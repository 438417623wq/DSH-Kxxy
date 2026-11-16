# Python 离线依赖修复 · 0.9.42

## 修复对象与根因

修复的是 **DSH Kxxy APP 内置的 Termux/Android arm64 Python**，没有修改 Windows 宿主的 Python 环境。

发布运行时中的版本与故障报告一致：Python 3.14.8、cryptography 50.0.2、NumPy 2.5.4、psutil 7.2.2。`cryptography` 的 Python 元数据要求 `cffi>=2.0.0`，而 deb 的 Depends 没有列出它。原 deb 的 `postinst` 会调用 pip 安装 CFFI；本项目只提取 deb 数据、不执行维护脚本，因此缺少 `cffi`、`_cffi_backend` 和 `pycparser`。已有 `libffi.so`，但它不是 Python 的 `_cffi_backend`。

本次保持原有 Python、cryptography、NumPy 和 psutil 版本，补入：

| 依赖 | 版本 | 来源 |
|---|---|---|
| cffi | 2.0.0 | PyPI 官方 sdist，NDK 交叉编译 Android 后端 |
| pycparser | 2.23 | PyPI 官方 `py3-none-any` wheel |

CFFI 源码 SHA256：`44d1b5909021139fe36001ae048dbdde8214afa20200eda0f64c068cac5d5529`。

CFFI Android wheel SHA256：`5c9097c22274525f02b8f4519e84a79144abf1374965f1bba5d416b0197dfaaa`。

后端 SHA256：`9cd107a6d6b67dd0d080a011ce97cc94eda15955682d7329ace1ac7c704bd883`。

pycparser wheel SHA256：`e5c6e8d3fbad53479cab09ac03729e0a9faf2bee3db8208a550daf5af81a5934`。

## Android 原生构件

- NDK 28.2.13676358，target `aarch64-linux-android24`。
- 使用同一发布运行时的 Python/libffi 头和共享库；289 项原始输入摘要记录在构建 manifest 的 `runtimeInputs`。
- SOABI：`cpython-314-aarch64-linux-android`；不是 manylinux、Windows 或其它 Python ABI 的二进制。
- ELF64/AArch64、Android API 24 note、16 KiB LOAD 对齐、RELRO/NOW、`PyInit__cffi_backend` 导出通过。
- 新后端无 RPATH；依赖 `libffi.so`、`libpython3.14.so`、`libdl.so`、`libc.so`。
- 后端 229 个强未定义符号及递归库闭包均匹配目标库与 API 24 导出。
- 两次独立构建（第二次离线）的后端、CFFI wheel 和 pycparser wheel 逐字节一致。

这些是**交叉编译、符号与产物检查**，不代表已在手机应用域中成功执行。

## 打包与升级

### 防止再漏依赖

- `tools/build-python-deps.py` 固定官方来源、下载摘要、目标 ABI、符号闭包和 wheel RECORD。
- `tools/lib/python-runtime.mjs` 装配依赖并验证受管文件、元数据、RECORD、编译输入和动态库闭包。
- 全量 `tools/build-runtime.mjs` 默认读取 `tools/prebuilt/python-android-cp314/manifest.json` 及两个固定 wheel；也可通过 `--python-deps <manifest.json>`（或 `KXXY_PYTHON_DEPS`）指定。构件缺失或与 stage 不匹配时明确失败，不依赖可被清理的 `.cache`。
- `tools/fetch-runtime.mjs` 在索引缺包或最终下载不完整时失败，不再发布残缺的 manifest。
- `tools/verify-runtime.mjs` 增加 Python 专项门控，旧的缺 CFFI 运行时将不再通过。

### 当前版本的增量修复

`tools/repair-python-runtime.mjs` 从 0.9.41 基线增量生成运行时，不回退 Codex/UI，也不重压无关大文件。

APK 内另带 `python-repair/manifest.json` 和 `payload.zip`。当前 payload **472,108 字节，61 个文件**，包括 CFFI/pycparser、自检、两处提示文案及清单/指纹。

`PythonRuntimeRepair` 在已有运行时的完整性快路径之前执行：

1. 校验 APK 元数据绑定的 manifest SHA256、payload SHA256、版本/ABI/路径白名单。
2. 预检全部目标；仅允许缺失文件、已是预期内容，或匹配显式旧摘要的文件。
3. 私有目录暂存并逐个验证，再逐文件原子替换；根清单和宿主指纹最后提交。
4. 中断后可重试；二次运行无写入、不重新读取 payload。

**不会删除用户包、venv、extensions 或整个 `lib`。** 内容冲突和非匹配宿主基线会明确拒绝，不自动退回清空重装。当前小补丁适用的宿主基线指纹为 `3d6f2e90e3f9c31098e8f372f9c7e4f0e37d273e7e21e755468ff2d4cf83eb60`，目标为 `37669ee7459245b93e2478931a2f9ccf5614a8c8a50bc47ccc884b72c19fa308`。未知旧版本不能当作已验证的升级路径。

## 应用内验收

