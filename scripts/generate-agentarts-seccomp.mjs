import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
// Classic BPF: verify architecture, reject nested namespaces, preserve ordinary Node threads.
// Seccomp data: nr offset0, arch offset4, args[0] offset16, native little endian on supported platforms.
const root = resolve(import.meta.dirname, "..");
for (const [arch, audit, clone, unshare, setns] of [
  ["x64", 0xc000003e, 56, 272, 308],
  ["arm64", 0xc00000b7, 220, 97, 268],
]) {
  const program = [
    [0x20, 0, 0, 4],
    [0x15, 1, 0, audit],
    [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0],
    [0x15, 5, 0, unshare],
    [0x15, 4, 0, setns],
    [0x15, 5, 0, 435],
    [0x15, 0, 3, clone],
    [0x20, 0, 0, 16],
    [0x45, 0, 1, 0x7e020000],
    [0x06, 0, 0, 0x00050001],
    [0x06, 0, 0, 0x7fff0000],
    [0x06, 0, 0, 0x00050026], // ENOSYS makes glibc use the filtered ordinary clone fallback.
  ];
  const bytes = Buffer.alloc(program.length * 8);
  program.forEach(([code, jt, jf, value], index) => {
    bytes.writeUInt16LE(code, index * 8);
    bytes[index * 8 + 2] = jt;
    bytes[index * 8 + 3] = jf;
    bytes.writeUInt32LE(value, index * 8 + 4);
  });
  const path = resolve(root, `assets/agentarts/worker-seccomp-${arch}.bpf`);
  if (process.argv.includes("--write")) await writeFile(path, bytes);
  else if (!(await readFile(path)).equals(bytes)) throw new Error(`Worker seccomp drift: ${arch}`);
}
