import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { DshConfigurationError } from "../dsh/errors.js";

function checkedKey(value: string): string {
  if (value.length < 8 || Buffer.byteLength(value) > 4096 || /[\s\0]/u.test(value))
    throw new DshConfigurationError(
      "Invalid supervisor model credential; its value was not logged",
    );
  return value;
}

/** Root-only secret mount avoids storing a local provider key in Docker's environment metadata. */
export async function supervisorEnvironment(
  environment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const path = environment.DEEPSEEK_API_KEY_FILE;
  if (path === undefined) {
    return { ...environment, DEEPSEEK_API_KEY: checkedKey(environment.DEEPSEEK_API_KEY ?? "") };
  }
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 0 ||
    !isAbsolute(path) ||
    environment.DEEPSEEK_API_KEY !== undefined
  )
    throw new DshConfigurationError(
      "Use one absolute root-only model key file on the Linux supervisor",
    );
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 4097
    )
      throw new DshConfigurationError(
        "Model key file must be a single root-owned regular file with mode 0600 and at most 4097 bytes",
      );
    const bytes = await handle.readFile();
    if (bytes.length > 4097) throw new DshConfigurationError("Model key file exceeds its limit");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const key = checkedKey(text.endsWith("\n") ? text.slice(0, -1) : text);
    const result: NodeJS.ProcessEnv = { ...environment, DEEPSEEK_API_KEY: key };
    delete result.DEEPSEEK_API_KEY_FILE;
    return result;
  } finally {
    await handle.close();
  }
}
