import { StringDecoder } from "node:string_decoder";
import { redactKnownSecrets } from "../security/env.js";
import { redactSecrets } from "../security/redaction.js";

/** Actions consumes add-mask commands; an ordinary CLI does not. Keep them private. */
export async function withPrivateControllerLogs<T>(
  secrets: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const restore: (() => void)[] = [];
  for (const stream of [process.stdout, process.stderr]) {
    // Retain the exact method for restoration; every invocation below supplies its original stream.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = stream.write;
    const decoder = new StringDecoder("utf8");
    let pending = "",
      dropped = false;
    const safeLine = (line: string) => {
      if (line.startsWith("::add-mask::")) return;
      original.call(stream, `${redactSecrets(redactKnownSecrets(line, secrets))}\n`);
    };
    // The original Controller emits line-oriented core messages. Buffer across
    // writes so a secret split between chunks cannot escape. Oversized lines
    // are discarded completely, never emitted as unredacted prefixes.
    const write = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const text = typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
      for (const [index, part] of text.split("\n").entries()) {
        if (index > 0) {
          if (dropped) safeLine("[Controller log line exceeded 64 KiB and was omitted]");
          else safeLine(pending);
          pending = "";
          dropped = false;
        }
        if (!dropped) {
          pending += part;
          if (pending.length > 64 * 1024) {
            pending = "";
            dropped = true;
          }
        }
      }
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (done) queueMicrotask(() => done());
      return true;
    };
    stream.write = write;
    restore.push(() => {
      stream.write = original;
      pending += decoder.end();
      if (dropped) safeLine("[Controller log line exceeded 64 KiB and was omitted]");
      else if (pending) safeLine(pending);
    });
  }
  try {
    return await run();
  } finally {
    for (const undo of restore.reverse()) undo();
  }
}
