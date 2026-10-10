# DSH Kxxy —— DeepSeek Harness 安卓移植（方案 T：Web-First）

把桌面版 DSH 的**完整能力**（官方 React 前端 + 86 个插槽 + 插件生态 + Turn 推理链 + Tool Call 卡片）
搬到 Android 手机端，而**不重写 UI**。

核心洞察：DSH 的 Web 面本身就是「浏览器 UI + 本地 HTTP 服务」，与 Electron 外壳解耦
（`dsh-web-app` 只依赖 `webServer` + 前端 dist）。所以手机端不需要移植 Electron，
只需要一个能跑 Node 的引擎 + 一个 WebView。

---

## 一、架构（三层）

```
┌─ 原生层（Kotlin 2,513 行 + C 433 行）────────────────────────────┐
│  BootstrapActivity  首次安装引导（方案 T 下唯一必须原生的 UI）      │
│  MainActivity       纯 WebView 容器，零业务控件                    │
│  AdaptLayer         移动端适配层（触控尺寸 / safe-area / 入口按钮） │
│  WebViewGate        WebView ≥ Chrome 85 检测                      │
│  EngineSupervisor   进程监管 + 指数退避 + 状态文件                 │
│  EngineProcess      PTY 启动引擎（--expose-internals 是硬前提）    │
│  RuntimeInstaller   解包 runtime.zip（含 LINK 物化 / 占位符改写）  │
│  EngineService      前台服务保活（specialUse）                     │
│  Privilege          Normal / Shizuku / Root 三级权限               │
│  dsh_pty.c          forkpty 原生 PTY（Android 无 posix_openpt）    │
└───────────────────────────────────────────────────────────────────┘
                              │  127.0.0.1:3080
┌─ Web 层（全部 UI）────────────────────────────────────────────────┐
│  /        官方 React 前端（复用 0 行代码，含对话/插槽/插件生态）    │
│  /kxxy    自研宿主管理页（kxxy-host Cordis 插件提供的路由）        │
└───────────────────────────────────────────────────────────────────┘
                              │
┌─ 运行时层（零改动 dsh 依赖树）────────────────────────────────────┐
│  Node 24.18.0 (Termux aarch64) + bash + git + rg + 524 个 npm 包   │
│  dsh web profile：dsh-base → dsh-web-app → kxxy-host               │
└───────────────────────────────────────────────────────────────────┘
```

**代码量对比**（同样功能）：

| 方案 | 行数 |
|---|---|
| Kotlin + framework 原生控件 | 15,158 |
| Jetpack Compose | ~10,000 |
| React Native | ~7,500 |
| Flutter | ~6,900 |
| **方案 T（本方案）** | **≈ 2,600** |

---

## 二、目录结构

```
dsh-kxxy/
├── android/                      Android 工程（AGP 8.5.2 / Kotlin 1.9.24 / JDK 17）
│   └── app/src/main/
│       ├── assets/runtime.zip    98.7 MiB 运行时（构建产物，**不入库**，见 tools/）
│       ├── cpp/                  PTY 原生层
│       └── java/app/kxxy/        Kotlin 源码 12 个文件
├── plugins/kxxy-host/            Cordis 插件（宿主管理页）
│   ├── cordis.patch.yml          挂载声明
│   ├── lib/index.js              路由 + API
│   └── web/                      管理页 HTML/CSS/JS
├── tools/                        构建与验证工具链（6 个脚本）
│   ├── fetch-runtime.mjs         拉取 Termux aarch64 deb 包
│   ├── build-runtime.mjs         装配 runtime.zip（8 个阶段）
│   ├── verify-runtime.mjs        产物结构校验
│   ├── simulate-install.mjs      复刻设备端解包流程
│   ├── smoke-plugin.mjs          插件路由冒烟测试
│   └── check-bundle.mjs          用真实 dsh-app-boot 验证 bundle 解析
└── .cache/                       构建缓存（debs / stage，可删）
```

---

## 三、构建

