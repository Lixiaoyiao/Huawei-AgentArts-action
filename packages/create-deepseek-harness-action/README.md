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

Version `0.3.1` is prepared for the formal
[v0.9.1 Action release](https://github.com/Lixiaoyiao/deepseek-harness-action/releases/tag/v0.9.1)
at immutable commit `80cf46ee9098158ea664c45ea6371604c47b71e6`. Its formal
[controlled/native release canary](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/37107258024)
passed. The installer source, tests, source tag, packed artifact, npm publication,
and fresh public consumers remain separate qualification steps; this source
preparation does not claim npm publication has completed.

The verified Action commit is supplied through `DSH_ACTION_RELEASE_SHA` at
pack time. Source templates retain a controlled build token; generated workflows
never use a candidate SHA, floating tag, or branch. Their audited exact DSH pin
is `0.2.0-rc.2`, with controlled as the default and native selected explicitly.
