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
│  RuntimeInstaller   解包 runtime.zip（含 LINK 物化 / 九锚点自愈）  │
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
│       ├── res/values/           浅色主题 + 窗口/启动页配色（缺陷 P）
│       ├── res/values-night/     深色主题（同一组资源名，缺陷 P）
│       └── java/app/kxxy/        Kotlin 源码 12 个文件
├── plugins/kxxy-host/            Cordis 插件（宿主管理页）
│   ├── cordis.patch.yml          挂载声明
│   ├── lib/index.js              路由 + API
│   └── web/                      管理页 HTML/CSS/JS（含 compat.js 兼容层）
│       ├── compat.js             旧 ROM WebView 兼容层（缺陷 I/J）
│       ├── mobile.css            移动端适配：设置面板重排 + 左侧栏隐藏/抽屉（缺陷 O）
│       └── mobile.js             同上，负责切类 / 遮罩点击 / 官方按钮判档
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

## 五、移植过程中发现并修掉的 17 个真实缺陷

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
| N | 插件更新不会到达老设备 | 只重装 APK 后，界面仍是旧插件（Shizuku 卡片的「请求授权」按钮、`priv-hint` 提示块全都不出现），必须手工 push 才生效 | `RuntimeInstaller.isComplete()` 的锚点 5 只判 `kxxy-host/package.json` 存在，而那个文件**从 v0.1.0 起内容就没变过**；`runtimeVersion` 戳也不变，于是七锚点全通过、永不重装。修复：新增锚点 8，按插件入口 `kxxy-host/lib/index.js` 首行的版本标记 `kxxy-host@N` 判定过期（与锚点 6/7 同一手法）。**约定：改动 `plugins/kxxy-host/` 下任何文件后，必须递增 `lib/index.js` 首行标记并同步 `RuntimeInstaller.HOST_PLUGIN_MARKER`**，否则老设备不会自愈。后来适配层（纯静态资产）又踩了同一个坑：只改 `mobile.css` / `mobile.js` 时插件入口标记不动，锚点 8 仍判「已是最新」→ 再加**锚点 9**（两份文件共用标记 `kxxy-mobile-ui@N`） |
| O | 官方前端无移动端适配 | ① 设置面板：411px 视口下面板仅 363px 宽，左侧导航硬吃 188px，右侧内容区只剩 175px，`_rowText` 扣掉 `padding-right:48px` 后标题宽 **0px** → 「选择新会话的默认权限模式」每个字一行、「权限」「语言」竖排、模型卡片「编辑/删除」竖排溢出卡片外；② 左侧栏：展开后主内容列从 355px 被压到 **131px** | 官方是纯桌面布局，**没有断点也没有移动端分支**。① 宽度链是 `panel 363px`（`width:800px; max-width:calc(-48px + 100vw)`）→ `nav 188px`（`flex:0 0 auto`，不可压缩）→ `content 175px`（`flex:1 1 0%`）→ `options` 再扣 `padding:0 24px` 只剩 127px → `rowText` 再扣 48px 归零；② `BynINW_frame` 的 `grid-template-columns: 280px minmax(0px,1fr) minmax(0px,0px)` 由 **React 写死在 inline style**（自定义属性全为空、官方样式表里 0 命中），它就是硬挤第二列，没有「覆盖层」概念。修复：新增插件侧移动端适配层 `plugins/kxxy-host/web/mobile.css` + `mobile.js`，注入到 `</head>` 之前（必须晚于官方样式表）。设置面板改为「顶部横向 tab 条 + 全宽内容」；左侧栏做**两态**：折叠态**整栏完全收掉**（连 56px 图标栏都不留）、展开态改为**覆盖式抽屉**。四条硬约束：① 第一列压到 0px 靠 `!important`（官方把列宽写在 React inline style 上，inline 无 `!important` 时 CSS `!important` 可胜出）；② 抽屉必须 `position:absolute` 而非 `fixed` —— 祖先链上有 `z-index:40` 的 static 容器，`fixed` 会输掉层叠竞争，症状是「测量全对但整块不可见」；③ 侧栏脱流后 `centerCol` 必须显式 `grid-column: 2`（grid 会自动把它排到 0px 宽的第 1 列）；④ 隐藏必须用 `visibility` 而**不是** `display:none` —— 官方开合按钮在列内，`display:none` 会让整棵子树退出渲染、按钮一起消失，用户永久失去唯一入口（详见下段「缺陷 O 的补充教训」） |

