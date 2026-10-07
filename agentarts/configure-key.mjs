#!/usr/bin/env node
/** Supervisor-only secret intake. Values never appear in argv, stdout or repository files. */
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
if (process.platform !== "linux" || process.getuid?.() !== 0 || process.argv.length !== 2)
  throw new Error(
    "Run as Linux root with no arguments; supply the key through hidden terminal input or stdin",
  );
if (process.stdin.isTTY) {
  process.stderr.write("DeepSeek key (hidden): ");
  process.stdin.setRawMode(true);
}
process.stdin.setEncoding("utf8");
let value = "";
let path;
try {
  for await (const chunk of process.stdin) {
    for (const char of chunk) {
      if (char === "\u0003") throw new Error("Secret configuration cancelled");
      if (char === "\r" || char === "\n") break;
      if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
      else value += char;
    }
    if (Buffer.byteLength(value) > 4096) throw new Error("Secret input exceeded its limit");
    if (chunk.includes("\n") || chunk.includes("\r")) break;
  }
  if (value.length < 8 || /[\s\0]/u.test(value))
    throw new Error("Invalid secret input; its value was not logged");
  path = await mkdtemp(join(tmpdir(), "agentarts-model-key."));
  await chmod(path, 0o700);
  const file = join(path, "deepseek_key");
  await writeFile(file, value + "\n", { mode: 0o600, flag: "wx" });
  process.stdout.write(file + "\n");
} catch (error) {
  if (path !== undefined) await rm(path, { recursive: true, force: true });
  process.stderr.write(
    error instanceof Error ? error.message + "\n" : "Secret configuration failed\n",
  );
  process.exitCode = 1;
} finally {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stderr.write("\n");
  }
  process.stdin.destroy();
}
