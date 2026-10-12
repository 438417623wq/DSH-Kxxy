/*
 * dsh_pty_node.c — Android 原生 PTY 的 N-API 绑定
 *
 * 为什么需要它：
 *   官方前端「新建终端」走 dsh-subprocess-local 的 spawnTerminal()，它 lazy require
 *   node-pty 并调用 spawn()。上游 asar 里没有 node-pty 的源码（只有 prebuilds 的
 *   .node，且是 glibc 目标），Android 上无法使用，所以 kxxy 的构建补丁
 *   patchNodePty 一直写的是一个「抛错空壳」——终端一打开就红字报错。
 *
 *   本文件把 node-pty 的 Android 实现补上：复用 android/app/src/main/cpp/dsh_pty.c
 *   已被引擎启动路径验证过的 fork/exec 逻辑，再加一层 libuv 事件集成做异步 I/O。
 *
 * 与 dsh_pty.c 的三条硬约束一致（G1/G2/G3）：
 *   G1 close_inherited_fds —— App 进程的 java.net.ServerSocket 不带 O_CLOEXEC，
 *      fork 后引擎会带着监听 socket 跑，父进程死后孤儿仍占端口 → EADDRINUSE。
 *      刻意不用 close_range(2)：需 Linux 5.9+，minSdk 26 覆盖不到。
 *   G2 prctl(PR_SET_PDEATHSIG, SIGTERM) —— 子进程随父进程退出，并处理
 *      「prctl 生效前父进程已死」的竞态（getppid() == 1 立即退出）。
 *   G3 execve(cmd, argv, envp) 完整替换环境 —— 不用 putenv()+execvp()，
 *      否则引擎会继承宿主 App 的全部环境变量。
 *   另外 execve 不搜索 PATH，executable 必须是绝对路径。
 *
 * 事件集成：
 *   uv_poll_t 监听 master fd 可读 → 回调在事件循环线程上执行 → 直接
 *   napi_call_function 调 JS 的 onData（无需 ThreadSafeFunction，因为已经在
 *   循环线程上）。
 *   uv_timer_t 每 200ms 做一次 waitpid(WNOHANG) 收割子进程，覆盖「子进程已退出
 *   但孙子进程仍持有 slave 端，读不到 EOF」的情况。
 *
 * master fd 全程 O_NONBLOCK：uv_poll 需要它，read 返回 EAGAIN 也不阻塞循环。
 */

#include <node_api.h>
#include <uv.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/wait.h>

/* ── G1：关闭所有继承的 fd ────────────────────────────────────────────────
 *
 * 遍历 /proc/self/fd 关闭除 0/1/2 之外的每一个 fd。
 *
 * ⚠️ 必须保留 [preserve] 指定的 fd —— 那是 PTY 从设备，它在 fork 之前就已打开
 * （先开 slave 再 fork 是标准做法，避免子进程里做更多可能失败的工作）。
 * 若把它一并关掉，后续 ioctl(TIOCSCTTY) 与 dup2 都会失败。
 *
 * 同时跳过遍历用的目录 fd 自身。
 */
static void close_inherited_fds(int preserve)
{
    DIR *dir = opendir("/proc/self/fd");
    if (dir == NULL) return;

    /* 注意变量名不要叫 dirfd —— 那是 <dirent.h> 里的函数名，会遮蔽声明 */
    int scan_fd = dirfd(dir);
    struct dirent *entry;

    while ((entry = readdir(dir)) != NULL) {
        if (entry->d_name[0] == '.') continue;

        char *end = NULL;
        long fd = strtol(entry->d_name, &end, 10);
        if (end == entry->d_name || *end != '\0') continue;

        if (fd <= STDERR_FILENO) continue;   /* 保留标准三件套 */
        if (fd == preserve) continue;        /* 保留 PTY 从设备 */
        if (fd == scan_fd) continue;         /* 保留遍历目录 fd 自身 */

        close((int)fd);
    }

    closedir(dir);
}

/* ══ napi 辅助 ═══════════════════════════════════════════════════════════ */

static napi_value js_undefined(napi_env env)
{
    napi_value v;
    napi_get_undefined(env, &v);
    return v;
}

static char *get_string(napi_env env, napi_value v)
{
    size_t len = 0;
    if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) return NULL;
    char *out = (char *)malloc(len + 1);
    if (out == NULL) return NULL;
    if (napi_get_value_string_utf8(env, v, out, len + 1, &len) != napi_ok) {
        free(out);
        return NULL;
    }
    return out;
}

