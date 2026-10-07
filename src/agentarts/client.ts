import { z } from "zod";
import type { ReadableStreamReadResult } from "node:stream/web";
import {
  DshAbortedError,
  DshConfigurationError,
  DshError,
  DshTimeoutError,
} from "../dsh/errors.js";
import {
  runtimeReplySchema,
  type ReviewTask,
  type RuntimeReply,
  MAX_TASK_BYTES,
} from "./protocol.js";
import {
  readOnlyTaskReplySchema,
  type ReadOnlyTask,
  type ReadOnlyTaskReply,
} from "./readonly-task-protocol.js";
import { formatRuntimeFailure, runtimeFailureDiagnostics } from "./failure-format.js";
import {
  runtimeTaskReplySchema,
  MAX_RUNTIME_TASK_BYTES,
  type RuntimeTask,
  type RuntimeTaskReply,
} from "./runtime-task-protocol.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";

async function readRuntimeJson(
  response: Response,
  maximumBytes = MAX_TASK_BYTES,
): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("application/json") || response.body === null)
    throw new DshConfigurationError("Runtime must return application/json");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw new DshConfigurationError("Runtime response exceeds limit");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } catch {
    throw new DshConfigurationError(
      "Runtime response was not valid UTF-8 JSON; body was not logged",
    );
  }
}

export interface RuntimeClientConfig {
  readonly origin: string;
  readonly runtimeName: string;
  readonly endpoint: string;
  readonly apiKey: string;
}

export function runtimeUrl(config: RuntimeClientConfig, operation = "invocations"): URL {
  const origin = new URL(config.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new DshConfigurationError("Runtime origin must be an HTTPS origin from its detail page");
  if (
    !/^[a-z][a-z0-9-]{0,46}[a-z0-9]$/u.test(config.runtimeName) ||
    !/^[A-Za-z][A-Za-z0-9-]{0,46}[A-Za-z0-9]$/u.test(config.endpoint) ||
    config.endpoint.toLowerCase() === "latest"
  )
    throw new DshConfigurationError(
      "Use an explicit fixed Runtime name and version alias; Latest is forbidden",
    );
  if (!config.apiKey || /[\r\n]/u.test(config.apiKey))
    throw new DshConfigurationError("Runtime API_KEY is required");
  const url = new URL(`/runtimes/${config.runtimeName}/${operation}`, origin);
  url.searchParams.set("endpoint", config.endpoint);
  return url;
}

/** One invocation, no automatic POST retries. Runtime payload is our versioned protocol. */
export async function invokeReview(
  config: RuntimeClientConfig,
  task: ReviewTask,
  options: {
    readonly signal?: AbortSignal;
    readonly fetchImplementation?: typeof fetch;
    readonly onRequestId?: (id: string) => void;
  } = {},
): Promise<RuntimeReply> {
  return invokeRuntime(config, task, runtimeReplySchema, options);
}

/** Uses the same bounded authenticated transport and fresh-session cleanup as review. */
export async function invokeReadOnlyTask(
  config: RuntimeClientConfig,
  task: ReadOnlyTask,
  options: {
    readonly signal?: AbortSignal;
    readonly fetchImplementation?: typeof fetch;
    readonly onRequestId?: (id: string) => void;
  } = {},
): Promise<ReadOnlyTaskReply> {
  return invokeRuntime(config, task, readOnlyTaskReplySchema, options);
}
/** Full v3 transport; authority and file deltas remain independently checked by the Controller. */
export async function invokeRuntimeTask(
  config: RuntimeClientConfig,
  task: RuntimeTask,
  options: {
    readonly signal?: AbortSignal;
    readonly fetchImplementation?: typeof fetch;
    readonly onRequestId?: (id: string) => void;
  } = {},
): Promise<RuntimeTaskReply> {
  return invokeRuntime(config, task, runtimeTaskReplySchema, options);
}

async function invokeRuntime<T>(
  config: RuntimeClientConfig,
  task: ReviewTask | ReadOnlyTask | RuntimeTask,
  replySchema: z.ZodType<T>,
  options: {
    readonly signal?: AbortSignal;
    readonly fetchImplementation?: typeof fetch;
    readonly onRequestId?: (id: string) => void;
  },
): Promise<T> {
  throwIfCancelled(options.signal);
  const fetcher = options.fetchImplementation ?? fetch;
  const url = runtimeUrl(config);
  const body = JSON.stringify(task);
  const maximumBytes = task.schemaVersion === 3 ? MAX_RUNTIME_TASK_BYTES : MAX_TASK_BYTES;
  if (Buffer.byteLength(body) > maximumBytes)
    throw new DshConfigurationError("Task exceeds transport limit");
  const timeout = AbortSignal.timeout(task.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  try {
    const response = await fetcher(url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "X-Hw-Agentarts-Session-Id": task.taskId,
      },
      body,
    });
    const requestId = response.headers.get("x-request-id");
    if (requestId && /^[A-Za-z0-9_-]{1,128}$/u.test(requestId)) options.onRequestId?.(requestId);
    if (!response.ok) {
      let failure: unknown;
      try {
        failure = await readRuntimeJson(response, maximumBytes);
      } catch {
        await response.body?.cancel();
      }
      const details = runtimeFailureDiagnostics(failure, task.taskId);
      const message = formatRuntimeFailure(response.status, details);
      if (response.status === 504) throw new DshError("DSH_TIMEOUT", message);
      if (response.status === 499) throw new DshError("DSH_ABORTED", message);
      throw new DshConfigurationError(message);
    }
    const result = replySchema.parse(await readRuntimeJson(response, maximumBytes));
    throwIfCancelled(signal);
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw new DshAbortedError();
    if (timeout.aborted) throw new DshTimeoutError(task.timeoutMs);
    if (error instanceof z.ZodError)
      throw new DshConfigurationError("Runtime response failed strict schema validation");
    throw error;
  } finally {
    // Stop only this fresh invocation session. Cleanup never changes its outcome.
    // Abort need not propagate through the cloud frontend; the worker also has a hard deadline.
    try {
      const response = await fetcher(runtimeUrl(config, "sessions-stop"), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "X-Hw-Agentarts-Session-Id": task.taskId,
        },
      });
      await response.body?.cancel();
    } catch {
      /* bounded best effort; no GitHub side effects exist in Runtime */
    }
  }
}
