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

Version `0.3.0` is prepared for v0.9.0 and is published only after the formal
Action tag, GitHub Release, and release canary agree. The verified immutable
Action commit is supplied through `DSH_ACTION_RELEASE_SHA` at pack time.
Generated workflows never use a candidate SHA, floating tag, or branch.
The fixed DSH migration candidate is `0.1.7-rc.2`; source preparation is not
evidence that release qualification or npm publication has completed.
