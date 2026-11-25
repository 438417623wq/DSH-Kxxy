#!/usr/bin/env python3
"""Manual device probe: engine/bin/python -I this-script --root ENGINE --scratch-parent WRITABLE.

JSON to stdout, exit 1 on any failed or unverified required capability. No su, policy edits, or provisioning.
PATH and runtime environment are inherited unchanged. All probe-created files live in
one private scratch directory and are removed, including on failed checks.
"""
import argparse
import ctypes
import errno
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import sysconfig
import tempfile
import time


SELF_INFO = """import json, os, platform, sys, sysconfig
print(json.dumps({'executable': sys.executable, 'prefix': sys.prefix, 'base_prefix': sys.base_prefix,
 'version': sys.version, 'platform': platform.platform(), 'machine': platform.machine(),
 'sys_platform': sys.platform, 'build_platform': sysconfig.get_platform(), 'soabi': sysconfig.get_config_var('SOABI'),
 'uid': os.getuid() if hasattr(os, 'getuid') else None, 'PATH': os.environ.get('PATH', '')}))
"""
PYTHON_CAPABILITIES = SELF_INFO + """import numpy as np, sklearn, cv2
from sklearn.linear_model import LinearRegression
x = np.array([[0.0], [1.0], [2.0]])
y = np.array([1.0, 3.0, 5.0])
model = LinearRegression().fit(x, y)
prediction = model.predict(np.array([[3.0]])).tolist()
image = cv2.resize(np.arange(12, dtype=np.uint8).reshape(3, 4), (2, 2))
assert np.allclose(prediction, [7.0]) and image.shape == (2, 2)
print(json.dumps({'numpy': np.__version__, 'sklearn': sklearn.__version__, 'cv2': cv2.__version__,
 'numpy_file': np.__file__, 'sklearn_file': sklearn.__file__, 'cv2_file': cv2.__file__,
 'prediction': prediction, 'resized_shape': list(image.shape), 'resized_values': image.tolist()}))
"""
CPU_LOAD = """import json, sys, time
from pathlib import Path
start = time.monotonic()
value = 1
while time.monotonic() - start < 2.0:
    for i in range(20000):
        value = (value * 1664525 + i + 1013904223) & 0xffffffff
Path(sys.argv[1]).write_text(json.dumps({'value': value, 'elapsed': time.monotonic() - start}), encoding='utf-8')
"""


def failure(ex):
    return {"error": str(ex), "errno": getattr(ex, "errno", None),
            "errno_name": errno.errorcode.get(getattr(ex, "errno", None))}


def read_metadata(path):
    try:
        return {"status": "pass", "path": path, "text": Path(path).read_text(encoding="utf-8").strip()}
    except FileNotFoundError as ex:
        return {"status": "skip", "path": path, **failure(ex)}
    except OSError as ex:
        return {"status": "fail", "path": path, **failure(ex)}


def process_info():
    status = read_metadata("/proc/self/status")
    fields = {}
    if status["status"] == "pass":
        for line in status["text"].splitlines():
            key, _, value = line.partition(":")
            if key in ("Uid", "Gid", "Seccomp", "Seccomp_filters", "NoNewPrivs"):
                fields[key] = value.strip()
    return {
        "status": "fail" if status["status"] == "fail" else "pass" if hasattr(os, "getuid") else "skip",
        "uid": os.getuid() if hasattr(os, "getuid") else None,
        "gid": os.getgid() if hasattr(os, "getgid") else None,
        "euid": os.geteuid() if hasattr(os, "geteuid") else None,
        "egid": os.getegid() if hasattr(os, "getegid") else None,
        "executable": sys.executable, "prefix": sys.prefix, "version": sys.version,
        "platform": platform.platform(), "machine": platform.machine(),
        "sys_platform": sys.platform, "build_platform": sysconfig.get_platform(),
        "soabi": sysconfig.get_config_var("SOABI"),
        "runtime_context_note": "Platform/ABI and uid are observed metadata; they do not prove native execution or real root under emulation.",
        "PATH": os.environ.get("PATH", ""), "proc_status": status["status"], "proc_fields": fields,
        "proc_status_error": status.get("error"),
    }


