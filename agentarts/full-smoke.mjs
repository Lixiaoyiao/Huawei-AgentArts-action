/* global AbortSignal */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  fullPacket,
  fullOutput,
  fullCorrected,
  canonicalFullJson,
  fullHash,
} from "./full-runtime-packets.mjs";
import { sendMessagesSse, messageToolResults } from "./messages-sse.mjs";

const startedAt = Date.now();
const emulated = process.env.SMOKE_EMULATED === "true";
const controller = new AbortController();
const overall = setTimeout(() => controller.abort(), emulated ? 240_000 : 120_000);
overall.unref();
const modelKey = "fixture-model-" + randomUUID(),
  localKey = "fixture-local-" + randomUUID();
let runtime,
  secretRoot,
  failure,
  childBytes = 0,
  childText = "",
  activeCase,
  modelFailure;
const counters = new Map(),
  checks = [];
const model = createServer((request, response) => {
  void (async () => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error("fixture model request oversized");
      chunks.push(chunk);
    }
    assert.equal(request.headers.authorization, `Bearer ${modelKey}`);
    const text = Buffer.concat(chunks).toString("utf8");
    assert(!text.includes(modelKey));
    assert(!text.includes(localKey));
    // The original format-repair prompt contains the invalid output rather
    // than the original task marker. Only this deliberately invalid fixture
    // may use the current sequential invocation as its correlation identity.
    const id =
      /FULL_CONTAINER_CASE=([a-z-]+)/u.exec(text)?.[1] ??
      (activeCase === "invalid-output" ? activeCase : undefined);
    assert(id, "Known fixture marker required");
    const count = (counters.get(id) ?? 0) + 1;
    counters.set(id, count);
    if (id === "timeout" || id === "cancel") return;
    const operation = id === "task-write" || id === "native-write" ? "task" : id;
    const write = ["fix", "implement", "task-write", "native-write"].includes(id);
    const payload = JSON.parse(text);
    if (count === 1) {
      const call =
        id === "native-write"
          ? {
              name: "bash",
              arguments: JSON.stringify({
                command: `node -e 'const fs=require("node:fs"),cp=require("node:child_process"),os=require("node:os");if(process.getuid()!==10001||process.env.GITHUB_TOKEN||process.env.AGENTARTS_LOCAL_API_KEY||Object.keys(os.networkInterfaces()).some(x=>x!=="lo"))throw Error("boundary");if(cp.spawnSync("/usr/bin/unshare",["--user","--","/usr/bin/true"]).status===0)throw Error("nested namespace");fs.writeFileSync("src/add.js",${JSON.stringify(fullCorrected)});process.stdout.write("NAMESPACE_CHECKED")'`,
                description: "Check namespace and update the admitted deterministic fixture",
                timeoutMs: 5000,
              }),
            }
          : { name: "read", arguments: JSON.stringify({ file_path: "src/add.js" }) };
      sendMessagesSse(
        response,
        { tool_calls: [{ id: `${id}-first`, index: 0, type: "function", function: call }] },
        "tool_calls",
      );
      return;
    }
    if (id === "invalid-output") {
      sendMessagesSse(
        response,
        { content: "A fixture that never returns the required result JSON." },
        "stop",
      );
      return;
    }
    const results = messageToolResults(payload);
    assert(results.length > 0);
    assert(results.every((result) => result.is_error !== true));
    if (write && id !== "native-write" && count === 2) {
      sendMessagesSse(
        response,
        {
          tool_calls: [
            {
              id: `${id}-edit`,
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
      return;
    }
    assert.equal(count, write && id !== "native-write" ? 3 : 2);
    sendMessagesSse(response, { content: JSON.stringify(fullOutput(operation)) }, "stop");
  })().catch((error) => {
    modelFailure = error;
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
async function invoke(task, signal = controller.signal, authenticated = true) {
  activeCase = /FULL_CONTAINER_CASE=([a-z-]+)/u.exec(task.instructions ?? "")?.[1];
  return fetch("http://127.0.0.1:8080/invocations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${localKey}` } : {}),
    },
    body: JSON.stringify(task),
    signal,
  });
}
async function healthy() {
  for (let attempt = 0; attempt < (emulated ? 200 : 80); attempt++) {
    assert(runtime.exitCode === null && runtime.signalCode === null, "Runtime startup failed");
    try {
      const response = await fetch("http://127.0.0.1:8080/ping", {
        signal: AbortSignal.timeout(500),
      });
      if ((await response.json()).status === "Healthy") return;
    } catch {
      /* bounded startup poll */
    }
    await delay(100);
  }
  throw new Error("Runtime health deadline exceeded");
}
async function idle() {
  for (let i = 0; i < 50; i++) {
    const response = await fetch("http://127.0.0.1:8080/ping", {
      signal: AbortSignal.timeout(1000),
    });
    if ((await response.json()).status === "Healthy") return;
    await delay(100);
  }
  throw new Error("Cancelled worker did not finish cleanup");
}
try {
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid(), 0);
  if (process.env.SMOKE_EXPECTED_ARCH) assert.equal(process.arch, process.env.SMOKE_EXPECTED_ARCH);
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const address = model.address();
  assert(address && typeof address !== "string");
  secretRoot = await mkdtemp("/tmp/agentarts-full-fixture-");
  const keyPath = join(secretRoot, "key");
  await writeFile(keyPath, modelKey, { mode: 0o600 });
  runtime = spawn(process.execPath, ["/opt/app/dist-agentarts/runtime/index.js"], {
    cwd: "/opt/app",
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: "/tmp",
      NODE_ENV: "production",
      DEEPSEEK_API_KEY_FILE: keyPath,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
      AGENTARTS_MODEL_EVIDENCE: "deterministic-fixture",
      AGENTARTS_INBOUND_MODE: "local",
      AGENTARTS_LOCAL_API_KEY: localKey,
    },
  });
  const capture = (chunk) => {
    childBytes += chunk.length;
    if (childBytes > 1024 * 1024) controller.abort();
    else childText += chunk.toString("utf8");
  };
  runtime.stdout.on("data", capture);
  runtime.stderr.on("data", capture);
  await healthy();
  const unauthorized = await invoke(fullPacket("review", "review"), controller.signal, false);
  assert.equal(unauthorized.status, 401);
  await unauthorized.arrayBuffer();
  checks.push({ id: "local-auth", status: "passed" });
  const legacy = await invoke({ schemaVersion: 1 });
  assert.equal(legacy.status, 400);
  await legacy.arrayBuffer();
  checks.push({ id: "legacy-default-rejected", status: "passed" });
  if (process.env.SMOKE_EXPECT_NAMESPACE_REFUSAL === "true") {
    const response = await invoke(fullPacket("namespace-denied", "task"));
    const refused = await response.json();
    assert.equal(response.status, 500);
    assert.equal(refused.error?.diagnostics?.failureCode, "DSH_ISOLATION_UNAVAILABLE");
    assert.equal(counters.size, 0);
    checks.push({ id: "namespace-required-before-model", status: "passed" });
  } else {
    let repeated;
    for (const [id, operation, write, native] of [
      ["review", "review", false, false],
      ["task", "task", false, false],
      ["diagnose", "diagnose", false, false],
      ["fix", "fix", true, false],
      ["implement", "implement", true, false],
      ["task-write", "task", true, false],
      ["native-write", "task", true, true],
    ]) {
      const start = Date.now();
      const task = fullPacket(id, operation, {
        write,
        native,
        timeoutMs: emulated ? 60_000 : 30_000,
      });
      const response = await invoke(task);
      const reply = await response.json();
      assert.equal(response.status, 200, JSON.stringify(reply));
      assert.equal(reply.schemaVersion, 3);
      assert.equal(reply.taskId, task.taskId);
      assert.equal(canonicalFullJson(reply.binding), canonicalFullJson(task.binding));
      assert.equal(reply.taskDigest, fullHash(canonicalFullJson(task)));
      assert.equal(reply.workspaceDigest, task.workspace.digest);
      assert.deepEqual(reply.output, fullOutput(operation));
      assert.deepEqual(reply.sandboxEvidence, {
        backend: "agentarts-bwrap",
        credentialMediated: true,
        processIsolated: true,
        networkIsolated: true,
        workspaceAccess: write ? "read-write" : "read-only",
      });
      assert.equal(reply.modelExecution.kind, "deterministic-fixture");
      assert.equal(reply.modelExecution.requestCount, counters.get(id));
      if (write) {
        assert.equal(reply.delta.inputDigest, task.workspace.digest);
        assert.equal(reply.delta.changes.length, 1);
        assert.equal(reply.delta.changes[0].file.content, fullCorrected);
        assert.equal(reply.delta.changes[0].file.sha256, fullHash(fullCorrected));
      } else assert.equal(reply.delta, null);
      if (native) assert(reply.observedTools.includes("bash"));
      else
        assert(reply.toolReceipts.some((receipt) => receipt.id === "workspace.read" && receipt.ok));
      checks.push({
        id,
        status: "passed",
        durationMs: Date.now() - start,
        providerRequests: reply.modelExecution.requestCount,
        tools: reply.toolReceipts.map(({ id, ok }) => ({ id, ok })),
        observedTools: reply.observedTools ?? [],
      });
      repeated ??= task;
    }
    const duplicate = await invoke(repeated);
    assert.equal(duplicate.status, 409);
    await duplicate.arrayBuffer();
    checks.push({ id: "duplicate", status: "passed" });
    const denied = fullPacket("denied", "fix", { write: true });
    denied.trust = "untrusted";
    const permission = await invoke(denied);
    assert.equal(permission.status, 400);
    await permission.arrayBuffer();
    assert.equal(counters.has("denied"), false);
    checks.push({ id: "permission-denied", status: "passed" });
    const invalid = await invoke(fullPacket("invalid-output", "task"));
    const invalidReply = await invalid.json();
    assert.equal(invalid.status, 500);
    assert.equal(invalidReply.error?.diagnostics?.failureCode, "DSH_MALFORMED_OUTPUT");
    checks.push({ id: "invalid-output-rejected", status: "passed" });
    const timeout = await invoke(
      fullPacket("timeout", "task", { timeoutMs: emulated ? 10_000 : 2500 }),
    );
    assert.equal(timeout.status, 504);
    await timeout.arrayBuffer();
    await idle();
    checks.push({ id: "timeout", status: "passed" });
    const abort = new AbortController();
    const pending = invoke(
      fullPacket("cancel", "task", { timeoutMs: 60_000 }),
      AbortSignal.any([controller.signal, abort.signal]),
    );
    for (let i = 0; i < 100 && !counters.has("cancel"); i++) await delay(50);
    assert(counters.has("cancel"));
    abort.abort();
    await pending.catch(() => undefined);
    await idle();
    checks.push({ id: "cancel", status: "passed" });
  }
  assert.equal(modelFailure, undefined);
  assert(!childText.includes(modelKey));
  assert(!childText.includes(localKey));
} catch (error) {
  failure = error;
} finally {
  clearTimeout(overall);
  controller.abort();
  if (runtime && runtime.exitCode === null && runtime.signalCode === null) {
    process.kill(-runtime.pid, "SIGTERM");
    await Promise.race([new Promise((resolve) => runtime.once("close", resolve)), delay(6000)]);
    if (runtime.exitCode === null && runtime.signalCode === null)
      process.kill(-runtime.pid, "SIGKILL");
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  if (secretRoot) await rm(secretRoot, { recursive: true, force: true });
}
const record = {
  schemaVersion: 1,
  mode: "container",
  suiteVersion: "full-runtime-v3-container-v1",
  status: failure ? "failed" : "passed",
  evidence: "real-dsh-deterministic-model",
  cloudCalled: false,
  realModelCalled: false,
  githubPublished: false,
  architecture: process.arch,
  emulated,
  sourceCommit: process.env.SMOKE_SOURCE_SHA ?? "unknown",
  sourceDirty: process.env.SMOKE_SOURCE_DIRTY ?? "unknown",
  buildInputDigest: process.env.SMOKE_SOURCE_TREE_DIGEST ?? "unknown",
  imageId: process.env.SMOKE_IMAGE_ID ?? "unknown",
  durationMs: Date.now() - startedAt,
  checks,
  runtimeEvents: childText.split("\n").filter((line) => line.startsWith("{")),
  warnings: [
    "Deterministic model responses test the actual production container, DSH and security boundaries; they do not measure live model correctness.",
    "No GitHub publication or cloud platform verification occurred.",
  ],
};
if (failure)
  record.error = {
    name: failure.name ?? "Error",
    message: String(failure.message ?? failure)
      .replaceAll(modelKey, "[REDACTED]")
      .replaceAll(localKey, "[REDACTED]"),
    runtimeDiagnostics: childText
      .slice(-8192)
      .replaceAll(modelKey, "[REDACTED]")
      .replaceAll(localKey, "[REDACTED]"),
    ...(modelFailure === undefined
      ? {}
      : {
          fixtureFailure: String(modelFailure.message ?? modelFailure)
            .slice(0, 1024)
            .replaceAll(modelKey, "[REDACTED]")
            .replaceAll(localKey, "[REDACTED]"),
        }),
  };
process.stdout.write(JSON.stringify(record) + "\n");
if (failure) process.exitCode = 1;
