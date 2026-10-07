# 本地收尾与真实GitHub验证

本页为25b镜像的前轮记录。最终CI发现新增记录使完整传输超限，之后已配套修复编码并用新14bd镜像重跑；当前状态见[最新收尾](capacity-finish.md)。本页原始证据不移记到新镜像。

2026-10-07。原仓库未修改；新仓库main保留共同历史。此轮补齐本地工作，不创建云资源、不发布release。AgentArts准入仍待审批，平台Runtime、Gateway、观测与评估未验收。

## 固定实现与容器

Runtime构建源码`25b207246e37f282b51bad12ea0e88d7775ab888`，DSH `0.2.0-rc.2`；本地AMD64镜像`sha256:029bd4854f2c6aca3f33cad7d2536aa9537dfb4d33584a2e3b3a8095f8b04412`。干净构建与输入摘要见[绑定](../../agentarts/evidence/local-finish/container-amd64/source-bindings.json)。后续Controller/诊断/文档提交没有改此Runtime的业务源码，不能因此称后续HEAD镜像已跑过。

实际补齐上游固定commit的Git包安装：镜像增加Git与公开CA；installer和worker只读挂载固定单个CA文件，保留TLS验证，Root所有权/父目录/大小校验，未挂整份`/etc`。真实公开固定Git包、越权origin、错误SHA三例通过，97.15秒。[原始记录](../../agentarts/evidence/full-v3/git-install-25b2072/)。原有五operation仍在主Action链路中，没有另外发明任务平台。

该镜像通过legacy smoke 9项、startup拒绝2项、v3实际DSH固定模型14项和namespace不可用时0模型请求的拒绝探针3项。[容器记录](../../agentarts/evidence/local-finish/container-amd64/)。这些模型响应为确定性夹具，单独记录，不当作真实模型效果。

原生Ubuntu AMD64/ARM64仍在当前保护配置下拒绝proc挂载；WSL同镜像通过。两次手动无凭据诊断保留完整差异、trace不可用和清理结果，未确认的内核拒绝分支保持unknown。[宿主条件及安全备选](host-requirements.md)。诊断workflow绿色只表示采证/清理完成。

## 最终镜像与真实模型

完整[suite](../../agentarts/evidence/local-finish/model-final/4201acde-6fe8-4db6-9d3f-4da03f906689.suite.json)使用Controller源码`6d07c5088aa1e8f919296917f3ea87299b49354e`与上述Runtime镜像：review缺陷/clean、diagnose、fix、通用写task、Issue实现、native写task，共七例，34次实际provider请求，记录的逐例耗时合计104741ms。每例最多8请求、每请求4096输出token、每例300秒。模型实际费用未知，美元声明不是账单硬上限。

七例自动rubric通过；四份真实delta经过原独立Docker验证，再重新执行3852个隐藏合同。[独立AI复核](final-image-review.md)逐份核对输出和候选：旧diagnose解释错误未重现；clean summary的“测试通过”没有执行证据（verification为skipped），明确不采信该措辞。人工判断仍是`not-reviewed`，没有计算成功率。

## 真实GitHub审查与发布

