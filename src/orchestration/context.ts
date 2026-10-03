import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { formatCiEvidence } from "../ci/diagnose.js";
import type { RoutedCommand } from "../commands/router.js";
import { fetchCiEvidence } from "../github/checks.js";
import { isWorkflowRunContext, type GitHubContext } from "../github/context.js";
import type { GitHubClient } from "../github/client.js";
import {
  fetchPullRequestSnapshot,
  type CommentActorFilter,
  type EntitySnapshot,
  type PullRequestSnapshot,
} from "../github/fetch.js";
import type { ActionInputs } from "../inputs.js";
import { ActionConfigurationError, OperationContextError, PolicyDeniedError } from "../errors.js";
import { sanitizeUntrustedText } from "../security/redaction.js";
import { validateRefName } from "../security/refs.js";
import { utf8Prefix } from "../security/utf8.js";

export function runUrl(context: GitHubContext): string {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  return `${server}/${context.repository.fullName}/actions/runs/${context.runId}`;
}

export function deferProgressUntilWriteValidation(
  command: Pick<RoutedCommand, "requestedAccess">,
): boolean {
  return command.requestedAccess === "write";
}

export function taskIdentity(
  command: RoutedCommand,
  inputs: ActionInputs,
  extensionAuditDigest: string,
  permissionDigest: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: command.operation,
        access: command.requestedAccess,
        instructions: command.instructions,
        permissionProfile: inputs.permissionProfile,
        allowedTools: inputs.allowedTools,
        disallowedTools: inputs.disallowedTools,
        validationIntegrity: inputs.validationIntegrity,
        ...(command.operation === "task" && inputs.taskOutputSchema !== undefined
          ? { taskOutputSchema: inputs.taskOutputSchema }
          : {}),
        ...(inputs.baseBranch === "" ? {} : { baseBranch: inputs.baseBranch }),
        ...(inputs.branchPrefix === "dsh/" ? {} : { branchPrefix: inputs.branchPrefix }),
        ...(inputs.branchNameTemplate === ""
          ? {}
          : { branchNameTemplate: inputs.branchNameTemplate }),
        toolConfig: inputs.toolConfig,
        // This identity can influence public branch names and PR markers. Bind
        // it to the redacted audit surface, never the secret-bearing effective
        // MCP/Plugin configuration used by the private runtime lock.
        extensionAuditDigest,
        permissionDigest,
        allowPluginInstall: inputs.allowPluginInstall,
      }),
      "utf8",
    )
    .digest("hex");
}

export function issueTaskIdentity(
  baseIdentity: string,
  snapshot: Extract<EntitySnapshot, { kind: "issue" }>,
): string {
  return createHash("sha256")
    .update([baseIdentity, snapshot.state, snapshot.contentFingerprint].join("\0"), "utf8")
    .digest("hex");
}

/** Resolve maintainer configuration against the trusted repository metadata. */
export function resolveBaseBranch(
  context: GitHubContext,
  configuredBaseBranch: string,
): string | undefined {
  const branch =
    configuredBaseBranch === "" ? context.repository.defaultBranch : configuredBaseBranch;
  return branch === undefined ? undefined : validateRefName(branch);
}

export function boundedText(value: string, maximumBytes: number): string {
  const cap = Math.max(0, Math.floor(maximumBytes));
  if (Buffer.byteLength(value, "utf8") <= cap) return value;
  const marker = "\n[truncated by dsh-action]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  return markerBytes >= cap
    ? utf8Prefix(marker, cap)
    : utf8Prefix(value, cap - markerBytes) + marker;
}

/** Enforce the operation/entity state machine before invoking DSH. */
export function assertOperationContext(
  command: RoutedCommand,
  context: GitHubContext,
  snapshot: EntitySnapshot | undefined,
  baseBranch: string | undefined = context.repository.defaultBranch,
): void {
  const assertTrustedWriteTarget = (): void => {
    if (baseBranch === undefined) {
      throw new PolicyDeniedError(
        "Cannot authorize a trusted write without the base branch identity",
      );
    }
    const protectedBranches = new Set(
      [context.repository.defaultBranch, baseBranch].filter(
        (branch): branch is string => branch !== undefined,
      ),
    );
    if (snapshot?.kind === "pull_request" && protectedBranches.has(snapshot.headRef)) {
      throw new PolicyDeniedError(
        "Refusing to update the repository default branch or configured base branch from a pull-request write",
      );
    }
  };
  if (command.operation === "task") {
    if (command.requestedAccess === "write") assertTrustedWriteTarget();
    return;
  }
  if (command.operation === "implement") {
    if (snapshot?.kind !== "issue") {
      throw new OperationContextError("@dsh implement is supported only on issues");
    }
    if (command.requestedAccess === "write") assertTrustedWriteTarget();
    return;
  }
  if (command.operation === "review" || command.operation === "fix") {
    if (snapshot?.kind !== "pull_request") {
      throw new OperationContextError(
        `@dsh ${command.operation} is supported only on pull requests`,
      );
    }
    if (command.operation === "fix" && command.requestedAccess === "write") {
      assertTrustedWriteTarget();
    }
    return;
  }
  if (snapshot?.kind !== "pull_request" && !isWorkflowRunContext(context)) {
    throw new OperationContextError(
      "@dsh diagnose requires a pull request or workflow_run context",
    );
  }
}

