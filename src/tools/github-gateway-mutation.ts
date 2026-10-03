import type { GitHubBackendRequestControl } from "./github-backend.js";
import { callGitHubApi, type GitHubInvocationDeadline } from "./github-gateway-deadline.js";
import { GitHubEntityRevalidationError } from "./github-gateway-revalidation.js";
import { GitHubQuotaError } from "../github/request-policy.js";

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function isAmbiguousGitHubMutationError(error: unknown): boolean {
  if (error instanceof GitHubEntityRevalidationError || error instanceof GitHubQuotaError)
    return false;
  const status = errorStatus(error);
  return status === undefined || status === 408 || status >= 500;
}

export interface GitHubMutationResult<T> {
  readonly value: T;
  readonly attempts: number;
  readonly effect: "updated" | "unchanged";
  readonly reconciled: boolean;
}

export class GitHubMutationExecutionError extends Error {
  public constructor(
    public readonly attempts: number,
    public readonly reconciled: boolean,
    public readonly externalEffect: "none" | "possible" | "confirmed",
    options?: ErrorOptions,
  ) {
    super("GitHub mutation failed its single-write reconciliation policy", options);
    this.name = "GitHubMutationExecutionError";
  }
}

/** Send a mutation once, then reconcile uncertain effects with fresh reads. */
export async function mutateGitHubWithPostcondition<T>(options: {
  readonly invocation: GitHubInvocationDeadline;
  readonly read: (control: GitHubBackendRequestControl) => Promise<T>;
  readonly mutate: (control: GitHubBackendRequestControl, markStarted: () => void) => Promise<void>;
  readonly matches: (value: T) => boolean;
}): Promise<GitHubMutationResult<T>> {
  const read = async (): Promise<T> => await callGitHubApi(options.invocation, options.read);
  const before = await read();
  if (options.matches(before)) {
    return { value: before, attempts: 0, effect: "unchanged", reconciled: true };
  }
  const attempts = 1;
  const mutation = { started: false };
  let mutationAcknowledged = false;
  try {
    await callGitHubApi(options.invocation, async (control) =>
      options.mutate(control, () => {
        mutation.started = true;
      }),
    );
    mutationAcknowledged = true;
    const after = await read();
    if (!options.matches(after)) {
      throw new Error("GitHub mutation postcondition did not match the requested state");
    }
    return { value: after, attempts, effect: "updated", reconciled: true };
  } catch (error: unknown) {
    if (mutationAcknowledged) {
      throw new GitHubMutationExecutionError(attempts, false, "confirmed", {
        cause: error,
      });
    }
    if (!mutation.started || error instanceof GitHubEntityRevalidationError) {
      throw new GitHubMutationExecutionError(attempts, false, "none", { cause: error });
    }
    if (options.invocation.signal?.aborted === true || !isAmbiguousGitHubMutationError(error)) {
      const externalEffect = isAmbiguousGitHubMutationError(error) ? "possible" : "none";
      throw new GitHubMutationExecutionError(attempts, false, externalEffect, {
        cause: error,
      });
    }
    try {
      const value = await read();
      if (options.matches(value)) {
        return { value, attempts, effect: "updated", reconciled: true };
      }
      throw new GitHubMutationExecutionError(attempts, true, "possible", { cause: error });
    } catch (readError: unknown) {
      if (readError instanceof GitHubMutationExecutionError) throw readError;
      throw new GitHubMutationExecutionError(attempts, false, "possible", {
        cause: readError,
      });
    }
  }
}
