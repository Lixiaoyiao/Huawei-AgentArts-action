import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const cli = resolve("agentarts/preflight.mjs");
let root: string;
let configPath: string;
const validConfig = async () => {
  const config = JSON.parse(
    await readFile("agentarts/examples/deployment-config.example.json", "utf8"),
  ) as Record<string, unknown>;
  config.sourceCommit = "a".repeat(40);
  const swr = config.swr as Record<string, unknown>;
  swr.digest = `sha256:${"b".repeat(64)}`;
  const runtime = config.runtime as Record<string, unknown>;
  runtime.origin = "https://fixture-runtime.example.test";
  return config;
};
const run = (...args: string[]) =>
  execute(process.execPath, [cli, ...args], {
    maxBuffer: 64 * 1024,
    env: {
      ...process.env,
      AGENTARTS_RUNTIME_API_KEY: "private-runtime-value-never-print",
      DEEPSEEK_API_KEY: "private-model-value-never-print",
      GITHUB_TOKEN: "private-github-value-never-print",
    },
  });
const refusal = async (
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> => {
  let failure: unknown;
  try {
    await run(...args);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  const result = failure as { code: number; stdout: string; stderr: string };
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  return result;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentarts-preflight-test-"));
  configPath = join(root, "deployment.json");
  await writeFile(configPath, JSON.stringify(await validConfig()));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("offline deployment preflight", () => {
  it("validates configuration without mutating it or reading/printing credential values", async () => {
    const original = await readFile(configPath);
    const { stdout, stderr } = await run("--config", configPath);
    const result = JSON.parse(stdout) as {
      localConfiguration: string;
      cloudAcceptance: string;
      image: { checked: boolean };
      credentialVariableNamesPresent: Record<string, boolean>;
      operatorDeclaredPending: string[];
    };
    expect(result.localConfiguration).toBe("passed");
    expect(result.cloudAcceptance).toBe("unverified");
    expect(result.image.checked).toBe(false);
    expect(result.credentialVariableNamesPresent).toEqual({
      AGENTARTS_RUNTIME_API_KEY: true,
      DEEPSEEK_API_KEY: true,
      GITHUB_TOKEN: true,
    });
    expect(result.operatorDeclaredPending).toContain("serviceApproved");
    expect(stdout).not.toContain("private-runtime-value");
    expect(stdout).not.toContain("private-model-value");
    expect(stdout).not.toContain("private-github-value");
    expect(stderr).toBe("");
    expect(await readFile(configPath)).toEqual(original);
    expect(await readdir(root)).toEqual(["deployment.json"]);
  });

  it.each(["latest", "main"])("rejects floating image tag %s", async (tag) => {
    const config = await validConfig();
    (config.swr as Record<string, unknown>).tag = tag;
    await writeFile(configPath, JSON.stringify(config));
    await expect(run("--config", configPath)).rejects.toThrow(/floating tag/u);
  });

  it("rejects Latest, wrong auth and session storage", async () => {
    for (const [field, value] of [
      ["endpoint", "Latest"],
      ["authentication", "IAM"],
      ["storage", "session"],
    ]) {
      const config = await validConfig();
      (config.runtime as Record<string, unknown>)[field ?? ""] = value;
      await writeFile(configPath, JSON.stringify(config));
      await expect(run("--config", configPath)).rejects.toThrow();
    }
  });

  it("refuses credentials in configuration and duplicate keys without printing values", async () => {
    const config = await validConfig();
    await writeFile(configPath, JSON.stringify({ ...config, apiKey: "inline-private-value" }));
    await expect(run("--config", configPath)).rejects.toThrow(/unknown fields/u);
    const text = JSON.stringify(config);
    await writeFile(
      configPath,
      `${text.slice(0, -1)},"runtime":{"apiKey":"hidden-private-value"}}`,
    );
    const failure = await refusal("--config", configPath);
    expect(failure.stderr).toContain("unique-key UTF-8 JSON");
    expect(failure.stderr).not.toContain("hidden-private-value");
  });

  it("does not accept placeholder digest or credentials in origin", async () => {
    const config = await validConfig();
    (config.swr as Record<string, unknown>).digest = "REPLACE_WITH_DIGEST";
    await writeFile(configPath, JSON.stringify(config));
    await expect(run("--config", configPath)).rejects.toThrow(/manifest digest/u);
    const other = await validConfig();
    (other.runtime as Record<string, unknown>).origin =
      "https://user:private-password@fixture.example.test";
    await writeFile(configPath, JSON.stringify(other));
    const failure = await refusal("--config", configPath);
    expect(failure.stderr).toContain("without credentials");
    expect(failure.stderr).not.toContain("private-password");
  });

  it("rejects escaped nested duplicate keys before applying configuration", async () => {
    const text = JSON.stringify(await validConfig());
    await writeFile(
      configPath,
      text.replace(
        '"authentication":"API_KEY"',
        '"authentication":"API_KEY","authenticati\\u006fn":"IAM"',
      ),
    );
    const failure = await refusal("--config", configPath);
    expect(failure.stderr).toContain("unique-key UTF-8 JSON");
    expect(await readdir(root)).toEqual(["deployment.json"]);
  });

  it("rejects oversized files and malformed UTF-8 without printing their contents", async () => {
    for (const bytes of [
      Buffer.from(`{"private":"${"oversized-private".repeat(3000)}"}`),
      Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
    ]) {
      await writeFile(configPath, bytes);
      const failure = await refusal("--config", configPath);
      expect(failure.stderr).toContain("bounded, unique-key UTF-8 JSON");
      expect(failure.stderr).not.toContain("oversized-private");
      expect(await readFile(configPath)).toEqual(bytes);
    }
  });

  it("rejects remote Docker host before any Docker inspection", async () => {
    await expect(
      run(
        "--config",
        configPath,
        "--inspect-image",
        "huawei-agentarts-action:fixture",
        "--docker-host",
        "tcp://example.test:2376",
      ),
    ).rejects.toThrow(/local Unix socket/u);
    expect(await readdir(root)).toEqual(["deployment.json"]);
  });

  it("requires explicit absolute configuration and keeps cloud acceptance unverified even when all operator flags are true", async () => {
    await expect(run("--config", "relative.json")).rejects.toThrow(/absolute path/u);
    const config = await validConfig();
    for (const key of Object.keys(config.readiness as Record<string, unknown>))
      (config.readiness as Record<string, unknown>)[key] = true;
    await writeFile(configPath, JSON.stringify(config));
    const result = JSON.parse((await run("--config", configPath)).stdout) as {
      cloudAcceptance: string;
      operatorDeclaredPending: string[];
    };
    expect(result.operatorDeclaredPending).toEqual([]);
    expect(result.cloudAcceptance).toBe("unverified");
  });
});
