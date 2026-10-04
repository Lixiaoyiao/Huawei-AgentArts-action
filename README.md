# Huawei-AgentArts-action

[中文](README.zh-CN.md)

A separately maintained AgentArts Runtime migration of [deepseek-harness-action](https://github.com/Lixiaoyiao/deepseek-harness-action). It retains DSH, the trusted GitHub Controller and the complete upstream source/history. The migration covers existing review, generic tasks, CI diagnosis, controlled fixes and Issue→PR capabilities in verified stages.

**PR Review is the first integration and acceptance stage. Cloud access is awaiting approval; GitHub → AgentArts → DSH → GitHub acceptance has not passed.** This update also adapts existing read-only `task`/`diagnose` through protocol v2 and prototypes checked workspace transfer; their current verification and admission status are explicit in the [capability matrix](docs/agentarts/capability-matrix.md). Write operations remain closed. Existing capabilities have not been silently removed. Historical image CI, local runs and cloud acceptance are separate evidence. The public repository includes source and local evidence; cloud deployment and acceptance are tracked separately.

The latest local AMD64 and ARM64 QEMU production images each passed nine runtime cases and two startup refusal checks with real DSH and a deterministic model fixture. Four fixed review cases also passed the automatic rubric through the same AMD64 image and live DeepSeek, using eight measured provider requests. These use synthetic PR context, have no GitHub publication or AgentArts calls, and still require human review; actual cost is unknown. Earlier failures and source-specific image evidence remain in the [verification record](docs/agentarts/verification.md).

Start with the [PR Review README](agentarts/README.md), then the [deployment and acceptance manual](docs/agentarts/deployment.md). See [verification evidence](docs/agentarts/verification.md), [Demo guide](docs/agentarts/demo-guide.md), [business acceptance cases](docs/agentarts/evaluation.md) and [upstream update procedure](docs/agentarts/maintenance.md).

The AgentArts Action entry is `agentarts/action.yml`; check its current inputs and the capability matrix before selecting an operation. The inherited root Action, installer and examples remain intact as upstream implementations and regression/reference material, and do not invoke AgentArts. Their complete introductions are archived under [docs/upstream](docs/upstream/README.md). A capability's presence in inherited code does not establish its cloud compatibility.

Upstream Git history and `upstream` are preserved; the original repository has not been modified. Sources and new integration are identified in the PR Review README and [upstream-lock.json](agentarts/upstream-lock.json). [MIT license](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md) and [bundled notices](BUNDLED_DEPENDENCIES.md) remain in place.