[PR #1](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/pull/1)为经授权建立的本仓库真实测试PR，base `7a101aa74f56594bcae5d5b1706ce166ce4cecb9`，缺陷head `3a08f598b0124598fb78a873169f3d9a0f53e5ef`，修正head `0567c02295f8dccd0e4968f908e35d5690fd9411`。Controller固定`7da336670bb62f04f598bc94c95ed7ec75baef23`，Runtime仍是25b镜像。

| 执行           | 实际结果                                                                                    | 证据                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 缺陷审查       | 1次Runtime、2模型请求；正确发现`index === length`应抛RangeError；原发布器更新同一条行内评论 | [结果](../../agentarts/evidence/local-finish/github-defect-verified/operation-evidence.json)、[行内评论](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/pull/1#discussion_r4204535137) |
| 新进程重复请求 | 同一私有state目录/绑定复用已确认结果；本次0 Runtime、0模型、0发布，读回真实评论核验         | [结果](../../agentarts/evidence/local-finish/github-duplicate/operation-evidence.json)                                                                                                        |
| 修正后clean    | 1次Runtime、1模型请求；findings 0、行内新增/更新0；原summary更新为无缺陷                    | [结果](../../agentarts/evidence/local-finish/github-clean/operation-evidence.json)、[summary](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/pull/1#issuecomment-6033762841)           |
| 旧head请求     | 真实API绑定检查拒绝，0 Runtime、0模型、无发布                                               | [结果](../../agentarts/evidence/local-finish/github-stale-head/operation-evidence.json)                                                                                                       |

CLI读取真实GitHub身份、PR、全仓不可变tree/blob，再复用原`runAction`、FullEngine、precision/diff/head检查与publisher。数百blob API请求使物化阶段耗时约数分钟；该阶段没有冒充模型执行。实际个人账号数字ID用于评论作者，不冒充Actions bot。修正后旧finding保留在原commit并被GitHub标为outdated，没有删除历史证据。

这次由人工显式启动，构造绑定真实PR的本地事件信封；没有接收webhook，也没有GitHub Actions run。结果链接使用真实PR，不伪造Actions链接。[可复用CLI与命令](local-github-review.md)。生产Action仍使用正常Actions上下文；仅受信调用者可传绑定当前实体的本地上下文链接。

原Controller的authority字段包含仅用于满足原输入合同的模型代理占位值；真实DeepSeek凭据始终在Runtime Root文件/内存，Controller并未持有真实模型key。Root supervisor代理、worker隔离与模型执行证据另见Runtime回执。Review不运行仓库测试；修复测试只在独立验证器执行。不能将Review的schema/head通过称为测试通过。

同一state目录的本地CLI拒绝并发/未知结果自动重放，并可跨进程复用完成记录；不承诺断电持久性、跨独立Controller的全局原子去重或GitHub exactly-once。原publisher并发查找/创建的边界与credentialed stdio/Plugin剩余差异见[兼容审计](compatibility-audit.md)。

## 失败记录、测试与清理

最初一次模型与一次GitHub试跑填错了操作者声明的源码SHA；原始记录保留在[attempts](../../agentarts/evidence/local-finish/attempts/)，不计入正式验收。第一次GitHub尝试实际产生了同一条评论，正式缺陷复测由原marker更新，未另建重复评论。随后校验真实Git HEAD再运行正式记录，没有改写错误原始元数据。

一次suite启动前发现本地容器已停止，CLI在预检拒绝、没有模型调用；确切停止原因未确认。重启容器并保持WSL前台生命周期后完整suite完成，原失败保留。不能由此推断AgentArts的生命周期行为。

源码完整回归2082通过、42跳过、0失败，51.41秒；此后诊断/隐藏合同测试小改另定向5通过、6跳过，最终远程CI另查实际记录。Linux专属Git安装、隐藏合同和宿主测试有各自真实Linux记录，Windows skip没有转写为通过。typecheck、ESLint、生成合同、release/DSH检查、6bundle独立加载和4个dry-run探针通过。[回归原始记录](../../agentarts/evidence/local-finish/regression/)。

Demo展示上述真实记录，复用/失败标签明确，工具为空时显示0，不按允许工具清单编造回执。[浏览器QA](../../agentarts/evidence/local-finish/browser-qa/)由独立fresh-profile Edge完成；内置浏览器连接不可用，没有操作用户登录的ICT页面。

已检查导出记录不含本轮三个已知真实凭据的原字节，并移除模型key文件、本地入站capability文件与专用Runtime容器；未将GitHub token写入文件。测试PR关闭、专用分支删除，未合并到main。[扫描](../../agentarts/evidence/local-finish/secret-scan.json)、[本地清理](../../agentarts/evidence/local-finish/secret-cleanup.json)、[GitHub清理](../../agentarts/evidence/local-finish/github-receipts/cleanup.json)。凭据扫描不证明不存在未知秘密。

## 审批后第一步

先取得目标租户的区域/项目、Runtime高代码权限，以及对namespace、五cap、seccomp、宿主LSM与隔离proc的支持结论，按[宿主门槛](host-requirements.md)跑无凭据固定probe。审批通过本身不会消除容器限制。能满足后按[部署与验收](deployment.md#5-审批后按顺序验收)创建经批准的最小固定资源；不能满足就停止该路线并评估独立执行服务或专用VM等安全备选。

之后验证平台入站认证、固定版本、SWR、模型/工具出站、任务body/时长/断开取消，再跑同一缺陷/clean PR并关联平台运行记录。平台Gateway/MCP、观测与评估仍需要真实接入；本地HTTP/日志不代替平台能力。
