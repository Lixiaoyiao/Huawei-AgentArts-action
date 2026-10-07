# 上游兼容与发布边界审计

核对日期2026-10-07，上游固定为`891570ef2254334dff8de22af948f3f0105e933e`。本页按原源码已有实现核对；云端能力仍须按[部署](deployment.md)和[验证记录](verification.md)验收。

## 保留与实际差异

原五种operation、十类事件、自动路由、actor/fork政策、controlled/native composition、原工具catalog、真实工作区修改、独立验证、baseline replay、GitHub finalizer及DSH Session均已经进入v3主链路。并不表示所有扩展组合或平台均已验收；具体入口见[能力表](capability-matrix.md)。

| 上游能力/配置                                                                | 当前情况                                                                                                                                                    | 分类                                                     |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| GitHub固定40SHA的`git+https`包源                                             | 原schema与lock audit保留；发现原Runtime镜像没有Git，现补Git与公开CA的最小适配，实际固定Git安装证明另记录                                                    | 真实环境兼容缺口，不能用npm registry安装通过替代         |
| native MCP的`credentialEnv`、`credentialHeaders`与Plugin的`credentialConfig` | 这些字段在上游确实已有。新Runtime拒绝在任务中传明文凭据；只读HTTPS MCP可用operator reference和supervisor代理。任意credentialed stdio/Plugin尚无通用等价接入 | 原能力的明确迁移差异，不默默删除、不向不可信进程传Secret |
| 无凭据stdio、公开HTTP MCP、Bundle/Plugin                                     | 原schema、原composition、安装锁和工具权限继续使用；每个外部可执行文件、网络代理兼容性及插件业务功能仍须检查                                                 | 已接代码，不能由安装成功推断业务成功                     |
| 自选DSH版本/可执行文件、process隔离、模型origin/key                          | 这六项输入由Runtime受信部署管理，Controller拒绝请求覆盖；其余原Action contract输入由代码导出复用                                                            | 明确部署接口变化，符合固定版本和云隔离要求               |
| 宿主已有任意命令/私网访问                                                    | 固定镜像只提供已声明二进制；worker无直接网络，只能经批准的精确origin代理                                                                                    | 运行环境与安全边界变化，不能保证任意宿主扩展原样运行     |
| OAuth、长订阅MCP、多模态附件                                                 | 上游没有这些完整实现，当前也不提供                                                                                                                          | 不是原能力迁移丢失，不为补齐表格而新增                   |
| AgentArts Gateway、平台Trace、平台评估                                       | 属于此次新增的目标云能力，尚未真实接入/验收                                                                                                                 | 不属于原仓库回归，不能声称平台已工作                     |

实际字段证据见原共同历史的`src/extensions/schema.ts`与当前同名文件；Runtime凭据拒绝和原plan重建见[runtime-task-protocol](../../src/agentarts/runtime-task-protocol.ts)。通用stdio/Plugin凭据没有统一可安全注入的语义：直接复原原明文字段会把真实Secret交给仓库工具或插件。后续只能在明确需要的协议上设计受信代理并单独验收，不能通过放宽拒绝实现“兼容”。

## 并发、重启、取消与发布

Runtime的重复taskId集合是**单实例内存**，容量4096，不驱逐后重放，满后拒绝工作。重启不会保留该集合，因此客户端不自动重试模糊的POST；Runtime本身没有GitHub写凭据。Controller每轮使用新UUID，检查task/operation/entity/ref/grants/revision/digests，拒绝旧结果与并发turn；任何拒绝后的engine不可复用。[server](../../src/agentarts/server.ts)、[FullEngine](../../src/agentarts/engine-full.ts)。

受检delta和Session事务先完成，才返回原loop。取消/截止仍须在安装和原验证/finalizer处检查；已经确认的远程部分效果按原结果记录，不能假装回滚GitHub。新组合测试覆盖并发turn拒绝、跨engine旧reply拒绝、失去updateRef响应后的精确成功对账、冲突ref不重试，以及独立验证后取消时queued label和commit均不发布。[engine tests](../../test/agentarts-engine-full.test.ts)、[Controller tests](../../test/agentarts-full-controller.test.ts)。两文件本轮32项通过，其中这些组合的GitHub与验证结果为模拟，不能写成真实GitHub验收。

PR写入保留原非force更新及固定head复查；Issue/automation写保留确定性branch、operation marker和commit trailers。模糊GitHub写入只在读回精确目标后认成功，不重新调用模型或盲重发写入。[Git数据API](../../src/write/github.ts)、[PR对账](../../src/write/pr.ts)。

原review/comment publisher用marker与作者身份查找再更新/创建。这能处理串行重跑，不是跨独立Controller的原子去重：两个并发进程可能同时读到不存在再各自创建。原workflow的concurrency分组约束各自工作流，不能宣称跨所有workflow、重启和独立部署的exactly-once。相同实体应使用一致的受信调度锁，模糊发布后先查实际GitHub效果再人工决定下一步；当前不提供分布式任务平台。[review publisher](../../src/review/publisher.ts)、[sticky comment](../../src/github/comments.ts)。

原独立Docker测试会使用`--network bridge`，不挂Controller凭据不等于没有网络。当前迁移保留该上游测试环境；本次四候选隐藏复核在可信test seam单独使用`none`，不可把该审计网络属性套到全部原验证。[验证器](../../src/write/validate.ts)、[独立业务复核](business-review.md)。
