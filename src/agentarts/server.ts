import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { DshAbortedError, DshTimeoutError } from "../dsh/errors.js";
import { collectControllerSecrets, redactKnownSecrets } from "../security/env.js";
import {
  MAX_RUNTIME_MS,
  MAX_TASK_BYTES,
  reviewTaskSchema,
  type ReviewTask,
  type RuntimeReply,
} from "./protocol.js";
import {
  runAgentArtsReview,
  runAgentArtsReadOnlyTask,
  runAgentArtsRuntimeTask,
  getAgentArtsFailureDiagnostics,
} from "./worker.js";
import type { AgentArtsFailureDiagnostics } from "./failure-diagnostics.js";
import {
  readOnlyTaskSchema,
  type ReadOnlyTask,
  type ReadOnlyTaskReply,
} from "./readonly-task-protocol.js";
import { modelPolicy } from "./model-policy.js";
import {
  MAX_RUNTIME_TASK_BYTES,
  MAX_RUNTIME_TASK_MS,
  runtimeTaskSchema,
  type RuntimeTask,
  type RuntimeTaskReply,
} from "./runtime-task-protocol.js";

export interface AgentArtsServerOptions {
  /** Supervisor environment, inaccessible to the DSH process. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly runReview?: (
    task: ReviewTask,
    options: { readonly environment: NodeJS.ProcessEnv; readonly signal: AbortSignal },
  ) => Promise<RuntimeReply>;
  readonly runReadOnlyTask?: (
    task: ReadOnlyTask,
    options: { readonly environment: NodeJS.ProcessEnv; readonly signal: AbortSignal },
  ) => Promise<ReadOnlyTaskReply>;
  readonly runRuntimeTask?: (
    task: RuntimeTask,
    options: { readonly environment: NodeJS.ProcessEnv; readonly signal: AbortSignal },
  ) => Promise<RuntimeTaskReply>;
  /** Tests can capture this bounded event stream without intercepting stdout. */
  readonly logEvent?: (event: RuntimeLogEvent) => void;
}

export interface RuntimeLogEvent {
  readonly schemaVersion: 1;
  readonly event: "task.accepted" | "task.completed" | "task.failed";
  readonly timestamp: string;
  readonly taskId: string;
  readonly repository: string;
  readonly pullNumber?: number;
  readonly operation?: "review" | "task" | "diagnose" | "fix" | "implement";
  readonly baseSha?: string;
  readonly entity?: ReadOnlyTask["binding"]["entity"];
  readonly headSha: string;
  readonly durationMs: number;
  readonly tools?: readonly {
    readonly id: string;
    readonly ok: boolean;
    readonly durationMs: number;
  }[];
  readonly code?: "TASK_TIMEOUT" | "TASK_CANCELLED" | "WORKER_FAILED";
  readonly diagnostics?: AgentArtsFailureDiagnostics;
}

export type AgentArtsServer = Server & { cancelActive(): void };

export function runtimeProtocolVersions(environment: NodeJS.ProcessEnv): readonly number[] {
  const legacy = environment.AGENTARTS_ENABLE_LEGACY_PROTOCOLS ?? "false";
  if (legacy !== "true" && legacy !== "false")
    throw new Error("Invalid legacy Runtime protocol setting");
  return legacy === "true" ? [1, 2, 3] : [3];
}

class RequestBodyError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: IncomingMessage): Promise<{ value: unknown; bytes: number }> {
  const size = request.headers["content-length"];
  if (size !== undefined && (!/^\d+$/u.test(size) || Number(size) > MAX_RUNTIME_TASK_BYTES)) {
    request.resume();
    throw new RequestBodyError(413, "Task body exceeds the Runtime limit");
  }
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    request.resume();
    throw new RequestBodyError(415, "Runtime accepts application/json tasks");
  }
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = (): void => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", fail);
      request.off("aborted", aborted);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const aborted = (): void => fail(new RequestBodyError(400, "Task upload disconnected"));
    const data = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > MAX_RUNTIME_TASK_BYTES) {
        cleanup();
        request.resume();
        reject(new RequestBodyError(413, "Task body exceeds the Runtime limit"));
        return;
      }
      chunks.push(chunk);
    };
    const end = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, bytes));
    };
    request.on("data", data).once("end", end).once("error", fail).once("aborted", aborted);
  });
  try {
    return {
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown,
      bytes: body.byteLength,
    };
  } catch {
    throw new RequestBodyError(400, "Task body is not valid JSON");
  }
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(serialized),
    "cache-control": "no-store",
  });
  response.end(serialized);
}

