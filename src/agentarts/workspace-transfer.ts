/**
 * Bounded transport for the Controller's original disposable workspace.
 * Callers must stop DSH before capture and exclusively own the Controller
 * workspace throughout apply. This module never runs repository code or tests.
 */
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";

import { assertPathWithin } from "../security/paths.js";
import { assertNoSecretOutput } from "../security/env.js";
import { PolicyDeniedError } from "../errors.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { DshError } from "../dsh/errors.js";
import { assertWritablePath } from "../write/github.js";
import {
  enforceValidationIntegrity,
  inspectValidationIntegrity,
  type ValidationIntegritySummary,
} from "../write/validation-integrity.js";
import {
  inspectWorkspaceChanges,
  isIgnoredGeneratedRootEntry,
  type WorkspaceChanges,
  type WorkspaceSnapshot,
} from "../write/workspace.js";
import { safeWorkspacePath } from "./protocol.js";

export const WORKSPACE_TRANSFER_LIMITS = Object.freeze({
  maxPayloadBytes: 16 * 1024 * 1024,
  maxExpandedBytes: 128 * 1024 * 1024,
  maxFiles: 5000,
  maxChanges: 5000,
});
export interface WorkspaceTransferOptions {
  readonly knownSecrets?: readonly string[];
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  /** Mirrors upstream snapshots: only generated node_modules is omitted. .git is forbidden. */
  readonly excludeGeneratedRoots?: boolean;
  /** Narrowing only: these are implementation transport limits, not platform limits. */
  readonly limits?: Partial<{
    readonly maxPayloadBytes: number;
    readonly maxExpandedBytes: number;
    readonly maxFiles: number;
    readonly maxChanges: number;
  }>;
}
export interface ApplyWorkspaceDeltaOptions extends WorkspaceTransferOptions {
  /** Used only by the upstream integrity classifier; never executed here. */
  readonly validationCommands?: readonly (readonly string[])[];
  /** Exact paths granted by the trusted Controller; omit to allow bounded safe paths. */
  readonly allowedPaths?: readonly string[];
}
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const sha1 = z.string().regex(/^[a-f0-9]{40}$/u);
export const workspaceTransferBindingSchema = z
  .strictObject({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    baseSha: sha1,
    headSha: sha1,
    revision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    taskId: z.uuid().optional(),
    operation: z.enum(["review", "diagnose", "fix", "implement", "task"]).optional(),
    entity: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("pull_request"), number: z.number().int().positive() }),
        z.strictObject({ kind: z.literal("issue"), number: z.number().int().positive() }),
        z.strictObject({ kind: z.literal("repository") }),
      ])
      .optional(),
    ref: z.string().min(1).max(1024).optional(),
    grantDigest: sha256.optional(),
    operationIdentity: z.string().min(1).max(4096).optional(),
  })
  .refine((binding) => {
    const count = [
      binding.taskId,
      binding.operation,
      binding.entity,
      binding.ref,
      binding.grantDigest,
      binding.operationIdentity,
    ].filter((value) => value !== undefined).length;
    return count === 0 || count === 6;
  }, "Full Runtime correlation binding must be complete");
