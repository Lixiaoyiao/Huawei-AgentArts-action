# 当前开发交接：2026-10-07 本地收尾完成

**最新检查点**：[capacity-finish](docs/agentarts/capacity-finish.md)取代下方25b作为最终镜像。CI发现新增记录导致16MiB超限后，14bd277配套编码修复保全部files/原限制，Controller4da864c、新image6a5b892...；982files实测12,992,284bytes。新7模型32请求/四修复3852隐藏合同；真实PR #2全983files/4模型请求/正确finding/跨进程0调用复用已通过并关闭未合并。源码CI37595273406成功2090pass39skip；新记录2截图通过，key/capability/专用容器与分支清理已验证。旧25b与新Controller不能混用。模型clean有“求值顺序相同”的事实错误已记录，人工仍未验收；云端与宿主限制未解决。下方25b段落是独立历史，不重跑、不改写其原证据。

先检查`git status`、`git log`和远程main；不reset/clean。本节为当前交接，下方旧记录/旧下一步仅作历史，不重复执行。

- 本地四项已收尾，结果入口为[local-finish](docs/agentarts/local-finish.md)。Runtime clean源码`25b207246e37f282b51bad12ea0e88d7775ab888`，本地AMD64 image`sha256:029bd4854f2c6aca3f33cad7d2536aa9537dfb4d33584a2e3b3a8095f8b04412`，DSH0.2.0-rc.2。后来Controller/诊断/文档提交不当作新镜像验收。
- 新补固定Git安装/公开CA最小只读挂载，三个真实安装/拒绝case通过。最终镜像legacy9/startup2/v3十四/namespace负例3；七例真实模型34请求，四实际修复及3852隐藏合同通过。独立AI复核保留无执行证据的测试措辞，人工仍not-reviewed。
- 真实本仓库PR #1已完成：正式Controller`7da336670bb62f04f598bc94c95ed7ec75baef23`，defect2模型请求/正确finding，clean1请求/0finding；同私有state目录跨进程复用0Runtime/model/publish；stale绑定拒绝0调用。原publisher更新同评论。PR已关闭未合并，仅专用分支已删除；原仓库未动。
- local-github入口复用原全仓tree/blob物化、runAction、FullEngine与publisher；人工启动，不是webhook或Actions run，不造runURL。Controller原模型输入是代理占位，真实模型key仅在Runtime Root。
- 源码完整回归2082pass/42skip/0fail、51.41s；之后测试小改另定向5pass/6skip。6bundle+4dryrun和type/lint/generated/release/DSH通过，最终远程CI另看实际run。Demo四份真实GH记录12截图，无overflow/CSP/JS错误，fresh Edge，不动用户ICT页。
- 原始证据新增local-finish、host-diagnostics与full-v3/git-install-25b2072。两次operator源SHA填错的准备运行与容器已停止的预检失败保留，不计正式验收。模型key文件、本地capability文件、专用容器已验证清除；GitHub token未写文件，已知凭据原字节扫描通过。不要从历史聊天或scratch提取key。
- 宿主调查收尾：WSL通过；原生Ubuntu两架构两次真实诊断仍拒proc，kretprobe EINVAL，精确拒绝分支unknown。诊断workflow绿仅采证/清理完成，不继续盲追或弱化隔离。[宿主门槛](docs/agentarts/host-requirements.md)及安全VM/独立执行备选已交付。
- 主要原operation已接，仍有credentialed stdio/任意Plugin凭据无安全通用等价接入等明确差异。OAuth原未实现；原publisher不承诺跨独立Controller原子去重，localledger只保障同state/identity，unknown拒自动重放，无断电保证。[兼容审计](docs/agentarts/compatibility-audit.md)。
- **下一步**：审批后先核对目标区域/项目与namespace/proc/seccomp/LSM/五cap，跑无凭据固定probe；满足后才经批准创建最小云资源，按deployment验收平台认证/网络/固定版本/超时取消及同一真实PR。AgentArts Runtime、Gateway/MCP、平台观测/评估仍未真实验收；账号审批本身不能消除宿主限制。没有创建云资源或release。
- 不重复整套本地测试；只在新修改、失败或平台条件变化时重跑相关项。仍保留原五operation完整迁移目标，不永久缩成Review。

## 此前交接（历史记录；以本页顶部为准）

