#!/usr/bin/env node
/** Offline configuration checks only. Never invokes Runtime, models or GitHub. */
import { execFile } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder, promisify } from "node:util";
import { URL } from "node:url";

const execute = promisify(execFile);
const USAGE =
  "Usage: node agentarts/preflight.mjs --config <absolute JSON path> [--inspect-image <local image>] [--docker-host <local unix/npipe socket>]";
const credentialNames = ["AGENTARTS_RUNTIME_API_KEY", "DEEPSEEK_API_KEY", "GITHUB_TOKEN"];
const readinessFields = [
  "serviceApproved",
  "serviceAuthorized",
  "regionConfirmed",
  "swrMediaTypeVerified",
  "swrUploaded",
  "aliasMappingRecorded",
  "runtimeKeyInController",
  "modelKeyInSupervisor",
  "githubCredentialInController",
  "uidAndCapabilitiesVerified",
  "namespaceAndSeccompVerified",
  "privateProcfsVerified",
  "metadataBoundaryVerified",
  "modelEgressVerified",
  "timeoutAndStopVerified",
  "loggingVerified",
];
const sha = /^[a-f0-9]{40}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const reject = (message) => {
  throw new Error(message);
};
function fields(value, names, label) {
  if (
    !object(value) ||
    Object.keys(value).some((name) => !names.includes(name)) ||
    names.some((name) => !Object.hasOwn(value, name))
  )
    reject(`Invalid ${label} fields; credentials and unknown fields are forbidden.`);
}

/** Same decoded-key/stack approach as upstream session/checkpoint preflightJson. */
function uniqueKeys(text) {
  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\") end += 1;
        end += 1;
      }
      if (end >= text.length) reject("Configuration must be unambiguous UTF-8 JSON.");
      let key;
      try {
        key = JSON.parse(text.slice(index, end + 1));
      } catch {
        reject("Configuration must be unambiguous UTF-8 JSON.");
      }
      const current = stack.at(-1);
      if (current?.expectingKey) {
        if (current.keys.has(key)) reject("Duplicate configuration keys are forbidden.");
        current.keys.add(key);
        current.expectingKey = false;
      }
      index = end;
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? { keys: new Set(), expectingKey: true } : null);
      if (stack.length > 10) reject("Configuration exceeds its depth limit.");
    } else if (char === "}" || char === "]") stack.pop();
    else if (char === "," && stack.at(-1)) stack.at(-1).expectingKey = true;
  }
}

