# 最终镜像结果的独立AI复核

2026-10-07，Codex只读复核了runId `4201acde-6fe8-4db6-9d3f-4da03f906689`的七份模型输出、四份完整candidate及其delta绑定。这是**独立AI复核，不是人工验收**。原始[evaluation/candidate/suite](../../agentarts/evidence/local-finish/model-final/)保留原字节；此前错误source声明的model-first尝试不计入本次验收，历史09e结果及已发现的解释错误也未删除。

本次Controller声明源码`6d07c5088aa1e8f919296917f3ea87299b49354e`，Runtime构建源码`25b207246e37f282b51bad12ea0e88d7775ab888`，本机镜像`sha256:029bd4854f2c6aca3f33cad7d2536aa9537dfb4d33584a2e3b3a8095f8b04412`。声明、构建记录与模型结果分别留证；声明不是远程attestation。本页没有再次调用模型、云或GitHub。

| 任务                | 独立AI判断                             | 实际核对依据                                                                                                                                                            |
| ------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| review-bounds       | 核心发现与反例正确                     | `<`变`<=`使index等于length被错误接受，空集合index0同样越界；第2行定位、证据和建议均符合固定需求                                                                         |
| review-clean        | 无缺陷结论合理，测试措辞不作为执行证据 | 在原函数的number合同内，提取比较保持语义；findings为空。summary说acceptance test“passes”，但verification明确`skipped`，没有真实测试执行证据，不能据此声称模型运行了测试 |
| diagnose-bounds     | 核心诊断与解释正确                     | 明确指出index等于length及空集合index0；旧09e“所有非负index均通过”的错误没有重现，不据此推断其他诊断也正确                                                               |
| fix-bounds          | 候选满足固定合同，未发现反例           | 完整文件恢复`index >= 0 && index < length`；下方896项隐藏合同通过                                                                                                       |
| task-write-roles    | 候选满足固定合同，未发现反例           | 完整文件使用`requiredRoles.every(role => userRoles.includes(role))`，保留空要求允许；1030项隐藏合同通过                                                                 |
| implement-roles     | 候选满足固定合同，未发现反例           | 从抛出Not implemented变为同样的全部角色判断；1030项隐藏合同通过                                                                                                         |
| native-write-bounds | 候选满足固定合同，未发现反例           | 实际delta内完整文件恢复排他上界；896项隐藏合同通过。模型的skipped声明与Controller独立验证分开理解                                                                       |

四份candidate内容恰好分别与此前已复核的bounds/roles修复一致，但本轮仍重新校验新runId、taskDigest、delta input/resultDigest和文件SHA，重新执行合同，没有继承旧运行的通过状态。两份bounds候选SHA256为`8c727768e7adde9e31661a82999bf559dfcd93b6026d6d77141d9a2b8fb56dce`，两份roles候选为`2594875386a6868f14f59d75175c03be452e50cc011b0c9e9942b0e563165fde`；各candidate artifact本身有不同SHA，记录于新机器证据。

## 本轮隐藏合同实测

复用[独立测试](../../test/agentarts-business-review.test.ts)，只在显式Linux audit opt-in下选择这份不可变runId/evidence目录。四个候选在不同私有目录中，由原Docker验证器执行；仅本次受信test seam将网络收紧为`none`。固定Node24.15 digest、无凭据挂载、无宿主import/eval、无模型或发布调用。

整数bounds用集合成员关系作独立oracle，每候选896项；roles用集合差、冻结数组、重复/空要求/大小写/Unicode作独立oracle，每候选1030项。共3852项合同、5个测试通过，总2.00秒。输入原始文件与scratch副本逐字节比较一致；私有scratch已删除。

新增[AI隐藏合同记录](../../agentarts/evidence/local-finish/independent-review/ai-hidden-contracts.json)、[原始测试日志](../../agentarts/evidence/local-finish/independent-review/ai-hidden-contracts.log)和[输入文件摘要](../../agentarts/evidence/local-finish/independent-review/inputs-sha256.txt)独立保存。没有改任何原`manualVerdict: not-reviewed`。可按新suite重跑审计（目录须指向可信操作者保存的原始证据，输出选择新文件）：

```sh
AGENTARTS_RUN_BUSINESS_REVIEW=true \
AGENTARTS_BUSINESS_REVIEW_RUN_ID=4201acde-6fe8-4db6-9d3f-4da03f906689 \
AGENTARTS_BUSINESS_REVIEW_EVIDENCE=/absolute/immutable-model-evidence \
AGENTARTS_BUSINESS_REVIEW_OUT=/absolute/new-ai-review.json \
npx vitest run test/agentarts-business-review.test.ts --maxWorkers=1
```

结论仅覆盖当前固定需求、返回内容和这些反例。成本仍未知；合成GitHub任务没有发布，AgentArts未验收，人工判读仍待完成。自动rubric通过、额外合同通过及本次AI判断都不能替代人工业务验收或推广为成功率。
