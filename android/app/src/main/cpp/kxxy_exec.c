/*
 * kxxy_exec.c —— exec 族路径重写预加载库（缺陷 CC，问题清单 P3）
 *
 * ── 要解决什么 ────────────────────────────────────────────────────────────
 *
 * runtime 是从 Termux 的 `/data/data/com.termux/files/usr` 整体搬过来的，
 * 但有一批 ELF 二进制把那个前缀**编译期写死**在了里面（真机实测 695 个）。
 * 于是 `make` 在处理任何带管道/引号/变量展开的命令时都会：
 *
 *     make: /data/data/com.termux/files/usr/bin/sh: No such file or directory
 *     make: *** [Makefile:2: all] Error 127
 *
 * GNU make 对「简单命令」走 fast-path（自己 fork+exec，不经过 shell），
 * 所以 `@echo hi` 能跑；一遇 `|`、`"`、`$(var)` 就切成 `SHELL -c`，
 * 而 SHELL 是编译期常量，`SHELL` 环境变量对它无效（make 的规则：
 * 环境里的 SHELL 只影响 exported 变量的值，不改变它自己用的 shell）。
 * 同型的还有 tar / ninja / autoreconf / 7z / gzip 等。
 *
 * ── 为什么不用 termux-exec ────────────────────────────────────────────────
 *
 * termux-exec 已经在 runtime 里（`lib/libtermux-exec-ld-preload.so`），
 * 我们也用了它：它解决 **P1**（`#!/usr/bin/env node` 的 bad interpreter），
 * 靠的是「给裸命令名加 `TERMUX__PREFIX` 前缀」+「修 shebang 的解释器路径」。
 * 但它**不改写调用方传进来的绝对路径** —— 那是它设计上的边界（它服务的是
 * 一个前缀固定的真 Termux）。`execve("/data/data/com.termux/files/usr/bin/sh")`
 * 这样的调用它会原样放行，于是 ENOENT。
 *
 * 所以这个库补的就是这一半：把**绝对路径**里以旧前缀开头的部分换成
 * `KXXY_ROOT`。两个库串联使用（本库在 LD_PRELOAD 里排前面）。
 *
 * ── 实现取舍 ──────────────────────────────────────────────────────────────
 *
 * · 拦 exec 族、posix_spawn、**dlopen**，以及 **open/openat 中极窄的一类**
 *   （只匹配 `.../usr/etc/` 前缀，见缺陷 CZ）。文件系统这一层构建期已经用
 *   @DSH_ROOT@ 占位符改写过（normaliseStageFiles + rewriteRootPlaceholder），
 *   所以**不**做全量 open 拦截 —— open 的热度比 exec 高几个数量级，全量拦会
 *   把 strlen/memcmp 的代价摊到每个进程的每次文件访问上。
 *   dlopen 是例外：它加载的是 ELF，而 ELF 里的路径**不可能**被构建期改写
 *   （改长度会让节偏移与重定位表错位），且调用频率极低。见缺陷 CR。
 *   open 的窄例外同理：go 的纯 Go resolver 把 resolv.conf 路径编译期写死，
 *   而它是**普通文本文件**、不属于会被改写的 ELF，只能运行期接上。见缺陷 CZ。
 * · 前缀匹配**从长到短**：`.../files/usr` 必须排在 `.../files` 与
 *   `.../` 之前，否则 `.../files/usr/bin/sh` 会先被 `.../files` 吃掉、
 *   变成 `<root>/usr/bin/sh`（多一层不存在的 usr）。
 * · 每次 exec 都现算新路径（不缓存），因为 exec 本身就不频繁，而缓存要在
 *   多线程下做引用计数，得不偿失。用完了 free。
 * · 重写后的路径**不检查存在性**。看起来更安全，但会让「本来就不存在」
 *   的调用变成「路径没改」而误导排查；直接交给内核返回 ENOENT 更诚实，
 *   而且真的存在旧前缀软链的情况也不会被我们破坏。
 */

#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

/* 四个旧前缀，**顺序即优先级**：长的在前。 */
static const char *const OLD_PREFIXES[] = {
    "/data/data/com.termux/files/usr",
    "/data/data/com.termux/files/home",
    "/data/data/com.termux/cache",
    "/data/data/com.termux/files",
    "/data/data/com.termux",
};
static const size_t OLD_COUNT =
    sizeof(OLD_PREFIXES) / sizeof(OLD_PREFIXES[0]);

