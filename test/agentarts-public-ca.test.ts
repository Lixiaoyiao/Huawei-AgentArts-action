import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  lstat: mocks.stat,
}));
import { AGENTARTS_PUBLIC_CA, agentArtsPublicCertificateArgs } from "../src/agentarts/sandbox.js";

const metadata = (path: string) => ({
  uid: 0,
  mode: path === AGENTARTS_PUBLIC_CA ? 0o100644 : 0o40755,
  size: 1024,
  isFile: () => path === AGENTARTS_PUBLIC_CA,
  isDirectory: () => path !== AGENTARTS_PUBLIC_CA,
  isSymbolicLink: () => false,
});
beforeEach(() =>
  mocks.stat.mockReset().mockImplementation((path: string) => Promise.resolve(metadata(path))),
);
describe("fixed public CA file for Git TLS in namespaces", () => {
  it("mounts only the image public CA file read-only, never the /etc directory or a host Git config", async () => {
    const args = await agentArtsPublicCertificateArgs();
    expect(args).toEqual([
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
    ]);
    expect(args).not.toContain("GIT_SSL_NO_VERIFY");
    expect(mocks.stat.mock.calls.map(([path]) => path)).toEqual([
      "/etc",
      "/etc/ssl",
      "/etc/ssl/certs",
      AGENTARTS_PUBLIC_CA,
    ]);
  });
  it.each(["symlink", "writable", "worker-owned", "empty", "oversized", "special"])(
    "refuses an unsafe %s CA bundle",
    async (kind) => {
      mocks.stat.mockImplementation((path: string) =>
        Promise.resolve(
          path !== AGENTARTS_PUBLIC_CA
            ? metadata(path)
            : {
                ...metadata(path),
                ...(kind === "symlink" ? { isSymbolicLink: () => true } : {}),
                ...(kind === "writable" ? { mode: 0o100666 } : {}),
                ...(kind === "worker-owned" ? { uid: 10001 } : {}),
                ...(kind === "empty" ? { size: 0 } : {}),
                ...(kind === "oversized" ? { size: 4 * 1024 * 1024 + 1 } : {}),
                ...(kind === "special" ? { isFile: () => false } : {}),
              },
        ),
      );
      await expect(agentArtsPublicCertificateArgs()).rejects.toThrow("Public CA bundle");
    },
  );
  it("refuses a writable or symlink ancestor before reading a CA leaf", async () => {
    mocks.stat.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/etc/ssl"
          ? {
              ...metadata(path),
              isSymbolicLink: () => true,
            }
          : metadata(path),
      ),
    );
    await expect(agentArtsPublicCertificateArgs()).rejects.toThrow("Public CA parent");
    expect(mocks.stat).toHaveBeenCalledTimes(2);
  });
});
