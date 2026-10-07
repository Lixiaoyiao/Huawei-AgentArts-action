// Fixed image verification only. The source harness never receives host credentials.
import { spawnSync } from "node:child_process";
import { log } from "node:console";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "hardening" && mode !== "test") throw new Error("Unknown fixed image check");
if (mode === "hardening") {
  const bytes = readFileSync("/usr/bin/bwrap");
  const build = readFileSync("/usr/share/doc/bubblewrap/agentarts-source/BUILD.txt", "utf8");
  if (bytes[4] !== 2 || bytes[5] !== 1) throw new Error("Expected little-endian ELF64");
  const offset = Number(bytes.readBigUInt64LE(32));
  const size = bytes.readUInt16LE(54),
    count = bytes.readUInt16LE(56);
  let relro = false,
    nonExecutableStack = false,
    bindNow = false;
  for (let index = 0; index < count; index++) {
    const header = offset + index * size,
      type = bytes.readUInt32LE(header);
    if (type === 0x6474e552) relro = true;
    if (type === 0x6474e551) nonExecutableStack = (bytes.readUInt32LE(header + 4) & 1) === 0;
    if (type !== 2) continue;
    const start = Number(bytes.readBigUInt64LE(header + 8));
    const end = start + Number(bytes.readBigUInt64LE(header + 32));
    for (let entry = start; entry < end; entry += 16) {
      const tag = bytes.readBigUInt64LE(entry),
        value = bytes.readBigUInt64LE(entry + 8);
      if (
        tag === 24n ||
        (tag === 30n && (value & 8n) !== 0n) ||
        (tag === 0x6ffffffbn && (value & 1n) !== 0n)
      )
        bindNow = true;
    }
  }
  const checks = {
    processOnlyProc: bytes.includes(Buffer.from("subset=pid")),
    positionIndependentExecutable: bytes.readUInt16LE(16) === 3,
    relro,
    nonExecutableStack,
    bindNow,
    stackProtector: bytes.includes(Buffer.from("__stack_chk_fail")),
    recordedDebianHardening:
      build.includes("hardening=+all") &&
      build.includes("-fstack-protector-strong") &&
      build.includes("_FORTIFY_SOURCE="),
    builderToolsAbsent: !["/usr/bin/gcc", "/usr/bin/make", "/usr/bin/dpkg-source"].some(existsSync),
  };
  const passed = Object.values(checks).every(Boolean);
  log(
    JSON.stringify({
      schemaVersion: 1,
      kind: "fixed-image-binary-hardening",
      status: passed ? "passed" : "failed",
      architecture: process.arch,
      binarySha256: createHash("sha256").update(bytes).digest("hex"),
      checks,
      realModelCalled: false,
      cloudCalled: false,
      githubCalled: false,
    }),
  );
  process.stdout.write(build);
  process.exitCode = passed ? 0 : 1;
} else {
  process.setgroups([]);
  writeFileSync(
    "/tmp/vitest-image-proof.mjs",
    'export default {root:"/opt/fixture",cacheDir:"/tmp/vite-cache",test:{environment:"node",testTimeout:30000,hookTimeout:30000}};',
  );
  const result = spawnSync(
    process.execPath,
    [
      "/opt/fixture/node_modules/vitest/vitest.mjs",
      "run",
      "test/agentarts-private-permissions.test.ts",
      "test/agentarts-runtime-installer.test.ts",
      "test/agentarts-session-runtime.test.ts",
      "--config",
      "/tmp/vitest-image-proof.mjs",
      "--configLoader",
      "native",
      "--maxWorkers",
      "1",
      "--no-file-parallelism",
      "--reporter",
      "verbose",
    ],
    {
      cwd: "/opt/fixture",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        NODE_ENV: "test",
        AGENTARTS_RUN_INSTALLER_PROOF: "true",
      },
      stdio: "inherit",
    },
  );
  log(
    JSON.stringify({
      schemaVersion: 1,
      kind: "fixed-image-source-fixture-tests",
      status: result.status === 0 ? "passed" : "failed",
      exitCode: result.status,
      signal: result.signal,
      modelEvidence: "deterministic-fixture",
      realModelCalled: false,
      cloudCalled: false,
      githubPublished: false,
      limitations: [
        "Source tests use this image's real bwrap/Node/npm; this is separate from compiled Runtime HTTP smoke evidence.",
        "Only the approved public npm registry and pinned fixture package are downloaded; model replies stay local.",
      ],
    }),
  );
  process.exitCode = result.status ?? 1;
}
