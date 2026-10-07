import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { dockerInstallerSpec } from "../dsh/docker-policy.js";
import {
  DshConfigurationError,
  DshIsolationUnavailableError,
  DshProcessError,
} from "../dsh/errors.js";
import { executeBoundedDshProcess, type DshProcessSpec } from "../dsh/process.js";
import type { DshRuntime } from "../dsh/runtime.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { agentArtsNamespaceArgs, agentArtsNamespaceProcess } from "./sandbox.js";
import { egressPolicy, startAgentArtsEgressProxy } from "./egress-proxy.js";
import { privateEntryPermissions } from "./private-permissions.js";

const UID = 10001;
const PACKAGE = "/opt/dsh-action/package";

/** Select npm from supervisor-owned installation files, never the repository or task PATH. */
export async function resolveAgentArtsNpm(
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly cli: string; readonly root: string }> {
  const paths = [
    ...new Set([
      dirname(process.execPath),
      ...(environment.PATH ?? "").split(delimiter),
      "/usr/local/bin",
      "/usr/bin",
    ]),
  ].filter(isAbsolute);
  for (const directory of paths) {
    let cli: string;
    try {
      cli = await realpath(join(directory, "npm"));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const root = dirname(dirname(cli));
    if (cli !== join(root, "bin/npm-cli.js")) continue;
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      name?: unknown;
    };
    if (manifest.name !== "npm")
      throw new DshConfigurationError("Installer command is not the npm distribution");
    const inspect = async (path: string): Promise<void> => {
      const entry = await lstat(path);
      if (entry.uid !== 0 || (!entry.isSymbolicLink() && (entry.mode & 0o022) !== 0))
        throw new DshConfigurationError(
          "Installer npm distribution must be immutable and root-owned",
        );
      if (entry.isSymbolicLink()) {
        const target = relative(root, await realpath(path));
        if (target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target))
          throw new DshConfigurationError("Installer npm distribution symlink escapes its root");
      } else if (entry.isDirectory()) {
        for (const child of await readdir(path)) await inspect(join(path, child));
      } else if (!entry.isFile())
        throw new DshConfigurationError("Installer npm distribution contains a special entry");
    };
    await inspect(root);
    return { cli, root };
  }
  throw new DshConfigurationError("A supervisor-owned npm installation is required");
}

/** Preserve the original pinned install flags instead of maintaining another npm policy. */
export function agentArtsNpmArguments(kind: "runtime" | "extension"): readonly string[] {
  const spec = dockerInstallerSpec({
    kind,
    containerImage: "unused-install-argv",
    workspace: "/unused",
    packageRoot: "/unused",
    npmCache: "/unused",
    environment: {},
  });
  const index = spec.args.lastIndexOf("npm");
  if (index < 0) throw new DshConfigurationError("Original installer command is unavailable");
  return spec.args.slice(index + 1);
}

export interface AgentArtsInstallerInput {
  readonly kind: "runtime" | "extension";
  readonly runtime: DshRuntime;
  readonly actionRoot: string;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly environment: NodeJS.ProcessEnv;
}