任务已经恢复，2026-10-05的暂停交接已过时。目标是保留原Action全部可合理迁移的能力，PR Review仍是第一条真实云验收；不能把当前本地迁移验证写成AgentArts/GitHub闭环已通过。此文件记录本轮源码与各次证据，不是云release声明。

## 仓库与当前边界

- 独立仓库：`outputs/Huawei-AgentArts-action`，分支 `agentarts/pr-review`；新远程为 https://github.com/Lixiaoyiao/Huawei-AgentArts-action 。原仓库未修改，upstream与共同历史保留。
- 上游基线 `891570ef2254334dff8de22af948f3f0105e933e`；DSH `0.2.0-rc.2`；Node `24.15.0`。
- 完整迁移源码 `09e41d9a14542be47afaaee334210101142f0e4c` 已按用户授权推新仓库main，通用npm alias修复独立提交 `8f9dd60d1b654a57d8b54e79d53676dfbd7fa693`。后续0ac保raw evidence、47修非root测试清理、42/ae7加AppArmor诊断、a3e加固proc helper、610f685修五cap所有权；Runtime/预检代码为 `86da6b0`，后续验证工具为 `18d8a79`，文档与证据提交以git log为准。先检查 `git status`，保留后续文件，不要reset/clean。七例真实模型仍准确绑定09e镜像，不改写到当前HEAD。
- 没有创建云资源、云release或向原仓库/第三方提交PR。云权限、实际部署、平台Gateway/MCP、平台观测/评估和真实GitHub结果仍未验收；普通本地测试不需要配置真实凭据。

## 已进入主链路

1. `src/agentarts/main.ts`选择FullEngine并复用原 `runAction`、授权/工具回调、独立Docker验证、baseline replay及finalizer。review、task、diagnose、fix、implement和原事件路由/输入已接；模型的verification不替代原独立验证。
2. v3严格绑定任务/操作/实体/ref/base/head/revision/current grants及input/result digest。受检完整workspace传入，停止DSH后采真实delta返回，Controller stage/安装后才回到原loop；保护路径、secret、source baseline、取消/过期与错误阻断发布。
3. 原DSH Session checkpoint/provenance/save/resume迁移，不拿AgentArts Session替代；不恢复历史工作区或旧工具权限。Session与delta事务失败会poison engine，不继续finalizer/save。
4. Linux UID/GID10001、bwrap文件系统/PID/网络隔离、密封Unix模型代理、默认拒绝出站/DNS/IP/metadata检查。只用CHOWN/DAC_OVERRIDE/KILL/SETGID/SETUID五cap，禁止SYS_ADMIN、privileged和Docker socket。固定来源的外层seccomp允许namespace setup，worker BPF再拒嵌套namespace。
5. 默认仅v3；legacy v1/v2须operator显式启用且只用于历史测试。普通loopback服务须local入站模式及独立临时Bearer；platform模式依赖真实AgentArts入口认证，不能直接暴露8080绕过平台。
6. 原controlled/native MCP/plugins/锁审计/namespace npm安装已接。独立只读MCP凭据由supervisor固定HTTPS代理注入，worker/Profile/task不含key；工具grant交集、工具/整组预算及Basic解码回显阻断已审查。OAuth、长订阅、通用stdio/Plugin凭据代理未实现，真实华为Gateway未验。
7. 工作流安装器复用原模板与权限、要求固定Action SHA；Demo支持五operation、原验证、真实结果链接/partial-success和观测名称，模拟/历史标签清楚。`live-full`七案例CLI使用FullEngine/v3，本轮已有下面独立真实模型证据，不等于云或GitHub发布通过。
8. ncc固定依赖版本读取适配只修改编译产物，精确版本/锁/hash/AST布局漂移拒绝；五入口可独立加载，node_modules未改。来源、许可和部署步骤见主README及 `docs/agentarts/`。

## 本轮实际检查

