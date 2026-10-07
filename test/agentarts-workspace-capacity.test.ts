import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createWorkspaceSnapshot } from "../src/write/workspace.js";
import {
  packWorkspaceSnapshot,
  materializeWorkspaceManifest,
  WORKSPACE_TRANSFER_LIMITS,
} from "../src/agentarts/workspace-transfer.js";

it("packs the actual tracked derivative repository and faithfully restores large tracked bundles within the explicit envelope", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agentarts-self-capacity-"));
  let previous = Date.now();
  const trace = (phase: string) => {
    const completed = Date.now();
    if (process.env.AGENTARTS_TRACE_CAPACITY === "1")
      process.stdout.write(
        `${JSON.stringify({ event: "capacity.phase", phase, durationMs: completed - previous })}\n`,
      );
    previous = completed;
  };
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
    });
    const headSha = stdout.trim();
    const snapshot = await createWorkspaceSnapshot(
      { kind: "git-checkout", root: process.cwd() },
      join(temporary, "worker"),
    );
    trace("original-snapshot");
    const manifest = await packWorkspaceSnapshot(snapshot, {
      repository: "Lixiaoyiao/Huawei-AgentArts-action",
      baseSha: headSha,
      headSha,
      revision: 0,
    });
    trace("pack-complete-manifest");
    expect(manifest.files.length).toBe(snapshot.baseline.size);
    expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThanOrEqual(
      WORKSPACE_TRANSFER_LIMITS.maxPayloadBytes,
    );
    expect(
      manifest.files.some(
        (file) => file.path === "dist/index.js.map" && file.encoding === "gzip-base64",
      ),
    ).toBe(true);
    const restored = join(temporary, "restored");
    await materializeWorkspaceManifest(manifest, restored);
    trace("validate-materialize-recapture");
    // Comparison uses original bytes, rather than accepting a self-reported compression ratio.
    for (const name of [
      "dist/index.js.map",
      "dist-agentarts/controller/index.js",
      "src/orchestrator.ts",
    ])
      // Buffer.equals compares the complete original bytes in native code.
      // A generic deep matcher visits tens of millions of individual indices,
      // dominating coverage runtime while proving the same byte equality.
      expect(
        (await readFile(join(restored, ...name.split("/")))).equals(
          await readFile(join(snapshot.workerRoot, ...name.split("/"))),
        ),
      ).toBe(true);
    trace("original-byte-comparison");
  } finally {
    await rm(temporary, { recursive: true, force: true });
    trace("cleanup");
  }
}, 60_000);
