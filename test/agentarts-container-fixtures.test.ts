import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { runtimeTaskSchema, runtimeTaskDigest } from "../src/agentarts/runtime-task-protocol.js";
const require = createRequire(import.meta.url);
const fixture = require("./fixtures/full-runtime-packets.mjs") as {
  fullPacket: (
    id: string,
    operation: string,
    options: { write: boolean; native: boolean },
  ) => unknown;
  canonicalFullJson: (value: unknown) => string;
  fullHash: (value: string) => string;
};
describe("standalone final-image fixture conforms to the source v3 contract", () => {
  it.each(["review", "task", "diagnose", "fix", "implement"])(
    "validates %s task and independent canonical digest",
    (operation) => {
      const raw = fixture.fullPacket(operation, operation, {
        write: operation === "fix" || operation === "implement",
        native: false,
      });
      const task = runtimeTaskSchema.parse(raw);
      expect(runtimeTaskDigest(task)).toBe(fixture.fullHash(fixture.canonicalFullJson(raw)));
    },
  );
  it("preserves native write identity and exact workspace digest", () => {
    expect(() =>
      runtimeTaskSchema.parse(
        fixture.fullPacket("native-write", "task", { write: true, native: true }),
      ),
    ).not.toThrow();
  });
});
