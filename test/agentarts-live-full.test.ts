import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DEFAULT_VALIDATION_IMAGE,
  acceptanceScript,
  fullFixtures,
  parseLiveFullArguments,
  runLiveFullSuite,
  type LiveFullOptions,
} from "../src/agentarts/live-full.js";
import { loadReviewSuite } from "../src/agentarts/live-review.js";
import {
  runtimeTaskDigest,
  runtimeTaskSchema,
  type RuntimeTaskReply,
} from "../src/agentarts/runtime-task-protocol.js";
import {
  materializeWorkspaceManifest,
  createWorkspaceDelta,
} from "../src/agentarts/workspace-transfer.js";
import type { runValidationCommandsInDocker } from "../src/write/validate.js";

// Explicit simulated HTTP/model and Docker results. These are CLI boundary tests,
// not DeepSeek, production isolation, Docker, Huawei or GitHub acceptance evidence.
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "agentarts-live-full-test-"));
  temporary.push(path);
  return path;
}
async function options(overrides: Partial<LiveFullOptions> = {}): Promise<LiveFullOptions> {
  return {
    mode: "simulation",
    execute: true,
    runtimeOrigin: "http://127.0.0.1:8080",
    maxCases: 7,
    timeoutMs: 30_000,
    maxModelRequestsPerCase: 4,
    maxOutputTokens: 4096,
    validationImage: DEFAULT_VALIDATION_IMAGE,
    outputDirectory: await directory(),
    ...overrides,
  };
}
const policy = {
  kind: "deterministic-fixture",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  upstreamOrigin: "http://fixture.invalid",
  requestLimit: 4,
  maxOutputTokens: 4096,
} as const;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
async function simulated(
  settings: {
    failValidation?: boolean;
    invalidPolicy?: boolean;
    invalidExecution?: boolean;
    oversizedCandidate?: boolean;
  } = {},
) {
  const suite = await loadReviewSuite();
  let invocations = 0;
  const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
    if ((url instanceof Request ? url.url : url instanceof URL ? url.href : url).endsWith("/ping"))
      return json({
        status: "Healthy",
        modelPolicy: settings.invalidPolicy ? { ...policy, kind: "live-provider" } : policy,
      });
    invocations += 1;
    if (typeof init?.body !== "string") throw new Error("Expected JSON task body");
    const task = runtimeTaskSchema.parse(JSON.parse(init.body) as unknown);
    const source = task.workspace.files.find((file) => file.path.startsWith("src/"));
    if (source === undefined) throw new Error("Source missing from complete transfer");
    const fixture = suite.cases.find(
      (item) =>
        item.path === source.path &&
        (task.operation === "review" && source.content.includes("belowUpperBound")
          ? item.id === "bounds-clean"
          : item.kind === "defect"),
    );
    if (fixture === undefined) throw new Error("Fixture missing");
    const remote = join(await directory(), "runtime-workspace");
    await materializeWorkspaceManifest(task.workspace, remote);
    if (task.requestedAccess === "write")
      await writeFile(
        join(remote, fixture.path),
        fixture.base + (settings.oversizedCandidate ? `//${"a".repeat(256 * 1024)}\n` : ""),
      );
    const output = {
      protocolVersion: 1,
      operation: task.operation,
      state: "final",
      summary: "Explicit simulated response",
      findings:
        task.operation === "review" && fixture.kind === "defect"
          ? [
              {
                title: "Reject the index equal to length",
                body: "index === length is out of bounds; 3 equals length 3.",
                evidence: "index=3,length=3 wrongly passes the inclusive upper bound.",
                category: "correctness",
                severity: "high",
                confidence: 0.99,
                path: fixture.path,
                line: 2,
                side: "RIGHT",
              },
            ]
          : [],
      ...(task.operation === "diagnose"
        ? { diagnosis: "index === length is out of bounds; 3 equals length 3." }
        : {}),
    };
    const reply: RuntimeTaskReply = {
      schemaVersion: 3,
      taskId: task.taskId,
      operation: task.operation,
      binding: task.binding,
      taskDigest: runtimeTaskDigest(task),
      workspaceDigest: task.workspace.digest,
      output,
      durationMs: 10,
      ...(task.mode === "native" ? { observedTools: ["read", "edit"] } : {}),
      toolReceipts: [
        {
          schemaVersion: 1,
          callId: "simulated-read",
          id: "workspace.read",
          runtimeName: "read",
          provider: "builtin",
          ok: true,
          completed: true,
          counted: true,
          durationMs: 1,
        },
      ],
      delta:
        task.requestedAccess === "write"
          ? await createWorkspaceDelta(task.workspace, remote)
          : null,
      extensionAudit: z
        .json()
        .parse(JSON.parse(JSON.stringify(task.extensions?.audit ?? {})) as unknown),
      modelExecution: { ...policy, requestCount: settings.invalidExecution ? 0 : 2 },
      sandboxEvidence: {
        backend: "insecure-test",
        credentialMediated: true,
        processIsolated: false,
        networkIsolated: false,
        workspaceAccess: task.requestedAccess === "write" ? "read-write" : "read-only",
      },
    };
    return json(reply);
  });
  const validationRunner = vi.fn<typeof runValidationCommandsInDocker>(
    async (cwd, commands, image) => {
      expect(image).toBe(DEFAULT_VALIDATION_IMAGE);
      const script = await readFile(join(cwd, "tests/acceptance.mjs"), "utf8");
      expect(script).toContain("assert.equal");
      expect(commands).toEqual([["node", "tests/acceptance.mjs"]]);
      const file = script.includes("inBounds") ? "src/bounds.ts" : "src/access.ts";
      expect(await readFile(join(cwd, file), "utf8")).toBe(
        suite.cases.find((fixture) => fixture.path === file)?.base,
      );
      return [
        {
          argv: commands[0] ?? [],
          result: {
            exitCode: settings.failValidation ? 1 : 0,
            timedOut: false,
            outputTruncated: false,
            stdout: "Simulated Docker process result",
            stderr: "",
          },
        },
      ];
    },
  );
  return {
    suite,
    fetchImplementation,
    validationRunner,
    invocations: () => invocations,
    allowInsecureRuntimeTestOnly: true as const,
  };
}
describe("Full v3 verification CLI (simulated transports)", () => {
  it("plans all five operations, native write and a clean review without requests or creating output", async () => {
    const deps = await simulated();
    const opts = await options({ execute: false });
    const result = await runLiveFullSuite(deps.suite, opts, deps);
    expect(result.status).toBe("dry-run");
    expect(result.plan.cases).toHaveLength(7);
    expect(new Set(result.plan.cases.map((item) => item.operation)).size).toBe(5);
    expect(result.plan.cases.find((item) => item.id === "review-clean")?.access).toBe("read");
    expect(deps.fetchImplementation).not.toHaveBeenCalled();
    expect(result.plan.maximumTurnsPerCase).toBe(1);
  });
  it("round-trips real local file bytes through v3 HTTP/delta, original loop and simulated Docker acceptance for every case", async () => {
    const deps = await simulated(),
      opts = await options();
    const result = await runLiveFullSuite(deps.suite, opts, deps);
    const failed = result.records.find((record) => record.status === "failed");
    expect(
      result.status,
      failed?.evidencePath === undefined
        ? "missing evidence"
        : await readFile(failed.evidencePath, "utf8"),
    ).toBe("passed");
    expect(deps.invocations()).toBe(7);
    expect(deps.validationRunner).toHaveBeenCalledTimes(4);
    for (const record of result.records) {
      if (record.evidencePath === undefined || record.demoPath === undefined)
        throw new Error("Record missing");
      const evidence = JSON.parse(await readFile(record.evidencePath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(evidence.mode).toBe("simulation");
      expect(evidence.manualVerdict).toBe("not-reviewed");
      expect(evidence.githubPublication).toBe("not-attempted");
      expect(evidence.cloudVerification).toBe("not-performed");
      expect(evidence.modelExecution).toMatchObject({
        kind: "deterministic-fixture",
        requestCount: 2,
      });
      if (["fix", "implement", "task"].includes(String(evidence.operation))) {
        const pointer = z
          .object({ path: z.string(), maxBytes: z.literal(256 * 1024) })
          .parse(evidence.candidateEvidence);
        const bytes = await readFile(pointer.path);
        expect(bytes.byteLength).toBeLessThanOrEqual(pointer.maxBytes);
        const artifact = z
          .object({
            original: z.object({ path: z.string(), sha256: z.string(), content: z.string() }),
            candidate: z.object({
              path: z.string(),
              sha256: z.string(),
              encoding: z.enum(["utf8", "base64"]),
              content: z.string(),
            }),
            delta: z.object({
              inputDigest: z.string(),
              changes: z.array(
                z.object({ kind: z.string(), file: z.object({ sha256: z.string() }).optional() }),
              ),
            }),
          })
          .parse(JSON.parse(bytes.toString("utf8")) as unknown);
        const originalBytes = Buffer.from(artifact.original.content),
          candidateBytes = Buffer.from(
            artifact.candidate.content,
            artifact.candidate.encoding === "utf8" ? "utf8" : "base64",
          );
        expect(createHash("sha256").update(originalBytes).digest("hex")).toBe(
          artifact.original.sha256,
        );
        expect(createHash("sha256").update(candidateBytes).digest("hex")).toBe(
          artifact.candidate.sha256,
        );
        expect(artifact.candidate.sha256).toBe(evidence.candidateSha);
        expect(
          artifact.delta.changes.find((change) => change.kind === "modified")?.file?.sha256,
        ).toBe(artifact.candidate.sha256);
        expect(artifact.delta.inputDigest).toBe(evidence.workspaceDigest);
        expect(candidateBytes.toString("utf8")).toBe(
          deps.suite.cases.find((fixture) => fixture.path === artifact.candidate.path)?.base,
        );
      }
      const demo = JSON.parse(await readFile(record.demoPath, "utf8")) as Record<string, unknown>;
      expect(demo.mode).toBe("simulation");
      expect(demo.result).not.toHaveProperty("githubUrl");
      const exported = join(opts.outputDirectory, `exported-${record.caseId}`);
      await promisify(execFile)(process.execPath, [
        "agentarts/demo/export.mjs",
        "--record",
        record.demoPath,
        "--out",
        exported,
      ]);
      expect(
        (await readFile(join(exported, "run-record.json"))).equals(await readFile(record.demoPath)),
      ).toBe(true);
    }
  });
  it("stops after independent candidate tests fail and keeps failure evidence", async () => {
    const deps = await simulated({ failValidation: true });
    const result = await runLiveFullSuite(
      deps.suite,
      await options({ maxCases: 2, caseIds: ["fix-bounds", "review-clean"] }),
      deps,
    );
    expect(result.status).toBe("failed");
    expect(deps.invocations()).toBe(1);
    expect(result.records.map((record) => record.status)).toEqual(["failed", "not-run"]);
    const first = result.records[0];
    if (first?.evidencePath === undefined) throw new Error("Missing failure evidence");
    expect(JSON.parse(await readFile(first.evidencePath, "utf8"))).toMatchObject({
      failureCode: "VALIDATION_FAILED",
      manualVerdict: "not-reviewed",
    });
  });
  it("rejects unapproved supervisor mode before any invocation", async () => {
    const deps = await simulated({ invalidPolicy: true });
    await expect(runLiveFullSuite(deps.suite, await options(), deps)).rejects.toThrow("preflight");
    expect(deps.invocations()).toBe(0);
  });
  it("refuses oversized candidate evidence explicitly before Docker and retains the omission reason", async () => {
    const deps = await simulated({ oversizedCandidate: true });
    const result = await runLiveFullSuite(
      deps.suite,
      await options({ maxCases: 1, caseIds: ["fix-bounds"] }),
      deps,
    );
    expect(result.status).toBe("failed");
    expect(deps.validationRunner).not.toHaveBeenCalled();
    const record = result.records[0];
    if (record?.evidencePath === undefined) throw new Error("Failure evidence missing");
    const evidence = JSON.parse(await readFile(record.evidencePath, "utf8")) as unknown;
    const parsed = z
      .object({
        candidateEvidence: z.object({ omittedReason: z.string() }),
        failureReason: z.string(),
      })
      .parse(evidence);
    expect(parsed.candidateEvidence.omittedReason).toBe(
      "candidate-export-rejected; case failed, no silent omission",
    );
    expect(parsed.failureReason).toContain("256 KiB");
  });
  it("rejects missing actual model calls before Docker/final acceptance", async () => {
    const deps = await simulated({ invalidExecution: true });
    const result = await runLiveFullSuite(
      deps.suite,
      await options({ maxCases: 1, caseIds: ["fix-bounds"] }),
      deps,
    );
    expect(result.status).toBe("failed");
    expect(deps.validationRunner).not.toHaveBeenCalled();
  });
  it("requires live budget approval and provenance, rejects remote origin and unknown cases without invocation", async () => {
    const deps = await simulated();
    await expect(
      runLiveFullSuite(deps.suite, await options({ mode: "local-real-model" }), deps),
    ).rejects.toThrow("budget");
    await expect(
      runLiveFullSuite(deps.suite, await options({ runtimeOrigin: "http://example.com" }), deps),
    ).rejects.toThrow("loopback");
    await expect(
      runLiveFullSuite(deps.suite, await options({ caseIds: ["invented"] }), deps),
    ).rejects.toThrow("Unknown full");
    expect(deps.fetchImplementation).not.toHaveBeenCalled();
  });
  it("parses pinned validation override and fixed-case selection, rejecting duplicate overrides", () => {
    expect(
      parseLiveFullArguments([
        "--dry-run",
        "--max-cases",
        "7",
        "--case-ids",
        "fix-bounds,review-clean",
        "--validation-image",
        DEFAULT_VALIDATION_IMAGE,
      ]),
    ).toMatchObject({
      execute: false,
      maxCases: 7,
      caseIds: ["fix-bounds", "review-clean"],
      validationImage: DEFAULT_VALIDATION_IMAGE,
    });
    expect(() =>
      parseLiveFullArguments([
        "--validation-image",
        DEFAULT_VALIDATION_IMAGE,
        "--validation-image",
        DEFAULT_VALIDATION_IMAGE,
      ]),
    ).toThrow("Duplicate");
  });
  it("retains frozen empty/boundary/negative/case-sensitive/all-role examples", async () => {
    const cases = fullFixtures(await loadReviewSuite());
    const bounds = cases[0],
      roles = cases[3];
    if (bounds === undefined || roles === undefined) throw new Error("Fixed cases missing");
    expect(acceptanceScript(bounds.fixture)).toContain('"index":-2');
    expect(acceptanceScript(bounds.fixture)).toContain('"length":0');
    expect(acceptanceScript(roles.fixture)).toContain('"Reader"');
    expect(acceptanceScript(roles.fixture)).toContain('"requiredRoles":[]');
  });
});
