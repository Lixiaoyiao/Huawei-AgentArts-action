# 原能力迁移表

核对日期：2026-10-07。目标是原 `deepseek-harness-action` 的完整AgentArts迁移版，PR Review仍是第一条真实云验收链路。共同历史和完整原实现保留；基线 [upstream-lock.json](../../agentarts/upstream-lock.json) 为 `891570ef2254334dff8de22af948f3f0105e933e`，DSH `0.2.0-rc.2`。账号准入待审批，真实AgentArts未验收；本地Runtime与真实GitHub审查发布已完成。

“代码接入”表示主Action实际选择原Controller加v3Runtime engine；不表示本轮新源码全部生产环境测试已完成。各次源码、镜像、实际模型/夹具与平台验收分别记录于 [verification.md](verification.md)。历史v1/v2只读镜像与四例真实模型评测保留原记录，不能继承为v3/native/write证据。

最新25b2072 clean AMD64镜像完成v3十四检查、七例真实DSH/DeepSeek与四份实际修复/隐藏合同；固定Git安装三例通过。真实本仓库PR的defect/clean审查、跨进程历史复用与过期head拒绝另有记录，人工仍未验收。[本轮结果](local-finish.md)逐项区分模拟、本地真实模型和真实GitHub；云端尚未通过。

原生Ubuntu两架构仍拒proc挂载，已交付最小无凭据诊断和宿主门槛；精确内核分支未查明，不将诊断job绿色记作Runtime通过。审批后先核对目标租户等价sandbox能力，不能满足就暂停该部署路线并评估安全备选，不新建资源硬试。历史09e/610证据仍在[验证记录](verification.md)，不会移记到新镜像。

## Operation、事件和输入

原operation为 `task`、`review`、`diagnose`、`fix`、`implement`，auto只负责路由。[命令解析](../../src/commands/parse.ts)、[路由](../../src/commands/router.ts)、[上下文状态机](../../src/orchestration/context.ts) 保留。

| 原能力                                      | 当前迁移实现                                                                | 当前边界/验收                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| PR `review`                                 | 原diff/精度过滤/行映射/publisher，通过v3 engine运行DSH                      | 本地真实模型及真实本仓库PR defect/clean发布通过；人工启动，非Actions/webhook/云验收            |
| `task --read`                               | 原Issue/PR/automation任务、typed taskOutput和答复finalizer                  | 代码接入；当前发送原准备工作区全部文件；不可信任务仍只有上下文                                 |
| `diagnose`                                  | 原head绑定check-runs/jobs/有界不可信日志，Controller工具请求/反馈与发布     | 代码接入；GitHub读凭据不进入Runtime；真实失败run、日志权限及云环境待验                         |
| PR `fix`                                    | v3真实编辑/delta导入后进入原验证/finishFix/API提交                          | 本地真实模型delta+独立Docker契约通过；仍需allow-write/原授权/固定head/ref，真实云/GitHub写待验 |
| Issue `implement`                           | v3工作区返回原finishImplement、Issue指纹/base复查、确定性branch/PR marker   | 代码接入；不把PR fix绑定替代Issue身份；真实创建PR待验                                          |
| `task --write`                              | 保留PR提交、Issue/automation创建PR和无变更答复的原task分支                  | 代码接入；原write policy、operation identity、验证和finalizer仍决定权限                        |
| 自动PR review、精确mention                  | 原opened/synchronize/ready/reopened；Issue/review/review-comment首行mention | 原路由直接复用；触发不授权限，正文/代码/日志不重新解释为命令                                   |
| label/assignee/actor、fork                  | 原过滤与政策；不可信fork只有bounded context，无工具/工作区/扩展/Session     | 参数恢复为原contract；真实事件组合逐项验收                                                     |
| dispatch/schedule/prompt-file/context-files | 原受信prompt修订、automation基线与附件文本选择                              | 参数/代码接入；不是任意GitHub数据成为控制指令；原未实现多模态仍未实现                          |
| workflow_run                                | 原失败run diagnose/明确授权fix；无同仓PR fix降diagnose                      | 无PR工作区固定workflowRun.headSha，PR仍head优先；真实run权限/行为待验                          |

