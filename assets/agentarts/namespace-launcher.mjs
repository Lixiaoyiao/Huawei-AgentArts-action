/** Trusted outer bootstrap. Install a worker-only seccomp filter after bwrap setup. */
import { spawn } from "node:child_process";
import { constants, openSync, fstatSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
if (process.getuid?.() !== 10001 || !["x64", "arm64"].includes(process.arch) || args.length === 0)
  throw new Error("Invalid namespace launcher");
const policy = join(dirname(fileURLToPath(import.meta.url)), `worker-seccomp-${process.arch}.bpf`);
const descriptor = openSync(policy, constants.O_RDONLY | constants.O_NOFOLLOW);
const stat = fstatSync(descriptor);
if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size !== 104)
  throw new Error("Invalid worker seccomp policy");
const child = spawn("/usr/bin/bwrap", ["--seccomp", "3", ...args], {
  shell: false,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe", descriptor],
});
closeSync(descriptor);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once("error", () => {
  process.stderr.write("Namespace bootstrap failed\n");
  process.exit(127);
});
child.once("exit", (code, signal) => process.exit(signal === null ? (code ?? 1) : 1));
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    child.kill(signal);
    setTimeout(() => process.exit(1), 100).unref();
  });
