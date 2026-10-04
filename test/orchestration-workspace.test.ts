import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as RepositoryModule from "../src/github/repository.js";
import type { GitHubClient } from "../src/github/client.js";
import type { GitHubContext } from "../src/github/context.js";
import type { PullRequestSnapshot } from "../src/github/fetch.js";
import {
  disposeWorkspace,
  prepareWorkspace,
  type PreparedWorkspace,
} from "../src/orchestration/workspace.js";
import { evaluatePolicy } from "../src/security/policy.js";
import { inspectWorkspaceChanges } from "../src/write/workspace.js";
import { inputs, permissions, pullRequestContext } from "./helpers.js";

const mocks = vi.hoisted(() => ({ materializeRepositoryAtSha: vi.fn() }));
vi.mock("../src/github/repository.js", async (original) => ({
  ...(await original<typeof RepositoryModule>()),
  materializeRepositoryAtSha: mocks.materializeRepositoryAtSha,
}));

const RUN_HEAD = "a".repeat(40);
const PR_HEAD = "b".repeat(40);
const ADVANCED_BRANCH_HEAD = "c".repeat(40);
const PR_BASE = "d".repeat(40);

function automationContext(workflowRun = false): GitHubContext {
  return {
    kind: "automation",
    rawEventName: workflowRun ? "workflow_run" : "workflow_dispatch",
    eventName: workflowRun ? "workflow_run" : "workflow_dispatch",
    runId: "99",
    actor: "alice",
    repository: {
      id: 1,
      owner: "octo",
      repo: "repo",
      fullName: "octo/repo",
      defaultBranch: "main",
    },
    payload: {},
    isPullRequestTarget: false,
    ...(workflowRun ? { workflowRun: { id: 50, headSha: RUN_HEAD, pullRequestNumbers: [] } } : {}),
  };
}

function pullSnapshot(): PullRequestSnapshot {
  return {
    kind: "pull_request",
    number: 7,
    title: "PR fixture",
    body: "Data only",
    author: "alice",
    baseSha: PR_BASE,
    baseRef: "main",
    baseRepository: "octo/repo",
    baseRepositoryId: 1,
    headSha: PR_HEAD,
    headRef: "feature",
    headRepository: "octo/repo",
    headRepositoryId: 1,
    draft: false,
    isFork: false,
    changedFiles: [],
    diffTruncated: false,
    comments: [],
  };
}

const workspaces: PreparedWorkspace[] = [];
let getRef: ReturnType<typeof vi.fn<() => Promise<{ data: { object: { sha: string } } }>>>;
let client: GitHubClient;

beforeEach(() => {
  vi.stubEnv("GITHUB_WORKSPACE", process.cwd());
  getRef = vi.fn(() => Promise.resolve({ data: { object: { sha: ADVANCED_BRANCH_HEAD } } }));
  client = { rest: { git: { getRef } } } as unknown as GitHubClient;
  mocks.materializeRepositoryAtSha.mockImplementation(
    async (_client: GitHubClient, _owner: string, _repo: string, sha: string, root: string) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/revision.txt"), `materialized:${sha}\n`);
    },
  );
});

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(disposeWorkspace));
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function prepare(
  context: GitHubContext,
  options: {
    snapshot?: PullRequestSnapshot;
    baseBranch?: string;
  } = {},
): Promise<PreparedWorkspace> {
  // This unit test isolates immutable source selection after admission. The
  // Controller tests separately show that a no-PR workflow_run is untrusted.
  const trustedRead = evaluatePolicy({
    context: pullRequestContext(),
    operation: "review",
    allowWrite: false,
    permissions: permissions(true),
    requestedAccess: "read",
  });
  expect(trustedRead.trust).toBe("trusted-read");
  const workspace = await prepareWorkspace({
    client,
    context,
    inputs: inputs({ isolation: "docker" }),
    policy: trustedRead,
    signal: new AbortController().signal,
    ...options,
  });
  workspaces.push(workspace);
  return workspace;
}

async function expectMaterializedRevision(workspace: PreparedWorkspace, sha: string) {
  expect(mocks.materializeRepositoryAtSha).toHaveBeenCalledOnce();
  expect(mocks.materializeRepositoryAtSha).toHaveBeenCalledWith(
    client,
    "octo",
    "repo",
    sha,
    join(workspace.tempRoot, "source"),
  );
  expect(workspace.boundWriteSha).toBe(sha);
  expect(workspace.snapshot?.sourceRoot).toBe(join(workspace.tempRoot, "source"));
  expect(workspace.snapshot?.workerRoot).toBe(workspace.agentWorkspace);
  expect(workspace.snapshot?.baseline.has("src/revision.txt")).toBe(true);
  expect(await readFile(join(workspace.agentWorkspace, "src/revision.txt"), "utf8")).toBe(
    `materialized:${sha}\n`,
  );
  if (workspace.snapshot === undefined) throw new Error("Expected a real workspace snapshot");
  expect(await inspectWorkspaceChanges(workspace.snapshot)).toEqual({
    added: [],
    modified: [],
    deleted: [],
    all: [],
  });
}

describe("Controller workspace immutable source selection (simulated repository transport)", () => {
  it("materializes the no-PR workflow run head instead of resolving its advanced base branch", async () => {
    const workspace = await prepare(automationContext(true), { baseBranch: "main" });

    await expectMaterializedRevision(workspace, RUN_HEAD);
    expect(getRef).not.toHaveBeenCalled();
  });

  it("prioritizes a resolved PR head over the workflow run head and base branch", async () => {
    const workspace = await prepare(automationContext(true), {
      snapshot: pullSnapshot(),
      baseBranch: "main",
    });

    await expectMaterializedRevision(workspace, PR_HEAD);
    expect(getRef).not.toHaveBeenCalled();
  });

  it.each(["repository task", "Issue task"] as const)(
    "resolves the configured base branch for a normal %s without a workflow revision",
    async (kind) => {
      const context: GitHubContext =
        kind === "repository task"
          ? automationContext()
          : {
              ...automationContext(),
              kind: "entity",
              rawEventName: "issues",
              eventName: "issues",
              entityNumber: 7,
              isPullRequest: false,
            };
      const workspace = await prepare(context, { baseBranch: "release" });

      await expectMaterializedRevision(workspace, ADVANCED_BRANCH_HEAD);
      expect(getRef).toHaveBeenCalledExactlyOnceWith({
        owner: "octo",
        repo: "repo",
        ref: "heads/release",
      });
      expect(getRef.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.materializeRepositoryAtSha.mock.invocationCallOrder[0] ?? 0,
      );
    },
  );

  it("keeps the immutable source separate from the worker and removes both on disposal", async () => {
    const workspace = await prepare(automationContext(true), { baseBranch: "main" });
    await expectMaterializedRevision(workspace, RUN_HEAD);
    await writeFile(join(workspace.agentWorkspace, "src/revision.txt"), "worker delta\n");
    expect(await readFile(join(workspace.tempRoot, "source/src/revision.txt"), "utf8")).toBe(
      `materialized:${RUN_HEAD}\n`,
    );
    if (workspace.snapshot === undefined) throw new Error("Expected a real workspace snapshot");
    expect(await inspectWorkspaceChanges(workspace.snapshot)).toMatchObject({
      modified: ["src/revision.txt"],
    });
    await disposeWorkspace(workspace);
    await expect(stat(workspace.tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
