# 验证记录

更新日期：2026-10-07。项目 Huawei-AgentArts-action；上游基线 `891570ef2254334dff8de22af948f3f0105e933e`，DSH `0.2.0-rc.2`，Node `24.15.0`。完整源码/共同历史/许可保留，原仓库未修改。真实AgentArts未验收；本地Runtime与真实GitHub审查已通过，属于人工启动，不是Actions/webhook或平台执行。

## 最新本地收尾

最新14bd277最终镜像七例真实模型、四份实际修复及3852隐藏合同、完整983文件真实GitHub链路见[最新配套收尾](capacity-finish.md)；源码CI2090通过/39跳过。前轮25b固定Git安装、PR clean/stale及2082本地回归仍见[前轮记录](local-finish.md)，不继承到新镜像。编译入口为6bundle+4dry-run；原始证据分别在capacity-finish/local-finish，不覆盖下方旧结果。

两次原生AMD64/ARM64宿主诊断仍拒proc；WSL通过，内核精确拒绝分支unknown。[宿主调查](host-requirements.md)记录实际版本、无凭据最小复现与清理；没有放宽隔离策略或声称AgentArts兼容。临时凭据/容器已清理，真实测试PR关闭且未合并。

## 先前完整任务迁移：09e至610本地记录

主Action已选择v3 FullEngine，五种operation、受检完整workspace/delta、原Controller验证/finalizer、controlled/native、扩展和原DSH Session均有主链路代码。代码接入与真实环境验收分别见 [能力表](capability-matrix.md)。完整迁移源码 `09e41d9a14542be47afaaee334210101142f0e4c` 已推新仓库main，通用npm alias修复独立提交为 `8f9dd60d1b654a57d8b54e79d53676dfbd7fa693`。下列源码回归在提交前工作树执行；最终clean镜像另记录准确源码与构建摘要，不把两者写成同一次验证。下方1890项与旧镜像不能代替本轮验证。

| 项目                         | 本次实际结果                                                   | 范围                                                                                                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows完整coverage回归      | 2025通过、32跳过；127测试文件通过、4文件跳过，118.70s          | 唯一最终idle完整运行，日志在仓库本地 `work/coverage-idle-final-20261007.log`；Linux专属测试另在下列真实Linux运行验证，不把Windows skip算通过                                                                                                                               |
| 本轮覆盖率                   | statements82.47%、branches76.51%、functions89.97%、lines84.29% | 只表示当前源码测试覆盖，不能与旧源码覆盖率直接当作业务效果比较                                                                                                                                                                                                             |
| Linux主链路定向回归          | 5文件、36通过，79.64s                                          | 真实固定DSH、五operation、生产bwrap/egress、Session与无凭据MCP；模型为确定性夹具，不调用AgentArts或真实模型，不发布GitHub                                                                                                                                                  |
| Linux凭据/Session/默认安装   | 3文件、36通过，70.87s；默认安装69.932s                         | credential16、Session19、默认npm安装1；真实DSH/bwrap/HTTPS MCP与原lock audit，仅批准registry外网，无真实模型/云/GitHub。日志本地 `outputs/pr-review-validation/linux-mcp-installer-session.log`，SHA256 `edc74eb6d20564dee451025f4aba09a22b19bde0a9cc73f0d5e8383561e3e05e` |
| 静态、生成与合同检查         | 通过                                                           | 最终typecheck、ESLint、Action生成合同、继承release contract与固定DSH配置；格式检查以文档冻结后的最终全仓检查为准                                                                                                                                                           |
| 工作流安装器/Session定向回归 | Windows96通过，4文件，5.88s                                    | 原installer61、新AgentArts installer9、Session transfer19、原Controller Session7；生成模板/文件事务，不调用模型/云/GitHub                                                                                                                                                  |
| Session真实save→resume       | Linux19通过，2文件，3.65s；实际DSH案例2.127s                   | 当次18项transfer加1项真实DSH/生产bwrap/fresh namespace；模型SSE夹具，合成Controller provenance；日志本地 `outputs/pr-review-validation/session-runtime-linux.log`。后加untrusted Session拒绝由上述Windows19项覆盖，不改旧日志                                              |
| Demo写任务记录               | 51定向测试通过，5.79s；TypeScript通过                          | fix/implement、原validation、partial-success/GitHub链接、native名称独立于回执、严格export/CSP/原JSON字节；VM不当作视觉测试                                                                                                                                                 |
| AgentArts编译入口独立检查    | 8项通过：5bundle独立加载/预期缺配置拒绝、3个CLI dry-run        | 无宿主node_modules；ncc适配仅固定DSH自身版本读取，版本/lock/源码hash/AST布局漂移拒绝。元数据在本地 `outputs/pr-review-validation/compiled-bundle-startup.json`；modelCalls为0，不执行云/GitHub，不代替容器及业务验收                                                       |