- Windows最终idle完整coverage：2025通过、32跳过；127文件通过、4文件跳过，118.70s；statements82.47%、branches76.51%、functions89.97%、lines84.29%。日志 `work/coverage-idle-final-20261007.log`。
- 初轮并发回归实际2022通过、32跳过、2失败，402.59s；700k Buffer深比较改为同等字节检查的 `Buffer.equals`，Session probe负载耗尽既有总预算未放宽deadline。两文件复测77通过、1跳过，37.33s，随后才完整idle通过；旧失败日志保留在 `work/coverage-final-20261007.log`。
- Linux五文件36通过，79.64s：真实DSH五operation、bwrap/egress、Session与无凭据MCP，确定性模型。
- Linux三文件36通过，70.87s：credential16、Session19、默认npm安装1；安装69.932s且原lock audit通过。真实namespace/HTTPS MCP，npm仅批准registry外网，非真实模型/云/GitHub。工作区根输出 `outputs/pr-review-validation/linux-mcp-installer-session.log` 的SHA256为 `edc74eb6d20564dee451025f4aba09a22b19bde0a9cc73f0d5e8383561e3e05e`。两组Session覆盖重叠，不累计为唯一用例数。
- 8个compiled probes通过：五bundle独立加载/预期缺配置拒绝、三个CLI dry-run，modelCalls为0；根输出 `outputs/pr-review-validation/compiled-bundle-startup.json`。静态/type/lint/生成/合同检查已通过，最终全仓格式在文档冻结后统一执行。
- Demo 51定向测试通过；独立fresh-profile Edge最终32布局/截图检查，无page/CSP错误。内置Browser连接曾失败，实际使用独立Edge；元数据在根输出 `outputs/pr-review-demo-qa/full-migration-20261007-final2/`。写任务页面用明确simulation夹具，旧真实Review只历史回放，不伪称新写任务真实通过。
- 最终clean AMD64生产镜像绑定09e源码与buildInputDigest `0acfe2dc5d055a05185b7046e6381500177fcfe9860b30e21ab94cd50c39ccfe`，image ID `sha256:2d3e340d4f6682deace5ccbcca90db173422a08d89ab521798af4ccc4a60c56a`。实际legacy9、2启动拒绝、v3十四检查和namespace-negative全通过；证据原字节在 `agentarts/evidence/full-v3/container-amd64/`。本地固定模型，不调用云/真实模型/GitHub。
- 同镜像真实DSH+DeepSeek七例自动rubric通过，runId `c00d93fd-9cd4-4f48-83db-dd2fda770454`，共32次provider请求。四write实际delta和独立Docker契约case72/38通过，完整candidate可查；原始记录在 `agentarts/evidence/full-v3/live-model/`。每例一轮、合成GitHub绑定、无发布/云，manual not-reviewed、cost unknown、无成功率。`secret-cleanup.json`核实专用模型key文件、容器和临时API capability已删除，不记录秘密值或路径。七份真实记录Demo QA另用独立Edge完成16布局/截图，原字节/历史标签/四candidate绑定检查通过，原数据 `agentarts/evidence/full-v3/browser-qa.json`，不继承旧模拟QA。
- 原生AMD/ARM镜像CI `37577194244` 均build+legacy通过，但v3隔离setup失败、0 provider calls，不能称ARM/v3 CI通过。09e普通CI因原始coverage JSON格式失败；0ac普通CI `37577380843` 格式已过但24项非root test-only cleanup失败，47cc133修后Linux UID10001两文件46通过/7.66s，生产路径未改变；后续完整CI另待新结果。
- 42a8bcb新增独立AppArmor profile，保留固定Moby其它限制，允许userns create/mount与bwrap两固定pivot，mount本身不按路径限定；必须与五cap/无SYS_ADMIN/no-new-privileges/清worker cap/BPF合用。CI固定无凭据probe先留default拒绝，再project复probe/fullsmoke，always只卸载自建profile；原生CI project策略下仍拒proc，WSL未启用AppArmor不当enforcement证明。AgentArts能否提供同等宿主策略仍未确认。
- 42a普通CI实际2029通过、29跳过、64.94s，ae7普通CI也全过；a3e普通CI37580414609成功，2029通过29跳过/128文件通过4跳过/63.17s，coverage82.48/76.56/89.97/84.32，Docker Integrity36.60s与native e2e通过。ae7原生镜像CI的project AppArmor虽推进至proc mount，仍EPERM；a3e原生双架构CI37580414164同样失败，subsetpid已编译存在，不能称修复兼容。
- a3e新镜像从固定Debian bubblewrap0.8.0-2+deb12u1源码保4补丁，dated单行proc subset patch+完整patched C SHA，dpkg-buildflags hardening=+all/无setuid，完整对应源码/许可/recipe入image，compiler不入Runtime。保Docker masks，无hostproc/完整proc fallback。Linux5.8+ feature存在不等于mount会被目标host允许。
- a3e clean WSL本地镜像另实测legacy9/startup2/fullv3十四/namespace-negative通过；buildInputDigest `4e0882ca223810ba9109a97c6e95d4477d9dd25626e9c22442853a9103a3c2fb`，image ID `sha256:736b08392b0dc3ac77f748a99a46dd80febe1819dbcbf81242e03adb938c537a`（不是config ID）。WSLkernel6.18.40.1-microsoft、Docker29.8.2，原字节在 `agentarts/evidence/full-v3/hardened-container-amd64/`；固定模型，不代表新镜像真实模型/AppArmor/云通过。
- a3e额外五capinstaller+Session证明暴露worker-owned文件/session-plan chmod EPERM；root全caps曾掩盖，十四smoke不覆盖这两条路径。610f685修为同fd O_NOFOLLOW/NONBLOCK/fstat→chownRoot→chmod→handoff，不加FOWNER，仅私有拓扑prelaunch/postshutdown；独立只读审查未见新具体漏洞，后续实际五cap复验通过，旧失败保留。
- 最终本地610f68572f384d481b6f98e4dac39ee173d91c06 clean镜像 `sha256:469ce7fb699c031cc012b94a20f04e7dbca687d527824ce554600f76f459f217`，buildInputDigest `c38d7d80d39457308df480273c3ea9ec9114021fe285a1853c450699ad82fa47`；legacy9/startup2/v3十四/namespace-negative3通过，raw在 `agentarts/evidence/full-v3/fivecap-container-amd64/`。相同image另五cap/NNP/只读source+devdeps源码harness2通过84.06s：默认运行时+扩展npm安装80.597s/原lock audit、实际DSH Session freshnamespace恢复2.319s；raw在 `fivecap-image-source-harness/`。不是部署bundle或新真实模型/云通过。
- 86da6b0普通CI37581841571 success：2031通过32跳过63.56s、coverage82.43/76.5/89.93/84.26、DockerIntegrity1通过38.93s/nativee2e/build5/compiled8/diff通过；private FD3在普通CI需root/cap而skip，另Linux root定向3+22 Runtime+Session1=26通过6.26s补证。原生镜像CI37581841343仍两架构procEPERM，86clean与610构建摘要相同，raw `agentarts/evidence/full-v3/attempts/image-ci-86da6b0/`，不弱化宿主保护求绿。
- 新preflight要求namespaceAndSeccompVerified/privateProcfsVerified必填，示例false、12测试通过，声明仍不是自动证明。交付check-image-extensions-session.sh四参数：imageID、cleanSource、devDepsRoot、新out；追加private FD测试，完整脚本自验另留结果，不将旧2passed改成新脚本全部通过。

