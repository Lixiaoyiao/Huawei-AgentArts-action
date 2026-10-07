import { lstat } from "node:fs/promises";
import type { lookup } from "node:dns/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DshConfigurationError, DshIsolationUnavailableError } from "../dsh/errors.js";
import { executeBoundedDshProcess, type DshProcessSpec } from "../dsh/process.js";
import type { DshDockerLaunchPlan } from "../dsh/composition.js";
import type { DeepSeekProxyHandle } from "../dsh/proxy.js";
import type { NativeToolId } from "../tools/schema.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { assertNoGitHubCredentials } from "../security/env.js";
import { egressPolicy, startAgentArtsEgressProxy } from "./egress-proxy.js";

export interface AgentArtsSandboxPreparation {
  readonly workspacePath: string;
  readonly dshHome: string;
  readonly workerTemporaryDirectory: string;
  readonly profileRoot: string;
  readonly actionRoot: string;
  readonly workspaceWrite: boolean;
  readonly networkRequested: boolean;
  readonly modelProxy: DeepSeekProxyHandle;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly nativeTools: readonly NativeToolId[];
  readonly mode: "controlled" | "native";
  readonly environment?: NodeJS.ProcessEnv;
  /** Trusted dependency seam for deterministic DNS tests; never task controlled. */
  readonly egressLookup?: typeof lookup;
  readonly workerMcpSocketPath?: string;
}
export interface AgentArtsSandboxHandle {
  readonly networkIsolated: boolean;
  readonly workerProxyBaseUrl: string;
  readonly workerWebSearchBaseUrl?: string;
  prepareProcess(spec: DshProcessSpec, launchPlan?: DshDockerLaunchPlan): DshProcessSpec;
  close(): Promise<void>;
}
const UID = 10001;
const BWRAP = "/usr/bin/bwrap";
export const AGENTARTS_PUBLIC_CA = "/etc/ssl/certs/ca-certificates.crt";

/** Image public trust roots only; never expose /etc, Git config or operator credentials. */
export async function agentArtsPublicCertificateArgs(): Promise<readonly string[]> {
  for (const directory of ["/etc", "/etc/ssl", "/etc/ssl/certs"]) {
    const details = await lstat(directory);
    if (
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      details.uid !== 0 ||
      (details.mode & 0o022) !== 0
    )
      throw new DshIsolationUnavailableError("Public CA parent must be immutable and root-owned");
  }
  const certificate = await lstat(AGENTARTS_PUBLIC_CA);
  if (
    !certificate.isFile() ||
    certificate.isSymbolicLink() ||
    certificate.uid !== 0 ||
    (certificate.mode & 0o022) !== 0 ||
    certificate.size === 0 ||
    certificate.size > 4 * 1024 * 1024
  )
    throw new DshIsolationUnavailableError(
      "Public CA bundle must be a bounded immutable root-owned regular file",
    );
  return [
    "--dir",
    "/etc",
    "--dir",
    "/etc/ssl",
    "--dir",
    "/etc/ssl/certs",
    "--ro-bind",
    AGENTARTS_PUBLIC_CA,
    AGENTARTS_PUBLIC_CA,
    "--setenv",
    "GIT_SSL_CAINFO",
    AGENTARTS_PUBLIC_CA,
  ];
}

async function immutableExecutable(path: string): Promise<void> {
  const details = await lstat(path);
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.uid !== 0 ||
    (details.mode & 0o022) !== 0 ||
    (details.mode & 0o111) === 0
  )
    throw new DshIsolationUnavailableError(
      "Namespace sandbox executable must be immutable and root-owned",
    );
}
export function agentArtsNamespaceArgs(): string[] {
  return [
    "--unshare-user",
    "--uid",
    String(UID),
    "--gid",
    String(UID),
    "--unshare-net",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/run",
    "--setenv",
    "PATH",
    "/usr/local/bin:/usr/bin:/bin",
  ];
}

