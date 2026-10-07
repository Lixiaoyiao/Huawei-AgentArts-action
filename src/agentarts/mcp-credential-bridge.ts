import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  type ClientRequest,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { chmod, chown, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { lookup } from "node:dns/promises";
import { z } from "zod";
import { DshConfigurationError, DshProxyError } from "../dsh/errors.js";
import { mcpPublicToolName, type ExtensionPlan } from "../extensions/plan.js";
import { assertNoSecretOutput, collectControllerSecrets } from "../security/env.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { egressPolicy, resolveAgentArtsEgressTarget } from "./egress-proxy.js";

const referenceSchema = z.strictObject({
  serverId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
  url: z.url().max(2048),
  headerName: z.enum(["authorization", "x-api-key", "api-key", "x-auth-token"]),
  secretEnvironment: z
    .string()
    .regex(/^AGENTARTS_TOOL_[A-Z0-9_]{1,80}$/u)
    .refine((name) => !name.endsWith("_FILE")),
  prefix: z.enum(["", "Bearer ", "Basic "]).default(""),
  readOnlyTools: z.array(z.string().min(1).max(256)).min(1).max(64),
  maxCalls: z.number().int().min(1).max(100).default(10),
});
export type McpCredentialReference = z.infer<typeof referenceSchema> & { readonly secret: string };
/** Values are resolved only from supervisor configuration, never an invocation body. */
export function supervisorMcpCredentialReferences(
  environment: NodeJS.ProcessEnv,
  options: { readonly allowInsecureHttpTestOnly?: boolean } = {},
): readonly McpCredentialReference[] {
  let references: z.infer<typeof referenceSchema>[];
  try {
    references = z
      .array(referenceSchema)
      .max(16)
      .parse(JSON.parse(environment.AGENTARTS_MCP_CREDENTIAL_REFERENCES ?? "[]"));
  } catch {
    throw new DshConfigurationError("Invalid supervisor MCP credential reference configuration");
  }
  if (new Set(references.map(({ serverId }) => serverId)).size !== references.length)
    throw new DshConfigurationError("Duplicate supervisor MCP credential reference");
  const forbidden = [
    ...collectControllerSecrets(
      Object.fromEntries(
        Object.entries(environment).filter(([name]) => !name.startsWith("AGENTARTS_TOOL_")),
      ),
    ),
    environment.API_KEY,
    environment.AGENTARTS_LOCAL_API_KEY,
  ].filter((value): value is string => value !== undefined);
  return references.map((reference) => {
    const target = new URL(reference.url);
    const secret = environment[reference.secretEnvironment];
    if (
      !(
        target.protocol === "https:" ||
        (options.allowInsecureHttpTestOnly === true && target.protocol === "http:")
      ) ||
      target.username !== "" ||
      target.password !== "" ||
      target.hash !== "" ||
      target.href !== reference.url ||
      secret === undefined ||
      secret.length < 8 ||
      secret.length > 4096 ||
      /[\s\0]/u.test(secret) ||
      forbidden.includes(secret) ||
      new Set(reference.readOnlyTools).size !== reference.readOnlyTools.length
    )
      throw new DshConfigurationError(
        "MCP reference requires an exact endpoint and an independent supervisor tool credential",
      );
    const resolved = Object.freeze({ ...reference, secret });
    if (credentialValues(resolved).some((value) => forbidden.includes(value)))
      throw new DshConfigurationError("MCP reference requires an independent tool credential");
    return resolved;
  });
}
function credentialValues(reference: McpCredentialReference): readonly string[] {
  if (reference.prefix !== "Basic ") return [reference.secret];
  let decoded: string;
  try {
    const bytes = Buffer.from(reference.secret, "base64");
    if (bytes.toString("base64") !== reference.secret) throw new Error("Noncanonical encoding");
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DshConfigurationError("Basic MCP credentials require canonical base64 UTF-8");
  }
  const separator = decoded.indexOf(":");
  let containsControl = false;
  for (let index = 0; index < decoded.length; index++) {
    const code = decoded.charCodeAt(index);
    if (code < 32 || code === 127) containsControl = true;
  }
  if (separator <= 0 || separator === decoded.length - 1 || containsControl)
    throw new DshConfigurationError("Basic MCP credentials require a nonempty user and password");
  return [reference.secret, decoded, decoded.slice(separator + 1)];
}
export function mcpCredentialSecretVariants(
  references: readonly McpCredentialReference[],
): readonly string[] {
  return [
    ...new Set(
      references.flatMap((reference) =>
        credentialValues(reference).flatMap((secret) => [
          secret,
          Buffer.from(secret).toString("base64"),
          Buffer.from(secret).toString("base64url"),
          Buffer.from(secret).toString("hex"),
          encodeURIComponent(secret),
        ]),
      ),
    ),
  ];
}
export interface McpCredentialBridgeOptions {
  readonly references: readonly McpCredentialReference[];
  readonly plan: ExtensionPlan;
  readonly socketPath: string;
  readonly workerBaseUrl: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly lookup?: typeof lookup;
  readonly allowInsecureHttpTestOnly?: boolean;
  readonly testOnlyCertificateAuthority?: string;
  readonly onFailureStage?: (
    stage: "body" | "rpc" | "identity" | "tool" | "session" | "resolve" | "forward" | "response",
  ) => void;
}
export interface McpCredentialBridgeHandle {
  readonly socketPath: string;
  readonly mappings: readonly {
    readonly serverId: string;
    readonly originalUrl: string;
    readonly workerUrl: string;
  }[];
  assertHealthy(): void;
  close(): Promise<void>;
}
const rpcSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(128), z.number().int()]).optional(),
  method: z.enum([
    "server/discover",
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
    "tools/call",
  ]),
  params: z.record(z.string(), z.json()).optional(),
});
const MAX_REQUEST = 256 * 1024,
  MAX_RESPONSE = 2 * 1024 * 1024;

