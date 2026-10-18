/**
 * 内置清单：④ 全能精选档种子包 + 扩展包池目录（J/K 组）。
 *
 * 抽成共享模块的理由：fetch-runtime.mjs（预装闭包）与 fetch-extensions.mjs
 * （包池边际闭包）必须用**同一份种子表**求交 —— 包池条目 = 包的闭包 − 预装闭包，
 * 两边种子表一旦漂移，包池里就会出现与预装重复的文件。
 *
 * 档位决策（用户已确认 ④ 全能精选档，2026-10-10）：
 *   预装 = ①②③④ 全量（220 包，APK ~366 MiB），J/K 组进包池（点了才本地展开，仍零联网）。
 */

/** Termux 主仓库（预装与包池共用；镜像切换只影响 npm 源，不影响构建期）。 */
export const TERMUX_REPO = "https://packages.termux.dev/apt/termux-main";

/** ④ 档种子：基线 22 包 + G0–G9 十组。 */
export const SEED_PACKAGES = [
  // ── 基线：让 DSH 引擎本身跑起来（22 个，缺一不可）──────────────────
  "nodejs-lts",                                        // node 本体（含 npm）
  "bash", "readline", "ncurses", "libiconv", "termux-tools", // bash 执行闭包
  "ripgrep", "pcre2",                                  // bionic 原生 rg
  "openssl", "c-ares", "libicu", "libsqlite", "zlib", "libc++", // nodejs-lts 硬依赖
  "libuv", "brotli",                                   // 静态链接兜底
  "libandroid-support",                                // bionic 兼容层辅助
  "ca-certificates",                                   // HTTPS 根证书
  "git", "openssh", "libcurl", "libexpat",             // 版本控制与远程访问

  // ── G0 构建小件：所有「./configure && make」流程的地基 ──────────────
  "make", "ninja", "cmake", "pkg-config",

  // ── G1 脚本与数据：AI 写脚本、处理 JSON/CSV/SQLite 的日常工具 ───────
  "python", "python-pip", "jq", "yq", "fd", "fzf", "bat", "eza",
  "tree", "sd", "sqlite", "bc", "lua54",

  // ── G2 归档压缩：任何格式都能解 ────────────────────────────────────
  // xz-utils/tar/gzip/bzip2 已在基线（Termux deb 内层就是 data.tar.xz）。
  "zstd", "lz4", "zip", "unzip", "7zip", "unrar", "cpio", "libarchive",

  // ── G3 C/C++ 编译链：让 AI 能编译原生代码（含 Node 原生模块）────────
  // 注意 ndk-sysroot 提供 bionic 的 libc 头文件，clang 单独装不出可编译环境。
  "clang", "libllvm", "llvm", "lld", "libcompiler-rt", "binutils",
  "ndk-sysroot", "patchelf", "termux-elf-cleaner", "file",

  // ── G4 安卓打包链：dex → 签名 → 对齐，全套官方工具 ─────────────────
  // d8/apksigner/aapt2 只依赖 openjdk-21（不依赖 17），装两个 JDK 纯浪费 91.8 MiB。
  "openjdk-21", "d8", "ecj", "aapt2", "apksigner", "android-tools",

  // ── G5 移动端专属：让 AI 能调手机硬件 ──────────────────────────────
  "termux-api", "termux-services", "termux-auth", "termux-exec",
  "libandroid-glob", "libandroid-execinfo", "libandroid-sysv-semaphore",
  "libandroid-posix-semaphore", "libandroid-wordexp", "libandroid-utimes",
  "libandroid-shmem", "libandroid-spawn",

  // ── G6 容器提权：proot 里跑完整 Debian/Ubuntu ──────────────────────
  "proot", "proot-distro", "tsu", "fakeroot", "libcap",

  // ── G7 终端生存：标准 Unix 环境补全 ────────────────────────────────
  // coreutils/findutils/diffutils/less/procps/psmisc/util-linux 已在基线。
  "which", "time", "lsof", "strace", "htop", "tmux", "busybox", "nano", "ed",

  // ── G8 网络：下载、同步、隧道、诊断 ────────────────────────────────
  "wget", "rsync", "aria2", "sshpass", "socat", "netcat-openbsd",
  "dnsutils", "inetutils", "mosh", "dropbear", "gnupg",

  // ── G9 包管理：AI 能自己查/装包 ────────────────────────────────────
  "dpkg", "debianutils", "command-not-found", "root-repo", "x11-repo",
];

