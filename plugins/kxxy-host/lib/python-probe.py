"""引擎 Python 的只读功能探针，由 python-selftest.mjs 用 -I -B 调用。

只计算内存中的固定样本、读取本进程和已安装包元数据。pip check 由 Node 另起
同一解释器并限时，不能放在这里起孙进程（外层超时后孙进程可能还在跑）。
输出是一份有界 JSON；单个模块失败不能把其它功能的证据一起丢掉。
"""

import contextlib
import importlib
import importlib.metadata as metadata
import io
import json
import os
import platform
import sys
import sysconfig


TEXT_LIMIT = 1024
TAG_LIMIT = 64
WHEEL_TAG_LIMIT = 16
MODULE_NAMES = ("cffi", "_cffi_backend", "pycparser", "cryptography", "numpy", "psutil", "pip")
DIST_NAMES = ("cffi", "pycparser", "cryptography", "numpy", "psutil", "pip")


def short(value, limit=TEXT_LIMIT):
    text = str(value)
    return text if len(text) <= limit else text[: limit - 7] + "…（已截断）"


def error_text(error):
    return short(type(error).__name__ + ": " + str(error))


class BoundedLog(io.TextIOBase):
    """模块 import 的提示不是协议；收进诊断字段，不能无限占内存。"""

    def __init__(self, limit=2048):
        super().__init__()
        self.limit = limit
        self.text = ""
        self.truncated = False

    def write(self, text):
        room = max(0, self.limit - len(self.text))
        self.text += text[:room]
        self.truncated |= len(text) > room
        return len(text)

    def flush(self):
        pass

    def value(self):
        return self.text + ("…（已截断）" if self.truncated else "")


def readonly_audit(event, args):
    """阻止 Python 层意外写盘/联网/起进程；这不是原生代码的 OS 沙箱。"""
    if event == "open":
        mode, flags = args[1], args[2]
        write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
        if (isinstance(mode, str) and any(letter in mode for letter in "wax+")) or (
            isinstance(flags, int) and flags & write_flags
        ):
            raise PermissionError("read-only Python probe: file write blocked")
    if event.startswith(("socket.", "subprocess.", "os.exec", "os.spawn")) or event in {
        "os.system", "os.posix_spawn", "os.fork", "os.forkpty", "os.remove", "os.rename",
        "os.rmdir", "os.mkdir", "os.link", "os.symlink", "os.chmod", "os.chown",
        "os.truncate", "os.utime", "os.setxattr", "os.removexattr", "shutil.copyfile",
    }:
        raise PermissionError("read-only Python probe: " + event + " blocked")


def runtime_info(executable):
    try:
        same_executable = os.path.samefile(sys.executable, executable)
    except (OSError, ValueError):
        same_executable = False
    return {
        "version": platform.python_version(),
        "executable": sys.executable,
        "requestedExecutable": executable,
        "sameExecutable": same_executable,
        "prefix": sys.prefix,
        "basePrefix": sys.base_prefix,
        "platform": sys.platform,
        "sysconfigPlatform": sysconfig.get_platform(),
        "machine": platform.machine(),
        "soabi": sysconfig.get_config_var("SOABI"),
        "isolated": bool(sys.flags.isolated),
        "dontWriteBytecode": bool(sys.dont_write_bytecode),
    }


def collect_modules():
    modules, records = {}, {}
    for name in MODULE_NAMES:
        try:
            module = importlib.import_module(name)
            modules[name] = module
            version = getattr(module, "__version__", None)
            records[name] = {
                "ok": True,
                "path": short(module.__file__) if getattr(module, "__file__", None) else None,
                "version": short(version, 128) if version is not None else None,
            }
        except Exception as error:
            records[name] = {"ok": False, "path": None, "version": None, "error": error_text(error)}
    return modules, records


def need(modules, name):
    if name not in modules:
        raise ImportError(name + " 未能导入（见模块诊断）")
    return modules[name]


