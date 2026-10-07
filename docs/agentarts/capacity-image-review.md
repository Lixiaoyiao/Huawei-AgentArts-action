# 配套压缩镜像的独立AI复核

2026-10-07，Codex重新阅读了runId `275254cb-06c4-4076-96fc-90f33958a2c4`的七份输出、四份完整candidate及delta，另行执行隐藏合同。没有根据自动passed或此前同内容的候选继承结论。本页是**独立AI复核，不是人工验收**；原始[evaluation/candidate/suite](../../agentarts/evidence/capacity-finish/model-final/)没有改写，`manualVerdict: not-reviewed`仍保留。

本次Controller声明源码`4da864c2e6b11575ffc72216a92f59aa2a63a52a`；配套Runtime源码`14bd277ca42a48406c7fe3a33ca903d5fd7d3f70`，镜像`sha256:6a5b8920363586a3a59a68ed33cdab09d9f2d04854312b51d17882ae3538006e`。旧25b镜像和旧suite仍属各自历史证据。这次收发端都使用新的确定性每文件压缩策略；声明不是远程attestation，也不表示云平台通过。

| 任务                | 独立AI判断                       | 依据与保留意见                                                                                                                                                                                                                                  |
| ------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| review-bounds       | 发现、定位与反例正确             | 第2行的`<= length`接受index等于length及空集合index0；建议恢复严格上界，未增加无关finding                                                                                                                                                        |
| review-clean        | 无缺陷结论合理，但解释有事实错误 | 返回值在声明的primitive number/整数合同内保持一致。summary却称“same evaluation order”：原代码先判断`index >= 0`并短路，新代码先计算`index < length`，顺序并不相同。该域内比较无副作用，所以这不是该固定需求的行为缺陷；仍不能把解释记为完全正确 |
| diagnose-bounds     | 诊断与具体反例正确               | 准确说明index等于length和空集合index0；旧09e“所有非负index通过”错误没有重现                                                                                                                                                                     |
| fix-bounds          | 候选满足固定需求，未发现反例     | 完整文件恢复`index >= 0 && index < length`，896个独立合同通过                                                                                                                                                                                   |
| task-write-roles    | 候选满足固定需求，未发现反例     | 完整文件使用`requiredRoles.every(role => userRoles.includes(role))`，保留空要求允许；1030个合同通过                                                                                                                                             |
| implement-roles     | 候选满足固定需求，未发现反例     | 替换Not implemented异常为完整的全部角色检查；1030个合同通过                                                                                                                                                                                     |
| native-write-bounds | 候选满足固定需求，未发现反例     | 实际delta完整文件恢复排他上界；896个合同通过。观测工具名不作为逐工具成功回执                                                                                                                                                                    |

review-clean称提供的CI反例全部通过，是对所给材料的表述，没有模型实际执行测试的证据。fix/native输出明确skipped，其他模型文字也不能代替Controller独立验证。这里既保留合理的业务结论，也保留解释和执行证据范围的不足，不为消除措辞错误再调用模型。

## 本轮独立隐藏合同

使用[既有审计测试](../../test/agentarts-business-review.test.ts)的显式Linux opt-in，固定上述runId和只读保存的原始证据目录。重新核对四candidate的完整原bytes/候选bytes SHA256、本次taskDigest、delta input/resultDigest，检查原evaluation仍未人工复核；候选只在各自新目录中的固定Node24.15 digest容器运行，复用原Docker验证器，仅本次可信test seam收紧为`--network none`。

整数bounds采用集合成员关系oracle，每候选896项；roles采用集合差oracle，含冻结输入、重复、空要求、大小写和Unicode，每候选1030项。四候选共3852个合同，5个测试通过，总1.99秒。输入与scratch副本逐字节比较一致，私有scratch已经删除。此次审计没有模型、AgentArts或GitHub调用，没有宿主import/eval或凭据挂载，也没有修改产品验证器的网络政策。

新[机器记录](../../agentarts/evidence/capacity-finish/independent-review/ai-hidden-contracts.json)、[原始日志](../../agentarts/evidence/capacity-finish/independent-review/ai-hidden-contracts.log)和[输入摘要](../../agentarts/evidence/capacity-finish/independent-review/inputs-sha256.txt)单独保存。重跑时选择新输出文件，避免覆盖历史：

```sh
AGENTARTS_RUN_BUSINESS_REVIEW=true \
AGENTARTS_BUSINESS_REVIEW_RUN_ID=275254cb-06c4-4076-96fc-90f33958a2c4 \
AGENTARTS_BUSINESS_REVIEW_EVIDENCE=/absolute/immutable-model-evidence \
AGENTARTS_BUSINESS_REVIEW_OUT=/absolute/new-ai-review.json \
npx vitest run test/agentarts-business-review.test.ts --maxWorkers=1
```

这些任务仍是固定的合成GitHub上下文；本suite没有发布GitHub或调用AgentArts，成本未知。额外合同与AI判断只增加对当前需求和候选的证据，不能证明任意仓库正确性，不替代人工业务验收，不计算模型成功率。本轮真实PR链路另按其自己的输入、Controller/Runtime绑定和发布记录验收。