/**
 * 扩展包池目录（五项改进方案 §4.1 J/K 组，全部进池不预装）。
 *
 * 每一项在构建期展开为「闭包 − 预装闭包」的边际集合，打成
 * `android/app/src/main/assets/ext-pool/<id>.tar.gz`；用户在扩展中心点
 * 「获取」时由 kxxy-host 本地解包（零联网）。
 *
 * 不收录：openjdk-17（与 21 并存纯浪费）、swift（安卓开发用不上）——
 * 见方案 §4.1 K 组「不建议」注记。
 */
export const POOL_ITEMS = [
  // ── J 组：媒体与文档 ────────────────────────────────────────────────
  {
    id: "ffmpeg", seeds: ["ffmpeg"], category: "media",
    name: "FFmpeg 多媒体工具链",
    description: "音视频转换、剪辑、抽帧、抽音轨。手机端做语音/视频处理绕不开它。",
    bins: ["ffmpeg", "ffprobe"],
  },
  {
    id: "imagemagick", seeds: ["imagemagick"], category: "media",
    name: "ImageMagick 图像处理",
    description: "图像缩放/裁剪/格式转换/合成（与 DSH 自带 sharp 有部分重叠，重场景仍需要它）。",
    bins: ["magick", "convert", "identify"],
  },
  {
    id: "tesseract", seeds: ["tesseract"], category: "media",
    name: "Tesseract OCR 文字识别",
    description: "离线 OCR（与 DSH 自带 modlens 视觉模型互补：批量、精确坐标场景更省电）。",
    bins: ["tesseract"],
  },
  {
    id: "poppler", seeds: ["poppler"], category: "media",
    name: "Poppler PDF 工具",
    description: "PDF 提取文字 / 渲染成图 / 拆页合并。",
    bins: ["pdftotext", "pdftoppm", "pdfinfo"],
  },
  {
    id: "ghostscript", seeds: ["ghostscript"], category: "media",
    name: "Ghostscript",
    description: "PDF/PS 转图、压缩、打印处理。",
    bins: ["gs"],
  },
  {
    id: "exiftool", seeds: ["exiftool"], category: "media",
    name: "ExifTool 元数据",
    description: "读写图片/视频的 EXIF / XMP 元数据。",
    bins: ["exiftool"],
  },
  {
    id: "mediainfo", seeds: ["mediainfo"], category: "media",
    name: "MediaInfo",
    description: "读取媒体文件的编码、码率、轨道信息。",
    bins: ["mediainfo"],
  },
  {
    id: "sox", seeds: ["sox"], category: "media",
    name: "SoX 音频处理",
    description: "音频格式转换、降噪、变速（语音识别前的切片预处理）。",
    bins: ["sox"],
  },
  {
    id: "yt-dlp", seeds: ["yt-dlp"], category: "media",
    name: "yt-dlp 视频下载",
    description: "主流视频站点的命令行下载器（需自备网络环境）。",
    bins: ["yt-dlp"],
  },
  {
    id: "qpdf", seeds: ["qpdf"], category: "media",
    name: "QPDF",
    description: "PDF 结构级拆分、合并、解密、线性化。",
    bins: ["qpdf"],
  },

  // ── K 组：可选重件（体积大，全部进池不预装）─────────────────────────
  {
    id: "gradle", seeds: ["gradle"], category: "toolchain",
    name: "Gradle 构建系统",
    description: "安卓官方构建系统。注意：构建时还要联网拉依赖，手机上体验有限。",
    bins: ["gradle"],
  },
  {
    id: "rust", seeds: ["rust"], category: "toolchain",
    name: "Rust 工具链",
    description: "rustc + cargo，编译 Rust 项目与 Node 原生模块。",
    bins: ["rustc", "cargo"],
  },
  {
    id: "kotlin", seeds: ["kotlin"], category: "toolchain",
    name: "Kotlin 编译器",
    description: "kotlinc。d8 已能处理 kotlinc 产出的 class。",
    bins: ["kotlinc"],
  },
  {
    id: "golang", seeds: ["golang"], category: "toolchain",
    name: "Go 工具链",
    description: "go 编译器与工具（含 go mod）。",
    bins: ["go", "gofmt"],
  },
  {
    id: "gdb", seeds: ["gdb"], category: "toolchain",
    name: "GDB 调试器",
    description: "C/C++ 断点调试。",
    bins: ["gdb"],
  },
  // ── L 组：Java / 脚本语言运行时（缺陷 BL / BN / BO 的补齐）─────────────
  //
  // 这五个都是「用户报缺、Termux 主仓确实有」的常驻语言工具链，此前完全
  // 没进池 —— 真机上 `mvn` / `php` / `ruby` / `erl` / `yarn` 一律 command
  // not found。边际体积（相对 ④ 预装闭包）实测：maven 9.17 MiB、
  // yarn 875 KiB、php 13.33 MiB、ruby 9.33 MiB、erlang 44.82 MiB，合计
  // 约 77.5 MiB，相对现有 1.1 GiB 池增 7%，可以接受。
  //
  // ⚠️ maven 的 37 包闭包里 36 包已在预装基线（openjdk-21 等），所以边际
  // 只有 maven 本体 —— 但它**依赖 openjdk-21**，而 openjdk-21 只在 ④ 档
  // 预装里；③ 档用户装 maven 时 `java` 可能不存在。所以 Maven 的运行
  // 还依赖 EngineConfig 注入的 JAVA_HOME（见 buildEnv 的 javaHome 探测）。
  {
    id: "maven", seeds: ["maven"], category: "toolchain",
    name: "Apache Maven",
    description: "mvn 构建 Java 工程。依赖引擎自带 OpenJDK 21，联网拉依赖仍走手机网络。",
    bins: ["mvn"],
  },
  {
    id: "php", seeds: ["php"], category: "devtools",
    name: "PHP",
    description: "php 8.x 解释器与 CLI（含 libxml/libzip/tidy 等扩展依赖）。",
    bins: ["php"],
  },
  {
    id: "ruby", seeds: ["ruby"], category: "devtools",
    name: "Ruby",
    description: "ruby 4.x 解释器与 gem 基础设施。",
    bins: ["ruby", "gem", "irb"],
  },
  {
    id: "erlang", seeds: ["erlang"], category: "devtools",
    name: "Erlang/OTP",
    description: "erl / escript / erlc，OTP 运行时（体积较大，44 MiB）。",
    bins: ["erl", "erlc", "escript"],
  },
  {
    id: "yarn", seeds: ["yarn"], category: "devtools",
    name: "Yarn",
    description: "经典 Yarn 1.x 包管理器（引擎已带 node，不需要它拉 nodejs）。",
    bins: ["yarn", "yarnpkg"],
  },
  {
    id: "texlive", seeds: ["texlive-bin"], category: "toolchain",
    name: "TeX Live (bin)",
    description: "LaTeX 排版引擎本体（宏包需另外获取）。",
    bins: ["pdflatex", "latex", "xelatex"],
  },
  {
    id: "autotools", seeds: ["autoconf", "automake"], category: "toolchain",
    name: "Autoconf/Automake",
    description: "老式「./configure && make」工程的构建套件。",
    bins: ["autoconf", "automake"],
  },
  {
    id: "pandoc", seeds: ["pandoc"], category: "devtools",
    name: "Pandoc",
    description: "Markdown / HTML / docx / LaTeX 之间的万能文档转换。",
    bins: ["pandoc"],
  },
  {
    id: "emacs", seeds: ["emacs"], category: "devtools",
    name: "Emacs",
    description: "无头模式可用的编辑器 / org-mode 处理器。",
    bins: ["emacs", "emacsclient"],
  },
  {
    id: "gnuplot", seeds: ["gnuplot"], category: "devtools",
    name: "Gnuplot",
    description: "命令行画图表（数据可视化、函数绘图）。",
    bins: ["gnuplot"],
  },
  {
    id: "perl", seeds: ["perl"], category: "devtools",
    name: "Perl",
    description: "git-svn / git-p4 的依赖，经典脚本语言。",
    bins: ["perl"],
  },
];