原十类事件 `issues`、`issue_comment`、`pull_request`、`pull_request_target`、`pull_request_review`、`pull_request_review_comment`、`workflow_dispatch`、`repository_dispatch`、`schedule`、`workflow_run` 保留。[事件](../../src/github/events.ts)、[实体解析](../../src/github/context.ts)。

[inputs.ts](../../src/agentarts/inputs.ts) 从原Action contract选择输入；只排除由Runtime管理的模型key、DSH版本/可执行文件、isolation、模型/web-search origin，其余原参数进入原loadInputs。模型/隔离配置不能由请求覆盖。[当前Action](../../agentarts/action.yml) 自动生成；旧根Action和旧installer仍是原项目入口。

## DSH、工具、Session与运维

默认server仅准入v3。旧v1/v2仅在受信operator设置`AGENTARTS_ENABLE_LEGACY_PROTOCOLS=true`时用于历史bench/local-proof；它们原来只提供UID等较弱隔离，不继承v3 namespace保证，不是生产云入口。保留源码/证据不等于强制保留所有旧运行接口。

| 原能力                                       | 当前迁移实现                                                                                      | 仍需验收/限制                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| controlled Profile/Bundle/launcher           | Runtime调用原ControlledComposition和prepareLockedRuntimeFiles                                     | 固定DSH/lock；必须生产namespace，禁止降级宿主执行                                                                                                        |
| native composition/headless boot             | Runtime调用原NativeComposition、原结果提取和格式修复                                              | 原native内部工具库存由DSH负责；observed names是观测，非Controller授权；实际环境测试另记                                                                  |
| read/search/edit、bash、subagent、web search | 原工具plane/权限交集，namespace内执行原DSH工具；受控写仅获当前授权                                | bash/subagent须trusted-write；网络仅经模型/web-search或批准egress代理；子进程/工具是否支持代理逐项验证                                                   |
| Controller命令和typed GitHub工具             | 原catalog/ToolRuntime/loop执行，DSH返回已授tool request                                           | 固定manifest/input/output/调用身份、限长结果和原权限仍执行；真实GitHub待验                                                                               |
| controlled/native MCP、Bundle/plugins        | 原schema/plan、安装锁/lock audit、permissions、Profile与composition接入v3                         | 明文凭据plan拒绝；固定HTTPS只读MCP已接supervisor代理/当前grant交集/预算与回显阻断，OAuth/长订阅/stdio或Plugin通用凭据代理未支持；华为Gateway/MCP服务未验 |
| 原runtime/extension安装                      | 复用原npm argv/lock安装政策，专用namespace与批准registry egress                                   | 默认无批准registry拒绝；不挂仓库/Session/模型socket或Controller环境，真实目标registry待验                                                                |
| DSH Session save/resume/artifact store       | 原checkpoint导出/导入/provenance、prepare/collect worker session、原Controller restore/save       | 代码接入；Linux真实DSH save→fresh namespace resume已通过夹具测试；跨run真实artifact权限与云环境待验                                                      |
| 原loop、多轮工具反馈/修复、format repair     | v3每轮返回原AgentEngine接口、feedback、验证失败/无进展/统一deadline                               | 不盲重试POST；每轮新taskId/Runtime Session，不用旧Runtime实例保存文件                                                                                    |
| workspace/验证/finalizers                    | 真实manifest/delta进入原snapshot，独立Docker验证/strict baseline replay/GitHub reconciliation保留 | 云不能运行Docker-in-Docker；原测试与GitHub写在Controller，实际业务验收待验                                                                               |
| progress/check/status/result-json            | 原sticky lifecycle/progress/check/action output，加run-record                                     | 代码接入；权限和真实GitHub留证；记录当前仅保留最后Runtime/session/requestId，非全链路Trace                                                               |
| 工作流installer                              | 新agentarts/install.mjs嵌入原review/commands模板及原不覆盖/rollback/验证设置                      | 离线9新测试+原installer回归通过；需显式已发布commit、Runtime vars/Secret和验收，不能用安装成功代替云通过                                                 |
| history/upstream/license                     | 共同Git历史、原源码/测试/README归档、固定版本和更新步骤保留                                       | 不追latest；华为新增、通用修复与无关重构分开维护                                                                                                         |