前置：JDK 17、Android SDK（platforms 36 / build-tools 36 / ndk 28.2 / cmake 3.22.1）。
本机没有 gradle wrapper，用已安装的 Gradle 8.10.2。

> **仓库不含 `assets/runtime.zip`**（98.7 MiB，`.gitignore` 已排除）—— 它是构建产物，
> 由下面第 1、2 步从**本机已安装的 DSH 桌面版** `app.asar` + Termux aarch64 `.deb` 现场装配。
> 所以完整重建需要本机装有 DSH 桌面版（提供 `dsh` 的 JS 依赖树与前端 dist）。

```powershell
$node = "F:\dsh-desktop\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$gradle = "C:\Users\XiaoXin\.gradle\wrapper\dists\gradle-8.10.2-bin\a04bxjujx95o3nb99gddekhwo\gradle-8.10.2\bin\gradle.bat"

# 1) 拉取 Termux 运行时（首次，约 180 MiB）
& $node tools/fetch-runtime.mjs

# 2) 装配 runtime.zip（从 app.asar 抽取 dsh 依赖树 + 打 11 个兼容补丁）
& $node tools/build-runtime.mjs

# 3) 四套验证
& $node tools/verify-runtime.mjs
& $node tools/simulate-install.mjs
& $node tools/smoke-plugin.mjs
& $node tools/check-bundle.mjs

# 4) 打包 APK（必须 clean：AGP 增量打包是 append-only，会残留孤儿数据）
cd android
& $gradle --no-daemon clean :app:assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk` ≈ **100.1 MiB**

---

## 四、装配链路（`build-runtime.mjs` 的 8 个阶段）

| 阶段 | 动作 | 关键点 |
|---|---|---|
| 1 | 收集 Termux stage | 实体 823 / 符号链接 368 |
| 2 | 内容去重 | 同内容文件折叠成 LINK 条目 |
| 3 | 路径归一化 | 161 个脚本的 `com.termux` 绝对路径改写成 `@DSH_ROOT@` |
| — | 目录链接展开 | `lib/icu/current`、`lib/terminfo` 是目录型链接，必须逐成员展开 |
| 4 | 闭包解析 | 从 asar 递归 **524 个包 / 533 个实例**；**按包实例建模**（含嵌套 node_modules） |
| 5 | 兼容补丁 | 11 个补丁（见下） |
| 6 | 注入 | corepack 包装器 + `kxxy-host` 插件 + 悬空 LINK 清扫 |
| 7 | 合并 | 目录 2454 / 文件 12234 / LINK 415 |
| 8 | 写出 | 条目 15,104，zip 98.7 MiB |

### 11 个兼容补丁

| 补丁 | 原因 |
|---|---|
| `koffi` | 换用 Android 预编译（需 ≥3.3.2） |
| `node-pty` | 换用 `libdsh_pty.so` |
| `flock` | Android 无 flock，退化为 no-op |
| `require-builtin` | 用纯 JS shim 替代原生 addon（依赖 `--expose-internals`） |
| `sandbox-local` | Android 无 landlock/seatbelt，退化为 `danger-full-access` |
| `session-jsonl` ×2 | 目录 fsync 在 Android 上不可用 |
| `ripgrep` | 指向 Termux 的 aarch64 `rg` |
| `fs-local` | 剥离 kernel32 / LibreOffice 平台分支 |
| `attachment-local` | `link()` 退化为 `copyFile` + 目录 fsync 容忍跳过 |
| `dsh-manifest` | 把 `kxxy-host` 写进 `@deepseek-ai/dsh` 的 dependencies |

---

## 五、移植过程中发现并修掉的 8 个真实缺陷

这些都是**只在真机/端到端路径上才会暴露**的问题，构建全绿时完全看不出来：

