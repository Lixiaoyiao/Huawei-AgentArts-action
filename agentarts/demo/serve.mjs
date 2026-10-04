#!/usr/bin/env node
/** Loopback-only, read-only run record viewer. No credentials or task execution. */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";

const USAGE =
  "Usage: node agentarts/demo/serve.mjs [--port 4173] [--record <absolute run-record.json path>]";
const MAX_BYTES = 2 * 1024 * 1024;
let port = 4173;
let recordPath;
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (args[i] === "--port") {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
        throw new Error("--port must be an integer between 1 and 65535.");
      port = Number(value);
    } else if (args[i] === "--record") {
      recordPath = args[++i];
      if (!recordPath || !isAbsolute(recordPath))
        throw new Error("--record must be an absolute file path.");
    } else {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  if (recordPath) {
    const info = await stat(recordPath);
    if (!info.isFile() || info.size > MAX_BYTES)
      throw new Error("--record must identify a regular file no larger than 2 MiB.");
  }
} catch (error) {
  console.error(error.message);
  console.error(USAGE);
  process.exit(1);
}

const html = await readFile(fileURLToPath(new URL("./index.html", import.meta.url)));
const source = html.toString("utf8");
const hashes = (tag) =>
  [...source.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))]
    .map((match) => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`)
    .join(" ");
const csp = `default-src 'none'; script-src ${hashes("script")}; style-src ${hashes("style")}; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
const authority = `127.0.0.1:${port}`;
const origin = `http://${authority}`;
const server = createServer(async (req, res) => {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  const reply = (status, body, type = "text/plain; charset=utf-8") => {
    res.writeHead(status, { ...headers, "Content-Type": type });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  // Prevent DNS rebinding and cross-origin reads. Paths are allowlisted, never mapped to disk.
  if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== origin))
    return reply(403, "Forbidden");
  if (!["GET", "HEAD"].includes(req.method)) return reply(405, "Method not allowed");
  let pathname;
  try {
    pathname = new URL(req.url, origin).pathname;
  } catch {
    return reply(400, "Bad request");
  }
  if (pathname === "/" || pathname === "/index.html")
    return reply(200, html, "text/html; charset=utf-8");
  if (pathname !== "/run-record.json") return reply(404, "Not found");
  if (!recordPath)
    return reply(
      404,
      JSON.stringify({ error: "No run record configured." }),
      "application/json; charset=utf-8",
    );
  try {
    const info = await stat(recordPath);
    if (!info.isFile() || info.size > MAX_BYTES)
      return reply(
        413,
        JSON.stringify({ error: "Run record exceeds the file limit." }),
        "application/json; charset=utf-8",
      );
    const payload = await readFile(recordPath);
    if (payload.byteLength > MAX_BYTES)
      return reply(
        413,
        JSON.stringify({ error: "Run record exceeds the file limit." }),
        "application/json; charset=utf-8",
      );
    JSON.parse(payload.toString("utf8"));
    reply(200, payload, "application/json; charset=utf-8");
  } catch {
    // Atomic updates are recommended; an incomplete file does not replace the browser's last record.
    reply(
      503,
      JSON.stringify({ error: "Run record is unavailable or invalid JSON." }),
      "application/json; charset=utf-8",
    );
  }
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 2000;
server.on("error", (error) => {
  console.error(`Demo server failed: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Run record viewer: ${origin}`);
  console.log(
    recordPath
      ? "Reading the configured run record. The page refreshes every 2 seconds."
      : "No run record configured. Load an exported JSON file in the page.",
  );
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
