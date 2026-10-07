# AgentArts 上的 DeepSeek Harness Action

这是原 Action 的完整能力迁移，PR Review 仍是第一条真实云验收链路。当前主入口复用原 `runAction`，将 DSH engine 接到 Runtime v3；事件解析、授权、工具回调、独立验证与发布继续使用原 Controller。账号准入待审批，没有真实 AgentArts 或 GitHub 发布验收。[能力表](../docs/agentarts/capability-matrix.md) 逐项列出代码接入、实测范围和待验条件；历史只读证据不代表本轮新代码通过。

```text
GitHub 事件 → Controller 授权、实体/ref/提交绑定、原上下文与工作区
            → Runtime supervisor → 隔离 namespace 中的原 DSH
            → 结果、实际工具回执、实际文件 delta、DSH checkpoint
            → Controller 独立检查、工具反馈/测试 → 原 GitHub finalizer
```

## 当前主链路

生产server默认只接v3。v1/v2源码和旧评测保留，只有操作者显式设置`AGENTARTS_ENABLE_LEGACY_PROTOCOLS=true`才允许历史benchmark；旧协议隔离较弱，不作为部署入口或新能力证据。`prove:local`为历史Review复现显式启用该兼容路径；新主Action不会设置此flag。

五种原 operation 都由 [AgentArtsFullEngine](../src/agentarts/engine-full.ts) 进入 [Runtime v3](../src/agentarts/runtime-task-protocol.ts)：`review`、`task`（read/write）、`diagnose`、`fix`、`implement`。原 command auto/mention、label/assignee/actor、自动化/CI 路由、prompt-file/context-files、typed taskOutput、progress/check/output 参数由原输入解析与授权处理。[当前 Action](action.yml) 由原 contract 生成，模型 key、DSH 版本/可执行文件、隔离和代理 origin 由受信 Runtime 管理，不能作为 Action 输入覆盖。

原 loop 保留多轮工具反馈和验证失败后的修复；每轮单独固定 taskId、operation identity、entity/ref、base/head、revision、有效工具/扩展权限摘要、输入工作区摘要和 taskDigest。Controller 原命令与 typed GitHub 工具仍在 Controller 执行，模型只请求已授 catalog 工具；Runtime 执行原 DSH 原生工具和经批准的扩展。GitHub 写 token 始终不进 Runtime。

受信任务使用原准备好的工作区完整文件集，不再仅传改动文件。工作区清单最多16 MiB编码、128 MiB解压累计、5000文件；支持原bytes的UTF-8/base64与有界gzip-base64，拒绝.git、链接、特殊文件、别名冲突和超限，generated node_modules不传。整个 v3 HTTP body最多32 MiB、单次最多30分钟；这些是本项目上限，不是 AgentArts 平台承诺。Controller 总截止、平台请求/生命周期上限仍需共同满足。fork等不可信任务继续只有有界上下文，不获文件、工具、扩展或Session。

DSH 停止后 supervisor 从实际文件捕获 delta；Controller 检查原SHA/mode、保护路径、source baseline、任务/权限/ref/revision/digest和凭据边界，stage后事务交换workerRoot。取消、截止、重复/迟到结果或导入失败会阻断finalizer。模型的changePlan和测试通过声明不代替内容或验收。原独立无凭据Docker测试、strict完整性分类/baseline replay、PR head/Issue指纹/base复查、部分效果与GitHub reconciliation继续由Controller完成。

controlled/native 都复用原Profile、Bundle和launcher。生产必须有bwrap、必要Linux namespace与固定seccomp策略，不能降级为只换UID的宿主执行。Runtime supervisor仅保留CHOWN、DAC_OVERRIDE、KILL、SETGID、SETUID五项cap；worker UID/GID10001、cap为空、新namespace创建被额外BPF限制，模型经Unix socket代理。没有Docker-in-Docker、Docker socket或privileged模式。网络扩展须由操作者配置精确origin的受信egress代理，默认关闭并拒私网/元数据地址；任意子进程不保证遵循代理，不能以授network权限声称已兼容所有联网工具。

原 DSH Session 使用原checkpoint格式、binding/provenance检查与artifact store：Controller restore后导出安全metadata与限长历史，Runtime在固定`/workspace`保存/恢复，返回严格checkpoint后导入Controller，再走原save。不会用AgentArts Session取代DSH历史，不恢复旧工作区、旧权限或重放旧工具。正文含已知secret、附件/不可移植内容、改写历史、摘要或provenance错误都拒绝。

| 位置               | 真实凭据与职责                                                                      |
| ------------------ | ----------------------------------------------------------------------------------- |
| GitHub Controller  | GitHub token、Runtime入站API Key；授权、原工具、独立测试、发布、DSH artifact存储    |
| Runtime supervisor | 模型key和受信出站策略；原模型代理、封闭worker环境、namespace、工具/文件/Session收集 |
| DSH及仓库代码      | 任务代理token和当前获准工作区/工具；没有GitHub、Runtime或真实模型key                |

