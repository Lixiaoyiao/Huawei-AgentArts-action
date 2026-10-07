import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDshRuntime, disposeDshRuntime } from "../src/dsh/runtime.js";
import {
  prepareLockedRuntimeFiles,
  captureExtensionInstallBaseline,
  assertExtensionInstallBaseline,
  auditFreshExtensionInstallation,
} from "../src/dsh/install.js";
import { NativeComposition } from "../src/dsh/native-composition.js";
import { DSH_VERSION } from "../src/release.js";
import { resolveNativeExtensionPlan } from "../src/extensions/plan.js";
import {
  parseNativeMcpConfiguration,
  parseNativePluginConfiguration,
} from "../src/extensions/schema.js";
import { evaluatePolicy } from "../src/security/policy.js";
import { installAgentArtsPackages } from "../src/agentarts/installer.js";

// Both npm 7.0.0 gitHead and the public GitHub 7.0.0 tag were read independently on 2026-10-07.
const COMMIT = "98e8ff1da1a89f93d1397a24d7413ed15421c139";
const SOURCE = `git+https://github.com/jonschlinkert/is-number.git#${COMMIT}`;
const enabled =
  process.platform === "linux" &&
  process.getuid?.() === 0 &&
  process.env.AGENTARTS_RUN_GIT_INSTALLER_PROOF === "true";
const origins = ["https://registry.npmjs.org", "https://github.com", "https://codeload.github.com"];
const policy = () =>
  evaluatePolicy({
    context: {
      kind: "automation",
      rawEventName: "workflow_dispatch",
      eventName: "workflow_dispatch",
      runId: "git-install-fixture",
      actor: "controller",
      repository: { id: 1, owner: "offline", repo: "installer", fullName: "offline/installer" },
      payload: {},
      isPullRequestTarget: false,
    },
    operation: "task",
    requestedAccess: "read",
    allowWrite: false,
    permissions: { actors: [], allActorsHaveWrite: true, allActorsAllowedForWrite: true },
  });
describe("fixed public Git source compatibility (explicit public network opt-in)", () => {
  it.skipIf(!enabled)(
    "installs an immutable GitHub commit with verified TLS and passes the original lock audit",
    async () => {
      const runtime = await createDshRuntime(),
        actionRoot = process.cwd();
      const abort = new AbortController(),
        deadlineMs = Date.now() + 600_000;
      const environment = {
        PATH: process.env.PATH,
        AGENTARTS_EGRESS_ALLOWED_ORIGINS: JSON.stringify(origins),
      };
      try {
        const manifestBase = await prepareLockedRuntimeFiles(runtime, DSH_VERSION, actionRoot);
        await installAgentArtsPackages({
          kind: "runtime",
          runtime,
          actionRoot,
          environment,
          deadlineMs,
          signal: abort.signal,
        });
        const plan = resolveNativeExtensionPlan({
          mcp: parseNativeMcpConfiguration('{"schemaVersion":1}'),
          plugins: parseNativePluginConfiguration(
            JSON.stringify({
              schemaVersion: 1,
              plugins: [{ id: "git-package", package: "is-number", source: SOURCE }],
            }),
          ),
          policy: policy(),
          allowPluginInstall: true,
        });
        await captureExtensionInstallBaseline(runtime, plan);
        await new NativeComposition().prepare({
          isolation: "docker",
          runtime,
          assetsDirectory: join(actionRoot, "assets/dsh"),
          manifestBase,
          plan,
          nativeTools: ["workspace.read"],
          trust: "trusted-read",
          workspaceWrite: false,
          expectedOperation: "task",
          task: "Public Git installation only; no model or package plugin execution",
          workspacePath: "/not-mounted",
        });
        assertExtensionInstallBaseline(runtime, plan);
        await installAgentArtsPackages({
          kind: "extension",
          runtime,
          actionRoot,
          environment,
          deadlineMs,
          signal: abort.signal,
        });
        await auditFreshExtensionInstallation(runtime, plan);
        const pkg = JSON.parse(
          await readFile(join(runtime.packageRoot, "node_modules/is-number/package.json"), "utf8"),
        ) as { name: string; version: string };
        expect(pkg).toMatchObject({ name: "is-number", version: "7.0.0" });
        expect(runtime.installedExtensionRuntimeLock?.extensionPackageCount).toBe(1);
      } finally {
        await disposeDshRuntime(runtime);
      }
    },
    650_000,
  );
  it.skipIf(!enabled).each(["origin", "commit"] as const)(
    "rejects a Git installation with an unapproved %s",
    async (kind) => {
      const runtime = await createDshRuntime(),
        actionRoot = process.cwd();
      const abort = new AbortController();
      try {
        await prepareLockedRuntimeFiles(runtime, DSH_VERSION, actionRoot);
        const manifestPath = join(runtime.packageRoot, "package.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          dependencies: Record<string, string>;
        };
        manifest.dependencies["is-number"] =
          kind === "commit" ? SOURCE.replace(COMMIT, "0".repeat(40)) : SOURCE;
        await writeFile(manifestPath, JSON.stringify(manifest));
        await expect(
          installAgentArtsPackages({
            kind: "extension",
            runtime,
            actionRoot,
            signal: abort.signal,
            deadlineMs: Date.now() + 90_000,
            environment: {
              PATH: process.env.PATH,
              AGENTARTS_EGRESS_ALLOWED_ORIGINS: JSON.stringify(
                kind === "origin" ? [origins[0]] : origins,
              ),
            },
          }),
        ).rejects.toThrow("Isolated package installation failed");
        expect(runtime.installedExtensionRuntimeLock).toBeUndefined();
      } finally {
        await disposeDshRuntime(runtime);
      }
    },
    100_000,
  );
});
