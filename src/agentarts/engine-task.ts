import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AgentEngine, AgentTurnRequest } from "../agent/contracts.js";
import { DshConfigurationError } from "../dsh/errors.js";
import type { DshTrust } from "../dsh/runner.js";
import type { DshOutput } from "../dsh/schema.js";
import type { TaskOutputSchema } from "../dsh/task-output.js";
import { PolicyDeniedError } from "../errors.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import type { DshTurnMetadata } from "../review/run.js";
import { assertNoSecretOutput } from "../security/env.js";
import { invokeReadOnlyTask, type RuntimeClientConfig } from "./client.js";
import { digest, MAX_RUNTIME_MS, workspaceDigest, type WorkspaceFile } from "./protocol.js";
import {
  readOnlyBindingSchema,
  readOnlyControllerManifestSchema,
  readOnlyOperationSchema,
  readOnlyReceiptSchema,
  readOnlyTaskDigest,
  readOnlyTaskReplySchema,
  readOnlyTaskSchema,
  validateReadOnlyTaskOutput,
  type ReadOnlyBinding,
  type ReadOnlyTask,
  type ReadOnlyTaskReply,
} from "./readonly-task-protocol.js";

const contextPacketSchema = z.object({
  repository: z.string(),
  entity: z
    .object({
      kind: z.enum(["pull_request", "issue"]),
      number: z.number().int().positive(),
      headSha: z.string().optional(),
      baseSha: z.string().optional(),
      changedFiles: z
        .array(z.object({ path: z.string(), source: z.string().optional() }))
        .optional(),
    })
    .optional(),
  textFiles: z
    .array(
      z.object({
        path: z.string(),
        text: z.string(),
        repository: z.string().optional(),
        sourceSha: z.string().optional(),
      }),
    )
    .optional(),
});

/** Uses the original outer AgentLoop; Controller tool calls never execute inside the Runtime. */
export class AgentArtsReadOnlyTaskEngine implements AgentEngine<DshOutput, DshTurnMetadata> {
  public readonly id = "dsh-agentarts";
  public readonly version = "0.2.0-rc.2";
  private readonly binding: ReadOnlyBinding;

  public constructor(
    private readonly config: RuntimeClientConfig,
    private readonly trust: DshTrust,
    binding: ReadOnlyBinding,
    private readonly secrets: readonly string[],
    private readonly options: {
      readonly taskOutputSchema?: TaskOutputSchema;
      readonly invoke?: (task: ReadOnlyTask, signal?: AbortSignal) => Promise<ReadOnlyTaskReply>;
      readonly onTask?: (task: ReadOnlyTask) => void | Promise<void>;
      readonly onValidated?: (reply: ReadOnlyTaskReply) => void | Promise<void>;
      readonly onRequestId?: (id: string) => void;
    } = {},
  ) {
    this.binding = readOnlyBindingSchema.parse(binding);
  }

