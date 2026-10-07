import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { ReadableStreamReadResult } from "node:stream/web";
import { z } from "zod";

import { DshConfigurationError } from "../dsh/errors.js";
import { PolicyDeniedError } from "../errors.js";
import { createGitHubClient, type GitHubClient } from "../github/client.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { runAction, type RunActionOptions } from "../orchestrator.js";
import { DSH_VERSION } from "../release.js";
import type { RunOutcome } from "../result.js";
import { indexTrackingComments } from "../review/tracking.js";
import { assertNoSecretOutput, redactKnownSecrets } from "../security/env.js";
import { redactSecrets } from "../security/redaction.js";
import { AgentArtsFullEngine } from "./engine-full.js";
import { runtimeUrl, type RuntimeClientConfig } from "./client.js";
import { assertFullAgentArtsAuthorizedRun, loadAgentArtsInputs } from "./inputs.js";
import { BUDGET_CONFIRMATION } from "./live-review.js";
import { withPrivateControllerLogs } from "./local-github-logs.js";
import { canonicalRuntimeJson, type RuntimeTaskReply } from "./runtime-task-protocol.js";

/** This dedicated proof driver cannot target upstream or a third-party repository. */
export const LOCAL_GITHUB_REPOSITORY = "Lixiaoyiao/Huawei-AgentArts-action";
const SHA = z.string().regex(/^[a-f0-9]{40}$/u);
const policySchema = z.strictObject({
  kind: z.literal("live-provider"),
  provider: z.literal("deepseek"),
  model: z.string().min(1).max(200),
  upstreamOrigin: z.literal("https://api.deepseek.com"),
  requestLimit: z.number().int().min(1).max(32),
  maxOutputTokens: z.number().int().min(1).max(8192),
});
type ModelPolicy = z.infer<typeof policySchema>;
const commentSchema = z.strictObject({
  kind: z.enum(["summary", "finding"]),
  id: z.number().int().positive(),
  url: z.string().max(2048),
  commitSha: SHA.optional(),
});
type PublishedComment = z.infer<typeof commentSchema>;
const identitySchema = z.strictObject({
  repository: z.literal(LOCAL_GITHUB_REPOSITORY),
  repositoryId: z.number().int().positive(),
  pullNumber: z.number().int().positive(),
  baseSha: SHA,
  headSha: SHA,
  headRef: z.string().min(1).max(1024),
  actorId: z.number().int().positive(),
  actor: z.string().min(1).max(100),
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  dshVersion: z.literal(DSH_VERSION),
  sourceCommit: SHA,
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
type Identity = z.infer<typeof identitySchema>;
const completedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationKey: z.string().regex(/^[a-f0-9]{64}$/u),
  identity: identitySchema,
  completedAt: z.iso.datetime(),
  runtimeTaskId: z.uuid(),
  originalOutputDirectory: z.string().max(4096),
  summary: z.string().max(16_384),
  comments: z.array(commentSchema).min(1).max(100),
});

