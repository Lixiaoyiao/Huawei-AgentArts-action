import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const ncc = resolve(root, "node_modules/@vercel/ncc/dist/ncc/cli.js");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--runtime-only"))
  throw new Error("Usage: node scripts/build-agentarts.mjs [--runtime-only]");
const entries = [
  ["src/agentarts/main.ts", "controller"],
  ["src/agentarts/runtime-main.ts", "runtime"],
  ["src/agentarts/local-proof.ts", "local-proof"],
  ["src/agentarts/live-review.ts", "live-review"],
];
for (const [entry, directory] of entries) {
  if (args[0] === "--runtime-only" && directory !== "runtime") continue;
  await mkdir(resolve(root, "dist-agentarts", directory), { recursive: true });
  const result = spawnSync(
    process.execPath,
    [ncc, "build", entry, "-o", `dist-agentarts/${directory}`, "--source-map", "--no-cache"],
    { cwd: root, stdio: "inherit", shell: false, windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