/** UID, filesystem, PID and network isolation are required before executable capabilities. */
export async function prepareAgentArtsSandbox(
  input: AgentArtsSandboxPreparation,
): Promise<AgentArtsSandboxHandle> {
  throwIfCancelled(input.signal);
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new DshIsolationUnavailableError(
      "Full AgentArts tasks require a Linux namespace supervisor",
    );
  await immutableExecutable(BWRAP);
  for (const path of [input.workspacePath, input.dshHome, input.profileRoot, input.actionRoot]) {
    if (!isAbsolute(path))
      throw new DshConfigurationError("Sandbox mounts require supervisor-selected absolute paths");
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink())
      throw new DshConfigurationError("Sandbox mount source must be a real directory");
  }
  const socketPath = input.modelProxy.workerSocketPath;
  if (socketPath === undefined || !isAbsolute(socketPath) || !(await lstat(socketPath)).isSocket())
    throw new DshConfigurationError(
      "A sealed authenticated model socket is required for the network namespace",
    );
  if (input.workerMcpSocketPath !== undefined) {
    const details = await lstat(input.workerMcpSocketPath);
    if (
      !isAbsolute(input.workerMcpSocketPath) ||
      !details.isSocket() ||
      details.uid !== 0 ||
      details.gid !== UID ||
      (details.mode & 0o777) !== 0o660
    )
      throw new DshConfigurationError("MCP mediation requires a sealed supervisor Unix socket");
  }
  const certificateArgs = await agentArtsPublicCertificateArgs();
  const probeArgs = [...agentArtsNamespaceArgs(), ...certificateArgs];
  if (!process.execPath.startsWith("/usr/")) {
    await immutableExecutable(process.execPath);
    probeArgs.push("--ro-bind", process.execPath, process.execPath);
  }
  probeArgs.push(
    "--",
    process.execPath,
    "-e",
    "const f=require('node:fs');const n=require('node:os').networkInterfaces();const s=f.readFileSync('/proc/self/status','utf8');if(process.getuid()!==10001||process.getgid()!==10001||process.getgroups().some(x=>x===0)||!/^CapEff:\\s+0+$/m.test(s)||Object.keys(n).some(x=>x!=='lo'))process.exit(41);process.stdout.write('isolated');",
  );
  const probe = await executeBoundedDshProcess(
    agentArtsNamespaceProcess({
      args: probeArgs,
      cwd: input.workerTemporaryDirectory,
      actionRoot: input.actionRoot,
    }),
    {
      timeoutMs: Math.max(1, Math.min(5000, input.deadlineMs - Date.now())),
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
      maxCombinedBytes: 8192,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
  if (probe.exitCode !== 0 || probe.signal !== null || probe.stdout !== "isolated")
    throw new DshIsolationUnavailableError(
      "Required filesystem, PID, user and network namespaces are unavailable; no fallback is permitted",
    );
  const policy = egressPolicy(input.environment ?? {});
  if (input.networkRequested && policy.origins.length === 0)
    throw new DshIsolationUnavailableError(
      "Networked extensions require supervisor AGENTARTS_EGRESS_ALLOWED_ORIGINS",
    );
  const egress = input.networkRequested
    ? await startAgentArtsEgressProxy({
        socketPath: join(resolve(socketPath, ".."), "egress.sock"),
        policy,
        deadlineMs: input.deadlineMs,
        ...(input.egressLookup === undefined ? {} : { lookup: input.egressLookup }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    : undefined;
  let closed = false;
  return {
    networkIsolated: true,
    workerProxyBaseUrl: input.modelProxy.workerBaseUrl,
    ...(input.modelProxy.workerWebSearchBaseUrl === undefined
      ? {}
      : { workerWebSearchBaseUrl: input.modelProxy.workerWebSearchBaseUrl }),
    prepareProcess(spec, launchPlan) {
      if (closed) throw new DshConfigurationError("Sandbox is closed");
      assertNoGitHubCredentials(spec.env);
      const args = [...agentArtsNamespaceArgs(), ...certificateArgs];
      if (!process.execPath.startsWith("/usr/"))
        args.push("--ro-bind", process.execPath, process.execPath);
      args.push(
        "--ro-bind",
        input.actionRoot,
        input.actionRoot,
        input.workspaceWrite ? "--bind" : "--ro-bind",
        input.workspacePath,
        "/workspace",
        "--bind",
        input.dshHome,
        "/dsh-home",
        "--ro-bind",
        input.profileRoot,
        "/opt/dsh-action/package",
        "--ro-bind",
        socketPath,
        "/run/agentarts-model.sock",
      );
      if (egress !== undefined)
        args.push(
          "--ro-bind",
          egress.socketPath,
          "/run/agentarts-egress.sock",
          "--setenv",
          "AGENTARTS_WORKER_EGRESS_SOCKET",
          "/run/agentarts-egress.sock",
        );
      if (input.workerMcpSocketPath !== undefined)
        args.push(
          "--ro-bind",
          input.workerMcpSocketPath,
          "/run/agentarts-mcp.sock",
          "--setenv",
          "AGENTARTS_WORKER_MCP_SOCKET",
          "/run/agentarts-mcp.sock",
        );
      for (const mount of launchPlan?.mounts ?? []) {
        const path = resolve(mount.sourcePath);
        if (
          !isAbsolute(mount.destinationPath) ||
          mount.destinationPath.startsWith("/proc/") ||
          mount.destinationPath === "/proc" ||
          mount.destinationPath === "/run/agentarts-model.sock"
        )
          throw new DshConfigurationError("Unsafe composition mount");
        args.push(mount.readOnly ? "--ro-bind" : "--bind", path, mount.destinationPath);
      }
      for (const [name, value] of Object.entries(spec.env)) {
        if (value === undefined) continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || value.includes("\0"))
          throw new DshConfigurationError("Invalid worker environment");
        args.push("--setenv", name, value);
      }
      args.push(
        "--setenv",
        "HOME",
        "/dsh-home",
        "--setenv",
        "DSH_HOME",
        "/dsh-home",
        "--setenv",
        "TMPDIR",
        "/tmp",
        "--setenv",
        "TMP",
        "/tmp",
        "--setenv",
        "TEMP",
        "/tmp",
        "--chdir",
        launchPlan?.workdir ?? "/workspace",
        "--",
        process.execPath,
        join(input.actionRoot, "assets/agentarts/sandbox-bridge.mjs"),
        "/run/agentarts-model.sock",
        String(input.modelProxy.port),
        launchPlan?.command ?? spec.command,
        ...(launchPlan?.args ?? spec.args),
      );
      return agentArtsNamespaceProcess({
        args,
        cwd: input.workerTemporaryDirectory,
        actionRoot: input.actionRoot,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await egress?.close();
    },
  };
}

export function agentArtsNamespaceProcess(input: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly actionRoot: string;
}): DshProcessSpec {
  return {
    command: process.execPath,
    args: [join(input.actionRoot, "assets/agentarts/namespace-launcher.mjs"), ...input.args],
    cwd: input.cwd,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    uid: UID,
    gid: UID,
  };
}
