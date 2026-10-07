import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";

import {
  collectRuntimeSession,
  exportControllerSession,
  prepareRuntimeSession,
  sessionTransferPlanDigest,
  stageControllerSessionReply,
  type SessionTransferPlan,
} from "../src/agentarts/session-transfer.js";
import { createDshRuntime, disposeDshRuntime, type DshRuntime } from "../src/dsh/runtime.js";
import { sessionBindingHash, type SessionBinding } from "../src/session/contracts.js";
import { runtimeGrantsDigest, runtimeTaskSchema } from "../src/agentarts/runtime-task-protocol.js";
import { createWorkspaceTransferManifest } from "../src/agentarts/workspace-transfer.js";

const faults = vi.hoisted(() => ({
  abortAfter: "",
  controller: undefined as AbortController | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FsPromises>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      const source = typeof args[0] === "string" ? args[0] : "";
      const destination = typeof args[1] === "string" ? args[1] : "";
      if (
        (faults.abortAfter === "backup" && basename(destination) === "backup") ||
        (faults.abortAfter === "install" && basename(source) === "candidate")
      ) {
        faults.abortAfter = "";
        faults.controller?.abort();
      }
    },
  };
});
beforeEach(() => {
  faults.abortAfter = "";
  faults.controller = undefined;
});

const runtimes: DshRuntime[] = [];
const sessionId = "session-11111111-1111-4111-8111-111111111111";
const fakeSecret = "controller-unit-secret-not-a-real-key";
const binding: SessionBinding = {
  repository: { id: 1, owner: "octo", repo: "repo" },
  workflow: { path: ".github/workflows/action.yml", jobId: "dsh", jobName: "DSH" },
  task: { kind: "issue", identity: "task:17" },
  runtime: {
    dshVersion: "0.2.0-rc.2",
    mode: "controlled",
    compositionId: "controlled",
    containerImage: "node@sha256:" + "a".repeat(64),
    extensionDigest: "b".repeat(64),
  },
  keyHash: "c".repeat(64),
};
const current = {
  runId: 42,
  runAttempt: 1,
  sourceSha: "d".repeat(40),
  actorId: 9,
  actorLogin: "maintainer",
  jobRunId: 43,
};
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(disposeDshRuntime));
});
async function runtime(controller = false): Promise<DshRuntime> {
  const value = await createDshRuntime();
  runtimes.push(value);
  if (controller)
    value.session = {
      bindingDigest: sessionBindingHash(binding),
      knownSecrets: new Set([fakeSecret]),
      transport: { binding, current, generation: 1, retentionDays: 2 },
    };
  return value;
}
async function plan(value: DshRuntime, write = false): Promise<SessionTransferPlan> {
  const result = await exportControllerSession(value, write);
  if (result === undefined) throw new Error("Expected enabled Session");
  return result;
}
/** Unit-only stand-in for stopped DSH; real lifecycle coverage lives in the Runtime integration test. */
async function completedWorker(
  value: DshRuntime,
  input: SessionTransferPlan,
  text = "remember fixture",
) {
  const prefix =
    input.checkpoint === undefined
      ? JSON.stringify(
          sessionFormatCatalog.encodeCurrentHeader(
            {
              version: 4,
              id: sessionId,
              createdAt: Date.now(),
              cwd: "/workspace",
              isSeeded: false,
              delegationDepth: 0,
            },
            0,
          ),
        ) + "\n"
      : Buffer.from(input.checkpoint.payloadBase64, "base64").toString("utf8");
  const before = value.session?.checkpointEventCount ?? 0;
  const events = [
    { type: "turn/start", data: { turn: before / 3 + 1 } },
    {
      type: "user/message",
      data: {
        id: "message-" + String(before),
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "user" },
      },
      surfaceOp: "append",
    },
    { type: "turn/end", data: { turn: before / 3 + 1, reason: { kind: "completed" } } },
  ].map((event, index) =>
    JSON.stringify({ ...event, seq: before + index, time: Date.now() + index }),
  );
  const storage = join(value.dshHome, "sessions", "--workspace--", sessionId);
  await mkdir(storage, { recursive: true });
  await writeFile(join(storage, "session.v4.jsonl"), prefix + events.join("\n") + "\n");
  await writeFile(
    join(value.dshHome, "action-state", "session-admission.json"),
    JSON.stringify({
      schemaVersion: 1,
      bindingDigest: input.bindingDigest,
      sessionId,
      source: input.checkpoint === undefined ? "startup" : "resume",
      workingDirectory: "/workspace",
      permissionMode: input.permissionMode,
      permissionPreset: input.permissionMode,
      approvalPolicy: "never",
      beforeSeq: before,
      afterSeq: before,
    }),
  );
}
async function firstReply(controller: DshRuntime) {
  const input = await plan(controller);
  const worker = await runtime();
  await prepareRuntimeSession(worker, input, false, ["worker-fixture-proxy"]);
  await completedWorker(worker, input);
  return { input, reply: await collectRuntimeSession(worker, input, false) };
}

