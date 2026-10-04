import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentArtsServer, type RuntimeLogEvent } from "../src/agentarts/server.js";
import {
  digest,
  workspaceDigest,
  type ReviewTask,
  type RuntimeReply,
} from "../src/agentarts/protocol.js";
import { getAgentArtsFailureDiagnostics, runAgentArtsReview } from "../src/agentarts/worker.js";
import { DshAbortedError, DshProcessError } from "../src/dsh/errors.js";
import { executeBoundedDshProcess, type DshProcessSpec } from "../src/dsh/process.js";
import { messageToolResults, sendMessagesSse } from "./fixtures/messages-sse.mjs";

const temporary: string[] = [];
const servers: Server[] = [];
const realKey = "supervisor-model-key-do-not-expose";
const runtimeKey = "supervisor-runtime-api-key-do-not-expose";
const output = {
  protocolVersion: 1,
  operation: "review",
  state: "final",
  summary: "Checked the admitted change",
  findings: [],
};
const environment = {
  ...process.env,
  DEEPSEEK_API_KEY: realKey,
  API_KEY: runtimeKey,
  GITHUB_TOKEN: "controller-github-key-must-stay-out",
  CUSTOM_SECRET: "not-for-worker",
};

function task(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    binding: {
      repository: "owner/repository",
      pullNumber: 1,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    trust: "trusted-read",
    tools: ["workspace.read", "workspace.search"],
    timeoutMs: 20_000,
    instructions: "Review the code and return the strict review result.",
    context: { untrusted: true, diff: "+ return a / b" },
    files: [
      {
        path: "src/divide.ts",
        content: "export const divide = (a, b) => a / b;\n",
        sha256: digest("export const divide = (a, b) => a / b;\n"),
      },
    ],
    ...overrides,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentarts-worker-test-"));
  temporary.push(directory);
  return directory;
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP fixture address");
  return `http://127.0.0.1:${String(address.port)}`;
}

function successfulReply(admitted: ReviewTask): RuntimeReply {
  return {
    schemaVersion: 1,
    taskId: admitted.taskId,
    binding: admitted.binding,
    dshVersion: "0.2.0-rc.2",
    output,
    durationMs: 1,
    workspaceDigest: workspaceDigest(admitted.files),
    toolReceipts: [],
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 3 })),
  );
});

