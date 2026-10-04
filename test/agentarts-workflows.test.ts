import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Inherited workflow admission on the derivative repository", () => {
  it("keeps every inherited model/write automation restricted to its original repository without broken folded conditions", async () => {
    for (const name of [
      "review",
      "commands",
      "ci-diagnose",
      "dsh-upstream-canary",
      "release-canary",
      "e2e",
      "session-e2e",
      "e2e-rate-limit",
    ]) {
      const source = await readFile(
        new URL(`../.github/workflows/${name}.yml`, import.meta.url),
        "utf8",
      );
      const workflow = parse(source) as { jobs: Record<string, { if?: string }> };
      for (const job of Object.values(workflow.jobs)) {
        expect(job.if).toContain("github.repository == 'Lixiaoyiao/deepseek-harness-action'");
        expect(job.if).not.toMatch(/\(>[-+]?\)/u);
      }
    }
  });
});
