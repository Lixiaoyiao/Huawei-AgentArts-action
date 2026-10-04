# 演示流程：从本地证据到真实云端闭环

演示开始先说明当前证据层次：**本地真实DSH既有确定性模型夹具运行，也有生产AMD64容器接真实DeepSeek的四个固定审查案例；最新AMD64/ARM64 QEMU镜像分别通过运行与拒绝检查；真实 GitHub → AgentArts → GitHub 闭环仍待云端验收。** 四例真实模型只通过自动rubric，人工尚未复核、实际成本未知；PR和提交仍是合成夹具，无GitHub发布。页面是记录查看器，不调用模型或证明数据来自云端。

## 1. 当场运行本地审查

在仓库根目录使用 Node.js 24.15.0 和 npm。此流程不需要云账号、GitHub token 或真实模型 key。

```sh
npm ci --ignore-scripts
npm run build:agentarts
npm run prove:local -- --out "$PWD/work/demo-local-review.json"
```

选择本次新的输出路径；当前prove命令可能覆盖已有同名文件，不覆盖历史evidence。命令退出码必须为0；检查本次生成的 `work/demo-local-review.json`，确认任务ID、阶段时间、工具回执和validation.status。失败时展示失败原因，不沿用旧文件假装本次成功。

这里实际执行的是：本地 HTTP Runtime → 固定 `0.2.0-rc.2` DSH 的原 Profile/Bundle 启动 → 原模型代理 → 真实 `read` 工具 → 结构化结果与工作区摘要 → 控制端检查和独立 diff/边界断言。模型服务先要求 DSH 读取 `src/example.ts`，再返回预设的 off-by-one 审查结果。它证明工具和协议链路，不证明模型自己发现了 bug；仓库名、PR 和提交标识也是夹具。没有真实 GitHub API 发布。

Windows 本地流程显式使用测试专用的 UID 隔离豁免，不能据此宣称生产权限隔离通过。Linux 不同 UID 的额外检查和部署要求见 [项目说明](../../agentarts/README.md)；测试豁免不能用于上线。

## 2. 展示刚生成的记录与历史回放

Windows PowerShell：

```powershell
$demoRecord = (Resolve-Path .\work\demo-local-review.json).Path
node agentarts/demo/serve.mjs --record "$demoRecord"
```

Linux/macOS：

```sh
node agentarts/demo/serve.mjs --record "$PWD/work/demo-local-review.json"
```

打开 `http://127.0.0.1:4173`。按这个顺序讲解，约 2 分钟：

1. 看「本地运行」标识、仓库/PR、绑定提交和任务 ID，说明它们来自本次文件。
2. 看阶段及实际时间，再看 `workspace.read` 回执和耗时。页面不会逐步播放已经结束的执行。
3. 看「控制端独立验证」的具体检查，再看审查摘要与警告。工具调用成功不等于审查结论正确。
4. 指出没有 GitHub 结果链接，说明本地流程未尝试发布。

普通非静态查看器通过HTTP连接后，页面约每2秒请求记录，serve仅按请求重新读 `--record` 文件，标签为「文件记录 · 自动刷新」。服务本身不定时执行任务，这也不是云端事件流。本地证明程序通常完成后才保存记录，因此文件刷新不表示内部步骤正在实时执行；按「停止刷新」可以停止读取。

演示历史记录时点击「载入运行记录」，选择实际导出的 JSON，页面会标明「历史回放」并停止自动刷新。记录的 `local`、`simulation` 或 `cloud` 模式保留；不要为换标签修改模式、任务 ID、工具、时间或结果。导入真实云端记录也仍是历史回放。

无记录时页面保持空状态。无效 JSON、未知模式或不支持的格式会拒绝载入；读取失败保留上一份成功记录并显示错误。录像中保留这些提示，不把旧结果当新结果。结束用 `Ctrl+C` 停止本机服务。

### 展示已经完成的真实模型记录

在「载入运行记录」选择 [最终bounds-defect](../../agentarts/evidence/current/live-model/final/3a0614e9-2513-4173-9db8-fe99e95f4266-bounds-defect.run-record.json)，再分别查看同目录的roles-defect、bounds-clean与roles-clean。它们来自同一最终套件 `3a0614e9-2513-4173-9db8-fe99e95f4266`、真实本地容器DSH/DeepSeek运行；加载后仍标为历史回放，不重执行或计费。查看「本地运行」「真实模型服务 · DeepSeek」、实际tool结果、validation和阶段耗时，并明确指出「记录未提供GitHub结果链接」。

