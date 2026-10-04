import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { DshAbortedError, DshTimeoutError } from "../dsh/errors.js";
import { collectControllerSecrets, redactKnownSecrets } from "../security/env.js";
import {
  MAX_RUNTIME_MS,
  MAX_TASK_BYTES,
  reviewTaskSchema,
  type ReviewTask,
  type RuntimeReply,
} from "./protocol.js";
import { runAgentArtsReview } from "./worker.js";

export interface AgentArtsServerOptions {
  /** Supervisor environment, inaccessible to the DSH process. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly runReview?: (
    task: ReviewTask,
    options: { readonly environment: NodeJS.ProcessEnv; readonly signal: AbortSignal },
  ) => Promise<RuntimeReply>;
  /** Tests can capture this bounded event stream without intercepting stdout. */
  readonly logEvent?: (event: RuntimeLogEvent) => void;
}

export interface RuntimeLogEvent {
  readonly schemaVersion: 1;
  readonly event: "task.accepted" | "task.completed" | "task.failed";
  readonly timestamp: string;
  readonly taskId: string;
  readonly repository: string;
  readonly pullNumber: number;
  readonly headSha: string;
  readonly durationMs: number;
  readonly tools?: readonly {
    readonly id: string;
    readonly ok: boolean;
    readonly durationMs: number;
  }[];
  readonly code?: "TASK_TIMEOUT" | "TASK_CANCELLED" | "WORKER_FAILED";
}

export type AgentArtsServer = Server & { cancelActive(): void };

class RequestBodyError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const size = request.headers["content-length"];
  if (size !== undefined && (!/^\d+$/u.test(size) || Number(size) > MAX_TASK_BYTES)) {
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
      if (bytes > MAX_TASK_BYTES) {
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
    return JSON.parse(body.toString("utf8")) as unknown;
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
  const execute = options.runReview ?? runAgentArtsReview;
  const logSecrets = [...collectControllerSecrets(environment), environment.API_KEY ?? ""];
  const logEvent =
    options.logEvent ??
    ((event: RuntimeLogEvent): void => {
      process.stdout.write(`${redactKnownSecrets(JSON.stringify(event), logSecrets)}\n`);
    });
  const emit = (
    task: ReviewTask,
    event: RuntimeLogEvent["event"],
    durationMs: number,
    extra: Pick<RuntimeLogEvent, "tools" | "code"> = {},
  ): void => {
    try {
      logEvent({
        schemaVersion: 1,
        event,
        timestamp: new Date().toISOString(),
        taskId: task.taskId,
        repository: task.binding.repository,
        pullNumber: task.binding.pullNumber,
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
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://runtime.invalid").pathname;
    if (path === "/ping" && request.method === "GET") {
      reply(response, 200, { status: active === undefined ? "Healthy" : "HealthyBusy" });
      return;
    }
    if (path !== "/invocations" || request.method !== "POST") {
      reply(response, 404, {
        error: { code: "ENDPOINT_NOT_ALLOWED", message: "Endpoint is not supported" },
      });
      request.resume();
      return;
    }
    let task: ReviewTask;
    try {
      const parsed = reviewTaskSchema.safeParse(await readJson(request));
      if (!parsed.success)
        throw new RequestBodyError(400, "Task failed the bounded review protocol");
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
    }
    if (active !== undefined) {
      reply(response, 409, {
        error: {
          code: "RUNTIME_BUSY",
          message: "Runtime admits one active review; this task did not start",
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
      const result = await execute(task, { environment, signal: cancellation.signal });
      if (cancellation.signal.aborted) throw new DshAbortedError();
      const serializedBytes = Buffer.byteLength(JSON.stringify(result));
      if (serializedBytes > MAX_TASK_BYTES)
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
      emit(task, "task.failed", Date.now() - acceptedAt, {
        code: timedOut ? "TASK_TIMEOUT" : aborted ? "TASK_CANCELLED" : "WORKER_FAILED",
      });
      reply(response, timedOut ? 504 : aborted ? 499 : 500, {
        error: {
          code: timedOut ? "TASK_TIMEOUT" : aborted ? "TASK_CANCELLED" : "WORKER_FAILED",
          message: timedOut
            ? "Review exceeded its execution deadline"
            : aborted
              ? "Review was cancelled before a result was accepted"
              : "DSH review failed; no result may be published",
          taskId: task.taskId,
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
  server.timeout = MAX_RUNTIME_MS + 30_000;
  server.on("close", () => active?.abort());
  return server;
}