/* 把 JS 字符串数组转成 NULL 结尾的 char* 数组。失败返回 NULL。 */
static char **get_string_array(napi_env env, napi_value v, int *count_out)
{
    bool is_array = false;
    if (napi_is_array(env, v, &is_array) != napi_ok || !is_array) return NULL;

    uint32_t n = 0;
    if (napi_get_array_length(env, v, &n) != napi_ok) return NULL;

    char **out = (char **)calloc((size_t)n + 1, sizeof(char *));
    if (out == NULL) return NULL;

    for (uint32_t i = 0; i < n; i++) {
        napi_value e;
        if (napi_get_element(env, v, i, &e) != napi_ok) goto fail;
        out[i] = get_string(env, e);
        if (out[i] == NULL) goto fail;
    }
    out[n] = NULL;
    *count_out = (int)n;
    return out;

fail:
    for (uint32_t i = 0; i < n; i++) free(out[i]);
    free(out);
    return NULL;
}

static void free_string_array(char **a, int n)
{
    if (a == NULL) return;
    for (int i = 0; i < n; i++) free(a[i]);
    free(a);
}

static napi_value make_int(napi_env env, int32_t v)
{
    napi_value out;
    napi_create_int32(env, v, &out);
    return out;
}

/* ══ 信号名 → 编号（node-pty 的 kill() 收字符串信号名） ═══════════════════ */

typedef struct { const char *name; int num; } sig_entry;

static const sig_entry SIG_TABLE[] = {
    { "SIGHUP", SIGHUP },   { "SIGINT", SIGINT },   { "SIGQUIT", SIGQUIT },
    { "SIGILL", SIGILL },   { "SIGTRAP", SIGTRAP }, { "SIGABRT", SIGABRT },
    { "SIGBUS", SIGBUS },   { "SIGFPE", SIGFPE },   { "SIGKILL", SIGKILL },
    { "SIGUSR1", SIGUSR1 }, { "SIGSEGV", SIGSEGV }, { "SIGUSR2", SIGUSR2 },
    { "SIGPIPE", SIGPIPE }, { "SIGALRM", SIGALRM }, { "SIGTERM", SIGTERM },
    { "SIGCHLD", SIGCHLD }, { "SIGCONT", SIGCONT }, { "SIGSTOP", SIGSTOP },
    { "SIGTSTP", SIGTSTP }, { "SIGTTIN", SIGTTIN }, { "SIGTTOU", SIGTTOU },
    { NULL, 0 },
};

/* 接受 number 或 "SIGTERM" 之类的字符串；无法识别返回 -1 */
static int parse_signal(napi_env env, napi_value v)
{
    napi_valuetype t;
    if (napi_typeof(env, v, &t) != napi_ok) return -1;
    if (t == napi_number) {
        int32_t n = 0;
        if (napi_get_value_int32(env, v, &n) != napi_ok) return -1;
        return (int)n;
    }
    if (t == napi_string) {
        char *s = get_string(env, v);
        if (s == NULL) return -1;
        int found = -1;
        for (int i = 0; SIG_TABLE[i].name != NULL; i++) {
            if (strcmp(SIG_TABLE[i].name, s) == 0) { found = SIG_TABLE[i].num; break; }
        }
        free(s);
        return found;
    }
    return -1;
}

/* ══ 每个 PTY 的事件槽位 ═════════════════════════════════════════════════
 *
 * state: 0=空闲可复用, 1=活动, 2=正在关闭（等 uv_close 回调把两个 handle 都
 * 收干净后才能回到 0 —— uv_close 是异步的，提前复用槽位会 use-after-close）。
 */
#define MAX_PTYS 32

typedef struct {
    int state;
    int fd;
    int pid;

    uv_poll_t poll;
    uv_timer_t timer;
    int poll_inited;
    int timer_inited;
    int poll_closed;
    int timer_closed;

    napi_env env;
    napi_ref on_data;
    napi_ref on_exit;

    int draining;        /* 已读到 EOF / 出错，不再 poll */
    int paused;
    int exit_emitted;
} pty_slot;

static pty_slot g_slots[MAX_PTYS];

