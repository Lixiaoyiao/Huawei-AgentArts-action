# Huawei-AgentArts-action

[中文](README.zh-CN.md)

An independently maintained AgentArts Runtime migration of [deepseek-harness-action](https://github.com/Lixiaoyiao/deepseek-harness-action). It retains DSH, the trusted GitHub Controller, upstream history and existing security/validation/publication logic.

The current Action routes all original operations through the versioned Runtime engine: review, generic read/write tasks, CI diagnosis, controlled fixes and Issue→PR. It also adapts controlled/native compositions, original tool callbacks, extensions and DSH checkpoint transport. This is implementation status; environment-specific acceptance is recorded separately in the [capability matrix](docs/agentarts/capability-matrix.md). **The real GitHub → AgentArts → DSH → GitHub chain has not passed acceptance.** Cloud access is awaiting approval.

The final local AMD64 image from `25b2072` ran seven real DSH/DeepSeek cases; four actual repairs passed independent Docker checks and 3,852 hidden contracts. A [real PR in this repository](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/pull/1) also exercised defect/clean reviews, reuse across Controller processes, and stale-head refusal. This was a manually started local Runtime chain, not a GitHub Actions or Huawei cloud run. The test PR was closed without merging. [Results and reproduction](docs/agentarts/local-finish.md) preserve raw evidence, failed attempts, and independent AI review; human acceptance and costs remain unknown.

Native Ubuntu on both architectures still refuses proc mounting. Isolation was not weakened to pass. After approval, first check the target tenant against the [host requirements](docs/agentarts/host-requirements.md). The [compatibility audit](docs/agentarts/compatibility-audit.md) also lists remaining differences, including credentialed stdio/Plugin integrations; operation routing alone does not establish compatibility for every extension.

Repository files travel as a bound, checked workspace manifest. Runtime executes DSH inside a mandatory Linux filesystem/PID/user/network namespace; real credentials stay with trusted supervisors. Actual stopped-worker file changes return to the Controller, which retains independent Docker validation, validation-integrity checks and GitHub finalizers. A supervisor bridge supports scoped read-only, credentialed HTTP MCP tools; plaintext credentials in task extension definitions remain rejected. This bridge is separate from Huawei Gateway/MCP service acceptance.

Start with the [migration README](agentarts/README.md) and [deployment manual](docs/agentarts/deployment.md). The [workflow installer](agentarts/install.mjs) embeds the original templates with an explicit immutable AgentArts Action commit. See [Demo guide](docs/agentarts/demo-guide.md), [acceptance cases](docs/agentarts/evaluation.md) and [upstream maintenance](docs/agentarts/maintenance.md). Deployment requires the documented kernel, namespace and host policy checks.

Use `agentarts/action.yml` for this project. The inherited root Action and installer still target the original project and remain available as upstream reference/regression material; their complete introductions are archived under [docs/upstream](docs/upstream/README.md).

The original repository is unchanged. The shared history and `upstream` remain intact; the fixed upstream/DSH versions are in [upstream-lock.json](agentarts/upstream-lock.json). [MIT license](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md) and [bundled notices](BUNDLED_DEPENDENCIES.md) are preserved.
