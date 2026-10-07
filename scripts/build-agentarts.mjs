import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { adaptDshAttribution, dshAttributionIdentity } from "./bundle-dsh-attribution.mjs";
const root = resolve(import.meta.dirname, "..");
const ncc = resolve(root, "node_modules/@vercel/ncc/dist/ncc/cli.js");
const args = process.argv.slice(2);
const entries = [
  ["src/agentarts/main.ts", "controller"],
  ["src/agentarts/runtime-main.ts", "runtime"],
  ["src/agentarts/local-proof.ts", "local-proof"],
  ["src/agentarts/live-review-main.ts", "live-review"],
  ["src/agentarts/live-full-main.ts", "live-full"],
  ["src/agentarts/local-github-main.ts", "local-github"],
];
const selected =
  args.length === 1 && args[0] === "--runtime-only"
    ? "runtime"
    : args.length === 2 && args[0] === "--entry" && entries.some(([, name]) => name === args[1])
      ? args[1]
      : args.length === 0
        ? undefined
        : null;
if (selected === null)
  throw new Error(
    "Usage: node scripts/build-agentarts.mjs [--runtime-only | --entry <fixed bundle name>]",
  );
const identity = await dshAttributionIdentity(root);
const bundler = JSON.parse(
  await readFile(resolve(root, "node_modules/@vercel/ncc/package.json"), "utf8"),
);
if (bundler.version !== "0.45.0")
  throw new Error("NCC version drifted; review the DSH attribution adaptation before rebuilding.");
const outputBase = resolve(root, "dist-agentarts");
await mkdir(outputBase, { recursive: true });
if (
  (await lstat(outputBase)).isSymbolicLink() ||
  resolve(await realpath(outputBase)) !== outputBase
)
  throw new Error("Bundle output base must be the real project dist-agentarts directory.");
for (const [entry, directory] of entries) {
  if (selected !== undefined && directory !== selected) continue;
  const output = resolve(outputBase, directory);
  if (dirname(output) !== outputBase || !entries.some(([, name]) => name === directory))
    throw new Error("Bundle cleanup escaped its fixed output directory.");
  try {
    if ((await lstat(output)).isSymbolicLink() || resolve(await realpath(output)) !== output)
      throw new Error("Bundle output must not be a symlink or redirected directory.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // Only the checked fixed child is removed; stale NCC chunks must not survive.
  await rm(output, { recursive: true, force: true });
  await mkdir(output);
  const result = spawnSync(
    process.execPath,
    [ncc, "build", entry, "-o", `dist-agentarts/${directory}`, "--source-map", "--no-cache"],
    { cwd: root, stdio: "inherit", shell: false, windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const code = await readFile(resolve(output, "index.js"), "utf8");
  const map = JSON.parse(await readFile(resolve(output, "index.js.map"), "utf8"));
  if (!Array.isArray(map.sources)) throw new Error("NCC did not emit a source inventory.");
  const included = map.sources.some(
    (source) =>
      typeof source === "string" &&
      source.replaceAll("\\", "/").includes("node_modules/@deepseek-ai/dsh-llm/lib/index.js"),
  );
  const adapted = adaptDshAttribution(code, identity, included);
  await writeFile(resolve(output, "index.js"), adapted.code);
  await writeFile(
    resolve(output, "bundle-adaptations.json"),
    `${JSON.stringify({ schemaVersion: 1, bundler: `@vercel/ncc@${bundler.version}`, adaptations: [adapted.adaptation] }, null, 2)}\n`,
  );
}
