# AgentArts 官方能力调查

调查日期：2026-10-04。资料仅采用华为云官方文档及其链接的官方 SDK 源码。本文记录**文档支持的能力和部署候选路线**，不表示已完成真实云端验证；真实运行证据应另行记录任务、提交、运行时版本、运行记录和 GitHub 结果链接。

## 结论

可以保留 TypeScript 控制端和 DSH，通过自定义容器将 DSH 托管到高代码 Runtime，无须为了 Python SDK 重写项目。Runtime 接收自定义 JSON 并原样转发，工作区装载、DSH 启动、工具权限和结构化结果协议由项目实现。受信控制端负责授权、准备提交绑定的上下文、独立验证和 GitHub 发布。平台提供会话沙箱、托管生命周期、鉴权与日志，不会自动实现本项目的结果校验或写入安全。

文档尚不能证明 Runtime 允许 DSH 所需的全部进程隔离能力。必须在真实租户验证非特权进程隔离、元数据隔离、资源规格、网络和超时后才可声明生产可用。首条链路宜限定 PR Review，禁止修改工作区和执行仓库提供的测试命令；CI 修复和 Issue→PR 待独立验证及凭证隔离完成后扩展。

来源：[运行时概述](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_029.html)、[调用概述](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_130.html)。

## 精确 HTTP 与认证合约

容器实现 `0.0.0.0:8080`，`POST /invocations` 接收 JSON，返回 JSON 或 SSE；`GET /ping` 返回 HTTP 200 与 `{"status":"Healthy"}`。启动中为 `Initing`，有后台长任务时为 `HealthyBusy`，避免后台工作被误判为空闲。同步处理也必须让健康检查独立响应，不能阻塞 Node 事件循环。

来源：[HTTP 入站协议](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_070.html)。

调用方使用运行时详情页给出的访问域名，不拼猜域名，不使用低代码 `InvokeRuntime` 协议：

```http
POST https://{gateway_domain}/runtimes/{runtime_name}/invocations?endpoint={fixed_endpoint}
Authorization: Bearer {runtime_api_key}
Content-Type: application/json
X-Hw-Agentarts-Session-Id: {session_id}

{ "schema_version": 1, "task": "项目定义的任务数据" }
```

这里的 body 是项目自定协议示意，**不是 AgentArts 的固定任务结构**。调用和返回字段由容器代码定义。Session ID 由英文、数字、`-`、`_` 组成，最长 64 字符；`runtime_name` 为 2–48 字符的小写名称。`endpoint` 缺省会使用 `Latest`，本项目应显式指定绑定已验证版本的访问方式。每次独立任务使用独立 Session，同一任务的调用、传输和停止使用相同版本与 Session。

