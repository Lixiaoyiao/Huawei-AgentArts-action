import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Payload from "../src/github/payload.js";
import type * as Clients from "../src/github/client.js";
import type * as Fetches from "../src/github/fetch.js";
import type * as Checks from "../src/github/checks.js";
import type * as Permissions from "../src/github/permissions.js";
import type * as Repository from "../src/github/repository.js";
import type * as Commands from "../src/security/argv.js";
import type { GitHubClient } from "../src/github/client.js";
import type { IssueSnapshot, PullRequestSnapshot } from "../src/github/fetch.js";
import type { AuthorizedRun } from "../src/orchestration/prepare.js";
import type { PreparedWorkspace } from "../src/orchestration/workspace.js";
import type { PreparedExecution } from "../src/orchestration/execution.js";
import type { DshRuntime } from "../src/dsh/runtime.js";
import type { ControlledActionInputs } from "../src/inputs.js";
import { runAction } from "../src/orchestrator.js";
import { AgentArtsFullEngine } from "../src/agentarts/engine-full.js";
import { createAgentArtsServer } from "../src/agentarts/server.js";
import { runAgentArtsRuntimeTask } from "../src/agentarts/worker.js";
import type { RuntimeTask, RuntimeTaskReply } from "../src/agentarts/runtime-task-protocol.js";
import { executeBoundedDshProcess } from "../src/dsh/process.js";
import {
  prepareInsecureFullRuntimeFixture,
  translateFullRuntimeFixtureProfile,
} from "./fixtures/agentarts-full-sandbox.js";
import { sendMessagesSse, messageToolResults } from "./fixtures/messages-sse.mjs";
import { issueContentFingerprint } from "../src/github/issue-identity.js";
import { inputs, permissions } from "./helpers.js";

// Simulated external transports/process: real Action, HTTP server, Runtime profiles,
// manifests, file delta installation, original independent validation and finalizers.
// Neither real DSH/model nor Docker/GitHub execution is claimed by this suite.
const mocks = vi.hoisted(() => ({
  payload: vi.fn(),
  client: vi.fn(),
  snapshot: vi.fn(),
  permissions: vi.fn(),
  materialize: vi.fn(),
  command: vi.fn(),
  checks: vi.fn(),
}));
vi.mock("../src/github/payload.js", async (original) => ({
  ...(await original<typeof Payload>()),
  readEventPayload: mocks.payload,
}));
vi.mock("../src/github/client.js", async (original) => ({
  ...(await original<typeof Clients>()),
  createGitHubClient: mocks.client,
}));
vi.mock("../src/github/fetch.js", async (original) => ({
  ...(await original<typeof Fetches>()),
  fetchEntitySnapshot: mocks.snapshot,
  fetchPullRequestSnapshot: mocks.snapshot,
}));
vi.mock("../src/github/checks.js", async (original) => ({
  ...(await original<typeof Checks>()),
  fetchCiEvidence: mocks.checks,
}));
vi.mock("../src/github/permissions.js", async (original) => ({
  ...(await original<typeof Permissions>()),
  checkActorPermissions: mocks.permissions,
}));
vi.mock("../src/github/repository.js", async (original) => ({
  ...(await original<typeof Repository>()),
  materializeRepositoryAtSha: mocks.materialize,
}));
vi.mock("../src/security/argv.js", async (original) => ({
  ...(await original<typeof Commands>()),
  runCommand: mocks.command,
}));

const HEAD = "a".repeat(40),
  BASE = "b".repeat(40),
  COMMIT = "c".repeat(40);
const SOURCE = "export const answer = 0;\n",
  REPAIRED = "export const answer = 42;\n";
const ANNOTATED = REPAIRED + "// contract-preserving annotation\n";
const GITHUB = "synthetic-controller-token",
  MODEL = "synthetic-model-token",
  RUNTIME = "synthetic-runtime-token";
const servers: Server[] = [];
let state: { head: string; refs: Map<string, string>; labels: string[] };
let github: ReturnType<typeof fakeGitHub>;
let snapshot: PullRequestSnapshot | IssueSnapshot;
let admitted: RuntimeTask[];
let processCall: number;
let nextContent: (turn: number) => string;
let baselineContent: string;
let mutateReply: ((reply: RuntimeTaskReply) => RuntimeTaskReply) | undefined;
let abortAfterProcess: AbortController | undefined;
let loopback: string;
let actualProcessMode: boolean;
let upstreamUrl: string | undefined;
let configuredOutput: ((task: RuntimeTask, turn: number) => RuntimeTaskReply["output"]) | undefined;

