# Session 检查点与显式恢复

[English](../session.md) · [配置](../configuration.md) · [安全边界](../../SECURITY.md)

Session 是显式 opt-in，用于在后续 Actions run 中继续同一任务。它复用固定
**DSH 0.2.0-rc.2** 的公开 JSONL persistence 和 `--session-id`。检查点保存完整的
原始 v4 Session 日志及来源 manifest；headless NDJSON 事件投影、拼接历史评论都
不能替代真实 Session 日志。

把[可运行 dispatch 示例](../../examples/session.yml)复制到
`.github/workflows/dsh-session.yml`，提交到默认分支并配置 `DEEPSEEK_API_KEY`。
生产环境应绑定 v0.9.3 Release 公布的 Action 完整 commit。在默认分支
dispatch `save`。该 run 成功后，在**同一个 workflow** 中选择 `resume`，保持相同
key、模式，并将其数字 Actions run ID 填入 `source_run_id`。可以修改 prompt，
提出同一任务的后续问题。成功恢复后保存下一 generation；再次恢复时必须指定
最新成功 producer run。

| 输入                     | 含义                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- |
| `session-mode`           | 默认 `off`，另有 `save`、`resume`。`save` 创建新的逻辑 Session。                 |
| `session-key`            | 维护者选择的 1–64 位 ASCII 字母、数字、点、下划线或连字符；save/resume 必填。    |
| `session-source-run-id`  | 仅 resume 必填，显式指定成功 producer run ID；使用在线核验后的当前 run attempt。 |
| `session-retention-days` | 默认 `3`，范围 `1`–`7` 天；过期状态拒绝恢复。                                    |

controlled 和 native 都要求 `isolation: docker`、digest 锁定镜像及固定 worker
工作目录 `/workspace`。host 执行不能提供跨 run 稳定的 cwd 身份。检查点最多保存
**4 MiB** 原始日志、**16 KiB** manifest；保留真实记录及原始模型流结算，不静默
截断、脱敏改写或迁移原始日志。

## 工作流与来源绑定

启用 Session 的 workflow 必须在**根级别**声明以下字面量 concurrency：

```yaml
concurrency:
  group: dsh-session
  cancel-in-progress: false
```

该 group 在同一仓库内串行执行 Session 工作流。一个静态命名 job 中只能有一个
Session-producing Action step；不支持 producer matrix 或 reusable job。不用
表达式替换 group，也不启用取消并发 run。Session 模式、key、source run 必须由
维护者控制，PR/Issue 内容、日志和模型输出不能选择这些配置或授予权限。

本次 GitHub triggering actor 必须与刚核验的授权身份一致。由不同账号发起的
rerun 会被拒绝；应使用新的维护者 dispatch 恢复，其账号可以不同于来源 run。

Controller 在线重新核验仓库 ID、默认分支、不可变 workflow revision、workflow
路径、静态 job 和 run attempt。来源必须是同仓库默认分支的成功 run；拒绝
`pull_request`、`pull_request_target` 来源。manifest 还绑定 task、key、DSH
版本、composition、镜像、扩展配置、generation 和保留期限。Issue/PR 绑定实体与
operation；automation 绑定 operation 与 Session key，所以允许修改后续指令。
改变仓库、任务、key 或运行时组合时，使用新的 key 创建 Session。
controlled 扩展 digest 包含其有效扩展工具授权；权限变更如果移除或改变这些授权，
恢复会因不兼容而拒绝，需要新的 key。扩展配置或凭据变更也可能改变 digest。
每次兼容恢复仍会重新计算当前权限。

GitHub artifact 元数据能证明所属 workflow run，不能独立证明由哪个 job 上传。
manifest 中的 job/actor 字段会与当前 GitHub run/job 元数据核对，但不是服务端签发
的 artifact issuer 证明。信任边界是维护者审阅的**整个默认分支 workflow**；应
审阅所有 step、引用的 Action，以及能够上传 artifact 的步骤。

只允许恢复最新成功 generation。旧来源、多个匹配检查点、重复执行已经 claim 的
attempt、过期状态、generation 冲突都会 fail closed。claim 记录已经开始的
attempt；失败或结果不明的 run 不能作为恢复来源。先查看 run 结果并核对外部副
作用，再选择新的逻辑 key；不会靠自动重放任务或重试写操作恢复不明结果。

## 权限、凭据与保留数据

新 worker 使用本次 run 重新计算的权限；启动策略在 driver 执行前替换历史
permission、sandbox、approval 设置，不恢复旧授权。Controller 的 GitHub 写入
仍需授权、验证、写前即时校验和结果核对，导入检查点不会重放以前的 GitHub
写入。外部扩展的凭据和副作用继续按扩展自身边界管理。

导出仅接受一个完整、已结算的顶级 Session。排队输入、未结束的 turn/request/
tool 或其他已跟踪操作、child/fork 血缘、不兼容 cwd/preset、未知必需事件、损坏
记录、额外 Session/generation、符号链接、硬链接以及超限 JSON 复杂度均拒绝。
artifact 仅含 `manifest.json` 与 `session.jsonl`，不保存完整 worker home、配置
或 lease 文件。导入校验完整性后写入新的专用目录，拒绝覆盖现有状态。

初版不会自动快照 child Session。native 保留现有工具图；任务如果实际创建了
subagent/child persistence，额外 Session 会使检查点收集失败并给出明确诊断，
不会只保存父 Session 的半套状态。blocked 或失败任务不生成可恢复检查点；先
核对其 claim 与外部副作用，再创建新的逻辑 Session。

导出和导入检查 Controller 实际已知凭据、扩展实际秘密、proxy 凭据、凭据字段、
已知 token 格式及 private key。发现后给出不回显原文的诊断并拒绝，不改写 raw
日志来获得成功。这些检查**不能证明已排除任意第三方事件数据中的所有秘密**。
检查点会保留任务文本、仓库上下文、模型输出及工具结果；将 Actions artifact
视为保留的任务数据，启用前审查扩展输出。该功能提供文本会话连续性，不代表
原生图片或 Office 附件支持。

workflow/run/artifact 读取复用现有 Controller GitHub client 与配额诊断。SDK 上传
使用独立的 job-scoped runtime 凭据；该 SDK 的传输请求数不计入主 client 审计。
上传等待有界，结果不明时保留诊断，不重放任务或写入。

## 失败后的处理

通过 run 结果和 artifact receipt 核对 source run、generation、校验值。只从
最新、兼容、成功 run 的检查点恢复。过期或不兼容时，用新的维护者 key 启动新
任务；损坏状态或凭据拒绝时，修复生成配置或输出并创建新 Session。手工编辑
原始记录会失去完整性和无损恢复保证。配置检查入口不会假装已经核验在线来源、
Docker 可用性或 artifact 权限；实际 run 会在模型启动前完成这些检查。
