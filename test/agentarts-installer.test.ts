import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runAgentArtsInstaller } from "../agentarts/install.mjs";

const directories: string[] = [],
  sha = "0123456789abcdef0123456789abcdef01234567";
class Capture extends Writable {
  public text = "";
  public override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.text += chunk.toString();
    callback();
  }
}
async function project(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agentarts-installer-test-"));
  directories.push(path);
  return path;
}
async function install(argv: string[], cwd?: string) {
  const target = cwd ?? (await project());
  const output = new Capture();
  const result = await runAgentArtsInstaller({
    argv,
    cwd: target,
    input: Readable.from([]),
    output,
    isTTY: false,
    env: { CI: "true" },
  });
  return { result, output: output.text, cwd: target };
}
interface Workflow {
  permissions: Record<string, string>;
  jobs: Record<string, { steps: { uses?: string; with?: Record<string, unknown> }[] }>;
}
async function workflow(cwd: string, kind: string) {
  return parse(
    await readFile(join(cwd, ".github/workflows/dsh-" + kind + ".yml"), "utf8"),
  ) as Workflow;
}
function action(document: Workflow) {
  const steps = Object.values(document.jobs).flatMap((job) => job.steps);
  const selected = steps.filter((step) =>
    step.uses?.startsWith("Lixiaoyiao/Huawei-AgentArts-action/agentarts@"),
  );
  expect(selected).toHaveLength(1);
  expect(selected[0]?.uses).toBe("Lixiaoyiao/Huawei-AgentArts-action/agentarts@" + sha);
  return selected[0]?.with ?? {};
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AgentArts embedding of the inherited installer", () => {
  it.each(["controlled", "native"])(
    "reuses review/commands permissions and validation in %s mode",
    async (mode) => {
      const validation = [["node", "--test"]],
        image = "node@sha256:" + "a".repeat(64);
      const result = await install([
        "--mode",
        "both",
        "--action-ref",
        sha,
        "--dsh-mode",
        mode,
        "--test-commands",
        JSON.stringify(validation),
        "--container-image",
        image,
      ]);
      expect(result.result.createdFiles).toEqual([
        ".github/workflows/dsh-review.yml",
        ".github/workflows/dsh-commands.yml",
      ]);
      const review = await workflow(result.cwd, "review"),
        commands = await workflow(result.cwd, "commands");
      expect(review.permissions).toEqual({ contents: "read", "pull-requests": "write" });
      expect(commands.permissions).toMatchObject({
        contents: "write",
        issues: "write",
        "pull-requests": "write",
        actions: "read",
        checks: "read",
      });
      const reviewInputs = action(review),
        commandInputs = action(commands);
      expect(reviewInputs["allow-write"]).toBe("false");
      expect(commandInputs["allow-write"]).toBe("true");
      expect(commandInputs["validation-integrity"]).toBe("strict");
      expect(commandInputs["test-commands"]).toBe(JSON.stringify(validation));
      expect(commandInputs["container-image"]).toBe(image);
      for (const inputs of [reviewInputs, commandInputs]) {
        expect(inputs["runtime-api-key"]).toBe("${{ secrets.AGENTARTS_RUNTIME_API_KEY }}");
        expect(inputs["runtime-origin"]).toBe("${{ vars.AGENTARTS_RUNTIME_ORIGIN }}");
        expect(inputs).not.toHaveProperty("deepseek-api-key");
        expect(inputs).not.toHaveProperty("dsh-version");
        expect(inputs).not.toHaveProperty("isolation");
        if (mode === "native") expect(inputs["dsh-mode"]).toBe("native");
      }
      expect(result.output).toContain("model key belongs only");
      expect(result.output).not.toContain("Add DEEPSEEK_API_KEY");
    },
  );
  it("retains the inherited fail-closed validation placeholder without reading package scripts", async () => {
    const cwd = await project();
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: { test: "do not execute fixture", preinstall: "do not execute fixture" },
      }),
    );
    const result = await install(["--mode", "commands", "--action-ref=" + sha], cwd);
    expect(action(await workflow(cwd, "commands"))["test-commands"]).toContain(
      "REQUIRED: replace test-commands",
    );
    expect(result.output).toContain("fail-closed test placeholder");
    expect((await readdir(cwd)).sort()).toEqual([".github", "package.json"]);
  });
  it("refuses overwrite using the original installer before changing existing files", async () => {
    const first = await install(["--mode", "review", "--action-ref", sha]);
    const path = join(first.cwd, ".github/workflows/dsh-review.yml"),
      original = await readFile(path);
    await expect(install(["--mode", "both", "--action-ref", sha], first.cwd)).rejects.toThrow(
      /overwrite/u,
    );
    expect(await readFile(path)).toEqual(original);
    expect(await readdir(join(first.cwd, ".github/workflows"))).toEqual(["dsh-review.yml"]);
  });
  it.each(
    [
      [],
      ["--action-ref", "main"],
      ["--action-ref", sha, "--action-ref", sha],
      ["--action-ref", sha, "--mode", "review", "--test-commands", '[["node","--test"]]'],
    ].map((argv) => ({ argv })),
  )("rejects incomplete or unsafe options %j without generating files", async ({ argv }) => {
    const cwd = await project();
    await expect(install(argv, cwd)).rejects.toThrow();
    expect(await readdir(cwd)).toEqual([]);
  });
  it("shows offline help without a binding, resource calls or output files", async () => {
    const result = await install(["--help"]);
    expect(result.output).toContain("--action-ref");
    expect(result.result.createdFiles).toEqual([]);
    expect(await readdir(result.cwd)).toEqual([]);
  });
});
