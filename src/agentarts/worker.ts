import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDshPrompt } from "../dsh/prompt.js";
import {
  DshAbortedError,
  DshConfigurationError,
  DshError,
  DshProcessError,
  DshTimeoutError,
} from "../dsh/errors.js";
import { headlessResultText } from "../dsh/headless-output.js";
import {
  executeBoundedDshProcess,
  type DshProcessLimits,
  type DshProcessResult,
  type DshProcessSpec,
} from "../dsh/process.js";
import { startDeepSeekProxy, type DeepSeekProxyHandle } from "../dsh/proxy.js";
import {
  emptyInvocationCounts,
  readInvocationCounts,
  readToolReceipts,
  reconcileToolAudit,
} from "../dsh/receipts.js";
import { effectiveExtensionPlan } from "../dsh/runner-policy.js";
import { ControlledComposition } from "../dsh/controlled-composition.js";
import type { DshRunRequest } from "../dsh/runner.js";
import { parseDshOutput } from "../dsh/schema.js";
import type { DshOperation } from "../dsh/schema.js";
import type { TaskOutputSchema } from "../dsh/task-output.js";
import type { AgentToolManifest } from "../agent/contracts.js";
import { prepareControlledProfile } from "../extensions/profile.js";
import { DSH_VERSION } from "../release.js";
import {
  assertNoSecretOutput,
  buildDshWorkerEnvironment,
  collectControllerSecrets,
} from "../security/env.js";
import { removeMarkdownImages } from "../security/redaction.js";
import { budgetedModelFetch, modelPolicy } from "./model-policy.js";
import {
  agentArtsFailureDiagnosticsSchema,
  type AgentArtsFailureDiagnostics,
  type AgentArtsFailurePhase,
} from "./failure-diagnostics.js";
import { PolicyDeniedError } from "../errors.js";
import type { NativeToolId } from "../tools/schema.js";
import {
  digest,
  reviewTaskSchema,
  runtimeReplySchema,
  workspaceDigest,
  type RuntimeReply,
  type ReviewTask,
  type WorkspaceFile,
} from "./protocol.js";
import {
  readOnlyTaskSchema,
  readOnlyTaskReplySchema,
  readOnlyTaskDigest,
  validateReadOnlyTaskOutput,
  type ReadOnlyTask,
  type ReadOnlyTaskReply,
} from "./readonly-task-protocol.js";

export const AGENTARTS_WORKER_UID = 10001;
export const AGENTARTS_WORKER_GID = 10001;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const failureDiagnostics = new WeakMap<object, AgentArtsFailureDiagnostics>();

/** Never trust an arbitrary error.diagnostics property or publish the error itself. */
export function getAgentArtsFailureDiagnostics(
  error: unknown,
): AgentArtsFailureDiagnostics | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = failureDiagnostics.get(error);
  return value === undefined
    ? undefined
    : agentArtsFailureDiagnosticsSchema.parse(structuredClone(value));
}

function diagnosedFailure(
  error: unknown,
  phase: AgentArtsFailurePhase,
  provider: AgentArtsFailureDiagnostics["provider"],
  processStatus: AgentArtsFailureDiagnostics["process"],
  boundaryCode?: AgentArtsFailureDiagnostics["boundaryCode"],
): Error {
  const failure = error instanceof Error ? error : new Error("Runtime worker failed");
  const diagnostics = agentArtsFailureDiagnosticsSchema.safeParse({
    schemaVersion: 1,
    failureCode:
      error instanceof DshError
        ? error.code
        : error instanceof PolicyDeniedError
          ? "POLICY_DENIED"
          : "WORKER_FAILED",
    phase,
    provider,
    ...(processStatus === undefined ? {} : { process: processStatus }),
    ...(boundaryCode === undefined ? {} : { boundaryCode }),
  });
  // Diagnostics are best effort and can never weaken or replace a rejection.
  if (diagnostics.success) failureDiagnostics.set(failure, diagnostics.data);
  return failure;
}

