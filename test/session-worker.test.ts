import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDshRuntime, disposeDshRuntime, type DshRuntime } from "../src/dsh/runtime.js";
import { collectWorkerSession, prepareWorkerSession } from "../src/session/worker.js";

const active: DshRuntime[] = [];
const id = "session-12345678-1234-1234-1234-123456789abc";
const digest = "a".repeat(64);
async function runtime() {
  const result = await createDshRuntime();
  active.push(result);
  result.session = {
    bindingDigest: digest,
    knownSecrets: new Set(["controller-secret-never-serialized"]),
  };
  return result;
}
afterEach(async () => {
  await Promise.all(active.splice(0).map(disposeDshRuntime));
});
function audit(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    bindingDigest: digest,
    sessionId: id,
    source: "startup",
    workingDirectory: "/workspace",
    permissionMode: "read-only",
    approvalPolicy: "never",
    permissionPreset: "read-only",
    beforeSeq: 0,
    afterSeq: 1,
    ...overrides,
  };
}
describe("Controller Session worker admission", () => {
  it("serializes current policy without credentials", async () => {
    const value = await runtime();
    await prepareWorkerSession(value, false);
    const text = await readFile(join(value.dshHome, "action-state", "session-plan.json"), "utf8");
    expect(JSON.parse(text)).toEqual({
      schemaVersion: 1,
      bindingDigest: digest,
      permissionMode: "read-only",
      workingDirectory: "/workspace",
    });
    expect(text).not.toContain("controller-secret");
  });
  it("binds a fresh admission before reusing its official Session ID", async () => {
    const value = await runtime();
    await writeFile(
      join(value.dshHome, "action-state", "session-admission.json"),
      JSON.stringify(audit()),
    );
    await collectWorkerSession(value, false);
    expect(value.session?.sessionId).toBe(id);
    if (value.session === undefined) throw new Error("missing test Session");
    value.session.checkpointEventCount = 15;
    await prepareWorkerSession(value, false);
    const text = await readFile(join(value.dshHome, "action-state", "session-plan.json"), "utf8");
    expect(JSON.parse(text)).toMatchObject({
      sessionId: id,
      checkpointEventCount: 15,
      permissionMode: "read-only",
    });
  });
  it.each([
    { bindingDigest: "b".repeat(64) },
    { permissionMode: "workspace-write" },
    { permissionPreset: "workspace-write" },
    { approvalPolicy: "on-request" },
    { source: "resume" },
    { workingDirectory: "/tmp/unbound" },
    { beforeSeq: 2, afterSeq: 1 },
    { oldAuthority: "admin" },
  ])("rejects foreign, stale or broadened admission %j", async (changes) => {
    const value = await runtime();
    await writeFile(
      join(value.dshHome, "action-state", "session-admission.json"),
      JSON.stringify(audit(changes)),
    );
    await expect(collectWorkerSession(value, false)).rejects.toThrow();
    expect(value.session?.sessionId).toBeUndefined();
  });
});
