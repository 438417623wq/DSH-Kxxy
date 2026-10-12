# node-pty-android（自研 Android PTY 绑定）

`tools/lib/patches.mjs` 的 `patchNodePty` 会把这里的全部内容注入到
`lib/node_modules/node-pty/`，替换上游那个没有 Android 目标的 node-pty。

## 为什么需要它

`dsh-subprocess-local` 的终端路径最终落到 `createLazyRequire("node-pty").spawn(...)`
（`lib/index.js` 的 `spawnTerminal`）。上游 node-pty 是完整的原生 PTY 绑定，
需要针对 Android 交叉编译；官方不发 Android 预编译产物，仓库里也没有源码。
没有它，终端侧栏一点开就是 `node-pty unavailable in this Android build`。

（同一路径上还有第二处平台判断，见 `patchSubprocessInspector`：上游
`createProcessInspector()` 只认 linux/darwin/win32，而 Android 上
`process.platform === "android"`，会先一步抛
`terminal inspection is unsupported on platform android`。两者都要修。）

## 组成

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | JS 包装层，对外提供 node-pty 的 `spawn()` 契约 |
| `src/dsh_pty_node.c` | N-API 原生模块源码（纯 C，无 libc++ 依赖） |
| `prebuilds/android-arm64/dsh_pty_node.node` | 交叉编译产物，构建期原样打进 runtime |
| `package.json` | 注入后即 `node-pty/package.json` |

## 契约（对照 `dsh-subprocess-local` 的实际调用点）

`spawn(file, args, options)` 返回的对象必须提供：

- `pid`
- `onData(cb)` → `{ dispose() }`，**cb 收 string**（上游调用点立刻
  `Buffer.from(data, "utf8")`，说明它期望字符串）
- `onExit(cb)` → `{ dispose() }`，cb 收 `{ exitCode, signal }`，
  **`signal` 是数字信号号**（上游用 `constants.signals` 反查名字）
- `pause()` / `resume()` —— 背压：`output.write()` 返回 false 时暂停读取
- `write(data)`
- `resize(cols, rows)` —— **注意与原生模块的 `resize(fd, rows, cols)` 参数顺序相反**
- `kill(signal?)` —— 上游四种调用形态：`kill("SIGKILL")`、`kill("SIGTERM")`、
  `kill("SIGKILL")`、**无参 `kill()`**

## 原生模块要点

三条约束与 `android/app/src/main/cpp/dsh_pty.c` 完全一致（App 侧 PTY 用同一套做法），
任何一条放宽都会在真机上以难以归因的方式炸掉：

1. **fork 后必须关闭继承的 fd**。App 进程里的 `java.net.ServerSocket`（设备桥）
   不带 `O_CLOEXEC`，fork 出的 shell 会一直占着监听端口，父进程死后变成孤儿
   仍占端口，新桥 bind 失败 `EADDRINUSE`。刻意不用 `close_range(2)`：需要
   Linux 5.9+，minSdk 26 覆盖不到。
2. **`prctl(PR_SET_PDEATHSIG, SIGTERM)` + `getppid() == 1` 竞态检查**。
   SIGTERM 而非 SIGKILL，给引擎收尾机会。
3. **`execve` 完整替换环境**，不用 `putenv()` + `execvp()`。execve 不搜索
   PATH，所以 `file` 必须是绝对路径 —— 包装层负责解析（见下）。

另外两个实现细节容易踩：

- **`reap()` 必须先抽干 fd 再发 `onExit`**。上游的 onExit 处理器会
  `output.end()`，先发退出事件会把子进程临终输出（如 shell 的 exit 提示）截断。
- **槽位在 fork 之前领取**。`uv_close` 是异步的，槽位要等 poll 与 timer 两个
  close 回调都回来才能复用，提前复用会 use-after-close。

## 版本标记

`lib/index.js` 首行是 `/* kxxy-pty-node@N */`，与 `kxxy-host/web/compat.js`
的 `kxxy-webview-compat@N` 同一套机制：`RuntimeInstaller.isComplete()` 的
锚点 7 按此标记判定老设备是否需要重装 runtime。

老设备升级 APK 时 runtime 版本戳（`v0.1.0-arm64`）不变，只判「文件存在」
会让它们带着旧的抛错空壳跳过重装，终端照旧报错。**改动本目录任何文件后
必须递增该编号，并同步 `RuntimeInstaller` 的 `PTY_NODE_MARKER`。**

## 重新编译

```powershell
$ndk = "C:\Users\XiaoXin\AppData\Local\Android\Sdk\ndk\28.2.13676358\toolchains\llvm\prebuilt\windows-x86_64\bin"
& "$ndk\aarch64-linux-android26-clang.cmd" -shared -fPIC -O2 -Wall -Wextra `
  -I<node 头文件目录> -DNAPI_VERSION=8 `
  -o prebuilds/android-arm64/dsh_pty_node.node src/dsh_pty_node.c
```

头文件（`node_api.h` / `js_native_api.h` / `uv.h` 及其 `uv/` 子目录）取自
runtime 里的 `include/node/`，即设备上
`/data/data/app.kxxy/files/engine/include/node/`。

产物校验：`llvm-readelf -d` 应只列 `libdl.so` 与 `libc.so`；
`llvm-readelf --dyn-syms` 应有一批 UND 的 `napi_*` / `uv_*`，由 node 主程序解析。

**编译告警要当真**：`-Wall -Wextra` 报 `unused function` 曾直接对应一个
「槽位从未被分配」的真 bug（`startPoll` 永远找不到 fd）。

## 真机冒烟

`run-as` 无法直接 require `/data/local/tmp/` 下的文件，必须先 cp 进私有目录；
`LD_LIBRARY_PATH` 必须显式带上，否则报
`CANNOT LINK EXECUTABLE "./bin/node": library "libz.so.1" not found`。

```powershell
& $adb shell "run-as app.kxxy cp /data/local/tmp/dsh_pty_node.node /data/data/app.kxxy/files/tmp/"
& $adb shell "run-as app.kxxy sh -c 'cd <engine> && LD_LIBRARY_PATH=<engine>/lib:<engine>/usr/lib ./bin/node <probe>.js 2>&1'"
```

判据：`stty size` 返回与 `spawn(..., rows, cols)` 一致的值（证明 winsize 生效），
且子进程退出前的最后一行输出出现在 `onExit` 之前（证明不截断）。
