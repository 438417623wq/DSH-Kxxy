# 原生 Codex CLI 接入方案

> 当前状态（2026-11-11）：下方 2026-11-09 的“尚未实施/不包含 CLI”是历史设计记录，已被文末实施状态及 0.9.37/0.9.38 发行替代。当前采用固定 CLI 的 app-process 执行与 untrusted 审批；新增多协议兼容实现见 [模型兼容说明](codex-model-compatibility-2026-11-11.md)。旧隔离失败记录不代表当前构建未内置 CLI，也不证明 app-process 获得内核沙箱。

2026-11-09：这是原生 CLI 的实现方案和验收要求，尚未实施。正在构建的 Kxxy 0.9.36 修复模式选择、聊天续接和环境检查，**仍不包含原生 Codex CLI，不能称为完全体 Codex**。当前自定义工作区助手使用 HTTP 模型请求及应用提供的工具。

本轮关于“原生 CLI 以应用普通权限执行，并保留 CLI 审批”的选择尚未收到用户回复，因此没有启用该执行模式，也没有修改原生隔离检查。

## 已有能力与实际阻塞

插件已通过 `codex app-server --stdio` 的结构化 JSON-RPC 接口连接原生 CLI，包含初始化、模型目录、线程、轮次、工具事件、差异、审批和停止。接入完整 CLI 应复用该接口，不解析终端文本，也不将现有 HTTP 工具循环包装成原生 CLI。

此前记录的 Android 13 / ARM64 / kernel 5.15、`app.kxxy` 应用身份验证结果是：固定 Codex 0.167.0 可运行 `--version`，`app-server` 的 `initialize`、`account/read`、`model/list` 成功；当时账号为空，未发送模型任务。官方 bubblewrap 读取 `/proc/sys/kernel/overflowuid` 被拒绝；Landlock 回退返回 `filesystem-restricted execution requires bubblewrap to isolate app-server sockets`。记录见 [插件 README](../plugins/dsh-codex-sidebar/README.md)。

本轮在线 Android 13 / kernel 5.15 设备再次以 `run-as app.kxxy` 读取该 proc 路径，仍返回 `Permission denied`；当前设备运行时没有原生 Codex 二进制。已有 Node、Python、Git、编译器和 Shell 并不能证明 Linux 用户命名空间、bubblewrap 或 Landlock 可以在应用身份下使用。

`run-as` 使用应用 UID，不代表它与实际应用进程处于相同 SELinux 域。CLI 能在 `run-as` 下输出版本或启动协议，不能替代 APK 启动的真实应用进程、及其子进程在设备上的验收。后续必须记录实际进程的 UID 和 SELinux context，并通过应用内入口测试。

PROot 提供用户空间的 rootfs 和路径兼容，不能视为通过验证的工作区沙箱；不能据此假定 Android 的 SELinux、proc 读取限制或用户命名空间限制已解决。没有已验收的 PROot 原生 Codex 隔离方案，也没有将远程宿主替换为当前手机环境的授权。

## 固定版本及来源

本方案依据官方 `rust-v0.167.0`，不是根据最新文档猜测固定版本的字段。

- 官方 tag 指向 commit `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`；本地缓存的源码 tree 请求使用同一 commit。
- 目标：`aarch64-unknown-linux-musl`。
- 官方压缩包：114,300,898 字节，SHA-256 `843489acb4d4b1079745c36b03c5963b887b83155af208fd53584e33ee8eb281`。
- CLI：278,794,648 字节，ARM64 ELF、ET_EXEC，SHA-256 `2fe94d848540ff2a6868c7ebcc494126a974aa409711676d14fa0379e49e6143`。
- 已下载的 bubblewrap：ARM64 ELF、ET_EXEC，SHA-256 `0f543a7356ab343b4827222f910461d4196778f328b28acd6c126ef18e9557ab`；已有文件不代表其隔离能力通过验收。

