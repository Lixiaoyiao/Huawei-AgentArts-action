import { z } from "zod";
import type { ReadableStreamReadResult } from "node:stream/web";
import { DshAbortedError, DshConfigurationError, DshTimeoutError } from "../dsh/errors.js";
import {
  runtimeReplySchema,
  type ReviewTask,
  type RuntimeReply,
  MAX_TASK_BYTES,
} from "./protocol.js";

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
  const fetcher = options.fetchImplementation ?? fetch;
  const url = runtimeUrl(config);
  const body = JSON.stringify(task);
  if (Buffer.byteLength(body) > MAX_TASK_BYTES)
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
    if (!response.ok)
      throw new DshConfigurationError(
        `Runtime invocation rejected (HTTP ${String(response.status)}); not retried`,
      );
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new DshConfigurationError("Runtime must return application/json");
    if (response.body === null) throw new DshConfigurationError("Runtime returned no response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_TASK_BYTES)
          throw new DshConfigurationError("Runtime response exceeds limit");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    return runtimeReplySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  } catch (error) {
    if (options.signal?.aborted) throw new DshAbortedError();
    if (timeout.aborted) throw new DshTimeoutError(task.timeoutMs);
    if (error instanceof z.ZodError)
      throw new DshConfigurationError("Runtime response failed strict schema validation");
    throw error;
  } finally {
    // Stop only our fresh review session. Cleanup never changes the invocation outcome.
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
