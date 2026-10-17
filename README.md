# DSH Kxxy —— DeepSeek Harness 安卓移植（方案 T：Web-First）

把桌面版 DSH 的**完整能力**（官方 React 前端 + 86 个插槽 + 插件生态 + Turn 推理链 + Tool Call 卡片）
搬到 Android 手机端，而**不重写 UI**。

核心洞察：DSH 的 Web 面本身就是「浏览器 UI + 本地 HTTP 服务」，与 Electron 外壳解耦
（`dsh-web-app` 只依赖 `webServer` + 前端 dist）。所以手机端不需要移植 Electron，
只需要一个能跑 Node 的引擎 + 一个 WebView。

---

## 一、架构（三层）

```
┌─ 原生层（Kotlin 3,800 行 + C 433 行 + N-API 818 行）──────────────┐
│  BootstrapActivity  首次安装引导（方案 T 下唯一必须原生的 UI）      │
│  MainActivity       纯 WebView 容器，零业务控件                    │
│  WebViewGate        WebView ≥ Chrome 85 检测                      │
│  EngineSupervisor   进程监管 + 指数退避 + 状态文件                 │
│  EngineProcess      PTY 启动引擎（--expose-internals 是硬前提）    │
│  RuntimeInstaller   解包 runtime.zip（含 LINK 物化 / 十三锚点自愈）│
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
│  dsh web profile：dsh-base → dsh-web-app → kxxy-host → dsh-web-mobile │
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
│       ├── assets/runtime.zip    591 MiB 运行时（构建产物，**不入库**，见 tools/）
│       ├── assets/ext-pool/      1.0 GiB 扩展包池（构建产物，**不入库**）
│       ├── cpp/                  PTY 原生层
│       ├── res/values/           浅色主题 + 窗口/启动页配色（缺陷 P）
│       ├── res/values-night/     深色主题（同一组资源名，缺陷 P）
│       └── java/app/kxxy/        Kotlin 源码 11 个文件
├── plugins/kxxy-host/            Cordis 插件（宿主管理页）
│   ├── cordis.patch.yml          挂载声明
│   ├── lib/index.js              路由 + API（/kxxy、/kxxy/assets、/kxxy/media、/kxxy/api）
│   └── web/                      管理页 HTML/CSS/JS（含 compat.js 兼容层）
│       ├── compat.js             旧 ROM WebView 兼容层（缺陷 I/J/R/W/AC/AD）
│       ├── modern.js             现代内建补齐层（页面 + blob worker/iframe）
│       └── （只有 index.html + host.css + host.js + theme.css；
│             v0.1.0 的 harness-*.html 设计稿快照已删，见 `assemble.mjs` 的过滤）
├── tools/                        构建与验证工具链
│   ├── fetch-runtime.mjs         拉取 Termux aarch64 deb 包
│   ├── build-runtime.mjs         装配 runtime.zip（8 个阶段）
│   ├── fetch-extensions.mjs      构建扩展包池
│   ├── verify-runtime.mjs        产物结构校验
│   ├── simulate-install.mjs      复刻设备端解包流程
│   ├── smoke-plugin.mjs          插件路由冒烟测试
│   ├── check-bundle.mjs          用真实 dsh-app-boot 验证 bundle 解析
│   ├── test-pty-patch.mjs        补丁离线单测（含原生 PTY 注入）
│   ├── test-compat-url.mjs       compat.js URL 补丁单测（104 行为沙箱）
│   ├── test-compat-css.mjs       compat.js CSS 补丁单测（dvh / @scope / :has() / hash 归一化）
│   ├── test-modern.mjs           modern.js 补齐层单测（104 行为沙箱 + blob 作用域）
│   ├── test-archive-providers.mjs 归档 provider 单测（zip 中央目录 + epub OPF）
│   ├── test-media-providers.mjs 媒体 provider 单测（video/audio 槽位与状态机）
│   ├── prebuilt/                 自研原生产物（Android arm64）与注入片段
│   │   ├── documentpreview-archive/  zip / epub provider 注入片段
│   │   └── documentpreview-media/    video / audio provider 注入片段
│   └── lib/                      装配/补丁/打包库
└── .cache/                       构建缓存（debs / stage，可删）
```

---

## 三、构建

前置：JDK 17、Android SDK（platforms 36 / build-tools 36 / ndk 28.2 / cmake 3.22.1）。
本机没有 gradle wrapper，用已安装的 Gradle 8.10.2。

> **仓库不含 `assets/runtime.zip`**（591 MiB，`.gitignore` 已排除）—— 它是构建产物，
> 由下面第 1、2 步从**本机已安装的 DSH 桌面版** `app.asar` + Termux aarch64 `.deb` 现场装配。
> 所以完整重建需要本机装有 DSH 桌面版（提供 `dsh` 的 JS 依赖树与前端 dist）。

```powershell
$node = "F:\dsh-desktop\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$gradle = "C:\Users\XiaoXin\.gradle\wrapper\dists\gradle-8.10.2-bin\a04bxjujx95o3nb99gddekhwo\gradle-8.10.2\bin\gradle.bat"

# 1) 拉取 Termux 运行时（④ 全能精选档闭包 220 包，约 310 MiB，可续跑）
& $node tools/fetch-runtime.mjs

# 1.5) 解 stage（poolextract/build-runtime 依赖它；Python 3.12 标准库解 data.tar.xz）
& "C:\Users\XiaoXin\AppData\Local\Programs\Python\Python312\python.exe" tools/lib/debextract.py --debs .cache\debs --out .cache\stage

# 1.6) 取 TeX Live 宏包树（CTAN scheme-basic，118 包 ≈ 19.9 MiB xz → 解包 84 MiB）
& "C:\Users\XiaoXin\AppData\Local\Programs\Python\Python312\python.exe" tools/fetch-texlive.py

# 2) 装配 runtime.zip（从 app.asar 抽取 dsh 依赖树 + 打 19 个兼容补丁
#    + 打包 LibreOffice wasm / CJK 字体 / 移动端插件 / 中文语言包 / TeX Live 宏包树）
& $node tools/build-runtime.mjs

# 2.5) 构建扩展包池（J/K 组边际闭包 → assets/ext-pool/*.tar.gz + 扩展目录 extensions.json）
& $node tools/fetch-extensions.mjs

# 3) 十一套验证
& $node tools/verify-runtime.mjs
& $node tools/simulate-install.mjs
& $node tools/smoke-plugin.mjs
& $node tools/check-bundle.mjs
& $node tools/test-pty-patch.mjs
& $node tools/test-compat-url.mjs
& $node tools/test-compat-css.mjs
& $node tools/test-modern.mjs
& $node tools/test-archive-providers.mjs
& $node tools/test-media-providers.mjs
& $node tools/test-extinstall.mjs

# 4) 打包 APK（必须 clean：AGP 增量打包是 append-only，会残留孤儿数据。但内存紧张时
#    可以去掉 clean 重跑 —— clean 会连产物一起清掉，白等几分钟）
cd android
& $gradle --no-daemon clean :app:assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`（④ 全能精选档 ≈ 1.6 GiB，另有包池按需本地展开）。

> **打包可能因 `compressDebugAssets` 报 `Java heap space` 失败**：assets 合计 1.54 GB
> 要一次性读进堆，本机（物理 8 GB）在内存紧张时会顶破 `-Xmx3072m`。
> 这是瞬时压力而非配置缺陷 —— 去掉 `clean` 重跑一次即可成功。

---

## 四、装配链路（`build-runtime.mjs` 的 8 个阶段）

| 阶段 | 动作 | 关键点 |
|---|---|---|
| 1 | 收集 Termux stage | 实体 19010 / 符号链接 833 |
| 2 | 内容去重 | 19010 → 18634 本体，新增 376 个 LINK，省 905.6 KiB |
| 3 | 路径归一化 | **1122** 个脚本的 `com.termux` 绝对路径改写成占位符（`@DSH_ROOT@` / `@DSH_HOME@` / `@DSH_TMP@` / `@DSH_FILES@` / `@DSH_DATA@`）；剔除 39 个死解释器脚本 |
| — | 目录链接展开 | `lib/clang/latest`(316) / `lib/icu/current`(2) / `lib/terminfo`(40) 是目录型链接，必须逐成员展开 |
| 4 | 闭包解析 | 从 asar 递归 **524 个包**；**按包实例建模**（含嵌套 node_modules） |
| 5 | 兼容补丁 | 19 个补丁（见下） |
| 6 | 注入 | corepack 包装器 + `kxxy-host` 插件 + 悬空 LINK 清扫 |
| 6.5 | 打包引擎资产 | LibreOffice wasm 引擎（49 文件，剥离 `os` 字段）+ 两份 CJK 字体 |
| 6.6 | 打包移动端插件 | 第三方 `dsh-web-mobile`（209 文件）整包塞进 `lib/node_modules/`（它进「已安装」列表靠的是启动时 `EngineConfig.ensureProfileManifest` 写 profile manifest，见缺陷 AB） |
| 6.7 | 打包中文语言包 | Tesseract 的 `chi_sim.traineddata`（tessdata_fast，2.35 MiB）落到 `share/tessdata/`，配套 `TESSDATA_PREFIX` 与锚点 12（见缺陷 AP） |
| 6.8 | 打包 TeX Live 宏包树 | 从 CTAN 取 `scheme-basic`（118 包 / 5,894 文件 / 83.84 MiB）落进 `share/texlive/2026.0/`，配套 `TEXMFCNF` 与锚点 13。**Termux 的 `texlive-bin` deb 只发引擎**，`tex/latex`、`tex/plain`、`tlpkg` 全为 0 条（见缺陷 AR） |
| 7 | 合并 | 目录 4263 / 文件 36218 / LINK 1560（未压缩 1.51 GiB） |
| 8 | 写出 | 条目 42,042，zip 590.89 MiB |

### 19 个兼容补丁

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
| `document-preview-unicode-sets` | PDF 分块的 `v` 标志正则（Chrome 111+）在 104 上是 `SyntaxError`，改写为 `u` 模式 |
| `libreoffice-kit-platform` | 三处 `platform !== "linux"` 放行 `android`，启用 wasm 后端（缺陷 X） |
| `libreoffice-kit-font-fallbacks` | 给 `FONT_FALLBACKS` 追加 Android 实存族 + 13 组 Windows/macOS 族（缺陷 X） |
| `office-to-pdf-formats` | 扩展名白名单补 `odt` / `ods` / `odp`（底层引擎本就支持 ODF） |
| `document-preview-office-extensions` | 客户端 office provider 的 `extensions` 同步补 `odt` / `ods` / `odp` |
| `document-preview-archive-providers` | 注入 zip / epub 两个归档 provider（缺陷 Z，官方两个格式都没有渲染器） |
| `document-preview-media-providers` | 注入 video / audio 两个媒体 provider（缺陷 AI，官方把 16 个音视频后缀列进 `UNVIEWABLE_BINARY_EXTENSIONS` 直接判「无法预览」） |
| `dsh-manifest` | 把 `kxxy-host` 与内置的 `dsh-web-mobile` 写进 `@deepseek-ai/dsh` 的 dependencies（installation scope，否则 `dsh-client-modules` 扫不到那条 Loader entry） |

---

