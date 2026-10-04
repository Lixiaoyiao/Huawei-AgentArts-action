import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mapFindingToInline } from "../diff/map.js";
import { parseGitHubFilePatches } from "../diff/parse.js";
import { parseDshOutput } from "../dsh/schema.js";
import { executeBoundedDshProcess } from "../dsh/process.js";
import { filterHighPrecisionFindings } from "../review/precision.js";
import { assertNoSecretOutput, redactKnownSecrets } from "../security/env.js";
import { messageToolResults, sendMessagesSse } from "../../test/fixtures/messages-sse.mjs";
import { AgentArtsReviewEngine } from "./engine.js";
import { createAgentArtsServer } from "./server.js";
import { runtimeReplySchema, type ReviewTask } from "./protocol.js";
import { AGENTARTS_WORKER_GID, AGENTARTS_WORKER_UID, runAgentArtsReview } from "./worker.js";

interface Stage {
  name: string;
  status: "running" | "passed" | "failed" | "skipped";
  startedAt: string;
  completedAt?: string;
  message?: string;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${String(address.port)}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((accept) => server.close(() => accept()));
}

/** Reproducible local proof, with original test SSE transport and no live model. */
export async function runLocalProof(
  options: { readonly linuxIsolation?: boolean; readonly outputPath?: string } = {},
): Promise<string> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const outputPath =
    options.outputPath === undefined
      ? join(root, "agentarts", "evidence", "local-run-record.json")
      : resolve(options.outputPath);
  const startedAt = Date.now();
  const repository = "local-fixture/off-by-one";
  const source =
    "export function inBounds(index, length) {\n  return index >= 0 && index <= length;\n}\n";
  const baseSource = source.replace("index <= length", "index < length");
  const headSha = createHash("sha1").update(source).digest("hex");
  const baseSha = createHash("sha1").update(baseSource).digest("hex");
  const patch =
    "@@ -1,3 +1,3 @@\n export function inBounds(index, length) {\n-  return index >= 0 && index < length;\n+  return index >= 0 && index <= length;\n }\n";
  const modelKey = `local-model-fixture-${randomUUID()}`;
  const runtimeKey = `local-runtime-fixture-${randomUUID()}`;
  const linuxIsolation = options.linuxIsolation === true;
  const stages: Stage[] = [];
  const record = {
    schemaVersion: 1,
    mode: "local",
    task: {
      id: "",
      repository,
      pullNumber: 1,
      headSha,
      baseSha,
      kind: "pull_request",
      operation: "review",
      url: "",
    },
    stages,
    tools: [] as {
      id: string;
      runtimeName: string;
      ok: boolean;
      completed: boolean;
      durationMs: number;
    }[],
    validation: { status: "not-run", checks: [] as string[] },
    result: { summary: "", error: "" },
    runtime: { sessionId: "", endpoint: "loopback-local", dshVersion: "0.2.0-rc.2" },
    durationMs: 0,
    warnings: [
      "Real local DSH and local HTTP Runtime protocol executed. Huawei AgentArts was not called.",
      "Model responses, PR context and repository/commit identifiers are deterministic fixtures; this is not a model-quality benchmark.",
      linuxIsolation
        ? "Separate Linux UID, root-private file protection and supervisor /proc environment protection are checked locally; container and cloud deployment remain unverified."
        : "The local fixture uses the explicit test-only UID bypass; Linux cloud UID separation and Runtime deployment remain unverified.",
      "No GitHub API publication was attempted. The local task correlation ID is not an AgentArts Session ID.",
    ],
    modelEvidence: {
      kind: "deterministic-fixture",
      provider: "deepseek",
      model: "deepseek-v4-pro",
    },
    environment: {
      node: process.version,
      platform: process.platform,
      linuxIsolationVerified: false,
    },
  };
  const stage = (name: string): void => {
    const prior = stages.at(-1);
    if (prior?.status === "running") {
      prior.status = "passed";
      prior.completedAt = new Date().toISOString();
    }
    stages.push({ name, status: "running", startedAt: new Date().toISOString() });
  };
  const requests: { messages?: { content?: unknown }[]; tools?: { name?: string }[] }[] = [];
  const expectedOutput = {
    protocolVersion: 1,
    operation: "review",
    state: "final",
    summary:
      "The deterministic fixture reports the intentionally introduced off-by-one boundary at src/example.ts:2.",
    findings: [
      {
        title: "Reject the index equal to the array length",
        body: "The changed <= comparison accepts index === length, which is outside the valid 0..length-1 range.",
        severity: "medium",
        category: "correctness",
        confidence: 1,
        path: "src/example.ts",
        line: 2,
        side: "RIGHT",
        evidence:
          "inBounds(3, 3) returns true because 3 <= 3; valid indices for length 3 are 0, 1, 2.",
        suggestion: "Use index < length for the upper bound.",
      },
    ],
  };
  const model = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      try {
        assert.equal(request.headers.authorization, `Bearer ${modelKey}`);
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as (typeof requests)[number];
        requests.push(body);
        if (requests.length === 1) {
          assert.deepEqual(body.tools?.map(({ name }) => name).sort(), ["read", "read_image"]);
          sendMessagesSse(
            response,
            {
              tool_calls: [
                {
                  index: 0,
                  id: "local-proof-read",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({ file_path: "src/example.ts" }),
                  },
                },
              ],
            },
            "tool_calls",
          );
        } else {
          const toolResults = messageToolResults(body);
          assert.equal(toolResults.length, 1);
          assert(JSON.stringify(toolResults).includes("index <= length"));
          assert(!JSON.stringify(toolResults).includes('"is_error":true'));
          sendMessagesSse(response, { content: JSON.stringify(expectedOutput) }, "stop");
        }
      } catch {
        response.writeHead(500).end("Deterministic model fixture failed its own assertions");
      }
    });
  });
  let runtime: Server | undefined;
  try {
    stage("准备固定版本的本地审查任务");
    if (linuxIsolation) {
      stage("Linux 不同 UID 与凭证文件边界验证");
      assert.equal(process.platform, "linux", "Linux isolation proof requires Linux");
      assert.equal(process.getuid?.(), 0, "Linux isolation proof requires a root supervisor");
      assert(process.setgroups !== undefined);
      process.setgroups([]);
      const privateRoot = await mkdtemp(join(tmpdir(), "agentarts-private-probe-"));
      try {
        const privateFile = join(privateRoot, "private.txt");
        await writeFile(privateFile, "non-secret root-only probe", { mode: 0o600 });
        const script =
          "const fs=require('node:fs');const deny=p=>{try{fs.readFileSync(p);return false}catch(e){return e.code==='EACCES'||e.code==='EPERM'}};process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),privateDenied:deny(process.argv[1]),supervisorEnvDenied:deny('/proc/'+process.argv[2]+'/environ')}));";
        const probe = await executeBoundedDshProcess(
          {
            command: process.execPath,
            args: ["-e", script, privateFile, String(process.pid)],
            cwd: tmpdir(),
            env: { PATH: process.env.PATH },
            uid: AGENTARTS_WORKER_UID,
            gid: AGENTARTS_WORKER_GID,
          },
          { timeoutMs: 5_000, maxStdoutBytes: 1024, maxStderrBytes: 1024, maxCombinedBytes: 2048 },
        );
        assert.equal(probe.exitCode, 0);
        const result = JSON.parse(probe.stdout) as {
          uid: number;
          gid: number;
          groups: number[];
          privateDenied: boolean;
          supervisorEnvDenied: boolean;
        };
        assert.equal(result.uid, AGENTARTS_WORKER_UID);
        assert.equal(result.gid, AGENTARTS_WORKER_GID);
        assert(!result.groups.includes(0), "Worker must not retain root's supplementary group");
        assert.equal(result.privateDenied, true, "Worker must not read root-private files");
        assert.equal(
          result.supervisorEnvDenied,
          true,
          "Worker must not read supervisor credentials through /proc",
        );
        record.environment.linuxIsolationVerified = true;
      } finally {
        await rm(privateRoot, { recursive: true, force: true });
      }
    }
    const modelUrl = await listen(model);
    const environment = {
      ...process.env,
      DEEPSEEK_API_KEY: modelKey,
      DEEPSEEK_BASE_URL: modelUrl,
      AGENTARTS_MODEL_EVIDENCE: "deterministic-fixture",
      API_KEY: runtimeKey,
    };
    runtime = createAgentArtsServer({
      environment,
      runReview: async (task, options) => {
        try {
          return await runAgentArtsReview(task, {
            ...options,
            actionRoot: root,
            allowInsecureTestOnly: !linuxIsolation,
            executeProcess: async (spec, limits) => {
              const result = await executeBoundedDshProcess(spec, limits);
              if (result.exitCode !== 0 || result.signal !== null) {
                record.result.error = redactKnownSecrets(result.stderr.slice(0, 2048), [
                  modelKey,
                  runtimeKey,
                  spec.env.DEEPSEEK_API_KEY ?? "",
                ]);
              }
              return result;
            },
          });
        } catch (error) {
          // Local fixture diagnostics only; no production HTTP error pass-through.
          record.result.error ||= redactKnownSecrets(
            error instanceof Error ? error.message : String(error),
            [modelKey, runtimeKey],
          );
          throw error;
        }
      },
    });
    const runtimeUrl = await listen(runtime);
    const engine = new AgentArtsReviewEngine(
      {
        origin: "https://local.invalid",
        runtimeName: "local-fixture",
        endpoint: "local-fixture",
        apiKey: runtimeKey,
      },
      "trusted-read",
      {
        repository,
        pullNumber: 1,
        baseSha,
        headSha,
      },
      [modelKey, runtimeKey],
      {
        onTask: (task) => {
          record.task.id = task.taskId;
          record.runtime.sessionId = `local-task:${task.taskId}`;
          stage("本地 HTTP Runtime → 真实 DSH → 真实只读工具");
        },
        invoke: async (task: ReviewTask, signal) => {
          const response = await fetch(`${runtimeUrl}/invocations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(task),
            ...(signal === undefined ? {} : { signal }),
          });
          assert.equal(response.status, 200, "Local Runtime invocation must succeed");
          return runtimeReplySchema.parse(await response.json());
        },
      },
    );
    const turn = await engine.runTurn({
      schemaVersion: 1,
      operation: "review",
      requestedAccess: "read",
      timeoutMs: 60_000,
      deadlineMs: Date.now() + 60_000,
      workspacePath: root,
      instructions:
        "Review the changed function. Read src/example.ts before the final result. Focus on the valid index boundary.",
      tools: [
        {
          id: "workspace.read",
          provider: "builtin",
          description: "Read admitted review source",
          permissions: ["read"],
          inputSchema: {},
        },
      ],
      context: {
        taskContext: {
          repository,
          entity: {
            kind: "pull_request",
            number: 1,
            baseSha,
            headSha,
            changedFiles: [{ path: "src/example.ts", source, patch }],
          },
        },
      },
    });
    stage("控制端独立协议、权限和业务验收");
    const checked = parseDshOutput(JSON.stringify(turn.output), "review");
    assert.equal(requests.length, 2, "Actual DSH must complete a tool round trip");
    const receipts = turn.metadata.toolReceipts;
    assert.equal(receipts.length, 1);
    const receipt = receipts[0];
    assert(receipt !== undefined);
    assert.equal(receipt.id, "workspace.read");
    assert.equal(receipt.ok, true);
    assert.equal(receipt.completed, true);
    const findings = filterHighPrecisionFindings(checked.findings);
    assert.equal(findings.length, 1);
    const finding = findings[0];
    assert(finding !== undefined);
    const diff = parseGitHubFilePatches([
      { filename: "src/example.ts", status: "modified", patch, truncated: false, binary: false },
    ]);
    assert.deepEqual(mapFindingToInline(diff, finding), {
      path: "src/example.ts",
      line: 2,
      side: "RIGHT",
    });
    assert.equal(finding.category, "correctness");
    assert(finding.evidence?.includes("inBounds(3, 3)"));
    assert(source.split("\n")[1]?.includes("index <= length"));
    const boundary = { index: 3, length: 3 };
    assert.equal(boundary.index <= boundary.length, true);
    assert.equal(boundary.index < boundary.length, false);
    record.tools = receipts.map(({ id, runtimeName, ok, completed, durationMs }) => ({
      id,
      runtimeName,
      ok,
      completed,
      durationMs,
    }));
    record.validation = {
      status: "passed",
      checks: [
        "Shared Controller engine accepted strict protocol, task/repository/base/head binding and unchanged workspace digest.",
        "The only allowed read tool completed through real DSH and its original policy receipt was reconciled.",
        "The expected correctness finding survived upstream precision filtering and mapped to the actual added diff line.",
        "Independent fixture oracle confirms index === length is accepted by <= and rejected by <.",
        "No workspace writes, repository tests, GitHub publication or cloud success are claimed.",
      ],
    };
    if (linuxIsolation)
      record.validation.checks.push(
        "Separate worker UID/GID10001, cleared supplementary groups, root-private files and supervisor /proc environment were independently verified on local Linux.",
      );
    record.result.summary = checked.summary;
    stage("GitHub 发布（本地证明不执行）");
    const finalStage = stages.at(-1);
    assert(finalStage !== undefined);
    finalStage.status = "skipped";
    finalStage.completedAt = new Date().toISOString();
    finalStage.message =
      "No real GitHub task or credentials were used; no external result URL exists.";
  } catch (error: unknown) {
    const failed = stages.at(-1);
    if (failed !== undefined) {
      failed.status = "failed";
      failed.completedAt = new Date().toISOString();
    }
    record.validation.status = "failed";
    record.result.error ||= error instanceof Error ? error.name : "Unknown local proof failure";
    throw error;
  } finally {
    if (runtime !== undefined) await close(runtime);
    await close(model);
    record.durationMs = Date.now() - startedAt;
    const serialized = JSON.stringify(record, null, 2);
    assertNoSecretOutput("stdout", serialized, [modelKey, runtimeKey]);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${serialized}\n`, { mode: 0o600 });
  }
  return outputPath;
}

const outIndex = process.argv.indexOf("--out");
const explicitOutput = outIndex === -1 ? undefined : process.argv[outIndex + 1];
if (outIndex !== -1 && (explicitOutput === undefined || explicitOutput.startsWith("--")))
  throw new Error("--out requires an output file path");
void runLocalProof({
  linuxIsolation: process.argv.includes("--linux-isolation"),
  ...(explicitOutput === undefined ? {} : { outputPath: explicitOutput }),
})
  .then((path) => {
    process.stdout.write(
      `Local proof passed: real DSH, deterministic model fixture, no cloud or GitHub publication.\nRecord: ${path}\n`,
    );
  })
  .catch(() => {
    process.stderr.write(
      "Local proof failed. See the bounded local run record; no result was published.\n",
    );
    process.exitCode = 1;
  });
