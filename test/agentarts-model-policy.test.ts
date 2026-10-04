import { describe, expect, it, vi } from "vitest";
import { budgetedModelFetch, modelPolicy } from "../src/agentarts/model-policy.js";

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
});
