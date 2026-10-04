# 验证记录

日期：2026-10-04。项目 Huawei-AgentArts-action；上游基线 `891570ef2254334dff8de22af948f3f0105e933e`，DSH `0.2.0-rc.2`，Node `24.15.0`。完整上游源码、共同Git历史、许可和声明保留，原仓库未写入。本轮仅本地提交，未push、未创建云资源、未公开发布。

本轮保留通用修复 `aa05620a609f60e4cbe89dd0af87515e8bfafcce`（CI工作区固定失败run的commit）和华为适配 `ed1050067ad74fd533461cba793a3f7d8dc14f81`，随后补充有限失败诊断、只读skipped声明与镜像构建修正。各次测试、容器构建和模型评测分别记录源码，不能声称所有验证期间HEAD相同或工作树始终clean；真实模型记录的操作者source声明也不等于镜像attestation。

## 本轮已经实际完成

| 项目                          | 实际结果                                                                         | 证据与适用范围                                                                                                                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 最新Windows完整回归及coverage | 1890通过、8跳过；112测试文件通过、1文件跳过，110.24s                             | 原通用实现与新增只读v2、模型配额/诊断、文件传输、安全/取消/协议；跳过项按平台条件保留。日志在 `outputs/pr-review-validation/windows-regression-idle.log`                                                                                                                         |
| 最新Windows覆盖率             | statements85.37%、branches78.8%、functions93.17%、lines87.46%                    | 表示测试覆盖，不表示模型发现缺陷、修复正确或业务通过                                                                                                                                                                                                                             |
| Linux权限/传输/工作区定向测试 | 69通过、0跳过，3.68s                                                             | supervisor secret13、workspace transfer51、Controller workspace5；真实Linux权限/文件行为，GitHub API为受控测试，非AgentArts。Windows传输50通过/1POSIX executable跳过由这里补齐                                                                                                   |
| 最新静态、合同和构建检查      | 通过                                                                             | typecheck、ESLint、generated Action contract、继承release contract、固定DSH配置、root build:check与build:agentarts四入口；原README归档后，旧metadata/发布断言改为读取归档，未删除旧断言                                                                                          |
| 当前完整本地Review            | 通过；记录总耗时4843ms                                                           | [当前实际记录](../../agentarts/evidence/current/local-run-record.json)：本地HTTP→真实DSH→read→Controller协议/绑定/回执→独立diff/oracle。modelEvidence为deterministic-fixture，PR为夹具，GitHub发布skipped；Windows使用显式测试UID豁免                                            |
| 固定四任务/真实DeepSeek       | 最终suite四例自动rubric通过；共8次provider请求                                   | pr-review-boundaries-v1含两defect/两clean；本地DSH/生产容器/真实DeepSeek，合成PR、无GitHub发布/云调用，人工仍not-reviewed、成本unknown。旧失败独立保留，详见下节与 [评测](evaluation.md)                                                                                         |
| v2 task/diagnose接入          | 代码接入，保留原loop/finalizer                                                   | 工具授权/空input、taskDigest/entity/commit/output schema、反馈与拒绝路径已测；注入transport/provider的Controller回调属于模拟。最新两架构生产镜像HTTP/DSH/read/typed output通过，真实GitHub/云尚未验收                                                                            |
| Demo真实浏览器QA              | 本地夹具20场景/46定向测试通过；真实模型回放initial12/retest3/final12截图检查通过 | [夹具浏览器元数据](../../agentarts/evidence/current/browser-qa.json) 与 [最终真实模型回放QA](../../agentarts/evidence/current/live-model/browser-qa/final.json)：独立fresh-profile/headless Edge154、1280/390/320，无overflow/page/CSP错误；记录只回放不重执行，人工评测仍未完成 |

当前两份JSON按原字节复制进仓库，没有转写或补造字段：local-run-record SHA256 `95b83b56186d9f5b6c088c96ef336c7ac282e40e3c0a31b9aff0b6df8a74e90b`；browser-qa SHA256 `f42a12df7628e0c94642545ef9c01720f524877add01347377741259a08c91f4`。截图保留本地 `outputs/pr-review-demo-qa/current/`，未放Git或公开托管；浏览器检查不证明云调用或模型效果。

