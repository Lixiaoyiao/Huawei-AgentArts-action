import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { buildDshPrompt } from "../src/dsh/prompt.js";
import type { GitHubClient } from "../src/github/client.js";
import type { PullRequestFileContext, PullRequestSnapshot } from "../src/github/fetch.js";
import { buildContextPacket } from "../src/orchestration/context.js";
import { inputs, pullRequestContext } from "./helpers.js";

function file(path: string, patch: string | undefined, source?: string): PullRequestFileContext {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    ...(patch === undefined ? {} : { patch }),
    patchMissing: patch === undefined,
    patchTruncated: false,
    ...(source === undefined ? {} : { source }),
    sourceTruncated: false,
  };
}

function snapshot(changedFiles: readonly PullRequestFileContext[]): PullRequestSnapshot {
  return {
    kind: "pull_request",
    number: 7,
    title: "A large PR",
    body: "",
    author: "alice",
    baseSha: "b".repeat(40),
    baseRef: "main",
    baseRepository: "octo/repo",
    baseRepositoryId: 1,
    headSha: "a".repeat(40),
    headRef: "feature",
    headRepository: "octo/repo",
    headRepositoryId: 1,
    draft: false,
    isFork: false,
    diffTruncated: false,
    changedFiles,
    comments: [],
  };
}

interface Projection {
  readonly changedFiles: readonly PullRequestFileContext[];
  readonly contextTruncated: boolean;
  readonly diffTruncated: boolean;
  readonly contextCoverage: {
    readonly changedFileCount: number;
    readonly includedFileCount: number;
    readonly omittedFileCount: number;
    readonly patchBytes: number;
    readonly sourceBytes: number;
    readonly patchesMissing: number;
  };
}

async function packet(value: PullRequestSnapshot) {
  return (await buildContextPacket(
    {} as GitHubClient,
    pullRequestContext(),
    {
      operation: "review",
      source: "automatic-event",
      instructions: "",
      requestedAccess: "read",
    },
    value,
    inputs(),
  )) as { readonly entity: Projection };
}

