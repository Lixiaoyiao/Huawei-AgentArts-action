import { describe, expect, it, vi } from "vitest";
import { digest, workspaceDigest } from "../src/agentarts/protocol.js";

describe("AgentArts workspace transport across locales", () => {
  it("produces the same commit-bound bundle digest on English and Chinese hosts", () => {
    const files = ["src/z.ts", "src/啊.ts", "src/中.ts", "src/a.ts"].map((path) => ({
      path,
      content: path,
      sha256: digest(path),
    }));
    const canonical = [files[3], files[0], files[2], files[1]];
    const results = ["en-US", "zh-CN"].map((locale) => {
      const collator = new Intl.Collator(locale);
      const spy = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
        this: string,
        other: string,
      ) {
        return collator.compare(this, other);
      });
      try {
        return workspaceDigest(files);
      } finally {
        spy.mockRestore();
      }
    });
    expect(results[0]).toBe(results[1]);
    expect(results[0]).toBe(digest(JSON.stringify(canonical)));
  });
});