官方来源：[发布 tag](https://github.com/openai/codex/tree/rust-v0.167.0)、[CLI 压缩包](https://github.com/openai/codex/releases/download/rust-v0.167.0/codex-aarch64-unknown-linux-musl.tar.gz)、[App Server 文档](https://developers.openai.com/codex/app-server/)。本地协议证据：[protocol.schema.json](../.cache/codex-native-probe-20261109/download-protocol/protocol.schema.json)、[config.schema.json](../.cache/codex-native-probe-20261109/download-protocol/config.schema.json)、[tree.json](../.cache/codex-native-probe-20261109/download-protocol/tree.json)。

## 自定义模型接入原生 CLI 的最小改动

保留现有 HTTP 助手，并在已有 `/thread/new` 增加明确的原生执行分支，例如 `engine: "native"`。原生绑定记录引擎、执行模式、provider ID、provider revision，以及当前会话的实际 cwd。不要复用 `source: "custom"` 作为原生标记，否则现有代码会继续走 HTTP 工具循环。

固定协议的 `ThreadStartParams` 和 `ThreadResumeParams` 支持 `model`、`modelProvider`、`config`、`cwd`、`approvalPolicy`、`approvalsReviewer`、`sandbox`。`TurnStartParams` 不支持 `modelProvider` 或 `config`；不能在发一轮消息时偷偷切换服务地址。

原生自定义 Responses 服务的服务器端请求形状如下，密钥不由前端回传，也不放入公开的线程绑定或日志：

```js
const providerKey = `kxxy_${provider.id}`
const providerConfig = {
  name: provider.name,
  base_url: provider.baseUrl,
  wire_api: 'responses',
  experimental_bearer_token: provider.apiKey,
  requires_openai_auth: false,
  supports_websockets: false,
  request_max_retries: 0,
  stream_max_retries: 0,
}

const start = {
  cwd: boundWorkspace,
  model: provider.model,
  modelProvider: providerKey,
  config: { [`model_providers.${providerKey}`]: providerConfig },
  approvalPolicy: 'untrusted',
  approvalsReviewer: 'user',
  sandbox: executionMode === 'workspace-write'
    ? 'workspace-write'
    : 'danger-full-access',
}
```

这只是待实现形状；`executionMode` 必须来自已确认、已绑定的服务器端执行选择，不能直接接受调用方任意字符串。隔离未通过时，`workspace-write` 继续拒绝执行。

固定版本的 ConfigManager 将请求 `config` 的 JSON 值转换为 TOML runtime overrides，支持上述点号 provider key。使用新的自定义 key，不能覆写内置 `openai` 的推理路由。官方配置接受 `env_key`，也接受用于程序化调用的 `experimental_bearer_token`，但建议优先使用环境密钥。这里用后者避免将多个用户模型密钥注入所有 CLI 子命令环境；实施前仍需验证运行时配置不会泄露到事件、配置读取或持久记录。

原生自定义服务不应因全局 OpenAI 账号为空而被拦截：`requires_openai_auth: false` 表示该 provider 使用自身凭据。原生自定义模型的实际 ID 不必出现在全局 OpenAI `model/list` 中；UI 可继续使用已保存的模型元数据，原生分支单独校验模型配置。

恢复原生自定义线程时，先检查绑定的 session/cwd/provider revision，再向 `thread/resume` 重带同一 `model`、`modelProvider` 和服务器端 `config`。`turn/start` 使用已绑定的模型、输入、推理强度和执行策略；应用权限模式的正式策略为 `sandboxPolicy: { type: 'dangerFullAccess' }`。切换 provider 或执行模式需创建新线程，沿用持久请求去重，不自动重发未知结果的请求。

固定 `WireApi` 只接受 `responses`。**Chat Completions 服务不能直接接入该原生版本**：应继续使用现有 HTTP 助手，或另行实现并验收 Responses 到 Chat Completions 的兼容桥。兼容桥还需处理原生工具协议、流式事件、工具结果、取消、错误、上下文压缩和历史，不能只改 URL。即使服务支持 `/responses`，也必须实际验证它接受原生 Codex 发出的工具及参数，才可认定开发任务可用。

## 应用权限执行与审批

应用权限模式使用官方 `danger-full-access` / `dangerFullAccess` 策略，意味着 CLI 按 Android 应用身份的普通权限运行，没有 Codex 的工作区操作系统沙箱。界面必须如实展示该边界，不能称它只允许访问工作区，也不能借此提权或关闭 SELinux。

保留 `approvalPolicy: 'untrusted'`、`approvalsReviewer: 'user'` 和已有审批接口。固定协议对 `untrusted` 的说明是：命令需要审批，除非明确的执行策略规则允许。**这不等于每次文件写入都询问，也不等于现有 HTTP 助手的逐条工具确认机制**。不能使用提示词承诺 CLI 不具备的强制权限行为。

父进程应使用当前应用真实环境的安全允许列表，同时保留独立 `CODEX_HOME`。Android 命令运行需要保留 `KXXY_ROOT`、`KXXY_ENGINE_ROOT`、`TERMUX__PREFIX`、`LD_PRELOAD`、库路径、Shell，以及 Git、Python 等实际运行时配置。固定版本的 Shell 环境默认继承父进程，因而安全处理应从原生子进程的父环境开始；不要直接继承任意账户密钥或任意 `NODE_OPTIONS`。

官方 musl CLI 是 Linux 目标，不具备本应用的 Android 专用路径假设。固定版本的 [shell_detect.rs](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/shell-command/src/shell_detect.rs) 从 passwd 读取用户 shell；无法选择时，Linux 分支优先通过 PATH 查找 `bash`，再尝试 `zsh`，最终回落到 `/bin/sh`。该默认发现流程不直接读取 `SHELL`。因此只设置 `SHELL=<应用>/bin/bash` 不足以证明适配：必须让应用运行时 `bin` 在真实 PATH 中可查找，核实 CLI 最终选择的可执行路径，避免 Android 不存在的 `/bin/sh` 回落。动态 Shell/工具所需的重定位环境仍须保留；静态 musl CLI 自身不能仅依赖 `LD_PRELOAD` 改写内置绝对路径。

## 打包和验收需要调整的文件

现有打包合同故意拒绝未验证的 CLI。启用应用权限路线需要新增明确的合同，不能将 `sandboxVerified` 改成 `true` 冒充隔离通过。

| 文件 | 当前合同 | 待实现的明确分支 |
| --- | --- | --- |
| `tools/lib/codex.mjs` | `attachCodexRuntime` 要求固定来源、`sandboxVerified: true`，同时包含 `codex` 与 `bwrap` | 增加独立的应用权限 manifest 验收，校验固定来源、二进制摘要、实际 app-server 可用性和 `executionMode`；保留原隔离合同 |
| `tools/build-runtime.mjs` | 通过 `KXXY_CODEX_RUNTIME_DIR` 装配，并写 `codexRuntimeIncluded` / version | 写入明确的执行模式和验收信息，包含固定 CLI；不要在构建时在线取不固定版本 |
| `tools/build-codex-apk.ps1` | 当前开发 APK 禁止任何 `codexRuntimeIncluded` | 增加独立、明确的原生发行路径，继续保留当前无 CLI 构建校验 |
| `tools/verify-codex-apk.py` | 强制不包含 CLI，且不得存在 `bin/codex` | 按明确发行模式验证 native ELF、摘要、版本、manifest 和来源，不能删除校验后直接打包 |
| `RuntimeInstaller.kt` | `codexRuntimeIncluded` 时同时要求 `codex` / `bwrap` | 按执行模式验证对应资产，应用权限模式不能被当成 sandboxVerified |
| 插件 `security.mjs` / `service.mjs` | 当前原生智能体必须通过真实工作区隔离探针 | 新增单独的应用权限能力与已确认执行选择；原隔离 gate 不变 |

建议 manifest 分别记录 `executionMode: "app-process"`、`appServerVerified`、设备验证证据和文件摘要，同时保持 `sandboxVerified: false`。这些字段是可审计的验收记录，运行时仍需核实实际资产及能力；仅填布尔值不是运行证明。

在实际手机的真实应用 SELinux 域中完成：固定 CLI 启动与 JSON-RPC 握手；实际 Shell 路径、Node/Python/Git 和开发命令；真实工作目录下的受控文件和命令任务；用户确认与拒绝；取消和超时；历史恢复及请求去重；独立账户数据；自定义 Responses provider 的完整工具往返。工作区沙箱路线还必须另外证明允许目录内写入、拒绝目录外写入及必要的进程/网络边界，不能以普通命令成功替代。

只有用户接受应用权限执行选择，并且原生任务与上述验收通过后，才应发布包含 CLI 的后续 APK。0.9.36 的模式、环境检查和浏览器测试，不能证明这些原生能力已完成。

## 实施状态（2026-11-10 更新）

用户已明确选择应用权限路线（见 `AI_HANDOFF.md`），上述方案已实施并交付 **0.9.37（versionCode 937000，未安装到设备）**。本节替代上文与权限决策相悖的旧表述；上文保留作为设计依据。

已实现：

- `service.mjs`：`engine: "native"` 原生分支（thread/start 带 `modelProvider`/`config`/`sandbox: 'danger-full-access'`；turn/start 按 `TurnStartParams` 合同剥离 `modelProvider`/`config` 并带 `sandboxPolicy: { type: 'dangerFullAccess' }`）；审批按 engine 分离 `nativeApp`/`agent` 能力门控；原生绑定校验、恢复、去重、密钥 scrub 与上文一致。
- 测试：`tools/test-codex-native.mjs` 11 项；全量 65/65 通过（旧 54 + 新 11）。
- 打包合同：`verify-codex-apk.py --native-app`、`verify-runtime.mjs` 原生块、`tools/lib/codex.mjs` app-process 分支、`RuntimeInstaller.kt` 按执行模式验证资产，均按上表“待实现的明确分支”落地。
- 设备级证据（`.cache/app-server-device-evidence.json`）：固定二进制在测试设备（Android 13 / arm64 / kernel 5.15.74）上以真实应用 UID 10398 运行，`initialize`/`account/read`/`model/list`/`command/exec`（应用 bash 5.3.20，dangerFullAccess）全部通过。**SELinux 边界已实测**：设备策略下 `untrusted_app_27` 无外部 entrypoint（shell_exec/toolbox_exec/app_data_file 的 entrypoint 均被拒），从外部无法进入应用域；应用域内的 manifest/UID/域/bash 校验由每次连接时的 `probeNativeApp` 在应用内强制执行（fail-closed）。未修改任何 SELinux 策略。

仍未完成（如实声明）：

- 真机安装与完整 UI 验收（原生连接、审批卡片、停止/断连、历史恢复、真实模型往返）；本轮仅协议级验证，未安装 0.9.37。
- Chat Completions → Responses 协议桥：chat 类自定义模型仍走旧 HTTP 助手。
- `acceptForSession`、execpolicy/network amendment 等持久授权决策未启用；`item/permissions/requestApproval` 明确拒绝。
