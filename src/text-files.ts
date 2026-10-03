import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { RoutedCommand } from "./commands/router.js";
import { ActionConfigurationError } from "./errors.js";
import type { GitHubClient } from "./github/client.js";
import type { RepositoryContext } from "./github/context.js";
import type { ActionInputs } from "./inputs.js";
import { redactKnownSecrets } from "./security/env.js";
import { removeMarkdownImages, sanitizeUntrustedText } from "./security/redaction.js";
import { validateCommitSha } from "./security/refs.js";
import { getBranchHead } from "./write/github.js";

export const TEXT_FILE_LIMITS = Object.freeze({
  contextCount: 8,
  fileBytes: 32 * 1024,
  contextBytes: 64 * 1024,
  pathBytes: 240,
  pathDepth: 16,
});

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".rst",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".tsv",
  ".log",
]);

/** Only explicitly named repository text; never a runner path, glob, or secret-file discovery. */
function textPath(value: unknown, input: string): string {
  if (typeof value !== "string")
    throw new ActionConfigurationError(`${input} paths must be strings`);
  const segments = value.split("/");
  if (
    value === "" ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > TEXT_FILE_LIMITS.pathBytes ||
    segments.length > TEXT_FILE_LIMITS.pathDepth ||
    // eslint-disable-next-line no-control-regex
    /[\\:\x00-\x1f\x7f*?[\]{}]/u.test(value) ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase() === ".git" ||
        (segment.startsWith(".") && segment !== ".github"),
    )
  ) {
    throw new ActionConfigurationError(
      `${input} must use explicit normalized repository-relative paths (no runner paths, hidden secret files, traversal, or globs)`,
    );
  }
  if (!TEXT_EXTENSIONS.has(posix.extname(value).toLowerCase())) {
    throw new ActionConfigurationError(
      `${input} unsupported text file type: ${value}; supported: .txt, .md, .rst, .json, .yaml, .yml, .csv, .tsv, .log`,
    );
  }
  return value;
}

export function parsePromptFile(value: string): string {
  return value === "" ? "" : textPath(value, "prompt-file");
}

export function parseContextFiles(value: string): readonly string[] {
  if (
    Buffer.byteLength(value, "utf8") >
    TEXT_FILE_LIMITS.contextCount * (TEXT_FILE_LIMITS.pathBytes + 4) + 2
  ) {
    throw new ActionConfigurationError("context-files configuration exceeds its path byte limit");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new ActionConfigurationError(
      "context-files must be a JSON array of explicit text file paths",
    );
  }
  if (!Array.isArray(decoded) || decoded.length > TEXT_FILE_LIMITS.contextCount) {
    throw new ActionConfigurationError(
      `context-files must be a JSON array with at most ${String(TEXT_FILE_LIMITS.contextCount)} paths`,
    );
  }
  const paths = decoded.map((entry: unknown) => textPath(entry, "context-files"));
  if (new Set(paths).size !== paths.length)
    throw new ActionConfigurationError("context-files must not contain duplicate paths");
  return paths;
}

export interface RepositoryTextFileAudit {
  readonly repository: string;
  readonly sourceSha: string;
  readonly path: string;
  readonly blobSha: string;
  readonly bytes: number;
}

export interface RepositoryTextFile extends RepositoryTextFileAudit {
  readonly text: string;
}

type TreeData = Awaited<ReturnType<GitHubClient["rest"]["git"]["getTree"]>>["data"];

