# 最终配套镜像与完整仓库验收

2026-10-07。这是[前轮本地收尾](local-finish.md)之后的最新记录。前轮源码与原始结果不改写为本轮通过；AgentArts仍待准入，未创建云资源或release。

## 完整工作区与配套版本

新增真实记录后，远程[CI 37593800984](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37593800984)暴露本仓库完整工作区超过16MiB编码上限，正确停止。原策略只压缩大于256KiB的单文件，许多中等文件和JSON转义累计占用线上的字节；没有删记录、删工作区文件或提高上限来通过。

现统一采用只依赖各文件bytes的确定性编码：大于4KiB且gzip/base64的实际JSON字符串成本节省至少20%时压缩。仍检查全部文件、原SHA/mode、解压128MiB、5000文件及编码16MiB上限，内容不省略；按总包大小动态换策略会改变无关文件的编码和delta摘要，因此没有采用。

Controller与Runtime必须配套升级。旧25b按256KiB规则recapture，不能与新编码混用；schema接受gzip不代表不同canonical编码策略兼容。混用会在工作区复查拒绝，不能把旧镜像继续当作最新版。固定部署时分别记录Action SHA和Runtime构建SHA/镜像ID，禁止自动指向latest。

| 项目                     | 实际绑定/结果                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Runtime源码              | `14bd277ca42a48406c7fe3a33ca903d5fd7d3f70`                                                                              |
| 实际本地AMD64镜像        | `sha256:6a5b8920363586a3a59a68ed33cdab09d9f2d04854312b51d17882ae3538006e`                                               |
| Controller源码与编译提交 | `4da864c2e6b11575ffc72216a92f59aa2a63a52a`                                                                              |
| DSH                      | `0.2.0-rc.2`，模型`deepseek-v4-pro`                                                                                     |
| 本仓库完整往返           | 982文件、实际编码12,992,284字节，小于16,777,216上限；原bytes与模式/摘要检查通过                                         |
| 定向测试                 | 64通过/1 Windows跳过；含完整仓库、JSON转义/Unicode/binary、跨压缩门槛双向编辑、无关文件编码稳定、不可压缩内容与限额拒绝 |
| 新镜像实际smoke          | legacy9/startup拒绝2/v3十四/namespace负例3通过；实际DSH、确定性模型，非真实模型效果                                     |

[构建绑定](../../agentarts/evidence/capacity-finish/container-amd64/source-bindings.json)、[往返测量](../../agentarts/evidence/capacity-finish/regression/capacity-measurement.log)、[定向记录](../../agentarts/evidence/capacity-finish/regression/capacity-mainline-tests.json)保留原字节。

## 新镜像真实模型与业务判断

新[suite 275254cb](../../agentarts/evidence/capacity-finish/model-final/275254cb-06c4-4076-96fc-90f33958a2c4.suite.json)七例实际DSH/DeepSeek自动rubric通过，32模型请求，逐例记录耗时合计112101ms；每例最多8请求/4096输出token/300秒。含缺陷/clean Review、diagnose、fix、通用写task、Issue实现和native写task。合成GitHub身份，不发布GitHub；真实PR另见下节。

四份实际delta先由原Controller独立Docker验证，再按本次run/task/file摘要重新执行3852个隐藏合同，5测试1.99秒通过。[独立AI复核](capacity-image-review.md)没有继承前轮结论：diagnose准确；clean的“求值顺序相同”解释有事实错误，虽不改变primitive number合同下的结果；模型宣称测试通过仍无执行证据，不予采信。原`manualVerdict: not-reviewed`保留，AI判断/自动通过不替代人工验收，不编成功率或费用。

## 包含全部新记录的真实GitHub任务

[PR #2](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/pull/2)从配套更新后的本仓库main建立，base `4da864c2e6b11575ffc72216a92f59aa2a63a52a`，head `fcdc256a0cdd8bd2fd81a7ca787747cf181602f1`。真实API tree包含983文件、42,793,028 bytes且未截断；比上述源码库多一个已知缺陷fixture。[原始commit/tree](../../agentarts/evidence/capacity-finish/github-receipts/)独立留证，不由Demo虚构文件数。

本地CLI通过原GitHub全仓物化、FullEngine、新Runtime和原DSH，控制端校验后由原publisher发布1条正确行内finding。实际4模型请求、999次原Controller GitHub请求、170610ms；6条真实工具回执包括2次失败搜索，页面分别显示工具失败与最终校验通过。失败工具不改写为成功，也不影响已检查的正确finding。[完整记录](../../agentarts/evidence/capacity-finish/github-complete-workspace/)、[行内评论](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/pull/2#discussion_r4204851817)。

新进程同state/identity重跑实际复用，0 Runtime/模型/发布，[记录](../../agentarts/evidence/capacity-finish/github-duplicate-complete/operation-evidence.json)。前轮真实PR #1的clean与stale测试保留各自25b绑定，不假称其运行在新镜像。两轮均为人工启动的本地Runtime闭环，不是GitHub Actions触发或AgentArts执行；结果使用真实PR链接，不伪造Actions run。

PR #2已关闭未合并，仅删除专用测试分支。真实凭据一直由Controller或Root supervisor持有，模型/worker只有短期代理token。已知凭据原字节扫描、临时模型/入站文件与专用容器删除分别有[扫描](../../agentarts/evidence/capacity-finish/secret-scan.json)、[本地清理](../../agentarts/evidence/capacity-finish/secret-cleanup.json)、[GitHub清理](../../agentarts/evidence/capacity-finish/github-receipts/cleanup.json)证据。

## 交付检查与下一步

配套源码[CI 37595273406](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37595273406)通过：2090测试通过、39跳过，59.15秒；生成/格式/lint/typecheck、coverage、根bundle及6个AgentArts bundle/10个启动干跑探针、Linux独立Docker验证与原native smoke均通过。[原始日志](../../agentarts/evidence/capacity-finish/regression/capacity-ci-37595273406.log)。初次超限CI失败也保留在attempts，未改写为通过。后续仅文档、原始证据与测试测量输出有变动，最终交付CI以对应提交的实际结果为准。

Demo最新记录另完成1280/390真实浏览器检查，导出字节、6条工具状态/耗时、错误与成功、真实链接准确，无布局/脚本错误；[QA](../../agentarts/evidence/capacity-finish/browser-qa/)。前轮四状态12截图继续保留各自来源。内置连接不可用，使用独立fresh Edge，用户ICT页面未动。可复现查看（替换为当前仓库绝对路径）：

```sh
node agentarts/demo/serve.mjs --record /absolute/Huawei-AgentArts-action/agentarts/evidence/capacity-finish/github-complete-workspace/run-record.json
```

审批通过后的第一步仍是核对目标租户的namespace/proc/seccomp/LSM/五cap并跑无凭据固定probe。[原生Ubuntu两架构拒proc的事实](host-requirements.md)未因编码修复消失；审批不等于宿主兼容。能力满足后再按[部署步骤](deployment.md)验证平台认证、SWR、固定版本、网络、任务时长/取消和真实PR。Gateway/MCP、平台观测/评估仍待真实接入；credentialed stdio/任意Plugin等[剩余迁移差异](compatibility-audit.md)没有通过放宽凭据限制伪装完成。