/** No repository, Session, model socket or Controller environment is mounted during installation. */
export async function installAgentArtsPackages(input: AgentArtsInstallerInput): Promise<void> {
  throwIfCancelled(input.signal);
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new DshIsolationUnavailableError(
      "Package installation requires the namespace supervisor",
    );
  const policy = egressPolicy(input.environment);
  if (policy.origins.length === 0)
    throw new DshConfigurationError(
      "Package installation requires an operator-approved registry origin policy",
    );
  const npm = await resolveAgentArtsNpm(input.environment);
  const executable = await lstat("/usr/bin/bwrap");
  if (
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    executable.uid !== 0 ||
    (executable.mode & 0o022) !== 0 ||
    (executable.mode & 0o111) === 0
  )
    throw new DshIsolationUnavailableError("Installer namespace executable must be immutable");
  for (const directory of [input.runtime.packageRoot, input.runtime.npmCache, input.actionRoot]) {
    const value = await lstat(directory);
    if (!isAbsolute(directory) || !value.isDirectory() || value.isSymbolicLink())
      throw new DshConfigurationError("Installer mounts must be private real directories");
  }
  // The original runtime creates sealed parents. Give the installer traverse-only group access.
  for (const parent of [
    input.runtime.root,
    input.runtime.dshHome,
    dirname(input.runtime.packageRoot),
  ]) {
    await privateEntryPermissions(parent, 0o710, 0, UID);
  }
  const writableTree = async (directory: string): Promise<void> => {
    await privateEntryPermissions(directory, 0o750, UID, UID);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await writableTree(path);
      else if (entry.isFile()) {
        const details = await lstat(path);
        await privateEntryPermissions(path, (details.mode & 0o111) | 0o640, UID, UID);
      } else if (!entry.isSymbolicLink())
        throw new DshConfigurationError("Installer package directory contains a special entry");
    }
  };
  await writableTree(input.runtime.packageRoot);
  await writableTree(input.runtime.npmCache);
  const args = agentArtsNamespaceArgs();
  if (!process.execPath.startsWith("/usr/")) {
    const node = await lstat(process.execPath);
    if (!node.isFile() || node.isSymbolicLink() || node.uid !== 0 || (node.mode & 0o022) !== 0)
      throw new DshIsolationUnavailableError("Installer Node executable must be immutable");
    args.push("--ro-bind", process.execPath, process.execPath);
  }
  const limits = () => ({
    timeoutMs: Math.max(1, input.deadlineMs - Date.now()),
    maxStdoutBytes: 512 * 1024,
    maxStderrBytes: 512 * 1024,
    maxCombinedBytes: 1024 * 1024,
    signal: input.signal,
  });
  const spec = (argv: readonly string[]): DshProcessSpec =>
    agentArtsNamespaceProcess({
      args: argv,
      cwd: input.runtime.root,
      actionRoot: input.actionRoot,
    });
  const probe = await executeBoundedDshProcess(
    spec([
      ...args,
      "--",
      process.execPath,
      "-e",
      "const f=require('node:fs'),n=require('node:os').networkInterfaces(),s=f.readFileSync('/proc/self/status','utf8');if(process.getuid()!==10001||process.getgid()!==10001||process.getgroups().some(x=>x===0)||!/^CapEff:\\s+0+$/m.test(s)||Object.keys(n).some(x=>x!=='lo'))process.exit(41);process.stdout.write('isolated');",
    ]),
    { ...limits(), timeoutMs: Math.max(1, Math.min(5000, input.deadlineMs - Date.now())) },
  );
  if (probe.exitCode !== 0 || probe.signal !== null || probe.stdout !== "isolated")
    throw new DshIsolationUnavailableError(
      "Installer namespaces are unavailable; no fallback is permitted",
    );
  const egress = await startAgentArtsEgressProxy({
    socketPath: join(input.runtime.root, `installer-${input.kind}.sock`),
    policy,
    deadlineMs: input.deadlineMs,
    signal: input.signal,
    maxRequests: 1024,
    maxConcurrent: 16,
    maxConnectionBytes: 128 * 1024 * 1024,
  });
  try {
    if (!npm.root.startsWith("/usr/")) args.push("--ro-bind", npm.root, npm.root);
    args.push(
      "--ro-bind",
      input.actionRoot,
      input.actionRoot,
      "--bind",
      input.runtime.packageRoot,
      PACKAGE,
      "--bind",
      input.runtime.npmCache,
      "/tmp/npm-cache",
      "--ro-bind",
      egress.socketPath,
      "/run/agentarts-egress.sock",
      "--setenv",
      "AGENTARTS_WORKER_EGRESS_SOCKET",
      "/run/agentarts-egress.sock",
      "--setenv",
      "HOME",
      "/tmp",
      "--setenv",
      "npm_config_cache",
      "/tmp/npm-cache",
      "--setenv",
      "npm_config_registry",
      "https://registry.npmjs.org/",
      "--setenv",
      "NODE_OPTIONS",
      "--max-old-space-size=3072",
      "--setenv",
      "PATH",
      `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      "--chdir",
      PACKAGE,
      "--",
      process.execPath,
      join(input.actionRoot, "assets/agentarts/sandbox-bridge.mjs"),
      "--installer",
      "0",
      process.execPath,
      npm.cli,
      ...agentArtsNpmArguments(input.kind),
    );
    const result = await executeBoundedDshProcess(spec(args), limits());
    if (result.exitCode !== 0 || result.signal !== null)
      throw new DshProcessError(
        result.exitCode,
        result.signal,
        "Isolated package installation failed",
      );
  } finally {
    await egress.close();
  }
}