const bindingSchema = workspaceTransferBindingSchema;
export type WorkspaceTransferBinding = z.infer<typeof bindingSchema>;
function portablePath(path: string): boolean {
  return (
    safeWorkspacePath(path) &&
    path
      .split("/")
      .every(
        (part) =>
          !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  );
}
const pathSchema = z.string().refine(portablePath, "Unsafe or ambiguous portable repository path");
const modeSchema = z.number().int().min(0).max(0o777);
const stateSchema = z.strictObject({ path: pathSchema, sha256, mode: modeSchema });
const fileSchema = stateSchema.extend({
  encoding: z.enum(["utf8", "base64", "gzip-base64"]),
  content: z.string().max(WORKSPACE_TRANSFER_LIMITS.maxPayloadBytes),
});
export type WorkspaceTransferFile = z.infer<typeof fileSchema>;
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  binding: bindingSchema,
  files: z.array(fileSchema).max(WORKSPACE_TRANSFER_LIMITS.maxFiles),
  digest: sha256,
});
export const workspaceTransferManifestSchema = manifestSchema;
export type WorkspaceTransferManifest = z.infer<typeof manifestSchema>;
const changeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("added"), file: fileSchema }),
  z.strictObject({ kind: z.literal("modified"), original: stateSchema, file: fileSchema }),
  z.strictObject({ kind: z.literal("deleted"), original: stateSchema }),
]);
const deltaSchema = z.strictObject({
  schemaVersion: z.literal(1),
  binding: bindingSchema,
  inputDigest: sha256,
  resultDigest: sha256,
  changes: z.array(changeSchema).max(WORKSPACE_TRANSFER_LIMITS.maxChanges),
});
export const workspaceTransferDeltaSchema = deltaSchema;
export type WorkspaceTransferDelta = z.infer<typeof deltaSchema>;
export interface AppliedWorkspaceDelta {
  readonly manifest: WorkspaceTransferManifest;
  /** Cumulative against the original upstream baseline, including earlier repair turns. */
  readonly changes: WorkspaceChanges;
  readonly validationIntegrity: ValidationIntegritySummary;
  readonly cleanupWarnings: readonly string[];
}
function denied(message: string): never {
  throw new PolicyDeniedError(`Workspace transfer ${message}`);
}
function guard(options: WorkspaceTransferOptions): void {
  throwIfCancelled(options.signal);
  if (
    options.deadlineMs !== undefined &&
    (!Number.isFinite(options.deadlineMs) || Date.now() >= options.deadlineMs)
  )
    throw new DshError(
      "DSH_TIMEOUT",
      "Workspace transport deadline expired; result was not installed",
    );
}
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const order = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const key = (path: string) => path.normalize("NFC").toLowerCase();
function limits(options: WorkspaceTransferOptions) {
  const result = { ...WORKSPACE_TRANSFER_LIMITS, ...options.limits };
  for (const name of ["maxPayloadBytes", "maxExpandedBytes", "maxFiles", "maxChanges"] as const)
    if (
      !Number.isSafeInteger(result[name]) ||
      result[name] < 1 ||
      result[name] > WORKSPACE_TRANSFER_LIMITS[name]
    )
      denied("limits may only narrow the supported transport envelope");
  return result;
}
function secretVariants(options: WorkspaceTransferOptions): readonly string[] {
  const values = options.knownSecrets ?? [];
  if (values.length > 256 || values.some((value) => value.length > 64 * 1024))
    denied("credential inspection limit exceeded");
  return [
    ...new Set(
      values
        .filter(Boolean)
        .flatMap((value) => [
          value,
          Buffer.from(value).toString("base64"),
          encodeURIComponent(value),
        ]),
    ),
  ];
}
function noSecrets(bytes: Buffer, options: WorkspaceTransferOptions): void {
  // Lossless byte comparison also covers credentials embedded in binary files.
  const variants = secretVariants(options).map((value) => Buffer.from(value).toString("latin1"));
  assertNoSecretOutput("stdout", bytes.toString("latin1"), variants);
}
function budget(value: unknown, options: WorkspaceTransferOptions): void {
  guard(options);
  let text: unknown;
  try {
    text = JSON.stringify(value);
  } catch {
    denied("payload is not a serializable bounded record");
  }
  if (typeof text !== "string" || Buffer.byteLength(text) > limits(options).maxPayloadBytes)
    denied("payload exceeds the byte limit; no files were omitted");
  noSecrets(Buffer.from(text), options);
}
function bytes(file: WorkspaceTransferFile, options: WorkspaceTransferOptions): Buffer {
  let contents: Buffer;
  if (file.encoding === "utf8") {
    contents = Buffer.from(file.content);
    if (contents.toString("utf8") !== file.content) denied("contains non-roundtrip UTF-8 text");
  } else {
    contents = Buffer.from(file.content, "base64");
    if (contents.toString("base64") !== file.content) denied("contains noncanonical base64");
    if (file.encoding === "gzip-base64") {
      try {
        contents = gunzipSync(contents, { maxOutputLength: limits(options).maxExpandedBytes });
      } catch {
        denied("compressed file is invalid or exceeds the expanded byte limit");
      }
    }
  }
  if (contents.byteLength > limits(options).maxExpandedBytes)
    denied("expanded file exceeds the byte limit");
  if (hash(contents) !== file.sha256) denied("file content hash mismatch");
  noSecrets(contents, options);
  return contents;
}
function assertFileTree(
  files: readonly WorkspaceTransferFile[],
  options: WorkspaceTransferOptions,
): void {
  if (files.length > limits(options).maxFiles)
    denied("file count limit exceeded; no files were omitted");
  const names = new Set<string>();
  let expandedBytes = 0;
  for (const file of files) {
    if (!portablePath(file.path)) denied("contains an unsafe path");
    const name = key(file.path);
    if (names.has(name)) denied("contains duplicate or aliased paths");
    names.add(name);
    expandedBytes += bytes(file, options).byteLength;
    if (expandedBytes > limits(options).maxExpandedBytes)
      denied("workspace exceeds the total expanded byte limit; no files were omitted");
  }
  for (const file of files) {
    const segments = file.path.split("/");
    for (let count = 1; count < segments.length; count += 1)
      if (names.has(key(segments.slice(0, count).join("/"))))
        denied("contains a file as another file's parent");
  }
}
function manifest(
  binding: WorkspaceTransferBinding,
  files: readonly WorkspaceTransferFile[],
  options: WorkspaceTransferOptions,
): WorkspaceTransferManifest {
  const body = {
    schemaVersion: 1 as const,
    binding: bindingSchema.parse(binding),
    files: files
      .map((file) => ({
        path: file.path,
        sha256: file.sha256,
        mode: file.mode,
        encoding: file.encoding,
        content: file.content,
      }))
      .sort((a, b) => order(a.path, b.path)),
  };
  assertFileTree(body.files, options);
  const result = { ...body, digest: hash(JSON.stringify(body)) };
  budget(result, options);
  return result;
}
function checkedManifest(
  raw: unknown,
  options: WorkspaceTransferOptions,
): WorkspaceTransferManifest {
  budget(raw, options);
  const parsed = manifestSchema.parse(raw);
  const canonical = manifest(parsed.binding, parsed.files, options);
  if (parsed.digest !== canonical.digest) denied("input manifest digest mismatch");
  return canonical;
}
export function validateWorkspaceTransferManifest(
  raw: unknown,
  options: WorkspaceTransferOptions = {},
): WorkspaceTransferManifest {
  return checkedManifest(raw, options);
}
export function createWorkspaceTransferManifest(
  binding: WorkspaceTransferBinding,
  files: readonly WorkspaceTransferFile[],
  options: WorkspaceTransferOptions = {},
): WorkspaceTransferManifest {
  return manifest(binding, files, options);
}
export function validateWorkspaceTransferDelta(
  input: unknown,
  delta: unknown,
  options: ApplyWorkspaceDeltaOptions = {},
): WorkspaceTransferManifest {
  return plannedResult(checkedManifest(input, options), delta, options);
}
async function directory(root: string): Promise<string> {
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory())
    denied("root must be a real directory without a symlink");
  return await realpath(root);
}
async function boundedFile(path: string, maximum: number): Promise<{ data: Buffer; mode: number }> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1)
    denied("symlink, special or hard-linked entries are forbidden");
  if ((info.mode & 0o7000) !== 0)
    denied("special permission bits are forbidden rather than normalized");
  if (info.size > maximum) denied("file exceeds the transport byte limit");
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.nlink > 1)
      denied("file changed while opening it");
    const data = Buffer.alloc(Math.min(maximum, opened.size) + 1);
    let offset = 0;
    while (offset < data.length) {
      const result = await handle.read(data, offset, data.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maximum) denied("file exceeds the transport byte limit");
    const after = await handle.stat();
    if (after.size !== offset || after.mtimeMs !== opened.mtimeMs || after.mode !== opened.mode)
      denied("file changed while capturing it");
    return { data: data.subarray(0, offset), mode: modeSchema.parse(opened.mode & 0o777) };
  } finally {
    await handle.close();
  }
}
async function capture(
  root: string,
  binding: WorkspaceTransferBinding,
  options: WorkspaceTransferOptions,
): Promise<WorkspaceTransferManifest> {
  guard(options);
  const canonicalRoot = await directory(root);
  const files: WorkspaceTransferFile[] = [];
  const pending = [""];
  let entries = 0,
    totalBytes = 0;
  const envelope = limits(options);
  while (pending.length > 0) {
    guard(options);
    const current = pending.pop();
    if (current === undefined) break;
    const currentLexical =
      current === "" ? canonicalRoot : join(canonicalRoot, ...current.split("/"));
    const currentInfo = await lstat(currentLexical);
    if (currentInfo.isSymbolicLink() || !currentInfo.isDirectory())
      denied("directory changed while capturing it");
    const currentPath =
      current === "" ? canonicalRoot : await assertPathWithin(canonicalRoot, current);
    if (resolve(currentPath) !== resolve(currentLexical)) denied("directory alias is forbidden");
    for (const entry of await readdir(currentPath, { withFileTypes: true })) {
      guard(options);
      if (
        current === "" &&
        entry.name === "node_modules" &&
        options.excludeGeneratedRoots !== false
      )
        continue;
      entries += 1;
      if (entries > envelope.maxFiles * 4 + 16) denied("directory entry limit exceeded");
      const path = current === "" ? entry.name : `${current}/${entry.name}`;
      if (!portablePath(path)) denied("unsafe path or .git entry is forbidden");
      const lexical = join(canonicalRoot, ...path.split("/"));
      const metadata = await lstat(lexical);
      if (metadata.isSymbolicLink()) denied("symbolic links are forbidden");
      const absolute = await assertPathWithin(canonicalRoot, path);
      if (resolve(absolute) !== resolve(lexical)) denied("path changed while capturing it");
      if (metadata.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!metadata.isFile()) denied("special entries are forbidden");
      if (files.length >= envelope.maxFiles)
        denied("file count limit exceeded; no files were omitted");
      const { data, mode } = await boundedFile(absolute, envelope.maxExpandedBytes - totalBytes);
      totalBytes += data.byteLength;
      if (totalBytes > envelope.maxExpandedBytes)
        denied("content exceeds the expanded byte limit; no files were omitted");
      guard(options);
      noSecrets(data, options);
      let content: string, encoding: "utf8" | "base64" | "gzip-base64";
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(data);
        if (data.includes(0) || !Buffer.from(content).equals(data)) throw new Error("binary");
        encoding = "utf8";
      } catch {
        content = data.toString("base64");
        encoding = "base64";
      }
      // Use one deterministic per-file encoding in both Controller and Runtime.
      // Medium source/evidence files also matter to the complete repository
      // envelope; compare actual JSON wire cost, including text escaping.
      // Never switch policy based on the total manifest size: an edit must not
      // change the encoding of unrelated files used by delta reconstruction.
      if (data.byteLength > 4 * 1024) {
        const compressed = gzipSync(data, { level: 6 });
        const compressedContent = compressed.toString("base64");
        if (
          Buffer.byteLength(JSON.stringify(compressedContent)) <
          Buffer.byteLength(JSON.stringify(content)) * 0.8
        ) {
          encoding = "gzip-base64";
          content = compressedContent;
        }
      }
      files.push({ path, encoding, content, sha256: hash(data), mode });
    }
  }
  return manifest(binding, files, options);
}

