# Huawei-AgentArts-action

[English](README.md)

[deepseek-harness-action](https://github.com/Lixiaoyiao/deepseek-harness-action) 的独立 AgentArts Runtime 迁移版。保留 DSH、受信 GitHub 控制端、完整上游源码与共同历史；逐项迁移原有审查、通用任务、CI 诊断、受控修复和 Issue→PR 能力。

**PR Review 是第一条接入与验收链路。账号准入审批中，真实 GitHub → AgentArts → DSH → GitHub 验收尚未完成。** 本次更新同时适配原只读 `task`/`diagnose` 的 v2 协议并实现受检工作区传输原型；当前验证与准入状态见 [能力迁移表](docs/agentarts/capability-matrix.md)，写操作仍关闭。原有能力未默默删减。既有容器 CI、各次本地运行和云端验收分开记录。本仓库公开提供源码与本地证据，云端部署和验收单独记录。

最新本地AMD64和ARM64 QEMU生产镜像各通过9运行场景和2启动拒绝，真实DSH使用确定性模型夹具。同一AMD64镜像接真实DeepSeek的四个固定审查案例均通过自动规则，测得共8次provider请求。这些仍是合成PR，无GitHub发布或AgentArts调用，人工尚未复核、实际成本未知。旧失败与各版镜像证据保留在 [验证记录](docs/agentarts/verification.md)。

从 [PR Review README](agentarts/README.md) 开始；审批通过后按 [部署与验收手册](docs/agentarts/deployment.md) 执行。另见 [验证证据](docs/agentarts/verification.md)、[Demo 指南](docs/agentarts/demo-guide.md)、[业务验收用例](docs/agentarts/evaluation.md) 和 [上游更新说明](docs/agentarts/maintenance.md)。

AgentArts 入口是 `agentarts/action.yml`，选择 operation 前核对其当前输入和能力表。根目录旧 Action、安装器与 examples 作为完整上游实现及回归/参考材料保留，尚不调用 AgentArts；原整份介绍已归档至 [docs/upstream](docs/upstream/README.zh-CN.md)，不要把旧安装命令当成本版入口。源码保留不等于云端已兼容。

共同 Git 历史和 `upstream` 保留，原仓库未修改。继承实现与新增部分见 PR Review README 和 [upstream-lock.json](agentarts/upstream-lock.json)。[MIT 许可证](LICENSE)、[第三方声明](THIRD_PARTY_NOTICES.md) 和 [打包依赖声明](BUNDLED_DEPENDENCIES.md) 均保留。