export interface LocalGitHubReviewOptions {
  readonly repository: string;
  readonly pullNumber: number;
  readonly expectedHead: string;
  readonly expectedBase: string;
  readonly sourceCommit: string;
  readonly imageDigest: string;
  readonly runtimeOrigin: string;
  readonly trustedLocalRuntime: boolean;
  readonly outputDirectory: string;
  readonly stateDirectory: string;
  readonly timeoutMinutes: number;
  readonly maxModelRequests: number;
  readonly maxOutputTokens: number;
  readonly budgetUsd?: number;
  readonly confirmBudget?: string;
  readonly execute?: boolean;
  readonly signal?: AbortSignal;
}
export interface LocalGitHubReviewDependencies {
  /** Offline tests only. Production uses the original authenticated GitHub client. */
  readonly createClient?: typeof createGitHubClient;
  /** Offline tests only. The default is the complete original Controller lifecycle. */
  readonly executeAction?: (options: RunActionOptions) => Promise<RunOutcome>;
  readonly fetchImplementation?: typeof fetch;
}
interface Stage {
  name: string;
  status: "running" | "passed" | "failed" | "skipped";
  startedAt: string;
  completedAt?: string;
  message?: string;
}
function fail(message: string): never {
  throw new DshConfigurationError(message);
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonicalRuntimeJson(value)).digest("hex");
}
function loopback(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("An explicit loopback Runtime origin is required");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    fail("Local GitHub execution requires an explicit HTTP loopback Runtime origin");
  return url;
}
function assertOptions(options: LocalGitHubReviewOptions): void {
  if (options.repository !== LOCAL_GITHUB_REPOSITORY)
    fail("This proof driver is authorized only for Lixiaoyiao/Huawei-AgentArts-action");
  if (!Number.isSafeInteger(options.pullNumber) || options.pullNumber < 1)
    fail("A positive pull request number is required");
  if (
    ![options.expectedHead, options.expectedBase, options.sourceCommit].every(
      (v) => SHA.safeParse(v).success,
    )
  )
    fail(
      "Expected base/head and declared Controller source commit must be exact lowercase Git SHAs",
    );
  if (!/^sha256:[a-f0-9]{64}$/u.test(options.imageDigest))
    fail("Declare the actual immutable Runtime image digest");
  if (!options.trustedLocalRuntime) fail("Explicit --trusted-local-runtime is required");
  loopback(options.runtimeOrigin);
  if (![options.outputDirectory, options.stateDirectory].every(isAbsolute))
    fail("Output and Controller state directories must be explicit absolute paths");
  const out = resolve(options.outputDirectory),
    state = resolve(options.stateDirectory);
  if (
    out === state ||
    !relative(out, state).startsWith(`..${sep}`) ||
    !relative(state, out).startsWith(`..${sep}`)
  )
    fail("Output and private Controller state directories must be separate siblings");
  if (
    !Number.isSafeInteger(options.timeoutMinutes) ||
    options.timeoutMinutes < 1 ||
    options.timeoutMinutes > 10
  )
    fail("Timeout minutes must be an integer from 1 to 10");
  if (
    !Number.isSafeInteger(options.maxModelRequests) ||
    options.maxModelRequests < 1 ||
    options.maxModelRequests > 32
  )
    fail("Maximum provider requests must be an integer from 1 to 32");
  if (
    !Number.isSafeInteger(options.maxOutputTokens) ||
    options.maxOutputTokens < 1 ||
    options.maxOutputTokens > 8192
  )
    fail("Maximum output tokens must be an integer from 1 to 8192");
  if (
    options.execute === true &&
    (!Number.isFinite(options.budgetUsd) ||
      (options.budgetUsd ?? 0) <= 0 ||
      options.confirmBudget !== BUDGET_CONFIRMATION)
  )
    fail("Execution requires explicit metered model budget approval");
}
function safeRecord(value: unknown, secrets: readonly string[]): string {
  const raw = JSON.stringify(value, null, 2);
  const result = redactSecrets(redactKnownSecrets(raw, secrets));
  assertNoSecretOutput("stdout", result, secrets);
  if (Buffer.byteLength(result) > 2 * 1024 * 1024) fail("Evidence exceeds the 2 MiB bound");
  return `${result}\n`;
}
function codeFor(error: unknown): string {
  return error instanceof PolicyDeniedError
    ? "POLICY_DENIED"
    : "LOCAL_CONTROLLER_REFUSED_OR_FAILED";
}
async function assertRealDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let cursor = root;
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink())
      fail("Controller directories must not contain symlinks or special paths");
  }
  if (resolve(await realpath(absolute)) !== absolute)
    fail("Controller directory aliases are forbidden");
}
async function privateDirectory(path: string, exclusive: boolean): Promise<void> {
  await assertRealDirectory(dirname(path));
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (exclusive || !(error instanceof Error) || !("code" in error) || error.code !== "EEXIST")
      throw error;
  }
  await assertRealDirectory(path);
  if (process.platform !== "win32") {
    const info = await lstat(path);
    if (info.uid !== process.getuid?.())
      fail("Controller directory must belong to the current operator");
    await chmod(path, 0o700);
  }
}
async function readPrivateJson(path: string): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 128 * 1024)
    fail("Controller ledger must be a bounded regular private file");
  const file = await open(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const stat = await file.stat();
    if (
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.size > 128 * 1024 ||
      stat.nlink !== 1 ||
      (process.platform !== "win32" &&
        (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
    )
      fail("Controller ledger changed or is not private");
    const bytes = Buffer.alloc(stat.size + 1);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== stat.size) fail("Controller ledger changed during read");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, stat.size)),
      ) as unknown;
    } catch {
      return fail("Controller ledger is not valid bounded JSON");
    }
  } finally {
    await file.close();
  }
}
async function optionalCompleted(path: string) {
  try {
    return completedSchema.parse(await readPrivateJson(path));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return fail("Controller completion record is invalid; reconcile manually before retry");
  }
}
async function durableIntent(path: string, content: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function atomicCompletion(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await durableIntent(temporary, content);
    // link is atomic and exclusive; rename could overwrite another completion.
    // A crash before unlink leaves nlink=2, which readPrivateJson rejects closed.
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
function fixedInputs(token: string, actorId: number, options: LocalGitHubReviewOptions) {
  const values: Record<string, string> = {
    "github-token": token,
    command: "review",
    "allow-write": "false",
    "dsh-mode": "controlled",
    "permission-profile": "custom",
    "allowed-tools": '["workspace.read","workspace.search"]',
    "max-turns": "1",
    "max-findings": "5",
    "progress-comment": "false",
    "session-mode": "off",
    "bot-user-id": String(actorId),
    "timeout-minutes": String(options.timeoutMinutes),
  };
  return loadAgentArtsInputs((name) => values[name] ?? "");
}
const actorSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(100),
});
const repoSchema = z.object({
  id: z.number().int().positive(),
  full_name: z.literal(LOCAL_GITHUB_REPOSITORY),
  name: z.literal("Huawei-AgentArts-action"),
  owner: z.object({ login: z.literal("Lixiaoyiao") }),
  default_branch: z.string().min(1).max(1024),
});
const prRepo = z.object({
  id: z.number().int().positive(),
  full_name: z.literal(LOCAL_GITHUB_REPOSITORY),
});
const prSchema = z.object({
  number: z.number().int().positive(),
  state: z.literal("open"),
  draft: z.literal(false),
  head: z.object({ sha: SHA, ref: z.string().min(1).max(1024), repo: prRepo }),
  base: z.object({ sha: SHA, ref: z.string().min(1).max(1024), repo: prRepo }),
});
async function currentIdentity(client: GitHubClient, options: LocalGitHubReviewOptions) {
  const actor = actorSchema.parse((await client.rest.users.getAuthenticated()).data);
  const repository = repoSchema.parse(
    (await client.rest.repos.get({ owner: "Lixiaoyiao", repo: "Huawei-AgentArts-action" })).data,
  );
  const pr = prSchema.parse(
    (
      await client.rest.pulls.get({
        owner: "Lixiaoyiao",
        repo: "Huawei-AgentArts-action",
        pull_number: options.pullNumber,
      })
    ).data,
  );
  if (
    pr.number !== options.pullNumber ||
    pr.head.sha !== options.expectedHead ||
    pr.base.sha !== options.expectedBase ||
    pr.head.repo.id !== repository.id ||
    pr.base.repo.id !== repository.id
  )
    throw new PolicyDeniedError(
      "Current real PR repository, open state or expected base/head binding changed",
    );
  return { actor, repository, pr };
}
async function publishedComments(
  client: GitHubClient,
  identity: Identity,
): Promise<PublishedComment[]> {
  const bound = { owner: "Lixiaoyiao", repo: "Huawei-AgentArts-action" };
  // Bounded pagination, with the original marker parser and exact numeric author.
  const summaries: PublishedComment[] = [],
    findings: PublishedComment[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const data = (
      await client.rest.issues.listComments({
        ...bound,
        issue_number: identity.pullNumber,
        per_page: 100,
        page,
      })
    ).data;
    for (const comment of indexTrackingComments(data, identity.actorId).summaries) {
      const expected = `https://github.com/${identity.repository}/issues/${String(identity.pullNumber)}#issuecomment-${String(comment.id)}`;
      const alternative = expected.replace("/issues/", "/pull/");
      if (comment.html_url !== expected && comment.html_url !== alternative)
        fail("Published summary URL ownership did not match the bound PR");
      summaries.push({ kind: "summary", id: comment.id, url: alternative });
    }
    if (data.length < 100) break;
    if (page === 5) fail("Comment ownership lookup exceeded its explicit scan bound");
  }
  for (let page = 1; page <= 5; page += 1) {
    const data = (
      await client.rest.pulls.listReviewComments({
        ...bound,
        pull_number: identity.pullNumber,
        per_page: 100,
        page,
      })
    ).data;
    for (const comment of indexTrackingComments(data, identity.actorId).findings.values()) {
      if (comment.commit_id !== identity.headSha) continue;
      const expected = `https://github.com/${identity.repository}/pull/${String(identity.pullNumber)}#discussion_r${String(comment.id)}`;
      if (comment.html_url !== expected)
        fail("Published finding URL ownership did not match the bound PR");
      findings.push({
        kind: "finding",
        id: comment.id,
        url: expected,
        commitSha: comment.commit_id,
      });
    }
    if (data.length < 100) break;
    if (page === 5) fail("Review ownership lookup exceeded its explicit scan bound");
  }
  return [...summaries, ...findings];
}
async function healthPolicy(
  fetcher: typeof fetch,
  local: URL,
  options: LocalGitHubReviewOptions,
  signal: AbortSignal,
): Promise<ModelPolicy> {
  const response = await fetcher(new URL("/ping", local), {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("application/json") ||
    response.body === null
  )
    fail("Local production Runtime health preflight failed");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item: ReadableStreamReadResult<Uint8Array> = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 16 * 1024) fail("Runtime health response exceeds its bound");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } catch {
    return fail("Runtime health response is not valid bounded JSON");
  }
  const checked = z
    .object({ status: z.literal("Healthy"), modelPolicy: policySchema })
    .safeParse(raw);
  if (
    !checked.success ||
    checked.data.modelPolicy.requestLimit > options.maxModelRequests ||
    checked.data.modelPolicy.maxOutputTokens > options.maxOutputTokens
  )
    fail("Runtime real-provider policy or approved request/token limits failed preflight");
  return checked.data.modelPolicy;
}
function checkExecution(reply: RuntimeTaskReply, policy: ModelPolicy): number {
  const execution = reply.modelExecution;
  if (
    execution === undefined ||
    execution.requestCount < 1 ||
    execution.requestCount > policy.requestLimit
  )
    fail("Runtime did not supply actual bounded model request evidence");
  const { requestCount, ...actual } = execution;
  if (canonicalRuntimeJson(actual) !== canonicalRuntimeJson(policy))
    fail("Runtime model policy changed after preflight; do not automatically retry");
  return requestCount;
}
function localTransport(
  config: RuntimeClientConfig,
  local: URL,
  fetcher: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    const requested =
      input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (requested === runtimeUrl(config, "sessions-stop").href) {
      // Local server cancellation follows connection abort and its hard deadline.
      // This adapter does not claim a platform session-stop endpoint exists.
      return new Response(null, { status: 204 });
    }
    if (requested !== runtimeUrl(config).href || init?.method !== "POST")
      fail("Local transport refuses an unexpected Runtime endpoint");
    return await fetcher(new URL("/invocations", local), { ...init, redirect: "error" });
  };
}
let active = false;
/** Real GitHub -> original Controller/FullEngine -> trusted loopback Runtime -> original publisher. */
export async function runLocalGitHubReview(
  options: LocalGitHubReviewOptions,
  dependencies: LocalGitHubReviewDependencies = {},
) {
  assertOptions(options);
  const plan = {
    mode: "local-real-model",
    execute: options.execute === true,
    repository: options.repository,
    pullNumber: options.pullNumber,
    expectedHead: options.expectedHead,
    expectedBase: options.expectedBase,
    sourceCommit: options.sourceCommit,
    imageDigest: options.imageDigest,
    provenance: "operator-declared-not-attested",
    operation: "review",
    dshVersion: DSH_VERSION,
    maxTurns: 1,
    allowedTools: ["workspace.read", "workspace.search"],
    maxModelRequests: options.maxModelRequests,
    maxOutputTokens: options.maxOutputTokens,
    timeoutMinutes: options.timeoutMinutes,
    actualCost: "unknown",
    dollarBudgetIsHardCap: false,
    cloudVerification: "not-performed",
    githubTrigger: "explicit-local-manual-PR-trigger",
    githubPublisher: "original-controller",
    deduplicationScope: "local-private-driver-ledger-not-Action-or-global-API-idempotency",
    runtimeCountScope: "controller-prepared-attempts-not-server-admission",
    modelCountScope: "validated-supervisor-replies-only-unconfirmed-calls-unknown",
  };
  if (options.execute !== true) return { status: "dry-run" as const, plan };
  if (active) fail("The local GitHub driver refuses concurrent in-process environment mutation");
  active = true;
  const started = Date.now(),
    attemptId = randomUUID();
  const out = resolve(options.outputDirectory),
    state = resolve(options.stateDirectory);
  const deadline = AbortSignal.timeout(options.timeoutMinutes * 60_000);
  const signal =
    options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal]);
  const envNames = [
    "GITHUB_API_URL",
    "GITHUB_SERVER_URL",
    "GITHUB_GRAPHQL_URL",
    "GITHUB_EVENT_NAME",
    "GITHUB_EVENT_PATH",
    "GITHUB_ACTOR",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_WORKSPACE",
  ];
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const stages: Stage[] = [];
  const record = {
    schemaVersion: 1,
    mode: "local",
    task: {
      id: attemptId as string,
      repository: options.repository,
      pullNumber: options.pullNumber,
      headSha: options.expectedHead,
      baseSha: options.expectedBase,
      kind: "pull_request",
      operation: "review",
      url: `https://github.com/${options.repository}/pull/${String(options.pullNumber)}`,
    },
    stages,
    tools: [] as {
      id: string;
      runtimeName: string;
      ok: boolean;
      completed: boolean;
      durationMs: number;
    }[],
    observedTools: [] as string[],
    validation: { status: "not-run", checks: [] as string[] },
    modelEvidence: { kind: "unverified", provider: "deepseek", model: "" },
    runtime: {
      sessionId: "",
      endpoint: options.runtimeOrigin,
      dshVersion: DSH_VERSION,
      requestId: "",
    },
    durationMs: 0,
    result: {} as { summary?: string; error?: string; githubUrl?: string },
    warnings: [
      "本机生产 Runtime；未验证华为云。此入口由人工显式启动，未接收 GitHub webhook。",
      "镜像和控制端 commit 由操作者声明，非远程证明。模型成本未知，美元预算不是硬上限。",
      "原控制端只发布审查；独立业务人工验收仍待完成。",
    ],
  };
  let outputCreated = false,
    operationKey = "",
    runtimeInvocations = 0,
    modelRequests = 0;
  let outcome: RunOutcome | undefined,
    comments: PublishedComment[] = [],
    identity: Identity | undefined;
  let currentStage: Stage | undefined;
  function stage(name: string) {
    if (currentStage?.status === "running") {
      currentStage.status = "passed";
      currentStage.completedAt = new Date().toISOString();
    }
    currentStage = { name, status: "running", startedAt: new Date().toISOString() };
    stages.push(currentStage);
  }
  const githubToken = process.env.AGENTARTS_GITHUB_TOKEN ?? "";
  const capability = process.env.AGENTARTS_LOCAL_API_KEY ?? "";
  const secrets = [githubToken, capability].filter(Boolean);
  const save = async (name: string, value: unknown) => {
    await writeFile(join(out, name), safeRecord(value, secrets), { flag: "wx", mode: 0o600 });
  };
  try {
    if (
      githubToken.length < 8 ||
      capability.length < 16 ||
      githubToken === capability ||
      /[\r\n]/u.test(githubToken + capability)
    )
      fail("Separate AGENTARTS_GITHUB_TOKEN and AGENTARTS_LOCAL_API_KEY credentials are required");
    await privateDirectory(out, true);
    outputCreated = true;
    await privateDirectory(state, false);
    Object.assign(process.env, {
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_GRAPHQL_URL: "https://api.github.com/graphql",
    });
    stage("真实 GitHub 身份与 PR 绑定");
    const client = (dependencies.createClient ?? createGitHubClient)(githubToken, signal, {
      deadlineMs: started + options.timeoutMinutes * 60_000,
    });
    const current = await currentIdentity(client, options);
    const inputs = fixedInputs(githubToken, current.actor.id, options);
    const publicConfiguration = {
      ...inputs,
      githubToken: "controller-only",
      deepseekApiKey: "runtime-managed-model-proxy",
    };
    identity = identitySchema.parse({
      repository: options.repository,
      repositoryId: current.repository.id,
      pullNumber: options.pullNumber,
      baseSha: current.pr.base.sha,
      headSha: current.pr.head.sha,
      headRef: current.pr.head.ref,
      actorId: current.actor.id,
      actor: current.actor.login,
      configurationDigest: digest(publicConfiguration),
      sourceCommit: options.sourceCommit,
      imageDigest: options.imageDigest,
      dshVersion: DSH_VERSION,
    });
    operationKey = digest(identity);
    const lock = join(state, `${operationKey}.started.json`),
      complete = join(state, `${operationKey}.complete.json`);
    const existing = await optionalCompleted(complete);
    if (existing !== undefined) {
      if (
        existing.operationKey !== operationKey ||
        canonicalRuntimeJson(existing.identity) !== canonicalRuntimeJson(identity)
      )
        fail("Completion identity does not match the current real PR");
      const actualComments = await publishedComments(client, identity);
      if (
        existing.comments.some(
          (item) =>
            !actualComments.some(
              (actual) => canonicalRuntimeJson(actual) === canonicalRuntimeJson(item),
            ),
        )
      )
        fail(
          "Previously confirmed GitHub comments are absent or ownership changed; manual reconciliation required",
        );
      comments = existing.comments;
      stage("已完成任务的历史结果复用（本次 0 Runtime / 0 发布）");
      record.task.id = existing.runtimeTaskId;
      record.result = { summary: existing.summary, githubUrl: comments[0]?.url ?? record.task.url };
      record.validation = {
        status: "passed",
        checks: [
          "重新读取真实 PR 并校验仓库/base/head/状态",
          "历史结果评论数字作者与 PR 链接归属复核",
          "本次没有模型或 GitHub 写入调用",
        ],
      };
      record.warnings.push(
        "历史复用：本次 0 Runtime、0 模型请求、0 发布；此前证据目录见 operation-evidence.json。仅证明本地 driver 跨重启幂等。",
      );
      if (currentStage) {
        currentStage.status = "passed";
        currentStage.completedAt = new Date().toISOString();
      }
      record.durationMs = Date.now() - started;
      await save("run-record.json", record);
      await save("operation-evidence.json", {
        schemaVersion: 1,
        attemptId,
        plan,
        identity,
        operationKey,
        status: "reused",
        runtimeInvocations: 0,
        modelRequests: 0,
        publicationAttempts: 0,
        comments,
        previousEvidenceDirectory: existing.originalOutputDirectory,
        manualVerdict: "not-reviewed",
        actualCost: "unknown",
      });
      return {
        status: "reused" as const,
        outputDirectory: out,
        operationKey,
        githubUrls: comments.map((item) => item.url),
        runtimeInvocations: 0,
        modelRequests: 0,
      };
    }
    // An exclusive durable intent is retained on every ambiguous/error exit. No automatic replay.
    try {
      await durableIntent(
        lock,
        safeRecord(
          {
            schemaVersion: 1,
            operationKey,
            identity,
            attemptId,
            startedAt: new Date().toISOString(),
            state: "unknown-until-confirmed",
          },
          secrets,
        ),
      );
    } catch {
      fail(
        "A prior or concurrent attempt has an unconfirmed outcome; reconcile the private ledger manually before retry",
      );
    }
    throwIfCancelled(signal);
    stage("本机生产 Runtime 与真实模型限额预检");
    const fetcher = dependencies.fetchImplementation ?? fetch,
      local = loopback(options.runtimeOrigin);
    const policy = await healthPolicy(fetcher, local, options, signal);
    const config: RuntimeClientConfig = {
      origin: "https://explicit-local-github.invalid",
      runtimeName: "local-github-review",
      endpoint: "fixed-v3",
      apiKey: capability,
    };
    const transport = localTransport(config, local, fetcher);
    const payload = {
      action: "synchronize",
      repository: current.repository,
      sender: { login: current.actor.login },
      pull_request: current.pr,
    };
    await save("manual-trigger.json", payload);
    Object.assign(process.env, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_ACTOR: current.actor.login,
      GITHUB_REPOSITORY: options.repository,
      GITHUB_EVENT_PATH: join(out, "manual-trigger.json"),
      GITHUB_RUN_ID: "",
      GITHUB_WORKSPACE: out,
    });
    outcome = await withPrivateControllerLogs(
      secrets,
      async () =>
        await (dependencies.executeAction ?? runAction)({
          inputs,
          signal,
          executionContextUrl: record.task.url,
          assertAuthorizedRun: (run) => {
            assertFullAgentArtsAuthorizedRun(run);
            if (
              run.policy.trust !== "trusted-read" ||
              run.command.operation !== "review" ||
              run.command.requestedAccess !== "read" ||
              run.context.repository.id !== identity?.repositoryId ||
              run.context.repository.fullName !== options.repository ||
              run.context.actor !== current.actor.login ||
              run.snapshot?.kind !== "pull_request" ||
              run.snapshot.number !== options.pullNumber ||
              run.snapshot.baseSha !== options.expectedBase ||
              run.snapshot.headSha !== options.expectedHead ||
              run.snapshot.isFork
            )
              throw new PolicyDeniedError(
                "Original Controller policy or freshly resolved PR binding did not match this local review",
              );
          },
          createEngine: (run, workspace, execution) => async (runtime) => {
            if (run.snapshot?.kind !== "pull_request")
              throw new PolicyDeniedError("Review requires the original PR snapshot");
            return await Promise.resolve(
              new AgentArtsFullEngine(
                config,
                run.policy.trust,
                {
                  repository: options.repository,
                  baseSha: run.snapshot.baseSha,
                  headSha: run.snapshot.headSha,
                  ref: run.snapshot.headRef,
                  entity: { kind: "pull_request", number: options.pullNumber },
                },
                secrets,
                {
                  workspace,
                  runtime,
                  mode: "controlled",
                  operationIdentity: execution.operationIdentity,
                  extensionPlan: execution.extensions,
                  validationCommands: inputs.testCommands,
                  fetchImplementation: transport,
                  onRequestId: (id) => {
                    record.runtime.requestId = id;
                  },
                  onTask: (task) => {
                    runtimeInvocations += 1;
                    if (runtimeInvocations > 1)
                      fail("This review driver permits one bounded Runtime invocation per attempt");
                    record.task.id = task.taskId;
                    record.runtime.sessionId = task.taskId;
                    stage("真实 DSH / DeepSeek 审查（本机生产容器）");
                  },
                  onValidated: async (reply) => {
                    modelRequests += checkExecution(reply, policy);
                    if (modelRequests > options.maxModelRequests)
                      fail("Actual provider request evidence exceeded the approved attempt limit");
                    record.modelEvidence = {
                      kind: "live-provider",
                      provider: "deepseek",
                      model: policy.model,
                    };
                    record.tools.push(
                      ...reply.toolReceipts.map((value) =>
                        z
                          .object({
                            id: z.string(),
                            runtimeName: z.string(),
                            ok: z.boolean(),
                            completed: z.boolean(),
                            durationMs: z.number().int().nonnegative(),
                          })
                          .parse(value),
                      ),
                    );
                    record.observedTools = [
                      ...new Set([...record.observedTools, ...(reply.observedTools ?? [])]),
                    ];
                    record.validation = {
                      status: "not-run",
                      checks: [
                        "v3 严格结果协议与 task/operation/entity/ref/base/head/grant 绑定",
                        "输入工作区摘要与只读实际文件检查",
                        "生产 bwrap / 网络隔离回执",
                        "可信 supervisor 模型来源与实际请求上限",
                      ],
                    };
                    stage("原控制端 precision / diff / 写前 head 校验与发布");
                    await save("validated-runtime-result.json", reply);
                  },
                },
              ),
            );
          },
        }),
    );
    await save("controller-outcome.json", outcome);
    if (
      outcome.conclusion !== "success" ||
      outcome.operation !== "review" ||
      outcome.publication === undefined ||
      outcome.publication.failures.length > 0
    )
      fail(
        "Original Controller did not confirm successful review publication; automatic retry is refused",
      );
    stage("真实 GitHub 发布结果只读核验");
    // Recheck base/head/state after publication before recording a reusable completion.
    await currentIdentity(client, options);
    comments = await publishedComments(client, identity);
    if (
      !comments.some((item) => item.kind === "summary") ||
      !record.runtime.sessionId ||
      record.modelEvidence.kind !== "live-provider"
    )
      fail(
        "Published review or actual Runtime evidence could not be independently confirmed; reconcile manually",
      );
    record.validation.status = "passed";
    record.validation.checks.push(
      "原控制端 precision / diff 与发布前 head 检查完成",
      "发布后 PR base/head 和实际评论数字作者/链接归属核验",
    );
    record.result = { summary: outcome.summary, githubUrl: comments[0]?.url ?? record.task.url };
    if (currentStage) {
      currentStage.status = "passed";
      currentStage.completedAt = new Date().toISOString();
    }
    record.durationMs = Date.now() - started;
    throwIfCancelled(signal);
    await atomicCompletion(
      complete,
      safeRecord(
        completedSchema.parse({
          schemaVersion: 1,
          operationKey,
          identity,
          completedAt: new Date().toISOString(),
          runtimeTaskId: record.task.id,
          originalOutputDirectory: out,
          summary: outcome.summary,
          comments,
        }),
        secrets,
      ),
    );
    await save("run-record.json", record);
    await save("operation-evidence.json", {
      schemaVersion: 1,
      attemptId,
      plan,
      identity,
      operationKey,
      status: "completed",
      runtimeInvocations,
      modelRequests,
      publication: outcome.publication,
      comments,
      independentRepositoryTests: "not-applicable-review",
      manualVerdict: "not-reviewed",
      actualCost: "unknown",
    });
    return {
      status: "completed" as const,
      outputDirectory: out,
      operationKey,
      githubUrls: comments.map((item) => item.url),
      runtimeInvocations,
      modelRequests,
    };
  } catch (error: unknown) {
    if (currentStage) {
      currentStage.status = "failed";
      currentStage.completedAt = new Date().toISOString();
    }
    const failureCode = codeFor(error);
    const failureReason =
      error instanceof DshConfigurationError || error instanceof PolicyDeniedError
        ? error.message
        : "Strict preflight, GitHub, filesystem or cancellation boundary failed; inspect private evidence.";
    record.validation.status = "failed";
    record.result.error = `${failureCode}: ${failureReason} Automatic replay is refused.`;
    record.durationMs = Date.now() - started;
    if (outputCreated) {
      await save("run-record.json", record).catch(() => undefined);
      await save("operation-evidence.json", {
        schemaVersion: 1,
        attemptId,
        plan,
        identity,
        operationKey,
        status: "failed-or-unconfirmed",
        failureCode,
        failureReason,
        runtimeInvocations,
        modelRequests,
        publication: outcome?.publication,
        comments,
        automaticReplay: "refused",
        actualCost: "unknown",
        manualVerdict: "not-reviewed",
      }).catch(() => undefined);
    }
    return {
      status: "refused-or-failed" as const,
      outputDirectory: outputCreated ? out : undefined,
      failureCode,
      failureReason,
      runtimeInvocations,
      modelRequests,
    };
  } finally {
    for (const name of envNames) {
      const value = previous[name];
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    active = false;
  }
}

