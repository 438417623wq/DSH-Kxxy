# tools/prebuilt/apksigner/

## 这是什么

Termux `apksigner` deb（`apksigner_37.0.0_all.deb`）里的 `usr/share/java/apksigner.jar`，
1,181,416 B。**随仓库入库**，理由和 `android/keystore/` 一样：让「换一台机器」
不再需要先装好 Android SDK 才能出包。

## 为什么要自带一份

签名这一步在缺陷 DX 之前有两个环境依赖，每一个都能让新机器卡住：

1. **`apksigner.bat` 跑不起来**（Node 侧）——
   - Node 18+ 直接 `spawn` 一个 `.bat` 会抛 `EINVAL`（CVE-2024-27980 之后的硬限制）；
   - 改走 `cmd /c` 又撞第二层：`spawnSync` 不走 shell 时会把参数里的引号转义成
     `\"`，cmd 于是把 `\"C:\…\apksigner.bat\"` 当成不存在的命令名；
   - 就算这两层都过了，`apksigner.bat` 自己还要 `JAVA_HOME`，否则报
     `ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.`
2. **`build-tools` 不一定装了** —— 本机就一度只有 `platforms/android-34`，
   `build-tools/` 是空的。那时 `build-apk.ps1` 直接抛「找不到 apksigner」。

`java -jar apksigner.jar` 把这三件事一起消掉：参数是干净的数组、不需要 shell、
也不需要 `JAVA_HOME`（`sign-apk.mjs` 自己找 `java.exe` 并把绝对路径传过去）。

## 谁在用它

`tools/sign-apk.mjs` 的 `resolveApksigner()`，优先级：

1. `--apksigner` / `KXXY_APKSIGNER`（显式指定，`.jar` 或 `.bat`）
2. **有 java 时**：SDK `build-tools/<最高版本>/lib/apksigner.jar`
3. **有 java 时**：本目录的 `apksigner.jar`
4. 都没有 java 时：SDK 的 `apksigner.bat` 兜底（它自己找 java）

刻意把「SDK 的 jar」排在「自带的 jar」前面：SDK 那份会跟着 build-tools 升级，
签名方案（v3/v4）与校验行为更新；自带这份的价值是**保底**，不是取代。
无论走哪一份，证书指纹都必须等于 `kxxy-signing.properties` 的 `certSha256` ——
`tools/sign-apk.mjs` 每次签完都硬校验（不等就删掉产物并抛错），
`tools/test-signing.mjs` 则用 keytool 走一条**独立于 apksigner 的链路**复核。

## 怎么重新取一份

```powershell
# .deb 是 ar 归档，data.tar.xz 里就是 usr/share/java/apksigner.jar
python -c "
import tarfile, io
raw = open('.cache/debs/apksigner_37.0.0_all.deb','rb').read()
off = 8
while off < len(raw):
    hdr = raw[off:off+60]; name = hdr[:16].decode().strip()
    size = int(hdr[48:58].decode().strip()); data = raw[off+60:off+60+size]
    if name.startswith('data.tar'):
        tf = tarfile.open(fileobj=io.BytesIO(data))
        for m in tf.getmembers():
            if m.name.endswith('apksigner.jar'):
                open('tools/prebuilt/apksigner/apksigner.jar','wb').write(tf.extractfile(m).read())
    off += 60 + size + (size % 2)
"
```

`.deb` 由 `tools/fetch-runtime.mjs` 下到 `.cache/debs/`（`seeds.mjs` 的 G4 组含
`apksigner`）。换版本后记得跑一次 `node tools/test-signing.mjs`。
