import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { supervisorEnvironment } from "../src/agentarts/supervisor-secrets.js";

const temporaryRoots: string[] = [];
const fixtureKey = "supervisor-only-test-credential";
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
describe("trusted supervisor credential loading", () => {
  it("copies a configured key without mutating the caller environment", async () => {
    const environment = { DEEPSEEK_API_KEY: fixtureKey, PORT: "8080" };
    const result = await supervisorEnvironment(environment);
    expect(result).toEqual(environment);
    expect(result).not.toBe(environment);
  });
  it.each([
    undefined,
    "short",
    "a".repeat(4097),
    "secret with space",
    "secret\nnewline",
    "secret\0null",
  ])("rejects malformed environment credentials without disclosing them", async (key) => {
    await expect(supervisorEnvironment({ DEEPSEEK_API_KEY: key })).rejects.toThrow(
      "value was not logged",
    );
  });
  it("refuses ambiguous key sources before reading a file", async () => {
    await expect(
      supervisorEnvironment({
        DEEPSEEK_API_KEY: fixtureKey,
        DEEPSEEK_API_KEY_FILE: "/run/secrets/key",
      }),
    ).rejects.toThrow("one absolute root-only");
  });
  it("refuses relative key-file paths", async () => {
    await expect(supervisorEnvironment({ DEEPSEEK_API_KEY_FILE: "key" })).rejects.toThrow(
      "one absolute root-only",
    );
  });
});

describe.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
  "Linux root-only mounted key files",
  () => {
    async function keyFile(content = fixtureKey): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), "agentarts-key-test-"));
      temporaryRoots.push(root);
      const path = join(root, "key");
      await writeFile(path, content, { mode: 0o600 });
      return path;
    }
    it("loads one bounded UTF-8 token with an optional final LF", async () => {
      const path = await keyFile(`${fixtureKey}\n`);
      const result = await supervisorEnvironment({ DEEPSEEK_API_KEY_FILE: path });
      expect(result.DEEPSEEK_API_KEY).toBe(fixtureKey);
      expect(result.DEEPSEEK_API_KEY_FILE).toBeUndefined();
    });
    it("rejects a group-readable mount", async () => {
      const path = await keyFile();
      await chmod(path, 0o640);
      await expect(supervisorEnvironment({ DEEPSEEK_API_KEY_FILE: path })).rejects.toThrow(
        "mode 0600",
      );
    });
    it("rejects symbolic and hard links", async () => {
      const path = await keyFile();
      const alias = `${path}.link`;
      await symlink(path, alias);
      await expect(supervisorEnvironment({ DEEPSEEK_API_KEY_FILE: alias })).rejects.toThrow();
      await link(path, `${path}.hard`);
      await expect(supervisorEnvironment({ DEEPSEEK_API_KEY_FILE: path })).rejects.toThrow(
        "single root-owned",
      );
    });
    it("rejects files that exceed the bound or contain multiple lines", async () => {
      const path = await keyFile("a".repeat(4098));
      await expect(supervisorEnvironment({ DEEPSEEK_API_KEY_FILE: path })).rejects.toThrow(
        "at most 4097",
      );
      await writeFile(path, `${fixtureKey}\n${fixtureKey}`);
      await expect(supervisorEnvironment({ DEEPSEEK_API_KEY_FILE: path })).rejects.toThrow(
        "value was not logged",
      );
    });
  },
);
