# 验证记录

日期：2026-10-04。项目 Huawei-AgentArts-action；上游基线 `891570ef2254334dff8de22af948f3f0105e933e`，DSH `0.2.0-rc.2`，Node `24.15.0`。完整上游源码、共同Git历史、许可和声明保留，原仓库未写入。本轮仅本地提交，未push、未创建云资源、未公开发布。

本轮代码提交为通用修复 `aa05620a609f60e4cbe89dd0af87515e8bfafcce`（CI工作区固定失败run的commit）和华为适配 `ed1050067ad74fd533461cba793a3f7d8dc14f81`。测试在提交前对应工作树执行，随后相同代码提交；不能声称所有验证期间HEAD已经是这个commit或工作树始终clean。当前、dirty试运行、历史CI和云端状态分别记录。

## 本轮已经实际完成

| 项目                          | 实际结果                                                       | 证据与适用范围                                                                                                                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows完整回归及coverage     | 1863通过、8跳过；111测试文件通过、1文件跳过，119.65s           | 原通用实现与新增只读v2、模型配额、文件传输、安全/取消/协议；跳过项按平台条件保留，不是云端成功率。本地日志在 `outputs/pr-review-validation/windows-regression.log`                                                                    |
| Windows覆盖率                 | statements85.28%、branches78.73%、functions93.15%、lines87.38% | 表示测试覆盖，不表示模型发现缺陷、修复正确或业务通过                                                                                                                                                                                  |
| Linux权限/传输/工作区定向测试 | 69通过、0跳过，3.68s                                           | supervisor secret13、workspace transfer51、Controller workspace5；真实Linux权限/文件行为，GitHub API为受控测试，非AgentArts。Windows传输50通过/1POSIX executable跳过由这里补齐                                                        |
| 静态、合同和构建检查          | 通过                                                           | typecheck、ESLint、Prettier、generated Action contract、继承release contract、固定DSH配置及build检查。原完整README归档后，旧metadata/发布断言改为读取归档，未删除旧断言                                                               |
| 当前完整本地Review            | 通过；记录总耗时4843ms                                         | [当前实际记录](../../agentarts/evidence/current/local-run-record.json)：本地HTTP→真实DSH→read→Controller协议/绑定/回执→独立diff/oracle。modelEvidence为deterministic-fixture，PR为夹具，GitHub发布skipped；Windows使用显式测试UID豁免 |
| 固定四任务/live-review准备    | 代码与定向验证通过；两个CLI dry-run实际通过                    | pr-review-boundaries-v1含两defect/两clean，受信请求/输出上限与自动rubric，人工仍not-reviewed。simulation和local-real-model dry-run都execute=false/costunknown，没有真实provider调用                                                   |
| v2 task/diagnose接入          | 代码接入，保留原loop/finalizer                                 | 工具授权/空input、taskDigest/entity/commit/output schema、反馈与拒绝路径已测；注入transport/provider的Controller回调属于模拟。固定d9源码的双架构生产镜像HTTP/DSH/read/typed output通过，真实GitHub/云尚未验收                         |
| Demo真实浏览器QA              | 20截图/视口场景检查通过；46项定向测试通过                      | [当前浏览器元数据](../../agentarts/evidence/current/browser-qa.json)：真实安装Edge154、隔离fresh profile/headless渲染，pageErrors/CSP errors均0。Review读取上述真实本地记录，task/diagnose及失败页面是标明的simulation                |

当前两份JSON按原字节复制进仓库，没有转写或补造字段：local-run-record SHA256 `95b83b56186d9f5b6c088c96ef336c7ac282e40e3c0a31b9aff0b6df8a74e90b`；browser-qa SHA256 `f42a12df7628e0c94642545ef9c01720f524877add01347377741259a08c91f4`。截图保留本地 `outputs/pr-review-demo-qa/current/`，未放Git或公开托管；浏览器检查不证明云调用或模型效果。

文件传输是实作原型，不是开放写能力：真实bytes/UTF-8或base64、SHA/mode、repository/commit/revision/digest、source baseline复查、保护路径、完整stage/rollback和上游strict完整性分类已测。它不含完整task/ref授权，不运行仓库测试/发布；fix、implement、task --write仍拒绝。范围见 [能力迁移表](capability-matrix.md)。

