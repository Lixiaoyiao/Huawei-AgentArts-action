#!/usr/bin/env node
/** Export one unmodified, validated historical record. This command never publishes. */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 40;
const MAX_JSON_NODES = 200000;
const USAGE =
  "Usage: node agentarts/demo/export.mjs --record <absolute run-record.json path> --out <new directory>";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
function fields(value, allowed, label) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(
      `Unknown fields or invalid object in ${label}; refusing to export raw payload fields.`,
    );
}

/**
 * Adapted from the upstream src/session/checkpoint.ts::preflightJson scanner.
 * That function is private to session validation. Keep this standalone CLI's
 * string/stack algorithm equivalent: decode keys before comparing, skip quoted
 * delimiters, and reject ambiguity before JSON.parse discards duplicate keys.
 * Full JSON grammar remains JSON.parse's responsibility; no raw diagnostics leak.
 */
function preflightJson(text) {
  const stack = [];
  let nodes = 0;
  const count = () => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new Error("Run record exceeds the JSON scan node limit.");
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      count();
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\") end += 1;
        end += 1;
      }
      if (end >= text.length) throw new Error("Run record contains malformed JSON.");
      let value;
      try {
        value = JSON.parse(text.slice(index, end + 1));
      } catch {
        throw new Error("Run record contains malformed JSON.");
      }
      if (typeof value !== "string") throw new Error("Run record contains malformed JSON.");
      const current = stack.at(-1);
      if (current?.expectingKey) {
        if (current.keys.has(value))
          throw new Error("Run record contains duplicate JSON keys; export refused.");
        current.keys.add(value);
        current.expectingKey = false;
      }
      index = end;
    } else if (char === "{" || char === "[") {
      count();
      stack.push(char === "{" ? { keys: new Set(), expectingKey: true } : null);
      if (stack.length > MAX_JSON_DEPTH)
        throw new Error("Run record exceeds the JSON depth limit.");
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === ",") {
      count();
      const current = stack.at(-1);
      if (current !== undefined && current !== null) current.expectingKey = true;
    }
  }
}

function validate(record) {
  if (!object(record) || record.schemaVersion !== 1)
    throw new Error("Unsupported run record: schemaVersion must be 1.");
  fields(
    record,
    [
      "schemaVersion",
      "mode",
      "task",
      "stages",
      "tools",
      "observedTools",
      "validation",
      "result",
      "runtime",
      "durationMs",
      "warnings",
      "environment",
      "modelEvidence",
    ],
    "record",
  );
  if (!["cloud", "local", "simulation"].includes(record.mode))
    throw new Error(
      "Only explicit cloud/local/simulation Demo records are supported; raw/container evidence is rejected.",
    );
  if (
    !object(record.task) ||
    ["id", "repository", "headSha", "url"].some((key) => typeof record.task[key] !== "string") ||
    !Number.isSafeInteger(record.task.pullNumber) ||
    record.task.pullNumber < 0
  )
    throw new Error("Invalid Demo task metadata.");
  fields(
    record.task,
    ["id", "repository", "pullNumber", "headSha", "baseSha", "url", "kind", "operation"],
    "task",
  );
  if (
    record.task.kind !== undefined &&
    !["pull_request", "issue", "repository"].includes(record.task.kind)
  )
    throw new Error("Invalid task kind.");
  if (
    record.task.operation !== undefined &&
    !["review", "task", "diagnose", "fix", "implement"].includes(record.task.operation)
  )
    throw new Error("Invalid task operation.");
  if (record.task.baseSha !== undefined && typeof record.task.baseSha !== "string")
    throw new Error("Invalid Demo base commit metadata.");
  if (
    !Array.isArray(record.stages) ||
    record.stages.length > 1000 ||
    record.stages.some(
      (stage) =>
        !object(stage) ||
        typeof stage.name !== "string" ||
        !["running", "passed", "failed", "skipped"].includes(stage.status) ||
        !timestamp(stage.startedAt) ||
        (stage.completedAt !== undefined && !timestamp(stage.completedAt)) ||
        (stage.message !== undefined && typeof stage.message !== "string"),
    )
  )
    throw new Error("Invalid Demo stages or timestamps.");
  for (const stage of record.stages)
    fields(stage, ["name", "status", "startedAt", "completedAt", "message"], "stage");
  if (
    !Array.isArray(record.tools) ||
    record.tools.length > 10000 ||
    record.tools.some(
      (tool) =>
        !object(tool) ||
        typeof tool.id !== "string" ||
        typeof tool.ok !== "boolean" ||
        !finite(tool.durationMs),
    )
  )
    throw new Error("Invalid Demo tool receipts.");
  for (const tool of record.tools) {
    fields(tool, ["id", "runtimeName", "ok", "completed", "durationMs"], "tool");
    if (
      (tool.runtimeName !== undefined && typeof tool.runtimeName !== "string") ||
      (tool.completed !== undefined && typeof tool.completed !== "boolean")
    )
      throw new Error("Invalid Demo tool metadata.");
  }
  if (
    record.observedTools !== undefined &&
    (!strings(record.observedTools) ||
      record.observedTools.length > 512 ||
      record.observedTools.some((name) => name.length > 128))
  )
    throw new Error("Invalid observed tool names; observations are not execution receipts.");
  if (
    !object(record.validation) ||
    !["passed", "failed", "not-run"].includes(record.validation.status) ||
    !strings(record.validation.checks) ||
    record.validation.checks.length > 1000
  )
    throw new Error("Invalid independent validation record.");
  fields(record.validation, ["status", "checks", "original"], "validation");
  if (record.validation.original !== undefined) {
    const original = record.validation.original;
    fields(original, ["status", "commandCount"], "original validation");
    if (
      !["passed", "failed", "skipped", "not-applicable"].includes(original.status) ||
      !Number.isSafeInteger(original.commandCount) ||
      original.commandCount < 0
    )
      throw new Error("Invalid original Controller validation summary.");
  }
  if (record.durationMs !== undefined && !finite(record.durationMs))
    throw new Error("Invalid record duration.");
  if (
    record.result !== undefined &&
    (!object(record.result) ||
      ["githubUrl", "summary", "error", "commitSha", "branchName"].some(
        (key) => record.result[key] !== undefined && typeof record.result[key] !== "string",
      ))
  )
    throw new Error("Invalid Demo result.");
  if (record.result !== undefined) {
    fields(
      record.result,
      ["githubUrl", "summary", "error", "writeStatus", "commitSha", "branchName"],
      "result",
    );
    if (
      (record.result.writeStatus !== undefined &&
        !["success", "partial-success", "no-changes"].includes(record.result.writeStatus)) ||
      (record.result.commitSha !== undefined && !/^[a-f0-9]{40}$/u.test(record.result.commitSha)) ||
      (record.result.branchName !== undefined && record.result.branchName.length > 1024)
    )
      throw new Error("Invalid original GitHub write summary.");
  }
  if (
    record.runtime !== undefined &&
    (!object(record.runtime) ||
      ["sessionId", "endpoint", "dshVersion", "requestId"].some(
        (key) => record.runtime[key] !== undefined && typeof record.runtime[key] !== "string",
      ))
  )
    throw new Error("Invalid Demo Runtime metadata.");
  if (record.runtime !== undefined)
    fields(record.runtime, ["sessionId", "endpoint", "dshVersion", "requestId"], "runtime");
  if (record.warnings !== undefined && (!strings(record.warnings) || record.warnings.length > 1000))
    throw new Error("Invalid Demo warnings.");
  if (record.environment !== undefined) {
    fields(record.environment, ["node", "platform", "linuxIsolationVerified"], "environment");
    if (
      ["node", "platform"].some(
        (key) =>
          record.environment[key] !== undefined && typeof record.environment[key] !== "string",
      ) ||
      (record.environment.linuxIsolationVerified !== undefined &&
        typeof record.environment.linuxIsolationVerified !== "boolean")
    )
      throw new Error("Invalid Demo environment metadata.");
  }
  if (record.modelEvidence !== undefined) {
    fields(record.modelEvidence, ["kind", "provider", "model"], "modelEvidence");
    if (
      !["live-provider", "deterministic-fixture", "unverified"].includes(
        record.modelEvidence.kind,
      ) ||
      record.modelEvidence.provider !== "deepseek" ||
      (record.modelEvidence.model !== undefined &&
        (typeof record.modelEvidence.model !== "string" || record.modelEvidence.model.length > 256))
    )
      throw new Error("Invalid model evidence; source must be explicitly recorded.");
  }
}

