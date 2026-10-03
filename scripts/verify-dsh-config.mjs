import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const dshPackage = require.resolve("@deepseek-ai/dsh/package.json");
const dshBin = join(dshPackage, "..", "lib", "bin.js");
const headlessPackage = require.resolve("@deepseek-ai/dsh-headless/package.json");
const headlessRunner = join(headlessPackage, "..", "lib", "index.js");
const headlessStartup = join(headlessPackage, "..", "lib", "startup.js");
const projectRoot = join(import.meta.dirname, "..");
const nativeLauncher = join(projectRoot, "assets", "dsh", "native-launcher.mjs");
const controlledLauncher = join(projectRoot, "assets", "dsh", "action-launcher.mjs");
const dshHome = await mkdtemp(join(tmpdir(), "dsh-action-config-"));

try {
  const [runnerSource, startupSource, nativeLauncherSource, controlledLauncherSource, action] =
    await Promise.all([
      readFile(headlessRunner, "utf8"),
      readFile(headlessStartup, "utf8"),
      readFile(nativeLauncher, "utf8"),
      readFile(controlledLauncher, "utf8"),
      readFile(join(projectRoot, "action.yml"), "utf8"),
    ]);
  assert.match(
    runnerSource,
    /const Config = z\.object\(\{\s*task: z\.string\(\),\s*sessionId: z\.string\(\),\s*json: z\.boolean\(\)\s*\}\);/u,
    "the audited headless runner exposes task, session identity, and JSON projection only",
  );
  assert.match(
    runnerSource,
    /content:\s*\[\{\s*type:\s*"text",\s*text:\s*task\s*\}\]/u,
    "the audited headless runner must submit the task as one text content block",
  );
  assert.doesNotMatch(
    runnerSource,
    /type:\s*["']image["']/u,
    "GitHub attachments must remain deferred until the audited headless runner exposes images",
  );
  assert.match(
    startupSource,
    /\.argument\(\s*"\[task\.\.\.\]"/u,
    "the audited headless startup must continue to accept the single text task positional",
  );
  assert.match(
    startupSource,
    /\.option\("--json"/u,
    "the published JSON projection flag is available",
  );
  assert.match(
    startupSource,
    /\.option\("--session-id <id>"/u,
    "the upstream adoption option is accounted for",
  );
  assert.match(
    runnerSource,
    /await agent\.whenIdle\(\)/u,
    "headless must wait for Agent quiescence",
  );
  assert.match(
    runnerSource,
    /await sessions\.flush\(agent\.session\)/u,
    "headless must flush its owned Session before exit",
  );
  for (const [mode, launcherSource] of [
    ["controlled", controlledLauncherSource],
    ["native", nativeLauncherSource],
  ]) {
    assert.match(
      launcherSource,
      /\["--json", "--", task\]/u,
      `${mode} must opt into JSON and bind one literal task after the option terminator`,
    );
    assert.doesNotMatch(
      launcherSource,
      /--(?:file|image|attachment)(?:[\s"'=]|$)/u,
      `${mode} must not opt into unsupported attachment entry points`,
    );
    assert.match(
      launcherSource,
      /sessionPlan\?\.sessionId === undefined/u,
      `${mode} must keep Session resume opt-in`,
    );
    assert.match(
      launcherSource,
      /\["--json", "--session-id", sessionPlan\.sessionId, "--", task\]/u,
      `${mode} must use the published literal Headless resume argument`,
    );
    assert.match(
      launcherSource,
      /sessionEnabled \? await import\("\.\/action-session\.mjs"\) : undefined/u,
      `${mode} must require Controller Session admission only for explicit opt-in`,
    );
    for (const row of [
      "session-telemetry-otel",
      "session-log-deepseek",
      "plugin-package-inventory-deepseek",
    ]) {
      assert.ok(
        launcherSource.includes(`{ id: "${row}", disabled: true }`),
        `${mode} must explicitly suppress ${row}`,
      );
    }
  }
  const actionInputs = Object.keys(parse(action).inputs);
  for (const forbidden of [
    "session-id",
    "resume",
    "resume-session",
    "file",
    "files",
    "image",
    "images",
    "attachment",
    "attachments",
  ]) {
    assert.ok(
      !actionInputs.includes(forbidden),
      `Action must not expose ${forbidden} in this migration`,
    );
  }
  assert.match(
    nativeLauncherSource,
    /loadProfile\(NAME, PROFILE, INSTALL_ANCHOR, dshHome\)/u,
    "native mode must load the official DSH headless Profile",
  );
  assert.match(
    nativeLauncherSource,
    /host\.on\("agent\/created", \(\{ agent \}\) =>/u,
    "native tool observation must sample the actual published Agent scope",
  );
  assert.match(
    nativeLauncherSource,
    /tools\.schemas\(agent\)/u,
    "native observedTools must come from the public DSH ToolRuntime schema view",
  );
  assert.match(
    nativeLauncherSource,
    /\{ id: "session-telemetry-otel", disabled: true \}/u,
    "the programmatic native launcher must preserve default-off DSH telemetry",
  );
  assert.doesNotMatch(
    nativeLauncherSource,
    /\.restrict\(|action-policy|action-workspace/u,
    "native observation must not install or imitate the controlled ToolRuntime policy",
  );

  for (const patch of [
    "strict-untrusted.patch.yml",
    "trusted-read.patch.yml",
    "trusted-write.patch.yml",
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        dshBin,
        "--profile",
        "headless",
        "--patch",
        join(projectRoot, "assets", "dsh", patch),
        "--dump-config",
      ],
      {
        cwd: dshHome,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          DSH_HOME: dshHome,
          DSH_TELEMETRY_DISABLED: "1",
          DSH_TOOLS_MODE: "native",
        },
        timeout: 60_000,
      },
    );
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(
        `${patch} was rejected by DSH: ${result.error?.message ?? result.stderr ?? "unknown failure"}`,
      );
    }
  }
} finally {
  await rm(dshHome, { force: true, recursive: true });
}
