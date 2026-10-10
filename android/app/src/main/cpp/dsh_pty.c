/*
 * dsh_pty.c — DSH Kxxy 原生 PTY 层
 *
 * 为什么自研而不用 flutter_pty / node-pty：
 *   参考项目与 flutter_pty 都缺三样东西，缺任何一样都会导致引擎在生产环境
 *   反复重启或变孤儿。本文件把它们一次补齐（记为 G1/G2/G3）。
 *
 *   G1 关闭继承的 fd
 *       App 进程里的 java.net.ServerSocket（设备桥）**不带 O_CLOEXEC**
 *       （实测 fdinfo flags: 04002 = O_RDWR|O_NONBLOCK）。fork 后引擎会带着
 *       这块监听 socket 一起跑，父进程死后孤儿仍占着端口，新桥 bind 失败
 *       EADDRINUSE。参考项目记录用户实测「62 次仍在增长」。
 *       刻意不用 close_range(2)：需 Linux 5.9+，Android 内核版本跨度过大。
 *
 *   G2 父进程死亡信号
 *       prctl(PR_SET_PDEATHSIG, SIGTERM) 让子进程随父进程退出。
 *       选 SIGTERM 而非 SIGKILL，给引擎收尾机会。
 *       并处理「prctl 生效前父进程已死」的竞态：getppid() == 1 时立即退出。
 *
 *   G3 环境变量完整替换
 *       execve(cmd, argv, envp) 而非 putenv()+execvp()。
 *       后者是「继承 + 覆盖」，引擎会带上宿主 App 的全部环境变量。
 *       参考项目刻意用完整替换数组，PATH 首位放 engine/bin 以遮蔽系统命令。
 *
 * 另外：execve 不搜索 PATH —— executable 必须是绝对路径，
 * 否则子进程已 chdir 到工作区，会按相对路径解析并报 ENOENT / exit 127。
 */

#include <jni.h>
#include <android/log.h>

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <dirent.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <termios.h>

#define LOG_TAG "DshPty"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

/* ── G1：关闭所有继承的 fd ────────────────────────────────────────────────
 *
 * 遍历 /proc/self/fd 关闭除 0/1/2 之外的每一个 fd。
 *
 * ⚠️ 必须保留 [preserve] 指定的 fd —— 那是 PTY 从设备，它在 fork 之前就已打开
 * （先开 slave 再 fork 是标准做法，避免子进程里做更多可能失败的工作）。
 * 若把它一并关掉，后续 ioctl(TIOCSCTTY) 与 dup2 都会失败。
 *
 * 同时跳过遍历用的目录 fd 自身。
 *
 * 刻意不用 close_range(2)：需 Linux 5.9+，而 Android 内核版本跨度过大
 * （minSdk 26 覆盖到 Android 8.0）。
 */
static void close_inherited_fds(int preserve)
{
    DIR *dir = opendir("/proc/self/fd");
    if (dir == NULL) {
        LOGE("close_inherited_fds: opendir failed: %s", strerror(errno));
        return;
    }

    /* 注意变量名不要叫 dirfd —— 那是 <dirent.h> 里的函数名，会遮蔽声明 */
    int scan_fd = dirfd(dir);
    struct dirent *entry;

    while ((entry = readdir(dir)) != NULL) {
        if (entry->d_name[0] == '.') continue;

        char *end = NULL;
        long fd = strtol(entry->d_name, &end, 10);
        if (end == entry->d_name || *end != '\0') continue;

        /* 保留标准三件套 */
        if (fd <= STDERR_FILENO) continue;
        /* 保留 PTY 从设备 */
        if (fd == preserve) continue;
        /* 保留遍历目录 fd 自身 */
        if (fd == scan_fd) continue;

        /* 静默关闭：失败也不影响主流程 */
        close((int)fd);
    }

    closedir(dir);
}

/* ── 启动一个 PTY 子进程 ─────────────────────────────────────────────────
 *
 * 返回 master fd（>= 0 成功），并把子进程 pid 写入 *out_pid。
 * 失败返回负 errno。
 *
 * argv / envp 都是 NULL 结尾的字符串数组，由 Dart 侧构造。
 * executable 必须绝对路径（execve 不搜 PATH）。
 */
