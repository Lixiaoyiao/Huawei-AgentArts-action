import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digest } from "../src/agentarts/protocol.js";
import {
  runtimeGrantsDigest,
  runtimeControllerManifestSchema,
  runtimeTaskDigest,
  runtimeTaskSchema,
  runtimeTaskReplySchema,
  validateRuntimeTaskOutput,
  type RuntimeTask,
  type RuntimeBinding,
} from "../src/agentarts/runtime-task-protocol.js";
import {
  createWorkspaceTransferManifest,
  validateWorkspaceTransferDelta,
} from "../src/agentarts/workspace-transfer.js";
import {
  runAgentArtsRuntimeTask,
  getAgentArtsFailureDiagnostics,
} from "../src/agentarts/worker.js";
import { createAgentArtsServer } from "../src/agentarts/server.js";
import { executeBoundedDshProcess } from "../src/dsh/process.js";
import type { DshOperation, DshOutput } from "../src/dsh/schema.js";
import { agentArtsNpmArguments } from "../src/agentarts/installer.js";
import { githubToolManifest } from "../src/tools/github-catalog.js";
import {
  prepareInsecureFullRuntimeFixture,
  translateFullRuntimeFixtureProfile,
} from "./fixtures/agentarts-full-sandbox.js";
import { sendMessagesSse, messageToolResults } from "./fixtures/messages-sse.mjs";

const directories: string[] = [],
  servers: Server[] = [];