## 五、移植过程中发现并修掉的 53 个真实缺陷

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
| L | Root 模式启动必然失败 | 选「Root 提权」后引擎永远起不来：`启动失败，32 秒后重试（第 N 次）`；logcat 里只有 `exit 127` 与 `EIO`，**没有一行报错** | `Privilege.usableSuPrefix()` 用 `findSu()` 的**绝对路径**去探测（探测成功），返回值却是硬编码的**裸名** `["su","-c"]`；该值一路传到 `EngineProcess.spawn` → `dsh_pty.c` 的 `execve` —— 而 `execve` **不搜索 PATH**，裸名直接 ENOENT、exit 127。讽刺的是 `Privilege.kt` 文件头注释早已写明这条约束。修复：`usableSuPrefix()` 返回 `listOf(suBin) + args`（首项必为绝对路径），`EngineProcess` 增 `requireAbsolute()` 守卫在起点拦下裸名 |
| M | Shizuku 模式从未实现 | 「Shizuku ADB」档位可选中、可保存、可重启，但**没有任何 ADB 能力**；用户感知为「Shizuku 权限有问题」 | 原实现只做了两件事：检测管理器是否安装（`packageManager.getPackageInfo`）+ 把 `DSH_ANDROID_PRIV_MODE=shizuku` 写进引擎环境变量。依赖里没有 `dev.rikka.shizuku:*`、清单里没有 `ShizukuProvider`、没有任何 binder 调用 —— 前端卡片自己都写着「完整注入为四期项」。修复见 `ShizukuBridge` + `ShizukuShellServer`：走 `IShizukuService.Stub.asInterface(Shizuku.getBinder()).newProcess(...)`（`Shizuku.newProcess` 在 13.x 已私有化且计划于 API 14 移除，但其实现只有这一行），应用侧轮询 `<engineRoot>/shz/request` 执行后写 `response`，引擎内用生成的 `bin/shz` 闸门脚本调用 |
| N | 插件更新不会到达老设备 | 只重装 APK 后，界面仍是旧插件（Shizuku 卡片的「请求授权」按钮、`priv-hint` 提示块全都不出现），必须手工 push 才生效 | `RuntimeInstaller.isComplete()` 的锚点 5 只判 `kxxy-host/package.json` 存在，而那个文件**从 v0.1.0 起内容就没变过**；`runtimeVersion` 戳也不变，于是七锚点全通过、永不重装。修复：新增锚点 8，按插件入口 `kxxy-host/lib/index.js` 首行的版本标记 `kxxy-host@N` 判定过期（与锚点 6/7 同一手法）。**约定：改动 `plugins/kxxy-host/` 下任何文件后，必须递增 `lib/index.js` 首行标记并同步 `RuntimeInstaller.HOST_PLUGIN_MARKER`**，否则老设备不会自愈。后来 office 资产（wasm 引擎 + CJK 字体）与内置的第三方移动端插件又各踩了一次同类坑：它们都是「随 runtime 新增的资产」而 `runtimeVersion` 戳不变 → 再加**锚点 9**（`kxxy-office@N` + wasm 主体 + 两份字体）、**锚点 10**（`kxxy-mobile-plugin@N` + 插件入口与客户端半区）。最后一类是**上游文件**上的补丁（documentpreview 的 `client.js`/`client.pdf.js`、`libreoffice-kit`、`dsh-office-to-pdf`），它们连标记都没有 → 再加**锚点 11**（构建期写入的 `kxxy-patchset@N`） |
| O | 官方前端无移动端适配 | ① 设置面板：411px 视口下面板仅 363px 宽，左侧导航硬吃 188px，右侧内容区只剩 175px，`_rowText` 扣掉 `padding-right:48px` 后标题宽 **0px** → 「选择新会话的默认权限模式」每个字一行、「权限」「语言」竖排、模型卡片「编辑/删除」竖排溢出卡片外；② 左侧栏：展开后主内容列从 355px 被压到 **131px** | 官方是纯桌面布局，**没有断点也没有移动端分支**。① 宽度链是 `panel 363px`（`width:800px; max-width:calc(-48px + 100vw)`）→ `nav 188px`（`flex:0 0 auto`，不可压缩）→ `content 175px`（`flex:1 1 0%`）→ `options` 再扣 `padding:0 24px` 只剩 127px → `rowText` 再扣 48px 归零；② `BynINW_frame` 的 `grid-template-columns: 280px minmax(0px,1fr) minmax(0px,0px)` 由 **React 写死在 inline style**（自定义属性全为空、官方样式表里 0 命中），它就是硬挤第二列，没有「覆盖层」概念。**第一版修法（已废弃）**：自研插件侧适配层 `plugins/kxxy-host/web/mobile.css` + `mobile.js`，注入到 `</head>` 之前（必须晚于官方样式表）；设置面板改为「顶部横向 tab 条 + 全宽内容」，左侧栏做两态（折叠态整栏收掉、展开态覆盖式抽屉）。四条硬约束当时逐条踩出来，**结论仍然有效**：① 第一列压到 0px 靠 `!important`（官方把列宽写在 React inline style 上，inline 无 `!important` 时 CSS `!important` 可胜出）；② 抽屉必须 `position:absolute` 而非 `fixed` —— 祖先链上有 `z-index:40` 的 static 容器，`fixed` 会输掉层叠竞争，症状是「测量全对但整块不可见」；③ 侧栏脱流后 `centerCol` 必须显式 `grid-column: 2`；④ 隐藏必须用 `visibility` 而不是 `display:none` —— 官方开合按钮在列内，`display:none` 会让整棵子树退出渲染、按钮一起消失，用户永久失去唯一入口。**最终解法：整体删除自研适配层、恢复官方原本 UI，改为内置第三方插件 `dsh-web-mobile`（见缺陷 AA）** —— 它是标准客户端插件而非注入样式表，覆盖弹层/状态栏/软键盘等更多场景，且由上游维护 |
| P | 「跟随系统」外观恒为深色 | 系统是浅色，app 里「外观 → 跟随系统」却始终渲染深色；切系统深浅色完全没反应 | 官方前端与控制台**都只判 `matchMedia('(prefers-color-scheme: dark)').matches`**（`ui-theme` 的 `buildSnapshot()` 里 `resolvedId = preference === "system" ? (media?.matches === true ? "dark" : "light") : preference`；官方三份 CSS 里 `prefers-color-scheme` 命中数为 **0**，暗色块只挂 `body[data-ds-dark-theme]`）。而 Android WebView 的该媒体特性**不看系统 `Configuration.uiMode`，只看宿主 Activity 主题的 `android:isLightTheme`** —— 本 app 的 `Theme.Kxxy` parent 是 `Theme.Material.NoActionBar`（深色），`isLightTheme=false`，于是恒报 dark。实测探针（改完强制重启，系统 night=no / yes 两次）：`prefersDark=true prefersLight=false rootColorScheme=normal` **两次完全相同**。修复：`values/themes.xml` 的 parent 改为 `Theme.Material.Light.NoActionBar` + 新增 `values-night/themes.xml`（深色 parent，窗口色与原值逐字节相同），另建 `values/colors.xml` 与 `values-night/colors.xml` 供 `MainActivity` / `BootstrapActivity` 取窗口色与启动页文字色（原先两者都硬编码 `0xFF0B0D13` 等） |
| Q | 控制台终端页浅色下配色错配 | 浅色主题下终端卡片里嵌着一张**纯白**的「终端 Shell 诊断」卡，底部六个快捷键按钮**白底浅灰字**几乎不可读 | 终端容器把底色**硬编码**成深色（`.terminal-container` `#151517`、`.terminal-bar`/`.terminal-shortcuts` `#1b1b1c`、`.terminal-viewport` `#101012`、`.terminal-code` `#D1D5DB`，注释还自承「终端保持深色（终端惯例）」），而内部文字与按钮用的是**语义变量**（`.terminal-title` 用 `--text-muted`、`.term-key` 用 `--bg-card` + `--text-secondary`）。浅色主题下这些变量翻成「深灰字、白底」，画在深底上就出现上述两个症状。修复：引入 `--term-surface` / `--term-chrome` / `--term-viewport` / `--term-fg` / `--term-key-bg` / `--term-key-fg` / `--term-border` / `--term-shadow` 一组变量，浅色段与 `body[data-ds-dark-theme]` 段各给一份取值（深色值与原硬编码逐字节相同，零回归）；另给 `.shell-diag-card` 加外边距并抬到 `--bg-elevated` 一层，使其读作「终端内部的独立面板」而不是「嵌进去的补丁」。顺带修掉该诊断卡的**误导性判据**：它原先只判 `cached.startsWith(engineRoot + '/')`，于是引擎 `bin/` 下的任何可执行文件都算「✓ 缓存有效」—— 设备上缓存着 `…/engine/bin/cmd`（那是 Android 的 `cmd` 服务工具，`cmd --help` 报 `Can't find service`，根本不是 shell），卡片却显示有效。现收紧为「必须是已知 shell 的可执行文件名」，并把标题改为「终端 Shell 缓存」+ 说明「官方当前版本已不读该缓存」 |
| R | 旧 ROM WebView 把非特殊协议的 authority 折进 pathname | 右侧栏「工作区文件」里点开 html / 图片 / 任意文件，预览区恒显示「文件资源服务不可用」（重试无效，文件树本身正常）；子代理聊天标签页也打不开 | Android WebView 104 的 `URL` 解析器**不承认非特殊协议（http/https/ws/wss/ftp/file 之外）的 `//authority` 形式**，把 authority 整段折进 pathname：`new URL('dsh-resource://file/session/abc/whale.html')` 在 104 上得到 `hostname=""`、`pathname="//file/session/abc/whale.html"`，规范值是 `hostname="file"`、`pathname="/session/abc/whale.html"`（本机 Node v24 实测对照；`https://file/…` 这类特殊协议在 104 上是对的）。后果链：`dsh-client-resources` 的 `protocolOf(address)` 写的是 `parsed.hostname === "" ? void 0 : parsed.hostname.toLowerCase()` → 恒 undefined → `providerOf()` 找不到已注册的 `file` provider（真机探针实测 `providers=[subagentchat,plan,file]`，注册本身没问题）→ `ResourceRegistry.create()` 建出 `status:"none"` 的记录 → `TextPreview` 渲染 `t("resourceUnavailable")`。同一缺陷还打断 `dsh-client-ui-subagent` 的 `parseSubagentChatAddress`（`url.hostname.toLowerCase() !== "subagentchat"` 恒真）与 `dsh-client-ui-sidebar-right` 的 `pathOf`（返回 `"//file/session/…"`）。修复在 `compat.js`：**行为探测**（`new URL('x-dsh-probe://host/p').hostname !== 'host'`）后包一层 `URL.prototype` 的 `hostname`/`host`/`pathname` 取值器，从折进来的 `//authority` 反推三个分量。四条硬约束：① 必须探测式触发，已支持的环境原样不动；② 只包 getter、原样保留 setter（`href`/`protocol`/`search`/`hash` 在 104 上本就正确，不动）；③ **必须排除特殊协议** —— `file:////x` 在 104 与规范上都是 `host=""`、`path="//x"`，不排除就会把本来正确的地址改坏；④ 空 authority（`dsh-resource:///file/x`、`dsh-resource://`）要按规范剥掉分隔斜杠，不能当成 host |
| S | 官方终端提示符不显示当前目录 | 终端打开只显示 `bash-5.3$`，看不出自己在哪个目录 | 上游终端走 `dsh-api-terminal-controller` → `dsh-subprocess-local`：`spawnTerminal` 只传 `env = { DSH_SESSION_ID }`，随后 `prepareShellActivity` 生成临时 rcfile 并以 `bash --rcfile <临时文件> -i` 启动。那个 rcfile 的**第一行**是 `[[ ! -r ~/.bashrc ]] || builtin source ~/.bashrc` —— 这正是上游留给用户自定义提示符的**正式挂点**；但 `$HOME` 下原本没有 `.bashrc`，bash 于是回落到内置默认提示符 `\s-\v\$`。修复：宿主在 `EngineSupervisor.ensureDirs()` 里调 `EngineConfig.ensureUserShellInit()`，写一份首行带 `# kxxy-shell@1` 标记、内容为 `PS1='\w\$ '` 的 `$HOME/.bashrc`（`\w` 会把 `$HOME` 缩写成 `~`，会话工作区显示为 `~/workspaces/<name>`；不用颜色，浅色/深色两套终端主题下都可读）。**绝不动用户资产**：文件已存在且首行不带标记时直接返回，内容一致也不写盘 |
| U | 外链拦截把预览 iframe 的 `blob:` 导航当成外链劫持 | HTML 预览**整片空白**（缺陷 T 修好 `Iterator` 后仍然空白，且没有任何错误文案）；PDF 预览正常。logcat 里只有两行：`external url intercepted: blob:http://127.0.0.1:3080/…` 与 `START u0 {act=android.intent.action.VIEW dat=blob:}` | `MainActivity` 的 `shouldOverrideUrlLoading` 只放行 `http://127.0.0.1:` / `http://localhost:` 前缀，其余一律 `startActivity(ACTION_VIEW)` 交给系统浏览器并返回 `true`（本意是「用户点外链就离开应用」）。而 HTML 预览是宿主侧 `createHtmlDocument(bundle)` 拼出 bootstrap 文档 → `URL.createObjectURL(new Blob([html], {type:"text/html"}))` → 塞进预览 iframe 的 `src` —— 这次导航是**子框架**且 scheme 为 `blob:`，被上面的判据命中后导航被取消、系统收到一个无法处理的 `blob:` VIEW intent。修复：拦截前先判 `request.isForMainFrame`（子框架一律 `return false` 放行），并把 `blob` / `data` / `about` / `javascript` 四个非网络 scheme 显式放行。**这条必须放在 `http://127.0.0.1:` 判据之前** —— 否则子框架请求会先被外链分支吃掉。定位手法：症状是「PDF 好了、HTML 还是空白」，直觉会继续往 WebView 兼容层里找，但真正有信息量的是 **logcat 全量**（而不是 `-s KxxyMain:D` 过滤后的那几行）——`external url intercepted` 这行本身就写在宿主里，一眼可见 |
| T | 旧 ROM WebView 缺现代 JS 内建（且 blob 作用域是**独立全局**） | 右侧栏「工作区文件」里点开 HTML 预览整片空白、点开 PDF 显示「PDF 渲染进程无法继续，请重试」；**同一 slot 崩溃会让所有格式一起预览不出来**（缺陷 R 修好后 html 仍空白的原因） | 两个独立缺口叠加。① **内建缺失**：DSH 前端按现代 Chrome 编写，104 缺 `Iterator` / `AsyncIterator` 全局（122/124）、`Map.prototype.getOrInsertComputed`（140 提案）、`Promise.withResolvers`（119）、`Set.prototype.union` 等（122）、`toSorted`（110）、`Uint8Array.fromBase64/toHex`（130/133）—— 真机上按「修好一个才暴露下一个」的顺序逐个炸：先是 pdf 解析器的 `v` 标志正则 `SyntaxError`（构建期补丁改写为 `u` 模式），再是 `ReferenceError: Iterator is not defined` 让 `sidebar.right.tab.document` 这个 slot 整个崩溃（所有格式一起空白）。② **作用域够不到**：PDF 渲染 worker 与 HTML 预览 iframe 都跑在 `blob:` 地址的**独立全局**里 —— pdf.js 6.3.289 把自己的 worker 源码当字符串常量内联进 bundle，再 `URL.createObjectURL(new Blob([...], {type:"text/javascript"}))` 成 module worker，其模块求值**第一行**就是 `"function"!=typeof Iterator.prototype.join&&(Iterator.prototype.join=…)`，于是 `worker.addEventListener("error", workerFailed)` 接住 ReferenceError，界面只剩「渲染进程无法继续」；HTML 预览同理（宿主拼 bootstrap 文档 → `createObjectURL` → iframe 里 `document.open/write` 用户 html）。`<head>` 注入的 `compat.js` 对这两个作用域**完全无效**，而报错只出现在 logcat 的 `blob:` URL 行上。修复：新增 `plugins/kxxy-host/web/modern.js`（独立资产、独立标记 `kxxy-modern@N`、锚点 6 的第二段判定），两步走 —— ① 在页面主作用域补齐全部缺口；② 包装 `URL.createObjectURL`，在**建 URL 之前**把同一份补齐源码**前置**到 script 类与 html 类 blob 的内容里（`new Blob([源码, 原 Blob])` 同步且廉价，Blob part 允许是 Blob，不会立即读字节）。三条硬约束：① 补齐实现必须**完全自包含**（它的源码文本经 `Function.prototype.toString()` 注入 worker，引用本文件作用域里任何变量都会在真机上只表现为「渲染进程无法继续」而本地零报错）；② HTML blob 的前置片段**必须自带 `<!doctype html>`** —— 原文档的 doctype 被顶到第二位会被解析器忽略，文档掉进 quirks 模式；③ 前置片段内不得出现裸 `</script`，否则提前闭合 HTML blob 的 script 标签 |
| V | 旧 ROM WebView 缺 `ArrayBuffer.prototype.transferToFixedLength` | PDF 预览「能打开」但纸张**整片空白** —— 标签、路径、纸张框、缩放控件全正常，无任何错误文案，logcat 里也没有 console 错误 | pdf.js 6.3.289 的字体编译路径 `compileFontInfo` / `compileSystemFontInfo` 结尾是 `assert(c <= o.byteLength, …); return o.transferToFixedLength(c)` —— `transferToFixedLength` 属 Chrome 114 的 `ArrayBuffer.prototype.transfer` 家族，104 上没有。它抛出的 `UnknownErrorException` **只走 worker 出站流，主线程完全看不见**：`executeOperatorList` 在 `index=1` 等 `g_d0_f1` 这个 `dependency` 对象，而 `commonObjs` 里永远不会有它，于是 `return i` 静默挂起（既不报错也不继续）；与此同时 `lastChunk` 又因为收到 ERROR 流被置真 → `_next()` → `endDrawing()` 把空 canvas 交出去 → 界面「成功但空白」。真机取证靠三件事：① 在 `compat.js` 尾部挂探针转储 C2D 调用序列，只有 `fillRect`（铺背景）+ 三次 `measureText`（TextLayer）+ `drawImage`（endDrawing 合成），**零 `beginPath` / `fill` / `fillText`**；② 转储 worker 出站流，看到 `stream=5`（`StreamKind.ERROR`）带 `name=UnknownErrorException message=o.transferToFixedLength is not a function`，而同一 worker 此前刚发过 `stream=8 … success=true`；③ operatorList 本身正确（`FN=9 [beginText, dependency["g_d0_f1"], setFont, moveText, showText, …]`），证明问题在对象池而非算子生成。修复在 `modern.js`：补 `transfer` / `transferToFixedLength` 两族（TypedArray 与 ArrayBuffer，返回同类型新视图/新缓冲、照抄 `min(srcLen,newLength)` 字节，并用 `structuredClone(buf, { transfer: [buf] })` 尽力分离原缓冲）。**单测陷阱**：`vm.createContext` 出来的新 realm 里没有 `structuredClone`，必须 `vm.createContext({ structuredClone })` 显式注入（等价于浏览器 104 原生存在），否则单测会在「宿主没有」这件事上假失败 |
| W | 旧 ROM WebView 不支持 `@scope` | csv / xlsx 预览「能打开但显示错误」：表格**塌成一列**，列头与数据挤在一起 | excel 预览把 50,018 字符的 fortune-sheet 样式表整段包进 `@scope ([data-excel-preview]) { … }`（`const scopedStyles = \`@scope ([data-excel-preview]) { ${index_css_default} }\``）。`@scope` 是 Chrome 118 特性，104 的 CSS 解析器**把整块丢弃且不报错** —— 真机探针实测 `scope_plain` / `scope_bare` / `scope_to` / `container` / `starting_style` / `has_sel` 全为 **0**，而 `media` / `supports` / `layer` / `is_sel` / `where_sel` / `nesting` 为 1；页面上真实样式表 50,018 B 而 `cssRules.length === 0`。修复在 `compat.js`：新增 `expandScopeBlocks` / `matchBrace` / `scopeRootOf` / `scopeSelector` / `expandScopeBody`，把 `@scope (root) { body }` 展开成「root 前缀化的普通规则」，并递归穿透 `@media` / `@supports` / `@layer` / `@container`（`@keyframes` / `@font-face` / `@page` / `@property` 内部原样保留，prelude 与 `{` 之间的空白也原样保留）。端到端 50,018 → 60,029 字符、无残留 `@scope`、未加前缀规则 0 |
| X | Office 预览在 Android 上完全不可用（四重门禁叠加） | 点开 docx / pptx / odt 显示「读取失败：Office 预览不可用。请在运行 DeepSeek Harness 的主机上启用文档预览服务。」 | 官方 office 链路是 `客户端 provider → remote.officeToPdf.render → @deepseek-ai/dsh-office-to-pdf → @deepseek-ai/libreoffice-kit → 引擎包`，这条链上有四道只认桌面平台的闸门：① `libreoffice-kit` 的 `platformTarget` / `resolveEngine` 三处 `if (platform !== "linux")` 直接把 android 判死（android 上 `report().header?.glibcVersionRuntime` 为空，`platformTarget` 本就返回 `void 0`）；② `dsh-office-to-pdf` 的扩展名白名单只认 `doc/docx/xls/xlsx/ppt/pptx`，`odt` 连门都进不去（底层 `CONVERSION_FORMATS` 其实完整支持 ODF）；③ 客户端 office provider 的 `extensions` 同样不含 odt/ods/odp；④ `libreoffice-kit` 的 `systemFontDirectories()` 在 android 上返回 XDG 目录（`/usr/share/fonts` 之类），一个都不存在 ⇒ 必须显式配 `fontDirectories`。四道闸门全部由构建期补丁打开，并新增**阶段 6.5**：从 npmmirror 拉 `@deepseek-ai/libreoffice-kit-wasm@0.1.1`（145 MiB，**必须锁 0.1.1** —— `readEngine` 会拿 `ENGINE_VERSIONS.wasm` 校验版本，0.2.0 直接抛「incompatible or incomplete manifest」）与 `@expo-google-fonts/noto-sans-sc@0.4.4`（取 400Regular / 700Bold 两份真 TTF），直接塞进 `asarPart` —— **不能走 `assemble.mjs` 的平台过滤**，因为该包 `package.json` 写着 `"os": ["linux"]`，会被 `isPlatformSpecific` 挡掉；写进 zip 前还要 `delete pkgJson.os`，否则设备上 `require.resolve` 抛 EBADPLATFORM。最后由 `EngineConfig.overlayContent()` 注入 `office-to-pdf.config.fontDirectories`（patch 语义是**整体替换** config，所以那一行必须重述全部 key）。**为什么不能直接用设备 `/system/fonts`**：安卓 13 上唯一含完整 CJK 的是 `NotoSansCJK-Regular.ttc`，而 wasm 后端会把 `.ttc` 字体集合里的 face 导出成**无字形的 Type1 空壳**（descriptor 用 `/FontFile`、`/Encoding` 全是 `dup N /cidNNNNN put`、**无 `/CharStrings` / `/sfnts` / `/Subrs`**），pdf.js 据此建不出 `toFontChar` ⇒ 把 code 当 ASCII 画；单文件 `.ttf` 才被正确嵌入为 `/FontFile2`（A/B 真机实验：同一 docx，字体目录只放单文件时 4 个 Font 全 `Subtype=TrueType` + `/FontFile2`，掺入 `.ttc` 后立刻出现 `EAAAAA+NotoSansCJKhk-Regular` + `/Subtype=Type1` + `/FontFile`）。**PDF 转换本身在设备上完全可行**：wasm 模块加载 1.37 s、docx → PDF 约 4.2–5.3 s、RSS 约 400–715 MiB（设备 MemAvailable 2.6 GB）；硬约束是必须设 `TMPDIR`（否则 `mkdtemp` 落到 `/data/data/com.termux/files/usr/tmp` → ENOENT）、`render` 要求输入输出都是**绝对路径**且输出目录**已存在**（否则 `ENOENT: … open '…/out/x.pdf'`）、输出文件已存在抛 `EEXIST` |
| Y | 旧 ROM WebView 缺 `Math.sumPrecise`（Office 字形错位） | docx / pptx 装上 CJK 字体后中文恢复正常，但**部分字符被画成别的 ASCII 字形** —— 源文 `Office` 渲染成 `O f ce`、`器等软件的打开效果` 渲染成 `！" 件的 # $ % &`、列表项变成 `' ( ) * +`、表格 `项目` / `数值` 变成 `3 4` / `5 6` | `Math.sumPrecise`（Chrome 138 提案）在 `pdf.worker.mjs` 有 **5 处**调用，**全部在重建字体表的路径上**：`Glyph.prototype.getSize()`（`Math.sumPrecise(this.glyphs.map(g => g.getSize() + 3 & ~3))`）、`CompositeGlyph.getSize()`、以及 `nameTable` 的三处 `exactLength`。104 上它不存在 ⇒ pdf.js worker 的 `checkAndRepair` 在重建 `glyf` / `loca` / `name` 表时抛 `TypeError` ⇒ **整个字体修复中断** ⇒ `FontFaceObject.missingFile === true`、`toFontChar` 为空 ⇒ 主线程 `_charToGlyph` 里 `let isInFont = this.toFontChar[charcode] !== undefined; fontCharCode = this.toFontChar[charcode] \|\| charcode;` 退化成 `fontCharCode = charcode`（正常路径下 `toFontChar[charcode]` 是 `nextAvailableFontCharCode++` 分配的私用区码点，浏览器拿它去匹配 `createCmapTable` 重建的 cmap）。**定位手法（可复用）**：先用 MuPDF 证明「PDF 本身完全正确」（`page.get_text()` 与渲染逐字一致，`page.get_fonts(full=True)` 显示四个字体都在），再用同一份 pdf.js 6.3.289 在 Node/V8 上跑差分 —— Node 每次运行报 **4 次** `Warning: TypeError: Math.sumPrecise is not a function`，次数正好等于字体数；手工补上后 4 个字体立刻全 `missingFile=false`（且 `dependency` id 从 `f1/f3/f4/f6` 变成 `f1/f2/f3/f4`，证明算子列表本身也变了）。修复在 `modern.js`：按提案实现 Neumaier 补偿求和（`compensation += (Math.abs(sum) >= Math.abs(v) ? (sum - t) + v : (v - t) + sum)`），空集返回 `0`，非可迭代或含非数字抛 `TypeError` |
| Z | epub / zip 官方没有任何渲染器 | `电子书.epub` 与 `archive.zip` 都显示「该格式文件暂时无法预览」（unsupported 空态） | 官方 66 个 client bundle 里 `ctx.documentPreviews.register({...})` 只有 8 处（text / markdown / html / image / pdf / code / office / excel），**epub 与 zip 都不在其中**：`zip` 被列进 `UNVIEWABLE_BINARY_EXTENSIONS` 走 unsupported 空态；`epub` 连黑名单都没进（全 bundle 对 `"epub"` / `.epub` / `epub+zip` 的严格字面量命中数都是 0，仅有的 4 处大小写不敏感命中全是 `"republishing"` 子串或 base64 图片噪声）⇒ 落纯文本兜底，把 ZIP 二进制当文本读。而**浏览器侧任何 bundle 都没有 ZIP 解压能力**（全量扫 `fflate` / `DecompressionStream` / `inflateRaw` / `unzipSync` / `jszip` / `PK\x03\x04` 全部零命中）。修复：构建期补丁把 `tools/prebuilt/documentpreview-archive/providers.js` 注入官方 `client.js`（插在 `exports.apply = apply;` 之前，模块作用域内可直接复用上游已 `require` 的 `react` / `react_jsx_runtime` / `_deepseek_ai_dsh_client_ui_primitives`），并在 `apply$3(ctx)` 之后追加一次 `kxxyArchiveApply(ctx)`。片段自带：手写 ZIP 中央目录解析器（从尾部 66,000 字节内找 EOCD `0x06054b50`，支持 ZIP64 的 EOCD 定位器 `0x07064b50` 与扩展字段 `0x0001`；**只读目录 + 按需解单条**，不一次性全解）、`DecompressionStream("deflate-raw")` 解压（真机实测 104 原生支持 `deflate-raw` / `deflate` / `gzip`）、EPUB 的 `META-INF/container.xml` → OPF → spine 解析，以及把章节内的图片/样式**内联成 data URI**（sandbox 帧是不透明源，`blob:` 子资源在那里取不到）。全部标识符带 `kxxy` 前缀 —— 目标是 26 万字符的扁平 bundle 作用域，不加前缀极易撞名。**为什么用构建期补丁而不是运行时注册**：`__ModuleLoader__` 在 `compat.js` 的注入点（`<head>` 开头）**尚未定义**（真机探针实测 `ML=undefined BOOT=none`），它是 `dsh-client-modules.js` 求值后才挂上的；`create(options)` 在 boot 后调用会抛「called after module-system boot」；而全 bundle 没有任何暴露 cordis 根 ctx 的全局（`globalThis.__DSH_*` 只有 4 个：`__DSH_BOOT__` / `__DSH_BOOT_READY__` / `__DSH_CODE_ICON_INSTANCE__` / `__DSH_TRANSPORT__`）⇒ 从页面外部拿不到 `ctx` 去调 `ctx.documentPreviews.register` |
| AA | 自研移动端适配层与官方 UI 冲突，改为内置第三方客户端插件 | 缺陷 O 的第一版修法是**注入 CSS**（`mobile.css` + `mobile.js` 打进 `</head>`），能治「设置面板挤压」与「侧栏遮挡」两件事，但覆盖面有限（弹层、状态栏安全区、软键盘顶起、触控目标尺寸都要自己补），且每处规则都靠 `[class*="语义名"]` 匹配官方运行时类名，官方一升级就可能失效 | 根因是**选错了扩展点**：官方前端本来就是可插拔的（`dsh-client-modules` 会扫 Loader entries，对每个声明了 `package.json` → `dsh.client.platform === "web"` 的包，把它的 `exports["./client"]` 挂进页面 module 图），所以正确的做法是**写一个客户端插件**，而不是从外面往里灌样式。修复：① **整体删除**自研适配层 —— 删 `android/app/src/main/java/app/kxxy/AdaptLayer.kt`（466 行）、`plugins/kxxy-host/web/mobile.css`（16,080 B）与 `mobile.js`（10,816 B）、`plugins/kxxy-host/lib/index.js` 里的 `mobileCss()`/`mobileScript()`/`injectMobileUi()` 与 `ctx.webServer.tapIndex(injectMobileUi)`，以及 `RuntimeInstaller` 的锚点 9（`kxxy-mobile-ui@N`）；② 新增**阶段 6.6** 从 npmmirror 拉 `dsh-web-mobile@3.1.0`（`unpackedSize` 4,159,505，209 文件）整包解进 `lib/node_modules/dsh-web-mobile/`，并在包内写一份 `plugin.version`（内容 `kxxy-mobile-plugin@1`）作为**锚点 10** 的探针；③ `patchDshManifest` 除 `kxxy-host` 外再写一行 `dsh-web-mobile` 进 `@deepseek-ai/dsh/package.json` 的 `dependencies` —— **这一步是决定性的**：`dsh-app-boot` 的 `collectInstallationScopePackages()` 从该 manifest 出发 BFS `dependencies` + `peerDependencies` 产出 installation scope，**只有进了 scope 的包才会被 `routeScoped` 判成 `{kind:"interception"}`**；漏掉它的话插件文件全都在设备上，但永远不产生 Loader entry，`dsh-client-modules` 扫不到，表现与「没打包」一模一样；④ 先按 `EngineConfig.overlayContent()` 的 `insert:` 列表补一行 `- id: dsh-web-mobile` / `name: dsh-web-mobile`（**不是**加进 `plugins/kxxy-host/cordis.patch.yml` —— kxxy-host 本身不是 profile bundle，那个文件在设备上根本没被加载，真正生效的一直是 `--patch android-overlay.yml`）—— **但这一步真机验收时被证明不够**：插件能跑，官方「插件」页却完全不显示它，用户仍然以为没装上；最终改为**登记进 profile manifest**（`EngineConfig.ensureProfileManifest`），并撤掉 overlay 那一行以免重复注册，详见缺陷 AB。三条硬约束：① 客户端半区通过 `package.json` 的 `dsh.client` **声明**被发现，不是通过 `cordis.patch.yml`（后者只让宿主 Loader 里有一行，且宿主半区可以是空 `apply`）；② `exports` 必须给出 `./client`，否则 `dsh-client-modules` 直接抛 `declares dsh.client but exports no "./client" bundle`；③ 内置第三方插件的整包必须**原样**落盘（含 `lib/client.js` 814,043 B 的预构建产物），构建期不重新打包 —— 它的客户端 bundle 是自研打包器（`scripts/build-client.mjs`）的产物，`require()` 的 56 个相对模块 + 3 个外部名（`react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`）都依赖那个打包格式 |
| AB | 内置插件只在 overlay 里 insert 时，官方「插件」页完全不显示它 | 插件确实在运行、移动端布局也已生效，但侧栏「插件」页只有「官方 8」一段，**没有「已安装」分组**；用户据此判定「根本没装进去」（插件页截图里 `dsh-web-mobile` 完全不出现） | 官方「插件」页（`dsh-client-ui-plugin-manager`）「已安装」分组的数据源是 `pluginManager.listBundles()`（`dsh-plugin-manager/lib/index.js:1456`）：名单 = profile 的 `dsh.profile.bundles` ∪ profile `dependencies` ∪ 安装锚点（`@deepseek-ai/dsh/package.json`）的 `dependencies`，其中 **`installed` 判据是「名字出现在 profile 的 `.dependencies` 里」、`enabled` 判据是「出现在 `dsh.profile.bundles` 里」**；解析不到 `dsh.bundle` 的包只有 `enabled` 为真时才以 `error.code = "not-bundle"` 入列。客户端再过滤一遍（`dsh-client-ui-plugin-manager/lib/client.js:3342`）：`!BUILTIN_PROFILE_BUNDLES.has(name) && (installed || optional || error)`，`:3343` 的 `mine = listed.filter((pkg) => pkg.installed || !pkg.optional)` 就是「已安装」。而上游 `dsh-app-boot` 的 `initProfile`（`dsh-app-boot/lib/index.js:26125`）**只在 `package.json` 不存在时才写模板**，设备上 profile 早已存在 ⇒ 永远不会被改写，只靠 overlay insert 的 Loader entry 在页面上完全不可见。修复：新增 `EngineConfig.ensureProfileManifest(ctx)`（`android/app/src/main/java/app/kxxy/engine/EngineConfig.kt:320-368`），由 `EngineSupervisor.ensureDirs()` 调用，**读-改-写** `$HOME/profiles/web/package.json`：`dependencies` 补 `"dsh-web-mobile": "3.1.0"`、`dsh.profile.bundles` 补 `"dsh-web-mobile"`，并**撤掉 `overlayContent(ctx)` 里与之重复的 insert 行**（否则同一插件被注册两次）。一条硬约束：**绝不能整体覆盖该文件** —— 用户通过插件页自装的插件写在同一 `dependencies` 里，覆盖会抹掉用户插件；只做「确保存在」式补写 |
| AC | 旧 ROM WebView 不支持 `:has()`（Chrome 105） | 内置插件 `dsh-web-mobile` 的样式表在真机上被解析器**成片丢弃** —— 278,723 字符的表只解析出 **39 条**顶层规则，设置面板仍是桌面两栏布局、「权限」「语言」「字号大小」逐字竖排，症状与缺陷 O 一模一样，极易误判成「插件根本没装上」 | 真机探针：`CSS.supports('selector(div:has(span))')` 为 **false**，注入三条规则只有不带 `:has()` 的那条存活；插件表里 `:has(` 出现 **301** 次，遍历 CSSOM 得到的 `selectorText` 含 `:has(` 的规则 **0 条**。修复：在 `compat.js` 里把 `:has(X)` 于 **CSS 文本层**改写为属性选择器 `[data-kxxy-has~="hN"]`（按实参特异性重复若干次以补齐权重），再用 `MutationObserver` 在真实 DOM 上维护标记 —— 由子代/兄弟/后代三种前导分别精确求值（`E:has(A B)` ⇔ E 是匹配 `A B` 元素的祖先；`E:has(> A B)` 再用 `:scope >` 验证；`+`/`~` 走 `previousElementSibling`；`:not(:has(X))` 必须精确故一律回落到 `matches()` 过滤）；递归进 `@media`/`@supports`/`@layer`/`@container`，`@keyframes`/`@font-face` 内部原样保留。修后真机复测：`rewrittenTags=17`、插件表 `remainHas` 从 **301 降到 22**、注入标记 **339 个**、**27 个元素**带标记、CSSOM 里 **189 条**规则恢复生效，设置面板变成移动端布局。**中途踩的最深的坑**：垫片里调用的 `matchParen` **从未定义**（全文 5 处调用、0 处定义），首次调用即抛 `ReferenceError`，而 `patchAllStyles()` 没有任何异常隔离 ⇒ 异常冒泡把 `observeStyles()` 一起带崩，**整层 CSS 改写（包括 v0.1.6 已验收过的 `dvh` 与 `@scope`）全部静默失效**；补上 `matchParen` 并给 `patchStyleTag` 加 `try/catch` 后才恢复。三条可复用教训：① 探针必须 `setTimeout` **延时**（15 s / 30 s）才看得到插件 append 之后的样式表，同步探针读到 `styleTags=0` 是假阴性；② 一个未定义标识符足以让整层适配静默失效，「改了没效果」要先去查有没有异常，而不是先怀疑选择器写错；③ Android WebView 未开 `setWebContentsDebuggingEnabled`、`onConsoleMessage` 又收不到未捕获异常 ⇒ **logcat 干净不能证明没有 JS 报错** |