export function parseLocalGitHubReviewArguments(args: readonly string[]): LocalGitHubReviewOptions {
  const values = new Map<string, string>(),
    booleans = new Set<string>();
  const fields = new Set([
    "repository",
    "pull-number",
    "expected-head",
    "expected-base",
    "source-commit",
    "image-digest",
    "runtime-origin",
    "out",
    "state-dir",
    "timeout-minutes",
    "max-model-requests",
    "max-output-tokens",
    "budget-usd",
    "confirm-budget",
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--execute" || flag === "--dry-run" || flag === "--trusted-local-runtime") {
      if (booleans.has(flag)) fail("Duplicate local GitHub flag");
      booleans.add(flag);
      continue;
    }
    if (
      flag === undefined ||
      !flag.startsWith("--") ||
      !fields.has(flag.slice(2)) ||
      values.has(flag.slice(2))
    )
      fail("Unknown or duplicate local GitHub argument");
    const value = args[++i];
    if (value === undefined || value.startsWith("--"))
      fail("Local GitHub argument is missing its value");
    values.set(flag.slice(2), value);
  }
  if (booleans.has("--execute") && booleans.has("--dry-run")) fail("Choose execute or dry-run");
  const options: LocalGitHubReviewOptions = {
    repository: values.get("repository") ?? "",
    pullNumber: Number(values.get("pull-number")),
    expectedHead: values.get("expected-head") ?? "",
    expectedBase: values.get("expected-base") ?? "",
    sourceCommit: values.get("source-commit") ?? "",
    imageDigest: values.get("image-digest") ?? "",
    runtimeOrigin: values.get("runtime-origin") ?? "",
    trustedLocalRuntime: booleans.has("--trusted-local-runtime"),
    outputDirectory: values.get("out") ?? "",
    stateDirectory: values.get("state-dir") ?? "",
    timeoutMinutes: Number(values.get("timeout-minutes") ?? "5"),
    maxModelRequests: Number(values.get("max-model-requests") ?? "8"),
    maxOutputTokens: Number(values.get("max-output-tokens") ?? "4096"),
    execute: booleans.has("--execute"),
    ...(values.has("budget-usd") ? { budgetUsd: Number(values.get("budget-usd")) } : {}),
    ...(values.has("confirm-budget") ? { confirmBudget: values.get("confirm-budget") ?? "" } : {}),
  };
  assertOptions(options);
  return options;
}

export async function runLocalGitHubReviewMain(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await runLocalGitHubReview({
      ...parseLocalGitHubReviewArguments(args),
      signal: cancellation.signal,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "refused-or-failed") process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
