import { describe, expect, it, vi } from "vitest";

import { invokeReview, runtimeUrl, type RuntimeClientConfig } from "../src/agentarts/client.js";
import {
  MAX_TASK_BYTES,
  workspaceDigest,
  type ReviewTask,
  type RuntimeReply,
} from "../src/agentarts/protocol.js";

// HTTPS URL + injected fetch is a simulation seam, not a cloud connectivity test.
const config: RuntimeClientConfig = {
  origin: "https://runtime.simulation.invalid",
  runtimeName: "simulated-review",
  endpoint: "tested-v1",
  apiKey: "simulated-runtime-key-123456",
};
function task(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    schemaVersion: 1,
    taskId: "123e4567-e89b-42d3-a456-426614174000",
    binding: {
      repository: "example/simulated-review",
      pullNumber: 7,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    trust: "untrusted",
    tools: [],
    timeoutMs: 1000,
    instructions: "Simulated review",
    context: { simulation: true },
    files: [],
    ...overrides,
  };
}
function reply(input = task()): RuntimeReply {
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    binding: input.binding,
    dshVersion: "0.2.0-rc.2",
    output: { simulation: true },
    durationMs: 10,
    workspaceDigest: workspaceDigest(input.files),
    toolReceipts: [],
  };
}
function jsonResponse(
  value: unknown = reply(),
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
function inputUrl(input: Parameters<typeof fetch>[0] | undefined): string {
  if (input === undefined) throw new Error("Expected a simulated transport call");
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}
function simulatedFetch(response: () => Response) {
  return vi.fn<typeof fetch>((input) =>
    Promise.resolve(
      inputUrl(input).includes("/sessions-stop") ? new Response(null, { status: 200 }) : response(),
    ),
  );
}

describe("AgentArts HTTPS client (simulated transport)", () => {
  it("uses the documented API_KEY URI, fixed version alias and exact session headers", async () => {
    const input = task();
    const fetcher = simulatedFetch(() => jsonResponse());
    await expect(invokeReview(config, input, { fetchImplementation: fetcher })).resolves.toEqual(
      reply(),
    );
    const invocation = fetcher.mock.calls[0];
    expect(inputUrl(invocation?.[0])).toBe(
      "https://runtime.simulation.invalid/runtimes/simulated-review/invocations?endpoint=tested-v1",
    );
    expect(invocation?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "X-Hw-Agentarts-Session-Id": input.taskId,
      },
      body: JSON.stringify(input),
    });
    const cleanup = fetcher.mock.calls[1];
    expect(inputUrl(cleanup?.[0])).toBe(
      "https://runtime.simulation.invalid/runtimes/simulated-review/sessions-stop?endpoint=tested-v1",
    );
    expect(cleanup?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "X-Hw-Agentarts-Session-Id": input.taskId,
      },
    });
    expect(cleanup?.[1]?.body).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([401, 429, 500, 504, 499])(
    "does not retry HTTP %s and still stops the session",
    async (status) => {
      const fetcher = simulatedFetch(
        () => new Response(`Sensitive error body ${config.apiKey}`, { status }),
      );
      await expect(invokeReview(config, task(), { fetchImplementation: fetcher })).rejects.toThrow(
        `HTTP ${String(status)}`,
      );
      await expect(
        invokeReview(config, task(), {
          fetchImplementation: simulatedFetch(() => new Response(null, { status })),
        }),
      ).rejects.toMatchObject({
        code: status === 504 ? "DSH_TIMEOUT" : status === 499 ? "DSH_ABORTED" : "DSH_CONFIGURATION",
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(inputUrl(fetcher.mock.calls[1]?.[0])).toContain("/sessions-stop?");
    },
  );

  it.each([Buffer.from('{"synthetic-private-key":'), Buffer.from([0xff, 0xfe])])(
    "rejects invalid response encoding/JSON without logging its contents",
    async (body) => {
      const fetcher = simulatedFetch(
        () => new Response(body, { headers: { "content-type": "application/json" } }),
      );
      await expect(invokeReview(config, task(), { fetchImplementation: fetcher })).rejects.toThrow(
        "valid UTF-8 JSON",
      );
      try {
        await invokeReview(config, task(), { fetchImplementation: fetcher });
      } catch (error) {
        expect(String(error)).not.toContain("synthetic-private-key");
      }
    },
  );

  it("does not retry a transport failure or let cleanup failure hide it", async () => {
    const original = new Error("simulated connection reset");
    const fetcher = vi.fn<typeof fetch>(() => Promise.reject(original));
    await expect(invokeReview(config, task(), { fetchImplementation: fetcher })).rejects.toBe(
      original,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps a valid result when session-stop transport fails", async () => {
    const fetcher = vi.fn<typeof fetch>((input) =>
      inputUrl(input).includes("/sessions-stop")
        ? Promise.reject(new Error("simulated stop failure"))
        : Promise.resolve(jsonResponse()),
    );
    await expect(invokeReview(config, task(), { fetchImplementation: fetcher })).resolves.toEqual(
      reply(),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    () => new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } }),
    () => new Response("not-json", { headers: { "content-type": "application/json" } }),
    () => new Response(null, { headers: { "content-type": "application/json" } }),
    () => jsonResponse({ ...reply(), controllerCommand: "publish now" }),
    () => jsonResponse({ ...reply(), dshVersion: "latest" }),
    () => jsonResponse({ ...reply(), durationMs: -1 }),
  ])("rejects malformed/unsupported replies and cleans up", async (makeResponse) => {
    const fetcher = simulatedFetch(makeResponse);
    await expect(invokeReview(config, task(), { fetchImplementation: fetcher })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("caps streamed response bytes before parsing and cancels the body", async () => {
    const cancel = vi.fn<() => void>();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_TASK_BYTES + 1));
      },
      cancel,
    });
    const fetcher = simulatedFetch(
      () => new Response(stream, { headers: { "content-type": "application/json" } }),
    );
    await expect(
      invokeReview(config, task(), { fetchImplementation: fetcher }),
    ).rejects.toMatchObject({
      code: "DSH_CONFIGURATION",
      message: "Runtime response exceeds limit",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized task before any transport side effect", async () => {
    const fetcher = simulatedFetch(() => jsonResponse());
    await expect(
      invokeReview(config, task({ context: { text: "x".repeat(MAX_TASK_BYTES) } }), {
        fetchImplementation: fetcher,
      }),
    ).rejects.toMatchObject({ code: "DSH_CONFIGURATION" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("records only a bounded safe platform request ID", async () => {
    const onRequestId = vi.fn<(id: string) => void>();
    const fetcher = simulatedFetch(() =>
      jsonResponse(reply(), { "x-request-id": "simulated-request_1" }),
    );
    await invokeReview(config, task(), { fetchImplementation: fetcher, onRequestId });
    expect(onRequestId).toHaveBeenCalledWith("simulated-request_1");
    onRequestId.mockClear();
    const malformed = simulatedFetch(() =>
      jsonResponse(reply(), { "x-request-id": "<script>untrusted</script>" }),
    );
    await invokeReview(config, task(), { fetchImplementation: malformed, onRequestId });
    expect(onRequestId).not.toHaveBeenCalled();
  });

  function abortAwareFetch() {
    return vi.fn<typeof fetch>((input, init) => {
      if (inputUrl(input).includes("/sessions-stop")) return Promise.resolve(new Response(null));
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(new DOMException("simulated abort", "AbortError"));
        else
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("simulated abort", "AbortError")),
            { once: true },
          );
      });
    });
  }

  it("classifies a client deadline and uses a separate bounded cleanup signal", async () => {
    const fetcher = abortAwareFetch();
    await expect(
      invokeReview(config, task({ timeoutMs: 10 }), { fetchImplementation: fetcher }),
    ).rejects.toMatchObject({ code: "DSH_TIMEOUT", timeoutMs: 10 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetcher.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
  });

  it("classifies cancellation without retry and still requests session cleanup", async () => {
    const controller = new AbortController();
    const fetcher = abortAwareFetch();
    const running = invokeReview(config, task(), {
      fetchImplementation: fetcher,
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "DSH_ABORTED" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
  });
});

describe("AgentArts endpoint configuration", () => {
  it.each([
    "http://runtime.simulation.invalid",
    "https://user:password@runtime.simulation.invalid",
    "https://runtime.simulation.invalid/path",
    "https://runtime.simulation.invalid/?x=1",
    "https://runtime.simulation.invalid/#fragment",
  ])("rejects an unsafe Runtime origin %s", (origin) => {
    expect(() => runtimeUrl({ ...config, origin })).toThrow("HTTPS origin");
  });

  it.each(["Latest", "latest", "LATEST", "x", "../release", "release?endpoint=Latest"])(
    "rejects unfixed or invalid version alias %s",
    (endpoint) => {
      expect(() => runtimeUrl({ ...config, endpoint })).toThrow("fixed Runtime");
    },
  );

  it.each(["", "injected\r\nAuthorization: attacker"])(
    "rejects missing/injected API keys",
    (apiKey) => {
      expect(() => runtimeUrl({ ...config, apiKey })).toThrow("API_KEY");
    },
  );
});
