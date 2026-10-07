# 当前开发交接：2026-10-07

任务已经恢复，2026-10-05的暂停交接已过时。目标是保留原Action全部可合理迁移的能力，PR Review仍是第一条真实云验收；不能把当前代码接入写成AgentArts/GitHub闭环已通过。此文件记录本轮工作树，不是release声明。

## 仓库与当前边界

- 独立仓库：`outputs/Huawei-AgentArts-action`，分支 `agentarts/pr-review`；新远程为 https://github.com/Lixiaoyiao/Huawei-AgentArts-action 。原仓库未修改，upstream与共同历史保留。
- 上游基线 `891570ef2254334dff8de22af948f3f0105e933e`；DSH `0.2.0-rc.2`；Node `24.15.0`。
- 最后公开基线 `0f067fa973723722f48962d456f85f3f6683d1d9`；通用npm alias修复已本地独立提交 `8f9dd60d1b654a57d8b54e79d53676dfbd7fa693`。当前完整迁移源码/测试/文档仍有大量未提交内容，先检查 `git status`，不要reset/clean丢文件。
- 本轮尚不推送、不创建云资源或release。云权限、实际部署、平台Gateway/MCP、平台观测/评估和真实GitHub结果仍未验收；普通本地测试不需要再配置真实凭据。

## 已进入主链路

1. `src/agentarts/main.ts`选择FullEngine并复用原 `runAction`、授权/工具回调、独立Docker验证、baseline replay及finalizer。review、task、diagnose、fix、implement和原事件路由/输入已接；模型的verification不替代原独立验证。
2. v3严格绑定任务/操作/实体/ref/base/head/revision/current grants及input/result digest。受检完整workspace传入，停止DSH后采真实delta返回，Controller stage/安装后才回到原loop；保护路径、secret、source baseline、取消/过期与错误阻断发布。
3. 原DSH Session checkpoint/provenance/save/resume迁移，不拿AgentArts Session替代；不恢复历史工作区或旧工具权限。Session与delta事务失败会poison engine，不继续finalizer/save。
4. Linux UID/GID10001、bwrap文件系统/PID/网络隔离、密封Unix模型代理、默认拒绝出站/DNS/IP/metadata检查。只用CHOWN/DAC_OVERRIDE/KILL/SETGID/SETUID五cap，禁止SYS_ADMIN、privileged和Docker socket。固定来源的外层seccomp允许namespace setup，worker BPF再拒嵌套namespace。
5. 默认仅v3；legacy v1/v2须operator显式启用且只用于历史测试。普通loopback服务须local入站模式及独立临时Bearer；platform模式依赖真实AgentArts入口认证，不能直接暴露8080绕过平台。
6. 原controlled/native MCP/plugins/锁审计/namespace npm安装已接。独立只读MCP凭据由supervisor固定HTTPS代理注入，worker/Profile/task不含key；工具grant交集、工具/整组预算及Basic解码回显阻断已审查。OAuth、长订阅、通用stdio/Plugin凭据代理未实现，真实华为Gateway未验。
7. 工作流安装器复用原模板与权限、要求固定Action SHA；Demo支持五operation、原验证、真实结果链接/partial-success和观测名称，模拟/历史标签清楚。`live-full`七案例CLI使用FullEngine/v3，真实模型当前仍待新执行证据。
8. ncc固定依赖版本读取适配只修改编译产物，精确版本/锁/hash/AST布局漂移拒绝；五入口可独立加载，node_modules未改。来源、许可和部署步骤见主README及 `docs/agentarts/`。

## 本轮实际检查

- Windows最终idle完整coverage：2025通过、32跳过；127文件通过、4文件跳过，118.70s；statements82.47%、branches76.51%、functions89.97%、lines84.29%。日志 `work/coverage-idle-final-20261007.log`。
- 初轮并发回归实际2022通过、32跳过、2失败，402.59s；700k Buffer深比较改为同等字节检查的 `Buffer.equals`，Session probe负载耗尽既有总预算未放宽deadline。两文件复测77通过、1跳过，37.33s，随后才完整idle通过；旧失败日志保留在 `work/coverage-final-20261007.log`。
- Linux五文件36通过，79.64s：真实DSH五operation、bwrap/egress、Session与无凭据MCP，确定性模型。
- Linux三文件36通过，70.87s：credential16、Session19、默认npm安装1；安装69.932s且原lock audit通过。真实namespace/HTTPS MCP，npm仅批准registry外网，非真实模型/云/GitHub。工作区根输出 `outputs/pr-review-validation/linux-mcp-installer-session.log` 的SHA256为 `edc74eb6d20564dee451025f4aba09a22b19bde0a9cc73f0d5e8383561e3e05e`。两组Session覆盖重叠，不累计为唯一用例数。
- 8个compiled probes通过：五bundle独立加载/预期缺配置拒绝、三个CLI dry-run，modelCalls为0；根输出 `outputs/pr-review-validation/compiled-bundle-startup.json`。静态/type/lint/生成/合同检查已通过，最终全仓格式在文档冻结后统一执行。
- Demo 51定向测试通过；独立fresh-profile Edge最终32布局/截图检查，无page/CSP错误。内置Browser连接曾失败，实际使用独立Edge；元数据在根输出 `outputs/pr-review-demo-qa/full-migration-20261007-final2/`。写任务页面用明确simulation夹具，旧真实Review只历史回放，不伪称新写任务真实通过。

## 下一步

1. 冻结文档后完成全仓格式检查，提交源码与证据，记录固定source commit/build input digest；不把工作树测试包装成clean提交证明。
2. Root重建最终clean AMD64生产镜像，运行旧9场景、v3十四检查、namespace缺失拒绝与独立验证；之前dirty候选、打包启动失败和format-repair夹具失败分别保留，不算最终验收。
3. 原生ARM64 CI必须在匹配架构内核运行BPF隔离；旧x64 QEMU只读镜像记录不能证明本轮ARM。新候选推送须按用户当时授权处理。
4. 如执行已授权有界真实模型测试，只supervisor持key，使用新runId记录实际provider请求/耗时/自动rubric，人工判定与费用未知仍写未知。旧只读四任务8次请求的通过记录不代表当前v3/write/native通过。
5. 获真实平台权限后先部署固定digest/version/单版本alias，验收真实GitHub PR Review→AgentArts→DSH→独立Controller检查→GitHub结果和平台记录；失败/权限/超时/取消/重复请求及清理也需实际证明，再扩展各原能力云验收。

部署、清理、更新和明确未完成项以 [部署手册](docs/agentarts/deployment.md)、[验证记录](docs/agentarts/verification.md)、[能力表](docs/agentarts/capability-matrix.md) 和 [维护说明](docs/agentarts/maintenance.md) 为准。不要读取历史消息或secret scratch提取密钥，不把任何真实值放文档、脚本、argv、记录或Demo。
