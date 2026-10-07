import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("confined namespace AppArmor policy", () => {
  it("reproduces the pinned source and preserves every unrelated Docker denial", async () => {
    const generated = spawnSync(process.execPath, ["scripts/generate-agentarts-apparmor.mjs"], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(generated.status, generated.stderr).toBe(0);
    const [source, profile] = await Promise.all([
      readFile("agentarts/apparmor-template.moby.txt", "utf8"),
      readFile("agentarts/apparmor-runtime.profile", "utf8"),
    ]);
    for (const denial of source.split("\n").filter((line) => line.trim().startsWith("deny "))) {
      if (denial.trim() !== "deny mount,") expect(profile).toContain(denial);
    }
    expect(profile).toContain("userns create,");
    expect(profile).toContain("pivot_root oldroot=/tmp/oldroot/ /tmp/,");
    expect(profile).toContain("pivot_root oldroot=/newroot/ /newroot/,");
    expect(profile).toContain(
      "ptrace (trace,read,tracedby,readby) peer=agentarts-runtime-bwrap-v1,",
    );
    expect(profile).not.toContain("flags=(unconfined)");
    expect(profile).not.toContain("deny mount,");
  });
});
