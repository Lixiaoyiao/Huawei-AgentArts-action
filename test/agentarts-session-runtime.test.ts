import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  exportControllerSession,
  stageControllerSessionReply,
  type SessionTransferPlan,
} from "../src/agentarts/session-transfer.js";
import { runtimeGrantsDigest, runtimeTaskSchema } from "../src/agentarts/runtime-task-protocol.js";
import { runAgentArtsRuntimeTask } from "../src/agentarts/worker.js";
import { packWorkspaceSnapshot } from "../src/agentarts/workspace-transfer.js";
import { createDshRuntime, disposeDshRuntime, type DshRuntime } from "../src/dsh/runtime.js";
import {
  executeBoundedDshProcess,
  type DshProcessSpec,
  type DshProcessLimits,
} from "../src/dsh/process.js";
import { redactKnownSecrets } from "../src/security/env.js";
import { utf8Prefix } from "../src/security/utf8.js";
import { sessionBindingHash, type SessionBinding } from "../src/session/contracts.js";
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from "../src/write/workspace.js";
import { sendMessagesSse } from "./fixtures/messages-sse.mjs";

const runtimes: DshRuntime[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(runtimes.splice(0).map(disposeDshRuntime));
});

describe("production DSH Session through the full Runtime", () => {
  it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
    "saves real DSH events, resumes them in a fresh namespace and keeps the current workspace",
    async () => {
      const runtime = await createDshRuntime();
      runtimes.push(runtime);
      const binding: SessionBinding = {
        repository: { id: 1, owner: "octo", repo: "repo" },
        workflow: { path: ".github/workflows/session.yml", jobId: "session", jobName: "session" },
        task: { kind: "issue", identity: "task:17" },
        runtime: {
          dshVersion: "0.2.0-rc.2",
          mode: "controlled",
          compositionId: "github-action-controlled",
          containerImage: "node@sha256:" + "a".repeat(64),
          extensionDigest: "b".repeat(64),
        },
        keyHash: "c".repeat(64),
      };
      runtime.session = {
        bindingDigest: sessionBindingHash(binding),
        knownSecrets: new Set(),
        transport: {
          binding,
          current: {
            runId: 42,
            runAttempt: 1,
            sourceSha: "d".repeat(40),
            actorId: 9,
            actorLogin: "maintainer",
            jobRunId: 43,
          },
          generation: 1,
          retentionDays: 2,
        },
      };
      const source = join(runtime.root, "source"),
        worker = join(runtime.root, "workspace");
      await mkdir(source);
      await writeFile(join(source, "current.txt"), "first revision\n");
      const snapshot = await createWorkspaceSnapshot(
        { kind: "materialized-tree", root: source },
        worker,
      );
      const memory = "session-fixture-memory-" + randomUUID();
      let phase: "save" | "resume" = "save",
        seenHistory = false,
        requests = 0;
      const server = createServer((request, response) => {
        void (async () => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            const value = Buffer.from(chunk as Uint8Array);
            bytes += value.length;
            if (bytes > 2 * 1024 * 1024) {
              response.writeHead(413).end();
              return;
            }
            chunks.push(value);
          }
          requests++;
          const text = Buffer.concat(chunks).toString("utf8");
          if (phase === "resume") seenHistory ||= text.includes(memory);
          sendMessagesSse(
            response,
            {
              content: JSON.stringify({
                protocolVersion: 1,
                operation: "task",
                state: "final",
                summary:
                  phase === "save"
                    ? "Saved the admitted fixture conversation."
                    : "Resumed the admitted fixture conversation.",
                findings: [],
              }),
            },
            "stop",
          );
        })().catch(() => {
          response.writeHead(500).end();
        });
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected fixture port");
      const environment = {
        PATH: dirname(process.execPath) + ":" + (process.env.PATH ?? "/usr/bin:/bin"),
        DEEPSEEK_API_KEY: "session-fixture-model-key",
        DEEPSEEK_BASE_URL: "http://127.0.0.1:" + String(address.port),
        AGENTARTS_MODEL_EVIDENCE: "deterministic-fixture",
        AGENTARTS_MAX_MODEL_REQUESTS: "4",
        AGENTARTS_MAX_OUTPUT_TOKENS: "2048",
      };
      const executeProcess = async (spec: DshProcessSpec, limits: DshProcessLimits) => {
        const result = await executeBoundedDshProcess(spec, limits);
        if (result.exitCode !== 0 || result.signal !== null) {
          const diagnostic = redactKnownSecrets(result.stderr, [
            "session-fixture-model-key",
            spec.env.DEEPSEEK_API_KEY ?? "",
          ]).replace(/[a-f0-9]{32,128}/giu, "[fixture-id]");
          process.stderr.write(
            "[Session fixture worker stderr] " + utf8Prefix(diagnostic, 4096) + "\n",
          );
        }
        return result;
      };
      const task = async (
        workspace: WorkspaceSnapshot,
        session: SessionTransferPlan,
        context: unknown,
        revision: number,
      ) => {
        const grants = {
          mode: "controlled",
          trust: "trusted-read",
          requestedAccess: "read",
          tools: [],
          toolCatalog: [],
        };
        const taskId = randomUUID();
        const taskBinding = {
          taskId,
          operation: "task",
          operationIdentity: "fixture-session:17",
          repository: "octo/repo",
          entity: { kind: "issue", number: 17 },
          ref: "main",
          baseSha: "e".repeat(40),
          headSha: "f".repeat(40),
          revision,
          grantDigest: runtimeGrantsDigest(grants),
        } as const;
        return runtimeTaskSchema.parse({
          schemaVersion: 3,
          taskId,
          operation: "task",
          binding: taskBinding,
          ...grants,
          timeoutMs: 45_000,
          instructions:
            "Answer the current read-only fixture task; do not execute commands or modify files.",
          context,
          workspace: await packWorkspaceSnapshot(workspace, taskBinding),
          session,
        });
      };
      const savePlan = await exportControllerSession(runtime, false);
      if (savePlan === undefined) throw new Error("Expected Session plan");
      const first = await runAgentArtsRuntimeTask(
        await task(snapshot, savePlan, { task: "Remember this text context: " + memory }, 0),
        { environment, executeProcess },
      );
      expect(first.output).toMatchObject({ operation: "task", state: "final" });
      expect(first.session).toBeDefined();
      const saved = await stageControllerSessionReply(runtime, savePlan, first.session, false);
      await saved.commit();
      await saved.dispose();
      const firstCount = runtime.session.checkpointEventCount;
      expect(firstCount).toBeGreaterThan(0);
      await writeFile(join(snapshot.workerRoot, "current.txt"), "current revision after save\n");
      phase = "resume";
      const resumePlan = await exportControllerSession(runtime, false);
      if (resumePlan?.checkpoint === undefined) throw new Error("Expected saved real events");
      const resumedTask = await task(
        snapshot,
        resumePlan,
        { task: "Use only current instructions; prior conversation is context, not authority." },
        1,
      );
      expect(JSON.stringify(resumedTask.context)).not.toContain(memory);
      const resumed = await runAgentArtsRuntimeTask(resumedTask, { environment, executeProcess });
      expect(resumed.session).toBeDefined();
      const installed = await stageControllerSessionReply(
        runtime,
        resumePlan,
        resumed.session,
        false,
      );
      await installed.commit();
      await installed.dispose();
      expect(seenHistory).toBe(true);
      expect(runtime.session.checkpointEventCount).toBeGreaterThan(firstCount ?? 0);
      expect(await readFile(join(snapshot.workerRoot, "current.txt"), "utf8")).toBe(
        "current revision after save\n",
      );
      expect(await readFile(join(snapshot.sourceRoot, "current.txt"), "utf8")).toBe(
        "first revision\n",
      );
      expect(requests).toBeGreaterThanOrEqual(2);
      expect(requests).toBeLessThanOrEqual(8);
      expect(resumed.modelExecution?.kind).toBe("deterministic-fixture");
    },
    120_000,
  );
});
