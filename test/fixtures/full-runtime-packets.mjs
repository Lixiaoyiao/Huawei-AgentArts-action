import { createHash, randomUUID } from "node:crypto";
export const fullSource = "export const add = (a, b) => a - b;\n";
export const fullCorrected = "export const add = (a, b) => a + b;\n";
export const fullHash = (text) => createHash("sha256").update(text).digest("hex");
export function canonicalFullJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFullJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalFullJson(value[key])}`)
    .join(",")}}`;
}
/** Test protocol fixture, not an SDK or a cloud platform API. Strict source-schema tests check it. */
export function fullPacket(
  id,
  operation,
  { write = false, native = false, timeoutMs = 30_000 } = {},
) {
  const grants = {
    mode: native ? "native" : "controlled",
    trust: write ? "trusted-write" : "trusted-read",
    requestedAccess: write ? "write" : "read",
    tools: native
      ? ["workspace.read", "workspace.edit", "native.bash"]
      : write
        ? ["workspace.read", "workspace.edit"]
        : ["workspace.read"],
    toolCatalog: [],
  };
  const binding = {
    taskId: randomUUID(),
    operation,
    operationIdentity: `${operation}:container-fixture:${id}`,
    repository: "fixture/full-runtime",
    entity:
      operation === "implement"
        ? { kind: "issue", number: 9 }
        : { kind: "pull_request", number: 7 },
    ref: "fixture",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    revision: 0,
    grantDigest: fullHash(canonicalFullJson(grants)),
  };
  const transferBinding = {
    repository: binding.repository,
    baseSha: binding.baseSha,
    headSha: binding.headSha,
    revision: binding.revision,
    taskId: binding.taskId,
    operation: binding.operation,
    entity: binding.entity,
    ref: binding.ref,
    grantDigest: binding.grantDigest,
    operationIdentity: binding.operationIdentity,
  };
  const body = {
    schemaVersion: 1,
    binding: transferBinding,
    files: [
      {
        path: "src/add.js",
        sha256: fullHash(fullSource),
        mode: 0o644,
        encoding: "utf8",
        content: fullSource,
      },
    ],
  };
  return {
    schemaVersion: 3,
    taskId: binding.taskId,
    operation,
    binding,
    ...grants,
    timeoutMs,
    instructions: `FULL_CONTAINER_CASE=${id}. This is a deterministic model fixture, not a quality score.`,
    context: {
      taskContext: {
        repository: binding.repository,
        entity: { ...binding.entity, headSha: binding.headSha, baseSha: binding.baseSha },
        source: fullSource,
      },
      fixtureCase: id,
    },
    workspace: { ...body, digest: fullHash(JSON.stringify(body)) },
  };
}
export function fullOutput(operation) {
  return {
    protocolVersion: 1,
    operation,
    state: "final",
    summary: "Deterministic fixture passed through the production DSH runtime.",
    findings: [],
    ...(operation === "diagnose"
      ? { diagnosis: "The subtraction operator contradicts the addition contract." }
      : {}),
  };
}