const fakeKey = "full-runtime-supervisor-key-fixture";
const environment = {
  DEEPSEEK_API_KEY: fakeKey,
  DEEPSEEK_BASE_URL: "http://127.0.0.1:9",
  API_KEY: "full-runtime-frontend-key-fixture",
  GITHUB_TOKEN: "full-controller-only-github-fixture",
  AGENTARTS_MODEL_EVIDENCE: "unverified",
  ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
};
const original = "export const add = (a, b) => a - b;\n";
const corrected = "export const add = (a, b) => a + b;\n";
const mode = process.platform === "win32" ? 0o666 : 0o644;
const catalog = [runtimeControllerManifestSchema.parse(githubToolManifest("github.checks.read"))];
function task(operation: DshOperation = "task", overrides: Partial<RuntimeTask> = {}): RuntimeTask {
  const write = operation === "fix" || operation === "implement";
  const grants = {
    trust: write ? ("trusted-write" as const) : ("trusted-read" as const),
    requestedAccess: write ? ("write" as const) : ("read" as const),
    mode: "controlled" as const,
    tools: write
      ? ["workspace.read" as const, "workspace.edit" as const]
      : ["workspace.read" as const],
    toolCatalog: catalog,
    ...overrides,
  };
  const taskId = randomUUID();
  const binding: RuntimeBinding = {
    taskId,
    operation,
    operationIdentity: `${operation}:7:offline`,
    repository: "offline/full-runtime",
    entity: { kind: "pull_request", number: 7 },
    ref: "main",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    revision: 0,
    grantDigest: runtimeGrantsDigest(grants),
  };
  return runtimeTaskSchema.parse({
    schemaVersion: 3,
    taskId,
    operation,
    binding,
    timeoutMs: 60_000,
    instructions:
      "Use the admitted context and source. All model responses in this test are deterministic fixtures.",
    context: {
      taskContext: { repository: binding.repository, entity: binding.entity },
      controllerLoop: { turn: 1 },
    },
    ...grants,
    workspace: createWorkspaceTransferManifest(binding, [
      { path: "src/add.js", encoding: "utf8", content: original, sha256: digest(original), mode },
    ]),
  });
}
function output(operation: DshOperation, extra: Partial<DshOutput> = {}): DshOutput {
  return {
    protocolVersion: 1,
    operation,
    state: "final",
    summary: "Explicit deterministic full Runtime result",
    findings: [],
    ...extra,
  };
}
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agentarts-full-test-"));
  directories.push(path);
  return path;
}
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("TCP fixture address missing");
  return `http://127.0.0.1:${String(address.port)}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 3 })),
  );
});

describe("full Runtime v3 protocol preserves original operations and current authorization", () => {
  it.each(["task", "review", "diagnose", "fix", "implement"] as const)(
    "binds %s to the complete manifest and grants",
    (operation) => {
      const value = task(operation);
      expect(value.operation).toBe(operation);
      expect(runtimeTaskDigest(value)).toMatch(/^[a-f0-9]{64}$/u);
      expect(value.workspace.binding.operationIdentity).toBe(value.binding.operationIdentity);
    },
  );
  it("rejects replay across task, operation, revision, commits, ref or grants", () => {
    const value = task("fix");
    for (const binding of [
      { ...value.binding, taskId: randomUUID() },
      { ...value.binding, headSha: "c".repeat(40) },
      { ...value.binding, operation: "implement" },
      { ...value.binding, revision: 1 },
      { ...value.binding, ref: "other" },
      { ...value.binding, grantDigest: "d".repeat(64) },
      { ...value.binding, operationIdentity: "other-task" },
    ])
      expect(runtimeTaskSchema.safeParse({ ...value, binding }).success).toBe(false);
    expect(runtimeTaskSchema.safeParse({ ...value, tools: ["native.bash"] }).success).toBe(false);
    expect(
      runtimeTaskSchema.safeParse({
        ...value,
        workspace: {
          ...value.workspace,
          files: [{ ...value.workspace.files[0], content: "tamper" }],
        },
      }).success,
    ).toBe(false);
  });
  it("does not permit write or executable capability under untrusted/read grants", () => {
    expect(() => task("fix", { trust: "trusted-read" })).toThrow();
    expect(() => task("task", { tools: ["workspace.edit"] })).toThrow();
    expect(() => task("task", { tools: ["native.bash"] })).toThrow();
    expect(() => task("task", { trust: "untrusted", tools: [], toolCatalog: [] })).toThrow();
    expect(() => task("review", { requestedAccess: "write", trust: "trusted-write" })).toThrow();
  });
  it("validates original operation schemas and only current catalog requests", () => {
    const value = task();
    expect(
      validateRuntimeTaskOutput(
        output("task", {
          state: "needs_tool",
          toolRequest: { id: "github.checks.read", input: {} },
        }),
        value,
      ).state,
    ).toBe("needs_tool");
    expect(() =>
      validateRuntimeTaskOutput(
        output("task", {
          state: "needs_tool",
          toolRequest: { id: "github.checks.read", input: { argv: ["sh"] } },
        }),
        value,
      ),
    ).toThrow();
    expect(() =>
      validateRuntimeTaskOutput(
        output("task", { state: "needs_tool", toolRequest: { id: "github.comment", input: {} } }),
        value,
      ),
    ).toThrow("ungranted");
    expect(() => validateRuntimeTaskOutput(output("review"), value)).toThrow("expected task");
    expect(() =>
      validateRuntimeTaskOutput(
        output("task", {
          verification: [{ command: "npm test", status: "passed", summary: "Model assertion" }],
        }),
        value,
      ),
    ).toThrow("executed tests");
    expect(
      validateRuntimeTaskOutput(
        output("task", { verification: [{ command: "npm test", status: "skipped" }] }),
        value,
      ).verification?.[0]?.status,
    ).toBe("skipped");
    const schemaTask = task("task", {
      taskOutputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    });
    expect(() =>
      validateRuntimeTaskOutput(output("task", { taskOutput: { answer: 42 } }), schemaTask),
    ).toThrow();
  });
  it("derives install lifecycle flags from the original locked installer", () => {
    expect(agentArtsNpmArguments("runtime")).toContain("--ignore-scripts");
    expect(agentArtsNpmArguments("runtime")[0]).toBe("ci");
    expect(agentArtsNpmArguments("extension")).toEqual(
      expect.arrayContaining([
        "install",
        "--ignore-scripts",
        "--install-strategy=nested",
        "--lockfile-version=3",
      ]),
    );
  });
  it("preserves typed GitHub catalog constraints without restricting them to task-output-schema", () => {
    const admitted = task("fix", {
      toolCatalog: [
        runtimeControllerManifestSchema.parse(githubToolManifest("github.issue.labels.set")),
        runtimeControllerManifestSchema.parse(githubToolManifest("github.pull.metadata.update")),
      ],
    });
    expect(
      validateRuntimeTaskOutput(
        output("fix", {
          state: "needs_tool",
          toolRequest: { id: "github.issue.labels.set", input: { labels: ["bug"] } },
        }),
        admitted,
      ).state,
    ).toBe("needs_tool");
    expect(() =>
      validateRuntimeTaskOutput(
        output("fix", {
          state: "needs_tool",
          toolRequest: { id: "github.issue.labels.set", input: { labels: ["bug", "bug"] } },
        }),
        admitted,
      ),
    ).toThrow();
    expect(() =>
      validateRuntimeTaskOutput(
        output("fix", {
          state: "needs_tool",
          toolRequest: { id: "github.pull.metadata.update", input: {} },
        }),
        admitted,
      ),
    ).toThrow();
    expect(() =>
      task("fix", {
        toolCatalog: [
          {
            ...runtimeControllerManifestSchema.parse(githubToolManifest("github.issue.labels.set")),
            permissions: ["read"],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("full Runtime captures bytes independently from model change/test claims", () => {
  it("returns actual modified and added binary files, while model verification is only business data", async () => {
    const temporaryDirectory = await directory(),
      admitted = task("fix");
    const result = await runAgentArtsRuntimeTask(admitted, {
      environment,
      temporaryDirectory,
      allowInsecureTestOnly: true,
      prepareSandbox: prepareInsecureFullRuntimeFixture,
      executeProcess: async (spec) => {
        expect(JSON.stringify(spec)).not.toContain(fakeKey);
        expect(spec.env.GITHUB_TOKEN).toBeUndefined();
        const workspace = join(spec.env.DSH_HOME ?? "", "../../workspace");
        await writeFile(join(workspace, "src/add.js"), corrected);
        await writeFile(join(workspace, "result.bin"), Buffer.from([0, 255, 1]));
        return {
          stdout: JSON.stringify(
            output("fix", {
              verification: [
                { command: "npm test", status: "passed", summary: "Unverified model assertion" },
              ],
              changePlan: [{ path: "unrelated.js", summary: "Model claims unrelated file" }],
            }),
          ),
          stderr: "",
          exitCode: 0,
          signal: null,
        };
      },
    });
    expect(result.delta?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "modified",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Nested Vitest matcher, never runtime data.
          file: expect.objectContaining({ path: "src/add.js", content: corrected }),
        }),
        expect.objectContaining({
          kind: "added",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Nested Vitest matcher, never runtime data.
          file: expect.objectContaining({ path: "result.bin", encoding: "base64" }),
        }),
      ]),
    );
    expect(result.delta?.changes).toHaveLength(2);
    expect(JSON.stringify(result.delta)).not.toContain("unrelated.js");
    expect(validateWorkspaceTransferDelta(admitted.workspace, result.delta).binding.revision).toBe(
      1,
    );
    expect(result.sandboxEvidence).toMatchObject({
      backend: "insecure-test",
      processIsolated: false,
      networkIsolated: false,
      workspaceAccess: "read-write",
    });
    expect((result.output as DshOutput).verification?.[0]?.status).toBe("passed");
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });
  it("rejects actual read-only drift, protected files and real supervisor credentials", async () => {
    const temporaryDirectory = await directory();
    const invoke = (admitted: RuntimeTask, mutate: (workspace: string) => Promise<void>) =>
      runAgentArtsRuntimeTask(admitted, {
        environment,
        temporaryDirectory,
        allowInsecureTestOnly: true,
        prepareSandbox: prepareInsecureFullRuntimeFixture,
        executeProcess: async (spec) => {
          await mutate(join(spec.env.DSH_HOME ?? "", "../../workspace"));
          return {
            stdout: JSON.stringify(output(admitted.operation)),
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        },
      });
    await expect(
      invoke(task(), (workspace) => writeFile(join(workspace, "src/add.js"), corrected)),
    ).rejects.toThrow("workspace changed");
    await expect(
      invoke(task("fix"), async (workspace) => {
        await mkdir(join(workspace, ".github/workflows"), { recursive: true });
        await writeFile(join(workspace, ".github/workflows/hidden.yml"), "malicious");
      }),
    ).rejects.toThrow();
    await expect(
      invoke(task("fix"), (workspace) => writeFile(join(workspace, "src/add.js"), fakeKey)),
    ).rejects.toThrow("credential");
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });
  it("records failed processes safely and cleans all temporary state", async () => {
    const temporaryDirectory = await directory();
    let failure: unknown;
    try {
      await runAgentArtsRuntimeTask(task("fix"), {
        environment,
        temporaryDirectory,
        allowInsecureTestOnly: true,
        prepareSandbox: prepareInsecureFullRuntimeFixture,
        executeProcess: () =>
          Promise.resolve({
            stdout: "",
            stderr: "private process failure details",
            exitCode: 3,
            signal: null,
          }),
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(getAgentArtsFailureDiagnostics(failure)).toMatchObject({
      phase: "process",
      process: { exitCode: 3 },
      provider: { requestCount: 0 },
    });
    expect(JSON.stringify(getAgentArtsFailureDiagnostics(failure))).not.toContain("private");
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });
  it("reuses one bounded output-only repair through the run proxy without executing another tool", async () => {
    const requests: Record<string, unknown>[] = [];
    const provider = await listen(
      createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.once("end", () => {
          requests.push(
            JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          );
          expect(request.headers.authorization).toBe(`Bearer ${fakeKey}`);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              choices: [
                {
                  message: { role: "assistant", content: JSON.stringify(output("task")) },
                  finish_reason: "stop",
                },
              ],
            }),
          );
        });
      }),
    );
    const executeProcess = vi.fn(() =>
      Promise.resolve({
        stdout: JSON.stringify({ ...output("task"), extraField: "untrusted formatter input" }),
        stderr: "",
        exitCode: 0,
        signal: null,
      }),
    );
    const reply = await runAgentArtsRuntimeTask(task(), {
      environment: {
        ...environment,
        DEEPSEEK_BASE_URL: provider,
        AGENTARTS_MODEL_EVIDENCE: "deterministic-fixture",
        AGENTARTS_MAX_MODEL_REQUESTS: "1",
      },
      allowInsecureTestOnly: true,
      prepareSandbox: prepareInsecureFullRuntimeFixture,
      executeProcess,
    });
    expect(reply.output).toEqual(output("task"));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.stream).toBe(false);
    expect(JSON.stringify(requests[0])).toContain("untrustedPreviousResult");
    expect(executeProcess).toHaveBeenCalledTimes(1);
    expect(reply.delta).toBeNull();
    expect(reply.modelExecution?.requestCount).toBe(1);
  });
  it.each([false, true])(
    "stops timed-out or cancelled processes before accepting a full result (cancel=%s)",
    async (cancel) => {
      const temporaryDirectory = await directory(),
        abort = new AbortController();
      let failure: unknown;
      try {
        await runAgentArtsRuntimeTask(task("fix", { timeoutMs: cancel ? 30_000 : 1500 }), {
          environment,
          temporaryDirectory,
          signal: abort.signal,
          allowInsecureTestOnly: true,
          prepareSandbox: prepareInsecureFullRuntimeFixture,
          executeProcess: async (spec, limits) => {
            if (cancel) setTimeout(() => abort.abort(), 100).unref();
            return await executeBoundedDshProcess(
              { ...spec, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
              limits,
            );
          },
        });
      } catch (error: unknown) {
        failure = error;
      }
      expect(getAgentArtsFailureDiagnostics(failure)?.failureCode).toBe(
        cancel ? "DSH_ABORTED" : "DSH_TIMEOUT",
      );
      expect(await readdir(temporaryDirectory)).toEqual([]);
    },
    10_000,
  );
});

describe("actual pinned DSH through full HTTP Runtime with deterministic model fixtures", () => {
  it.each(["task", "review", "diagnose", "fix", "implement"] as const)(
    "runs %s, admits native filesystem tools and returns a bound actual delta",
    async (operation) => {
      const admitted = task(operation),
        expected = output(operation),
        requests: Record<string, unknown>[] = [];
      const write = admitted.requestedAccess === "write";
      const provider = await listen(
        createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.once("end", () => {
            requests.push(
              JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
            );
            expect(request.headers.authorization).toBe(`Bearer ${fakeKey}`);
            if (requests.length === 1)
              sendMessagesSse(
                response,
                {
                  tool_calls: [
                    {
                      id: "full-read",
                      index: 0,
                      type: "function",
                      function: {
                        name: "read",
                        arguments: JSON.stringify({ file_path: "src/add.js" }),
                      },
                    },
                  ],
                },
                "tool_calls",
              );
            else if (write && requests.length === 2)
              sendMessagesSse(
                response,
                {
                  tool_calls: [
                    {
                      id: "full-edit",
                      index: 0,
                      type: "function",
                      function: {
                        name: "edit",
                        arguments: JSON.stringify({
                          file_path: "src/add.js",
                          old_string: "a - b",
                          new_string: "a + b",
                        }),
                      },
                    },
                  ],
                },
                "tool_calls",
              );
            else sendMessagesSse(response, { content: JSON.stringify(expected) }, "stop");
          });
        }),
      );
      const temporaryDirectory = await directory();
      const runtime = createAgentArtsServer({
        environment: {
          ...environment,
          DEEPSEEK_BASE_URL: provider,
          AGENTARTS_MODEL_EVIDENCE: "deterministic-fixture",
        },
        runRuntimeTask: (packet, options) =>
          runAgentArtsRuntimeTask(packet, {
            ...options,
            temporaryDirectory,
            allowInsecureTestOnly: true,
            prepareSandbox: prepareInsecureFullRuntimeFixture,
            executeProcess: async (spec, limits) => {
              await translateFullRuntimeFixtureProfile(
                join(spec.env.DSH_HOME ?? "", "profiles/github-action"),
              );
              return await executeBoundedDshProcess(spec, limits);
            },
          }),
      });
      const origin = await listen(runtime);
      const response = await fetch(`${origin}/invocations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(admitted),
        redirect: "error",
      });
      const raw: unknown = await response.json();
      expect(response.status, JSON.stringify(raw)).toBe(200);
      const result = runtimeTaskReplySchema.parse(raw);
      expect(result.output).toEqual(expected);
      expect(result.taskDigest).toBe(runtimeTaskDigest(admitted));
      expect(result.workspaceDigest).toBe(admitted.workspace.digest);
      expect(result.toolReceipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "workspace.read", completed: true, ok: true }),
        ]),
      );
      expect(messageToolResults(requests[1] ?? {})).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tool_use_id: "full-read", is_error: false }),
        ]),
      );
      if (write) {
        expect(messageToolResults(requests[2] ?? {})).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ tool_use_id: "full-edit", is_error: false }),
          ]),
        );
        expect(result.delta?.changes).toEqual([
          expect.objectContaining({
            kind: "modified",
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Nested Vitest matcher, never runtime data.
            file: expect.objectContaining({ path: "src/add.js", content: corrected }),
          }),
        ]);
      } else expect(result.delta).toBeNull();
      expect(result.modelExecution).toMatchObject({
        kind: "deterministic-fixture",
        requestCount: write ? 3 : 2,
      });
      expect(await readdir(temporaryDirectory)).toEqual([]);
      expect(
        (
          await fetch(`${origin}/invocations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(admitted),
          })
        ).status,
      ).toBe(409);
    },
    90_000,
  );
  it("does not start a malformed full packet", async () => {
    const runRuntimeTask =
      vi.fn<
        NonNullable<NonNullable<Parameters<typeof createAgentArtsServer>[0]>["runRuntimeTask"]>
      >();
    const runtime = await listen(createAgentArtsServer({ environment, runRuntimeTask }));
    const value = task("fix");
    const response = await fetch(`${runtime}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...value, binding: { ...value.binding, headSha: "c".repeat(40) } }),
    });
    expect(response.status).toBe(400);
    expect(runRuntimeTask).not.toHaveBeenCalled();
  });
});
