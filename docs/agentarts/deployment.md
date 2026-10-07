# PR Review：审批后部署与验收

核对日期：2026-10-07。当前账号准入审批中，未部署或验收真实 AgentArts Runtime。仓库保留各次源码、本地验证和原始记录；本轮完整任务迁移与旧只读证据分别记载，尚未创建云资源或公开托管 Demo。以下云端步骤是审批后手册，不是已执行记录。

本手册以PR Review为第一条真实云验收；当前代码的完整任务迁移见 [能力迁移表](capability-matrix.md)。事件、授权、独立Docker验证、GitHub写凭据与finalizer留在Controller；Runtime托管固定DSH、受检工作区、原工具/扩展和DSH Session传输。它必须通过强制namespace安全检查，不能仅有HTTP200就开放写任务。首次平台验收仍从只读Review开始，不启用共享持久存储、低代码Agent或未经验证的Gateway/MCP服务。

**审批后的第一步是核对目标租户可否提供所需sandbox。** 先通过现有租户配置与官方支持确认namespace/private procfs、自定义seccomp/LSM和五cap可用；原生Ubuntu24镜像CI已实际遭proc挂载拒绝，本地WSL通过不能代替它。能力未确认时不创建资源硬试；若平台确实不能提供等价隔离，暂停本部署路线，另行评估架构备选并取得用户同意。只有条件确认并获资源/费用授权后，才部署最小固定候选、运行真实probe及PR Review；配置允许也不等于实际probe通过。

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

生产`AGENTARTS_INBOUND_MODE=platform`（默认）依赖华为入站网关认证，cloud客户端只访问平台固定入口，禁止直接公开容器8080绕过网关。不能假设网关会将Authorization透传到应用；该行为仍待租户确认。普通本地容器没有该网关，必须显式`AGENTARTS_INBOUND_MODE=local`并配置仅本机试验使用的随机`AGENTARTS_LOCAL_API_KEY`：server在读取task body前验证Bearer，缺失/错误会拒绝。该key不复用真实AgentArts key、不进worker；健康`/ping`仍不要求该key，不能以ping成功证明任务已授权。

模型 key 不能写进 Dockerfile、镜像 ENV、部署 JSON、命令参数、仓库文件或请求 body。按租户实际支持的敏感环境变量/安全注入交给 supervisor；项目没有实现 CSMS 自动取密钥。若平台配置/版本导出能显示明文，限制其管理访问，不将导出物作为演示附件。真实值不交给 DSH，DSH 环境中仅有单次代理 token。

## 2. 固定代码、镜像与版本关系

部署前记录完整源码 commit、锁定依赖与镜像架构；工作区有变更时另记补丁摘要，不能拿旧 commit 的 CI 代替新代码。保持 `package-lock.json` 和 Node 基础镜像 digest，不更换 DSH `0.2.0-rc.2`。