这次四例自动rubric均passed，共测得8次provider请求，人工manualVerdict仍not-reviewed，actualCost未知。成功标准、finding数、case版本及完整评测边界见 [评测](evaluation.md)；不把页面的validation passed改称人工验收或云端通过。真实模型专用容器/key文件已按 [清理记录](../../agentarts/evidence/current/live-model/secret-cleanup.json) 停止删除，回放不需要恢复凭据。

独立fresh-profile/headless Edge154在1280/390/320实际检查过三组回放： [initial](../../agentarts/evidence/current/live-model/browser-qa/initial.json) 12截图、[roles-clean单例retest](../../agentarts/evidence/current/live-model/browser-qa/retest.json) 3截图、[最终四例](../../agentarts/evidence/current/live-model/browser-qa/final.json) 12截图，无overflow/page/CSP错误。最终390视口原尺寸截图也已人工查看。图片保留本地 `outputs/pr-review-demo-qa/live-model/`，没有公开托管；旧失败画面保留原状态，不能换成功记录掩盖失败。

### 准备在线展示文件

先检查记录已经脱敏、适合公开；当前可用本地记录验证导出，但要保留本地模式和固定模型夹具说明。使用明确的新输出目录：

```powershell
$demoRecord = (Resolve-Path .\work\demo-local-review.json).Path
node agentarts/demo/export.mjs --record "$demoRecord" --out "$PWD/../demo-site"
```

Linux/macOS 使用同样的 `--record`/`--out` 参数和绝对路径。输出目录的父目录需已存在；已有目录、错误 schema、未知字段及 `container` 原始证据均会拒绝，不覆盖文件或伪造转换。命令生成静态 HTML 和原字节的 JSON，不自动托管或发布。输出中包含哈希 CSP，静态托管应提供 `index.html` 和同目录 `run-record.json`；项目子路径可用。

这种页面显示「历史回放 · 静态页面」，首次读取后不轮询，可手动重新读取或导入另一条真实记录。在线浏览和交互不意味着在线执行了 AgentArts。用真实云记录替换展示数据时也保持历史标识。公开部署前审查所有已知字符串中的私人信息，并取得发布授权；服务需要额外的防嵌入响应头时由托管配置提供。

## 3. 展示绑定源码的生产镜像证据

查看最新 [AMD64 smoke](../../agentarts/evidence/current/candidate-container-amd64.jsonl) 和 [ARM64 QEMU smoke](../../agentarts/evidence/current/candidate-container-arm64-qemu.jsonl)：均为clean源码、固定DSH `0.2.0-rc.2`、UID/GID10001，每边9运行场景及2启动拒绝通过。AMD64绑定cd9ce8e、14239ms；ARM绑定60b7e95、emulated=true、89559ms，构建输入摘要一致。各自image/manifest ID、原始descriptor与negative链接见 [验证记录](verification.md)，不要把不同commit和镜像混作一次运行。

重点展示生产HTTP健康检查、真实read/typed task/diagnose、工作区摘要、重复拒绝、未授写入/进程环境访问拒绝、非法输出、取消和真正保持模型请求不返回时的硬截止清理。另有缺caps、key文件权限过宽的health之前启动拒绝。这些smoke用确定性模型/PR/CI夹具；真实DeepSeek四例是另一次执行，不能把它的请求数和耗时混进smoke。容器Schema2格式通过尚不证明SWR接收；QEMU通过不是原生ARM或AgentArts通过。

[历史双架构CI](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37187847055) 仍保存源码3957bbe的原artifact，只证明当时记录，不替代本轮候选；较早d9双架构也分别留证。后续重新运行workflow前核对受信代码、当前源码与资源授权，本轮没有push新workflow或公开发布。

容器evidence的mode:container不能导入Demo run-record schema。直接展示原JSONL和日志，不改字段或补造阶段。最新smoke无真实模型、云或GitHub发布调用，实际镜像尚未上传SWR。

