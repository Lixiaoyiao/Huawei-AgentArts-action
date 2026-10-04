# 原能力迁移表

核对日期：2026-10-04。目标是原 `deepseek-harness-action` 的完整 AgentArts 迁移版，PR Review 是第一条验收链路。共同历史和完整原实现保留；本表不把“文件仍在”当成“云端已经支持”。基线为 [upstream-lock.json](../../agentarts/upstream-lock.json) 的 `891570ef2254334dff8de22af948f3f0105e933e`，DSH `0.2.0-rc.2`。

这里的“已接入”指当前 AgentArts 入口已调用相应真实实现，本地/生产镜像证据范围见 [验证记录](verification.md)；全部真实云端能力仍未验收。账号准入审批中，本轮正式推送已获授权，尚未创建云资源或完成真实平台验收。

| 状态           | 含义                                                         |
| -------------- | ------------------------------------------------------------ |
| 已接入         | 当前 AgentArts Controller/Runtime 实际使用；云端验收另记     |
| 接入待验       | 本轮新增迁移代码，主入口/HTTP与本地验证状态仍需明确确认      |
| 保留未接入     | 上游源码、测试或例子完整保留，云入口尚未允许/适配            |
| 平台依赖待验证 | 实现或路线需真实租户能力/安全边界才能完成，不能宣称不可行    |
| 已确认平台限制 | 有当前官方文档明确依据，见末节；不把当前项目限制误称平台限制 |

## Operation 与触发

源码 operation 是 `task`、`review`、`diagnose`、`fix`、`implement` 五种，`auto` 只是路由输入，不是第六种 operation。[命令解析](../../src/commands/parse.ts)、[路由](../../src/commands/router.ts)、[上下文状态机](../../src/orchestration/context.ts)。

