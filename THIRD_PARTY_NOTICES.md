# Third-party notices

Parts of the GitHub integration architecture and selected utility code are
derived from [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)
at commit `dc33e8a15b19e2109ac3fa8329058842f63780dc`.

The v0.3 controller loop and its then-proposed extension design were also
reviewed against upstream commit
`d721746d683d812e669ce117cebe55a85fbd9c3e`. No Claude SDK, MCP server, plugin
runtime or session token implementation is bundled by that reference.

The v0.4 controlled-extension work continues to use those MIT-licensed GitHub
workflow trust patterns, but its MCP client, Profile, Bundle, Cordis, and
ToolRuntime integration uses DeepSeek Harness rather than Claude extension
runtime code.

The interoperability fixtures in `test/mcp-official.test.ts` and
`test/fixtures/mcp-server.mjs` are adapted from the DeepSeek Harness
`dsh-v0.1.0-rc.8` MCP client tests at commit
`141eb6fef83422698aef7a981029e843e8161534`, principally
`packages/mcp/mcp-client/tests/mcp-client.e2e.ts` and
`packages/mcp/mcp-client/tests/fixture-server.ts`.

The v0.9.0 runtime migration consumes the published DeepSeek Harness
`0.1.7-rc.2` package family at upstream release commit
`477b4f420553e8a52c2fbccc464d7561b239c443`. The worker runtime is installed from
the committed lockfile. Controller imports of DSH boot helpers and their
dependencies are separately included in the static NCC bundle and listed in
[`BUNDLED_DEPENDENCIES.md`](BUNDLED_DEPENDENCIES.md).
The exact dependency graph, upstream contract changes, and residual dependency
advisory are documented in
[`docs/dsh-0.1.7-rc.2-migration.md`](docs/dsh-0.1.7-rc.2-migration.md).

## AgentArts NCC dependency attribution adapter

The AgentArts bundles consume the locked DeepSeek Harness `0.2.0-rc.2` package
family. [`scripts/bundle-dsh-attribution.mjs`](scripts/bundle-dsh-attribution.mjs)
adapts only the relocated `@deepseek-ai/dsh-llm` self-version lookup used by
NCC `0.45.0`: its exact `createRequire(import.meta.url)("../package.json")`
call is replaced in generated output with the installed package's own version.
The pinned `lib/index.js` SHA256 is
`9132c8a8053ee82b9fb1ded4f98c85cf557f288a15a85c552c6b1fb319ead120`.
Package version, lockfile, complete module hash, AST call and NCC layout drift
are rejected. Padding retains source-map character and line positions.
The installed `node_modules` files are not changed; each adapted bundle records
the change in `bundle-adaptations.json`. This generated-code compatibility
adaptation does not change model selection, provider behavior or DSH permissions.

## Moby seccomp profile

The image separately builds **bubblewrap 0.8.0-2+deb12u1** from fixed Debian
sources, retaining Debian patches and adding the dated `subset=pid` procfs patch
in `agentarts/bubblewrap-proc-subset.patch`. Bubblewrap is LGPL-2.0-or-later; it
runs as a separate executable and does not change this project's MIT license.
Its complete corresponding upstream/Debian archives, descriptor, local patch,
license, Debian copyright and build script accompany the image in
`/usr/share/doc/bubblewrap/agentarts-source`. Source hashes and rebuild metadata
are retained in `agentarts/bubblewrap-source.json` and
`scripts/build-agentarts-bwrap.mjs`; the LGPL text is also retained in
[`agentarts/LICENSE.bubblewrap`](agentarts/LICENSE.bubblewrap).
Builder compilers are absent from Runtime.

The separately loaded `agentarts/apparmor-runtime.profile` also derives from the
Moby Docker default AppArmor template, pinned at
[`6430e49a55babd9b8f4d08e70ecb2b68900770fe`](https://github.com/moby/moby/blob/6430e49a55babd9b8f4d08e70ecb2b68900770fe/profiles/apparmor/template.go).
The original template is retained in `agentarts/apparmor-template.moby.txt`.
The independent profile permits namespace creation, sandbox mounting and two
fixed bubblewrap root pivots while preserving the other default rules.
Source and modifications are recorded in `agentarts/apparmor-source.json`;
the Apache 2.0 license is retained in `agentarts/LICENSE.moby-seccomp`.

The AgentArts container seccomp profile in
[`agentarts/seccomp-bwrap.json`](agentarts/seccomp-bwrap.json) is derived from
[`moby/profiles` default.json](https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json)
at commit `6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef`, licensed under Apache-2.0.
It adds permission for the six namespace setup syscalls required by the
unprivileged bubblewrap launcher. The DSH worker then receives a separate
project-authored BPF filter that rejects further namespace creation.
The upstream Apache license is retained in
[`agentarts/LICENSE.moby-seccomp`](agentarts/LICENSE.moby-seccomp).

## Claude Code Action

MIT License

Copyright (c) 2025 Anthropic, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## DeepSeek Harness MCP test fixtures

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
