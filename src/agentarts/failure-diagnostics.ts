import { z } from "zod";

/** Only supervisor-owned classifications and transport facts cross a failure boundary. */
export const providerAttemptSchema = z
  .strictObject({
    sequence: z.number().int().min(1).max(32),
    outcome: z.enum(["http-success", "http-error", "network-error", "cancelled"]),
    status: z.number().int().min(100).max(599).nullable(),
  })
  .superRefine((attempt, context) => {
    const http = attempt.outcome === "http-success" || attempt.outcome === "http-error";
    if (http !== (attempt.status !== null))
      context.addIssue({ code: "custom", message: "Only HTTP attempts have a status" });
    if (
      attempt.status !== null &&
      (attempt.outcome === "http-success") !== (attempt.status >= 200 && attempt.status < 300)
    )
      context.addIssue({ code: "custom", message: "HTTP status and outcome disagree" });
  });
export type ProviderAttempt = z.infer<typeof providerAttemptSchema>;

export const providerFailureDiagnosticsSchema = z
  .strictObject({
    provider: z.literal("deepseek"),
    model: z.enum(["deepseek-v4-pro", "deepseek-flash"]),
    upstreamOrigin: z
      .url()
      .max(2048)
      .refine((value) => {
        try {
          return new URL(value).origin === value;
        } catch {
          return false;
        }
      }, "Origin only"),
    requestCount: z.number().int().min(0).max(32),
    requestLimit: z.number().int().min(1).max(32),
    maxOutputTokens: z.number().int().min(1).max(8192),
    /** Settled attempts only; a counted in-flight request has no invented status. */
    attempts: z.array(providerAttemptSchema).max(32),
  })
  .superRefine((provider, context) => {
    if (
      provider.requestCount > provider.requestLimit ||
      provider.attempts.length > provider.requestCount
    )
      context.addIssue({ code: "custom", message: "Provider attempt count exceeds policy" });
    const seen = new Set<number>();
    for (const attempt of provider.attempts) {
      if (seen.has(attempt.sequence) || attempt.sequence > provider.requestCount)
        context.addIssue({ code: "custom", message: "Provider attempt sequence is invalid" });
      seen.add(attempt.sequence);
    }
  });
export type ProviderFailureDiagnostics = z.infer<typeof providerFailureDiagnosticsSchema>;

export const agentArtsFailureDiagnosticsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  failureCode: z.enum([
    "DSH_ABORTED",
    "DSH_CONFIGURATION",
    "DSH_CREDENTIAL_LEAK",
    "DSH_ENVIRONMENT",
    "DSH_ISOLATION_UNAVAILABLE",
    "DSH_MALFORMED_OUTPUT",
    "DSH_OUTPUT_LIMIT",
    "DSH_PROCESS_FAILED",
    "DSH_PROXY",
    "DSH_SPAWN",
    "DSH_TIMEOUT",
    "POLICY_DENIED",
    "WORKER_FAILED",
  ]),
  phase: z.enum(["setup", "process", "output", "tool-audit", "workspace", "cleanup"]),
  provider: providerFailureDiagnosticsSchema,
  process: z
    .strictObject({
      exitCode: z.number().int().min(0).max(255).nullable(),
      signal: z
        .enum([
          "SIGABRT",
          "SIGALRM",
          "SIGBUS",
          "SIGCHLD",
          "SIGCONT",
          "SIGFPE",
          "SIGHUP",
          "SIGILL",
          "SIGINT",
          "SIGIO",
          "SIGIOT",
          "SIGKILL",
          "SIGPIPE",
          "SIGPOLL",
          "SIGPROF",
          "SIGPWR",
          "SIGQUIT",
          "SIGSEGV",
          "SIGSTKFLT",
          "SIGSTOP",
          "SIGSYS",
          "SIGTERM",
          "SIGTRAP",
          "SIGTSTP",
          "SIGTTIN",
          "SIGTTOU",
          "SIGUNUSED",
          "SIGURG",
          "SIGUSR1",
          "SIGUSR2",
          "SIGVTALRM",
          "SIGWINCH",
          "SIGXCPU",
          "SIGXFSZ",
          "SIGBREAK",
          "SIGLOST",
          "SIGINFO",
        ])
        .nullable(),
    })
    .optional(),
});
export type AgentArtsFailureDiagnostics = z.infer<typeof agentArtsFailureDiagnosticsSchema>;
export type AgentArtsFailurePhase = AgentArtsFailureDiagnostics["phase"];
