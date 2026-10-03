# DSH 0.2.0-rc.2 migration audit

Action v0.9.1 migrates the production DSH family from `0.1.7-rc.2` to the
published `0.2.0-rc.2` family. The Action's public input/output shapes, composition
defaults, and authority boundaries do not change. Workflows explicitly setting
`dsh-version` must update that exact pin to `0.2.0-rc.2`. This is a patch release;
upstream's own version change does not require an Action minor release.
Neither `0.2.1` alpha nor upstream `master` is a migration target.

## Official release and dependency identity

Checked on 2026-10-03 against the official release and npm registry:

- [DSH release dsh-v0.2.0-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)
  is an immutable upstream prerelease, published on 2026-09-29, whose tag
  resolves to `639ed015397290b3745d163aafe02ffee4aa3f84`.
- [Official CLI manifest](https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.0-rc.2)
  reports version `0.2.0-rc.2` and tarball integrity
  `sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==`.
- All 278 DSH entries in the lockfile resolve to `0.2.0-rc.2`. Their exact
  versions, tarball URLs, and integrity values, plus all five Cordis entries,
  were checked individually against the official exact-version manifests:
  **283 matches, zero mismatches**. Verification requested metadata only and
  downloaded no source archives or package tarballs.
- Installed base and headless patch SHA-256 values are respectively
  `9c2be64f46a193eff3cca190c26e697e8e8eee25c9b40149dfdb56f8142c252d`
  and `d0c99638f497c315e248ab63564fa27b4792c60506d6ab8f22c87018b64ab95d`.
  The headless patch is unchanged from the v0.9.0 dependency.

The coherent companion family remains:

| Package                              | Exact lock | Official constraint |
| ------------------------------------ | ---------- | ------------------- |
| `@deepseek-ai/cordis`                | `4.0.4`    | `~4.0.4`            |
| `@deepseek-ai/cordis-plugin-group`   | `1.0.4`    | `~1.0.4`            |
| `@deepseek-ai/cordis-plugin-include` | `1.0.9`    | `~1.0.9`            |
| `@deepseek-ai/cordis-plugin-loader`  | `1.0.5`    | `~1.0.5`            |
| `@deepseek-ai/cordis-plugin-timer`   | `1.1.6`    | `~1.1.6`            |
| `@deepseek-ai/cosmokit`              | `1.8.5`    | `~1.8.5`            |
| `@deepseek-ai/schemastery`           | `3.18.4`   | `~3.18.4`           |

Every directly imported DSH package has an exact direct pin. The remaining
graph has committed exact versions and integrity values. There is one Cordis
runtime identity, shared by the official Profile resolver and admitted
extensions. The worker still starts from its Profile mount. No peer override,
`--force`, `--legacy-peer-deps`, schema relaxation, or security-policy bypass
is part of this migration.

The upstream graph adds five DSH packages: `dsh-otel`,
`dsh-host-product-telemetry-otel`, `dsh-client-product-analytics`,
`dsh-client-ui-settings-session-log`, and `dsh-experimental-schedule-bundle`.
Installation does not activate their optional product compositions. The
six-package lifecycle-script inventory is unchanged; current versions and
lifecycle metadata were also compared with official manifests. The official
graph now pins Koffi to its tested `3.1.1` release.

## API and breaking-change review

The audit compared the exact cached `0.1.7-rc.2` npm packages with the installed
official `0.2.0-rc.2` JavaScript, declarations, and bundle patches. It covered
all 44 direct DSH packages plus the Agent loop, model adapters, credentials,
Session persistence, Skills, Plugin manager, user questions, and Workflow PTC
dependencies. Cached baseline packages were extracted locally; no repository
was cloned or source archive downloaded.

The [0.2.0-rc.1 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)
summarizes changes since `0.1.7-rc.2`; the
[0.2.0-rc.2 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)
adds subsequent fixes. Actual published API changes were checked independently
of those user-facing summaries.

### Contracts used by the Action

- **Profile and composition:** the public `loadProfile`,
  `createRuntimeResolution`, `PluginPackages`, `boot`, and `installFailLoud`
  declarations are unchanged. App-boot adds only the experimental schedule
  bundle to its optional-bundle list. The Action continues to compose base,
  headless, and explicitly admitted layers, rejects skipped admitted Bundles,
  and requires admitted Loader entries to activate before Agent execution.
- **Headless:** its JavaScript, declarations, and patch are byte-identical.
  The runner still accepts `task`, `sessionId`, and `json`, submits one text
  content block, waits for `agent.whenIdle()`, then flushes the owned Session.
  The Action still passes `--json -- <one literal task>` and exposes no Session
  adoption, resume, image, attachment, or Files input. JSON transport events
  continue to require strict Controller result validation.
- **Controlled and native tools:** Agent, Scope, Tools, authorization,
  permissions runtime, and user approval public APIs are unchanged. The
  controlled `ctx.tools.restrict`/`guard` policy still enforces the positive
  effective inventory and monotonic invocation limits. Native observation
  still samples `ctx.tools.schemas(agent)` and reports `observedTools`; it
  grants no controlled policy on native mode's behalf.
- **MCP, Plugin, Bundle, and Skill:** MCP client runtime/config, Plugin manager,
  Skill registry, filesystem Skills, and Office Skills are byte-identical.
  Admission, immutable package acquisition, environment isolation, startup
  failure handling, and controlled tool bindings retain their contracts.