  public async runTurn(request: AgentTurnRequest) {
    throwIfCancelled(request.signal);
    if (
      !readOnlyOperationSchema.safeParse(request.operation).success ||
      request.requestedAccess !== "read" ||
      this.trust === "trusted-write"
    )
      throw new PolicyDeniedError(
        "AgentArts v2 currently admits read-only task and diagnose operations",
      );
    if (request.session !== undefined)
      throw new DshConfigurationError("Portable cloud DSH session resume is not implemented");
    const operation = readOnlyOperationSchema.parse(request.operation);
    const tools: ReadOnlyTask["tools"] = [];
    const toolCatalog: ReadOnlyTask["toolCatalog"] = [];
    for (const tool of request.tools) {
      if (tool.provider === "builtin") {
        if (
          !["workspace.read", "workspace.search"].includes(tool.id) ||
          tool.permissions.some((permission) => permission !== "read")
        )
          throw new PolicyDeniedError(
            "Read-only Runtime admits only native workspace read and search tools",
          );
        tools.push(z.enum(["workspace.read", "workspace.search"]).parse(tool.id));
      } else {
        const manifest = readOnlyControllerManifestSchema.safeParse(tool);
        if (!manifest.success)
          throw new PolicyDeniedError("Read-only Runtime cannot grant this Controller manifest");
        toolCatalog.push(manifest.data);
      }
    }
    const wrapped = z.object({ taskContext: contextPacketSchema }).parse(request.context);
    const packet = wrapped.taskContext;
    if (packet.repository !== this.binding.repository)
      throw new PolicyDeniedError("Task context does not match the Controller repository binding");
    const entity = this.binding.entity;
    if (entity.kind === "repository") {
      if (packet.entity !== undefined)
        throw new PolicyDeniedError("Repository task acquired an unbound issue or pull request");
    } else {
      if (packet.entity?.kind !== entity.kind || packet.entity.number !== entity.number)
        throw new PolicyDeniedError("Task context does not match the Controller entity binding");
      if (
        entity.kind === "pull_request" &&
        (packet.entity.headSha !== this.binding.headSha ||
          packet.entity.baseSha !== this.binding.baseSha)
      )
        throw new PolicyDeniedError(
          "Pull request context does not match the bound base/head commits",
        );
    }
    const files: WorkspaceFile[] = [];
    if (this.trust === "trusted-read") {
      const seen = new Map<string, WorkspaceFile>();
      for (const text of packet.textFiles ?? []) {
        if (
          (text.repository !== undefined && text.repository !== this.binding.repository) ||
          (text.sourceSha !== undefined && text.sourceSha !== this.binding.headSha)
        )
          throw new PolicyDeniedError(
            "Context source file does not match the bound repository revision",
          );
      }
      for (const source of [
        ...(packet.entity?.changedFiles ?? []).map((file) => ({
          path: file.path,
          content: file.source,
        })),
        ...(packet.textFiles ?? []).map((file) => ({ path: file.path, content: file.text })),
      ]) {
        if (source.content === undefined) continue;
        const file: WorkspaceFile = {
          path: source.path,
          content: source.content,
          sha256: digest(source.content),
        };
        const previous = seen.get(source.path.toLowerCase());
        if (previous !== undefined) {
          if (previous.path !== file.path || previous.sha256 !== file.sha256)
            throw new PolicyDeniedError("Ambiguous or conflicting context source files");
          continue;
        }
        seen.set(source.path.toLowerCase(), file);
        files.push(file);
      }
    }
    const task = readOnlyTaskSchema.parse({
      schemaVersion: 2,
      taskId: randomUUID(),
      operation,
      binding: this.binding,
      trust: this.trust,
      tools,
      toolCatalog,
      timeoutMs: Math.min(
        request.timeoutMs,
        request.deadlineMs - Date.now() - 15_000,
        MAX_RUNTIME_MS,
      ),
      instructions: request.instructions,
      context: JSON.parse(JSON.stringify(request.context)) as unknown,
      files,
      ...(operation !== "task" || this.options.taskOutputSchema === undefined
        ? {}
        : { taskOutputSchema: this.options.taskOutputSchema }),
    });
    assertNoSecretOutput("prompt", JSON.stringify(task), [...this.secrets, this.config.apiKey]);
    await this.options.onTask?.(task);
    const reply = await (this.options.invoke === undefined
      ? invokeReadOnlyTask(this.config, task, {
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(this.options.onRequestId === undefined
            ? {}
            : { onRequestId: this.options.onRequestId }),
        })
      : this.options.invoke(task, request.signal));
    throwIfCancelled(request.signal);
    const validated = readOnlyTaskReplySchema.parse(JSON.parse(JSON.stringify(reply)) as unknown);
    assertNoSecretOutput("stdout", JSON.stringify(validated), [
      ...this.secrets,
      this.config.apiKey,
    ]);
    if (
      validated.taskId !== task.taskId ||
      validated.operation !== task.operation ||
      JSON.stringify(validated.binding) !== JSON.stringify(task.binding) ||
      validated.taskDigest !== readOnlyTaskDigest(task) ||
      validated.workspaceDigest !== workspaceDigest(task.files)
    )
      throw new DshConfigurationError(
        "Runtime task, operation, source, grants or workspace binding mismatch",
      );
    const output = validateReadOnlyTaskOutput(validated.output, task);
    const toolReceipts = validated.toolReceipts.map((receipt) => {
      const { code, ...rest } = readOnlyReceiptSchema.parse(receipt);
      return { ...rest, ...(code === undefined ? {} : { code }) };
    });
    if (toolReceipts.some((receipt) => receipt.counted && !receipt.completed))
      throw new DshConfigurationError("Runtime returned unfinished native tool receipts");
    if (
      (this.trust === "untrusted" && toolReceipts.length > 0) ||
      toolReceipts.some((receipt) => !task.tools.includes(receipt.id))
    )
      throw new PolicyDeniedError("Runtime reported an ungranted native tool receipt");
    await this.options.onValidated?.(validated);
    return {
      output,
      durationMs: validated.durationMs,
      metadata: {
        toolReceipts,
        isolationReport: {
          backend: "agentarts" as const,
          credentialMediated: true as const,
          repoToolsEnabled: task.tools.length > 0,
          processIsolated: true,
          networkIsolated: false,
          workspaceAccess: "read-only" as const,
          extensionProfile: "github-action" as const,
          limitations: [
            "Runtime supervisor and DSH use separate Unix identities; cloud deployment verification is required.",
            "Only bounded admitted text is transferred. Native shell, writes, extensions and arbitrary network tools remain disabled.",
            "Controller requests return to the existing outer loop and remain subject to its capability, immutable entity and input checks.",
          ],
        },
      },
    };
  }
}
