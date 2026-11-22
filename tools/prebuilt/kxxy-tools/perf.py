#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kxxy-perf —— 直接调用 perf_event_open 的极简 perf。

为什么不是 simpleperf：NDK 的 simpleperf 在部分 app uid 环境下有额外限制
（例如 `-- cmd` 或 `record` 的系统属性设置）。这里绕开 simpleperf，直接开事件、
读环形缓冲，但不绕过内核权限检查：事件可用性仍取决于当前内核、PMU、
perf_event_paranoid、SELinux/seccomp 与进程身份，以现场系统调用结果为准。

子命令：
  perf list                       每个事件的 PMU/降级能力矩阵
  perf stat [-e ev,ev] [-p PID] [--] cmd...     计数器汇总
  perf record [-F 999] [-g] [-o f] [-p PID] [--] cmd...    采样
  perf report [-i f] [--stack]                  符号化汇总

只依赖 CPython 标准库（ctypes/struct/mmap），可以在 bionic 上原生跑。
"""

import errno
import os
import struct
import sys
import time

PAGE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096
# 只在此处取一次 uname：测试会在 import 时替换它，运行期不再依赖该属性
# （Windows 上的 CPython 没有 os.uname）。
MACHINE = os.uname().machine if hasattr(os, "uname") else "unknown"

SYS_PERF_EVENT_OPEN = {
    "aarch64": 241, "arm64": 241,
    "armv7l": 364, "armv8l": 364,
    "x86_64": 298, "amd64": 298,
    "i686": 336, "i386": 336,
}.get(MACHINE, 241)

# ── perf_event_attr 位域 ────────────────────────────────────────────────────
B_DISABLED, B_INHERIT, B_PINNED, B_EXCLUSIVE = 0, 1, 2, 3
B_EXCL_USER, B_EXCL_KERNEL, B_EXCL_HV = 4, 5, 6
B_MMAP, B_COMM, B_FREQ = 8, 9, 10
B_ENABLE_ON_EXEC, B_TASK = 12, 13
B_MMAP2, B_COMM_EXEC = 23, 24

# sample_type 位
S_IP, S_TID, S_TIME, S_ADDR = 0, 1, 2, 3
S_CALLCHAIN, S_ID, S_CPU, S_PERIOD = 5, 6, 7, 8

# read_format
R_TOTAL_TIME_ENABLED, R_TOTAL_TIME_RUNNING = 0, 1

# 记录类型
REC_MMAP, REC_LOST, REC_COMM, REC_EXIT, REC_SAMPLE, REC_MMAP2 = 1, 2, 3, 4, 9, 10

HW = 0
SW = 1

EVENTS = {
    # 名字: (type, config, 说明)
    "cycles": (HW, 0, "CPU 周期"),
    "cpu-cycles": (HW, 0, "CPU 周期"),
    "instructions": (HW, 1, "退休指令数"),
    "cache-references": (HW, 2, "末级 cache 访问"),
    "cache-misses": (HW, 3, "末级 cache 缺失"),
    "branches": (HW, 4, "分支指令"),
    "branch-instructions": (HW, 4, "分支指令"),
    "branch-misses": (HW, 5, "分支预测失败"),
    "bus-cycles": (HW, 6, "总线周期"),
    "stalled-cycles-frontend": (HW, 7, "前端停顿周期"),
    "stalled-cycles-backend": (HW, 8, "后端停顿周期"),
    "ref-cycles": (HW, 9, "固定频率参考周期"),
    "cpu-clock": (SW, 0, "CPU 时钟（毫秒级）"),
    "task-clock": (SW, 1, "任务占用 CPU 时间（毫秒级）"),
    "page-faults": (SW, 2, "缺页"),
    "context-switches": (SW, 3, "上下文切换"),
    "cpu-migrations": (SW, 4, "CPU 迁移"),
    "minor-faults": (SW, 5, "次缺页"),
    "major-faults": (SW, 6, "主缺页"),
    "alignment-faults": (SW, 7, "对齐异常"),
}

DEFAULT_STAT = [
    "task-clock", "context-switches", "page-faults",
    "cycles", "instructions", "branches", "branch-misses",
]
DEFAULT_RECORD_EVENT = "cpu-clock"

# stat 降级路径实际能提供的计数及其来源。硬件事件不在此表里：没有 PMU 时
# 不能把 task-clock 乘一个系数冒充 cycles，也不能把软链/模拟计数当硬件结果。
FALLBACK_STAT_SOURCES = {
    "task-clock": "rusage//proc",
    "cpu-clock": "rusage//proc",
    "page-faults": "rusage//proc",
    "minor-faults": "rusage//proc",
    "major-faults": "rusage//proc",
    "context-switches": "rusage//proc",
}
FALLBACK_RECORD_EVENTS = frozenset(("cpu-clock",))


def _libc():
    import ctypes
    lib = ctypes.CDLL("libc.so", use_errno=True)
    lib.syscall.restype = ctypes.c_long
    lib.syscall.argtypes = [ctypes.c_long] + [ctypes.c_void_p] * 5
    return lib, ctypes


def _V(ctypes, n):
    return ctypes.c_void_p(n & (2 ** 64 - 1))


def attr_blob(etype, config, sample_period=0, sample_type=0, read_format=0,
              bits=(), wakeup_events=0, freq=False):
    flags = 0
    for b in bits:
        flags |= 1 << b
    if freq:
        flags |= 1 << B_FREQ
    blob = (struct.pack("<IIQ", etype, 128, config)
            + struct.pack("<QQQ", sample_period, sample_type, read_format)
            + struct.pack("<QII", flags, wakeup_events, 0))
    return blob + b"\x00" * (128 - len(blob))


PERF_IOC_ENABLE = 0x2400
PERF_IOC_DISABLE = 0x2401
PERF_IOC_RESET = 0x2403


def ev_ioctl(fd, code):
    import fcntl
    fcntl.ioctl(fd, code, 0)


def perf_open(attr, pid=0, cpu=-1, group_fd=-1, flags=0):
    """返回 fd，失败抛 OSError（errno 从 libc 取）。"""
    lib, ctypes = _libc()
    buf = ctypes.create_string_buffer(attr, len(attr))
    ctypes.set_errno(0)
    fd = lib.syscall(ctypes.c_long(SYS_PERF_EVENT_OPEN),
                     ctypes.cast(buf, ctypes.c_void_p),
                     _V(ctypes, pid), _V(ctypes, cpu),
                     _V(ctypes, group_fd), _V(ctypes, flags))
    if fd < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))
    return fd


def perf_open_failure(command, spec, attr, ex, pid=0, cpu=-1, flags=0):
    """保留每次失败调用的参数与 errno，不从错误码推断具体策略来源。"""
    etype, _size, config = struct.unpack_from("<IIQ", attr)
    attr_flags = struct.unpack_from("<Q", attr, 40)[0]
    ek = int(bool(attr_flags & (1 << B_EXCL_KERNEL)))
    name = errno.errorcode.get(ex.errno, "UNKNOWN")
    return (f"perf {command}: {spec}: perf_event_open failed: "
            f"errno={ex.errno} ({name}: {ex.strerror}); "
            f"type={etype} config={config} pid={pid} cpu={cpu} "
            f"attr_flags=0x{attr_flags:x} exclude_kernel={ek} flags=0x{flags:x}\n")


def current_domain():
    if not os.path.exists("/proc/self/attr/current"):
        return "unknown"
    try:
        with open("/proc/self/attr/current", "r") as f:
            return f.read().strip() or "unknown"
    except OSError:
        return "unknown"


def policy_hint(errnos):
    """按 errno + 当前 SELinux 域给一条可行动的提示；只陈述对照实测，
    不从错误码单独断言具体是哪条策略。读不到域（非 Linux 环境等）不出提示。"""
    dom = current_domain()
    if dom == "unknown" or not errnos:
        return []
    out = []
    if 13 in errnos and dom.startswith("u:r:untrusted_app"):
        out.append(
            f"  提示：当前进程域 {dom} 下 perf_event_open 返回 EACCES"
            f"（perf_event_paranoid=-1 时，普通应用统计自身事件本不应被 paranoid 拒绝）。\n"
            "  对照实测：同一台设备上，adb run-as 域（u:r:runas_app）同一命令可用：\n"
            "      adb shell run-as app.kxxy env LD_LIBRARY_PATH=files/engine/lib \\\n"
            "          files/engine/bin/perf stat -- <cmd>\n"
            "  差异指向本 ROM 对应用域的策略限制；应用内无法绕过。\n")
    elif 1 in errnos:
        out.append("  提示：EPERM 常见于 seccomp 过滤或 perf_event_paranoid 限制。\n")
    return out


# ── 降级路径：PMU 打不开时仍给出可用数据 ────────────────────────────────────
# 应用域（u:r:untrusted_app_27）里 perf_event_open 被设备策略拒绝，但统计和
# 采样本身不一定要 PMU：stat 用 rusage//proc 记账，record 用 ptrace 定时抓 PC。
# 两者都不绕过任何权限检查（ptrace 只针对自己 fork 的子进程或同 uid 进程），
# 因此不受该策略影响，代价是没有 cycles/instructions 这类硬件计数。
PTRACE_TRACEME, PTRACE_CONT, PTRACE_GETREGSET, PTRACE_DETACH = 0, 7, 0x4204, 17
PTRACE_ATTACH = 16
NT_PRSTATUS = 1


def perf_mode():
    mode = os.environ.get("KXXY_PERF_MODE", "auto").strip().lower()
    return mode if mode in ("auto", "pmu", "fallback") else "auto"


def proc_cpu(pid):
    """(utime, stime, minflt, majflt) —— stat(5) 的第 14/15/10/12 项。"""
    with open("/proc/%d/stat" % pid, "rb") as f:
        raw = f.read()
    fields = raw[raw.rfind(b")") + 2:].split()
    try:
        ticks = float(os.sysconf("SC_CLK_TCK"))
    except (ValueError, OSError):
        ticks = 100.0
    return (int(fields[11]) / ticks, int(fields[12]) / ticks,
            int(fields[7]), int(fields[9]))


def proc_switches(pid):
    out = {}
    try:
        with open("/proc/%d/status" % pid, "r") as f:
            for line in f:
                if line.startswith(("voluntary_ctxt_switches",
                                    "nonvoluntary_ctxt_switches")):
                    key, _, value = line.partition(":")
                    out[key.strip()] = int(value)
    except (OSError, ValueError):
        pass
    return out


def read_maps(pid):
    maps = []
    try:
        with open("/proc/%d/maps" % pid, "r") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 6 or "x" not in parts[1]:
                    continue
                try:
                    start, end = (int(x, 16) for x in parts[0].split("-"))
                    maps.append((start, end - start, int(parts[2], 16),
                                 parts[5] or "[anon]"))
                except ValueError:
                    continue
    except OSError:
        pass
    return maps


def stat_fallback(child, pid, duration, label, failed_errnos, attempted=True,
                  requested=None):
    """无 PMU 计数时用 rusage / /proc 记账，输出 CPU 时间、缺页、上下文切换。

    requested 为显式 -e 列表时，只输出确实能由 rusage//proc 得到的项；全部都是
    硬件计数则返回 1，避免 `perf stat -e cycles` 用 task-clock 冒充成功。
    """
    util_note = ""
    if child is not None:
        resume(child)
        t0 = time.time()
        ru = None
        try:
            _, _status, ru = os.wait4(child, 0)
        except (ChildProcessError, AttributeError):
            pass
        elapsed = time.time() - t0
        cpu = (ru.ru_utime + ru.ru_stime) if ru else 0.0
        minflt = ru.ru_minflt if ru else 0
        majflt = ru.ru_majflt if ru else 0
        csw = (ru.ru_nvcsw + ru.ru_nivcsw) if ru else 0
    else:
        before = proc_cpu(pid)
        sw0 = sum(proc_switches(pid).values())
        t0 = time.time()
        time.sleep(duration if duration else 3.0)
        elapsed = time.time() - t0
        after = proc_cpu(pid)
        sw1 = sum(proc_switches(pid).values())
        cpu = max(0.0, (after[0] + after[1]) - (before[0] + before[1]))
        minflt = max(0, after[2] - before[2])
        majflt = max(0, after[3] - before[3])
        csw = max(0, sw1 - sw0)
        util_note = "（-p 模式按 /proc 增量估算）"

    names = None
    unsupported = []
    if requested is not None:
        names = {ev_name(item) for item in requested}
        unsupported = sorted(n for n in names if n not in FALLBACK_STAT_SOURCES)
        names &= set(FALLBACK_STAT_SOURCES)

    used = cpu / elapsed if elapsed > 0 else 0.0
    print(f"\n Performance counter stats（降级模式：本域无 PMU 计数）"
          f"for {label!r}:\n")
    if names is None or names & {"task-clock", "cpu-clock"}:
        shown = "task-clock" if names is None or "task-clock" in names else "cpu-clock"
        print(f"  {cpu * 1e3:14.6f}  msec  {shown:<25} "
              f"# {used:.2f} CPUs utilized")
    if names is None or "page-faults" in names:
        print(f"  {human(minflt + majflt):>14}  page-faults")
    if names is not None and "minor-faults" in names:
        print(f"  {human(minflt):>14}  minor-faults")
    if names is not None and "major-faults" in names:
        print(f"  {human(majflt):>14}  major-faults")
    if names is None or "context-switches" in names:
        print(f"  {human(csw):>14}  context-switches")
    print(f"\n  {elapsed:10.6f} seconds time elapsed{util_note}\n")

    if attempted:
        sys.stderr.write(
            "  降级原因：perf_event_open 未能打开任何事件（详见上方 errno）。\n")
    else:
        sys.stderr.write(
            "  降级原因：KXXY_PERF_MODE=fallback，未尝试 PMU 计数。\n")
    if unsupported:
        sys.stderr.write(
            "  以下显式请求的事件需要 PMU，降级路径不提供："
            + ", ".join(unsupported) + "\n")
    sys.stderr.write(
        "  以上来自 rusage / /proc，不含 cycles / instructions / branches 等硬件计数。\n"
        "  想要硬件计数可设 KXXY_PERF_MODE=pmu，或在允许的域执行（见下方对照命令）。\n")
    for line in policy_hint(failed_errnos):
        sys.stderr.write(line)
    if requested is not None and not names:
        return 1
    return 0


def _ptrace(lib, ctypes):
    fn = lib.ptrace
    fn.restype = ctypes.c_long
    fn.argtypes = [ctypes.c_long, ctypes.c_long, ctypes.c_void_p,
                   ctypes.c_void_p]
    return fn


def _pc_index():
    machine = MACHINE
    if machine in ("aarch64", "arm64"):
        return 32          # user_pt_regs: regs[31] / sp / pc / pstate
    if machine in ("x86_64", "amd64"):
        return 16          # user_regs_struct.rip 在偏移 128 处
    return None


def read_pc(ptrace, ctypes, pid, index):
    buf = (ctypes.c_ulonglong * 34)()

    class IOVec(ctypes.Structure):
        _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]

    iov = IOVec(ctypes.cast(buf, ctypes.c_void_p), ctypes.sizeof(buf))
    if ptrace(PTRACE_GETREGSET, pid, ctypes.c_void_p(NT_PRSTATUS),
              ctypes.byref(iov)) != 0:
        return 0
    return int(buf[index])


def spawn_traced(cmd):
    """fork + PTRACE_TRACEME：子进程在 exec 处停住，父进程仍可读它的 PC。"""
    lib, ctypes = _libc()
    ptrace = _ptrace(lib, ctypes)
    sys.stdout.flush()
    sys.stderr.flush()
    pid = os.fork()
    if pid == 0:
        try:
            ptrace(PTRACE_TRACEME, 0, None, None)
            os.execvp(cmd[0], cmd)
        except BaseException:
            os._exit(127)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    return pid


def record_fallback(child, pid, freq, duration, label, out, failed_errnos,
                    cmd=None):
    """ptrace 定时抓 PC 的采样器；产出与 PMU 路径相同的 perf.data 文本格式。"""
    import ctypes
    import signal

    index = _pc_index()
    if index is None:
        sys.stderr.write("perf record: 降级采样不支持 %s 架构\n" % MACHINE)
        if child is not None:
            kill_child(child)
        return 1
    if child is None and not pid:
        sys.stderr.write("perf record: 需要 -- cmd 或 -p PID\n")
        return 2

    if child is not None and cmd:
        # spawn_stopped 的孩子没有 PTRACE_TRACEME，换成被跟踪的实例重开
        kill_child(child)
        child = spawn_traced(cmd)

    lib, ctypes = _libc()
    ptrace = _ptrace(lib, ctypes)

    if child is None:
        if ptrace(PTRACE_ATTACH, pid, None, None) != 0:
            sys.stderr.write("perf record: ptrace attach %d 失败（%s）\n"
                             % (pid, os.strerror(ctypes.get_errno())))
            return 1
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
    target = pid if pid else child

    # SIGSTOP 往返一次毫秒级，采样频率按 200 Hz 封顶，否则会明显拖慢目标
    hz = max(1, min(int(freq or 200), 200))
    interval = 1.0 / hz
    limit = duration if duration else 30.0

    maps = read_maps(target)
    comms = {}
    try:
        with open("/proc/%d/comm" % target, "r") as f:
            comms[target] = f.read().strip()
    except OSError:
        comms[target] = str(target)

    samples = []
    exited = False
    target_status = None
    last_maps = time.time()
    t0 = time.time()
    try:
        while time.time() - t0 < limit:
            ptrace(PTRACE_CONT, target, None, None)
            time.sleep(interval)
            try:
                os.kill(target, signal.SIGSTOP)
            except OSError:
                break
            try:
                _, status = os.waitpid(target, os.WUNTRACED)
            except ChildProcessError:
                break
            if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                exited = True
                target_status = status
                break
            pc = read_pc(ptrace, ctypes, target, index)
            if pc:
                # exec 停下时动态库还没加载完，映射要随采样刷新，否则样本落不进
                # 任何模块、report 只能回 [unknown]。
                if not any(start <= pc < start + ln for start, ln, _o, _n in maps) \
                        and time.time() - last_maps > 0.2:
                    maps = read_maps(target)
                    last_maps = time.time()
                samples.append((pc, target, target, [pc]))
    finally:
        # 采样结束不杀目标，但**任何**异常/中断都不能把它留在 SIGSTOP 里：
        # 否则用户那条命令会永远停住（真机上确实这么残留过两个进程）。
        if not exited:
            try:
                ptrace(PTRACE_DETACH, target, None,
                       ctypes.c_void_p(int(signal.SIGCONT)))
            except OSError:
                pass
            try:
                _, target_status = os.waitpid(target, 0)
            except (ChildProcessError, KeyboardInterrupt):
                pass

    with open(out, "w", encoding="utf-8") as f:
        f.write("#kxxy-perf 1\n")
        f.write(f"#label {label}\n")
        f.write("#event cpu-clock\n")
        f.write("#mode ptrace-fallback\n")
        f.write(f"#elapsed {time.time() - t0:.3f}\n")
        f.write(f"#freq {hz}\n")
        for p, nm in sorted(comms.items()):
            f.write(f"C {p} {nm}\n")
        for addr, ln, pgoff, name in maps:
            f.write(f"M {addr:x} {ln:x} {pgoff:x} {name or '[anon]'}\n")
        for ip, rpid, rtid, chain in samples:
            f.write("S %x %d %d %s\n" % (ip, rpid, rtid,
                                         " ".join("%x" % x for x in chain)))

    if samples:
        sys.stderr.write(
            f"perf record: 降级模式（ptrace 每 {interval * 1000:.1f} ms 抓一次 PC，"
            f"仅主线程、无调用链）{len(samples)} 个样本 → {out}\n")
    else:
        sys.stderr.write(
            f"perf record: 降级模式未抓到样本（目标可能很快退出），"
            f"已写出合法的空采样文件 → {out}\n")
    for line in policy_hint(failed_errnos):
        sys.stderr.write(line)
    return sampled_exit_status(target_status, bool(samples), child is not None)


def sampled_exit_status(target_status, have_samples, attached_child):
    """record 的退出码：保留目标结果；-p 模式只在采到样本时算成功。"""
    if target_status is not None and os.WIFSIGNALED(target_status):
        return 128 + os.WTERMSIG(target_status)
    if target_status is not None and os.WIFEXITED(target_status):
        return os.WEXITSTATUS(target_status)
    return 0 if have_samples or attached_child else 1


def ev_name(spec):
    return spec.split(":", 1)[0].strip()


def ev_resolve(spec):
    name = ev_name(spec)
    if name not in EVENTS:
        raise KeyError(name)
    t, cfg, _ = EVENTS[name]
    return t, cfg


def human(n):
    return f"{n:,}"


def spawn_stopped(cmd):
    """fork+exec 起子进程，先让它停在 exec 前 —— `perf stat -- true` 这种
    1 毫秒就退出的命令，等 popen 返回再 perf_event_open 必然 ESRCH。"""
    import signal
    sys.stdout.flush()
    sys.stderr.flush()
    pid = os.fork()
    if pid == 0:
        try:
            os.kill(os.getpid(), signal.SIGSTOP)
            os.execvp(cmd[0], cmd)
        except BaseException:
            os._exit(127)
    try:
        os.waitpid(pid, os.WUNTRACED)
    except ChildProcessError:
        pass
    return pid


def resume(pid):
    import signal
    try:
        os.kill(pid, signal.SIGCONT)
    except OSError:
        pass


def alive(pid):
    try:
        wpid, _ = os.waitpid(pid, os.WNOHANG)
        return wpid == 0
    except ChildProcessError:
        return False


def reap(pid):
    try:
        _, status = os.waitpid(pid, 0)
        return status
    except ChildProcessError:
        return -1


def kill_child(pid):
    import signal
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except OSError:
        pass


# ── stat ───────────────────────────────────────────────────────────────────
def cmd_stat(argv):
    events = None
    explicit_events = False
    pid = None
    duration = None
    verbose = False
    cmd = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            cmd = argv[i + 1:]
            break
        elif a in ("-e", "--event"):
            i += 1
            events = [x for x in argv[i].replace(",", " ").split() if x]
            explicit_events = True
        elif a in ("-p", "--pid"):
            i += 1
            pid = int(argv[i])
        elif a in ("-a", "--all-cpus"):
            sys.stderr.write(f"perf stat: 不支持的选项 {a}（未实现系统范围计数）\n")
            return 2
        elif a in ("-r", "--repeat"):
            i += 1
        elif a.startswith("-"):
            if a in ("-v", "--verbose"):
                verbose = True
            elif a in ("-d", "--detailed"):
                events = (events or []) + ["cache-references", "cache-misses",
                                           "stalled-cycles-frontend",
                                           "stalled-cycles-backend"]
                explicit_events = True
            else:
                sys.stderr.write(f"perf stat: 不支持的选项 {a}\n")
                return 2
        elif duration is None and a.isdigit() and pid is not None:
            duration = float(a)
        else:
            cmd = argv[i:]
            break
        i += 1

    if not events:
        events = list(DEFAULT_STAT)

    child = None
    if cmd:
        child = spawn_stopped(cmd)
        target = child
        label = " ".join(cmd)
    elif pid:
        target = pid
        label = f"pid {pid}"
        duration = duration or 3.0
    else:
        sys.stderr.write("perf stat: 需要 -- cmd 或 -p PID\n")
        return 2

    mode = perf_mode()
    if mode == "fallback":
        return stat_fallback(child, None if child is not None else target,
                             duration, label, [], attempted=False,
                             requested=events if explicit_events else None)

    fds = []
    used = []
    exclude_kernel = 0
    failed_errnos = []
    for spec in events:
        try:
            t, cfg = ev_resolve(spec)
        except KeyError:
            sys.stderr.write(f"perf stat: 未知事件 {spec}（perf list 看可选）\n")
            continue
        opened = False
        failures = []
        for ek in (0, 1):  # 先按 perf 默认（含内核），失败再试只算用户态
            bits = [B_DISABLED]
            if ek:
                bits.append(B_EXCL_KERNEL)
            blob = attr_blob(t, cfg, bits=bits)
            try:
                fd = perf_open(blob, pid=target)
            except OSError as ex:
                failures.append(perf_open_failure("stat", spec, blob, ex, pid=target))
                failed_errnos.append(ex.errno)
                continue
            ev_ioctl(fd, PERF_IOC_ENABLE)
            fds.append((fd, spec))
            used.append(spec)
            exclude_kernel = ek
            opened = True
            break
        if not opened or verbose:
            sys.stderr.writelines(failures)
        if not opened and verbose:
            sys.stderr.write(f"  {spec}: 跳过\n")

    if not fds and mode != "pmu":
        # 一个计数器都没开起来（应用域 EACCES 等）——子进程还停在 exec 前，
        # 此时改用 rusage 记账，拿到 CPU 时间/缺页/切换次数而不是直接失败。
        sys.stderr.write("perf stat: PMU 不可用，切换到 rusage//proc 降级统计。\n")
        return stat_fallback(child, None if child is not None else target,
                             duration, label, failed_errnos,
                             requested=events if explicit_events else None)

    t0 = time.time()
    if child is not None:
        resume(child)
        reap(child)
    else:
        time.sleep(duration)
    elapsed = time.time() - t0

    for fd, _ in fds:
        try:
            ev_ioctl(fd, PERF_IOC_DISABLE)
        except OSError:
            pass

    rows = []
    for fd, spec in fds:
        try:
            raw = os.read(fd, 8)
            val = struct.unpack("<Q", raw)[0]
        except OSError:
            val = 0
        rows.append((spec, val))
        os.close(fd)

    if not rows:
        sys.stderr.write("perf stat: 没有可用计数器；事件打开失败详情见上\n")
        for line in policy_hint(failed_errnos):
            sys.stderr.write(line)
        return 1

    print(f"\n Performance counter stats for {label!r}"
          f"{'（不含内核态）' if exclude_kernel else ''}:\n")
    for spec, val in rows:
        name = ev_name(spec)
        if name in ("task-clock", "cpu-clock"):
            print(f"  {val / 1e6:14.6f}  msec  {name}")
        elif name == "page-faults" or name.endswith("faults"):
            print(f"  {human(val):>14}  {name}")
        else:
            print(f"  {human(val):>14}  {name}")
            if name in ("cycles", "task-clock") and val and elapsed:
                pass
    print(f"\n  {elapsed:10.6f} seconds time elapsed\n")
    # 派生指标（perf stat 的招牌）
    d = dict((ev_name(s), v) for s, v in rows)
    if d.get("instructions") and d.get("cycles"):
        print(f"  {d['instructions'] / d['cycles']:.2f}  insn per cycle")
    if d.get("instructions") and d.get("task-clock"):
        pass
    if d.get("branch-misses") and d.get("branches"):
        print(f"  {100.0 * d['branch-misses'] / d['branches']:.2f}%  of all branches"
              f" missed")
    if d.get("instructions") and d.get("task-clock"):
        # task-clock 是纳秒
        gbps = d["instructions"] / (d["task-clock"] / 1e9) / 1e9
        if gbps > 0:
            print(f"  {gbps:.2f}  GHz  effective（指令吞吐）")
    print()
    return 0


# ── 环形缓冲 ───────────────────────────────────────────────────────────────
class Ring:
    def __init__(self, fd, pages=8):
        import mmap
        self.size = pages * PAGE
        self.mm = mmap.mmap(fd, (pages + 1) * PAGE)
        self.head_off = 1024
        self.tail_off = 1032
        self.data = PAGE

    def head(self):
        return struct.unpack_from("<Q", self.mm, self.head_off)[0]

    def set_tail(self, v):
        struct.unpack_from  # noqa
        struct.pack_into("<Q", self.mm, self.tail_off, v)

    def read(self, pos, n):
        """从环形区读 n 字节（处理回绕）。pos 是相对 data 区的偏移。"""
        out = b""
        start = self.data + (pos % self.size)
        remain = n
        while remain:
            chunk = min(remain, self.data + self.size - start)
            out += self.mm[start:start + chunk]
            remain -= chunk
            start = self.data
        return out

    def close(self):
        try:
            self.mm.close()
        except Exception:
            pass


def make_maps_entry(addr, length, pgoff, path):
    return ("M", addr, length, pgoff, path)


def cmd_record(argv):
    freq = 999
    period = None
    event = DEFAULT_RECORD_EVENT
    out = "perf.data"
    pid = None
    duration = None
    callgraph = False
    cmd = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            cmd = argv[i + 1:]
            break
        elif a in ("-F", "--freq"):
            i += 1
            freq = int(argv[i])
        elif a in ("-c", "--count"):
            i += 1
            period = int(argv[i])
        elif a in ("-e", "--event"):
            i += 1
            event = ev_name(argv[i])
        elif a in ("-o", "--output"):
            i += 1
            out = argv[i]
        elif a in ("-p", "--pid"):
            i += 1
            pid = int(argv[i])
        elif a in ("-g", "--call-graph"):
            callgraph = True
        elif a == "--duration":
            i += 1
            duration = float(argv[i])
        elif a.startswith("-"):
            sys.stderr.write(f"perf record: 不支持的选项 {a}\n")
            return 2
        elif a.isdigit() and pid is not None and duration is None:
            duration = float(a)
        else:
            cmd = argv[i:]
            break
        i += 1

    try:
        t, cfg = ev_resolve(event)
    except KeyError:
        sys.stderr.write(f"perf record: 未知事件 {event}（perf list 看可选）\n")
        return 2

    child = None
    if cmd:
        child = spawn_traced(cmd) if perf_mode() == "fallback" else spawn_stopped(cmd)
        target = child
        label = " ".join(cmd)
        if duration is None:
            duration = 30.0
    elif pid:
        target = pid
        label = f"pid {pid}"
        duration = duration or 5.0
    else:
        sys.stderr.write("perf record: 需要 -- cmd 或 -p PID\n")
        return 2

    stype = (1 << S_IP) | (1 << S_TID) | (1 << S_TIME)
    if callgraph:
        stype |= 1 << S_CALLCHAIN
    bits = [B_DISABLED, B_MMAP, B_COMM, B_TASK]
    # 不能带 B_INHERIT：内核 perf_mmap() 对「per-task 且 inherit」直接 EINVAL
    # （所有子进程共用一个环会串数据）。代价是 record 只采样目标进程本身。

    if perf_mode() == "fallback":
        return record_fallback(child, None if child is not None else target,
                               freq, duration, label, out, [], cmd=cmd)

    fd = None
    failures = []
    failed_errnos = []
    for ek in (0, 1):
        b = list(bits) + ([B_EXCL_KERNEL] if ek else [])
        if period:
            blob = attr_blob(t, cfg, sample_period=period, sample_type=stype, bits=b)
        else:
            blob = attr_blob(t, cfg, sample_period=freq, sample_type=stype,
                             bits=b, freq=True)
        try:
            fd = perf_open(blob, pid=target)
            break
        except OSError as ex:
            failures.append(perf_open_failure("record", event, blob, ex, pid=target))
            failed_errnos.append(ex.errno)
    sys.stderr.writelines(failures)
    if fd is None:
        if perf_mode() != "pmu":
            # 应用域里 PMU 事件被策略拒绝——改用 ptrace 抓 PC，采样本身不需要 PMU
            sys.stderr.write(
                "perf record: PMU 路径不可用，切换到 ptrace 降级采样。\n")
            return record_fallback(child, None if child is not None else target,
                                   freq, duration, label, out, failed_errnos,
                                   cmd=cmd)
        sys.stderr.write("perf record: 没有可用采样事件；事件打开失败详情见上\n")
        for line in policy_hint(failed_errnos):
            sys.stderr.write(line)
        if child is not None:
            kill_child(child)
        return 1

    ring = Ring(fd)
    ev_ioctl(fd, PERF_IOC_ENABLE)
    if child is not None:
        resume(child)

    maps = []
    samples = []   # (ip, pid, tid, chain)
    comms = {}
    tail = 0
    lost = 0
    t0 = time.time()
    try:
        while time.time() - t0 < duration:
            if child is not None and not alive(child):
                break
            head = ring.head()
            while tail < head:
                hdr = ring.read(tail, 8)
                if len(hdr) < 8:
                    break
                rtype, misc, rsize = struct.unpack("<IHH", hdr)
                if rsize < 8:
                    break
                body = ring.read(tail, rsize)
                tail += rsize
                if rtype == REC_SAMPLE:
                    off = 8
                    ip, rpid, rtid, _t = struct.unpack_from("<QIIQ", body, off)
                    off += 24
                    chain = [ip]
                    if callgraph and len(body) >= off + 8:
                        nr = struct.unpack_from("<Q", body, off)[0]
                        off += 8
                        for k in range(min(nr, 128)):
                            if off + 8 > len(body):
                                break
                            chain.append(struct.unpack_from("<Q", body, off)[0])
                            off += 8
                    samples.append((ip, rpid, rtid, chain))
                elif rtype in (REC_MMAP, REC_MMAP2):
                    try:
                        if rtype == REC_MMAP:
                            rpid, rtid, addr, ln, pgoff = struct.unpack_from(
                                "<IIQQQ", body, 8)
                            name = body[40:].split(b"\x00", 1)[0].decode(
                                "utf-8", "replace")
                        else:
                            rpid, rtid, addr, ln, pgoff = struct.unpack_from(
                                "<IIQQQ", body, 8)
                            name = body[72:].split(b"\x00", 1)[0].decode(
                                "utf-8", "replace")
                        if ln:
                            maps.append((addr, ln, pgoff, name))
                    except struct.error:
                        pass
                elif rtype == REC_COMM:
                    try:
                        rpid, rtid = struct.unpack_from("<II", body, 8)
                        nm = body[16:].split(b"\x00", 1)[0].decode("utf-8", "replace")
                        comms[rpid] = nm
                    except struct.error:
                        pass
                elif rtype == REC_LOST:
                    lost += 1
            ring.set_tail(tail)
            time.sleep(0.01)
    finally:
        try:
            ev_ioctl(fd, PERF_IOC_DISABLE)
        except OSError:
            pass

    if child is not None:
        reap(child)
    ring.close()
    os.close(fd)

    if not maps:
        # 兜底：进程还活着就直接读 /proc/PID/maps
        try:
            with open(f"/proc/{target}/maps") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) < 6:
                        continue
                    rng, perms, off, _dev, _ino, path = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]
                    if "x" not in perms:
                        continue
                    s, e = (int(x, 16) for x in rng.split("-"))
                    maps.append((s, e - s, int(off, 16), path))
        except OSError:
            pass

    if pid and target not in comms:
        try:
            with open(f"/proc/{target}/comm") as f:
                comms[target] = f.read().strip()
        except OSError:
            pass

    with open(out, "w", encoding="utf-8") as f:
        f.write("#kxxy-perf 1\n")
        f.write(f"#label {label}\n")
        f.write(f"#event {event}\n")
        f.write(f"#elapsed {time.time() - t0:.3f}\n")
        if lost:
            f.write(f"#lost {lost}\n")
        for pid_, nm in sorted(comms.items()):
            f.write(f"C {pid_} {nm}\n")
        for addr, ln, pgoff, name in maps:
            f.write(f"M {addr:x} {ln:x} {pgoff:x} {name or '[anon]'}\n")
        for ip, rpid, rtid, chain in samples:
            f.write("S %x %d %d %s\n" % (ip, rpid, rtid, " ".join("%x" % x for x in chain)))

    sys.stderr.write(
        f"perf record: {len(samples)} 个样本 → {out}"
        f"{'（丢 ' + str(lost) + ' 块）' if lost else ''}\n")
    return 0


# ── ELF 符号 ───────────────────────────────────────────────────────────────
class ElfSyms:
    """最小 ELF64 读取：把 st_value 换算成文件偏移，便于和采样地址对齐。"""

    def __init__(self, path):
        self.syms = []      # (file_off_start, file_off_end, name)
        self.ok = False
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return
        if len(data) < 64 or data[:4] != b"\x7fELF" or data[4] != 2:
            return
        try:
            e_phoff, e_shoff = struct.unpack_from("<QQ", data, 32)
            e_phentsize, e_phnum, e_shentsize, e_shnum = struct.unpack_from(
                "<HHHH", data, 54)
        except struct.error:
            return
        segs = []
        for i in range(e_phnum):
            off = e_phoff + i * e_phentsize
            try:
                p_type, p_flags, p_offset, p_vaddr = struct.unpack_from(
                    "<IIQQ", data, off)
            except struct.error:
                break
            if p_type == 1:  # PT_LOAD
                segs.append((p_vaddr, p_offset))
        if not segs:
            return

        def to_off(vaddr):
            best = None
            for p_vaddr, p_offset in segs:
                if vaddr >= p_vaddr:
                    cand = vaddr - p_vaddr + p_offset
                    if best is None or cand < best:
                        best = cand
            return best

        for i in range(e_shnum):
            off = e_shoff + i * e_shentsize
            try:
                sh_name, sh_type, sh_flags, sh_addr, sh_offset, sh_size, \
                    sh_link, sh_info, sh_align, sh_entsize = struct.unpack_from(
                        "<IIQQQQIIQQ", data, off)
            except struct.error:
                break
            if sh_type not in (2, 11):  # SYMTAB / DYNSYM
                continue
            if not sh_entsize:
                continue
            str_off = e_shoff + sh_link * e_shentsize
            try:
                s_name, s_type, s_flags, s_addr, s_off, s_size = struct.unpack_from(
                    "<IIQQQQ", data, str_off)
            except struct.error:
                continue
            strtab = data[s_off:s_off + s_size]
            n = sh_size // sh_entsize
            for k in range(n):
                so = sh_offset + k * sh_entsize
                try:
                    st_name, st_info, st_other, st_shndx, st_value, st_size = \
                        struct.unpack_from("<IBBHQQ", data, so)
                except struct.error:
                    break
                if not st_value:
                    continue
                if (st_info & 0xF) not in (2, 10, 0):  # FUNC / GNU_IFUNC / NOTYPE
                    continue
                if st_name >= len(strtab):
                    continue
                name = strtab[st_name:].split(b"\x00", 1)[0].decode("utf-8", "replace")
                if not name:
                    continue
                fo = to_off(st_value)
                if fo is None:
                    continue
                self.syms.append((fo, fo + max(st_size, 1), name, st_value))
        self.syms.sort(key=lambda s: s[0])
        self.ok = bool(self.syms)

    def lookup(self, file_off):
        lo, hi = 0, len(self.syms) - 1
        best = None
        while lo <= hi:
            mid = (lo + hi) // 2
            s = self.syms[mid]
            if s[0] <= file_off:
                if file_off < s[1]:
                    return s[2]
                best = s[2]
                lo = mid + 1
            else:
                hi = mid - 1
        return best


_ELF_CACHE = {}


def elf_for(path):
    if path not in _ELF_CACHE:
        _ELF_CACHE[path] = ElfSyms(path)
    return _ELF_CACHE[path]


def symbolize(ip, maps):
    """maps: [(start, len, pgoff, path)] 按 start 升序。"""
    lo, hi = 0, len(maps) - 1
    idx = None
    while lo <= hi:
        mid = (lo + hi) // 2
        s = maps[mid]
        if ip < s[0]:
            hi = mid - 1
        elif ip >= s[0] + s[1]:
            lo = mid + 1
        else:
            idx = mid
            break
    if idx is None:
        return ("[unknown]", 0, None)
    start, ln, pgoff, path = maps[idx]
    if not path or path.startswith("["):
        return (path or "[anon-exec]", ip - start, None)
    file_off = pgoff + (ip - start)
    elf = elf_for(path)
    name = elf.lookup(file_off) if elf.ok else None
    if name:
        return (name, ip - start, path)
    return (os.path.basename(path), ip - start, path)


def demangle_names(names):
    """C++ 名字走 c++filt / llvm-cxxfilt（引擎 bin/ 里有），没有就保留原名。"""
    import shutil
    import subprocess
    need = sorted({n for n in names if n.startswith("_Z")})
    if not need:
        return {}
    exe = None
    for cand in ("c++filt", "llvm-cxxfilt"):
        exe = shutil.which(cand)
        if exe:
            break
    if not exe:
        return {}
    try:
        r = subprocess.run([exe], input="\n".join(need), capture_output=True,
                           text=True, timeout=30)
        lines = r.stdout.splitlines()
        if r.returncode != 0 or len(lines) != len(need):
            return {}
        return dict(zip(need, lines))
    except Exception:
        return {}


def cmd_report(argv):
    src = "perf.data"
    top = 30
    show_stack = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-i", "--input"):
            i += 1
            src = argv[i]
        elif a in ("-n", "--top"):
            i += 1
            top = int(argv[i])
        elif a in ("-g", "--stack", "--call-graph"):
            show_stack = True
        elif a in ("--stdio", "-T"):
            pass
        else:
            sys.stderr.write(f"perf report: 不认识的参数 {a}\n")
            return 2
        i += 1

    try:
        lines = open(src, encoding="utf-8").read().splitlines()
    except OSError as ex:
        sys.stderr.write(f"perf report: 打不开 {src}（{ex.strerror}）\n")
        return 1

    maps = []
    comms = {}
    samples = []
    label = ""
    elapsed = 0.0
    for line in lines:
        if line.startswith("M "):
            parts = line.split(" ", 4)
            if len(parts) < 5:
                continue
            maps.append((int(parts[1], 16), int(parts[2], 16),
                         int(parts[3], 16), parts[4]))
        elif line.startswith("S "):
            parts = line.split()
            if len(parts) < 4:
                continue
            chain = [int(x, 16) for x in parts[4:]] or [int(parts[1], 16)]
            samples.append((int(parts[1], 16), int(parts[2]), chain))
        elif line.startswith("C "):
            parts = line.split(" ", 2)
            if len(parts) == 3:
                comms[int(parts[1])] = parts[2]
        elif line.startswith("#label "):
            label = line[7:]
        elif line.startswith("#elapsed "):
            try:
                elapsed = float(line[9:])
            except ValueError:
                pass

    if not samples:
        sys.stderr.write(f"perf report: {src} 里没有样本\n")
        return 1
    maps.sort()

    total = len(samples)
    agg = {}
    for ip, pid, chain in samples:
        name, off, path = symbolize(chain[0] if chain else ip, maps)
        comm = comms.get(pid, str(pid))
        if show_stack and len(chain) > 1:
            key = " <- ".join(symbolize(x, maps)[0] for x in chain[:8])
        else:
            key = name
        agg[(comm, key)] = agg.get((comm, key), 0) + 1

    print(f"\n# kxxy-perf report · {src}")
    if label:
        print(f"# 目标 {label} · {total} 个样本 · {elapsed:.2f}s · "
              f"{len(maps)} 个映射")
    mode = next((l[6:] for l in lines if l.startswith("#mode ")), "")
    print(f"# 事件 {next((l[7:] for l in lines if l.startswith('#event ')), '?')}"
          f"{' · ' + mode if mode else ''}\n")
    print(f"{'Samples':>8}  {'Percent':>8}  Command        Symbol")
    print("-" * 78)
    dm = {} if show_stack else demangle_names({k[1] for k in agg})
    for (comm, name), cnt in sorted(agg.items(), key=lambda kv: -kv[1])[:top]:
        pct = 100.0 * cnt / total
        disp = dm.get(name, name)
        if len(disp) > 46:
            disp = disp[:43] + "..."
        print(f"{cnt:>8}  {pct:>7.2f}%  {comm[:14]:<14} {disp}")
    print()
    if not show_stack:
        print("（`-g` 记录调用链，`--stack` 按栈显示；JIT 代码落在匿名可执行映射里，"
              "显示为 [anon-exec]）")
    return 0


def cmd_list(argv):
    print("Events: PMU 列来自现场 perf_event_open；降级列不依赖 PMU。\n")
    groups = {}
    for name, (t, cfg, desc) in sorted(EVENTS.items()):
        kind = "hardware" if t == HW else "software"
        groups.setdefault(kind, []).append((name, cfg, desc))
    for kind, items in groups.items():
        print(f"  {kind}:")
        print(f"    {'PMU':<10} {'event':<26} {'fallback':<20} description")
        for name, cfg, desc in items:
            pmu = "✓"
            try:
                fd = perf_open(attr_blob(0 if kind == "hardware" else 1, cfg,
                                         bits=[B_DISABLED]))
                os.close(fd)
            except OSError as ex:
                code = errno.errorcode.get(ex.errno, str(ex.errno))
                pmu = "✗ " + code
            sources = []
            if name in FALLBACK_STAT_SOURCES:
                sources.append("stat:" + FALLBACK_STAT_SOURCES[name])
            if name in FALLBACK_RECORD_EVENTS:
                sources.append("record:ptrace")
            print(f"    {pmu:<10} {name:<26} {', '.join(sources) or '—':<20} {desc}")
        print()

    dom = current_domain()
    print(f"  当前域：{dom} · KXXY_PERF_MODE={perf_mode()}")
    print("  PMU 全部 ✗ 只表示硬件/内核计数不可用；stat/record 仍可能走 fallback。")
    print("  真 PMU 需要允许 perf_event_open 的域（如 adb run-as 或特权 helper）。")
    return 0


def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return 0
    if argv[0] in ("--version", "-v", "version"):
        print("kxxy-perf 1.1（perf_event_open 直连；无 PMU 时 rusage/ptrace 降级）")
        return 0
    cmd, rest = argv[0], argv[1:]
    table = {"stat": cmd_stat, "record": cmd_record, "report": cmd_report,
             "list": cmd_list, "ls": cmd_list}
    fn = table.get(cmd)
    if fn is None:
        sys.stderr.write(f"perf: 未知子命令 {cmd}（stat/record/report/list）\n")
        return 2
    return fn(rest)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)