export interface AgentArtsWorkerOptions {
  /** Trusted supervisor configuration. Credentials never come from a task. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly executeProcess?: (
    spec: DshProcessSpec,
    limits: DshProcessLimits,
  ) => Promise<DshProcessResult>;
  readonly actionRoot?: string;
  readonly temporaryDirectory?: string;
  /** Unit/integration fixtures only; never read from the environment or task. */
  readonly allowInsecureTestOnly?: boolean;
}

function packagedRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return ["agentarts", "runtime"].includes(basename(moduleDirectory))
    ? resolve(moduleDirectory, "..", "..")
    : resolve(moduleDirectory, "..");
}

async function assertSupervisorIsolation(actionRoot: string, testOnly: boolean): Promise<void> {
  if (testOnly) return;
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new DshConfigurationError(
      "AgentArts production requires a Linux root supervisor with a separate unprivileged DSH worker",
    );
  }
  const capabilityText = await readFile("/proc/self/status", "utf8");
  const effective = /^CapEff:\s+([a-f0-9]+)$/imu.exec(capabilityText)?.[1];
  const required = 0xe3n; // CHOWN, DAC_OVERRIDE, KILL, SETGID, SETUID.
  if (effective === undefined || (BigInt(`0x${effective}`) & required) !== required) {
    throw new DshConfigurationError(
      "Runtime supervisor requires CHOWN, DAC_OVERRIDE, KILL, SETGID and SETUID capabilities for credential isolation and hard cancellation",
    );
  }
  // Do not leave root's supplementary groups available after the child drops
  // its primary UID/GID. The supervisor itself keeps UID0 for sealed setup.
  if (process.setgroups === undefined)
    throw new DshConfigurationError("Runtime cannot clear inherited Unix groups");
  process.setgroups([]);
  for (const path of [
    actionRoot,
    join(actionRoot, "node_modules"),
    join(actionRoot, "assets", "dsh"),
  ]) {
    const details = await lstat(path);
    if (
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      details.uid !== 0 ||
      (details.mode & 0o022) !== 0
    ) {
      throw new DshConfigurationError(
        "AgentArts runtime code must be an immutable root-owned image directory",
      );
    }
  }
}

/** Production startup preflight; no task, environment flag or test bypass can weaken it. */
export async function assertAgentArtsRuntimeIsolation(): Promise<void> {
  await assertSupervisorIsolation(packagedRoot(), false);
}

async function permissions(
  path: string,
  mode: number,
  workerOwned: boolean,
  testOnly: boolean,
): Promise<void> {
  await chmod(path, mode);
  if (!testOnly) await chown(path, workerOwned ? AGENTARTS_WORKER_UID : 0, AGENTARTS_WORKER_GID);
}

async function sealDirectories(root: string, testOnly: boolean): Promise<void> {
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isDirectory()) await sealDirectories(join(root, item.name), testOnly);
  }
  await permissions(root, 0o550, false, testOnly);
}

async function materializeContext(
  root: string,
  files: readonly WorkspaceFile[],
  testOnly: boolean,
): Promise<void> {
  await mkdir(root, { mode: 0o750 });
  for (const file of files) {
    const path = join(root, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true, mode: 0o750 });
    await writeFile(path, file.content, { flag: "wx", encoding: "utf8", mode: 0o440 });
    await permissions(path, 0o440, false, testOnly);
  }
  await sealDirectories(root, testOnly);
}

