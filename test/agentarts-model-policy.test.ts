import { describe, expect, it, vi } from "vitest";
import { budgetedModelFetch, modelPolicy } from "../src/agentarts/model-policy.js";
import {
  agentArtsFailureDiagnosticsSchema,
  providerFailureDiagnosticsSchema,
} from "../src/agentarts/failure-diagnostics.js";

describe("trusted AgentArts model policy", () => {
  it("defaults to bounded, unverified evidence without exposing a supervisor key", () => {
    const policy = modelPolicy({ DEEPSEEK_API_KEY: "synthetic-supervisor-secret" });
    expect(policy).toEqual({
      kind: "unverified",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      upstreamOrigin: "https://api.deepseek.com",
      requestLimit: 12,
      maxOutputTokens: 4096,
    });
    expect(JSON.stringify(policy)).not.toContain("synthetic-supervisor-secret");
  });
  it.each([
    { AGENTARTS_MODEL_EVIDENCE: "cloud-real" },
    { AGENTARTS_MAX_MODEL_REQUESTS: "33" },
    { AGENTARTS_MAX_MODEL_REQUESTS: "0" },
    { AGENTARTS_MAX_OUTPUT_TOKENS: "8193" },
    { AGENTARTS_MAX_OUTPUT_TOKENS: "Infinity" },
    { AGENTARTS_DEEPSEEK_MODEL: "arbitrary-model" },
    { DEEPSEEK_BASE_URL: "https://operator:secret@api.deepseek.com" },
    { AGENTARTS_MODEL_EVIDENCE: "live-provider", DEEPSEEK_BASE_URL: "http://api.deepseek.com" },
    {
      AGENTARTS_MODEL_EVIDENCE: "live-provider",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com.evil.invalid",
    },
  ])("refuses unsafe operator configuration %j", (environment) => {
    expect(() => modelPolicy(environment)).toThrow();
  });
  it("clamps output, selects the trusted model, and counts failed attempts before provider transport", async () => {
    const policy = modelPolicy({
      AGENTARTS_MAX_MODEL_REQUESTS: "2",
      AGENTARTS_MAX_OUTPUT_TOKENS: "512",
      AGENTARTS_DEEPSEEK_MODEL: "deepseek-flash",
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("ambiguous failure"))
      .mockResolvedValueOnce(new Response("{}"));
    const transport = budgetedModelFetch(policy, new AbortController().signal, fetcher);
    const init = {
      method: "POST",
      body: Buffer.from(
        JSON.stringify({ model: "untrusted-model", max_tokens: 999999, messages: [] }),
      ),
    };
    await expect(
      transport.fetchImplementation("https://api.deepseek.com/anthropic/v1/messages", init),
    ).rejects.toThrow("ambiguous");
    await transport.fetchImplementation("https://api.deepseek.com/anthropic/v1/messages", init);
    await expect(
      transport.fetchImplementation("https://api.deepseek.com/anthropic/v1/messages", init),
    ).rejects.toThrow("limit reached");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(transport.requestCount()).toBe(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      model: "deepseek-flash",
      max_tokens: 512,
    });
  });
  it("refuses invalid body and cancellation without consuming provider allowance", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>();
    const transport = budgetedModelFetch(modelPolicy({}), abort.signal, fetcher);
    await expect(
      transport.fetchImplementation("https://api.deepseek.com", { body: "[" }),
    ).rejects.toThrow("JSON");
    abort.abort();
    await expect(
      transport.fetchImplementation("https://api.deepseek.com", { body: "{}" }),
    ).rejects.toThrow("cancelled");
    expect(fetcher).not.toHaveBeenCalled();
    expect(transport.requestCount()).toBe(0);
  });

  it("records bounded HTTP status facts on rejected provider attempts without reading its body", async () => {
    const rawSecret = "synthetic-private-provider-body";
    const response = new Response(rawSecret, { status: 400 });
    const read = vi.spyOn(response, "text");
    const json = vi.spyOn(response, "json");
    const transport = budgetedModelFetch(
      modelPolicy({}),
      new AbortController().signal,
      vi.fn<typeof fetch>().mockResolvedValue(response),
    );
    expect(
      await transport.fetchImplementation("https://api.deepseek.com/anthropic/v1/messages", {
        body: "{}",
      }),
    ).toBe(response);
    expect(transport.requestCount()).toBe(1);
    expect(transport.attempts()).toEqual([{ sequence: 1, outcome: "http-error", status: 400 }]);
    expect(JSON.stringify(transport.attempts())).not.toContain(rawSecret);
    expect(read).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    const copy = transport.attempts();
    if (copy[0] === undefined) throw new Error("Expected recorded attempt");
    copy[0].status = 401;
    expect(transport.attempts()[0]?.status).toBe(400);
  });

  it("counts an unsettled request without inventing its status and records cancellation afterward", async () => {
    const abort = new AbortController();
    const transport = budgetedModelFetch(
      modelPolicy({}),
      abort.signal,
      vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("Synthetic credential in raw error: never expose")),
              { once: true },
            );
          }),
      ),
    );
    const pending = transport.fetchImplementation(
      "https://api.deepseek.com/anthropic/v1/messages",
      { body: "{}" },
    );
    expect(transport.requestCount()).toBe(1);
    expect(transport.attempts()).toEqual([]);
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(transport.attempts()).toEqual([{ sequence: 1, outcome: "cancelled", status: null }]);
    expect(JSON.stringify(transport.attempts())).not.toContain("credential");
  });

  it("preserves Messages thinking effort while clamping max_tokens and records only transport success", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("invalid stream fixture"));
    const transport = budgetedModelFetch(
      modelPolicy({ AGENTARTS_MAX_OUTPUT_TOKENS: "2048" }),
      new AbortController().signal,
      fetcher,
    );
    await transport.fetchImplementation("https://api.deepseek.com/anthropic/v1/messages", {
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        max_tokens: 256000,
        thinking: { type: "enabled" },
        output_config: { effort: "high" },
      }),
    });
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({
      model: "deepseek-v4-pro",
      max_tokens: 2048,
      thinking: { type: "enabled" },
      output_config: { effort: "high" },
    });
    expect(transport.attempts()).toEqual([{ sequence: 1, outcome: "http-success", status: 200 }]);
  });

  it("strictly refuses forged messages, credentials, status contradictions and counter violations", () => {
    const provider = {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      upstreamOrigin: "https://api.deepseek.com",
      requestCount: 1,
      requestLimit: 2,
      maxOutputTokens: 2048,
      attempts: [{ sequence: 1, outcome: "http-error", status: 400 }],
    };
    const diagnostics = {
      schemaVersion: 1,
      failureCode: "DSH_PROCESS_FAILED",
      phase: "process",
      provider,
    };
    expect(agentArtsFailureDiagnosticsSchema.safeParse(diagnostics).success).toBe(true);
    for (const changes of [
      { message: "raw error" },
      { stderr: "raw provider credential" },
      { failureCode: "MODEL_COMMANDED_RELEASE" },
      { phase: "instructions" },
    ])
      expect(
        agentArtsFailureDiagnosticsSchema.safeParse({ ...diagnostics, ...changes }).success,
      ).toBe(false);
    for (const changes of [
      { upstreamOrigin: "https://api.deepseek.com/path?credential=value" },
      { upstreamOrigin: "not-a-url" },
      { apiKey: "credential" },
      { requestCount: 3 },
      { attempts: [{ sequence: 1, outcome: "http-success", status: 400 }] },
      { attempts: [{ sequence: 2, outcome: "network-error", status: null }] },
      {
        attempts: [
          { sequence: 1, outcome: "http-error", status: 400 },
          { sequence: 1, outcome: "http-error", status: 400 },
        ],
      },
    ])
      expect(providerFailureDiagnosticsSchema.safeParse({ ...provider, ...changes }).success).toBe(
        false,
      );
  });
});
