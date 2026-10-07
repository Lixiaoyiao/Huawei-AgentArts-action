import * as core from "@actions/core";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadAgentArtsInputs, assertFullAgentArtsAuthorizedRun } from "./inputs.js";
import { runAction } from "../orchestrator.js";
import { PolicyDeniedError } from "../errors.js";
import { installCancellationHandlers } from "../lifecycle/cancellation.js";
import { buildActionOutputs, formatStepSummary } from "../result.js";
import { redactKnownSecrets } from "../security/env.js";
import { AgentArtsFullEngine } from "./engine-full.js";
import type { RuntimeTask, RuntimeTaskReply } from "./runtime-task-protocol.js";
import type { ValidationSummary } from "../result.js";
import { getBranchHead } from "../write/github.js";
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
  operation?: "review" | "task" | "diagnose" | "fix" | "implement";
} = { id: randomUUID(), repository: "", pullNumber: 0, headSha: "", url: "" };
const record = {
  schemaVersion: 1,
  mode: "cloud",
  task: initialTask,
  stages,
  tools: [] as { id: string; ok: boolean; durationMs: number }[],
  observedTools: [] as string[],
  validation: { status: "not-run", checks: [] as string[] } as {
    status: string;
    checks: string[];
    original?: Pick<ValidationSummary, "status" | "commandCount">;
  },
  runtime: { sessionId: "", endpoint: "", dshVersion: "0.2.0-rc.2", requestId: "" },
  result: {} as {
    githubUrl?: string;
    summary?: string;
    error?: string;
    writeStatus?: "success" | "partial-success" | "no-changes";
    commitSha?: string;
    branchName?: string;
  },
  durationMs: 0,
  warnings: [
    "工具清单来自执行回执；本记录不是 AgentArts 全链路 Trace。",
    "模型执行证据、协议检查和控制端独立测试分别记录；云环境验收仍需审批后的真实运行。",
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
  const inputs = loadAgentArtsInputs((name) =>
    name === "github-token" ? githubToken : core.getInput(name),
  );
  record.runtime.endpoint = `${config.runtimeName}/${config.endpoint}`;
  await save();
  const outcome = await runAction({
    inputs,
    signal: cancellation.signal,
    assertAuthorizedRun: (run) => {
      assertFullAgentArtsAuthorizedRun(run);
      record.task = {
        id: record.task.id,
        repository: run.context.repository.fullName,
        pullNumber: run.snapshot?.kind === "pull_request" ? run.snapshot.number : 0,
        headSha: run.snapshot?.kind === "pull_request" ? run.snapshot.headSha : "",
        kind: run.snapshot?.kind ?? "repository",
        operation: run.command.operation,
        url:
          run.snapshot === undefined
            ? run.currentRunUrl
            : `https://github.com/${run.context.repository.fullName}/${run.snapshot.kind === "pull_request" ? "pull" : "issues"}/${String(run.snapshot.number)}`,
      };
    },
    createEngine: (run, workspace, execution) => async (runtime) => {
      const hooks = {
        onRequestId: (id: string) => {
          record.runtime.requestId = id;
        },
        onTask: async (task: RuntimeTask) => {
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
        onValidated: async (reply: RuntimeTaskReply) => {
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
          record.observedTools = [
            ...new Set([...record.observedTools, ...(reply.observedTools ?? [])]),
          ];
          stage("控制端独立结果校验");
          record.validation = {
            status: "not-run",
            checks: [
              "严格结果协议",
              "任务/仓库/实体/base/head/权限摘要绑定",
              "完整输入工作区摘要与文件差异校验",
              "工具授权和凭据边界",
              "回执完整性",
            ],
          };
          stage("控制端工具回调与最终验收");
          await save();
        },
      };
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
          "Cloud task requires a Controller-bound immutable source revision",
        );
      const binding = {
        repository: run.context.repository.fullName,
        baseSha: run.snapshot?.kind === "pull_request" ? run.snapshot.baseSha : sourceSha,
        headSha: sourceSha,
        ref:
          run.snapshot?.kind === "pull_request"
            ? run.snapshot.headRef
            : (run.baseBranch ?? run.context.repository.defaultBranch ?? "main"),
        entity:
          run.snapshot === undefined
            ? { kind: "repository" as const }
            : { kind: run.snapshot.kind, number: run.snapshot.number },
      };
      return new AgentArtsFullEngine(config, run.policy.trust, binding, secrets, {
        ...hooks,
        workspace,
        runtime,
        mode: inputs.dshMode,
        operationIdentity: execution.operationIdentity,
        extensionPlan: execution.extensions,
        validationCommands: inputs.testCommands,
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
    ...(outcome.pullRequestUrl !== undefined
      ? { githubUrl: outcome.pullRequestUrl }
      : outcome.commentId !== undefined &&
          record.task.url !== "" &&
          record.task.kind !== "repository"
        ? { githubUrl: `${record.task.url}#issuecomment-${String(outcome.commentId)}` }
        : outcome.commitSha !== undefined && record.task.repository !== ""
          ? {
              githubUrl: `https://github.com/${record.task.repository}/commit/${outcome.commitSha}`,
            }
          : {}),
    ...(outcome.writeStatus === undefined ? {} : { writeStatus: outcome.writeStatus }),
    ...(outcome.commitSha === undefined ? {} : { commitSha: outcome.commitSha }),
    ...(outcome.branchName === undefined ? {} : { branchName: outcome.branchName }),
    ...(outcome.error === undefined
      ? {}
      : { error: `${outcome.error.code}: ${outcome.error.message}` }),
  };
  if (outcome.validation !== undefined) {
    record.validation.original = {
      status: outcome.validation.status,
      commandCount: outcome.validation.commandCount,
    };
    record.validation.status =
      outcome.validation.status === "passed"
        ? "passed"
        : outcome.validation.status === "failed"
          ? "failed"
          : "not-run";
    record.validation.checks.push(
      `原控制端独立验证：${outcome.validation.status}；命令数 ${String(outcome.validation.commandCount)}`,
    );
  } else if (outcome.conclusion === "success") {
    record.validation.status = "passed";
    record.validation.checks.push("原控制端结果过滤与发布前提交检查；无写入测试验收");
  }
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
