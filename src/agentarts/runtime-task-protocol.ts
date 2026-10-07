import { z } from "zod";

import { DshConfigurationError } from "../dsh/errors.js";
import { dshOperationSchema, parseDshOutput, type DshOutput } from "../dsh/schema.js";
import { parseTaskOutputSchema, validateTaskOutput } from "../dsh/task-output.js";
import {
  configuredExtensionSecrets,
  resolveExtensionPlan,
  resolveNativeExtensionPlan,
  type ExtensionPlan,
} from "../extensions/plan.js";
import {
  parseMcpConfiguration,
  parsePluginConfiguration,
  parseNativeMcpConfiguration,
  parseNativePluginConfiguration,
} from "../extensions/schema.js";
import { evaluatePolicy } from "../security/policy.js";
import type { ExtensionRuntimeLockAudit } from "../extensions/runtime-lock.js";
import { validateRefName } from "../security/refs.js";
import { nativeToolSchema, parseAllowedTools, githubToolSchema } from "../tools/schema.js";
import { githubToolManifest, githubToolInputSchemas } from "../tools/github-catalog.js";
import { digest, runtimeReplySchema } from "./protocol.js";
import {
  validateWorkspaceTransferManifest,
  workspaceTransferManifestSchema,
  workspaceTransferDeltaSchema,
} from "./workspace-transfer.js";
import { sessionTransferPlanSchema, sessionTransferReplySchema } from "./session-transfer.js";

/** Project limits only; the AgentArts tenant's actual body limit still requires validation. */
export const MAX_RUNTIME_TASK_BYTES = 32 * 1024 * 1024;
export const MAX_RUNTIME_TASK_MS = 30 * 60_000;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const commit = z.string().regex(/^[a-f0-9]{40}$/u);
const entitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pull_request"), number: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("issue"), number: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("repository") }),
]);
export const runtimeBindingSchema = z.strictObject({
  taskId: z.uuid(),
  operation: dshOperationSchema,
  operationIdentity: z.string().min(1).max(2048),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  entity: entitySchema,
  ref: z
    .string()
    .max(1024)
    .refine((value) => {
      try {
        validateRefName(value);
        return true;
      } catch {
        return false;
      }
    }),
  baseSha: commit,
  headSha: commit,
  revision: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1),
  grantDigest: hash,
});
export type RuntimeBinding = z.infer<typeof runtimeBindingSchema>;

/** Canonical key order prevents differing validated schema property order from changing a binding. */
export function canonicalRuntimeJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalRuntimeJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalRuntimeJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

export const runtimeControllerManifestSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .max(256)
      .regex(
        /^(?:command\.[a-z][a-z0-9-]{0,31}|github\.[a-z][a-z0-9.-]{0,100}|mcp\.[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9_-]{0,63}|plugin\.[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9_-]{0,63})$/u,
      ),
    description: z.string().min(1).max(500),
    provider: z.enum(["command", "github", "mcp", "plugin"]),
    permissions: z
      .array(z.enum(["read", "write", "execute", "network", "github-read", "github-write"]))
      .max(6),
    inputSchema: z.record(z.string(), z.json()),
  })
  .superRefine((tool, context) => {
    if (
      !tool.id.startsWith(`${tool.provider}.`) ||
      new Set(tool.permissions).size !== tool.permissions.length
    )
      context.addIssue({
        code: "custom",
        message: "Controller manifest provider or permissions mismatch",
      });
    try {
      if (tool.provider === "github") {
        const id = githubToolSchema.parse(tool.id);
        if (canonicalRuntimeJson(tool) !== canonicalRuntimeJson(githubToolManifest(id)))
          throw new DshConfigurationError("GitHub catalog must use the original static manifest");
      } else parseTaskOutputSchema(JSON.stringify(tool.inputSchema));
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid Controller input schema or static GitHub manifest",
      });
    }
  });