static pty_slot *slot_by_fd(int fd)
{
    for (int i = 0; i < MAX_PTYS; i++) {
        if (g_slots[i].state == 1 && g_slots[i].fd == fd) return &g_slots[i];
    }
    return NULL;
}

/* 领取一个空闲槽位。⚠️ 必须在 fork 之前调用：spawn 一旦成功，父进程返回的
 * fd 就已经存在于 fd 表里，若此刻才分配槽位，两次 spawn 之间可能被 uv 回调
 * 抢跑，导致 startPoll 找不到 fd。 */
static pty_slot *slot_reserve(void)
{
    for (int i = 0; i < MAX_PTYS; i++) {
        if (g_slots[i].state == 0) {
            pty_slot *s = &g_slots[i];
            memset(s, 0, sizeof(*s));
            s->state = 1;
            s->fd = -1;
            s->pid = -1;
            s->poll.data = s;
            s->timer.data = s;
            return s;
        }
    }
    return NULL;
}

/* spawn 失败时归还槽位 */
static void slot_release(pty_slot *s)
{
    if (s == NULL) return;
    s->state = 0;
    s->fd = -1;
    s->pid = -1;
    s->poll_inited = 0;
    s->timer_inited = 0;
    s->poll_closed = 0;
    s->timer_closed = 0;
}

/* 调 JS 的 onExit({exitCode, signal})。status 为 waitpid 的原始 wait status。 */
static void emit_exit(pty_slot *s, int status)
{
    if (s->exit_emitted || s->on_exit == NULL) return;

    napi_env env = s->env;
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) != napi_ok) return;

    napi_value cb;
    if (napi_get_reference_value(env, s->on_exit, &cb) != napi_ok || cb == NULL) {
        napi_close_handle_scope(env, scope);
        return;
    }

    int32_t exit_code = 0;
    int32_t sig = 0;
    if (WIFEXITED(status)) {
        exit_code = WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
        sig = WTERMSIG(status);
        exit_code = 0;
    } else {
        /* 不该发生（我们只在不阻塞的情况下收割），保守给 0 */
        exit_code = 0;
    }

    napi_value obj, v;
    napi_create_object(env, &obj);
    napi_create_int32(env, exit_code, &v);
    napi_set_named_property(env, obj, "exitCode", v);
    napi_create_int32(env, sig, &v);
    napi_set_named_property(env, obj, "signal", v);

    napi_value argv[1] = { obj };
    napi_value recv = js_undefined(env);
    s->exit_emitted = 1;
    napi_call_function(env, recv, cb, 1, argv, NULL);

    napi_close_handle_scope(env, scope);
}

/* 把 master fd 上当前可读的字节全部读出并投递给 onData。
 * 返回 1 表示已到 EOF / 出错（流结束），0 表示只是暂时没数据（EAGAIN）。 */
static int pump(pty_slot *s)
{
    char buf[65536];
    for (;;) {
        ssize_t n = read(s->fd, buf, sizeof(buf));
        if (n > 0) {
            napi_env env = s->env;
            napi_handle_scope scope;
            if (napi_open_handle_scope(env, &scope) != napi_ok) return 0;

            napi_value cb;
            if (napi_get_reference_value(env, s->on_data, &cb) == napi_ok && cb != NULL) {
                napi_value chunk;
                void *copy = NULL;
                if (napi_create_buffer_copy(env, (size_t)n, buf, &copy, &chunk) == napi_ok) {
                    napi_value argv[1] = { chunk };
                    napi_value recv = js_undefined(env);
                    napi_call_function(env, recv, cb, 1, argv, NULL);
                }
            }
            napi_close_handle_scope(env, scope);

            /* 读满一整个缓冲说明还有积压，继续；否则回到事件循环等下一次可读 */
            if (n < (ssize_t)sizeof(buf)) return 0;
            continue;
        }
        if (n == 0) return 1;                                    /* EOF */
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;   /* 暂时没数据 */
        return 1;                                                /* EIO 等：对端已关闭 */
    }
}

/* 非阻塞收割；收割成功返回 1 并已 emit_exit。
 *
 * ⚠️ 顺序很关键：必须**先**把 fd 上残留的输出抽干再发 onExit。JS 侧的
 * onExit 处理器会 this.output.end()，若先发退出事件，子进程临终前写出的最后
 * 一段输出（如 shell 的 exit 提示）会被截断。 */