| AD | 内置插件的 CSS 锚点锁死在宿主**旧代** class hash 上 | 对话界面右上角**多出一个侧栏图标** —— 插件自己的「文件浏览」按钮与宿主的「打开右侧边栏」按钮**重叠绘制**成一个「文件夹 + 双栏框」的怪图标；「开始」空态页顶栏本该有的三枚按钮**全部消失**。用户 m19951（逐字）：「你看对话界面右上角，我给你发的图片是正常的渲染，怎么现在给到的结果会多一个侧边栏图标呢，还有第二个人界面也不对，是不是插件没完全挂载啊」，随后 m20235 给出正确判据：「这个是我让你内置的插件，按道理插件只要完全生效，这些问题是不会出现的」 | 新版官方前端给每个 CSS module 生成**随机 hash 前缀**（本次为 `Dc7zOa_`），而 `dsh-web-mobile` 是按某一代宿主构建的，选择器里写死了那一代的 hash —— 真机实测插件样式表 **451 条规则里 320 条** `selectorText` 在 DOM 上零命中。其中要命的是插件用来**隐藏宿主 headerCorner** 的那条 `… header:has([class*="_headerLeading"]) [class*="wSkVaW_titleRow"] > [class*="_headerCorner"] { display: none !important }`（`layout.css.ts:2027-2035`，注释明确写着「新宿主把右侧栏入口放进了 titleRow 的 headerCorner，和插件的文件按钮是同一个面板的两个入口」，其**上一代写法** `wSkVaW_titleRow` 与真机的 `Dc7zOa_titleRow` 不匹配 ⇒ 整条失效 ⇒ 宿主按钮没被隐藏，与插件按钮叠在一起）。插件作者自己也知道这批锚点「代际脆弱」——`docs/upstream/compat-contracts.json` 里 28 条契约每条都标了 owner 包名与 `lazy` 标记，另备了一批结构化 marker 作兜底。**为什么不能改成「补样式」**：用户要的是「插件完全生效」，手工补规则只能治眼前这一处，宿主再升级一次又要补；正解是**把插件写死的旧代 hash 在运行时归一化到宿主当前代**。修复：`compat.js` 新增第 4 段（在 `dvh` / `@scope` / `:has(` **之前**）—— `hashScan` 从插件样式表收集旧锚点的**后缀集合**，`hashLivePrefixes` 只从 `style[data-plugin^="@deepseek-ai/"]` 的**宿主样式表**（带完整类名清单，比当前 DOM 全）取候选代，**后缀集合被候选完整包含且候选唯一**才建立映射（模糊宁可不映射 —— 真机上 `QsffPG_root` 有 23 个候选，按设计放弃），随后 `hashRewrite` 把 `[class*="OLD_` 与 `.OLD_` 两种写法一并替换。映射建立后主动调一次 `patchAllStyles()`，并挂 300 ms 去抖的 `MutationObserver`（`attributeFilter: ['class']`，上限 40 轮）跟随宿主渐进渲染。**两个关键细节**：① `hashLivePrefixes()` 必须只认 `@deepseek-ai/` 前缀的样式表 —— 插件自己那张表也带 hash，混进来会把锚点「并到同代」；② 判据用**唯一超集**而非最大交集 —— 只按交集打分会让 `_root` / `_label` 这类常见后缀成群误配。**定位手法（可复用）**：症状是「多出一个图标 / 少了一排图标」，第一直觉会去查插件是不是没挂载；正确的第一步是**把「插件样式表里有多少条规则在 DOM 上零命中」打出来**（探针遍历 `style[data-plugin]` 的 `cssRules` 逐个 `document.querySelector(selectorText)`），再对每条零命中规则提取 `[class*="H_s"]` 里的 `H_s`，按「后缀集合 ⊆ 宿主某个模块的前缀后缀集合」反查 owner 包 —— 一眼就能看出是**整代 hash 全都对不上**，而不是某条选择器写错 |