function extensionPlan(raw: unknown): ExtensionPlan {
  const head = z
    .object({
      profileName: z.enum(["github-action", "headless-native"]),
      mcpServers: z.array(z.object({ definition: z.json() })),
      bundles: z.array(z.object({ definition: z.json() })),
      plugins: z.array(z.object({ definition: z.json() })),
    })
    .parse(raw);
  const native = head.profileName === "headless-native";
  const mcpJson = JSON.stringify({
    schemaVersion: 1,
    servers: head.mcpServers.map(({ definition }) => definition),
  });
  const pluginsJson = JSON.stringify({
    schemaVersion: 1,
    bundles: head.bundles.map(({ definition }) => definition),
    plugins: head.plugins.map(({ definition }) => definition),
  });
  const mcp = native ? parseNativeMcpConfiguration(mcpJson) : parseMcpConfiguration(mcpJson);
  const plugins = native
    ? parseNativePluginConfiguration(pluginsJson)
    : parsePluginConfiguration(pluginsJson);
  if (configuredExtensionSecrets(mcp, plugins, 1).length > 0)
    throw new DshConfigurationError(
      "Extension credentials must use a supervisor-owned reference or mediated bridge",
    );
  // Reuse the original admission/normalization rather than trust serialized effective grants.
  const policy = evaluatePolicy({
    context: {
      kind: "automation",
      rawEventName: "workflow_dispatch",
      eventName: "workflow_dispatch",
      runId: "protocol-normalization",
      actor: "controller",
      repository: { id: 1, owner: "bound", repo: "context", fullName: "bound/context" },
      payload: {},
      isPullRequestTarget: false,
    },
    operation: "task",
    requestedAccess: "write",
    allowWrite: true,
    permissions: { actors: [], allActorsHaveWrite: true, allActorsAllowedForWrite: true },
  });
  // For read-only owners the original resolver expects a read-only workspace.
  const write = native
    ? z.object({ workspaceWrite: z.boolean() }).parse(raw).workspaceWrite
    : head.mcpServers
        .concat(head.bundles, head.plugins)
        .some(
          ({ definition }) =>
            typeof definition === "object" &&
            definition !== null &&
            "tools" in definition &&
            Array.isArray(definition.tools) &&
            definition.tools.some(
              (tool: unknown) =>
                typeof tool === "object" &&
                tool !== null &&
                "permissions" in tool &&
                Array.isArray(tool.permissions) &&
                tool.permissions.includes("workspace-write"),
            ),
        );
  const effectivePolicy = {
    ...policy,
    trust: write ? ("trusted-write" as const) : ("trusted-read" as const),
    capabilities: { ...policy.capabilities, modifyWorkspace: write },
  };
  const normalized = native
    ? resolveNativeExtensionPlan({
        mcp: mcp as ReturnType<typeof parseNativeMcpConfiguration>,
        plugins: plugins as ReturnType<typeof parseNativePluginConfiguration>,
        allowPluginInstall: true,
        policy: effectivePolicy,
      })
    : resolveExtensionPlan({
        mcp: mcp as ReturnType<typeof parseMcpConfiguration>,
        plugins: plugins as ReturnType<typeof parsePluginConfiguration>,
        allowedTools: parseAllowedTools(
          JSON.stringify(
            z
              .object({ tools: z.array(z.object({ id: z.string() })) })
              .parse(raw)
              .tools.map(({ id }) => id),
          ),
        ),
        allowPluginInstall: true,
        policy: effectivePolicy,
      });
  const rawRecord = z.record(z.string(), z.json()).parse(raw);
  const audit = z.record(z.string(), z.json()).parse(rawRecord.audit);
  const lock = audit.runtimeLock;
  const parsedLock: ExtensionRuntimeLockAudit | undefined =
    lock === undefined
      ? undefined
      : z
          .strictObject({
            schemaVersion: z.literal(1),
            algorithm: z.literal("sha256"),
            digest: hash,
            lockfileVersion: z.literal(3),
            packageCount: z.number().int().nonnegative(),
            extensionPackageCount: z.number().int().nonnegative(),
          })
          .parse(lock);
  const withoutLock = { ...rawRecord, audit: { ...audit } };
  delete withoutLock.audit.runtimeLock;
  if (canonicalRuntimeJson(withoutLock) !== canonicalRuntimeJson(normalized))
    throw new DshConfigurationError(
      "Extension plan differs from the original normalized admission plan",
    );
  if (parsedLock === undefined) return normalized;
  if (normalized.profileName === "headless-native")
    return { ...normalized, audit: { ...normalized.audit, runtimeLock: parsedLock } };
  return { ...normalized, audit: { ...normalized.audit, runtimeLock: parsedLock } };
}
export const runtimeExtensionPlanSchema = z.json().transform((raw, context) => {
  try {
    return extensionPlan(raw);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid or credential-bearing extension plan" });
    return z.NEVER;
  }
});