MCP/plugins的原定义、安装锁、受控/native组合已接入代码；任务中明文secret仍拒绝。[监督进程MCP代理](../src/agentarts/mcp-credential-bridge.ts)支持固定HTTPS endpoint、独立只读凭据、当前grant交集/预算、POST与有限SSE；key不进Profile/worker/模型，回显key阻断整次结果。OAuth、长订阅、凭据stdio/直接Plugin配置尚无通用代理适配。配置见 [部署手册](../docs/agentarts/deployment.md#31-可选的只读-mcp-凭据代理)。原MCP接入与华为Gateway/MCP服务是两件事；后者仍未配置或验收，平台评分未接入，不用本地日志冒充平台Trace。

## 本地开发与验证

需要Node.js24.15.0、npm、Git；完整生产运行另需要Linux与Docker/bwrap。以下不调用华为或真实模型：

```bash
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run test:agentarts
npm run build:agentarts
npm test -- --maxWorkers=2
```

Session真实save→resume的确定性模型测试在Linux root且namespace可用时执行；Windows按平台条件跳过：

```bash
npx vitest run test/agentarts-session-runtime.test.ts --maxWorkers=1
```

原只读Review小闭环仍可复现，但它不是v3全部能力证明：

```bash
npm run prove:local -- --out /absolute/path/to/work/review-proof-new.json
node agentarts/demo/serve.mjs --record /absolute/path/to/work/review-proof-new.json
```

命令经过本地HTTP、真实DSH和Controller检查，模型/PR为夹具；Windows使用显式测试UID豁免。选新输出路径，避免覆盖历史记录。生产镜像、真实模型预算和安全key挂载按 [部署手册](../docs/agentarts/deployment.md)，实测日志与新源码范围见 [验证记录](../docs/agentarts/verification.md)。旧双架构read-only CI不能替代新namespace/full-task镜像验证。

Demo只读实际记录，导入/静态导出标为历史回放，不触发任务；浏览器无key。多轮记录汇总回执，但Runtime/session/requestId当前保留最后一轮，非完整平台Trace。[Demo指南](../docs/agentarts/demo-guide.md) 说明安全导出与标签。

## 安装与第一条云验收

[新安装入口](install.mjs) 复用原review/commands模板、权限、明确test argv/镜像digest和不覆盖逻辑。先核对已发布commit，再在目标仓库运行：

```bash
node /absolute/path/to/Huawei-AgentArts-action/agentarts/install.mjs \
  --action-ref <published-40-character-commit> --mode review
```

commands/both还需受信验证argv与固定测试镜像；省略验证argv会保留原失败占位，不读取package scripts猜测试：

```bash
node /absolute/path/to/Huawei-AgentArts-action/agentarts/install.mjs \
  --action-ref <published-40-character-commit> --mode both \
  --test-commands '[["node","--test"]]' \
  --container-image '<validation-image>@sha256:<64-character-digest>'
```

安装器离线生成workflow，不配置key、不开资源、不调用模型/GitHub。配置Runtime三个Variables与Controller Secret，审查生成的权限/测试；`--dsh-mode native`支持原模板选择，但须先通过对应生产环境验收。不要先启用写工作流再检查云安全。

[部署与验收手册](../docs/agentarts/deployment.md) 先验证固定镜像/alias、API_KEY、namespace/caps/seccomp、网络、超时/取消/清理与日志，再用维护者小PR实跑Review。实际事件、Runtime/DSH/tool、Controller检查和GitHub结果须对应同一任务；其余operation逐项保存独立证据。创建远程资源、开付费服务或公开托管须按用户授权执行。

## 来源与维护

GitHub事件/权限、工作区、原DSH compositions/launcher/代理、结果协议、loop、验证、finalizers、Session artifacts、安装器模板及通用测试来自 [原项目](https://github.com/Lixiaoyiao/deepseek-harness-action)。新增Runtime transport、受检workspace/Session传输、namespace/出站代理、安装入口、Demo/评测和文档在本衍生仓库维护；上游局部接口调整保留来源与测试。[许可](../LICENSE) 和 [第三方声明](../THIRD_PARTY_NOTICES.md) 包含派生的Moby seccomp策略。

维护关系为 `DSH官方 → 原Action已验证更新 → 本衍生版`；[upstream-lock.json](upstream-lock.json) 固定基线，按 [维护手册](../docs/agentarts/maintenance.md) 人工开独立升级分支，不追latest、不重复各自追DSH。能力、剩余平台依赖和证据见 [迁移表](../docs/agentarts/capability-matrix.md) 与 [验证记录](../docs/agentarts/verification.md)。
