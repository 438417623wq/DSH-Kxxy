# DSH Kxxy —— DeepSeek Harness 安卓移植（方案 T：Web-First）

把桌面版 DSH 的**完整能力**（官方 React 前端 + 86 个插槽 + 插件生态 + Turn 推理链 + Tool Call 卡片）
搬到 Android 手机端，而**不重写 UI**。

核心洞察：DSH 的 Web 面本身就是「浏览器 UI + 本地 HTTP 服务」，与 Electron 外壳解耦
（`dsh-web-app` 只依赖 `webServer` + 前端 dist）。所以手机端不需要移植 Electron，
只需要一个能跑 Node 的引擎 + 一个 WebView。

---

## 一、架构（三层）

```
┌─ 原生层（Kotlin 3,224 行 + C 433 行 + N-API 818 行）──────────────┐
│  BootstrapActivity  首次安装引导（方案 T 下唯一必须原生的 UI）      │
│  MainActivity       纯 WebView 容器，零业务控件                    │
│  AdaptLayer         移动端适配层（触控尺寸 / safe-area / 入口按钮） │
│  WebViewGate        WebView ≥ Chrome 85 检测                      │
│  EngineSupervisor   进程监管 + 指数退避 + 状态文件                 │
│  EngineProcess      PTY 启动引擎（--expose-internals 是硬前提）    │
│  RuntimeInstaller   解包 runtime.zip（含 LINK 物化 / 七锚点自愈）  │
│  EngineService      前台服务保活（specialUse）                     │
│  Privilege          Normal / Shizuku / Root 三级权限               │
│  dsh_pty.c          forkpty 原生 PTY（Android 无 posix_openpt）    │
│  dsh_pty_node.c     node-pty 的 N-API 实现（终端侧栏用）           │
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
| **方案 T（本方案）** | **≈ 3,200**（Kotlin；另有 C 433 + N-API 818 行，插件与工具链 22,000 行） |

---

## 二、目录结构

```
dsh-kxxy/
├── android/                      Android 工程（AGP 8.5.2 / Kotlin 1.9.24 / JDK 17）
│   └── app/src/main/
│       ├── assets/runtime.zip    497 MiB 运行时（构建产物，**不入库**，见 tools/）
│       ├── assets/ext-pool/      1.0 GiB 扩展包池（构建产物，**不入库**）
│       ├── cpp/                  PTY 原生层
│       └── java/app/kxxy/        Kotlin 源码 12 个文件
├── plugins/kxxy-host/            Cordis 插件（宿主管理页）
│   ├── cordis.patch.yml          挂载声明
│   ├── lib/index.js              路由 + API
│   └── web/                      管理页 HTML/CSS/JS（含 compat.js 兼容层）
├── tools/                        构建与验证工具链（8 个脚本）
│   ├── fetch-runtime.mjs         拉取 Termux aarch64 deb 包
│   ├── build-runtime.mjs         装配 runtime.zip（8 个阶段）
│   ├── fetch-extensions.mjs      构建扩展包池
│   ├── verify-runtime.mjs        产物结构校验
│   ├── simulate-install.mjs      复刻设备端解包流程
│   ├── smoke-plugin.mjs          插件路由冒烟测试
│   ├── check-bundle.mjs          用真实 dsh-app-boot 验证 bundle 解析
│   ├── test-pty-patch.mjs        补丁离线单测（含原生 PTY 注入）
│   ├── prebuilt/                 自研原生产物（Android arm64）
│   └── lib/                      装配/补丁/打包库
└── .cache/                       构建缓存（debs / stage，可删）
```

---

## 三、构建

前置：JDK 17、Android SDK（platforms 36 / build-tools 36 / ndk 28.2 / cmake 3.22.1）。
本机没有 gradle wrapper，用已安装的 Gradle 8.10.2。

> **仓库不含 `assets/runtime.zip`**（497 MiB，`.gitignore` 已排除）—— 它是构建产物，
> 由下面第 1、2 步从**本机已安装的 DSH 桌面版** `app.asar` + Termux aarch64 `.deb` 现场装配。
> 所以完整重建需要本机装有 DSH 桌面版（提供 `dsh` 的 JS 依赖树与前端 dist）。

```powershell
$node = "F:\dsh-desktop\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$gradle = "C:\Users\XiaoXin\.gradle\wrapper\dists\gradle-8.10.2-bin\a04bxjujx95o3nb99gddekhwo\gradle-8.10.2\bin\gradle.bat"

# 1) 拉取 Termux 运行时（④ 全能精选档闭包 220 包，约 310 MiB，可续跑）
& $node tools/fetch-runtime.mjs

# 1.5) 解 stage（poolextract/build-runtime 依赖它；Python 3.12 标准库解 data.tar.xz）
& "C:\Users\XiaoXin\AppData\Local\Programs\Python\Python312\python.exe" tools/lib/debextract.py --debs .cache\debs --out .cache\stage

# 2) 装配 runtime.zip（从 app.asar 抽取 dsh 依赖树 + 打 12 个兼容补丁）
& $node tools/build-runtime.mjs

