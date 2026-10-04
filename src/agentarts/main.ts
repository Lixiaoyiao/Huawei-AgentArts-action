import * as core from "@actions/core";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadInputs } from "../inputs.js";
import { runAction } from "../orchestrator.js";
import { PolicyDeniedError } from "../errors.js";
import { installCancellationHandlers } from "../lifecycle/cancellation.js";
import { buildActionOutputs, formatStepSummary } from "../result.js";
import { redactKnownSecrets } from "../security/env.js";
import { AgentArtsReviewEngine } from "./engine.js";
import { AgentArtsReadOnlyTaskEngine } from "./engine-task.js";
import type { ReviewTask, RuntimeReply } from "./protocol.js";
import type { ReadOnlyTask, ReadOnlyTaskReply, ReadOnlyBinding } from "./readonly-task-protocol.js";
import { getBranchHead } from "../write/github.js";
import { assertAgentArtsAuthorizedRun } from "./engine.js";
import { runtimeUrl, type RuntimeClientConfig } from "./client.js";

const startedAt = Date.now();
const outputPath = resolve(process.env.RUNNER_TEMP ?? process.cwd(), "agentarts-run-record.json");
const stages: {
  name: string;
  status: "running" | "passed" | "failed";
  startedAt: string;
  completedAt?: string;
  message?: string;
}[] = [];
const initialTask: {
  id: string;
  repository: string;
  pullNumber: number;
  headSha: string;
  baseSha?: string;
  url: string;
  kind?: "pull_request" | "issue" | "repository";
  operation?: "review" | "task" | "diagnose";
} = { id: randomUUID(), repository: "", pullNumber: 0, headSha: "", url: "" };
const record = {
  schemaVersion: 1,
  mode: "cloud",
  task: initialTask,
  stages,
  tools: [] as { id: string; ok: boolean; durationMs: number }[],
  validation: { status: "not-run", checks: [] as string[] },
  runtime: { sessionId: "", endpoint: "", dshVersion: "0.2.0-rc.2", requestId: "" },
  result: {} as { githubUrl?: string; summary?: string; error?: string },
  durationMs: 0,
  warnings: [
    "工具清单来自执行回执；本记录不是 AgentArts 全链路 Trace。",
    "当前云适配仅接入只读操作，不执行仓库测试，也不发布文件修改。",
  ],
  modelEvidence: {
    kind: "unverified" as "live-provider" | "deterministic-fixture" | "unverified",
    provider: "deepseek",
    model: "",
  },
};
let secrets: string[] = [];
async function save(): Promise<void> {
  record.durationMs = Date.now() - startedAt;
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp`;
  await writeFile(temporary, redactKnownSecrets(JSON.stringify(record, null, 2), secrets), {
    mode: 0o600,
  });
  await rename(temporary, outputPath);
}
function stage(name: string): void {
  const previous = stages.at(-1);
  if (previous?.status === "running") {
    previous.status = "passed";
    previous.completedAt = new Date().toISOString();
  }
  stages.push({ name, status: "running", startedAt: new Date().toISOString() });
}

const cancellation = installCancellationHandlers();
try {
  stage("授权与提交上下文");
  const config: RuntimeClientConfig = {
    origin: core.getInput("runtime-origin", { required: true }),
    runtimeName: core.getInput("runtime-name", { required: true }),
    endpoint: core.getInput("runtime-endpoint", { required: true }),
    apiKey: core.getInput("runtime-api-key", { required: true }),
  };
  runtimeUrl(config);
  const githubToken = core.getInput("github-token", { required: true });
  secrets = [config.apiKey, githubToken];
  secrets.forEach((secret) => core.setSecret(secret));
  // These internal values reuse upstream policy parsing only. No local model runner is selected.
  const fixed: Record<string, string> = {
    "deepseek-api-key": "runtime-managed-model-proxy",
    "github-token": githubToken,
    "dsh-version": "0.2.0-rc.2",
    "dsh-mode": "controlled",
    isolation: "docker",
    "allow-write": "false",
    "permission-profile": "custom",
    "allowed-tools": core.getInput("allowed-tools") || '["workspace.read","workspace.search"]',
    "max-turns": core.getInput("max-turns") || "3",
    "progress-comment": "false",
    "session-mode": "off",
    command: core.getInput("command") || "auto",
  };
  const allowedInputs = new Set([
    "prompt",
    "context-files",
    "max-findings",
    "timeout-minutes",
    "bot-user-id",
    "task-output-schema",
    "base-branch",
  ]);
  const inputs = loadInputs(
    (name) => fixed[name] ?? (allowedInputs.has(name) ? core.getInput(name) : ""),
  );
  if (inputs.timeoutMinutes > 10)
    throw new PolicyDeniedError("AgentArts controller timeout must be at most 10 minutes");
  if (
    inputs.allowedTools.some(
      (id) => !["workspace.read", "workspace.search", "github.checks.read"].includes(id),
    )
  )
    throw new PolicyDeniedError(
      "This cloud adapter currently grants only workspace.read, workspace.search and Controller github.checks.read",
    );
  record.runtime.endpoint = `${config.runtimeName}/${config.endpoint}`;
  await save();
  const outcome = await runAction({
    inputs,
    signal: cancellation.signal,
    assertAuthorizedRun: (run) => {
      assertAgentArtsAuthorizedRun(run);
      record.task = {
        id: record.task.id,
        repository: run.context.repository.fullName,
        pullNumber: run.snapshot?.kind === "pull_request" ? run.snapshot.number : 0,
        headSha: run.snapshot?.kind === "pull_request" ? run.snapshot.headSha : "",
        kind: run.snapshot?.kind ?? "repository",
        operation: run.command.operation as "review" | "task" | "diagnose",
        url:
          run.snapshot === undefined
            ? run.currentRunUrl
            : `https://github.com/${run.context.repository.fullName}/${run.snapshot.kind === "pull_request" ? "pull" : "issues"}/${String(run.snapshot.number)}`,
      };
    },
    createEngine: (run, workspace) => async () => {
      const hooks = {
        onRequestId: (id: string) => {
          record.runtime.requestId = id;
        },
        onTask: async (task: ReviewTask | ReadOnlyTask) => {
          record.validation = { status: "not-run", checks: [] };
          record.task.id = task.taskId;
          record.task.baseSha = task.binding.baseSha;
          record.task.headSha = task.binding.headSha;
          record.runtime.sessionId = task.taskId;
          stage("AgentArts Runtime / DSH");
          await save();
          core.info(
            `AgentArts task=${task.taskId} repository=${task.binding.repository} head=${task.binding.headSha}`,
          );
        },
        onValidated: async (reply: RuntimeReply | ReadOnlyTaskReply) => {
          record.modelEvidence = {
            kind: reply.modelExecution?.kind ?? "unverified",
            provider: "deepseek",
            model: reply.modelExecution?.model ?? "",
          };
          record.tools.push(
            ...reply.toolReceipts.map((value) => {
              const receipt = value as { id: string; ok: boolean; durationMs: number };
              return { id: receipt.id, ok: receipt.ok, durationMs: receipt.durationMs };
            }),
          );
          stage("控制端独立结果校验");
          const finalResult =
            typeof reply.output === "object" &&
            reply.output !== null &&
            !Array.isArray(reply.output) &&
            reply.output.state === "final";
          record.validation = {
            status: finalResult ? "passed" : "not-run",
            checks: [
              "严格结果协议",
              "仓库/实体/base/head绑定",
              "只读工作区摘要",
              "只读能力和工具授权边界",
              "回执完整性",
            ],
          };
          stage("控制端工具回调或 GitHub 结果发布");
          await save();
        },
      };
      if (run.command.operation === "review") {
        if (run.snapshot?.kind !== "pull_request")
          throw new PolicyDeniedError("Missing PR snapshot");
        return new AgentArtsReviewEngine(
          config,
          run.policy.trust,
          {
            repository: run.context.repository.fullName,
            pullNumber: run.snapshot.number,
            baseSha: run.snapshot.baseSha,
            headSha: run.snapshot.headSha,
          },
          secrets,
          hooks,
        );
      }
      const sourceSha =
        run.snapshot?.kind === "pull_request"
          ? run.snapshot.headSha
          : (workspace.boundWriteSha ??
            (run.context.kind === "automation" ? run.context.workflowRun?.headSha : undefined) ??
            (run.baseBranch === undefined
              ? undefined
              : await getBranchHead(
                  run.client,
                  run.context.repository.owner,
                  run.context.repository.repo,
                  run.baseBranch,
                )));
      if (sourceSha === undefined)
        throw new PolicyDeniedError(
          "Read-only cloud task requires a Controller-bound immutable source revision",
        );
      const binding: ReadOnlyBinding = {
        repository: run.context.repository.fullName,
        baseSha: run.snapshot?.kind === "pull_request" ? run.snapshot.baseSha : sourceSha,
        headSha: sourceSha,
        entity:
          run.snapshot === undefined
            ? { kind: "repository" }
            : { kind: run.snapshot.kind, number: run.snapshot.number },
      };
      return new AgentArtsReadOnlyTaskEngine(config, run.policy.trust, binding, secrets, {
        ...hooks,
        ...(inputs.taskOutputSchema === undefined
          ? {}
          : { taskOutputSchema: inputs.taskOutputSchema }),
      });
    },
  });
  const last = stages.at(-1);
  record.tools.push(
    ...(outcome.agent?.toolReceipts ?? []).map(({ id, ok, durationMs }) => ({
      id,
      ok,
      durationMs,
    })),
  );
  if (last?.status === "running") {
    last.status = outcome.conclusion === "failure" ? "failed" : "passed";
    last.completedAt = new Date().toISOString();
    last.message = outcome.summary;
  }
  record.result = {
    summary: outcome.summary,
    ...(outcome.conclusion === "success" ? { githubUrl: record.task.url } : {}),
    ...(outcome.error === undefined
      ? {}
      : { error: `${outcome.error.code}: ${outcome.error.message}` }),
  };
  if (
    outcome.conclusion === "failure" &&
    (record.validation.status !== "passed" || outcome.error?.phase === "agent")
  )
    record.validation.status = "failed";
  await save();
  for (const [name, value] of Object.entries(buildActionOutputs(outcome)))
    core.setOutput(name, value);
  core.setOutput("run-record", outputPath);
  await core.summary
    .addHeading(`Huawei-AgentArts-action · ${record.task.operation ?? "task"}`)
    .addRaw(formatStepSummary(outcome))
    .write();
  if (outcome.conclusion === "failure")
    core.setFailed(redactKnownSecrets(record.result.error ?? outcome.summary, secrets));
} catch (error) {
  const message = redactKnownSecrets(
    error instanceof Error ? error.message : String(error),
    secrets,
  );
  const last = stages.at(-1);
  if (last) {
    last.status = "failed";
    last.message = message;
    last.completedAt = new Date().toISOString();
  }
  record.result = { error: message };
  await save();
  core.setOutput("run-record", outputPath);
  core.setFailed(message);
} finally {
  cancellation.dispose();
}
process.exit(process.exitCode ?? 0);
