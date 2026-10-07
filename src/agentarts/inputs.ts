import { ACTION_INPUT_CONTRACT } from "../action-contract.js";
import { loadInputs, type ActionInputs } from "../inputs.js";
import { DSH_VERSION } from "../release.js";
import { ActionConfigurationError, PolicyDeniedError } from "../errors.js";
import type { AuthorizedRun } from "../orchestration/prepare.js";

/** Provider credentials and executable selection belong to the Runtime supervisor. */
export const RUNTIME_MANAGED_INPUTS = new Set([
  "deepseek-api-key",
  "dsh-version",
  "dsh-executable",
  "isolation",
  "base-url",
  "web-search-base-url",
]);
export const AGENTARTS_UPSTREAM_INPUTS = ACTION_INPUT_CONTRACT.filter(
  ({ name }) => !RUNTIME_MANAGED_INPUTS.has(name),
);

export function loadAgentArtsInputs(read: (name: string) => string): ActionInputs {
  for (const name of RUNTIME_MANAGED_INPUTS) {
    if (read(name) !== "")
      throw new ActionConfigurationError(
        `${name} is configured by the trusted Runtime supervisor, not the cloud Action`,
      );
  }
  const fixed: Record<string, string> = {
    "deepseek-api-key": "runtime-managed-model-proxy",
    "dsh-version": DSH_VERSION,
    "dsh-executable": "",
    isolation: "docker",
  };
  return loadInputs((name) => fixed[name] ?? (RUNTIME_MANAGED_INPUTS.has(name) ? "" : read(name)));
}

/** The original policy has already checked actors, events, forks and requested access. */
export function assertFullAgentArtsAuthorizedRun(run: AuthorizedRun): void {
  if (
    !run.policy.allowed ||
    (run.command.requestedAccess === "write" && run.policy.trust !== "trusted-write")
  )
    throw new PolicyDeniedError("AgentArts task did not pass the original Controller write policy");
  if (
    (run.command.operation === "review" || run.command.operation === "fix") &&
    run.snapshot?.kind !== "pull_request"
  )
    throw new PolicyDeniedError("AgentArts review/fix requires a bound pull request");
  if (run.command.operation === "implement" && run.snapshot?.kind !== "issue")
    throw new PolicyDeniedError("AgentArts implement requires a bound Issue");
}
