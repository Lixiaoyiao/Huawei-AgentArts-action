import { randomUUID } from "node:crypto";
import type { lookup } from "node:dns/promises";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { digest } from "../src/agentarts/protocol.js";
import {
  runtimeGrantsDigest,
  runtimeTaskSchema,
  runtimeTaskReplySchema,
  type RuntimeTask,
} from "../src/agentarts/runtime-task-protocol.js";
import { createWorkspaceTransferManifest } from "../src/agentarts/workspace-transfer.js";
import { createAgentArtsServer, type AgentArtsServerOptions } from "../src/agentarts/server.js";
import { runAgentArtsRuntimeTask } from "../src/agentarts/worker.js";
import { executeBoundedDshProcess } from "../src/dsh/process.js";
import { prepareAgentArtsSandbox } from "../src/agentarts/sandbox.js";
import {
  resolveExtensionPlan,
  resolveNativeExtensionPlan,
  type ExtensionPlan,
} from "../src/extensions/plan.js";
import {
  parseMcpConfiguration,
  parsePluginConfiguration,
  parseNativeMcpConfiguration,
  parseNativePluginConfiguration,
} from "../src/extensions/schema.js";
import type { SecurityPolicy } from "../src/security/policy.js";
import { sendMessagesSse, messageToolResults } from "./fixtures/messages-sse.mjs";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture TCP address unavailable");
  return `http://127.0.0.1:${String(address.port)}`;
}
function admission(write = false): SecurityPolicy {
  return {
    trust: write ? "trusted-write" : "trusted-read",
    allowed: true,
    reason: "Production namespace deterministic test",
    capabilities: {
      readRepository: true,
      readCi: true,
      publishComments: false,
      executeRepositoryCode: write,
      loadExtensions: true,
      accessNetwork: true,
      modifyWorkspace: write,
      commit: false,
      push: false,
      createPullRequest: false,
      manageIssueLabels: false,
      manageIssueAssignees: false,
      updateIssueState: false,
      updatePullRequestMetadata: false,
    },
  };
}
function packet(
  mode: "controlled" | "native",
  write: boolean,
  extensions?: ExtensionPlan,
): RuntimeTask {
  const grants = {
    mode,
    trust: write ? ("trusted-write" as const) : ("trusted-read" as const),
    requestedAccess: write ? ("write" as const) : ("read" as const),
    tools: write
      ? ["workspace.read" as const, "workspace.edit" as const, "native.bash" as const]
      : ["workspace.read" as const],
    toolCatalog: [],
    ...(extensions === undefined ? {} : { extensions }),
  };
  const taskId = randomUUID(),
    binding = {
      taskId,
      operation: "task" as const,
      operationIdentity: "task:9:namespace-test",
      repository: "offline/namespace",
      entity: { kind: "issue" as const, number: 9 },
      ref: "main",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      revision: 0,
      grantDigest: runtimeGrantsDigest(grants),
    };
  const source = "original namespace fixture\n";
  return runtimeTaskSchema.parse({
    schemaVersion: 3,
    taskId,
    operation: "task",
    binding,
    ...grants,
    timeoutMs: 60_000,
    instructions:
      "This is a deterministic namespace fixture. Use admitted tools and current workspace only.",
    context: {
      taskContext: { repository: binding.repository, entity: binding.entity },
      controllerLoop: { turn: 1 },
    },
    workspace: createWorkspaceTransferManifest(binding, [
      {
        path: "source.txt",
        content: source,
        encoding: "utf8",
        sha256: digest(source),
        mode: 0o644,
      },
    ]),
  });
}
const final = {
  protocolVersion: 1,
  operation: "task",
  state: "final",
  summary: "Production namespace deterministic fixture complete",
  findings: [],
};
const fakeKey = "namespace-supervisor-model-key-fixture";
const production = process.platform === "linux" && process.getuid?.() === 0;
// A named endpoint preserves production URL semantics. DSH deliberately keeps localhost inside its own namespace.
const fixtureDns = ((hostname: string, options?: unknown) => {
  if (hostname !== "mcp-fixture.invalid") throw new Error("Unexpected fixture DNS request");
  const address = { address: "127.0.0.1", family: 4 };
  return Promise.resolve(
    typeof options === "object" && options !== null && "all" in options && options.all === true
      ? [address]
      : address,
  );
}) as typeof lookup;
const runRuntimeFixture: NonNullable<AgentArtsServerOptions["runRuntimeTask"]> = (task, options) =>
  runAgentArtsRuntimeTask(task, {
    ...options,
    prepareSandbox: (input) => prepareAgentArtsSandbox({ ...input, egressLookup: fixtureDns }),
    executeProcess: async (spec, limits) => {
      const result = await executeBoundedDshProcess(spec, limits);
      if (result.exitCode !== 0) {
        const source = result.stdout + result.stderr;
        const signatures = [
          "ECONNREFUSED",
          "ENOTFOUND",
          "fetch failed",
          "failed to activate",
          "timed out",
          "EGRESS_DENIED",
        ].filter((signature) => source.includes(signature));
        process.stderr.write(
          JSON.stringify({
            event: "runtime-fixture.failure",
            exitCode: result.exitCode,
            signatures,
          }) + "\n",
        );
      }
      return result;
    },
  });