static int reap(pty_slot *s)
{
    if (s->pid <= 0 || s->exit_emitted) return 0;
    int status = 0;
    pid_t r = waitpid((pid_t)s->pid, &status, WNOHANG);
    if (r == (pid_t)s->pid) {
        if (!s->draining) {
            s->draining = 1;
            if (s->poll_inited) uv_poll_stop(&s->poll);
            pump(s);
        }
        emit_exit(s, status);
        return 1;
    }
    return 0;
}

static void on_timer(uv_timer_t *h)
{
    pty_slot *s = (pty_slot *)h->data;
    if (s == NULL || s->state != 1) return;
    reap(s);
}

static void on_poll(uv_poll_t *h, int status, int events)
{
    (void)events;
    pty_slot *s = (pty_slot *)h->data;
    if (s == NULL || s->state != 1 || s->draining) return;
    if (status < 0) {
        /* poll 自身出错：当作流结束，避免无限空转 */
        s->draining = 1;
        uv_poll_stop(&s->poll);
        reap(s);
        return;
    }

    if (pump(s)) {
        /* EOF / EIO：最后一个持有 slave 的进程已关闭从设备 */
        s->draining = 1;
        uv_poll_stop(&s->poll);
        reap(s);
    }
}

static void on_poll_closed(uv_handle_t *h)
{
    pty_slot *s = (pty_slot *)h->data;
    if (s == NULL) return;
    s->poll_closed = 1;
    if (s->poll_closed && s->timer_closed && s->state == 2) s->state = 0;
}

static void on_timer_closed(uv_handle_t *h)
{
    pty_slot *s = (pty_slot *)h->data;
    if (s == NULL) return;
    s->timer_closed = 1;
    if (s->poll_closed && s->timer_closed && s->state == 2) s->state = 0;
}

static void slot_teardown(pty_slot *s)
{
    if (s->on_data != NULL) { napi_delete_reference(s->env, s->on_data); s->on_data = NULL; }
    if (s->on_exit != NULL) { napi_delete_reference(s->env, s->on_exit); s->on_exit = NULL; }
}

/* ══ JS 接口 ═════════════════════════════════════════════════════════════ */

/*
 * spawn(file, args[], env[], cwd, rows, cols) -> { fd, pid }
 * file 必须是绝对路径（execve 不搜 PATH）。
 */