def run_command(argv, scratch, timeout=45):
    """Do not inject PATH/PYTHONPATH or substitute an explicit alternative Python."""
    started = time.monotonic()
    try:
        result = subprocess.run(argv, cwd=str(scratch), capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=timeout)
        return {"status": "pass" if result.returncode == 0 else "fail", "argv": argv,
                "code": result.returncode, "stdout": result.stdout, "stderr": result.stderr,
                "elapsed_seconds": round(time.monotonic() - started, 3)}
    except subprocess.TimeoutExpired as ex:
        def text(value):
            return value.decode("utf-8", "replace") if isinstance(value, bytes) else value or ""
        return {"status": "fail", "argv": argv, "code": None, "timed_out": True,
                "stdout": text(ex.stdout), "stderr": text(ex.stderr), "error": str(ex)}
    except OSError as ex:
        return {"status": "fail", "argv": argv, "code": None, "stdout": "", "stderr": "", **failure(ex)}


def installed(path):
    try:
        path.lstat()
        return {"status": "pass", "path": str(path)} if path.is_file() else {"status": "skip", "path": str(path), "reason": "tool not installed"}
    except FileNotFoundError:
        return {"status": "skip", "path": str(path), "reason": "tool not installed"}
    except OSError as ex:
        return {"status": "fail", "path": str(path), **failure(ex)}


def file_info(path):
    value = path.lstat()
    return {"dev": value.st_dev, "ino": value.st_ino, "nlink": value.st_nlink,
            "mode": value.st_mode, "uid": value.st_uid, "gid": value.st_gid,
            "size": value.st_size, "mtime_ns": value.st_mtime_ns,
            "is_symlink": stat.S_ISLNK(value.st_mode), "is_regular": stat.S_ISREG(value.st_mode)}


def os_link(source, destination):
    """`os.link` with a libc fallback for Android's CPython.

    Android 的 CPython 构建没有 `os.link`（真机实测 `AttributeError: module 'os'
    has no attribute 'link'`），`link(2)` 在 libc 里却是有的 —— 直接 ctypes 调，
    否则探针在**唯一需要它的平台**上不是「报告没有硬链接」，而是整份报告崩掉。
    """
    if hasattr(os, "link"):
        return os.link(source, destination)
    libc = ctypes.CDLL(None, use_errno=True)
    rc = libc.link(os.fsencode(str(source)), os.fsencode(str(destination)))
    if rc != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err), str(source), None, str(destination))


def verify_link(source, destination, payload):
    """Reject link2symlink/copy emulation; prove unlink survival and restoration."""
    original, linked = file_info(source), file_info(destination)
    result = {"status": "fail", "source": original, "destination": linked}
    genuine = (original["is_regular"] and linked["is_regular"] and not original["is_symlink"]
               and not linked["is_symlink"] and original["dev"] == linked["dev"]
               and original["ino"] == linked["ino"] and min(original["nlink"], linked["nlink"]) >= 2)
    result["true_hardlink"] = genuine
    if not genuine:
        result["reason"] = "not a true hardlink (symlink, copy, different inode/device, or insufficient nlink)"
        return result
    if source.read_bytes() != payload or destination.read_bytes() != payload:
        result["reason"] = "linked content mismatch"
        return result
    source.unlink()
    result["unlink_source_survives"] = destination.read_bytes() == payload
    result["after_unlink"] = file_info(destination)
    os_link(destination, source)
    result["restored_source"] = file_info(source)
    result["restored_destination"] = file_info(destination)
    result["source_restored"] = (source.read_bytes() == payload and
                                 result["restored_source"]["ino"] == linked["ino"] and
                                 result["restored_source"]["dev"] == linked["dev"] and
                                 min(result["restored_source"]["nlink"], result["restored_destination"]["nlink"]) >= 2 and
                                 not result["restored_source"]["is_symlink"])
    result["status"] = "pass" if result["unlink_source_survives"] and result["source_restored"] else "fail"
    return result


