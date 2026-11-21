# 2026-11-21：默认 Python、硬链接与 perf 修复说明

## 状态与原则

本次修改源码和本地验收逻辑，不把符号链接、复制、模拟计数或显式 `kxxy-py` 导入当作原问题通过。未安装 APK、未执行设备提权、未修改 SELinux/seccomp 或内核设置、未提交/推送 GitHub。

- 默认 Python：新增独立路由，使裸 `python` / `python3` 和 `pip` / `pip3` 通过已初始化的 glibc 环境运行。原生 `engine/bin/python*` 不变；原生自检仍使用绝对路径。
- 硬链接：`ln` 恢复 coreutils 原始语义，权限失败保持失败。`kxxy-rsync` 不再改写 `--link-dest` 或事后补软链，而是进行实际目录的原生能力检查，再原样执行 rsync。
- perf：保留两次 syscall 尝试的事件参数与 errno；不能从 `Permission denied` 或 paranoid=-1 单独归因为 SELinux/seccomp。计数器不可用仍失败。
- Root 探测：检查真实 `/system/bin/id -u`、退出码和完整的精确标记，不再相信 `echo uid=0`。Root 模式仍需要原有显式授权。

## 默认 Python 使用与限制

默认路由位于 `libexec/python-default/bin/`，在 `EngineConfig.buildEnv()` 中排在原生 `engine/bin` 前面。该目录不含 `su`、`shz` 或其他权限命令。路由用绝对路径原生解释器执行隔离控制脚本，然后进入 glibc；不会混合 bionic/manylinux 原生扩展。

默认启动不下载依赖、不解包 rootfs、不自动安装扩展。必须先显式初始化 glibc 扩展并预置 Python/ML 包。既有已正常的 glibc rootfs可复用，新启动器同时打包到运行时，避免升级后继续调用旧扩展的启动脚本。

```sh
python3 -c 'import sklearn, cv2; print(sklearn.__version__, cv2.__version__)'
python3 -m pip --version
# 原生 bionic 解释器仍可明确调用：
"$KXXY_ENGINE_ROOT/bin/python3" -c 'import sys; print(sys.executable)'
```

当前目录和应用/工作区路径通过明确绑定保持，不改写任意 Python 参数。guest 环境重建，清除宿主 LD_*、PYTHONHOME/PYTHONPATH；显式激活的原生 venv仍有 PATH 优先权。

默认 `python3 -m venv` 支持**新建目标**以及 `--copies`、`--without-pip`、`--system-site-packages`、`--prompt`。目标应有已存在的父目录。拒绝覆盖现有环境、`--clear`、`--upgrade`、`--upgrade-deps`、`--symlinks` 和从已激活 glibc venv再建嵌套环境。原生解释器的原有 venv操作不受这些路由限制。

生成的 glibc venv为宿主 Python/pip 名称提供启动器，内部保存 glibc 可执行并在 guest 中覆盖对应路径，以维持 `sys.prefix`、`sys.executable` 与子进程行为。不要移动已生成环境。任意 pip包的 console scripts不承诺可在宿主直接运行：应在 guest 内运行，或使用 `python3 -m <模块>`。受管 glibc venv内的 pip自身升级/移除、ensurepip等启动器维护不支持，避免覆盖宿主启动器；这不等于所有 pip操作与普通桌面 venv完全一致。

## 硬链接与备份

```sh
ln source destination
# 明确需要其他语义时自行选择：
ln -s source destination
cp source destination
```

旧 `KXXY_LN_STRATEGY=copy/symlink` 不再改变 `ln` 原始语义；`KXXY_LN_STRICT` 无需用来关闭自动降级，因为默认就不降级。

`KXXY_RSYNC_LINK_MODE=symlink` 已禁用：旧实现会恢复源中已删除/排除的文件，也会在 `--dry-run` 后写盘。不是安全的快照等价实现。

```sh
KXXY_RSYNC_LINK_STRICT=1 kxxy-rsync -a --link-dest=/absolute/base src/ dst/
```

严格探测需要实际存在且可写的基准/目标目录；探测只用自己新建的临时文件，检查 `st_dev/st_ino/st_nlink` 并清理。read-only basis、远端、目标不存在、dry-run和不认识的参数属于“未验证”，严格模式拒绝，普通模式仅说明风险并原样执行 rsync。通过目录探测不保证每个已有文件都能链接：文件权限、属性匹配和跨挂载仍需检查。裸 `rsync` 保留上游行为，可能在 link-dest失败后复制。

## perf 与设备权限边界

`perf stat` / `record` 仍直接调用 `perf_event_open`。诊断列出失败尝试的事件 type/config、目标 PID/CPU、attr flags、exclude_kernel与 errno 数字/名称/文本。未实现的 `stat -a` / `--all-cpus` 明确拒绝。

真正解除内核拒绝需要当前进程上下文和对应审计证据。应用 UID、Shizuku shell UID、Root UID、proot假 root均不保证 SELinux/seccomp 允许。glibc 的 `--link2symlink` 是兼容性模拟，不是硬链接；不要用 guest中的模拟结果验收原生能力。没有在本次修改中关闭 SELinux、移除 seccomp或修改 sysctl。

