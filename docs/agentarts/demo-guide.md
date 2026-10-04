# 演示流程：从本地证据到真实云端闭环

演示开始先说明当前证据层次：**本地启动了真实 DSH，模型回答来自固定夹具；生产镜像已留下 AMD64 CI 记录；真实 GitHub → AgentArts → GitHub 闭环仍待云端验收。** 页面显示记录，不能独立证明记录来自云端。最新状态以 [验证记录](verification.md) 和对应原始运行记录为准。

## 1. 当场运行本地审查

在仓库根目录使用 Node.js 24 和 npm。此流程不需要云账号、GitHub token 或真实模型 key。

```sh
npm ci --ignore-scripts
npm run build:agentarts
npm run prove:local
```

命令退出码必须为 0；检查本次生成的 `agentarts/evidence/local-run-record.json`，确认任务 ID、阶段时间、工具回执和 `validation.status`。失败时展示记录中的失败原因，先修复原因，不沿用旧文件假装本次成功。

这里实际执行的是：本地 HTTP Runtime → 固定 `0.2.0-rc.2` DSH 的原 Profile/Bundle 启动 → 原模型代理 → 真实 `read` 工具 → 结构化结果与工作区摘要 → 控制端检查和独立 diff/边界断言。模型服务先要求 DSH 读取 `src/example.ts`，再返回预设的 off-by-one 审查结果。它证明工具和协议链路，不证明模型自己发现了 bug；仓库名、PR 和提交标识也是夹具。没有真实 GitHub API 发布。

Windows 本地流程显式使用测试专用的 UID 隔离豁免，不能据此宣称生产权限隔离通过。Linux 不同 UID 的额外检查和部署要求见 [项目说明](../../agentarts/README.md)；测试豁免不能用于上线。

## 2. 展示刚生成的记录与历史回放

Windows PowerShell：

```powershell
$demoRecord = (Resolve-Path .\agentarts\evidence\local-run-record.json).Path
node agentarts/demo/serve.mjs --record "$demoRecord"
```

Linux/macOS：

```sh
node agentarts/demo/serve.mjs --record "$PWD/agentarts/evidence/local-run-record.json"
```

打开 `http://127.0.0.1:4173`。按这个顺序讲解，约 2 分钟：

1. 看「本地运行」标识、仓库/PR、绑定提交和任务 ID，说明它们来自本次文件。
2. 看阶段及实际时间，再看 `workspace.read` 回执和耗时。页面不会逐步播放已经结束的执行。
3. 看「控制端独立验证」的具体检查，再看审查摘要与警告。工具调用成功不等于审查结论正确。
4. 指出没有 GitHub 结果链接，说明本地流程未尝试发布。

`--record` 每 2 秒重新读取文件，标签为「文件记录 · 自动刷新」；这不是云端事件流，也不触发任务。本地证明程序通常完成后才保存记录，因此刷新不表示内部步骤正在实时执行。

演示历史记录时点击「载入运行记录」，选择实际导出的 JSON，页面会标明「历史回放」并停止自动刷新。记录的 `local`、`simulation` 或 `cloud` 模式保留；不要为换标签修改模式、任务 ID、工具、时间或结果。导入真实云端记录也仍是历史回放。

无记录时页面保持空状态。无效 JSON、未知模式或不支持的格式会拒绝载入；读取失败保留上一份成功记录并显示错误。录像中保留这些提示，不把旧结果当新结果。结束用 `Ctrl+C` 停止本机服务。

### 准备在线展示文件

先检查记录已经脱敏、适合公开；当前可用本地记录验证导出，但要保留本地模式和固定模型夹具说明。使用明确的新输出目录：

```powershell
$demoRecord = (Resolve-Path .\agentarts\evidence\local-run-record.json).Path
node agentarts/demo/export.mjs --record "$demoRecord" --out "$PWD/../demo-site"
```

Linux/macOS 使用同样的 `--record`/`--out` 参数和绝对路径。输出目录的父目录需已存在；已有目录、错误 schema、未知字段及 `container` 原始证据均会拒绝，不覆盖文件或伪造转换。命令生成静态 HTML 和原字节的 JSON，不自动托管或发布。输出中包含哈希 CSP，静态托管应提供 `index.html` 和同目录 `run-record.json`；项目子路径可用。

这种页面显示「历史回放 · 静态页面」，首次读取后不轮询，可手动重新读取或导入另一条真实记录。在线浏览和交互不意味着在线执行了 AgentArts。用真实云记录替换展示数据时也保持历史标识。公开部署前审查所有已知字符串中的私人信息，并取得发布授权；服务需要额外的防嵌入响应头时由托管配置提供。

## 3. 展示生产容器 CI 证据

打开已经核实的 [AMD64 生产镜像 CI 运行](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37187847055)，展示镜像构建步骤、实际 DSH smoke 步骤和 artifact；再查看 [保存的容器记录](../../agentarts/evidence/container-amd64.json)。该记录绑定源 commit `3957bbe4e6b589c7fd790a1a05ff86394d11be9f`，DSH `0.2.0-rc.2`，实际架构 `x64`，耗时 `8863 ms`。这是那一次测量，不能套用到其他 commit、镜像或架构。

重点展示已经断言的事实：最终生产 HTTP bundle 的健康检查、真实 DSH 在 UID/GID 10001 下使用 read 工具、只读工作区摘要、同任务拒绝重复执行，以及真正保持模型请求不返回时的截止和子进程清理。此容器使用固定模型夹具与 PR 数据，未调用 DeepSeek 公网、AgentArts 或 GitHub 发布 API。

