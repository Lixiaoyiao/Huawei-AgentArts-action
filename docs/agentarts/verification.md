# 验证记录

日期：2026-10-04。项目：Huawei-AgentArts-action。上游基线 `891570ef2254334dff8de22af948f3f0105e933e`，DSH `0.2.0-rc.2`，Node `24.15.0`。Git 历史完整保留；原仓库未写入。以下是实际运行状态，不是平台效果分数。

| 层次                           | 状态              | 实际证据与限制                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 通用及新增自动化测试           | 本地及 CI 通过    | Windows 快照 1652 通过、3 跳过；[Linux 完整 CI](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37190222963) 为 1677 通过、1 跳过，代码 commit `28b4b4b8ce33f02d5b2abe4ebd68292f2533c1bd`，含新增 workflow 与静态导出检查及平台差异。新增测试包括真实 DSH worker 与模拟 Runtime/GitHub 的 Controller 验证。 |
| 静态及合同检查                 | 本地通过          | TypeScript、ESLint、Prettier、Action 合同生成、原 release contract 与 DSH 配置检查。                                                                                                                                                                                                                                           |
| Windows 完整本地审查           | 本地通过          | [实际记录](../../agentarts/evidence/local-run-record.json)：HTTP server → 真实 DSH → read 工具 → 回执 → Controller → diff 锚点/边界 oracle。确定性模型与 PR 夹具；没有 GitHub 发布；UID 使用明确的测试豁免。                                                                                                                   |
| Linux 独立 UID 审查            | 本地通过          | [实际记录](../../agentarts/evidence/linux-run-record.json)：同链路运行，UID/GID10001，补充组清空，root 私有文件与父进程 `/proc` 环境不可读；检查所需 Linux capabilities。WSL Ubuntu，非容器、非云端。                                                                                                                          |
| 生产容器镜像 AMD64             | CI 实际通过       | [实际运行](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37187847055) 与 [容器记录](../../agentarts/evidence/container-amd64.json)：最终镜像运行真实 DSH/UID/read、拒绝重复任务、实际模型请求超时后清理子进程；模型与 PR 为夹具。                                                                         |
| 生产容器镜像 ARM64             | QEMU CI 实际通过  | [双架构运行](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37187847055) 与 [ARM64 记录](../../agentarts/evidence/container-arm64-qemu.json)：真实 DSH/UID/read、重复拒绝及超时清理均通过，`emulated: true`。原生 ARM 和 AgentArts 租户仍未验证。                                                          |
| AgentArts Runtime              | 尚未验证          | 未部署、未调用，没有真实云 Session、运行分析或 LTS 证据。                                                                                                                                                                                                                                                                      |
| 真实 GitHub → AgentArts → 评论 | 尚未验证          | 待云端环境和 Secrets。模拟发布测试不是这个阶段的成功记录。                                                                                                                                                                                                                                                                     |
| Gateway/MCP、平台评估          | 未接入            | 已调查实际能力与限制，没有伪造接入或评分。                                                                                                                                                                                                                                                                                     |
| Demo                           | HTTP/数据检查通过 | 真实记录驱动、空状态、文件回放、失败、模式标识、安全链接和大小限制已检查。自动浏览器连接失败；视觉 QA 尚未确认。                                                                                                                                                                                                               |

Windows 测试快照覆盖率：Statements 84.75%，Branches 78.07%，Functions 92.63%，Lines 86.84%。上面链接的 Linux CI 为 84.75%、78.14%、92.57%、86.86%。这些仅表示自动化测试覆盖，不表示模型成功率或修复正确率。

随后新增静态 Demo 导出：22 项针对性测试实际通过，涵盖原始记录字节一致、严格字段/UTF-8、重复及转义等价 JSON 键、大小/深度/扫描节点限制、已有输出拒绝、CSP 哈希、子路径和静态回放不轮询。HTTP viewer 实测 200、CSP 与实际脚本/样式匹配、记录字节未变。此阶段没有公开部署、没有浏览器视觉验收，也没有调用云端；不能把它加入真实云任务成功率。

双架构记录都绑定源码 `3957bbe4e6b589c7fd790a1a05ff86394d11be9f`。AMD64 镜像 ID 为 `sha256:a24ef93ffc9f255564706a4919c81f5cbca590d54e4d5f7f7367761f93da1e95`，总耗时 8863 ms；ARM64 QEMU 镜像 ID 为 `sha256:67b3f0ab8c8c174c6e7f5488fb4fb7db16310403a5373a49f2cc804eaad3e0ab`，总耗时 33295 ms。总耗时包含两种架构各自的超时案例，不能作为正常云任务延迟。原始 Actions artifact 和保存的 JSON 对应这次实际构建，没有推送 SWR。

[AMD64 首次通过记录](../../agentarts/evidence/container-amd64-initial.json) 的源 commit 为 `d845474a236685300e751e77301112775297b5bb`，实际 image ID 为 `sha256:f96f9aa55a0f8c54dc2b5a2d02aeda34cf638146a9d7b4dd2d1300e00f7c9c85`，测量总耗时 8804 ms（含超时案例）。它是本地 Docker image ID，不是已推送的 SWR digest；仅对应那次构建。矩阵新增 QEMU Action 固定 commit、binfmt digest，并在证据中显式记录是否模拟执行。

复现路径：`agentarts/README.md`。Windows 并行启动多组真实 DSH/上游 worker 且同时构建时曾触发测试时限；最终采用最多两个 Vitest workers，保持产品截止时间不变，仅给真实 worker 测试足够的启动预算。没有跳过失败断言。继承 workflow 的两个合同断言随“仅允许原仓库执行旧自动化”更新，其行为在新仓库禁用。

真实云验收必须补充：镜像 digest/架构、Runtime 版本/固定 alias、Session/taskId、head/base、日志记录、独立业务判定、GitHub 结果链接、过期提交/权限拒绝/超时/取消与重复运行结果。费用和 token 使用尚未可靠统计。

开发使用 Codex 与并行助手进行官方文档调查、实现和独立审查；通过 Git/npm/TypeScript/Vitest/ncc 构建验证。测试模型响应来自原 SSE 夹具，不能据此宣称 DeepSeek 模型质量。官方 SDK 源码仅供调查，没有新增华为 Python SDK 运行依赖。
