import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { DshConfigurationError } from "../dsh/errors.js";
import type { DshRuntime } from "../dsh/runtime.js";

const admissionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  sessionId: z.string().regex(/^session-[a-f0-9-]{36}$/u),
  source: z.enum(["startup", "resume"]),
  workingDirectory: z.literal("/workspace"),
  permissionMode: z.enum(["read-only", "workspace-write"]),
  approvalPolicy: z.literal("never"),
  permissionPreset: z.enum(["read-only", "workspace-write"]),
  beforeSeq: z.number().int().nonnegative(),
  afterSeq: z.number().int().nonnegative(),
});

/** Only current Controller policy is written; checkpoint content supplies no authority. */
export async function prepareWorkerSession(
  runtime: DshRuntime,
  workspaceWrite: boolean,
): Promise<void> {
  const session = runtime.session;
  if (session === undefined) return;
  const state = join(runtime.dshHome, "action-state");
  await rm(join(state, "session-admission.json"), { force: true });
  await writeFile(
    join(state, "session-plan.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      bindingDigest: session.bindingDigest,
      permissionMode: workspaceWrite ? "workspace-write" : "read-only",
      workingDirectory: "/workspace",
      ...(session.sessionId === undefined
        ? {}
        : {
            sessionId: session.sessionId,
            checkpointEventCount: session.checkpointEventCount,
          }),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

/** A completed fresh worker must prove it used the exact current plan. */
export async function collectWorkerSession(
  runtime: DshRuntime,
  workspaceWrite: boolean,
): Promise<void> {
  const session = runtime.session;
  if (session === undefined) return;
  const path = join(runtime.dshHome, "action-state", "session-admission.json");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024) {
    throw new DshConfigurationError("Session admission audit is not a bounded regular file");
  }
  let value: unknown;
  try {
    const bytes = await readFile(path);
    if (bytes.length > 8 * 1024) throw new Error("oversized");
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new DshConfigurationError("Session admission audit must be strict UTF-8 JSON");
  }
  const parsed = admissionSchema.safeParse(value);
  const mode = workspaceWrite ? "workspace-write" : "read-only";
  if (
    !parsed.success ||
    parsed.data.bindingDigest !== session.bindingDigest ||
    parsed.data.permissionMode !== mode ||
    parsed.data.permissionPreset !== mode ||
    parsed.data.source !== (session.sessionId === undefined ? "startup" : "resume") ||
    (session.sessionId !== undefined && parsed.data.sessionId !== session.sessionId) ||
    parsed.data.afterSeq < parsed.data.beforeSeq
  ) {
    throw new DshConfigurationError(
      "Session admission audit does not match the current Controller policy",
    );
  }
  session.sessionId = parsed.data.sessionId;
}