| AE | 控制台扩展页的信息架构自相矛盾，且展开态每 5 秒被抹掉 | ① 页顶挂着「镜像源加速」卡，而本页扩展**全部**来自 APK 内置包池（每张卡都写着「内置包池 · 零联网」）—— 用户原话：「现在好像完全内置了，上方那个，镜像源加速为我去除……现在没有下载入口，但是又有这个镜像源，这不是很冲突吗？」；②「已激活」分组点开后再看，自己折叠回去了 —— 用户原话：「我展开以后，他会自动折叠，你点击这个展开，他又自动折叠，这不行」 | ② 是纯状态管理 bug：`renderExtensions()` 开头就 `dom.extensionsList.innerHTML = ''` 重建整个 DOM，而 `startPolling()` 每 `POLL_INTERVAL = 5000` ms 调一次 `fetchExtensions()`，展开态只存在 DOM 的 `class="collapsed"` 上 ⇒ 最多 5 秒就被重置。修复：模块级 `const expandedGroups = new Set()` 记住展开的分组 key，渲染时按它决定是否加 `collapsed`，点击时同步增删，并用 `title.classList.toggle('expanded', …)` 驱动 CSS 里的 `▸/▾` 箭头。① 不是 bug 而是**放错了位置**：镜像源的真实用途是给官方插件页的「+ 添加插件」（`ctx.remote.pluginManager.installBundle`）下载第三方插件时加速，它服务的是**对话页**而不是内置扩展页。修法：把整张卡（连同 `#mirror-results`，**id 一个不改**，`host.js` 的 `initMirrorActions`/`fetchMirror` 零改动）搬到「设置」页，扩展页原位换成一句 `.builtin-note-card` 说明「全部内置 · 零联网，要装第三方插件请去对话页侧栏 →「插件」→「+ 添加插件」」。**为什么不是按字面「删除」**：用户原话给了「去除，或者……给我添加一个下载入口」二选一，而下载入口官方**早就有**（`dsh-client-ui-plugin-manager` 的 `installSpecLabel: "包名或地址"` / `installSpecPlaceholder: "例如 dsh-plugin-whale-pet"`），只是它在对话页侧栏而不在控制台 —— 直接删掉镜像源会让那个入口失去加速能力，所以保留能力、消除误导 |
| AF | 控制台「终端」页是伪终端（只是 `engine.log` 的尾巴查看器） | 页面上有 `.terminal-container`、`.terminal-bar`、`.terminal-viewport`、六个快捷键按钮，看起来像终端，实际只能看日志、不能输入 —— 用户原话：「这个控制台的终端界面好像完全没用呀，直接为我去除」 | 该视图的全部能力是 `fetchLog()` 的 `GET /kxxy/api/log` 轮询 + `initTerminalActions()` 的 `term-key` 按钮（`POST /kxxy/api/action {action:'term-key'}`，往引擎 PTY 写一个键），**没有任何输入通道**。真终端在对话页侧栏（官方 `sidebar-terminal`），控制台这个页签只会让人以为「终端坏了」。修复：整体删除 —— `index.html` 的 `data-view="terminal"` 整段与底部 tabbar 的对应按钮、`host.js` 的 `renderAnsi`/`fetchLog`/`scrollTerminalToBottom`/`initTerminalActions`/`prefersReducedMotion` 与 `dom` 表里的五个引用、`host.css` 的整段终端样式（含 16 条 `--term-*` 变量）与 `.shell-diag-card`。**顺带清掉一个只服务于该页签的隐患**：原 `renderShellDiagnostics()` 在发现 `localStorage['dsh.terminal.shell']` 是失效值时，会弹 toast 让用户「到终端页一键清除」—— 页签没了就没有这个入口了，改成 `repairShellCache()` **静默自愈**：判据仍是「值必须在引擎根下且 basename 是已知 shell」，不满足就直接 `removeItem` 并提示已自动清理 |
| AG | 权限卡的长徽章把标题列挤成逐字竖排 | Root 卡的文字**一行一个字**竖直排列（「经 / su / 整 / 体 / 提 / 权 / 启 / 动 / 引 / 擎」），Shizuku 卡却正常 | `.priv-card-head` 是 `display:flex` 且**不换行**，`.priv-badge` 又是 `flex-shrink: 0; white-space: nowrap` ⇒ 徽章宽度完全不可压缩。Shizuku 徽章「不可用 · 未检测到 Shizuku 管理器」在 412px 竖屏下勉强放得下，Root 徽章「不可用 · 未检测到可用的 su（需 Magisk / KernelSU）」更长 ⇒ 徽章把 `.priv-titles` 挤到 `min-width: 0` 允许的最小宽度，中文于是逐字换行成一列。修复：`.priv-card-head` 加 `flex-wrap: wrap`，`.priv-titles` 改 `flex: 1 1 60%; min-width: 8em`，`.priv-badge` 改 `flex-shrink: 1; max-width: 100%; white-space: normal; overflow-wrap: anywhere` —— 徽章先尝试与标题同行，放不下就整块掉到下一行。**合成复现为什么失败、真机探针为什么成功**（可复用教训）：用无头 Chrome 按 412px 宽复现时，旧 CSS 只量到 `titlesW=130.6`，**复现不出竖排** —— 因为合成页面里 `.priv-card` 直接是 `body` 的子元素、吃满了整屏宽度；真机上它嵌在 `.view-pane > .card > .priv-cards` 三层 padding 里，可用宽度只有 **350.2px**。改在真机页面里注入探针（`probe-priv.js`，先切到设置视图再量，因为非激活视图是 `display:none` 会量到 0）才拿到决定性对照：旧 CSS `titlesW=0, titlesH=527, vertical=true`，新 CSS `titlesW=285.2, titlesH=56, vertical=false`。**教训：布局类缺陷的合成复现必须复刻真实容器的宽度链路，否则「复现不出」会被误读成「不是这个原因」** |

| AH | 删页签时漏改底栏列数，留下一个空列 | 底栏右侧多出一块很显眼的空白 —— 用户原话：「现在不是三个板块吗？概览扩展设置为什么之前删除的板块导致右下方有一个很明显的空白？」 | 缺陷 AF 删掉「终端」页时改了三处（HTML 的视图段、HTML 的页签按钮、`host.js` 的五个引用），**漏了第四处**：`.tabbar-inner` 的 `grid-template-columns: repeat(4, 1fr)` 是照着当时四个页签写死的。页签从四个变三个后，网格仍是四列，第四列没有子元素 ⇒ 底栏右侧空出整整四分之一。修复：改成 `grid-auto-flow: column` + `grid-auto-columns: 1fr`，列数由子元素个数决定，以后再增删页签都不会留下空列。**教训（与缺陷 AF 同源）**：这类「删掉一块东西」的改动，真正要清理的是**所有引用它的地方**，而 CSS 里的布局参数最容易漏 —— 它不在 JS 的调用图里，grep 页签 id 也搜不到。同一个删除动作实际涉及四处：视图段、页签按钮、JS 逻辑、**布局网格**。这个 bug 不报错、HTTP 层完全看不出异常、只有肉眼能发现，所以在 `smoke-plugin.mjs` 里补了两条断言把它钉死：① 解析 `index.html` 的 `data-target` 与 `data-view`，数量不等或页签指向不存在的视图就报错；② `.tabbar-inner` 出现 `grid-template-columns: repeat(N,` 就报错，且必须存在 `grid-auto-flow: column` |

