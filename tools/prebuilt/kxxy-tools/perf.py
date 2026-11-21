#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kxxy-perf —— 直接调用 perf_event_open 的极简 perf。

为什么不是 simpleperf：NDK 的 simpleperf 在 app uid 下有两处硬限制
（`-- cmd` 直接拒；`record` 启动时要 SetProperty debug.perf_event_max_sample_rate，
应用域改不了系统属性，即使外面已经 setprop 也照样失败）。而内核本身是允许的
—— `perf_event_paranoid=-1`，perf_event_open 对 SW/HW 事件都返回正常 fd。
所以这里绕开 simpleperf，自己开事件、自己读环形缓冲。

子命令：
  perf list                       支持的计数器
  perf stat [-e ev,ev] [-p PID] [--] cmd...     计数器汇总
  perf record [-F 999] [-g] [-o f] [-p PID] [--] cmd...    采样
  perf report [-i f] [--stack]                  符号化汇总

只依赖 CPython 标准库（ctypes/struct/mmap），可以在 bionic 上原生跑。
"""

import os
import struct
import sys
import time

PAGE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096

SYS_PERF_EVENT_OPEN = {
    "aarch64": 241, "arm64": 241,
    "armv7l": 364, "armv8l": 364,
    "x86_64": 298, "amd64": 298,
    "i686": 336, "i386": 336,
}[os.uname().machine] if os.uname().machine in (
    "aarch64", "arm64", "armv7l", "armv8l", "x86_64", "amd64", "i686", "i386",
) else 241

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
        elif a in ("-p", "--pid"):
            i += 1
            pid = int(argv[i])
        elif a in ("-a", "--all-cpus"):
            pass  # 应用域只能看自己，接受但忽略
        elif a in ("-r", "--repeat"):
            i += 1
        elif a.startswith("-"):
            if a in ("-v", "--verbose"):
                verbose = True
            elif a in ("-d", "--detailed"):
                events = (events or []) + ["cache-references", "cache-misses",
                                           "stalled-cycles-frontend",
                                           "stalled-cycles-backend"]
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

    fds = []
    used = []
    exclude_kernel = 0
    for spec in events:
        try:
            t, cfg = ev_resolve(spec)
        except KeyError:
            sys.stderr.write(f"perf stat: 未知事件 {spec}（perf list 看可选）\n")
            continue
        opened = False
        for ek in (0, 1):  # 先按 perf 默认（含内核），被拒再退到只算用户态
            bits = [B_DISABLED]
            if ek:
                bits.append(B_EXCL_KERNEL)
            try:
                fd = perf_open(attr_blob(t, cfg, bits=bits), pid=target)
            except OSError as ex:
                if ek == 0:
                    continue
                if verbose:
                    sys.stderr.write(f"  {spec}: 开不了（{ex.strerror}）\n")
                break
            ev_ioctl(fd, PERF_IOC_ENABLE)
            fds.append((fd, spec))
            used.append(spec)
            exclude_kernel = ek
            opened = True
            break
        if not opened and verbose:
            sys.stderr.write(f"  {spec}: 跳过\n")

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
        sys.stderr.write("perf stat: 一个计数器都没开起来（内核/sepolicy 拒绝）\n")
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
        child = spawn_stopped(cmd)
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

    def try_open(ek):
        b = list(bits) + ([B_EXCL_KERNEL] if ek else [])
        if period:
            blob = attr_blob(t, cfg, sample_period=period, sample_type=stype, bits=b)
        else:
            blob = attr_blob(t, cfg, sample_period=freq, sample_type=stype,
                             bits=b, freq=True)
        return perf_open(blob, pid=target)

    fd = None
    for ek in (0, 1):
        try:
            fd = try_open(ek)
            break
        except OSError as ex:
            if ek == 1:
                sys.stderr.write(f"perf record: {event} 开不了（{ex.strerror}）\n")
                if child:
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
    print(f"# 事件 {next((l[7:] for l in lines if l.startswith('#event ')), '?')}\n")
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
    print("List of supported events（每个都现场试开一次）:\n")
    groups = {}
    for name, (t, cfg, desc) in sorted(EVENTS.items()):
        kind = "hardware" if t == HW else "software"
        groups.setdefault(kind, []).append((name, cfg, desc))
    for kind, items in groups.items():
        print(f"  {kind}:")
        for name, cfg, desc in items:
            ok = "✓"
            try:
                fd = perf_open(attr_blob(0 if kind == "hardware" else 1, cfg,
                                         bits=[B_DISABLED]))
                os.close(fd)
            except OSError:
                ok = "✗"
            print(f"    {ok} {name:<26} {desc}")
        print()
    return 0


def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return 0
    if argv[0] in ("--version", "-v", "version"):
        print("kxxy-perf 1.0（perf_event_open 直连，不含 simpleperf）")
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
