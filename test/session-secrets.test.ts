import { describe, expect, it } from "vitest";

import {
  configuredExtensionSecrets,
  configuredHttpSecrets,
  configuredSessionExtensionSecrets,
} from "../src/extensions/credentials.js";
import {
  parseNativeMcpConfiguration,
  parseNativePluginConfiguration,
} from "../src/extensions/schema.js";
import { collectControllerSecrets } from "../src/security/env.js";
import { validateSessionPayload } from "../src/session/checkpoint.js";

const emptyMcp = parseNativeMcpConfiguration('{"schemaVersion":1}');
const emptyPlugins = parseNativePluginConfiguration('{"schemaVersion":1}');

function plugins(config: unknown, credentialConfig: unknown = {}) {
  return parseNativePluginConfiguration(
    JSON.stringify({
      schemaVersion: 1,
      plugins: [
        { id: "fixture", package: "fixture-plugin", source: "1.0.0", config, credentialConfig },
      ],
    }),
  );
}

function mcp(server: Record<string, unknown>) {
  return parseNativeMcpConfiguration(
    JSON.stringify({ schemaVersion: 1, servers: [{ id: "fixture", ...server }] }),
  );
}

function raw(value: string): Buffer {
  return Buffer.from(
    [
      {
        type: "session",
        version: 4,
        id: "session-1",
        createdAt: 1,
        cwd: "/workspace",
        isSeeded: false,
        delegationDepth: 0,
      },
      { type: "fixture/optional", seq: 0, time: 1, data: { arbitrary: value }, ignorable: true },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
}

describe("Session exact credential refusal list", () => {
  it("collects a short actual plugin credential using the existing sensitive-field parser", () => {
    const configuration = plugins({ connection: { apiKey: "abc" }, ordinary: "hello" });
    expect(configuredExtensionSecrets(emptyMcp, configuration)).not.toContain("abc");
    expect(configuredSessionExtensionSecrets(emptyMcp, configuration)).toContain("abc");
    expect(configuredSessionExtensionSecrets(emptyMcp, configuration)).not.toContain("hello");
    expect(() =>
      validateSessionPayload({
        payload: raw("abc"),
        sessionId: "session-1",
        workspacePath: "/workspace",
        knownSecrets: configuredSessionExtensionSecrets(emptyMcp, configuration),
      }),
    ).toThrow(/credential material/u);
  });

  it("keeps explicit plugin credentials independent from the ordinary field name", () => {
    const configuration = plugins({ title: "ordinary" }, { license: "abcd" });
    expect(configuredSessionExtensionSecrets(emptyMcp, configuration)).toContain("abcd");
    expect(configuredSessionExtensionSecrets(emptyMcp, configuration)).not.toContain("ordinary");
  });

  it("collects short sensitive stdio env and argv while ignoring ordinary values", () => {
    const configuration = mcp({
      transport: "stdio",
      command: "fixture-mcp-server",
      args: ["worker.mjs", "--api-key=abc", "--password", "xy"],
      env: { AUTH_TOKEN: "z", ORDINARY_MODE: "hello" },
    });
    const known = configuredSessionExtensionSecrets(configuration, emptyPlugins);
    expect(known).toEqual(expect.arrayContaining(["abc", "xy", "z"]));
    expect(known).not.toContain("hello");
    expect(known).not.toContain("worker.mjs");
    expect(configuredExtensionSecrets(configuration, emptyPlugins)).toEqual([]);
  });

  it("retains non-sensitive explicit MCP credential env and headers", () => {
    const stdio = mcp({
      transport: "stdio",
      command: "fixture-mcp-server",
      credentialEnv: { LICENSE: "abcd" },
    });
    const http = mcp({
      transport: "streamable-http",
      url: "https://example.test/mcp",
      credentialHeaders: { "X-License": "efgh" },
    });
    expect(configuredSessionExtensionSecrets(stdio, emptyPlugins)).toContain("abcd");
    expect(configuredSessionExtensionSecrets(http, emptyPlugins)).toContain("efgh");
  });

  it("collects actual short authorization values while retaining the previous masking default", () => {
    const configuration = mcp({
      transport: "streamable-http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer abc", "X-Mode": "plain" },
    });
    const legacy = configuredExtensionSecrets(configuration, emptyPlugins);
    const current = configuredSessionExtensionSecrets(configuration, emptyPlugins);
    expect(legacy).toContain("Bearer abc");
    expect(legacy).not.toContain("abc");
    expect(current).toEqual(expect.arrayContaining(["Bearer abc", "abc"]));
    expect(current).not.toContain("Bearer");
    expect(current).not.toContain("plain");
  });

  it("does not classify short ordinary URL paths or query data as credentials", () => {
    const configuration = mcp({
      transport: "streamable-http",
      url: "https://example.test/v1/mcp?mode=fast&api_key=abc",
    });
    const known = configuredSessionExtensionSecrets(configuration, emptyPlugins);
    expect(known).toContain("abc");
    expect(known).not.toContain("v1");
    expect(known).not.toContain("mcp");
    expect(known).not.toContain("fast");
  });

  it("uses the same URL decoder for short explicit credential channels", () => {
    // Public configuration rejects embedded userinfo, but the shared extractor
    // still understands it without treating ordinary paths as short secrets.
    expect(configuredHttpSecrets("https://u:p%61@example.test/mcp?token=%62", {}, 1)).toEqual(
      expect.arrayContaining(["u", "pa", "b"]),
    );
    expect(configuredHttpSecrets("https://u:p%61@example.test/mcp?token=%62", {})).not.toContain(
      "pa",
    );
    const configuration = plugins({ password: "%61%62%63" });
    expect(configuredSessionExtensionSecrets(emptyMcp, configuration)).toEqual(
      expect.arrayContaining(["%61%62%63", "abc"]),
    );
  });

  it("includes nonempty Controller environment credentials of any length only when explicitly requested", () => {
    const environment = {
      GITHUB_TOKEN: "abc",
      GH_TOKEN: "x",
      ACTIONS_RUNTIME_TOKEN: "rt",
      DEEPSEEK_API_KEY: "sk",
      ORDINARY: "hello",
      GITHUB_REF: "main",
    };
    expect(collectControllerSecrets(environment)).toEqual([]);
    const known = collectControllerSecrets(environment, 1);
    expect(known).toEqual(["abc", "x", "rt", "sk"]);
    expect(() =>
      validateSessionPayload({
        payload: raw("abc"),
        sessionId: "session-1",
        workspacePath: "/workspace",
        knownSecrets: known,
      }),
    ).toThrow(/credential material/u);
  });

  it("does not include empty credentials", () => {
    expect(collectControllerSecrets({ GITHUB_TOKEN: "" }, 1)).toEqual([]);
    expect(configuredSessionExtensionSecrets(emptyMcp, plugins({ apiKey: "" }))).toEqual([]);
  });
});