/* 对应的新根。由 init_roots() 从环境变量读一次。 */
static char *g_roots[OLD_COUNT];
static pthread_once_t g_once = PTHREAD_ONCE_INIT;

static void init_roots(void) {
    /* KXXY_ROOT 是引擎根；HOME 与 TMPDIR 各自独立给。 */
    const char *root = getenv("KXXY_ROOT");
    const char *home = getenv("HOME");
    const char *tmp = getenv("TMPDIR");

    /* files/usr → root，files/home → HOME，com.termux/cache → TMPDIR，
       files → (root 的父目录)，com.termux → (root 的祖父目录)。
       后两条只在极少见的地方出现（perl 的 -Dsysroot），但仍然要覆盖。 */
    char *files = NULL;
    char *data = NULL;

    if (root != NULL) {
        char *slash = strrchr(root, '/');
        if (slash != NULL && slash != root) {
            files = strndup(root, (size_t)(slash - root));
            char *slash2 = strrchr(files, '/');
            if (slash2 != NULL && slash2 != files) {
                data = strndup(files, (size_t)(slash2 - files));
            }
        }
    }

    g_roots[0] = (root != NULL) ? strdup(root) : NULL;
    g_roots[1] = (home != NULL) ? strdup(home) : NULL;
    g_roots[2] = (tmp != NULL) ? strdup(tmp) : NULL;
    g_roots[3] = files;
    g_roots[4] = data;
}

static void ensure_roots(void) { pthread_once(&g_once, init_roots); }

/*
 * 返回重写后的新字符串（调用方负责 free），无需重写时返回 NULL。
 */
static char *rewrite_path(const char *path) {
    if (path == NULL || path[0] != '/') return NULL;

    ensure_roots();

    for (size_t i = 0; i < OLD_COUNT; i++) {
        if (g_roots[i] == NULL) continue;
        size_t n = strlen(OLD_PREFIXES[i]);
        if (strncmp(path, OLD_PREFIXES[i], n) != 0) continue;
        /* 必须是完整的一段：`.../usrX` 不算命中 `.../usr`。 */
        if (path[n] != '\0' && path[n] != '/') continue;

        size_t rest = strlen(path + n);
        size_t base = strlen(g_roots[i]);
        char *out = malloc(base + rest + 1);
        if (out == NULL) return NULL;
        memcpy(out, g_roots[i], base);
        memcpy(out + base, path + n, rest + 1);
        return out;
    }
    return NULL;
}

/* ── execve ─────────────────────────────────────────────────────────────── */

typedef int (*execve_fn)(const char *, char *const[], char *const[]);

int execve(const char *path, char *const argv[], char *const envp[]) {
    static execve_fn real = NULL;
    if (real == NULL) real = (execve_fn)dlsym(RTLD_NEXT, "execve");

    char *fixed = rewrite_path(path);
    if (fixed != NULL) {
        int rc = real(fixed, argv, envp);
        int saved = errno;
        /* 重写后的路径不存在时退回原始路径：万一调用方本来就是想命中
           一个真实存在的旧前缀（例如设备上同时装了真 Termux），不该
           因为我们的改写而变得不可用。 */
        if (rc == -1 && (saved == ENOENT || saved == ENOTDIR)) {
            free(fixed);
            return real(path, argv, envp);
        }
        free(fixed);
        errno = saved;
        return rc;
    }
    return real(path, argv, envp);
}

/* ── execv ──────────────────────────────────────────────────────────────── */

typedef int (*execv_fn)(const char *, char *const[]);

int execv(const char *path, char *const argv[]) {
    static execv_fn real = NULL;
    if (real == NULL) real = (execv_fn)dlsym(RTLD_NEXT, "execv");

    char *fixed = rewrite_path(path);
    if (fixed != NULL) {
        int rc = real(fixed, argv);
        int saved = errno;
        if (rc == -1 && (saved == ENOENT || saved == ENOTDIR)) {
            free(fixed);
            return real(path, argv);
        }
        free(fixed);
        errno = saved;
        return rc;
    }
    return real(path, argv);
}

/* ── execvp / execvpe ───────────────────────────────────────────────────── */

typedef int (*execvp_fn)(const char *, char *const[]);

int execvp(const char *file, char *const argv[]) {
    static execvp_fn real = NULL;
    if (real == NULL) real = (execvp_fn)dlsym(RTLD_NEXT, "execvp");

    /* 裸命令名交给 termux-exec（它会用 TERMUX__PREFIX 补全）；
       只有写死的绝对路径才由我们改。 */
    char *fixed = rewrite_path(file);
    if (fixed != NULL) {
        int rc = real(fixed, argv);
        int saved = errno;
        if (rc == -1 && (saved == ENOENT || saved == ENOTDIR)) {
            free(fixed);
            return real(file, argv);
        }
        free(fixed);
        errno = saved;
        return rc;
    }
    return real(file, argv);
}

