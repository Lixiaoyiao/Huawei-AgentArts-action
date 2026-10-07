# 本机生产 Runtime → 真实 GitHub PR Review

这个专用入口复用原 `runAction`、`AgentArtsFullEngine`、precision/diff 检查和 review publisher。它只接受 `Lixiaoyiao/Huawei-AgentArts-action` 的同仓、非 draft、open PR；不是通用 webhook 服务，也不是 GitHub Actions run。人工显式启动后，控制端从 GitHub API 读取当前用户、仓库和 PR，将真实绑定交给本机生产 Runtime 中的 DSH，最后由原控制端发布经过检查的审查。不会创建修复 commit 或 PR。

这条链路的成功范围是“真实 GitHub + 本机生产 Runtime + 真实 DeepSeek”。它不证明华为云兼容、平台观测或云部署通过。模型判断仍需人工验收，不以 HTTP 200 或评论创建成功代替业务正确性。当前实际结果另见 [验证记录](verification.md)，本页命令是操作手册。

## 1. 固定两个执行位置

在受信控制端使用 Node 24、干净的已审查源码和锁文件构建入口：

```bash
npm ci --ignore-scripts
node scripts/build-agentarts.mjs --entry local-github
```

控制端可运行在 Linux，或与已经启动的本地 Linux Runtime 相连的 Windows 主机。它持有 GitHub token；token 不挂载进 Runtime，不进入模型请求或 DSH 环境。此入口的读权限仅为 `workspace.read`、`workspace.search`，不开放 Bash、测试执行、GitHub 工具或扩展；最多一次 Runtime 调用、一次原 AgentLoop turn，Session 关闭。

