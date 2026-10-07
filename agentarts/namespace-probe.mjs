// Fixed-code, no-credential diagnostic. Does not start Runtime, DSH, a model or network.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

if (process.getuid?.() !== 0) throw new Error("Fixed namespace probe requires the supervisor");
process.setgroups([]);

const read = (path) => {
  try {
    return readFileSync(path, "utf8").trim().slice(0, 1024);
  } catch {
    return "unavailable";
  }
};
const proof = `
const fs=require('node:fs'),os=require('node:os'),cp=require('node:child_process');
const status=fs.readFileSync('/proc/self/status','utf8');
if(process.getuid()!==10001||process.getgid()!==10001||process.getgroups().includes(0)||!/^CapEff:\\s+0+$/m.test(status)||!/^NoNewPrivs:\\s+1$/m.test(status)||!/^Seccomp:\\s+2$/m.test(status)||Object.keys(os.networkInterfaces()).some(x=>x!=='lo'))process.exit(41);
fs.accessSync('/usr/bin/unshare',fs.constants.X_OK);
const nested=cp.spawnSync('/usr/bin/unshare',['--user','--','/usr/bin/true'],{encoding:'utf8',timeout:1000});
if(nested.error||nested.status===null||nested.status===0)process.exit(42);
process.stdout.write('isolated');`;
const result = spawnSync(
  process.execPath,
  [
    "/opt/app/assets/agentarts/namespace-launcher.mjs",
    "--unshare-user",
    "--uid",
    "10001",
    "--gid",
    "10001",
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
    "--",
    process.execPath,
    "-e",
    proof,
  ],
  {
    cwd: "/tmp",
    uid: 10001,
    gid: 10001,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 8000,
    maxBuffer: 8192,
    killSignal: "SIGKILL",
  },
);
const passed = result.status === 0 && result.signal === null && result.stdout === "isolated";
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    kind: "fixed-namespace-diagnostic",
    status: passed ? "passed" : "failed",
    architecture: process.arch,
    apparmor: read("/proc/self/attr/current"),
    apparmorUsernsRestriction: read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
    usernsClone: read("/proc/sys/kernel/unprivileged_userns_clone"),
    usernsMaximum: read("/proc/sys/user/max_user_namespaces"),
    exitCode: result.status,
    signal: result.signal,
    // Only trusted fixed bootstrap code ran, with a closed environment and no credential mounts.
    stderr: (result.stderr ?? "").slice(0, 4096),
    spawnError: result.error?.code ?? null,
    realModelCalled: false,
    cloudCalled: false,
    githubCalled: false,
  }) + "\n",
);
process.exitCode = passed ? 0 : 1;
