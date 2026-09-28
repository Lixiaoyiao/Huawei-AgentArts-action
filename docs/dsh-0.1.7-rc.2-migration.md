# DSH 0.1.7-rc.2 migration audit

This records the fixed runtime candidate for Action v0.9.0. Installing the
candidate is not a compatibility or release qualification result. The exact
candidate Action SHA still needs the repository's complete local, trusted
Core E2E, post-merge, and release-canary gates. Existing v0.8.2 tags and releases
remain immutable. This audit does not track upstream `master` or a moving npm
dist-tag.

## Official release and package identity

Checked on 2026-09-28 against the official npm registry and upstream release:

- [DSH release dsh-v0.1.7-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)
  resolves to `477b4f420553e8a52c2fbccc464d7561b239c443`.
- [Official CLI registry manifest](https://registry.npmjs.org/@deepseek-ai%2fdsh/0.1.7-rc.2)
  reports the npm publication at `2026-09-24T14:18:11.337Z` and CLI tarball
  integrity
  `sha512-SQFhriLvza8GnFApnC5/32AgpcyKxrWnYXhvwDOLJdgWpkCX2EexyR9c8kCkMITJXnFLEN3Qb2CEh0W36vkLyw==`.
- All 273 installed `@deepseek-ai/dsh*` entries have version `0.1.7-rc.2`.
  Their lockfile versions, tarball URLs, and integrity values were compared
  individually with the exact-version official registry manifests; all match.
- The installed base and headless patches are byte-identical to the files at
  the fixed upstream tag. Their SHA-256 values are respectively
  `861414459d7f60af5421ac7a9735a7c0d80b52a2369623b8cda3ce6079c733b4` and
  `d0c99638f497c315e248ab63564fa27b4792c60506d6ab8f22c87018b64ab95d`.

The exact non-DSH companions selected by the official dependency and peer graph
are:

| Package                              | Locked version | Candidate's requirement |
| ------------------------------------ | -------------- | ----------------------- |
| `@deepseek-ai/cordis`                | `4.0.4`        | `~4.0.4`                |
| `@deepseek-ai/cordis-plugin-group`   | `1.0.4`        | `~1.0.4`                |
| `@deepseek-ai/cordis-plugin-include` | `1.0.9`        | `~1.0.9`                |
| `@deepseek-ai/cordis-plugin-loader`  | `1.0.5`        | `~1.0.5`                |
| `@deepseek-ai/cordis-plugin-timer`   | `1.1.6`        | `~1.1.6`                |
| `@deepseek-ai/cosmokit`              | `1.8.5`        | `~1.8.5`                |
| `@deepseek-ai/schemastery`           | `3.18.4`       | `~3.18.4`               |

There is one Cordis runtime. The Action directly pins Cordis and group, directly
pins every imported DSH package, and commits exact resolved versions and
integrities for the remaining graph in `package-lock.json`.

The official runtime resolver prefers Profile-local packages. Both Docker
worker entrypoints therefore run from the Profile mount so their installation
anchor and extension imports resolve to the same Cordis module identity.
Bundle and Plugin fixtures assert that their Context is an instance of that
same imported Cordis Context; Docker CI must also prove this configuration.

`@deepseek-ai/dsh-code-runtime@0.1.7-rc.2` does not exist: the old package's
published line ends at `0.1.5-rc.3`. The candidate's own base and tools manifests
instead use `@deepseek-ai/dsh-ptc-runtime-node` and
`@deepseek-ai/dsh-ptc-runtime`. The direct inventory follows that official
replacement. It does not mix an old code-runtime package into the new graph.

## Changed upstream contracts to qualify

The fixed-tag [architecture](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/docs/architecture.md),
[Agent lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/docs/agent-lifecycle.md),
[tool execution pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/docs/tool-execution-pipeline.md),
[base bundle](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/packages/bundle/base/README.md),
and [headless contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/packages/bundle/headless/README.md)
were checked against installed JavaScript and declaration files.

- Headless supports stdin, an optional NDJSON projection, and Session adoption.
  The Action continues to submit one text task and use run-scoped Session
  state. It exposes no public resume or attachment input. A syntactically valid
  NDJSON `final` event is not a valid Controller business result; exit status,
  strict result schema, operation binding, and business validation all remain
  necessary. The upstream final answer is not byte-capped, so Controller
  output bounds remain necessary.
- Headless creates or adopts an Agent through the new Session/Agent lifecycle,
  waits for quiescence, and flushes its owned durable event interval. New
  lifecycle and tool-content APIs must be used without replaying a task during
  terminal-result formatting repair.
- The base `llm-deepseek` row now mounts the API-key adapter; account-funded
  access has a separate row. Controller proxy routing must still carry only a
  run-scoped worker credential, never the real API key or GitHub token.
  The official default selection remains `deepseek-official`, with the new
  Messages model ID `deepseek-flash` replacing `deepseek-v4-flash`. The Action
  consumes that published selection without adding a new model input.
- PTC uses the published `ptc-runtime` contract and Node runtime. Controlled
  tools remain subject to the Controller's positive effective inventory and
  monotonic invocation guard. Native inventory is DSH-owned observation.
- The base no longer mounts `str_replace_editor` automatically. The controlled
  Profile explicitly mounts the published tool when `workspace.edit` is
  effective, preserving the existing canonical capability and tool rules.
- Upstream can skip incompatible Bundles and warn about optional startup
  failures. The launchers reject skipped admitted Bundles and use the official
  settled Loader entries to require admitted extensions to be active before
  Agent execution. Real Bundle and Plugin startup-failure regressions require
  a failing process and zero additional model requests. This checks startup,
  not native tool grants or a replacement plugin framework.

The model adapter now calls Messages through the run-scoped proxy. The public
Action base URL `https://api.deepseek.com` (and its existing `/v1` alias) maps to
DeepSeek's `/anthropic/v1/messages` endpoint. A custom base URL supplies the
root for `/v1/messages`; the proxy admits only that exact worker Messages
route. It replaces both authentication header forms with Controller-owned
credentials, drops user/session attribution headers, rejects redirects, and
does not enable Files or model-discovery endpoints. The sole forwarded beta
header is the candidate's published dynamic-tools beta.

The existing one-shot terminal-result formatter remains on Chat Completions
through the same Controller proxy. Therefore, a custom endpoint must support
both the Messages model route and Chat Completions result-formatting route.
The formatter receives only the bounded previous result and strict output
contract; it has no tool catalog or execution hook and cannot replay the task,
change a known operation/state, or produce a dispatchable tool request.

## New defaults and data-flow review

The published CLI brings a broader optional ecosystem into the install graph.
Package presence alone does not enable a feature in the generated Action
Profile. In particular, the shared base/headless patches do not mount Web UI,
Office conversion, Agent Teams, a Browser/Computer Use service, or a listening
HTTP server. The Action must not select those additional compositions as a
side effect of this migration.

The candidate's base has three independent outbound contributions that the
Action launchers explicitly disable after applying Profile layers:

| Base row                            | Published behavior                                                                                    | Required Action treatment                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `session-telemetry-otel`            | Feedback can release a canonical Session prefix to the OTel endpoint; default mode is `FEEDBACK_ONLY` | Disable the row; ordinary model use must not enable a separate collector |
| `session-log-deepseek`              | Enabled by default; adds `dsh_session_log` to official DeepSeek requests                              | Disable the row; no additional Session-log upload                        |
| `plugin-package-inventory-deepseek` | Enabled by default; adds `dsh_plugin_packages` to requests                                            | Disable the row; no additional package inventory disclosure              |

The OTel environment switch is implemented by the CLI launch path. Because the
Action consumes the public app-boot API directly, an environment variable alone
is insufficient evidence for these three independent paths. The generated
profiles and runtime tests must verify their actual configuration.

The headless default writes reasoning deltas to stderr, but both Action launchers
explicitly select `--json`; committed reasoning is bounded transport telemetry
and is not the business result. Controller output budgets and secret checks
still cover the complete stdout/stderr transport. Both compositions disable
the new anonymous `web_fetch` provider and the new `mcp-resources` row: otherwise
an admitted MCP server would also register `list_mcp_resources`, expanding the
previous tool surface. Existing mediated Web Search and admitted MCP tool calls
remain available. Plugin-manager tools are disabled in the published base; the
Action does not provide the product `profileContext` that enables the manager.
Installation remains a separate maintainer-controlled acquisition step.

The account adapter registers a separate provider, but a fresh managed home
contains no account grant; the account service reads its credential record at
startup without making an account request. The credentials provider consults
the explicit launch-environment snapshot: because the launcher supplies only
the sanitized process layer, project/home dotenv fallback layers are absent.
The Controller proxy also removes the adapter's user/session attribution
headers. These observations apply to the Action's generated profile; trusted
extension code still requires separate review.

The new Session projection cache uses the JSON storage domain under
`$DSH_HOME/storages/session_projcache/sessions`. Docker keeps the home and
installed Profile read-only, with writable `action-state`, `sessions`,
`attachments`, and `storages` subdirectories inside the same disposable runtime
root. The storage mount is necessary for existing one-shot Agent lifecycle,
not a cross-run persistence product. Root disposal releases runtime services;
the Controller's deadline/cancellation path remains authoritative and removes
the Docker process/network and disposable runtime. Its runtime cleanup deletes
the parent containing every new storage directory. Host loss or forced process
termination still cannot guarantee finalizers.

Lockfile lifecycle-script comparison found no newly introduced install-script
package relative to the previous lock. The existing platform/native helpers
still require review as executable dependencies; this observation does not
make acquisition offline or third-party extension code sandboxed.

## Dependency verification and residual advisory

The following commands completed with peer validation and audit enabled:

```text
npm install --strict-peer-deps --registry=https://registry.npmjs.org/   exit 0
npm ci --strict-peer-deps --registry=https://registry.npmjs.org/        exit 0
npm ls --all --json                                                 exit 0
```

The initial reused lock reported 15 audit findings (13 moderate, two high).
Normal updates within published dependency constraints repaired the high
findings and other fixable advisories: `fast-uri` is `3.1.8`, `js-yaml` is
`4.3.2`, `hono` is `4.13.9`, and `qs` is `6.16.0`. The exact Vitest and
coverage pair is `4.1.11`. No DSH candidate version changed, no override was
added, and no peer-resolution or audit bypass flag was used.

This describes migration dependency resolution and qualification. The existing
run-scoped Controller runtime acquisition retains its `--no-audit` option to
avoid a separate registry advisory request with the installed-package inventory
on every Agent runtime setup. It does not replace the explicit audited
maintainer installation or CI evidence above, and must not be interpreted as a
clean vulnerability result.

The final `npm audit --json --registry=https://registry.npmjs.org/` still
**exits 1**, reporting **eight moderate, zero high, and zero critical** findings.
These are one underlying [fflate ZIP64 denial-of-service advisory](https://github.com/advisories/GHSA-px8p-9vwx-vf98)
plus its seven affected ancestor packages:

```text
@deepseek-ai/dsh
  -> @deepseek-ai/dsh-skill-office
     -> @deepseek-ai/libreoffice-kit@0.1.2
        -> fflate@0.8.2
```

The alternative Office conversion path runs through `dsh-web-app` and
`dsh-office-to-pdf`; `dsh-sdk-app` and `dsh-sdk-minimal` are also reported as
affected ancestors. The official `libreoffice-kit@0.1.2` manifest requires
exactly `fflate: "0.8.2"`; it cannot consume fixed `0.8.3` without changing the
published graph. This is an upstream dependency defect, not a missing DSH
publication or a successful audit. The Action does not mount those Office
providers in its default controlled/native headless profiles and adds no
document/image entry point in this release. That limits default reachability;
it does not remove the installed vulnerable package or justify representing
the audit as clean. A trusted custom extension that loads Office code requires
its own review. The selected DSH candidate remains fixed while this residual
finding is disclosed.

Complete `npm run check`, latest-SHA Core E2E, formal release smoke, and
installer-consumer evidence are recorded separately by the release workflow;
dependency installation and static graph verification do not substitute for
those gates.

Targeted migration checks include the real stdio/Streamable HTTP MCP tests
(discovery, invocation, timeout, and crash behavior), three upstream
`--dump-config` overlay validations, and the official Node PTC integration
fixture. The PTC fixture records real child PIDs and checks their exit after
normal completion, output-budget failure, a non-cooperative loop timeout,
explicit abort, and owner disposal. It also checks that the executed program
receives no environment keys. These local checks supplement the required
trusted Docker and live-provider evidence; they do not qualify an unfrozen SHA.