# 2.5) 构建扩展包池（J/K 组边际闭包 → assets/ext-pool/*.tar.gz + 扩展目录 extensions.json）
& $node tools/fetch-extensions.mjs

# 3) 五套验证
& $node tools/verify-runtime.mjs
& $node tools/simulate-install.mjs
& $node tools/smoke-plugin.mjs
& $node tools/check-bundle.mjs
& $node tools/test-pty-patch.mjs

# 4) 打包 APK（必须 clean：AGP 增量打包是 append-only，会残留孤儿数据）
cd android
& $gradle --no-daemon clean :app:assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`（④ 全能精选档 ≈ 1.5 GiB，另有包池按需本地展开）。

> **打包可能因 `compressDebugAssets` 报 `Java heap space` 失败**：assets 合计 1.54 GB
> 要一次性读进堆，本机（物理 8 GB）在内存紧张时会顶破 `-Xmx3072m`。
> 这是瞬时压力而非配置缺陷 —— 去掉 `clean` 重跑一次即可成功。

---

## 四、装配链路（`build-runtime.mjs` 的 8 个阶段）

| 阶段 | 动作 | 关键点 |
|---|---|---|
| 1 | 收集 Termux stage | 实体 19010 / 符号链接 833 |
| 2 | 内容去重 | 19010 → 18634 本体，新增 376 个 LINK，省 905.6 KiB |
| 3 | 路径归一化 | 1121 个脚本的 `com.termux` 绝对路径改写成 `@DSH_ROOT@`；剔除 39 个死解释器脚本 |
| — | 目录链接展开 | `lib/clang/latest`(316) / `lib/icu/current`(2) / `lib/terminfo`(40) 是目录型链接，必须逐成员展开 |
| 4 | 闭包解析 | 从 asar 递归 **524 个包**；**按包实例建模**（含嵌套 node_modules） |
| 5 | 兼容补丁 | 12 个补丁（见下） |
| 6 | 注入 | corepack 包装器 + `kxxy-host` 插件 + 悬空 LINK 清扫 |
| 7 | 合并 | 目录 3628 / 文件 30061 / LINK 1560（未压缩 1.26 GiB） |
| 8 | 写出 | 条目 35,250，zip 497.24 MiB |

### 12 个兼容补丁

| 补丁 | 原因 |
|---|---|
| `koffi` | 换用 Android 预编译（需 ≥3.3.2） |
| `node-pty` | 注入自研 Android 原生 PTY 绑定（`tools/prebuilt/node-pty-android/`） |
| `subprocess-inspector` | 让 `createProcessInspector` 认 `android` 平台（复用 `LinuxProcessInspector`） |
| `flock` | Android 无 flock，退化为 no-op |
| `require-builtin` | 用纯 JS shim 替代原生 addon（依赖 `--expose-internals`） |
| `sandbox-local` | Android 无 landlock/seatbelt，退化为 `danger-full-access` |
| `session-jsonl` ×2 | 目录 fsync 在 Android 上不可用 |
| `ripgrep` | 指向 Termux 的 aarch64 `rg` |
| `fs-local` | 剥离 kernel32 / LibreOffice 平台分支 |
| `attachment-local` | `link()` 退化为 `copyFile` + 目录 fsync 容忍跳过 |
| `dsh-manifest` | 把 `kxxy-host` 写进 `@deepseek-ai/dsh` 的 dependencies |

---

## 五、移植过程中发现并修掉的 11 个真实缺陷

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
| I | 旧 ROM WebView 缺 `AbortSignal.any` | 设置 → 通用设置 →「权限」原样显示英文 `permission catalog has no active Host connection`；设置 →「模型」provider 列表整块空白 | 官方前端插件 bundle 用了 Chrome 116+ 的 `AbortSignal.any`，旧 WebView 上抛 `TypeError` 被 `ConnectionController.loop()` 静默吞掉，`connection.generation` 恒 undefined；另叠加 `rows.toSorted`（Chrome 110+）缺失使 provider 列表渲染抛错。修复见 `plugins/kxxy-host/web/compat.js` |
| J | 旧 ROM WebView 不支持 `dvh` 单位 | 「选择工作区目录」对话框只剩标题栏与底部按钮，目录列表整片空白（行在 DOM 里但不可见） | 插件 CSS 用了 Chrome 108+ 的 `dvh`：`dsh-client-ui-directory-picker-browse` 的 `.…_dialog{height:min(500px,100dvh - 32px)}`。WebView 104 的 CSS 解析器把整条 `height` 声明丢弃 → 对话框退化为 `height:auto`；其内部是 flex 列 + 子项 `flex:1 1 0`，auto 高度下被压成 0，列表行虽在 DOM 里却被 0 高的 `overflow:auto` 容器裁掉。`dsh-client-ui-schedule` 的 `min(420px,100dvh - 48px)` 是同一缺陷。修复同样在 `compat.js`（文本层面 `dvh → vh` + `MutationObserver` 观察后续插入的 `<style>`） |
| K | Android 无 PTY 支持（两处独立缺口） | 「新建终端」面板只剩「重试」按钮与红字 `终端错误：subprocess-local: terminal inspection is unsupported on platform android` | ① 上游 `dsh-subprocess-local` 的 `createProcessInspector()` 只认 linux/darwin/win32，而 Android 上 `process.platform === "android"`（不是 `"linux"`），三分支全不命中直接抛错；② 即使过了这关，`node-pty` 在 Android 上没有官方预编译产物，早期构建注入的是**抛错空壳**。两处都由构建期补丁修掉：`patchSubprocessInspector` 让 android 复用 `LinuxProcessInspector`（其实现只依赖 `/proc`，arm64 的 `SYSCALLS` 表齐备，真机实测 `/proc/self/stat` 与 `/proc/self/mem` 均可读），`patchNodePty` 改为注入自研 N-API 模块（`tools/prebuilt/node-pty-android/`） |

**教训**：`simulate-install.mjs` 的判据比设备端 Kotlin 代码更正确（它认 `libexec/`），
正是这个分歧暴露了缺陷 B。**测试脚本不该照抄实现，而该照抄规格。**

**缺陷 I 的定位手法**（可复用）：`app.kxxy` 未调 `WebView.setWebContentsDebuggingEnabled(true)`，
CDP 看不到它的 WebView；而 `onConsoleMessage` 只转发 `console.*`、**收不到未捕获异常**，
所以 logcat 里 `TypeError` 数为 0，极易误判为「没有 JS 异常」。
正确做法是把 Chrome 标签页当**可控实验台**：用 `Page.addScriptToEvaluateOnNewDocument`
注入 `delete AbortSignal.any` 模拟旧 WebView，即可在 CDP 里拿到真机拿不到的异常栈，
再用「删掉 + 补回 polyfill」做对照。两条硬约束：实验前必须 `navigate("about:blank")`
并清空事件缓冲（否则上一轮异常串进结果）；polyfill 必须在入口 module 求值**之前**注入
（`onPageFinished` 阶段补回只能让 body 从 31 恢复到 292，重试计数不会立即归零）。

**缺陷 J 的定位手法**（可复用）：症状是「标题栏和底部按钮都在，中间列表整片空白」——
第一直觉会去查数据通路（目录是否存在、宿主 opendir 是否返回），但那一条全绿。
真正的判据是**量高度**：在 CDP 里打开同一个对话框，量出
`dialog=500 / content=303 / millerRow=271`；再把那条 `height` 声明从样式文本里抹掉
（模拟 104 丢弃它），立刻变成 `dialog=229 / content=32 / millerRow=0 / column=0`，
而四行文本仍在 DOM 里 —— 与截图症状逐项吻合，再补一条 `vh` 版本即恢复原值。
两条硬约束：模拟必须**精确替换那一条字面量**（用正则匹配 `height:` 会连带误删
`max-height`，得到假阳性）；以及 `document.styleSheets` **看不到**插件注入的
`<style>`，所以不能靠遍历样式表来做剥离或修复，只能改文本。

**缺陷 K 的定位手法**（可复用）：报错文案里已经写明了平台，所以第一步不是读前端，
而是在设备上 `grep -rl` 那个字面量，直接落到唯一文件与唯一行。
真正花时间的是**第二处缺口**：`createProcessInspector` 修好之后终端仍然打不开，
因为 `node-pty` 是抛错空壳 —— 这条路径在源码里被 `createLazyRequire("node-pty")`
藏起来了（`require` 本身成功，只在**终端侧栏真正打开**时才 `spawn`），
所以「`require("node-pty")` 不报错」不能作为「PTY 可用」的证据。
另外，修 PTY 时最容易漏的是**契约的细节**而非功能本身：`onData` 收 string 还是
Buffer、`onExit` 的 `signal` 是数字还是名字、`resize(cols, rows)` 与原生
`resize(fd, rows, cols)` 顺序相反、`kill()` 有无参形态 —— 逐条对着上游调用点核，
而不是对着 node-pty 的文档核（上游只用其中一部分）。
一条可复用的硬约束：**原生回调必须先抽干 fd 再发退出事件**，
因为上游的 `onExit` 处理器会 `output.end()`，顺序反了会把子进程临终输出截断，
而这个 bug 在交互式终端里几乎看不出来（只在 `exit` 提示行消失时才显形）。

---

## 六、验证体系（五层）

| 脚本 | 验证什么 | 为什么需要它 |
|---|---|---|
| `verify-runtime.mjs` | zip 结构（条目数 / LINK 注释 / 占位符残留 / 版本标记 / ELF 校验） | 产物完整性 |
| `simulate-install.mjs` | 复刻 `RuntimeInstaller` 的 7 步解包与七锚点判定 | 结构对 ≠ 设备上能装出可启动的树 |
| `smoke-plugin.mjs` | 复刻官方 `WebServer` 路由契约起真实 HTTP | 文件铺对了 ≠ 插件能挂起来 |
| `check-bundle.mjs` | 用**真实** `dsh-app-boot` 走解析链 | 插件能跑 ≠ DSH 能发现它 |
| `test-pty-patch.mjs` | 12 个补丁的离线单测（自带 fixture，不依赖仓库外文件） | 补丁改错了构建照样全绿，只有点开终端才炸 |

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