def link_probe(root, scratch, kind):
    tool = root / "bin" / ("coreutils" if kind == "ln" else "rsync")
    if kind != "os.link":
        availability = installed(tool)
        if availability["status"] != "pass":
            return availability
    work = scratch / kind.replace(".", "-")
    payload = b"kxxy capability probe hardlink payload\n"
    result = {"status": "fail"}
    try:
        work.mkdir()
        if kind == "rsync":
            for name in ("src", "base", "dst"):
                (work / name).mkdir()
            source, base, destination = (work / "src/item", work / "base/item", work / "dst/item")
            source.write_bytes(payload)
            base.write_bytes(payload)
            stamp = 1_700_000_000_000_000_000
            for path in (source, base):
                os.utime(path, ns=(stamp, stamp))
            first, second = file_info(source), file_info(base)
            attrs = ("mode", "uid", "gid", "size", "mtime_ns")
            result["matched_attributes"] = all(first[key] == second[key] for key in attrs)
            result["source_before"] = first
            result["base_before"] = second
            if not result["matched_attributes"]:
                result["reason"] = "source/base attributes did not match exactly; link-dest result not tested"
                return result
            command = run_command([str(tool), "-a", "--link-dest=" + str(work / "base"),
                                   str(work / "src") + os.sep, str(work / "dst") + os.sep], scratch)
            result["command"] = command
            if command["status"] != "pass":
                return result
            result.update(verify_link(base, destination, payload))
            result["destination_matched_attributes"] = all(result["destination"][key] == second[key] for key in attrs)
            if not result["destination_matched_attributes"]:
                result["status"] = "fail"
        else:
            source, destination = work / "source", work / "destination"
            source.write_bytes(payload)
            if kind == "os.link":
                os_link(source, destination)
            else:
                command = run_command([str(tool), "--coreutils-prog=ln", str(source), str(destination)], scratch)
                result["command"] = command
                if command["status"] != "pass":
                    return result
            result.update(verify_link(source, destination, payload))
    except (OSError, ValueError) as ex:
        result.update(failure(ex))
        result["status"] = "fail"
    except AttributeError as ex:
        # 解释器缺某个 API（如 bionic 的 os.link 且 ctypes 也调不通）时，
        # 一句 capability 说明比整份报告崩掉有用得多
        result.update(failure(ex))
        result["status"] = "fail"
    return result


def python_probe(root, scratch, default):
    executable = shutil.which("python3") if default else str(root / "bin/python3")
    if default and executable is None:
        return {"status": "skip", "reason": "python3 absent from inherited PATH", "PATH": os.environ.get("PATH", "")}
    if not default:
        availability = installed(Path(executable))
        if availability["status"] != "pass":
            return availability
    # Bare python3 is intentional: exercise the real default command, never kxxy-py.
    result = run_command(["python3" if default else executable, "-I", "-B", "-c",
                          PYTHON_CAPABILITIES if default else SELF_INFO], scratch, timeout=120)
    result["resolved_command"] = executable
    result["PATH"] = os.environ.get("PATH", "")
    result["runtime_info"] = []
    for line in result["stdout"].splitlines():
        try:
            result["runtime_info"].append(json.loads(line))
        except ValueError:
            pass
    expected = 2 if default else 1
    if result["status"] == "pass" and len(result["runtime_info"]) != expected:
        result["status"] = "fail"
        result["reason"] = "runtime information or numerical result missing from successful command output"
    return result


def classify_perf(result, record):
    combined = result["stdout"] + "\n" + result["stderr"]
    result["no_counters"] = bool(re.search(r"没有可用计数器|一个计数器都没开起来|没有可用采样事件|<not supported>|<not counted>", combined))
    result["samples"] = None
    result["zero_samples"] = False
    if record:
        match = re.search(r"perf record:\s*(\d+)\s*个样本", combined)
        if match:
            result["samples"] = int(match[1])
            result["zero_samples"] = result["samples"] == 0
        result["usable_measurement"] = result["code"] == 0 and result["samples"] is not None and result["samples"] > 0
    else:
        result["usable_measurement"] = result["code"] == 0 and "Performance counter stats" in combined and not result["no_counters"]
    if not result["usable_measurement"]:
        result["status"] = "fail"
    return result


def perf_probe(root, scratch, record, load):
    tool = root / "bin/perf"
    availability = installed(tool)
    if availability["status"] != "pass":
        return availability
    name = ("record" if record else "stat") + ("-load" if load else "-true")
    output = scratch / (name + ".data")
    command = [str(tool), "record", "-o", str(output) if load else os.devnull] if record else [str(tool), "stat"]
    target = scratch / (name + ".json")
    if load:
        program = scratch / "cpu-load.py"
        if not program.exists():
            program.write_text(CPU_LOAD, encoding="utf-8")
        child = [sys.executable, "-I", "-B", str(program), str(target)]
    else:
        child = ["true"]
    result = classify_perf(run_command(command + ["--"] + child, scratch), record)
    if record and not load and result["code"] == 0 and result["zero_samples"]:
        result["status"] = "skip"
        result["reason"] = "short true zero samples; access not proven by samples; load determines capability"
    result["workload"] = "2-second native Python CPU load" if load else "original true (may legitimately finish before any sample)"
    if load:
        result["workload_output_exists"] = target.is_file()
        if target.is_file():
            result["workload_output"] = target.read_text(encoding="utf-8")
        if not result["workload_output_exists"]:
            result["status"] = "fail"
    return result


