import { describe, expect, it, vi } from "vitest";

import { createRequestPolicy, GitHubQuotaError } from "../src/github/request-policy.js";
import {
  isAmbiguousGitHubMutationError,
  mutateGitHubWithPostcondition,
} from "../src/tools/github-gateway-mutation.js";

describe("GitHub mutation quota and unknown-effect safety", () => {
  it.each([403, 429])(
    "sends a quota-rejected write once (%s) and preserves a definite rejection",
    async (status) => {
      const policy = createRequestPolicy();
      const write = vi.fn().mockRejectedValue(
        Object.assign(new Error("quota"), {
          status,
          response: { headers: { "x-ratelimit-remaining": "0" } },
        }),
      );
      const read = vi.fn(() => Promise.resolve(false));
      const operation = mutateGitHubWithPostcondition({
        invocation: { deadlineMs: Date.now() + 60_000 },
        read,
        mutate: async (_, markStarted) => {
          markStarted();
          await policy.run(write, { method: "POST", url: "/repos/o/r/issues" });
        },
        matches: Boolean,
      });
      await expect(operation).rejects.toMatchObject({
        attempts: 1,
        externalEffect: "none",
        cause: { code: "GITHUB_QUOTA_EXHAUSTED", status },
      });
      expect(write).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledOnce();
      expect(isAmbiguousGitHubMutationError(new GitHubQuotaError(policy.snapshot(), status))).toBe(
        false,
      );
    },
  );

  it("reconciles a transport failure with a fresh read without resending the write", async () => {
    const read = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const mutate = vi.fn((_, markStarted: () => void) => {
      markStarted();
      return Promise.reject(new Error("connection lost"));
    });
    await expect(
      mutateGitHubWithPostcondition({
        invocation: { deadlineMs: Date.now() + 60_000 },
        read,
        mutate,
        matches: Boolean,
      }),
    ).rejects.toMatchObject({ attempts: 1, reconciled: true, externalEffect: "possible" });
    expect(mutate).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