| 原能力                                         | 原实现与真实行为                                                                                      | 迁移状态与验收条件                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review`                                       | PR diff/文件、精度过滤、行映射、摘要/inline 评论和 fingerprint 去重；写前复核 head                    | **已接入**。本地AMD64生产容器/真实DeepSeek四个固定案例通过自动rubric，共8次provider请求；合成PR无GitHub发布，人工未复核。云入口只读、单次DSH turn；真实云端工具/评论/日志/清理仍待验收                                                               |
| `task --read`                                  | Issue/PR 问答或受信自动化任务；可返回维护者 schema 约束的 `taskOutput`，无修改时发答复                | **v2代码已接入，最新本地双架构生产HTTP/DSH/read/typed output通过**。只传changedFiles.source/context-files，Issue/repository默认可能只有任务文本；文件问答需context-files，read/search不等于全仓访问。云端/真实GitHub未验收                           |
| `diagnose`                                     | 读取绑定 head 的 check-runs/失败 jobs/限长日志；日志标为不可信数据；发布限长诊断                      | **v2代码已接入，最新本地双架构生产HTTP/DSH/read通过**。原 [CI evidence](../../src/github/checks.ts)/[诊断](../../src/ci/diagnose.ts)/[发布](../../src/commands/diagnose.ts) 留在Controller；模型只获限长不可信日志，不获下载日志的凭据或GitHub写凭据 |
| `fix`                                          | 同仓库 PR 的真实工作区变更，经独立测试后由 Controller API 提交到其绑定 head branch                    | **保留未接入，写传输待适配**。必须验证实际变更、测试定义、当前 head、commit/ref 与不确定写入的协调                                                                                                                                                   |
| `implement`                                    | Issue 身份/内容指纹与固定 baseSha 绑定；Controller 创建确定性分支、commit 和带 operation marker 的 PR | **保留未接入，写传输待适配**。复用 [实现 finalizer](../../src/commands/implement.ts) 和 [ownership/reconciliation](../../src/write/implementation.ts)，Issue 更新/base 移动必须阻断旧结果                                                            |
| `task --write`                                 | 仍需 allow-write/actor/fork 等授权；PR 可提交，Issue 或 automation 可创建 PR；无变更时普通答复        | **保留未接入，写传输待适配**。原 [task finalizer](../../src/commands/task.ts)/[operation identity](../../src/write/task.ts) 保留，不把通用 task 简化成 implement 的别名                                                                              |
| 自动 PR 审查                                   | `opened`/`synchronize`/`ready_for_review`/`reopened`                                                  | **已接入**当前 PR 示例；其他 workflow 组合逐项核对                                                                                                                                                                                                   |
| 精确首行 mention                               | Issue comment、review、review-comment 的 `@dsh`；正文/代码/日志不会被命令解析器重新解析               | **review/task/diagnose路由已接入源码**；write仍拒绝，真实mention/GitHub/云场景待验，触发不授权限                                                                                                                                                     |
| label/assignee、actor 过滤                     | PR 路由 review，Issue 路由 task；路由过滤不授予写权限                                                 | **保留未暴露参数**。当前云Action保留默认actor检查并暴露有限只读输入；不虚构label/assignee配置或全部旧参数兼容                                                                                                                                        |
| workflow_dispatch/repository_dispatch/schedule | 维护者 prompt/prompt-file 自动路由 task                                                               | 只读task的**prompt路径已接入源码**；prompt-file参数未暴露。固定base/默认分支及真实automation场景待验                                                                                                                                                 |
| workflow_run                                   | 完成失败 run 自动 diagnose；明确 allow-write 可 fix，未解析同仓 PR 的 fix 降为 diagnose               | 只读diagnose路径**已接入源码**；云fix仍拒绝。无PR诊断代码/文本改为固定workflowRun.headSha，PR仍head优先；真实run/actor/GitHub场景待验                                                                                                                |

原支持十类事件：`issues`、`issue_comment`、`pull_request`、`pull_request_target`、`pull_request_review`、`pull_request_review_comment`、`workflow_dispatch`、`repository_dispatch`、`schedule`、`workflow_run`。[事件清单](../../src/github/events.ts)、[实体解析](../../src/github/context.ts)。本轮新增只读 task/diagnose 的 v2 binding/protocol；支持解析某事件或拥有 engine 类不等于整条主入口/HTTP/业务链路已验证。[当前 admission/Review engine](../../src/agentarts/engine.ts)、[v2 engine](../../src/agentarts/engine-task.ts)、[当前 Action](../../agentarts/action.yml)。

### 本轮 v2 的执行位置

最新AMD64（clean源码 `cd9ce8e`）和ARM64 QEMU（clean源码 `60b7e95`）生产容器，各通过9个运行场景与2项启动拒绝，包括真实DSH v2 read/typed task/diagnose，构建输入摘要相同；两次source commit、实际image/manifest ID与原始记录分别见 [验证记录](verification.md)。QEMU不是原生ARM/云，较早d9和历史CI保留原范围，不替代本次验证。Controller工具反馈测试使用原loop配合注入transport/provider，不能算真实云/GitHub回调验收。

最终真实DeepSeek Review套件 `3a0614e9` 在上述AMD64镜像四个固定case均通过自动rubric，每例2次provider请求，共8次；人工仍not-reviewed、实际成本unknown，合成PR没有GitHub发布或AgentArts调用。首次WORKER_FAILED、诊断轮roles-clean失败与单例复测均在 [评测](evaluation.md) 原字节保留，不以后续通过推定旧失败根因；不能将自动规则通过推广为业务成功率或云端闭环通过。

Review 保持 v1 单次只读协议。v2 task/diagnose 将实际 DSH `needs_tool` 返回给既有 `runAgentLoop`，由 Controller 验证 grant、空 input 与 immutable identity，再调用原 toolProvider，把有界不可信反馈交给后续 DSH turn。`command.*` 的 argv/实现、`github.checks.read` 的 GitHub API 和真实凭据均留在 Controller，未搬到 Runtime、Gateway 或 MCP。v2 task digest 包括规范化任务、工具 grant、上下文与可信 output schema；结果须与它及仓库/实体/base/head/只读工作区同时匹配。[v2 协议](../../src/agentarts/readonly-task-protocol.ts)。

这不是给只读任务新的执行权限。原 `evaluatePolicy` 的普通 read 分支未授予 `executeRepositoryCode`，原 registry 因而不默认授予 `command.*`；协议可传已准入 command 不等于任意 read task 能执行仓库命令。`github.checks.read` 也需原 CI capability、当前实体 binding 和 provider 可用。write grant、模型 argv/target/ref/key、未授予工具和测试/修改声明仍拒绝；`fix`/`implement`/`task --write` 不会因 v2 打开。

## DSH、工具与状态

| 原机制                                 | 原实现/边界                                                                                                                                | 迁移状态                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 固定 DSH、官方 headless 启动、模型代理 | DSH `0.2.0-rc.2`；真实 key 留代理；DSH 只拿一次性 token                                                                                    | **已接入**原 Profile/launcher/proxy，Runtime supervisor 持模型 key。云元数据/出站边界待验                                                                                     |
| controlled composition                 | Controller owns effective grants；strict/standard/custom、显式 deny、调用预算、完整回执                                                    | **已接入受限只读组合**。当前仅 read/search；edit/bash/web/subagent 和其他 profiles 未接入                                                                                     |
| native composition                     | 官方 headless Profile、DSH owns inventory；观察 `observedTools`，不冒充 Controller grant；仍有外层隔离/权限/验证                           | **保留未接入**。`src/dsh/native-composition.ts` 完整保留；是否复用或调整云适配须独立审计，不直接开放整个 graph                                                                |
| 原 Docker/host isolation               | Docker 用于不可信输入、写、扩展；`none` 只保留受信读兼容，无 OS/container 边界                                                             | **原实现保留**。AgentArts 改为平台外层容器 + supervisor/worker UID，host `none` 不是云替代方案；无需维持所有旧启动参数                                                        |
| `workspace.read/search/edit`           | 官方 DSH 工具，路径/权限/预算受 Action Profile/sandbox 限制                                                                                | read/search **已接入**；edit **保留未接入**，真实文件变更返回与 Controller 检查须先完成                                                                                       |
| `native.bash/web-search/subagent`      | 显式可信权限、worker 网络/工作区边界；命令执行和 mediated web 存在专门限制                                                                 | **保留未接入、平台边界待验证**。不能将“平台托管”当作已安全开放 shell/网络的证据                                                                                               |
| `command.*`                            | 维护者固定 argv，模型输入空对象；无 Controller 凭据的独立 Docker 执行                                                                      | **v2 catalog/request 接入待验**；实际执行仍在原 Controller，read policy 不默认授予。Runtime 不接收 argv/实现或 Docker socket                                                  |
| typed `github.*`                       | labels/assignees/state/comment/pull metadata/checks；实体/ref由受信 Controller 定，mutation 延迟至独立验证后 flush                         | `github.checks.read` **v2 接入待验**；mutation 全部**保留未接入**。继续复用 [authority gateway](../../src/tools/github-authority-gateway.ts)，写 key 不进 Runtime/Gateway/MCP |
| controlled MCP                         | 官方 DSH MCP client；精确工具和预算；受信配置 stdio/HTTP、独立扩展准入与回执                                                               | **保留未接入**。平台 Gateway/MCP 只在有具体业务价值且重新审计凭据/授权后适配                                                                                                  |
| Bundle/Plugin 与 native MCP            | exact package/Git commit pin、禁 lifecycle script、runtime inventory/lock 审计；第三方启动代码属于受信代码                                 | **保留未接入**。云构建/供应链、启动权限/进程网络/凭据边界待验证，当前镜像不加载第三方扩展                                                                                     |
| Skills/Subagent/Workflow               | native 使用 DSH graph 原行为；controlled 禁止仓库指令自动成为权限，依受信组合授予能力                                                      | **保留未接入 native 部分**。不能自动执行仓库 `.agents`/`.dsh` 指令，也不额外设计多 Agent 产品                                                                                 |
| fresh turns 与工具反馈                 | `needs_tool` 通过 Controller provider；有界不可信反馈；固定 deadline、max-turns，validation failure 可返回 fresh turn                      | v2 只读 task/diagnose 的 **工具请求多轮接入待验**；Review 仍单 turn。写后 validation repair **保留未接入**，不由本轮回调开放                                                  |
| malformed output repair                | 原 runner 可经同一代理对终态做有界格式修复，不提升工具权限                                                                                 | **保留未接入当前云 worker**，当前严格格式失败即停。若接入须单独记录该真实请求与耗时                                                                                           |
| DSH Session save/resume                | 显式 off/save/resume；完整原 DSH checkpoint + 有界 provenance；验证维护者工作流、Actions artifact、tool/runtime/task binding，重新计算授权 | **保留未接入，状态传输待审计**。AgentArts Session 用于平台沙箱亲和/停止，二者不是一个接口；不用平台共享存储偷换原 checkpoint 安全                                             |

依据：[composition](../../src/dsh/composition.ts)、[工具 IDs](../../src/tools/schema.ts)、[permission presets](../../src/permissions/profile.ts)、[扩展准入](../../src/extensions/plan.ts)、[安装完整性](../../src/dsh/install.ts)、[Session Controller](../../src/session/controller.ts)、[checkpoint](../../src/session/checkpoint.ts)。

## 工作区、验证、发布和维护

| 原机制                                | 当前保留/复用情况                                                                                                                             | 云迁移必须继续成立                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 不可变仓库数据                        | `materializeRepositoryAtSha` 固定 PR head 或 automation/Issue baseSha；复制 `.git`-less worker tree，拒绝 symlink/特殊文件，记录文件 SHA/mode | Review **已接入有界文本快照**。写任务需完整足够的受限上下文和传输，不以截断 Review 包代替仓库                                                   |
| 真正变更来源                          | `WorkspaceSnapshot` 的 added/modified/deleted 及真实 bytes；`changePlan` 只有 path/summary                                                    | 原机制**保留未接入云写**。返回内容须验证 path、baseline SHA/mode、task/ref、上限、symlink/新增文件/删除与漂移，再导入原 Controller snapshot     |
| 独立写前验证                          | 必须 run-tests=true 且至少一条非空维护者 argv；隔离复制、无真实 key 的固定 digest Docker、统一截止、失败阻断                                  | 原 [validation](../../src/write/validate.ts)**完整保留**。由受信 Controller 负责，Runtime/model 声明不代替；不需要在 Runtime 内嵌 Docker daemon |
| 测试定义完整性                        | off/warn/strict 审计变更，strict 必要时 replay baseline；检查 shell/依赖/工具链路径                                                           | 原 [integrity](../../src/write/validation-integrity.ts)**完整保留**。是否通过测试与是否正确修复分别验收                                         |
| Review publisher                      | confidence/evidence/category过滤、diff anchor、重复指纹、bot ownership/配额、当前 head 复查                                                   | **已接入**。未知写入结果可能已有部分效果；人工重跑须核对已有评论，不能承诺跨重启 exactly-once                                                   |
| 修复/PR创建 finalizers                | PR ref revalidation、GitHub Git 数据 API、确定性 branch、commit trailers/operation marker、失去响应后的 reconciliation                        | **完整保留未接云写**。只由 Controller 写，沿用 identity/验证/部分成功记录，不用模型 git push                                                    |
| 凭据、文本和注入边界                  | 环境白名单、代理、限长文本、secret redaction；Issue/PR/代码/日志/工具结果为不可信数据                                                         | Review **已接入**；云 UID≠网络隔离，元数据实际凭据入口仍需单独验收                                                                              |
| 生命周期与幂等                        | fixed overall deadline、SIGTERM/KILL、取消后禁止 finalizer；run/task/tool call identity；部分效果保留                                         | **已接入当前 Review** + 无盲重试 invocation/同实例 duplicate409；平台代理断开、stop、跨实例重启边界待验                                         |
| progress/check/status/result-json     | 原 sticky lifecycle comment、Actions step summary/check，结构化 policy/tools/validation/write/error                                           | **原机制保留**，当前云 Action 输出 result-json/run-record 与少量状态；progress 默认关闭，不冒充所有旧 output 完成迁移                           |
| prompt-file/context-files             | 维护者选 prompt revision 和文本路径；context只是资料；图片/Office传输上游已延期                                                               | `context-files` **已接入**，prompt-file **保留未接入**；不得按附件推断控制命令或补造多模态支持                                                  |
| installer/config checker/CLI examples | `packages/create-deepseek-harness-action` 与原 generated contract、离线配置 checker                                                           | **完整保留未改云入口**。旧安装器仍生成原 Action；新云预检独立、无密钥值/资源操作。发布方式后续再定                                              |
| upstream/releases/tests/license       | 原 history/upstream、通用测试、Action dist/installer契约和 notices；独立 AgentArts 新增目录                                                   | **已保留**。不自动 latest；同步原 Action 已验证 DSH 更新，华为变更/通用修复/无关重构分开                                                        |

源码：[工作区准备](../../src/orchestration/workspace.ts)、[文件快照](../../src/write/workspace.ts)、[Git 数据发布](../../src/write/github.ts)、[统一 finalizer](../../src/orchestration/write.ts)、[写前阶段](../../src/orchestration/agent-phase.ts)、[Review publisher](../../src/review/publisher.ts)、[原安装器](../../packages/create-deepseek-harness-action/README.md)、[维护流程](maintenance.md)。

### 本轮文件传输原型：代码存在，写入口仍关闭

[workspace-transfer.ts](../../src/agentarts/workspace-transfer.ts) 复用原 `WorkspaceSnapshot`/`inspectWorkspaceChanges`：`packWorkspaceSnapshot` 包含 workerRoot 的实际完整文件集，`materializeWorkspaceManifest` 建立受限云工作区；DSH 已停止后，`createWorkspaceDelta` 从真实文件捕获 added/modified/deleted，`applyWorkspaceDelta` 在 Controller 检查并安装结果。它不接受模型 `changePlan` 作为内容，不执行仓库代码、测试或 GitHub 发布。[针对性测试](../../test/agentarts-workspace-transfer.test.ts) 本轮Windows实际50通过/1跳过POSIX executable case，Linux51全部通过；完整回归范围见 [验证记录](verification.md)，不能把这项测试计作云fix通过。

默认整个序列化 manifest/delta 最多 1 MiB、500 files/changes，参数只能收紧，超限拒绝而不截断。这是本项目原型限制，不是 AgentArts 平台承诺。UTF-8/base64 用于完整原 bytes，SHA256 与 POSIX 低九位 mode 需对应；拒绝 `.git`、symlink/junction、特殊文件、hardlink、特殊 mode bits、路径别名/大小写/Unicode 重复和父子冲突。不静默丢掉 node_modules，但因原检查忽略 generated roots，它的修改拒绝。

utility 绑定 repository/baseSha/headSha/revision、inputDigest/resultDigest；**不含 taskId、Git ref 或完整授权**。正式 Controller 仍须把它纳入当前任务/实体/ref授权和写前复查，不能单独接到发布 API。导入先检查所有 original bytes SHA/mode、由受信调用方提供的 knownSecrets 及常见编码、当前输入摘要和可选精确路径 grant；它不会自动获取密钥或保证发现任意未知/混淆值。完整 stage 结果经上游 strict validation-integrity 分类后才同卷 rename 交换 workerRoot。sourceRoot/baseline 保留，测试与 finalizer 必须另执行；不能以分类通过声称修复正确。

Supervisor capture与Controller apply均复用上游 `assertWritablePath`，在安装前阻断workflow/actions/DSH/agents、CODEOWNERS、根action.yml、.gitmodules、dependabot和SECURITY等保护路径。sourceRoot实际bytes/mode也必须始终符合原snapshot.baseline：staging前、分类前、swap前均复查；任意added/modified/deleted漂移不安装，不只比对远端提交字符串。

此原型要求 Controller 独占、暂停使用的 workspace 生命周期，source/worker 互不嵌套；不承诺抵御外部进程并发持有文件句柄。安装失败尝试回滚，回滚失败保留原 backup 并抛错供人工恢复，不能继续发布。平台文件传输、失败恢复和真实写链路都尚未验收。

### 受控写迁移接缝：待接入，不开放写入口

源码审计确认最小路线仍沿用原 Controller：[`runAction` 的 `createEngine`](../../src/orchestrator.ts) → [`runAgentPhase`/`runAgentLoop`](../../src/orchestration/agent-phase.ts) → 云 `AgentEngine.runTurn` → 原写前验证与 `executeWrite`。云 engine 必须在返回前把受检的实际 delta 安装进当前 `WorkspaceSnapshot.workerRoot`；原 `sourceRoot`/`baseline` 不变。这样现有 finalizer 读取的仍是真实文件，不必再写一套 publisher、测试服务或公共SDK。以下是尚未实施的接入要求，不能据此称云fix已支持。

1. **先授权再打包。** 复用原 policy/actor/fork/allow-write 与 `assertWriteTaskConfiguration`；只有已准入同仓库写任务才从当前完整 workerRoot 调用 `packWorkspaceSnapshot`。外层请求/响应须严格绑定 Controller task/operation identity、entity类型与编号、repository/base/head、受信Git ref/PR身份、精确工具和可选路径grant、revision及inputDigest；还要校验resultDigest。现有utility只覆盖其中部分字段，不能由模型选择ref、授权或升级trust。固定测试argv与验证镜像digest留在Controller。
2. **仅把文件编辑搬到Runtime。** 首个fix只需受控原生read/search/edit，沿用原Profile、launcher、模型代理和独立UID；明确区分可写工作区与root拥有的Profile/监督进程/凭据。不同时开放Bash、plugins、session或GitHub写工具。DSH及其相关进程停止后，supervisor调用 `createWorkspaceDelta` 捕获真实bytes/mode、增加/修改/删除和结果摘要。模型的 `changePlan` 是描述，测试状态也只是声明，二者都不能代替返回内容或Controller验证。
3. **返回原loop之前完成导入。** 云 engine 先检查严格版本化envelope、任务/实体/ref/grant/revision/digest、实际工具回执及凭据泄漏，再调用 `applyWorkspaceDelta`。保留保护路径、source baseline、完整stage和rollback检查；导入完成后才返回output/metadata。若后续轮次请求Controller工具，它必须读到当前已受检工作区。下一轮重新打包当前workerRoot并推进revision，累计变更仍相对于原baseline；不靠恢复旧云Session保存文件状态。
4. **取消/截止不得遗留迟到导入。** 传输原型目前没有AbortSignal或deadline参数，正式engine接入要补齐导入前后检查与有界事务生命周期。不能用 `Promise.race` 返回超时后，让未等待的导入继续修改仍会被使用的工作区；stage/swap/rollback必须收敛，Controller才能清理或结束。取消、过期任务、安装/回滚失败均阻断finalizer。文件数/字节上限仍为全量拒绝，不能偷偷删文件或用Review截断文本包代替完整写工作区。
5. **导入分类不等于独立验证。** `applyWorkspaceDelta` 的strict仅执行分类门槛；它省略baselineReplay，不运行任何测试。正式结果仍经过原 `runAgentPhase` 的 `inspectValidationIntegrity`/`enforceValidationIntegrity`，strict下需要时使用baseline replay，再由 [`finishFix`](../../src/commands/fix.ts) 的 `runValidationCommandsInDocker`/`assertValidationSucceeded` 检查受信argv。测试运行在独立复制的无凭据验证工作区，测试改写的文件不能进入发布。原 [`runAgentLoop`](../../src/agent/loop.ts) 可把 `ValidationFailureError` 的有界不可信反馈交给下一轮修复，并保持统一截止/无进展阻断；模型“通过测试”不放宽这些检查。
6. **继续使用原GitHub写边界。** `finishFix` 在测试前、写前复查PR身份/head/ref，`createGitHubCommitFromWorkspace` 再查真实变更和保护路径，只有Controller token调用Git数据API。原 [`updateRemoteBranch`/`createRemoteBranch`](../../src/write/github.ts) 对失去响应的写入只读回核对精确目标；未知结果不能自动重发云任务或重复发布。写入已发生后保留partial-success及reconciliation，不把后续评论失败改成可盲重试的提交失败。Issue `implement`/写task随后分别复用原Issue内容指纹/base复查、确定性分支与operation marker，不能直接照搬PR fix的实体绑定。

最小后续验收用小仓库的同仓PR fix：完整包在当前上限内，先覆盖实际edit→delta→导入→受信Docker测试→原finalizer；独立验证错误delta、未授权/保护路径、测试失败、过期head、超时/取消、重复任务和失去写入响应均不会误写。测试通过与修复符合需求分别判定。先跑本地确定性模型与实际DSH，再按批准的真实模型/GitHub/AgentArts环境逐层留证；不同时扩展Issue→PR、native或MCP。当前main/admission/worker的拒写门槛仍有效，修改一个allow-write开关不算完成迁移。

## 已确认限制与尚未确认项

官方 HTTP/控制台当前写 ARM64、8080、`/ping`/`/invocations`；创建 API 又列 `arm64`/`x86_64`，所以首轮选择 ARM64，不能宣称平台普遍不支持 x86。API_KEY 身份创建后不能改。Latest 跟随最新版本，固定 alias 仍可管理移动。会话存储启用后不能关闭，FUSE 权限不保证 chmod/chown 生效，故第一阶段不挂载。SWR 基础版当前文档不支持 OCI v1.0/v1.1 镜像规格，上传前要核对媒体类型。[HTTP](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_070.html)、[创建 API](https://support.huaweicloud.com/api-agentarts/CreateCoreRuntime.html)、[认证](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_227.html)、[访问方式](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_048.html)、[会话](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_119.html)、[SWR](https://support.huaweicloud.com/usermanual-swr/swr_01_0011.html)。

**尚未确认**：目标租户五项 Linux capabilities、worker 对元数据凭据的可达性、DeepSeek 出站、普通 HTTP 任务总时限/断开传播、真实 SWR 拉取、固定 alias 映射、LTS 查询、Session stop 以及真实 GitHub 结果。本表不据此断言云写、native 或 MCP 不可行，也不以 Docker/QEMU通过代替平台验收。详细门槛见 [部署手册](deployment.md)。

## 迁移顺序与退出标准

1. 收尾并验收真实 PR Review：固定镜像/版本、真实 Runtime/DSH/tool、Controller 独立检查、GitHub评论、平台记录；失败/超时/取消能停。
2. 完成本轮 v2 的主入口/HTTP/真实 DSH 与原工具反馈验证，逐项适配 `task --read`、`diagnose` 的实体/automation/CI上下文和 finalizer，覆盖没有 PR 的任务；结果与 Review 旧 CI 分开记。
3. 先完成受控变更传输与 Controller snapshot 导入，保持独立测试与 integrity 边界；再分别适配 PR `fix`、Issue `implement` 与 `task --write`，验证重复/迟到/失去响应/过期实体均不误写。
4. 依实际使用逐项审计原 multi-turn/command/typed GitHub/native/extensions/session/installer能力。工具、运行模式、旧接口可为简洁维护合理调整；明确写出行为变化和替代路径，不只删除配置后声称全量迁移。

每一项都应有可运行代码、有界输入输出、拒绝路径、业务 oracle 与真实适用环境记录。完整迁移目标不等于同时开放所有能力；本轮仍优先完成第一条链路。
