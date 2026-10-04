import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentEngine, AgentTurnRequest } from "../agent/contracts.js";
import type { DshTurnMetadata } from "../review/run.js";
import type { DshTrust } from "../dsh/runner.js";
import { parseDshOutput, type DshOutput } from "../dsh/schema.js";
import { DshConfigurationError } from "../dsh/errors.js";
import { PolicyDeniedError } from "../errors.js";
import { assertNoSecretOutput } from "../security/env.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { invokeReview, type RuntimeClientConfig } from "./client.js";
import type { AuthorizedRun } from "../orchestration/prepare.js";
import {
  digest,
  reviewTaskSchema,
  workspaceDigest,
  MAX_RUNTIME_MS,
  type ReviewTask,
  type ReviewBinding,
  type WorkspaceFile,
  type RuntimeReply,
} from "./protocol.js";

const receiptSchema = z.strictObject({
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

export function assertAgentArtsAuthorizedRun(run: AuthorizedRun): void {
  if (
    run.command.operation !== "review" ||
    run.command.requestedAccess !== "read" ||
    run.snapshot?.kind !== "pull_request" ||
    run.policy.trust === "trusted-write"
  )
    throw new PolicyDeniedError("Huawei-AgentArts-action v1 accepts PR Review only");
}

/** Versioned remote AgentEngine; GitHub authority and finalization stay upstream. */
export class AgentArtsReviewEngine implements AgentEngine<DshOutput, DshTurnMetadata> {
  public readonly id = "dsh-agentarts";
  public readonly version = "0.2.0-rc.2";
  public constructor(
    private readonly config: RuntimeClientConfig,
    private readonly trust: DshTrust,
    private readonly binding: ReviewBinding,
    private readonly secrets: readonly string[],
    private readonly options: {
      readonly invoke?: (task: ReviewTask, signal?: AbortSignal) => Promise<RuntimeReply>;
      readonly onTask?: (task: ReviewTask) => void | Promise<void>;
      readonly onValidated?: (reply: RuntimeReply) => void | Promise<void>;
      readonly onRequestId?: (id: string) => void;
    } = {},
  ) {}

  public async runTurn(request: AgentTurnRequest) {
    throwIfCancelled(request.signal);
    if (
      request.operation !== "review" ||
      request.requestedAccess !== "read" ||
      this.trust === "trusted-write" ||
      request.tools.some(
        (tool) =>
          !["workspace.read", "workspace.search"].includes(tool.id) ||
          tool.provider !== "builtin" ||
          tool.permissions.some((permission) => permission !== "read"),
      )
    )
      throw new PolicyDeniedError("AgentArts v1 supports only PR Review with read/search tools");
    const wrapped = z.object({ taskContext: z.unknown() }).parse(request.context);
    const packet = z
      .object({
        repository: z.string(),
        entity: z.object({
          kind: z.literal("pull_request"),
          number: z.number(),
          headSha: z.string(),
          baseSha: z.string(),
          changedFiles: z
            .array(z.object({ path: z.string(), source: z.string().optional() }))
            .default([]),
        }),
        textFiles: z.array(z.object({ path: z.string(), text: z.string() })).optional(),
      })
      .parse(wrapped.taskContext);
    if (
      packet.repository !== this.binding.repository ||
      packet.entity.number !== this.binding.pullNumber ||
      packet.entity.headSha !== this.binding.headSha ||
      packet.entity.baseSha !== this.binding.baseSha
    )
      throw new PolicyDeniedError("Review context does not match Controller binding");
    const files: WorkspaceFile[] = [];
    if (this.trust === "trusted-read") {
      const seen = new Set<string>();
      for (const file of [
        ...packet.entity.changedFiles.map((f) => ({ path: f.path, content: f.source })),
        ...(packet.textFiles ?? []).map((f) => ({ path: f.path, content: f.text })),
      ]) {
        if (file.content === undefined || seen.has(file.path)) continue;
        seen.add(file.path);
        files.push({ path: file.path, content: file.content, sha256: digest(file.content) });
      }
    }
    const task = reviewTaskSchema.parse({
      schemaVersion: 1,
      taskId: randomUUID(),
      binding: this.binding,
      trust: this.trust,
      tools: request.tools.map((tool) => tool.id),
      timeoutMs: Math.min(
        request.timeoutMs,
        request.deadlineMs - Date.now() - 15_000,
        MAX_RUNTIME_MS,
      ),
      instructions: request.instructions,
      context: JSON.parse(JSON.stringify(request.context)) as unknown,
      files,
    });
    assertNoSecretOutput("prompt", JSON.stringify(task), [...this.secrets, this.config.apiKey]);
    await this.options.onTask?.(task);
    const reply = await (this.options.invoke === undefined
      ? invokeReview(this.config, task, {
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(this.options.onRequestId === undefined
            ? {}
            : { onRequestId: this.options.onRequestId }),
        })
      : this.options.invoke(task, request.signal));
    throwIfCancelled(request.signal);
    const checked = JSON.parse(JSON.stringify(reply)) as unknown;
    const { runtimeReplySchema } = await import("./protocol.js");
    const validated = runtimeReplySchema.parse(checked);
    assertNoSecretOutput("stdout", JSON.stringify(validated), [
      ...this.secrets,
      this.config.apiKey,
    ]);
    if (
      validated.taskId !== task.taskId ||
      JSON.stringify(validated.binding) !== JSON.stringify(task.binding) ||
      validated.workspaceDigest !== workspaceDigest(task.files)
    )
      throw new DshConfigurationError(
        "Cloud task, repository, commit or workspace binding mismatch",
      );
    const output = parseDshOutput(JSON.stringify(validated.output), "review");
    if (
      output.state !== "final" ||
      (output.changePlan?.length ?? 0) > 0 ||
      (output.verification?.length ?? 0) > 0
    )
      throw new PolicyDeniedError(
        "Review Runtime cannot request tools, modifications or claim executed tests",
      );
    const toolReceipts = validated.toolReceipts.map((receipt) => {
      const { code, ...rest } = receiptSchema.parse(receipt);
      return { ...rest, ...(code === undefined ? {} : { code }) };
    });
    if (toolReceipts.some((receipt) => receipt.counted && !receipt.completed))
      throw new DshConfigurationError("Runtime returned unfinished tool receipts");
    if (this.trust === "untrusted" && toolReceipts.length > 0)
      throw new PolicyDeniedError("Untrusted review may not invoke workspace tools");
    if (toolReceipts.some((receipt) => !task.tools.includes(receipt.id)))
      throw new PolicyDeniedError("Runtime receipt reports an ungranted tool");
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
            "Only bounded changed-file text and explicit context files are transferred. Repository code is never executed.",
            "Runtime egress is configured by the operator; no repository shell, write or arbitrary network tool is admitted.",
          ],
        },
      },
    };
  }
}
