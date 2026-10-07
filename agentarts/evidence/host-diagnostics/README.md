# 固定宿主诊断原始记录

这些记录仅运行受信固定 namespace bootstrap；没有 Runtime 业务任务、DSH、真实模型、云调用或 GitHub 发布。所有目录由 Linux 输出逐字节复制，最终成功目录经 `diff -qr` 确认一致；原始输出未补改。

## 最终本地采集

[wsl-source-25b2072](wsl-source-25b2072/) 绑定本地镜像 `sha256:029bd4854f2c6aca3f33cad7d2536aa9537dfb4d33584a2e3b3a8095f8b04412`；镜像来源由构建方确认是 clean source `25b207246e37f282b51bad12ea0e88d7775ab888`。采集器当时为尚未提交的独立诊断文件，因此 `binding.json` 如实记录 `collectorSourceDirty:true`，执行文件哈希在 `inputs-sha256.txt`，不能改称干净提交内已有的工具。

- 原 namespace probe：passed。外层实际五 cap、NNP、seccomp 和 Docker proc masks 均可查。
- 跟踪：唯一诊断 comm 对应的初始 kernel PID 映射成功；随后只观察该 PID 的后代 bwrap。
- `mount_too_revealing` 五次返回均为 0；两个安全挂载钩子返回均为 0。此结果证明这次 WSL 固定挂载流程未被这些返回点拒绝，不解释其他内核或配置的行为。
- `cleanup.json`：passed，本次容器、event definitions、instance 与临时 tracefs 已清理。
- 版本、精确 image ID、bwrap 二进制 SHA、proc 挂载树与 namespace 元数据见各 JSON/TXT。没有从此目录推导 Linux 通用最低版本或云兼容结论。

## 保留的诊断工具迭代

| 目录                                                     | 实际结果与局限                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [wsl-invalid-filter](attempts/wsl-invalid-filter/)       | 首个工具版本误用了不存在的 ftrace `common_comm` 字段；在业务 probe 前失败，清理通过。不能作为 Runtime 失败记录。               |
| [wsl-comm-only-trace](attempts/wsl-comm-only-trace/)     | 固定 probe passed，返回值有记录，但只按 bwrap comm 过滤，未绑定单次进程；保留调试用途，不当作最终严格归因证据。                |
| [wsl-daemon-pid-filter](attempts/wsl-daemon-pid-filter/) | 固定 probe passed，但用 Docker top PID 设置过滤后没有事件；空跟踪不能证明内核放行。最终版本改为唯一 comm 映射初始 kernel PID。 |
| [wsl-image-unavailable](attempts/wsl-image-unavailable/) | 旧固定镜像已被构建方清理，inspect 失败关闭；未拉取、替换或启动镜像，清理通过。随后获授权才使用上述新固定镜像。                 |

前三个迭代使用旧 `469ce7fb...` 镜像，不能改写绑定到新镜像。

## 原生双架构最终诊断

- [native-37590968482](native-37590968482/)：source `a73516da305ec1f1b2a5e874fd1a08f2cd680636`，76 个原始 artifact 文件逐 SHA256 确认复制一致。
- [native-37592501345](native-37592501345/)：最后一次诊断，source `44b421127dcfa3f45956a64ebdc8e60fc7a0aaac`，80 个原始 artifact 文件逐 SHA256 确认复制一致。AMD64 镜像 `sha256:c945ec2ece066f4d8e82101410ee4976953d798f48ee7a30e2a5d958405108e3`；ARM64 镜像 `sha256:61912daf19bd2c6e611d67733712962b26abad031f5a647bf3d4afe804ded53b`；均原生执行、clean source。

两次实际均复现默认 AppArmor 拒绝 make-slave、专用 enforce 策略下拒绝 proc 挂载。最后两架构均 kernel `6.17.0-1022-azure`、Docker `28.0.4`、containerd `2.3.6`、runc `1.5.1`；后两者与 WSL 相同。外层实际五 cap、NNP、seccomp、proc masks 均保留。

最后新增的注册收据表明 BTF 存在，四个固定符号存在并列于 function tracer，但 kretprobe 注册仍 `EINVAL`，没有匹配本次命令的扩展错误，因此标 `not-recorded`/`unavailable`。四次诊断清理全部 passed。工作流 success 表示诊断与清理完成，**Runtime probe 实际 failed**。不能把空跟踪写成已经命中 `mount_too_revealing`，也不由符号存在推断注册应当成功。

精确内核分支保持未知，有限诊断到此结束。已确定的是当前两个原生 runner 不支持现有生产 namespace 路线；部署条件与安全备选见 [宿主说明](../../../docs/agentarts/host-requirements.md)。