源码入口：[main](../../src/agentarts/main.ts)、[FullEngine](../../src/agentarts/engine-full.ts)、[Runtime protocol](../../src/agentarts/runtime-task-protocol.ts)、[worker](../../src/agentarts/worker.ts)、[namespace](../../src/agentarts/sandbox.ts)、[Session transport](../../src/agentarts/session-transfer.ts)。

### 当前工作区传输与受控写接缝

主链路为原 `runAction.createEngine` → `runAgentPhase/runAgentLoop` → `AgentArtsFullEngine.runTurn` → 受检delta导入 → 原独立验证与 `executeWrite`。这是本轮实际接入代码；完整生产/GitHub/云证据须另记录，不只是解除allow-write限制。

1. **先授权后打包。** 原actor/fork/allow-write/实体规则与 `assertWriteTaskConfiguration` 先执行。每轮严格绑定taskId、operation/operationIdentity、entity类型/编号、repository、受信ref、base/head、revision、grantDigest及inputDigest/resultDigest；模型不能选ref、加工具或升级trust。固定test argv与验证镜像digest留在Controller。
2. **完整原文件与实际delta。** [workspace-transfer](../../src/agentarts/workspace-transfer.ts) 打包当前workerRoot全部ordinary files，仅按原generated roots跳过node_modules、拒.git/链接/特殊mode/别名冲突。UTF-8/base64/gzip-base64保存原bytes，编码最多16MiB、解压累计128MiB、5000files/changes，超限拒绝而不截断；这些是项目实现界限。Runtime把它物化为固定 `/workspace`；DSH及子进程停止后supervisor从真实文件capture新增/修改/删除和SHA/mode，不采模型changePlan作为内容。
3. **返回原loop前导入。** Controller验证严格envelope、task/实体/ref/grant/revision/digest、有效工具回执及已知secret，Session先stage而未安装，再严格检查delta。sourceRoot/baseline保持原bytes/mode；保护路径在supervisor capture和Controller安装前都由原assertWritablePath阻断。完整stage+分类后交换workerRoot，随后Session commit，任一失败poison engine、阻断finalizer。下一轮重新打包当前workspace并增加revision；累计变更仍相对原baseline。
4. **取消与事务收敛。** pack/materialize/capture/apply及Session stage/commit使用共同signal/deadline。远端计算的截止不会分离Controller文件导入；backup或candidate交换后观察到取消会回滚。Controller独占quiesced workspace，不承诺抵御外部进程并发持有FS句柄。rollback失败保留sole original私有backup并抛错，不能继续发布。重复、迟到、过期或未验证结果不安装。
5. **继续原独立验证。** 传输的strict分类省略baselineReplay，不运行测试；原 `runAgentPhase` 仍执行完整integrity与必要baseline replay，`finishFix/finishImplement/finishTask` 执行无凭据Docker验证、受信argv、固定镜像和original成功门槛。测试产生的改写不进入发布。原loop可用限长不可信ValidationFailure反馈继续修复；模型声称测试通过不放宽检查，测试通过也不等于需求正确。
6. **继续原GitHub发布边界。** PR head/ref、Issue内容指纹/base在测试/写前复查，原Git数据API再检查变更和保护路径。只有Controller token发布；确定性branch、operation marker、commit trailers和失去响应后的精确reconciliation保留。不确定写入/部分成功不触发盲重发云任务或重复提交。

### DSH Session接缝

Controller原restore后才导出安全metadata与原sessions/plan：repository/workflow/task/runtime bindingDigest、current run/source/actor、generation/retention、固定cwd、当前权限和可选checkpoint，不含knownSecrets/token值。Runtime按当前task/实体/模式/权限检查，调用原prepareWorkerSession与原DSH save/resume，再由collectWorkerSession和checkpoint validator捕获。

返回checkpoint须匹配当前planDigest/provenance、SHA/长度、canonical base64；已有历史必须原bytes前缀不变且eventCount增长，不能重放旧checkpoint。Controller stage/commit后原session.save仍写原artifact store；AgentArts Session只用于单次Runtime生命周期。不会恢复旧代码文件、历史权限或执行旧工具。Session历史仍是不可信上下文；含凭据或原不支持的附件内容拒绝，不重写原checkpoint语义。

## 真实平台依赖与范围

