import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";
import type * as Integrity from "../src/write/validation-integrity.js";

import {
  createWorkspaceSnapshot,
  fingerprintWorkspace,
  inspectWorkspaceChanges,
  type WorkspaceSnapshot,
} from "../src/write/workspace.js";
import {
  applyWorkspaceDelta,
  createWorkspaceDelta,
  materializeWorkspaceManifest,
  packWorkspaceSnapshot,
  type WorkspaceTransferBinding,
  type WorkspaceTransferDelta,
  type WorkspaceTransferManifest,
} from "../src/agentarts/workspace-transfer.js";

// Offline real filesystem prototype. Neither DSH, cloud, commands nor GitHub APIs run.
const faults = vi.hoisted(() => ({
  writeName: "",
  failInstall: false,
  failRollback: false,
  sourceDriftPath: "",
  sourceDriftAfterIntegrity: "",
  cancelPhase: "",
  controller: undefined as AbortController | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FsPromises>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const path = typeof args[0] === "string" ? args[0] : "";
      if (
        faults.writeName &&
        path.includes(".agentarts-workspace-transfer-") &&
        basename(path) === faults.writeName
      )
        throw new Error("Injected staging write failure");
      await actual.writeFile(...args);
      if (faults.sourceDriftPath && path.includes(".agentarts-workspace-transfer-")) {
        const source = faults.sourceDriftPath;
        faults.sourceDriftPath = "";
        await actual.writeFile(source, "independent source drift during staging");
      }
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const path = String(args[0]);
      if (
        faults.failInstall &&
        path.includes(".agentarts-workspace-transfer-") &&
        basename(path) === "candidate"
      ) {
        faults.failInstall = false;
        throw new Error("Injected installation rename failure");
      }
      if (
        faults.failRollback &&
        path.includes(".agentarts-workspace-transfer-") &&
        basename(path) === "backup"
      ) {
        faults.failRollback = false;
        throw new Error("Injected rollback I/O failure");
      }
      await actual.rename(...args);
      if (
        (faults.cancelPhase === "backup" && basename(String(args[1])) === "backup") ||
        (faults.cancelPhase === "candidate" && basename(path) === "candidate")
      ) {
        faults.cancelPhase = "";
        faults.controller?.abort(new Error("Scoped transfer cancellation"));
      }
    },
  };
});
vi.mock("../src/write/validation-integrity.js", async (original) => {
  const actual = await original<typeof Integrity>();
  return {
    ...actual,
    enforceValidationIntegrity: async (
      ...args: Parameters<typeof actual.enforceValidationIntegrity>
    ) => {
      const result = await actual.enforceValidationIntegrity(...args);
      if (faults.sourceDriftAfterIntegrity) {
        const path = faults.sourceDriftAfterIntegrity;
        faults.sourceDriftAfterIntegrity = "";
        await writeFile(path, "independent source drift after integrity classification");
      }
      return result;
    },
  };
});

