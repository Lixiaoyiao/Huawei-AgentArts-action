import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { chmod, chown, lstat, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { DshConfigurationError } from "../dsh/errors.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";

export interface EgressPolicy {
  readonly origins: readonly string[];
  readonly allowPrivateAddresses: boolean;
}
/** ProxyAgent also tunnels plain HTTP. Match the exact configured host and port. */
export function approvedConnectTarget(authority: string, policy: EgressPolicy): URL {
  if (!/^(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):[0-9]{1,5}$/u.test(authority))
    throw new DshConfigurationError("Invalid CONNECT authority");
  const requested = new URL(`https://${authority}`);
  const port = Number(authority.slice(authority.lastIndexOf(":") + 1));
  if (port < 1 || port > 65535) throw new DshConfigurationError("Invalid CONNECT port");
  for (const origin of policy.origins) {
    const candidate = new URL(origin);
    if (
      candidate.hostname === requested.hostname &&
      Number(candidate.port || (candidate.protocol === "https:" ? 443 : 80)) === port
    )
      return candidate;
  }
  throw new DshConfigurationError("CONNECT origin denied");
}
/** Operator configuration only: tasks cannot select an origin or bypass DNS/IP checks. */
export function egressPolicy(environment: NodeJS.ProcessEnv): EgressPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(environment.AGENTARTS_EGRESS_ALLOWED_ORIGINS ?? "[]") as unknown;
  } catch {
    throw new DshConfigurationError("Egress origin policy must be a JSON array");
  }
  if (
    !Array.isArray(raw) ||
    raw.length > 32 ||
    raw.some((value: unknown) => typeof value !== "string")
  )
    throw new DshConfigurationError("Egress origin policy must contain at most 32 origins");
  const origins = (raw as string[]).map((value) => {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== value ||
      url.username !== "" ||
      url.password !== ""
    )
      throw new DshConfigurationError(
        "Egress policy must contain exact HTTP(S) origins without paths or credentials",
      );
    return url.origin;
  });
  const privateOption = environment.AGENTARTS_EGRESS_ALLOW_PRIVATE ?? "false";
  if (!["true", "false"].includes(privateOption))
    throw new DshConfigurationError("Egress private-address policy must be true or false");
  return { origins: [...new Set(origins)], allowPrivateAddresses: privateOption === "true" };
}

export function publicEgressAddress(address: string): boolean {
  const text = address.toLowerCase();
  if (text.startsWith("::ffff:")) return publicEgressAddress(text.slice(7));
  if (isIP(text) === 4) {
    const [a = 0, b = 0] = text.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  // Only global unicast; IPv4-mapped, NAT64, link-local and transition ranges stay closed.
  return (
    isIP(text) === 6 &&
    /^[23][0-9a-f]{3}:/u.test(text) &&
    !text.startsWith("2001:db8:") &&
    !text.startsWith("2001:0:") &&
    !text.startsWith("2002:")
  );
}

export interface EgressProxyOptions {
  readonly socketPath: string;
  readonly policy: EgressPolicy;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  /** Deterministic DNS tests; production always resolves and pins the selected address. */
  readonly lookup?: typeof lookup;
  /** Supervisor-only installer limits, never serialized in a task. */
  readonly maxRequests?: number;
  readonly maxConcurrent?: number;
  readonly maxConnectionBytes?: number;
}
export interface EgressProxyHandle {
  readonly socketPath: string;
  close(): Promise<void>;
}
const metadataAddresses = new BlockList();
metadataAddresses.addSubnet("169.254.0.0", 16, "ipv4");
metadataAddresses.addAddress("100.100.100.200", "ipv4");
metadataAddresses.addSubnet("fe80::", 10, "ipv6");
metadataAddresses.addAddress("fd00:ec2::254", "ipv6");
metadataAddresses.addSubnet("64:ff9b::", 96, "ipv6");
metadataAddresses.addSubnet("64:ff9b:1::", 48, "ipv6");
metadataAddresses.addSubnet("2002::", 16, "ipv6");
metadataAddresses.addSubnet("2001::", 32, "ipv6");

/** Shared trusted DNS pinning for raw egress and the credentialed MCP bridge. */
export async function resolveAgentArtsEgressTarget(
  target: URL,
  policy: EgressPolicy,
  lookupImplementation: typeof lookup = lookup,
  signal?: AbortSignal,
): Promise<{ address: string; port: number }> {
  if (
    !policy.origins.includes(target.origin) ||
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== "" ||
    !["http:", "https:"].includes(target.protocol)
  )
    throw new DshConfigurationError("Egress destination denied");
  throwIfCancelled(signal);
  const hostname = target.hostname.replace(/^\[|\]$/gu, "");
  const addresses =
    isIP(hostname) === 0
      ? await lookupImplementation(hostname, { all: true, verbatim: true })
      : [{ address: hostname, family: isIP(hostname) }];
  throwIfCancelled(signal);
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) =>
      metadataAddresses.check(address, isIP(address) === 4 ? "ipv4" : "ipv6"),
    ) ||
    (!policy.allowPrivateAddresses &&
      addresses.some(({ address }) => !publicEgressAddress(address)))
  )
    throw new DshConfigurationError("Egress DNS resolved a forbidden address");
  const selected = addresses[0];
  if (selected === undefined) throw new DshConfigurationError("Egress DNS resolution failed");
  return {
    address: selected.address,
    port: Number(target.port || (target.protocol === "https:" ? 443 : 80)),
  };
}

