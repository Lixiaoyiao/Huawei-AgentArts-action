import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type * as Clients from "../src/github/client.js";
import type * as Fetches from "../src/github/fetch.js";
import type * as Repository from "../src/github/repository.js";
import type { GitHubClient } from "../src/github/client.js";
import type { PullRequestSnapshot } from "../src/github/fetch.js";
import {
  LOCAL_GITHUB_REPOSITORY,
  parseLocalGitHubReviewArguments,
  runLocalGitHubReview,
  type LocalGitHubReviewOptions,
} from "../src/agentarts/local-github-review.js";
import {
  runtimeTaskDigest,
  runtimeTaskSchema,
  type RuntimeTaskReply,
} from "../src/agentarts/runtime-task-protocol.js";
import { BUDGET_CONFIRMATION } from "../src/agentarts/live-review.js";
import { createTrackingMarker } from "../src/review/tracking.js";
import { withPrivateControllerLogs } from "../src/agentarts/local-github-logs.js";

// Explicit simulated GitHub and HTTP/model responses. The success test runs the
// real original runAction, FullEngine, precision/diff checks and review publisher.
// It proves wiring and refusal/dedup semantics, not real DSH/provider/cloud/GitHub.
const mocks = vi.hoisted(() => ({ client: vi.fn(), snapshot: vi.fn(), materialize: vi.fn() }));
vi.mock("../src/github/client.js", async (original) => ({
  ...(await original<typeof Clients>()),
  createGitHubClient: mocks.client,
}));
vi.mock("../src/github/fetch.js", async (original) => ({
  ...(await original<typeof Fetches>()),
  fetchEntitySnapshot: mocks.snapshot,
  fetchPullRequestSnapshot: mocks.snapshot,
}));
vi.mock("../src/github/repository.js", async (original) => ({
  ...(await original<typeof Repository>()),
  materializeRepositoryAtSha: mocks.materialize,
}));

const HEAD = "a".repeat(40),
  BASE = "b".repeat(40),
  SOURCE = "c".repeat(40);
const TOKEN = "synthetic-github-controller-only",
  CAP = "synthetic-runtime-capability-only";
const TEXT =
  "export function inBounds(index: number, length: number): boolean {\n  return index >= 0 && index <= length;\n}\n";
const PATCH =
  "@@ -1,3 +1,3 @@\n export function inBounds(index: number, length: number): boolean {\n-  return index >= 0 && index < length;\n+  return index >= 0 && index <= length;\n }";
const policy = {
  kind: "live-provider",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  upstreamOrigin: "https://api.deepseek.com",
  requestLimit: 4,
  maxOutputTokens: 4096,
} as const;
const temporary: string[] = [];
interface Comment {
  id: number;
  body: string;
  user: { id: number };
  html_url: string;
  commit_id?: string;
  path?: string;
  line?: number;
  side?: string;
}
let comments: Comment[],
  inline: Comment[],
  head: string,
  base: string,
  repoId: number,
  openState: string;
let github: ReturnType<typeof fakeGitHub>, transport: ReturnType<typeof runtimeTransport>;
let priorEnvironment: NodeJS.ProcessEnv;

