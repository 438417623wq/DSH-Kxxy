# DSH Kxxy —— DeepSeek Harness 安卓移植（方案 T：Web-First）

把桌面版 DSH 的**完整能力**（官方 React 前端 + 86 个插槽 + 插件生态 + Turn 推理链 + Tool Call 卡片）
搬到 Android 手机端，而**不重写 UI**。

核心洞察：DSH 的 Web 面本身就是「浏览器 UI + 本地 HTTP 服务」，与 Electron 外壳解耦
（`dsh-web-app` 只依赖 `webServer` + 前端 dist）。所以手机端不需要移植 Electron，
只需要一个能跑 Node 的引擎 + 一个 WebView。

---

## 一、架构（三层）

```
┌─ 原生层（Kotlin 3,273 行 + C 433 行 + N-API 818 行）──────────────┐
│  BootstrapActivity  首次安装引导（方案 T 下唯一必须原生的 UI）      │
│  MainActivity       纯 WebView 容器，零业务控件                    │
│  WebViewGate        WebView ≥ Chrome 85 检测                      │
│  EngineSupervisor   进程监管 + 指数退避 + 状态文件                 │
│  EngineProcess      PTY 启动引擎（--expose-internals 是硬前提）    │
│  RuntimeInstaller   解包 runtime.zip（含 LINK 物化 / 十一锚点自愈）│
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
│       ├── assets/runtime.zip    555 MiB 运行时（构建产物，**不入库**，见 tools/）
│       ├── assets/ext-pool/      1.0 GiB 扩展包池（构建产物，**不入库**）
│       ├── cpp/                  PTY 原生层
│       ├── res/values/           浅色主题 + 窗口/启动页配色（缺陷 P）
│       ├── res/values-night/     深色主题（同一组资源名，缺陷 P）
│       └── java/app/kxxy/        Kotlin 源码 11 个文件
├── plugins/kxxy-host/            Cordis 插件（宿主管理页）
│   ├── cordis.patch.yml          挂载声明
│   ├── lib/index.js              路由 + API
│   └── web/                      管理页 HTML/CSS/JS（含 compat.js 兼容层）
│       ├── compat.js             旧 ROM WebView 兼容层（缺陷 I/J）
│       └── modern.js             现代内建补齐层（页面 + blob worker/iframe）
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
│   ├── test-modern.mjs           modern.js 补齐层单测（104 行为沙箱 + blob 作用域）
│   ├── prebuilt/                 自研原生产物（Android arm64）
│   └── lib/                      装配/补丁/打包库
└── .cache/                       构建缓存（debs / stage，可删）
```

---

## 三、构建

前置：JDK 17、Android SDK（platforms 36 / build-tools 36 / ndk 28.2 / cmake 3.22.1）。
本机没有 gradle wrapper，用已安装的 Gradle 8.10.2。

> **仓库不含 `assets/runtime.zip`**（555 MiB，`.gitignore` 已排除）—— 它是构建产物，
> 由下面第 1、2 步从**本机已安装的 DSH 桌面版** `app.asar` + Termux aarch64 `.deb` 现场装配。
> 所以完整重建需要本机装有 DSH 桌面版（提供 `dsh` 的 JS 依赖树与前端 dist）。