def check_cffi(modules):
    cffi = need(modules, "cffi")
    need(modules, "_cffi_backend")
    need(modules, "pycparser")
    ffi = cffi.FFI()
    # cdef 真正经过声明解析器；只 import cffi 抓不到缺 pycparser 或后端的情况。
    ffi.cdef("typedef struct { int value; unsigned char data[4]; } kxxy_probe;")
    value = ffi.new("kxxy_probe *", {"value": 23, "data": [1, 2, 3, 4]})
    data = ffi.new("unsigned char[]", b"kxxy")
    if value.value != 23 or bytes(ffi.buffer(value.data, 4)) != b"\x01\x02\x03\x04":
        raise AssertionError("FFI struct/new/buffer mismatch")
    data[0] = ord("K")
    if bytes(ffi.buffer(data, 4)) != b"Kxxy":
        raise AssertionError("FFI buffer roundtrip mismatch")
    return "FFI cdef/new/buffer 读写通过（结构体大小 " + str(ffi.sizeof("kxxy_probe")) + "）"


def check_aesgcm(modules):
    need(modules, "cryptography")
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    # 固定的公开测试样本，不是生产密钥；只在内存中 roundtrip，不需要随机数或网络。
    cipher = AESGCM(bytes(range(32)))
    nonce, aad, plain = bytes(range(12)), b"kxxy-selftest-aad", b"kxxy-python-aesgcm"
    encrypted = cipher.encrypt(nonce, plain, aad)
    if cipher.decrypt(nonce, encrypted, aad) != plain:
        raise AssertionError("AES-GCM plaintext mismatch")
    tampered = encrypted[:-1] + bytes([encrypted[-1] ^ 1])
    try:
        cipher.decrypt(nonce, tampered, aad)
    except InvalidTag:
        return "AES-GCM roundtrip 通过；篡改密文按预期抛 InvalidTag"
    raise AssertionError("AES-GCM accepted tampered ciphertext")


def check_openssl(modules):
    need(modules, "cryptography")
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import hashes

    backend = default_backend()
    version, number = backend.openssl_version_text(), backend.openssl_version_number()
    if not version or not isinstance(number, int) or number <= 0 or not backend.hash_supported(hashes.SHA256()):
        raise AssertionError("OpenSSL backend initialization failed")
    digest = hashes.Hash(hashes.SHA256())
    digest.update(b"abc")
    if digest.finalize().hex() != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad":
        raise AssertionError("OpenSSL SHA-256 mismatch")
    return "OpenSSL 后端初始化与 SHA-256 通过：" + short(version, 256)


def check_numpy(modules):
    np = need(modules, "numpy")
    vector = np.array([1.0, 2.0, 3.0], dtype=np.float64)
    if not np.array_equal(vector * 2 + 1, [3.0, 5.0, 7.0]) or float(np.dot(vector, vector)) != 14.0:
        raise AssertionError("NumPy vector/dot mismatch")
    matrix = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float64)
    product = matrix @ np.array([[5.0, 6.0], [7.0, 8.0]], dtype=np.float64)
    if not np.array_equal(product, [[19.0, 22.0], [43.0, 50.0]]):
        raise AssertionError("NumPy matrix multiplication mismatch")
    solved = np.linalg.solve(np.array([[3.0, 1.0], [1.0, 2.0]]), np.array([9.0, 8.0]))
    if not np.allclose(solved, [2.0, 3.0], rtol=0, atol=1e-12):
        raise AssertionError("NumPy linear solve mismatch")
    return "NumPy 向量/dot=14、矩阵乘法=[[19,22],[43,50]]、线性方程解=[2,3] 通过"


def check_psutil(modules):
    psutil = need(modules, "psutil")
    pid = os.getpid()
    process = psutil.Process(pid)
    rss = process.memory_info().rss
    if process.pid != pid or not isinstance(rss, int) or rss <= 0:
        raise AssertionError("psutil self pid/rss invalid")
    return "psutil 读取本进程通过：pid=" + str(pid) + "；rss=" + str(rss) + " bytes"


