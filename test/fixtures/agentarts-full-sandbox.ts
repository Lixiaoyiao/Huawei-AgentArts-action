import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import type {
  AgentArtsSandboxPreparation,
  AgentArtsSandboxHandle,
} from "../../src/agentarts/sandbox.js";
import type { DshDockerLaunchPlan } from "../../src/dsh/composition.js";

/** Portable actual-DSH fixture, without namespaces. Only usable with the explicit insecure-test worker seam. */
export async function prepareInsecureFullRuntimeFixture(
  input: AgentArtsSandboxPreparation,
): Promise<AgentArtsSandboxHandle> {
  const files: string[] = [];
  const find = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await find(path);
      else if (entry.isFile() && (entry.name.endsWith(".yml") || entry.name.endsWith(".json")))
        files.push(path);
    }
  };
  await find(input.profileRoot);
  let prepared = false;
  return {
    networkIsolated: false,
    workerProxyBaseUrl: input.modelProxy.workerBaseUrl,
    ...(input.modelProxy.workerWebSearchBaseUrl === undefined
      ? {}
      : { workerWebSearchBaseUrl: input.modelProxy.workerWebSearchBaseUrl }),
    prepareProcess(spec, launch?: DshDockerLaunchPlan) {
      if (prepared) throw new Error("Fixture prepares exactly one process");
      prepared = true;
      if (launch === undefined) throw new Error("Original Docker launch plan is required");
      const mounts = [
        ...launch.mounts,
        {
          sourcePath: input.workspacePath,
          destinationPath: "/workspace",
          readOnly: !input.workspaceWrite,
        },
        { sourcePath: input.dshHome, destinationPath: "/dsh-home", readOnly: true },
        {
          sourcePath: input.profileRoot,
          destinationPath: "/opt/dsh-action/package",
          readOnly: true,
        },
      ].sort((a, b) => b.destinationPath.length - a.destinationPath.length);
      const translate = (value: string): string => {
        for (const mount of mounts) {
          if (value === mount.destinationPath || value.startsWith(`${mount.destinationPath}/`))
            return (
              mount.sourcePath.replaceAll("\\", "/") + value.slice(mount.destinationPath.length)
            );
          const url = `file://${mount.destinationPath}`;
          if (value === url || value.startsWith(`${url}/`))
            return pathToFileURL(mount.sourcePath).href + value.slice(url.length);
        }
        return value;
      };
      const walk = (value: unknown): unknown =>
        typeof value === "string"
          ? translate(value)
          : Array.isArray(value)
            ? value.map(walk)
            : value !== null && typeof value === "object"
              ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]))
              : value;
      // Worker prepareProcess is synchronous; defer only the fixture's trusted file translation to execute helper below.
      pendingTranslations.set(input.profileRoot, async () => {
        for (const file of files) {
          await chmod(file, 0o640);
          const source = await readFile(file, "utf8");
          await writeFile(
            file,
            file.endsWith(".json")
              ? JSON.stringify(walk(JSON.parse(source)))
              : stringify(walk(parse(source))),
          );
        }
      });
      return {
        command: process.execPath,
        args: launch.args.map(translate),
        cwd: launch.workdir === "/tmp" ? input.workerTemporaryDirectory : translate(launch.workdir),
        env: {
          ...spec.env,
          HOME: input.dshHome,
          DSH_HOME: input.dshHome,
          TMPDIR: input.workerTemporaryDirectory,
          TMP: input.workerTemporaryDirectory,
          TEMP: input.workerTemporaryDirectory,
        },
      };
    },
    close() {
      pendingTranslations.delete(input.profileRoot);
      return Promise.resolve();
    },
  };
}
const pendingTranslations = new Map<string, () => Promise<void>>();
export async function translateFullRuntimeFixtureProfile(profileRoot: string): Promise<void> {
  const pending = pendingTranslations.get(profileRoot);
  if (pending === undefined) throw new Error("Fixture preparation missing");
  pendingTranslations.delete(profileRoot);
  await pending();
}