export async function startAgentArtsEgressProxy(
  options: EgressProxyOptions,
): Promise<EgressProxyHandle> {
  throwIfCancelled(options.signal);
  const requestLimit = options.maxRequests ?? 128;
  const concurrentLimit = options.maxConcurrent ?? 4;
  const connectionLimit = options.maxConnectionBytes ?? 16 * 1024 * 1024;
  if (
    !Number.isSafeInteger(requestLimit) ||
    requestLimit < 1 ||
    requestLimit > 2048 ||
    !Number.isSafeInteger(concurrentLimit) ||
    concurrentLimit < 1 ||
    concurrentLimit > 32 ||
    !Number.isSafeInteger(connectionLimit) ||
    connectionLimit < 1 ||
    connectionLimit > 128 * 1024 * 1024
  )
    throw new DshConfigurationError("Invalid supervisor egress limits");
  if (process.platform !== "linux" || process.getuid?.() !== 0 || !isAbsolute(options.socketPath))
    throw new DshConfigurationError("Egress mediation requires a root supervisor Unix socket");
  const parent = await lstat(dirname(options.socketPath));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== 0 ||
    (parent.mode & 0o067) !== 0 ||
    ((parent.mode & 0o010) !== 0 && parent.gid !== 10001)
  )
    throw new DshConfigurationError("Egress socket parent must be sealed");
  try {
    await lstat(options.socketPath);
    throw new DshConfigurationError("Egress socket path must be unused");
  } catch (error: unknown) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }
  const sockets = new Set<Socket>();
  let closed = false;
  let total = 0;
  let active = 0;
  const ended = (): boolean => closed || Date.now() >= options.deadlineMs;
  const selectedTarget = async (target: URL) => {
    if (
      closed ||
      Date.now() >= options.deadlineMs ||
      !options.policy.origins.includes(target.origin) ||
      target.username !== "" ||
      target.password !== "" ||
      target.hash !== "" ||
      !["http:", "https:"].includes(target.protocol)
    )
      throw new DshConfigurationError("Egress destination denied");
    if (active >= concurrentLimit || ++total > requestLimit)
      throw new DshConfigurationError("Egress request budget exhausted");
    active += 1;
    try {
      const selected = await resolveAgentArtsEgressTarget(
        target,
        options.policy,
        options.lookup ?? lookup,
        options.signal,
      );
      if (ended()) throw new DshConfigurationError("Egress task ended during DNS resolution");
      return selected;
    } catch (error: unknown) {
      active -= 1;
      throw error;
    }
  };
  const boundedSocket = (socket: Socket): void => {
    sockets.add(socket);
    socket.setTimeout(Math.max(1, Math.min(30_000, options.deadlineMs - Date.now())), () =>
      socket.destroy(),
    );
    let size = 0;
    socket.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > connectionLimit) socket.destroy();
    });
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const deny = (response: ServerResponse): void => {
    if (!response.headersSent)
      response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"EGRESS_DENIED"}');
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      let reserved = false;
      try {
        const target = new URL(request.url ?? "");
        if (target.protocol !== "http:")
          throw new DshConfigurationError("Use CONNECT for HTTPS egress");
        const selected = await selectedTarget(target);
        reserved = true;
        const headers: IncomingHttpHeaders = { ...request.headers, host: target.host };
        delete headers["proxy-authorization"];
        delete headers["proxy-connection"];
        delete headers.connection;
        const upstream = httpRequest(
          {
            host: selected.address,
            port: selected.port,
            method: request.method,
            path: `${target.pathname}${target.search}`,
            headers,
          },
          (incoming) => {
            response.writeHead(incoming.statusCode ?? 502, incoming.headers);
            incoming.pipe(response);
          },
        );
        upstream.on("socket", boundedSocket);
        upstream.on("error", () => deny(response));
        request.once("aborted", () => upstream.destroy());
        response.once("close", () => {
          upstream.destroy();
          if (reserved) {
            active -= 1;
            reserved = false;
          }
        });
        request.pipe(upstream);
      } catch {
        if (reserved) active -= 1;
        deny(response);
        request.resume();
      }
    })();
  });
  server.on("connection", boundedSocket);
  server.maxConnections = concurrentLimit * 4;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (request, socket, head) => {
    void (async () => {
      try {
        const authority = request.url ?? "";
        const selected = await selectedTarget(approvedConnectTarget(authority, options.policy));
        const upstream = connect({ host: selected.address, port: selected.port });
        boundedSocket(upstream);
        upstream.once("close", () => {
          active -= 1;
          socket.destroy();
        });
        socket.once("close", () => upstream.destroy());
        upstream.once("connect", () => {
          if (closed) {
            upstream.destroy();
            return;
          }
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
      } catch {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
    })();
  });
  const stop = (): void => {
    closed = true;
    for (const socket of sockets) socket.destroy();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(options.socketPath, 0o660);
    await chown(options.socketPath, 0, 10001);
  } catch (error: unknown) {
    stop();
    options.signal?.removeEventListener("abort", stop);
    server.close();
    throw error;
  }
  return {
    socketPath: options.socketPath,
    async close() {
      stop();
      options.signal?.removeEventListener("abort", stop);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(options.socketPath, { force: true });
    },
  };
}