最新完整回归之前，高负载执行曾实际得到3失败/1887通过/8跳过，694.95s；单独相关23项复测通过，42.45s。随后重新执行完整suite，才得到上表1890/8、110.24s的通过结果；初次失败日志保留，不改写成通过，也不以23项单测替代完整回归。较早1863/8、119.65s与对应覆盖率仅适用于先前工作树。

文件传输是实作原型，不是开放写能力：真实bytes/UTF-8或base64、SHA/mode、repository/commit/revision/digest、source baseline复查、保护路径、完整stage/rollback和上游strict完整性分类已测。它不含完整task/ref授权，不运行仓库测试/发布；fix、implement、task --write仍拒绝。范围见 [能力迁移表](capability-matrix.md)。

## 最新生产容器候选：两架构独立实测通过

两份smoke均为 `sourceDirty: false`，sourceTreeDigest（构建输入摘要）同为 `612909c530a4b17669d3d3a1fd6888bf0bbf1ffc235acc6b02380320af17b6cc`，保留各自实际source commit，不改写成同一HEAD。真实DSH/UID10001/native read使用确定性模型夹具，smoke未调用真实模型、云或GitHub。

| 架构/固定源码                                                         | 实际image/manifest ID                                                     | 实测结果                              | 原始证据                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AMD64，emulated=false；`cd9ce8eac73fd0b873fab9f197c98c0714312db9`     | `sha256:a3e1d38dd8dca372da34eb2c4c7bc3413dc0b401b1a00d7fb99f07579ca7f752` | 9场景passed、14239ms；2启动拒绝passed | [smoke](../../agentarts/evidence/current/candidate-container-amd64.jsonl)、[启动拒绝](../../agentarts/evidence/current/candidate-startup-amd64-negative.jsonl)、[descriptor](../../agentarts/evidence/current/candidate-image-amd64-descriptor.jsonl)      |
| ARM64 QEMU，emulated=true；`60b7e95bbd0eb549016ca6ff23852da1294cb6c8` | `sha256:64f9a7cad6833594de0740ea8783bb9a051f7a7b795d2d3ec1739a2f6badd304` | 9场景passed、89559ms；2启动拒绝passed | [smoke](../../agentarts/evidence/current/candidate-container-arm64-qemu.jsonl)、[启动拒绝](../../agentarts/evidence/current/candidate-startup-arm64-negative.jsonl)、[descriptor](../../agentarts/evidence/current/candidate-image-arm64-descriptor.jsonl) |

两份descriptor实测为Docker Schema2 `application/vnd.docker.distribution.manifest.v2+json`；尚未上传SWR。AMD64同镜像另用于下述真实模型评测，两次执行分别记录。QEMU注册已卸载，ARM不是原生硬件/云性能证明；总耗时含拒绝/取消/超时场景，不当作正常任务延迟。较早d9和历史CI保留原范围。

之前一次冷cache构建遇到npm ECONNRESET，没有运行smoke，不算容器通过；缓存复用后得到上述AMD64构建/运行结果。两种架构均不是AgentArts/SWR验收。

## 较早d9容器：仅对应固定源码的两架构实测

两份原始记录均绑定源码 `d9b8dc29b158b731e7dd2cb76e682d8d54598630`，`sourceDirty: false`、`sourceTreeDigest: 4949a96264f3cf5e5ec6e153e9cc52a5e3ad92c890170e240277b656d464f678`。按 [local-container.sh](../../agentarts/local-container.sh) 从该clean源码构建，仅编译Runtime生产bundle（--runtime-only），host Controller/评测bundle不放入部署镜像。

| 架构与执行方式            | 实际image ID                                                              | 实测结果与耗时                        | 原始证据                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AMD64，emulated=false     | `sha256:bbddbfd69c320119d516400138b0f632e3809d769a106d27f4cb6783959156ca` | 9运行场景通过，13150ms；2启动拒绝通过 | [smoke](../../agentarts/evidence/current/container-amd64.jsonl)、[启动拒绝](../../agentarts/evidence/current/startup-amd64-negative.jsonl)、[descriptor](../../agentarts/evidence/current/image-amd64-descriptor.jsonl)      |
| ARM64，QEMU emulated=true | `sha256:376cf327f67af3f28d854c22afd261e7a9eebfc33da948df0d2bf9aabe5af549` | 9运行场景通过，99895ms；2启动拒绝通过 | [smoke](../../agentarts/evidence/current/container-arm64-qemu.jsonl)、[启动拒绝](../../agentarts/evidence/current/startup-arm64-negative.jsonl)、[descriptor](../../agentarts/evidence/current/image-arm64-descriptor.jsonl) |

