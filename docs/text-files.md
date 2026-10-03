# Text task files and explicit context

`prompt-file` loads a maintainer-selected task instruction file; `context-files`
adds explicitly selected text files as untrusted task data. Both use the existing
Controller prompt envelope in `controlled` and `native`. They do not implement
native image, PDF, or Office attachment support.

## Smallest runnable example

Commit `examples/prompts/repository-summary.md` and
`examples/context/release-checklist.txt` to your repository's default branch,
then copy [`examples/text-files.yml`](../examples/text-files.yml) to
`.github/workflows/dsh-text-files.yml`. Set the repository secret
`DEEPSEEK_API_KEY` and run the workflow manually. The example starts in
`controlled`; its dispatch selector can explicitly choose Docker-only `native`.
The sample task is read-only and never executes repository scripts.

```yaml
with:
  deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
  command: task
  prompt-file: examples/prompts/repository-summary.md
  context-files: '["examples/context/release-checklist.txt"]'
```

No checkout step is required to load these files. The Controller reads only the
explicit paths through GitHub's Git Database API, verifies regular Git modes,
SHA identities, blob content integrity and strict UTF-8, and passes text to DSH.
It never resolves a runner filesystem path or executes a file.

## Source, precedence and trust

- A non-empty `prompt` and `prompt-file` are mutually exclusive. `command: task`
  requires one of them; `command: auto` with a file on dispatch or schedule
  selects `task`, preserving the existing inline-prompt routing behavior.
- `prompt-file` always comes from the **same repository's default branch**.
  The Controller resolves its current head once, then reads at that immutable
  commit SHA. It does not accept an arbitrary ref, PR-head fallback, or runner
  checkout as a trusted instruction source. A configured `base-branch` does
  not change this source.
- An authorized interactive command retains its existing precedence: its parsed
  instruction body is used and the configured `prompt-file` is not read.
- `context-files` comes from the bound immutable PR head for PR tasks, or the
  task's immutable configured/default base-branch revision otherwise. It is
  included inside the existing **untrusted context** envelope. Content may
  describe a request, a log or a prompt injection, but cannot authorize a tool,
  change permission, supply trusted instructions or bypass validation.
- Selecting a prompt file explicitly promotes those default-branch bytes to
  operator task instructions. It does not make other repository files trusted
  or grant Controller authority. Maintainers must review and control this file.
  Keep the path literal in the workflow; never interpolate PR, issue, comment,
  attachment or log values into `prompt-file` or `context-files`. Inline `prompt`
  has the same control-plane provenance limitation after Actions interpolation.

The context packet records each file's repository, source commit SHA, path, blob
SHA and original byte size. The task identity includes file provenance so changed
text does not reuse an earlier task's deduplication identity. Credential values
are absent: a task file containing a configured Controller credential fails
closed; attached context uses the existing secret redaction and text sanitation.

## Bounds and diagnostics

Only `.txt`, `.md`, `.rst`, `.json`, `.yaml`, `.yml`, `.csv`, `.tsv` and `.log`
are supported. This is a deliberately small text allowlist, not arbitrary file
attachment handling. There are no globs or automatic file discovery.

Paths must be normalized repository-relative paths with `/` separators, at most
240 UTF-8 bytes and 16 segments. Absolute paths, backslashes, traversal, hidden
files/directories other than `.github`, `.git`, glob syntax, symlinks and
submodules are rejected. Parent directories are checked before reading a blob.
Secret-file extensions such as `.pem` and `.key`, `.env`, binary control bytes,
invalid UTF-8 and corrupt blob payloads fail closed.

The prompt file is at most 32 KiB. `context-files` accepts a JSON array of at most
8 distinct paths, each at most 32 KiB and together at most 64 KiB; combined file
input is at most 96 KiB. Missing paths, incompatible types, invalid encoding and
limits report the path and reason without logging its contents. Files are not
silently skipped or decoded with replacement characters. The existing final
prompt envelope may further bound task instructions and untrusted context to its
platform/argv budget and labels that truncation.

The offline configuration checker validates names, conflicts and path bounds. It
cannot establish remote file existence, content, branch access or online token
permission without GitHub requests; these checks remain explicitly unchecked
until the normal Controller context phase. Config checks do not start DSH,
execute repository code or modify GitHub.

# 文本任务文件与上下文

`prompt-file` 从当前仓库默认分支读取维护者明确选定的任务文件，并固定到
Controller 解析出的完整提交 SHA；它不会从 PR head 或 runner checkout 读取可信
指令。`context-files` 是显式 JSON 路径数组，来自任务绑定的 PR head 或基线提交，
始终进入不可信文本上下文。两种组合模式复用同一个信任边界，不支持原生图片或
Office 附件。

先将示例任务文件和上下文文件提交到默认分支，复制
[`examples/text-files.yml`](../examples/text-files.yml)，配置 `DEEPSEEK_API_KEY`
后手动运行。`prompt` 与 `prompt-file` 互斥；交互式命令已有的优先级不变。路径应由
维护者在工作流中固定，不能从 PR、Issue、日志或附件内容插值生成。可信任务文本
也不能改变工具权限、代替授权或绕过写入验证。

仅允许上表中的文本后缀；最多 8 个上下文文件，单文件 32 KiB，上下文合计 64 KiB，
任务文件加上下文合计 96 KiB。路径遍历、任意 runner 路径、符号链接、隐藏敏感文件、
缺失文件、非法 UTF-8 和超限均明确报错。离线配置检查无法确认远端文件内容和
GitHub 权限，相关检查会标明尚未检查；正式执行在启动模型前完成文件校验。
