import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

const PACKAGE = "@deepseek-ai/dsh-llm";
const MODULE = `./node_modules/${PACKAGE}/lib/index.js`;
const MARKER = `;// CONCATENATED MODULE: ${MODULE}`;
const SOURCE_CALL = 'createRequire(import.meta.url)("../package.json")';
// Audited npm artifact from the existing lock. A DSH upgrade reviews this
// build adaptation independently instead of silently carrying it forward.
const AUDITED_VERSION = "0.2.0-rc.2";
const AUDITED_SOURCE_SHA256 = "9132c8a8053ee82b9fb1ded4f98c85cf557f288a15a85c552c6b1fb319ead120";

/** Read the actual upstream package identity, never the derivative Action version. */
export async function dshAttributionIdentity(root) {
  const packageRoot = join(root, "node_modules", PACKAGE);
  const [manifestText, lockText, source] = await Promise.all([
    readFile(join(packageRoot, "package.json"), "utf8"),
    readFile(join(root, "package-lock.json"), "utf8"),
    readFile(join(packageRoot, "lib/index.js"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText),
    lock = JSON.parse(lockText);
  const locked = lock.packages?.[`node_modules/${PACKAGE}`];
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  if (
    manifest.name !== PACKAGE ||
    manifest.version !== AUDITED_VERSION ||
    locked?.version !== manifest.version ||
    sourceSha256 !== AUDITED_SOURCE_SHA256 ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(manifest.version) ||
    source.split(SOURCE_CALL).length !== 2
  )
    throw new Error(
      "DSH attribution package/source drifted; review the NCC adaptation before rebuilding.",
    );
  return {
    package: PACKAGE,
    version: manifest.version,
    source: `${PACKAGE}/lib/index.js`,
    sourceSha256,
  };
}
function unwrap(expression) {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.CommaToken
  )
    return unwrap(expression.right);
  return expression;
}
function isAttributionRead(node) {
  if (
    !ts.isCallExpression(node) ||
    node.arguments.length !== 1 ||
    !ts.isStringLiteral(node.arguments[0]) ||
    node.arguments[0].text !== "../package.json"
  )
    return false;
  const callee = unwrap(node.expression);
  if (
    !ts.isCallExpression(callee) ||
    callee.arguments.length !== 1 ||
    callee.arguments[0].getText() !== "import.meta.url"
  )
    return false;
  const factory = unwrap(callee.expression);
  return ts.isPropertyAccessExpression(factory) && factory.name.text === "createRequire";
}
/**
 * NCC 0.45 cannot relocate this DSH createRequire(import.meta.url) read.
 * Replace only the identified upstream attribution expression after bundling.
 * Padding preserves every generated character/line offset used by NCC maps.
 * No upstream installed file or runtime loader is modified.
 */
export function adaptDshAttribution(code, identity, includedInSourceMap) {
  const start = code.indexOf(MARKER);
  if (start === -1) {
    if (includedInSourceMap)
      throw new Error("NCC DSH module layout changed; attribution adaptation refused.");
    return { code, adaptation: { ...identity, replacements: 0, reason: "not-bundled" } };
  }
  if (code.indexOf(MARKER, start + MARKER.length) !== -1)
    throw new Error("NCC repeated the DSH attribution module; adaptation refused.");
  const next = code.indexOf(";// CONCATENATED MODULE:", start + MARKER.length);
  const end = next === -1 ? code.length : next;
  const part = code.slice(start, end);
  const parsed = ts.createSourceFile(
    "bundled-dsh-llm.js",
    part,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const matches = [];
  const visit = (node) => {
    if (isAttributionRead(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (matches.length !== 1)
    throw new Error("NCC DSH attribution expression drifted; adaptation refused.");
  const match = matches[0],
    from = start + match.getStart(parsed),
    to = start + match.end;
  const original = code.slice(from, to),
    replacement = JSON.stringify({ version: identity.version });
  if (original.includes("\n") || original.includes("\r") || replacement.length > original.length)
    throw new Error("NCC DSH attribution expression cannot preserve source-map positions.");
  return {
    code: code.slice(0, from) + replacement.padEnd(original.length) + code.slice(to),
    adaptation: {
      ...identity,
      replacements: 1,
      generatedModule: MODULE,
      reason: "inline-locked-upstream-package-version",
      sourceMapOffsetsPreserved: true,
    },
  };
}
