import { createHash } from "node:crypto";
import { z } from "zod";

export const AGENTARTS_PROTOCOL_VERSION = 1;
export const MAX_TASK_BYTES = 2 * 1024 * 1024;
export const MAX_WORKSPACE_BYTES = 1024 * 1024;
export const MAX_RUNTIME_MS = 10 * 60_000;

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
export const bindingSchema = z.strictObject({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  pullNumber: z.number().int().positive(),
  baseSha: sha,
  headSha: sha,
});
export type ReviewBinding = z.infer<typeof bindingSchema>;

export function safeWorkspacePath(path: string): boolean {
  const segments = path.split("/");
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !/[\\:]/u.test(path) &&
    !Array.from(path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    segments.every(
      (part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
    ) &&
    !segments[0]?.startsWith("~")
  );
}

export const workspaceFileSchema = z.strictObject({
  path: z.string().refine(safeWorkspacePath, "Unsafe workspace path"),
  content: z.string().max(256 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const reviewTaskSchema = z
  .strictObject({
    schemaVersion: z.literal(AGENTARTS_PROTOCOL_VERSION),
    taskId: z.uuid(),
    binding: bindingSchema,
    trust: z.enum(["untrusted", "trusted-read"]),
    tools: z.array(z.enum(["workspace.read", "workspace.search"])).max(2),
    timeoutMs: z.number().int().min(1).max(MAX_RUNTIME_MS),
    instructions: z.string().max(16 * 1024),
    context: z.json(),
    files: z.array(workspaceFileSchema).max(500),
  })
  .superRefine((task, ctx) => {
    const paths = new Set<string>();
    let bytes = 0;
    for (const file of task.files) {
      const key = file.path.toLowerCase();
      if (paths.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate workspace path" });
      paths.add(key);
      bytes += Buffer.byteLength(file.content);
      if (digest(file.content) !== file.sha256)
        ctx.addIssue({ code: "custom", message: "Workspace file digest mismatch" });
    }
    if (bytes > MAX_WORKSPACE_BYTES)
      ctx.addIssue({ code: "custom", message: "Workspace exceeds byte limit" });
    if (task.trust === "untrusted" && (task.files.length !== 0 || task.tools.length !== 0))
      ctx.addIssue({ code: "custom", message: "Untrusted review receives context only" });
  });
export type ReviewTask = z.infer<typeof reviewTaskSchema>;
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const runtimeReplySchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: z.uuid(),
  binding: bindingSchema,
  dshVersion: z.literal("0.2.0-rc.2"),
  output: z.json(),
  durationMs: z.number().int().nonnegative(),
  workspaceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  toolReceipts: z.array(z.json()).max(1000),
});
export type RuntimeReply = z.infer<typeof runtimeReplySchema>;

export function workspaceDigest(files: readonly WorkspaceFile[]): string {
  return digest(
    JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
  );
}