/** Stateless Streamable HTTP POST bridge: fixed targets, scoped read tools, no credentials in the worker. */
export async function startAgentArtsMcpCredentialBridge(
  options: McpCredentialBridgeOptions,
): Promise<McpCredentialBridgeHandle | undefined> {
  const selected = options.references.flatMap((reference) => {
    const server = options.plan.mcpServers.find(
      ({ definition }) => definition.id === reference.serverId,
    );
    if (server === undefined) return [];
    if (
      server.definition.transport !== "streamable-http" ||
      server.definition.url !== reference.url
    )
      throw new DshConfigurationError("MCP reference endpoint differs from the admitted server");
    if (options.plan.profileName === "github-action") {
      const controlled = options.plan.mcpServers.find(
        ({ definition }) => definition.id === reference.serverId,
      );
      if (
        controlled === undefined ||
        controlled.tools.some(
          (tool) =>
            !reference.readOnlyTools.some(
              (name) => mcpPublicToolName(reference.serverId, name) === tool.runtimeName,
            ) || tool.permissions.includes("workspace-write"),
        )
      )
        throw new DshConfigurationError(
          "Credential MCP bridge only admits the scoped read-only tool intersection",
        );
    }
    return [reference];
  });
  if (selected.length === 0) return undefined;
  if (
    selected.some(
      ({ url }) => new URL(url).protocol !== "https:" && options.allowInsecureHttpTestOnly !== true,
    )
  )
    throw new DshConfigurationError("Credential MCP transport requires HTTPS");
  throwIfCancelled(options.signal);
  if (process.platform !== "linux" || process.getuid?.() !== 0 || !isAbsolute(options.socketPath))
    throw new DshConfigurationError("Credential MCP mediation requires a Linux root Unix socket");
  const parent = await lstat(dirname(options.socketPath));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== 0 ||
    (parent.mode & 0o067) !== 0 ||
    ((parent.mode & 0o010) !== 0 && parent.gid !== 10001)
  )
    throw new DshConfigurationError("Credential MCP socket parent must be sealed");
  const policy = egressPolicy(options.environment),
    secrets = mcpCredentialSecretVariants(selected);
  const routes = new Map(
    selected.map((reference) => [
      `/agentarts-mcp/${reference.serverId}`,
      {
        reference,
        calls: 0,
        groupLimit:
          options.plan.profileName === "headless-native"
            ? reference.maxCalls
            : Math.min(
                reference.maxCalls,
                ...options.plan.tools
                  .filter((tool) => tool.ownerKind === "mcp" && tool.ownerId === reference.serverId)
                  .map(({ groupMaxCalls }) => groupMaxCalls),
              ),
        sessions: new Set<string>(),
        tools: new Map<string, { count: number; limit: number }>(
          reference.readOnlyTools.flatMap((name) => {
            if (options.plan.profileName === "headless-native")
              return [[name, { count: 0, limit: reference.maxCalls }] as const];
            const grant = options.plan.tools.find(
              (tool) =>
                tool.ownerKind === "mcp" &&
                tool.ownerId === reference.serverId &&
                tool.runtimeName === mcpPublicToolName(reference.serverId, name),
            );
            return grant === undefined
              ? []
              : [
                  [
                    name,
                    { count: 0, limit: Math.min(reference.maxCalls, grant.maxCalls) },
                  ] as const,
                ];
          }),
        ),
      },
    ]),
  );
  const pending = new Set<ClientRequest>(),
    incoming = new Set<IncomingMessage>();
  let closed = false,
    total = 0,
    active = 0,
    failure: Error | undefined;
  const guard = () => {
    throwIfCancelled(options.signal);
    if (closed || Date.now() >= options.deadlineMs)
      throw new DshProxyError("Credential MCP bridge is closed or expired");
  };
  const deny = (response: ServerResponse, status = 403) => {
    if (!response.headersSent)
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
    response.end('{"error":"MCP_BRIDGE_DENIED"}');
  };
  const server = createServer((request, response) => {
    void (async () => {
      let reserved = false;
      let stage: Parameters<NonNullable<McpCredentialBridgeOptions["onFailureStage"]>>[0] = "body";
      try {
        guard();
        const route = routes.get(request.url ?? "");
        if (route === undefined) throw new DshConfigurationError("Credential MCP route denied");
        if (request.method === "GET" || request.method === "DELETE") {
          deny(response, 405);
          return;
        }
        if (
          request.method !== "POST" ||
          !/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")
        )
          throw new DshConfigurationError("Credential MCP method denied");
        if (active >= 4 || ++total > 128)
          throw new DshProxyError("Credential MCP request budget exceeded");
        active++;
        reserved = true;
        incoming.add(request);
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const raw of request) {
          guard();
          const chunk = Buffer.from(raw as Uint8Array);
          size += chunk.length;
          if (size > MAX_REQUEST)
            throw new DshProxyError("Credential MCP input exceeds its byte bound");
          chunks.push(chunk);
        }
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        assertNoSecretOutput("prompt", raw, secrets);
        stage = "rpc";
        const decoded: unknown = JSON.parse(raw);
        assertNoSecretOutput("prompt", JSON.stringify(decoded), secrets);
        const checked = rpcSchema.safeParse(decoded);
        if (!checked.success)
          throw new DshConfigurationError("Credential MCP RPC input is invalid");
        const rpc = checked.data;
        assertNoSecretOutput("prompt", JSON.stringify(rpc), secrets);
        stage = "identity";
        if (
          rpc.method === "notifications/initialized" ? rpc.id !== undefined : rpc.id === undefined
        )
          throw new DshConfigurationError("Credential MCP RPC identity denied");
        if (rpc.method === "tools/call") {
          stage = "tool";
          const name = rpc.params?.name;
          const grantedTool = typeof name === "string" ? route.tools.get(name) : undefined;
          if (
            grantedTool === undefined ||
            ++route.calls > route.groupLimit ||
            ++grantedTool.count > grantedTool.limit
          )
            throw new DshConfigurationError("Credential MCP tool is not in the read-only grant");
        }
        stage = "session";
        const session = request.headers["mcp-session-id"];
        if (session !== undefined && (typeof session !== "string" || !route.sessions.has(session)))
          throw new DshConfigurationError("Credential MCP session is not bound to this task");
        const target = new URL(route.reference.url);
        stage = "resolve";
        const selectedTarget = await resolveAgentArtsEgressTarget(
          target,
          policy,
          options.lookup,
          options.signal,
        );
        guard();
        stage = "forward";
        const result = await new Promise<{
          status: number;
          contentType: string;
          session?: string;
          text: string;
        }>((resolve, reject) => {
          const headers: Record<string, string> = {
            host: target.host,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            [route.reference.headerName]: route.reference.prefix + route.reference.secret,
          };
          if (typeof session === "string") headers["mcp-session-id"] = session;
          const version = request.headers["mcp-protocol-version"];
          if (typeof version === "string" && /^[0-9-]{1,32}$/u.test(version))
            headers["mcp-protocol-version"] = version;
          const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(
            {
              hostname: selectedTarget.address,
              port: selectedTarget.port,
              ...(isIP(target.hostname.replace(/^\[|\]$/gu, "")) === 0
                ? { servername: target.hostname }
                : {}),
              method: "POST",
              path: target.pathname + target.search,
              headers,
              signal: options.signal,
              ...(options.testOnlyCertificateAuthority === undefined
                ? {}
                : { ca: options.testOnlyCertificateAuthority }),
            },
            (received) => {
              let bytes = 0;
              const output: Buffer[] = [];
              received.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > MAX_RESPONSE)
                  upstream.destroy(
                    new DshProxyError("Credential MCP response exceeds its byte bound"),
                  );
                else output.push(chunk);
              });
              received.once("error", reject);
              received.once("end", () => {
                try {
                  const text = new TextDecoder("utf-8", { fatal: true }).decode(
                    Buffer.concat(output),
                  );
                  const sessionHeader = received.headers["mcp-session-id"];
                  assertNoSecretOutput("stdout", JSON.stringify(received.headers) + text, secrets);
                  resolve({
                    status: received.statusCode ?? 502,
                    contentType: received.headers["content-type"] ?? "",
                    ...(typeof sessionHeader === "string" ? { session: sessionHeader } : {}),
                    text,
                  });
                } catch (error: unknown) {
                  reject(
                    error instanceof Error
                      ? error
                      : new DshProxyError("Credential MCP response failed"),
                  );
                }
              });
            },
          );
          pending.add(upstream);
          upstream.setTimeout(Math.max(1, Math.min(30_000, options.deadlineMs - Date.now())), () =>
            upstream.destroy(new DshProxyError("Credential MCP request timed out")),
          );
          upstream.once("close", () => pending.delete(upstream));
          upstream.once("error", reject);
          response.once("close", () => {
            if (!response.writableFinished) upstream.destroy();
          });
          upstream.end(raw);
        });
        guard();
        stage = "response";
        // The pinned MCP 2.0 client probes server/discover before its standard initialize fallback.
        if (rpc.method === "server/discover" && [400, 404, 405].includes(result.status)) {
          response.writeHead(result.status, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: -32601, message: "MCP discovery is unavailable" },
            }),
          );
          return;
        }
        if (result.status >= 300 && result.status < 400)
          throw new DshProxyError("Credential MCP redirects are forbidden");
        if (result.status < 200 || result.status >= 300)
          throw new DshProxyError("Credential MCP endpoint rejected the request");
        const rewrite = (value: unknown): unknown => {
          assertNoSecretOutput("stdout", JSON.stringify(value), secrets);
          const envelope = z.record(z.string(), z.json()).parse(value);
          if (envelope.jsonrpc !== "2.0")
            throw new DshProxyError("Credential MCP response is not JSON-RPC");
          if ("id" in envelope && envelope.id !== rpc.id)
            throw new DshProxyError("Credential MCP response identity mismatch");
          if (
            rpc.method === "tools/list" &&
            typeof envelope.result === "object" &&
            envelope.result !== null &&
            !Array.isArray(envelope.result)
          ) {
            const tools = envelope.result.tools;
            if (!Array.isArray(tools))
              throw new DshProxyError("Credential MCP tool catalog is malformed");
            return {
              ...envelope,
              result: {
                ...envelope.result,
                tools: tools.filter(
                  (tool) =>
                    typeof tool === "object" &&
                    tool !== null &&
                    !Array.isArray(tool) &&
                    typeof tool.name === "string" &&
                    route.tools.has(tool.name),
                ),
              },
            };
          }
          return envelope;
        };
        let body = result.text;
        if (rpc.id !== undefined || result.text.trim() !== "") {
          if (/^application\/json(?:\s*;|$)/iu.test(result.contentType))
            body = JSON.stringify(rewrite(JSON.parse(body)));
          else if (/^text\/event-stream(?:\s*;|$)/iu.test(result.contentType))
            body =
              body
                .split(/\r?\n\r?\n/u)
                .filter(Boolean)
                .map((block) => {
                  const lines = block.split(/\r?\n/u),
                    data = lines
                      .filter((line) => line.startsWith("data:"))
                      .map((line) => line.slice(5).trimStart())
                      .join("\n");
                  return data === ""
                    ? block
                    : [
                        ...lines.filter((line) => !line.startsWith("data:")),
                        `data: ${JSON.stringify(rewrite(JSON.parse(data)))}`,
                      ].join("\n");
                })
                .join("\n\n") + "\n\n";
          else throw new DshProxyError("Credential MCP requires a JSON or finite SSE response");
        }
        if (result.session !== undefined) {
          if (result.session.length > 256 || /[\r\n]/u.test(result.session))
            throw new DshProxyError("Credential MCP session header is invalid");
          route.sessions.add(result.session);
        }
        response.writeHead(result.status, {
          "content-type": result.contentType,
          "cache-control": "no-store",
          ...(result.session === undefined ? {} : { "mcp-session-id": result.session }),
        });
        response.end(body);
      } catch (error: unknown) {
        try {
          options.onFailureStage?.(stage);
        } catch {
          /* Observability cannot change the denial. */
        }
        if (!closed && !options.signal.aborted)
          failure ??= error instanceof Error ? error : new DshProxyError("Credential MCP failed");
        deny(response);
        request.resume();
      } finally {
        incoming.delete(request);
        if (reserved) active--;
      }
    })();
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.maxConnections = 16;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  const stop = () => {
    closed = true;
    for (const request of pending) request.destroy();
    for (const request of incoming) request.destroy();
    server.closeAllConnections();
  };
  options.signal.addEventListener("abort", stop, { once: true });
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
    options.signal.removeEventListener("abort", stop);
    server.close();
    throw error;
  }
  return {
    socketPath: options.socketPath,
    mappings: selected.map(({ serverId, url }) => ({
      serverId,
      originalUrl: url,
      workerUrl: `${options.workerBaseUrl}/agentarts-mcp/${serverId}`,
    })),
    assertHealthy() {
      if (failure !== undefined) throw failure;
      if (active > 0) throw new DshProxyError("Credential MCP work has not finished");
    },
    async close() {
      stop();
      options.signal.removeEventListener("abort", stop);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(options.socketPath, { force: true });
    },
  };
}