def office_probe(root, scratch):
    """Informational: which document engine office_convert/office_render actually uses.

    Runs the Kit's own `capabilities --json`, so the answer comes from the package that
    performs the conversion instead of a second opinion. Android ships the WASM engine
    only (no soffice, and the native engine package needs a glibc userland), so
    `backend: wasm` is the declared configuration, not a silent degradation — that is
    what keeps "render differs from desktop Word" from being re-filed as a defect.
    Never fails the report: office is optional.
    """
    node = root / "bin/node"
    cli = root / "lib/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js"
    if not node.is_file():
        return {"status": "skip", "reason": "runtime node not installed", "node": str(node)}
    if not cli.is_file():
        return {"status": "skip", "reason": "libreoffice-kit not installed", "kit": str(cli)}
    run = run_command([str(node), str(cli), "capabilities", "--json"], scratch, timeout=120)
    result = {"status": "pass", "argv": run.get("argv"), "code": run.get("code"),
              "elapsed_seconds": run.get("elapsed_seconds")}
    payload = None
    for line in reversed(run["stdout"].splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line)
                break
            except ValueError:
                continue
    if payload is None:
        result.update(status="skip", reason="capabilities --json produced no JSON",
                      stdout=run["stdout"][-400:], stderr=run["stderr"][-400:])
        return result
    runtime = payload.get("runtime") or {}
    result.update(kitVersion=runtime.get("version"), backend=runtime.get("backend"),
                  nativePreview=runtime.get("nativePreview"), cliPath=runtime.get("cliPath"),
                  conversions=payload.get("conversions"), pdfBackend=(payload.get("imageRendering") or {}).get("pdfBackend"))
    result["native"] = result["backend"] == "native"
    result["note"] = ("native LibreOffice engine is in use" if result["native"]
                      else "WASM engine: conversion works, desktop-exact layout is not guaranteed")
    return result


def collect(root, scratch):
    checks = {"process": process_info(), "selinux_context": read_metadata("/proc/self/attr/current"),
              "perf_event_paranoid": read_metadata("/proc/sys/kernel/perf_event_paranoid")}
    for kind in ("os.link", "ln", "rsync"):
        checks[kind] = link_probe(root, scratch, kind)
    checks["default_python"] = python_probe(root, scratch, True)
    checks["native_python3"] = python_probe(root, scratch, False)
    try:
        checks["office_engine"] = office_probe(root, scratch)
    except (OSError, ValueError) as ex:
        checks["office_engine"] = {"status": "skip", **failure(ex)}
    for record in (False, True):
        for load in (False, True):
            name = "perf_" + ("record" if record else "stat") + ("_load" if load else "_true")
            try:
                checks[name] = perf_probe(root, scratch, record, load)
            except (OSError, ValueError) as ex:
                checks[name] = {"status": "fail", **failure(ex)}
    return checks


def probe(root, scratch_parent):
    report = {"schema": 1, "root": str(root), "scratch_parent": str(scratch_parent),
              "PATH": os.environ.get("PATH", ""), "checks": {},
              "notes": ["Manual probe only; no root/su, policy changes, provisioning, or secret reads.",
                        "Inherited PATH/environment are unchanged; wrappers may apply their normal runtime environment.",
                        "A zero-sample true run is not proof of a denied counter; inspect load and syscall diagnostics.",
                        "office_engine is informational and never required: Android ships the WASM document engine."]}
    scratch = None
    try:
        scratch = Path(tempfile.mkdtemp(prefix="kxxy-capabilities-", dir=str(scratch_parent)))
        report["scratch"] = str(scratch)
        report["checks"] = collect(root, scratch)
    except (OSError, ValueError) as ex:
        report["checks"]["probe_setup_or_execution"] = {"status": "fail", **failure(ex)}
    finally:
        if scratch is not None:
            try:
                shutil.rmtree(scratch)
                removed = not scratch.exists()
                report["checks"]["scratch_cleanup"] = {"status": "pass" if removed else "fail", "removed": removed}
            except OSError as ex:
                report["checks"]["scratch_cleanup"] = {"status": "fail", **failure(ex)}
    statuses = [check["status"] for check in report["checks"].values()]
    required = ("os.link", "ln", "rsync", "default_python", "native_python3",
                "perf_stat_true", "perf_stat_load", "perf_record_load")
    report["unverified_required_checks"] = [name for name in required
                                            if report["checks"].get(name, {}).get("status") not in ("pass", "fail")]
    report["status"] = "fail" if "fail" in statuses else "unverified" if report["unverified_required_checks"] else "pass"
    report["counts"] = {status: statuses.count(status) for status in ("pass", "fail", "skip")}
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--scratch-parent", type=Path, required=True)
    args = parser.parse_args(argv)
    report = probe(args.root.absolute(), args.scratch_parent.absolute())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
