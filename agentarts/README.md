# AgentArts 上的 DeepSeek Harness Action

目标是完整迁移原 Action 的已有能力，保留 DSH 和受信 GitHub Controller，由 AgentArts 提供适用的云运行基础设施。PR Review 是第一条接入与验收链路：Controller 获取绑定 base/head 的上下文，Runtime 内运行 DSH，Controller 独立检查返回结果，再由原 publisher 发布审查评论。账号准入审批中，真实云端闭环未验收。本轮不公开发布、不创建云资源。

本轮接入原只读 `task`、`diagnose` 的 v2 engine/worker 与主入口，复用原 Controller loop 的工具请求/反馈路径。本机生产容器9场景试运行含真实DSH v2 read/typed output；该次sourceDirty=true，最终本轮记录仍独立核对。[能力迁移表](../docs/agentarts/capability-matrix.md) 区分代码/本地/模拟/云端状态，不拿旧Review CI作为v2证据。`fix`、`implement`、`task --write` 仍拒绝。native/extensions/session 等原实现完整保留；迁移是原能力适配，不是另建平台。运行模式和旧参数是否原样保留须逐项判断，不凭源码存在宣称兼容，也不将本阶段只读约束当成永久产品定位。

当前 Action 参数中 `command` 可选 auto/review/task/diagnose；`allowed-tools` 只允许 workspace.read/search 和受信 Controller 的 github.checks.read，工具仍经原 policy交集判断；`max-turns` 默认3，约束原loop，包括工具反馈轮次。task-output-schema仅适用于通用task；非PR任务的base-branch由Controller固定到commit，无PR workflow_run诊断则固定失败run的head。Review使用v1，不接受Controller工具请求；只读task/diagnose使用v2。native read/search实际在Runtime执行；只有已授catalog中的github.checks.read请求返回Controller，执行和反馈由原loop完成。模型没有GitHub写入或command argv；普通read不授仓库执行能力。

```text
GitHub PR → Controller 授权/绑定上下文 → AgentArts Runtime 内运行 DSH
          → 只读工具/结果/回执 → Controller 独立校验与 head 复查 → GitHub 评论
```

DSH 固定 `0.2.0-rc.2`，Node 镜像和 npm 依赖锁定。Controller 只传限长 diff、改动文件文本及显式 context-files：最多 1 MiB/500 文件，整个任务最多 2 MiB。云端不 clone 仓库，不带 `.git`、符号链接或仓库启动命令；缺失/截断上下文按缺失处理。同仓库的授权审查仅有 read/search；fork 按上游策略只接收有界上下文，不装载工具工作区。

v2也只传changedFiles.source与context-files，不上传Controller整仓。Issue/repository task默认可能只有Issue或任务文本；文件问答要显式选择context-files。授予read/search只允许访问这份有界工作区，不代表可读取完整仓库或从云端自由拉代码。

| 受信位置             | 凭据与职责                                                                 |
| -------------------- | -------------------------------------------------------------------------- |
| GitHub Controller    | GitHub 写 token、Runtime 入站 API Key；授权、独立验证、PR 复查、评论发布   |
| Runtime supervisor   | DeepSeek 模型 key；启动原模型代理、封闭环境、只读工作区和 UID/GID10001 DSH |
| DSH / 模型 / PR 数据 | 只有任务代理 token 与授予的只读工具；不持有真实 GitHub、Runtime 或模型 key |

独立 UID 不等于网络隔离。真实租户仍须验证父进程、文件、云元数据凭据、网络与截止/取消清理。未满足时停止部署验收；禁止将测试 UID 豁免用于云端。当前审查不执行 PR 代码和测试，不接受文件修改、模型测试通过声明或控制端工具请求。未知结果、绑定错误、越权/未结束回执、工作区变化和凭据泄漏会阻断发布；模型评论仍需按业务标准判断。

后续写能力须将真实文件变更按路径、基线 SHA/模式与任务绑定返回，导入受信 Controller 的隔离工作区，再复用原验证完整性检查、无凭据容器测试和独立 GitHub finalizer。`changePlan` 只是模型描述，不包含补丁内容；不能改用模型“测试通过”声明，也不能简单解除本阶段只读限制。

本轮已实现 [文件传输原型](../src/agentarts/workspace-transfer.ts)，从真实工作区打包/capture/delta，严格校验后 stage/交换原 Controller workspace；它还未接入云端 write 或 GitHub finalizer。repository/commit/revision/digest 绑定不能代替外层 task/ref授权，详情与测试范围见 [能力表](../docs/agentarts/capability-matrix.md)。

新增配置入口不自动补齐workflow权限。PR Review使用contents read/pull-requests write；诊断读取check-runs/失败run日志需相应checks read/actions read。Issue答复的写权限只给Controller并按实际comment endpoint配置；它不等于开放文件/ref写入。[上游诊断权限例](../examples/ci-diagnose.yml)、[GitHub评论权限](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)。当前审批后部署预检与第一条云验收仍以Review为主；其他operation的真实GitHub/云场景单独记录。

## 本地运行与证据