function pr(): PullRequestSnapshot {
  return {
    kind: "pull_request",
    number: 7,
    title: "Fix answer",
    body: "untrusted",
    author: "alice",
    baseSha: BASE,
    baseRef: "main",
    baseRepository: "octo/repo",
    baseRepositoryId: 1,
    headSha: HEAD,
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
function issue(): IssueSnapshot {
  return {
    kind: "issue",
    number: 7,
    title: "Implement answer",
    body: "untrusted",
    author: "alice",
    state: "open",
    updatedAt: "2026-10-04T00:00:00Z",
    contentFingerprint: issueContentFingerprint({
      number: 7,
      title: "Implement answer",
      body: "untrusted",
      authorId: 1,
    }),
    comments: [],
  };
}
function payload(isIssue = false) {
  return {
    action: "created",
    repository: {
      id: 1,
      name: "repo",
      full_name: "octo/repo",
      default_branch: "main",
      owner: { login: "octo" },
    },
    sender: { login: "alice", type: "User" },
    ...(isIssue
      ? {
          issue: {
            number: 7,
            state: "open",
            title: "Implement answer",
            body: "untrusted",
            user: { login: "alice", type: "User" },
          },
        }
      : {
          pull_request: {
            number: 7,
            draft: false,
            head: { sha: HEAD, ref: "feature", repo: { id: 1, full_name: "octo/repo" } },
            base: { sha: BASE, ref: "main", repo: { id: 1, full_name: "octo/repo" } },
          },
        }),
  };
}
function fakeGitHub() {
  const listComments = vi.fn(),
    listReviewComments = vi.fn(),
    listPulls = vi.fn(() => Promise.resolve({ data: [] }));
  const createBlob = vi.fn((input: { content: string; encoding: string }) =>
    Promise.resolve({
      data: { sha: "d".repeat(40), content: input.content },
    }),
  );
  const createTree = vi.fn(() => Promise.resolve({ data: { sha: "e".repeat(40) } }));
  const createCommit = vi.fn(() => Promise.resolve({ data: { sha: COMMIT } }));
  const updateRef = vi.fn((input: { ref: string; sha: string }) => {
    state.refs.set(input.ref.replace(/^heads\//u, ""), input.sha);
    if (input.ref === "heads/feature") state.head = input.sha;
    return Promise.resolve({ data: {} });
  });
  const createRef = vi.fn((input: { ref: string; sha: string }) => {
    state.refs.set(input.ref.replace(/^refs\/heads\//u, ""), input.sha);
    return Promise.resolve({ data: {} });
  });
  const getRef = vi.fn((input: { ref: string }) => {
    const sha = state.refs.get(input.ref.replace(/^heads\//u, ""));
    if (!sha) throw Object.assign(new Error("No synthetic branch"), { status: 404 });
    return Promise.resolve({ data: { object: { sha } } });
  });
  const createPull = vi.fn(() =>
    Promise.resolve({
      data: { number: 9, html_url: "https://github.com/octo/repo/pull/9" },
    }),
  );
  const createComment = vi.fn(() => Promise.resolve({ data: { id: 11 } }));
  const setLabels = vi.fn((input: { labels: string[] }) => {
    state.labels = [...input.labels];
    return Promise.resolve({ data: [...state.labels] });
  });
  const pullGet = vi.fn(() =>
    Promise.resolve({
      data: {
        number: 7,
        title: "Fix answer",
        body: "untrusted",
        maintainer_can_modify: false,
        state: "open",
        head: { sha: state.head, ref: "feature", repo: { id: 1, full_name: "octo/repo" } },
        base: { sha: BASE, ref: "main", repo: { id: 1, full_name: "octo/repo" } },
      },
    }),
  );
  const value = {
    paginate: vi.fn(() => Promise.resolve([])),
    rest: {
      pulls: { get: pullGet, list: listPulls, create: createPull, listReviewComments },
      issues: {
        get: vi.fn(() =>
          Promise.resolve({
            data: {
              number: 7,
              title: "Implement answer",
              body: "untrusted",
              state: "open",
              updated_at: "2026-10-04T00:00:00Z",
              user: { id: 1, login: "alice" },
              labels: [...state.labels],
              assignees: [],
              ...(snapshot.kind === "pull_request" ? { pull_request: {} } : {}),
            },
          }),
        ),
        listComments,
        createComment,
        setLabels,
      },
      repos: { get: vi.fn(() => Promise.resolve({ data: { id: 1 } })) },
      git: {
        getRef,
        createRef,
        updateRef,
        createBlob,
        createTree,
        createCommit,
        getCommit: vi.fn((input: { commit_sha: string }) =>
          Promise.resolve({
            data: {
              sha: input.commit_sha,
              tree: { sha: "f".repeat(40) },
              message: "bound commit",
              parents: [],
            },
          }),
        ),
      },
    },
  };
  return {
    value: value as unknown as GitHubClient,
    createBlob,
    createTree,
    createCommit,
    updateRef,
    createRef,
    createPull,
    createComment,
    setLabels,
    pullGet,
  };
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  return `http://127.0.0.1:${String(address.port)}`;
}
async function startRuntime() {
  return await listen(
    createAgentArtsServer({
      environment: { ...process.env, API_KEY: RUNTIME, DEEPSEEK_API_KEY: MODEL },
      logEvent: () => undefined,
      runRuntimeTask: async (task, options) => {
        admitted.push(task);
        let workspace = "";
        const reply = await runAgentArtsRuntimeTask(task, {
          ...options,
          ...(upstreamUrl === undefined
            ? {}
            : {
                environment: {
                  ...options.environment,
                  DEEPSEEK_BASE_URL: upstreamUrl,
                  AGENTARTS_MODEL_EVIDENCE: "deterministic-fixture",
                },
              }),
          allowInsecureTestOnly: true,
          prepareSandbox: actualProcessMode
            ? prepareInsecureFullRuntimeFixture
            : (input) => {
                workspace = input.workspacePath;
                return Promise.resolve({
                  workerProxyBaseUrl: input.modelProxy.workerBaseUrl,
                  networkIsolated: false,
                  prepareProcess: (spec) => spec,
                  close: () => Promise.resolve(),
                });
              },
          executeProcess: async (spec, limits) => {
            processCall += 1;
            if (actualProcessMode) {
              await translateFullRuntimeFixtureProfile(
                join(spec.env.DSH_HOME ?? "", "profiles/github-action"),
              );
              return await executeBoundedDshProcess(spec, limits);
            }
            await writeFile(join(workspace, "src/answer.ts"), nextContent(processCall));
            abortAfterProcess?.abort();
            return {
              stdout: JSON.stringify(
                configuredOutput?.(task, processCall) ?? {
                  protocolVersion: 1,
                  operation: task.operation,
                  state: "final",
                  summary:
                    "Simulated DSH process fixture; actual bytes changed, Controller must validate.",
                  findings: [],
                },
              ),
              stderr: "",
              exitCode: 0,
              signal: null,
            };
          },
        });
        return mutateReply?.(reply) ?? reply;
      },
    }),
  );
}
function options(
  operation: "fix" | "implement" | "task" | "review" | "diagnose",
  maxTurns = 2,
  overrides: Partial<ControlledActionInputs> = {},
) {
  return {
    inputs: inputs({
      command: operation,
      allowWrite: true,
      taskAccess: "write",
      deepseekApiKey: MODEL,
      githubToken: GITHUB,
      progressComment: false,
      permissionProfile: "custom",
      allowedTools: ["workspace.read", "workspace.edit"],
      testCommands: [["node", "tests/check.mjs"]],
      maxTurns,
      timeoutMinutes: 5,
      ...overrides,
    }),
    createEngine:
      (run: AuthorizedRun, workspace: PreparedWorkspace, execution: PreparedExecution) =>
      (runtime: DshRuntime) =>
        new AgentArtsFullEngine(
          {
            origin: "https://fixture.example.test",
            runtimeName: "full-runtime",
            endpoint: "v1",
            apiKey: RUNTIME,
          },
          run.policy.trust,
          {
            repository: "octo/repo",
            baseSha: run.snapshot?.kind === "pull_request" ? BASE : HEAD,
            headSha: HEAD,
            entity:
              run.snapshot === undefined
                ? { kind: "repository" }
                : { kind: run.snapshot.kind, number: run.snapshot.number },
            ref: run.snapshot?.kind === "pull_request" ? "feature" : "main",
          },
          [GITHUB, MODEL],
          {
            workspace,
            runtime,
            mode: "controlled",
            operationIdentity: execution.operationIdentity,
            allowInsecureRuntimeTestOnly: true,
            extensionPlan: execution.extensions,
            validationCommands: [["node", "tests/check.mjs"]],
            fetchImplementation: async (input, init) => {
              const url = new URL(
                input instanceof Request ? input.url : input instanceof URL ? input.href : input,
              );
              const path = url.pathname.endsWith("sessions-stop")
                ? "/sessions-stop"
                : "/invocations";
              return fetch(new URL(path, loopback), init);
            },
          },
        ),
  };
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("GITHUB_EVENT_NAME", "pull_request");
  vi.stubEnv("GITHUB_ACTOR", "alice");
  vi.stubEnv("GITHUB_RUN_ID", "99");
  vi.stubEnv("GITHUB_REPOSITORY", "octo/repo");
  vi.stubEnv("GITHUB_EVENT_PATH", "synthetic-event.json");
  vi.stubEnv("GITHUB_WORKSPACE", process.cwd());
  vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
  state = {
    head: HEAD,
    labels: [],
    refs: new Map([
      ["feature", HEAD],
      ["main", HEAD],
    ]),
  };
  github = fakeGitHub();
  snapshot = pr();
  admitted = [];
  processCall = 0;
  nextContent = () => REPAIRED;
  baselineContent = SOURCE;
  mutateReply = undefined;
  abortAfterProcess = undefined;
  configuredOutput = undefined;
  actualProcessMode = false;
  upstreamUrl = undefined;
  mocks.payload.mockResolvedValue(payload());
  mocks.client.mockReturnValue(github.value);
  mocks.snapshot.mockImplementation(() => Promise.resolve(snapshot));
  mocks.permissions.mockResolvedValue(permissions(true));
  mocks.checks.mockResolvedValue({ headSha: HEAD, jobs: [], checkRuns: [], truncated: false });
  mocks.materialize.mockImplementation(
    async (_client: unknown, _owner: string, _repo: string, _sha: string, root: string) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/answer.ts"), baselineContent);
      await mkdir(join(root, "tests"));
      await writeFile(
        join(root, "tests/check.mjs"),
        "import { answer } from '../src/answer.ts'; if (answer !== 42) throw new Error('Contract answer must equal 42');\n",
      );
    },
  );
  mocks.command.mockImplementation(async (input: Parameters<typeof Commands.runCommand>[0]) => {
    if (input.command !== "docker")
      throw new Error("Only the explicit simulated Docker process is admitted");
    if (input.args[0] === "rm")
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, outputTruncated: false };
    // The original validator copied the candidate into a private validation root.
    const actual = await readFile(join(input.cwd, "src/answer.ts"), "utf8");
    expect(JSON.stringify(input.env)).not.toContain(GITHUB);
    expect(JSON.stringify(input.env)).not.toContain(MODEL);
    const accepted = actual === REPAIRED || actual === ANNOTATED;
    return {
      exitCode: accepted ? 0 : 1,
      stdout: "Independent expected answer is 42",
      stderr: accepted ? "" : "Candidate violates independently frozen answer=42",
      timedOut: false,
      outputTruncated: false,
    };
  });
  loopback = await startRuntime();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("Full Action write chain (simulated DSH/Docker/GitHub; actual HTTP and file transfer)", () => {
  it.each(["fix", "task"] as const)(
    "imports an actual %s edit then original validation and GitHub commit/update",
    async (operation) => {
      const outcome = await runAction(options(operation));
      expect(outcome.conclusion, outcome.error?.message).toBe("success");
      expect(github.createCommit).toHaveBeenCalledOnce();
      expect(github.updateRef).toHaveBeenCalledOnce();
      expect(github.createBlob).toHaveBeenCalledWith(
        expect.objectContaining({ content: Buffer.from(REPAIRED).toString("base64") }),
      );
      expect(
        admitted[0]?.workspace.files.find((file) => file.path === "src/answer.ts")?.content,
      ).toBe(SOURCE);
      expect(JSON.stringify(admitted)).not.toContain(GITHUB);
      expect(JSON.stringify(admitted)).not.toContain(MODEL);
    },
  );
  it("imports Issue implement bytes and uses the original branch/PR publisher", async () => {
    snapshot = issue();
    vi.stubEnv("GITHUB_EVENT_NAME", "issues");
    mocks.payload.mockResolvedValue(payload(true));
    const outcome = await runAction(options("implement"));
    expect(outcome.conclusion, outcome.error?.message).toBe("success");
    expect(github.createCommit).toHaveBeenCalledOnce();
    expect(github.createRef).toHaveBeenCalledOnce();
    expect(github.createPull).toHaveBeenCalledOnce();
    expect(github.updateRef).not.toHaveBeenCalled();
    expect(admitted[0]?.binding.entity).toEqual({ kind: "issue", number: 7 });
  });
  it("repairs after real candidate bytes fail the independent original validator, retaining the first baseline", async () => {
    nextContent = (turn) => (turn === 1 ? "export const answer = 41;\n" : REPAIRED);
    const outcome = await runAction(options("fix", 3));
    expect(outcome.conclusion, outcome.error?.message).toBe("success");
    expect(processCall).toBe(2);
    expect(admitted.map((task) => task.binding.revision)).toEqual([0, 1]);
    expect(
      admitted[1]?.workspace.files.find((file) => file.path === "src/answer.ts")?.content,
    ).toBe("export const answer = 41;\n");
    expect(JSON.stringify(admitted[1]?.context)).toContain("validation");
    expect(github.createCommit).toHaveBeenCalledOnce();
  });
  it("does not publish when all returned edits fail independent validation", async () => {
    nextContent = (turn) => `export const answer = ${String(turn)};\n`;
    const outcome = await runAction(options("fix", 2));
    expect(outcome.conclusion).toBe("failure");
    expect(processCall).toBe(2);
    expect(outcome.error?.code).toBe("VALIDATION_FAILED");
    expect(github.createCommit).not.toHaveBeenCalled();
    expect(github.updateRef).not.toHaveBeenCalled();
  });
  it("rejects a mismatched captured delta before validation or Git objects", async () => {
    mutateReply = (reply) => ({
      ...reply,
      delta: reply.delta === null ? null : { ...reply.delta, resultDigest: "f".repeat(64) },
    });
    const outcome = await runAction(options("fix"));
    expect(outcome.conclusion).toBe("failure");
    expect(processCall).toBe(1);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(github.createCommit).not.toHaveBeenCalled();
  });
  it.each([
    "grant",
    "operation-identity",
    "ref",
    "revision",
    "base",
    "head",
    "receipt-name",
    "insecure-workspace",
  ])("independently rejects forged %s evidence before any Git object creation", async (field) => {
    mutateReply = (reply) => {
      const changed = structuredClone(reply);
      if (field === "receipt-name")
        changed.toolReceipts = [
          {
            schemaVersion: 1,
            callId: "forged-read-as-edit",
            id: "workspace.read",
            runtimeName: "edit",
            provider: "builtin",
            counted: true,
            completed: true,
            ok: true,
            durationMs: 1,
          },
        ];
      else if (field === "insecure-workspace")
        changed.sandboxEvidence.workspaceAccess = "read-only";
      else {
        if (field === "grant") changed.binding.grantDigest = "f".repeat(64);
        if (field === "operation-identity") changed.binding.operationIdentity = "unbound operation";
        if (field === "ref") changed.binding.ref = "other-branch";
        if (field === "revision") changed.binding.revision += 1;
        if (field === "base") changed.binding.baseSha = "f".repeat(40);
        if (field === "head") changed.binding.headSha = "f".repeat(40);
        if (changed.delta !== null) changed.delta.binding = changed.binding;
      }
      return changed;
    };
    const outcome = await runAction(options("fix"));
    expect(outcome.conclusion).toBe("failure");
    expect(processCall).toBe(1);
    expect(admitted).toHaveLength(1);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(github.createCommit).not.toHaveBeenCalled();
    expect(github.updateRef).not.toHaveBeenCalled();
  });
  it("rejects a head advanced before the original write finalizer", async () => {
    mutateReply = (reply) => {
      state.head = "d".repeat(40);
      return reply;
    };
    const outcome = await runAction(options("fix"));
    expect(outcome.conclusion).toBe("failure");
    expect(processCall).toBe(1);
    expect(outcome.error?.message).toContain("identity changed");
    expect(github.createCommit).not.toHaveBeenCalled();
    expect(github.updateRef).not.toHaveBeenCalled();
  });
  it("stops cancelled work without accepting a late Runtime delta", async () => {
    const cancellation = new AbortController();
    abortAfterProcess = cancellation;
    const outcome = await runAction({ ...options("fix"), signal: cancellation.signal });
    expect(outcome.conclusion).toBe("failure");
    expect(processCall).toBe(1);
    expect(github.createCommit).not.toHaveBeenCalled();
    expect(github.updateRef).not.toHaveBeenCalled();
  });

  it("returns a Controller command request to the original ToolProvider and continues the same repair loop", async () => {
    configuredOutput = (task, turn) => ({
      protocolVersion: 1,
      operation: task.operation,
      state: turn === 1 ? "needs_tool" : "final",
      summary: "Offline Controller command flow",
      findings: [],
      ...(turn !== 1 ? {} : { toolRequest: { id: "command.contract", input: {} } }),
    });
    const outcome = await runAction(
      options("fix", 3, {
        allowedTools: ["workspace.read", "workspace.edit", "command.contract"],
        toolConfig: {
          schemaVersion: 1,
          commands: [
            {
              name: "contract",
              description: "Run frozen contract check",
              argv: ["node", "tests/check.mjs"],
              timeoutMinutes: 1,
              maxOutputBytes: 4096,
              maxCalls: 1,
              network: "none",
              workspaceAccess: "read",
            },
          ],
        },
      }),
    );
    expect(outcome.conclusion, outcome.error?.message).toBe("success");
    expect(outcome.agent?.toolCalls).toBe(1);
    expect(processCall).toBe(2);
    expect(admitted[0]?.toolCatalog.map((tool) => tool.id)).toContain("command.contract");
    expect(JSON.stringify(admitted[1]?.context)).toContain("command.contract");
    expect(github.createCommit).toHaveBeenCalledOnce();
  });

  it("validates typed GitHub input and schedules its mutation through original independent write validation", async () => {
    baselineContent = REPAIRED;
    nextContent = () => ANNOTATED;
    configuredOutput = (task, turn) => ({
      protocolVersion: 1,
      operation: task.operation,
      state: turn === 1 ? "needs_tool" : "final",
      summary: "Offline deferred label fixture",
      findings: [],
      ...(turn !== 1
        ? {}
        : { toolRequest: { id: "github.issue.labels.set", input: { labels: ["accepted"] } } }),
    });
    const outcome = await runAction(
      options("task", 3, {
        allowedTools: ["workspace.read", "workspace.edit", "github.issue.labels.set"],
      }),
    );
    expect(outcome.conclusion, outcome.error?.message).toBe("success");
    expect(github.setLabels).toHaveBeenCalledOnce();
    expect(github.createCommit).toHaveBeenCalledOnce();
    expect(mocks.command.mock.invocationCallOrder[0]).toBeLessThan(
      github.setLabels.mock.invocationCallOrder[0] ?? 0,
    );
    expect(admitted[0]?.toolCatalog.map((tool) => tool.id)).toEqual(["github.issue.labels.set"]);
  });

  it("rejects model-defined GitHub targets or command argv before Controller invocation", async () => {
    baselineContent = REPAIRED;
    nextContent = () => ANNOTATED;
    configuredOutput = (task) => ({
      protocolVersion: 1,
      operation: task.operation,
      state: "needs_tool",
      summary: "Invalid target fixture",
      findings: [],
      toolRequest: {
        id: "github.issue.labels.set",
        input: { labels: ["accepted"], repository: "other/repo" },
      },
    });
    const outcome = await runAction(
      options("task", 2, {
        allowedTools: ["workspace.read", "workspace.edit", "github.issue.labels.set"],
      }),
    );
    expect(outcome.conclusion).toBe("failure");
    expect(processCall).toBe(1);
    expect(github.setLabels).not.toHaveBeenCalled();
    expect(github.createCommit).not.toHaveBeenCalled();
  });

  it("returns a blocked Runtime state to the original blocked callback without write validation or publication", async () => {
    configuredOutput = (task) => ({
      protocolVersion: 1,
      operation: task.operation,
      state: "blocked",
      summary: "Requires unavailable specification; no repair claimed",
      findings: [],
    });
    const outcome = await runAction(options("fix"));
    expect(outcome.conclusion).toBe("neutral");
    expect(processCall).toBe(1);
    expect(github.createCommit).not.toHaveBeenCalled();
    expect(github.updateRef).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
  });
  it.each(["review", "diagnose", "task"] as const)(
    "routes read-only %s through the same full engine and original answer/review callback",
    async (operation) => {
      nextContent = () => SOURCE;
      configuredOutput = (task) => ({
        protocolVersion: 1,
        operation: task.operation,
        state: "final",
        summary: "Read-only fixture answer",
        findings: [],
        ...(operation === "diagnose"
          ? { diagnosis: "The frozen log has no executable repair instruction." }
          : {}),
      });
      const outcome = await runAction(
        options(operation, 2, { taskAccess: "read", allowedTools: ["workspace.read"] }),
      );
      expect(outcome.conclusion, outcome.error?.message).toBe("success");
      expect(admitted[0]?.requestedAccess).toBe("read");
      expect(github.createCommit).not.toHaveBeenCalled();
      expect(github.updateRef).not.toHaveBeenCalled();
      expect(mocks.command).not.toHaveBeenCalled();
      expect(github.createComment).toHaveBeenCalled();
    },
  );

  it("runs the real pinned DSH read/edit process through Action and HTTP, then original independent validation and mock GitHub write", async () => {
    const requests: Record<string, unknown>[] = [];
    actualProcessMode = true;
    upstreamUrl = await listen(
      createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.once("end", () => {
          requests.push(
            JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          );
          expect(request.headers.authorization).toBe(`Bearer ${MODEL}`);
          const phase = requests.length;
          if (phase <= 2)
            sendMessagesSse(
              response,
              {
                tool_calls: [
                  {
                    index: 0,
                    id: phase === 1 ? "main-real-read" : "main-real-edit",
                    type: "function",
                    function: {
                      name: phase === 1 ? "read" : "edit",
                      arguments: JSON.stringify(
                        phase === 1
                          ? { file_path: "src/answer.ts" }
                          : {
                              file_path: "src/answer.ts",
                              old_string: "answer = 0",
                              new_string: "answer = 42",
                            },
                      ),
                    },
                  },
                ],
              },
              "tool_calls",
            );
          else
            sendMessagesSse(
              response,
              {
                content: JSON.stringify({
                  protocolVersion: 1,
                  operation: "fix",
                  state: "final",
                  summary:
                    "Actual pinned DSH called read and edit with deterministic model responses; independent Controller validation remains required.",
                  findings: [],
                }),
              },
              "stop",
            );
        });
      }),
    );
    const outcome = await runAction(options("fix", 2));
    expect(outcome.conclusion, outcome.error?.message).toBe("success");
    expect(processCall).toBe(1);
    expect(requests).toHaveLength(3);
    expect(messageToolResults(requests[2] ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool_use_id: "main-real-read", is_error: false }),
        expect.objectContaining({ tool_use_id: "main-real-edit", is_error: false }),
      ]),
    );
    expect(outcome.agent?.dshToolReceipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "workspace.read", runtimeName: "read", ok: true }),
        expect.objectContaining({ id: "workspace.edit", runtimeName: "edit", ok: true }),
      ]),
    );
    expect(github.createCommit).toHaveBeenCalledOnce();
    expect(github.updateRef).toHaveBeenCalledOnce();
    expect(github.createBlob).toHaveBeenCalledWith(
      expect.objectContaining({ content: Buffer.from(REPAIRED).toString("base64") }),
    );
    expect(JSON.stringify(requests)).not.toContain(MODEL);
    expect(JSON.stringify(requests)).not.toContain(GITHUB);
    expect(outcome.agent?.isolation.processIsolated).toBe(false); // Explicit host fixture, not production namespace evidence.
  }, 60_000);
});