function encodedBytes(value: string | undefined): number {
  return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

describe("fair model context allocation", () => {
  it("keeps late source patches visible after large leading prose across the real worker prompt", async () => {
    const files = Array.from({ length: 73 }, (_, index) =>
      file(
        index < 4 ? `README-${String(index)}.md` : `src/change-${String(index)}.ts`,
        `@@ -1 +1 @@\n-PREVIOUS_${String(index)}\n+VISIBLE_CHANGE_${String(index)}\n${"+body\n".repeat(4_000)}`,
        "source prefix\n".repeat(4_000),
      ),
    );
    const original = snapshot(files);
    const before = structuredClone(original);
    const projected = await packet(original);
    expect(projected.entity.changedFiles).toHaveLength(73);
    for (const [index, changed] of projected.entity.changedFiles.entries()) {
      expect(changed.patch).toContain(`VISIBLE_CHANGE_${String(index)}`);
      expect(changed.patchTruncated).toBe(true);
    }
    expect(
      projected.entity.contextCoverage.patchBytes + projected.entity.contextCoverage.sourceBytes,
    ).toBeLessThanOrEqual(36 * 1024);
    const prompt = buildDshPrompt({
      operation: "review",
      prompt: JSON.stringify(projected),
      trust: "trusted-read",
      maxBytes: 96 * 1024,
    });
    expect(prompt).toContain("truncated=false");
    expect(prompt).toContain("VISIBLE_CHANGE_72");
    expect(prompt).toContain("src/change-72.ts");
    expect(original).toEqual(before);
  });

  it("returns short patch shares and spends remaining evidence budget on source only afterward", async () => {
    const projected = await packet(
      snapshot([
        file("short.ts", "@@ -1 +1 @@\n-old\n+new", "source one"),
        file("long.ts", "+large\n".repeat(5_000), "source two"),
      ]),
    );
    expect(projected.entity.changedFiles[0]?.patch).toBe("@@ -1 +1 @@\n-old\n+new");
    expect(projected.entity.changedFiles[0]?.source).toBe("source one");
    expect(projected.entity.changedFiles[1]?.source).toBe("source two");
    expect(encodedBytes(projected.entity.changedFiles[1]?.patch)).toBeGreaterThan(11 * 1024);
    expect(encodedBytes(projected.entity.changedFiles[1]?.patch)).toBeLessThanOrEqual(12 * 1024);
  });

  it("charges UTF-8 and JSON escaping, preserves 100 file metadata and keeps prose behind patch evidence", async () => {
    const files = Array.from({ length: 100 }, (_, index) =>
      file(
        `src/file-${String(index)}.ts`,
        `@@ -1 +1 @@\n+PATCH_${String(index)}🙂路径\n${'"\\\n🙂路径'.repeat(5_000)}`,
        "source".repeat(4_000),
      ),
    );
    const original = {
      ...snapshot(files),
      body: '"\\\n'.repeat(10_000),
      comments: Array.from({ length: 20 }, (_, index) => ({
        id: index + 1,
        author: "alice",
        body: '"\\\n'.repeat(3_000),
        createdAt: "2026-10-03T00:00:00Z",
        updatedAt: "2026-10-03T00:00:00Z",
      })),
    };
    const projected = await packet(original);
    expect(projected.entity.changedFiles.map(({ path }) => path)).toEqual(
      files.map(({ path }) => path),
    );
    let total = 0;
    for (const [index, changed] of projected.entity.changedFiles.entries()) {
      expect(changed.patch).toContain(`PATCH_${String(index)}🙂路径`);
      expect(changed.patch).not.toContain("�");
      expect(changed.source).not.toContain("�");
      total += encodedBytes(changed.patch) + encodedBytes(changed.source);
    }
    expect(total).toBeLessThanOrEqual(36 * 1024);
    expect(total).toBe(
      projected.entity.contextCoverage.patchBytes + projected.entity.contextCoverage.sourceBytes,
    );
    const prompt = buildDshPrompt({
      operation: "review",
      prompt: JSON.stringify(projected),
      trust: "untrusted",
      maxBytes: 96 * 1024,
    });
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(96 * 1024);
    expect(prompt).toContain("truncated=false");
    expect(prompt).toContain("PATCH_99🙂路径");
    expect(prompt).toContain("src/file-99.ts");
  });

  it("reports missing patches, inherited truncation and the existing 100-file projection limit", async () => {
    const files = Array.from({ length: 101 }, (_, index) =>
      file(`file-${String(index)}.ts`, undefined, "source"),
    );
    const projected = await packet(snapshot(files));
    expect(projected.entity.changedFiles).toHaveLength(100);
    expect(projected.entity.changedFiles[0]?.patch).toBeUndefined();
    expect(projected.entity.contextCoverage).toMatchObject({
      changedFileCount: 101,
      includedFileCount: 100,
      omittedFileCount: 1,
      patchesMissing: 100,
    });
    expect(projected.entity.diffTruncated).toBe(true);
    const sourceOnly = await packet(
      snapshot([
        { ...file("a.ts", "complete patch", "large".repeat(5_000)), sourceTruncated: true },
      ]),
    );
    expect(sourceOnly.entity.diffTruncated).toBe(false);
    expect(sourceOnly.entity.contextTruncated).toBe(true);
    expect(sourceOnly.entity.changedFiles[0]?.sourceTruncated).toBe(true);
  });

  it("keeps the trusted review workflow read-only and makes its coverage instructions explicit", async () => {
    const workflow = YAML.parse(
      await readFile(new URL("../.github/workflows/review.yml", import.meta.url), "utf8"),
    ) as {
      jobs: {
        review: {
          "timeout-minutes": number;
          steps: { uses: string; with: Record<string, string | boolean> }[];
        };
      };
      permissions: Record<string, string>;
    };
    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "write" });
    expect(workflow.jobs.review["timeout-minutes"]).toBe(30);
    expect(workflow.jobs.review.steps[0]?.with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
    });
    const action = workflow.jobs.review.steps.find((step) => step.uses === "./");
    expect(action?.with).toMatchObject({
      command: "review",
      "allow-write": "false",
      "max-findings": "10",
    });
    expect(action?.with.prompt).toContain("contextTruncated");
    expect(action?.with.prompt).toContain("not proof that a file was completely reviewed");
    expect(action?.with["max-turns"]).toBeUndefined();
  });
});
