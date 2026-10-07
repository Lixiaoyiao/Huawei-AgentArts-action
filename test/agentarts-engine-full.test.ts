import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTurnRequest } from "../src/agent/contracts.js";
import { AgentArtsFullEngine } from "../src/agentarts/engine-full.js";
import { createDshRuntime, disposeDshRuntime } from "../src/dsh/runner.js";
import { createWorkspaceSnapshot } from "../src/write/workspace.js";
import {
  createWorkspaceDelta,
  materializeWorkspaceManifest,
} from "../src/agentarts/workspace-transfer.js";
import {
  runtimeTaskDigest,
  type RuntimeTask,
  type RuntimeTaskReply,
} from "../src/agentarts/runtime-task-protocol.js";

// Direct simulated Runtime responses exercise effective FS authority independently
// of main's stricter write admission. No DSH, Docker, LLM, Huawei or GitHub calls.
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function setup(change: boolean, productionEvidence = false) {
  const root = await mkdtemp(join(tmpdir(), "agentarts-full-grant-"));
  directories.push(root);
  const source = join(root, "source"),
    worker = join(root, "worker");
  await mkdir(source);
  await writeFile(join(source, "answer.ts"), "export const answer = 0;\n");
  const snapshot = await createWorkspaceSnapshot(
    { kind: "materialized-tree", root: source },
    worker,
  );
  const runtime = await createDshRuntime();
  directories.push(runtime.root);
  const binding = {
    repository: "fixture/no-edit",
    entity: { kind: "repository" as const },
    ref: "main",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
  };
  const invoke = vi.fn(async (task: RuntimeTask): Promise<RuntimeTaskReply> => {
    const remote = join(root, "remote");
    await materializeWorkspaceManifest(task.workspace, remote);
    if (change) await writeFile(join(remote, "answer.ts"), "export const answer = 42;\n");
    return {
      schemaVersion: 3,
      taskId: task.taskId,
      operation: task.operation,
      binding: task.binding,
      taskDigest: runtimeTaskDigest(task),
      workspaceDigest: task.workspace.digest,
      durationMs: 1,
      output: {
        protocolVersion: 1,
        operation: "task",
        state: "final",
        summary: "Explicit simulated write-intent/read-only-grant result",
        findings: [],
      },
      toolReceipts: [],
      delta: await createWorkspaceDelta(task.workspace, remote),
      sandboxEvidence: {
        backend: productionEvidence ? "agentarts-bwrap" : "insecure-test",
        credentialMediated: true,
        processIsolated: productionEvidence,
        networkIsolated: false,
        workspaceAccess: "read-only",
      },
    };
  });
  const engine = new AgentArtsFullEngine(
    {
      origin: "https://fixture.invalid",
      runtimeName: "fixture-runtime",
      endpoint: "fixed-v3",
      apiKey: "synthetic-invocation-key",
    },
    "trusted-write",
    binding,
    [],
    {
      workspace: { tempRoot: root, agentWorkspace: worker, snapshot },
      runtime,
      mode: "controlled",
      operationIdentity: "synthetic-effective-grant",
      invoke,
      ...(productionEvidence ? {} : { allowInsecureRuntimeTestOnly: true }),
    },
  );
  const request: AgentTurnRequest = {
    schemaVersion: 1,
    operation: "task",
    requestedAccess: "write",
    instructions: "Synthetic direct boundary test",
    context: { taskContext: { repository: binding.repository } },
    tools: [
      {
        id: "workspace.read",
        provider: "builtin",
        description: "read",
        permissions: ["read"],
        inputSchema: {},
      },
    ],
    workspacePath: worker,
    deadlineMs: Date.now() + 30_000,
    timeoutMs: 30_000,
  };
  return { engine, request, source, worker, runtime, invoke };
}
describe("FullEngine effective workspace grants (simulated Runtime)", () => {
  it("rejects production evidence with a network namespace boundary missing", async () => {
    const test = await setup(false, true);
    try {
      await expect(test.engine.runTurn(test.request)).rejects.toThrow(
        "isolated workspace boundary",
      );
      expect(await readFile(join(test.worker, "answer.ts"), "utf8")).toContain("= 0");
    } finally {
      await disposeDshRuntime(test.runtime);
    }
  });
  it("accepts an unchanged write-intent turn with actual read-only grants and read-only evidence", async () => {
    const test = await setup(false);
    try {
      const result = await test.engine.runTurn(test.request);
      expect(result.metadata.isolationReport.workspaceAccess).toBe("read-only");
      expect(await readFile(join(test.worker, "answer.ts"), "utf8")).toContain("= 0");
    } finally {
      await disposeDshRuntime(test.runtime);
    }
  });
  it("rejects a forged nonempty delta without edit authority before any Controller file changes", async () => {
    const test = await setup(true);
    try {
      await expect(test.engine.runTurn(test.request)).rejects.toThrow(
        "effective workspace write grant",
      );
      expect(await readFile(join(test.worker, "answer.ts"), "utf8")).toContain("= 0");
      expect(await readFile(join(test.source, "answer.ts"), "utf8")).toContain("= 0");
      await expect(test.engine.runTurn(test.request)).rejects.toThrow("reuse");
      expect(test.invoke).toHaveBeenCalledTimes(1);
    } finally {
      await disposeDshRuntime(test.runtime);
    }
  });
});