| AI | 视频与音频完全没有渲染器，点开只显示「该格式文件暂时无法预览」 | 文件树里 12 种视频（`3gp/avi/flv/m4v/mkv/mov/mp4/mpg/ogv/ts/webm/wmv`）与 17 种音频全部只有 unsupported 空态 —— 用户原话：「查看我现在的手机界面，视频跟音频无法打开，无法预览，给我优化一下」 | 这是**上游能力缺口**（与缺陷 Z 同类，桌面版同样没有），不是 Android 特有：`dsh-client-ui-sidebar-documentpreview` 的 `documentPreviews.register` 只注册了 text / markdown / html / image / pdf / code / office 七种，而 `UNVIEWABLE_BINARY_EXTENSIONS`（65 项）**开头 16 项就是音视频**（`mp4, mov, avi, mkv, webm, flv, wmv, m4v, mp3, wav, flac, ogg, m4a, aac, wma, opus`）⇒ 无候选 + 命中黑名单 ⇒ `candidates` 返回空数组 ⇒ 直接渲染 unsupported 空态。修复分两半：**① 宿主侧新增 `/kxxy/media` 流式路由**（官方 `/api/file` 无 Range/206、全量读进内存、上限复用的是**图片附件上限 20 MiB**，对视频偏小）；**② 客户端注入 video / audio 两个 provider**（`tools/prebuilt/documentpreview-media/providers.js`，与归档 provider 同构）。**WebView 104 解码能力实测**（探针 `[kxxy-media]`）：`video/mp4; codecs="avc1.42E01E"` / `vp8` / `vp9` / `audio/mpeg` / `audio/aac` / `audio/flac` / `ogg; codecs="opus"` 等 13 项 `probably`，`video/mp4` / `video/webm` / `audio/wav` 等 10 项 `maybe`，`mkv/avi/wmv/flv/mpeg/mp2t/quicktime/aiff/midi/amr` 等 17 项 `no` ⇒ **缺的不是解码器，是 provider**。**真实播放验证**：2,848,208 B 的 `sample-5s.mp4` 走 `/kxxy/media` 得 `video-OK dur=5.759 rs=1 seekable=1`。真机验收：`real-sample.mp4` 出播放器（`0:00 / 0:05` + 进度条 + 音量 + 全屏 + 倍速菜单），`silence.mp3` 出音频控件（`0:00 / 0:02`）。**为什么不走 `bytes-complete`**：那条路要先全量下载进内存（受 20 MiB 上限约束）才出画面；新 provider 用 `loading: "renderer"` 模式 —— 该模式**不需要任何字节加载，provider 声明即被自动触发**，只需拿到 `version` 后调一次 `request.loaded(version)` 让 `hasContent` 为真，`<video src>` 直接指向流式 URL。**失败文案必须分开**：`MediaError.code === 4`（`MEDIA_ERR_SRC_NOT_SUPPORTED`）与「文件损坏」是两回事，前者报「当前系统的浏览器内核不支持 `{ext}` 格式」+ 转码提示，后者报错误码；混在一起会让用户对着不支持的容器反复重试 |
| AJ | 扩展包池里的 Termux 绝对路径从未被改写（问题.txt【1】） | 扩展装好之后成批的工具起不来、或指向不存在的目录：`bin/kotlinc` 首行是 `#!/data/data/com.termux/files/usr/bin/env bash`，内核解析 shebang 失败，直接报脚本自身路径的 ENOENT（比「版本不对」更难判断）；`tesseract --list-langs` 报 `No such file or directory ["/data/data/com.termux/files/usr/share/tessdata/"]`；gdb 找不到 Guile 的 Scheme 源；perl 的 `Config_heavy.pl` 里 sysroot 是 Termux 路径 | `normaliseStageFiles()` 只处理 runtime stage（`SCRIPT_TOP_DIRS` 白名单 + 非 ELF + 含 `com.termux` 才改），**扩展包池完全不走它** —— `tools/lib/poolextract.py` 只剥 tar 成员名的前缀（`rel[len(TERMUX_PREFIX):]`），**从不改写内容**。自建扫描器全量实测：runtime.zip 侧只有 19 处命中且 18 处无害（C 头注释 / `libbfd.a` / PyPI 元数据），**ext-pool 侧 1296 处**（texlive 562 / imagemagick 163 / ffmpeg 112 / autotools 72 / gnuplot 70 / tesseract 57 / golang 49 / ghostscript 45 / poppler 44 / exiftool 35 / perl 34 / kotlin 14 / emacs 11 / gdb 10 / sox 8 / qpdf 3 / rust 3 / gradle 2 / mediainfo 2 —— 用户「697 处」的估算偏低）。修法分两半：**构建期**在 `poolextract.py` 的写出循环里做同一套替换（`merged[path]` 已是整块 bytes，在那里改最省事），**跳过 ELF / ar 静态库 / 任何含 NUL 的数据** —— 占位符比原串短，改长度会让节偏移与重定位表整体错位（RUNPATH 优先级低于 `LD_LIBRARY_PATH`，留着无害）；并把被改写的文件清单写进 pool 内的 **`.pool-manifest.json`**（**清单必须随包走**：安装可能在任何一次运行时由用户点「获取」触发，构建期 report 那时早已不在设备上）。**设备端**由 `extinstall.applyPlaceholders()` 在解包后按清单回填真实路径、然后删掉清单（老 APK 没有清单，读不到即静默跳过，不是错误）。另外新增 `@DSH_FILES@` / `@DSH_DATA@` 两条**裸父目录**规则：perl 的 `Config_heavy.pl` 把 sysroot 记成 `-Dsysroot=-I/data/data/com.termux/files`（**不带 `/usr`**），三条长规则一条都匹配不到 —— 重打后仅剩的 3 处残留全是这同一个文件（autotools / perl / exiftool 各带一份）。终局：20/20 pool 清单齐备、合计改写 1285 个文件、文本残留 **0**（跳过 ELF 1629 个） |
| AK | 扩展装完后 `bin/texlive` 是一个空目录，PATH 里一个 TeX 引擎都没有（问题.txt【4】） | 装完 texlive 后 `pdflatex` / `xelatex` / `latex` 全部 command not found；更早的现象是设备上 `bin/texlive/` 里一个文件都没有 | 两层原因叠加。**第一层（写死的实现缺陷）**：`extinstall.buildLinks()` 对 `<extDir>/bin` 只做**一层** `readdirSync` 且**不递归** ⇒ `bin/texlive` 这个**目录**被整体软链成 `engine/bin/texlive`，其下 411 个引擎永远进不了 PATH（`<root>/bin` 是 PATH 的唯一入口）。**第二层（认知陷阱）**：`pdflatex` / `xelatex` / `latex` 在 TeX Live 里**从来不是真实文件** —— 它们是 `texlinks` 从 `pdftex`（2,063,464 B）/ `xetex`（794,176 B）+ `-fmt` 生成的符号链接，上游 `texlive-bin` deb 里就没有，全池 grep 只命中 6 处**文本提及**（`latexmk` / `purifyeps` 的注释）。所以「81 MB 里一个 TeX 引擎都没有」这个判断本身是错的 —— 引擎全都在，是**链接没建、目录进不了 PATH**。修法：`buildLinks` 重写为 `buildViews`，`collectBins` **递归展平**（浅层名字优先拿干净命令名，同扩展内重名退回 `sub_foo` 形态；**先处理文件再下潜目录** —— 反过来的话先递归 `bin/texlive/` 会占掉 411 个引擎名，之后 `bin/` 顶层同名文件拿不到干净名只能被丢弃），同时**保留目录软链**让 `texlinks` / `fmtutil` 这类「按自己所在目录找兄弟程序」的脚本仍工作。**顺带修掉一个完全同型的隐蔽缺陷**：扩展 `lib/` 下的**子目录**（实测 14 个）原本是「目标已存在就跳过」，其中 `pkgconfig`（12 个扩展贡献）、`cmake`（9 个）、`girepository-1.0`（6 个）与 runtime 自带目录同名 ⇒ 同样静默丢内容，现在走同一套递归合并 |
| AL | 扩展的 `etc/` `share/` `opt/` 从不接入引擎根，配置与资源全都找不到（问题.txt【6】） | ImageMagick 找不到 `colors.xml`、Ghostscript 找不到 `gs_init.ps`、Fontconfig 无法加载默认配置 | 原 `buildLinks` **只处理 `bin/` 与 `lib/*.so*`**，`etc/`、`share/`、`opt/`、`sbin/`、`var/` 完全不处理；而所有这些工具在编译期都把前缀写死成单一目录。修法：`buildViews` 新增**合并视图** —— 把各扩展的 `etc/` `share/` `opt/` `sbin/` `var/` 接入 `<root>` 的同名位置，再由 `EngineConfig` 注入 `FONTCONFIG_PATH=<root>/etc/fonts`、`TESSDATA_PREFIX=<root>/share/tessdata`、`GUILE_LOAD_PATH=<root>/share/guile/3.0`、`XDG_DATA_DIRS` / `XDG_CONFIG_DIRS`。**为什么不能是「整目录软链」**（第一版就是这么写的，实测把它推翻了）：① 与 runtime 自带目录同名时（10 处，如 `share/xml`、`share/gettext`、`share/icons`、`var/service`、`etc/bash_completion.d`）整链会把 runtime 的内容**整块遮掉**；② 多个扩展同名时（15 处，如 `etc/fonts` 7 个、`share/aclocal` 10 个、`share/fontconfig` / `share/fonts` / `share/gettext` / `share/xml` 各 7 个）后装者把先装者整棵树遮掉 —— 而这两批恰恰是本任务最需要的（fontconfig 的 `conf.d` 与 tesseract 的 `tessdata` 分属不同扩展，`share/aclocal` 更是 aclocal / freetype2.m4 / guile.m4 / gpgme.m4 各贡献一份）。**递归合并的安全性有实测背书**：同名叶子 583 条、大小**全部一致**、差异 **0** 条 ⇒ 叶子冲突保留先到的无损。代价量化：整目录软链 43 条 → 递归合并 80 条（+37 条），可忽略。实现要点：目标是**真目录**就递归合并；目标是**软链**（前一个扩展整链过来的）必须先 `materialise()` **物化成真目录**、把原主的子项补链回原主的清单 —— **不物化就等于往别人的扩展目录里写，那个扩展一卸载，另一个扩展的配置跟着一起消失**；叶子同名记 `shadowed: true` 而不是静默跳过，这样卸载占位者时 `reclaimViews()` 能把被遮的文件补回来 |
| AM | Java 没进 PATH，PATH 与 `LD_LIBRARY_PATH` 里还留着两条死路径（问题.txt【3】【7】） | `java` / `javac` 直接用不了；kotlinc、gradle 也因为没有 `JAVA_HOME` 而失败；同时 PATH 里有一条永远不存在的目录 | OpenJDK 装在 `<root>/lib/jvm/java-21-openjdk/bin`，没有任何东西把它加进 PATH（问题.txt【3】）。同时 `EngineConfig.buildEnv()` 的 PATH 里有 `<root>/usr/bin`、`LD_LIBRARY_PATH` 里有 `<root>/usr/lib`，而引擎根下**根本没有 `usr/` 这一层** —— Termux 的 `$PREFIX` 本身就是 `files/usr`，我们在打包时把它拍平了，于是这两条成了死路径（问题.txt【7】）。修法：`EngineConfig.javaHome(ctx)` 扫 `<root>/lib/jvm/*` 里第一个含 `bin/java` 的目录并取它（**目录名由 deb 包版本决定，换 Termux 源可能变成 `java-17-openjdk`，不能写死**；实测 `java -version` = `openjdk version "21.0.12"`），把 `<javaHome>/bin` 加进 PATH、导出 `JAVA_HOME`，并删掉两条死路径 |
| AN | rustc 编译任何程序都 `can't find crate for 'std'`（问题.txt【5】） | `rustc --print sysroot` 输出 `/data/user/0/app.kxxy/files/engine`（**引擎根，不是 `extensions/rust`**）；`rustc h.rs` 报 `error[E0463]: can't find crate for 'std'` | sysroot **不是**从 `/proc/self/exe` 推导的（把同一个 ELF 复制到 `$E/tmp/x/rustc`、`$E/tmp/y/rustc` 后仍输出 `$E`），而是**从 `librustc_driver-*.so` 被实际加载所在目录的父目录**倒推：`rustc` 是 prefer-dynamic 构建（`NEEDED librustc_driver-7d7db29c2d20f1e4.so` + `libc.so`，RUNPATH 是无效的 Termux 路径），`LD_LIBRARY_PATH=<root>/lib` 命中 `<root>/lib/librustc_driver-*.so` ⇒ sysroot 被算成 `<root>`。`extensions/rust/lib/` 下**也有一份同样的 78 MB driver**，但那里**没有 `libLLVM.so`**，而 `<root>/lib` 有（`libLLVM.so` + `libLLVM-21.so`，各 133 MB）⇒ 只有 `<root>/lib` 能同时满足 driver 的运行时依赖，绕不开。修法：把 `<root>/lib/rustlib` 软链到 `extensions/rust/lib/rustlib`（实测加之前 `can't find crate for 'std'`，加之后能产出可执行文件并正确运行）。**只软链不够**：rustc 的链接行写死 `-lunwind`，而 `rustlib/…/lib/` 下只有 `libunwind-*.rlib` / `.rmeta`（**没有 `.so`**），真身是 `<root>/lib/libunwind.a`，`ld.lld` 不做 `-lunwind` → `.a` 的隐式匹配 ⇒ 不加 `-L <root>/lib` 就报 `ld.lld: error: unable to find library -lunwind`。**固化方式选 `LIBRARY_PATH`**（`:251`）而不是 `RUSTFLAGS` —— rustc 不读 `RUSTFLAGS`，而 clang 会把 `LIBRARY_PATH` 展开成 `-L`，两头都覆盖。注意软链之后 `--print sysroot` **仍**输出 `<root>`，但 `--print target-libdir` 变成存在的路径，编译正常 —— 别拿 `--print sysroot` 当验收判据 |
| AO | gdb 一启动就 `Fatal signal: Aborted`（问题.txt【5】） | `gdb --version` 退出码 **134 (SIGABRT)**；`--nx --batch -ex quit` 一样 134 | 崩溃栈是 `main → gdb_main → ext_lang_initialization → with_guile → scm_i_init_guile → scm_load_startup_files → scm_primitive_load_path → scm_misc_error → scm_error_scm → scm_ithrow → scm_throw → abort` —— **Guile 扩展初始化失败**：`libguile-3.0.so` 编译期把 Scheme 源的前缀写死成 `/data/data/com.termux/files/usr/share/guile`，真实源在 `extensions/gdb/share/guile/3.0/`（369 个 `.scm`，含 `ice-9/boot-9.scm`），且一个预编译 `.go` 都没有。修法：注入 `GUILE_LOAD_PATH=<root>/share/guile/3.0`（走目录第 AL 条的合并视图，回落到 `extensions/gdb/share/guile/3.0`）。**`GUILE_AUTO_COMPILE` 的取值是实测定的，而且第一版结论是错的**：之前的探针写成 `gdb --version \| head -1`，`head` 读完一行就关管道、gdb 收 SIGPIPE 提前退出、**自动编译循环被中断**，于是缓存里 0 个 `.go` 被误读成「自动编译不落盘」。改成一律重定向到文件、绝不接管道之后，干净 A/B：`AUTO_COMPILE=0` 冷 **225 s** / 热 **238 s**（缓存 0 个 .go）／默认 `1` 冷 **1837 s** / 热 **1494 s**（只写出 4–5 个 .go，369 个源文件里）。⇒ 带它慢 **6–8 倍**且几乎不落缓存、每次启动重复白工，**`=0` 是纯粹收益**。也试过构建期预编译：单进程 `compile-file` 全量 369 个 `.scm` 耗时 **7163 s** 只产出 98 个 `.go`，之后 `gdb --version` 反而要 **197 s**（比不预编译的 146–160 s 更慢）⇒ 预编译路线废弃 |
| AP | Tesseract 只有英文语言包，中文识别直接用不了（问题.txt【5】） | `tesseract -l chi_sim` 报错；`--list-langs` 因编译期 Termux 前缀失效（`No such file or directory ["/data/data/com.termux/files/usr/share/tessdata/"]`） | `extensions/tesseract/share/tessdata/` 下只有 `configs/`、`eng.traineddata`、`tessconfigs/`。**中文包在 Termux 里根本不存在**：对 3011 个包名全量 grep `tessdata` / `traineddata` **零命中**，也没有任何 `tesseract-lang*` 包 ⇒ 只能外部获取。修法：新增**阶段 6.7**，构建期从 `raw.githubusercontent`（原始站优先）下载 tessdata_fast 的 `chi_sim.traineddata`（2,469,156 B，sha256 `a5fcb6f0…`，取 fast 版而非标准版：2.4 MiB vs 40 MiB+）塞进 `asarPart` 的 `share/tessdata/`，配 `EngineConfig` 的 `TESSDATA_PREFIX`，并加**锚点 12**（标记 `kxxy-tessdata@1` + 主体文件存在 + 魔数必须是 `18 00 00 00`，tessdata_fast 的格式标记） |
| AR | TeX Live 装了引擎却一个文档都编不出来：宏包树整棵缺失（问题.txt【4】的第二层） | `pdftex t.tex` 报 `I can't find the format file 'pdftex.fmt'!`（**连 plain TeX 也不行**）；`mktexfmt` 报 `Can't locate mktexlsr.pl in @INC`；`tlmgr` 报 `Can't locate TeXLive/TLConfig.pm in @INC`。设备上 `<root>/share/texlive/2026.0/texmf-dist/` 顶层只有 `bibtex chktex doc dvipdfmx dvips fonts hbf2gf scripts texconfig ttf2pk web2c` —— **`tex/` 与 `tlpkg/` 两棵子树完全不存在**，全池 `.fmt=0 .ltx=0 .cls=0` | **deb 级取证**（`_recon/deb-tex.py` 读 `texlive-bin_1_2026.0-2_aarch64.deb` 的 `data.tar.xz`，1190 条目）：`[probe 'tex/latex']` **0 条**、`[probe 'tex/plain']` **0 条**、`[probe 'tlpkg']` **0 条** ⇒ **Termux 的 `texlive-bin` 只发引擎**，宏包树归 `texlive-installer`（`install-tl` 的包装）从 CTAN 现场下载；Termux 索引里只有 `texlive-bin` / `texlive-bin-static` / `texlive-installer` 三个 texlive 包。**修法**：新增 `tools/fetch-texlive.py` 从 CTAN 取 `scheme-basic`（118 包 / 19.9 MiB xz / 解包 5,894 文件 83.84 MiB）打进 runtime（阶段 6.8 + 锚点 13），并配 `TEXMFCNF`（缺陷 AS）。**三个坑**：① **`norm()` 不能按 `.` 切分包名** —— `texlive.infra`、`texlive.infra.ARCH` 里的点是名字的一部分，首版把 `texlive.infra` 当成 `texlive`，闭包漏掉整个基础包（`tlmgr.pl` 361 KB 与 `tlpkg/TeXLive/*.pm` 全在里面），症状是「117 包都解开了但 `TLConfig.pm` 一个都没有」；② **包内路径有两套约定，必须归一化** —— 有的只写 TDS 相对路径（`tex/latex/base/article.cls`，须补 `texmf-dist/`），有的显式写 `texmf-dist/…`（须剥掉再补回），`tlpkg/…` 相对 `$TEXMFROOT`，另有根级散文件；首版全部平铺进 `<root>/`，`article.cls` 落在 `<root>/tex/latex/base/`（少一层），kpathsea 按 `$TEXMFDIST` 找必然落空，**与「没装」同症状**；③ **单个 CTAN 镜像会间歇抛 `SSL: UNEXPECTED_EOF_WHILE_READING`**（大文件传一半被切断），只对同一镜像重试会整批跳过 `latex`/`l3kernel`/`etoolbox` 等包，必须**对每个镜像各试一遍**并把成功的包缓存到 `.cache/texlive-archive/` |
| AS | perl 连核心 pragma 都加载不了，所有 perl 脚本（含 TeX Live 的 fmtutil / tlmgr）全废（问题.txt【1】的第二层） | `perl -Mstrict -e 1` 报 `Can't locate strict.pm in @INC (you may need to install the strict module) (@INC entries checked: /data/data/com.termux/files/usr/lib/perl5/site_perl/5.42.2/aarch64-android /data/data/com.termux/files/usr/lib/perl5/site_perl/5.42.2 /data/data/com.termux/files/usr/lib/perl5/5.42.2/aarch64-android /data/data/com.termux/files/usr/lib/perl5/5.42.2)` —— **连核心 pragma `strict` 都找不到**；`exiftool`（`#!/…/bin/env perl`）随即 `BEGIN failed--compilation aborted at /data/user/0/app.kxxy/files/engine/bin/exiftool line 10`；TeX Live 的 `fmtutil` / `mktexfmt` / `tlmgr` 全是 perl 脚本，一并失效 | **根因**：perl 的 `@INC` 默认条目是**编译期写死的 C 字符串**（`/data/data/com.termux/files/usr/lib/perl5/…`），跟 `bin/kotlinc` 的 shebang 是同一类残留，但**无法用构建期文件回填修** —— 那不是文本常量，改长度会让 ELF 偏移错位。修法：`EngineConfig.kt` 新增 `perlLibPath(root)` 并注入 `PERL5LIB`（前置到 `@INC`，覆盖编译期条目）。**判架构目录要靠名字不能靠内容**：`$Config{archname}` 形如 `aarch64-android`，用「目录里有 `.so`」判断会漏（`.so` 全在 `aarch64-android/CORE/` 里）。**首版把版本目录下每个模块目录（`App/`、`Archive/`、`B/`…）都塞进去，`PERL5LIB` 变成 60 多条、几 KB 长**（真机读 `/proc/<pid>/environ` 实测），已收窄到「版本目录 + 架构目录 + site_perl 两套」。真机复验：`perl -Mstrict` → `strict ok`、`exiftool -ver` → `13.59` |
| AT | kpathsea 找不到 `texmf.cnf`，引擎起得来却读不到任何配置 | `kpsewhich` / `pdftex` 报 `warning: kpathsea: configuration file texmf.cnf not found in these directories:` 后接一长串**可执行文件所在目录**的上下级路径（`…/extensions/texlive/bin/texlive`、`…/extensions/texlive/bin`、`…/extensions/texlive`、`…/share/texmf-dist/web2c` …），**编译期的 Termux 前缀排在最后** —— 也就是说前面那些候选目录一个都不存在 | **根因**：kpathsea 是「按可执行文件的相对位置找配置」，而扩展装好后 `<root>/bin/pdftex` 是**软链**到 `extensions/texlive/bin/texlive/pdftex` 的，它按自己所在目录推 `../share/texmf-dist/web2c` 只会推出 `extensions/texlive/share/…`（不存在）。修法：`EngineConfig.kt` 新增 `texmfCnfPath(root)` 并注入 `TEXMFCNF=<root>/share/texlive/<年份>/texmf-dist/web2c`。**扫目录取年份而不是写死 `2026.0`**（换 TeX Live 版本时不用改代码；回落值才是写死的那一个）。真机复验：`kpsewhich --var-value=TEXMFROOT` → `/data/user/0/app.kxxy/files/engine/share/texlive/2026.0`。**注意 `texmf.cnf` 自身的内容是正确的**（构建期已改写，`grep -c 'com\.termux'` = 0），缺的只是「谁来告诉 kpathsea 它在哪」 |
| AU | 扩展的 `lib/` **子目录**（`pkgconfig` / `cmake` / `girepository-1.0` / `rustlib` / `guile`）从没被合并，清一色「目标已占用就跳过」（问题.txt【4】的同类） | `pkg-config` 找不到扩展带的 `.pc`（`freetype2.pc` 等）；`cmake` 找不到扩展的模块目录；**rust 的 `rustc` 编译任何程序报 `error[E0463]: can't find crate for 'std'`**（`rustlib` 没进 `<root>/lib`）；gdb 的 `share/guile` 虽在但 `lib/guile` 不在 | `buildViews` 的 `lib/` 段原本判 `if (isPresent(dest)) continue` —— 而 `pkgconfig`（12 个扩展贡献）、`cmake`（9 个）、`girepository-1.0`（6 个）**三个名字与 runtime 自带的目录重名**（runtime `lib/pkgconfig` 441 条目、`lib/cmake` 148 条、`lib/girepository-1.0` 8 条），于是三个扩展的贡献被整块丢掉。修法：把 `mergeViews` 的单条目逻辑抽成 `mergeEntry(src, dst, here, views)`，`lib/` 段改为逐项调它 —— 与 `etc/` `share/` 走**同一套递归合并规则**（目录不存在则整链 / 已是自己则记自有 / 被占用则软链先物化再递归 / 叶子同名则记 `shadowed`）。单测新增 **[12] 组 8 条**断言（runtime 预置 `zlib.pc` 不被顶掉、扩展的 `freetype2.pc` 也进来、卸载 rust 后 `rustlib` 回收而 runtime 的 `pkgconfig` 仍在） |
| AV | 旧布局的扩展永远不会自动重装，装配层的修复到不了已装扩展（问题.txt【1】【4】【6】的通病） | 代码全改对了、手工重装的那一个扩展也全对了，但**其余 19 个仍是旧布局**：rust 编不了程序、perl 的 `-Dsysroot` 还指向 `/data/data/com.termux/files`、`bin/texlive` 还是空目录。`relinkAll` 只按已有清单重建链接，**从不重新解包** —— 它修不了内容层的缺陷 | 为什么不能靠删目录重装：`extensions/` 是**用户态资产**（用户自己装的插件也在同一个 `dependencies` 里），`RuntimeInstaller.ensureInstalled` 的 `topLevelDirs` 只覆盖 runtime.zip 顶层目录、**故意不碰 `extensions/`**。修法：新增 `LAYOUT_VERSION = 2` 与 `staleExtensions(root)` —— 装配布局版本写进每个扩展的 `.links.json`，插件启动时 `relinkAll` 之后扫一遍，`layout < LAYOUT_VERSION` 且**在包池里**的扩展自动重装（不在包池里的不动，那是用户自己装的）。★**戳必须在 `buildViews` 里盖、不能在 `runInstall` 里补** —— 否则将来任何一条新装配路径写出的清单都会漏戳、被永远判「落后」而无限重装（单测 `[13]` 的「buildViews 返回的清单带 layout 戳」抓到了这个写法错误）。真机复验：20 个扩展全部 `layout: 2`、mtime 全为启动时刻 |
| AW | Gradle 连 `--version` 都出不来，kotlinc 每次都打一条 Termux 路径的 `No such file` 警告（问题.txt【3】【4】的第二层） | `gradle --version` 报 `FAILURE: Build failed with an exception. > Could not initialize native services. > Failed to load native library 'libnative-platform.so' for Linux aarch64.`；`kotlinc -version` 前面永远挂一行 `/data/data/com.termux/files/usr/tmp/jansi-2.4.0-<hash>-libjansi.so.lck (No such file or directory)`；而 `java -version` 与 kotlinc 的**编译本身**都完全正常（`a.jar` 5.6 MB 产出、`java -jar` 跑得通）—— 所以极易误判成「java 没链好」或「gradle 包不完整」 | **三个独立根因叠加**，逐一被 A/B 钉死。**① JVM 的 `user.home` / `java.io.tmpdir` 是编译期写死的 C 字符串**：`java -XshowSettings:properties` 报 `user.home=/data/data/com.termux/files/home`、`java.io.tmpdir=/data/data/com.termux/files/usr/tmp/`，**两个目录都不存在**（与 perl 的 `@INC` 同一类残留，改文件改不掉，只能从环境变量盖）。gradle 的 native-platform 在 `$user.home/.gradle` 下建临时探针文件，父目录不存在 ⇒ `IOException: No such file or directory` ⇒ 报成「native 库加载失败」。jansi 则是往 `java.io.tmpdir` 解 `.so`。**② `GRADLE_USER_HOME` / `-Duser.home` 必须成对或二选一** —— 真机四组对照（同一个 java、同一个 gradle 9.8.1）：基线 → rc=1 `Could not initialize native services`；只加 `java.io.tmpdir` → 同样 rc=1；只加 `GRADLE_USER_HOME` → rc=1 但换成 `createVirtualFileSystem()` 失败（缓存根有了、tmpdir 还是死的）；**两者都加 → rc=0，真的编出 `A.class`**；不设 `GRADLE_USER_HOME` 而只靠 `-Duser.home` 也能过（两者等价）。**③ JVM 的 `lib/jspawnhelper` 没有可执行位**（随 zip 存的是 `-rw-------`，12,504 B）：`restoreExecBits` 当时只认 `/bin/` 路径段，`jspawnhelper` 在 `lib/` 下被漏掉 ⇒ gradle 起 daemon 时 `Failed to exec spawn helper: pid: … exit code: 127`，而 gradle 把它转述成 `Could not start '…/bin/java'` —— **看起来是 java 不可执行，实际 java 好好的**。修法：`EngineConfig.buildEnv` 注入 `JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=… -Duser.home=…` 与 `GRADLE_USER_HOME=<home>/.gradle`（用一条 `JAVA_TOOL_OPTIONS` 而不是两条导出，因为这个变量本来就由 JVM 自己按空格拆分，且 kotlinc / d8 / apksigner 一并受益），`EngineSupervisor.ensureDirs` 预建 `<home>/.gradle`；`RuntimeInstaller.restoreExecBits` 补一段「`lib/jvm` 下 ELF 且无扩展名」全量置位，并抽成 `ensureJvmExecBits(root)` 挂到**每次启动的幂等路径**上 —— 因为它不是资产缺失、锚点判不出来（`setExecutable` 连 mtime 都不改），若只写在重装路径上，老设备 `isComplete()` 判真就永远到不了（与缺陷 AV 同型的「自愈够不到」）。真机复验：20 个扩展 `layout: 3`、`gradle --version` 出 `Gradle 9.8.1`、`gradle --offline compileJava` → `BUILD SUCCESSFUL`、`./build/classes/java/main/A.class` 落地 |
| AX | ImageMagick 找不到 `colors.xml`、Ghostscript 找不到 `gs_init.ps`（问题.txt【6】的最后两处） | `magick` 每次调用都打 `magick: UnableToOpenConfigureFile 'colors.xml' @ warning/configure.c/GetConfigureOptions/722`（**出图仍然成功**，所以很容易被当成无害告警放过）；`gs` 报 `GPL Ghostscript 10.07.1: Can't find initialization file gs_init.ps.` —— 而且**退出码仍是 0**，只产出一份空 PDF，属于静默失败 | 文件其实都到位了：`<root>/etc/ImageMagick-7/colors.xml`（合并视图的软链，14 个 xml 齐备）与 `<root>/share/ghostscript/Resource/Init/gs_init.ps` 在真机上 `find` 都命中。**缺的是「谁告诉它们去那儿找」** —— 这两个程序都**不看 `$PREFIX`**，只认自己的编译期路径与专用变量：`magick` 走 `MAGICK_CONFIGURE_PATH`，`gs` 走 `GS_LIB`（`gs -h` 的 search path 第一位就是 `/data/data/com.termux/files/usr/share/ghostscript/Resource/Init`，一个死路径）。这与 FONTCONFIG_PATH / TESSDATA_PREFIX / GUILE_LOAD_PATH / TEXMFCNF 是同一类，但当年只补了那四个，漏了这两个。修法：`EngineConfig.buildEnv` 增加 `MAGICK_CONFIGURE_PATH=<root>/etc/ImageMagick-7` 与 `GS_LIB=<root>/share/ghostscript/{Resource/Init,lib,Resource/Font}`。真机 A/B：不设 `MAGICK_CONFIGURE_PATH` 告警照旧、设了即干净（8x8 出图 296 B）；`gs -sDEVICE=pdfwrite` 从「空 PDF」变成 **2,433 B 的真 PDF**。**fontconfig 复查通过、无需改动**：用 ctypes 直接调 `libfontconfig.so`，`FcInit=1`、`FcConfigGetFilename("fonts.conf")` 返回 `<root>/etc/fonts/fonts.conf`、字体集合 `nfont=593 sfont=608` —— 说明「Fontconfig 无法加载默认配置」那条已经被缺陷 AL 的合并视图真正修好了（引擎里没有 `fc-list` 二进制，所以只能这样验，别拿 `fc-list: not found` 当失败） |
| AY | TeX Live 的引擎能跑、配置也读到了，但**一个文档都编不出来**；`pdflatex` / `xelatex` / `latex` 三件套全废（问题.txt【4】的最后一层，接 AR / AT） | 装上宏包树、设好 `TEXMFROOT`、`texmf.cnf` 也能读之后，`kpsewhich article.cls` 仍是**空**；`bin/` 下只有 `pdftex`/`tex` 而没有 `pdflatex`；手工 `pdftex -ini` 报 `! I can't find file 'dehypht-x-2024-02-28.tex'.` → `! Emergency stop.`；`mktexfmt` 报 `inifile pdflatex.ini … not found`（可 `kpsewhich pdflatex.ini` 明明能命中） | **五处独立根因叠加**，逐条 A/B 定位：<br>① **`ls-R` 缺 kpathsea 魔数首行**。`mktexlsr` 报 `no magic string, skipping...`；首行必须逐字为 `% ls-R -- filename database for kpathsea; do not change this line.`（早期版本写的是中文注释）。<br>② **`ls-R` 文件名被缩进两格**。真产物里文件名**顶格**、目录行以 `:` 结尾、第 2 行是 `./:`。改正后索引 107,842 B / 5974 文件，`kpsewhich` 立刻全命中。<br>③ **`pdftex.map` 从未生成，且落点必须在 `fonts/map/pdftex/updmap/`**。缺它 → `!pdfTeX error: pdflatex (file cmbx12): Font cmbx12 at 720 not found`（引擎改去现搓 PK 字体）。`updmap-sys` 跑不通（`updmap.cfg` 列 339 个 map、闭包只有 43 个，296 条 ERROR），`--syncwithtrees` 也死在 perl 拼出来的 `/data/data/com.termux/files/usr/bin/sh`。改为构建期**只并 `fonts/map/dvips/` 的 37 个 map**（3179 行）写到 `fonts/map/pdftex/updmap/pdftex.map` —— 放进 `web2c/` 是搜不到的（`TEXFONTMAPS` = `…/fonts/map/{kpsewhich,pdftex,dvips,}//`）；也不能并 `dvipdfm/`/`dvipdfmx/` 那几份（行格式不同，会让 xdvipdfmx 报 `Found a mismatched fontmap line`）。<br>④ **`dvipdfmx.cfg` 的 `p  a4` 让 xelatex 致命失败**：`xdvipdfmx:fatal: Unrecognized paper format: a4`，**命令行 `-p a4`/`-p 595pt,842pt` 全部无效**（Termux 交叉编译后 paper 名字表没初始化），只能改 cfg 成纯数值 `p  595.28pt,841.89pt`。<br>⑤ **`web2c/mktex*` 无可执行位**（zip 里是 0600）→ `mktexpk: …/mktexnam: Permission denied`。<br>**格式文件另走安装期生成**：`mktexfmt` 本身不可修 —— 它是 perl，内部 `system("kpsewhich … >$nul 2>&1")` 这种**带重定向的字符串形式**在 Android 上 `system` 直接返回 **-1**（`Config{sh}` 正常、`bin/sh` 是正常 ELF、反引号可用、list-form `system("sh","-c",…)` 也 rc=0，只有字符串形式带重定向失败），且那串 termux 路径是运行期拼的（`grep -rl 'com\.termux'` 在整棵 TeX 树里命中 0 个文件）。改为 `RuntimeInstaller.ensureTexFormats` 在**安装期直接 `-ini`** 生成三个 `.fmt`（各 11~12 秒），落 `$TEXMFVAR/web2c/`。**关键：必须落用户树** —— `TEXFORMATS` 里 `$TEXMFSYSVAR` 带 `!!` 前缀（只查 `ls-R` 不扫目录），而 `$TEXMFVAR` 不带，所以用户树**一个索引都不需要**，设备上不用跑 `mktexlsr`（那也是 perl）。`TEXMFVAR` 由 `EngineConfig.texmfVar(ctx)` 显式指定为 `<home>/.texlive/texmf-var`，避免去猜 `.texlive2026` 这种随发行版变的年份名（真机验证：设了立即逐字生效）。另需把 `language.dat` 从 226 条断词语言**收窄到闭包里真实存在的 3 条**，否则 `pdftex -ini` 读到第一个缺失断词文件就 `Emergency stop`。<br>**终验**（全新安装 + 零手工干预）：`pdflatex` → `t.pdf 11859 B`（`%PDF-1.7`）、`latex` → `t.dvi 260 B`、`xelatex` → `t.pdf 2829 B`，三条 rc 全 0；删掉 `$TEXMFVAR` 后重启能自动补回，再重启则一行日志都不打（幂等） |
| AZ | `ffmpeg` / `ffprobe` 在设备上**完全起不来**，而同一环境的 `curl` / `cmake` / `node` / `pandoc` … 全部正常（问题.txt【2】的最后一项） | `CANNOT LINK EXECUTABLE "…/engine/bin/ffmpeg": cannot find "libbinder_ndk.so" from verneed[0] in DT_NEEDED list for "/system/lib64/libui.so"`。**报的是「版本符号找不到」而不是「文件缺失」** —— 这句话极具误导性，`libbinder_ndk.so` 明明就在 `<root>/lib/` 里躺着 | **桩库遮蔽 + 只多删一个就崩，两个反直觉点**。`libandroid-stub_30-1` 发的 `<root>/lib/libbinder_ndk.so` 只有 **24,000 B**、`soname=null`、无 `.gnu.version_d`、`strings \| grep '^_Z'` **零个符号**；`/system/lib64/libbinder_ndk.so` 是 **94,488 B / 190 个 `_Z*`**。`EngineConfig.buildEnv` 把 `<root>/lib` 放在 `LD_LIBRARY_PATH` 首位（`curl`/`cmake` 需要引擎里那批新库），于是 24 KB 的桩库**遮蔽**了系统真库，`/system/lib64/libui.so` 的 verneed 解析失败 ⇒ 报「找不到」。<br>**① 逐个 `mv` 的单变量 A/B（`_recon/probe-stub3.sh`）**：5 个桩库一个一个移走，每组跑 16 个工具 —— **只有移走 `libbinder_ndk.so` 时 ffmpeg/ffprobe 变化**（`CANNOT LINK…` → `ffmpeg version 8.1.3` / `ffprobe version 8.1.3`），移走其余四个任意一个 ffmpeg 依旧报错；而 16 个工具里除 ffmpeg/ffprobe 外的 14 个（curl 8.22.0 / cmake 4.4.4 / sqlite3 3.54.0 / node v24.18.0 / perl / tesseract 5.5.3 / magick 7.1.2-33 / gs 10.07.1 / pandoc 3.12 / qpdf 12.4.2 / git 2.56.0 / python3 3.14.6 / clang 21.1.8 / rg 15.2.0）**输出逐字不变**。<br>**② 旧结论「挪走 5 个桩库只前进一环」是被自己误导的**：同时移走 `libmediandk.so` 后报 `cannot locate symbol "Xzs_Construct" referenced by "/system/lib64/libunwindstack.so"` —— 那是**挪得太多**引入的新问题（`libmediandk.so` 桩 35,592 B / 系统版 228,928 B）。所以 `libandroid.so` / `libmediandk.so` / `libOpenSLES.so` / `libtermux-platform-ns.so` 四个桩库**必须保留**，只删 binder 这一个。<br>**③ 删掉是否安全，用数据证明**：写 `_recon/elfneeded2.py`（纯 python ELF64 头解析，不依赖 readelf）扫整棵引擎 **44,324 个文件 / 3,577 个 ELF64**（`bin/` + `lib/` + `libexec/` + `extensions/`），`DT_NEEDED` 里含 `libbinder_ndk.so` 的 **0 个**；含 `libmediandk.so` 的 3 个（都是 `libavcodec.so*`）、含 `libandroid.so` 的 6 个、含 `libOpenSLES.so` 的 2 个（pulseaudio 的 sles 模块）、含 `libtermux-platform-ns.so` 的 4 个（正是那四个桩库自己）。**修法**：`tools/build-runtime.mjs` 新增 `DROPPED_LIBS = new Set(["lib/libbinder_ndk.so"])`，在 `normaliseStageFiles()` 的剔除分支里连同 `DEAD_INTERPRETER_SCRIPTS` / `TERMUX_APP_SCRIPTS` 一起 splice 掉并计入 `removedPaths`；`tools/verify-runtime.mjs` 加「桩库剔除」静态检查（binder 必须不在、其余四个必须仍在），`tools/simulate-install.mjs` 加同款安装后断言。重建后 zip 条目 42046 → **42045**。<br>**④ 光有构建期剔除还不够 —— 老设备永远收不到**：装了带 `DROPPED_LIBS` 的 APK 后，logcat 只打一行 `runtime already installed and complete`，`<root>/lib/libbinder_ndk.so` **照样躺在盘上**，因为 `isComplete()` 判真 ⇒ 永不重装（与 `ensureJvmExecBits` 完全同型：资产都在，问题是「多了一个文件」）。所以 `RuntimeInstaller` 另加 `ensureNoShadowingStubs(root)`，挂在**两条路径**上（`isComplete` 为真分支 + 重装流程 `writeStamp` 之前），每次启动只做一次 `File.exists()`。**真机闭环验证**：手工把 24,000 B 桩库 `cp` 回 `<root>/lib/`，`ffmpeg` 立刻退回 `CANNOT LINK…`；`am force-stop` 后重启 App，logcat 打出 `ensureNoShadowingStubs: removed lib/libbinder_ndk.so (24000 B, 遮蔽系统真库)`，`ffmpeg -version` → `ffmpeg version 8.1.3`，`ffprobe -version` → `ffprobe version 8.1.3`，实际转码 `-f lavfi -i testsrc -c:v libx264` 产出 5,183 B 的 mp4（`ffprobe` 报 `format_name=mov,mp4,m4a,3gp,3g2,mj2`、`duration=1.000000`），其余 14 个工具输出逐字不变 |
| BA | `emacs --version` 能打出版本号，但每次都先刷三条 `Warning: arch-dependent data dir '/data/data/com.termux/files/usr/…'`；`emacs --batch` 更直接死掉：`Error: file-missing ("Loading charset map" "No such file or directory" "8859-2")` + `Emacs will not function correctly without the character map files.`（问题修复.txt 的最后一项） | **两层根因，一半在构建期、一半在运行期。**<br>① **构建期**：`tools/lib/stage.mjs` 与 `tools/lib/poolextract.py` 的 `PRUNE_EXT` 里有一条 `.map`（本意是裁 JS sourcemap），而扩展池里带 `.map` 的只有两个包、且**全是要用的数据文件** —— emacs 的 `share/emacs/31.1/etc/charsets/*.map`（131 个 / 2.8 MiB，字符集映射表）与 texlive-bin 的 `fonts/map/dvipdfmx/cid-x.map`、`source/fonts/zhmetrics/ttfonts.map`、`texconfig/tcfmgr.map`（3 个 / 6 KiB）。真机 `emacs.pool` 解出来 `etc/charsets/` 里**只有 README 一个文件**（4,239 成员里 `charsets` 命中 1 个），而 deb 里明明是 131 个。<br>② **运行期**：三个数据目录是 Emacs 编译期写进 C 字符串的 `$prefix` 派生值，和 JVM 的 `user.home`、perl 的 `@INC` 完全同型 —— **文件回填改不掉**，只能靠环境变量在其前面插入真实路径。 | <br>**构建期**：从 `PRUNE_EXT` 删掉 `.map`（两个文件都加注释记录这 134 个文件为什么必须留），重跑 `fetch-extensions.mjs` → `emacs.pool` 成员 4,239 → **4,370**（+131），`verify-runtime.mjs` 新增「字符集映射」段（解 gzip 后遍历 tar 头，断言 `charsets/*.map` ≥100 且含 `8859-2.map`）。<br>**运行期**：`EngineConfig.buildEnv` 注入四个变量 —— `EMACSDATA`（etc/）、`EMACSLOADPATH`（lisp + site-lisp + lisp/leim）、**`EMACSPATH`**（libexec/emacs/&lt;版本&gt;/&lt;arch&gt;/）、`EMACSDOC`（etc/）；新增 `emacsVersionDir` / `emacsDataDir` / `emacsLoadPath` / `emacsLibExecDir` 四个函数，版本号扫 `share/emacs/` 取**首字符是数字**的最大目录（当前 31.1），合并视图优先、`extensions/emacs/share/emacs` 兜底。<br>**真机 A/B**（`_recon/probe-emacs4.sh` / `probe-emacs5.sh`，均从引擎进程 `/proc/&lt;pid&gt;/environ` 取真实环境）：不设变量 → 三条 `com.termux` 警告 + `--batch` 报 `Loading charset map` 失败；只设这四个变量 → 警告**归零**（`grep -c 'com\.termux'` = 0），`--version` 干净出版本号，`load-path` 全部指向 `<root>/share/emacs/31.1/lisp` 系列。 |
| BB | BA 的四变量方案上机后，`--version` 干净了，但 `--batch` 仍刷两行 `Error running git rev-parse: (file-missing "Setting current directory" "No such file or directory" "/data/data/com.termux/files/usr/share/emacs/31.1/")`，且 `--version` 的一条 `arch-dependent data dir` 警告**时有时无** | **三个各自独立的小坑，全在真机 A/B 里才暴露。**<br>① **变量名写错**：`EngineConfig` 里写的是 `EMACSLIBEXEC`，而 emacs 31.1 二进制里被 `getenv` 的 EMACS* 名字只有五个 —— `grep -ao 'EMACS[A-Z_]*' <root>/extensions/emacs/bin/emacs \| sort -u` 得到 `EMACSDATA` / `EMACSDOC` / `EMACSLOADPATH` / `EMACSPATH` / `EMACS_FONT_LOG` / `EMACS_IGNORE_TIMERFD`，**没有 `EMACSLIBEXEC`**。四组 A/B（`_recon/probe-emacs11.sh`）：`A(none) arch-warn=1` / `B(EMACSPATH) arch-warn=0` / `C(EMACSLIBEXEC) arch-warn=1` / `D(both) arch-warn=1` —— 设了错的等于没设。<br>② **字典序取错版本目录**：`emacsVersionDir` 扫 `share/emacs/` 取「字典序最大」，但该目录下除了 `31.1` 还有 `site-lisp`，而 `"site-lisp" > "31.1"`（`s` > `3`）⇒ `EMACSDATA` 指向不存在的 `share/emacs/site-lisp/etc` ⇒ emacs 报 `Emacs will not function correctly without the character map files.` + `The EMACSDATA environment variable is set.  Maybe it has the wrong value?` 并 rc=1。**这个坑只在 `extensions/emacs` 装配完成、`share/emacs/site-lisp` 被建出来之后才出现**，所以第一版探针是绿的。<br>③ **无 dump 时的 git 探测**：`loadup.el:463` 的 `(if (and (eq system-type 'android) (not (pdumper-stats))) (setq emacs-repository-version (ignore-errors (emacs-repository-get-version)) …))` —— 每次启动都拿 `source-directory`（编译期常量，指向 Termux 前缀）当工作目录去 `call-process "git" rev-parse HEAD`，目录不存在 + 设备上根本没 git ⇒ 两行报错。 | <br>① 变量名 `EMACSLIBEXEC` → **`EMACSPATH`**（`emacsLibExecDir()` 函数体不变，返回的路径本来就是对的）。<br>② `emacsVersionDir` 与 `ensureEmacsSiteLoad` 里的目录扫描都加 `.filter { it.isNotEmpty() && it[0].isDigit() }` —— 只认版本号形态，排除 `site-lisp` / `etc` 这类非版本目录。<br>③ 新增 `RuntimeInstaller.ensureEmacsSiteLoad(root)`：往 `$HOME/.emacs.d/kxxy/site-load.el` 写三条 elisp —— `(setq source-directory "<root>/share/emacs/<版本>/")` + `(defalias 'emacs-repository-get-version #'ignore)` + `(defalias 'emacs-repository-get-branch #'ignore)`；`EngineConfig.emacsLoadPath` 把这个目录放在 `EMACSLOADPATH` **最前面**，于是 `loadup.el:411` 的 `(load "site-load" t)` 先命中它。放在 `$HOME` 而非引擎树，因为引擎树是 `runtime.zip` 的产物、重装即整棵重建。两条路径（`isComplete()` 命中 / 重装）都挂，幂等（内容一致不重写）。<br>**关键 A/B**：只改 `source-directory` 时 `git=2` **不变**（目录存在了但 git 照样跑、照样失败），**必须同时 defalias 掉那两个探测函数**才 `git=0`。<br>**pdump 明确放弃**（负面结论）：照抄 deb 的 `postinst`（`cd …/lisp && emacs -batch -l loadup --temacs=pdump`）恒 rc=255，报 `Symbol's function definition is void: debug-early--handler`，无 `.pdmp` 产出；根因是 `(featurep 'android)` = **nil**（`system-type` 虽是 `android`），`loadup.el:574` 的自 dump 分支永不触发。无 dump 状态下功能完整，`--batch` 启动 **570 ms** 可接受。<br>**真机终验**（`_recon/probe-emacs-final6.sh`，用 APK 自动生成的 `site-load.el`）：`--version` → `rc=0 stderr=0 termux=0`；`--batch` → `rc=0 git=0 termux=0 cookie-missing=0`，非 `Loading` 输出只剩 `Dump mode: nil` 一行；`latin2=y`、`source-directory` 指向 `<root>/share/emacs/31.1/`、`coding-system-for-write` 为 utf-8 时中文正常落盘。 |