9场景为v1Review、v2typed task、diagnose、重复task、未授写入、实际DSH读取supervisor进程环境被拒绝、非法模型结果、取消后清理和超时后清理。真实DSH `0.2.0-rc.2`、UID/GID10001、native read、结果与工作区摘要/回执均核对；模型和PR/CI为确定性夹具，未调用真实模型、华为或GitHub。启动拒绝分别确认缺少必要capabilities、模型key文件权限可被其他用户读取时，在health之前失败关闭。测量总耗时含取消/超时案例，ARM使用QEMU，不能当正常云延迟或原生ARM通过。

Docker29首次dirty试运行默认生成OCI index/attestation；正式d9构建使用 `--provenance=false --sbom=false --output type=image,oci-mediatypes=false`，两份descriptor都实测为 `application/vnd.docker.distribution.manifest.v2+json`。这是本地格式和digest事实，不证明SWR已接受或拉取。先前sourceDirty=true的AMD64试运行保留为较早记录，不替代这次clean源码证据。

**上述两架构证明只适用于d9源码和列出的镜像。** 后续诊断代码与最新候选的结果使用独立记录，不继承d9通过状态。

## 真实DeepSeek固定四任务：自动rubric通过，人工未复核

用户明确批准最多4个固定case、每case最多6次provider请求和120000ms时限、每次provider请求最多2048输出tokens，每次套件执行1美元参考预算。key由受信supervisor从root0600单文件加载，worker仅获代理token；固定合成PR/context不向GitHub发表，也未调用AgentArts。美元批准值不是账单硬上限，actualCost始终unknown。

最终runId `3a0614e9-2513-4173-9db8-fe99e95f4266`，记录声明source `ec39f6bebbf4856ea73a66bb11a32f31dc0e320e`，实际执行上述A3 AMD64镜像。其构建smoke的source commit为cd9ce8e，二者分别保存，不把评测声明写成构建证明。[原始suite](../../agentarts/evidence/current/live-model/final/3a0614e9-2513-4173-9db8-fe99e95f4266.suite.json) 四例自动rubric均passed，每例2次provider请求，共8次；bounds-defect保留1finding/9729ms，roles-defect2findings/12685ms，bounds-clean0finding/9284ms，roles-clean0finding/11905ms。完整表与独立oracle/rubric含义见 [评测](evaluation.md)。这些耗时来自评测记录，Demo记录另含少量收尾时间。

全部manualVerdict仍not-reviewed，successRate未计算。通过只证明此固定套件的自动执行和证据规则，不代表人工业务验收、泛化模型成功率、云端或真实GitHub闭环。真实模型Demo完成三次独立fresh-profile/headless Edge检查：initial12、roles-clean单例retest3、最终四例final12；正确标为本地/真实模型/历史回放，并保留无GitHub结果链接的空状态。截图和QA元数据保留在 `outputs/pr-review-demo-qa/live-model/`，页面加载不重新执行任务。

早期失败与复测按原字节归档： [b0be682c首次失败](../../agentarts/evidence/current/live-model/initial-failure/b0be682c-421d-49ac-b637-817438de5bd0.suite.json) 首例bounds-defect在19730ms返回Runtime HTTP500 WORKER_FAILED，后三not-run，modelExecution为null；[08bb3f89诊断轮](../../agentarts/evidence/current/live-model/diagnostics/08bb3f89-9474-4d48-ac80-b85f2706edf6.suite.json) 三例passed、roles-clean失败；[3b5c3e6c单例复测](../../agentarts/evidence/current/live-model/clean-retest/3b5c3e6c-fb7e-495e-8c83-6d459478f22a.suite.json) 只运行roles-clean并passed。最终四例是另一个runId；旧失败未抹去，未知计量/缺失证据不补造，不从后续通过推定旧失败的确定根因。

真实模型专用容器已停止删除，本地root key文件已删除，[清理检查](../../agentarts/evidence/current/live-model/secret-cleanup.json) 保留原字节；不在文档或Demo包含key值，也不声称清理了第三方账号中的共享资源。

## 历史证据：仅对应原记录源码