## 下一步

1. 文档和交付脚本已冻结；最终脚本完整5通过100.82s、正常清理通过，另1秒限时退出124且清理通过，原始记录在 `fivecap-script-final/` 与 `attempts/fivecap-script-timeout/`。旧中间版本保留，不覆盖失败或补造hash。先核git status和远程最新提交，不重复已有模型/容器验证。
2. 审批后第一步通过现有租户配置/官方支持确认namespace/privateproc/seccomp/LSM/五cap可用，能力未确认不创建资源硬试。若无法提供等价sandbox，暂停该部署路线，经用户同意另评架构备选，不能冒称当前兼容。原生Ubuntu24两架构proc mount仍失败，subsetpid缩暴露但未证明兼容修复；不加SYS_ADMIN/privileged/unconfined、移除Docker masks或关全局宿主保护求绿。
3. 人工审阅七case模型输出与四份candidate、固定测试是否覆盖需求；自动通过不改成manual passed，不汇总泛化成功率或猜费用。普通文档/模拟测试不需要密钥。
4. 获真实平台权限后先部署固定digest/version/单版本alias，验收真实GitHub PR Review→AgentArts→DSH→独立Controller检查→GitHub结果和平台记录；失败/权限/超时/取消/重复请求及清理也需实际证明，再扩展各原能力云验收。

部署、清理、更新和明确未完成项以 [部署手册](docs/agentarts/deployment.md)、[验证记录](docs/agentarts/verification.md)、[能力表](docs/agentarts/capability-matrix.md) 和 [维护说明](docs/agentarts/maintenance.md) 为准。不要读取历史消息或secret scratch提取密钥，不把任何真实值放文档、脚本、argv、记录或Demo。