describe("AgentArts Runtime DSH worker boundaries", () => {
  it("ignores forged diagnostics attached to arbitrary errors", () => {
    expect(
      getAgentArtsFailureDiagnostics(
        Object.assign(new Error("untrusted"), {
          diagnostics: { failureCode: "DSH_PROCESS_FAILED", provider: { requestCount: 9 } },
        }),
      ),
    ).toBeUndefined();
  });

  it("reports rejected provider status and attempted requests on process failure without raw body or stderr", async () => {
    const raw = "DO_NOT_EXPOSE_PROVIDER_BODY_OR_STDERR";
    const baseUrl = await listen(
      createServer((_request, response) => {
        response
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: raw } }));
      }),
    );
    const directory = await temporaryDirectory();
    let failure: unknown;
    try {
      await runAgentArtsReview(task(), {
        environment: {
          ...environment,
          DEEPSEEK_BASE_URL: baseUrl,
          AGENTARTS_MAX_MODEL_REQUESTS: "6",
          AGENTARTS_MAX_OUTPUT_TOKENS: "2048",
        },
        temporaryDirectory: directory,
        allowInsecureTestOnly: true,
        executeProcess: async (spec) => {
          const response = await fetch(`${spec.env.DEEPSEEK_BASE_URL ?? ""}/v1/messages`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${spec.env.DEEPSEEK_API_KEY ?? ""}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "deepseek-v4-pro",
              max_tokens: 256000,
              thinking: { type: "enabled" },
              output_config: { effort: "high" },
              messages: [],
            }),
          });
          expect(response.status).toBe(400);
          await response.body?.cancel();
          return { stdout: "", stderr: raw, exitCode: 1, signal: null };
        },
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DshProcessError);
    const diagnostics = getAgentArtsFailureDiagnostics(failure);
    expect(diagnostics).toEqual({
      schemaVersion: 1,
      failureCode: "DSH_PROCESS_FAILED",
      phase: "process",
      provider: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        upstreamOrigin: baseUrl,
        requestCount: 1,
        requestLimit: 6,
        maxOutputTokens: 2048,
        attempts: [{ sequence: 1, outcome: "http-error", status: 400 }],
      },
      process: { exitCode: 1, signal: null },
    });
    for (const forbidden of [raw, realKey, runtimeKey, environment.GITHUB_TOKEN])
      expect(JSON.stringify(diagnostics)).not.toContain(forbidden);
    if (diagnostics === undefined) throw new Error("Expected trusted failure diagnostics");
    diagnostics.provider.requestCount = 6;
    expect(getAgentArtsFailureDiagnostics(failure)?.provider.requestCount).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps HTTP success separate from independently rejected DSH output", async () => {
    const baseUrl = await listen(
      createServer((_request, response) => response.writeHead(200).end("fixture stream")),
    );
    let failure: unknown;
    try {
      await runAgentArtsReview(task(), {
        environment: { ...environment, DEEPSEEK_BASE_URL: baseUrl },
        allowInsecureTestOnly: true,
        executeProcess: async (spec) => {
          const response = await fetch(`${spec.env.DEEPSEEK_BASE_URL ?? ""}/v1/messages`, {
            method: "POST",
            headers: { authorization: `Bearer ${spec.env.DEEPSEEK_API_KEY ?? ""}` },
            body: "{}",
          });
          await response.body?.cancel();
          return { stdout: "invalid model result", stderr: "", exitCode: 0, signal: null };
        },
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(getAgentArtsFailureDiagnostics(failure)).toMatchObject({
      failureCode: "DSH_MALFORMED_OUTPUT",
      phase: "output",
      provider: { requestCount: 1, attempts: [{ outcome: "http-success", status: 200 }] },
    });
  });

  it("classifies zero-call credential and cancellation failures without exposing captured output", async () => {
    for (const cancelled of [false, true]) {
      const cancellation = new AbortController();
      let failure: unknown;
      try {
        await runAgentArtsReview(task(), {
          environment,
          signal: cancellation.signal,
          allowInsecureTestOnly: true,
          executeProcess: () => {
            if (cancelled) cancellation.abort();
            return Promise.resolve({
              stdout: JSON.stringify({ ...output, summary: realKey }),
              stderr: "",
              exitCode: 0,
              signal: null,
            });
          },
        });
      } catch (error: unknown) {
        failure = error;
      }
      const diagnostics = getAgentArtsFailureDiagnostics(failure);
      expect(diagnostics).toMatchObject({
        failureCode: cancelled ? "DSH_ABORTED" : "DSH_CREDENTIAL_LEAK",
        provider: { requestCount: 0, attempts: [] },
      });
      expect(JSON.stringify(diagnostics)).not.toContain(realKey);
    }
  });

  it("fails closed on platforms without the production supervisor identity", async () => {
    if (process.platform === "linux" && process.getuid?.() === 0) return;
    const executeProcess = vi.fn();
    await expect(runAgentArtsReview(task(), { environment, executeProcess })).rejects.toThrow(
      "Linux root supervisor",
    );
    expect(executeProcess).not.toHaveBeenCalled();
  });

  it("rejects tampered context and untrusted workspace grants before spawning", async () => {
    const executeProcess = vi.fn();
    const admitted = task();
    await expect(
      runAgentArtsReview(
        { ...admitted, files: [{ ...admitted.files[0], content: "tampered" }] },
        { environment, executeProcess, allowInsecureTestOnly: true },
      ),
    ).rejects.toThrow();
    await expect(
      runAgentArtsReview(
        { ...admitted, trust: "untrusted" },
        { environment, executeProcess, allowInsecureTestOnly: true },
      ),
    ).rejects.toThrow();
    expect(executeProcess).not.toHaveBeenCalled();
  });

  it("whitelists child env, seals exact admitted context and cleans all run data", async () => {
    const directory = await temporaryDirectory();
    const admitted = task({ tools: ["workspace.read"] });
    const result = await runAgentArtsReview(admitted, {
      environment,
      temporaryDirectory: directory,
      allowInsecureTestOnly: true,
      executeProcess: async (spec) => {
        expect(JSON.stringify(spec.env)).not.toContain(realKey);
        expect(JSON.stringify(spec.env)).not.toContain(runtimeKey);
        expect(spec.env.GITHUB_TOKEN).toBeUndefined();
        expect(spec.env.CUSTOM_SECRET).toBeUndefined();
        expect(spec.env.DEEPSEEK_API_KEY).toBeTruthy();
        const dshHome = spec.env.DSH_HOME ?? "";
        const patch = await readFile(
          join(dshHome, "profiles", "github-action", "cordis.patch.yml"),
          "utf8",
        );
        expect(patch).toContain('"runtimeName": "read"');
        expect(patch).not.toContain('"runtimeName": "grep"');
        expect(patch).not.toContain('"runtimeName": "bash"');
        expect(spec.args[0]).toBe("--expose-internals");
        return { stdout: JSON.stringify(output), stderr: "", exitCode: 0, signal: null };
      },
    });
    expect(result.workspaceDigest).toBe(workspaceDigest(admitted.files));
    expect(result.binding).toEqual(admitted.binding);
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects unexpected workspace edits, model credential leaks and write/test claims", async () => {
    const directory = await temporaryDirectory();
    const admitted = task();
    await expect(
      runAgentArtsReview(admitted, {
        environment,
        temporaryDirectory: directory,
        allowInsecureTestOnly: true,
        executeProcess: async (spec) => {
          const path = join(spec.env.DSH_HOME ?? "", "..", "workspace", "src", "divide.ts");
          await chmod(path, 0o640);
          await writeFile(path, "changed");
          return { stdout: JSON.stringify(output), stderr: "", exitCode: 0, signal: null };
        },
      }),
    ).rejects.toThrow("workspace changed");
    await expect(
      runAgentArtsReview(task(), {
        environment,
        temporaryDirectory: directory,
        allowInsecureTestOnly: true,
        executeProcess: () =>
          Promise.resolve({
            stdout: JSON.stringify({ ...output, summary: realKey }),
            stderr: "",
            exitCode: 0,
            signal: null,
          }),
      }),
    ).rejects.toThrow("credential");
    await expect(
      runAgentArtsReview(task(), {
        environment,
        temporaryDirectory: directory,
        allowInsecureTestOnly: true,
        executeProcess: () =>
          Promise.resolve({
            stdout: JSON.stringify({
              ...output,
              verification: [{ command: "npm test", status: "passed" }],
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
          }),
      }),
    ).rejects.toThrow("claim workspace");
    await expect(
      runAgentArtsReview(task(), {
        environment,
        temporaryDirectory: directory,
        allowInsecureTestOnly: true,
        executeProcess: () =>
          Promise.resolve({
            stdout: JSON.stringify({ ...output, changePlan: [], verification: [] }),
            stderr: "",
            exitCode: 0,
            signal: null,
          }),
      }),
    ).resolves.toMatchObject({ output: { state: "final", changePlan: [], verification: [] } });
    expect(await readdir(directory)).toEqual([]);
  });

  it("marks untrusted reviews with no tools and honors cancellation", async () => {
    const directory = await temporaryDirectory();
    const cancellation = new AbortController();
    await expect(
      runAgentArtsReview(task({ trust: "untrusted", tools: [], files: [] }), {
        environment,
        signal: cancellation.signal,
        temporaryDirectory: directory,
        allowInsecureTestOnly: true,
        executeProcess: async (spec) => {
          const patch = await readFile(
            join(spec.env.DSH_HOME ?? "", "profiles", "github-action", "cordis.patch.yml"),
            "utf8",
          );
          expect(patch).toContain('"allowedRuntimeTools": []');
          cancellation.abort();
          return { stdout: JSON.stringify(output), stderr: "", exitCode: 0, signal: null };
        },
      }),
    ).rejects.toThrow("abort");
    expect(await readdir(directory)).toEqual([]);
  });

  it("boots real pinned DSH, calls an actual read tool and returns reconciled receipts through the model proxy", async () => {
    const requests: Record<string, unknown>[] = [];
    const headers: (string | undefined)[] = [];
    let processSpec: DshProcessSpec | undefined;
    const baseUrl = await listen(
      createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >;
          requests.push(body);
          headers.push(request.headers.authorization);
          if (requests.length === 1) {
            sendMessagesSse(
              response,
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "review-read",
                    type: "function",
                    function: {
                      name: "read",
                      arguments: JSON.stringify({ file_path: "src/divide.ts" }),
                    },
                  },
                ],
              },
              "tool_calls",
            );
          } else {
            sendMessagesSse(response, { content: JSON.stringify(output) }, "stop");
          }
        });
      }),
    );
    const directory = await temporaryDirectory();
    const result = await runAgentArtsReview(task({ timeoutMs: 60_000 }), {
      environment: {
        ...environment,
        DEEPSEEK_BASE_URL: baseUrl,
        AGENTARTS_MAX_OUTPUT_TOKENS: "2048",
      },
      temporaryDirectory: directory,
      allowInsecureTestOnly: true,
      executeProcess: async (spec, limits) => {
        processSpec = spec;
        return await executeBoundedDshProcess(spec, limits);
      },
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.max_tokens).toBe(2048);
      expect(request.thinking).toEqual({ type: "enabled" });
      expect(request.output_config).toEqual({ effort: "high" });
    }
    expect(headers).toEqual([`Bearer ${realKey}`, `Bearer ${realKey}`]);
    expect(JSON.stringify(requests)).not.toContain(realKey);
    expect(JSON.stringify(processSpec)).not.toContain(realKey);
    expect(messageToolResults(requests[1] ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool_use_id: "review-read", is_error: false }),
      ]),
    );
    expect(result.toolReceipts).toEqual([
      expect.objectContaining({
        id: "workspace.read",
        runtimeName: "read",
        completed: true,
        ok: true,
      }),
    ]);
    const tools = requests[0]?.tools as { name: string }[];
    expect(tools.map(({ name }) => name).sort()).toEqual(["glob", "grep", "read", "read_image"]);
    expect(await readdir(directory)).toEqual([]);
  }, 90_000);
});

