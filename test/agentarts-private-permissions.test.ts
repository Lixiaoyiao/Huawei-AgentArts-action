import { mkdtemp, writeFile, symlink, stat, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { privateEntryPermissions } from "../src/agentarts/private-permissions.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const directory = async () => {
  const root = await mkdtemp(join(tmpdir(), "agentarts-ownership-test-"));
  roots.push(root);
  return root;
};
describe.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
  "private ownership handoff without FOWNER",
  () => {
    it("reclaims a worker-owned file and directory before chmod and final handoff", async () => {
      const root = await directory(),
        file = join(root, "session-plan.json");
      await writeFile(file, "{}", { mode: 0o600 });
      for (const path of [file, root]) {
        await privateEntryPermissions(path, 0o750, 10001, 10001);
        await privateEntryPermissions(path, 0o440, 0, 10001);
        const sealed = await stat(path);
        expect(sealed.uid).toBe(0);
        expect(sealed.gid).toBe(10001);
        expect(sealed.mode & 0o777).toBe(0o440);
        await privateEntryPermissions(path, 0o750, 10001, 10001);
        expect((await stat(path)).uid).toBe(10001);
      }
    });
    it("rejects a symlink without changing its target", async () => {
      const root = await directory(),
        target = join(root, "target"),
        link = join(root, "link");
      await writeFile(target, "unchanged", { mode: 0o600 });
      await symlink(target, link);
      await expect(privateEntryPermissions(link, 0o777, 10001, 10001)).rejects.toMatchObject({
        code: "ELOOP",
      });
      expect((await stat(target)).uid).toBe(0);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    });
    it("rejects a FIFO without blocking and rejects non-private argument shapes", async () => {
      const root = await directory(),
        fifo = join(root, "fifo");
      execFileSync("/usr/bin/mkfifo", [fifo]);
      await expect(privateEntryPermissions(fifo, 0o640, 10001, 10001)).rejects.toThrow("regular");
      await expect(privateEntryPermissions("relative", 0o640, 10001, 10001)).rejects.toThrow(
        "invalid",
      );
      await expect(privateEntryPermissions(fifo, 0o4755, 10001, 10001)).rejects.toThrow("invalid");
    });
  },
);