typedef int (*execvpe_fn)(const char *, char *const[], char *const[]);

int execvpe(const char *file, char *const argv[], char *const envp[]) {
    static execvpe_fn real = NULL;
    if (real == NULL) real = (execvpe_fn)dlsym(RTLD_NEXT, "execvpe");
    if (real == NULL) {
        errno = ENOSYS;
        return -1;
    }

    char *fixed = rewrite_path(file);
    if (fixed != NULL) {
        int rc = real(fixed, argv, envp);
        int saved = errno;
        if (rc == -1 && (saved == ENOENT || saved == ENOTDIR)) {
            free(fixed);
            return real(file, argv, envp);
        }
        free(fixed);
        errno = saved;
        return rc;
    }
    return real(file, argv, envp);
}

/* ── execl / execlp / execle ────────────────────────────────────────────── */

/* execl 系列是变参：先把 argv 收进数组，再复用 execv 的路径重写。 */
typedef int (*execl_fn)(const char *, const char *, ...);

int execl(const char *path, const char *arg0, ...) {
    static execl_fn real = NULL;
    if (real == NULL) real = (execl_fn)dlsym(RTLD_NEXT, "execl");

    /*
     * 变参无法「重放」给 real，所以这里用 execv 的语义自己收参数。
     * 注意 va_arg 从 arg0 之后开始。
     */
    size_t cap = 8, n = 0;
    char **argv = malloc(cap * sizeof(char *));
    if (argv == NULL) return real(path, arg0, NULL);
    argv[n++] = (char *)arg0;

    va_list ap;
    va_start(ap, arg0);
    for (;;) {
        char *a = va_arg(ap, char *);
        if (a == NULL) break;
        if (n + 1 >= cap) {
            cap *= 2;
            char **grown = realloc(argv, cap * sizeof(char *));
            if (grown == NULL) {
                va_end(ap);
                free(argv);
                return real(path, arg0, NULL);
            }
            argv = grown;
        }
        argv[n++] = a;
    }
    va_end(ap);
    argv[n] = NULL;

    int rc = execv(path, argv);
    int saved = errno;
    free(argv);
    errno = saved;
    return rc;
}

/* ── posix_spawn / posix_spawnp ─────────────────────────────────────────── */

typedef int (*spawn_fn)(pid_t *, const char *,
                        const posix_spawn_file_actions_t *,
                        const posix_spawnattr_t *, char *const[],
                        char *const[]);

int posix_spawn(pid_t *pid, const char *path,
                const posix_spawn_file_actions_t *file_actions,
                const posix_spawnattr_t *attrp, char *const argv[],
                char *const envp[]) {
    static spawn_fn real = NULL;
    if (real == NULL) real = (spawn_fn)dlsym(RTLD_NEXT, "posix_spawn");

    char *fixed = rewrite_path(path);
    if (fixed != NULL) {
        int rc = real(pid, fixed, file_actions, attrp, argv, envp);
        int saved = errno;
        if (rc == ENOENT || rc == ENOTDIR) {
            free(fixed);
            return real(pid, path, file_actions, attrp, argv, envp);
        }
        free(fixed);
        errno = saved;
        return rc;
    }
    return real(pid, path, file_actions, attrp, argv, envp);
}

int posix_spawnp(pid_t *pid, const char *file,
                 const posix_spawn_file_actions_t *file_actions,
                 const posix_spawnattr_t *attrp, char *const argv[],
                 char *const envp[]) {
    static spawn_fn real = NULL;
    if (real == NULL) real = (spawn_fn)dlsym(RTLD_NEXT, "posix_spawnp");

    char *fixed = rewrite_path(file);
    if (fixed != NULL) {
        int rc = real(pid, fixed, file_actions, attrp, argv, envp);
        int saved = errno;
        if (rc == ENOENT || rc == ENOTDIR) {
            free(fixed);
            return real(pid, file, file_actions, attrp, argv, envp);
        }
        free(fixed);
        errno = saved;
        return rc;
    }
    return real(pid, file, file_actions, attrp, argv, envp);
}

/* ── dlopen ─────────────────────────────────────────────────────────────── */

