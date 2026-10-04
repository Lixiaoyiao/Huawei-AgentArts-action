import { z } from "zod";

import { DshConfigurationError } from "../dsh/errors.js";
import { parseDshOutput, type DshOutput } from "../dsh/schema.js";
import { parseTaskOutputSchema, validateTaskOutput } from "../dsh/task-output.js";
import {
  bindingSchema,
  digest,
  MAX_RUNTIME_MS,
  MAX_TASK_BYTES,
  MAX_WORKSPACE_BYTES,
  runtimeReplySchema,
  workspaceFileSchema,
} from "./protocol.js";

export const readOnlyOperationSchema = z.enum(["task", "diagnose"]);
export const readOnlyBindingSchema = z.strictObject({
  repository: bindingSchema.shape.repository,
  baseSha: bindingSchema.shape.baseSha,
  headSha: bindingSchema.shape.headSha,
  entity: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("pull_request"), number: z.number().int().positive() }),
    z.strictObject({ kind: z.literal("issue"), number: z.number().int().positive() }),
    z.strictObject({ kind: z.literal("repository") }),
  ]),
});
export type ReadOnlyBinding = z.infer<typeof readOnlyBindingSchema>;

const emptyInputSchema = z.strictObject({
  type: z.literal("object"),
  additionalProperties: z.literal(false),
  properties: z.record(z.string(), z.never()).optional(),
});
const commandManifestSchema = z
  .strictObject({
    id: z.string().regex(/^command\.[a-z][a-z0-9-]{0,31}$/u),
    provider: z.literal("command"),
    description: z.string().min(1).max(500),
    permissions: z
      .array(z.enum(["execute", "network"]))
      .min(1)
      .max(2),
    inputSchema: emptyInputSchema,
  })
  .refine(
    (tool) => tool.permissions.includes("execute"),
    "Controller command requires execute permission",
  );
const checksManifestSchema = z.strictObject({
  id: z.literal("github.checks.read"),
  provider: z.literal("github"),
  description: z.string().min(1).max(500),
  permissions: z.tuple([z.literal("github-read")]),
  inputSchema: emptyInputSchema,
});

/** Catalog descriptions are not implementation code; all callbacks remain in the original Controller. */
export const readOnlyControllerManifestSchema = z.union([
  commandManifestSchema,
  checksManifestSchema,
]);
export type ReadOnlyControllerManifest = z.infer<typeof readOnlyControllerManifestSchema>;

const safeTaskOutputSchema = z.record(z.string(), z.json()).superRefine((schema, context) => {
  try {
    parseTaskOutputSchema(JSON.stringify(schema));
  } catch {
    context.addIssue({ code: "custom", message: "Invalid trusted task output schema" });
  }
});

export const readOnlyTaskSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    taskId: z.uuid(),
    operation: readOnlyOperationSchema,
    binding: readOnlyBindingSchema,
    trust: z.enum(["untrusted", "trusted-read"]),
    tools: z.array(z.enum(["workspace.read", "workspace.search"])).max(2),
    toolCatalog: z.array(readOnlyControllerManifestSchema).max(32),
    timeoutMs: z.number().int().min(1).max(MAX_RUNTIME_MS),
    instructions: z.string().max(16 * 1024),
    context: z.json(),
    files: z.array(workspaceFileSchema).max(500),
    taskOutputSchema: safeTaskOutputSchema.optional(),
  })
  .superRefine((task, context) => {
    const paths = new Set<string>();
    let bytes = 0;
    for (const file of task.files) {
      const path = file.path.toLowerCase();
      if (paths.has(path))
        context.addIssue({ code: "custom", message: "Duplicate workspace path" });
      paths.add(path);
      bytes += Buffer.byteLength(file.content);
      if (digest(file.content) !== file.sha256)
        context.addIssue({ code: "custom", message: "Workspace file digest mismatch" });
    }
    if (bytes > MAX_WORKSPACE_BYTES)
      context.addIssue({ code: "custom", message: "Workspace exceeds byte limit" });
    if (
      task.trust === "untrusted" &&
      (task.files.length > 0 || task.tools.length > 0 || task.toolCatalog.length > 0)
    )
      context.addIssue({ code: "custom", message: "Untrusted task receives context only" });
    if (
      new Set(task.tools).size !== task.tools.length ||
      new Set(task.toolCatalog.map((tool) => tool.id)).size !== task.toolCatalog.length
    )
      context.addIssue({ code: "custom", message: "Duplicate tool grant" });
    if (task.operation !== "task" && task.taskOutputSchema !== undefined)
      context.addIssue({ code: "custom", message: "Only generic task may use taskOutputSchema" });
    if (Buffer.byteLength(JSON.stringify(task)) > MAX_TASK_BYTES)
      context.addIssue({ code: "custom", message: "Task exceeds transport limit" });
  });
export type ReadOnlyTask = z.infer<typeof readOnlyTaskSchema>;

export const readOnlyTaskReplySchema = z.strictObject({
  schemaVersion: z.literal(2),
  taskId: z.uuid(),
  operation: readOnlyOperationSchema,
  binding: readOnlyBindingSchema,
  taskDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  workspaceDigest: runtimeReplySchema.shape.workspaceDigest,
  dshVersion: runtimeReplySchema.shape.dshVersion,
  output: runtimeReplySchema.shape.output,
  durationMs: runtimeReplySchema.shape.durationMs,
  toolReceipts: runtimeReplySchema.shape.toolReceipts,
  modelExecution: runtimeReplySchema.shape.modelExecution,
});
export type ReadOnlyTaskReply = z.infer<typeof readOnlyTaskReplySchema>;

export const readOnlyReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  callId: z.string().min(1).max(256),
  id: z.enum(["workspace.read", "workspace.search"]),
  runtimeName: z.enum(["read", "read_image", "glob", "grep"]),
  provider: z.literal("builtin"),
  counted: z.boolean(),
  ok: z.boolean(),
  completed: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  code: z.string().max(128).optional(),
});

/** Hash the normalized strict request, including instructions, grants and the trusted output schema. */
export function readOnlyTaskDigest(task: ReadOnlyTask): string {
  return digest(JSON.stringify(readOnlyTaskSchema.parse(task)));
}

/** Independent terminal/request check on both sides of the Runtime boundary. */
export function validateReadOnlyTaskOutput(raw: unknown, task: ReadOnlyTask): DshOutput {
  const output = parseDshOutput(JSON.stringify(raw), task.operation, task.taskOutputSchema);
  if (
    (output.changePlan?.length ?? 0) > 0 ||
    output.verification?.some((item) => item.status !== "skipped") === true
  )
    throw new DshConfigurationError(
      "Read-only Runtime cannot claim workspace modifications or executed tests",
    );
  if (output.toolRequest !== undefined) {
    const request = output.toolRequest;
    const manifest = task.toolCatalog.find((tool) => tool.id === request.id);
    if (manifest === undefined || task.trust === "untrusted")
      throw new DshConfigurationError("Runtime requested an ungranted Controller tool");
    const schema = parseTaskOutputSchema(JSON.stringify(manifest.inputSchema));
    if (schema === undefined)
      throw new DshConfigurationError("Missing Controller tool input schema");
    // Original command/checks requests never accept model-defined argv, target, ref or credentials.
    validateTaskOutput(request.input ?? {}, schema);
  }
  return output;
}