## 本轮容器：固定d9源码的两架构实测

两份原始记录均绑定源码 `d9b8dc29b158b731e7dd2cb76e682d8d54598630`，`sourceDirty: false`、`sourceTreeDigest: 4949a96264f3cf5e5ec6e153e9cc52a5e3ad92c890170e240277b656d464f678`。按 [local-container.sh](../../agentarts/local-container.sh) 从该clean源码构建，仅编译Runtime生产bundle（--runtime-only），host Controller/评测bundle不放入部署镜像。

| 架构与执行方式            | 实际image ID                                                              | 实测结果与耗时                        | 原始证据                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AMD64，emulated=false     | `sha256:bbddbfd69c320119d516400138b0f632e3809d769a106d27f4cb6783959156ca` | 9运行场景通过，13150ms；2启动拒绝通过 | [smoke](../../agentarts/evidence/current/container-amd64.jsonl)、[启动拒绝](../../agentarts/evidence/current/startup-amd64-negative.jsonl)、[descriptor](../../agentarts/evidence/current/image-amd64-descriptor.jsonl)      |
| ARM64，QEMU emulated=true | `sha256:376cf327f67af3f28d854c22afd261e7a9eebfc33da948df0d2bf9aabe5af549` | 9运行场景通过，99895ms；2启动拒绝通过 | [smoke](../../agentarts/evidence/current/container-arm64-qemu.jsonl)、[启动拒绝](../../agentarts/evidence/current/startup-arm64-negative.jsonl)、[descriptor](../../agentarts/evidence/current/image-arm64-descriptor.jsonl) |

9场景为v1Review、v2typed task、diagnose、重复task、未授写入、实际DSH读取supervisor进程环境被拒绝、非法模型结果、取消后清理和超时后清理。真实DSH `0.2.0-rc.2`、UID/GID10001、native read、结果与工作区摘要/回执均核对；模型和PR/CI为确定性夹具，未调用真实模型、华为或GitHub。启动拒绝分别确认缺少必要capabilities、模型key文件权限可被其他用户读取时，在health之前失败关闭。测量总耗时含取消/超时案例，ARM使用QEMU，不能当正常云延迟或原生ARM通过。

Docker29首次dirty试运行默认生成OCI index/attestation；正式d9构建使用 `--provenance=false --sbom=false --output type=image,oci-mediatypes=false`，两份descriptor都实测为 `application/vnd.docker.distribution.manifest.v2+json`。这是本地格式和digest事实，不证明SWR已接受或拉取。先前sourceDirty=true的AMD64试运行保留为较早记录，不替代这次clean源码证据。

**上述两架构证明只适用于d9源码和列出的镜像。** 后续真实模型失败诊断引起的server/worker/CLI修改需绑定新源码重新验证，不能继承d9通过状态。

## 有限真实模型尝试：失败后已停止

在用户明确批准最多4个固定case、每case最多6次provider请求、2048输出tokens、120s时限与1美元参考预算后，已启动一次 `local-real-model` 尝试。key由受信supervisor从root0600单文件加载；固定合成PR/context不向GitHub发表，也未调用AgentArts。美元批准值不是账单硬上限。

首例 `bounds-defect` 在19730ms返回Runtime HTTP500 `WORKER_FAILED`，后三例为 `not-run`；没有可验收的审查结果。失败记录的 `modelExecution` 为null，真实provider请求数、token使用和成本仍未知，根因尚未确认。不能将这次尝试写成模型成功、完整四case执行或云端通过，也不能凭未知计量计算成功率/成本。原始评测保留本地 `outputs/pr-review-validation/live-model/`，未复制raw响应、模型正文或凭据到公开材料。后续只使用有界安全诊断和新runId重试；新修改与新执行另记。

## 历史证据：仅对应原记录源码