describe("bounded DSH Session supervisor transport", () => {
  it("keeps disabled Sessions absent and rejects missing original provenance", async () => {
    const value = await runtime();
    expect(await exportControllerSession(value, false)).toBeUndefined();
    value.session = { bindingDigest: "a".repeat(64), knownSecrets: new Set() };
    await expect(exportControllerSession(value, false)).rejects.toThrow(/provenance/u);
  });
  it("transfers only safe plan metadata and recalculated current authority", async () => {
    const controller = await runtime(true);
    const input = await plan(controller);
    expect(JSON.stringify(input)).not.toContain(fakeSecret);
    expect(JSON.stringify(input)).not.toContain("knownSecrets");
    expect(input.permissionMode).toBe("read-only");
    const worker = await runtime();
    await prepareRuntimeSession(worker, input, false, ["local-only-fixture"]);
    const file = JSON.parse(
      await readFile(join(worker.dshHome, "action-state", "session-plan.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(file).toEqual({
      schemaVersion: 1,
      bindingDigest: input.bindingDigest,
      permissionMode: "read-only",
      workingDirectory: "/workspace",
    });
    await expect(prepareRuntimeSession(await runtime(), input, true)).rejects.toThrow(/authority/u);
  });
  it("rejects an otherwise valid untrusted task with a DSH Session", async () => {
    const controller = await runtime(true);
    const session = await plan(controller);
    const taskId = randomUUID();
    const grants = {
      mode: "controlled" as const,
      trust: "untrusted" as const,
      requestedAccess: "read" as const,
      tools: [],
      toolCatalog: [],
    };
    const binding = {
      taskId,
      operation: "task" as const,
      operationIdentity: "unit-task-operation",
      repository: "octo/repo",
      entity: { kind: "issue" as const, number: 17 },
      ref: "main",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      revision: 0,
      grantDigest: runtimeGrantsDigest(grants),
    };
    const task = {
      schemaVersion: 3,
      taskId,
      operation: "task",
      binding,
      ...grants,
      timeoutMs: 1000,
      instructions: "Unit-only context task",
      context: {},
      workspace: createWorkspaceTransferManifest(binding, []),
    };
    expect(runtimeTaskSchema.safeParse(task).success).toBe(true);
    expect(runtimeTaskSchema.safeParse({ ...task, session }).success).toBe(false);
  });
  it("stages save and continuation while preserving history and the original workspace", async () => {
    const controller = await runtime(true);
    const workspace = join(controller.root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "current.txt"), "current revision");
    const { input, reply } = await firstReply(controller);
    const stage = await stageControllerSessionReply(controller, input, reply, false);
    expect(controller.session?.sessionId).toBeUndefined();
    await stage.commit();
    await stage.dispose();
    expect(controller.session?.sessionId).toBe(sessionId);
    expect(controller.session?.checkpointEventCount).toBe(3);
    const next = await plan(controller);
    const worker = await runtime();
    await prepareRuntimeSession(worker, next, false);
    expect(worker.session?.checkpointEventCount).toBe(3);
    await completedWorker(worker, next, "new current task");
    const second = await collectRuntimeSession(worker, next, false);
    const nextStage = await stageControllerSessionReply(controller, next, second, false);
    await nextStage.commit();
    await nextStage.dispose();
    expect(controller.session?.checkpointEventCount).toBe(6);
    expect(await readFile(join(workspace, "current.txt"), "utf8")).toBe("current revision");
    expect((await plan(controller)).checkpoint?.payloadBase64).toBe(
      second.checkpoint.payloadBase64,
    );
  });
  it.each(["binding", "source", "generation", "digest"] as const)(
    "rejects changed %s before import",
    async (kind) => {
      const controller = await runtime(true);
      const { input, reply } = await firstReply(controller);
      if (kind === "binding") reply.checkpoint.manifest.repository.id++;
      if (kind === "source") reply.checkpoint.manifest.issuer.actorId++;
      if (kind === "generation") reply.checkpoint.manifest.session.generation++;
      if (kind === "digest") reply.checkpoint.manifest.payload.sha256 = "e".repeat(64);
      await expect(stageControllerSessionReply(controller, input, reply, false)).rejects.toThrow();
      expect(controller.session?.sessionId).toBeUndefined();
      expect(await readdir(join(controller.dshHome, "sessions"))).toEqual([]);
    },
  );
  it("rejects reply-plan mismatch and unknown credential fields", async () => {
    const controller = await runtime(true);
    const { input, reply } = await firstReply(controller);
    await expect(
      stageControllerSessionReply(
        controller,
        input,
        { ...reply, planDigest: "f".repeat(64) },
        false,
      ),
    ).rejects.toThrow(/another task/u);
    await expect(
      prepareRuntimeSession(await runtime(), { ...input, knownSecrets: ["bad"] }, false),
    ).rejects.toThrow();
  });
  it("refuses noncanonical base64, secret history and corrupted payload", async () => {
    const controller = await runtime(true);
    const { input, reply } = await firstReply(controller);
    await expect(
      stageControllerSessionReply(
        controller,
        input,
        {
          ...reply,
          checkpoint: { ...reply.checkpoint, payloadBase64: reply.checkpoint.payloadBase64 + "=" },
        },
        false,
      ),
    ).rejects.toThrow(/encoding/u);
    const worker = await runtime();
    await prepareRuntimeSession(worker, input, false, [fakeSecret]);
    await completedWorker(worker, input, fakeSecret);
    await expect(collectRuntimeSession(worker, input, false)).rejects.toThrow(/credential/u);
    const bad = Buffer.from("not a checkpoint\n");
    await expect(
      stageControllerSessionReply(
        controller,
        input,
        {
          ...reply,
          checkpoint: {
            manifest: {
              ...reply.checkpoint.manifest,
              payload: {
                file: "session.jsonl",
                bytes: bad.length,
                sha256: createHash("sha256").update(bad).digest("hex"),
              },
            },
            payloadBase64: bad.toString("base64"),
          },
        },
        false,
      ),
    ).rejects.toThrow();
  });
  it.each(["image", "file"] as const)(
    "refuses native %s attachments without restoring files",
    async (type) => {
      const controller = await runtime(true);
      const { input, reply } = await firstReply(controller);
      const rows = Buffer.from(reply.checkpoint.payloadBase64, "base64")
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((row) => JSON.parse(row) as { type: string; data?: { content?: unknown[] } });
      const user = rows.find((row) => row.type === "user/message");
      if (user?.data === undefined) throw new Error("Expected fixture message");
      user.data.content = [
        type === "image"
          ? {
              type,
              attachment: {
                attachmentId: "sha256:" + "a".repeat(64),
                mediaType: "image/png",
                bytes: 68,
                width: 1,
                height: 1,
              },
            }
          : {
              type,
              attachment: {
                attachmentId: "sha256:" + "a".repeat(64),
                name: "fixture.pdf",
                bytes: 100,
              },
            },
      ];
      const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      reply.checkpoint.payloadBase64 = bytes.toString("base64");
      reply.checkpoint.manifest.payload = {
        file: "session.jsonl",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      await expect(stageControllerSessionReply(controller, input, reply, false)).rejects.toThrow(
        /nonportable/u,
      );
      expect(await readdir(join(controller.dshHome, "sessions"))).toEqual([]);
    },
  );
  it("rejects duplicate JSON keys inside raw history even when its byte digest is correct", async () => {
    const controller = await runtime(true);
    const { input, reply } = await firstReply(controller);
    const text = Buffer.from(reply.checkpoint.payloadBase64, "base64")
      .toString("utf8")
      .replace('"role":"user"', '"role":"assistant","role":"user"');
    const bytes = Buffer.from(text);
    reply.checkpoint.payloadBase64 = bytes.toString("base64");
    reply.checkpoint.manifest.payload = {
      file: "session.jsonl",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await expect(stageControllerSessionReply(controller, input, reply, false)).rejects.toThrow(
      /duplicate/u,
    );
  });
  it("discards a validated stage and rejects double commit without overwriting installed history", async () => {
    const controller = await runtime(true);
    const { input, reply } = await firstReply(controller);
    const discarded = await stageControllerSessionReply(controller, input, reply, false);
    await discarded.dispose();
    await expect(discarded.commit()).rejects.toThrow(/available/u);
    const installed = await stageControllerSessionReply(controller, input, reply, false);
    await installed.commit();
    await expect(installed.commit()).rejects.toThrow(/available/u);
    await installed.dispose();
    expect((await plan(controller)).checkpoint?.payloadBase64).toBe(reply.checkpoint.payloadBase64);
  });
  it("refuses unchanged replay and any rewrite of imported history", async () => {
    const controller = await runtime(true);
    const first = await firstReply(controller);
    const installed = await stageControllerSessionReply(
      controller,
      first.input,
      first.reply,
      false,
    );
    await installed.commit();
    await installed.dispose();
    const input = await plan(controller);
    if (input.checkpoint === undefined) throw new Error("Expected resume payload");
    await expect(
      stageControllerSessionReply(
        controller,
        input,
        {
          schemaVersion: 1,
          planDigest: sessionTransferPlanDigest(input),
          checkpoint: input.checkpoint,
        },
        false,
      ),
    ).rejects.toThrow(/replayed/u);
    const worker = await runtime();
    await prepareRuntimeSession(worker, input, false);
    await completedWorker(worker, input);
    const reply = await collectRuntimeSession(worker, input, false);
    const text = Buffer.from(reply.checkpoint.payloadBase64, "base64")
      .toString("utf8")
      .replace("remember fixture", "rewritten fixture");
    const bytes = Buffer.from(text);
    reply.checkpoint.payloadBase64 = bytes.toString("base64");
    reply.checkpoint.manifest.payload = {
      file: "session.jsonl",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await expect(stageControllerSessionReply(controller, input, reply, false)).rejects.toThrow(
      /rewrote/u,
    );
  });
  it("does not install a staged result after cancellation or deadline", async () => {
    const controller = await runtime(true);
    const { input, reply } = await firstReply(controller);
    const abort = new AbortController();
    const staged = await stageControllerSessionReply(controller, input, reply, false, {
      signal: abort.signal,
    });
    abort.abort();
    await expect(staged.commit()).rejects.toThrow();
    await staged.dispose();
    await expect(
      stageControllerSessionReply(controller, input, reply, false, { deadlineMs: Date.now() - 1 }),
    ).rejects.toThrow(/deadline/u);
    expect(controller.session?.sessionId).toBeUndefined();
  });
  it.each(["backup", "install"])(
    "restores original persistence after cancellation following the %s rename",
    async (phase) => {
      const controller = await runtime(true);
      const initial = await firstReply(controller);
      const first = await stageControllerSessionReply(
        controller,
        initial.input,
        initial.reply,
        false,
      );
      await first.commit();
      await first.dispose();
      const before = await plan(controller);
      const worker = await runtime();
      await prepareRuntimeSession(worker, before, false);
      await completedWorker(worker, before, "cancelled continuation");
      const reply = await collectRuntimeSession(worker, before, false);
      const abort = new AbortController();
      const staged = await stageControllerSessionReply(controller, before, reply, false, {
        signal: abort.signal,
      });
      faults.abortAfter = phase;
      faults.controller = abort;
      await expect(staged.commit()).rejects.toThrow();
      await staged.dispose();
      expect(controller.session?.checkpointEventCount).toBe(3);
      expect((await plan(controller)).checkpoint?.payloadBase64).toBe(
        before.checkpoint?.payloadBase64,
      );
    },
  );
  it("refuses redirected or nonempty startup storage and missing admission", async () => {
    const controller = await runtime(true);
    await mkdir(join(controller.dshHome, "sessions", "unexpected"));
    await expect(plan(controller)).rejects.toThrow(/empty/u);
    const fresh = await runtime(true);
    const input = await plan(fresh),
      worker = await runtime();
    await prepareRuntimeSession(worker, input, false);
    await expect(collectRuntimeSession(worker, input, false)).rejects.toThrow();
  });
});