/*
 * 缺陷 CR（问题 3：`7z` 主命令报 Codec Load Error）：
 *
 * 7z 的 codec 是**插件**，通过 `dlopen("/data/data/com.termux/files/usr/libexec/
 * 7zip/7z.so")` 加载，而不是链接期依赖。这条路径编译期写死，`readelf -d` 里
 * 只看到 RUNPATH=`.../usr/lib`，插件本身在 `libexec/7zip/`，只能靠 dlopen 的
 * 绝对路径命中。真机实测：
 *
 *   $ 7z a q.7z z.txt
 *   Codec Load Error: /data/data/com.termux/files/usr/libexec/7zip/7z.so : errno=2
 *   System ERROR: E_NOTIMPL
 *   rc=2
 *
 * 而 `7za` / `7zr` / `7zz` 都是自包含的单体二进制（不 dlopen），所以全 rc=0 ——
 * 这也解释了「为什么只有 7z 一个命令坏」。
 *
 * 本库原先只拦 exec 族，注释里明确写了「不拦 open」—— 那条取舍针对的是**文件
 * 系统层**（构建期已用 `@DSH_ROOT@` 占位符把脚本与配置改写过，运行期再拦 open
 * 只会增加不确定性，且 open 的热度比 exec 高几个数量级）。`dlopen` 不一样：
 *
 *   1. 它的调用频率极低（一个进程通常只有个位数次）；
 *   2. 它加载的是 **ELF**，而 ELF 里的路径**不可能**被构建期改写
 *      （poolextract 的 `rewrite_prefixes` 遇到 ELF_MAGIC 直接早退，因为改长度
 *      会让节偏移与重定位表错位）；
 *   3. 它没有「PATH 搜索」这种旁路，路径错了就是错了。
 *
 * 所以这里补上这一层，用同一个 `rewrite_path()`。
 *
 * 回落语义照 exec 族：重写后加载失败（返回 NULL）就用原路径再试一次 ——
 * 这样「旧前缀路径恰好存在」（比如用户自己建了 /data/data/com.termux）时行为
 * 与不装本库时完全一致，不会因为我们改写了路径而变得更差。
 *
 * 注意 `filename == NULL` 是合法调用（dlopen(NULL, ...) 返回主程序句柄），
 * 必须原样透传，不能进 rewrite_path。
 */

typedef void *(*dlopen_fn)(const char *filename, int flags);

void *dlopen(const char *filename, int flags) {
    static dlopen_fn real = NULL;
    if (real == NULL) real = (dlopen_fn)dlsym(RTLD_NEXT, "dlopen");

    if (filename == NULL || real == NULL) return real(filename, flags);

    char *fixed = rewrite_path(filename);
    if (fixed == NULL) return real(filename, flags);

    void *handle = real(fixed, flags);
    free(fixed);
    if (handle != NULL) return handle;

    /* 重写后的路径加载失败：清掉本次 dlerror，用原路径重试。 */
    (void)dlerror();
    return real(filename, flags);
}

/* ── system / popen 的 shell ────────────────────────────────────────────── */

/*
 * system() 与 popen() 内部走 `/bin/sh`（Android 上确实存在，是 toybox），
 * 不需要重写；但**如果调用方显式指定了 SHELL** 或用的 `sh -c` 带了绝对
 * 路径，就由上面的 execve 拦截兜住。这里不插一层，避免额外复杂度。
 */

/* ── openat / open：只拦「配置目录」这一小块 ────────────────────────────── */

