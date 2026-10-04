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
  url: string;
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
    "PR Review 不执行仓库测试，也不发布文件修改。",
  ],
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
    "allowed-tools": '["workspace.read","workspace.search"]',
    "max-turns": "1",
    "progress-comment": "false",
    "session-mode": "off",
    command: "auto",
  };
  const allowedInputs = new Set([
    "prompt",
    "context-files",
    "max-findings",
    "timeout-minutes",
    "bot-user-id",
  ]);
  const inputs = loadInputs(
    (name) => fixed[name] ?? (allowedInputs.has(name) ? core.getInput(name) : ""),
  );
  if (inputs.timeoutMinutes > 10)
    throw new PolicyDeniedError("AgentArts v1 controller timeout must be at most 10 minutes");
  record.runtime.endpoint = `${config.runtimeName}/${config.endpoint}`;
  await save();
  const outcome = await runAction({
    inputs,
    signal: cancellation.signal,
    assertAuthorizedRun: (run) => {
      assertAgentArtsAuthorizedRun(run);
      if (run.snapshot?.kind !== "pull_request") throw new PolicyDeniedError("Missing PR snapshot");
      record.task = {
        id: record.task.id,
        repository: run.context.repository.fullName,
        pullNumber: run.snapshot.number,
        headSha: run.snapshot.headSha,
        url: `https://github.com/${run.context.repository.fullName}/pull/${String(run.snapshot.number)}`,
      };
    },
    createEngine: (run) => () => {
      if (run.snapshot?.kind !== "pull_request") throw new PolicyDeniedError("Missing PR snapshot");
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
        {
          onRequestId: (id) => {
            record.runtime.requestId = id;
          },
          onTask: async (task) => {
            record.task.id = task.taskId;
            record.runtime.sessionId = task.taskId;
            stage("AgentArts Runtime / DSH");
            await save();
            core.info(
              `AgentArts task=${task.taskId} repository=${task.binding.repository} head=${task.binding.headSha}`,
            );
          },
          onValidated: async (reply) => {
            record.tools = reply.toolReceipts.map((value) => {
              const receipt = value as { id: string; ok: boolean; durationMs: number };
              return { id: receipt.id, ok: receipt.ok, durationMs: receipt.durationMs };
            });
            stage("控制端独立结果校验");
            record.validation = {
              status: "passed",
              checks: [
                "严格结果协议",
                "仓库/PR/base/head绑定",
                "只读工作区摘要",
                "审查能力边界",
                "回执完整性",
              ],
            };
            stage("GitHub 提交复核与评论发布");
            await save();
          },
        },
      );
    },
  });
  const last = stages.at(-1);
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
  if (outcome.conclusion === "failure" && record.validation.status !== "passed")
    record.validation.status = "failed";
  await save();
  for (const [name, value] of Object.entries(buildActionOutputs(outcome)))
    core.setOutput(name, value);
  core.setOutput("run-record", outputPath);
  await core.summary
    .addHeading("Huawei-AgentArts-action · PR Review")
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