/** Independently compare the entire returned workspace to the admitted text bundle. */
async function verifyContext(root: string, files: readonly WorkspaceFile[]): Promise<void> {
  const expected = new Map(files.map((file) => [file.path, file]));
  const directories = new Set(
    files.flatMap((file) => {
      const parts = file.path.split("/");
      return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
    }),
  );
  let observed = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === "" ? item.name : `${prefix}/${item.name}`;
      const fullPath = join(directory, item.name);
      const details = await lstat(fullPath);
      if (details.isSymbolicLink())
        throw new DshConfigurationError("Review workspace acquired a symbolic link");
      if (details.isDirectory()) {
        if (!directories.has(path))
          throw new DshConfigurationError("Review workspace acquired an unadmitted directory");
        await walk(fullPath, path);
      } else if (details.isFile()) {
        const baseline = expected.get(path);
        if (
          baseline === undefined ||
          details.size !== Buffer.byteLength(baseline.content) ||
          digest(await readFile(fullPath, "utf8")) !== baseline.sha256
        ) {
          throw new DshConfigurationError("Read-only review workspace changed; refusing a result");
        }
        observed += 1;
      } else {
        throw new DshConfigurationError("Review workspace contains a non-regular file");
      }
    }
  };
  await walk(root, "");
  if (observed !== expected.size)
    throw new DshConfigurationError("Review workspace lost an admitted file");
}

/** Run original DSH Profile/Bundle boot inside one AgentArts Runtime container. */
export async function runAgentArtsReview(
  rawTask: unknown,
  options: AgentArtsWorkerOptions = {},
): Promise<RuntimeReply> {
  const task = reviewTaskSchema.parse(rawTask);
  const result = await executeReadOnlyDsh(task, { operation: "review", toolCatalog: [] }, options);
  return runtimeReplySchema.parse({
    schemaVersion: 1,
    taskId: task.taskId,
    binding: task.binding,
    ...result,
  });
}

/** V2 adds generic task/diagnosis data and outer Controller requests, never worker write/exec authority. */
export async function runAgentArtsReadOnlyTask(
  rawTask: unknown,
  options: AgentArtsWorkerOptions = {},
): Promise<ReadOnlyTaskReply> {
  const task = readOnlyTaskSchema.parse(rawTask);
  const result = await executeReadOnlyDsh(
    task,
    {
      operation: task.operation,
      toolCatalog: task.toolCatalog,
      ...(task.taskOutputSchema === undefined ? {} : { taskOutputSchema: task.taskOutputSchema }),
    },
    options,
  );
  return readOnlyTaskReplySchema.parse({
    schemaVersion: 2,
    taskId: task.taskId,
    operation: task.operation,
    binding: task.binding,
    taskDigest: readOnlyTaskDigest(task),
    ...result,
  });
}

