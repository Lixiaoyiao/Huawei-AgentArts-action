# Huawei-AgentArts-action

[English](README.md)

[deepseek-harness-action](https://github.com/Lixiaoyiao/deepseek-harness-action) 的独立 AgentArts Runtime 迁移版。保留 DSH、受信 GitHub 控制端、共同 Git 历史和原有权限、验证、发布实现。

当前 Action 已将原 `review`、通用读写 `task`、CI `diagnose`、受控 `fix` 和 Issue→PR `implement` 接到版本化 Runtime engine，并适配 controlled/native 组合、原工具回调、扩展和 DSH checkpoint 传输。这是代码接入状态，各环境实际验收另见 [能力迁移表](docs/agentarts/capability-matrix.md)。**真实 GitHub → AgentArts → DSH → GitHub 闭环尚未验收；账号准入仍待审批。**

代码通过绑定任务、实体、ref、提交和权限的受检工作区清单送入 Runtime。DSH 必须在 Linux 文件、进程、用户和网络 namespace 内运行；真实凭据留在受信监督进程。停止 DSH 后捕获的实际文件差异返回 Controller，继续使用原独立 Docker 测试、验证完整性检查和 GitHub finalizer。监督进程代理已接入受限只读 HTTP MCP 凭据工具，任务中的明文凭据定义仍拒绝；这不等于华为 Gateway/MCP 服务已验收。

从 [迁移 README](agentarts/README.md) 和 [部署手册](docs/agentarts/deployment.md) 开始。[新工作流安装器](agentarts/install.mjs) 复用原模板，要求显式固定本项目 Action commit。另见 [验证记录](docs/agentarts/verification.md)、[Demo 指南](docs/agentarts/demo-guide.md)、[业务验收](docs/agentarts/evaluation.md) 和 [上游更新说明](docs/agentarts/maintenance.md)。历史只读镜像和真实模型评测不替代本轮完整任务代码验收。

本项目入口是 `agentarts/action.yml`。根目录旧 Action 与旧安装器仍指向原项目，作为上游参考与回归材料保留；完整旧介绍归档于 [docs/upstream](docs/upstream/README.zh-CN.md)，不要把旧安装命令当成本版入口。

原仓库未修改，共同历史和 `upstream` 保留；上游/DSH 固定版本见 [upstream-lock.json](agentarts/upstream-lock.json)。[MIT 许可证](LICENSE)、[第三方声明](THIRD_PARTY_NOTICES.md) 与 [打包依赖声明](BUNDLED_DEPENDENCIES.md) 均保留。
