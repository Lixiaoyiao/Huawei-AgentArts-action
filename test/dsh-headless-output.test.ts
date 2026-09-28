import { describe, expect, it } from "vitest";

import { headlessResultText } from "../src/dsh/headless-output.js";
import { parseDshOutput } from "../src/dsh/schema.js";

const session = { type: "session", sessionId: "session-fixture", cwd: "/workspace" };
const result = {
  protocolVersion: 1,
  operation: "task",
  state: "final",
  summary: "Done",
  findings: [],
};
const terminal = { type: "final", text: JSON.stringify(result) };
const stream = (...events: unknown[]): string =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n";

describe("DSH headless transport", () => {
  it("rejects escaped credentials in discarded telemetry before lower-priority schema errors", () => {
    for (const event of [
      { type: "thinking", text: "controller-private-key" },
      {
        type: "tool_call",
        callId: "call",
        tool: "fixture",
        input: { secret: "controller-private-key" },
      },
      { type: "unknown", data: "controller-private-key" },
    ]) {
      const raw = stream(session, event, terminal).replace("controller", "\\u0063ontroller");
      expect(() => headlessResultText(raw, ["controller-private-key"])).toThrow(
        expect.objectContaining({ code: "DSH_CREDENTIAL_LEAK" }),
      );
    }
  });
  it("extracts only the lossless final, preserving strict business validation", () => {
    const raw = stream(
      session,
      { type: "status", phase: "turn_start", turn: 0 },
      { type: "thinking", text: "untrusted reasoning" },
      { type: "tool_call", callId: "call-1", tool: "not-controller-authority", input: {} },
      { type: "tool_result", callId: "call-1", status: "completed", result: "untrusted output" },
      { type: "text", text: "truncated answer", truncated: true },
      { type: "status", phase: "turn_end", turn: 0, reason: { kind: "completed" } },
      terminal,
    );
    expect(parseDshOutput(headlessResultText(raw), "task")).toEqual(result);
  });

  it("accepts the official bounded telemetry fallback but never a truncated final", () => {
    expect(
      headlessResultText(stream(session, { type: "tool_call", truncated: true }, terminal)),
    ).toBe(terminal.text);
    expect(() => headlessResultText(stream(session, { ...terminal, truncated: true }))).toThrow();
  });

  it.each([
    [{ type: "unknown" }],
    [{ type: 1 }],
    [terminal],
    [session],
    [session, session, terminal],
    [session, terminal, terminal],
    [session, terminal, { type: "text", text: "after final" }],
    [session, { type: "error", message: "provider failed" }, terminal],
    [session, { type: "unknown" }, terminal],
    [session, { type: "final", text: {}, toolRequest: {} }],
  ])("rejects incomplete, erroneous or ambiguous event streams: %j", (...events) => {
    expect(() => headlessResultText(stream(...events))).toThrow();
  });

  it("rejects mixed prose and events instead of searching for a JSON substring", () => {
    expect(() => headlessResultText(`prefix\n${stream(session, terminal)}`)).toThrow();
    expect(() =>
      headlessResultText(`${stream(session)}broken JSON\n${stream(terminal)}`),
    ).toThrow();
  });

  it("does not grant business authority to a valid final envelope", () => {
    for (const invalid of [
      "Done",
      JSON.stringify({ ...result, operation: "fix" }),
      JSON.stringify({ ...result, unknown: true }),
      JSON.stringify({ ...result, toolRequest: { id: "github.comment" } }),
    ]) {
      const raw = stream(session, { type: "final", text: invalid });
      expect(() => parseDshOutput(headlessResultText(raw), "task")).toThrow();
    }
  });

  it("retains the published text mode for host launcher compatibility", () => {
    expect(headlessResultText(JSON.stringify(result, null, 2))).toBe(
      JSON.stringify(result, null, 2),
    );
    expect(headlessResultText("malformed terminal text")).toBe("malformed terminal text");
  });
});
