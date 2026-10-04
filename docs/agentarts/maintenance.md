# 上游更新操作

本项目名称 Huawei-AgentArts-action。公共历史保留，`upstream` 指向原 deepseek-harness-action；`origin` 仅在批准创建新仓库后配置。当前基线和锁定依赖见 `agentarts/upstream-lock.json`。根 package 的版本保留为上游合同版本 `0.9.3`，衍生版本单独记录，不冒充已经发布的 AgentArts 版本。

更新从原 Action 已适配并验证的 commit 选择，不在衍生仓库直接自动追 DSH latest。

```bash
git status --short
git fetch upstream --tags
git switch -c upgrade/upstream-<short-sha>
git log --oneline <recorded-upstream-commit>..<chosen-upstream-commit>
git diff <recorded-upstream-commit>..<chosen-upstream-commit> -- src assets test package.json package-lock.json
git merge --no-commit <chosen-upstream-commit>
```

先确认工作区干净；占位 commit 要由维护者选择。冲突不能简单用 ours/theirs 批量覆盖。特别审查 DSH launcher/Profile、凭证白名单、模型协议、权限、工具、结果协议和 GitHub 写前复核是否变化。

适用更新合并后更新 upstream-lock 中的基线/版本/官方资料日期；DSH 直接依赖全部精确锁定，不混版本。运行安装、通用测试、类型/静态检查、AgentArts 边界测试、`prove:local`，再构建 ARM64 镜像并跑真实云端 PR + 失败/超时/取消链路。旧 Runtime 版本与可用 digest 保留供回滚。未验证的升级不得移动正式 alias 或发布。

Huawei 专属实现保留在现有附加目录，避免挪动共同源文件。通用修复单独 commit，重构单独 commit。若未来获准向上游提交通用修复，再另开 PR；当前没有向第三方提交。紧急修复可 `git cherry-pick -x <commit>`，记录来源、适用原因、测试和下次合并消除重复的步骤。

发布前更新第三方声明和实际云依赖版本；保留真实 task/日志/GitHub 链接。不把构建产物、模拟 Demo、仅本地测试或上游 canary 当成云端验收。根目录旧 canary 属于上游参考，衍生仓库默认不能用它自动升级或发布。
