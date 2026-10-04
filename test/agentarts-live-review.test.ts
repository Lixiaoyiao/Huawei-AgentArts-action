import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertLiveReviewOptions,
  BUDGET_CONFIRMATION,
  evaluateFixtureOracle,
  evaluateReviewCase,
  loadReviewSuite,
  parseLiveReviewArguments,
  runLiveReviewSuite,
  type LiveReviewOptions,
  type ReviewFixture,
  type ReviewSuite,
} from "../src/agentarts/live-review.js";
import { reviewTaskSchema, workspaceDigest, type ReviewTask } from "../src/agentarts/protocol.js";
import { parseDshOutput } from "../src/dsh/schema.js";

// Every HTTP/provider result below is an explicit offline fixture. No model key is read.
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    expect(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`)).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
});

async function options(overrides: Partial<LiveReviewOptions> = {}): Promise<LiveReviewOptions> {
  const directory = await mkdtemp(join(tmpdir(), "agentarts-live-review-test-"));
  directories.push(directory);
  return {
    mode: "simulation",
    execute: true,
    runtimeOrigin: "http://127.0.0.1:8080",
    maxCases: 4,
    timeoutMs: 30_000,
    maxModelRequestsPerCase: 4,
    maxOutputTokens: 4096,
    outputDirectory: directory,
    ...overrides,
  };
}

function fixtureOutput(fixture: ReviewFixture) {
  return {
    protocolVersion: 1,
    operation: "review",
    state: "final",
    summary: "Explicit offline response fixture, not real model quality evidence.",
    findings:
      fixture.kind === "clean"
        ? []
        : [
            {
              title:
                fixture.oracle === "exclusive-upper-bound"
                  ? "Reject the index equal to length"
                  : "Require every configured role",
              body:
                fixture.oracle === "exclusive-upper-bound"
                  ? "index === length is outside the valid interval; inBounds(3, 3) incorrectly returns true."
                  : "The change from every to some admits userRoles=['reader'] when requiredRoles=['reader','owner']; all required roles must be present.",
              evidence:
                fixture.oracle === "exclusive-upper-bound"
                  ? "3 <= 3 accepts index === length; the required exclusive upper bound rejects it."
                  : "some returns true on reader before checking the missing owner role, whereas every rejects the partial authorization.",
              category: fixture.oracle === "exclusive-upper-bound" ? "correctness" : "security",
              severity: "high",
              confidence: 0.99,
              path: fixture.path,
              line: 2,
              side: "RIGHT",
            },
          ],
  };
}

const fixturePolicy = {
  kind: "deterministic-fixture" as const,
  provider: "deepseek" as const,
  model: "deepseek-v4-pro",
  upstreamOrigin: "http://offline-model-fixture.invalid",
  requestLimit: 4,
  maxOutputTokens: 4096,
};

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required offline test value was absent");
  return value;
}

function transport(
  suite: ReviewSuite,
  settings: {
    policy?: unknown;
    transform?: (
      reply: Record<string, unknown>,
      task: ReviewTask,
      fixture: ReviewFixture,
    ) => unknown;
    status?: number;
    contentType?: string;
    rawBody?: string;
  } = {},
) {
  let invocations = 0;
  const tasks: ReviewTask[] = [];
  const fetcher = vi.fn<typeof fetch>((input, init) => {
    const url =
      input instanceof URL
        ? input
        : typeof input === "string"
          ? new URL(input)
          : new URL(input.url);
    expect(url.origin).toBe("http://127.0.0.1:8080");
    expect(init?.redirect).toBe("error");
    if (url.pathname === "/ping") {
      expect(init?.method).toBe("GET");
      return Promise.resolve(
        Response.json({
          status: "Healthy",
          modelPolicy: Object.hasOwn(settings, "policy") ? settings.policy : fixturePolicy,
        }),
      );
    }
    expect(url.pathname).toBe("/invocations");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(typeof init?.body).toBe("string");
    const task = reviewTaskSchema.parse(JSON.parse(init?.body as string) as unknown);
    tasks.push(task);
    const fixture = suite.cases[invocations++];
    expect(fixture).toBeDefined();
    if (fixture === undefined) throw new Error("No offline case remains");
    expect(task.binding.repository).toBe("agentarts-fixtures/review-v1");
    expect(task.files).toHaveLength(1);
    expect(task.files[0]?.content).toBe(fixture.head);
    expect(task.instructions).not.toContain(fixture.successCriteria);
    expect(JSON.stringify(task.context)).not.toContain("counterexamples");
    const reply = {
      schemaVersion: 1,
      taskId: task.taskId,
      binding: task.binding,
      workspaceDigest: workspaceDigest(task.files),
      dshVersion: "0.2.0-rc.2",
      output: fixtureOutput(fixture),
      durationMs: 12,
      toolReceipts: [
        {
          schemaVersion: 1,
          callId: "offline-read",
          id: "workspace.read",
          runtimeName: "read",
          provider: "builtin",
          counted: true,
          ok: true,
          completed: true,
          durationMs: 5,
        },
      ],
      modelExecution: { ...fixturePolicy, requestCount: 2 },
    };
    if (settings.rawBody !== undefined)
      return Promise.resolve(
        new Response(settings.rawBody, {
          status: settings.status ?? 200,
          headers: { "content-type": settings.contentType ?? "application/json" },
        }),
      );
    return Promise.resolve(
      Response.json(settings.transform?.(reply, task, fixture) ?? reply, {
        status: settings.status ?? 200,
      }),
    );
  });
  return { fetcher, tasks, invocations: () => invocations };
}

describe("fixed PR review cases and independent business oracle", () => {
  it("has exactly two real defects and two correct changes with versioned immutable source", async () => {
    const suite = await loadReviewSuite();
    expect(suite.suiteVersion).toBe("pr-review-boundaries-v1");
    expect(suite.cases.map((fixture) => fixture.kind)).toEqual([
      "defect",
      "defect",
      "clean",
      "clean",
    ]);
    for (const fixture of suite.cases) {
      expect(evaluateFixtureOracle(fixture).every((check) => check.passed)).toBe(true);
      expect(
        evaluateReviewCase(
          fixture,
          parseDshOutput(JSON.stringify(fixtureOutput(fixture)), "review"),
        ).verdict,
      ).toBe("passed");
    }
  });

  it("detects falsified frozen observations independently", async () => {
    const fixture = required((await loadReviewSuite()).cases[0]);
    const altered = {
      ...fixture,
      counterexamples: fixture.counterexamples.map((example) => ({
        ...example,
        observed: !example.observed,
      })),
    };
    expect(evaluateFixtureOracle(altered).some((check) => !check.passed)).toBe(true);
  });

  it("rejects source outside the audited oracle without executing its code", async () => {
    const fixture = required((await loadReviewSuite()).cases[0]);
    expect(() =>
      evaluateFixtureOracle({ ...fixture, head: `${fixture.head}process.exit(9);\n` }),
    ).toThrow("audited bounds oracle");
  });

  it("rejects source/diff disagreement and criteria pointing to unchanged lines", async () => {
    const fixture = required((await loadReviewSuite()).cases[0]);
    expect(
      evaluateFixtureOracle({
        ...fixture,
        patch: fixture.patch.replace("<= length", "< length"),
      }).some((check) => !check.passed),
    ).toBe(true);
    expect(
      evaluateFixtureOracle({ ...fixture, expectedLines: [1] }).some((check) => !check.passed),
    ).toBe(true);
  });

  it("rejects a missed defect, wrong location, unsupported or unrelated evidence", async () => {
    const fixture = required((await loadReviewSuite()).cases[0]);
    const baseline = fixtureOutput(fixture);
    for (const findings of [
      [],
      baseline.findings.map((finding) => ({ ...finding, line: 99 })),
      baseline.findings.map((finding) => ({
        ...finding,
        evidence: "Looks bad",
        body: "Possibly wrong",
        suggestion: undefined,
      })),
    ]) {
      const output = parseDshOutput(JSON.stringify({ ...baseline, findings }), "review");
      expect(evaluateReviewCase(fixture, output).verdict).toBe("failed");
    }
  });

  it("counts clean high-precision false positives without treating style advice as defects", async () => {
    const suite = await loadReviewSuite();
    const clean = required(suite.cases[2]);
    const defect = fixtureOutput(required(suite.cases[0]));
    expect(
      evaluateReviewCase(clean, parseDshOutput(JSON.stringify(defect), "review")).verdict,
    ).toBe("failed");
    const style = {
      ...defect,
      findings: defect.findings.map((finding) => ({
        ...finding,
        category: "maintainability",
        severity: "low",
      })),
    };
    expect(evaluateReviewCase(clean, parseDshOutput(JSON.stringify(style), "review")).verdict).toBe(
      "passed",
    );
  });
});

describe("metered execution gates and honest modes", () => {
  it("selects one failed fixed case without rerunning the other paid cases", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await runLiveReviewSuite(
      await loadReviewSuite(),
      await options({ execute: false, maxCases: 1, caseIds: ["roles-clean"] }),
      { fetchImplementation: fetcher },
    );
    expect(result.plan.cases.map((item) => item.id)).toEqual(["roles-clean"]);
    expect(result.plan.maximumRuntimeInvocations).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      parseLiveReviewArguments(["--case-ids", "roles-clean", "--max-cases", "1"]).caseIds,
    ).toEqual(["roles-clean"]);
  });

  it.each([
    { caseIds: ["unknown-case"] },
    { caseIds: ["roles-clean", "roles-clean"] },
    { caseIds: [""] },
    { caseIds: ["roles-clean", "bounds-clean"] },
  ])("rejects invalid case selection $caseIds before HTTP", async ({ caseIds }) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      runLiveReviewSuite(await loadReviewSuite(), await options({ caseIds, maxCases: 1 }), {
        fetchImplementation: fetcher,
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("defaults to dry-run and exports cloud tasks without any credential read or HTTP", async () => {
    const suite = await loadReviewSuite();
    const fetcher = vi.fn<typeof fetch>();
    const opts = await options({
      execute: false,
      mode: "cloud",
      cloud: {
        origin: "https://gateway.example.invalid",
        runtimeName: "pinned-review",
        endpoint: "release-v1",
      },
    });
    const result = await runLiveReviewSuite(suite, opts, { fetchImplementation: fetcher });
    expect(result.status).toBe("dry-run");
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.plan.cases).toHaveLength(4);
    expect(reviewTaskSchema.parse(result.plan.cases[0]?.taskTemplate).files).toHaveLength(1);
    expect(result.plan.actualCost).toBe("unknown");
    expect(result.plan.dollarBudgetIsHardCap).toBe(false);
  });

  it.each([undefined, "yes", "APPROVED"])(
    "refuses absent or wrong metered approval %s before HTTP",
    async (confirmation) => {
      const opts = await options({
        mode: "local-real-model",
        budgetUsd: 1,
        ...(confirmation === undefined ? {} : { confirmBudget: confirmation }),
        imageDigest: `sha256:${"a".repeat(64)}`,
        sourceCommit: "b".repeat(40),
      });
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        runLiveReviewSuite(await loadReviewSuite(), opts, { fetchImplementation: fetcher }),
      ).rejects.toThrow("budget confirmation");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 0, -1, Infinity, NaN])(
    "requires a positive explicit budget value %s",
    async (budget) => {
      const opts = await options({
        mode: "local-real-model",
        confirmBudget: BUDGET_CONFIRMATION,
        ...(budget === undefined ? {} : { budgetUsd: budget }),
        imageDigest: `sha256:${"a".repeat(64)}`,
        sourceCommit: "b".repeat(40),
      });
      expect(() => assertLiveReviewOptions(opts)).toThrow("budget confirmation");
    },
  );

  it("requires production provenance and refuses unverified cloud execution", async () => {
    const opts = await options({
      mode: "local-real-model",
      confirmBudget: BUDGET_CONFIRMATION,
      budgetUsd: 1,
    });
    expect(() => assertLiveReviewOptions(opts)).toThrow("image digest");
    expect(() =>
      assertLiveReviewOptions({
        ...opts,
        mode: "cloud",
        cloud: {
          origin: "https://gateway.example.invalid",
          runtimeName: "pinned-review",
          endpoint: "release-v1",
        },
      }),
    ).toThrow("templates only");
  });

  it.each([
    "https://127.0.0.1:8080",
    "http://localhost:8080",
    "http://evil.example/",
    "http://127.0.0.1:8080/path",
    "http://user:password@127.0.0.1:8080",
    "http://127.0.0.1:8080/?endpoint=Latest",
  ])("refuses unsafe local origin %s", async (origin) => {
    const opts = await options({ runtimeOrigin: origin });
    expect(() => assertLiveReviewOptions(opts)).toThrow("loopback");
  });

  it.each([
    { maxCases: 0 },
    { maxCases: 5 },
    { timeoutMs: 999 },
    { timeoutMs: 600001 },
    { maxModelRequestsPerCase: 0 },
    { maxModelRequestsPerCase: 33 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 8193 },
  ])("refuses invalid batch/request/time/token limits %j", async (overrides) => {
    const opts = await options(overrides);
    expect(() => assertLiveReviewOptions(opts)).toThrow();
  });

  it("CLI execute needs explicit case/time/request/token approvals and rejects duplicate or unknown options", () => {
    expect(parseLiveReviewArguments([]).execute).toBe(false);
    expect(() => parseLiveReviewArguments(["--mode", "local-real-model", "--execute"])).toThrow(
      "explicit",
    );
    expect(() => parseLiveReviewArguments(["--api-key", "unused"])).toThrow("Unknown");
    expect(() => parseLiveReviewArguments(["--max-cases", "2", "--max-cases", "4"])).toThrow(
      "duplicate",
    );
    expect(() => parseLiveReviewArguments(["--dry-run", "--execute"])).toThrow("conflicting");
    expect(() => parseLiveReviewArguments(["--execute", "--dry-run"])).toThrow("dry-run");
  });
});

describe("offline production HTTP contract, evidence and stop behavior", () => {
  it("validates all four simulated results and writes separate redacted evaluation and Demo records", async () => {
    const suite = await loadReviewSuite();
    const opts = await options();
    const http = transport(suite);
    const result = await runLiveReviewSuite(suite, opts, { fetchImplementation: http.fetcher });
    expect(result.status).toBe("passed");
    expect(http.invocations()).toBe(4);
    expect(new Set(http.tasks.map((task) => task.taskId)).size).toBe(4);
    for (const record of result.records) {
      expect(record.status).toBe("passed");
      const evidence = JSON.parse(await readFile(required(record.evidencePath), "utf8")) as Record<
        string,
        unknown
      >;
      const demo = JSON.parse(await readFile(required(record.demoPath), "utf8")) as Record<
        string,
        unknown
      >;
      expect(evidence.rawResult).toBeDefined();
      expect(evidence.humanReviewRequired).toBe(true);
      expect(evidence.needsHumanReview).toBe(true);
      expect(evidence.manualVerdict).toBe("not-reviewed");
      expect(demo.mode).toBe("local");
      expect(demo.modelEvidence).toEqual({
        kind: "deterministic-fixture",
        provider: "deepseek",
        model: "deepseek-v4-pro",
      });
      expect(demo).not.toHaveProperty("rawResult");
      expect(demo).not.toHaveProperty("evaluation");
    }
    expect(result).toHaveProperty("summaryPath");
    expect(result).toHaveProperty("plan.cases.0.acceptanceTemplate.manualVerdict", "not-reviewed");
  });

  it.each([
    { ...fixturePolicy, kind: "live-provider" },
    { ...fixturePolicy, kind: "unverified" },
    { ...fixturePolicy, requestLimit: 5 },
    { ...fixturePolicy, maxOutputTokens: 8192 },
    undefined,
  ])("rejects unsafe or unverified supervisor policy before any paid POST %j", async (policy) => {
    const suite = await loadReviewSuite();
    const http = transport(suite, { policy: policy ?? null });
    await expect(
      runLiveReviewSuite(suite, await options(), { fetchImplementation: http.fetcher }),
    ).rejects.toThrow();
    expect(http.invocations()).toBe(0);
    expect(http.fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a noncanonical live-provider preflight without contacting the provider", async () => {
    const suite = await loadReviewSuite();
    const http = transport(suite, {
      policy: {
        ...fixturePolicy,
        kind: "live-provider",
        upstreamOrigin: "https://impersonator.invalid",
      },
    });
    const opts = await options({
      mode: "local-real-model",
      confirmBudget: BUDGET_CONFIRMATION,
      budgetUsd: 1,
      imageDigest: `sha256:${"a".repeat(64)}`,
      sourceCommit: "b".repeat(40),
    });
    await expect(
      runLiveReviewSuite(suite, opts, { fetchImplementation: http.fetcher }),
    ).rejects.toThrow("canonical");
    expect(http.invocations()).toBe(0);
  });

  it.each([
    (reply: Record<string, unknown>) => ({
      ...reply,
      taskId: "11111111-1111-4111-8111-111111111111",
    }),
    (reply: Record<string, unknown>) => ({ ...reply, workspaceDigest: "a".repeat(64) }),
    (reply: Record<string, unknown>) => ({
      ...reply,
      output: {
        ...(reply.output as Record<string, unknown>),
        changePlan: [{ path: "src/bounds.ts", content: "changed", reason: "untrusted write" }],
      },
    }),
    (reply: Record<string, unknown>) => ({ ...reply, toolReceipts: [] }),
    (reply: Record<string, unknown>) => ({
      ...reply,
      modelExecution: { ...fixturePolicy, requestCount: 0 },
    }),
    (reply: Record<string, unknown>) => ({
      ...reply,
      modelExecution: { ...fixturePolicy, requestCount: 5 },
    }),
    (reply: Record<string, unknown>) => ({
      ...reply,
      modelExecution: { ...fixturePolicy, model: "changed-after-preflight", requestCount: 2 },
    }),
  ])(
    "fails closed, records the rejected raw result and does not retry or continue %s",
    async (transform) => {
      const suite = await loadReviewSuite();
      const http = transport(suite, { transform });
      const result = await runLiveReviewSuite(suite, await options(), {
        fetchImplementation: http.fetcher,
      });
      expect(result.status).toBe("failed");
      expect(http.invocations()).toBe(1);
      expect(result.records.map((record) => record.status)).toEqual([
        "failed",
        "not-run",
        "not-run",
        "not-run",
      ]);
      const evidence = JSON.parse(
        await readFile(required(required(result.records[0]).evidencePath), "utf8"),
      ) as Record<string, unknown>;
      expect(evidence.rawResult).not.toBeNull();
      expect(evidence.failureCode).toBe("BOUNDARY_OR_EVIDENCE_REJECTED");
    },
  );

  it("stops after business failure even if transport and protocol pass", async () => {
    const suite = await loadReviewSuite();
    const http = transport(suite, {
      transform: (reply) => ({
        ...reply,
        output: { ...(reply.output as Record<string, unknown>), findings: [] },
      }),
    });
    const result = await runLiveReviewSuite(suite, await options(), {
      fetchImplementation: http.fetcher,
    });
    expect(result.records[0]?.failureCode).toBe("BUSINESS_RUBRIC_FAILED");
    expect(http.invocations()).toBe(1);
  });

  it.each([504, 409, 500])("does not retry HTTP %s or run remaining cases", async (status) => {
    const suite = await loadReviewSuite();
    const http = transport(suite, { status });
    const result = await runLiveReviewSuite(suite, await options(), {
      fetchImplementation: http.fetcher,
    });
    expect(http.invocations()).toBe(1);
    expect(result.records[0]?.failureCode).toBe(
      status === 504 ? "TASK_TIMEOUT" : "BOUNDARY_OR_EVIDENCE_REJECTED",
    );
  });

  it("bounds response bytes, rejects a false test claim, and redacts token-shaped text in rejected raw evidence", async () => {
    const suite = await loadReviewSuite();
    const oversized = transport(suite, { rawBody: "x".repeat(2 * 1024 * 1024 + 1) });
    const result = await runLiveReviewSuite(suite, await options(), {
      fetchImplementation: oversized.fetcher,
    });
    expect(result.status).toBe("failed");
    expect(oversized.invocations()).toBe(1);
    const token = `sk-${"x".repeat(30)}`;
    const untrusted = transport(suite, {
      transform: (reply) => ({
        ...reply,
        output: {
          ...(reply.output as Record<string, unknown>),
          summary: token,
          verification: [{ command: "npm test", status: "passed", output: "claim" }],
        },
      }),
    });
    const rejected = await runLiveReviewSuite(suite, await options(), {
      fetchImplementation: untrusted.fetcher,
    });
    expect(rejected.status).toBe("failed");
    expect(
      await readFile(required(required(rejected.records[0]).evidencePath), "utf8"),
    ).not.toContain(token);
  });

  it("never starts an invocation after cancellation and never emits a GitHub request", async () => {
    const suite = await loadReviewSuite();
    const cancelled = new AbortController();
    cancelled.abort();
    const http = transport(suite);
    const result = await runLiveReviewSuite(suite, await options({ signal: cancelled.signal }), {
      fetchImplementation: http.fetcher,
    });
    expect(result.status).toBe("failed");
    expect(http.invocations()).toBe(0);
    expect(result.records.every((record) => record.status === "not-run")).toBe(true);
  });
});