static napi_value js_spawn(napi_env env, napi_callback_info info)
{
    size_t argc = 6;
    napi_value argv[6];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 6) {
        napi_throw_type_error(env, NULL, "spawn(file, args, env, cwd, rows, cols) 需要 6 个参数");
        return NULL;
    }

    char *file = get_string(env, argv[0]);
    if (file == NULL) {
        napi_throw_type_error(env, NULL, "file 必须是字符串");
        return NULL;
    }

    int nargs = 0, nenv = 0;
    char **args = get_string_array(env, argv[1], &nargs);
    char **envp = get_string_array(env, argv[2], &nenv);
    char *cwd = get_string(env, argv[3]);
    int32_t rows = 0, cols = 0;
    napi_get_value_int32(env, argv[4], &rows);
    napi_get_value_int32(env, argv[5], &cols);

    if (args == NULL || envp == NULL) {
        napi_throw_type_error(env, NULL, "args / env 必须是字符串数组");
        free(file); free(cwd);
        free_string_array(args, nargs);
        free_string_array(envp, nenv);
        return NULL;
    }

    int master = -1, slave = -1;
    char *slave_name = NULL;
    int rc = 0;
    pty_slot *slot = slot_reserve();
    if (slot == NULL) {
        napi_throw_error(env, NULL, "PTY spawn 失败: 已达并发终端上限（32）");
        free(file); free(cwd);
        free_string_array(args, nargs);
        free_string_array(envp, nenv);
        return NULL;
    }

    master = open("/dev/ptmx", O_RDWR | O_NOCTTY);
    if (master < 0) { rc = -errno; goto fail; }
    fcntl(master, F_SETFD, FD_CLOEXEC);

    if (grantpt(master) != 0 || unlockpt(master) != 0) { rc = -errno; goto fail; }

    slave_name = ptsname(master);
    if (slave_name == NULL) { rc = -errno; goto fail; }

    slave = open(slave_name, O_RDWR | O_NOCTTY);
    if (slave < 0) { rc = -errno; goto fail; }

    /* fork 前预设窗口尺寸：留到 fork 之后的话，node-pty 在首次 resize 之前会读到
     * 0x0 尺寸，某些 CLI 会因此错判终端能力。 */
    {
        struct winsize ws;
        memset(&ws, 0, sizeof(ws));
        ws.ws_row = (unsigned short)(rows > 0 ? rows : 40);
        ws.ws_col = (unsigned short)(cols > 0 ? cols : 120);
        ioctl(slave, TIOCSWINSZ, &ws);
    }

    {
        pid_t pid = fork();
        if (pid < 0) { rc = -errno; goto fail; }

        if (pid == 0) {
            /* ── 子进程：只做系统调用，绝不碰 napi / JS ─────────────── */
            setsid();

            /* G1：必须在 dup2(slave) 之前做，因为 slave 此刻还在原 fd 号上，
             * 关闭后再 dup2 才能保证 0/1/2 指向它。 */
            close_inherited_fds(slave);

            if (ioctl(slave, TIOCSCTTY, (char *)NULL) == -1) _exit(126);
            if (dup2(slave, STDIN_FILENO) < 0 ||
                dup2(slave, STDOUT_FILENO) < 0 ||
                dup2(slave, STDERR_FILENO) < 0) _exit(126);
            if (slave > STDERR_FILENO) close(slave);

            /* 恢复 SIGPIPE 默认行为：node 可能把它设成了 SIG_IGN，而 execve 会
             * 保留被忽略的信号处置，导致 shell 管道不按预期终止。 */
            signal(SIGPIPE, SIG_DFL);

            /* G2：父进程死亡信号。竞态处理：若父进程在本行之前已死，
             * PR_SET_PDEATHSIG 不会生效，所以紧接着检查 getppid()。 */
            prctl(PR_SET_PDEATHSIG, SIGTERM);
            if (getppid() == 1) _exit(0);

            if (cwd != NULL && cwd[0] != '\0') chdir(cwd);

            /* G3：完整替换环境后 execve */
            execve(file, args, envp);
            _exit(127);
        }

        /* ── 父进程 ─────────────────────────────────────────────────── */
        close(slave);
        slave = -1;

        /* master 设非阻塞：uv_poll 需要，且让 read 以 EAGAIN 返回而不是卡住循环 */
        {
            int fl = fcntl(master, F_GETFL, 0);
            if (fl >= 0) fcntl(master, F_SETFL, fl | O_NONBLOCK);
        }

        slot->fd = master;
        slot->pid = (int)pid;

        napi_value out, v;
        napi_create_object(env, &out);
        napi_create_int32(env, master, &v);
        napi_set_named_property(env, out, "fd", v);
        napi_create_int32(env, (int32_t)pid, &v);
        napi_set_named_property(env, out, "pid", v);

        free(file); free(cwd);
        free_string_array(args, nargs);
        free_string_array(envp, nenv);
        return out;
    }

fail:
    slot_release(slot);
    if (slave >= 0) close(slave);
    if (master >= 0) close(master);
    free(file); free(cwd);
    free_string_array(args, nargs);
    free_string_array(envp, nenv);
    {
        char msg[128];
        snprintf(msg, sizeof(msg), "PTY spawn 失败: %s", strerror(-rc));
        napi_throw_error(env, NULL, msg);
    }
    return NULL;
}

/*
 * startPoll(fd, onData, onExit) —— 开始监听 master fd。
 * onData 收 Buffer（非 string，包装层负责 utf8 解码）。
 */
