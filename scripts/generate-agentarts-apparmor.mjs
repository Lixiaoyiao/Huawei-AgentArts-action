// Offline derivation of the pinned Moby default; retain every unrelated denial.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = await readFile(resolve(root, "agentarts/apparmor-template.moby.txt"), "utf8");
if (
  createHash("sha256").update(source).digest("hex") !==
  "42130ca5908f45263facef820961d9e1a988e82f8a2937f4658e7bcccc96cc07"
)
  throw new Error("Pinned Moby AppArmor template changed");
const body = source.split("`")[1];
if (body === undefined) throw new Error("Moby template is missing");
const generated =
  "# Derived from Moby 6430e49a55babd9b8f4d08e70ecb2b68900770fe (Apache-2.0).\n" +
  "# Modified: independent name, userns creation, sandbox mounts and fixed bwrap pivots.\n" +
  "# Outer five capabilities, no-new-privileges, seccomp and worker BPF remain required.\n" +
  "abi <abi/4.0>,\n" +
  body
    .replace("{{range $value := .Imports}}\n{{$value}}\n{{end}}", "#include <tunables/global>")
    .replace(
      "{{range $value := .InnerImports}}\n  {{$value}}\n{{end}}",
      "  #include <abstractions/base>",
    )
    .replaceAll("{{.Name}}", "agentarts-runtime-bwrap-v1")
    .replaceAll("{{.DaemonProfile}}", "unconfined")
    .replace(
      "  deny mount,",
      "  # bwrap 0.8 setup inside its new user/mount namespace; worker caps are dropped.\n" +
        "  userns create,\n" +
        "  mount,\n" +
        "  pivot_root oldroot=/tmp/oldroot/ /tmp/,\n" +
        "  pivot_root oldroot=/newroot/ /newroot/,",
    );
if (generated.includes("{{")) throw new Error("Unresolved AppArmor template substitution");
const path = resolve(root, "agentarts/apparmor-runtime.profile");
if (process.argv.includes("--write")) await writeFile(path, generated);
else if ((await readFile(path, "utf8")) !== generated)
  throw new Error("Generated AppArmor profile is stale");
