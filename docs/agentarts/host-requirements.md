# Runtime 宿主条件与 proc 挂载诊断

本页区分已观察到的拒绝、内核解释和部署决策。它不声明 AgentArts 云 Runtime 已兼容，也不把一个 Linux 版本号当作兼容证明。

## 当前结论

2026-10-07 的原生 Ubuntu 24.04 AMD64/ARM64 镜像 CI 已证明：当前生产 namespace 路线在这两类 runner 上不可用。默认 Docker AppArmor 策略先拒绝 bwrap 挂载；项目专用策略下推进到新 procfs 挂载后，仍返回 `EPERM`。固定 `subset=pid` 补丁已经进入镜像，不能把它描述成该宿主兼容修复。

WSL2 的固定生产镜像通过同一 namespace 探针及更完整的容器测试，外层仍有 Docker 的 `/proc` 遮罩、五项 capability、`no-new-privileges` 和指定 seccomp。该宿主未启用 AppArmor，不能用其结果证明 AppArmor enforce 下的部署通过。内核发行字符串不同，也不能单独证明差异来自某次内核升级。

| 证据                                                                                                                                                                             | 已确认事实                                                                                        | 不能推出的结论                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [原生双架构 CI 37581841343](https://github.com/Lixiaoyiao/Huawei-AgentArts-action/actions/runs/37581841343)，[归档](../../agentarts/evidence/full-v3/attempts/image-ci-86da6b0/) | 专用 AppArmor enforce；userns 可进入；bwrap 新 proc 挂载被拒绝；0 模型调用                        | 所有 Ubuntu 24.04 主机必定失败；或该拒绝必定来自 AppArmor    |
| [WSL 五 cap 镜像检查](../../agentarts/evidence/full-v3/fivecap-container-amd64/)                                                                                                 | kernel `6.18.40.1-microsoft-standard-WSL2`、Docker `29.8.2`；固定镜像完成十四项 v3 检查与隔离负例 | Linux ≥6.18 通用可用；原生 ARM、云或 AppArmor enforce 已通过 |
| 本轮 `diagnose-host.sh`                                                                                                                                                          | 采集固定镜像的实际 proc 挂载树、进程保护字段、Docker/runc 版本与选定内核返回值                    | 采集工作流为绿就代表 Runtime 可部署                          |

## 为什么不能只加 subset=pid

Linux 的 procfs 挂载会经过安全钩子和 `mount_too_revealing` 检查。所核对的 [Linux v6.8 namespace.c](https://github.com/torvalds/linux/blob/v6.8/fs/namespace.c#L4981)、[WSL 6.18.40.1 namespace.c](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.18.40.1/fs/namespace.c#L5794) 中，后者会检查父视图是否足够可见，包括继承的锁定子挂载；它可以独立返回 `EPERM`。这给出了与 Docker proc 遮罩相关的具体候选解释，尚不能替代目标宿主上的返回值证据。

上述 WSL 源码的 [proc_fill_super](https://github.com/microsoft/WSL2-Linux-Kernel/blob/linux-msft-wsl-6.18.40.1/fs/proc/root.c#L229) 仍设置 `SB_I_USERNS_VISIBLE`。因此不根据发行字符串或“支持 subset 选项”猜测已经豁免可见性检查。当前 `mountinfo` 也不暴露内部 `MNT_LOCKED` 标志；遮罩后 inode 的 `stat` 不能证明被遮住的原 inode 属性。

诊断中只有观察到 `mount_too_revealing return_value=1` 才能确认这一拒绝分支；安全钩子非零则是另一拒绝来源。没有命中、符号不可探测或内核跟踪不可用，都记为未知，不从空日志推断放行。

## 可复现的固定诊断

使用已在本机存在的不可变镜像 ID，并选择新的输出目录：

```sh
bash agentarts/diagnose-host.sh \
  sha256:<64位本地镜像ID> /absolute/new-evidence-directory
```

本脚本不拉镜像、不推送、不启动 Runtime/DSH、不执行仓库代码；容器无网络、无凭据挂载。Docker 客户端用空配置、关闭继承环境及固定本地 Unix socket。它保留现有五 cap、只读 rootfs、NNP、指定 seccomp 和 Docker 默认 masked/readonly paths。可选 `AGENTARTS_APPARMOR_PROFILE=agentarts-runtime-bwrap-v1` 只选择 operator 已加载的专用策略，不修改或替换它。

明确需要定位内核返回值时，加 `--kernel-trace`。此选项需要宿主非交互 sudo 及可用的 kprobe/tracefs，仅创建本次随机命名的 trace instance/events；必要时临时挂载自己的 tracefs。它不会修改 sysctl、LSM 或容器权限。先由固定进程的唯一 comm 映射初始内核 PID，再仅跟踪其后代 bwrap 的三个固定挂载函数返回值，避免把 Docker PID namespace 的编号误用于跟踪过滤。只导出函数名、整数返回值及 PID 元数据，不导出参数、文件访问内容、环境、kernel 地址或栈。机制见 [内核 kprobe 文档](https://www.kernel.org/doc/html/latest/trace/kprobetrace.html)。

`cleanup.json` 独立记录本次容器、events、instance 与临时 mount 清理结果；中断也只清理本次拥有的对象。`kernel-trace.json` 的 `armed` 表示配置完成，必须同时查看实际 `kernel-trace.txt` 是否有匹配记录。原始 `outcome.json` 和 `probe.jsonl` 记录探针成功或拒绝，不能把诊断完成状态代替探针状态。

独立手动工作流 [agentarts-host-diagnostics.yml](../../.github/workflows/agentarts-host-diagnostics.yml) 接受审核过的完整 commit SHA，在两个原生 runner 构建同源镜像；先记录默认策略，再记录专用策略。checkout 不保留凭据，工作流仅有 `contents: read`，不调用模型、云或 GitHub 业务发布接口。允许保留预期的拒绝结果，但检查结构化记录及清理是否完成。

## 部署放行与安全备选

继续采用当前镜像的前提，是目标宿主对**该不可变镜像、实际 LSM/seccomp/capability 和 masked paths 组合**通过固定 namespace 探针，再通过容器十四项业务/隔离检查及 installer/Session 检查。至少要实际证明 UID/GID10001、worker 无 capability、NNP、seccomp 生效、私有 PID/proc/网络命名空间、无系统 proc 条目/父进程，以及嵌套 namespace 被拒绝。声明配置和 `/ping` 可读不足以放行。

不加 `SYS_ADMIN`、`SYS_PTRACE` 或 privileged，不移除 masks，不绑定宿主 proc，不用 unconfined 或关闭全机 AppArmor 换取通过。当前原生 Ubuntu 24.04 CI 环境应标为**已知不支持当前路线**；其他宿主与 AgentArts 租户策略未测时标为**待验证**。

如果托管 Runtime 不允许这些等价边界，安全备选是另外评估专用 VM/独立任务沙箱承载 DSH，保留受信控制端、模型/工具凭据代理、原权限与独立验证，再由 AgentArts 负责实际可用的调度、Gateway 和观测。这会改变“DSH 直接由 AgentArts Runtime 托管”的部署关系，需明确设计及真实验收，不能称现有镜像已经在云兼容。若只在受控 Linux VM 上直接运行 supervisor 以避开两层容器的 proc 可见性冲突，也必须重新验证该部署的 filesystem/PID/network/LSM 边界，不能直接继承 WSL 结论。本轮未创建或实现这些备选部署。