static napi_value js_start_poll(napi_env env, napi_callback_info info)
{
    size_t argc = 3;
    napi_value argv[3];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3) {
        napi_throw_type_error(env, NULL, "startPoll(fd, onData, onExit) 需要 3 个参数");
        return NULL;
    }

    int32_t fd = 0;
    napi_get_value_int32(env, argv[0], &fd);

    pty_slot *s = slot_by_fd(fd);
    if (s == NULL) {
        napi_throw_error(env, NULL, "startPoll: 未知的 PTY fd（spawn 未返回或已关闭）");
        return NULL;
    }
    if (s->poll_inited) {
        napi_throw_error(env, NULL, "startPoll: 该 fd 已在监听中");
        return NULL;
    }

    uv_loop_t *loop = NULL;
    if (napi_get_uv_event_loop(env, &loop) != napi_ok || loop == NULL) {
        napi_throw_error(env, NULL, "startPoll: 无法取得 uv event loop");
        return NULL;
    }

    s->env = env;
    napi_create_reference(env, argv[1], 1, &s->on_data);
    napi_create_reference(env, argv[2], 1, &s->on_exit);

    if (uv_poll_init(loop, &s->poll, fd) != 0) {
        slot_teardown(s);
        napi_throw_error(env, NULL, "startPoll: uv_poll_init 失败");
        return NULL;
    }
    s->poll_inited = 1;
    uv_poll_start(&s->poll, UV_READABLE, on_poll);

    if (uv_timer_init(loop, &s->timer) != 0) {
        uv_poll_stop(&s->poll);
        uv_close((uv_handle_t *)&s->poll, on_poll_closed);
        slot_teardown(s);
        napi_throw_error(env, NULL, "startPoll: uv_timer_init 失败");
        return NULL;
    }
    s->timer_inited = 1;
    /* 200ms 收割一次子进程：覆盖「子进程已退出但孙子进程仍持有 slave 端，
     * 读不到 EOF」的情况，同时避免僵尸进程堆积。 */
    uv_timer_start(&s->timer, on_timer, 200, 200);

    return js_undefined(env);
}

/* stopPoll(fd) —— 停止监听并释放槽位（uv_close 完成后槽位才可复用） */
static napi_value js_stop_poll(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
        return js_undefined(env);
    }
    int32_t fd = 0;
    napi_get_value_int32(env, argv[0], &fd);

    pty_slot *s = slot_by_fd(fd);
    if (s == NULL) return js_undefined(env);

    /* 先补一次收割，让 onExit 有机会在收尾前发出 */
    reap(s);

    s->state = 2;
    if (s->poll_inited && !s->poll_closed) {
        uv_poll_stop(&s->poll);
        uv_close((uv_handle_t *)&s->poll, on_poll_closed);
    } else {
        s->poll_closed = 1;
    }
    if (s->timer_inited && !s->timer_closed) {
        uv_timer_stop(&s->timer);
        uv_close((uv_handle_t *)&s->timer, on_timer_closed);
    } else {
        s->timer_closed = 1;
    }
    slot_teardown(s);
    if (s->poll_closed && s->timer_closed) s->state = 0;

    return js_undefined(env);
}

/* pausePoll(fd) / resumePoll(fd) —— 背压：JS 侧缓冲满时暂停读取 */
static napi_value js_pause_poll(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc >= 1) {
        int32_t fd = 0;
        napi_get_value_int32(env, argv[0], &fd);
        pty_slot *s = slot_by_fd(fd);
        if (s != NULL && s->poll_inited && !s->draining && !s->paused) {
            uv_poll_stop(&s->poll);
            s->paused = 1;
        }
    }
    return js_undefined(env);
}

static napi_value js_resume_poll(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc >= 1) {
        int32_t fd = 0;
        napi_get_value_int32(env, argv[0], &fd);
        pty_slot *s = slot_by_fd(fd);
        if (s != NULL && s->poll_inited && !s->draining && s->paused) {
            uv_poll_start(&s->poll, UV_READABLE, on_poll);
            s->paused = 0;
        }
    }
    return js_undefined(env);
}

/* write(fd, Buffer|string) -> 写入字节数（EAGAIN 返回 0） */
static napi_value js_write(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value argv[2];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
        return make_int(env, 0);
    }

    int32_t fd = 0;
    napi_get_value_int32(env, argv[0], &fd);

    void *data = NULL;
    size_t len = 0;
    bool is_buffer = false;
    napi_is_buffer(env, argv[1], &is_buffer);
    if (is_buffer) {
        napi_get_buffer_info(env, argv[1], &data, &len);
    } else {
        char *s = get_string(env, argv[1]);
        if (s == NULL) return make_int(env, 0);
        ssize_t n = write(fd, s, strlen(s));
        free(s);
        return make_int(env, n < 0 ? 0 : (int32_t)n);
    }
    if (data == NULL || len == 0) return make_int(env, 0);

    ssize_t n = write(fd, data, len);
    if (n < 0) return make_int(env, 0);
    return make_int(env, (int32_t)n);
}

/* resize(fd, rows, cols) —— 注意顺序是 rows, cols（与 node-pty 的
 * terminal.resize(cols, rows) 相反，包装层负责换算） */
