# 前端工具链落地（npm 源扩展池，v0.9.66）

第九项那批 `tsc / eslint / prettier / esbuild / rollup / vite` 不是「运行时坏了」，
也不是「漏拷了几个文件」—— 它们**不在 deb 世界里**。扩展池原来只会从 Termux
索引求 deb 闭包，而这一整套只发 npm，所以无论怎么修运行时都不会有它们。

这次补的不是「几个包」，是**扩展池的第二种来源**。

## 为什么不能「在设备上 npm install」

看起来最省事的做法是留个空壳包装器、第一次运行时 `npm i` 到本地。三条都不成立：

- 离线是硬前提。设备端 pip/npm 的联网路径本来就不稳定，工具链属于「装了就该能用」；
- 装机体积已经 2 GB 级，多 60 MiB 不是决策变量，但「每次首跑都要网」是；
- 依赖解析需要按 **android/arm64** 过滤 `os`/`cpu` 可选依赖，设备端 npm 拿到的是
  宿主平台文件时才更难排（同一份 `package.json`，两套结果）。

所以走构建期打包，产物与 deb 池**逐字节同构**，设备端安装器一行都不用改。

## 关键决策

### 1. `npm install --os=android --cpu=arm64`

npm 会按**构建机**的 `process.platform`/`arch` 过滤 `os`/`cpu` 声明的可选依赖。
在 Windows 上装 esbuild，拿到的是 `@esbuild/win32-x64`，`@esbuild/android-arm64`
被静默跳过 —— 打到设备上就是「命令在、一跑就找不到二进制」。两个解法里选了
官方开关，而不是手写依赖解析（要自己处理扁平化、版本冲突、peer deps，工作量大且易错）：

```
npm install --os=android --cpu=arm64 --ignore-scripts --omit=dev --install-strategy=hoisted
```

`--ignore-scripts` 是必须的：esbuild/rollup 的 postinstall 会去校验甚至下载**宿主
平台**的二进制，交叉安装场景下只会失败或写错文件；真正要的二进制由
`optionalDependencies` 里的平台包提供，不需要脚本。

构建期还有一道硬校验：`requiredPlatformPackages`（`@esbuild/android-arm64`、
`@rollup/rollup-android-arm64`）必须真的落地，os/cpu 字段也要对得上，缺一个就
**构建失败**。这是整条链路唯一能提前发现「按宿主平台装错」的地方 —— 装错时命令
还在，只有设备上第一次执行才炸，排查成本极高。

### 2. staging 目录按依赖指纹寻址（不删旧目录）

第一版是「`rm -rf` staging 再装」，在本机直接失败：

```
Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":1629,...}
```

递归删除 1600+ 文件被判成批量删除。与其去绕审计钩子，不如换个写法：目录名由
`sha256(name@version ...)` 的十位前缀决定，依赖没变就命中同一个目录、直接复用。
副作用是好的 —— 冷装 7 分钟不必每次都付：

```
node-tools: 复用已装好的 staging（node-tools-7304f238c7）
```

### 3. 执行位按**内容**判，不信 `stat`

这条是真机上唯一一次「装完还是不能用」，值得单独记：

```
Error: spawnSync …/@esbuild/android-arm64/bin/esbuild EACCES
    at Object.<anonymous> (…/esbuild/bin/esbuild:222:28)
```

`esbuild` 的 JS 入口用 `spawnSync` 起平台二进制，而那个二进制在设备上是 0644。
原因是构建机 Windows 上除 `.exe` 外**没有执行位**（`mode & 0o111` 恒为 0），
我们按 `stat` 判 0755/0644 就把它归到了 0644。报错停在
`node:child_process` 的 throw 上，看着像 node 的 bug。

现在按魔数判：`\x7fELF`（原生可执行，esbuild 的 Go 二进制名字不带后缀）与
`#!`（脚本）一律 0755，其余 0644。`.node` 是 dlopen 的，故意不在其列。

### 4. 包装器用占位符，回填交给安装器

`bin/` 里的包装器会被 `collectBins` 软链进 `<engine>/bin`，`$0` 已经指不回扩展目录，
而引擎根只有安装时才确定。所以包装器里写 `@DSH_ROOT@/extensions/node-tools/...`，
装完由 `extinstall.applyPlaceholders` 逐条回填（与 deb 池同一份 `.pool-manifest.json`）。

顺带解决一个 Android 特有的问题：上游 `#!` 是 `/usr/bin/env node`，Android 上没有
`/usr/bin/env`，直接执行必失败。包装器按 shebang 判断该用引擎 node 起（
`exec "<root>/bin/node" <target> "$@"`）还是直接 exec 原生二进制。

## 真机验收（Redmi K60 Pro，22127RK46C，Android 13）

