import {
  agentArtsFailureDiagnosticsSchema,
  type AgentArtsFailureDiagnostics,
} from "./failure-diagnostics.js";

/** Ignore messages and unrecognized properties in error bodies; only fixed classifications survive. */
export function runtimeFailureDiagnostics(
  raw: unknown,
  taskId: string,
): AgentArtsFailureDiagnostics | undefined {
  if (typeof raw !== "object" || raw === null || !("error" in raw)) return undefined;
  const error = raw.error;
  if (
    typeof error !== "object" ||
    error === null ||
    !("taskId" in error) ||
    error.taskId !== taskId ||
    !("diagnostics" in error)
  )
    return undefined;
  const parsed = agentArtsFailureDiagnosticsSchema.safeParse(error.diagnostics);
  return parsed.success ? parsed.data : undefined;
}

export function formatRuntimeFailure(
  status: number,
  diagnostics?: AgentArtsFailureDiagnostics,
): string {
  const prefix = `Runtime invocation rejected (HTTP ${String(status)}); no result accepted or retried`;
  if (diagnostics === undefined) return prefix;
  const transport = [
    ...new Set(
      diagnostics.provider.attempts.map((attempt) =>
        attempt.status === null ? attempt.outcome : `HTTP ${String(attempt.status)}`,
      ),
    ),
  ].join(", ");
  return `${prefix}; ${diagnostics.failureCode} at ${diagnostics.phase}; provider attempts ${String(diagnostics.provider.requestCount)}/${String(diagnostics.provider.requestLimit)}${transport === "" ? "" : ` (${transport})`}`;
}
