# 0.9.44：升级时 Python 离线修复被判「用户文件冲突」导致启动失败

保存日期：2026-11-12，Asia/Shanghai。对应真机救援报告 `kxxy-rescue-1794498538477.txt`（versionName 0.9.43 / versionCode 937006，Xiaomi 25102RKBEC，Android 16）。

## 1. 现场

```
Engine state:
Failed: 同一条启动错误连续出现 6 次，重试已无意义：
Python 离线修复：用户文件冲突或内容已修改：kxxy-runtime.json
（既非期望内容，也不匹配显式 previousSha256）；保留原文件；不会自动清空或重装用户运行时

native-boot-failure:
{"phase":"install","exception":"Refused","reason":"Python 离线修复：用户文件冲突或内容已修改：kxxy-runtime.json…"}
```

失败在**安装阶段**（`RuntimeInstaller.install()` 的第一个动作 `pythonRuntimeRepair.repair(root)`），
引擎一次都没起来。`-- User data permissions --` 显示私有目录、`kxxy-home/storages`、
`.credentials.yaml` 全部 `owner=10577` 可访问，`.credentials.yaml.lock: ENOENT`
—— 也就是说这不是 2026-11-09 那批 `atomic-write` 写锁超时（那是历史，`CredentialsLockRecovery` 已覆盖），
目录权限、SELinux、存储（7.0 GiB 可用）都正常，问题只在 Python 修复的**前置判据**。

## 2. 根因

`kxxy-runtime.json` 是安装器写进 engine 根目录的**构建元数据**，不是用户内容。
`PythonRuntimeRepair` 把它当成「必须与 APK 逐字节一致」的受管文件，只允许两种状态：
目标摘要，或者一个显式的 `previousSha256`。

问题出在那个 `previousSha256` 是怎么算出来的。0.9.43 的运行时重建链路是：

```
0.9.41 修复前基线（host 3d6f2e90、无 python 标记）
      → restamp Codex 插件（指纹 95b5f044）         ← 中间产物，从未发布
      → repair-python-runtime.mjs 补 python 依赖    ← 0.9.43 的 runtime.zip
```

`repair-python-runtime.mjs` 把「补包之前那份清单」记作 previous，所以 previous = **上一步中间产物**的清单，
而不是任何用户手上真正装过的版本。实测三个真实版本与这两个值的对照：

| 设备上的版本 | kxxy-runtime.json sha256 | 结果 |
| --- | --- | --- |
| 0.9.38 | `4afae45b5c54…` | 不匹配 → Refused |
| 0.9.41 | `a1a2d7a65366…` | 不匹配 → Refused |
| 0.9.42 | `a8d7a064a5ff…` | 不匹配 → Refused |
| 中间产物（未发布） | `ce2792fb3764…` | previous 命中 |
| 0.9.43 目标 | `298520547281…` | expected 命中 |

也就是说 0.9.43 **只能装在「0.9.41 基线重封后的中间产物」上**，而这个状态没有任何设备会有。
所有真实升级（0.9.38/0.9.41/0.9.42 → 0.9.43）都会在安装阶段被 fail-closed 挡死。

这个字段本身根本不适合做字节绑定：0.9.42 与 0.9.43 的清单**只有两个字段不同**（实测）：

```
builtAt:                   2026-11-12T07:45:47.333Z → 2026-11-12T15:23:45.639Z
plugins.codexFingerprint:  67289b10…                → 95b5f044…
```

即「每次发布都会变」加「上游打包阶段（Codex restamp）会改」。用单值哈希表达迁移，必然在下一个版本复发。

## 3. 修法

### 设备侧：`PythonRuntimeRepair.supersededManifest()`

对 `kxxy-runtime.json` 这一条，把「字节等于某一个旧值」换成**结构判据**。盘上那份必须同时满足：

1. 能按本文件自带的严格 JSON 解析器解析成对象（不用 Android `JSONObject` 的宽松语法）；
2. 顶层字段全部在 `MANIFEST_KEYS` 白名单内（14 个，与 `tools/build-runtime.mjs` 同步）；
3. `schemaVersion == MANIFEST_SCHEMA`（当前 2）；
4. `arch == "aarch64"`；
5. `plugins` 的字段全部在 `MANIFEST_PLUGIN_KEYS` 白名单内（5 个）；
6. `plugins.hostFingerprint` 仍是本次的**基线或目标**宿主指纹 —— 谱系必须对得上。

满足就当作 `PREVIOUS`（可覆盖），不满足照旧 Refused 并零写入。安全性没有放宽：

