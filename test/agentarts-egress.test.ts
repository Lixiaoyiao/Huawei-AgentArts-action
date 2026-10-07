import { describe, it, expect, afterEach } from "vitest";
import { createServer, request } from "node:http";
import { chmod, chown, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  egressPolicy,
  approvedConnectTarget,
  publicEgressAddress,
  startAgentArtsEgressProxy,
  type EgressProxyHandle,
} from "../src/agentarts/egress-proxy.js";

describe("supervisor egress configuration", () => {
  it("matches HTTP and HTTPS CONNECT by the exact operator-selected host and port", () => {
    const policy = {
      origins: ["http://tools.example:8080", "https://secure.example", "http://[::1]:8123"],
      allowPrivateAddresses: false,
    };
    expect(approvedConnectTarget("tools.example:8080", policy).origin).toBe(
      "http://tools.example:8080",
    );
    expect(approvedConnectTarget("secure.example:443", policy).origin).toBe(
      "https://secure.example",
    );
    expect(approvedConnectTarget("[::1]:8123", policy).origin).toBe("http://[::1]:8123");
    for (const target of [
      "tools.example:443",
      "secure.example:80",
      "tools.example:8081",
      "user@tools.example:8080",
      "tools.example:0",
      "tools.example:65536",
      "other.example:8080",
      "tools.example:8080/path",
    ])
      expect(() => approvedConnectTarget(target, policy)).toThrow();
  });
  it("defaults closed and rejects paths, credentials and operator typos", () => {
    expect(egressPolicy({})).toEqual({ origins: [], allowPrivateAddresses: false });
    for (const value of [
      "{}",
      '["https://tools.example/mcp"]',
      '["https://user:password@tools.example"]',
      '["file:///tmp"]',
      "[1]",
      '["https://tools.example/"]',
    ])
      expect(() => egressPolicy({ AGENTARTS_EGRESS_ALLOWED_ORIGINS: value })).toThrow();
    expect(() => egressPolicy({ AGENTARTS_EGRESS_ALLOW_PRIVATE: "yes" })).toThrow();
    expect(
      egressPolicy({ AGENTARTS_EGRESS_ALLOWED_ORIGINS: '["https://tools.example"]' }).origins,
    ).toEqual(["https://tools.example"]);
  });
  it("blocks loopback, metadata, VPC, CGNAT, IPv4-mapped, NAT64 and transition addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.1.1",
      "169.254.169.254",
      "100.100.100.200",
      "172.31.1.1",
      "192.168.1.1",
      "0.0.0.0",
      "198.18.0.1",
      "224.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::7f00:1",
      "fe80::1",
      "fd00::1",
      "2002:7f00:1::",
      "2001:db8::1",
    ])
      expect(publicEgressAddress(address), address).toBe(false);
    for (const address of ["1.1.1.1", "8.8.8.8", "2001:4860:4860::8888"])
      expect(publicEgressAddress(address), address).toBe(true);
  });
});

const linuxRoot = process.platform === "linux" && process.getuid?.() === 0;
describe.skipIf(!linuxRoot)("actual mediated Unix egress", () => {
  let root: string | undefined;
  let proxy: EgressProxyHandle | undefined;
  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });
  async function prepare(origins: string[], allowPrivateAddresses = false) {
    root = await mkdtemp(join(tmpdir(), "agentarts-egress-test-"));
    await chmod(root, 0o710);
    await chown(root, 0, 10001);
    proxy = await startAgentArtsEgressProxy({
      socketPath: join(root, "egress.sock"),
      policy: { origins, allowPrivateAddresses },
      deadlineMs: Date.now() + 10_000,
    });
    return proxy;
  }
  async function invoke(socketPath: string, path: string) {
    return await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const pending = request({ socketPath, path }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      pending.once("error", reject);
      pending.end();
    });
  }
  it("connects only the exact operator-approved local fixture and strips proxy credentials", async () => {
    let received = 0;
    const fixture = createServer((_request, response) => {
      received += 1;
      response.end("approved");
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    if (address === null || typeof address === "string") throw new Error("fixture failed");
    try {
      const origin = `http://127.0.0.1:${String(address.port)}`;
      const handle = await prepare([origin], true);
      expect(await invoke(handle.socketPath, `${origin}/tools`)).toEqual({
        status: 200,
        text: "approved",
      });
      expect((await invoke(handle.socketPath, "http://127.0.0.1:1/tools")).status).toBe(403);
      expect(received).toBe(1);
    } finally {
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });
  it("denies metadata even when private egress is explicitly enabled", async () => {
    const handle = await prepare(["http://169.254.169.254"], true);
    expect(
      (await invoke(handle.socketPath, "http://169.254.169.254/latest/meta-data")).status,
    ).toBe(403);
  });
  it("requires private opt-in for even an approved localhost origin", async () => {
    const handle = await prepare(["http://127.0.0.1:1"]);
    expect((await invoke(handle.socketPath, "http://127.0.0.1:1/")).status).toBe(403);
  });
});
