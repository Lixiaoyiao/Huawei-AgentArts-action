/** Original DSH checkpoints travel between trusted supervisors, never as AgentArts Session state. */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { DshRuntime } from "../dsh/runtime.js";
import { PolicyDeniedError } from "../errors.js";
import {
  exportSessionCheckpoint,
  importSessionCheckpoint,
  SESSION_CHECKPOINT_LIMITS,
  validateSessionPayload,
} from "../session/checkpoint.js";
import {
  parseSessionManifest,
  sessionBindingHash,
  sessionManifestSchema,
  type SessionCheckpoint,
  type SessionManifestWithoutPayload,
} from "../session/contracts.js";
import { collectWorkerSession, prepareWorkerSession } from "../session/worker.js";

export const MAX_SESSION_TRANSFER_BYTES = 6 * 1024 * 1024;
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const bindingSchema = z.strictObject({
  repository: sessionManifestSchema.shape.repository,
  workflow: sessionManifestSchema.shape.workflow.pick({ path: true, jobId: true, jobName: true }),
  task: sessionManifestSchema.shape.task,
  runtime: sessionManifestSchema.shape.runtime,
  keyHash: sha,
});
const sourceSchema = z.strictObject({
  runId: sessionManifestSchema.shape.workflow.shape.runId,
  runAttempt: sessionManifestSchema.shape.workflow.shape.runAttempt,
  sourceSha: sessionManifestSchema.shape.workflow.shape.sourceSha,
  actorId: sessionManifestSchema.shape.issuer.shape.actorId,
  actorLogin: sessionManifestSchema.shape.issuer.shape.actorLogin,
  jobRunId: sessionManifestSchema.shape.issuer.shape.jobRunId,
});
const checkpointSchema = z.strictObject({
  manifest: sessionManifestSchema.extend({
    session: sessionManifestSchema.shape.session.extend({
      sessionId: z
        .string()
        .regex(/^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
    }),
  }),
  payloadBase64: z
    .string()
    .min(4)
    .max(Math.ceil(SESSION_CHECKPOINT_LIMITS.payloadBytes / 3) * 4),
});
export const sessionTransferPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  bindingDigest: sha,
  binding: bindingSchema,
  current: sourceSchema,
  generation: z.number().int().min(1).max(1_000_000),
  retentionDays: z.number().int().min(1).max(7),
  workingDirectory: z.literal("/workspace"),
  permissionMode: z.enum(["read-only", "workspace-write"]),
  checkpoint: checkpointSchema.optional(),
});
export type SessionTransferPlan = z.infer<typeof sessionTransferPlanSchema>;
export const sessionTransferReplySchema = z.strictObject({
  schemaVersion: z.literal(1),
  planDigest: sha,
  checkpoint: checkpointSchema,
});
export type SessionTransferReply = z.infer<typeof sessionTransferReplySchema>;

function denied(message: string): never {
  throw new PolicyDeniedError("Remote DSH Session " + message);
}
function bounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SESSION_TRANSFER_BYTES)
    denied("exceeds its bounded transport envelope");
}
function permission(workspaceWrite: boolean) {
  return workspaceWrite ? "workspace-write" : "read-only";
}
function secrets(runtime: DshRuntime, additional: readonly string[]) {
  return [...new Set([...(runtime.session?.knownSecrets ?? []), ...additional])];
}
function metadata(runtime: DshRuntime) {
  const session = runtime.session;
  if (session?.transport === undefined)
    denied("requires original Controller-verified provenance metadata");
  if (session.bindingDigest !== sessionBindingHash(session.transport.binding))
    denied("Controller provenance digest changed");
  return { session, transport: session.transport };
}
function manifest(plan: SessionTransferPlan, sessionId: string): SessionManifestWithoutPayload {
  const created = new Date();
  return {
    schemaVersion: 1,
    repository: plan.binding.repository,
    workflow: {
      ...plan.binding.workflow,
      sourceSha: plan.current.sourceSha,
      runId: plan.current.runId,
      runAttempt: plan.current.runAttempt,
    },
    task: plan.binding.task,
    runtime: plan.binding.runtime,
    issuer: {
      actorId: plan.current.actorId,
      actorLogin: plan.current.actorLogin,
      jobRunId: plan.current.jobRunId,
    },
    session: { keyHash: plan.binding.keyHash, sessionId, generation: plan.generation },
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + plan.retentionDays * 86_400_000).toISOString(),
  };
}
function checkedPlan(raw: unknown, workspaceWrite: boolean): SessionTransferPlan {
  bounded(raw);
  const plan = sessionTransferPlanSchema.parse(raw);
  if (
    plan.bindingDigest !== sessionBindingHash(plan.binding) ||
    plan.permissionMode !== permission(workspaceWrite)
  )
    denied("does not match current provenance or workspace authority");
  return plan;
}
export function sessionTransferPlanDigest(raw: unknown): string {
  bounded(raw);
  return createHash("sha256")
    .update(JSON.stringify(sessionTransferPlanSchema.parse(raw)))
    .digest("hex");
}
function decode(value: z.infer<typeof checkpointSchema>): SessionCheckpoint {
  const payload = Buffer.from(value.payloadBase64, "base64");
  if (
    payload.length > SESSION_CHECKPOINT_LIMITS.payloadBytes ||
    payload.toString("base64") !== value.payloadBase64
  )
    denied("contains noncanonical or oversized checkpoint encoding");
  return { manifest: parseSessionManifest(value.manifest), payload };
}
function encode(value: SessionCheckpoint): z.infer<typeof checkpointSchema> {
  return { manifest: value.manifest, payloadBase64: Buffer.from(value.payload).toString("base64") };
}
function sameControllerState(left: SessionTransferPlan, right: SessionTransferPlan): boolean {
  const { checkpoint: a, ...leftPlan } = left;
  const { checkpoint: b, ...rightPlan } = right;
  return (
    JSON.stringify(leftPlan) === JSON.stringify(rightPlan) &&
    (a === undefined || b === undefined
      ? a === undefined && b === undefined
      : a.payloadBase64 === b.payloadBase64 &&
        JSON.stringify({ ...a.manifest, createdAt: undefined, expiresAt: undefined }) ===
          JSON.stringify({ ...b.manifest, createdAt: undefined, expiresAt: undefined }))
  );
}