const outputSchema = z.record(z.string(), z.json()).superRefine((value, context) => {
  try {
    parseTaskOutputSchema(JSON.stringify(value));
  } catch {
    context.addIssue({ code: "custom", message: "Invalid trusted task output schema" });
  }
});
export function runtimeGrantsDigest(task: {
  readonly mode: string;
  readonly trust: string;
  readonly requestedAccess: string;
  readonly tools: readonly string[];
  readonly toolCatalog: readonly unknown[];
  readonly extensions?: ExtensionPlan | undefined;
}): string {
  return digest(
    canonicalRuntimeJson({
      mode: task.mode,
      trust: task.trust,
      requestedAccess: task.requestedAccess,
      tools: task.tools,
      toolCatalog: task.toolCatalog,
      ...(task.extensions === undefined ? {} : { extensions: task.extensions }),
    }),
  );
}
export const runtimeTaskSchema = z
  .strictObject({
    schemaVersion: z.literal(3),
    taskId: z.uuid(),
    operation: dshOperationSchema,
    binding: runtimeBindingSchema,
    trust: z.enum(["untrusted", "trusted-read", "trusted-write"]),
    requestedAccess: z.enum(["read", "write"]),
    mode: z.enum(["controlled", "native"]),
    tools: z.array(nativeToolSchema).max(6),
    toolCatalog: z.array(runtimeControllerManifestSchema).max(128),
    timeoutMs: z.number().int().min(1).max(MAX_RUNTIME_TASK_MS),
    instructions: z.string().max(64 * 1024),
    context: z.json(),
    workspace: workspaceTransferManifestSchema,
    taskOutputSchema: outputSchema.optional(),
    extensions: runtimeExtensionPlanSchema.optional(),
    session: sessionTransferPlanSchema.optional(),
  })
  .superRefine((task, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (
      task.binding.taskId !== task.taskId ||
      task.binding.operation !== task.operation ||
      task.binding.grantDigest !== runtimeGrantsDigest(task)
    )
      issue("Task identity, operation or grants binding mismatch");
    const expected = { ...task.binding }; // Workspace transfer carries the same immutable binding.
    if (canonicalRuntimeJson(task.workspace.binding) !== canonicalRuntimeJson(expected))
      issue("Workspace is not bound to this full Runtime task");
    try {
      validateWorkspaceTransferManifest(task.workspace);
    } catch {
      issue("Workspace manifest failed independent content validation");
    }
    if (
      new Set(task.tools).size !== task.tools.length ||
      new Set(task.toolCatalog.map(({ id }) => id)).size !== task.toolCatalog.length
    )
      issue("Duplicate effective grants");
    if (task.requestedAccess === "write" && task.trust !== "trusted-write")
      issue("Workspace write requires trusted-write admission");
    if (
      task.requestedAccess === "read" &&
      (task.trust === "trusted-write" || task.tools.includes("workspace.edit"))
    )
      issue("Read-only task cannot acquire write authority");
    if (
      (task.operation === "fix" || task.operation === "implement") &&
      task.requestedAccess !== "write"
    )
      issue("Fix and implement require explicit write intent");
    if (
      (task.operation === "review" || task.operation === "diagnose") &&
      task.requestedAccess !== "read"
    )
      issue("Review and diagnose are read-only operations");
    if (
      task.trust === "untrusted" &&
      (task.mode !== "controlled" ||
        task.tools.length > 0 ||
        task.toolCatalog.length > 0 ||
        task.workspace.files.length > 0 ||
        task.extensions !== undefined ||
        task.session !== undefined)
    )
      issue("Untrusted tasks receive context only");
    if (task.taskOutputSchema !== undefined && task.operation !== "task")
      issue("Trusted task-output-schema is only for task");
    if (
      task.requestedAccess === "read" &&
      task.toolCatalog.some(
        ({ permissions }) => permissions.includes("write") || permissions.includes("github-write"),
      )
    )
      issue("Read-only task acquired a Controller write grant");
    if (
      task.trust !== "trusted-write" &&
      task.tools.some((id) => id === "native.bash" || id === "native.subagent")
    )
      issue("Repository execution requires trusted-write admission");
    if (task.session !== undefined) {
      const session = task.session;
      const workspaceWrite =
        task.requestedAccess === "write" &&
        (task.mode === "native" ||
          task.tools.includes("workspace.edit") ||
          (task.extensions?.profileName === "github-action" &&
            task.extensions.tools.some(({ permissions }) =>
              permissions.includes("workspace-write"),
            )));
      if (
        `${session.binding.repository.owner}/${session.binding.repository.repo}` !==
          task.binding.repository ||
        session.binding.runtime.mode !== task.mode ||
        session.permissionMode !== (workspaceWrite ? "workspace-write" : "read-only")
      )
        issue("Session repository, composition or current permission binding mismatch");
      if (
        task.binding.entity.kind === "repository"
          ? session.binding.task.kind !== "automation" ||
            !session.binding.task.identity.startsWith(`${task.operation}:`)
          : session.binding.task.kind !== task.binding.entity.kind ||
            session.binding.task.identity !==
              `${task.operation}:${String(task.binding.entity.number)}`
      )
        issue("Session acquired an unbound task entity");
    }
    if (
      task.extensions !== undefined &&
      task.extensions.profileName !== (task.mode === "native" ? "headless-native" : "github-action")
    )
      issue("Extension profile differs from selected composition");
    if (
      task.requestedAccess === "read" &&
      task.extensions !== undefined &&
      (task.extensions.profileName === "headless-native"
        ? task.extensions.workspaceWrite
        : task.extensions.tools.some(({ permissions }) => permissions.includes("workspace-write")))
    )
      issue("Read-only task acquired a writable extension");
    if (Buffer.byteLength(JSON.stringify(task)) > MAX_RUNTIME_TASK_BYTES)
      issue("Runtime task exceeds transport limit");
  });