/** Pack actual worker files, excluding only the original generated-root policy (node_modules). */
export async function packWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
  binding: WorkspaceTransferBinding,
  options: WorkspaceTransferOptions = {},
): Promise<WorkspaceTransferManifest> {
  return await capture(snapshot.workerRoot, bindingSchema.parse(binding), options);
}
function state(file: WorkspaceTransferFile) {
  return { path: file.path, sha256: file.sha256, mode: file.mode };
}
function changedPath(change: z.infer<typeof changeSchema>) {
  return change.kind === "added" ? change.file.path : change.original.path;
}
function permittedChange(path: string): void {
  assertWritablePath(path);
  if (isIgnoredGeneratedRootEntry(path.split("/")[0] ?? ""))
    denied(
      "changes to generated roots are not independently observed by the upstream write validator",
    );
}
/** Supervisor-only capture after DSH exits. There is no model changePlan parameter. */
export async function createWorkspaceDelta(
  rawInput: unknown,
  actualWorkerRoot: string,
  options: WorkspaceTransferOptions = {},
): Promise<WorkspaceTransferDelta> {
  const input = checkedManifest(rawInput, options);
  const result = await capture(
    actualWorkerRoot,
    { ...input.binding, revision: input.binding.revision + 1 },
    options,
  );
  const before = new Map(input.files.map((file) => [file.path, file]));
  const after = new Map(result.files.map((file) => [file.path, file]));
  const changes: WorkspaceTransferDelta["changes"] = [];
  for (const file of result.files) {
    const original = before.get(file.path);
    if (original === undefined) changes.push({ kind: "added", file });
    else if (original.sha256 !== file.sha256 || original.mode !== file.mode)
      changes.push({ kind: "modified", original: state(original), file });
  }
  for (const file of input.files)
    if (!after.has(file.path)) changes.push({ kind: "deleted", original: state(file) });
  for (const change of changes) permittedChange(changedPath(change));
  // Reuse the upstream actual-files validator; generated files remain in the
  // complete manifest but may not be returned as unobserved write changes.
  const baseline = new Map(
    input.files
      .filter((file) => !isIgnoredGeneratedRootEntry(file.path.split("/")[0] ?? ""))
      .map((file) => [file.path, { kind: "file" as const, digest: file.sha256, mode: file.mode }]),
  );
  const observed = await inspectWorkspaceChanges({
    sourceRoot: actualWorkerRoot,
    workerRoot: actualWorkerRoot,
    baseline,
  });
  const samePaths = (left: readonly string[], right: readonly string[]) =>
    JSON.stringify([...left].sort(order)) === JSON.stringify([...right].sort(order));
  if (
    !samePaths(
      observed.added,
      changes.filter((change) => change.kind === "added").map(changedPath),
    ) ||
    !samePaths(
      observed.modified,
      changes.filter((change) => change.kind === "modified").map(changedPath),
    ) ||
    !samePaths(
      observed.deleted,
      changes.filter((change) => change.kind === "deleted").map(changedPath),
    ) ||
    (await capture(actualWorkerRoot, result.binding, options)).digest !== result.digest
  )
    denied("actual workspace changed during delta inspection");
  if (changes.length > limits(options).maxChanges) denied("change count limit exceeded");
  const delta = {
    schemaVersion: 1 as const,
    binding: input.binding,
    inputDigest: input.digest,
    resultDigest: result.digest,
    changes: changes.sort((a, b) => order(changedPath(a), changedPath(b))),
  };
  budget(delta, options);
  return delta;
}
function plannedResult(
  input: WorkspaceTransferManifest,
  rawDelta: unknown,
  options: ApplyWorkspaceDeltaOptions,
): WorkspaceTransferManifest {
  budget(rawDelta, options);
  const delta = deltaSchema.parse(rawDelta);
  if (
    JSON.stringify(delta.binding) !== JSON.stringify(input.binding) ||
    delta.inputDigest !== input.digest
  )
    denied("repository, commit, revision or input digest binding mismatch");
  if (delta.changes.length > limits(options).maxChanges) denied("change count limit exceeded");
  const next = new Map(input.files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const allowed =
    options.allowedPaths === undefined
      ? undefined
      : new Set(options.allowedPaths.map((path) => pathSchema.parse(path)));
  for (const change of delta.changes) {
    const path = changedPath(change);
    permittedChange(path);
    if (seen.has(key(path))) denied("delta contains duplicate or aliased paths");
    seen.add(key(path));
    if (allowed !== undefined && !allowed.has(path))
      denied("change exceeds the Controller path grant");
    const previous = next.get(path);
    if (change.kind === "added") {
      if (previous !== undefined) denied("added file already exists");
      next.set(path, change.file);
    } else {
      if (previous === undefined) denied("original file hash or mode mismatch");
      if (previous.sha256 !== change.original.sha256 || previous.mode !== change.original.mode)
        denied("original file hash or mode mismatch");
      if (change.kind === "deleted") next.delete(path);
      else {
        if (change.file.path !== path) denied("modified path cannot rename a file");
        if (change.file.sha256 === previous.sha256 && change.file.mode === previous.mode)
          denied("modified file has no actual change");
        next.set(path, change.file);
      }
    }
  }
  const result = manifest(
    { ...input.binding, revision: input.binding.revision + 1 },
    [...next.values()],
    options,
  );
  if (result.digest !== delta.resultDigest) denied("result manifest digest mismatch");
  return result;
}
async function populate(
  root: string,
  value: WorkspaceTransferManifest,
  options: WorkspaceTransferOptions,
): Promise<void> {
  await mkdir(root, { mode: 0o700 });
  for (const file of value.files) {
    guard(options);
    const target = await assertPathWithin(root, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if ((await assertPathWithin(root, file.path)) !== target) denied("staging parent path changed");
    await writeFile(target, bytes(file, options), { flag: "wx", mode: 0o600 });
    await chmod(target, file.mode);
  }
  if ((await capture(root, value.binding, options)).digest !== value.digest)
    denied("staged content or file modes cannot be represented faithfully");
}
/** Materialize into a new directory only, useful for the executable transfer prototype. */
export async function materializeWorkspaceManifest(
  rawInput: unknown,
  destination: string,
  options: WorkspaceTransferOptions = {},
): Promise<WorkspaceTransferManifest> {
  const value = checkedManifest(rawInput, options);
  const parent = await directory(dirname(resolve(destination)));
  const target = resolve(destination);
  if (await exists(target)) denied("materialization destination already exists");
  const stage = await mkdtemp(join(parent, ".agentarts-workspace-transfer-"));
  try {
    const candidate = join(stage, "candidate");
    await populate(candidate, value, options);
    if (await exists(target)) denied("materialization destination changed");
    await rename(candidate, target);
    return value;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
function overlap(left: string, right: string): boolean {
  const path = relative(left, right);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
async function assertSourceBaseline(snapshot: WorkspaceSnapshot, source: string): Promise<void> {
  // The integrity classifier reads sourceRoot. Its bytes and modes must still
  // be the original authority, including no newly added repository files.
  const changes = await inspectWorkspaceChanges({ ...snapshot, workerRoot: source });
  if (changes.all.length > 0) denied("source workspace no longer matches the original baseline");
}
/**
 * Stage and independently inspect the complete result, then replace workerRoot.
 * The original sourceRoot/baseline remain the upstream validation/publication
 * authority. No test is run and no checkout, commit or remote API is written.
 */
const activeImports = new Set<string>();
export async function applyWorkspaceDelta(
  snapshot: WorkspaceSnapshot,
  rawInput: unknown,
  rawDelta: unknown,
  options: ApplyWorkspaceDeltaOptions = {},
): Promise<AppliedWorkspaceDelta> {
  const target = resolve(snapshot.workerRoot);
  if (activeImports.has(target)) denied("another import already owns this Controller workspace");
  activeImports.add(target);
  try {
    return await applyWorkspaceDeltaInternal(snapshot, rawInput, rawDelta, options);
  } finally {
    activeImports.delete(target);
  }
}
async function applyWorkspaceDeltaInternal(
  snapshot: WorkspaceSnapshot,
  rawInput: unknown,
  rawDelta: unknown,
  options: ApplyWorkspaceDeltaOptions = {},
): Promise<AppliedWorkspaceDelta> {
  guard(options);
  const input = checkedManifest(rawInput, options);
  const result = plannedResult(input, rawDelta, options);
  const worker = await directory(snapshot.workerRoot),
    source = await directory(snapshot.sourceRoot);
  if (overlap(source, worker) || overlap(worker, source))
    denied("source and worker roots must be disjoint");
  if (
    [...snapshot.baseline.keys()].some((path) =>
      isIgnoredGeneratedRootEntry(path.split("/")[0] ?? ""),
    )
  )
    denied("baseline includes files ignored by the upstream write validator");
  await assertSourceBaseline(snapshot, source);
  if ((await capture(worker, input.binding, options)).digest !== input.digest)
    denied("Controller workspace no longer matches the input manifest");
  const stage = await mkdtemp(join(dirname(worker), ".agentarts-workspace-transfer-"));
  const candidate = join(stage, "candidate"),
    backup = join(stage, "backup");
  let backedUp = false,
    installed = false;
  const cleanupWarnings: string[] = [];
  try {
    await populate(candidate, result, options);
    guard(options);
    await assertSourceBaseline(snapshot, source);
    const candidateSnapshot = { ...snapshot, workerRoot: candidate };
    const changes = await inspectWorkspaceChanges(candidateSnapshot);
    const commands = options.validationCommands ?? [];
    const audit = await inspectValidationIntegrity({
      snapshot: candidateSnapshot,
      changes,
      commands,
      mode: "strict",
    });
    // Classification-only: baselineReplay is deliberately absent, so no command is executed.
    const validationIntegrity = await enforceValidationIntegrity({
      snapshot: candidateSnapshot,
      commands,
      audit,
    });
    if (
      (await directory(snapshot.workerRoot)) !== worker ||
      (await directory(snapshot.sourceRoot)) !== source ||
      (await capture(worker, input.binding, options)).digest !== input.digest
    )
      denied("Controller workspace changed before installation");
    await assertSourceBaseline(snapshot, source);
    guard(options);
    await rename(worker, backup);
    backedUp = true;
    try {
      guard(options);
      await rename(candidate, worker);
      installed = true;
      guard(options);
    } catch (error: unknown) {
      try {
        if (installed) {
          await rename(worker, candidate);
          installed = false;
        }
        await rename(backup, worker);
        backedUp = false;
      } catch (rollback: unknown) {
        throw new AggregateError(
          [error, rollback],
          `Workspace replacement failed; original is retained for recovery at ${backup}`,
          { cause: rollback },
        );
      }
      throw error;
    }
    return { manifest: result, changes, validationIntegrity, cleanupWarnings };
  } finally {
    // Do not destroy the sole original copy after a rollback I/O failure.
    if (!backedUp || installed) {
      try {
        await rm(stage, { recursive: true, force: true });
      } catch {
        cleanupWarnings.push(
          "Private transfer staging cleanup failed; Controller cleanup is required.",
        );
      }
    }
  }
}