Windows初轮在并发负载下实际为2022通过、32跳过、2失败，402.59s：大Buffer深比较超时，以及Session probe在既有总预算内未完成。前者改为等价的 `Buffer.equals` 字节检查，未削弱断言；后者未放宽deadline。随后两文件定向复测77通过、1跳过，37.33s，再完整idle重跑才得到上表2025/32；初轮失败保留在 `work/coverage-final-20261007.log`，不转写为通过。两组Linux回归各有Session覆盖，不相加成唯一用例数。

09e clean AMD64镜像与七例真实模型已分别实际通过下节限定检查。最终本地610f685镜像修复五cap所有权交接，WSL固定模型smoke与另行installer/Session源码测试通过；Runtime/预检代码基于86da6b0，验证工具和文档另行提交，普通CI通过，原生Ubuntu24双架构镜像CI仍失败。各来源分开，不继承09e真实模型或旧QEMU证明。AgentArts与真实GitHub闭环仍未验收。

Demo浏览器复现另用独立fresh-profile headless Edge，模拟写状态均明确标记simulation/历史回放，不调用Runtime、模型或GitHub；最终截图与浏览器元数据以本地 `outputs/pr-review-demo-qa/full-migration-20261007-final2/` 为准。内置Browser连接实际失败后采用独立Edge，不冒称内置浏览器通过。UI和源码测试不能代表华为云验收。

### 最终本地610f685镜像与五cap额外验证

固定源码 `610f68572f384d481b6f98e4dac39ee173d91c06`、clean构建输入摘要 `c38d7d80d39457308df480273c3ea9ec9114021fe285a1853c450699ad82fa47`、实际本地image ID `sha256:469ce7fb699c031cc012b94a20f04e7dbca687d527824ce554600f76f459f217`，见 [source binding](../../agentarts/evidence/full-v3/fivecap-container-amd64/source-bindings.json)。WSL中 [legacy9](../../agentarts/evidence/full-v3/fivecap-container-amd64/smoke.jsonl) 12664ms、[startup2](../../agentarts/evidence/full-v3/fivecap-container-amd64/startup-negative.json)、[默认v3十四](../../agentarts/evidence/full-v3/fivecap-container-amd64/full-smoke.jsonl) 12987ms与 [namespace-negative](../../agentarts/evidence/full-v3/fivecap-container-amd64/namespace-negative.jsonl) 320ms均通过；真实DSH、确定性模型，无真实模型/云/GitHub。

同一image另以CHOWN/SETUID/SETGID/DAC_OVERRIDE/KILL五cap、no-new-privileges、只读source/dev-dependencies执行源码harness：真正默认npm运行时及扩展安装、原lock audit通过（80.597s），真实DSH Session save→fresh namespace恢复通过（2.319s），两例总84.06s。[binding](../../agentarts/evidence/full-v3/fivecap-image-source-harness/binding.json)、[实际log](../../agentarts/evidence/full-v3/fivecap-image-source-harness/image-installer-session-610f685-fivecap-passed.log)、[binary hardening](../../agentarts/evidence/full-v3/fivecap-image-source-harness/image-binary-610f685.log)。这补证了先前a3e chmod EPERM的所有权修复，不增加FOWNER；它是使用镜像真实Node/npm/bwrap的**container-source-harness**，不能写成部署bundle HTTP、AppArmor、真实模型或云端通过。