/** Runtime protocol only. Publish and GitHub credentials remain in the Controller. */
export function createAgentArtsServer(options: AgentArtsServerOptions = {}): AgentArtsServer {
  const environment = options.environment ?? process.env;
  const protocols = runtimeProtocolVersions(environment);
  // AgentArts authenticates at its inbound gateway. Direct local access has a
  // separate optional capability, selected only by the supervisor/operator.
  const localKey = environment.AGENTARTS_LOCAL_API_KEY;
  if (
    localKey !== undefined &&
    (localKey.length < 16 || Buffer.byteLength(localKey) > 4096 || /[\s\0]/u.test(localKey))
  )
    throw new Error("Invalid local Runtime authentication configuration");
  const policy = modelPolicy(environment);
  const execute = options.runReview ?? runAgentArtsReview;
  const executeReadOnly = options.runReadOnlyTask ?? runAgentArtsReadOnlyTask;
  const executeRuntime = options.runRuntimeTask ?? runAgentArtsRuntimeTask;
  const logSecrets = [
    ...collectControllerSecrets(environment),
    environment.API_KEY ?? "",
    localKey ?? "",
  ];
  const logEvent =
    options.logEvent ??
    ((event: RuntimeLogEvent): void => {
      process.stdout.write(`${redactKnownSecrets(JSON.stringify(event), logSecrets)}\n`);
    });
  const emit = (
    task: ReviewTask | ReadOnlyTask | RuntimeTask,
    event: RuntimeLogEvent["event"],
    durationMs: number,
    extra: Pick<RuntimeLogEvent, "tools" | "code" | "diagnostics"> = {},
  ): void => {
    try {
      logEvent({
        schemaVersion: 1,
        event,
        timestamp: new Date().toISOString(),
        taskId: task.taskId,
        repository: task.binding.repository,
        ...(task.schemaVersion === 1
          ? { pullNumber: task.binding.pullNumber, operation: "review" as const }
          : { entity: task.binding.entity, operation: task.operation }),
        baseSha: task.binding.baseSha,
        headSha: task.binding.headSha,
        durationMs,
        ...extra,
      });
    } catch {
      // Observability does not turn a log sink failure into a replayed task.
    }
  };
  const seen = new Set<string>();
  let active: AbortController | undefined;
  let uploading = false;
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://runtime.invalid").pathname;
    if (path === "/ping" && request.method === "GET") {
      reply(response, 200, {
        status: active === undefined ? "Healthy" : "HealthyBusy",
        modelPolicy: policy,
        protocolVersions: protocols,
      });
      return;
    }
    if (path !== "/invocations" || request.method !== "POST") {
      reply(response, 404, {
        error: { code: "ENDPOINT_NOT_ALLOWED", message: "Endpoint is not supported" },
      });
      request.resume();
      return;
    }
    if (localKey !== undefined) {
      const actual = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${localKey}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        reply(response, 401, {
          error: {
            code: "LOCAL_AUTH_REQUIRED",
            message: "Runtime invocation requires the operator-configured local capability",
          },
        });
        request.resume();
        return;
      }
    }
    if (uploading) {
      reply(response, 409, {
        error: {
          code: "RUNTIME_BUSY",
          message: "Runtime is admitting another bounded upload; this task did not start",
        },
      });
      request.resume();
      return;
    }
    let task: ReviewTask | ReadOnlyTask | RuntimeTask;
    uploading = true;
    try {
      const uploaded = await readJson(request);
      const raw = uploaded.value;
      const version =
        typeof raw === "object" && raw !== null && "schemaVersion" in raw
          ? raw.schemaVersion
          : undefined;
      if (typeof version !== "number" || !protocols.includes(version))
        throw new RequestBodyError(400, "Task protocol is not enabled on this Runtime");
      if (version !== 3 && uploaded.bytes > MAX_TASK_BYTES)
        throw new RequestBodyError(413, "Legacy task body exceeds its 2 MiB limit");
      const parsed =
        version === 3
          ? runtimeTaskSchema.safeParse(raw)
          : version === 2
            ? readOnlyTaskSchema.safeParse(raw)
            : reviewTaskSchema.safeParse(raw);
      if (!parsed.success)
        throw new RequestBodyError(400, "Task failed the bounded Runtime protocol");
      task = parsed.data;
    } catch (error: unknown) {
      const bodyError =
        error instanceof RequestBodyError
          ? error
          : new RequestBodyError(400, "Invalid Runtime task upload");
      reply(response, bodyError.status, {
        error: { code: "INVALID_TASK", message: bodyError.message },
      });
      return;
    } finally {
      uploading = false;
    }
    if (active !== undefined) {
      reply(response, 409, {
        error: {
          code: "RUNTIME_BUSY",
          message: "Runtime admits one active task; this task did not start",
        },
      });
      return;
    }
    if (seen.has(task.taskId)) {
      reply(response, 409, {
        error: {
          code: "DUPLICATE_TASK",
          message: "This Runtime instance has already admitted this task",
        },
      });
      return;
    }
    // Bound deduplication state without eviction/replay. An instance that reaches
    // capacity refuses work; restarting loses this local state, so Controller
    // transport deliberately never retries an ambiguous invocation automatically.
    if (seen.size >= 4096) {
      reply(response, 503, {
        error: {
          code: "TASK_HISTORY_FULL",
          message: "Runtime task history requires instance replacement",
        },
      });
      return;
    }
    seen.add(task.taskId);
    const acceptedAt = Date.now();
    emit(task, "task.accepted", 0);
    const cancellation = new AbortController();
    active = cancellation;
    const disconnect = (): void => {
      if (!response.writableEnded) cancellation.abort();
    };
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    const deadline = { reached: false };
    const timer = setTimeout(() => {
      deadline.reached = true;
      cancellation.abort();
    }, task.timeoutMs);
    timer.unref();
    try {
      const result =
        task.schemaVersion === 1
          ? await execute(task, { environment, signal: cancellation.signal })
          : task.schemaVersion === 2
            ? await executeReadOnly(task, { environment, signal: cancellation.signal })
            : await executeRuntime(task, { environment, signal: cancellation.signal });
      if (cancellation.signal.aborted) throw new DshAbortedError();
      const serializedBytes = Buffer.byteLength(JSON.stringify(result));
      if (serializedBytes > (task.schemaVersion === 3 ? MAX_RUNTIME_TASK_BYTES : MAX_TASK_BYTES))
        throw new Error("Runtime result exceeds its bounded response limit");
      const tools = result.toolReceipts.map((receipt) => {
        const value = receipt as { id: string; ok: boolean; durationMs: number };
        return { id: value.id, ok: value.ok, durationMs: value.durationMs };
      });
      emit(task, "task.completed", Date.now() - acceptedAt, { tools });
      reply(response, 200, result);
    } catch (error: unknown) {
      // Worker stderr, secrets, repository text and model data never become
      // public exception messages or control instructions.
      const timedOut = deadline.reached || error instanceof DshTimeoutError;
      const aborted = cancellation.signal.aborted || error instanceof DshAbortedError;
      const diagnostics = getAgentArtsFailureDiagnostics(error);
      emit(task, "task.failed", Date.now() - acceptedAt, {
        code: timedOut ? "TASK_TIMEOUT" : aborted ? "TASK_CANCELLED" : "WORKER_FAILED",
        ...(diagnostics === undefined ? {} : { diagnostics }),
      });
      reply(response, timedOut ? 504 : aborted ? 499 : 500, {
        error: {
          code: timedOut ? "TASK_TIMEOUT" : aborted ? "TASK_CANCELLED" : "WORKER_FAILED",
          message: timedOut
            ? "Task exceeded its execution deadline"
            : aborted
              ? "Task was cancelled before a result was accepted"
              : "DSH task failed; no result may be published",
          taskId: task.taskId,
          ...(diagnostics === undefined ? {} : { diagnostics }),
        },
      });
    } finally {
      clearTimeout(timer);
      request.off("aborted", disconnect);
      response.off("close", disconnect);
      active = undefined;
    }
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  }) as AgentArtsServer;
  server.cancelActive = (): void => active?.abort();
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.timeout = Math.max(MAX_RUNTIME_MS, MAX_RUNTIME_TASK_MS) + 30_000;
  server.on("close", () => active?.abort());
  return server;
}