function validate(config) {
  fields(
    config,
    [
      "schemaVersion",
      "sourceCommit",
      "architecture",
      "region",
      "swr",
      "runtime",
      "github",
      "readiness",
    ],
    "configuration",
  );
  if (
    config.schemaVersion !== 1 ||
    !sha.test(config.sourceCommit) ||
    config.sourceCommit === "0".repeat(40)
  )
    reject("Set schemaVersion 1 and a full non-placeholder source commit.");
  if (
    !["arm64", "amd64"].includes(config.architecture) ||
    !/^[a-z][a-z0-9-]{1,31}$/u.test(config.region)
  )
    reject("Invalid architecture or region.");
  fields(config.swr, ["registry", "namespace", "repository", "tag", "digest"], "SWR");
  if (config.swr.registry !== `swr.${config.region}.myhuaweicloud.com`)
    reject("Use the basic SWR registry copied for the configured region.");
  for (const field of ["namespace", "repository"])
    if (
      typeof config.swr[field] !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(config.swr[field])
    )
      reject("Invalid SWR namespace or repository.");
  if (
    typeof config.swr.tag !== "string" ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(config.swr.tag) ||
    ["latest", "main", "master", "dev"].includes(config.swr.tag.toLowerCase())
  )
    reject("Use a dedicated immutable review image tag, never a floating tag.");
  if (!digest.test(config.swr.digest) || config.swr.digest === `sha256:${"0".repeat(64)}`)
    reject("Record the published SWR manifest digest; a local image ID is not a substitute.");
  fields(
    config.runtime,
    [
      "origin",
      "name",
      "endpoint",
      "version",
      "aliasTrafficPercent",
      "authentication",
      "protocol",
      "routeMode",
      "port",
      "storage",
      "requestTimeoutSeconds",
      "idleTimeoutSeconds",
      "maxLifetimeSeconds",
    ],
    "Runtime",
  );
  let origin;
  try {
    origin = new URL(config.runtime.origin);
  } catch {
    reject("Runtime origin must be an HTTPS origin copied from its detail page.");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.hostname.endsWith(".invalid")
  )
    reject("Runtime origin must be an HTTPS origin without credentials, path or query.");
  if (
    !/^[a-z][a-z0-9-]{0,46}[a-z0-9]$/u.test(config.runtime.name) ||
    !/^[A-Za-z][A-Za-z0-9-]{0,46}[A-Za-z0-9]$/u.test(config.runtime.endpoint) ||
    config.runtime.endpoint.toLowerCase() === "latest"
  )
    reject("Runtime requires a valid name and explicit fixed endpoint alias.");
  if (
    typeof config.runtime.version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(config.runtime.version) ||
    config.runtime.version.toLowerCase() === "latest" ||
    config.runtime.aliasTrafficPercent !== 100
  )
    reject("Record one concrete Runtime version and 100% traffic; disable alias gray traffic.");
  if (
    config.runtime.authentication !== "API_KEY" ||
    config.runtime.protocol !== "HTTP" ||
    config.runtime.routeMode !== "ACCURATE_MATCH" ||
    config.runtime.port !== 8080 ||
    config.runtime.storage !== "none"
  )
    reject(
      "This review profile requires API_KEY, HTTP/8080, ACCURATE_MATCH and no mounted session storage.",
    );
  const {
    requestTimeoutSeconds: task,
    idleTimeoutSeconds: idle,
    maxLifetimeSeconds: lifetime,
  } = config.runtime;
  if (
    ![task, idle, lifetime].every(Number.isSafeInteger) ||
    task < 60 ||
    task > 600 ||
    task % 60 !== 0 ||
    idle < 60 ||
    idle > 604800 ||
    lifetime < task + 60 ||
    lifetime > 604800 ||
    idle > lifetime
  )
    reject(
      "Invalid lifecycle values: Controller 1-10 whole minutes; platform lifetime must leave setup/cleanup time.",
    );
  fields(config.github, ["repository", "contentsPermission", "pullRequestsPermission"], "GitHub");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(config.github.repository) ||
    config.github.contentsPermission !== "read" ||
    config.github.pullRequestsPermission !== "write"
  )
    reject("Review requires a repository, contents read and pull-requests write only.");
  fields(config.readiness, readinessFields, "operator readiness");
  if (readinessFields.some((name) => typeof config.readiness[name] !== "boolean"))
    reject("Readiness entries must be operator-recorded booleans, never credentials.");
}

