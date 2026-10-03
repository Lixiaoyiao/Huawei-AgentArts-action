# create-deepseek-harness-action

Create safe starter workflows for
[DeepSeek Harness Action](https://github.com/Lixiaoyiao/deepseek-harness-action).

```bash
npm create deepseek-harness-action@latest
```

The interactive installer offers **PR Review**, **@dsh Coding Commands**, or
**Both**, then lets you keep the compatible `controlled` DSH composition or
explicitly select `native`. For non-interactive use, select the workflow mode
explicitly; omitting `--dsh-mode` keeps `controlled`:

```bash
npm create deepseek-harness-action@latest -- --mode both
```

To generate native-mode workflows explicitly:

```bash
npm create deepseek-harness-action@latest -- --mode both --dsh-mode native
```

Valid workflow modes are `review`, `commands`, and `both`; valid DSH modes are
`controlled` and `native`. The installer creates only workflow files. It does
not add secrets, commit, push, or open a pull request. Existing workflow files
are never overwritten.

Installer 0.4.0 accepts explicit maintainer-selected write validation:

```bash
npm create deepseek-harness-action@latest -- --mode commands \
  --test-commands '[["node","trusted-tests.mjs"]]' \
  --container-image 'your-reviewed-image@sha256:<64 lowercase hex>'
```

Choose commands and their trusted sources yourself. No repository
scripts are discovered, executed or automatically trusted; no language or
package manager is assumed. Missing options keep the fail-closed placeholder.
Malformed/empty argv, workflow expressions, placeholders and mutable image
references are rejected. Installing these values still requires successful
Controller validation and fresh actor/repository/SHA authorization at runtime.
The installer reports credentials/scopes/quota, Docker/image availability and
repository validation as unchecked.

For an offline static check from a reviewed Action source checkout, use
`npm run check:config -- --config examples/config-check.json` as described in
[Setup](../../docs/setup.md#check-configuration-before-the-first-model-run).

Version `0.4.0` is prepared for the formal
[v0.9.2 Action release](https://github.com/Lixiaoyiao/deepseek-harness-action/releases/tag/v0.9.2)
at immutable commit `c184872f309ebfc5e57a0c5c1397c59e774709e0`. Its formal
[controlled/native release canary](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/37135372034) passed.
Installer source review, exact-source CI/tag, qualified tarball, npm publication
and fresh public consumers remain distinct gates. The Action identity alone
does not establish installer publication or consumer qualification.

The verified Action commit is supplied through `DSH_ACTION_RELEASE_SHA` at
pack time. Source templates retain a controlled build token; generated workflows
never use a candidate SHA, floating tag, or branch. Their audited exact DSH pin
is `0.2.0-rc.2`, with controlled as the default and native selected explicitly.
