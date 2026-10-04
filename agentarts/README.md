# Huawei-AgentArts-action

将 DeepSeek Harness（DSH）托管到华为云 AgentArts 的 GitHub Action 衍生项目。保留原项目的事件授权、不可变上下文、结构化结果检查和 GitHub 审查发布，不另建 Agent 平台。

**当前支持 PR Review。云端真实验收尚未完成，不能据此宣称生产可用。** 本地可运行真实锁定版本 DSH；确定性模型服务、模拟 GitHub、Linux 隔离和真实云端分别记录。CI 修复、Issue→PR、Gateway/MCP 和平台评估属于后续阶段，本版本不开放这些云端能力。

## 第一条链路

```text
真实 GitHub PR 事件
  → GitHub Actions 受信 Controller：路由、权限、API 获取绑定 head/base 的上下文
  → AgentArts Runtime：独立 Session、root supervisor、run-scoped 模型代理
  → UID/GID 10001 的 DSH：只读文本工作区、固定 read/search 工具
  → JSON 审查结果、实际工具回执、工作区摘要
  → Controller：任务/仓库/提交/结果/工具复核，重新查询 PR 当前状态
  → 原 publisher：高置信度过滤、diff 锚点、bot 所有权、评论去重
```

DSH 固定为 `0.2.0-rc.2`，默认继续使用 DeepSeek。GitHub token 与 Runtime API Key 仅在 GitHub 控制端；真实模型 key 在 Runtime 的受信 supervisor 中，经原 `startDeepSeekProxy` 替换成任务代理 token 后供 DSH 使用。模型 key 不经过任务 body，不进入 DSH 环境、argv 或仓库文件。云端 supervisor 是新增受信组件，不能把平台会话隔离等同于它与 DSH 的进程隔离。

代码上下文采用 Controller 已经从 GitHub API 获取并限长的改动文件文本与可选 `context-files`；传输最多 1 MiB 文本/500 文件，整个任务最多 2 MiB。这里没有完整 clone，也没有 `.git`、符号链接或仓库启动脚本。上下文截断标记保留；缺失证据不能解释成完整审查。Fork 按原权限判断只传有界上下文，不装载文件、不开放工具。

审查不执行代码和测试，不接受补丁、修改计划、模型测试声明或控制端工具请求。Runtime 独立确认工作区未变化；Controller 独立检查结果协议和绑定，publisher 写前复查 PR。授权、Runtime 或独立验证失败均不进入发布。发布 API 中途失败时，记录已发生的评论和失败原因，重跑仍检查原评论指纹。评论本身仍是模型建议，不构成“代码已证明正确”。

## 本地复现

需要 Node.js 24、npm、Git。不需要 Python SDK。

```bash
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run test:agentarts
npm test -- --maxWorkers=2
npm run build:agentarts
npm run prove:local
node agentarts/demo/serve.mjs --record /absolute/path/to/agentarts/evidence/local-run-record.json
```

`prove:local` 真正启动原 DSH Profile/Bundle、原 HTTP 模型代理和只读工具，并通过本地 HTTP Runtime 合约返回结果。它采用确定性模型响应和模拟 PR 数据，验证协议、工具执行与独立检查；没有真实模型效果、云端或 GitHub 发布证据。Windows 下显式使用仅限测试的 UID 隔离豁免。Linux root 可运行 `node dist-agentarts/local-proof/index.js --linux-isolation` 验证不同 UID 的凭证/文件边界；这仍不是容器或云端验证。

生产最终镜像另有 [AMD64 容器 CI 实际通过记录](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37186465878)：真实 DSH、独立 UID、read 回执、重复任务拒绝和超时后子进程清理均已检查，模型与 PR 仍为夹具。双架构及云端状态以 [验证记录](../docs/agentarts/verification.md) 为准。演示步骤见 [Demo 指南](../docs/agentarts/demo-guide.md)。

Demo 在 `http://127.0.0.1:4173`。默认空白，可导入 JSON；文件导入显示“历史回放”。通过 `--record` 读取实际更新的记录，不用动画推测执行进度。工具显示的是已接收到的回执，后台任务内部不会凭空生成实时步骤。

## 部署

先阅读 [官方能力调查](../docs/agentarts/research.md)，尤其是容器架构、认证、元数据委托与观测限制。准备已有或明确批准创建的 SWR、AgentArts 高代码 Runtime、允许出站访问 DeepSeek 的网络，以及日志访问权限。

1. 在 Linux Docker/buildx 环境构建镜像。基础 Node 镜像与 npm 依赖都已固定；最终部署也要绑定 SWR 镜像 digest。

   ```bash
   docker buildx build --platform linux/arm64 -f agentarts/Dockerfile -t huawei-agentarts-action:review-v1 --load .
   ```

   本地执行 ARM64 需要同架构设备或已配置的模拟器。x86_64 是否可选以租户 Runtime 创建页/API 为准，不能根据文档矛盾直接假定兼容。