static napi_value js_resize(napi_env env, napi_callback_info info)
{
    size_t argc = 3;
    napi_value argv[3];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3) {
        return make_int(env, -1);
    }
    int32_t fd = 0, rows = 0, cols = 0;
    napi_get_value_int32(env, argv[0], &fd);
    napi_get_value_int32(env, argv[1], &rows);
    napi_get_value_int32(env, argv[2], &cols);

    struct winsize ws;
    memset(&ws, 0, sizeof(ws));
    ws.ws_row = (unsigned short)(rows > 0 ? rows : 40);
    ws.ws_col = (unsigned short)(cols > 0 ? cols : 120);
    if (ioctl(fd, TIOCSWINSZ, &ws) != 0) return make_int(env, -errno);
    return make_int(env, 0);
}

/* kill(pid, signal?) -> 0 成功 / -errno。优先杀整个进程组：子进程 setsid 后
 * 自己就是组长，杀组才能连带收掉 shell 里跑着的命令。 */
static napi_value js_kill(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value argv[2];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
        return make_int(env, -1);
    }
    int32_t pid = 0;
    napi_get_value_int32(env, argv[0], &pid);

    int sig = SIGTERM;
    if (argc >= 2) {
        int parsed = parse_signal(env, argv[1]);
        if (parsed >= 0) sig = parsed;
    }

    if (kill(-(pid_t)pid, sig) == 0) return make_int(env, 0);
    if (errno == ESRCH) {
        if (kill((pid_t)pid, sig) == 0) return make_int(env, 0);
    }
    return make_int(env, -errno);
}

/* close(fd) —— 只关 master fd。槽位由 stopPoll 释放。 */
static napi_value js_close(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok && argc >= 1) {
        int32_t fd = 0;
        napi_get_value_int32(env, argv[0], &fd);
        if (fd >= 0) close(fd);
    }
    return js_undefined(env);
}

/* waitNohang(pid) -> exit status | undefined（undefined 表示还活着） */
static napi_value js_wait_nohang(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
        return js_undefined(env);
    }
    int32_t pid = 0;
    napi_get_value_int32(env, argv[0], &pid);

    int status = 0;
    pid_t r = waitpid((pid_t)pid, &status, WNOHANG);
    if (r == (pid_t)pid) return make_int(env, status);
    return js_undefined(env);
}

/* isatty(fd) -> boolean —— 用于判定 master 端能否交给 tty.ReadStream */
static napi_value js_isatty(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1];
    napi_value out;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
        napi_get_boolean(env, false, &out);
        return out;
    }
    int32_t fd = 0;
    napi_get_value_int32(env, argv[0], &fd);
    napi_get_boolean(env, isatty(fd) == 1, &out);
    return out;
}

/* processGroupOf(pid) -> pgid，诊断用 */
static napi_value js_getpgid(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
        return make_int(env, -1);
    }
    int32_t pid = 0;
    napi_get_value_int32(env, argv[0], &pid);
    pid_t pg = getpgid((pid_t)pid);
    return make_int(env, pg < 0 ? -errno : (int32_t)pg);
}

/* ══ 模块注册 ════════════════════════════════════════════════════════════ */

static napi_value Init(napi_env env, napi_value exports)
{
    const struct { const char *name; napi_callback fn; } fns[] = {
        { "spawn",        js_spawn },
        { "startPoll",    js_start_poll },
        { "stopPoll",     js_stop_poll },
        { "pausePoll",    js_pause_poll },
        { "resumePoll",   js_resume_poll },
        { "write",        js_write },
        { "resize",       js_resize },
        { "kill",         js_kill },
        { "close",        js_close },
        { "waitNohang",   js_wait_nohang },
        { "isatty",       js_isatty },
        { "getpgid",      js_getpgid },
    };

    for (size_t i = 0; i < sizeof(fns) / sizeof(fns[0]); i++) {
        napi_value fn;
        if (napi_create_function(env, fns[i].name, NAPI_AUTO_LENGTH, fns[i].fn, NULL, &fn) != napi_ok) {
            return NULL;
        }
        napi_set_named_property(env, exports, fns[i].name, fn);
    }

    napi_value v;
    napi_create_string_utf8(env, "dsh-pty-node@1", NAPI_AUTO_LENGTH, &v);
    napi_set_named_property(env, exports, "version", v);

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