export type RuntimeTask = z.infer<typeof runtimeTaskSchema>;
export function runtimeTaskDigest(task: RuntimeTask): string {
  return digest(canonicalRuntimeJson(runtimeTaskSchema.parse(task)));
}

export const runtimeTaskReplySchema = z
  .strictObject({
    schemaVersion: z.literal(3),
    taskId: z.uuid(),
    operation: dshOperationSchema,
    binding: runtimeBindingSchema,
    taskDigest: hash,
    workspaceDigest: hash,
    output: z.json(),
    durationMs: z.number().int().nonnegative(),
    toolReceipts: z.array(z.json()).max(4096),
    observedTools: z.array(z.string().max(128)).max(512).optional(),
    delta: workspaceTransferDeltaSchema.nullable(),
    session: sessionTransferReplySchema.optional(),
    extensionAudit: z.json().optional(),
    modelExecution: runtimeReplySchema.shape.modelExecution,
    sandboxEvidence: z.strictObject({
      backend: z.enum(["agentarts-bwrap", "insecure-test"]),
      credentialMediated: z.literal(true),
      processIsolated: z.boolean(),
      networkIsolated: z.boolean(),
      workspaceAccess: z.enum(["read-only", "read-write"]),
    }),
  })
  .superRefine((reply, context) => {
    if (reply.binding.taskId !== reply.taskId || reply.binding.operation !== reply.operation)
      context.addIssue({ code: "custom", message: "Runtime reply identity mismatch" });
    if (
      reply.delta !== null &&
      (canonicalRuntimeJson(reply.delta.binding) !== canonicalRuntimeJson(reply.binding) ||
        reply.delta.inputDigest !== reply.workspaceDigest)
    )
      context.addIssue({ code: "custom", message: "Delta is not bound to the input task" });
    if (Buffer.byteLength(JSON.stringify(reply)) > MAX_RUNTIME_TASK_BYTES)
      context.addIssue({ code: "custom", message: "Runtime reply exceeds transport limit" });
  });
export type RuntimeTaskReply = z.infer<typeof runtimeTaskReplySchema>;

/** Business output describes work; only captured bytes plus Controller verification can authorize publication. */
export function validateRuntimeTaskOutput(raw: unknown, task: RuntimeTask): DshOutput {
  const output = parseDshOutput(JSON.stringify(raw), task.operation, task.taskOutputSchema);
  if (
    task.requestedAccess === "read" &&
    ((output.changePlan?.length ?? 0) > 0 ||
      output.verification?.some(({ status }) => status !== "skipped") === true)
  )
    throw new DshConfigurationError(
      "Read-only Runtime cannot claim modifications or executed tests",
    );
  if (output.toolRequest !== undefined) {
    const manifest = task.toolCatalog.find(({ id }) => id === output.toolRequest?.id);
    if (manifest === undefined || task.trust === "untrusted")
      throw new DshConfigurationError("Runtime requested an ungranted Controller tool");
    if (manifest.provider === "github")
      githubToolInputSchemas[githubToolSchema.parse(manifest.id)].parse(
        output.toolRequest.input ?? {},
      );
    else {
      const schema = parseTaskOutputSchema(JSON.stringify(manifest.inputSchema));
      if (schema === undefined)
        throw new DshConfigurationError("Controller tool lacks an input schema");
      validateTaskOutput(output.toolRequest.input ?? {}, schema);
    }
  }
  return output;
}