function snapshot(): PullRequestSnapshot {
  return {
    kind: "pull_request",
    number: 7,
    title: "Synthetic local driver review",
    body: "untrusted",
    author: "alice",
    baseSha: BASE,
    baseRef: "main",
    baseRepository: LOCAL_GITHUB_REPOSITORY,
    baseRepositoryId: 123,
    headSha: HEAD,
    headRef: "proof-branch",
    headRepository: LOCAL_GITHUB_REPOSITORY,
    headRepositoryId: 123,
    draft: false,
    isFork: false,
    changedFiles: [
      {
        path: "src/bounds.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: PATCH,
        patchMissing: false,
        patchTruncated: false,
        source: TEXT,
        sourceTruncated: false,
      },
    ],
    diffTruncated: false,
    comments: [],
  };
}
function fakeGitHub() {
  const listComments = vi.fn(() => Promise.resolve({ data: comments })),
    listReviewComments = vi.fn(() => Promise.resolve({ data: inline }));
  const createComment = vi.fn((input: { body: string }) => {
    const comment = {
      id: 101,
      body: input.body,
      user: { id: 456 },
      html_url: `https://github.com/${LOCAL_GITHUB_REPOSITORY}/issues/7#issuecomment-101`,
    };
    comments.push(comment);
    return Promise.resolve({ data: comment });
  });
  const createReviewComment = vi.fn(
    (input: { body: string; commit_id: string; path: string; line: number; side: string }) => {
      const comment = {
        ...input,
        id: 102,
        user: { id: 456 },
        html_url: `https://github.com/${LOCAL_GITHUB_REPOSITORY}/pull/7#discussion_r102`,
      };
      inline.push(comment);
      return Promise.resolve({ data: comment });
    },
  );
  const updateComment = vi.fn((input: { body: string; comment_id: number }) => {
    const comment = comments.find((value) => value.id === input.comment_id);
    if (comment) comment.body = input.body;
    return Promise.resolve({ data: comment });
  });
  const getPull = vi.fn(() =>
    Promise.resolve({
      data: {
        number: 7,
        state: openState,
        draft: false,
        head: {
          sha: head,
          ref: "proof-branch",
          repo: { id: repoId, full_name: LOCAL_GITHUB_REPOSITORY },
        },
        base: { sha: base, ref: "main", repo: { id: repoId, full_name: LOCAL_GITHUB_REPOSITORY } },
      },
    }),
  );
  const value = {
    rest: {
      users: {
        getAuthenticated: vi.fn(() => Promise.resolve({ data: { id: 456, login: "alice" } })),
        getByUsername: vi.fn(() => Promise.resolve({ data: { type: "User" } })),
      },
      repos: {
        get: vi.fn(() =>
          Promise.resolve({
            data: {
              id: 123,
              name: "Huawei-AgentArts-action",
              full_name: LOCAL_GITHUB_REPOSITORY,
              owner: { login: "Lixiaoyiao" },
              default_branch: "main",
            },
          }),
        ),
        getCollaboratorPermissionLevel: vi.fn(() =>
          Promise.resolve({ data: { permission: "admin" } }),
        ),
      },
      pulls: {
        get: getPull,
        listReviewComments,
        createReviewComment,
        updateReviewComment: vi.fn(),
      },
      issues: { listComments, createComment, updateComment },
    },
    paginate: vi.fn((method: unknown) =>
      Promise.resolve(method === listComments ? comments : inline),
    ),
  };
  return {
    client: value as unknown as GitHubClient,
    createComment,
    createReviewComment,
    updateComment,
    getPull,
  };
}
function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
function runtimeTransport(
  settings: {
    badPolicy?: boolean;
    badBinding?: boolean;
    noIsolation?: boolean;
    staleAfterReply?: boolean;
    unknownPost?: boolean;
    clean?: boolean;
  } = {},
) {
  return vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (url.endsWith("/ping"))
      return Promise.resolve(
        json({
          status: "Healthy",
          modelPolicy: settings.badPolicy ? { ...policy, requestLimit: 32 } : policy,
        }),
      );
    expect(url).toBe("http://127.0.0.1:8080/invocations");
    expect(init?.redirect).toBe("error");
    expect(JSON.stringify(init)).not.toContain(TOKEN);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${CAP}`);
    if (settings.unknownPost) return Promise.reject(new Error(`Simulated disconnect ${TOKEN}`));
    if (typeof init?.body !== "string") throw new Error("Expected task JSON");
    const task = runtimeTaskSchema.parse(JSON.parse(init.body) as unknown);
    expect(task.tools).toEqual(["workspace.read", "workspace.search"]);
    expect(task.workspace.files.some((file) => file.path === "src/bounds.ts")).toBe(true);
    expect(
      task.workspace.files.some(
        (file) => file.path.includes("ledger") || file.path.includes("trigger"),
      ),
    ).toBe(false);
    const reply: RuntimeTaskReply = {
      schemaVersion: 3,
      taskId: task.taskId,
      operation: task.operation,
      binding: settings.badBinding ? { ...task.binding, headSha: "d".repeat(40) } : task.binding,
      taskDigest: runtimeTaskDigest(task),
      workspaceDigest: task.workspace.digest,
      output: {
        protocolVersion: 1,
        operation: "review",
        state: "final",
        summary: "Simulated boundary review",
        findings: settings.clean
          ? []
          : [
              {
                title: "Inclusive upper bound permits an invalid index",
                body: "The exclusive upper bound is required: index=3,length=3 must be false.",
                evidence: "index=3,length=3 returns true.",
                category: "correctness",
                severity: "high",
                confidence: 0.99,
                path: "src/bounds.ts",
                line: 2,
                side: "RIGHT",
              },
            ],
      },
      durationMs: 10,
      toolReceipts: [
        {
          schemaVersion: 1,
          callId: "fixture-read",
          id: "workspace.read",
          runtimeName: "read",
          provider: "builtin",
          ok: true,
          completed: true,
          counted: true,
          durationMs: 2,
        },
      ],
      delta: null,
      extensionAudit: z
        .json()
        .parse(JSON.parse(JSON.stringify(task.extensions?.audit ?? {})) as unknown),
      modelExecution: { ...policy, requestCount: 2 },
      sandboxEvidence: {
        backend: "agentarts-bwrap",
        credentialMediated: true,
        processIsolated: true,
        networkIsolated: !settings.noIsolation,
        workspaceAccess: "read-only",
      },
    };
    if (settings.staleAfterReply) head = "e".repeat(40);
    return Promise.resolve(json(reply));
  });
}
async function options(changes: Partial<LocalGitHubReviewOptions> = {}) {
  const parent = await mkdtemp(join(tmpdir(), "agentarts-local-gh-test-"));
  temporary.push(parent);
  return {
    repository: LOCAL_GITHUB_REPOSITORY,
    pullNumber: 7,
    expectedHead: HEAD,
    expectedBase: BASE,
    sourceCommit: SOURCE,
    imageDigest: `sha256:${"1".repeat(64)}`,
    runtimeOrigin: "http://127.0.0.1:8080",
    trustedLocalRuntime: true,
    outputDirectory: join(parent, "evidence"),
    stateDirectory: join(parent, "ledger"),
    timeoutMinutes: 1,
    maxModelRequests: 4,
    maxOutputTokens: 4096,
    execute: true,
    budgetUsd: 1,
    confirmBudget: BUDGET_CONFIRMATION,
    ...changes,
  } satisfies LocalGitHubReviewOptions;
}
async function read(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}
const deps = () => ({ createClient: mocks.client, fetchImplementation: transport });
beforeEach(() => {
  priorEnvironment = { ...process.env };
  process.env.AGENTARTS_GITHUB_TOKEN = TOKEN;
  process.env.AGENTARTS_LOCAL_API_KEY = CAP;
  comments = [];
  inline = [];
  head = HEAD;
  base = BASE;
  repoId = 123;
  openState = "open";
  github = fakeGitHub();
  transport = runtimeTransport();
  mocks.client.mockReturnValue(github.client);
  mocks.snapshot.mockResolvedValue(snapshot());
  mocks.materialize.mockImplementation(
    async (_client: unknown, _owner: string, _repo: string, _sha: string, path: string) => {
      await mkdir(join(path, "src"), { recursive: true });
      await writeFile(join(path, "src/bounds.ts"), TEXT);
    },
  );
});
afterEach(async () => {
  process.env = priorEnvironment;
  vi.clearAllMocks();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
describe("explicit local real-GitHub driver (offline simulated transports)", () => {
  it("dry-runs without reading credentials, HTTP, filesystem or publication", async () => {
    const opts = await options({ execute: false });
    Reflect.deleteProperty(process.env, "AGENTARTS_GITHUB_TOKEN");
    Reflect.deleteProperty(process.env, "AGENTARTS_LOCAL_API_KEY");
    expect(await runLocalGitHubReview(opts, deps())).toMatchObject({
      status: "dry-run",
      plan: { mode: "local-real-model", cloudVerification: "not-performed", maxTurns: 1 },
    });
    expect(transport).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    await expect(readdir(opts.outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("uses real original Action/FullEngine/precision/diff/publisher and confirms authors/links", async () => {
    const opts = await options();
    const result = await runLocalGitHubReview(opts, deps());
    if (result.status !== "completed")
      throw new Error(
        JSON.stringify(await read(join(opts.outputDirectory, "controller-outcome.json"))),
      );
    expect(result).toMatchObject({ status: "completed", runtimeInvocations: 1, modelRequests: 2 });
    expect(github.createReviewComment).toHaveBeenCalledOnce();
    expect(github.createComment).toHaveBeenCalledOnce();
    expect(github.createComment.mock.calls[0]?.[0].body).toContain("[Execution context]");
    expect(github.createComment.mock.calls[0]?.[0].body).not.toContain("/actions/runs/");
    const record = await read(join(opts.outputDirectory, "run-record.json"));
    expect(record).toMatchObject({
      mode: "local",
      modelEvidence: { kind: "live-provider" },
      validation: { status: "passed" },
    });
    for (const file of await readdir(opts.outputDirectory)) {
      const body = await readFile(join(opts.outputDirectory, file), "utf8");
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain(CAP);
    }
    expect(process.env.GITHUB_EVENT_PATH).toBe(priorEnvironment.GITHUB_EVENT_PATH);
    const exporter = resolve("agentarts/demo/export.mjs"),
      exported = join(opts.outputDirectory, "..", "static");
    await promisify(execFile)(process.execPath, [
      exporter,
      "--record",
      join(opts.outputDirectory, "run-record.json"),
      "--out",
      exported,
    ]);
    expect(
      (await readFile(join(exported, "run-record.json"))).equals(
        await readFile(join(opts.outputDirectory, "run-record.json")),
      ),
    ).toBe(true);
  });
  it("reuses only a freshly rechecked confirmed operation, with zero Runtime or publication", async () => {
    const opts = await options();
    expect((await runLocalGitHubReview(opts, deps())).status).toBe("completed");
    const before = transport.mock.calls.length,
      outputDirectory = join(join(opts.outputDirectory, ".."), "replayed");
    expect(await runLocalGitHubReview({ ...opts, outputDirectory }, deps())).toMatchObject({
      status: "reused",
      runtimeInvocations: 0,
      modelRequests: 0,
    });
    expect(transport).toHaveBeenCalledTimes(before);
    expect(github.createReviewComment).toHaveBeenCalledOnce();
    expect(github.createComment).toHaveBeenCalledOnce();
    expect(await read(join(outputDirectory, "operation-evidence.json"))).toMatchObject({
      publicationAttempts: 0,
      previousEvidenceDirectory: opts.outputDirectory,
    });
  });
  it.each(["base", "head", "state", "repository-id", "comment-author", "comment-url"])(
    "refuses cached operation after %s drift",
    async (kind) => {
      const opts = await options();
      expect((await runLocalGitHubReview(opts, deps())).status).toBe("completed");
      if (kind === "base") base = "d".repeat(40);
      if (kind === "head") head = "d".repeat(40);
      if (kind === "state") openState = "closed";
      if (kind === "repository-id") repoId = 999;
      const first = comments[0];
      if (!first) throw new Error("Original publisher did not create a summary");
      if (kind === "comment-author") first.user.id = 999;
      if (kind === "comment-url") first.html_url = "https://evil.invalid/issuecomment-101";
      const before = transport.mock.calls.length;
      expect(
        (
          await runLocalGitHubReview(
            { ...opts, outputDirectory: join(opts.outputDirectory, "..", "drift") },
            deps(),
          )
        ).status,
      ).toBe("refused-or-failed");
      expect(transport).toHaveBeenCalledTimes(before);
      expect(github.createComment).toHaveBeenCalledOnce();
    },
  );
  it.each(["binding", "isolation", "stale", "ambiguous-http", "policy"])(
    "stops %s failures without publishing or automatic replay",
    async (kind) => {
      const opts = await options();
      transport = runtimeTransport({
        badBinding: kind === "binding",
        noIsolation: kind === "isolation",
        staleAfterReply: kind === "stale",
        unknownPost: kind === "ambiguous-http",
        badPolicy: kind === "policy",
      });
      expect((await runLocalGitHubReview(opts, deps())).status).toBe("refused-or-failed");
      expect(github.createComment).not.toHaveBeenCalled();
      expect(github.createReviewComment).not.toHaveBeenCalled();
      head = HEAD;
      const before = transport.mock.calls.length;
      expect(
        (
          await runLocalGitHubReview(
            { ...opts, outputDirectory: join(opts.outputDirectory, "..", "retry") },
            deps(),
          )
        ).status,
      ).toBe("refused-or-failed");
      expect(transport).toHaveBeenCalledTimes(before);
    },
  );
  it("publishes a checked clean summary without an invented finding", async () => {
    transport = runtimeTransport({ clean: true });
    expect((await runLocalGitHubReview(await options(), deps())).status).toBe("completed");
    expect(github.createComment).toHaveBeenCalledOnce();
    expect(github.createReviewComment).not.toHaveBeenCalled();
  });
  it("does not treat model or foreign-author markers as confirmed publications", async () => {
    const opts = await options();
    comments.push({
      id: 999,
      body: createTrackingMarker({ kind: "summary" }),
      user: { id: 999 },
      html_url: "https://evil.invalid/",
    });
    expect((await runLocalGitHubReview(opts, deps())).status).toBe("completed");
    expect(github.createComment).toHaveBeenCalledOnce();
  });
  it("refuses absent/distinct capability, existing output and linked state directories", async () => {
    const opts = await options();
    process.env.AGENTARTS_LOCAL_API_KEY = TOKEN;
    expect((await runLocalGitHubReview(opts, deps())).status).toBe("refused-or-failed");
    expect(mocks.client).not.toHaveBeenCalled();
    process.env.AGENTARTS_LOCAL_API_KEY = CAP;
    await mkdir(opts.outputDirectory);
    expect((await runLocalGitHubReview(opts, deps())).status).toBe("refused-or-failed");
    expect(mocks.client).not.toHaveBeenCalled();
    const target = join(opts.stateDirectory, "..", "actual-state");
    await mkdir(target);
    await symlink(target, opts.stateDirectory, process.platform === "win32" ? "junction" : "dir");
    expect(
      (
        await runLocalGitHubReview(
          { ...opts, outputDirectory: join(opts.outputDirectory, "..", "linked") },
          deps(),
        )
      ).status,
    ).toBe("refused-or-failed");
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it.each([
    { repository: "Lixiaoyiao/deepseek-harness-action" },
    { runtimeOrigin: "http://localhost:8080" },
    { runtimeOrigin: "https://other.invalid" },
    { trustedLocalRuntime: false },
    { sourceCommit: "latest" },
    { expectedHead: "abc" },
    { maxModelRequests: 33 },
    { confirmBudget: "yes" },
  ])("rejects invalid admission without HTTP: %j", async (change) => {
    await expect(runLocalGitHubReview(await options(change), deps())).rejects.toThrow();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects unknown and duplicate CLI arguments before any execution", () => {
    expect(() => parseLocalGitHubReviewArguments(["--bundle-load-probe"])).toThrow();
    expect(() => parseLocalGitHubReviewArguments(["--execute", "--execute"])).toThrow();
    expect(() => parseLocalGitHubReviewArguments(["--runtime-origin"])).toThrow();
  });
  it("keeps Actions mask commands private and redacts secrets across split log chunks", async () => {
    const output: string[] = [];
    const writer = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await withPrivateControllerLogs([TOKEN, CAP], () => {
        process.stdout.write(`::add-mask::${TOKEN}\n`);
        process.stdout.write(`Controller ${TOKEN.slice(0, 12)}`);
        process.stdout.write(`${TOKEN.slice(12)} safely redacted\n`);
        process.stdout.write(`tail ${CAP}`);
        return Promise.resolve();
      });
      expect(output.join("")).not.toContain(TOKEN);
      expect(output.join("")).not.toContain(CAP);
      expect(output.join("")).not.toContain("::add-mask::");
      expect(output.join("")).toContain("safely redacted");
    } finally {
      writer.mockRestore();
    }
  });
  it("retains an exclusive unknown ledger and refuses a concurrent process driver attempt", async () => {
    const opts = await options();
    let release: (() => void) | undefined;
    const originalFetch = transport;
    transport = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url.endsWith("/ping"))
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return await originalFetch(input, init);
    });
    const pending = runLocalGitHubReview(opts, deps());
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(
      runLocalGitHubReview(
        { ...opts, outputDirectory: join(opts.outputDirectory, "..", "concurrent") },
        deps(),
      ),
    ).rejects.toThrow("concurrent");
    release?.();
    expect((await pending).status).toBe("completed");
    expect(github.createComment).toHaveBeenCalledOnce();
  });
});