为了不走「重建 runtime.zip → 重打 APK → 装机」这一轮，先旁路验证：把
`node-tools.pool` 推进 `<engine>/ext-pool/`，再用 `run-as` 里的引擎 node 调
**同一份** `extinstall.mjs`（`startInstall` → 同一个 `runInstall`），与 UI 上点
「获取」完全同一条路径。

```
REMOVE {"ok":true,"removedBins":7,...}
JOB done 100% 完成：1568 个文件，7 个命令、0 个库、0 项资源已接入，回填路径 7 个
```

```
tsc -> Version 5.9.3
eslint -> v9.39.5
prettier -> 3.10.1
esbuild -> 0.28.2
rollup -> rollup v4.68.6
vite -> vite/7.3.8 android-arm64 node-v24.22.3
=== 原生构件 ===
-rwxr-xr-x  …/@esbuild/android-arm64/bin/esbuild            11534582
-rwxr-xr-x  …/@rollup/rollup-android-arm64/rollup.android-arm64.node  1918688
=== 真实编译 ===
tsc out: const who = { name: "kxxy", age: 1 };console.log(who.name.toUpperCase());
esbuild out: 102 B
rollup: 'use strict'; const add = (a, b) => a + b; exports.add = add;
prettier: const x = 1;
eslint: 1:1  error  Unexpected var, use let or const instead  no-var
```

`vite --version` 打出 `android-arm64 node-v24.22.3` 是个意外之喜 —— 它自己会报
运行平台，等于顺带证明了「按目标平台装」这条真的生效了。

## 体积

`node-tools.pool` 60.5 MiB / 1568 文件（压缩后 15.61 MiB）。池内 25 项合计 1011 MiB。

## 0.9.66 装机验收

`dist/Kxxy-0.9.66.apk` 2,009,646,556 B（1.92 GiB），
sha256 `ab900184468dafb977082bd9211cb072fbef1772e53f785002ab6ed83164f65c`。
宿主指纹 `5d3abc7e…` → `1a885821…`，设备据此重解压了一次运行时（约 60 s）。

装机后复验（`run-as`，不手动喂 `RUBYLIB`/`GUILE_*` 的项一律加注）：

```
=== 扩展目录（UI 的数据源 readCatalog()）===
目录条目 25，仓库 https://packages.termux.dev/apt/termux-main
node-tools: v5.9.3+9.39.5+3.10.1+0.28.2+4.68.6+7.3.8 63482962 B 1568 文件
            [devtools] tsc,tsserver,eslint,prettier,esbuild,rollup,vite
=== 1 ruby ===（补 RUBYLIB 后）require "rubygems" ok，gem/bundle 4.0.20
=== 2 gdb  ===（补 GUILE_* 后）GNU gdb 18.1，elapsed=0s
=== 3 dsh  === 0.2.2-rc.3，dsh web --help rc=0
=== 5 pdf  === latex.fmt 2264179 B，pdflatex/xelatex/lualatex 三个标准名就位
=== 7 tz   === CST +0800，TZ=Asia/Shanghai
=== 9 前端 === tsc 5.9.3 eslint 9.39.5 prettier 3.10.1 esbuild 0.28.2
              rollup 4.68.6 vite 7.3.8 android-arm64
```

两次「先坏后好」的假警报都记在这里，免得下次重复怀疑：

- `ruby -e '... require "rubygems" ...'` 在双引号字符串里嵌 `"rubygems"`，报的
  `LoadError` 是自己的引号问题；单独 `require "rubygems"` 是 `require ok`。
- 不喂 `GUILE_LOAD_PATH`/`GUILE_LOAD_COMPILED_PATH` 时 gdb 会 `Fatal signal: Aborted`
  而不是报缺库 —— 这两条是引擎进程注入的，手工 `run-as` 起 shell 不会带。

## 还剩什么

- **sherpa-onnx 的 Android 绑定**：上游只发 darwin/linux/win 六个平台包，
  `sherpa-onnx-linux-arm64` 是 glibc、bionic 上 dlopen 必拒。要真修只能交叉编译
  （本机有 NDK 28.2，但 sherpa-onnx + onnxruntime 是独立项目）。本次先做两件事：
  有预编译产物（`tools/prebuilt/sherpa-onnx-android/prebuilds/android-arm64/`）就注入；
  没有就在 `addon.js` 顶部抛 `KXXY_SHERPA_UNAVAILABLE`，把「上游没发 Android 绑定」
  写清楚，而不是留给用户一句 `Could not find sherpa-onnx-node. Tried …`。
- **科学计算（scipy/sklearn/torch/opencv）**：不能塞 manylinux wheel，要按
  Android/arm64 原生依赖与 ABI 逐个验，且要跟上 `python 3.14.8`、`numpy 2.5.4`
  这组钉住的版本。属于下一批。
- **Julia / .NET / deno / zig / perf / valgrind**：工具链级或内核级项目，不在池子模型里。
