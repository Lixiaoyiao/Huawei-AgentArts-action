# PR Review：审批后部署与验收

核对日期：2026-10-04。当前账号准入审批中，未部署或验收真实 AgentArts Runtime。公开仓库提供本地验证后的代码、配置和记录，尚未创建云资源或公开托管 Demo。以下云端步骤是审批后手册，不是已执行记录。

本手册覆盖迁移的第一阶段 PR Review。完整迁移目标和原能力状态见 [能力迁移表](capability-matrix.md)。事件与写权限留在 GitHub Controller；当前 Runtime 托管固定 DSH、只读工作区、模型代理与实际工具执行。第一轮不启用共享存储、文件传输、低代码 Agent、Gateway/MCP 或其他任务；这是阶段边界，不是对原能力的永久删除。

## 1. 准备账号、区域与受信配置

服务准入通过后，确认目标区域的高代码 Runtime、SWR 和日志入口实际可用。在 AgentArts 的授权管理里核对已开通的服务与授权；IAM 子用户只授本次部署所需权限。管理人员权限、Runtime 委托权限和调用端 API Key 是三件事，不能互相替代。官方给出完整 Runtime 身份策略及自定义权限列表，应按实际资源采用最小授权。[开通服务](https://support.huaweicloud.com/qs-agentarts/agentarts_04_0000.html)、[控制台部署](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_031.html)。

SDK 支持区域页当前只列西南-贵阳一 `cn-southwest-2`；这不是其他租户/区域已可用的证明。HTTP 和控制台指南写 ARM64 镜像限制，创建 API 同时列出 `arm64`/`x86_64`。首轮按 ARM64；只有实际租户确认其他架构可选并验证后才使用。[SDK 区域](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_037.html)、[HTTP 要求](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_070.html)、[创建 API](https://support.huaweicloud.com/api-agentarts/CreateCoreRuntime.html)。

| 项目                      | 配置位置                                                  | 留存证据                                                         |
| ------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| GitHub 写 token           | 受信 Actions 步骤；优先仓库 `GITHUB_TOKEN`                | `contents: read`、`pull-requests: write`；token 不进入任务或云端 |
| Runtime 入站 API Key      | Controller 的 Actions Secret `AGENTARTS_RUNTIME_API_KEY`  | Secret 名称及配置完成状态，不保存值                              |
| DeepSeek 模型 key         | Runtime 受信 supervisor 的敏感环境配置 `DEEPSEEK_API_KEY` | 注入方式、访问控制与轮换状态，不保存值                           |
| Runtime origin/name/alias | Controller Variables                                      | 从 Runtime 详情复制 HTTPS origin；显式固定版本 alias             |
| SWR 登录凭据              | 部署者本地凭据管理                                        | 使用批准的登录方式；不放 Git/构建参数/任务/Demo                  |

入站 API_KEY 使用 `Authorization: Bearer …`，从 Runtime 的权限与访问控制 URN 进入 AgentIdentity 获取。认证方式创建后不能改；选择 IAM/OAuth 会与本版客户端不匹配。创建 Runtime 前就选 API_KEY；不要把账号 AK/SK 当成 Runtime API Key。[入站身份认证](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_227.html)。

模型 key 不能写进 Dockerfile、镜像 ENV、部署 JSON、命令参数、仓库文件或请求 body。按租户实际支持的敏感环境变量/安全注入交给 supervisor；项目没有实现 CSMS 自动取密钥。若平台配置/版本导出能显示明文，限制其管理访问，不将导出物作为演示附件。真实值不交给 DSH，DSH 环境中仅有单次代理 token。

## 2. 固定代码、镜像与版本关系

部署前记录完整源码 commit、锁定依赖与镜像架构；工作区有变更时另记补丁摘要，不能拿旧 commit 的 CI 代替新代码。保持 `package-lock.json` 和 Node 基础镜像 digest，不更换 DSH `0.2.0-rc.2`。

在已有或明确批准的 SWR 组织内准备专用镜像路径，记录控制台给出的 registry/组织/仓库。用非 latest、非复用 tag，例如 `review-<source12>-arm64`。审批后的登录/推送按该区域 SWR 控制台提供的指令执行；不要把带密码的指令粘入本手册或运行记录。[SWR 客户端上传](https://support.huaweicloud.com/usermanual-swr/swr_01_0011.html)。

**推送前先确认 SWR 版本与产物媒体类型。** 当前大陆 SWR 基础版官方页明确不支持 OCI v1.0/v1.1 镜像规格，企业版另有支持；不能假设 Buildx 默认 OCI/provenance 索引可以上传基础版。Docker 本地运行通过仅证明该本地镜像可运行。按实际 registry 支持选择构建输出并复核 manifest 类型，未核对时停止推送步骤；本项目没有验证 SWR 上传/拉取，不自动购买企业版。[SWR 镜像规格限制](https://support.huaweicloud.com/usermanual-swr/swr_01_0011.html)。

推送后独立记录 SWR manifest digest，复核 registry/path/tag 与架构。Docker 的本地 image ID 是另一种标识，不能填充 SWR digest。若创建界面只允许 tag/path，使用独占 tag，保存它当时解析出的 digest，禁止覆盖；若租户明确支持 digest 引用再使用该形式。项目没有实际验证创建 API 接受 `@sha256` 的所有路径。

创建固定 Runtime 版本，并建立明确 alias，例如 `review-v1`。关闭灰度，将 100% 流量绑定该版本；保存 `source commit → SWR digest → Runtime version → alias` 映射。默认 Latest 总是指向最新版本，本客户端拒绝它；固定 alias 仍可被管理人员移动，名称本身不构成不可变保证。升级建立新版本/新 alias，验收后人工切换并保留回滚版本。[访问方式管理](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_048.html)。

## 3. Runtime 必须满足的部署边界

| 设置/检查     | 本版要求                                                                      | 未满足时                             |
| ------------- | ----------------------------------------------------------------------------- | ------------------------------------ |
| HTTP          | `0.0.0.0:8080`；`GET /ping`、`POST /invocations`；标准精确匹配                | 不进行真实 PR 调用                   |
| 启动身份      | root supervisor；DSH UID/GID10001；补充组清空                                 | 失败关闭；禁止测试豁免上线           |
| capabilities  | supervisor 有 CHOWN、DAC_OVERRIDE、KILL、SETGID、SETUID                       | 不能声称凭据隔离/超时清理成立        |
| 运行文件      | 镜像代码 root 所有、不可被 worker 写；每任务本地只读输入与私有状态            | 拒绝结果                             |
| 存储          | 第一轮不挂会话/OBS/SFS 持久存储                                               | 先撤回设计，不把共享卷充当私有工作区 |
| 网络          | supervisor 可访问操作者固定的 DeepSeek HTTPS；DSH 无任意网络工具              | 保留实际失败，不换成本地兜底         |
| 云元数据/委托 | 审计最小委托；验证 worker 不可取得实际云身份凭据                              | 视为安全验收失败，停止发布验收       |
| 生命周期      | Controller 1–10 分钟；平台最大生命周期留出冷启动/清理余量；每任务独立 Session | 不沿用/重放旧 Session                |
| 日志          | 开启并能按 taskId/head 查询实际 Runtime JSON 日志                             | 云端链路证据不完整                   |

平台隔离不同 Session；同一 Session 内 supervisor 与 DSH 的 UID/文件/网络边界由本项目和租户条件共同保证。会话存储启用后不能关闭，其 FUSE 权限不保证运行时 chmod/chown 生效，故本版不使用它。生命周期范围见官方指南；客户端或示例中的 900 秒不是普通 HTTP 服务端硬上限。[会话管理](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_119.html)。

本版没有给 worker 创建独立 network namespace，`networkIsolated` 为 false。只读工具清单不能自动证明元数据不可达。必须用受信诊断验证 DSH 身份对父进程环境、root 私有文件和元数据临时凭据入口的访问结果；诊断只记录拒绝/状态，不读取、展示或持久化凭据值。平台若不能提供要求的边界，停止该云端路线，不扩大委托或开放 shell 来绕过。[委托说明](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_226.html)。

普通调用总超时、断开传播和本项目所需 Linux capabilities 尚待真实租户验证。公开出站/VPC 配置也不能证明 DeepSeek 在目标区域可达。不要开 `--privileged`、挂 Docker socket、执行 PR 代码或使用 Docker-in-Docker。容器测试的受限 capabilities 与云平台实际允许项须逐一核对。

## 4. 本地预检与复现

从 [配置示例](../../agentarts/examples/deployment-config.example.json) 复制到本地工作目录，填入非敏感的实际参数。示例刻意保留不可通过的占位 commit/digest/origin，防止把模板当成已部署配置。`readiness` 是操作者填写的状态，不是脚本生成的云端证据。

```bash
node agentarts/preflight.mjs --config /absolute/path/to/deployment-config.json
node agentarts/preflight.mjs --config /absolute/path/to/deployment-config.json --inspect-image huawei-agentarts-action:review-local
```

第一条只读本地 JSON；第二条可选查询本地 Docker 镜像的 Linux/架构/image ID/USER/RepoDigests 元数据，不读取镜像 ENV，不 pull、不 run。Linux 默认固定本地 `unix:///var/run/docker.sock`，Windows 固定本地 pipe；rootless 可显式传 `--docker-host unix:///run/user/1000/docker.sock`。拒绝 TCP/SSH 等远程 daemon。检查 Docker 时使用私有临时空配置和封闭环境，不加载操作者 registry 登录凭据，随后清理该临时目录。

脚本不读取 key 值，只通过变量名称报告当前进程是否存在 `AGENTARTS_RUNTIME_API_KEY`、`DEEPSEEK_API_KEY`、`GITHUB_TOKEN`；存在不代表非空/正确，也不验证远程 Actions Secrets。不要为了这个检查把原本分属 Controller 与 supervisor 的 key 集中复制到同一环境。输出始终为 `cloudAcceptance: unverified`，不创建/修改资源，不调用 Runtime/模型/GitHub，不输出原始配置或 Docker 错误正文。

### 4.1 最终镜像与确定性模型 smoke

以下 Linux/Bash 脚本运行真实 DSH 和本地 SSE 模型夹具；无真实模型 key、GitHub token 或华为调用。构建需要获取锁定基础镜像/npm 依赖，故“本地”不代表构建完全断网。本轮新源码是否实际执行通过，以单独新记录为准；旧双架构 CI 只证明其记录中的 commit。

```bash
bash agentarts/local-container.sh
```

在仓库根目录运行。脚本固定只支持 linux/amd64、linux/arm64，构建后按实际 image ID 运行 smoke，覆盖 HTTP Runtime、UID、只读工具、重复拒绝和截止清理。测试容器无外网，夹具 HTTP服务在内部loopback；caps是同五项，未挂Docker socket或凭据。本地记录在 `work/container-x64/`（可由 `AGENTARTS_EVIDENCE_DIR` 更改），包含 descriptor/smoke、source commit、dirty状态、构建输入文件摘要；它们不构成源码/镜像签名证明。

```bash
AGENTARTS_TEST_PLATFORM=linux/arm64 bash agentarts/local-container.sh
```

ARM64 要有实际 ARM daemon，或已准备 QEMU 的测试宿主。脚本不会自动登记 QEMU；跨架构时将记录 emulated，必须复核宿主/daemon实际架构，不能把 emulated=false 冒充原生硬件。镜像workflow的QEMU仅作用于临时测试宿主，不能放到AgentArts Runtime内。Windows可在已配置Docker的Linux环境使用这些Bash命令。

本轮统一构建导出格式为 `--provenance=false --sbom=false --output type=image,oci-mediatypes=false`，避免Docker新版默认OCI索引/attestation混入单架构SWR候选。需单独构建时使用同样参数：

```bash
docker build --platform linux/amd64 --file agentarts/Dockerfile \
  --provenance=false --sbom=false --output type=image,oci-mediatypes=false \
  --tag huawei-agentarts-action:local-x64 .
```

仍须检查实际 `image-descriptor.json`/registry manifest，而不只相信flag；构建工具/镜像存储方式可能改变结果。Docker官方将 `oci-mediatypes` 作为export格式参数；此处格式选择不保证目标SWR接受，真实上传/拉取尚未验证。[Docker image exporter](https://docs.docker.com/build/exporters/image-registry/)。

### 4.2 固定 Review 任务与真实模型执行前的计划

构建后运行固定四任务的纯本地计划，不启动 Runtime、不读取凭据、不调用模型/GitHub：

```bash
node dist-agentarts/live-review/index.js --mode simulation --dry-run \
  --max-cases 4 --timeout-ms 120000 \
  --max-model-requests-per-case 6 --max-output-tokens 2048
```

`simulation --execute` 才会向已运行的 loopback Runtime 发夹具任务，且要求 supervisor 标明 `deterministic-fixture`。`local-real-model` 则要求 `live-provider`、官方 DeepSeek origin 和经过核对的请求/输出上限；默认不执行。示例仍是 dry-run，即使没有 key、Runtime 尚未启动也不发送请求：

```bash
node dist-agentarts/live-review/index.js --mode local-real-model --dry-run \
  --runtime-origin http://127.0.0.1:18080 --max-cases 1 --timeout-ms 120000 \
  --max-model-requests-per-case 6 --max-output-tokens 2048
```

真实模型执行必须先获得明确的模型费用授权并启动正确配置的受信 supervisor，再使用 `--execute`、上述四项显式上限、`--budget-usd`、`--confirm-budget I_ACCEPT_METERED_MODEL_CALLS`、`--image-digest`、`--source-commit` 和 `--out`。本地 `--image-digest` 当前用于操作者记录实际 image ID，不能冒充 SWR manifest digest；`--source-commit` 也不是源码/镜像签名证明。CLI 不启动容器，不读取模型 key，固定合成 PR 不向 GitHub 发布。失败会停止后续案例，不盲重试。

配额由 supervisor 的 `AGENTARTS_MAX_MODEL_REQUESTS` 和 `AGENTARTS_MAX_OUTPUT_TOKENS` 实际强制，不能大于 CLI 批准值；`AGENTARTS_MODEL_EVIDENCE` 必须与所选模式相符，`AGENTARTS_DEEPSEEK_MODEL` 由受信配置选择。请求次数包含失败的实际出站尝试；美元预算只是明确批准额度，不是可执行的账单硬上限，实际费用仍为 unknown。结果的自动 rubric 需要人工复核，不能等同模型审查正确率。

当前 `cloud` 模式只生成固定任务/验收模板，`cloud --execute` 明确拒绝；因此它不是第一条真实 GitHub cloud Review 的入口。真正事件入口仍为受信 Action。新增 task/diagnose v2 不属于这套固定 Review 评测。

### 4.3 本地真实 key 的位置

生产入口已支持 [supervisor-secrets.ts](../../src/agentarts/supervisor-secrets.ts) 的 `DEEPSEEK_API_KEY_FILE`：Linux root supervisor 从绝对路径打开最终组件不跟随 symlink的文件，要求 UID0、常规文件、nlink=1、mode0600、最多4097 bytes。key必须为一行，可末尾LF；与 `DEEPSEEK_API_KEY` 互斥。真实值只进入传给 server 的内存环境，不写容器 ENV metadata、task body 或 child env；DSH 仍只拿随机代理 token。启动前还必须通过 root/五项caps/不可写镜像目录的隔离检查。云租户是否支持该挂载/权限尚未验收；本轮实测结果以验证记录为准。

以下是 Linux root Bash 中的本地 key 文件准备方法。WSL 使用 Linux 文件系统中的 `/tmp`，不要在 `/mnt/c` 等不能忠实表示 Unix mode/ownership 的路径创建。`read -s` 从终端接收值，命令历史只有变量名；不要开启 shell trace。启动/调用与预算审批是不同步骤。

```bash
test "$(id -u)" = 0 || exit 1
umask 077
agentarts_key_dir="$(mktemp -d /tmp/agentarts-model-key.XXXXXXXX)"
IFS= read -r -s -p 'DeepSeek key: ' agentarts_model_key
printf '\n' >&2
printf '%s\n' "$agentarts_model_key" > "$agentarts_key_dir/deepseek_key"
unset agentarts_model_key
```

只挂这个文件，禁止挂整个 home、Docker config、GitHub credential目录或把实际 key放命令行/build-arg/镜像ENV/env-file。用刚构建并独立核对的镜像启动本地 supervisor，端口只映射到127.0.0.1。下面设置实际每次Runtime任务最多6个模型请求、单次最多2048输出tokens；它们须与之后批准的CLI上限一致。`AGENTARTS_DEEPSEEK_MODEL` 是受信选择，生产代理强制覆写请求中的模型名；此命令仅启动服务，不主动发送 Review或模型请求。

```bash
agentarts_image_id="$(docker image inspect huawei-agentarts-action:local-x64 --format '{{.Id}}')"
[[ "$agentarts_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
docker run --detach --name huawei-agentarts-review-local --init --read-only \
  --publish 127.0.0.1:18080:8080 \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
  --cap-add DAC_OVERRIDE --cap-add KILL --security-opt no-new-privileges \
  --pids-limit 256 --memory 1g --cpus 2 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=536870912 \
  --mount "type=bind,source=$agentarts_key_dir/deepseek_key,target=/run/secrets/deepseek_key,readonly" \
  --env DEEPSEEK_API_KEY_FILE=/run/secrets/deepseek_key \
  --env AGENTARTS_MODEL_EVIDENCE=live-provider \
  --env AGENTARTS_DEEPSEEK_MODEL=deepseek-v4-pro \
  --env AGENTARTS_MAX_MODEL_REQUESTS=6 --env AGENTARTS_MAX_OUTPUT_TOKENS=2048 \
  "$agentarts_image_id"
```

真实模型需要实际网络出站；确定性smoke的 `--network none` 不能直接复用。此本地命令使用 Docker默认网络，不证明云端egress/元数据边界。启动后先检查有限的 `/ping` 状态及公开 modelPolicy，不打印完整容器ENV或请求/模型正文；尚未获得模型费用授权时，不运行任何 `--execute`。不要把只设置了 live-provider 的健康响应当成实际模型调用证据。

结束本地试验，先停止并删除本专用容器；停止失败须检查实际状态，不能接着宣称清理完成。确认挂载已解除后只删除先前生成的单文件和空私有目录，禁止批量/递归删除未知目录：

```bash
docker stop --time 10 huawei-agentarts-review-local || exit 1
docker rm huawei-agentarts-review-local || exit 1
case "$agentarts_key_dir" in /tmp/agentarts-model-key.*) ;; *) exit 1 ;; esac
rm -- "$agentarts_key_dir/deepseek_key"
rmdir -- "$agentarts_key_dir"
unset agentarts_key_dir
unset agentarts_image_id
```

## 5. 审批后按顺序验收

先得到账号、资源创建/费用与私有部署的明确授权，随后执行本轮已经核对的构建、容器和 live 命令。当前命令入口和本轮证据由 [验证记录](verification.md) 单独记录；不要替换成历史 CI 的 image ID 或 Session。

1. **基础部署**：确认实际目标架构、固定镜像/版本/alias、API_KEY、日志和网络。核对 `/ping`、原 DSH 启动、UID/caps 与凭据边界；尚未安全通过前不安装可发布的 GitHub workflow。
2. **无发布调用**：用维护者控制的 PR 上下文检查真实 Runtime → DSH → read 回执 → 独立结果验证，保存 taskId、Session、真实 request ID、平台日志和清理状态。没有日志/UID/工具证据的 HTTP 200 不能代替验收。
3. **第一次真实 PR**：在新仓库使用 [受信 workflow 示例](../../agentarts/examples/pr-review.yml)，配置三个 Runtime Variables 和 Secret。确认 GitHub token 仅为 contents read/pull-requests write、`bot-user-id` 与实际作者一致。workflow 只构建受信 `github.workflow_sha`，禁止 checkout/执行 PR head。
4. 维护者建立一个小的已知缺陷 PR，记录实际 base/head 与业务 oracle。检查真实 GitHub 事件、Runtime/DSH/tool、Controller 校验、写前当前 head 和 GitHub 评论链接对应同一个任务，再由人工独立判定发现是否正确。选零发现案例验证不会为“演示效果”伪造 bug。[业务验收](evaluation.md)。
5. 在同一固定版本上执行过期 head、权限拒绝、伪造/越权结果、超时、取消和人工重跑。拒绝发生在应有边界：权限拒绝不调用 Runtime；格式/绑定/回执问题不发布；过期 head 不发布旧审查；截止/取消后的迟到结果不能进 finalizer；重跑不制造重复评论。

发布过程中 API 失败可能已有部分评论成功。保存已确认效果，复查原指纹和 bot 所有权后再人工处理；不能用“失败”推断 GitHub 没有变化。本版本不自动重试不确定的 invocation POST，不把同实例 taskId 拒绝等同于跨重启持久幂等。

每次结果表至少包含：案例版本/成功标准、模式、source commit、SWR digest、Runtime version/alias、DSH、base/head、taskId/Session/request ID、实际工具与耗时、独立业务判定、失败原因、GitHub 链接及清理结果。未知成本/token 写未知，不把夹具、QEMU、当前本地运行和真实云端计成一个成功率。

## 6. 停止、回滚与清理

失败或取消先关闭该任务的发布入口，保留原因与已确认 GitHub 效果。Controller 对同一固定 alias/Session 发 `sessions-stop`，它是无 body 的 POST，仍需相同入站认证与 Session header。200 后再结合平台确认沙箱停止；清理失败单独记为失败，不覆盖业务结果、不编“已清理”。[StopRuntimeSession](https://support.huaweicloud.com/api-agentarts/StopRuntimeSession.html)。

部署验收失败时停止新调用，保留已核实旧版本/alias供回滚；不要移动当前 alias 到未经验证的镜像。结束专用实验时依序停用 workflow、撤销调用/模型 key、停止遗留 Session，再按批准范围删除专用 Runtime/版本/alias、SWR 镜像与日志数据。停止会话与删除持久状态是不同操作；本轮未启用持久存储。[会话管理](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_119.html)。

Runtime 删除可能连带其版本/访问方式；共享 registry、VPC、委托、日志组不随实验删除。实际计费以账户账单为准，LTS、网络、镜像与模型分别核对。先保留脱敏运行证据，再清理专属资源。本手册和 preflight 均不执行这些删除操作。