| 历史验证               | 固定源码/实际证据                                                                                                                                                                                                                                                         | 限制                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Windows首次完整测试    | 1652通过、3跳过；coverage84.75/78.07/92.63/86.84%                                                                                                                                                                                                                         | 历史快照，不替代当前1863回归                                                                                      |
| 历史Linux完整CI        | [运行37190222963](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37190222963)，commit28b4b4b8ce33f02d5b2abe4ebd68292f2533c1bd，1677通过/1跳过                                                                                                         | 历史源快照与平台差异，不是当前只读v2/transfer代码CI                                                               |
| Windows首次本地Review  | [原记录](../../agentarts/evidence/local-run-record.json)                                                                                                                                                                                                                  | 真实DSH、确定性模型/PR，Windows测试UID豁免，没有GitHub发布                                                        |
| Linux首次独立UIDReview | [原记录](../../agentarts/evidence/linux-run-record.json)                                                                                                                                                                                                                  | WSL Ubuntu，非容器/云；UID/GID10001、补充组清空、root私有文件与父进程/proc环境不可读                              |
| AMD64首次生产镜像CI    | [原记录](../../agentarts/evidence/container-amd64-initial.json)，源码d845474a236685300e751e77301112775297b5bb                                                                                                                                                             | 实际image ID sha256:f96f9aa55a0f8c54dc2b5a2d02aeda34cf638146a9d7b4dd2d1300e00f7c9c85，8804ms含超时案例，无SWR推送 |
| 历史双架构生产镜像CI   | [运行37187847055](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37187847055)，源码3957bbe4e6b589c7fd790a1a05ff86394d11be9f；[AMD64](../../agentarts/evidence/container-amd64.json)、[ARM64 QEMU](../../agentarts/evidence/container-arm64-qemu.json) | 真实DSH/UID/read、重复拒绝和超时清理，确定性模型；ARM64明确emulated=true，非原生ARM或AgentArts                    |

历史双架构image ID：AMD64 `sha256:a24ef93ffc9f255564706a4919c81f5cbca590d54e4d5f7f7367761f93da1e95`、8863ms；ARM64 QEMU `sha256:67b3f0ab8c8c174c6e7f5488fb4fb7db16310403a5373a49f2cc804eaad3e0ab`、33295ms。时间都含各自超时案例，不能当正常云延迟；image ID不是SWR manifest digest。原Actions artifact与保存JSON对应当次构建。

历史静态Demo导出22项定向测试和HTTP/CSP/字节检查通过；当时自动浏览器连接失败、没有视觉验收。当前已另用真实Edge完成20场景检查，不能把两次检查混为同一次运行。Windows过去多组真实DSH与构建同时执行曾碰到测试时限；本轮完整回归使用最多两个Vitest workers，产品截止未延长，未删除失败断言。

## 未完成的真实验收

| 项目                                       | 状态                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 真实DeepSeek效果评测                       | 首例bounds-defect尝试返回WORKER_FAILED，后三例not-run；根因和modelExecution未知，未通过业务验收，无成功率/可靠成本 |
| SWR上传/拉取                               | 未执行；媒体类型与目标SWR版本、digest/架构需实测                                                                   |
| AgentArts Runtime                          | 账号准入审批中，未部署或调用，无真实Session、LTS/运行分析证据                                                      |
| GitHub→AgentArts→DSH→评论                  | 未验收；本地/模拟GitHub不能代替真实事件、Controller写前head复查、评论链接和平台记录                                |
| Gateway/MCP/平台评估                       | 已调查，未接入，不伪造工具接入或评分                                                                               |
| 云端fix/Issue→PR/native/extensions/session | 原实现保留与适配边界明确，当前云入口未开放                                                                         |

真实云验收须核对固定SWR digest/架构、Runtime版本/单版本alias、UID/caps/元数据/出站、Session/taskId/base/head、实际工具回执、独立业务判定、GitHub结果、失败/过期head/权限拒绝/超时/取消/重复运行与清理状态。多轮Action记录汇总工具，但当前runtime/task/session/requestId保留最后一轮，不是完整平台Trace；未采集的轨迹留未知。步骤见 [部署手册](deployment.md)，业务判读见 [评测](evaluation.md)。

开发使用Codex与并行助手调查官方文档、编码和独立审查，使用Git/npm/TypeScript/Vitest/ncc、WSL/Linux/Docker与真实Edge/Playwright验证。固定测试模型来自原Messages SSE夹具。官方华为SDK仅作接口调查，没有新增Python运行依赖。开发工具与历史记录保留真实适用范围。
