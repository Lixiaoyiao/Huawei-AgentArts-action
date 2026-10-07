import { readFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import prettier from "prettier";
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.includes("/src/")
        ? `${specifier.slice(0, -3)}.ts`
        : specifier,
      context,
    );
  },
});
const { ACTION_INPUT_CONTRACT } = await import("../src/action-contract.ts");
const managed = new Set([
  "deepseek-api-key",
  "dsh-version",
  "dsh-executable",
  "isolation",
  "base-url",
  "web-search-base-url",
]);
const inputs = Object.fromEntries(
  ACTION_INPUT_CONTRACT.filter(({ name }) => !managed.has(name)).map(
    ({ name, description, required, default: fallback }) => [
      name,
      { description, required, ...(fallback === undefined ? {} : { default: fallback }) },
    ],
  ),
);
Object.assign(inputs, {
  "runtime-origin": {
    description: "HTTPS AgentArts Runtime invocation origin (no path).",
    required: true,
  },
  "runtime-name": { description: "Deployed high-code Runtime name.", required: true },
  "runtime-endpoint": {
    description: "Operator-pinned Runtime version alias; Latest is rejected.",
    required: true,
  },
  "runtime-api-key": {
    description: "Controller-only inbound Runtime API_KEY; never enters tasks or DSH.",
    required: true,
  },
});
const root = resolve(import.meta.dirname, "..");
const original = parse(await readFile(resolve(root, "action.yml"), "utf8"));
const metadata = {
  name: "Huawei-AgentArts-action",
  description:
    "Run pinned DSH tasks on AgentArts; reuse the original Controller authorization, independent validation and GitHub publication.",
  author: "Lixiaoyiao",
  inputs,
  outputs: {
    ...original.outputs,
    "run-record": { description: "Redacted Controller task record path for evidence and Demo." },
  },
  runs: { using: "node24", main: "../dist-agentarts/controller/index.js" },
};
const path = resolve(root, "agentarts/action.yml");
const expected = await prettier.format(
  `# Generated from the upstream Action contract. Run node scripts/generate-agentarts-action.mjs --write.\n${stringify(metadata)}`,
  { ...(await prettier.resolveConfig(path)), filepath: path },
);
if (process.argv.includes("--write")) await writeFile(path, expected);
else if ((await readFile(path, "utf8")) !== expected)
  throw new Error(
    "AgentArts Action contract drift; run node scripts/generate-agentarts-action.mjs --write",
  );
process.stdout.write("AgentArts Action contract checked.\n");