| # | 缺陷 | 症状 | 根因 |
|---|---|---|---|
| A | 状态文件 BOM | 管理页 pid/内存/运行时长全丢 | `JSON.parse` 遇 BOM 抛错，catch 是静默的 |
| B | `libexec/` 未恢复可执行位 | `git clone https://…` 报 `Permission denied`，**极易误判为网络问题** | `restoreExecBits` 只扫 `bin/` 一层，漏 `libexec/` 且未递归 |
| C | peerDependencies 未进闭包 | 引擎启动即 `Cannot find package '@deepseek-ai/cordis-plugin-group'` | DSH 大量用「接缝包」模式，抽象层只被 peer 引用 |
| D | 状态只在变化时落盘 | 运行时长/内存冻结在健康那一刻 | `StateFlow` 语义 —— 参考项目 v1.2.73 有过同类事故 |
| E | `dsh web` 不挂载插件 | `/kxxy` 404 | web 模板的 `dsh.profile.bundles` 只有 base + web-app |
| F | 嵌套 node_modules 未建模 | `webserver` 插件 `failed to import`，引擎启动失败 | 嵌套 `negotiator@1.1.0` 需要 `content-type`，闭包只跟顶层 |
| G | prefix 路由带尾斜杠 | `/kxxy` 200 但 `/kxxy/api/*` 全 404 | 官方 `match()` 判据是 `startsWith(prefix + '/')` |
| H | 管理页资源相对路径 | 页面无样式无交互，HTTP 层完全看不出异常 | 页面 URL 无尾斜杠，`href="host.css"` 解析到站点根 |

**教训**：`simulate-install.mjs` 的判据比设备端 Kotlin 代码更正确（它认 `libexec/`），
正是这个分歧暴露了缺陷 B。**测试脚本不该照抄实现，而该照抄规格。**

---

## 六、验证体系（四层）

| 脚本 | 验证什么 | 为什么需要它 |
|---|---|---|
| `verify-runtime.mjs` | zip 结构（条目数 / LINK 注释 / 占位符残留） | 产物完整性 |
| `simulate-install.mjs` | 复刻 `RuntimeInstaller` 的 7 步解包 | 结构对 ≠ 设备上能装出可启动的树 |
| `smoke-plugin.mjs` | 复刻官方 `WebServer` 路由契约起真实 HTTP | 文件铺对了 ≠ 插件能挂起来 |
| `check-bundle.mjs` | 用**真实** `dsh-app-boot` 走解析链 | 插件能跑 ≠ DSH 能发现它 |

外加**端到端实测**：用宿主 node 直接跑装配产物，验证
`/`（官方前端 + token 认证）、`/kxxy`（管理页）、`/kxxy/api/*`（API）、
以及边界行为（恶意 Host 403、目录穿越 400、未知端点 404）。

---

## 七、已知限制

| 项 | 状态 |
|---|---|
| Office 文档预览 | Android 上抛 `Unsupported LibreOfficeKit host: android-arm64`（可接受降级，PDF/Markdown/代码预览正常） |
| 沙箱隔离 | Android 无 landlock/seatbelt，固定 `danger-full-access` |
| 无障碍服务 | 未实现（参考项目有 1,495 行，方案 T 下属可选后置） |
| 语音输入 | 未实现 |
| `ctx.slots` | **是浏览器侧概念**（`dsh-client-ui-slots` 只在 client bundle 里跑），host 侧插件无法注册；管理页入口改由 `AdaptLayer` 在 WebView 里注入悬浮按钮 |

---

## 八、环境依赖的硬约束

1. **`--expose-internals` 不是可选项** —— `dsh-app-boot` 的 `internalModules()` 靠它拿
   `internal/modules/esm/loader` 等内部模块；缺了会 `Cannot find module`。
2. **必须是 glibc 环境** —— 所有原生依赖（sharp / ripgrep / koffi / node-addon-*）
   只有 `linux-arm64-gnu` 预编译，**没有 Android bionic 目标**。
   所以走 Termux 的 aarch64 包 + `LD_LIBRARY_PATH`，而不是 Termux 原生环境。
3. **Node 24.18.0** —— Termux 的 `nodejs-lts`；DSH 的 Node 矩阵是 22/24/26，
   nodejs-mobile（Node 18）不满足。
4. **registry 只能是 `registry.npmmirror.com`** —— `registry.npmjs.org` 在本机不可达。