**关于缺陷 Q 的额外结论（终端功能本身是好的）**：`dsh.terminal.shell` 这个键**已被官方废弃** —— 在四个运行时 bundle（`sidebar-terminal` / `client.terminal` / `terminal-bash` / `terminal`）里对 `/terminal\.shell/` 与 `/localStorage/` 的命中数**都是 0**；官方新建终端走 `webTerminals.selectShell(path)` → 开 tab 时把 `shellPath` 作为参数传下去（`terminal-bash` 的默认值是 `DEFAULT_BASH_SHELL = "/bin/bash"`，可被 `config.shellPath` 覆盖，而该配置由引擎侧注入）。所以那张卡显示的 `bin/cmd` 只是**历史遗留值**，不影响终端；真机上终端本身工作正常（`uname -a` 正常、提示符显示当前目录），即缺陷 K 的修复仍然有效（提示符一栏见缺陷 S）。对照实验也证明**官方终端天然跟随主题**：浅色下 `.xterm-viewport` 背景透明、文字 `rgb(15,17,21)`，官方 `sidebar-terminal` 插件全部用 `var(--dsw-alias-*)` 官方 token。

**缺陷 P 的定位手法**（可复用）：症状是「跟随系统没反应」，第一直觉会去查官方前端的
主题逻辑，但它那行 `resolvedId = preference === "system" ? (media?.matches === true ? "dark" : "light") : preference`
完全正确。真正的判据是**把媒体查询的取值打出来**：往 `compat.js` 尾部追加一段探针读
`matchMedia('(prefers-color-scheme: dark)').matches`，经 `onConsoleMessage` 转发到 logcat。
两条硬约束：① **必须 `force-stop` 后重启**再取值 —— `prefers-color-scheme` 是 WebView
创建时算一次的快照，只切系统 night mode 不重启会拿到上一次的缓存值，从而无法区分
「WebView 读系统 uiMode」与「读宿主主题」这两种假设（第一次实验就栽在这里）；
② 对照实验要做**双向**（night=no 与 night=yes 各一次），两次结果相同才能排除系统因素。
确定根因后不要急着改官方前端 —— **官方与控制台两处判定同源**（都是同一句 `matchMedia`），
修好宿主主题这一处，两处一起跟随。

