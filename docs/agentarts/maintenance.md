# 上游更新操作

本项目名称Huawei-AgentArts-action。共同历史保留，`upstream`指向原deepseek-harness-action，`origin`指向独立衍生仓库；原仓库未修改。当前基线/DSH/依赖见 [upstream-lock.json](../../agentarts/upstream-lock.json)，Moby seccomp与AppArmor来源分别见 [seccomp-source.json](../../agentarts/seccomp-source.json)、[apparmor-source.json](../../agentarts/apparmor-source.json)。根package版本保留上游合同`0.9.3`，衍生版本单独记录，不冒充正式AgentArts release。

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

适用更新合并后更新upstream-lock中的基线/版本/官方资料日期；DSH直接依赖精确锁定，不混版本。跑原通用回归、类型/lint/generated/release合同及AgentArts定向测试，单独验v3 workspace/delta、原独立测试/finalizers、Session真实save/resume、controlled/native、MCP/plugins与失败/超时/取消。`prove:local`只证明其只读Review路径，不代替完整迁移。

重新构建AMD64/ARM64固定镜像，记录各自source/dirty/input digest与架构；QEMU注明emulated，不当云/原生性能。bwrap版本、Moby默认profile来源/新增setup syscalls和worker BPF分别固定审查；不拉latest安全配置，也不为通过升级测试放开privileged/SYS_ADMIN。目标租户再跑真实PR Review和适用写任务、失败/超时/取消/重复/不确定发布链路；云未验时不得移动正式alias。旧Runtime版本和digest保留供回滚。

AppArmor策略单独升级与记录：固定Moby模板hash、ABI、bwrap两处pivot路径和generator输出，先执行 `node scripts/generate-agentarts-apparmor.mjs` 验字节，再于启用AppArmor的原生匹配架构宿主记录default拒绝/project probe/full smoke/清理。parser检查或AppArmor未启用的WSL通过不代表策略执行。专用profile中mount允许须与外层无SYS_ADMIN/五cap/no-new-privileges及worker清cap/BPF一起审查；不修改docker-default，不开unconfined或关闭全机AppArmor/sysctl。仅停完专用容器后卸载本次自建且不共享策略，步骤见 [部署手册](deployment.md#32-apparmor宿主策略)。真实AgentArts能否提供等效宿主策略必须租户确认；镜像或普通Linux CI通过不能替代它。

bubblewrap源码适配也单独固定审查：[metadata](../../agentarts/bubblewrap-source.json)中的Debian descriptor/orig/archive SHA、四个Debian补丁、本地dated proc补丁和完整patched C SHA；记录 `dpkg-buildflags hardening=+all` 的实际C/CPP/LD flags、无setuid以及随镜像完整对应源码/许可/recipe。更新不得丢失原Debian修复、移除Docker masked paths或增加hostproc/完整proc回退。Linux5.8+ `subset=pid`只是必要feature，不能绕过真实mount/LSM检查；升级须在原生两架构重跑，依赖systemproc的工具另验。旧09e真实模型不证明a3e及以后新helper，目标环境仍拒绝就保留失败，不把普通CI通过当作容器部署通过。

Huawei 专属实现保留在现有附加目录，避免挪动共同源文件。通用修复单独 commit，重构单独 commit。若未来获准向上游提交通用修复，再另开 PR；当前没有向第三方提交。紧急修复可 `git cherry-pick -x <commit>`，记录来源、适用原因、测试和下次合并消除重复的步骤。

发布前更新第三方声明和实际云依赖版本；保留真实 task/日志/GitHub 链接。不把构建产物、模拟 Demo、仅本地测试或上游 canary 当成云端验收。根目录旧 canary 属于上游参考，衍生仓库默认不能用它自动升级或发布。
