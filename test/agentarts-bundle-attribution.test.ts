import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { adaptDshAttribution, dshAttributionIdentity } from "../scripts/bundle-dsh-attribution.mjs";

const marker = ";// CONCATENATED MODULE: ./node_modules/@deepseek-ai/dsh-llm/lib/index.js\n";
const expression = '(0,external_node_module_.createRequire)(import.meta.url)("../package.json")';
const identity = {
  package: "@deepseek-ai/dsh-llm",
  version: "0.2.0-rc.2",
  source: "@deepseek-ai/dsh-llm/lib/index.js",
  sourceSha256: "9132c8a8053ee82b9fb1ded4f98c85cf557f288a15a85c552c6b1fb319ead120",
};
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
describe("NCC adaptation for the audited DSH attribution package read", () => {
  it("uses upstream DSH version and preserves generated source-map offsets without a package at runtime", () => {
    const code =
      marker + `const { version } = ${expression};\nglobalThis.actualVersion = version;\n`;
    const adapted = adaptDshAttribution(code, identity, true);
    expect(adapted.code.length).toBe(code.length);
    expect(adapted.code.split("\n").map((line) => line.length)).toEqual(
      code.split("\n").map((line) => line.length),
    );
    const result: { actualVersion?: string } = {};
    runInNewContext(adapted.code, result);
    expect(result.actualVersion).toBe("0.2.0-rc.2");
    expect(adapted.code).not.toContain("0.9.3");
    expect(adapted.adaptation).toMatchObject({
      ...identity,
      replacements: 1,
      sourceMapOffsetsPreserved: true,
    });
  });
  it("does not patch another module's relative require and refuses unknown layouts/counts", () => {
    const other = `;// CONCATENATED MODULE: ./other.js\nconst other = ${expression};\n`;
    const adapted = adaptDshAttribution(
      marker + `const { version } = ${expression};\n` + other,
      identity,
      true,
    );
    expect(adapted.code).toContain(`const other = ${expression}`);
    expect(() => adaptDshAttribution(other, identity, true)).toThrow("layout");
    expect(() =>
      adaptDshAttribution(marker + "const version = 'changed';", identity, true),
    ).toThrow("drifted");
    expect(() =>
      adaptDshAttribution(marker + `const a=${expression};const b=${expression};`, identity, true),
    ).toThrow("drifted");
    expect(() =>
      adaptDshAttribution(marker + marker + `const a=${expression};`, identity, true),
    ).toThrow("repeated");
    expect(adaptDshAttribution(other, identity, false).code).toBe(other);
  });
  it("records the installed locked artifact without modifying its source", async () => {
    const source = join(process.cwd(), "node_modules/@deepseek-ai/dsh-llm/lib/index.js");
    const original = await readFile(source);
    expect(await dshAttributionIdentity(process.cwd())).toEqual(identity);
    expect((await readFile(source)).equals(original)).toBe(true);
  });
  it("fails closed on package version, lock mismatch or source drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentarts-attribution-drift-"));
    temporary.push(root);
    const packageRoot = join(root, "node_modules/@deepseek-ai/dsh-llm");
    await mkdir(join(packageRoot, "lib"), { recursive: true });
    const source = await readFile(
      join(process.cwd(), "node_modules/@deepseek-ai/dsh-llm/lib/index.js"),
    );
    const manifest = { name: identity.package, version: identity.version };
    const lock = {
      packages: { "node_modules/@deepseek-ai/dsh-llm": { version: identity.version } },
    };
    await writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest));
    await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
    await writeFile(join(packageRoot, "lib/index.js"), source);
    expect(await dshAttributionIdentity(root)).toEqual(identity);
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ ...manifest, version: "0.9.3" }),
    );
    await expect(dshAttributionIdentity(root)).rejects.toThrow("drifted");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest));
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: {} }));
    await expect(dshAttributionIdentity(root)).rejects.toThrow("drifted");
    await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
    await writeFile(
      join(packageRoot, "lib/index.js"),
      Buffer.concat([source, Buffer.from("\n// source changed\n")]),
    );
    await expect(dshAttributionIdentity(root)).rejects.toThrow("drifted");
  });
});