def collect_checks(modules):
    checks = {}
    for name, operation in (
        ("cffi", check_cffi), ("aesgcm", check_aesgcm), ("openssl", check_openssl),
        ("numpy", check_numpy), ("psutil", check_psutil),
    ):
        try:
            checks[name] = {"ok": True, "detail": short(operation(modules))}
        except Exception as error:
            checks[name] = {"ok": False, "detail": error_text(error)}
    return checks


def collect_packaging():
    result = {
        "ok": False, "source": "pip._internal.utils.compatibility_tags.get_supported",
        "supportedTags": [], "supportedTagCount": 0, "supportedTagsTruncated": False, "wheels": {},
    }
    supported, parse_tag = [], None
    try:
        # 必须用 pip 自己的判定集合，不能用手造标签或另一个 packaging 版本代替。
        from pip._internal.utils.compatibility_tags import get_supported
        from pip._vendor.packaging.tags import parse_tag

        supported = get_supported()
        if not supported:
            raise ValueError("pip returned no supported tags")
        result.update({
            "supportedTags": [str(tag) for tag in supported[:TAG_LIMIT]],
            "supportedTagCount": len(supported),
            "supportedTagsTruncated": len(supported) > TAG_LIMIT,
        })
    except Exception as error:
        result["error"] = error_text(error)
    supported_set = set(supported)
    android_pairs = {}
    for tag in supported:
        parts = tag.platform.split("_")
        if len(parts) == 4 and parts[0] == "android" and parts[1].isdigit() and parts[2:] == ["arm64", "v8a"]:
            android_pairs.setdefault((tag.interpreter, tag.abi), str(tag))
    for name in DIST_NAMES:
        wheel = {"ok": False, "tags": [], "tagCount": 0, "tagsTruncated": False}
        result["wheels"][name] = wheel
        try:
            dist = metadata.distribution(name)
            content = dist.read_text("WHEEL")
            if content is not None and len(content) > 65536:
                raise ValueError("WHEEL metadata exceeds 64 KiB")
            tags = [line.partition(":")[2].strip() for line in (content or "").splitlines()
                    if line.partition(":")[0].lower() == "tag"]
            parsed = set()
            if parse_tag is not None:
                for tag in tags:
                    parsed.update(parse_tag(tag))
            matches = []
            for tag in tags:
                parts = tag.split("-")
                if len(parts) == 3 and parts[2] == "android_aarch64":
                    match = android_pairs.get((parts[0], parts[1]))
                    if match:
                        matches.append({"wheel": tag, "supported": match})
            wheel.update({
                "ok": True,
                "version": short(dist.version, 128),
                "location": short(getattr(dist, "_path", dist.locate_file(""))),
                "hasWheel": content is not None,
                "tags": tags[:WHEEL_TAG_LIMIT], "tagCount": len(tags),
                "tagsTruncated": len(tags) > WHEEL_TAG_LIMIT,
                "supported": bool(parsed & supported_set),
                "legacyPlatformOnly": bool(tags) and not (parsed & supported_set) and len(matches) == len(tags),
                "legacyMatches": matches[:WHEEL_TAG_LIMIT],
            })
        except Exception as error:
            wheel["error"] = error_text(error)
    result["ok"] = "error" not in result and all(wheel["ok"] for wheel in result["wheels"].values())
    return result


def main():
    # 在任何第三方 import 前加保护；-B 保证 import 本身不尝试生成 pyc。
    sys.addaudithook(readonly_audit)
    log = BoundedLog()
    with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
        runtime = runtime_info(sys.argv[1] if len(sys.argv) == 2 else "")
        modules, records = collect_modules()
        checks = collect_checks(modules)
        packaging = collect_packaging()
    result = {
        "kind": "kxxy-python-selftest", "schema": 1, "runtime": runtime,
        "modules": records, "checks": checks, "packaging": packaging, "diagnostics": log.value(),
    }
    # ensure_ascii 也让 Android 的 locale / 终端编码不能破坏 JSON 协议。
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