/*
 * 缺陷 CZ（问题清单 R2 / P4，Go 无法联网）。
 *
 * Go 的纯 Go resolver **自己读 resolv.conf**，而 Termux 编译的 go 把路径
 * 写死成了 `--prefix` 下的 `/data/data/com.termux/files/usr/etc/resolv.conf`：
 *
 *   openat(AT_FDCWD, "/data/data/com.termux/files/usr/etc/resolv.conf",
 *          O_RDONLY|O_CLOEXEC) = -1 ENOENT
 *   → go: lookup goproxy.cn on [::1]:53: connection refused
 *
 * 这条路径是**编译期常量**，构建期的 @DSH_ROOT@ 改写覆盖不到它 ——
 * 那个改写只处理 `SCRIPT_TOP_DIRS` 下的**文本文件**，ELF 一律早退
 * （改长度会让节偏移与重定位表错位）。
 *
 * 真机上 `<root>/etc/resolv.conf` 是**存在的**（RuntimeInstaller.ensureResolvConf
 * 每次启动按当前网络的 DNS 落盘），所以只要把这一条路径接上就够了。
 *
 * ── 为什么不干脆全量拦 open ───────────────────────────────────────────────
 *
 * 文件系统层构建期已经用 @DSH_ROOT@ 占位符改写过（normaliseStageFiles +
 * rewriteRootPlaceholder），运行期再全量拦一遍只会增加不确定性；而且 open
 * 的热度比 exec 高好几个数量级（一次 `git status` 就是几千次），在 preload
 * 层做 strlen/memcmp 的代价会摊到每一个进程的每一次文件访问上。
 *
 * 所以这里用一个**极窄的开关**：只有路径以
 * `/data/data/com.termux/files/usr/etc/` 开头才进 rewrite_path，其余一律
 * 一次 memcmp 就放行。这个前缀的命中率在真实负载里约等于零（配置文件在
 * 构建期已经改写过了），热路径代价就是一次长度可预知的常量比较。
 *
 * ── 回落语义 ─────────────────────────────────────────────────────────────
 *
 * 与 exec 族一致：重写后仍失败（ENOENT / ENOTDIR）就用原路径再试一次。
 * 这样「设备上恰好装了一个真 Termux」时行为与不装本库完全一致。
 */

static const char CONFIG_PREFIX[] = "/data/data/com.termux/files/usr/etc/";
#define CONFIG_PREFIX_LEN (sizeof(CONFIG_PREFIX) - 1)

/* 只对配置目录做重写；其余路径立即返回 NULL（热路径只有一次 memcmp）。 */
static char *rewrite_config_path(const char *path) {
    if (path == NULL || path[0] != '/') return NULL;
    if (memcmp(path, CONFIG_PREFIX, CONFIG_PREFIX_LEN) != 0) return NULL;
    return rewrite_path(path);
}

/* open / openat 是变参：只有带 O_CREAT / O_TMPFILE 时才有 mode。 */
#define NEEDS_MODE(flags) \
    (((flags) & O_CREAT) != 0 || (((flags) & O_TMPFILE) == O_TMPFILE))

typedef int (*open_fn)(const char *, int, ...);
typedef int (*openat_fn)(int, const char *, int, ...);

static int do_open(const char *path, int flags, mode_t mode, int has_mode,
                   int dirfd, int use_at) {
    static open_fn real_open = NULL;
    static openat_fn real_openat = NULL;

    if (use_at) {
        if (real_openat == NULL) real_openat = (openat_fn)dlsym(RTLD_NEXT, "openat");
        if (real_openat == NULL) { errno = ENOSYS; return -1; }
    } else {
        if (real_open == NULL) real_open = (open_fn)dlsym(RTLD_NEXT, "open");
        if (real_open == NULL) { errno = ENOSYS; return -1; }
    }

    char *fixed = rewrite_config_path(path);

    int rc;
    if (use_at) {
        rc = has_mode ? real_openat(dirfd, fixed != NULL ? fixed : path, flags, mode)
                      : real_openat(dirfd, fixed != NULL ? fixed : path, flags);
    } else {
        rc = has_mode ? real_open(fixed != NULL ? fixed : path, flags, mode)
                      : real_open(fixed != NULL ? fixed : path, flags);
    }

    if (fixed == NULL) return rc;

    int saved = errno;
    if (rc == -1 && (saved == ENOENT || saved == ENOTDIR)) {
        /* 重写后的路径不存在：退回原始路径，保持与不装本库时一致。 */
        free(fixed);
        if (use_at) {
            rc = has_mode ? real_openat(dirfd, path, flags, mode)
                          : real_openat(dirfd, path, flags);
        } else {
            rc = has_mode ? real_open(path, flags, mode)
                          : real_open(path, flags);
        }
        return rc;
    }
    free(fixed);
    errno = saved;
    return rc;
}

int open(const char *path, int flags, ...) {
    mode_t mode = 0;
    int has_mode = NEEDS_MODE(flags);
    if (has_mode) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    return do_open(path, flags, mode, has_mode, AT_FDCWD, 0);
}

int open64(const char *path, int flags, ...) {
    mode_t mode = 0;
    int has_mode = NEEDS_MODE(flags);
    if (has_mode) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    return do_open(path, flags, mode, has_mode, AT_FDCWD, 0);
}

int openat(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    int has_mode = NEEDS_MODE(flags);
    if (has_mode) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    return do_open(path, flags, mode, has_mode, dirfd, 1);
}

int openat64(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    int has_mode = NEEDS_MODE(flags);
    if (has_mode) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    return do_open(path, flags, mode, has_mode, dirfd, 1);
}
