import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentArtsServer, type AgentArtsServer } from "../src/agentarts/server.js";
let server: AgentArtsServer | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server !== undefined) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});
describe("local Runtime authentication before task admission", () => {
  it("requires the local capability before reading or admitting any task; health remains non-secret", async () => {
    const key = "fixture-independent-local-capability";
    const runRuntimeTask = vi.fn(() => Promise.reject(new Error("must not start")));
    server = createAgentArtsServer({
      environment: { AGENTARTS_LOCAL_API_KEY: key },
      runRuntimeTask,
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture address");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    expect((await fetch(`${origin}/ping`)).status).toBe(200);
    for (const authorization of [undefined, "Bearer wrong", `Basic ${key}`]) {
      const response = await fetch(`${origin}/invocations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: "not-json",
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(key);
    }
    expect(
      (
        await fetch(`${origin}/invocations`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: "not-json",
        })
      ).status,
    ).toBe(400);
    expect(runRuntimeTask).not.toHaveBeenCalled();
  });
  it("refuses invalid local authentication configuration at startup", () => {
    for (const key of ["", "short", "contains whitespace and fails"])
      expect(() =>
        createAgentArtsServer({ environment: { AGENTARTS_LOCAL_API_KEY: key } }),
      ).toThrow("local Runtime authentication");
  });
});
