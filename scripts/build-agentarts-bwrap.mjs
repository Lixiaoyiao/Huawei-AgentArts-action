// Trusted image-builder only. No repository/DSH/model task runs here.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const inputs = resolve(import.meta.dirname, "../agentarts");
const root = resolve(process.argv[2] ?? "/build");
const archiveDirectory = join(root, "sources");
const sourceDirectory = join(root, "bubblewrap");
const metadata = JSON.parse(await readFile(join(inputs, "bubblewrap-source.json"), "utf8"));
await mkdir(archiveDirectory, { recursive: true });
for (const file of metadata.files) {
  if (!/^bubblewrap_[a-z0-9.+-]+\.(?:dsc|(?:orig|debian)\.tar\.xz)$/u.test(file.name))
    throw new Error("Unexpected pinned source filename");
  const response = await fetch(new URL(file.name, metadata.baseUrl), {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Pinned bubblewrap source download failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1_048_576 || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw new Error("Pinned bubblewrap source checksum failed");
  await writeFile(join(archiveDirectory, file.name), bytes);
}
const run = (command, args, cwd = sourceDirectory) =>
  execFileSync(command, args, { cwd, stdio: "inherit", timeout: 120_000 });
// Every source byte was checked against a committed SHA-256; no unverified PGP claim is made.
run("dpkg-source", ["--no-check", "-x", metadata.files[0].name, sourceDirectory], archiveDirectory);
run("patch", ["--batch", "--fuzz=0", "--forward", "-p1", "-i", join(inputs, metadata.patch)]);
const patched = await readFile(join(sourceDirectory, "bubblewrap.c"), "utf8");
if (
  createHash("sha256").update(patched).digest("hex") !== metadata.patchedSourceSha256 ||
  !patched.includes('MS_NOSUID | MS_NOEXEC | MS_NODEV, "subset=pid")') ||
  patched.includes('mount ("proc", arg1, "proc", MS_NOSUID | MS_NOEXEC | MS_NODEV, NULL)')
)
  throw new Error("Process-only proc patch was not applied exactly");
const hardening = Object.fromEntries(
  ["CFLAGS", "CPPFLAGS", "LDFLAGS"].map((name) => [
    name,
    execFileSync("dpkg-buildflags", ["--get", name], {
      cwd: sourceDirectory,
      env: { ...process.env, DEB_BUILD_MAINT_OPTIONS: "hardening=+all" },
      encoding: "utf8",
      timeout: 5000,
    }).trim(),
  ]),
);
run("./configure", [
  "--disable-man",
  "--enable-selinux",
  "--with-priv-mode=none",
  ...Object.entries(hardening).map(([name, value]) => `${name}=${value}`),
]);
run("make", ["-j2", "bwrap"]);
await chmod(join(sourceDirectory, "bwrap"), 0o755);
await copyFile(join(inputs, metadata.patch), join(archiveDirectory, metadata.patch));
await copyFile(
  join(inputs, "bubblewrap-source.json"),
  join(archiveDirectory, "bubblewrap-source.json"),
);
await copyFile(import.meta.filename, join(archiveDirectory, "build-agentarts-bwrap.mjs"));
await copyFile(join(sourceDirectory, "COPYING"), join(archiveDirectory, "COPYING.LGPL-2"));
await copyFile(
  join(sourceDirectory, "debian/copyright"),
  join(archiveDirectory, "debian-copyright"),
);
await writeFile(
  join(archiveDirectory, "BUILD.txt"),
  "bubblewrap 0.8.0-2+deb12u1 plus the dated process-only proc patch.\n" +
    "Corresponding upstream and Debian source archives, descriptor, patch, license and build script are included.\n" +
    "Rebuild with Node 24, dpkg-dev, build-essential, pkg-config, libcap-dev and libselinux1-dev;\n" +
    "place the three agentarts inputs and scripts/build-agentarts-bwrap.mjs in their repository paths, then run the script.\n" +
    "--disable-man --enable-selinux --with-priv-mode=none; make -j2 bwrap. No setuid bit.\n" +
    "Debian dpkg-buildflags with DEB_BUILD_MAINT_OPTIONS=hardening=+all:\n" +
    Object.entries(hardening)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
);