/** Read immutable Git blobs only. Tree modes reject links before any target is followed. */
export async function loadRepositoryTextFiles(options: {
  readonly client: GitHubClient;
  readonly repository: RepositoryContext;
  readonly sourceSha: string;
  readonly paths: readonly string[];
  readonly maximumBytes: number;
}): Promise<readonly RepositoryTextFile[]> {
  const { client, repository, maximumBytes } = options;
  const sourceSha = validateCommitSha(options.sourceSha);
  if (options.paths.length > TEXT_FILE_LIMITS.contextCount)
    throw new ActionConfigurationError("Too many repository text files");
  const paths = options.paths.map((path) => textPath(path, "repository text file"));
  if (new Set(paths).size !== paths.length) {
    throw new ActionConfigurationError("Repository text file paths must be distinct");
  }
  if (paths.length === 0) return [];
  const target = { owner: repository.owner, repo: repository.repo };
  const commit = await client.rest.git.getCommit({
    ...target,
    commit_sha: sourceSha,
    request: { dshImmutable: true },
  });
  if (commit.data.sha !== sourceSha)
    throw new ActionConfigurationError(
      "Text file source commit SHA did not match its immutable binding",
    );
  const rootTreeSha = validateCommitSha(commit.data.tree.sha);
  const trees = new Map<string, Promise<TreeData>>();
  const getTree = (sha: string): Promise<TreeData> => {
    let pending = trees.get(sha);
    pending ??= (async () => {
      const response = await client.rest.git.getTree({
        ...target,
        tree_sha: sha,
        request: { dshImmutable: true },
      });
      if (response.data.sha !== sha || response.data.truncated)
        throw new ActionConfigurationError("Text file Git tree was mismatched or truncated");
      return response.data;
    })();
    trees.set(sha, pending);
    return pending;
  };
  let totalBytes = 0;
  const files: RepositoryTextFile[] = [];
  for (const path of paths) {
    const segments = path.split("/");
    let treeSha = rootTreeSha;
    for (const [index, segment] of segments.entries()) {
      const tree = await getTree(treeSha);
      const matching = tree.tree.filter((entry) => entry.path === segment);
      const entry = matching[0];
      if (matching.length > 1) {
        throw new ActionConfigurationError(
          `Text file Git tree contains duplicate entries: ${path}`,
        );
      }
      if (entry === undefined)
        throw new ActionConfigurationError(`Text file is missing at ${sourceSha}: ${path}`);
      const sha = validateCommitSha(entry.sha);
      if (index < segments.length - 1) {
        if (entry.type !== "tree" || entry.mode !== "040000")
          throw new ActionConfigurationError(
            `Text file parent is not a regular Git directory (symlinks and submodules are forbidden): ${path}`,
          );
        treeSha = sha;
        continue;
      }
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
        throw new ActionConfigurationError(
          `Text file is not a regular Git blob (symlinks and submodules are forbidden): ${path}`,
        );
      const size = entry.size;
      if (
        size === undefined ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > TEXT_FILE_LIMITS.fileBytes
      )
        throw new ActionConfigurationError(
          `Text file exceeds the ${String(TEXT_FILE_LIMITS.fileBytes)} byte limit or has invalid size: ${path}`,
        );
      totalBytes += size;
      if (totalBytes > maximumBytes)
        throw new ActionConfigurationError(
          `Repository text files exceed the total ${String(maximumBytes)} byte limit at: ${path}`,
        );
      const blob = await client.rest.git.getBlob({
        ...target,
        file_sha: sha,
        request: { dshImmutable: true },
      });
      const base64 = blob.data.content.replaceAll("\n", "").replaceAll("\r", "");
      if (
        blob.data.sha !== sha ||
        blob.data.encoding !== "base64" ||
        blob.data.size !== size ||
        base64.length > 4 * Math.ceil(size / 3)
      )
        throw new ActionConfigurationError(
          `Text file blob identity, encoding, or size did not match: ${path}`,
        );
      const bytes = Buffer.from(base64, "base64");
      if (
        bytes.byteLength !== size ||
        bytes.toString("base64") !== base64 ||
        createHash("sha1")
          .update(`blob ${String(size)}\0`)
          .update(bytes)
          .digest("hex") !== sha
      )
        throw new ActionConfigurationError(
          `Text file blob content failed integrity verification: ${path}`,
        );
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new ActionConfigurationError(`Text file must use valid UTF-8 encoding: ${path}`);
      }
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text))
        throw new ActionConfigurationError(`Text file contains binary/control bytes: ${path}`);
      files.push({
        repository: repository.fullName,
        sourceSha,
        path,
        blobSha: sha,
        bytes: size,
        text,
      });
    }
  }
  return files;
}

/** Explicit opt-in promotes this default-branch file to task text, never to Controller authority. */
export async function resolveTrustedPrompt(options: {
  readonly client: GitHubClient;
  readonly repository: RepositoryContext;
  readonly command: RoutedCommand;
  readonly inputs: ActionInputs;
}): Promise<RoutedCommand> {
  const { client, repository, command, inputs } = options;
  // Preserve existing interactive-command precedence over configured prompt.
  if (inputs.promptFile === "" || command.source === "mention") return command;
  if (repository.defaultBranch === undefined)
    throw new ActionConfigurationError(
      "prompt-file requires the repository default branch identity; no PR-head fallback is allowed",
    );
  const sourceSha = await getBranchHead(
    client,
    repository.owner,
    repository.repo,
    repository.defaultBranch,
  );
  const [file] = await loadRepositoryTextFiles({
    client,
    repository,
    sourceSha,
    paths: [inputs.promptFile],
    maximumBytes: TEXT_FILE_LIMITS.fileBytes,
  });
  if (file === undefined || file.text.trim() === "")
    throw new ActionConfigurationError(
      `prompt-file must contain non-empty task instructions: ${inputs.promptFile}`,
    );
  if ([inputs.deepseekApiKey, inputs.githubToken].some((secret) => file.text.includes(secret)))
    throw new ActionConfigurationError("prompt-file must not contain Controller credentials");
  const { text, ...instructionFile } = file;
  return { ...command, instructions: removeMarkdownImages(text), instructionFile };
}

export function untrustedTextFiles(
  files: readonly RepositoryTextFile[],
  secrets: readonly string[],
): readonly RepositoryTextFile[] {
  return files.map((file) => ({
    ...file,
    text: sanitizeUntrustedText(redactKnownSecrets(file.text, secrets)),
  }));
}