int dsh_forkpty(const char *executable,
                char *const argv[],
                char *const envp[],
                const char *cwd,
                int rows,
                int cols,
                int *out_pid)
{
    int master = -1;
    int slave = -1;
    char *slave_name = NULL;

    /* 1. 打开 PTY 主设备 */
    master = open("/dev/ptmx", O_RDWR | O_NOCTTY);
    if (master < 0) {
        LOGE("open /dev/ptmx failed: %s", strerror(errno));
        return -errno;
    }

    /* master 自身设 CLOEXEC，避免被 execve 继承 */
    fcntl(master, F_SETFD, FD_CLOEXEC);

    /* 2. 授权 + 解锁 + 取从设备名 */
    if (grantpt(master) != 0 || unlockpt(master) != 0) {
        LOGE("grantpt/unlockpt failed: %s", strerror(errno));
        int e = errno;
        close(master);
        return -e;
    }

    slave_name = ptsname(master);
    if (slave_name == NULL) {
        LOGE("ptsname failed: %s", strerror(errno));
        int e = errno;
        close(master);
        return -e;
    }

    /* 3. 打开从设备（先于 fork，避免子进程里做更多工作） */
    slave = open(slave_name, O_RDWR | O_NOCTTY);
    if (slave < 0) {
        LOGE("open %s failed: %s", slave_name, strerror(errno));
        int e = errno;
        close(master);
        return -e;
    }

    /* 4. fork 前预设窗口尺寸
     *
     * 这一步不能省：若留到 fork 之后，node-pty 在首次 resize 之前会读到
     * 0x0 尺寸，某些 CLI 会因此错判终端能力。
     */
    struct winsize ws;
    memset(&ws, 0, sizeof(ws));
    ws.ws_row = (unsigned short)(rows > 0 ? rows : 40);
    ws.ws_col = (unsigned short)(cols > 0 ? cols : 120);
    ioctl(slave, TIOCSWINSZ, &ws);

    pid_t pid = fork();
    if (pid < 0) {
        LOGE("fork failed: %s", strerror(errno));
        int e = errno;
        close(slave);
        close(master);
        return -e;
    }

    if (pid == 0) {
        /* ── 子进程 ─────────────────────────────────────────────── */

        /* 脱离控制终端，成为新会话首进程 */
        setsid();

        /* G1：关掉所有继承的 fd
         *
         * 必须在 dup2(slave) 之前做，因为 slave 此刻还在原 fd 号上，
         * 关闭后再 dup2 才能保证 0/1/2 指向它。
         * 顺序上也要在 setsid 之后：setsid 不依赖任何 fd。
         *
         * preserve = slave：PTY 从设备在 fork 前就打开了，必须保留。
         */
        close_inherited_fds(slave);

        /* 让 PTY 成为控制终端 */
        if (ioctl(slave, TIOCSCTTY, (char *)NULL) == -1) {
            LOGE("TIOCSCTTY failed: %s", strerror(errno));
            _exit(126);
        }

        /* 标准三件套接到 slave */
        if (dup2(slave, STDIN_FILENO) < 0 ||
            dup2(slave, STDOUT_FILENO) < 0 ||
            dup2(slave, STDERR_FILENO) < 0) {
            _exit(126);
        }

        if (slave > STDERR_FILENO) close(slave);

        /* G2：父进程死亡信号
         *
         * 注意竞态：若父进程在本行之前就已死亡，PR_SET_PDEATHSIG 不会生效
         * （信号发给的是调用时刻的父进程）。所以紧接着检查 getppid()。
         */
        if (prctl(PR_SET_PDEATHSIG, SIGTERM) == -1) {
            LOGE("prctl(PR_SET_PDEATHSIG) failed: %s", strerror(errno));
        }
        if (getppid() == 1) {
            /* 父进程已不在，直接退出 */
            _exit(0);
        }

        /* 切到工作目录 */
        if (cwd != NULL && cwd[0] != '\0') {
            if (chdir(cwd) != 0) {
                LOGE("chdir(%s) failed: %s", cwd, strerror(errno));
            }
        }

        /* G3：完整替换环境后 execve（不搜索 PATH，executable 必须绝对路径） */
        execve(executable, argv, envp);

        /* 走到这里说明 execve 失败 */
        LOGE("execve(%s) failed: %s", executable, strerror(errno));
        _exit(127);
    }

    /* ── 父进程 ─────────────────────────────────────────────────── */
    close(slave);

    *out_pid = (int)pid;
    return master;
}

/* ── PTY 尺寸调整 ──────────────────────────────────────────────────────── */
int dsh_resize(int master, int rows, int cols)
{
    struct winsize ws;
    memset(&ws, 0, sizeof(ws));
    ws.ws_row = (unsigned short)rows;
    ws.ws_col = (unsigned short)cols;
    return ioctl(master, TIOCSWINSZ, &ws);
}

/* ── 写入 PTY ──────────────────────────────────────────────────────────── */
int dsh_write(int master, const char *data, int length)
{
    ssize_t n = write(master, data, (size_t)length);
    return (int)n;
}

/* ── 关闭 master fd ────────────────────────────────────────────────────── */
void dsh_close(int master)
{
    if (master >= 0) close(master);
}

/* ── 等待子进程退出，返回原始 wait status ──────────────────────────────── */
int dsh_waitpid(int pid)
{
    int status = 0;
    waitpid((pid_t)pid, &status, 0);
    return status;
}

/* ── 向子进程发信号 ────────────────────────────────────────────────────── */
int dsh_kill(int pid, int sig)
{
    return kill((pid_t)pid, sig);
}

/* ── 探测子进程是否仍存活（不回收） ────────────────────────────────────── */
int dsh_alive(int pid)
{
    if (kill((pid_t)pid, 0) == 0) return 1;
    return (errno == EPERM) ? 1 : 0;
}