**缺陷 Q 的定位手法**（可复用）：症状是「浅色下难看」，先别改配色，先把**每个元素的
实际计算色**打出来（`bg` / `color` / `border` 一起取），错配立刻显形：容器底是
`rgb(21,21,23)` 而内部的卡是 `rgb(255,255,255)`、按钮是 `bg=rgb(255,255,255) color=rgb(97,102,107)`。
一条硬约束：**页面是从设备上的插件目录加载的**，本地改完必须先 `adb push` + `run-as … cat >`
覆盖设备文件再量测，否则会看到「改了没反应」（第一次跑就踩了）。
验证时必须**浅色与深色各跑一遍并人工读图**：只验证浅色会漏掉「深色被改坏」，
而深色值本就应当逐像素不变（因为原硬编码值原样搬进了 `body[data-ds-dark-theme]` 段）。

**构建期陷阱（非代码缺陷，但会毁掉产物）**：Gradle 的 `packageDebug` 走 zipflinger **增量打包** —— 它打开已存在的 APK 原地更新，条目变大时把新数据追加到文件末尾，**旧数据留成空洞且不截断文件**。本次 `runtime.zip` 只增大了 448 字节，`app-debug.apk` 却从 1.62 GB 涨到 **2.14 GB**（凭空多出 521 MB，恰好一整个旧 `runtime.zip`）。用中央目录逐条核对偏移即可确诊（空洞在 `classes5.dex` 之后、`DebugProbesKt.bin` 之前）。删掉产物重新 `assembleDebug` 后回到 1620993963 B。**发布前必须核对 APK 体积量级**，否则会发出一个白胖一倍的包。

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
而是在设备上 `grep -rl` 那个字面量，直接落到唯一文件与唯一行。真正花时间的是**第二处缺口**：`createProcessInspector` 修好之后终端仍然打不开，
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

