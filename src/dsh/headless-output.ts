import { z } from "zod";

import { DshMalformedOutputError } from "./errors.js";
import { assertNoSecretOutput } from "../security/env.js";

const truncated = { truncated: z.literal(true).optional() };
const count = z.number().int().nonnegative();
const eventSchema = z.union([
  z.strictObject({
    type: z.literal("session"),
    sessionId: z.string().min(1),
    cwd: z.string(),
    ...truncated,
  }),
  z.strictObject({
    type: z.literal("status"),
    phase: z.enum(["turn_start", "step_start", "step_end", "turn_end"]),
    turn: count,
    step: count.optional(),
    reason: z.json().optional(),
    usage: z.json().optional(),
    ...truncated,
  }),
  z.strictObject({ type: z.enum(["thinking", "text"]), text: z.string(), ...truncated }),
  z.strictObject({
    type: z.literal("tool_call"),
    callId: z.string(),
    tool: z.string(),
    input: z.json().optional(),
    ...truncated,
  }),
  z.strictObject({
    type: z.literal("tool_result"),
    callId: z.string(),
    status: z.enum(["error", "completed"]),
    result: z.string(),
    ...truncated,
  }),
  // The official projection may discard every field except type/truncated
  // when its per-event budget is exceeded. This is telemetry, never authority.
  z.strictObject({
    type: z.enum(["session", "status", "thinking", "text", "tool_call", "tool_result"]),
    truncated: z.literal(true),
  }),
  z.strictObject({ type: z.literal("final"), text: z.string() }),
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Decode the published headless transport, independently of the business
 * schema. Retain the official text output contract for custom host launchers.
 * Never interpret projected tool calls/results as Controller requests/receipts.
 * Protocol failures must be caught outside the tool-free business repair path.
 */
export function headlessResultText(stdout: string, secrets: readonly string[] = []): string {
  const lines = stdout.trim().split(/\r?\n/u);
  const parsed: unknown[] = lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
  });
  const projected = parsed.some((entry) => object(entry) && Object.hasOwn(entry, "type"));
  if (!projected) return stdout;

  // Scan decoded telemetry too: escaped credentials in a discarded event are
  // still a worker leak, even when its terminal business result is harmless.
  for (const entry of parsed) {
    if (entry !== undefined) assertNoSecretOutput("stdout", JSON.stringify(entry), secrets);
  }

  let final: string | undefined;
  for (const [index, entry] of parsed.entries()) {
    const event = eventSchema.safeParse(entry);
    if (!event.success) {
      throw new DshMalformedOutputError("DSH headless stream contains an invalid or error event");
    }
    const data = event.data;
    if (index === 0 && data.type !== "session") {
      throw new DshMalformedOutputError("DSH headless stream must begin with one session event");
    }
    if (index > 0 && data.type === "session") {
      throw new DshMalformedOutputError("DSH headless stream contains multiple sessions");
    }
    if (final !== undefined) {
      throw new DshMalformedOutputError("DSH headless stream contains data after its final event");
    }
    if (data.type === "final") final = data.text;
  }
  if (final === undefined) {
    throw new DshMalformedOutputError("DSH headless stream has no final event");
  }
  return final;
}