/** Called after original session.restore; no credentials or workspace files are serialized. */
export async function exportControllerSession(
  runtime: DshRuntime,
  workspaceWrite: boolean,
  additionalSecrets: readonly string[] = [],
): Promise<SessionTransferPlan | undefined> {
  if (runtime.session === undefined) return undefined;
  const { session, transport } = metadata(runtime);
  const plan: SessionTransferPlan = checkedPlan(
    {
      schemaVersion: 1,
      bindingDigest: session.bindingDigest,
      ...transport,
      workingDirectory: "/workspace",
      permissionMode: permission(workspaceWrite),
    },
    workspaceWrite,
  );
  if (session.sessionId !== undefined) {
    const checkpoint = await exportSessionCheckpoint({
      persistenceRoot: join(runtime.dshHome, "sessions"),
      workspacePath: "/workspace",
      knownSecrets: secrets(runtime, additionalSecrets),
      manifest: manifest(plan, session.sessionId),
    });
    plan.checkpoint = encode(checkpoint);
  } else {
    if (session.checkpointEventCount !== undefined) denied("has event count without an identity");
    const root = join(runtime.dshHome, "sessions");
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(root)).length !== 0)
      denied("startup persistence is not an empty dedicated directory");
  }
  bounded(plan);
  return sessionTransferPlanSchema.parse(plan);
}

/** Fresh cloud home only; current authority is supplied separately by the admitted task. */
export async function prepareRuntimeSession(
  runtime: DshRuntime,
  rawPlan: unknown,
  workspaceWrite: boolean,
  localSecrets: readonly string[] = [],
): Promise<SessionTransferPlan> {
  if (runtime.session !== undefined) denied("refuses reuse of an initialized worker home");
  const plan = checkedPlan(rawPlan, workspaceWrite);
  runtime.session = {
    bindingDigest: plan.bindingDigest,
    knownSecrets: new Set(localSecrets),
    transport: {
      binding: plan.binding,
      current: plan.current,
      generation: plan.generation,
      retentionDays: plan.retentionDays,
    },
  };
  if (plan.checkpoint !== undefined) {
    const inspection = await importSessionCheckpoint({
      persistenceRoot: join(runtime.dshHome, "sessions"),
      checkpoint: decode(plan.checkpoint),
      binding: plan.binding,
      source: plan.current,
      workspacePath: "/workspace",
      knownSecrets: localSecrets,
    });
    runtime.session.sessionId = inspection.sessionId;
    runtime.session.checkpointEventCount = inspection.eventCount;
  }
  await prepareWorkerSession(runtime, workspaceWrite);
  return plan;
}

/** Only after actual DSH termination/durability; reuses original admission and physical inspection. */
export async function collectRuntimeSession(
  runtime: DshRuntime,
  rawPlan: unknown,
  workspaceWrite: boolean,
  additionalSecrets: readonly string[] = [],
): Promise<SessionTransferReply> {
  const plan = checkedPlan(rawPlan, workspaceWrite);
  const { session, transport } = metadata(runtime);
  if (
    session.bindingDigest !== plan.bindingDigest ||
    JSON.stringify(transport) !==
      JSON.stringify({
        binding: plan.binding,
        current: plan.current,
        generation: plan.generation,
        retentionDays: plan.retentionDays,
      })
  )
    denied("worker provenance changed during execution");
  await collectWorkerSession(runtime, workspaceWrite);
  if (session.sessionId === undefined) denied("completed worker supplied no Session identity");
  const checkpoint = await exportSessionCheckpoint({
    persistenceRoot: join(runtime.dshHome, "sessions"),
    manifest: manifest(plan, session.sessionId),
    workspacePath: "/workspace",
    knownSecrets: secrets(runtime, additionalSecrets),
  });
  const reply = {
    schemaVersion: 1 as const,
    planDigest: sessionTransferPlanDigest(plan),
    checkpoint: encode(checkpoint),
  };
  bounded(reply);
  return sessionTransferReplySchema.parse(reply);
}

