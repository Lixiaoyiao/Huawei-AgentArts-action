// Fixed, no-credential collector. It does not execute repository code or start DSH.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { arch, release } from "node:os";
import { pathToFileURL } from "node:url";

const read = (path, maximum = 16_384) => {
  try {
    const bytes = readFileSync(path);
    if (bytes.length > maximum) return "unavailable: exceeds bound";
    return bytes.toString("utf8").trim();
  } catch {
    return "unavailable";
  }
};

// Never export overlay paths, unrelated bind mounts, environment, argv or mount sources.
export function procMounts(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1_048_576)
    throw new Error("Mountinfo exceeds the fixed diagnostic bound");
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [left, right, extra] = line.split(" - ");
      const fields = left?.split(" ") ?? [];
      const tail = right?.split(" ") ?? [];
      if (extra !== undefined || fields.length < 6 || tail.length < 3)
        throw new Error("Malformed fixed mountinfo record");
      const point = fields[4];
      if (tail[0] !== "proc" && point !== "/proc" && !point?.startsWith("/proc/")) return [];
      if (fields.some((field) => field.length > 2048) || tail.some((field) => field.length > 2048))
        throw new Error("Mountinfo field exceeds bound");
      return [
        {
          mountId: fields[0],
          parentId: fields[1],
          device: fields[2],
          root: fields[3],
          point,
          options: fields[5],
          propagation: fields.slice(6),
          filesystem: tail[0],
          superOptions: tail[2],
        },
      ];
    });
}

export function processStatus(text) {
  const names = new Set([
    "Uid",
    "Gid",
    "NSpid",
    "CapInh",
    "CapPrm",
    "CapEff",
    "CapBnd",
    "CapAmb",
    "NoNewPrivs",
    "Seccomp",
    "Seccomp_filters",
  ]);
  return Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const match = /^([A-Za-z_]+):\s+([0-9a-fA-F\t ]+)$/.exec(line);
      return match && names.has(match[1]) ? [[match[1], match[2].trim()]] : [];
    }),
  );
}

function namespaceLinks() {
  return Object.fromEntries(
    ["user", "mnt", "pid", "pid_for_children", "net", "cgroup"].map((name) => {
      try {
        return [name, readlinkSync(`/proc/self/ns/${name}`)];
      } catch {
        return [name, "unavailable"];
      }
    }),
  );
}

function snapshot() {
  const mountinfo = read("/proc/self/mountinfo", 1_048_576);
  return {
    architecture: arch(),
    kernelRelease: release(),
    status: processStatus(read("/proc/self/status")),
    namespaceLinks: namespaceLinks(),
    uidMap: read("/proc/self/uid_map", 4096),
    gidMap: read("/proc/self/gid_map", 4096),
    setgroups: read("/proc/self/setgroups", 64),
    apparmor: read("/proc/self/attr/current", 1024),
    apparmorEnabled: read("/sys/module/apparmor/parameters/enabled", 64),
    apparmorUsernsRestriction: read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", 64),
    usernsClone: read("/proc/sys/kernel/unprivileged_userns_clone", 64),
    usernsMaximum: read("/proc/sys/user/max_user_namespaces", 64),
    mountinfoSha256: createHash("sha256").update(mountinfo).digest("hex"),
    procMounts: procMounts(mountinfo),
    // These are the *overmounted* inodes. Userspace cannot infer MNT_LOCKED or
    // the covered proc inode from them; the kernel trace resolves that boundary.
    procMaskStats: [
      "bus",
      "fs",
      "irq",
      "sys",
      "sysrq-trigger",
      "acpi",
      "interrupts",
      "kcore",
      "keys",
      "scsi",
      "timer_list",
    ].map((name) => {
      try {
        const value = statSync(`/proc/${name}`);
        return {
          path: `/proc/${name}`,
          mode: value.mode,
          links: value.nlink,
          directory: value.isDirectory(),
          characterDevice: value.isCharacterDevice(),
        };
      } catch {
        return { path: `/proc/${name}`, unavailable: true };
      }
    }),
    bwrapSha256: createHash("sha256").update(readFileSync("/usr/bin/bwrap")).digest("hex"),
    bwrapBuild: read("/usr/share/doc/bubblewrap/agentarts-source/BUILD.txt"),
  };
}

export async function main() {
  if (process.getuid?.() !== 0) throw new Error("Fixed diagnostic requires supervisor UID");
  if (process.argv[2] === "--wait-for-tracer") {
    if (!/^aadg[A-Za-z0-9]{8}$/.test(process.argv[3] ?? ""))
      throw new Error("Invalid fixed diagnostic process identity");
    process.title = process.argv[3];
  }
  process.setgroups([]);
  const before = snapshot();
  if (process.argv[2] === "--wait-for-tracer") {
    const deadline = Date.now() + 15_000;
    while (!existsSync("/tmp/agentarts-diagnostic-go")) {
      if (Date.now() >= deadline) throw new Error("Fixed diagnostic admission timed out");
      // Generate a fixed, argument-free security-hook return under the unique
      // comm so the host can map this process to the kernel's initial PID space.
      read("/proc/self/comm", 64);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const probe = spawnSync(process.execPath, ["/check/namespace-probe.mjs"], {
    cwd: "/tmp",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 12_000,
    maxBuffer: 16_384,
    killSignal: "SIGKILL",
  });
  let parsed = null;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch {
    // Fixed-code startup failure is separately recorded; do not treat it as a pass.
  }
  const passed = probe.status === 0 && parsed?.status === "passed";
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      kind: "fixed-host-namespace-diagnostic",
      status: passed ? "passed" : "failed",
      before,
      probe: parsed,
      exitCode: probe.status,
      signal: probe.signal,
      spawnError: probe.error?.code ?? null,
      fixedCodeStderr: (probe.stderr ?? "").slice(0, 4096),
      realModelCalled: false,
      cloudCalled: false,
      githubCalled: false,
    }) + "\n",
  );
  process.exitCode = passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
