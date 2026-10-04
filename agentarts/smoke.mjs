/* global AbortSignal */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

import { messageToolResults, sendMessagesSse } from "./messages-sse.mjs";

const startedAt = Date.now();
const emulated = process.env.SMOKE_EMULATED === "true";
const deadline = new AbortController();
const timer = setTimeout(() => deadline.abort(), 120_000);
timer.unref();
const digest = (text) => createHash("sha256").update(text).digest("hex");
const sha = (text) => createHash("sha1").update(text).digest("hex");
const modelKey = `image-model-fixture-${randomUUID()}`;
const runtimeKey = `image-runtime-fixture-${randomUUID()}`;
const source =
  "export function inBounds(index, length) {\n  return index >= 0 && index <= length;\n}\n";
const expectedOutput = {
  protocolVersion: 1,
  operation: "review",
  state: "final",
  summary: "The image fixture reports the intentionally introduced off-by-one boundary.",
  findings: [
    {
      title: "Reject an index equal to the length",
      body: "The changed <= comparison accepts index === length, outside the valid 0..length-1 range.",
      severity: "medium",
      category: "correctness",
      confidence: 1,
      path: "src/example.ts",
      line: 2,
      side: "RIGHT",
      evidence: "inBounds(3, 3) returns true because 3 <= 3; valid indices are 0, 1, 2.",
    },
  ],
};
const files = [{ path: "src/example.ts", content: source, sha256: digest(source) }];
const task = {
  schemaVersion: 1,
  taskId: randomUUID(),
  binding: {
    repository: "image-fixture/off-by-one",
    pullNumber: 1,
    baseSha: sha(source.replace("index <= length", "index < length")),
    headSha: sha(source),
  },
  trust: "trusted-read",
  tools: ["workspace.read"],
  timeoutMs: emulated ? 60_000 : 30_000,
  instructions:
    "Read src/example.ts and review the changed valid-index boundary. Return the strict review result.",
  context: {
    untrusted: true,
    fixtureCase: "normal-review",
    patch:
      "@@ -2 +2 @@\n-  return index >= 0 && index < length;\n+  return index >= 0 && index <= length;\n",
  },
  files,
};
let runtime;
let childOutput = "";
let childOutputBytes = 0;
let normalRequests = 0;
let timeoutRequests = 0;
let observedUid = false;
let measuredTools = [];
let measuredSummary = "";
let stage = "initialization";
const checks = [];

async function runtimeChildren() {
  if (runtime?.pid === undefined || runtime.exitCode !== null || runtime.signalCode !== null)
    return [];
  try {
    const text = await readFile(`/proc/${runtime.pid}/task/${runtime.pid}/children`, "utf8");
    return text
      .trim()
      .split(/\s+/u)
      .filter((id) => /^[1-9][0-9]*$/u.test(id))
      .map(Number);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function verifyWorkerUid() {
  const children = await runtimeChildren();
  assert.equal(children.length, 1, "The Runtime must have one isolated DSH process");
  const status = await readFile(`/proc/${children[0]}/status`, "utf8");
  assert.match(status, /^Uid:\s+10001\s+10001\s+10001\s+10001$/mu);
  assert.match(status, /^Gid:\s+10001\s+10001\s+10001\s+10001$/mu);
  const groups =
    /^Groups:[\t ]*(.*)$/mu.exec(status)?.[1].trim().split(/\s+/u).filter(Boolean) ?? [];
  assert(!groups.includes("0"), "DSH must not inherit the root supplementary group");
  observedUid = true;
}

const model = createServer((request, response) => {
  const chunks = [];
  let bytes = 0;
  request.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) request.destroy();
    else chunks.push(chunk);
  });
  request.on("error", () => undefined);
  request.once("end", () => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert(request.url?.endsWith("/v1/messages"));
      assert.equal(request.headers.authorization, `Bearer ${modelKey}`);
      assert.equal(request.headers["x-api-key"], modelKey);
      const text = Buffer.concat(chunks).toString("utf8");
      assert(!text.includes(modelKey) && !text.includes(runtimeKey));
      const body = JSON.parse(text);
      await verifyWorkerUid();
      if (text.includes("SMOKE_TIMEOUT_HOLD")) {
        timeoutRequests += 1;
        // Keep the real provider request open until the supervisor-owned
        // deadline aborts the proxy and kills the DSH process.
        return;
      }
      normalRequests += 1;
      if (normalRequests === 1) {
        assert.deepEqual(body.tools.map(({ name }) => name).sort(), ["read", "read_image"]);
        sendMessagesSse(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "image-smoke-read",
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
        assert.equal(normalRequests, 2);
        const results = messageToolResults(body);
        assert.equal(results.length, 1);
        assert.equal(results[0].tool_use_id, "image-smoke-read");
        assert.notEqual(results[0].is_error, true);
        assert(JSON.stringify(results).includes("index <= length"));
        sendMessagesSse(response, { content: JSON.stringify(expectedOutput) }, "stop");
      }
    })().catch(() => {
      if (!response.destroyed && !response.headersSent)
        response.writeHead(500).end("Image model fixture assertion failed");
    });
  });
});