export interface PreparedControllerSession {
  /** Commit only after all other Runtime result/workspace checks have passed. */
  commit(): Promise<void>;
  dispose(): Promise<void>;
}

/** Verify and stage first; rejected replies cannot replace the original Controller checkpoint. */
export async function stageControllerSessionReply(
  runtime: DshRuntime,
  rawPlan: unknown,
  rawReply: unknown,
  workspaceWrite: boolean,
  options: {
    readonly additionalSecrets?: readonly string[];
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
  } = {},
): Promise<PreparedControllerSession> {
  const active = () => {
    options.signal?.throwIfAborted();
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)
      denied("Controller deadline expired before Session installation");
  };
  active();
  const plan = checkedPlan(rawPlan, workspaceWrite);
  const current = await exportControllerSession(runtime, workspaceWrite, options.additionalSecrets);
  if (current === undefined || !sameControllerState(current, plan))
    denied("Controller state no longer matches the request plan");
  bounded(rawReply);
  const reply = sessionTransferReplySchema.parse(rawReply);
  if (reply.planDigest !== sessionTransferPlanDigest(plan))
    denied("reply belongs to another task plan");
  const checkpoint = decode(reply.checkpoint);
  if (checkpoint.manifest.session.generation !== plan.generation)
    denied("reply changed the Controller artifact generation");
  const localSecrets = secrets(runtime, options.additionalSecrets ?? []);
  const inspection = validateSessionPayload({
    payload: checkpoint.payload,
    sessionId: checkpoint.manifest.session.sessionId,
    workspacePath: "/workspace",
    knownSecrets: localSecrets,
  });
  if (plan.checkpoint !== undefined) {
    const prior = decode(plan.checkpoint);
    const before = validateSessionPayload({
      payload: prior.payload,
      sessionId: prior.manifest.session.sessionId,
      workspacePath: "/workspace",
      knownSecrets: localSecrets,
    });
    if (
      inspection.sessionId !== before.sessionId ||
      inspection.eventCount <= before.eventCount ||
      !Buffer.from(checkpoint.payload)
        .subarray(0, prior.payload.length)
        .equals(Buffer.from(prior.payload))
    )
      denied("reply rewrote or replayed historical events");
  }
  const stage = await mkdtemp(join(runtime.dshHome, ".remote-session-"));
  const candidate = join(stage, "candidate"),
    backup = join(stage, "backup");
  try {
    await mkdir(candidate, { mode: 0o700 });
    await importSessionCheckpoint({
      persistenceRoot: candidate,
      checkpoint,
      binding: plan.binding,
      source: plan.current,
      workspacePath: "/workspace",
      knownSecrets: localSecrets,
    });
    active();
  } catch (error: unknown) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  let committed = false,
    installing = false,
    retainedBackup = false,
    disposed = false;
  return {
    commit: async () => {
      if (disposed || committed || installing) denied("staged checkpoint is no longer available");
      installing = true;
      active();
      const latest = await exportControllerSession(
        runtime,
        workspaceWrite,
        options.additionalSecrets,
      );
      if (latest === undefined || !sameControllerState(latest, plan))
        denied("Controller Session changed before checkpoint installation");
      const destination = join(runtime.dshHome, "sessions");
      const info = await lstat(destination);
      if (!info.isDirectory() || info.isSymbolicLink())
        denied("Controller persistence root was redirected");
      active();
      await rename(destination, backup);
      retainedBackup = true;
      let installed = false;
      try {
        active();
        await rename(candidate, destination);
        installed = true;
        active();
      } catch (error: unknown) {
        try {
          if (installed) await rename(destination, candidate);
          await rename(backup, destination);
          retainedBackup = false;
        } catch (rollback: unknown) {
          throw new AggregateError(
            [error, rollback],
            "Session install rollback failed; original retained in private backup",
            { cause: rollback },
          );
        }
        throw error;
      }
      committed = true;
      retainedBackup = false;
      const { session } = metadata(runtime);
      session.sessionId = inspection.sessionId;
      session.checkpointEventCount = inspection.eventCount;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (!retainedBackup) await rm(stage, { recursive: true, force: true });
    },
  };
}