async function inspectImage(image, host, architecture, swrReference) {
  if (
    typeof image !== "string" ||
    image.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/u.test(image)
  )
    reject("Invalid local image reference.");
  if (!/^unix:\/\/\/(?:[^\r\n]+)$/u.test(host) && host !== "npipe:////./pipe/docker_engine")
    reject("Docker inspection permits only an explicit local Unix socket or local Windows pipe.");
  const scratch = await mkdtemp(join(tmpdir(), "agentarts-preflight-"));
  try {
    const env = {};
    for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "PATHEXT", "TEMP", "TMP"])
      if (Object.hasOwn(process.env, name)) env[name] = process.env[name];
    let output;
    try {
      const result = await execute(
        "docker",
        [
          "--config",
          scratch,
          "--host",
          host,
          "image",
          "inspect",
          "--format",
          '{"os":{{json .Os}},"architecture":{{json .Architecture}},"id":{{json .Id}},"user":{{json .Config.User}},"repoDigests":{{json .RepoDigests}}}',
          image,
        ],
        { env, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true },
      );
      output = JSON.parse(result.stdout.trim());
    } catch {
      reject(
        "Local Docker image inspection failed; no registry login, pull or container run was attempted.",
      );
    }
    if (
      output.os !== "linux" ||
      output.architecture !== architecture ||
      !digest.test(output.id) ||
      output.user !== "0:0"
    )
      reject("Local image must match the chosen Linux architecture and explicit 0:0 supervisor.");
    return {
      checked: true,
      imageId: output.id,
      architecture: output.architecture,
      swrDigestPresent:
        Array.isArray(output.repoDigests) && output.repoDigests.includes(swrReference),
    };
  } finally {
    if (
      dirname(resolve(scratch)) !== resolve(tmpdir()) ||
      !basename(scratch).startsWith("agentarts-preflight-")
    )
      reject("Refusing cleanup outside the generated preflight directory.");
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index],
      value = args[index + 1];
    if (
      !["--config", "--inspect-image", "--docker-host"].includes(name) ||
      Object.hasOwn(options, name) ||
      !value ||
      value.startsWith("--")
    )
      reject("Invalid command options.");
    options[name] = value;
  }
  if (!options["--config"] || !isAbsolute(options["--config"]))
    reject("--config requires an explicit absolute path.");
  if (options["--docker-host"] && !options["--inspect-image"])
    reject("--docker-host only applies to local image inspection.");
  let config;
  try {
    const file = await open(options["--config"], "r");
    let bytes;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 32 * 1024)
        reject("Deployment configuration must be a regular file within 32 KiB.");
      const bounded = Buffer.alloc(32 * 1024 + 1);
      let length = 0;
      while (length < bounded.length) {
        const { bytesRead } = await file.read(bounded, length, bounded.length - length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > 32 * 1024) reject("Deployment configuration exceeds 32 KiB.");
      bytes = bounded.subarray(0, length);
    } finally {
      await file.close();
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    uniqueKeys(text);
    config = JSON.parse(text);
  } catch {
    reject(
      "Deployment configuration must be a bounded, unique-key UTF-8 JSON file; input was not printed.",
    );
  }
  validate(config);
  const image = options["--inspect-image"]
    ? await inspectImage(
        options["--inspect-image"],
        options["--docker-host"] ??
          (process.platform === "win32"
            ? "npipe:////./pipe/docker_engine"
            : "unix:///var/run/docker.sock"),
        config.architecture,
        `${config.swr.registry}/${config.swr.namespace}/${config.swr.repository}@${config.swr.digest}`,
      )
    : { checked: false };
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, mode: "offline-preflight", localConfiguration: "passed", cloudAcceptance: "unverified", image, credentialVariableNamesPresent: Object.fromEntries(credentialNames.map((name) => [name, Object.hasOwn(process.env, name)])), operatorDeclaredPending: readinessFields.filter((name) => !config.readiness[name]), notes: ["No key value was read, printed or passed to Docker. Variable presence does not prove validity or remote Secret configuration.", "No resource, registry, Runtime, model or GitHub API was called. Image inspection only reads a local daemon using an empty temporary Docker config.", "Operator readiness flags are declarations, not cloud evidence. Verify alias/version/digest, UID/caps, metadata, egress, timeout/stop and real PR results after approval.", "V3 requires actual target Runtime checks of user/PID/mount/network namespaces, outer seccomp compatibility and the installed worker BPF. UID/capability checks alone are insufficient; namespaceAndSeccompVerified is only an operator declaration.", "V3 must actually mount and verify worker-private procfs inside its PID namespace on the target Runtime. An image build or another host's passing probe is insufficient. A /proc denial must stop deployment; do not weaken namespace, procfs or seccomp isolation. privateProcfsVerified is only an operator declaration.", "This checker validates basic SWR registry naming only. Confirm the target SWR edition and artifact media type before upload; it does not validate OCI support.", ...(config.architecture === "amd64" ? ["ARM64 is the documented first-deployment profile; AMD64 requires explicit tenant confirmation."] : []), ...(config.region !== "cn-southwest-2" ? ["The current SDK guide lists cn-southwest-2 only; confirm this region in the actual tenant."] : [])] }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`Preflight stopped: ${error.message}\n${USAGE}\n`);
  process.exitCode = 1;
});
