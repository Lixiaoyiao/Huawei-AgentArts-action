import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DshConfigurationError } from "../dsh/errors.js";

/** Only for supervisor-created private entries before worker launch/after worker shutdown. */
export async function privateEntryPermissions(
  path: string,
  mode: number,
  uid: 0 | 10001,
  gid: 0 | 10001,
): Promise<void> {
  if (!isAbsolute(path) || !Number.isInteger(mode) || mode < 0 || mode > 0o777)
    throw new DshConfigurationError("Private entry permissions are invalid");
  // Descriptor operations avoid following a replacement final symlink; nonblocking avoids FIFOs.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() && !entry.isDirectory())
      throw new DshConfigurationError("Private permissions require a regular file or directory");
    // CHOWN is already admitted. Reclaim ownership instead of adding FOWNER to the supervisor.
    await handle.chown(0, 0);
    await handle.chmod(mode);
    await handle.chown(uid, gid);
  } finally {
    await handle.close();
  }
}
