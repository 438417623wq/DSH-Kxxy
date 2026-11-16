# MuMu 模拟器「已安装但启动失败」修复 · 0.9.53

日期：2026-11-15
设备：MuMu 模拟器（Android 12，`ro.product.cpu.abilist=x86_64,arm64-v8a,…`，houdini 翻译 ARM64）
应用：`app.kxxy` 0.9.52 / 937016（覆盖安装，未卸载、未清数据）

## 现象

启动后停在启动页，随后 `kxxy-state.json` 变成 `Failed`，`engine.log` 里**没有任何 JS 堆栈**，
只有两行链接器报错：

```
dlopen failed: "/apex/com.android.runtime/lib64/bionic/libc.so" is for EM_X86_64 (62) instead of EM_AARCH64 (183)
dlopen failed: "/apex/com.android.runtime/lib64/bionic/libc.so" is for EM_X86_64 (62) instead of EM_AARCH64 (183)
```

`native-boot-failure.json`：`HealthTimeout`，120 秒内 3080 端口始终连不上。

上一轮记录把这条报错归因为「koffi / FFI libc 架构路径」。**该结论是错的**：本运行时里的
`koffi` 是惰性桩（`koffi.load('libc.so').func(...)()` 直接返回字符串 `koffi.load.func`），
根本不会真正 dlopen 任何东西。真正的调用方是 Node 自己。

## 定位方法（可复现）

1. 用 NDK 编一个 `dlopen` 记录器（`LD_PRELOAD`），打印每个 `dlopen` 的**库名**与**调用方模块**：

```
DLOPEN-FAIL name=/system/lib64/libc.so caller=…/engine/bin/node+0x224040c
```

2. 从 `runtime.zip` 取出 `bin/node`，用 `llvm-objdump -d --start-address=0x224040c` 反汇编，
   命中的是 **libuv 的 `getaddrinfo` 拦截函数**：

```
00000000022403d4 <getaddrinfo>:
  adrp x0, 0x52e000            ; "/system/lib64/libc.so"
  add  x0, x0, #0xf99
  mov  w1, #0x2                ; RTLD_NOW
  bl   0x2b60280 <dlopen@plt>  ← 返回 NULL ⇒ 整个引擎 exit 1
```

即：libuv 在 Android 上用**绝对路径 `/system/lib64/libc.so`** 取系统 libc 句柄，再 `dlsym` 出真正的
`getaddrinfo`。这也解释了为什么 `node --version`、`node -e` 都正常，只有 `web` 子命令必死 ——
**只有它要解析主机名**（`listen 127.0.0.1:3080` 走 getaddrinfo）。反证：把 3080 端口先占住，
`listen` 在 getaddrinfo 之前就失败，那次运行反而没有这条报错。

## 为什么只在模拟器上炸

| 环境 | `/system/lib64/libc.so` | 结果 |
|---|---|---|
| ARM64 真机 | 软链 → `/apex/…/lib64/bionic/libc.so`（**AArch64**） | 正常 |
| MuMu 等 x86_64 宿主 | 软链 → `/apex/…/lib64/bionic/libc.so`（**x86_64**） | ELF machine 不匹配 |

这些模拟器把 ARM 兼容库单独放在 `/system/lib64/arm64/`（32 位在 `/system/lib/arm/`），
其中 `libc.so` 就是**已经加载进本进程的那一份**。

## 修复

`android/app/src/main/cpp/kxxy_exec.c`（已有的 `LD_PRELOAD` 路径重写库）在 `dlopen` 钩子里新增
`arm_compat_alternate()`：

- 只处理 `/system/lib64/<name>` 与 `/system/lib/<name>`（一层文件名，不猜子目录）；
- 仅当 `/system/lib64/arm64/<name>`（或 `/system/lib/arm/<name>`）**真实存在**时才改写；
- 改写后仍失败则回退原路径，语义与不装本库一致。

真机没有 `arm64/` 子目录，这条分支天然不命中，行为与旧版逐字节相同 —— 所以这不是「为模拟器
开的后门」，而是一条在真机上恒为假的兼容路径。

实测（引擎侧，`LD_PRELOAD` 只挂这个库）：

```
OK      from=libc.so                 handle=0xbb6e80ebb4cd1387    ← 进程自身 libc
REWRITE from=/system/lib64/libc.so to=/system/lib64/arm64/libc.so handle=0xbb6e80ebb4cd1387
dsh web: http://127.0.0.1:3080/?token=…
```

两次改写返回的句柄与进程自身 libc **完全相同** —— bionic 按 inode 命中已加载的那份，
不会加载第二份 libc。

## 附带修掉的构建期误判

`tools/verify-runtime.mjs` 的「锚点 15」用正则找 `RuntimeInstaller.kt` 里的快路径，只容得下
一个 `!flag &&` 前缀；0.9.52 把守卫扩成 `if (!force && !freshRoot && isComplete(root))` 之后
它就判「找不到快路径」，导致**任何新包都打不出来**。已放宽为任意多个 `!标识符 &&` 前缀，
判据意图（`healPackagingWrappers` 必须早于 `isComplete` 快路径）不变。

## 边界

- 只改了宿主预加载库 + 构建期校验器，**运行时资产一个字节没动**
  （`7620d12e…`，84,620 条目），设备不需要重跑运行时升级。
- 未处理模拟器上「每次启动都要完整校验 2.4 GB 运行时」的耗时问题（真机 UFS 上可接受，
  MuMu 上明显偏慢）；这属于性能问题，与本次启动失败无关，未改其校验语义。
