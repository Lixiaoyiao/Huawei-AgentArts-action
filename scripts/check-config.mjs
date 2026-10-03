import { lstat, open } from "node:fs/promises";
import { registerHooks } from "node:module";
import { resolve } from "node:path";

// Match the contract generator: run only this checkout's trusted source on Node 24.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      context.parentURL?.includes("/src/") === true
    ) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const usage =
  "Usage: npm run check:config -- --config <maintainer-owned.json>\nOffline static check; no model, repository commands, Docker probe, or GitHub calls.";
const argumentsList = process.argv.slice(2);
if (argumentsList.length === 1 && ["--help", "-h"].includes(argumentsList[0])) {
  process.stdout.write(`${usage}\n`);
} else {
  try {
    if (argumentsList.length !== 2 || argumentsList[0] !== "--config") {
      throw new Error(usage);
    }
    const path = resolve(argumentsList[1]);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error("Configuration must be a regular JSON file, not a directory or symlink.");
    }
    const maximumBytes = 256 * 1024;
    if (details.size > maximumBytes) throw new Error("Configuration file exceeds 256 KiB.");
    const handle = await open(path, "r");
    let configuration;
    try {
      // Bound a concurrent writer as well as the original stat result.
      const buffer = Buffer.alloc(maximumBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maximumBytes) throw new Error("Configuration file exceeds 256 KiB.");
      try {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, bytesRead),
        );
        configuration = JSON.parse(source);
      } catch {
        throw new Error(
          "Configuration file must contain valid UTF-8 JSON; values are not echoed in diagnostics.",
        );
      }
    } finally {
      await handle.close();
    }
    const { checkConfiguration } = await import("../src/configuration-check.ts");
    const result = checkConfiguration(configuration);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    // Filesystem errors can contain paths but must never dump configuration/env values.
    const message =
      error instanceof Error && "code" in error
        ? "Configuration file could not be read; confirm the selected regular JSON file exists and is readable."
        : error instanceof Error
          ? error.message
          : "Configuration check failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