Runtime 按 [部署手册的本机容器步骤](deployment.md#43-本地真实-key-的位置) 启动，并先完成 [宿主隔离预检](host-requirements.md)。使用固定 image ID、五项 capabilities、受检外层 seccomp、必要的独立 AppArmor profile、只读镜像和私有临时目录；禁止使用 privileged、SYS_ADMIN、unconfined 或测试隔离豁免。未通过真实 namespace、private procfs、worker BPF 和网络 probe 就停止。

Runtime 必须选择 `AGENTARTS_INBOUND_MODE=local`，端口只暴露到 `127.0.0.1`，提供独立临时 `AGENTARTS_LOCAL_API_KEY`。DeepSeek key 仅由 root supervisor 按部署手册从 root-owned 0600 文件读入；不要把它交给此 CLI、Docker ENV/argv、仓库或记录。健康 `/ping` 无入站认证，不代表任务调用已授权。

可信 supervisor 需配置 `AGENTARTS_MODEL_EVIDENCE=live-provider`、官方 DeepSeek origin、固定模型及明确的 `AGENTARTS_MAX_MODEL_REQUESTS`、`AGENTARTS_MAX_OUTPUT_TOKENS`。CLI 会在调用前检查这些上限，并在发布前核对实际 reply 中的模型来源与请求数。最多 32 次请求、8192 output tokens 是本实现上限，不是云平台承诺。美元预算仅表示批准额度，不是美元计费硬限制；无法可靠归因的成本记为 unknown。

分别记录 Controller 的源码 commit，以及 Runtime 镜像的构建源码 commit → 本地 image ID 映射。`--source-commit` 表示 Controller commit，`--image-digest` 表示 Runtime 的本地 image ID；二者不声称来自同一个源码 commit，也不构成远程证明。本地 image ID 不能替代 SWR manifest digest。

## 2. 凭据和计划

控制端安全配置两个不同的环境变量：

| 变量                      | 位置及用途                                                                       |
| ------------------------- | -------------------------------------------------------------------------------- |
| `AGENTARTS_GITHUB_TOKEN`  | 仅控制端，读取实际 PR 和发布审查；使用专用仓库授权的最小权限 token               |
| `AGENTARTS_LOCAL_API_KEY` | 控制端与本机 supervisor 共有的临时入站 capability；不得复用 GitHub、模型或云 key |

例如在受信 Bash 终端用隐藏输入设置 GitHub token，不把值写进 shell 历史：

```bash
read -r -s -p 'Controller GitHub token: ' AGENTARTS_GITHUB_TOKEN
printf '\n'
export AGENTARTS_GITHUB_TOKEN
```

本机 capability 使用部署时已安全生成并配置给 supervisor 的值。不要执行 `env`、`set -x` 或输出包含凭据的 Docker inspect。CLI 会在调用原控制端时隐藏 Actions `add-mask` 命令并对已知凭据脱敏，保存的记录也做脱敏；发布 Demo 前仍需人工审查允许字段中的字符串。

准备两个**彼此独立、父目录已存在**的绝对路径：全新的输出目录 `OUT` 和持久私有状态目录 `STATE`。入口创建 leaf 目录，Linux 为 0700、文件 0600；拒绝既有输出、symlink、路径别名和不安全 ledger。状态目录必须位于控制端，不能放入被审查仓库或挂载给 Runtime。

下面是 Bash 示例。三个 SHA 和镜像 ID 必须替换成实际值；`BASE_SHA` 要在执行前从当前真实 PR 读取，推送 main 可能改变它。若使用 `gh` 读取绑定，令其在控制端使用同一专用 GitHub 身份；不要将未经检查的 API 输出拼成命令。

```bash
CONTROLLER_SHA="$(git rev-parse HEAD)"
PR_NUMBER=1
HEAD_SHA="$(GH_TOKEN="$AGENTARTS_GITHUB_TOKEN" gh api "repos/Lixiaoyiao/Huawei-AgentArts-action/pulls/$PR_NUMBER" --jq .head.sha)"
BASE_SHA="$(GH_TOKEN="$AGENTARTS_GITHUB_TOKEN" gh api "repos/Lixiaoyiao/Huawei-AgentArts-action/pulls/$PR_NUMBER" --jq .base.sha)"
RUNTIME_IMAGE_ID='sha256:<actual-64-lowercase-hex-local-image-id>'
OUT='/absolute/private/evidence/pr-review-first'
STATE='/absolute/private/controller-review-ledger'

node dist-agentarts/local-github/index.js --dry-run \
  --repository Lixiaoyiao/Huawei-AgentArts-action --pull-number "$PR_NUMBER" \
  --expected-head "$HEAD_SHA" --expected-base "$BASE_SHA" \
  --source-commit "$CONTROLLER_SHA" --image-digest "$RUNTIME_IMAGE_ID" \
  --runtime-origin http://127.0.0.1:8080 --trusted-local-runtime \
  --timeout-minutes 5 --max-model-requests 8 --max-output-tokens 4096 \
  --out "$OUT" --state-dir "$STATE"
```

干跑只校验参数并输出计划，不读取凭据、不调用 GitHub/模型、不创建目录。它不能检查真实 PR、身份或 Runtime 健康。执行时显式将 `--dry-run` 换成：

```text
--execute --budget-usd <approved-positive-usd> --confirm-budget I_ACCEPT_METERED_MODEL_CALLS
```

其余参数保持不变。CLI 只允许显式 HTTP 回环地址 `127.0.0.1` 或 `[::1]`；原生产客户端的 HTTPS/固定 alias 规则保持不变。本机传输适配仅把已绑定的 v3 invocation 发到 `/invocations`，不重定向 GitHub API，不重试不确定 POST。取消依靠 HTTP 断开和 supervisor 硬截止时间；这里没有验证云 `sessions-stop`。

## 3. 检查结果和拒绝

正常执行会在输出目录保存以下私有文件：

| 文件                            | 含义                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `manual-trigger.json`           | 来自实际 API 的最小人工 PR trigger，非接收的 webhook                                                 |
| `validated-runtime-result.json` | FullEngine 已校验的实际 v3 reply、工具和模型回执；后续原 precision/diff 检查仍可拒绝发布             |
| `controller-outcome.json`       | 原控制端的最终 outcome 和真实 publication 计数                                                       |
| `run-record.json`               | Demo 严格 schema 的本机运行记录；实际模型来源独立标注                                                |
| `operation-evidence.json`       | 真实身份、绑定、镜像/Controller 声明、请求计数范围、实际评论 ID/链接、ledger key、失败或历史复用状态 |

真实 taskId 可与 supervisor 的 `task.accepted/completed/failed` JSON 日志关联。成功后再次只读核对 PR base/head、open 状态，以及原 tracking marker 评论的数字作者和精确 PR URL，才写入完成记录。读取 GitHub 评论 URL 失败、结果协议失败、模型证据不符、隔离不足、提交漂移、原发布失败或截止取消都会停止；不自动补发。发布后再检查失败可能意味着 GitHub 已有部分结果，应人工检查，不能当成“未产生副作用”重试。

`runtimeInvocations` 计数控制端已准备的调用尝试，不等于服务端已接受数；`modelRequests` 只计严格核验的 supervisor reply。发生断连而没有可信 reply 时，真实已计费请求数未知，不能把该字段的 0 解释成没有费用。PR Review 不执行仓库代码，不将协议/precision/diff 通过写成独立 Docker 测试通过。

人工查看 PR 评论、源码和缺陷证据后另记验收，CLI 不自动把 `manualVerdict: not-reviewed` 改成通过。不要只看评论总数来判断审查正确性。

## 4. 重复执行与停止条件

相同 `STATE` 下，repo ID、PR、base/head/ref、认证用户数字 ID、固定审查配置、DSH 版本、Controller commit 和 Runtime image ID 共同形成 operation key。成功完成后，用同一参数和**新的 OUT** 再运行，会先重新读取当前实际 PR 和评论归属，再输出 `status: reused`，本次 0 Runtime、0 模型调用、0 发布；Demo 记录明确历史复用。

这是同一私有状态目录和身份下的本地 driver 跨重启幂等，不是 Action/GitHub API 全局并发幂等。原发布器自己的 fingerprint/upsert 机制仍保留，但不要据此宣称相近措辞的模型发现永远不会重复。

状态目录的 `*.started.json` 是独占意图记录；结果未知时保留，下一次拒绝自动重放。`*.complete.json` 用独占链接原子生成；文件内容做 sync，但未承诺父目录 fsync 或断电耐久性。遇到 pending、损坏记录、链接归属变化或疑似部分发布，先检查真实 GitHub 与 supervisor 日志，再由受信操作者决定是否另开任务；不要用删除 ledger 或换 STATE 绕过不确定结果。源码/镜像/配置变化会形成新 key，因此升级后同一 PR 也应先检查既有结果再执行。

演示无缺陷场景可使用另一个专用 clean PR；错误绑定可传明确不匹配的 `--expected-head`，应在 Runtime/发布前拒绝。错误凭据、预算、PR 状态和隔离失败都保留真实失败，不能用模拟结果补成成功。

## 5. 回放和清理

审核脱敏后，可以将实际记录导出为静态回放；导出不发布、不调用服务、不改模式或记录字节：

```bash
node agentarts/demo/export.mjs --record "$OUT/run-record.json" --out /absolute/new/static-review-demo
```

页面标注历史快照，固定 JSON 不轮询，不把回放当成本次执行。公开部署还需单独授权。`validated-runtime-result.json`、Controller outcome 和 ledger 不应直接当 Demo JSON 发布。

演示结束后，保存经过人工脱敏的证据，停止并删除本次专用 Runtime 容器，撤销/移除临时 GitHub token、本机 capability 和 root-only 模型文件，并清空控制端环境变量。容器、宿主策略和凭据的清理按部署手册逐项核对；不要删除共享资源。保留私有 ledger 可以防止后续误重放，证据保留期结束后由操作者按目录归属清理。专用测试 PR/评论由获准的仓库维护者关闭或保留为案例，不触及上游仓库或第三方。