需要 Node.js 24.15.0、npm、Git。已有本地复现命令如下，不调用华为或真实模型：

```bash
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run test:agentarts
npm run build:agentarts
npm run prove:local -- --out /absolute/path/to/work/local-proof-new.json
node agentarts/demo/serve.mjs --record /absolute/path/to/work/local-proof-new.json
```

`prove:local` 实际经过本地 HTTP Runtime、原 DSH、只读工具与 Controller 检查，模型/PR 是确定性夹具。使用新的 `--out` 路径保存本轮，避免覆盖历史evidence；该命令当前不拒绝覆盖已有同名文件，操作者需选新的路径。Windows 有明确的测试UID豁免；Linux root可用 `node dist-agentarts/local-proof/index.js --linux-isolation --out /absolute/path/to/work/linux-proof-new.json` 另验UID/文件/父进程环境，仍不是云端证据。完整通用回归另执行 `npm test -- --maxWorkers=2`，targeted test不能代替它。

Linux本机生产镜像复现用 `bash agentarts/local-container.sh`；支持已准备宿主的AMD64/ARM64，不自动登记QEMU、不推送SWR。它保留实际image ID、descriptor、dirty/source tree摘要和smoke记录。固定Review任务/无调用dry-run、受信root key单文件挂载和清理见 [部署手册4节](../docs/agentarts/deployment.md#4-本地预检与复现)。有真实key也不自动调用模型，须独立确认模型费用与次数/时限上限。

既有双架构镜像 CI 绑定源码 `3957bbe4e6b589c7fd790a1a05ff86394d11be9f`：[实际运行](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37187847055)。AMD64 与 ARM64 QEMU 都运行了真实 DSH/read、重复拒绝和真实请求超时清理；它们不证明本轮其他源码、原生 ARM 硬件或 AgentArts 通过。本轮容器/live 命令和新记录按 [部署手册](../docs/agentarts/deployment.md) 与 [验证记录](../docs/agentarts/verification.md) 分开留存。

Demo 默认在 `http://127.0.0.1:4173`，只读记录；文件导入标为历史回放。静态导出保留原 JSON，拒绝 raw/container、未知字段和重复键，不执行任务、不持续轮询。已知字符串仍需人工脱敏；导出与公开托管是不同操作，当前不发布。详见 [Demo 指南](../docs/agentarts/demo-guide.md)。浏览器不配置 key。

多轮Action记录汇总实际native与Controller工具回执，但runtime/task/session/requestId当前保留最后一轮Session，不是完整平台Trace。平台日志须另按各次真实任务查询；GitHub源事件、回执和演示记录不能补造为未采集的中间云轨迹。

## 审批后的第一条真实链路

按 [部署与验收手册](../docs/agentarts/deployment.md) 使用已有或明确批准的 SWR/Runtime/LTS 资源。首次固定 ARM64 镜像 digest、Runtime 版本和单版本 alias，使用 HTTP/8080 与 API_KEY 认证。控制端只需 `contents: read`、`pull-requests: write`；敏感值分别存入 Controller 和 supervisor，不进部署 JSON、镜像、任务 body 或 Demo。

可先离线检查本地部署配置：

```bash
node agentarts/preflight.mjs --config /absolute/path/to/deployment-config.json
```

格式见 [deployment-config.example.json](examples/deployment-config.example.json)。预检只验证文件/参数以及环境变量名称是否存在；不读取 key 值、不调用云 API、不启动容器、不创建资源。可选的本地镜像检查仅查询元数据。通过不代表 key、云权限、SWR 拉取或 alias 映射已验证。

Action 入口：[action.yml](action.yml)；受信自用 workflow：[pr-review.yml](examples/pr-review.yml)。只构建 `github.workflow_sha` 的受信代码，不 checkout/执行 PR head。先确认云安全和清理，再用新仓库的维护者 PR 实跑；平台日志、实际 DSH/工具、控制端校验和 GitHub 评论必须对应同一任务。结果与清理状态分别记录。

## 来源与维护

事件/权限、不可变 GitHub 数据、DSH Profile/launcher/代理、结果协议、审查过滤/publisher、原loop/finalizers和通用测试来自 [原项目](https://github.com/Lixiaoyiao/deepseek-harness-action)。新增部分为 `src/agentarts/`、本目录工具与文档/测试；上游局部调整包括受信engine/admission接口、UID/GID参数与无PR workflow_run固定CI commit，修改来源和验证单独记录。许可证和第三方声明保留在根目录。

维护关系为 `DSH 官方 → 原 Action 已验证更新 → 本衍生版`。基线见 [upstream-lock.json](upstream-lock.json)，按 [更新说明](../docs/agentarts/maintenance.md) 在独立分支人工升级，不追 latest。Gateway/MCP、平台评分、write/native/extensions/session未接云端；只读v2的本轮证据及原能力适配条件见 [能力迁移表](../docs/agentarts/capability-matrix.md)。开发工具、各次实际验证和未知项见 [验证记录](../docs/agentarts/verification.md)；赛事整理见 [ICT 对照](../docs/agentarts/ict-track2.md)。