async function boundedRecord(path) {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("--record must identify a regular file.");
    if (info.size > MAX_BYTES) throw new Error("Run record exceeds 2 MiB.");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_BYTES) throw new Error("Run record exceeds 2 MiB.");
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

function staticHtml(template) {
  const hashes = (tag) =>
    [...template.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map(
      (match) => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`,
    );
  const scripts = hashes("script"),
    styles = hashes("style");
  if (scripts.length !== 1 || styles.length !== 1 || !template.includes('<meta charset="utf-8" />'))
    throw new Error("Unexpected Demo template; CSP generation stopped.");
  // Meta CSP cannot enforce frame-ancestors; hosting may add its own response header.
  const csp = `default-src 'none'; script-src ${scripts.join(" ")}; style-src ${styles.join(" ")}; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return template.replace(
    '<meta charset="utf-8" />',
    `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <meta name="agentarts-record-source" content="static-export" />\n    <meta name="referrer" content="no-referrer" />`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(USAGE);
    return;
  }
  let recordPath, outputPath;
  for (let i = 0; i < args.length; i++) {
    const name = args[i],
      value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
    if (name === "--record" && recordPath === undefined) recordPath = value;
    else if (name === "--out" && outputPath === undefined) outputPath = value;
    else throw new Error(`Unknown or repeated option: ${name}.`);
  }
  if (!recordPath || !isAbsolute(recordPath))
    throw new Error("--record requires an explicit absolute path.");
  if (!outputPath)
    throw new Error("--out is required and must name a new directory with an existing parent.");
  const payload = await boundedRecord(recordPath);
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new Error("Record must be valid UTF-8 JSON; no record content was printed.");
  }
  preflightJson(decoded);
  let record;
  try {
    record = JSON.parse(decoded);
  } catch {
    throw new Error("Record must be valid UTF-8 JSON; no record content was printed.");
  }
  validate(record);
  const html = staticHtml(
    await readFile(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8"),
  );
  const destination = resolve(outputPath);
  // Atomic exclusive mkdir refuses existing directories, files and symlinks. No recursive creation or deletion.
  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("Output path already exists; refusing to overwrite it.");
    throw error;
  }
  await writeFile(resolve(destination, "index.html"), html, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(destination, "run-record.json"), payload, { flag: "wx", mode: 0o600 });
  console.log(`Static history exported: ${destination}`);
  console.log(
    "Record bytes, mode, task, timestamps and results were preserved. No task ran and nothing was published.",
  );
  console.log(
    "发布前必须人工审查 run-record.json 的脱敏内容：已知字符串字段也可能含凭证、代码或日志。本命令拒绝未知字段，但不保证自动脱敏，也不自动发布。",
  );
}

main().catch((error) => {
  console.error(`Export stopped: ${error.message}`);
  console.error(USAGE);
  process.exitCode = 1;
});