let root: string;
const binding: WorkspaceTransferBinding = {
  repository: "fixture/repo",
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  revision: 0,
};
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentarts-transfer-test-"));
  faults.writeName = "";
  faults.failInstall = false;
  faults.failRollback = false;
  faults.sourceDriftPath = "";
  faults.sourceDriftAfterIntegrity = "";
  faults.cancelPhase = "";
  faults.controller = undefined;
});
afterEach(async () => {
  faults.writeName = "";
  faults.failInstall = false;
  faults.failRollback = false;
  faults.sourceDriftPath = "";
  faults.sourceDriftAfterIntegrity = "";
  faults.cancelPhase = "";
  faults.controller = undefined;
  await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<WorkspaceSnapshot> {
  const source = join(root, "source"),
    worker = join(root, "worker");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src/text.txt"), "original text\n");
  await writeFile(join(source, "src/binary.bin"), Buffer.from([0, 255, 1, 128, 42]));
  await writeFile(join(source, "removed.txt"), "delete candidate\n");
  return await createWorkspaceSnapshot({ kind: "materialized-tree", root: source }, worker);
}
async function remote(input: WorkspaceTransferManifest): Promise<string> {
  const path = join(root, "remote");
  await materializeWorkspaceManifest(input, path);
  return path;
}
async function modified(
  snapshot: WorkspaceSnapshot,
): Promise<{ input: WorkspaceTransferManifest; delta: WorkspaceTransferDelta }> {
  const input = await packWorkspaceSnapshot(snapshot, binding);
  const worker = await remote(input);
  await writeFile(join(worker, "src/text.txt"), "modified text\n");
  await writeFile(join(worker, "src/binary.bin"), Buffer.from([255, 0, 42, 7]));
  await mkdir(join(worker, "new"));
  await writeFile(join(worker, "new/added.txt"), "actual added text\n");
  await writeFile(join(worker, "new/added.bin"), Buffer.from([0, 7, 254]));
  await rm(join(worker, "removed.txt"));
  return { input, delta: await createWorkspaceDelta(input, worker) };
}
async function unchanged(
  snapshot: WorkspaceSnapshot,
  workerFingerprint: string,
  sourceFingerprint: string,
) {
  expect(await fingerprintWorkspace(snapshot.workerRoot)).toBe(workerFingerprint);
  expect(await fingerprintWorkspace(snapshot.sourceRoot)).toBe(sourceFingerprint);
}
function rehash(value: WorkspaceTransferManifest): WorkspaceTransferManifest {
  const body = { schemaVersion: value.schemaVersion, binding: value.binding, files: value.files };
  return { ...body, digest: hash(JSON.stringify(body)) };
}

describe("Workspace transfer prototype (offline actual files, no cloud fix integration)", () => {
  it("uses canonical metadata field order across serialized and schema-parsed manifests", async () => {
    const snapshot = await fixture();
    const input = await packWorkspaceSnapshot(snapshot, binding);
    const reordered = {
      digest: input.digest,
      files: input.files.map((file) => ({
        content: file.content,
        encoding: file.encoding,
        mode: file.mode,
        sha256: file.sha256,
        path: file.path,
      })),
      binding: {
        revision: input.binding.revision,
        headSha: input.binding.headSha,
        baseSha: input.binding.baseSha,
        repository: input.binding.repository,
      },
      schemaVersion: 1,
    };
    await materializeWorkspaceManifest(reordered, join(root, "reordered"));
    const copied = await createWorkspaceDelta(input, join(root, "reordered"));
    expect(copied.changes).toEqual([]);
  });
  it("round trips complete text and binary files and returns real additions, modifications and deletion", async () => {
    const snapshot = await fixture();
    const sourceBefore = await fingerprintWorkspace(snapshot.sourceRoot);
    const baseline = snapshot.baseline;
    const baselineBefore = [...baseline.entries()];
    const { input, delta } = await modified(snapshot);
    expect(input.files.find((file) => file.path === "src/text.txt")).toMatchObject({
      encoding: "utf8",
      content: "original text\n",
    });
    expect(input.files.find((file) => file.path === "src/binary.bin")).toMatchObject({
      encoding: "base64",
      sha256: hash(Buffer.from([0, 255, 1, 128, 42])),
    });
    expect(delta.changes.map((change) => change.kind).sort()).toEqual([
      "added",
      "added",
      "deleted",
      "modified",
      "modified",
    ]);
    const result = await applyWorkspaceDelta(snapshot, input, delta);
    expect(result.manifest.binding.revision).toBe(1);
    expect(result.manifest.digest).toBe(delta.resultDigest);
    expect(result.changes).toEqual({
      added: ["new/added.bin", "new/added.txt"],
      modified: ["src/binary.bin", "src/text.txt"],
      deleted: ["removed.txt"],
      all: ["new/added.bin", "new/added.txt", "removed.txt", "src/binary.bin", "src/text.txt"],
    });
    expect(await readFile(join(snapshot.workerRoot, "src/text.txt"), "utf8")).toBe(
      "modified text\n",
    );
    expect(await readFile(join(snapshot.workerRoot, "src/binary.bin"))).toEqual(
      Buffer.from([255, 0, 42, 7]),
    );
    expect(await readFile(join(snapshot.workerRoot, "new/added.bin"))).toEqual(
      Buffer.from([0, 7, 254]),
    );
    await expect(readFile(join(snapshot.workerRoot, "removed.txt"))).rejects.toThrow();
    expect(snapshot.baseline).toBe(baseline);
    expect([...snapshot.baseline.entries()]).toEqual(baselineBefore);
    expect(await fingerprintWorkspace(snapshot.sourceRoot)).toBe(sourceBefore);
    expect(result.validationIntegrity).toMatchObject({ mode: "strict", status: "clean" });
    expect(result.cleanupWarnings).toEqual([]);
  });

  it("preserves cumulative upstream changes across separately bound repair revisions", async () => {
    const snapshot = await fixture();
    const { input, delta } = await modified(snapshot);
    const first = await applyWorkspaceDelta(snapshot, input, delta);
    const nextRemote = join(root, "second-remote");
    await materializeWorkspaceManifest(first.manifest, nextRemote);
    await writeFile(join(nextRemote, "new/added.txt"), "second revision\n");
    const nextDelta = await createWorkspaceDelta(first.manifest, nextRemote);
    const next = await applyWorkspaceDelta(snapshot, first.manifest, nextDelta);
    expect(next.manifest.binding.revision).toBe(2);
    expect(next.changes).toEqual(first.changes);
    expect(await inspectWorkspaceChanges(snapshot)).toEqual(first.changes);
  });

  it.each(["repository", "baseSha", "headSha", "revision"] as const)(
    "rejects a different %s binding without changing either root",
    async (field) => {
      const snapshot = await fixture();
      const before = await fingerprintWorkspace(snapshot.workerRoot),
        source = await fingerprintWorkspace(snapshot.sourceRoot);
      const { input, delta } = await modified(snapshot);
      const altered = {
        ...delta,
        binding: {
          ...delta.binding,
          [field]:
            field === "repository" ? "other/repo" : field === "revision" ? 1 : "c".repeat(40),
        },
      };
      await expect(applyWorkspaceDelta(snapshot, input, altered)).rejects.toThrow(
        /binding mismatch/u,
      );
      await unchanged(snapshot, before, source);
    },
  );

  it.each(["inputDigest", "resultDigest"] as const)(
    "rejects the wrong %s without partial installation",
    async (field) => {
      const snapshot = await fixture();
      const before = await fingerprintWorkspace(snapshot.workerRoot),
        source = await fingerprintWorkspace(snapshot.sourceRoot);
      const { input, delta } = await modified(snapshot);
      await expect(
        applyWorkspaceDelta(snapshot, input, { ...delta, [field]: "f".repeat(64) }),
      ).rejects.toThrow(/digest|binding/u);
      await unchanged(snapshot, before, source);
    },
  );

  it("rejects corrupted input content and an incorrect manifest digest", async () => {
    const snapshot = await fixture();
    const input = await packWorkspaceSnapshot(snapshot, binding);
    await expect(
      materializeWorkspaceManifest({ ...input, digest: "f".repeat(64) }, join(root, "bad")),
    ).rejects.toThrow(/manifest digest/u);
    const corrupt = structuredClone(input);
    const file = corrupt.files[0];
    expect(file).toBeDefined();
    if (file === undefined) throw new Error("Missing fixture");
    file.content += "corrupt";
    await expect(materializeWorkspaceManifest(corrupt, join(root, "bad"))).rejects.toThrow(
      /hash|base64/u,
    );
    expect(await readdir(root)).toEqual(["source", "worker"]);
  });

  it.each(["sha256", "mode"] as const)(
    "checks every original %s before any modification",
    async (field) => {
      const snapshot = await fixture();
      const before = await fingerprintWorkspace(snapshot.workerRoot),
        source = await fingerprintWorkspace(snapshot.sourceRoot);
      const { input, delta } = await modified(snapshot);
      const corrupt = structuredClone(delta);
      const change = corrupt.changes.find((item) => item.kind === "modified");
      if (change?.kind !== "modified") throw new Error("Missing modification fixture");
      if (field === "sha256") change.original.sha256 = "f".repeat(64);
      else change.original.mode = 0;
      await expect(applyWorkspaceDelta(snapshot, input, corrupt)).rejects.toThrow(
        /original file hash or mode/u,
      );
      await unchanged(snapshot, before, source);
    },
  );

  it.each([
    "../escape",
    "/absolute",
    "a\\b",
    "folder/.git/config",
    "x:stream",
    "nul.txt",
    "trailing.",
  ])("rejects unsafe path %s before staging", async (path) => {
    const snapshot = await fixture();
    const before = await fingerprintWorkspace(snapshot.workerRoot),
      source = await fingerprintWorkspace(snapshot.sourceRoot);
    const { input, delta } = await modified(snapshot);
    const changed = structuredClone(delta);
    const addition = changed.changes.find((item) => item.kind === "added");
    if (addition?.kind !== "added") throw new Error("Missing addition fixture");
    addition.file.path = path;
    await expect(applyWorkspaceDelta(snapshot, input, changed)).rejects.toThrow();
    await unchanged(snapshot, before, source);
  });

  it("rejects duplicate/aliased changes and file-as-parent conflicts", async () => {
    const snapshot = await fixture();
    const { input, delta } = await modified(snapshot);
    const before = await fingerprintWorkspace(snapshot.workerRoot),
      source = await fingerprintWorkspace(snapshot.sourceRoot);
    await expect(
      applyWorkspaceDelta(snapshot, input, {
        ...delta,
        changes: [...delta.changes, delta.changes[0]],
      }),
    ).rejects.toThrow(/duplicate/u);
    const conflict = structuredClone(input);
    const file = input.files[0];
    if (file === undefined) throw new Error("Missing fixture");
    conflict.files.push({ ...file, path: `${file.path}/child` });
    await expect(
      materializeWorkspaceManifest(rehash(conflict), join(root, "conflict")),
    ).rejects.toThrow(/parent/u);
    const alias = structuredClone(input);
    alias.files.push({ ...file, path: file.path.toUpperCase() });
    await expect(materializeWorkspaceManifest(rehash(alias), join(root, "alias"))).rejects.toThrow(
      /aliased/u,
    );
    await unchanged(snapshot, before, source);
  });

  it("applies Controller allowed-path and change-count bounds", async () => {
    const snapshot = await fixture();
    const { input, delta } = await modified(snapshot);
    const before = await fingerprintWorkspace(snapshot.workerRoot),
      source = await fingerprintWorkspace(snapshot.sourceRoot);
    await expect(
      applyWorkspaceDelta(snapshot, input, delta, { allowedPaths: ["src/text.txt"] }),
    ).rejects.toThrow(/path grant/u);
    await expect(
      applyWorkspaceDelta(snapshot, input, delta, { limits: { maxChanges: 1 } }),
    ).rejects.toThrow(/change count/u);
    await unchanged(snapshot, before, source);
  });

  it.each([
    ".github/workflows/test.yml",
    ".github/actions/test/action.yml",
    ".dsh/config.json",
    ".agents/rules.txt",
    "CODEOWNERS",
    "action.yml",
    ".gitmodules",
    ".github/dependabot.yml",
    "SECURITY.md",
  ])(
    "reuses protected-path policy at Supervisor and Controller boundaries for %s",
    async (path) => {
      const snapshot = await fixture();
      const { input, delta } = await modified(snapshot);
      const remoteRoot = join(root, "protected-remote");
      await materializeWorkspaceManifest(input, remoteRoot);
      const segments = path.split("/");
      if (segments.length > 1)
        await mkdir(join(remoteRoot, ...segments.slice(0, -1)), { recursive: true });
      await writeFile(join(remoteRoot, ...segments), "actual protected change");
      await expect(createWorkspaceDelta(input, remoteRoot)).rejects.toThrow(/Protected path/u);
      const addition = delta.changes.find((change) => change.kind === "added");
      if (addition?.kind !== "added") throw new Error("Missing added fixture");
      addition.file.path = path;
      const before = await fingerprintWorkspace(snapshot.workerRoot),
        source = await fingerprintWorkspace(snapshot.sourceRoot);
      await expect(applyWorkspaceDelta(snapshot, input, delta)).rejects.toThrow(/Protected path/u);
      await unchanged(snapshot, before, source);
      expect(
        (await readdir(root)).filter((name) => name.startsWith(".agentarts-workspace-transfer-")),
      ).toEqual([]);
    },
  );

  it.each(["added", "modified", "deleted", "mode"] as const)(
    "rejects original source %s drift before staging",
    async (kind) => {
      const snapshot = await fixture();
      const { input, delta } = await modified(snapshot);
      const sourceFile = join(snapshot.sourceRoot, "src/text.txt");
      if (kind === "added")
        await writeFile(join(snapshot.sourceRoot, "unexpected.txt"), "external addition");
      else if (kind === "modified") await writeFile(sourceFile, "external source modification");
      else if (kind === "deleted") await rm(sourceFile);
      else await chmod(sourceFile, 0o444);
      const before = await fingerprintWorkspace(snapshot.workerRoot),
        source = await fingerprintWorkspace(snapshot.sourceRoot),
        baseline = [...snapshot.baseline.entries()];
      await expect(applyWorkspaceDelta(snapshot, input, delta)).rejects.toThrow(
        /source workspace.*baseline/u,
      );
      await unchanged(snapshot, before, source);
      expect([...snapshot.baseline.entries()]).toEqual(baseline);
      expect(
        (await readdir(root)).filter((name) => name.startsWith(".agentarts-workspace-transfer-")),
      ).toEqual([]);
    },
  );

  it("rejects source drift introduced while staging before integrity inspection or installation", async () => {
    const snapshot = await fixture();
    const { input, delta } = await modified(snapshot);
    const before = await fingerprintWorkspace(snapshot.workerRoot),
      baseline = [...snapshot.baseline.entries()];
    faults.sourceDriftPath = join(snapshot.sourceRoot, "src/text.txt");
    await expect(applyWorkspaceDelta(snapshot, input, delta)).rejects.toThrow(
      /source workspace.*baseline/u,
    );
    expect(await fingerprintWorkspace(snapshot.workerRoot)).toBe(before);
    expect(await readFile(join(snapshot.sourceRoot, "src/text.txt"), "utf8")).toBe(
      "independent source drift during staging",
    );
    expect([...snapshot.baseline.entries()]).toEqual(baseline);
    expect(
      (await readdir(root)).filter((name) => name.startsWith(".agentarts-workspace-transfer-")),
    ).toEqual([]);
  });

  it("rechecks the original source after integrity classification immediately before replacement", async () => {
    const snapshot = await fixture();
    const { input, delta } = await modified(snapshot);
    const before = await fingerprintWorkspace(snapshot.workerRoot),
      baseline = [...snapshot.baseline.entries()];
    faults.sourceDriftAfterIntegrity = join(snapshot.sourceRoot, "src/text.txt");
    await expect(applyWorkspaceDelta(snapshot, input, delta)).rejects.toThrow(
      /source workspace.*baseline/u,
    );
    expect(await fingerprintWorkspace(snapshot.workerRoot)).toBe(before);
    expect(await readFile(join(snapshot.sourceRoot, "src/text.txt"), "utf8")).toBe(
      "independent source drift after integrity classification",
    );
    expect([...snapshot.baseline.entries()]).toEqual(baseline);
    expect(
      (await readdir(root)).filter((name) => name.startsWith(".agentarts-workspace-transfer-")),
    ).toEqual([]);
  });

  it("rejects a late invalid file after examining earlier additions without touching the Controller tree", async () => {
    const snapshot = await fixture();
    const { input, delta } = await modified(snapshot);
    const last = delta.changes.find(
      (change) => change.kind === "modified" && change.file.path === "src/text.txt",
    );
    if (last?.kind !== "modified") throw new Error("Missing last-file fixture");
    last.file.sha256 = "f".repeat(64);
    const before = await fingerprintWorkspace(snapshot.workerRoot),
      source = await fingerprintWorkspace(snapshot.sourceRoot);
    await expect(applyWorkspaceDelta(snapshot, input, delta)).rejects.toThrow(/content hash/u);
    await unchanged(snapshot, before, source);
    expect(
      (await readdir(root)).filter((name) => name.startsWith(".agentarts-workspace-transfer-")),
    ).toEqual([]);
  });

  it("omits only upstream generated roots and refuses ordinary files over the declared bounds", async () => {
    const snapshot = await fixture();
    await mkdir(join(snapshot.workerRoot, "node_modules/pkg"), { recursive: true });
    await writeFile(
      join(snapshot.workerRoot, "node_modules/pkg/data.txt"),
      "captured, not silently ignored",
    );
    const normal = await packWorkspaceSnapshot(snapshot, binding);
    expect(normal.files.some((file) => file.path.startsWith("node_modules/"))).toBe(false);
    expect(normal.files.map((file) => file.path)).toEqual([
      "removed.txt",
      "src/binary.bin",
      "src/text.txt",
    ]);
    const manifest = await packWorkspaceSnapshot(snapshot, binding, {
      excludeGeneratedRoots: false,
    });
    expect(manifest.files.some((file) => file.path === "node_modules/pkg/data.txt")).toBe(true);
    await expect(
      packWorkspaceSnapshot(snapshot, binding, {
        excludeGeneratedRoots: false,
        limits: { maxFiles: 3 },
      }),
    ).rejects.toThrow(/file count/u);
    await expect(
      packWorkspaceSnapshot(snapshot, binding, { limits: { maxPayloadBytes: 100 } }),
    ).rejects.toThrow(/byte limit/u);
    await expect(
      packWorkspaceSnapshot(snapshot, binding, { limits: { maxFiles: 5001 } }),
    ).rejects.toThrow(/narrow/u);
    const remoteRoot = join(root, "remote-generated");
    await materializeWorkspaceManifest(manifest, remoteRoot, { excludeGeneratedRoots: false });
    await writeFile(
      join(remoteRoot, "node_modules/pkg/data.txt"),
      "unobserved generated-root modification",
    );
    await expect(
      createWorkspaceDelta(manifest, remoteRoot, { excludeGeneratedRoots: false }),
    ).rejects.toThrow(/generated roots/u);
  });

  it.each(["backup", "candidate"])(
    "rolls back cancellation after the %s directory rename without publishing or leaving late changes",
    async (phase) => {
      const snapshot = await fixture(),
        { input, delta } = await modified(snapshot);
      const before = await fingerprintWorkspace(snapshot.workerRoot),
        source = await fingerprintWorkspace(snapshot.sourceRoot);
      const controller = new AbortController();
      faults.controller = controller;
      faults.cancelPhase = phase;
      await expect(
        applyWorkspaceDelta(snapshot, input, delta, {
          signal: controller.signal,
          deadlineMs: Date.now() + 60_000,
        }),
      ).rejects.toThrow(/Scoped transfer cancellation/u);
      await unchanged(snapshot, before, source);
      expect(
        (await readdir(root)).filter((name) => name.startsWith(".agentarts-workspace-transfer-")),
      ).toEqual([]);
    },
  );
  it("rejects cancellation and expired deadline before staging and serializes competing imports", async () => {
    const snapshot = await fixture(),
      { input, delta } = await modified(snapshot);
    const before = await fingerprintWorkspace(snapshot.workerRoot),
      source = await fingerprintWorkspace(snapshot.sourceRoot);
    const controller = new AbortController();
    controller.abort();
    await expect(
      applyWorkspaceDelta(snapshot, input, delta, { signal: controller.signal }),
    ).rejects.toThrow();
    await expect(
      applyWorkspaceDelta(snapshot, input, delta, { deadlineMs: Date.now() - 1 }),
    ).rejects.toThrow(/deadline/u);
    await unchanged(snapshot, before, source);
    const applying = applyWorkspaceDelta(snapshot, input, delta);
    await expect(applyWorkspaceDelta(snapshot, input, delta)).rejects.toThrow(/another import/u);
    await applying;
    await expect(applyWorkspaceDelta(snapshot, input, delta)).rejects.toThrow(/no longer matches/u);
    expect(await fingerprintWorkspace(snapshot.sourceRoot)).toBe(source);
  });

  it("refuses .git rather than treating it as an ignored directory", async () => {
    const snapshot = await fixture();
    await mkdir(join(snapshot.workerRoot, ".git"));
    await writeFile(join(snapshot.workerRoot, ".git/config"), "private metadata");
    await expect(packWorkspaceSnapshot(snapshot, binding)).rejects.toThrow(/\.git/u);
  });
  it("transfers large text and binary bytes through explicit compression without dropping ordinary files", async () => {
    const snapshot = await fixture(),
      text = "large ordinary source content\n".repeat(20_000),
      binary = Buffer.alloc(700_000, 0xff);
    await writeFile(join(snapshot.workerRoot, "large.txt"), text);
    await writeFile(join(snapshot.workerRoot, "large.bin"), binary);
    const input = await packWorkspaceSnapshot(snapshot, binding);
    expect(
      input.files.filter((file) => file.path.startsWith("large.")).map((file) => file.encoding),
    ).toEqual(["gzip-base64", "gzip-base64"]);
    const copied = await remote(input);
    expect(await readFile(join(copied, "large.txt"), "utf8")).toBe(text);
    expect((await readFile(join(copied, "large.bin"))).equals(binary)).toBe(true);
    expect(input.files.find((file) => file.path === "large.txt")?.sha256).toBe(hash(text));
  });
  it("faithfully transfers medium escaped JSON text and binary without retaining the old large-file threshold", async () => {
    const snapshot = await fixture(),
      text = (JSON.stringify({ 说明: '会议\\路径\n"quoted"' }) + "\n").repeat(500),
      binary = Buffer.alloc(12_000, 0xff),
      entropy = Buffer.concat(
        Array.from({ length: 512 }, (_, index) =>
          createHash("sha256")
            .update(`json-wire-${String(index)}`)
            .digest(),
        ),
      ),
      alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" +
        ['"', "\\", "\n"].join("").repeat(7),
      escaped = Array.from(entropy, (value) => alphabet[value % alphabet.length] ?? "").join("");
    await writeFile(join(snapshot.workerRoot, "medium.json"), text);
    await writeFile(join(snapshot.workerRoot, "medium.bin"), binary);
    // Fixed high-entropy text: JSON escaping changes the useful wire saving,
    // rather than relying only on a highly repetitive string compressing well.
    await writeFile(join(snapshot.workerRoot, "medium-escaped.txt"), escaped);
    expect(Buffer.byteLength(text)).toBeLessThan(256 * 1024);
    const input = await packWorkspaceSnapshot(snapshot, binding);
    expect(
      input.files.filter((file) => file.path.startsWith("medium")).map((file) => file.encoding),
    ).toEqual(["gzip-base64", "gzip-base64", "gzip-base64"]);
    expect(input.files).toHaveLength(snapshot.baseline.size + 3);
    const copied = await remote(input);
    expect((await readFile(join(copied, "medium.json"))).equals(Buffer.from(text))).toBe(true);
    expect((await readFile(join(copied, "medium.bin"))).equals(binary)).toBe(true);
    expect((await readFile(join(copied, "medium-escaped.txt"))).equals(Buffer.from(escaped))).toBe(
      true,
    );
    expect((await createWorkspaceDelta(input, copied)).changes).toEqual([]);
  });
  it("keeps unchanged file representations stable when an edited file crosses the compression threshold in both directions", async () => {
    const source = join(root, "source"),
      small = "a".repeat(4095),
      large = "a".repeat(16_000),
      stable = (JSON.stringify({ unchanged: '真实记录\n"quoted"' }) + "\n").repeat(400);
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "src/edited.txt"), small);
    await writeFile(join(source, "stable.json"), stable);
    const snapshot = await createWorkspaceSnapshot(
      { kind: "materialized-tree", root: source },
      join(root, "worker"),
    );
    const sourceBefore = await fingerprintWorkspace(source),
      input = await packWorkspaceSnapshot(snapshot, binding),
      worker = await remote(input);
    expect(input.files.find((file) => file.path === "src/edited.txt")?.encoding).toBe("utf8");
    await writeFile(join(worker, "src/edited.txt"), large);
    const delta = await createWorkspaceDelta(input, worker);
    expect(
      delta.changes.map((change) =>
        change.kind === "deleted" ? change.original.path : change.file.path,
      ),
    ).toEqual(["src/edited.txt"]);
    const first = await applyWorkspaceDelta(snapshot, input, delta);
    expect(first.manifest.files.find((file) => file.path === "src/edited.txt")?.encoding).toBe(
      "gzip-base64",
    );
    expect(first.manifest.files.find((file) => file.path === "stable.json")).toEqual(
      input.files.find((file) => file.path === "stable.json"),
    );
    const secondWorker = join(root, "remote-second");
    await materializeWorkspaceManifest(first.manifest, secondWorker);
    await writeFile(join(secondWorker, "src/edited.txt"), small);
    const secondDelta = await createWorkspaceDelta(first.manifest, secondWorker),
      second = await applyWorkspaceDelta(snapshot, first.manifest, secondDelta);
    expect(second.manifest.files.find((file) => file.path === "src/edited.txt")?.encoding).toBe(
      "utf8",
    );
    expect(second.manifest.files.find((file) => file.path === "stable.json")).toEqual(
      input.files.find((file) => file.path === "stable.json"),
    );
    expect(
      (await readFile(join(snapshot.workerRoot, "src/edited.txt"))).equals(Buffer.from(small)),
    ).toBe(true);
    expect(second.changes.all).toEqual([]);
    expect(await fingerprintWorkspace(source)).toBe(sourceBefore);
  });
  it("retains incompressible binary bytes and still refuses the bounded wire envelope", async () => {
    const snapshot = await fixture(),
      binary = Buffer.concat(
        Array.from({ length: 256 }, (_, index) =>
          createHash("sha256")
            .update(`fixed-public-capacity-fixture:${String(index)}`)
            .digest(),
        ),
      );
    await writeFile(join(snapshot.workerRoot, "incompressible.bin"), binary);
    const input = await packWorkspaceSnapshot(snapshot, binding);
    expect(input.files.find((file) => file.path === "incompressible.bin")?.encoding).toBe("base64");
    const copied = await remote(input);
    expect((await readFile(join(copied, "incompressible.bin"))).equals(binary)).toBe(true);
    await expect(
      packWorkspaceSnapshot(snapshot, binding, { limits: { maxPayloadBytes: 4096 } }),
    ).rejects.toThrow(/byte limit/u);
    await expect(
      materializeWorkspaceManifest(input, join(root, "over-budget"), {
        limits: { maxPayloadBytes: 4096 },
      }),
    ).rejects.toThrow(/byte limit/u);
    expect(await readdir(root)).not.toContain("over-budget");
  });
  it("rejects gzip bombs and cumulative expansion before creating any destination", async () => {
    const snapshot = await fixture(),
      input = await packWorkspaceSnapshot(snapshot, binding),
      expanded = Buffer.alloc(20_000, 0);
    const file = input.files[0];
    if (file === undefined) throw new Error("Missing fixture");
    const compressed = {
      ...file,
      path: "bomb.bin",
      encoding: "gzip-base64" as const,
      content: gzipSync(expanded).toString("base64"),
      sha256: hash(expanded),
    };
    const bomb = rehash({ ...input, files: [compressed] });
    await expect(
      materializeWorkspaceManifest(bomb, join(root, "bomb"), {
        limits: { maxExpandedBytes: 1024 },
      }),
    ).rejects.toThrow(/expanded byte limit/u);
    const cumulative = rehash({
      ...input,
      files: [compressed, { ...compressed, path: "second.bin" }],
    });
    await expect(
      materializeWorkspaceManifest(cumulative, join(root, "sum"), {
        limits: { maxExpandedBytes: 25_000 },
      }),
    ).rejects.toThrow(/total expanded/u);
    expect(await readdir(root)).not.toContain("bomb");
    expect(await readdir(root)).not.toContain("sum");
  });

  it("rejects a real directory symlink/junction, including an added-file parent escape", async () => {
    const snapshot = await fixture();
    const { input, delta } = await modified(snapshot);
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "private.txt"), "must remain");
    await symlink(
      outside,
      join(snapshot.workerRoot, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(packWorkspaceSnapshot(snapshot, binding)).rejects.toThrow(/symbolic/u);
    await expect(applyWorkspaceDelta(snapshot, input, delta)).rejects.toThrow(/symbolic/u);
    expect(await readFile(join(outside, "private.txt"), "utf8")).toBe("must remain");
  });

  it("refuses hard links instead of normalizing shared inode contents", async () => {
    const snapshot = await fixture();
    await link(join(snapshot.workerRoot, "src/text.txt"), join(snapshot.workerRoot, "hardlink"));
    await expect(packWorkspaceSnapshot(snapshot, binding)).rejects.toThrow(/hard-linked/u);
  });

  it.each(["utf8", "base64"] as const)(
    "rejects known credential content in real %s files before installing",
    async (encoding) => {
      const snapshot = await fixture();
      const { input, delta } = await modified(snapshot);
      const secret = "synthetic-controller-secret-12345";
      const data =
        encoding === "utf8"
          ? Buffer.from(secret)
          : Buffer.concat([Buffer.from([0, 255]), Buffer.from(secret), Buffer.from([0])]);
      const change = delta.changes.find((item) => item.kind === "added");
      if (change?.kind !== "added") throw new Error("Missing fixture");
      change.file = {
        ...change.file,
        encoding,
        content: encoding === "utf8" ? data.toString("utf8") : data.toString("base64"),
        sha256: hash(data),
      };
      const before = await fingerprintWorkspace(snapshot.workerRoot),
        source = await fingerprintWorkspace(snapshot.sourceRoot);
      await expect(
        applyWorkspaceDelta(snapshot, input, delta, { knownSecrets: [secret] }),
      ).rejects.toThrow(/credential/iu);
      await unchanged(snapshot, before, source);
    },
  );

  it("detects credentials before packing or returning a Supervisor delta", async () => {
    const snapshot = await fixture(),
      input = await packWorkspaceSnapshot(snapshot, binding);
    const secret = "synthetic-controller-secret-12345";
    await writeFile(join(snapshot.workerRoot, "src/text.txt"), secret);
    await expect(
      packWorkspaceSnapshot(snapshot, binding, { knownSecrets: [secret] }),
    ).rejects.toThrow(/credential/iu);
    const remoteRoot = await remote(input);
    await writeFile(join(remoteRoot, "src/text.txt"), Buffer.from(secret).toString("base64"));
    await expect(
      createWorkspaceDelta(input, remoteRoot, { knownSecrets: [secret] }),
    ).rejects.toThrow(/credential/iu);
  });

  it("refuses changed Controller workspace and never accepts a model changePlan as a delta", async () => {
    const snapshot = await fixture();
    const { input, delta } = await modified(snapshot);
    await writeFile(
      join(snapshot.workerRoot, "src/text.txt"),
      "independent concurrent modification",
    );
    const before = await fingerprintWorkspace(snapshot.workerRoot),
      source = await fingerprintWorkspace(snapshot.sourceRoot);
    await expect(applyWorkspaceDelta(snapshot, input, delta)).rejects.toThrow(/no longer matches/u);
    await expect(
      applyWorkspaceDelta(snapshot, input, {
        ...delta,
        changePlan: [{ path: "src/text.txt", summary: "fake model change" }],
      }),
    ).rejects.toThrow();
    await unchanged(snapshot, before, source);
  });

  it("keeps the original tree untouched when the second staged file write fails", async () => {
    const snapshot = await fixture(),
      { input, delta } = await modified(snapshot);
    const before = await fingerprintWorkspace(snapshot.workerRoot),
      source = await fingerprintWorkspace(snapshot.sourceRoot);
    faults.writeName = "added.txt";
    await expect(applyWorkspaceDelta(snapshot, input, delta)).rejects.toThrow(/Injected staging/u);
    await unchanged(snapshot, before, source);
    expect(
      (await readdir(root)).filter((name) => name.startsWith(".agentarts-workspace-transfer-")),
    ).toEqual([]);
  });

  it("rolls back an installation rename failure after moving the old worker directory", async () => {
    const snapshot = await fixture(),
      { input, delta } = await modified(snapshot);
    const before = await fingerprintWorkspace(snapshot.workerRoot),
      source = await fingerprintWorkspace(snapshot.sourceRoot);
    faults.failInstall = true;
    await expect(applyWorkspaceDelta(snapshot, input, delta)).rejects.toThrow(
      /Injected installation/u,
    );
    await unchanged(snapshot, before, source);
    expect(
      (await readdir(root)).filter((name) => name.startsWith(".agentarts-workspace-transfer-")),
    ).toEqual([]);
  });

  it("retains the original private backup when installation and rollback both fail", async () => {
    const snapshot = await fixture();
    const { input, delta } = await modified(snapshot);
    const before = await fingerprintWorkspace(snapshot.workerRoot),
      source = await fingerprintWorkspace(snapshot.sourceRoot);
    faults.failInstall = true;
    faults.failRollback = true;
    await expect(applyWorkspaceDelta(snapshot, input, delta)).rejects.toThrow(
      /retained for recovery/u,
    );
    expect(await fingerprintWorkspace(snapshot.sourceRoot)).toBe(source);
    const retained = (await readdir(root)).filter((name) =>
      name.startsWith(".agentarts-workspace-transfer-"),
    );
    expect(retained).toHaveLength(1);
    const stage = retained[0];
    if (stage === undefined) throw new Error("Expected retained recovery directory");
    expect(await fingerprintWorkspace(join(root, stage, "backup"))).toBe(before);
    await expect(lstat(snapshot.workerRoot)).rejects.toThrow();
  });

  it("reuses strict upstream integrity classification to stop test-definition weakening without running it", async () => {
    const snapshot = await fixture();
    await writeFile(
      join(snapshot.sourceRoot, "package.json"),
      JSON.stringify({ scripts: { test: "node tests/check.js" } }),
    );
    await mkdir(join(snapshot.sourceRoot, "tests"));
    await writeFile(join(snapshot.sourceRoot, "tests/check.js"), 'throw new Error("check");');
    const integritySnapshot = await createWorkspaceSnapshot(
      { kind: "materialized-tree", root: snapshot.sourceRoot },
      join(root, "integrity-worker"),
    );
    const input = await packWorkspaceSnapshot(integritySnapshot, binding),
      remoteRoot = await remote(input);
    await writeFile(
      join(remoteRoot, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    const delta = await createWorkspaceDelta(input, remoteRoot);
    const before = await fingerprintWorkspace(integritySnapshot.workerRoot),
      source = await fingerprintWorkspace(integritySnapshot.sourceRoot);
    await expect(
      applyWorkspaceDelta(integritySnapshot, input, delta, {
        validationCommands: [["npm", "test"]],
      }),
    ).rejects.toThrow(/Validation|validation/iu);
    await unchanged(integritySnapshot, before, source);
  });

  it("captures actual mode changes and rejects unsafe mode values", async () => {
    const snapshot = await fixture(),
      input = await packWorkspaceSnapshot(snapshot, binding),
      remoteRoot = await remote(input);
    await chmod(join(remoteRoot, "src/text.txt"), 0o444);
    const actualMode = (await lstat(join(remoteRoot, "src/text.txt"))).mode & 0o777;
    const delta = await createWorkspaceDelta(input, remoteRoot);
    const result = await applyWorkspaceDelta(snapshot, input, delta);
    expect((await lstat(join(snapshot.workerRoot, "src/text.txt"))).mode & 0o777).toBe(actualMode);
    const nextRemote = join(root, "mode-remote");
    await materializeWorkspaceManifest(result.manifest, nextRemote);
    await chmod(join(nextRemote, "src/text.txt"), 0o666);
    await writeFile(join(nextRemote, "src/text.txt"), "mode candidate");
    const nextDelta = await createWorkspaceDelta(result.manifest, nextRemote);
    const change = nextDelta.changes.find((item) => item.kind === "modified");
    if (change?.kind !== "modified") throw new Error("Missing mode fixture");
    change.file.mode = 0o4755;
    await expect(applyWorkspaceDelta(snapshot, result.manifest, nextDelta)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "round trips actual executable POSIX file mode",
    async () => {
      const snapshot = await fixture();
      await chmod(join(snapshot.workerRoot, "src/text.txt"), 0o755);
      const input = await packWorkspaceSnapshot(snapshot, binding),
        remoteRoot = await remote(input);
      expect((await lstat(join(remoteRoot, "src/text.txt"))).mode & 0o777).toBe(0o755);
      await chmod(join(remoteRoot, "src/text.txt"), 0o644);
      const delta = await createWorkspaceDelta(input, remoteRoot);
      await applyWorkspaceDelta(snapshot, input, delta);
      expect((await lstat(join(snapshot.workerRoot, "src/text.txt"))).mode & 0o777).toBe(0o644);
    },
  );
});
