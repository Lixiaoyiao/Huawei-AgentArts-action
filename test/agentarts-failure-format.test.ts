import { describe, expect, it } from "vitest";
import { agentArtsFailureDiagnosticsSchema } from "../src/agentarts/failure-diagnostics.js";
import {
  formatRuntimeFailure,
  runtimeFailureDiagnostics,
} from "../src/agentarts/failure-format.js";
import { invokeReview } from "../src/agentarts/client.js";
import type { ReviewTask } from "../src/agentarts/protocol.js";

const task: ReviewTask = {
  schemaVersion: 1,
  taskId: "123e4567-e89b-42d3-a456-426614174000",
  binding: {
    repository: "fixtures/failure",
    pullNumber: 1,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
  },
  trust: "untrusted",
  tools: [],
  files: [],
  timeoutMs: 1000,
  instructions: "Fixture",
  context: {},
};
const diagnostics = agentArtsFailureDiagnosticsSchema.parse({
  schemaVersion: 1,
  failureCode: "DSH_PROCESS_FAILED",
  phase: "process",
  provider: {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    upstreamOrigin: "https://api.deepseek.com",
    requestCount: 2,
    requestLimit: 6,
    maxOutputTokens: 2048,
    attempts: [
      { sequence: 1, outcome: "http-error", status: 400 },
      { sequence: 2, outcome: "http-error", status: 400 },
    ],
  },
  process: { exitCode: 1, signal: null },
});
describe("safe Runtime failure facts", () => {
  it("shows a validated boundary classification without parsing worker text", () => {
    expect(
      formatRuntimeFailure(500, { ...diagnostics, boundaryCode: "result_schema_invalid" }),
    ).toContain("at process (result_schema_invalid)");
    expect(
      runtimeFailureDiagnostics(
        {
          error: {
            taskId: task.taskId,
            diagnostics: { ...diagnostics, boundaryCode: "raw-secret-text" },
          },
        },
        task.taskId,
      ),
    ).toBeUndefined();
  });
  it("binds failure diagnostics to this invocation while ignoring raw messages", () => {
    const raw = {
      error: { taskId: task.taskId, message: "sensitive-fixture-never-display", diagnostics },
    };
    const parsed = runtimeFailureDiagnostics(raw, task.taskId);
    expect(formatRuntimeFailure(500, parsed)).toContain(
      "DSH_PROCESS_FAILED at process; provider attempts 2/6 (HTTP 400)",
    );
    expect(formatRuntimeFailure(500, parsed)).not.toContain("sensitive-fixture");
    expect(runtimeFailureDiagnostics(raw, "another-task")).toBeUndefined();
  });
  it("rejects message-bearing or forged metadata instead of echoing it", () => {
    const parsed = runtimeFailureDiagnostics(
      {
        error: {
          taskId: task.taskId,
          diagnostics: { ...diagnostics, stderr: "hidden-raw-worker-output" },
        },
      },
      task.taskId,
    );
    expect(parsed).toBeUndefined();
    expect(formatRuntimeFailure(500, parsed)).not.toContain("hidden-raw-worker-output");
  });
  it("uses typed facts on HTTP failure without publishing, echoing a body or retrying", async () => {
    let invocations = 0;
    let stops = 0;
    const fetchImplementation: typeof fetch = (url) => {
      const path = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (path.includes("sessions-stop")) {
        stops += 1;
        return Promise.resolve(new Response(null));
      }
      invocations += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: { taskId: task.taskId, diagnostics, message: "untrusted-body-secret" },
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      );
    };
    await expect(
      invokeReview(
        {
          origin: "https://runtime.fixture.invalid",
          runtimeName: "fixture-runtime",
          endpoint: "v1",
          apiKey: "fake-key",
        },
        task,
        { fetchImplementation },
      ),
    ).rejects.toThrow("provider attempts 2/6 (HTTP 400)");
    expect(invocations).toBe(1);
    expect(stops).toBe(1);
  });
});
