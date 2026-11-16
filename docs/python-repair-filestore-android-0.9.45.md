# 0.9.45：真机安装阶段 `Python 离线修复：getFileStore`

真机救援报告 `kxxy-rescue-1794501268971.txt`（BuildMeta 0.9.44 / 937007，Xiaomi 25102RKBEC，Android 16 / sdk 36，
`availableBytes=13226795008`）仍然是引擎一次都没起来，但这次的拒绝原因换了：

```json
{"phase":"install","exception":"Refused","reason":"Python 离线修复：getFileStore；不会自动清空或重装用户运行时"}
```

`Engine state` 同样是「同一条启动错误连续出现 3 次」。报告里 `engine.log` 尾部那批
`atomic-write: timed out waiting for the writer lock` 是 2026-11-09 的历史行（时间戳 1794227xxx，早于本次），
与本次失败无关；`.credentials.yaml.lock` 仍是 ENOENT，私有目录 owner=10577 全部可访问。

## 1. 根因：Android 没有 `FileStore`

AOSP libcore 有一个提交 **“java.nio.file: Remove support for FileStore information”**：Android 上
`FileSystemProvider.getFileStore` 被改成无条件抛异常（API 契约允许抛 `SecurityException`），
原因是普通应用无权读挂载信息。抛出来的异常消息就是方法名 `getFileStore`。

而 `PythonRuntimeRepair.guarded()` 的兜底是：

```kotlin
catch (e: Exception) { throw Refused(e.message ?: e.javaClass.simpleName, e) }
```

`Refused` 再把消息拼成「Python 离线修复：$message；不会自动清空或重装用户运行时」——
于是真机上一条完整的平台异常，被压缩成 5 个字符 `getFileStore` 出现在报告里。

代码里有两处踩到它：

| 位置 | 用途 | 真机上 |
| --- | --- | --- |
| `repair()` 空间预检 | `Files.getFileStore(scope.base).usableSpace` | 直接抛异常 |
| `posix(path)` | `Files.getFileStore(path).supportsFileAttributeView("posix")` | 同样抛异常 |

`posix()` 被 `createDirectory` / `newFile` / `setMode` 三处调用，`Scope.newStage()` 一进去就会命中，
所以即使跳过空间预检也必然在同一阶段炸。

## 2. 为什么 112 条测试全绿还是炸了

桌面 JVM 的 `sun.nio.fs.LinuxFileStore` 是完整实现，`test-python-repair.mjs` 在 Windows/JDK17 上
跑的是真实 Kotlin 代码，`getFileStore` 一路通畅。**这是平台差异，不是逻辑分支**，测试套件结构上覆盖不到。

而且这条路径直到 0.9.44 才第一次在真机上被走到：0.9.43 及更早的升级都死在更前面的
「`kxxy-runtime.json` 用户文件冲突」；`inspect` 全 `CURRENT` 时会提前 return，也不会碰暂存和空间检查。
所以 0.9.44 修好了清单判据，才把这个一直存在的平台坑暴露出来。

## 3. 改法

`android/app/src/main/java/app/kxxy/engine/PythonRuntimeRepair.kt`

- **空间预检**改用 `java.io.File.usableSpace`（内部是同一条 `statvfs`，Android/JVM 都可用）：

  ```kotlin
  val needed = unpacked + 16L * 1024 * 1024
  val free = scope.base.toFile().usableSpace
  if (free in 1 until needed) refuse("私有暂存空间不足，旧文件未改动（剩余 $free 字节，需要 $needed 字节）")
  ```

  `free <= 0`（statvfs 取不到）时不在这里阻断，让写入按真实 ENOSPC 失败并保留旧文件；
  拒绝消息现在带剩余/需要字节数，下次报告能直接判断是不是空间问题。

- **POSIX 判定**不再探测，改为平台判定：

  ```kotlin
  private val windows = System.getProperty("os.name").orEmpty().startsWith("Windows")
  private val posix = !windows
  ```

  Android/Linux 的 app 私有目录必然是 POSIX；唯一跑非 POSIX 的地方是 Windows 上的 JVM 测试夹具。
  非 POSIX 且非 Windows 仍然 `refuse("文件系统不支持私有 POSIX 暂存权限")`，保持 fail-closed。

## 4. 验证

- `tools/test-python-repair.mjs` **112/112**（仍是真 Kotlin 编译执行）。新增 3 条静态合同断言，防止这类调用回来：
  源码不得出现 `Files.getFileStore(`、不得出现 `.supportsFileAttributeView(`、空间预检必须用 `.usableSpace`。
- 真实升级模拟 `.cache/simulate-upgrade-manifest-refusal.mjs <旧版本>`（真 Kotlin + 真补包 + 真旧运行时树）：
  - `0.9.42` → `replaced=1`，只换 `kxxy-runtime.json`，`isCurrent=true`；
  - `0.9.38` → `replaced=61`（全量补齐），`isCurrent=true`，用户文件（bin/node、extensions、venv、
    site-packages 手写文件）未动。
- `verify-python-repair` 合同校验随构建通过。

## 5. 产物

- `dist/Kxxy-0.9.45.apk`：**1,961,399,542 字节 / 1,870.54 MiB**，versionName 0.9.45 / versionCode **937008**
  （gradle 已打印），SHA256 `0e0326d14c809f7d32f4aac61c2023e3b740fb08298460aab30ee92c5fadfccb`。
- `dist/Kxxy-0.9.45-verification.json` checksPassed=true（22 个插件文件逐一源码比对、原生 app-process、
  三处指纹），`dist/Kxxy-0.9.45-python-verification.json` checksPassed=true。
- 运行时逐字节复用 `.cache/runtime-0.9.43/runtime.zip`（`ba0c54c6…`），Codex 插件指纹 `95b5f044…` 不变；
  Python 补包未重生成：manifest `c64c0388…` / payload `a4c79941…` / 61 文件 / 472111 B 与 0.9.43、0.9.44 完全一致。
- 已核对打包后的 `classes6.dex`：含新消息「私有暂存空间不足，旧文件未改动（剩余 …）」与 `supersededManifest`，
  并且**不再包含** `getFileStore` / `supportsFileAttributeView` / `FileStore`（改用 `getUsableSpace`）。
- 版本下限已写 **937008**，下次至少 **937009**。

## 6. 边界

- 没有安装到设备，本轮证据是「同一份 Kotlin + 真实旧运行时树」的模拟，不是真机验收。
- `posix=true` 那条分支（带 POSIX mode 创建目录/文件）在桌面 Windows 上跑不到，只能靠代码审查；
  它依赖的 `Files.createDirectory(dir, mode)` / `FileChannel.open(..., NOFOLLOW_LINKS, mode)` /
  `Files.setPosixFilePermissions` 都是 libcore 实现的常规 API，风险点集中但未被真机验证。
- 若还有下一处平台差异，`Refused` 现在会带上出错的 API 消息与字节数，救援报告能直接定位。
