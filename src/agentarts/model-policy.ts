import { DshConfigurationError } from "../dsh/errors.js";

export interface ModelPolicy {
  readonly kind: "live-provider" | "deterministic-fixture" | "unverified";
  readonly provider: "deepseek";
  readonly model: string;
  readonly upstreamOrigin: string;
  readonly requestLimit: number;
  readonly maxOutputTokens: number;
}

function limit(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = environment[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(value) || value > maximum)
    throw new DshConfigurationError(`${name} must be an integer in 1..${String(maximum)}`);
  return value;
}

/** Operator-owned policy only. No model key, task data or model output participates. */
export function modelPolicy(environment: NodeJS.ProcessEnv): ModelPolicy {
  const kind = environment.AGENTARTS_MODEL_EVIDENCE ?? "unverified";
  if (!["live-provider", "deterministic-fixture", "unverified"].includes(kind))
    throw new DshConfigurationError("AGENTARTS_MODEL_EVIDENCE is not a supported evidence mode");
  let upstream: URL;
  try {
    upstream = new URL(environment.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com");
  } catch {
    throw new DshConfigurationError("Invalid operator-selected model upstream");
  }
  if (upstream.username || upstream.password || upstream.search || upstream.hash)
    throw new DshConfigurationError(
      "Model upstream must not contain credentials, query or fragment",
    );
  if (
    kind === "live-provider" &&
    (upstream.origin !== "https://api.deepseek.com" ||
      !["/", "/v1", "/anthropic", "/anthropic/v1"].includes(
        upstream.pathname.replace(/\/$/u, "") || "/",
      ))
  )
    throw new DshConfigurationError(
      "Live model validation requires the official HTTPS DeepSeek upstream",
    );
  const model = environment.AGENTARTS_DEEPSEEK_MODEL ?? "deepseek-v4-pro";
  if (!["deepseek-v4-pro", "deepseek-flash"].includes(model))
    throw new DshConfigurationError(
      "Choose an explicit supported DeepSeek model for the trusted proxy",
    );
  return {
    kind: kind as ModelPolicy["kind"],
    provider: "deepseek",
    model,
    upstreamOrigin: upstream.origin,
    requestLimit: limit(environment, "AGENTARTS_MAX_MODEL_REQUESTS", 12, 32),
    maxOutputTokens: limit(environment, "AGENTARTS_MAX_OUTPUT_TOKENS", 4096, 8192),
  };
}

/** A hard provider-call limit, including retries. A dollar budget is not inferred. */
export function budgetedModelFetch(
  policy: ModelPolicy,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): {
  readonly fetchImplementation: typeof fetch;
  readonly requestCount: () => number;
} {
  let requests = 0;
  const implementation: typeof fetch = async (input, init) => {
    if (signal.aborted)
      throw new DshConfigurationError("Model call cancelled before provider transport");
    if (requests >= policy.requestLimit)
      throw new DshConfigurationError(
        "Trusted model request limit reached; no further provider call was made",
      );
    if (typeof init?.body !== "string" && !(init?.body instanceof Uint8Array))
      throw new DshConfigurationError("Model proxy requires a JSON text request body");
    let payload: Record<string, unknown>;
    try {
      const decoded =
        typeof init.body === "string"
          ? init.body
          : new TextDecoder("utf-8", { fatal: true }).decode(init.body);
      const parsed = JSON.parse(decoded) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new DshConfigurationError("Model proxy request is not a valid JSON object");
    }
    payload.model = policy.model;
    const proposed = payload.max_tokens;
    payload.max_tokens =
      typeof proposed === "number" && Number.isSafeInteger(proposed) && proposed > 0
        ? Math.min(proposed, policy.maxOutputTokens)
        : policy.maxOutputTokens;
    // Count every attempt before transport. Even an ambiguous network error
    // consumes its allowance; redirects cannot forward the real credential.
    requests += 1;
    return await fetcher(input, {
      ...init,
      body: JSON.stringify(payload),
      redirect: "error",
      signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
  };
  return { fetchImplementation: implementation, requestCount: () => requests };
}
