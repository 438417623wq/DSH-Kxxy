# 固定签名（`kxxy-signing.jks`）

## 一句话

**这个目录里的 keystore 就是 DSH Kxxy 的正式签名密钥，入库、永不重建。**
换掉它（或换掉之前那套「每台机器各自生成的 `~/.android/debug.keystore`」）
的直接后果是：设备上已装的包**无法覆盖升级**，必须

```
adb uninstall app.kxxy        # 或者手机上长按 → 卸载
```

而 `adb uninstall` 会连同 `/data/data/app.kxxy/` 下的**引擎、运行时（713 MiB）、
会话、已装扩展**一起删掉 —— 装回去等于从零解压一遍。

## 为什么会「每次都要卸载」

`build-apk.ps1` 原来用的是 AGP/`apksigner` 的**调试默认值**：

```powershell
$ks = "$env:USERPROFILE\.android\debug.keystore"
```

`debug.keystore` 是**每台机器、每个 Windows 用户各自生成**的一次性密钥
（AGP 在缺失时自动创建，密码固定 `android`、别名 `androiddebugkey`）。
于是：

| 情况 | 结果 |
| --- | --- |
| 换构建机 / 换 Windows 用户 / 清了 `%USERPROFILE%` | 新机器重新生成 → **签名变了** → 装不上 |
| 删过 `.android` 目录、跑过 `flutter doctor --android-licenses` 之类 | 同上 |
| 只想换一台电脑出包 | 同上 |

真机上的报错是 `INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package app.kxxy
signatures do not match previously installed version` —— 与「版本号降级」
（`INSTALL_FAILED_VERSION_DOWNGRADE`）是两回事，后者能用 `-d` 绕过，
前者**没有任何绕过手段**，只能卸载。

## 现在的做法

| 文件 | 作用 |
| --- | --- |
| `kxxy-signing.jks` | PKCS12，RSA 2048，有效期 100 年（`36500` 天），别名 `kxxy` |
| `kxxy-signing.properties` | 密码、别名、以及**证书 SHA-256 指纹**（构建期硬断言用） |

指纹：

```
SHA-256  d0:8a:e4:99:73:63:7a:25:ff:b3:7c:c0:aa:c3:ac:71:fa:58:12:58:6b:11:8e:2e:94:39:d6:fa:49:b9:03:73
SHA-1    cd:4e:c6:fb:54:fe:c3:bd:a1:5c:48:4d:bf:af:fa:85:78:6b:61:12
DN       CN=DSH Kxxy, OU=Android, O=DSH Kxxy, C=CN
```

三处消费方**必须**读同一份 `kxxy-signing.properties`：

1. `android/app/build.gradle.kts` —— `signingConfigs.create("kxxy")`，
   debug / release 都用它。这样连 gradle 中间产物都是同一把钥匙签的。
2. `tools/build-apk.ps1` —— 第 6 步 `apksigner` 重签（zipalign 之后必须重签）。
3. `tools/sign-apk.mjs` —— 只重签、不重新构建（换机器后补救用）。

构建期还会做两件事，任何一件不满足都**直接抛错**而不是出一个能装不能升的包：

* 签完立刻 `apksigner verify --print-certs`，把实际证书 SHA-256 与
  `kxxy-signing.properties` 的 `certSha256` 比对；
* 若磁盘上已存在上一次的 `app-signed.apk`，再比一次**新旧指纹** ——
  不一致时打印「这次装上去需要先卸载」，把事故提前到构建期可见。

## 唯一一次例外

`kxxy-signing.jks` 是 2026-10-26 新造的。此前所有包用的是
`CN=Android Debug`（SHA-256 `c2:61:8a:ca:…:56`）那把一次性调试密钥，
**它的私钥已经随旧构建机的 `%USERPROFILE%\.android` 一起丢失**，
无法导出、也无法恢复。

所以：**从旧调试签名的包升级到本密钥签名的包，需要卸载一次**。之后永久不用再卸。

```powershell
adb uninstall app.kxxy
adb install -r android\app\build\outputs\apk\debug\app-signed.apk
```

## 不要做的事

* ❌ 用 `keytool -genkeypair` 重新生成 `kxxy-signing.jks`（哪怕「只是换个密码」）。
* ❌ 用 `keytool -storepasswd` 改密码后忘了同步 `kxxy-signing.properties`。
* ❌ 把 `android/keystore/` 加进 `.gitignore`。
* ❌ 在 CI 里「找不到 keystore 就临时生成一个」—— 这正是缺陷本身的写法。

备份方式只有一个：**复制 `kxxy-signing.jks` 与 `kxxy-signing.properties` 到仓库之外的私密位置**。
仓库本身已经是其中一份备份（远端 `https://github.com/438417623wq/DSH-Kxxy`）。