function contextTextBytes(value: string | undefined): number {
  // Charge escaped newlines/quotes too, so 36 KiB does not become 72 KiB in
  // the model's JSON envelope and silently discard later file metadata.
  return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

function boundContextText(value: string, maximumBytes: number): string {
  if (contextTextBytes(value) <= maximumBytes) return value;
  if (maximumBytes < contextTextBytes("\n[truncated by dsh-action]")) return "";
  let low = 0;
  let high = Math.min(Buffer.byteLength(value, "utf8"), maximumBytes);
  let bounded = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = boundedText(value, middle);
    if (contextTextBytes(candidate) <= maximumBytes) {
      bounded = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return bounded;
}

/** Deterministic water filling: short evidence returns its unused share. */
function fairlyBoundContext(
  values: readonly (string | undefined)[],
  maximumBytes: number,
  perFileBytes: number,
): readonly (string | undefined)[] {
  const capped = values.map((value) =>
    value === undefined ? undefined : boundContextText(value, perFileBytes),
  );
  const needs = capped.map(contextTextBytes);
  const allocations = needs.map(() => 0);
  let remaining = maximumBytes;
  let active = needs.flatMap((need, index) => (need > 0 ? [index] : []));
  while (remaining > 0 && active.length > 0) {
    const share = Math.floor(remaining / active.length);
    const extra = remaining % active.length;
    for (const [position, index] of active.entries()) {
      const grant = Math.min(
        (needs[index] ?? 0) - (allocations[index] ?? 0),
        share + (position < extra ? 1 : 0),
      );
      allocations[index] = (allocations[index] ?? 0) + grant;
      remaining -= grant;
    }
    active = active.filter((index) => (allocations[index] ?? 0) < (needs[index] ?? 0));
  }
  return capped.map((value, index) =>
    value === undefined ? undefined : boundContextText(value, allocations[index] ?? 0),
  );
}

function sanitizedSnapshot(snapshot: EntitySnapshot): unknown {
  if (snapshot.kind === "issue") {
    let commentBytes = 0;
    return {
      ...snapshot,
      title: boundedText(sanitizeUntrustedText(snapshot.title), 2 * 1024),
      body: boundedText(sanitizeUntrustedText(snapshot.body), 12 * 1024),
      comments: snapshot.comments.slice(-20).flatMap((comment) => {
        const body = boundedText(sanitizeUntrustedText(comment.body), 2 * 1024);
        const bytes = Buffer.byteLength(body, "utf8");
        if (commentBytes + bytes > 6 * 1024) return [];
        commentBytes += bytes;
        return [{ ...comment, body }];
      }),
    };
  }
  const files = snapshot.changedFiles.slice(0, 100);
  const sanitizedPatches = files.map((file) =>
    file.patch === undefined ? undefined : sanitizeUntrustedText(file.patch),
  );
  const sanitizedSources = files.map((file) =>
    file.source === undefined ? undefined : sanitizeUntrustedText(file.source),
  );
  // Allocate all patches before any source. A long early README, generated
  // bundle or source prefix cannot consume later files' entire evidence share.
  const patches = fairlyBoundContext(sanitizedPatches, 36 * 1024, 12 * 1024);
  const patchBytes = patches.reduce((total, patch) => total + contextTextBytes(patch), 0);
  const sources = fairlyBoundContext(sanitizedSources, 36 * 1024 - patchBytes, 4 * 1024);
  const sourceBytes = sources.reduce((total, source) => total + contextTextBytes(source), 0);
  const changedFiles = files.map((file, index) => {
    const patch = patches[index];
    const source = sources[index];
    return {
      ...file,
      patch,
      source,
      patchTruncated: file.patchTruncated || patch !== sanitizedPatches[index],
      sourceTruncated: file.sourceTruncated || source !== sanitizedSources[index],
    };
  });
  const projectionTruncated =
    files.length < snapshot.changedFiles.length ||
    changedFiles.some((file) => file.patchTruncated || file.sourceTruncated);
  let commentBytes = 0;
  return {
    kind: snapshot.kind,
    number: snapshot.number,
    author: snapshot.author,
    baseSha: snapshot.baseSha,
    baseRef: snapshot.baseRef,
    baseRepository: snapshot.baseRepository,
    baseRepositoryId: snapshot.baseRepositoryId,
    headSha: snapshot.headSha,
    headRef: snapshot.headRef,
    headRepository: snapshot.headRepository,
    headRepositoryId: snapshot.headRepositoryId,
    draft: snapshot.draft,
    isFork: snapshot.isFork,
    diffTruncated:
      snapshot.diffTruncated ||
      files.length < snapshot.changedFiles.length ||
      changedFiles.some((file) => file.patchTruncated),
    contextTruncated: projectionTruncated,
    contextCoverage: {
      changedFileCount: snapshot.changedFiles.length,
      includedFileCount: files.length,
      omittedFileCount: snapshot.changedFiles.length - files.length,
      patchBytes,
      sourceBytes,
      contentBudgetBytes: 36 * 1024,
      byteAccounting: "json-string-content-utf8",
      patchesTruncated: changedFiles.filter((file) => file.patchTruncated).length,
      sourcesTruncated: changedFiles.filter((file) => file.sourceTruncated).length,
      patchesMissing: changedFiles.filter((file) => file.patchMissing).length,
    },
    // Keep patch evidence ahead of prose if the final argv-safe envelope must
    // truncate an unusually large metadata/body/comments packet again.
    changedFiles,
    title: boundContextText(sanitizeUntrustedText(snapshot.title), 2 * 1024),
    body: boundContextText(sanitizeUntrustedText(snapshot.body), 12 * 1024),
    comments: snapshot.comments.slice(-20).flatMap((comment) => {
      const body = boundContextText(sanitizeUntrustedText(comment.body), 2 * 1024);
      const bytes = contextTextBytes(body);
      if (commentBytes + bytes > 6 * 1024) return [];
      commentBytes += bytes;
      return [{ ...comment, body }];
    }),
  };
}

export async function resolvePullRequest(
  client: GitHubClient,
  context: GitHubContext,
  actorFilter: CommentActorFilter = {},
): Promise<PullRequestSnapshot | undefined> {
  if (context.kind === "entity" && context.isPullRequest) {
    return await fetchPullRequestSnapshot(client, context, context.entityNumber, actorFilter);
  }
  if (isWorkflowRunContext(context)) {
    const pullNumber = context.workflowRun.pullRequestNumbers[0];
    if (pullNumber !== undefined) {
      return await fetchPullRequestSnapshot(client, context, pullNumber, actorFilter);
    }
  }
  return undefined;
}

export function requireWorkspace(): string {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (workspace === undefined || workspace === "") {
    throw new ActionConfigurationError("GITHUB_WORKSPACE is missing");
  }
  return resolve(workspace);
}

export async function buildContextPacket(
  client: GitHubClient,
  context: GitHubContext,
  command: RoutedCommand,
  snapshot: EntitySnapshot | undefined,
  inputs: ActionInputs,
): Promise<unknown> {
  let ci: string | undefined;
  if (
    (command.operation === "diagnose" || command.operation === "fix") &&
    snapshot?.kind === "pull_request"
  ) {
    ci = formatCiEvidence(
      await fetchCiEvidence(client, context.repository.owner, context.repository.repo, {
        headSha: snapshot.headSha,
        secrets: [inputs.githubToken, inputs.deepseekApiKey],
        ...(isWorkflowRunContext(context) ? { workflowRunId: context.workflowRun.id } : {}),
      }),
    );
  } else if (
    command.operation === "diagnose" &&
    isWorkflowRunContext(context) &&
    snapshot === undefined
  ) {
    ci = formatCiEvidence(
      await fetchCiEvidence(client, context.repository.owner, context.repository.repo, {
        headSha: context.workflowRun.headSha,
        workflowRunId: context.workflowRun.id,
        secrets: [inputs.githubToken, inputs.deepseekApiKey],
      }),
    );
  }
  return {
    event: { name: context.rawEventName, action: context.eventAction },
    repository: context.repository.fullName,
    entity: snapshot === undefined ? undefined : sanitizedSnapshot(snapshot),
    ci: ci === undefined ? undefined : boundedText(ci, 32 * 1024),
  };
}
