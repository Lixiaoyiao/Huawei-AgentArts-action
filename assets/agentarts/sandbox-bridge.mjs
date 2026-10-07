/** Trusted namespace bootstrap: only the bounded, authenticated model socket is exposed. */
import { createServer, request as requestHttp } from "node:http";
import { spawn } from "node:child_process";

const [socketPath, rawPort, command, ...args] = process.argv.slice(2);
const installerOnly = socketPath === "--installer";
const port = Number(rawPort);
if (
  (!installerOnly &&
    (socketPath !== "/run/agentarts-model.sock" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535)) ||
  (installerOnly &&
    (rawPort !== "0" ||
      process.env.AGENTARTS_WORKER_EGRESS_SOCKET !== "/run/agentarts-egress.sock")) ||
  !command
)
  throw new Error("Invalid namespace bootstrap");
const server = createServer((incoming, outgoing) => {
  const mcpPath = incoming.url?.startsWith("/agentarts-mcp/");
  const mcpSocket = process.env.AGENTARTS_WORKER_MCP_SOCKET;
  if (
    mcpPath &&
    (mcpSocket !== "/run/agentarts-mcp.sock" ||
      !/^\/agentarts-mcp\/[a-z][a-z0-9-]{0,31}$/u.test(incoming.url))
  ) {
    outgoing.writeHead(403);
    outgoing.end();
    incoming.resume();
    return;
  }
  const upstream = requestHttp(
    {
      socketPath: mcpPath ? mcpSocket : socketPath,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.once("aborted", () => upstream.destroy());
  outgoing.once("close", () => {
    if (!outgoing.writableFinished) upstream.destroy();
  });
  incoming.pipe(upstream);
});
server.on("clientError", (_error, socket) => socket.destroy());
if (!installerOnly)
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
let egressServer;
const workerEnvironment = { ...process.env };
delete workerEnvironment.AGENTARTS_WORKER_MCP_SOCKET;
if (process.env.AGENTARTS_WORKER_EGRESS_SOCKET === "/run/agentarts-egress.sock") {
  const egressSocket = process.env.AGENTARTS_WORKER_EGRESS_SOCKET;
  egressServer = createServer((incoming, outgoing) => {
    const upstream = requestHttp(
      {
        socketPath: egressSocket,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.once("aborted", () => upstream.destroy());
    outgoing.once("close", () => {
      if (!outgoing.writableFinished) upstream.destroy();
    });
    incoming.pipe(upstream);
  });
  egressServer.on("connect", (incoming, socket, head) => {
    const upstream = requestHttp({
      socketPath: egressSocket,
      method: "CONNECT",
      path: incoming.url,
      headers: incoming.headers,
    });
    upstream.once("connect", (response, tunnel, tunnelHead) => {
      if (response.statusCode !== 200) {
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        tunnel.destroy();
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) tunnel.write(head);
      if (tunnelHead.length > 0) socket.write(tunnelHead);
      socket.pipe(tunnel);
      tunnel.pipe(socket);
      socket.once("close", () => tunnel.destroy());
      tunnel.once("close", () => socket.destroy());
      tunnel.on("error", () => socket.destroy());
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  egressServer.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    egressServer.once("error", reject);
    egressServer.listen(0, "127.0.0.1", resolve);
  });
  const address = egressServer.address();
  const proxy = `http://127.0.0.1:${address.port}`;
  Object.assign(workerEnvironment, {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: `127.0.0.1:${port},localhost:${port}`,
    no_proxy: `127.0.0.1:${port},localhost:${port}`,
    NODE_USE_ENV_PROXY: "1",
  });
}
delete workerEnvironment.AGENTARTS_WORKER_EGRESS_SOCKET;
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: workerEnvironment,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let stopped = false;
function finish(code) {
  if (stopped) return;
  stopped = true;
  if (!installerOnly) server.closeAllConnections();
  egressServer?.closeAllConnections();
  egressServer?.close();
  if (installerOnly) process.exit(code);
  else server.close(() => process.exit(code));
  // Exiting namespace pid2 also causes bwrap's pid1 to reap/stop remaining children.
  setTimeout(() => process.exit(code), 100).unref();
}
child.once("error", () => finish(127));
child.once("exit", (code, signal) => finish(signal === null ? (code ?? 1) : 1));
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    child.kill(signal);
    finish(1);
  });
