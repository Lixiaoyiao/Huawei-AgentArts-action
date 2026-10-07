import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubContext } from "../src/github/context.js";
import { runUrl } from "../src/orchestration/context.js";
import { executionContextLinkLabel } from "../src/github/execution-context.js";

const context: GitHubContext = {
  kind: "entity",
  rawEventName: "pull_request",
  eventName: "pull_request",
  runId: "123",
  actor: "alice",
  repository: { id: 1, owner: "octo", repo: "repo", fullName: "octo/repo" },
  payload: {},
  entityNumber: 7,
  isPullRequest: true,
  isPullRequestTarget: false,
};
afterEach(() => vi.unstubAllEnvs());
describe("trusted local execution context", () => {
  it("retains the real Actions URL and label by default", () => {
    vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
    expect(runUrl(context)).toBe("https://github.com/octo/repo/actions/runs/123");
    expect(executionContextLinkLabel(runUrl(context))).toBe("Workflow run");
  });
  it("binds an explicitly local context to this exact entity", () => {
    vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
    const url = runUrl(context, "https://github.com/octo/repo/pull/7");
    expect(url).toBe("https://github.com/octo/repo/pull/7");
    expect(executionContextLinkLabel(url)).toBe("Execution context");
  });
  it.each([
    "https://github.com/other/repo/pull/7",
    "https://github.com/octo/repo/pull/8",
    "https://github.com/octo/repo/issues/7",
    "https://github.com/octo/repo/pull/7?token=secret",
    "https://evil.example/octo/repo/pull/7",
    "javascript:alert(1)",
  ])("rejects a different entity, origin or extra URL data: %s", (url) => {
    vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
    expect(() => runUrl(context, url)).toThrow("bound GitHub entity");
  });
});