## 手动设备验收

将 `tools/probe-runtime-capabilities.py` 放到设备的独立脚本目录，在应用终端**继承原始 PATH/环境**，用绝对路径原生解释器启动。不要为了让测试通过自行将 `kxxy-py` 替代为默认命令，也不要在 glibc guest里启动原生能力探测。

```sh
"$KXXY_ENGINE_ROOT/bin/python" -I /path/to/probe-runtime-capabilities.py \
  --root "$KXXY_ENGINE_ROOT" --scratch-parent "$TMPDIR"
```

探针只在新建私有 scratch中写测试文件并清理，不读取会话凭证或真实项目文件。结果 JSON包括：

- UID/GID、上下文、Seccomp/NoNewPrivs、paranoid和 PATH等只读信息；
- 原生 `os.link`、coreutils ln、rsync link-dest：同设备/同 inode/非软链/link count与删源后存活；
- **裸 `python3`** 导入 sklearn/cv2并做最小回归拟合与图像 resize；
- 原生 Python 信息；
- perf原始 true命令和短 CPU负载的实际输出/退出码/计数与样本。

短 `record true` 可能合法产生零样本，单独记警告/未取样，不归因为权限拒绝；实际采样能力以 CPU负载产生真实样本为准。缺少必要工具或未验证的必要能力不会报告全绿。

## 本地验证范围

已生成独立候选运行时 `.cache/runtime-capabilities-20261121/runtime.zip`，954,163,810 字节、74,835 条目；完整结构校验通过，原生 Python 与提示钩子字节保持不变。它只是源码验证候选，**不是可单独安装的完整新版 APK**：需要同时带上更新后的原生配置/安装器。旧 `dist/Kxxy-0.9.75.apk` 未改动。

`verify-runtime.mjs` 的旧 zlib 文件名、pnpm脚本形态、Ruby内联注入断言曾导致候选首次校验失败。现改为跟随 SONAME 到实际 ELF、验证 ARM64 pnpm实体/执行位，以及检查 Ruby结果变量的真实注入；新增缺失/循环/截断/架构错误等负例测试后，完整校验通过。没有删除这些必要检查来假通过。

定向安装验证已通过：六个路由的 ZIP/source/manifest 内容、五条占位符字节级回填、六次执行位恢复调用，以及原生 Python 字节保持不变。保留输出位于 `.cache/sim-capabilities-20261121-final`。为避免额外展开整棵约 2.43 GB 的树，**未运行全量安装模拟**；Windows 只能核对权限元数据和 chmod 调用，不能验证 Android/POSIX 实际执行权限。安装模拟器已同步这些检查。

本地测试覆盖纯逻辑、模拟 syscall失败、Windows真实硬链接、构件/ZIP/安装合同与 Kotlin编译。Windows没有可用的 POSIX shell/native rsync，因此对应集成项明确跳过。没有把本地模拟或历史设备记录当成本轮真机结果。

原生 Python修复测试必须设置 `KXXY_PYTHON_DEPS` 指向 `tools/prebuilt/python-android-cp314/manifest.json`。旧 native健康检查和包 ABI合同均保留。运行时 patchset已同步到 `kxxy-patchset@33`；旧发行包不覆盖。完整新 APK及同版设备回归仍需另行构建/授权验收。

## 补遗（同日晚：真机验收发现的两处修复）

0.9.76 首个 APK（runtime `ef6e4fdc…`，@33）装到 Redmi K60 Pro 后真机验收发现：

1. **kxxy-rsync 能力探针在设备上裸崩**（`AttributeError: module 'os' has no attribute 'link'`）。
   原生 bionic Python 把 `os.link` 裁掉了，而本地测试全在 Windows 上跑（`os.link` 存在），
   模拟不到这个差异。修法：`_native_link()` 先走 `os.link`，AttributeError 时退到
   ctypes 直调 libc `link(2)`；兜底也不可用时报"能力不可用"，不抛裸异常。
   新增回归测试 `test_os_link_missing_bionic_fallback_reports_gracefully`。
   同目录探测逻辑不变；`probe_hardlinks` 失败时仍只清理自己建的临时文件。
2. **perf 增加 SELinux 域感知提示**。adb `run-as`（`u:r:runas_app` 域）实测
   `perf stat/record` 完全可用（stat 25,321,936 cycles；record+report 解出
   `_PyEval_EvalFrameDefault` 等符号），而 App 内（`u:r:untrusted_app_27` 域）全部
   EACCES——差异指向本 ROM 对应用域的策略限制。`policy_hint()` 在失败且能读到域时
   只陈述这组对照实测（不从 errno 单独断言具体策略），并给出 run-as 可用命令；
   读不到域（非 Linux 等）不出提示。

因此 patchset 升 `kxxy-patchset@34`（`build-runtime.mjs` / `RuntimeInstaller.kt` /
`test-runtime-capability-contracts.mjs` 三处同步），runtime 全量重建后打包含两处修复。
验收方法注意：run-as 域下 perf 可用**不能**当作 App 内可用的证据；App 内以现场
`perf list` 的 ✓/✗ 与 stat/record 输出为准。