2. 推送到批准使用的 SWR 路径。不要在镜像构建参数、Dockerfile 或仓库中放 key。创建 Runtime，使用 HTTP、标准精确路径、API_KEY 入站认证，监听 `0.0.0.0:8080`。
3. 为 supervisor 配置敏感环境变量 `DEEPSEEK_API_KEY`；可选 `DEEPSEEK_BASE_URL` 只能由受信操作者指定。Runtime 必须支持 root supervisor 降权到 UID/GID 10001，以及 `CHOWN`、`DAC_OVERRIDE`、`KILL`、`SETGID`、`SETUID`；不支持时任务失败，不能开启测试豁免上线。避免向 Runtime 委托不需要的云权限；检查元数据临时凭证入口。
4. 设置会话最大时长与空闲清理策略。项目 Controller 最多 10 分钟，DSH 留出 15 秒供独立检查/发布；Runtime 自己也有硬截止时间。平台普通 HTTP 硬超时尚未确认，真实租户必须实测。
5. 保存已验证的版本，建立显式版本访问方式（例如 `review-v1`），固定它对应的版本和镜像 digest。代码拒绝 `Latest`；操作者也不得悄悄移动这个 alias。
6. 在**新仓库**加入 [PR Review workflow 示例](examples/pr-review.yml)。配置 Variables：`AGENTARTS_RUNTIME_ORIGIN`、`AGENTARTS_RUNTIME_NAME`、`AGENTARTS_RUNTIME_ENDPOINT`；Secret：`AGENTARTS_RUNTIME_API_KEY`。模型 key 不放在 GitHub 任务输入中。GitHub token 只需 `contents: read`、`pull-requests: write`。
7. 在新仓库创建含已知 bug 的真实 PR；记录 workflow SHA、head/base、Runtime 版本/digest、DSH 版本、taskId/Session ID、日志和 GitHub 评论链接。重跑验证不重复评论，再跑过期 head、拒绝、超时和取消场景。按 [业务评测](../docs/agentarts/evaluation.md) 独立验收。

入口是 `./agentarts`。本地 workflow 只 checkout 不带凭证的 `github.workflow_sha`，从受信代码构建 bundle 后执行；没有 checkout 或执行 PR head。公开仓库是 [Lixiaoyiao/Huawei-AgentArts-action](https://github.com/Lixiaoyiao/Huawei-AgentArts-action)，当前为未完成云验收的开发版本。Controller bundle 已纳入 Git，其他仓库可以将 `Lixiaoyiao/Huawei-AgentArts-action/agentarts@<完整 commit>` 固定到明确的开发 commit 做验收；正式使用需固定到通过云端验收的 release commit，不能直接跟 main/latest。Runtime 镜像仍按源代码独立构建并固定 digest。

## 超时、重试与清理

Runtime 每个实例只接受一个活动审查；同实例已接受的 taskId 不重放。客户端不自动重试不确定的 POST，固定任务 Session；结束或失败后请求官方 `sessions-stop`。断开连接会取消 worker；云代理可能不传递断开，因此 worker 的硬截止时间仍独立生效。云端只读、无 GitHub 凭证，即使迟到完成也不能自己发布。Controller 在取消/截止后不进入 finalizer。

同实例去重不是跨重启的持久幂等数据库；本版本以不重试调用、串行 workflow 与原评论指纹共同约束效果。人工重跑仍重新授权和绑定当前 commit。`sessions-stop` 是最多 5 秒的尽力清理，失败不覆盖已经确认的 GitHub 结果；云端验收要查实际会话清理记录。

结束实验时先停用新仓库 workflow/移除调用 Secret，撤销 API Key 和模型 key，停止遗留 Session，再删除批准清理的 Runtime 版本/访问方式、专属 SWR 镜像、专属日志与观测资源。共享 VPC、委托、日志组和 registry 不能随实验一起删除。Runtime、日志、网络、SWR、模型调用的费用以账户实际账单为准，本版没有可靠成本统计。

## 观测、评估与后续工具

Runtime stdout 输出实际任务生命周期和工具回执的精简 JSON，可在日志中用 taskId/head SHA 关联 Controller 的 `run-record` artifact。记录不包含代码正文或 key。它不是完整 OTel Trace；官方当前 Runtime 观测指南只保证日志。Gateway/MCP 下一步可以接中心化的、只读的仓库审查规范工具；在真实配置及权限验证完成前不声称接入。

AgentArts 离线评估可作为轨迹质量的附加证据，不能替代 bug oracle、拒绝/停止行为或修复语义验收。在线评估的外部目标支持有文档限制。评测目前以可复现业务场景与实际断言为准，不编成功率，不把模拟响应当模型能力结果。

## 来源与维护

- 原 Controller、DSH launcher、Profile/Bundle、凭证代理、GitHub publisher、权限与通用测试来自 [deepseek-harness-action](https://github.com/Lixiaoyiao/deepseek-harness-action)。
- 本次新增 `src/agentarts/`、`agentarts/`、相应测试和调查/评测/维护说明。原代码只增加受信入口的 engine/admission 注入和进程 UID/GID 参数。
- MIT `LICENSE`、`THIRD_PARTY_NOTICES.md`、`BUNDLED_DEPENDENCIES.md` 保留。Git 历史与 `upstream` remote 保留，原远程仓库没有写入。
- 基线见 [upstream-lock.json](upstream-lock.json)；跟进 `DSH 官方 → 原 Action → 衍生版`，按 [更新说明](../docs/agentarts/maintenance.md) 人工升级，不直接追 `latest`。
- 开发使用 Codex、并行审查助手、Git/npm/TypeScript/Vitest、官方文档检索；实际测试状态在 [验证记录](../docs/agentarts/verification.md)。

根目录原 `action.yml`、installer、旧 examples 和文档作为共同历史/回归材料保留，属于上游接口。本衍生版对外支持的路径仅为 `agentarts/action.yml`；继承的自动化需显式禁用，不把上游本地模式的运行记录当 AgentArts 证据。
