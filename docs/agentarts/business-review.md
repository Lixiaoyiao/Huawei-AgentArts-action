# 独立业务复核

本页记录2026-10-07由Codex完成的**独立AI复核**，不是人工验收。复核对象为既有七例真实DSH/DeepSeek结果，runId `c00d93fd-9cd4-4f48-83db-dd2fda770454`；其实际模型运行源码为 `09e41d9a14542be47afaaee334210101142f0e4c`，不是后续镜像。原始evaluation、完整candidate文件和`manualVerdict: not-reviewed`均未改动。没有再次调用模型、AgentArts或GitHub。

## 七例需求与结果

需求来自固定[fixture](../../agentarts/fixtures/pr-review/cases.json)及[live-full](../../src/agentarts/live-full.ts)的七例选择。这里另行检查源码、模型解释和完整候选内容，不只读取自动`passed`。

| 任务                | 独立AI判断                     | 依据与保留意见                                                                                                                                                                        |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| review-bounds       | 核心发现正确                   | 改动行把`< length`变为`<= length`；`(3,3)`、`(0,0)`反例及第2行定位正确，未增加无关发现                                                                                                |
| review-clean        | 此固定改动无缺陷的结论合理     | 先计算`index < length`再与`index >= 0`合并，在声明的整数域中保持语义；无actionable finding                                                                                            |
| diagnose-bounds     | 定位正确，解释存在一处过度断言 | 上界错误和两个反例正确；但body/diagnosis声称length为0时所有非负index均通过。实际旧表达式只接受index 0，index 1返回false。这是自动rubric没有捕捉的文字错误，不能将该例解释视为完全正确 |
| fix-bounds          | 候选满足当前合同，未发现反例   | 完整文件恢复`index >= 0 && index < length`；以下896个独立合同通过                                                                                                                     |
| task-write-roles    | 候选满足当前合同，未发现反例   | 完整文件恢复所有requiredRoles均存在的判断，空要求允许；以下1030个独立合同通过                                                                                                         |
| implement-roles     | 候选满足当前合同，未发现反例   | 从未实现函数变为同样的完整角色判断；以下1030个独立合同通过                                                                                                                            |
| native-write-bounds | 候选满足当前合同，未发现反例   | 实际delta中的完整文件恢复排他上界；以下896个独立合同通过。native观测名称不作为逐工具成功凭据                                                                                          |

所有原始记录位于[live-model](../../agentarts/evidence/full-v3/live-model/)，具体链接及原模型耗时见[评测记录](evaluation.md)。此次没有编辑原模型错误或重新计算旧自动rubric。

## 独立隐藏合同

[测试](../../test/agentarts-business-review.test.ts)先核对四份candidate的原文件/候选bytes SHA256、taskDigest与delta input/resultDigest，确认原evaluation仍是`manualVerdict: not-reviewed`。随后将完整候选写入各自新私有目录，复用原`runValidationCommandsInDocker`，仅在本次审计受信test seam将原`--network bridge`收紧为`none`。代码只在固定digest的Node24.15容器执行，没有宿主import/eval或凭据挂载；这不改变产品验证器的网络政策。

Bounds的独立oracle是整数集合成员关系：length 0至32、index从-5至length+5，加上安全整数极值和负零，896项/候选。需求仅声明非负整数length与整数index，本次没有擅自要求小数、NaN或Infinity必须拒绝。

角色的独立oracle是集合差是否为空，不复用候选的`every/includes`表达式。覆盖32×32个角色子集、空要求、额外角色、重复角色、大小写、emoji和Unicode组合形式差异，输入数组冻结，1030项/候选。

真实Linux/Docker运行5项测试通过，四候选共3852个合同；总2.05秒。新[机器记录](../../agentarts/evidence/full-v3/independent-review/ai-hidden-contracts.json)和[原始日志](../../agentarts/evidence/full-v3/independent-review/ai-hidden-contracts.log)独立保存，不覆盖模型运行记录。机器记录明确`reviewKind: ai-independent-review-and-hidden-contracts`、`humanReviewRequired: true`与`manualVerdict: not-reviewed`。

这些检查增加了对固定需求与候选内容的信心，没有证明任意需求、任意仓库或全部模型解释正确；diagnose的已发现文字错误尤其说明自动通过与业务正确性需要分开。人工仍需阅读真实任务、源码、影响和候选，单独填写判断，不能把本次AI复核改记为人工通过或成功率。