在已有或明确批准的 SWR 组织内准备专用镜像路径，记录控制台给出的 registry/组织/仓库。用非 latest、非复用 tag，例如 `review-<source12>-arm64`。审批后的登录/推送按该区域 SWR 控制台提供的指令执行；不要把带密码的指令粘入本手册或运行记录。[SWR 客户端上传](https://support.huaweicloud.com/usermanual-swr/swr_01_0011.html)。

**推送前先确认 SWR 版本与产物媒体类型。** 当前大陆 SWR 基础版官方页明确不支持 OCI v1.0/v1.1 镜像规格，企业版另有支持；不能假设 Buildx 默认 OCI/provenance 索引可以上传基础版。Docker 本地运行通过仅证明该本地镜像可运行。按实际 registry 支持选择构建输出并复核 manifest 类型，未核对时停止推送步骤；本项目没有验证 SWR 上传/拉取，不自动购买企业版。[SWR 镜像规格限制](https://support.huaweicloud.com/usermanual-swr/swr_01_0011.html)。

推送后独立记录 SWR manifest digest，复核 registry/path/tag 与架构。Docker 的本地 image ID 是另一种标识，不能填充 SWR digest。若创建界面只允许 tag/path，使用独占 tag，保存它当时解析出的 digest，禁止覆盖；若租户明确支持 digest 引用再使用该形式。项目没有实际验证创建 API 接受 `@sha256` 的所有路径。

创建固定 Runtime 版本，并建立明确 alias，例如 `review-v1`。关闭灰度，将 100% 流量绑定该版本；保存 `source commit → SWR digest → Runtime version → alias` 映射。默认 Latest 总是指向最新版本，本客户端拒绝它；固定 alias 仍可被管理人员移动，名称本身不构成不可变保证。升级建立新版本/新 alias，验收后人工切换并保留回滚版本。[访问方式管理](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_048.html)。

## 3. Runtime 必须满足的部署边界

默认server只接受v3，新Action统一走强制bwrap路径。生产不要设置`AGENTARTS_ENABLE_LEGACY_PROTOCOLS`；其值`true`只为旧v1/v2本地bench保留较弱隔离兼容入口。历史live-review与prove:local数据不能因此升级成v3验收。

| 设置/检查         | 本版要求                                                                                 | 未满足时                             |
| ----------------- | ---------------------------------------------------------------------------------------- | ------------------------------------ |
| HTTP              | `0.0.0.0:8080`；`GET /ping`、`POST /invocations`；标准精确匹配                           | 不进行真实 PR 调用                   |
| 启动身份          | root supervisor；DSH UID/GID10001；补充组清空                                            | 失败关闭；禁止测试豁免上线           |
| capabilities      | supervisor 有 CHOWN、DAC_OVERRIDE、KILL、SETGID、SETUID                                  | 不能声称凭据隔离/超时清理成立        |
| 运行文件          | 镜像代码 root 所有、不可被 worker 写；每任务本地只读输入与私有状态                       | 拒绝结果                             |
| 存储              | 第一轮不挂会话/OBS/SFS 持久存储                                                          | 先撤回设计，不把共享卷充当私有工作区 |
| namespace/seccomp | 固定bwrap；user/PID/network/IPC/UTS及文件namespace，允许受信setup后追加worker BPF        | 失败关闭，无UID-only或宿主执行兜底   |
| 网络              | supervisor访问固定DeepSeek；DSH网络namespace仅loopback，经Unix socket模型/批准egress代理 | 保留实际失败，不放开任意外网         |
| 云元数据/委托     | 审计最小委托；验证 worker 不可取得实际云身份凭据                                         | 视为安全验收失败，停止发布验收       |
| 生命周期          | v3单轮最多30分钟，Controller总截止与平台时限共同满足；首次Review可用10分钟               | 不沿用旧Runtime Session重放任务      |
| 日志              | 开启并能按 taskId/head 查询实际 Runtime JSON 日志                                        | 云端链路证据不完整                   |

平台隔离不同 Session；同一 Session 内 supervisor 与 DSH 的 UID/文件/网络边界由本项目和租户条件共同保证。会话存储启用后不能关闭，其 FUSE 权限不保证运行时 chmod/chown 生效，故本版不使用它。生命周期范围见官方指南；客户端或示例中的 900 秒不是普通 HTTP 服务端硬上限。[会话管理](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_119.html)。

当前v3必须给worker创建独立user/PID/network等namespace，固定`/workspace`和`/dsh-home`只挂当前任务获准目录。worker为UID/GID10001、清空groups/capabilities，父进程环境、host文件、云网络不可直接访问；受信Unix socket桥只提供模型和批准出站入口。实际启动probe检查UID/cap/只有loopback，未通过即拒绝，无fallback。原只读v1/v2记录中的`networkIsolated:false`是历史实现，不能用来代表当前v3。

当前镜像从固定Debian `bubblewrap 0.8.0-2+deb12u1` 源码构建，保留四项Debian补丁，仅把新PID namespace的procfs mount选项改为 `subset=pid`。三份source输入逐SHA验证、无fuzz应用本地dated patch，再核对完整patched C SHA；`--with-priv-mode=none`、0755无setuid，使用Debian `dpkg-buildflags hardening=+all`。完整orig/Debian源码archive、descriptor、本地补丁、许可/copyright与构建脚本/flags随镜像 `/usr/share/doc/bubblewrap/agentarts-source` 提供，编译器不进入Runtime。[来源](../../agentarts/bubblewrap-source.json)、[补丁](../../agentarts/bubblewrap-proc-subset.patch)、[LGPL-2.0-or-later](../../agentarts/LICENSE.bubblewrap)。

`subset=pid`自Linux5.8提供，隐藏非任务相关的系统proc条目；worker没有 `/proc/sys`、`/proc/meminfo` 等文件，依赖它们的工具须另验。版本号不是足够条件，目标内核/LSM/父proc挂载仍须实际probe通过；保留Docker masked paths，不挂宿主proc，也无完整proc回退。**a3e原生Ubuntu24双架构CI在专用AppArmor enforce下仍报proc mount EPERM**，不能承诺此补丁解决masked-parent限制；本地WSL固定模型通过不能替代该宿主或云验收。[proc mount选项](https://man7.org/linux/man-pages/man5/proc.5.html)、[实际记录](verification.md)。

Docker外层需使用固定 [seccomp-bwrap.json](../../agentarts/seccomp-bwrap.json)：它基于固定Moby Apache-2.0默认profile，仅新增`clone/unshare/mount/umount2/pivot_root/setns`的namespace setup能力；worker启动后追加项目BPF拒绝新的namespace创建并保留普通Node线程。无需CAP_SYS_ADMIN、privileged或开放Docker socket。目标AgentArts租户是否允许这些syscalls、unprivileged user namespace和自定义seccomp仍待验收，标准HTTP容器支持不保证满足该要求。来源/许可证见 [第三方声明](../../THIRD_PARTY_NOTICES.md)。

启用AppArmor的Docker宿主还需允许bwrap的user namespace、挂载与root pivot；仅seccomp允许syscall不代表宿主LSM允许。Ubuntu24.04默认限制非特权user namespace；Docker默认profile还有mount拒绝。项目提供独立固定profile，详见 [3.2](#32-apparmor宿主策略)，不修改宿主docker-default或关闭AppArmor。[Ubuntu发布说明](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890)、[Docker AppArmor](https://docs.docker.com/engine/security/apparmor/)。

网络扩展/包安装由监督进程`AGENTARTS_EGRESS_ALLOWED_ORIGINS`精确origin JSON白名单控制，默认空列表，默认拒绝私网、loopback、link-local/metadata等地址，DNS解析后再次核对。批准registry仅在确有安装需要时配置，例如`["https://registry.npmjs.org"]`；额外tarball/MCP origins需独立确认，不使用通配域名，不把URL内凭据带入请求。代理不能让不遵循代理的任意子进程自动联网；扩展需逐项验证。明文env/header secret不能放extension plan，credentialed扩展须受信Controller回调或监督进程专属代理，当前直接定义会拒绝。

仍须真实租户验证对父环境、root文件、云元数据临时凭据入口与网络拒绝的结果；诊断只记拒绝/状态，不展示或持久化凭据。平台不能满足边界时停止部署验收，不扩大委托或降级宿主执行。[委托说明](https://support.huaweicloud.com/highcode-agentarts/agentarts_10_226.html)。

普通HTTP调用总超时、32MiB body上限、断开传播、namespace/seccomp/capabilities与模型/registry出站尚待真实租户验证。审查不执行PR代码；写任务执行仅在获原trusted-write授权后于namespace内进行，独立测试仍在Controller无凭据容器，不使用Docker-in-Docker。生产镜像没有宿主执行降级。

### 3.1 可选的只读 MCP 凭据代理

[operator references示例](../../agentarts/examples/mcp-credential-references.example.json) 是一个数组，对应监督进程`AGENTARTS_MCP_CREDENTIAL_REFERENCES`。将`.invalid`占位URL替换为自己批准的真实HTTPS MCP endpoint；相同`serverId`和完整URL须与 [Controller MCP定义](../../agentarts/examples/mcp-conventions.example.json) 一致。示例工具读取版本化仓库约定，不授远端写权限；示例没有已部署服务。

监督进程配置分三项，均由操作者选择，任务不能覆盖：

```text
AGENTARTS_MCP_CREDENTIAL_REFERENCES = operator JSON数组（不含secret值）
AGENTARTS_EGRESS_ALLOWED_ORIGINS = ["https://tools.example.invalid"]
AGENTARTS_TOOL_CONVENTIONS = 该工具服务专用、只读、可撤销凭据（敏感配置）
```

真实值通过平台受限敏感配置交给supervisor，不写Git、JSON示例、镜像、argv、task body、Profile、日志或Demo。当前MCP引用读取`AGENTARTS_TOOL_*`环境变量，不支持该引用的`*_FILE`或CSMS自动取值；模型key的`DEEPSEEK_API_KEY_FILE`是独立机制。部署者可见的环境导出须按secret处理，不作为演示材料。禁止复用GitHub写token、模型key或Runtime/local入站key，代码会检查已知主凭据值复用。

`prefix`支持空字符串、`Bearer `和`Basic `。Basic的敏感变量必须是规范base64编码的UTF-8 `user:password`，用户名和密码都非空且无控制字符；编码值、解码后的整值和密码及其常见编码都会参与回显阻断，解码后的主凭据复用也拒绝。不要把base64当成加密或可公开材料。

Controller的`mcp-config`使用上述无secret定义，controlled的`allowed-tools`加入`mcp.conventions.read`（以及确需的workspace工具）。不要添加Authorization/header/env中的真实key；task只有逻辑serverId/URL、当前有效工具grants与绑定摘要，supervisor自行匹配operator reference。原controlled/native Profile会被受信进程准确映射到密封Unix socket桥，模型只看到代理地址。controlled列表/调用均限定当前grant与operator只读名单的交集及预算；native清单由DSH负责，凭据代理仍仅暴露operator批准的只读工具。

生产凭据传输强制HTTPS，精确origin/DNS/IP/元数据检查仍执行，禁止redirect。只支持Streamable HTTP POST、JSON或完整有限SSE，单请求≤256KiB、响应≤2MiB；GET/DELETE返回405，不支持OAuth、长订阅或任意stdio/Plugin凭据注入。凭据回显（含已知常见编码）会阻断整次任务，不把错误正文发模型或发布。MCP Session header只接受本任务上游实际产生的值，不复用旧Session。

调用上限分别限制当前工具和同server整组：controlled取operator上限与当前grants上限的较小值，native仍受operator名单和上限约束。工具调用失败也消耗已预留的调用次数；初始化、列举等RPC另受每桥128请求、4并发上限和任务截止限制。调用次数不是服务费用或账单硬上限；MCP服务、Runtime和模型计费分别核对，缺少可靠计量时记录unknown。

本地测试使用隔离namespace、确定性模型和MCP测试服务；HTTP豁免只存在受信test API seam，不能由环境/task启用。Linux实际DSH/MCP测试及后续拒绝负例按 [验证记录](verification.md) 保存各自范围；不能写成华为Gateway/MCP已接入。第一条云Review仍先验收Runtime安全，工具服务与凭据权限独立确认。

### 3.2 AppArmor宿主策略

[apparmor-runtime.profile](../../agentarts/apparmor-runtime.profile) 名为 `agentarts-runtime-bwrap-v1`，固定来源/修改见 [apparmor-source.json](../../agentarts/apparmor-source.json)。它保留固定Moby默认规则的其它部分，使用AppArmor4 ABI，增加 `userns create`，将原 `deny mount` 替换为 `mount`，并只允许bwrap0.8的两处固定root pivot。**mount规则本身没有按路径收窄**；它必须与外层五cap/no-new-privileges、bwrap固定输入、worker清空capabilities和阻断新namespace的BPF一起使用，不能把该profile当作独立沙箱。[AppArmor规则](https://manpages.ubuntu.com/manpages/noble/man5/apparmor.d.5.html)。

这是宿主操作者权限，不能由task要求或在不可信worker里加载。确认本机支持ABI4、同名策略未被其它部署使用后，操作者可在仓库根目录加载并运行无真实凭据的本地smoke：

```bash
node scripts/generate-agentarts-apparmor.mjs
sudo apparmor_parser -a -K "$PWD/agentarts/apparmor-runtime.profile"
AGENTARTS_APPARMOR_PROFILE=agentarts-runtime-bwrap-v1 \
  AGENTARTS_TEST_PLATFORM=linux/amd64 bash agentarts/local-container.sh
```

`-a`在同名策略已存在时拒绝，避免覆盖其它部署。单独启动本手册的 `docker run` 时，在同样确认策略已加载的宿主追加 `--security-opt apparmor=agentarts-runtime-bwrap-v1`；环境变量只由local-container脚本解释，不会自动改变任意Docker命令。所有使用该profile的专用容器停止后，只有本次确实创建且不共享的策略才可清理：

```bash
sudo apparmor_parser -R "$PWD/agentarts/apparmor-runtime.profile"
```

GitHub-hosted CI的 [ci-apparmor.sh](../../agentarts/ci-apparmor.sh) 先用同image运行封闭环境、无key/模型/网络的固定probe，保存有限stderr和内核bwrap拒绝；再加载独立profile、复probe和完整smoke，always仅卸载本次自建策略。它拒绝覆盖已有同名profile，不改docker-default、daemon或sysctl。无AppArmor执行的WSL通过与parser语法通过均不证明策略enforcement；原生CI实际结果见 [验证记录](verification.md)。

AgentArts是否允许指定/加载宿主profile、相应namespace/mount/pivot策略仍未确认。不要求租户关闭AppArmor，不用unconfined、SYS_ADMIN、privileged或全局sysctl豁免；平台不能满足时停止部署验收，先讨论保留边界的替代部署方式。

## 4. 本地预检与复现

MCP配置与模型预算、入站认证分别管理；先检查下面配置和第3节namespace/网络边界，再执行任何任务。

从 [配置示例](../../agentarts/examples/deployment-config.example.json) 复制到本地工作目录，填入非敏感的实际参数。示例刻意保留不可通过的占位 commit/digest/origin，防止把模板当成已部署配置。`readiness` 是操作者填写的状态，不是脚本生成的云端证据。

```bash
node agentarts/preflight.mjs --config /absolute/path/to/deployment-config.json
node agentarts/preflight.mjs --config /absolute/path/to/deployment-config.json --inspect-image huawei-agentarts-action:review-local
```

第一条只读本地 JSON；第二条可选查询本地 Docker 镜像的 Linux/架构/image ID/USER/RepoDigests 元数据，不读取镜像 ENV，不 pull、不 run。Linux 默认固定本地 `unix:///var/run/docker.sock`，Windows 固定本地 pipe；rootless 可显式传 `--docker-host unix:///run/user/1000/docker.sock`。拒绝 TCP/SSH 等远程 daemon。检查 Docker 时使用私有临时空配置和封闭环境，不加载操作者 registry 登录凭据，随后清理该临时目录。

脚本不读取key值，只按名称报告当前进程是否存在`AGENTARTS_RUNTIME_API_KEY`、`DEEPSEEK_API_KEY`、`GITHUB_TOKEN`；存在不代表正确，也不检查FILE注入或远程Secret。不要把分属Controller/supervisor的key集中复制。输出始终为`cloudAcceptance: unverified`，不创建资源或调用服务。86da6b0起 `readiness.namespaceAndSeccompVerified` 与 `privateProcfsVerified` 均必填，示例为false；相关12项测试通过。它们是操作者需有证据支持的声明，不是脚本自动探测，不得由ping、普通CI或WSL通过推断目标租户已就绪。实际namespace/privateproc、extension egress、完整body/Session与写场景另验。

### 4.1 最终镜像与确定性模型 smoke

以下 Linux/Bash 脚本运行真实 DSH 和本地 SSE 模型夹具；无真实模型 key、GitHub token 或华为调用。构建需要获取锁定基础镜像/npm 依赖，故“本地”不代表构建完全断网。本轮新源码是否实际执行通过，以单独新记录为准；旧双架构 CI 只证明其记录中的 commit。

```bash
bash agentarts/local-container.sh
```

在仓库根目录运行。脚本固定只支持linux/amd64、linux/arm64，按实际image ID记录HTTP/UID/工具/重复/截止检查；具体case以当次smoke为准，旧9场景仅覆盖v1/v2。测试容器无外网、仅模型夹具loopback、五项caps，不挂Docker socket或凭据。v3必须额外使用本节固定seccomp策略并完成full-task场景，不能以旧smoke证明新写/native/Session。记录在`work/container-x64/`（可用AGENTARTS_EVIDENCE_DIR更改），source/dirty/digest不是签名证明。

```bash
AGENTARTS_TEST_PLATFORM=linux/arm64 bash agentarts/local-container.sh
```

新v3的ARM64 namespace/BPF验收必须使用匹配架构的原生ARM64 Linux kernel/daemon；worker会检查AUDIT_ARCH，x64上的用户态QEMU不能证明ARM kernel seccomp。上述ARM命令须在原生ARM宿主执行。QEMU只可用于构建/旧只读smoke兼容检查，记录emulated，不把旧QEMU通过升级为本轮ARM安全验收。镜像CI使用原生`ubuntu-24.04-arm`，其实际结果以对应新run为准；当前不预先宣称ARM通过。Windows可在已配置Docker的Linux环境执行AMD64流程。[GitHub官方runner架构](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

本轮统一构建导出格式为 `--provenance=false --sbom=false --output type=image,oci-mediatypes=false`，避免Docker新版默认OCI索引/attestation混入单架构SWR候选。需单独构建时使用同样参数：

```bash
docker build --platform linux/amd64 --file agentarts/Dockerfile \
  --provenance=false --sbom=false --output type=image,oci-mediatypes=false \
  --tag huawei-agentarts-action:local-x64 .
```

仍须检查实际 `image-descriptor.json`/registry manifest，而不只相信flag；构建工具/镜像存储方式可能改变结果。Docker官方将 `oci-mediatypes` 作为export格式参数；此处格式选择不保证目标SWR接受，真实上传/拉取尚未验证。[Docker image exporter](https://docs.docker.com/build/exporters/image-registry/)。

#### 额外扩展安装与Session复验

[check-image-extensions-session.sh](../../agentarts/check-image-extensions-session.sh) 接收四个参数：本地固定image ID、干净源码checkout绝对路径、已安装dev dependencies的目录、全新输出目录。dependency目录的package-lock须与源码一致，可先单独 `npm ci --ignore-scripts` 准备；它不是模型/GitHub凭据目录。示例中的镜像必须已在本机构建并独立核对，不表示镜像已公开或SWR可拉取：

```bash
bash agentarts/check-image-extensions-session.sh \
  sha256:469ce7fb699c031cc012b94a20f04e7dbca687d527824ce554600f76f459f217 \
  /absolute/path/to/clean-source /absolute/path/to/dev-dependencies \
  /absolute/path/to/new-evidence
```

脚本先读真实bwrap ELF与BUILD flags检查加固，再用五cap/no-new-privileges/只读source与dev-dependencies，在镜像真实Node/npm/bwrap下跑private-permissions、默认安装器和Session测试。需要明确允许公共npm registry下载固定包，模型仍为本地夹具，无真实key/云/GitHub调用。它是 **container-source-harness**，与部署bundle HTTP smoke分别记录；新脚本完整自验以自己的binding/outcome/log为准，不能把先前单独harness的2passed/84.06s写成此脚本的全部用例通过。已有输出拒绝覆盖，失败保留原因；启用AppArmor宿主可沿用3.2的已加载profile选择，仍须实际probe通过。

Docker客户端使用空临时配置及固定本地 `/var/run/docker.sock`，忽略继承的远程context/凭据；缺少本地镜像时拒绝隐式拉取。每次仅清理随机命名且带本次label的两个容器，实际清理状态另写 `cleanup.json`。默认总时限240秒；可用 `AGENTARTS_IMAGE_PROOF_TIMEOUT_SECONDS=1` 和全新输出目录复现限时拒绝。最终脚本完整5项通过、正常清理及1秒超时清理分别留有 [独立记录](verification.md#最终本地610f685镜像与五cap额外验证)，不把超时退出124写成任务成功。

### 4.2 v3固定任务计划与历史Review benchmark

新 [live-full CLI](../../src/agentarts/live-full.ts) 使用v3 FullEngine，固定Review/clean、diagnose、fix、写task、implement与native写任务。写候选在Controller执行冻结契约的独立Docker测试，不发布GitHub；真实模型仍须独立预算授权，dry-run不读取模型key、不调用服务。完成`build:agentarts`的live-full入口后可先查看单例计划：

```bash
node dist-agentarts/live-full/index.js --mode local-real-model --dry-run \
  --runtime-origin http://127.0.0.1:18080 --max-cases 1 --case-ids fix-bounds \
  --timeout-ms 120000 --max-model-requests-per-case 6 --max-output-tokens 2048
```

真实`--execute`仍需`--budget-usd`、`--confirm-budget I_ACCEPT_METERED_MODEL_CALLS`、实际`--image-digest`/`--source-commit`和新的`--out`，并核对受信模型policy与独立validation image digest。每case固定一轮，没有真实GitHub发布，人工判读和账单成本另记；不要把自动契约通过写成全部原能力或云通过。多轮修复由单独原Controller integration测试覆盖。Runtime与CLI使用同一**临时本地**`AGENTARTS_LOCAL_API_KEY`，不复用云key。

以下`live-review`是旧v1只读四案例benchmark。要执行它，local supervisor必须单独显式启用`AGENTARTS_ENABLE_LEGACY_PROTOCOLS=true`；该兼容模式隔离较弱，不在云部署命令启用，不证明v3/write/native。默认生产配置会拒绝旧协议；dry-run本身仍可离线运行。

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
# Only a fresh, local test key; never copy the real AgentArts gateway key here.
export AGENTARTS_LOCAL_API_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
docker run --detach --name huawei-agentarts-review-local --init --read-only \
  --publish 127.0.0.1:18080:8080 \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
  --cap-add DAC_OVERRIDE --cap-add KILL --security-opt no-new-privileges \
  --security-opt "seccomp=$PWD/agentarts/seccomp-bwrap.json" \
  --pids-limit 256 --memory 1g --cpus 2 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=536870912 \
  --mount "type=bind,source=$agentarts_key_dir/deepseek_key,target=/run/secrets/deepseek_key,readonly" \
  --env DEEPSEEK_API_KEY_FILE=/run/secrets/deepseek_key \
  --env AGENTARTS_INBOUND_MODE=local --env AGENTARTS_LOCAL_API_KEY \
  --env AGENTARTS_MODEL_EVIDENCE=live-provider \
  --env AGENTARTS_DEEPSEEK_MODEL=deepseek-v4-pro \
  --env AGENTARTS_MAX_MODEL_REQUESTS=6 --env AGENTARTS_MAX_OUTPUT_TOKENS=2048 \
  "$agentarts_image_id"
```

真实模型需要supervisor实际出站；确定性smoke的`--network none`不能直接复用。本命令在仓库根目录运行，固定seccomp文件绝对路径；外层Docker默认网络不证明云边界，v3内层仍强制network namespace。首次`/ping`通过不证明模型调用、v3 namespace或云成功；真实Review调用前核对namespace拒绝检查，并遵守模型费用授权。不要打印容器ENV或模型正文。

结束本地试验，先停止并删除本专用容器；停止失败须检查实际状态，不能接着宣称清理完成。确认挂载已解除后只删除先前生成的单文件和空私有目录，禁止批量/递归删除未知目录：

```bash
docker stop --time 10 huawei-agentarts-review-local || exit 1
docker rm huawei-agentarts-review-local || exit 1
case "$agentarts_key_dir" in /tmp/agentarts-model-key.*) ;; *) exit 1 ;; esac
rm -- "$agentarts_key_dir/deepseek_key"
rmdir -- "$agentarts_key_dir"
unset agentarts_key_dir
unset agentarts_image_id
unset AGENTARTS_LOCAL_API_KEY
```

## 5. 审批后按顺序验收

先核对目标租户可提供等价namespace/privateproc/seccomp/LSM/五cap；能力未确认或无法满足时暂停该路线，不新建资源硬试。通过能力核对后，再得到账号、资源创建/费用与私有部署的明确授权，执行最小固定候选的实际probe和验收。备选架构须另行评估并取得用户同意，不能冒充当前已兼容。命令与各环境证据由 [验证记录](verification.md) 分别保存。

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