维护区按钮为 **“一键验收（含 Python）”**。保留既有七项，追加：

- 解释器实际路径、prefix、SOABI、隔离参数和模块来源。
- CFFI 的 `cdef/new/buffer`，不只测试 import。
- AES-GCM 加解密往返及篡改密文触发 `InvalidTag`。
- OpenSSL 初始化与 SHA-256 已知样本。
- NumPy 向量、矩阵乘法与线性方程求解。
- psutil 读取本进程 PID/RSS。
- 同解释器 `pip check`、实际 supported tags 和 WHEEL 标签。

固定调用引擎 `bin/python3 -I -B`，不使用 PATH 上的其他 Python，不安装依赖。Python 检查共用 8 秒预算，pip 子预算至多 4 秒；每流输出上限 64 KiB。

### NumPy / psutil 的告警

保留原始 `android_aarch64` WHEEL 标签，**不修改 pip 或伪造兼容标签消警**。只有实际功能测试成功、解释器/ABI 对应的 Android supported tags 有证据、且 pip 没有其它错误时才报告为告警；未知依赖错误或功能失败仍报告失败。

因此，本次修复后原始 `pip check` 仍可能因这两个旧标签返回 1。不能将“CFFI 依赖链已补齐”写成“所有 pip 告警消失”。

## 回归记录

- CFFI 构建专项：16 通过。
- Python 装配/归档：14 通过。
- 自检集成：102 通过。
- Python 自检与探针故障注入：83 通过。
- 真实 Kotlin 修复 helper：104 通过，另有 installer 接入守卫通过。
- 最终 61 文件真实候选合同：旧摘要绑定、升级内容、用户文件保留、二次零写及全新内容完整性通过。
- 新运行时结构与 Python 专项：通过。
- 全量安装模拟完成，52 个 Python 文件在占位符/别名处理后摘要全部一致；**模拟器整体返回 1，另有 2 条既存静态断言失败**。`ensureNoShadowingStubs` / `ensureEmacsSiteLoad` 的旧断言要求各两处调用，但修改前后源码都已统一到 `maintainAfterHealthy`，并由 `EngineSupervisor` 在 Healthy 后调度。本次未修改这两条非 Python 断言，也未将整体模拟器记为通过。

第一次完整验证发现 `.cache/build-meta.json` 的宿主指纹仍旧，已修复增量脚本同时更新两份 metadata，随后完整验证通过。失败日志保留，不隐藏该过程。

日志目录：`.cache/python-validation-0.9.42/`。新运行时：`.cache/runtime-0.9.42/runtime.zip`。

## 复现示例

用实际本机解释器/工具路径替换 `python`、`node` 和 NDK 参数；不是在手机上执行 pip install：

```text
python -I tools/build-python-deps.py --runtime <基线runtime.zip> --ndk <Android NDK目录> --out-parent .cache
node tools/repair-python-runtime.mjs --in <基线runtime.zip> --out <新runtime.zip> --python-deps <构件manifest.json> --meta android/app/src/main/assets/meta/build.json --assets android/app/src/main/assets/python-repair
node tools/verify-runtime.mjs <新runtime.zip>
node tools/verify-python-repair.mjs <新runtime.zip> android/app/src/main/assets/python-repair android/app/src/main/assets/meta/build.json
```

新构建的全量 runtime 使用同一依赖模块；新版本/新 Python 不能复用不匹配的编译输入，必须重新构建并复核固定合同。

## 最终产物

- APK：`dist/Kxxy-0.9.42.apk`，**1,961,395,446 字节**；versionName **0.9.42** / versionCode **937005**，arm64-v8a。
- SHA256：`8b14ae1e09517e25f61217ddca35855bf7f5b058e37b8bbaf0ddcff9dd02b566`（同目录 `.sha256`）。
- runtime SHA256：`b8bdc326ec0e86e8123e2b026a2418dc45d8f649f78cea16062304a44cd964a5`，916,245,292 字节 / 61,133 条目。
- 构建结果：Gradle `BUILD SUCCESSFUL in 14m 20s`；对齐、固定证书签名、原生/宿主资产与版本检查通过。较长耗时已用线程快照定位为 Gradle 对旧大输出目录的摘要扫描，不是 Python 编译阻塞。
- `dist/Kxxy-0.9.42-verification.json`：原有 Codex/运行时/24 扩展池合同通过。
- `dist/Kxxy-0.9.42-python-verification.json`：APK 内 Python 小补丁、运行时摘要、全部 61 文件、五份自检/提示源码以及编入 dex 的 `PythonRuntimeRepair`/`RuntimeInstaller` 均通过。
- 保留旧 0.9.41 APK 和修复前备份；下次 versionCode 必须大于 **937005**。

## 验证边界

未连接历史手机、未安装 APK、未调用真实模型账号、未提交或推送。Windows 上的协议/模拟测试及 JVM 安装测试不能替代 Android 应用权限下的真实加密、加载与升级验收。用户在目标手机升级后可运行一键验收并复制结果确认。