describe("actual full Runtime namespaces, native capabilities and public MCP", () => {
  it("rejects serialized extension credentials and tampered effective tool plans before execution", () => {
    const definition = {
      schemaVersion: 1,
      servers: [
        {
          id: "public",
          transport: "streamable-http",
          url: "https://public-fixture.invalid/mcp",
          headers: { Authorization: "Bearer extension-credential-fixture" },
          tools: [
            {
              id: "echo",
              name: "echo",
              description: "Public fixture evidence",
              permissions: ["read", "network"],
            },
          ],
        },
      ],
    };
    const plan = resolveExtensionPlan({
      mcp: parseMcpConfiguration(JSON.stringify(definition)),
      plugins: parsePluginConfiguration('{"schemaVersion":1}'),
      allowedTools: ["mcp.public.echo"],
      allowPluginInstall: false,
      policy: admission(),
    });
    expect(() => packet("controlled", false, plan)).toThrow("credential-bearing");
    const publicPlan = resolveExtensionPlan({
      mcp: parseMcpConfiguration(
        JSON.stringify({
          ...definition,
          servers: definition.servers.map((server) => ({ ...server, headers: {} })),
        }),
      ),
      plugins: parsePluginConfiguration('{"schemaVersion":1}'),
      allowedTools: ["mcp.public.echo"],
      allowPluginInstall: false,
      policy: admission(),
    });
    expect(packet("controlled", false, publicPlan).extensions?.digest).toBe(publicPlan.digest);
    expect(() => packet("controlled", false, { ...publicPlan, digest: "f".repeat(64) })).toThrow();
  });
  it.skipIf(!production).each(["controlled", "native"] as const)(
    "executes %s Bash in the production namespace and captures actual bytes",
    async (mode) => {
      const requests: Record<string, unknown>[] = [];
      const provider = await listen(
        createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.once("end", () => {
            requests.push(
              JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
            );
            if (requests.length === 1) {
              // Probe the actual namespace from repository code, without printing or receiving real credentials.
              const script =
                "const fs=require('node:fs'),os=require('node:os');const s=fs.readFileSync('/proc/self/status','utf8');if(process.getuid()!==10001||process.getgid()!==10001||!/^CapEff:\\s+0+$/m.test(s)||Object.keys(os.networkInterfaces()).some(x=>x!=='lo')||process.env.GITHUB_TOKEN||process.env.API_KEY||process.env.DEEPSEEK_API_KEY?.includes('supervisor'))process.exit(45);fs.writeFileSync('source.txt','changed by isolated Bash\\n');process.stdout.write('NAMESPACE_OK');";
              sendMessagesSse(
                response,
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "namespace-bash",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({
                          command: `node -e '${script.replaceAll("'", "'\\''")}'`,
                          description: "Check namespace and update admitted fixture",
                          timeoutMs: 5000,
                        }),
                      },
                    },
                  ],
                },
                "tool_calls",
              );
            } else sendMessagesSse(response, { content: JSON.stringify(final) }, "stop");
          });
        }),
      );
      const runtime = await listen(
        createAgentArtsServer({
          environment: {
            DEEPSEEK_API_KEY: fakeKey,
            DEEPSEEK_BASE_URL: provider,
            DEEPSEEK_WEB_SEARCH_BASE_URL: provider,
            AGENTARTS_MODEL_EVIDENCE: "deterministic-fixture",
            GITHUB_TOKEN: "controller-only-fixture-token",
            API_KEY: "frontend-only-fixture-key",
            PATH: process.env.PATH,
          },
          runRuntimeTask: runRuntimeFixture,
        }),
      );
      const response = await fetch(`${runtime}/invocations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(packet(mode, true)),
      });
      const raw: unknown = await response.json();
      expect(response.status, JSON.stringify(raw)).toBe(200);
      const result = runtimeTaskReplySchema.parse(raw);
      const tool = messageToolResults(requests[1] ?? {}).find(
        (entry) => "tool_use_id" in entry && entry.tool_use_id === "namespace-bash",
      );
      expect(tool).toMatchObject({ is_error: false });
      expect(JSON.stringify(tool)).toContain("NAMESPACE_OK");
      expect(result.delta?.changes).toEqual([
        expect.objectContaining({
          kind: "modified",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Nested Vitest matcher, never runtime data.
          file: expect.objectContaining({
            path: "source.txt",
            content: "changed by isolated Bash\n",
          }),
        }),
      ]);
      expect(result.sandboxEvidence).toEqual({
        backend: "agentarts-bwrap",
        credentialMediated: true,
        processIsolated: true,
        networkIsolated: true,
        workspaceAccess: "read-write",
      });
      if (mode === "controlled")
        expect(result.toolReceipts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "native.bash", completed: true, ok: true }),
          ]),
        );
      else expect(result.observedTools).toContain("bash");
    },
    90_000,
  );

  it.skipIf(!production).each(["controlled", "native"] as const)(
    "calls a credential-free %s HTTP MCP service only through approved egress",
    async (mode) => {
      let calls = 0;
      const mcpOrigin = await listen(
        createServer((request, response) => {
          const mcp = new McpServer(
            { name: "public-runtime-fixture", version: "1.0.0" },
            { capabilities: { tools: {} } },
          );
          mcp.registerTool(
            "echo",
            { description: "Return public fixture evidence", inputSchema: { message: z.string() } },
            ({ message }) => {
              calls++;
              return Promise.resolve({
                content: [{ type: "text" as const, text: `PUBLIC_MCP:${message}` }],
              });
            },
          );
          const transport = new StreamableHTTPServerTransport({});
          response.once("close", () => {
            void transport.close();
            void mcp.close();
          });
          mcp
            .connect(transport as Transport)
            .then(() => transport.handleRequest(request, response))
            .catch(() => response.writeHead(500).end());
        }),
      );
      const namedOrigin = mcpOrigin.replace("127.0.0.1", "mcp-fixture.invalid");
      const raw = JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "public",
            transport: "streamable-http",
            url: `${namedOrigin}/mcp`,
            reconnect: { enabled: false },
            ...(mode === "controlled"
              ? {
                  tools: [
                    {
                      id: "echo",
                      name: "echo",
                      description: "Return public fixture evidence",
                      permissions: ["read", "network"],
                      timeoutMs: 5000,
                    },
                  ],
                }
              : {}),
          },
        ],
      });
      const extensions =
        mode === "controlled"
          ? resolveExtensionPlan({
              mcp: parseMcpConfiguration(raw),
              plugins: parsePluginConfiguration('{"schemaVersion":1}'),
              allowedTools: ["mcp.public.echo"],
              allowPluginInstall: false,
              policy: admission(),
            })
          : resolveNativeExtensionPlan({
              mcp: parseNativeMcpConfiguration(raw),
              plugins: parseNativePluginConfiguration('{"schemaVersion":1}'),
              allowPluginInstall: false,
              policy: admission(),
            });
      const requests: Record<string, unknown>[] = [];
      const provider = await listen(
        createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.once("end", () => {
            requests.push(
              JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
            );
            if (requests.length === 1)
              sendMessagesSse(
                response,
                {
                  tool_calls: [
                    {
                      id: "public-mcp",
                      index: 0,
                      type: "function",
                      function: {
                        name: "mcp__public__echo",
                        arguments: JSON.stringify({ message: "admitted" }),
                      },
                    },
                  ],
                },
                "tool_calls",
              );
            else sendMessagesSse(response, { content: JSON.stringify(final) }, "stop");
          });
        }),
      );
      const runtime = await listen(
        createAgentArtsServer({
          environment: {
            DEEPSEEK_API_KEY: fakeKey,
            DEEPSEEK_BASE_URL: provider,
            DEEPSEEK_WEB_SEARCH_BASE_URL: provider,
            AGENTARTS_MODEL_EVIDENCE: "deterministic-fixture",
            AGENTARTS_EGRESS_ALLOWED_ORIGINS: JSON.stringify([namedOrigin]),
            AGENTARTS_EGRESS_ALLOW_PRIVATE: "true",
            PATH: process.env.PATH,
          },
          runRuntimeTask: runRuntimeFixture,
        }),
      );
      const response = await fetch(`${runtime}/invocations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(packet(mode, false, extensions)),
      });
      const result: unknown = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      const reply = runtimeTaskReplySchema.parse(result);
      expect(calls).toBe(1);
      expect(JSON.stringify(messageToolResults(requests[1] ?? {}))).toContain(
        "PUBLIC_MCP:admitted",
      );
      expect(reply.delta).toBeNull();
      expect(reply.sandboxEvidence.networkIsolated).toBe(true);
      if (mode === "controlled")
        expect(reply.toolReceipts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "mcp.public.echo", ok: true, completed: true }),
          ]),
        );
      else expect(reply.observedTools).toContain("mcp__public__echo");
    },
    90_000,
  );
});
