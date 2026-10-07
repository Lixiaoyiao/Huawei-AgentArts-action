import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function evaluate(source: string): unknown {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

describe("fixed no-credential host diagnostics", () => {
  it.skipIf(process.platform === "win32")(
    "classifies only this run's registration error without exporting the global log",
    () => {
      const result = spawnSync(
        "bash",
        [
          "agentarts/diagnose-host.sh",
          "--classify-registration-error",
          "agentarts_Test1234",
          "mount_too_revealing",
        ],
        {
          input:
            "[1] trace_kprobe: error: private-other-message\n  Command: r:other/probe private-symbol\n[2] trace_kprobe: error: Failed to find BTF function type\n  Command: r:agentarts_Test1234/mount_too_revealing mount_too_revealing return_value=$retval:s64\n[3] trace_kprobe: error: private-later-message\n  Command: r:other/probe private-later-symbol\n",
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("btf-unavailable\n");
      expect(result.stdout).not.toContain("private");
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not infer a trace denial cause from another run's error",
    () => {
      const result = spawnSync(
        "bash",
        [
          "agentarts/diagnose-host.sh",
          "--classify-registration-error",
          "agentarts_Test1234",
          "mount_too_revealing",
        ],
        {
          input:
            "[1] trace_kprobe: error: Permission denied\n  Command: r:agentarts_Other123/mount_too_revealing mount_too_revealing\n",
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("not-recorded\n");
    },
  );

  it("exports every proc mount and its covers without unrelated host paths or mount sources", () => {
    const lines = [
      "1 0 0:1 / / rw - overlay overlay rw,lowerdir=/host/private/token-path",
      "2 1 0:2 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
      "3 2 0:2 /sys /proc/sys ro,nosuid,nodev,noexec,relatime - proc proc rw",
      "4 2 0:3 /null /proc/keys rw,nosuid - tmpfs /host/secret-source rw,size=64k",
      "5 1 0:4 / /private-proc rw - proc proc rw,subset=pid",
      "6 1 0:5 /secret /run/credentials ro - tmpfs /host/secret-file rw",
    ].join("\n");
    const parsed = evaluate(`
      import {procMounts} from './agentarts/host-diagnostic.mjs';
      process.stdout.write(JSON.stringify(procMounts(${JSON.stringify(lines)})));
    `);
    expect(parsed).toEqual([
      {
        mountId: "2",
        parentId: "1",
        device: "0:2",
        root: "/",
        point: "/proc",
        options: "rw,nosuid,nodev,noexec,relatime",
        propagation: [],
        filesystem: "proc",
        superOptions: "rw",
      },
      {
        mountId: "3",
        parentId: "2",
        device: "0:2",
        root: "/sys",
        point: "/proc/sys",
        options: "ro,nosuid,nodev,noexec,relatime",
        propagation: [],
        filesystem: "proc",
        superOptions: "rw",
      },
      {
        mountId: "4",
        parentId: "2",
        device: "0:3",
        root: "/null",
        point: "/proc/keys",
        options: "rw,nosuid",
        propagation: [],
        filesystem: "tmpfs",
        superOptions: "rw,size=64k",
      },
      {
        mountId: "5",
        parentId: "1",
        device: "0:4",
        root: "/",
        point: "/private-proc",
        options: "rw",
        propagation: [],
        filesystem: "proc",
        superOptions: "rw,subset=pid",
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("/host/");
    expect(JSON.stringify(parsed)).not.toContain("credentials");
  });

  it("rejects incomplete or oversized evidence instead of silently identifying a cause", () => {
    expect(
      evaluate(`
      import {procMounts} from './agentarts/host-diagnostic.mjs';
      const cases=['malformed', 'x'.repeat(1048577)];
      process.stdout.write(JSON.stringify(cases.map(value=>{try{procMounts(value);return false}catch{return true}})));
    `),
    ).toEqual([true, true]);
  });

  it("records only selected numeric process protection fields", () => {
    expect(
      evaluate(`
      import {processStatus} from './agentarts/host-diagnostic.mjs';
      process.stdout.write(JSON.stringify(processStatus('Name: private-key-name\\nUid:\\t10001\\t10001\\t10001\\t10001\\nCapEff:\\t0000000000000000\\nNoNewPrivs:\\t1\\nSeccomp:\\t2\\n')));
    `),
    ).toEqual({
      Uid: "10001\t10001\t10001\t10001",
      CapEff: "0000000000000000",
      NoNewPrivs: "1",
      Seccomp: "2",
    });
  });

  it("keeps the diagnostic permissions and output collection separate from credentials and host policy", async () => {
    const shell = await readFile("agentarts/diagnose-host.sh", "utf8");
    expect(shell).toContain("env -i PATH=");
    expect(shell).toContain("--pull never --init --read-only --network none");
    expect(shell).toContain(
      "--cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add KILL",
    );
    expect(shell).toContain("--security-opt no-new-privileges");
    expect(shell).toContain('task_comm == "bwrap"');
    expect(shell).toContain('"$observed_label" != "$run_id"');
    expect(shell).not.toMatch(
      /(?:--privileged|SYS_ADMIN|SYS_PTRACE|unconfined|systempaths=|sysctl\s+-w|\.Config\.Env)/,
    );
  });
});