- **Subagent, Workflow, and PTC:** the Subagent in-process driver and spawn,
  Workflow API, PTC runtime, and Node runtime are byte-identical. Workflow PTC's
  generated guest changes its intrinsic-constructor check to compare with the
  current engine's `Function.prototype.toString` representation. It changes no
  workflow arguments, JSON-schema subset, child limits, cancellation, or
  disposal API. Generated type metadata adds the optional late user-question
  reply source; it does not change Subagent execution authority.

These observations justify preserving the existing adapters and regression
contracts. Rewriting unchanged interfaces would add migration risk without
implementing an upstream requirement.

### Changed upstream behavior and unused breaking APIs

- **Session failure recovery:** Session adds `ToolCallRecovery`. AgentLoop now
  tracks missing tool results and records conservative error results before
  closing a failed step; the scheduler error still propagates. Results
  distinguish a call that never started from a started operation whose outcome
  is unknown. The latter advises checking side effects before retrying. The
  Action does not replay a task or treat synthetic recovery as authorization
  for a persistent write; Gateway reconciliation remains authoritative.
- **OTel composition:** base adds the shared `otel` transport provider and
  revises the Session telemetry endpoint, byte-bounded batching, and shutdown
  handling. Mounting `dsh-otel` alone creates no queue, identity, or network
  connection; its consumers create their own reporters. Both Action launchers
  continue explicitly disabling `session-telemetry-otel`,
  `session-log-deepseek`, and `plugin-package-inventory-deepseek`. The new Host
  product telemetry and Client analytics rows are not mounted by this headless
  composition. The upgrade therefore does not authorize another telemetry
  collector or Session/package inventory upload.
- **Web search credentials:** the published provider adds an optional
  account-token resolver for a Session using `deepseek-account`, and gives its
  `x-dsh-auth-token` precedence over API-key headers. The generated Action uses
  `deepseek-official`, a disposable home without account grants, and the same
  run-scoped Controller proxy credential. Real DeepSeek and GitHub credentials
  remain outside the worker. Existing mediated search retains the API-key
  route; anonymous fetch and MCP resource discovery remain disabled.
- **Files API breaking change:** `DeepSeekFileStore.invalidate` now takes a
  generation list plus connection; `DeepSeekUploadIndex.remove` takes a scope
  plus generation list. This atomically invalidates stale image mappings.
  These upstream APIs are unused by the Action's one-text-task Headless entry
  point. The proxy admits no Files route, so no adapter or public Action input
  change is required.
- **Other optional changes:** automation moves to an optional schedule Bundle;
  asynchronous user questions require explicit tool configuration. Neither is
  enabled by the Action migration. The pi-ai `0.87.1` catalog removes some old
  third-party model IDs, while the Action's existing `deepseek-official` /
  `deepseek-flash` selection is unchanged. Bash tool guidance now requires
  checking resolved delete/move paths. The built-in Windows sandbox can
  register an ACL diagnosis Skill; Linux Action execution does not select
  that platform path.

Controller / DSH / GitHubAuthorityGateway / validation layering remains intact.
Controlled remains the default and native requires explicit opt-in. Persistent
GitHub writes still pass authorization, validation, revalidation, and
reconciliation. Output budgets, cancellation, disposable runtime cleanup,
the non-executable Docker temporary mount, and the published
`NARB_DISABLE_NATIVE_CACHE=1` setting remain in force.

## Dependency validation and residual advisories

Audited strict-peer installation, a clean strict-peer `npm ci`, and
`npm ls --all --json` completed successfully. Normal updates within published
dependency constraints selected `brace-expansion@5.0.12`,
`ip-address@10.7.3`, and `undici@6.29.0`; no DSH pin or override changed to
obtain those updates.

The final dependency audit still **exits 1** with **15 findings: six moderate,
nine high, zero critical**. These include affected ancestors of two underlying
advisories:

- [fflate malformed ZIP64 denial of service](https://github.com/advisories/GHSA-px8p-9vwx-vf98):
  root `fflate@0.8.3` is fixed, but the official
  `@deepseek-ai/libreoffice-kit@0.1.5` graph requires exact `fflate@0.8.2`.
  The vulnerable nested copy remains installed through optional Office paths.
- [http-cache-semantics cached response disclosure](https://github.com/advisories/GHSA-ch52-4w7c-c8xp):
  the published OTel/Got graph contains `http-cache-semantics@4.2.0`, with no
  compatible newer published `4.x` version available at audit time. The
  generated headless Profile disables the telemetry consumers. The passive
  OTel provider does not construct a cache or request at mount time, and its
  event transport does not enable Got caching.

Default Profile reachability limits do not remove vulnerable installed
dependencies or make the audit clean. Trusted extensions that activate Office
or telemetry consumers need their own review. The exact upstream family is
preserved and these residual findings remain disclosed.

## Release qualification

Dependency identity and the API audit are complete. Full `npm run check`,
controlled/native targeted tests, Docker/native ecosystem smoke, candidate and
exact-main Core E2E, release canaries, and public installer qualification must
all complete on their required immutable SHAs before publication is reported
as complete. Their final run IDs and results are recorded by the v0.9.1 release
notes; this audit alone is not release qualification.

Headless remains text-only; resumable Sessions, attachments, Office processing,
product UI, optional automation, and asynchronous human questions are not new
Action capabilities. Custom model endpoints still need both the Messages task
route and the Chat Completions terminal-result formatter route. Host loss or
forced termination cannot guarantee process finalizers, so Controller cleanup
continues to own the deadline and disposable runtime boundary.
