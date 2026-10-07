import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installAgentArtsPackages, resolveAgentArtsNpm } from "../src/agentarts/installer.js";
import { createDshRuntime, disposeDshRuntime } from "../src/dsh/runtime.js";
import {
  prepareLockedRuntimeFiles,
  captureExtensionInstallBaseline,
  assertExtensionInstallBaseline,
  auditFreshExtensionInstallation,
} from "../src/dsh/install.js";
import { NativeComposition } from "../src/dsh/native-composition.js";
import { resolveNativeExtensionPlan } from "../src/extensions/plan.js";
import {
  parseNativeMcpConfiguration,
  parseNativePluginConfiguration,
} from "../src/extensions/schema.js";
import { evaluatePolicy } from "../src/security/policy.js";
import { DSH_VERSION } from "../src/release.js";

// Explicit opt-in public npm download, no model/GitHub credentials or calls. Normal offline test runs skip it.
const networkProof =
  process.platform === "linux" &&
  process.getuid?.() === 0 &&
  process.env.AGENTARTS_RUN_INSTALLER_PROOF === "true";
describe("production isolated default package installer", () => {
  it.skipIf(!networkProof)(
    "installs pinned runtime and a pinned package without lifecycle scripts, then passes the original lock audit",
    async () => {
      const runtime = await createDshRuntime();
      const actionRoot = process.cwd(),
        deadlineMs = Date.now() + 600_000,
        abort = new AbortController();
      const environment = {
        PATH: process.env.PATH,
        AGENTARTS_EGRESS_ALLOWED_ORIGINS: '["https://registry.npmjs.org"]',
      };
      try {
        const npm = await resolveAgentArtsNpm(environment);
        expect(npm.cli.endsWith("/bin/npm-cli.js")).toBe(true);
        const manifestBase = await prepareLockedRuntimeFiles(runtime, DSH_VERSION, actionRoot);
        const policy = evaluatePolicy({
          context: {
            kind: "automation",
            rawEventName: "workflow_dispatch",
            eventName: "workflow_dispatch",
            runId: "installer-fixture",
            actor: "controller",
            repository: {
              id: 1,
              owner: "offline",
              repo: "installer",
              fullName: "offline/installer",
            },
            payload: {},
            isPullRequestTarget: false,
          },
          operation: "task",
          requestedAccess: "read",
          allowWrite: false,
          permissions: { actors: [], allActorsHaveWrite: true, allActorsAllowedForWrite: true },
        });
        const plan = resolveNativeExtensionPlan({
          mcp: parseNativeMcpConfiguration('{"schemaVersion":1}'),
          plugins: parseNativePluginConfiguration(
            '{"schemaVersion":1,"plugins":[{"id":"package-smoke","package":"is-positive","source":"3.1.0"}]}',
          ),
          policy,
          allowPluginInstall: true,
        });
        await installAgentArtsPackages({
          kind: "runtime",
          runtime,
          actionRoot,
          environment,
          deadlineMs,
          signal: abort.signal,
        });
        const installed = JSON.parse(
          await readFile(
            join(runtime.packageRoot, "node_modules/@deepseek-ai/dsh/package.json"),
            "utf8",
          ),
        ) as { version?: unknown };
        expect(installed.version).toBe(DSH_VERSION);
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
          task: "Installer smoke only; no model process is started",
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
        const extension = JSON.parse(
          await readFile(
            join(runtime.packageRoot, "node_modules/is-positive/package.json"),
            "utf8",
          ),
        ) as { name?: unknown; version?: unknown };
        expect(extension).toMatchObject({ name: "is-positive", version: "3.1.0" });
        expect(runtime.installedExtensionRuntimeLock).toMatchObject({
          schemaVersion: 1,
          algorithm: "sha256",
          lockfileVersion: 3,
          extensionPackageCount: 1,
        });
      } finally {
        await disposeDshRuntime(runtime);
      }
    },
    650_000,
  );
});