```powershell
$node = "F:\dsh-desktop\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$gradle = "C:\Users\XiaoXin\.gradle\wrapper\dists\gradle-8.10.2-bin\a04bxjujx95o3nb99gddekhwo\gradle-8.10.2\bin\gradle.bat"

# 1) 拉取 Termux 运行时（④ 全能精选档闭包 220 包，约 310 MiB，可续跑）
& $node tools/fetch-runtime.mjs

# 1.5) 解 stage（poolextract/build-runtime 依赖它；Python 3.12 标准库解 data.tar.xz）
& "C:\Users\XiaoXin\AppData\Local\Programs\Python\Python312\python.exe" tools/lib/debextract.py --debs .cache\debs --out .cache\stage

# 2) 装配 runtime.zip（从 app.asar 抽取 dsh 依赖树 + 打 17 个兼容补丁 + 打包 LibreOffice wasm、CJK 字体与移动端插件）
& $node tools/build-runtime.mjs

# 2.5) 构建扩展包池（J/K 组边际闭包 → assets/ext-pool/*.tar.gz + 扩展目录 extensions.json）
& $node tools/fetch-extensions.mjs

# 3) 七套验证
& $node tools/verify-runtime.mjs
& $node tools/simulate-install.mjs
& $node tools/smoke-plugin.mjs
& $node tools/check-bundle.mjs
& $node tools/test-pty-patch.mjs
& $node tools/test-compat-url.mjs
& $node tools/test-modern.mjs

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
| 5 | 兼容补丁 | 17 个补丁（见下） |
| 6 | 注入 | corepack 包装器 + `kxxy-host` 插件 + 悬空 LINK 清扫 |
| 6.5 | 打包引擎资产 | LibreOffice wasm 引擎（49 文件，剥离 `os` 字段）+ 两份 CJK 字体 |
| 6.6 | 打包移动端插件 | 第三方 `dsh-web-mobile`（209 文件）整包塞进 `lib/node_modules/` |
| 7 | 合并 | 目录 3657 / 文件 30325 / LINK 1560（未压缩 1.43 GiB） |
| 8 | 写出 | 条目 35,543，zip 557.96 MiB |

### 17 个兼容补丁

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
| `document-preview-archive-providers` | 注入 zip / epub 两个归档 provider（缺陷 Y，官方两个格式都没有渲染器） |
| `dsh-manifest` | 把 `kxxy-host` 与内置的 `dsh-web-mobile` 写进 `@deepseek-ai/dsh` 的 dependencies（installation scope，否则 `dsh-client-modules` 扫不到那条 Loader entry） |

---

## 五、移植过程中发现并修掉的 27 个真实缺陷

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

| AA | 自研移动端适配层与官方 UI 冲突，改为内置第三方客户端插件 | 缺陷 O 的第一版修法是**注入 CSS**（`mobile.css` + `mobile.js` 打进 `</head>`），能治「设置面板挤压」与「侧栏遮挡」两件事，但覆盖面有限（弹层、状态栏安全区、软键盘顶起、触控目标尺寸都要自己补），且每处规则都靠 `[class*="语义名"]` 匹配官方运行时类名，官方一升级就可能失效 | 根因是**选错了扩展点**：官方前端本来就是可插拔的（`dsh-client-modules` 会扫 Loader entries，对每个声明了 `package.json` → `dsh.client.platform === "web"` 的包，把它的 `exports["./client"]` 挂进页面 module 图），所以正确的做法是**写一个客户端插件**，而不是从外面往里灌样式。修复：① **整体删除**自研适配层 —— 删 `android/app/src/main/java/app/kxxy/AdaptLayer.kt`（466 行）、`plugins/kxxy-host/web/mobile.css`（16,080 B）与 `mobile.js`（10,816 B）、`plugins/kxxy-host/lib/index.js` 里的 `mobileCss()`/`mobileScript()`/`injectMobileUi()` 与 `ctx.webServer.tapIndex(injectMobileUi)`，以及 `RuntimeInstaller` 的锚点 9（`kxxy-mobile-ui@N`）；② 新增**阶段 6.6** 从 npmmirror 拉 `dsh-web-mobile@3.1.0`（`unpackedSize` 4,159,505，209 文件）整包解进 `lib/node_modules/dsh-web-mobile/`，并在包内写一份 `plugin.version`（内容 `kxxy-mobile-plugin@1`）作为**锚点 10** 的探针；③ `patchDshManifest` 除 `kxxy-host` 外再写一行 `dsh-web-mobile` 进 `@deepseek-ai/dsh/package.json` 的 `dependencies` —— **这一步是决定性的**：`dsh-app-boot` 的 `collectInstallationScopePackages()` 从该 manifest 出发 BFS `dependencies` + `peerDependencies` 产出 installation scope，**只有进了 scope 的包才会被 `routeScoped` 判成 `{kind:"interception"}`**；漏掉它的话插件文件全都在设备上，但永远不产生 Loader entry，`dsh-client-modules` 扫不到，表现与「没打包」一模一样；④ `EngineConfig.overlayContent()` 的 `insert:` 列表补一行 `- id: dsh-web-mobile` / `name: dsh-web-mobile`（**不是**加进 `plugins/kxxy-host/cordis.patch.yml` —— kxxy-host 本身不是 profile bundle，那个文件在设备上根本没被加载，真正生效的一直是 `--patch android-overlay.yml`）。三条硬约束：① 客户端半区通过 `package.json` 的 `dsh.client` **声明**被发现，不是通过 `cordis.patch.yml`（后者只让宿主 Loader 里有一行，且宿主半区可以是空 `apply`）；② `exports` 必须给出 `./client`，否则 `dsh-client-modules` 直接抛 `declares dsh.client but exports no "./client" bundle`；③ 内置第三方插件的整包必须**原样**落盘（含 `lib/client.js` 814,043 B 的预构建产物），构建期不重新打包 —— 它的客户端 bundle 是自研打包器（`scripts/build-client.mjs`）的产物，`require()` 的 56 个相对模块 + 3 个外部名（`react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`）都依赖那个打包格式 |

：`dsh.terminal.shell` 这个键**已被官方废弃** —— 在四个运行时 bundle（`sidebar-terminal` / `client.terminal` / `terminal-bash` / `terminal`）里对 `/terminal\.shell/` 与 `/localStorage/` 的命中数**都是 0**；官方新建终端走 `webTerminals.selectShell(path)` → 开 tab 时把 `shellPath` 作为参数传下去（`terminal-bash` 的默认值是 `DEFAULT_BASH_SHELL = "/bin/bash"`，可被 `config.shellPath` 覆盖，而该配置由引擎侧注入）。所以那张卡显示的 `bin/cmd` 只是**历史遗留值**，不影响终端；真机上终端本身工作正常（`bash-5.3$` 提示符、`uname -a` 正常），即缺陷 K 的修复仍然有效。对照实验也证明**官方终端天然跟随主题**：浅色下 `.xterm-viewport` 背景透明、文字 `rgb(15,17,21)`，官方 `sidebar-terminal` 插件全部用 `var(--dsw-alias-*)` 官方 token。

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

## 六、验证体系（九层）

| 脚本 | 验证什么 | 为什么需要它 |
|---|---|---|
| `verify-runtime.mjs` | zip 结构（条目数 / LINK 注释 / 占位符残留 / 版本标记 / ELF 校验 / 字体 sfnt 魔数） | 产物完整性 |
| `simulate-install.mjs` | 复刻 `RuntimeInstaller` 的 7 步解包与十一锚点判定 | 结构对 ≠ 设备上能装出可启动的树 |
| `smoke-plugin.mjs` | 复刻官方 `WebServer` 路由契约起真实 HTTP，并断言兼容层/现代内建补齐层的关键实现在场、版本标记与 Kotlin 常量一致 | 文件铺对了 ≠ 插件能挂起来 |
| `check-bundle.mjs` | 用**真实** `dsh-app-boot` 走解析链 | 插件能跑 ≠ DSH 能发现它 |
| `test-pty-patch.mjs` | 17 个补丁的离线单测（自带 fixture，不依赖仓库外文件） | 补丁改错了构建照样全绿，只有点开终端才炸 |
| `test-compat-url.mjs` | 在「WebView 104 行为沙箱」里跑真实 `compat.js`，断言 URL 补丁的 25 组取值与 8 组回归 | `smoke-plugin` 只能验「实现在场」，验不了语义边界（特殊协议、空 authority、userinfo/port）—— 而边界恰恰最容易改坏 |
| `test-compat-css.mjs` | 断言 `@scope` 展开器的 27 组取值（含嵌套 `@media`/`@supports`/`@layer`、`@keyframes` 内部原样保留） | 展开器是纯文本重写，一个括号配平错误就会让整张样式表失效 |
| `test-modern.mjs` | 每个用例一个**独立 vm realm** 的「104 沙箱」，跑真实 `modern.js`，断言补齐结果 + `URL.createObjectURL` 对 script/html 两类 blob 的前置注入 + 幂等 | 补齐层最危险的失败模式是「本地全绿、真机只显示渲染进程无法继续」—— 补齐源码要被 `Function.prototype.toString()` 搬进 worker 执行，引用本文件作用域里任何变量都不会在本地报错 |
| `test-archive-providers.mjs` | 在 `vm` 沙箱里跑 `tools/prebuilt/documentpreview-archive/providers.js`，断言 ZIP 中央目录解析（含 ZIP64、目录项、加密位）、`kxxyInflateRaw`、EPUB OPF/spine 解析、内联资源与预算控制 | 归档 provider 是**注入进 26 万字符扁平 bundle 作用域**的片段，本地没有模块边界兜底；ZIP 解析器的边界（EOCD 扫描窗口、ZIP64 扩展字段顺序）只有单测能覆盖 |

外加**端到端实测**：用宿主 node 直接跑装配产物，验证
`/`（官方前端 + token 认证）、`/kxxy`（管理页）、`/kxxy/api/*`（API）、
以及边界行为（恶意 Host 403、目录穿越 400、未知端点 404）。

---

## 七、已知限制

| 项 | 状态 |
|---|---|
| Office 文档预览 | **已可用**（缺陷 X）—— 走 LibreOffice wasm 后端，doc/docx/odt/xls/xlsx/ods/ppt/pptx/odp 九种格式都能转 PDF。代价是包体：wasm 引擎 145 MiB + 两份 CJK 字体 21 MiB 使 runtime.zip 从 497 MiB 涨到 555 MiB、APK 从 1,545 MiB 涨到 1,604 MiB；转换在设备上约 4–5 s、峰值 RSS 约 400–715 MiB。**首次转换有冷启动**（wasm 模块加载约 1.4 s） |
| 归档 / 电子书预览 | **已可用**（缺陷 Z）—— zip 列条目 + 点开预览文本条目；epub 按 OPF spine 拼出可滚动单页。**限制**：zip 单条目解压上限 16 MiB、epub 内联资源总预算 24 MiB；只支持 `stored` 与 `deflate`（`deflate64` / `bzip2` / `lzma` 等少见方式会报「不支持的压缩方式」）；加密 zip 明确拒绝；**纯前端解压，不做流式**，打开超大 zip 会把整个文件读进内存 |
| 沙箱隔离 | Android 无 landlock/seatbelt，固定 `danger-full-access` |
| 无障碍服务 | 未实现（参考项目有 1,495 行，方案 T 下属可选后置） |
| 语音输入 | 未实现 |
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