/** Strictly remap only the composition's generated MCP entry; definitions, grants and audit remain unchanged. */
export async function remapCredentialMcpProfile(
  profileRoot: string,
  mappings: McpCredentialBridgeHandle["mappings"],
): Promise<void> {
  const path = join(profileRoot, "cordis.patch.yml");
  const patch = z
    .array(z.record(z.string(), z.json()))
    .parse(JSON.parse(await readFile(path, "utf8")));
  for (const mapping of mappings) {
    let found = 0;
    for (const row of patch)
      for (const entry of Array.isArray(row.insert) ? row.insert : []) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          Array.isArray(entry) ||
          typeof entry.id !== "string" ||
          ![
            `dsh-action-mcp-${mapping.serverId}`,
            `dsh-action-native-mcp-${mapping.serverId}`,
          ].includes(entry.id)
        )
          continue;
        if (
          entry.name !== "@deepseek-ai/dsh-mcp-client" ||
          typeof entry.config !== "object" ||
          entry.config === null ||
          Array.isArray(entry.config) ||
          entry.config.transport !== "streamable-http" ||
          entry.config.serverName !== mapping.serverId ||
          entry.config.url !== mapping.originalUrl
        )
          throw new DshConfigurationError(
            "Generated credential MCP profile differs from its admitted definition",
          );
        entry.config.url = mapping.workerUrl;
        found++;
      }
    if (found !== 1)
      throw new DshConfigurationError(
        "Generated profile must contain exactly one credential MCP entry",
      );
  }
  await writeFile(path, JSON.stringify(patch) + "\n", { mode: 0o600 });
}