- 其余 60 个受管文件（cffi/pycparser 全部文件、`_cffi_backend.so`、宿主插件五个文件、`.fingerprint`）
  仍然逐字节校验，包括 `previousSha256`；
- 「用户换掉了运行时」会先在 `.fingerprint` / 宿主文件上失败，走不到清单这一步；
- 用户手改过的清单（非 JSON、多了自己的字段、外来宿主指纹、未来 schema）继续被拒，**一个字节都不写**。

顺带把拒绝信息补全成 `盘上 <n> 字节，sha256 <前 12 位>`，下次救援报告能直接看出是哪个状态。

### 打包侧：`verify-python-repair.mjs` 新增 schema 合同

`verifyManifestSchemaContract()` 在出包时读 `PythonRuntimeRepair.kt`，核对
`MANIFEST_SCHEMA` 与运行时根清单的 `schemaVersion` 一致、`MANIFEST_KEYS`/`MANIFEST_PLUGIN_KEYS`
覆盖清单的全部字段。任何一边漏改都会在**构建时**失败，而不是等用户升级时被 fail-closed 挡在启动前。

## 4. 验证

- `tools/test-python-repair.mjs`：**112/112**（原 104 + 新增 8）。新增用例走的是真 Kotlin 代码（JVM 上编译 `PythonRuntimeRepair.kt`）：
  - 旧版清单（只有 builtAt/codexFingerprint 不同，基线谱系 / 目标谱系两种）→ 被覆盖，且回读 `isCurrent == true`；
  - 未知顶层字段、未知 plugins 字段、`schemaVersion: 3`、外来宿主指纹、不是 JSON 对象、纯文本 → 全部零写入拒绝，文件原样保留。
- `tools/test-python-runtime.mjs`：14/14（`KXXY_PYTHON_DEPS` 指向 `.cache/python-deps-4syqvzp_/manifest.json`）。
- 真实升级模拟（`.cache/simulate-upgrade-manifest-refusal.mjs`，用编译后的真 Kotlin 代码 + 真补包 + 真旧运行时树）：
  - 0.9.42 → 目标：`replaced=1`，只替换 `kxxy-runtime.json`；其余 60 个文件本就一致；`bin/node`、`extensions/`、`venv/`、site-packages 里的用户文件全部原样；
  - 0.9.41 / 0.9.38 → 目标：`replaced=61`，61 个受管文件全部补齐到目标摘要，用户数据未动。
- `node tools/verify-python-repair.mjs <runtime> <assets> <build.json>`：通过，新增 `manifestSchemaContract: {schema: 2, allowed: 14, allowedPlugins: 5}`。

## 5. 边界（说清楚，别夸大）

1. 未在真机安装 0.9.44。上面的证据是 JVM 上跑同一份 Kotlin + 真实运行时树/真实补包的模拟，
   不是设备验收。真机仍需「一键验收（含 Python）」确认。
2. 仍然只支持「宿主指纹 = 基线或目标」的增量。更老的运行时（宿主插件内容不同、`.fingerprint` 对不上）
   继续 Refused —— 这是 0.9.42 就定下的 fail-closed 边界，本轮没有放宽，也不该放宽（放宽等于允许
   覆盖未知的 site-packages）。
3. 修复只解决「清单被判用户冲突」。本次报告里 `dshmarket` 插件解析失败、DeepSeek 账号
   `403/no-response` 都是既有独立问题：前者是第三方插件包缺失的非致命告警，后者是网络/账号侧。
4. 没有改任何插件源码、协议、审批门控；Codex 插件指纹仍是 `95b5f044…`，运行时与 0.9.43 逐字节相同。

## 6. 复现与出包

```powershell
# 运行时不需要重封（Kotlin 修复不进 runtime.zip）
& tools\build-codex-apk.ps1 `
  -Runtime .cache\runtime-0.9.43\runtime.zip `
  -Backup .cache\codex-workspace-20261109-233052-f08c94a2 `
  -Version 0.9.44 -VersionCode 937007 -NativeApp
```

产物：`dist/Kxxy-0.9.44.apk`，1,961,399,542 字节（1,870.54 MiB），versionName 0.9.44 / versionCode 937007，
SHA256 `6daf0e0c7c8c504d334fe7c62a9b25aced550e938d9c9b3591e54d0b9b72857c`。
运行时逐字节复用 0.9.43（`ba0c54c6…`），插件指纹仍 `95b5f044…`。
已核对打包后的 `classes6.dex` 含 `supersededManifest` 与新的拒绝消息。

升级路径：设备装 0.9.44（同签名覆盖安装即可，不需要清数据，也不用先卸 0.9.43）。