async function executeReadOnlyDsh(
  task: ReviewTask | ReadOnlyTask,
  configuration: {
    readonly operation: Extract<DshOperation, "review" | "task" | "diagnose">;
    readonly toolCatalog: readonly AgentToolManifest[];
    readonly taskOutputSchema?: TaskOutputSchema;
  },
  options: AgentArtsWorkerOptions,
) {
  const environment = options.environment ?? process.env;
  const policy = modelPolicy(environment);
  const apiKey = environment.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "")
    throw new DshConfigurationError("Runtime supervisor DEEPSEEK_API_KEY is required");
  const actionRoot = options.actionRoot ?? packagedRoot();
  const testOnly = options.allowInsecureTestOnly === true;
  await assertSupervisorIsolation(actionRoot, testOnly);
  const installed = JSON.parse(
    await readFile(createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json"), "utf8"),
  ) as { version?: unknown };
  if (installed.version !== DSH_VERSION)
    throw new DshConfigurationError("Installed DSH does not match the audited version");
  const knownSecrets = [
    ...new Set([apiKey, environment.API_KEY ?? "", ...collectControllerSecrets(environment)]),
  ].filter((secret) => secret !== "");
  assertNoSecretOutput("prompt", JSON.stringify(task), knownSecrets);
  const startedAt = Date.now();
  const deadlineMs = startedAt + task.timeoutMs;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), task.timeoutMs);
  timer.unref();
  const signal =
    options.signal === undefined
      ? timeout.signal
      : AbortSignal.any([timeout.signal, options.signal]);
  const check = (): void => {
    if (timeout.signal.aborted || Date.now() >= deadlineMs)
      throw new DshTimeoutError(task.timeoutMs);
    if (signal.aborted) throw new DshAbortedError();
  };
  let root: string | undefined;
  let proxy: DeepSeekProxyHandle | undefined;
  const modelTransport = budgetedModelFetch(policy, signal);
  let phase: AgentArtsFailurePhase = "setup";
  let processStatus: AgentArtsFailureDiagnostics["process"];
  let boundaryCode: AgentArtsFailureDiagnostics["boundaryCode"];
  let primaryFailure: Error | undefined;
  let completedResult:
    | {
        dshVersion: typeof DSH_VERSION;
        output: ReturnType<typeof parseDshOutput>;
        durationMs: number;
        workspaceDigest: string;
        toolReceipts: Awaited<ReturnType<typeof readToolReceipts>>;
        modelExecution: ReturnType<typeof modelPolicy> & { requestCount: number };
      }
    | undefined;
  const providerDiagnostics = (): AgentArtsFailureDiagnostics["provider"] => ({
    provider: policy.provider,
    model: policy.model === "deepseek-flash" ? "deepseek-flash" : "deepseek-v4-pro",
    upstreamOrigin: policy.upstreamOrigin,
    requestCount: modelTransport.requestCount(),
    requestLimit: policy.requestLimit,
    maxOutputTokens: policy.maxOutputTokens,
    attempts: [...modelTransport.attempts()],
  });
  try {
    check();
    root = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), "agentarts-review-"));
    await permissions(root, 0o750, false, testOnly);
    const workspace = join(root, "workspace");
    const dshHome = join(root, "home");
    const state = join(dshHome, "action-state");
    const workerTmp = join(root, "tmp");
    await mkdir(dshHome, { mode: 0o750 });
    await permissions(dshHome, 0o750, false, testOnly);
    for (const directory of [
      state,
      workerTmp,
      ...["sessions", "attachments", "storages"].map((name) => join(dshHome, name)),
    ]) {
      await mkdir(directory, { mode: 0o700 });
      await permissions(directory, 0o700, true, testOnly);
    }
    await materializeContext(workspace, task.files, testOnly);
    check();
    const nativeTools: readonly NativeToolId[] = task.tools;
    const prompt = buildDshPrompt({
      operation: configuration.operation,
      prompt: JSON.stringify(task.context, (_key, value: unknown) =>
        typeof value === "string" ? removeMarkdownImages(value) : value,
      ),
      trustedInstructions: [
        "This Runtime is read-only. Return changePlan omitted or []. Tests are not executed here: verification must be omitted, [] or contain only status=skipped; never claim passed or failed.",
        task.schemaVersion === 1
          ? "Review must finish with state=final and no toolRequest. Direct runtime tools are only the admitted workspace.read/search tools."
          : "Direct runtime tools are only the admitted workspace.read/search tools. To request a Controller tool, use state=needs_tool with an exact admitted catalog id and empty input; never call Controller tools directly.",
        removeMarkdownImages(task.instructions),
      ].join("\n\n"),
      trust: task.trust,
      toolCatalog: configuration.toolCatalog,
      toolPolicy: { policyOwner: "controller", nativeTools },
      ...(configuration.taskOutputSchema === undefined
        ? {}
        : { taskOutputSchema: configuration.taskOutputSchema }),
    });
    // This upstream helper only reads the optional extensions field when
    // selecting the already-audited empty controlled plan.
    const plan = effectiveExtensionPlan({} as DshRunRequest, new ControlledComposition());
    if (plan.profileName !== "github-action")
      throw new DshConfigurationError("Controlled review profile is required");
    const assets = join(actionRoot, "assets", "dsh");
    const manifestBase = JSON.parse(
      await readFile(join(actionRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const profile = await prepareControlledProfile({
      dshHome,
      plan,
      nativeTools,
      workspaceWrite: false,
      expectedOperation: configuration.operation,
      task: prompt,
      workerWorkspacePath: workspace,
      policyPluginPath: join(assets, "action-policy.mjs"),
      workspacePluginPath: join(assets, "action-workspace.mjs"),
      workerStatePath: join(state, "tool-counts.json"),
      workerAuditPath: join(state, "tool-receipts.jsonl"),
      manifestBase,
    });
    await copyFile(
      join(assets, "action-launcher.mjs"),
      join(profile.profileDir, "action-launcher.mjs"),
    );
    await symlink(
      join(actionRoot, "node_modules"),
      join(profile.profileDir, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const directory of [join(dshHome, "profiles"), profile.profileDir])
      await permissions(directory, 0o750, false, testOnly);
    for (const file of [
      profile.rootPath,
      profile.manifestPath,
      profile.patchPath,
      profile.workspacePath,
      join(profile.profileDir, "action-launcher.mjs"),
    ]) {
      await permissions(file, 0o440, false, testOnly);
    }
    check();
    proxy = await startDeepSeekProxy({
      apiKey,
      baseUrl: environment.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      bindHost: "127.0.0.1",
      workerHost: "127.0.0.1",
      allowWebSearch: false,
      requestTimeoutMs: Math.max(1, deadlineMs - Date.now()),
      maxRequestBytes: 2 * 1024 * 1024,
      maxResponseBytes: MAX_OUTPUT_BYTES,
      fetchImplementation: modelTransport.fetchImplementation,
    });
    const allSecrets = [...knownSecrets, proxy.workerToken];
    const workerEnvironment = buildDshWorkerEnvironment({
      source: {
        PATH: environment.PATH,
        LANG: environment.LANG,
        TZ: environment.TZ,
        HOME: dshHome,
        TMPDIR: workerTmp,
        TMP: workerTmp,
        TEMP: workerTmp,
      },
      dshHome,
      permissionMode: "read-only",
      proxyBaseUrl: proxy.workerBaseUrl,
      proxyToken: proxy.workerToken,
      realDeepSeekApiKey: apiKey,
    });
    const spec: DshProcessSpec = {
      command: process.execPath,
      args: ["--expose-internals", join(profile.profileDir, "action-launcher.mjs"), prompt],
      cwd: workerTmp,
      env: workerEnvironment,
      ...(testOnly ? {} : { uid: AGENTARTS_WORKER_UID, gid: AGENTARTS_WORKER_GID }),
    };
    assertNoSecretOutput("argv", JSON.stringify(spec.args), allSecrets);
    assertNoSecretOutput("environment", JSON.stringify(workerEnvironment), knownSecrets);
    check();
    phase = "process";
    const processResult = await (options.executeProcess ?? executeBoundedDshProcess)(spec, {
      timeoutMs: Math.max(1, deadlineMs - Date.now()),
      maxStdoutBytes: MAX_OUTPUT_BYTES,
      maxStderrBytes: MAX_OUTPUT_BYTES,
      maxCombinedBytes: MAX_OUTPUT_BYTES,
      signal,
    });
    processStatus = { exitCode: processResult.exitCode, signal: processResult.signal };
    check();
    assertNoSecretOutput("stdout", processResult.stdout, allSecrets);
    assertNoSecretOutput("stderr", processResult.stderr, allSecrets);
    if (processResult.exitCode !== 0 || processResult.signal !== null) {
      throw new DshProcessError(
        processResult.exitCode,
        processResult.signal,
        "Runtime DSH worker exited unsuccessfully",
      );
    }
    phase = "output";
    let resultText: string;
    try {
      resultText = headlessResultText(processResult.stdout, allSecrets);
    } catch (error: unknown) {
      boundaryCode = "headless_result_invalid";
      throw error;
    }
    let parsedOutput: ReturnType<typeof parseDshOutput>;
    try {
      parsedOutput = parseDshOutput(
        resultText,
        configuration.operation,
        configuration.taskOutputSchema,
      );
    } catch (error: unknown) {
      boundaryCode = "result_schema_invalid";
      throw error;
    }
    if ((parsedOutput.changePlan?.length ?? 0) > 0) {
      boundaryCode = "workspace_change_claim_not_allowed";
      throw new DshConfigurationError(
        "Cloud review must not request Controller tools or claim workspace modifications/tests",
      );
    }
    if (parsedOutput.verification?.some((test) => test.status !== "skipped") === true) {
      boundaryCode = "test_execution_claim_not_allowed";
      throw new DshConfigurationError("Read-only Runtime must not claim executed tests");
    }
    if (parsedOutput.toolRequest !== undefined) {
      if (
        task.schemaVersion === 1 ||
        task.trust === "untrusted" ||
        !task.toolCatalog.some((tool) => tool.id === parsedOutput.toolRequest?.id)
      ) {
        boundaryCode = "controller_tool_not_allowed";
        throw new DshConfigurationError(
          "Cloud review must not request Controller tools or claim workspace modifications/tests",
        );
      }
      // Current Controller manifests are strictly closed, empty-input schemas.
      if (Object.keys(parsedOutput.toolRequest.input ?? {}).length > 0) {
        boundaryCode = "controller_tool_input_invalid";
        throw new DshConfigurationError(
          "Controller tool input does not match its trusted empty-input schema",
        );
      }
    }
    const output =
      task.schemaVersion === 2 ? validateReadOnlyTaskOutput(parsedOutput, task) : parsedOutput;
    phase = "tool-audit";
    let receipts: Awaited<ReturnType<typeof readToolReceipts>>;
    try {
      receipts = await readToolReceipts(profile.auditPath, 0);
      assertNoSecretOutput("tool receipt", JSON.stringify(receipts), allSecrets);
      reconcileToolAudit(
        emptyInvocationCounts(),
        await readInvocationCounts(profile.statePath, profile.rules),
        receipts,
        true,
      );
    } catch (error: unknown) {
      boundaryCode = "tool_audit_invalid";
      throw error;
    }
    phase = "workspace";
    try {
      await verifyContext(workspace, task.files);
    } catch (error: unknown) {
      boundaryCode = "workspace_changed";
      throw error;
    }
    check();
    completedResult = {
      dshVersion: DSH_VERSION,
      output,
      durationMs: Date.now() - startedAt,
      workspaceDigest: workspaceDigest(task.files),
      toolReceipts: receipts,
      modelExecution: { ...policy, requestCount: modelTransport.requestCount() },
    };
  } catch (error: unknown) {
    let rejection = error;
    try {
      check();
    } catch (deadlineError: unknown) {
      rejection = deadlineError;
    }
    primaryFailure = diagnosedFailure(
      rejection,
      phase,
      providerDiagnostics(),
      processStatus,
      boundaryCode,
    );
  } finally {
    clearTimeout(timer);
    try {
      try {
        if (proxy !== undefined) await proxy.close();
      } finally {
        if (root !== undefined) {
          // Workspace directories were deliberately sealed while the worker ran.
          // Root supervisor may remove them; insecure non-root fixtures need write permission.
          if (testOnly) {
            const restore = async (directory: string): Promise<void> => {
              await chmod(directory, 0o750);
              for (const item of await readdir(directory, { withFileTypes: true })) {
                if (item.isDirectory()) await restore(join(directory, item.name));
              }
            };
            await restore(join(root, "workspace")).catch(() => undefined);
          }
          await rm(root, { recursive: true, force: true, maxRetries: 3 });
        }
      }
    } catch (cleanupError: unknown) {
      primaryFailure = diagnosedFailure(
        cleanupError,
        "cleanup",
        providerDiagnostics(),
        processStatus,
      );
    } finally {
      // Proxy shutdown may settle cancelled transport attempts after the catch.
      if (primaryFailure !== undefined) {
        const previous = getAgentArtsFailureDiagnostics(primaryFailure);
        if (previous !== undefined)
          failureDiagnostics.set(primaryFailure, { ...previous, provider: providerDiagnostics() });
      }
    }
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (completedResult === undefined)
    throw new DshConfigurationError("Runtime result was not accepted");
  return completedResult;
}
