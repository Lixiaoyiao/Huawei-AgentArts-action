import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installedTopLevelPackageInventory,
  assertExtensionPackagesDoNotShadowRuntime,
  assertInstalledRuntimeInventoryUnchanged,
} from "../src/dsh/install.js";
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function packages(entries: readonly { slot: string; name: string; version: string }[]) {
  const root = await mkdtemp(join(tmpdir(), "dsh-alias-inventory-"));
  temporary.push(root);
  for (const entry of entries) {
    const directory = join(root, "node_modules", entry.slot);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: entry.name, version: entry.version }),
    );
  }
  return root;
}
describe("locked runtime inventories preserve valid npm alias slots", () => {
  it("keeps normal and aliased versions of the same package without false duplicates", async () => {
    const root = await packages([
      { slot: "string-width", name: "string-width", version: "5.1.2" },
      { slot: "string-width-cjs", name: "string-width", version: "4.2.3" },
      { slot: "@scope/alias", name: "@other/real", version: "1.0.0" },
    ]);
    expect(await installedTopLevelPackageInventory(root)).toEqual({
      "string-width": "5.1.2",
      "string-width-cjs": "npm:string-width@4.2.3",
      "@scope/alias": "npm:@other/real@1.0.0",
    });
  });
  it("protects both the installation slot and the original alias identity from shadowing", () => {
    const inventory = {
      "legacy-width": "npm:string-width@4.2.3",
      "@scope/alias": "npm:@other/real@1.0.0",
    };
    for (const name of ["legacy-width", "string-width", "@scope/alias", "@other/real"])
      expect(() =>
        assertExtensionPackagesDoNotShadowRuntime(
          { packageDependencies: { [name]: "1.0.0" } },
          inventory,
        ),
      ).toThrow("shadow");
    expect(() =>
      assertExtensionPackagesDoNotShadowRuntime(
        { packageDependencies: { unrelated: "1.0.0" } },
        inventory,
      ),
    ).not.toThrow();
  });
  it("rejects replaced alias identities, versions, slots or removals after installation", () => {
    const before = { "legacy-width": "npm:string-width@4.2.3" };
    for (const after of [
      { "legacy-width": "npm:other@4.2.3" },
      { "legacy-width": "npm:string-width@5.0.0" },
      { renamed: "npm:string-width@4.2.3" },
      {},
    ])
      expect(() => assertInstalledRuntimeInventoryUnchanged(before, after)).toThrow(
        "changed runtime",
      );
    expect(() =>
      assertInstalledRuntimeInventoryUnchanged(before, { ...before, extension: "1.0.0" }),
    ).not.toThrow();
  });
});
