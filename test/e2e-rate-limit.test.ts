import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

interface DiagnosticStep {
  readonly name: string;
  readonly shell: string;
  readonly env: Readonly<Record<string, string>>;
  readonly run: string;
}

interface DiagnosticWorkflow {
  readonly name: string;
  readonly on: Readonly<Record<string, unknown>>;
  readonly permissions: Readonly<Record<string, string>>;
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly if: string;
        readonly "timeout-minutes": number;
        readonly steps: readonly DiagnosticStep[];
      }
    >
  >;
}

describe("independent Actions token rate-limit diagnostic", () => {
  let source: string;
  let workflow: DiagnosticWorkflow;
  let script: string;

  beforeAll(async () => {
    source = await readFile(
      new URL("../.github/workflows/e2e-rate-limit.yml", import.meta.url),
      "utf8",
    );
    workflow = parse(source) as DiagnosticWorkflow;
    const step = workflow.jobs.inspect?.steps[0];
    if (step === undefined) throw new Error("Missing quota diagnostic step");
    script = step.run;
  });

  it("is manually dispatched on main with no repository permissions or candidate execution", () => {
    expect(workflow.name).toBe("Actions token rate-limit diagnostic");
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(["inspect"]);
    expect(workflow.jobs.inspect?.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.inspect?.["timeout-minutes"]).toBe(2);
    expect(workflow.jobs.inspect?.steps).toHaveLength(1);
    expect(workflow.jobs.inspect?.steps[0]?.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    expect(source).not.toMatch(
      /uses:|checkout|secrets\.|inputs\.|environment:|Core E2E|deepseek/iu,
    );
    expect(source).not.toMatch(/permissions:\s*\n|contents:|actions:|checks:|pull-requests:/u);
    expect(script.match(/\bgh api\b/gu)).toHaveLength(1);
    expect(script).toContain('gh api --include rate_limit > "$response_file"');
    expect(script).not.toMatch(/gh workflow|gh run|sleep|while|retry|printenv|set -x/u);
  });

  it("prints only the successful status, quota counters, rate-limit headers, and reset time", async () => {
    const parser = /<<'NODE'\r?\n([\s\S]*?)\r?\nNODE(?:\r?\n)?$/u.exec(script)?.[1];
    if (parser === undefined) throw new Error("Missing quota response parser");
    const directory = await mkdtemp(join(tmpdir(), "dsh-rate-limit-"));
    try {
      const responsePath = join(directory, "response.txt");
      await writeFile(
        responsePath,
        [
          "HTTP/2.0 200 OK",
          "X-Ratelimit-Limit: 1000",
          "X-Ratelimit-Used: 1000",
          "X-Ratelimit-Remaining: 0",
          "X-Ratelimit-Reset: 1790592000",
          "X-Ratelimit-Resource: core",
          "X-Unrelated-Header: private-response-data",
          "",
          JSON.stringify({
            resources: {
              core: { limit: 1000, used: 999, remaining: 1, reset: 1790592000, extra: "private" },
              graphql: { limit: 5000 },
            },
            extra: "private-body-data",
          }),
        ].join("\r\n"),
      );
      const result = spawnSync(process.execPath, ["--input-type=module", "-", responsePath], {
        input: parser,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        status: 200,
        headers: {
          "x-ratelimit-limit": "1000",
          "x-ratelimit-used": "1000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1790592000",
          "x-ratelimit-resource": "core",
        },
        core: { limit: 1000, used: 999, remaining: 1, reset: 1790592000 },
        resetAt: "2026-09-28T10:40:00.000Z",
      });
      expect(result.stdout).not.toContain("private");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