async function waitHealthy() {
  const end = Date.now() + (emulated ? 20_000 : 8_000);
  while (Date.now() < end && !deadline.signal.aborted) {
    assert(
      runtime !== undefined && runtime.exitCode === null && runtime.signalCode === null,
      "Production Runtime exited before its health check",
    );
    try {
      const response = await fetch("http://127.0.0.1:8080/ping", {
        signal: AbortSignal.any([deadline.signal, AbortSignal.timeout(500)]),
      });
      if (response.status === 200 && (await response.json()).status === "Healthy") return;
    } catch {
      // Readiness is bounded independently; no invocation is retried.
    }
    await delay(100, undefined, { signal: deadline.signal });
  }
  throw new Error("Production Runtime did not become healthy within its bounded startup budget");
}

async function invoke(admitted) {
  return await fetch("http://127.0.0.1:8080/invocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(admitted),
    signal: deadline.signal,
  });
}

async function stopRuntime() {
  if (runtime === undefined || runtime.exitCode !== null || runtime.signalCode !== null) return;
  process.kill(-runtime.pid, "SIGTERM");
  const stopped = await Promise.race([
    new Promise((accept) => runtime.once("close", () => accept(true))),
    delay(2_000).then(() => false),
  ]);
  if (!stopped) {
    // DSH has a separate process group. Kill only current children of this
    // exact supervisor before hard-stopping the supervisor itself.
    for (const pid of await runtimeChildren()) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    try {
      process.kill(-runtime.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await Promise.race([new Promise((accept) => runtime.once("close", accept)), delay(2_000)]);
  }
}

let failure;
try {
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid(), 0);
  assert.equal(process.version, "v24.15.0");
  assert([undefined, "true", "false"].includes(process.env.SMOKE_EMULATED));
  if (process.env.SMOKE_SOURCE_SHA !== undefined)
    assert.match(process.env.SMOKE_SOURCE_SHA, /^[a-f0-9]{40}$/u);
  if (process.env.SMOKE_IMAGE_ID !== undefined)
    assert.match(process.env.SMOKE_IMAGE_ID, /^sha256:[a-f0-9]{64}$/u);
  if (process.env.SMOKE_EXPECTED_ARCH !== undefined)
    assert.equal(process.arch, process.env.SMOKE_EXPECTED_ARCH);
  const require = createRequire("/opt/app/package.json");
  const installed = JSON.parse(
    await readFile(require.resolve("@deepseek-ai/dsh/package.json"), "utf8"),
  );
  assert.equal(installed.version, "0.2.0-rc.2");
  assert(!(await readFile("/proc/self/mountinfo", "utf8")).includes("docker.sock"));
  await new Promise((accept) => model.listen(0, "127.0.0.1", accept));
  const address = model.address();
  assert(address !== null && typeof address !== "string");
  stage = "production-startup";
  runtime = spawn(process.execPath, ["/opt/app/dist-agentarts/runtime/index.js"], {
    cwd: "/opt/app",
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: "/tmp",
      NODE_ENV: "production",
      DEEPSEEK_API_KEY: modelKey,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
      API_KEY: runtimeKey,
    },
  });
  const capture = (chunk) => {
    childOutputBytes += chunk.length;
    if (childOutputBytes > 1024 * 1024) deadline.abort();
    else childOutput += chunk.toString("utf8");
  };
  runtime.stdout.on("data", capture);
  runtime.stderr.on("data", capture);
  runtime.once("error", () => deadline.abort());
  await waitHealthy();
  checks.push(
    "The final image's unmodified production Runtime bundle passed its real /ping health check.",
  );
  stage = "real-dsh-review";
  const response = await invoke(task);
  assert.equal(response.status, 200);
  const reply = await response.json();
  assert.equal(reply.schemaVersion, 1);
  assert.equal(reply.taskId, task.taskId);
  assert.deepEqual(reply.binding, task.binding);
  assert.equal(reply.dshVersion, installed.version);
  assert.equal(reply.workspaceDigest, digest(JSON.stringify(files)));
  assert(Number.isSafeInteger(reply.durationMs) && reply.durationMs >= 0);
  assert.deepEqual(reply.output, expectedOutput);
  assert.equal(reply.toolReceipts.length, 1);
  const receipt = reply.toolReceipts[0];
  assert.equal(receipt.id, "workspace.read");
  assert.equal(receipt.runtimeName, "read");
  assert.equal(receipt.provider, "builtin");
  assert.equal(receipt.counted, true);
  assert.equal(receipt.completed, true);
  assert.equal(receipt.ok, true);
  assert(Number.isSafeInteger(receipt.durationMs) && receipt.durationMs >= 0);
  measuredTools = [
    {
      id: receipt.id,
      ok: receipt.ok,
      completed: receipt.completed,
      durationMs: receipt.durationMs,
    },
  ];
  measuredSummary = reply.output.summary;
  assert.equal(normalRequests, 2);
  assert.equal(observedUid, true);
  assert.deepEqual(await runtimeChildren(), []);
  assert(!childOutput.includes(modelKey) && !childOutput.includes(runtimeKey));
  checks.push(
    "Actual pinned DSH used the real read tool under observed UID/GID10001 with no root supplementary group.",
  );
  checks.push(
    "The read result contained the admitted source; its reconciled receipt, result, immutable binding and unchanged workspace digest matched.",
  );
  stage = "duplicate-admission";
  const repeated = await invoke(task);
  assert.equal(repeated.status, 409);
  assert.equal((await repeated.json()).error.code, "DUPLICATE_TASK");
  assert.equal(normalRequests, 2);
  checks.push("An identical task was refused before a second DSH execution.");
  stage = "timeout-and-cleanup";
  const timeoutTask = {
    ...task,
    taskId: randomUUID(),
    timeoutMs: emulated ? 20_000 : 8_000,
    context: { ...task.context, fixtureCase: "SMOKE_TIMEOUT_HOLD" },
  };
  const timed = await invoke(timeoutTask);
  assert.equal(timed.status, 504);
  assert.equal((await timed.json()).error.code, "TASK_TIMEOUT");
  assert(timeoutRequests >= 1, "Timeout must happen after an actual provider request starts");
  assert.deepEqual(
    await runtimeChildren(),
    [],
    "The timed-out DSH process must exit before the result response",
  );
  assert(!childOutput.includes(modelKey) && !childOutput.includes(runtimeKey));
  checks.push(
    "A real held provider request reached its declared deadline; the separate-UID DSH process was killed and no result was accepted.",
  );
  stage = "passed";
} catch (error) {
  failure = typeof error.code === "string" ? error.code : error.name;
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try {
    await stopRuntime();
  } catch {
    failure ??= "TEARDOWN_FAILED";
    process.exitCode = 1;
  }
  model.closeAllConnections();
  await new Promise((accept) => model.close(() => accept()));
  const evidence = {
    schemaVersion: 1,
    mode: "container",
    status: failure === undefined ? "passed" : "failed",
    taskId: task.taskId,
    stage,
    node: process.version,
    architecture: process.arch,
    emulated,
    dshVersion: "0.2.0-rc.2",
    workerUidVerified: observedUid,
    sourceCommit: process.env.SMOKE_SOURCE_SHA ?? "",
    imageId: process.env.SMOKE_IMAGE_ID ?? "",
    tools: measuredTools,
    result: { summary: measuredSummary },
    durationMs: Date.now() - startedAt,
    normalModelRequests: normalRequests,
    timeoutModelRequests: timeoutRequests,
    checks,
    ...(failure === undefined ? {} : { failureCode: failure }),
    limitations: [
      "The model and PR/commit identifiers are deterministic fixtures.",
      "This proves the tested final Docker image and production HTTP/DSH path, not AgentArts cloud or GitHub publication.",
      emulated
        ? "This architecture was executed through QEMU emulation on an AMD64 runner; native ARM hardware and cloud deployment remain unverified."
        : "This architecture was executed without configured QEMU emulation; other architectures and cloud deployment are not inferred.",
    ],
  };
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}