生产新v3必须有Linux root supervisor、UID/GID10001、CHOWN/DAC_OVERRIDE/KILL/SETGID/SETUID、bwrap和user/PID/network/IPC/UTS/filesystem namespace。Docker需固定 [seccomp-bwrap.json](../../agentarts/seccomp-bwrap.json)，允许bwrap setup所需六项syscall；worker启动后额外BPF拒新namespace。没有SYS_ADMIN、privileged或Docker socket要求。ARM64新增BPF/kernel隔离要求匹配架构的原生Linux验收，旧x64用户态QEMU通过不继承；本地Linux/Docker通过不能证明AgentArts租户支持这些kernel/seccomp能力，真实平台不满足即停止，不降级执行。

当前helper从固定Debian bubblewrap0.8.0-2+deb12u1源码保留四补丁，仅改新PID namespace的procfs为 `subset=pid`；无setuid、Debian hardening=+all、完整对应源码/许可随镜像。Linux5.8+ feature与实际probe均须满足，系统proc条目不可用的工具须另验；保留Docker masked paths，不挂hostproc/完整proc fallback。这项实现未解决当前Ubuntu24 CI所有限制，不能声明AgentArts已兼容。[源码metadata](../../agentarts/bubblewrap-source.json)、[部署](deployment.md)。

启用AppArmor的宿主另需允许setup。独立 [固定profile](../../agentarts/apparmor-runtime.profile) 保留Moby其它限制，允许userns创建、mount和bwrap两处固定pivot；mount未按路径缩小，必须与无SYS_ADMIN/五cap/no-new-privileges/worker清cap和BPF合用。CI先无凭据固定probe记录default拒绝，再加载专用profile复测，always仅卸载自身策略；不能用unconfined或全局关闭宿主限制替代。真实AgentArts是否提供这类宿主策略能力未确认，不能声称可部署。[部署与清理](deployment.md#32-apparmor宿主策略)。

华为官方HTTP当前要求ARM64/8080/`/ping`/`/invocations`；创建API同时列arm64/x86_64。API_KEY创建后不能变；Latest随版本移动，固定alias仍可被管理员移动。AgentArts会话存储启用后不能关闭，FUSE权限不保证chmod/chown，所以不拿它保存DSH私有状态。[HTTP](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_070.html)、[创建API](https://support.huaweicloud.com/api-agentarts/CreateCoreRuntime.html)、[认证](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_227.html)、[访问方式](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_048.html)、[会话](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_119.html)。

仍待真实租户：自定义seccomp/namespace/caps、模型及registry出站、元数据凭据不可达、32MiB任务body和实际HTTP总时限/断开传播、SWR拉取与固定alias、LTS查询、Session stop和真实GitHub结果。SWR基础版当前文档不支持OCI规格，使用单架构Docker Schema2构建格式仍须真实registry检查。[SWR](https://support.huaweicloud.com/usermanual-swr/swr_01_0011.html)、[部署](deployment.md)。

华为Gateway/MCP服务、平台观测Trace和平台评估属于新增云能力，尚未接入；原MCP的监督进程只读凭据代理已接主worker，见 [部署示例](deployment.md#31-可选的只读-mcp-凭据代理)。当前真实采集的是任务生命周期、DSH/tool/file/session结果及Controller检查。OAuth、长订阅与多模态没有上游完整实现，不属于迁移丢失；上游native MCP的显式credentialEnv/credentialHeaders和Plugin credentialConfig确有实现，本迁移拒绝任务传明文，任意stdio/Plugin凭据尚无等价接入。具体差异与固定Git包源适配见 [兼容审计](compatibility-audit.md)。

## 验收顺序

先在同一固定候选源码运行通用回归及Linux/生产镜像v3场景，区分真实DSH、fixture transport/provider与模拟GitHub。然后真实AgentArts小PR Review验证安全/日志/评论/清理；其他原operation、native/extensions/跨runSession逐项验收。首次write要覆盖真正edit→delta→导入→独立测试→原finalizer及权限拒绝、保护路径、测试失败、过期实体、取消/超时、重复与不确定GitHub写入。自动rubric、通过测试与人工需求正确性分别记录，不能编云成功率。本轮 [独立AI业务复核](business-review.md) 对四候选执行了3852个隐藏合同，同时发现diagnose解释中的一处过度断言；原manualVerdict仍未改成人工通过。
