# Huawei-AgentArts-action

[中文](README.zh-CN.md)

An independently maintained AgentArts Runtime migration of [deepseek-harness-action](https://github.com/Lixiaoyiao/deepseek-harness-action). It retains DSH, the trusted GitHub Controller, upstream history and existing security/validation/publication logic.

The current Action routes all original operations through the versioned Runtime engine: review, generic read/write tasks, CI diagnosis, controlled fixes and Issue→PR. It also adapts controlled/native compositions, original tool callbacks, extensions and DSH checkpoint transport. This is implementation status; environment-specific acceptance is recorded separately in the [capability matrix](docs/agentarts/capability-matrix.md). **The real GitHub → AgentArts → DSH → GitHub chain has not passed acceptance.** Cloud access is awaiting approval.

The clean local AMD64 image from `09e41d9` passed seven real DeepSeek cases, including four actual file changes with independent Docker contract tests. These are automatic checks on synthetic GitHub tasks; human review and costs remain unknown. The final local `610f685` image also passed fixture smoke and separate five-capability source tests for extension installation and Session recovery after an ownership fix. Native Ubuntu24 image CI still rejects proc mounting. [Verification records](docs/agentarts/verification.md) keep these scopes separate; confirm the target tenant can provide the required sandbox before creating cloud resources.

Repository files travel as a bound, checked workspace manifest. Runtime executes DSH inside a mandatory Linux filesystem/PID/user/network namespace; real credentials stay with trusted supervisors. Actual stopped-worker file changes return to the Controller, which retains independent Docker validation, validation-integrity checks and GitHub finalizers. A supervisor bridge supports scoped read-only, credentialed HTTP MCP tools; plaintext credentials in task extension definitions remain rejected. This bridge is separate from Huawei Gateway/MCP service acceptance.

Start with the [migration README](agentarts/README.md) and [deployment manual](docs/agentarts/deployment.md). The [workflow installer](agentarts/install.mjs) embeds the original templates with an explicit immutable AgentArts Action commit. See [Demo guide](docs/agentarts/demo-guide.md), [acceptance cases](docs/agentarts/evaluation.md) and [upstream maintenance](docs/agentarts/maintenance.md). Deployment requires the documented kernel, namespace and host policy checks.

Use `agentarts/action.yml` for this project. The inherited root Action and installer still target the original project and remain available as upstream reference/regression material; their complete introductions are archived under [docs/upstream](docs/upstream/README.md).

The original repository is unchanged. The shared history and `upstream` remain intact; the fixed upstream/DSH versions are in [upstream-lock.json](agentarts/upstream-lock.json). [MIT license](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md) and [bundled notices](BUNDLED_DEPENDENCIES.md) are preserved.