交付的 [复验脚本](../../agentarts/check-image-extensions-session.sh) 另包含private-permissions定向测试；上述2passed记录来自之前单独harness，不改写为新脚本完整通过。新脚本完整自验状态由其独立输出记录确认，准确参数见 [部署手册](deployment.md#41-最终镜像与确定性模型-smoke)。

最终交付脚本随后独立完整执行：3文件、5通过，100.82s；Session 2.239s、真正默认安装器97.263s、私有FD权限3项通过。固定610源码/同469镜像、实际ELF加固、五cap、空Docker配置/固定本地socket与清理均通过，原始 [binding](../../agentarts/evidence/full-v3/fivecap-script-final/binding.json)、[fixtures](../../agentarts/evidence/full-v3/fivecap-script-final/fixtures.log)、[outcome](../../agentarts/evidence/full-v3/fivecap-script-final/outcome.json) 和 [cleanup](../../agentarts/evidence/full-v3/fivecap-script-final/cleanup.json) 分开保存。它仍是source-harness、确定性模型，不是新真实模型或云验收。

同一最终脚本另做1秒限时负例，实际退出124且 [两个自有容器清理通过](../../agentarts/evidence/full-v3/attempts/fivecap-script-timeout/cleanup.json)，不将预期超时写成任务成功。增加清理前的 [中间版本](../../agentarts/evidence/full-v3/fivecap-script-intermediate/provenance.json) 五项69.24s也保留；当时未采集shell脚本hash，如实记null，不补造运行时绑定。

[86da6b0普通CI 37581841571](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37581841571) success：2031通过、32跳过，63.56s；coverage82.43/76.5/89.93/84.26；Docker Integrity1通过/38.93s、native e2e、五bundle构建、八compiled probes及diff检查通过。32skip包含需Linux root/cap的private FD三例；另有Linux root定向3+22 Runtime五操作+1 Session共26通过/6.26s，以及上述实际五cap两例补证。平台/权限条件不同的运行不合并为唯一通过数。

[86原生镜像CI 37581841343](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37581841343) 两架构仍proc mount EPERM；source86 clean、构建输入摘要与610相同，原始source/arch/image绑定保存在 `agentarts/evidence/full-v3/attempts/image-ci-86da6b0/`。不能用普通CI或WSL通过替代它；审批后须先确认目标租户可提供等价namespace/privateproc/seccomp/LSM/五cap，否则暂停该部署路线，经用户同意另评架构备选。

### 本轮09e clean AMD64生产容器

固定源码 `09e41d9a14542be47afaaee334210101142f0e4c`，记录 `sourceDirty: false`，buildInputDigest `0acfe2dc5d055a05185b7046e6381500177fcfe9860b30e21ab94cd50c39ccfe`；本地部署image ID `sha256:2d3e340d4f6682deace5ccbcca90db173422a08d89ab521798af4ccc4a60c56a`。这是本地image/manifest事实，未上传SWR或部署AgentArts。

| 实际检查              | 结果                    | 原始证据                                                                                                                                                           |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 显式legacy兼容性      | 9场景通过，12718ms      | [smoke](../../agentarts/evidence/full-v3/container-amd64/smoke.jsonl)，仅该进程开启旧协议，不改变生产默认v3                                                        |
| 默认v3主链路/失败停止 | 14项通过，13067ms       | [full-smoke](../../agentarts/evidence/full-v3/container-amd64/full-smoke.jsonl)：7种operation/mode/读写组合、入站认证、legacy拒绝、重复、权限、非法输出、超时/取消 |
| namespace配置缺失     | 在模型请求前拒绝，317ms | [namespace negative](../../agentarts/evidence/full-v3/container-amd64/namespace-negative.jsonl)                                                                    |
| 启动安全配置缺失      | 2项拒绝通过             | [startup negative](../../agentarts/evidence/full-v3/container-amd64/startup-negative.json)，缺cap或可被他人读取的模型key文件在health前拒绝                         |

上表使用真实固定DSH和实际生产bundle/UID/bwrap，模型为确定性夹具；未调用真实模型、云或GitHub。耗时含失败/超时案例，不当作正常云任务延迟。[descriptor](../../agentarts/evidence/full-v3/container-amd64/image-descriptor.json) 保存镜像媒体类型；早期bundle启动失败、native/format-repair夹具失败分别保存在 `agentarts/evidence/full-v3/attempts/`，不覆盖或算最终通过。

### 后续a3e加固候选：本地WSL通过，原生CI失败

固定源码 `a3e61e520011623bafc6456f13abb433b460e689`，clean构建输入摘要 `4e0882ca223810ba9109a97c6e95d4477d9dd25626e9c22442853a9103a3c2fb`，实际本地image ID `sha256:736b08392b0dc3ac77f748a99a46dd80febe1819dbcbf81242e03adb938c537a`。WSL内核 `6.18.40.1-microsoft`、Docker `29.8.2`；[legacy9](../../agentarts/evidence/full-v3/hardened-container-amd64/smoke.jsonl) 12020ms、[2启动拒绝](../../agentarts/evidence/full-v3/hardened-container-amd64/startup-negative.json)、[默认v3十四检查](../../agentarts/evidence/full-v3/hardened-container-amd64/full-smoke.jsonl) 13005ms与 [namespace-negative](../../agentarts/evidence/full-v3/hardened-container-amd64/namespace-negative.jsonl) 314ms均通过。这是确定性模型与真实DSH，不含真实模型、云或GitHub，也不证明AppArmor policy enforcement。

该候选保留固定Debian bubblewrap0.8.0-2+deb12u1四项补丁，只把新PID namespace procfs改为 `subset=pid`；源输入/patch/C hash、hardening=+all、无setuid、对应源码/许可/构建说明随镜像提供，见 [metadata](../../agentarts/bubblewrap-source.json)。`subset=pid`缩小系统proc暴露面，不能保证兼容父proc masked mounts；Linux5.8+只说明feature存在，内核版本不是充分验收条件。

[原生镜像CI 37580414164](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37580414164) 的AMD64/ARM64在专用AppArmor enforce下仍报 `Can't mount proc on /newroot/proc: Operation not permitted`；补丁已实际编译存在，目标宿主仍拒绝。继续保留Docker masked paths、五cap/no-new-privileges/BPF和强制namespace，不以放宽宿主策略换通过。真实AgentArts仍待确认可行性，09e七例模型结果不改写成a3e模型验收。

### 本轮v3真实DeepSeek七任务

09e的固定2d3e镜像执行真实DSH与DeepSeek，runId `c00d93fd-9cd4-4f48-83db-dd2fda770454`，[suite](../../agentarts/evidence/full-v3/live-model/c00d93fd-9cd4-4f48-83db-dd2fda770454.suite.json) 七例自动rubric通过，共32次provider请求。四个write案例均导入真实delta并独立执行固定Docker契约测试，完整原文件/候选/delta保存在各 `.candidate.json`。逐例表和边界见 [评测](evaluation.md#本轮v3七任务真实deepseek)。所有manualVerdict仍not-reviewed、actualCost unknown、successRate not-computed；绑定为合成GitHub身份，无GitHub发布，也未调用AgentArts。[清理记录](../../agentarts/evidence/full-v3/live-model/secret-cleanup.json) 核实专用模型key文件、容器和临时本地API capability已删除，不记录秘密路径或值。

七份真实记录的 [Demo QA](../../agentarts/evidence/full-v3/browser-qa.json) 另用独立fresh-profile Edge154实际完成16布局/截图检查、静态原字节与历史/本地真实模型标签检查，page/CSP errors为空；四candidate的bytes SHA和评测绑定独立核对。浏览器只回放记录，未重新调用模型/云/GitHub；人工业务判读仍未完成。该次新QA与此前模拟写页面32布局检查分别保留。

### 当前远程CI仍有失败

[原生双架构镜像CI 37577194244](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37577194244) 的AMD64/ARM64均构建并通过legacy，但v3 namespace setup失败、provider请求为0；不能写原生ARM或v3 CI通过。09e源码普通CI还因原字节coverage JSON被格式检查失败；后续 `0acaa70` 排除raw evidence目录的格式重写，[CI 37577380843](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37577380843) 格式通过但有24项非root fixture清理失败。`47cc133` 只在显式test-only私有目录恢复owner-write再dispose，不改生产路径；Linux UID10001两文件实际复测46通过，7.66s，不把它写成此前完整CI已通过。

`42a8bcb` 增加独立AppArmor策略，`ae7e319`修可选audit读取不遮蔽probe。42a普通CI实际2029通过、29跳过，64.94s，ae7普通CI也通过；a3e普通CI结果见下段。这些源码测试通过不代表镜像隔离通过。ae7原生镜像CI中default AppArmor拒mount，project策略已推进至proc挂载，但仍EPERM；a3e加proc subset补丁后也保留上述失败。固定probe无凭据/模型，project profile独立清理；parser检查与AppArmor未启用的WSL通过不证明enforcement。原始记录不为格式化改写，云容器能否提供这些宿主策略仍待租户确认，不使用SYS_ADMIN、unconfined或关闭宿主保护绕过失败。[部署要求](deployment.md#32-apparmor宿主策略)。

[a3e普通CI 37580414609](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37580414609) 已success：2029通过、29跳过；128测试文件通过、4跳过，63.17s；coverage statements82.48%、branches76.56%、functions89.97%、lines84.32%，Docker Integrity 36.60s与native e2e通过。该runner的测试权限不等于部署镜像的五cap配置。后续用同a3e镜像额外运行默认installer与Session，实际发现worker-owned文件和session-plan的chmod EPERM；因此十四smoke通过不证明这两条生产路径已可用。后续610f685实际五cap复验通过，详见前节；不加FOWNER或其它cap，不把root全cap测试通过代替生产配置验收。

## 历史只读阶段：2026-10-04源码与证据

以下数据保留原运行与源码范围，包括真实模型首轮失败与后续复测；不转写为当前v3/write/native/MCP效果。历史推送授权不等于创建云资源或公开托管Demo。

本轮保留通用修复 `aa05620a609f60e4cbe89dd0af87515e8bfafcce`（CI工作区固定失败run的commit）和华为适配 `ed1050067ad74fd533461cba793a3f7d8dc14f81`，随后补充有限失败诊断、只读skipped声明与镜像构建修正。各次测试、容器构建和模型评测分别记录源码，不能声称所有验证期间HEAD相同或工作树始终clean；真实模型记录的操作者source声明也不等于镜像attestation。

### 当时已经实际完成

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

## 历史只读候选容器：两架构独立实测通过

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

## 历史只读真实DeepSeek四任务：自动rubric通过，人工未复核

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
| 云端fix/Issue→PR/native/extensions/session | 当前v3代码已接入；生产环境与真实GitHub/AgentArts逐项验收，旧只读证据不替代          |

真实云验收须核对固定SWR digest/架构、Runtime版本/单版本alias、UID/caps/元数据/出站、Session/taskId/base/head、实际工具回执、独立业务判定、GitHub结果、失败/过期head/权限拒绝/超时/取消/重复运行与清理状态。多轮Action记录汇总工具，但当前runtime/task/session/requestId保留最后一轮，不是完整平台Trace；未采集的轨迹留未知。步骤见 [部署手册](deployment.md)，业务判读见 [评测](evaluation.md)。

开发使用Codex与并行助手调查官方文档、编码和独立审查，使用Git/npm/TypeScript/Vitest/ncc、WSL/Linux/Docker与真实Edge/Playwright验证。固定测试模型来自原Messages SSE夹具。官方华为SDK仅作接口调查，没有新增Python运行依赖。开发工具与历史记录保留真实适用范围。