describe("AgentArts Runtime HTTP lifecycle", () => {
  it("exposes health, refuses invalid tasks and prevents repeated admissions", async () => {
    const runReview = vi.fn((admitted: ReviewTask) => Promise.resolve(successfulReply(admitted)));
    const events: RuntimeLogEvent[] = [];
    const baseUrl = await listen(
      createAgentArtsServer({ environment, runReview, logEvent: (event) => events.push(event) }),
    );
    const health = (await (await fetch(`${baseUrl}/ping`)).json()) as {
      status: string;
      modelPolicy: unknown;
    };
    expect(health.status).toBe("Healthy");
    expect(health.modelPolicy).toMatchObject({
      kind: "unverified",
      provider: "deepseek",
      requestLimit: 12,
      maxOutputTokens: 4096,
    });
    expect(JSON.stringify(health)).not.toContain(realKey);
    expect((await fetch(`${baseUrl}/exec`, { method: "POST" })).status).toBe(404);
    expect(
      (
        await fetch(`${baseUrl}/invocations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
    const admitted = task();
    const send = (): Promise<Response> =>
      fetch(`${baseUrl}/invocations?endpoint=review-v1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(admitted),
      });
    expect((await send()).status).toBe(200);
    const duplicate = await send();
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: "DUPLICATE_TASK" } });
    expect(runReview).toHaveBeenCalledTimes(1);
    expect(events.map(({ event }) => event)).toEqual(["task.accepted", "task.completed"]);
    expect(events[1]).toMatchObject({
      taskId: admitted.taskId,
      repository: admitted.binding.repository,
      tools: [],
    });
    expect(JSON.stringify(events)).not.toContain(output.summary);
    expect(JSON.stringify(events)).not.toContain(realKey);
    expect(JSON.stringify(events)).not.toContain(runtimeKey);
  });

  it("admits only one worker and aborts work when the caller disconnects", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let stopped!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const runReview = vi.fn(async (_admitted: ReviewTask, options: { signal: AbortSignal }) => {
      started();
      return await new Promise<RuntimeReply>((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            stopped();
            reject(new DshAbortedError());
          },
          { once: true },
        );
      });
    });
    const baseUrl = await listen(createAgentArtsServer({ environment, runReview }));
    const connection = httpRequest(`${baseUrl}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    connection.on("error", () => undefined);
    connection.end(JSON.stringify(task()));
    await ready;
    const busy = await fetch(`${baseUrl}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(task()),
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "RUNTIME_BUSY" } });
    connection.destroy();
    await cancelled;
    expect(runReview).toHaveBeenCalledTimes(1);
  });

  it("stops at the declared deadline and redacts arbitrary worker errors", async () => {
    const baseUrl = await listen(
      createAgentArtsServer({
        environment,
        runReview: async (_task, options) =>
          await new Promise<RuntimeReply>((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error(realKey)), {
              once: true,
            });
          }),
      }),
    );
    const response = await fetch(`${baseUrl}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(task({ timeoutMs: 30 })),
    });
    expect(response.status).toBe(504);
    expect(await response.text()).not.toContain(realKey);
  });
});