后续复现可在新仓库 Actions 中手动运行 `AgentArts production image` workflow。现有矩阵包含原生 AMD64 和 ARM64 QEMU；每个架构都需单独查看结果、源 commit、image ID 和 artifact。**QEMU 下 ARM64 容器通过也不等于华为云 ARM64 Runtime 已通过。** 未取得对应记录时写「待验证」，不沿用 AMD64 结论。

同一次矩阵的 [ARM64 QEMU 原始记录](../../agentarts/evidence/container-arm64-qemu.json) 也已通过：`emulated: true`，总耗时 33295 ms，包含 20 秒超时案例。可演示不同架构的真实断言结果，但不把这个总耗时当正常任务延迟或原生 ARM 性能。

容器 evidence 的 `mode: container` 是另一种证据格式，不能直接导入当前 Demo 的运行记录 schema。直接展示原 JSON 和 CI 日志即可；不要改字段或补造阶段来让页面接受它。CI 镜像 ID 也不等于已推送的 SWR 镜像 digest。

## 4. 将来演示真实 GitHub → AgentArts → GitHub

以下是验收流程，不是已经完成的演示。先按 [部署说明](../../agentarts/README.md#部署) 使用已有或明确获准创建的资源；创建收费服务和公开发布前取得用户确认。必须有可用账号、SWR/Runtime 权限、运行日志访问权限、模型凭证及 GitHub 仓库配置权限。模型 key 只在 Runtime supervisor 中；GitHub token 和 Runtime 入站 key 只在受信控制端。

1. 固定衍生项目 commit、DSH 版本、目标架构、SWR 镜像 digest、Runtime 版本和显式 endpoint alias，拒绝 `Latest`。验证目标租户的降权能力、元数据凭证边界、DeepSeek 出站网络、普通 HTTP 硬超时和 Session 停止行为；任一条件不成立先停在部署验收。
2. 在新仓库审核并安装 [PR Review workflow](../../agentarts/examples/pr-review.yml)，配置 `AGENTARTS_RUNTIME_ORIGIN`、`AGENTARTS_RUNTIME_NAME`、`AGENTARTS_RUNTIME_ENDPOINT` 和 Secret `AGENTARTS_RUNTIME_API_KEY`。示例只构建受信 `github.workflow_sha` 的代码，通过 GitHub API 获取 PR 上下文，不执行 PR head 的脚本。
3. 按 [任务集](evaluation.md#审查任务集) 创建真实 `review-bug/1` PR，记录固定 base/head 和业务成功标准。触发审查后，在 Actions 查看授权、任务和 Session 关联；在 AgentArts 日志中按 taskId/head 找到真实 DSH 启动、工具回执和结束记录。
4. 下载该 workflow 的 `agentarts-review-<run_id>-<attempt>` artifact，将实际 `agentarts-run-record.json` 载入 Demo。对照仓库、head、taskId、Session、实际 Cloud Request ID 和平台日志；字段缺失按缺失处理，不能用本地 ID 补齐。
5. 打开记录中的真实 GitHub 结果链接，核对评论所在 PR、代码行和当前提交。评测者用固定源文件/diff 独立判定授权 guard 缺陷是否成立；不以 schema 通过、模型自评或测试数量代替这个判定。
6. 再跑 clean、权限拒绝、提交变化、超时、取消和人工重跑案例。检查真实 GitHub 评论没有重复、DSH 已停止、Session 无遗留运行。分别保留失败原因和清理证据，不能只录正常案例。

只有上述真实事件、平台 DSH/工具证据、控制端验证和 GitHub 结果都能对应，才把该次任务写为「云端闭环通过」。Runtime 日志是现有观测依据；尚未接入的 Gateway/MCP、完整 Trace 和平台评估不列为演示功能。CI 修复、Issue→PR 当前应拒绝，不能换用本地上游模式冒充已迁移。

## 5. 停止条件与留档

权限拒绝时不调用 Runtime；任务/仓库/提交/工作区绑定错误、秘密泄漏、未知工具、未完成回执、工作区被修改、测试通过声明或修改请求，都应在结果发布前拒绝。GitHub head 变化也应停止旧结果发布。截止或取消后的迟到结果不能进入 finalizer；云端另外查子进程和 Session，而不是从 HTTP 断开推测已经清理。

遇到不可确认的 POST 失败不要自动重发；保留同次任务证据，人工重跑必须重新授权、绑定当前提交并检查评论去重。如果发布阶段已有部分评论后才失败，记录已经发生的效果和失败原因，不能称为零副作用或完整成功。发现任何绕过验证的发布，立即停用后续任务并调查。

每次演示留存衍生/upstream commit、DSH 版本、案例版本与成功标准、base/head、模式、真实阶段时间、工具回执、独立判定、失败原因、清理结果；云端还需 Runtime 版本/digest、Session/requestId、Actions artifact、平台日志和实际 GitHub 链接。费用没有可靠账单与 token 映射时写「未知」。不将本地、容器和云端计成一个成功率。

实验后先停用 workflow 或移除调用 Secret，撤销专用 key，停止残留 Session，再按已批准范围清理专属资源。共享网络、委托、日志和 registry 不随演示删除，具体顺序见部署说明。