| 历史验证               | 固定源码/实际证据                                                                                                                                                                                                                                                         | 限制                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Windows首次完整测试    | 1652通过、3跳过；coverage84.75/78.07/92.63/86.84%                                                                                                                                                                                                                         | 历史快照，不替代当前1890回归                                                                                      |
| 历史Linux完整CI        | [运行37190222963](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37190222963)，commit28b4b4b8ce33f02d5b2abe4ebd68292f2533c1bd，1677通过/1跳过                                                                                                         | 历史源快照与平台差异，不是当前只读v2/transfer代码CI                                                               |
| Windows首次本地Review  | [原记录](../../agentarts/evidence/local-run-record.json)                                                                                                                                                                                                                  | 真实DSH、确定性模型/PR，Windows测试UID豁免，没有GitHub发布                                                        |
| Linux首次独立UIDReview | [原记录](../../agentarts/evidence/linux-run-record.json)                                                                                                                                                                                                                  | WSL Ubuntu，非容器/云；UID/GID10001、补充组清空、root私有文件与父进程/proc环境不可读                              |
| AMD64首次生产镜像CI    | [原记录](../../agentarts/evidence/container-amd64-initial.json)，源码d845474a236685300e751e77301112775297b5bb                                                                                                                                                             | 实际image ID sha256:f96f9aa55a0f8c54dc2b5a2d02aeda34cf638146a9d7b4dd2d1300e00f7c9c85，8804ms含超时案例，无SWR推送 |
| 历史双架构生产镜像CI   | [运行37187847055](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37187847055)，源码3957bbe4e6b589c7fd790a1a05ff86394d11be9f；[AMD64](../../agentarts/evidence/container-amd64.json)、[ARM64 QEMU](../../agentarts/evidence/container-arm64-qemu.json) | 真实DSH/UID/read、重复拒绝和超时清理，确定性模型；ARM64明确emulated=true，非原生ARM或AgentArts                    |

历史双架构image ID：AMD64 `sha256:a24ef93ffc9f255564706a4919c81f5cbca590d54e4d5f7f7367761f93da1e95`、8863ms；ARM64 QEMU `sha256:67b3f0ab8c8c174c6e7f5488fb4fb7db16310403a5373a49f2cc804eaad3e0ab`、33295ms。时间都含各自超时案例，不能当正常云延迟；image ID不是SWR manifest digest。原Actions artifact与保存JSON对应当次构建。

历史静态Demo导出22项定向测试和HTTP/CSP/字节检查通过；当时自动浏览器连接失败、没有视觉验收。当前已另用真实Edge完成20场景检查，不能把两次检查混为同一次运行。Windows过去多组真实DSH与构建同时执行曾碰到测试时限；本轮完整回归使用最多两个Vitest workers，产品截止未延长，未删除失败断言。

## 未完成的真实验收

| 项目                                       | 状态                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| 真实DeepSeek效果评测                       | 四固定case已自动rubric通过，人工业务判读尚未完成，无成功率/可靠成本；旧失败独立保留 |
| SWR上传/拉取                               | 未执行；媒体类型与目标SWR版本、digest/架构需实测                                    |
| AgentArts Runtime                          | 账号准入审批中，未部署或调用，无真实Session、LTS/运行分析证据                       |
| GitHub→AgentArts→DSH→评论                  | 未验收；本地/模拟GitHub不能代替真实事件、Controller写前head复查、评论链接和平台记录 |
| Gateway/MCP/平台评估                       | 已调查，未接入，不伪造工具接入或评分                                                |
| 云端fix/Issue→PR/native/extensions/session | 原实现保留与适配边界明确，当前云入口未开放                                          |

真实云验收须核对固定SWR digest/架构、Runtime版本/单版本alias、UID/caps/元数据/出站、Session/taskId/base/head、实际工具回执、独立业务判定、GitHub结果、失败/过期head/权限拒绝/超时/取消/重复运行与清理状态。多轮Action记录汇总工具，但当前runtime/task/session/requestId保留最后一轮，不是完整平台Trace；未采集的轨迹留未知。步骤见 [部署手册](deployment.md)，业务判读见 [评测](evaluation.md)。

开发使用Codex与并行助手调查官方文档、编码和独立审查，使用Git/npm/TypeScript/Vitest/ncc、WSL/Linux/Docker与真实Edge/Playwright验证。固定测试模型来自原Messages SSE夹具。官方华为SDK仅作接口调查，没有新增Python运行依赖。开发工具与历史记录保留真实适用范围。