## 4. 将来演示真实 GitHub → AgentArts → GitHub

以下是验收流程，不是已经完成的演示。先按 [部署与验收手册](deployment.md) 使用已有或明确获准创建的资源；创建收费服务和公开发布前取得用户确认。必须有可用账号、SWR/Runtime权限、运行日志访问权限、模型凭证及GitHub仓库配置权限。模型key只在Runtime supervisor中；GitHub token和Runtime入站key只在受信控制端。

1. 固定衍生项目 commit、DSH 版本、目标架构、SWR 镜像 digest、Runtime 版本和显式 endpoint alias，拒绝 `Latest`。验证目标租户的降权能力、元数据凭证边界、DeepSeek 出站网络、普通 HTTP 硬超时和 Session 停止行为；任一条件不成立先停在部署验收。
2. 在新仓库审核并安装 [PR Review workflow](../../agentarts/examples/pr-review.yml)，配置 `AGENTARTS_RUNTIME_ORIGIN`、`AGENTARTS_RUNTIME_NAME`、`AGENTARTS_RUNTIME_ENDPOINT` 和 Secret `AGENTARTS_RUNTIME_API_KEY`。示例只构建受信 `github.workflow_sha` 的代码，通过 GitHub API 获取 PR 上下文，不执行 PR head 的脚本。
3. 按 [真实GitHub云端候选](evaluation.md) 创建真实 `review-bug/1` PR，记录固定base/head和业务成功标准；它不是已执行的本地四case。触发后，在Actions查看授权、任务和Session关联；在AgentArts日志中按taskId/head找到真实DSH启动、工具回执和结束记录。
4. 下载该 workflow 的 `agentarts-review-<run_id>-<attempt>` artifact，将实际 `agentarts-run-record.json` 载入 Demo。对照仓库、head、taskId、Session、实际 Cloud Request ID 和平台日志；字段缺失按缺失处理，不能用本地 ID 补齐。
5. 打开记录中的真实 GitHub 结果链接，核对评论所在 PR、代码行和当前提交。评测者用固定源文件/diff 独立判定授权 guard 缺陷是否成立；不以 schema 通过、模型自评或测试数量代替这个判定。
6. 再跑 clean、权限拒绝、提交变化、超时、取消和人工重跑案例。检查真实 GitHub 评论没有重复、DSH 已停止、Session 无遗留运行。分别保留失败原因和清理证据，不能只录正常案例。

只有上述真实事件、平台 DSH/工具证据、控制端验证和 GitHub 结果都能对应，才把该次任务写为「云端闭环通过」。Runtime 日志是现有观测依据；尚未接入的 Gateway/MCP、完整 Trace 和平台评估不列为演示功能。CI 修复、Issue→PR 当前应拒绝，不能换用本地上游模式冒充已迁移。

## 5. 停止条件与留档

权限拒绝时不调用Runtime；任务/仓库/提交/工作区绑定错误、秘密泄漏、未知工具、未完成回执、工作区被修改、执行测试的passed/failed声明或修改请求，都应在只读结果发布前拒绝。真实模型返回verification.status=skipped只说明未执行测试，不增加权限。GitHub head变化也应停止旧结果发布。截止或取消后的迟到结果不能进入finalizer；云端另外查子进程和Session，而不是从HTTP断开推测已经清理。

遇到不可确认的 POST 失败不要自动重发；保留同次任务证据，人工重跑必须重新授权、绑定当前提交并检查评论去重。如果发布阶段已有部分评论后才失败，记录已经发生的效果和失败原因，不能称为零副作用或完整成功。发现任何绕过验证的发布，立即停用后续任务并调查。

每次演示留存衍生/upstream commit、DSH 版本、案例版本与成功标准、base/head、模式、真实阶段时间、工具回执、独立判定、失败原因、清理结果；云端还需 Runtime 版本/digest、Session/requestId、Actions artifact、平台日志和实际 GitHub 链接。费用没有可靠账单与 token 映射时写「未知」。不将本地、容器和云端计成一个成功率。

实验后先停用 workflow 或移除调用 Secret，撤销专用 key，停止残留 Session，再按已批准范围清理专属资源。共享网络、委托、日志和 registry 不随演示删除，具体顺序见部署说明。
