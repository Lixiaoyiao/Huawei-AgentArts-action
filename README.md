# Huawei-AgentArts-action

[中文](README.zh-CN.md)

A separately maintained AgentArts Runtime migration of [deepseek-harness-action](https://github.com/Lixiaoyiao/deepseek-harness-action). It retains DSH, the trusted GitHub Controller and the complete upstream source/history. The migration covers existing review, generic tasks, CI diagnosis, controlled fixes and Issue→PR capabilities in verified stages.

**PR Review is the first integration and acceptance stage. Cloud access is awaiting approval; GitHub → AgentArts → DSH → GitHub acceptance has not passed.** This round also adapts existing read-only `task`/`diagnose` through protocol v2 and prototypes checked workspace transfer; their current verification and admission status are explicit in the [capability matrix](docs/agentarts/capability-matrix.md). Write operations remain closed. Existing capabilities have not been silently removed. Historical image CI, local runs and cloud acceptance are separate evidence. This working round remains local and is not a new public release.

Local production images built from clean source `d9b8dc2` passed nine runtime cases and two startup refusal checks on AMD64 and ARM64 QEMU, using real DSH with a deterministic model fixture. A separately authorized live-model attempt returned `WORKER_FAILED` on the first case and stopped the remaining three; its cause and provider usage remain unknown. Later diagnostic code changes require new image verification. Details are in the [verification record](docs/agentarts/verification.md).

Start with the [PR Review README](agentarts/README.md), then the [deployment and acceptance manual](docs/agentarts/deployment.md). See [verification evidence](docs/agentarts/verification.md), [Demo guide](docs/agentarts/demo-guide.md), [business acceptance cases](docs/agentarts/evaluation.md) and [upstream update procedure](docs/agentarts/maintenance.md).

The AgentArts Action entry is `agentarts/action.yml`; check its current inputs and the capability matrix before selecting an operation. The inherited root Action, installer and examples remain intact as upstream implementations and regression/reference material, and do not invoke AgentArts. Their complete introductions are archived under [docs/upstream](docs/upstream/README.md). A capability's presence in inherited code does not establish its cloud compatibility.

Upstream Git history and `upstream` are preserved; the original repository has not been modified. Sources and new integration are identified in the PR Review README and [upstream-lock.json](agentarts/upstream-lock.json). [MIT license](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md) and [bundled notices](BUNDLED_DEPENDENCIES.md) remain in place.