| P | 「跟随系统」外观恒为深色 | 系统是浅色，app 里「外观 → 跟随系统」却始终渲染深色；切系统深浅色完全没反应 | 官方前端与控制台**都只判 `matchMedia('(prefers-color-scheme: dark)').matches`**（`ui-theme` 的 `buildSnapshot()` 里 `resolvedId = preference === "system" ? (media?.matches === true ? "dark" : "light") : preference`；官方三份 CSS 里 `prefers-color-scheme` 命中数为 **0**，暗色块只挂 `body[data-ds-dark-theme]`）。而 Android WebView 的该媒体特性**不看系统 `Configuration.uiMode`，只看宿主 Activity 主题的 `android:isLightTheme`** —— 本 app 的 `Theme.Kxxy` parent 是 `Theme.Material.NoActionBar`（深色），`isLightTheme=false`，于是恒报 dark。实测探针（改完强制重启，系统 night=no / yes 两次）：`prefersDark=true prefersLight=false rootColorScheme=normal` **两次完全相同**。修复：`values/themes.xml` 的 parent 改为 `Theme.Material.Light.NoActionBar` + 新增 `values-night/themes.xml`（深色 parent，窗口色与原值逐字节相同），另建 `values/colors.xml` 与 `values-night/colors.xml` 供 `MainActivity` / `BootstrapActivity` 取窗口色与启动页文字色（原先两者都硬编码 `0xFF0B0D13` 等） |
| Q | 控制台终端页浅色下配色错配 | 浅色主题下终端卡片里嵌着一张**纯白**的「终端 Shell 诊断」卡，底部六个快捷键按钮**白底浅灰字**几乎不可读 | 终端容器把底色**硬编码**成深色（`.terminal-container` `#151517`、`.terminal-bar`/`.terminal-shortcuts` `#1b1b1c`、`.terminal-viewport` `#101012`、`.terminal-code` `#D1D5DB`，注释还自承「终端保持深色（终端惯例）」），而内部文字与按钮用的是**语义变量**（`.terminal-title` 用 `--text-muted`、`.term-key` 用 `--bg-card` + `--text-secondary`）。浅色主题下这些变量翻成「深灰字、白底」，画在深底上就出现上述两个症状。修复：引入 `--term-surface` / `--term-chrome` / `--term-viewport` / `--term-fg` / `--term-key-bg` / `--term-key-fg` / `--term-border` / `--term-shadow` 一组变量，浅色段与 `body[data-ds-dark-theme]` 段各给一份取值（深色值与原硬编码逐字节相同，零回归）；另给 `.shell-diag-card` 加外边距并抬到 `--bg-elevated` 一层，使其读作「终端内部的独立面板」而不是「嵌进去的补丁」。顺带修掉该诊断卡的**误导性判据**：它原先只判 `cached.startsWith(engineRoot + '/')`，于是引擎 `bin/` 下的任何可执行文件都算「✓ 缓存有效」—— 设备上缓存着 `…/engine/bin/cmd`（那是 Android 的 `cmd` 服务工具，`cmd --help` 报 `Can't find service`，根本不是 shell），卡片却显示有效。现收紧为「必须是已知 shell 的可执行文件名」，并把标题改为「终端 Shell 缓存」+ 说明「官方当前版本已不读该缓存」 |

**关于缺陷 Q 的额外结论（终端功能本身是好的）**：`dsh.terminal.shell` 这个键**已被官方废弃** —— 在四个运行时 bundle（`sidebar-terminal` / `client.terminal` / `terminal-bash` / `terminal`）里对 `/terminal\.shell/` 与 `/localStorage/` 的命中数**都是 0**；官方新建终端走 `webTerminals.selectShell(path)` → 开 tab 时把 `shellPath` 作为参数传下去（`terminal-bash` 的默认值是 `DEFAULT_BASH_SHELL = "/bin/bash"`，可被 `config.shellPath` 覆盖，而该配置由引擎侧注入）。所以那张卡显示的 `bin/cmd` 只是**历史遗留值**，不影响终端；真机上终端本身工作正常（`bash-5.3$` 提示符、`uname -a` 正常），即缺陷 K 的修复仍然有效。对照实验也证明**官方终端天然跟随主题**：浅色下 `.xterm-viewport` 背景透明、文字 `rgb(15,17,21)`，官方 `sidebar-terminal` 插件全部用 `var(--dsw-alias-*)` 官方 token。

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

**缺陷 O 的第三层教训：页面里会同时存在两份注入样式表**。`data-kxxy-mobile`
（引擎按设备上**旧 runtime** 注入）与 `data-kxxy-css`（桌面驱动注入的新版）并存时，
新版把 `display:none` 换成 `visibility` 后**没有显式声明 `display`**，于是旧版那条
`display: none !important` 仍然胜出 —— 现象与上面那条一模一样。所以隐藏态
`sidebarCol` 规则必须**显式写 `display: block !important`**，把旧规则顶回去。
定位这条根因时，JS 侧遍历 `document.styleSheets` 两次都返回 `totalRules: 0`
（遍历器自身有 bug），**换用 CDP 的 `CSS.getMatchedStylesForNode` 一次就拿到
胜出规则**——教训是：当 JS 侧的自查结果与现象矛盾时，别再改遍历器，直接换权威通道。

---

## 六、验证体系（五层）

| 脚本 | 验证什么 | 为什么需要它 |
|---|---|---|
| `verify-runtime.mjs` | zip 结构（条目数 / LINK 注释 / 占位符残留 / 版本标记 / ELF 校验） | 产物完整性 |
| `simulate-install.mjs` | 复刻 `RuntimeInstaller` 的 7 步解包与九锚点判定 | 结构对 ≠ 设备上能装出可启动的树 |
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