来源：[高代码 ExecuteRuntime](https://support.huaweicloud.com/api-agentarts/InvokeRuntime1.html)、[版本访问方式](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_048.html)。

三种入站身份的合约不同，首版可准确限定 API Key：

| 部署时所选认证 | 调用方实际要求                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API Key        | `Authorization: Bearer {api_key}`；Key 从运行时的权限与访问控制 URN 跳转 AgentIdentity 获取                                                                  |
| IAM            | AK/SK 的 `V11-HMAC-SHA256` 或文档支持的 ECDSA 签名；不是普通 IAM `X-Auth-Token`；运行时数据面 body 不参与签名，发送 `X-Sdk-Content-Sha256: UNSIGNED-PAYLOAD` |
| OAuth 2.0      | `Authorization: Bearer {jwt_token}`；必须匹配部署时配置的发现地址、受众、客户端、范围和声明                                                                  |

IAM STS 还需 `X-Security-Token`。IAM 签名时间与服务器时间相差超过 15 分钟会拒绝，文档称 AK/SK 认证消息体限制 12 MB。认证指南中的示意 `/v1/runtimes/...` 与最新 API 路径存在差异，具体调用以最新 `ExecuteRuntime` 的 `/runtimes/...` 为准。

来源：[入站身份认证](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_227.html)。

自定义路由须在创建时选 `PREFIX_MATCH`。外部 `.../invocations/status` 映射容器 `/status`，支持不同 HTTP 方法。默认 `ACCURATE_MATCH` 只允许标准调用路径；控制台文档称选择严格匹配后不能改为前缀匹配。若采用异步启动、查询和取消，应一开始选择前缀匹配。该能力不等于平台提供了任务队列或持久化幂等记录。

来源：[自定义路径调用](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_131.html)。

## 工作区、结果传输和任务结束

Runtime 的不同 Session 在独立 microVM 中隔离；同一 Session 共享进程环境及文件系统。平台隔离的是**不同 Session**，不会自动隔离同一容器中的受信代理与 DSH。

会话生命周期文档明确：空闲超时与最大存活时间范围均为 60–604800 秒；默认分别为 900 秒和 86400 秒。达到最大存活时间会强制终止。`agentarts invoke --timeout` 默认 900 秒是 SDK 客户端默认值，不能当作高代码 HTTP 请求的服务端硬上限。未找到明确的普通调用硬超时、同会话并发上限、镜像体积、容器磁盘、nested Docker、Linux capabilities 或 seccomp/user namespace 保证，这些必须云端实测或工单确认。

来源：[会话管理](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_119.html)、[CLI](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_039.html)。

文件传输需要创建运行时时开启，默认关闭；控制台称创建后不能修改。完整文件链路为：

1. `POST /runtimes/{name}/sessions-start?endpoint={fixed_endpoint}`，带 `Authorization`，无请求体。200 返回 `data.session_id`，**不由此接口接收调用方指定的 Session ID**。
2. `POST .../upload-files?path={encoded_path}&endpoint={fixed_endpoint}`，带该 Session header。单文件流式上传用 `application/octet-stream`；multipart 或 `application/x-tar` 上传目标目录需以 `/` 结尾。文档上限单文件 100 MB、多文件总量 500 MB。
3. `POST .../invocations?endpoint={fixed_endpoint}` 处理同 Session 的文件。
4. `GET .../download-files?path={encoded_path}&endpoint={fixed_endpoint}` 获取结果；目录可设 `recursive=true` 返回 tar。
5. `POST .../sessions-stop?endpoint={fixed_endpoint}`，带相同 `Authorization` 与 Session header，无请求体，200 表示停止成功。

来源：[StartRuntimeSession](https://support.huaweicloud.com/api-agentarts/StartRuntimeSession.html)、[文件上传下载](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_133.html)、[StopRuntimeSession](https://support.huaweicloud.com/api-agentarts/StopRuntimeSession.html)。

PR Review 可先传有大小上限的 diff 和源文件快照；完整修复应由控制端在绑定 commit 的隔离 checkout 打包，排除 `.git`、凭证、链接和不需要的生成物，生成文件清单与内容摘要后上传。容器自行验证清单并装载只读输入和独立可写目录，拒绝目录穿越、链接、重复路径和超量输入。不要给模型任意下载 URL，不把 GitHub 写凭证用于云端 clone。补丁或文件结果返回控制端后仍视为不可信，控制端根据原始 commit 独立应用、限制路径、重新测试、复查 PR head 后发布。平台 upload 的自动解压不能替代项目自己的安全解包。

`POST .../commands` 的 shell 与 Agent 在同一容器执行。指南限制命令超时默认 60 秒、最大 300 秒，chunked 返回 `application/x-ndjson`；因此不把此接口当作 DSH 长任务的主执行器。平台的停止会话是销毁实例，不是保证精确一次业务提交。HTTP 断开也没有文档保证会终止子进程：项目仍需截止时间、进程树清理、取消状态、控制端发布幂等保护。停止沙箱和删除会话持久化数据是两个操作。

来源：[执行命令](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_132.html)、[会话管理](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_119.html)。

## 新增凭证面与网络边界

Runtime 委托代表用户访问云服务，SDK 通过元数据取临时 AK/SK/SecurityToken。官方源码 `MetadataProvider` 请求 `http://169.254.169.254/v1/metadata/securitykey`。仅清理 DSH 环境变量无法阻止它通过 shell、网络或 `/proc` 读取父进程和云端身份信息。必须限制 Runtime 委托到实际所需资源，验证元数据不可被 DSH 触达，并将 Gateway/模型凭证保存在受信代理可访问而 DSH 不可访问的位置。没有这项验证不能宣称“模型和代码拿不到凭证”。

来源：[委托介绍](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_226.html)、[官方 SDK metadata.py](https://github.com/huaweicloud/agentarts-sdk-python/blob/80a275a4bcf685937033eba4e5f205751e44e32f/src/agentarts/sdk/utils/metadata.py)。SDK 调查 commit：`80a275a4bcf685937033eba4e5f205751e44e32f`，仅用于核对协议，没有引入运行依赖。

出站网络可选 PUBLIC 或 VPC，VPC 指定子网和安全组；入站访问由网络配置和认证共同决定。官方文档未保证公网出口能在目标账户区域访问 GitHub、DeepSeek 或所有代理端点，也未保证针对子进程的出站白名单。生产路线应将 DSH 限制在代理可用的 network namespace 或等效隔离层；如果租户不允许，停止该部署路线并采用能提供隔离的执行设施，不能用任意 HTTP wrapper 绕过安全要求。

来源：[CreateCoreRuntime](https://support.huaweicloud.com/api-agentarts/CreateCoreRuntime.html)、[控制台部署](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_031.html)。

## Gateway/MCP：有意义的下一阶段候选

Gateway 可以连接 MCP Server 或将 REST/OpenAPI 转成 MCP；工具由 Target 后端执行，不会因为经过 Gateway 就自动进入 Runtime 的仓库工作区。出站 API Key/OAuth/IAM 凭证由网关附加，调用方只持有 Gateway 入站认证。推理 Target 走独立 `/inference/` 路由，也可接 DeepSeek；这不是首条 Review 必需项。

来源：[Target 介绍](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_242.html)、[Target 出站认证](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_123.html)。

候选首个工具是读取**特定任务允许的不可变审查约定/规则文件**，由控制端准备并绑定 repository、commit、run ID，通过 Gateway 的 MCP Target 返回内容；工具不得接受任意仓库、ref、URL 或文件系统路径，也不提供发布权限。另一候选是读指定 PR/CI 的元数据，但需任务级 read capability 与明确的字段/大小限制。服务需独立可达的 HTTPS/MCP 端点，Gateway 不是本地 stdio 工具的透明替代。以上为下一阶段候选，当前实现状态以 README 为准。

MCP 调用使用 `POST https://{gateway_domain}/mcp`，`Authorization`、`Content-Type: application/json`、`Accept: application/json, text/event-stream`；先 JSON-RPC `initialize` 协商，再 `tools/list`/`tools/call`，遵循响应会话 ID。协议支持 `2025-03-26`、`2025-06-18`、`2025-11-25`；后两者的非初始化请求必须带 `Mcp-Protocol-Version`。控制台指南限制四个方法 `initialize`、`tools/list`、`tools/call`、`ping`，响应统一 SSE；不支持批量 JSON-RPC、tasks、tools 注解/outputSchema 等扩展。API schema 却列有若干扩展字段，按控制台实际限制设计最小客户端并实测。单租户默认 10 网关，每网关最多 10 Target。

来源：[InvokeMcpGateway](https://support.huaweicloud.com/api-agentarts/InvokeMcpGateway.html)、[创建网关及协议限制](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_024.html)、[创建 MCP Target](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_160.html)。

## 观测与评估的实际边界

最新观测指南明确 Runtime 托管目前只支持日志上报，开启后可在 AgentArts 智能体列表/运行分析和 LTS 查看日志。虽然创建 API 中存在 APM tracing/AOM metrics 配置，不能据此承诺 DSH 工具和模型自动产生完整 Trace。第一阶段输出有 run ID、repository、commit、阶段、实际工具、失败原因和时间的脱敏结构化日志，并保存控制端运行记录供 Demo 读取；后台日志流量可能产生 LTS 费用。

来源：[数据上报概述](https://support.huaweicloud.com/ops-agentarts/agentarts_14_0004.html)、[查看智能体上报数据](https://support.huaweicloud.com/ops-agentarts/agentarts_14_0132.html)。

需要完整调用链时，可以单独创建“第三方智能体接入”实体并通过语言无关 OpenTelemetry 导出；示例采用 OTLP gRPC，不要求改写 Python。平台要求 `OTEL_SERVICE_NAME=AgentArts.{agent_id}.{version}` 和 `Authentication={trace_token}`，Root/LLM/PLUGIN 类型、资源与会话 ID、真实输入输出等有专用字段约定。端点及 token 从租户控制台取得，不能猜写 URL。仅记录真实捕获的 token 使用，未知为 unknown；输入输出先脱敏，密钥只交受信上报进程。Trace 接入限制为每租户每分钟 20 万 Span，APM 按数据量可能收费。

来源：[Trace 数据上报](https://support.huaweicloud.com/ops-agentarts/agentarts_14_0125.html)、[OTel 字段映射](https://support.huaweicloud.com/ops-agentarts/agentarts_14_0127.html)。

离线评估支持 Runtime 和第三方托管，能配置 Header/Body/Query、JSON/SSE 响应字段、`{{SessionID}}` 轨迹关联。但文档对 Runtime/第三方目标仅支持“轨迹质量”和“轨迹-工具参数填充正确性”评估器；需要 APM/AOM 授权和可用轨迹。最新在线评估指南称只支持智能体管理中创建的智能体，暂不支持外部接入，不能承诺本项目在线评分。应先交可复现业务评测：任务版本、输入提交、期望发现/修复、权限拒绝、验证失败、超时、取消与幂等行为。平台轨迹分数只是辅助证据，PR 审查正确性及修复正确性仍由业务标准/人工检查验收。评测集评估可复盘已生成结果，不能冒充重新执行云端任务。

来源：[离线评估](https://support.huaweicloud.com/ops-agentarts/agentarts_14_0086.html)、[在线评估](https://support.huaweicloud.com/ops-agentarts/agentarts_14_0087.html)、[Trace 回流限制](https://support.huaweicloud.com/ops-agentarts/agentarts_14_0021.html)。

## 真实云端部署与清理检查点

以下操作需要账户权限；创建云资源、开通计费能力和发布远程仓库均须先获得用户明确确认。

1. 在支持区域确认 AgentArts 服务与服务授权可用。SDK 文档目前仅列 `cn-southwest-2`。创建或使用专用 SWR 镜像组织；从本项目构建包含固定 DSH 和依赖的镜像，使用不可变、非 `latest` tag，记录 digest。
2. 首选 ARM64 镜像。HTTP 与控制台指南写 ARM64 限制，最新创建 API 又允许 `arch=arm64/x86_64`，存在矛盾；只有真实租户确认 x86_64 可用后才使用。控制台当前列 2 vCPU/8 GiB，API 要求查询租户允许的 specs，不能将所有规格当作已开放。
3. “托管与运行 > 智能体运行时 > 托管智能体”：选择 SWR 镜像、HTTP、监听 8080、最小权限委托、入站网络和 API Key；按实际需要配置出站网络、日志、生命周期和文件传输。需要状态接口时选前缀匹配。Review 首条链路无需挂共享存储。
4. 创建访问方式并绑定本次已验证版本；保存运行时 ID/name、域名、endpoint、镜像 digest、DSH 版本和配置，不把密钥写入仓库。API Key 放控制端的 GitHub secret。校验 TLS，不照搬 CLI 文档中的跳过校验示例。
5. 部署后依次证明容器健康、DSH 启动、元数据/父进程/凭证隔离、输入与提交绑定、截止时间与停止、真实 Review、控制端独立校验、GitHub 结果和 LTS 记录。每一项留真实证据；没有凭证时只能报告本地或模拟验证。
6. 每次任务 finally 停止会话；停止失败单独记录以便清理，不把它写成已清理。持久化会话数据另行删除。结束 Demo 后在运行时列表操作列“删除”，输入 `DELETE` 确认。运行时删除会同时删除其版本和访问方式；另外检查专用 SWR 镜像、Gateway/Target、网络资源、日志存储和 APM/AOM 资源是否仍计费，按各服务控制台清理专用资源，保留需长期保存的运行证据。

来源：[SDK 支持区域](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_037.html)、[控制台部署及删除](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_031.html)、[CreateCoreRuntime](https://support.huaweicloud.com/api-agentarts/CreateCoreRuntime.html)、[DeleteCoreRuntime](https://support.huaweicloud.com/api-agentarts/DeleteCoreRuntime.html)。

## 部署前必须澄清的未知项

- 租户高代码 invocations 的实际代理/连接/总任务超时，同 Session 并发及传输限流；不要混用低代码工作流 15 分钟限制。
- 非特权 user/network/PID namespace、文件只读策略、元数据屏蔽、seccomp/capabilities 和子进程树取消是否允许；没有实际隔离证据时不能进入修复发布模式。
- DSH 固定依赖在 ARM64 上的兼容性，SWR 拉取、磁盘、资源峰值及 GitHub/DeepSeek 的实际网络可达性。
- Runtime 日志、独立 OTel 实体与离线轨迹评估在该租户的真实可用性和收费范围；记录实际验收能力，不把产品宣传或 schema 字段算作集成成功。