**缺陷 O 的定位手法**（可复用）：症状是「中文逐字竖排」，第一直觉会去查字体或
`writing-mode`，但两者都正常。真正的判据是**逐层量宽度**：从面板根一路量到出问题
的那一行，得到 `363 → 188 → 175 → 127 → 0`，一眼看出每一层各吃掉多少 ——
标题宽 0px 时，任何文字都只能一字一行。三条硬约束：
① **官方运行时类名不在静态 CSS 文件里** —— 前端有 140+ 个运行时 `<style>` 标签，
每个客户端插件用 `data-plugin="<包名>"` 注入，在 `dist/*.css` 里 grep 全部 0 命中，
定位必须走 `document.styleSheets` 遍历 + 按 `ownerNode.getAttribute('data-plugin')` 归属；
② **适配层不能依赖 CSS-module 哈希** —— 官方同时存在 `_语义_hash_行号`（如 `_3HsggG_rowText`）
与 `hash_语义`（如 `wCInkW_nav`）两套格式，只能按**语义名中缀**匹配
（`[class*="navList"]`），否则升级即失效；③ **`flex-basis` 优先于 `height`** ——
外观卡片官方是 `flex:1 1 180px`，在 `flex-direction:column` 容器里 180px 是**主轴（高度）**
尺寸，只写 `height:52px` 会被顶掉（实测仍 180px），必须先 `flex:0 0 auto`。

**缺陷 O 的验证通道**（可复用）：Android WebView 没法开 CDP（`app.kxxy` 未调
`setWebContentsDebuggingEnabled`），但**桌面 Chrome 打开同一个 `dsh web` 页面**
就能拿到完全相同的 DOM —— 用 `Emulation.setDeviceMetricsOverride` 设 411x914、
`setTouchEmulationEnabled` 让 `pointer: coarse` 命中，再 `Page.captureScreenshot` 出图。
两条硬约束：① 引擎 cookie 绑 authority 且 `HttpOnly + SameSite=Strict`，手工
`Network.setCookie` 会被 CDP 以 `Sanitizing cookie failed` 拒绝，**也不能先导航到
about:blank 再回来**（无发起者的跨站导航不带 Strict cookie → 401，症状是 body 恰好
68 字节），必须直接 `Page.navigate` 打 token URL 让浏览器自己走完 303 → Set-Cookie →
重定向；② 要在**入口 module 求值之前**注入，用 `Page.addScriptToEvaluateOnNewDocument`
（等价于原生层的 `evaluateJavascript`），否则会先渲染一帧桌面布局再跳变。

**缺陷 O 的补充教训：隐藏侧栏不能用 `display:none`**（用户要求「点官方那个按钮
之后它完全隐藏进去」，这条约束是用户催出来的）：第一版用 `display:none` 把
`sidebarCol` 收掉，结果官方开合按钮就在这一列**内部** —— 整棵子树退出渲染，
按钮跟着消失，用户再也打不开侧栏。改用 `visibility:hidden`（可被后代
`visibility:visible` 覆盖）后仍有第二个坑：只把按钮自己设回 `visible` 不够，
因为上面那条 `* { visibility: hidden }` 同样命中了按钮内部的 `svg`/`span`，
而 **`visibility` 是可继承属性，父级改回 `visible` 救不回被显式声明为 `hidden`
的子元素** —— 症状极具误导性：`getBoundingClientRect()` 完全正确（36x36@10,18），
`getComputedStyle` 也全是期望值，但屏幕上什么都不画。判据只能是
`document.elementFromPoint()` 的命中测试，`rect` 与 `computed style` 都会骗人。
所以规则要写成**双选择器组**（`[class*="toggle"], [class*="toggle"] *`）。

**缺陷 O 的第三层教训（历史，适用于任何「注入样式表」方案）**：页面里会同时存在
两份注入样式表。`data-kxxy-mobile`（引擎按设备上**旧 runtime** 注入）与
`data-kxxy-css`（桌面驱动注入的新版）并存时，新版把 `display:none` 换成 `visibility`
后**没有显式声明 `display`**，于是旧版那条 `display: none !important` 仍然胜出 ——
现象与上面那条一模一样。所以隐藏态 `sidebarCol` 规则必须**显式写
`display: block !important`**，把旧规则顶回去。
定位这条根因时，JS 侧遍历 `document.styleSheets` 两次都返回 `totalRules: 0`
（遍历器自身有 bug），**换用 CDP 的 `CSS.getMatchedStylesForNode` 一次就拿到
胜出规则**——教训是：当 JS 侧的自查结果与现象矛盾时，别再改遍历器，直接换权威通道。

---

## 六、验证体系（十二层）

| 脚本 | 验证什么 | 为什么需要它 |
|---|---|---|
| `verify-runtime.mjs` | zip 结构（条目数 / LINK 注释 / 占位符残留 / 版本标记 / ELF 校验 / 字体 sfnt 魔数）**+ 打开 zip 里真实的 documentpreview `client.js` 断言注入片段真的写进去了、且上游音视频黑名单 16 项全被 provider 认领** | 产物完整性。后两条是补上来的：锚点判定只证明 `patchset.version` 标记文件在、与 Kotlin 常量一致，**不证明补丁内容真的落进 bundle** —— 真机出过一次「标记在、全锚点过、`isComplete()` 判真跳过重装，而设备上仍是未打补丁的旧文件」 |
| `simulate-install.mjs` | 复刻 `RuntimeInstaller` 的 7 步解包与十三锚点判定 | 结构对 ≠ 设备上能装出可启动的树 |
| `smoke-plugin.mjs` | 复刻官方 `WebServer` 路由契约起真实 HTTP，并断言兼容层/现代内建补齐层的关键实现在场、版本标记与 Kotlin 常量一致 | 文件铺对了 ≠ 插件能挂起来 |
| `check-bundle.mjs` | 用**真实** `dsh-app-boot` 走解析链 | 插件能跑 ≠ DSH 能发现它 |
| `test-pty-patch.mjs` | 2 个补丁的离线单测（`patchSubprocessInspector` / `patchNodePty`），自带**逐字节照抄上游**的 fixture，不依赖仓库外文件；手上有真 `runner-launch-*.js` 时可用 `DSH_RUNNER_LAUNCH` 换上真文件跑 | 补丁改错了构建照样全绿，只有点开终端才炸 |
| `test-compat-url.mjs` | 在「WebView 104 行为沙箱」里跑真实 `compat.js`，断言 URL 补丁的 25 组取值与 8 组回归 | `smoke-plugin` 只能验「实现在场」，验不了语义边界（特殊协议、空 authority、userinfo/port）—— 而边界恰恰最容易改坏 |
| `test-compat-css.mjs` | 断言 `dvh → vh`、`@scope` 展开器、`:has()` 标记改写与插件 hash 锚点代际归一化共 45 组取值（含嵌套 `@media`/`@supports`/`@layer`、`@keyframes` 内部原样保留、真机设置面板门控形态、哈希映射的「唯一超集才采纳」边界） | 三段器都是纯文本重写，一个括号配平错误或一个标识符未定义就会让**整层**样式改写失效（缺陷 AC 的 `matchParen` 事故） |
| `test-modern.mjs` | 每个用例一个**独立 vm realm** 的「104 沙箱」，跑真实 `modern.js`，断言补齐结果 + `URL.createObjectURL` 对 script/html 两类 blob 的前置注入 + 幂等 | 补齐层最危险的失败模式是「本地全绿、真机只显示渲染进程无法继续」—— 补齐源码要被 `Function.prototype.toString()` 搬进 worker 执行，引用本文件作用域里任何变量都不会在本地报错 |
| `test-archive-providers.mjs` | 在 `vm` 沙箱里跑 `tools/prebuilt/documentpreview-archive/providers.js`，断言 ZIP 中央目录解析（含 ZIP64、目录项、加密位）、`kxxyInflateRaw`、EPUB OPF/spine 解析、内联资源与预算控制 | 归档 provider 是**注入进 26 万字符扁平 bundle 作用域**的片段，本地没有模块边界兜底；ZIP 解析器的边界（EOCD 扫描窗口、ZIP64 扩展字段顺序）只有单测能覆盖 |
| `test-media-providers.mjs` | 在自建 hooks 运行时里跑 `tools/prebuilt/documentpreview-media/providers.js`：13+17 个后缀覆盖、src 构造（loopback 走 `/kxxy/media`、`dsh-app://` 退回 `api/file`）、失败归因（code 4 报 unsupported / 其它报错误码）、`loaded` 上报幂等、三态兜底（unavailable / noPath / loading）、注册形状（1 字典 + 2 provider + 2 槽位 + 5 effect） | 媒体 body 有 5 条互相独立的分支（元数据未到 / 无绝对路径 / 加载中 / 就绪 / 失败），少写一条就变成**永远转圈**且不报任何错；`renderer` 模式还要求恰好上报一次 `loaded`，否则 `hasContent` 不为真、body 根本不渲染 |
| `test-extinstall.mjs` | 在临时目录里跑真实的 `extinstall.mjs`，断言扩展装配的 13 组行为：`bin/**` 递归展平（TeX Live 的 411 个引擎必须进 PATH）与同扩展内重名退回、`opt/<name>/lib → <extDir>/lib` 布局软链、`etc/`+`share/`+`lib/` 的**递归合并**（与 runtime 同名、多扩展同名、叶子同名记 `shadowed`）、占位符回填（五规则、幂等、老包无清单静默跳过）、卸载只回收自己的资源并把被遮蔽的文件补回、`relinkAll` 与悬空链接自愈 | 装配链是把「一堆互不知情的 tar 包」缝成一套可用工具树的地方，三类冲突（与 runtime 同名 10 处、多扩展同名 15 处、`lib/` 子目录同名 3 处）全都只在真机装完才暴露，而**静默丢内容**没有任何报错；另外 `existsSync` 跟随软链、悬空链接会让「先删后建」变成 EEXIST，这类语义陷阱必须用单测钉住 |

外加**端到端实测**：用宿主 node 直接跑装配产物，验证
`/`（官方前端 + token 认证）、`/kxxy`（管理页）、`/kxxy/api/*`（API）、
`/kxxy/media`（媒体流）、
以及边界行为（恶意 Host 403、目录穿越 400、未知端点 404）。

---

## 七、已知限制

| 项 | 状态 |
|---|---|
| Office 文档预览 | **已可用**（缺陷 X）—— 走 LibreOffice wasm 后端，doc/docx/odt/xls/xlsx/ods/ppt/pptx/odp 九种格式都能转 PDF。代价是包体：wasm 引擎 145 MiB + 两份 CJK 字体 21 MiB 使 runtime.zip 从 497 MiB 涨到 555 MiB、APK 从 1,545 MiB 涨到 1,604 MiB；转换在设备上约 4–5 s、峰值 RSS 约 400–715 MiB。**首次转换有冷启动**（wasm 模块加载约 1.4 s） |
| 归档 / 电子书预览 | **已可用**（缺陷 Z）—— zip 列条目 + 点开预览文本条目；epub 按 OPF spine 拼出可滚动单页。**限制**：zip 单条目解压上限 16 MiB、epub 内联资源总预算 24 MiB；只支持 `stored` 与 `deflate`（`deflate64` / `bzip2` / `lzma` 等少见方式会报「不支持的压缩方式」）；加密 zip 明确拒绝；**纯前端解压，不做流式**，打开超大 zip 会把整个文件读进内存 |
| 视频 / 音频预览 | **已可用**（缺陷 AI）—— 新增 `/kxxy/media` 流式路由（支持单段 `Range` / 206 / `HEAD`，正确 MIME，无 20 MiB 上限）+ video / audio 两个 provider。**限制**：容器支持取决于 ROM 自带的 WebView（本机 104 实测能解 H.264/MP4、VP8/VP9 WebM、MP3、AAC、FLAC、Opus/Vorbis；**不能解** mkv / avi / wmv / flv / mpg / ts / 3gp / theora / aiff / midi / amr，点开会明确提示「内核不支持该格式，通常需要先转成 mp4 或 webm」而不是空转）。设备侧 **ffmpeg / ffprobe 已可用**（缺陷 AZ，见下表），matroska 这类 WebView 不认的容器可以先用 `ffmpeg -i in.mkv -c copy out.mp4` 转封装再预览 |
| 沙箱隔离 | Android 无 landlock/seatbelt，固定 `danger-full-access` |
| 无障碍服务 | 未实现（参考项目有 1,495 行，方案 T 下属可选后置） |
| 语音输入 | 未实现 |
| ffmpeg / ffprobe 二进制 | **已可用**（缺陷 AZ）—— 曾经报 `CANNOT LINK EXECUTABLE "…/ffmpeg": cannot find "libbinder_ndk.so" from verneed[0] in DT_NEEDED list for "/system/lib64/libui.so"`，**报的是「版本符号找不到」却不是「文件缺失」**：`libandroid-stub_30-1` 发的 `lib/libbinder_ndk.so` 只有 24,000 B 且 `soname=null`、无 `.gnu.version_d`，而 `/system/lib64/libbinder_ndk.so` 是 94,488 B 且带 190 个 `_Z*` 符号；`EngineConfig.buildEnv` 把 `<root>/lib` 放在 `LD_LIBRARY_PATH` 首位（curl/cmake 需要引擎里那批新库），于是桩库**遮蔽**了系统真库，`/system/lib64/libui.so` 的 verneed 解析失败。**真机逐个 `mv` 的 A/B**：只移走 `libbinder_ndk.so` 一个，ffmpeg 立刻变 `ffmpeg version 8.1.3`、ffprobe 变 `ffprobe version 8.1.3`，而 curl 8.22.0 / cmake 4.4.4 / sqlite3 3.54.0 / node v24.18.0 / perl / tesseract 5.5.3 / magick 7.1.2-33 / gs 10.07.1 / pandoc 3.12 / qpdf 12.4.2 / pdftotext 26.02.0 / git 2.56.0 / python3 3.14.6 / clang 21.1.8 / rg 15.2.0 **输出逐字不变**；移走其余四个任意一个 ffmpeg 依旧失败。**旧结论「挪走 5 个桩库只前进一环、改报 `_Z17createHeifDecoderv`」已被推翻** —— 那是挪得太多：同时移走 `libmediandk.so` 会让系统 `libunwindstack.so` 报 `cannot locate symbol "Xzs_Construct"`，所以 mediandk / libandroid / libOpenSLES / libtermux-platform-ns 四个桩库**必须保留**，只删 binder 这一个。**安全性证明**：对整棵引擎（44,324 文件 / 3,577 个 ELF64，含 `extensions/`）做 ELF 头解析，`DT_NEEDED` 里含 `libbinder_ndk.so` 的**一个都没有** ⇒ 删掉不破坏任何依赖。修法：`tools/build-runtime.mjs` 的 `DROPPED_LIBS` 在 `normaliseStageFiles()` 里剔除 `lib/libbinder_ndk.so`，`verify-runtime.mjs` 与 `simulate-install.mjs` 各加一条回归断言（同时校验其余四个仍在）。**音视频预览**另走 ROM 自带 WebView 解码（缺陷 AI） |
| emacs 编辑器 | **已可用**（缺陷 BA + BB）—— `emacs --version` 干净出版本号（`grep -c 'com\.termux'` = 0、stderr 零行），`--batch` → `rc=0 git=0 termux=0`，非 `Loading` 输出只剩 `Dump mode: nil` 一行；`latin-2` / `iso-8859-2` 编码系统都在，`coding-system-for-write` 设 utf-8 时中文正常落盘。曾经刷三条 `Warning: … data dir '/data/data/com.termux/files/usr/…'` 且 `--batch` 报 `Error: file-missing ("Loading charset map" … "8859-2")`。三层根因：① `PRUNE_EXT` 里的 `.map` 把 `etc/charsets/*.map` 131 个字符集映射全裁掉了（池里只剩一个 README）；② 三个数据目录是编译期写死的 C 字符串，只能靠 `EMACSDATA` / `EMACSLOADPATH` / **`EMACSPATH`**（不是 `EMACSLIBEXEC`，emacs 不认那个名字）/ `EMACSDOC` 覆盖；③ `share/emacs/` 下的 `site-lisp` 会被字典序排到 `31.1` 之后，取版本目录时必须过滤「首字符是数字」。另加一份安装期生成的 `$HOME/.emacs.d/kxxy/site-load.el` 消掉 `loadup.el:463` 的 git 探测噪音。**限制**：无 pdump 转储（包里没有 `.pdmp`，且 `(featurep 'android)` = nil 使自 dump 分支永不触发），首次启动要现加载 `loadup.el`，`--batch` 冷启动约 **570 ms**；`emacsclient` 需要先起 daemon。 |
| `ctx.slots` | **是浏览器侧概念**（`dsh-client-ui-slots` 只在 client bundle 里跑），host 侧插件无法注册。要往页面里加 UI，只有两条路：① 写一个**客户端插件**（`package.json` 声明 `dsh.client`，由 `dsh-client-modules` 扫 Loader entries 发现并挂进页面 module 图）；② 构建期改官方 bundle。本项目内置的 `dsh-web-mobile` 走的就是第 ① 条 |

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
