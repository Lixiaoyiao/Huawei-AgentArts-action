# 验证记录

日期：2026-10-04。项目：Huawei-AgentArts-action。上游基线 `891570ef2254334dff8de22af948f3f0105e933e`，DSH `0.2.0-rc.2`，Node `24.15.0`。Git 历史完整保留；原仓库未写入。以下是实际运行状态，不是平台效果分数。

| 层次                           | 状态              | 实际证据与限制                                                                                                                                                                                               |
| ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 通用及新增自动化测试           | 本地通过          | 1652 通过、3 跳过；Windows 用 `npm run test:coverage -- --maxWorkers=2`，达到原覆盖率门槛。新增测试包括真实 DSH worker 与模拟 Runtime/GitHub 的 Controller 验证。                                            |
| 静态及合同检查                 | 本地通过          | TypeScript、ESLint、Prettier、Action 合同生成、原 release contract 与 DSH 配置检查。                                                                                                                         |
| Windows 完整本地审查           | 本地通过          | [实际记录](../../agentarts/evidence/local-run-record.json)：HTTP server → 真实 DSH → read 工具 → 回执 → Controller → diff 锚点/边界 oracle。确定性模型与 PR 夹具；没有 GitHub 发布；UID 使用明确的测试豁免。 |
| Linux 独立 UID 审查            | 本地通过          | [实际记录](../../agentarts/evidence/linux-run-record.json)：同链路运行，UID/GID10001，补充组清空，root 私有文件与父进程 `/proc` 环境不可读；检查所需 Linux capabilities。WSL Ubuntu，非容器、非云端。        |
| 生产容器镜像                   | 待 CI 真实运行    | `agentarts-image.yml` 构建 Linux AMD64 最终镜像，离线实际 DSH/UID/重复/超时 smoke；ARM64 和真实 AgentArts 租户仍须另外验证。                                                                                 |
| AgentArts Runtime              | 尚未验证          | 未部署、未调用，没有真实云 Session、运行分析或 LTS 证据。                                                                                                                                                    |
| 真实 GitHub → AgentArts → 评论 | 尚未验证          | 待云端环境和 Secrets。模拟发布测试不是这个阶段的成功记录。                                                                                                                                                   |
| Gateway/MCP、平台评估          | 未接入            | 已调查实际能力与限制，没有伪造接入或评分。                                                                                                                                                                   |
| Demo                           | HTTP/数据检查通过 | 真实记录驱动、空状态、文件回放、失败、模式标识、安全链接和大小限制已检查。自动浏览器连接失败；视觉 QA 尚未确认。                                                                                             |

覆盖率：Statements 84.75%，Branches 78.07%，Functions 92.63%，Lines 86.84%。这些仅表示自动化测试覆盖，不表示模型成功率或修复正确率。

复现路径：`agentarts/README.md`。Windows 并行启动多组真实 DSH/上游 worker 且同时构建时曾触发测试时限；最终采用最多两个 Vitest workers，保持产品截止时间不变，仅给真实 worker 测试足够的启动预算。没有跳过失败断言。继承 workflow 的两个合同断言随“仅允许原仓库执行旧自动化”更新，其行为在新仓库禁用。

真实云验收必须补充：镜像 digest/架构、Runtime 版本/固定 alias、Session/taskId、head/base、日志记录、独立业务判定、GitHub 结果链接、过期提交/权限拒绝/超时/取消与重复运行结果。费用和 token 使用尚未可靠统计。

开发使用 Codex 与并行助手进行官方文档调查、实现和独立审查；通过 Git/npm/TypeScript/Vitest/ncc 构建验证。测试模型响应来自原 SSE 夹具，不能据此宣称 DeepSeek 模型质量。官方 SDK 源码仅供调查，没有新增华为 Python SDK 运行依赖。
