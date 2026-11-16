#!/usr/bin/env python3
"""只读验证 APK 中的 DSH 升级资产；用宿主 Python -I 运行，不执行 Android 代码。

用法：python -I -X utf8 tools/verify-dsh-apk.py APK RUNTIME [--project PROJECT] [--report REPORT]
--project 默认是本脚本所属项目；--report 仅以独占创建方式写入成功报告，不覆盖已有文件。
"""
import argparse
import binascii
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import zipfile
import zlib

FROM, TO = "0.2.1-rc.5", "0.2.2-rc.2"
SCHEMA = "kxxy-dsh-upgrade@1"
ROOT = "kxxy-runtime.json"
NM = "lib/node_modules/"
HOST = NM + "kxxy-host/"
FP = HOST + "lib/.fingerprint"
CORE = ("@deepseek-ai/dsh", "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app")
MAX_META, MAX_MANIFEST = 128 * 1024, 16 * 1024 * 1024
MAX_PAYLOAD, MAX_FILE, MAX_TOTAL = 512 * 1024 * 1024, 128 * 1024 * 1024, 1024 * 1024 * 1024
MAX_RECORDS, MAX_ENTRIES, MAX_CENTRAL = 40000, 200000, 64 * 1024 * 1024
MAX_ARCHIVE, CHUNK = 0xffffffff - 1, 64 * 1024


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def valid_hash(value, label):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{64}", value), f"{label}：SHA-256 格式无效")
    return value.lower()


def integer(value, low, high, label):
    require(type(value) is int and low <= value <= high, f"{label}：整数或大小超出上限")
    return value


def decimal(text, high, label):
    require(re.fullmatch(r"0|[1-9][0-9]*", text), f"{label}：必须使用规范非负十进制整数")
    require(len(text) <= 19, f"{label}：大小整数溢出")
    return integer(int(text), 0, high, label)


def strict_json(data, label):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, f"{label}：JSON 重复字段 {key}")
            result[key] = value
        return result

    def constant(value):
        raise ValueError(f"{label}：JSON 非法常量 {value}")

    result = json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    require(type(result) is dict, f"{label}：必须为单个 JSON 对象")
    nodes = 0

    def visit(value, depth):
        nonlocal nodes
        nodes += 1
        require(depth <= 16 and nodes <= 20000, f"{label}：JSON 结构超出上限")
        if isinstance(value, float):
            require(math.isfinite(value), f"{label}：JSON 数字溢出")
        if isinstance(value, (dict, list)):
            for child in value.values() if isinstance(value, dict) else value:
                visit(child, depth + 1)

    visit(result, 0)
    return result


def metadata(data):
    meta = strict_json(data, "metadata")
    require(type(meta.get("schema")) is int and meta["schema"] == 1 and meta.get("dshVersion") == TO and meta.get("dshPreviousVersion") == FROM,
            "metadata：DSH schema/目标版本/起始版本不符")
    for key in ("runtimeSha256", "dshUpgradeManifestSha256", "kxxyHostFingerprint"):
        meta[key] = valid_hash(meta.get(key), f"metadata {key}")
    integer(meta.get("runtimeSize"), 22, MAX_ARCHIVE, "metadata runtimeSize")
    integer(meta.get("runtimeEntries"), 1, MAX_ENTRIES, "metadata runtimeEntries")
    integer(meta.get("runtimeUncompressedBytes"), 0, 2**53 - 1, "metadata runtimeUncompressedBytes")
    return meta


def path_parts(path):
    parts = path.split("/")
    require(1 <= len(path) <= 1024 and all(1 <= len(p) <= 255 and p not in (".", "..") and not p.endswith(".")
            and re.fullmatch(r"[A-Za-z0-9_+@.\-]+", p) and not re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", p.split(".")[0], re.I)
            for p in parts), f"manifest：非法路径 {path}")
    if path != ROOT:
        package = r"[A-Za-z0-9][A-Za-z0-9_.\-]*"
        require(len(parts) >= 4 and parts[:2] == ["lib", "node_modules"], f"manifest：路径越出包文件白名单 {path}")
        require((len(parts) >= 5 and re.fullmatch(package, parts[2][1:]) and re.fullmatch(package, parts[3]))
                if parts[2].startswith("@") else re.fullmatch(package, parts[2]), f"manifest：非法包名 {path}")
    return parts


def parse_manifest(data, meta):
    require(len(data) <= MAX_MANIFEST and sha(data) == meta["dshUpgradeManifestSha256"], "manifest：大小超限或与可信 metadata SHA 不符")
    text = data.decode("utf-8")
    require(text.endswith("\n") and "\r" not in text, "manifest：必须为 UTF-8/LF 且以单个换行结尾")
    lines = text[:-1].split("\n")
    require(len(lines) >= 7 and lines[0] == SCHEMA, "manifest：schema/头不符")
    headers = {}
    for pos, key in enumerate(("from", "to", "base-host", "host", "payload-sha256", "payload-size"), 1):
        fields = lines[pos].split("\t")
        require(len(fields) == 2 and fields[0] == key, f"manifest：头缺失、重复或顺序错误 {key}")
        headers[key] = fields[1]
    require(headers["from"] == FROM and headers["to"] == TO, "manifest：升级版本不符")
    base, host = valid_hash(headers["base-host"], "base-host"), valid_hash(headers["host"], "host")
    require(host == meta["kxxyHostFingerprint"], "manifest：目标宿主与 metadata 不符")
    payload_sha = valid_hash(headers["payload-sha256"], "payload-sha256")
    payload_size = decimal(headers["payload-size"], MAX_PAYLOAD, "payload-size")
    require(payload_size >= 22 and len(lines) - 7 <= MAX_RECORDS, "manifest：payload 太短或记录数超限")
    records, names, spellings, total = [], set(), {}, 0
    for line in lines[7:]:
        fields = line.split("\t")
        require(len(fields) == 6 and fields[0] in ("file", "delete"), "manifest：记录必须恰好六列，不允许空行或尾部垃圾")
        kind, path, size_text, mode_text, target, previous_text = fields
        parts = path_parts(path)
        lower = path.lower()
        require(lower not in names, f"manifest：路径重复 {path}")
        names.add(lower)
        for index in range(1, len(parts) + 1):
            prefix = "/".join(parts[:index])
            require(spellings.get(prefix.lower(), prefix) == prefix, f"manifest：大小写别名 {path}")
            spellings[prefix.lower()] = prefix
        size = decimal(size_text, MAX_FILE, f"size {path}")
        require(mode_text in ("420", "493"), f"manifest：非法 mode {path}")
        target_sha = valid_hash(target, f"target {path}") if kind == "file" else None
        require(kind != "delete" or target == "-", f"manifest：delete 不允许目标 SHA {path}")
        previous = [] if previous_text == "-" else [valid_hash(v, f"previous {path}") for v in previous_text.split(",")]
        require(len(previous) == len(set(previous)) and (kind == "file" or previous), f"manifest：previous 重复或 delete 缺少旧 SHA {path}")
        total += size if kind == "file" else 0
        require(total <= MAX_TOTAL and (path != FP or size <= 4096), "manifest：总解压大小或指纹文件超出上限")
        records.append({"kind": kind, "path": path, "size": size, "mode": int(mode_text), "sha256": target_sha, "previous": previous})
    by_path = {r["path"]: r for r in records}
    for record in records:
        parts = record["path"].split("/")
        require(all("/".join(parts[:i]).lower() not in names for i in range(1, len(parts))), f"manifest：文件与父目录重叠 {record['path']}")
    require(all(by_path.get(p, {}).get("kind") == "file" for p in (ROOT, FP)), "manifest：缺少根清单或目标宿主指纹记录")
    require(base == host or by_path[FP]["previous"], "manifest：跨宿主升级必须声明指纹文件 previous")
    files = [r for r in records if r["kind"] == "file"]
    require(len(files) <= MAX_RECORDS, "payload：增量 ZIP 不得超过 40000 条文件记录")
    return {"from": headers["from"], "to": headers["to"], "baseHost": base, "host": host,
            "payloadSha256": payload_sha, "payloadSize": payload_size, "records": records,
            "files": files, "spellings": spellings, "unpackedBytes": total}


def local_size(path, limit, low=0):
    require(path.is_file() and not path.is_symlink(), f"输入必须为普通文件：{path}")
    return integer(path.stat().st_size, low, limit, f"输入 {path}")


def read_small(path, limit):
    size = local_size(path, limit)
    with path.open("rb") as source:
        data = source.read(limit + 1)
    require(len(data) == size, f"输入读取期间长度变化：{path}")
    return data


def stream_digest(source, limit, capture=False):
    digest, size, chunks = hashlib.sha256(), 0, []
    while True:
        data = source.read(CHUNK)
        if not data:
            break
        size += len(data)
        require(size <= limit, "流式读取超过声明的大小上限")
        digest.update(data)
        if capture:
            chunks.append(data)
    return {"size": size, "sha256": digest.hexdigest(), **({"data": b"".join(chunks)} if capture else {})}


def file_digest(path, limit, low=22):
    size = local_size(path, limit, low)
    with path.open("rb") as source:
        before = os.fstat(source.fileno())
        result = stream_digest(source, size)
        after = os.fstat(source.fileno())
    require(result["size"] == size and before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns, f"输入读取期间变化：{path}")
    return result


def read_at(source, length, offset, count):
    require(offset >= 0 and count >= 0 and offset + count <= length, "ZIP：记录越界")
    source.seek(offset)
    data = source.read(count)
    require(len(data) == count, "ZIP：记录截断")
    return data


def u16(data, offset):
    return struct.unpack_from("<H", data, offset)[0]


def u32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]


def u64(data, offset):
    return struct.unpack_from("<Q", data, offset)[0]


def zip_directory(source, length, role):
    integer(length, 22, MAX_PAYLOAD if role == "payload" else MAX_ARCHIVE, "ZIP 归档大小")
    start = max(0, length - 65557)
    tail = read_at(source, length, start, length - start)
    end = next((i for i in range(len(tail) - 22, -1, -1) if u32(tail, i) == 0x06054b50 and i + 22 + u16(tail, i + 20) == len(tail)), -1)
    require(end >= 0, "ZIP：缺少合法 EOCD")
    count, cd_size, cd_offset = u16(tail, end + 10), u32(tail, end + 12), u32(tail, end + 16)
    require(not u16(tail, end + 4) and not u16(tail, end + 6) and u16(tail, end + 8) == count, "ZIP：分卷或卷内计数不一致")
    require(cd_size < 0xffffffff and cd_offset < 0xffffffff, "ZIP64：只允许 runtime 计数扩展，不允许大小或偏移扩展")
    directory_end = start + end
    zip64 = count == 0xffff
    if zip64:
        require(role == "runtime", "ZIP64：只允许完整 runtime 使用有界计数扩展")
        locator = read_at(source, length, directory_end - 20, 20)
        require(u32(locator, 0) == 0x07064b50 and u32(locator, 4) == 0 and u32(locator, 16) == 1, "ZIP64：locator 无效")
        offset = u64(locator, 8)
        require(offset < 0xffffffff and offset + 56 == directory_end - 20, "ZIP64：EOCD 偏移或长度无效")
        record = read_at(source, length, offset, 56)
        require(u32(record, 0) == 0x06064b50 and u64(record, 4) == 44 and u16(record, 14) == 45 and not u32(record, 16) and not u32(record, 20), "ZIP64：EOCD 头部无效")
        count = u64(record, 32)
        require(0xffff <= count <= MAX_ENTRIES and u64(record, 24) == count and u64(record, 40) == cd_size and u64(record, 48) == cd_offset, "ZIP64：计数越界或目录不一致")
        directory_end = offset
    limit = MAX_ENTRIES if role == "runtime" else (MAX_RECORDS if role == "payload" else 0xfffe)
    require(count <= limit and count * 46 <= cd_size <= MAX_CENTRAL and cd_offset + cd_size == directory_end and (count or cd_size == 0), "ZIP：中央目录计数/范围超限")
    return {"count": count, "offset": cd_offset, "size": cd_size, "zip64Count": zip64}


def check_extra(data, payload, zero_padding=False):
    """校验 extra 字段链。

    `zero_padding` 只对 APK 外层为真：zipalign 会把本地头 extra 补成纯零字节
    （常见形态是 `00 00 00 00` 之后接若干 0x00），Android 的 ZipFile 不解析
    extra，因此这是合法产物。真实 APK 上 135 个条目（classes*.dex、.so、
    assets/*）都因此被误判成「extra 截断」。payload/runtime 是我们自己写的
    归档，仍保持严格：不允许任何填充。
    """
    pos, seen = 0, set()
    while pos < len(data):
        tail = data[pos:]
        if zero_padding and not any(tail):
            return
        require(pos + 4 <= len(data), "ZIP：extra 截断")
        tag, size = u16(data, pos), u16(data, pos + 2)
        require(tag != 1 and pos + 4 + size <= len(data), "ZIP：逐文件 ZIP64 extra 或 extra 越界")
        if payload:
            require(tag not in seen and tag not in (0x000d, 0x756e, 0x7075), "payload：重复、链接或替代路径 extra")
        seen.add(tag)
        pos += 4 + size


@contextmanager
def opened_zip(path, role, manifest=None):
    length = local_size(path, MAX_PAYLOAD if role == "payload" else MAX_ARCHIVE, 22)
    with path.open("rb") as source:
        directory = zip_directory(source, length, role)
        with zipfile.ZipFile(source) as archive:
            infos = archive.infolist()
            require(len(infos) == directory["count"] and archive.start_dir == directory["offset"], "ZIP：zipfile 与原始中央目录计数/偏移不符")
            records = {r["path"]: r for r in manifest["files"]} if manifest else {}
            if role == "payload":
                require(len(infos) == len(records), "payload：条目数量不符")
            entries, spans = {}, []
            pos, central_end = directory["offset"], directory["offset"] + directory["size"]
            for info in infos:
                require(pos + 46 <= central_end, "ZIP：中央目录截断")
                head = read_at(source, length, pos, 46)
                require(u32(head, 0) == 0x02014b50, "ZIP：中央目录签名错误")
                nl, el, cl = u16(head, 28), u16(head, 30), u16(head, 32)
                require(nl > 0 and pos + 46 + nl + el + cl <= central_end, "ZIP：中央条目越界")
                raw_name = read_at(source, length, pos + 46, nl)
                flags, method, version = u16(head, 8), u16(head, 10), u16(head, 6)
                name = raw_name.decode("utf-8" if role != "apk" or flags & 0x800 else "cp437")
                require(name == info.filename == info.orig_filename and name not in entries, f"ZIP：名字重复或解码歧义 {name}")
                require(not name.startswith("/") and "\\" not in name and "\0" not in name and
                        all(p and p not in (".", "..") and ":" not in p for p in name.removesuffix("/").split("/")), f"ZIP：非法路径 {name}")
                size, csize, offset, crc = u32(head, 24), u32(head, 20), u32(head, 42), u32(head, 16)
                require(max(size, csize, offset) < 0xffffffff and not u16(head, 34) and offset + 30 <= directory["offset"], f"ZIP：逐文件 ZIP64、分卷或偏移越界 {name}")
                require(method in (0, 8) and not flags & 0x0041, f"ZIP：加密或不支持的压缩方法 {name}")
                if role != "apk":
                    require(10 <= version <= 20 and not flags & (0xf7f7 if role == "payload" else 0xf7ff), f"ZIP：版本或 flags 不符合 {role} 合同 {name}")
                extra = read_at(source, length, pos + 46 + nl, el)
                comment = read_at(source, length, pos + 46 + nl + el, cl)
                check_extra(extra, role == "payload", role == "apk")
                mode = u32(head, 38) >> 16
                if role == "payload":
                    record = records.get(name)
                    require(record is not None and nl <= 1024 and size == record["size"], f"payload：清单外路径或 size 不符 {name}")
                    require(u16(head, 4) >> 8 in (3, 19) and mode & 0o170000 == 0o100000 and mode & 0o7777 == record["mode"] and not u32(head, 38) & 16,
                            f"payload：不是约定的普通文件/mode {name}")
                    require(not comment.decode("utf-8").startswith("LINK:"), f"payload：禁止 LINK {name}")
                local = read_at(source, length, offset, 30)
                lnl, lel = u16(local, 26), u16(local, 28)
                require(u32(local, 0) == 0x04034b50 and u16(local, 4) == version and u16(local, 6) == flags and u16(local, 8) == method and lnl == nl and read_at(source, length, offset + 30, lnl) == raw_name,
                        f"ZIP：本地/中央头不一致 {name}")
                check_extra(read_at(source, length, offset + 30 + lnl, lel), role == "payload", role == "apk")
                data_offset = offset + 30 + lnl + lel
                end = data_offset + csize
                if flags & 8:
                    if role == "payload":
                        require(method == 8 and not u32(local, 14) and not u32(local, 18) and not u32(local, 22), f"payload：descriptor 本地字段错误 {name}")
                    if u32(read_at(source, length, end, 4), 0) == 0x08074b50:
                        end += 4
                    descriptor = read_at(source, length, end, 12)
                    require((u32(descriptor, 0), u32(descriptor, 4), u32(descriptor, 8)) == (crc, csize, size), f"ZIP：descriptor 不一致 {name}")
                    end += 12
                else:
                    require((u32(local, 14), u32(local, 18), u32(local, 22)) == (crc, csize, size), f"ZIP：本地大小/CRC 不一致 {name}")
                require(end <= directory["offset"] and (method != 0 or csize == size), f"ZIP：数据范围无效 {name}")
                entries[name] = {"info": info, "name": name, "size": size, "csize": csize, "crc": crc,
                                 "mode": mode, "comment": comment, "method": method, "dataOffset": data_offset}
                spans.append((offset, end))
                pos += 46 + nl + el + cl
            require(pos == central_end, "ZIP：中央目录存在额外记录")
            if role != "apk":
                cursor = 0
                for start, end in sorted(spans):
                    require(start == cursor, "ZIP：本地记录存在间隙、重叠或隐藏数据")
                    cursor = end
                require(cursor == directory["offset"], "ZIP：存在未声明本地数据")
            yield archive, entries, directory, length


# zipfile 会按中央目录 file_size 截断返回值；另核验完整 DEFLATE，防止额外解压数据或尾部垃圾被忽略。
def check_deflate(archive, entry, length):
    if entry["method"] != 8:
        return
    inflater, size, crc = zlib.decompressobj(-15), 0, 0
    remaining, pos = entry["csize"], entry["dataOffset"]

    def consume(data):
        nonlocal size, crc
        size += len(data)
        require(size <= entry["size"], f"ZIP：实际解压大小超限 {entry['name']}")
        crc = binascii.crc32(data, crc)

    while remaining:
        count = min(CHUNK, remaining)
        pending = read_at(archive.fp, length, pos, count)
        pos += count
        remaining -= count
        require(not inflater.eof, f"ZIP：DEFLATE 后存在未消费数据 {entry['name']}")
        while pending:
            data = inflater.decompress(pending, CHUNK)
            consume(data)
            require(not inflater.unused_data, f"ZIP：DEFLATE 后存在未消费数据 {entry['name']}")
            pending = inflater.unconsumed_tail
    while not inflater.eof:
        data = inflater.decompress(b"", CHUNK)
        if not data:
            break
        consume(data)
    require(inflater.eof and not inflater.unused_data and size == entry["size"] and crc == entry["crc"], f"ZIP：DEFLATE 实际大小/CRC 或结束状态不符 {entry['name']}")


def entry_digest(bundle, name, limit, capture=False):
    archive, entries, _, length = bundle
    entry = entries.get(name)
    require(entry is not None and not name.endswith("/") and entry["size"] <= limit, f"ZIP：条目缺失或超出上限 {name}")
    check_deflate(archive, entry, length)
    with archive.open(entry["info"]) as source:
        result = stream_digest(source, entry["size"], capture)
    require(result["size"] == entry["size"], f"ZIP：实际条目大小不符 {name}")
    return result


def regular(bundle, name, mode=None):
    entry = bundle[1].get(name)
    require(entry is not None and not name.endswith("/") and entry["mode"] & 0o170000 == 0o100000 and not entry["comment"].startswith(b"LINK:") and
            (mode is None or entry["mode"] & 0o7777 == mode), f"runtime：缺少普通文件、存在 LINK 或 mode 不符 {name}")
    return entry


def runtime_small(bundle, name, limit=MAX_MANIFEST):
    regular(bundle, name)
    return entry_digest(bundle, name, limit, True)["data"]


def verify_runtime(bundle, manifest, meta):
    entries = bundle[1]
    require(len(entries) == meta["runtimeEntries"] and sum(e["size"] for e in entries.values()) == meta["runtimeUncompressedBytes"], "runtime：目录计数/未压缩大小与 metadata 不符")
    managed = {r["path"].lower(): r for r in manifest["records"]}
    for name in entries:
        parts = name.removesuffix("/").split("/")
        for index in range(1, len(parts) + 1):
            prefix = "/".join(parts[:index])
            expected = manifest["spellings"].get(prefix.lower())
            require(expected is None or prefix == expected, f"runtime：受管路径大小写别名 {name}")
            record = managed.get(prefix.lower())
            if record:
                require(record["kind"] == "file" and not name.endswith("/") and index == len(parts), f"runtime：delete 未缺失或受管文件成为父目录 {name}")
            if not name.endswith("/") and index == len(parts):
                require(expected is None or record is not None, f"runtime：受管父路径不是目录 {name}")
    core_versions = {}
    for package in CORE:
        value = strict_json(runtime_small(bundle, NM + package + "/package.json", 1024 * 1024), package)
        require(value.get("name") == package and value.get("version") == TO, f"runtime：官方核心版本不符 {package}")
        core_versions[package] = value["version"]
    rows, index_text = [], None
    for name in entries:
        if not name.startswith(HOST) or name.endswith("/") or name == FP:
            continue
        regular(bundle, name)
        is_index = name == HOST + "lib/index.js"
        actual = entry_digest(bundle, name, MAX_FILE, is_index)
        if is_index:
            index_text = actual["data"].decode("utf-8")
            actual["sha256"] = sha(re.sub(r"^/\* kxxy-host@[^\n]*?\*/\r?\n", "", index_text, count=1).encode("utf-8"))
        rows.append(name[len(HOST):] + "\0" + actual["sha256"])
    require(rows and index_text is not None, "runtime：宿主树或入口缺失")
    host_hash = sha("\n".join(sorted(rows)).encode("utf-8"))
    marker = "kxxy-host@" + host_hash[:12]
    fp_text = runtime_small(bundle, FP, 4096).decode("utf-8")

    def field(key):
        matches = [line[len(key) + 1:].strip() for line in fp_text.splitlines() if line.startswith(key + ":")]
        require(len(matches) == 1, f"runtime：宿主指纹字段缺失或重复 {key}")
        return matches[0]

    require(host_hash == manifest["host"] and valid_hash(field("fingerprint"), "fingerprint") == host_hash and field("algorithm") == "sha256" and
            decimal(field("files"), MAX_ENTRIES, "host files") == len(rows) and field("marker") == marker and index_text.startswith(f"/* {marker} */\n"), "runtime：H1 实际宿主内容、指纹文件或入口标记不符")
    root = strict_json(runtime_small(bundle, ROOT), "runtime root manifest")
    require(type(root.get("schemaVersion")) is int and root["schemaVersion"] > 0 and type(root.get("entries")) is int and root["entries"] == len(entries) and
            type(root.get("directories")) is int and root["directories"] == sum(n.endswith("/") for n in entries) and
            type(root.get("linkEntries")) is int and root["linkEntries"] == sum(e["comment"].startswith(b"LINK:") for e in entries.values()), "runtime：root manifest schema/条目/目录/LINK 计数不符")
    plugins = root.get("plugins", {})
    require(valid_hash(plugins.get("hostFingerprint"), "root host") == host_hash and plugins.get("hostMarker") == marker and meta.get("kxxyHostMarker") == marker, "runtime：root manifest/metadata 与 H1 不符")
    if "codexPluginFingerprint" in meta:
        require(valid_hash(plugins.get("codexFingerprint"), "root codex") == valid_hash(meta["codexPluginFingerprint"], "metadata codex"), "runtime：root Codex 指纹与 metadata 不符")
    if "pythonRuntimeRevision" in meta:
        require(root.get("pythonRuntimeRevision") == meta["pythonRuntimeRevision"], "runtime：root Python revision 与 metadata 不符")
    return core_versions, host_hash, len(rows)


def dex_strings(bundle, required):
    found = set()
    overlap = max(len(value) for value in required) - 1
    for name, entry in bundle[1].items():
        if not re.fullmatch(r"classes(?:[2-9]|[1-9][0-9]+)?\.dex", name):
            continue
        tail = b""
        with bundle[0].open(entry["info"]) as source:
            while True:
                data = source.read(CHUNK)
                if not data:
                    break
                block = tail + data
                found.update(value for value in required if value in block)
                tail = block[-overlap:]
    return found


def verify(apk_path, runtime_path, project):
    assets = project / "android/app/src/main/assets"
    source_meta = read_small(assets / "meta/build.json", MAX_META)
    meta = metadata(source_meta)
    source_manifest = read_small(assets / "dsh-upgrade/manifest.tsv", MAX_MANIFEST)
    manifest = parse_manifest(source_manifest, meta)
    payload_path = assets / "dsh-upgrade/payload.zip"
    source_payload = file_digest(payload_path, MAX_PAYLOAD)
    source_runtime = file_digest(runtime_path, MAX_ARCHIVE)
    require(source_payload["size"] == manifest["payloadSize"] and source_payload["sha256"] == manifest["payloadSha256"], "源 payload：size/SHA 与 manifest 不符")
    require(source_runtime["size"] == meta["runtimeSize"] and source_runtime["sha256"] == meta["runtimeSha256"], "外部 runtime：实际 size/SHA 与 metadata 不符")
    with opened_zip(apk_path, "apk") as apk:
        packaged_meta = entry_digest(apk, "assets/meta/build.json", MAX_META, True)
        require(packaged_meta["data"] == source_meta, "APK metadata 与项目源文件不同")
        inside_meta = metadata(packaged_meta["data"])
        packaged_manifest = entry_digest(apk, "assets/dsh-upgrade/manifest.tsv", MAX_MANIFEST, True)
        require(packaged_manifest["data"] == source_manifest, "APK manifest 与项目源文件不同")
        inside_manifest = parse_manifest(packaged_manifest["data"], inside_meta)
        upgrade_names = {n for n in apk[1] if n.startswith("assets/dsh-upgrade/") and not n.endswith("/")}
        require(upgrade_names == {"assets/dsh-upgrade/manifest.tsv", "assets/dsh-upgrade/payload.zip"}, "APK：dsh-upgrade 必须恰好包含双资产")
        packaged_payload = entry_digest(apk, "assets/dsh-upgrade/payload.zip", MAX_PAYLOAD)
        require(packaged_payload == source_payload, "APK payload 与项目源文件 size/SHA 不同")
        packaged_runtime = entry_digest(apk, "assets/runtime.zip", MAX_ARCHIVE)
        require(packaged_runtime == source_runtime, "APK runtime 与外部 runtime 实际 size/SHA 不同")
        require(inside_manifest["to"] == meta["dshVersion"] and inside_manifest["host"] == meta["kxxyHostFingerprint"], "APK：内外目标版本或宿主不符")
        descriptors = (b"Lapp/kxxy/engine/DshRuntimeUpgrade;", b"Lapp/kxxy/engine/RuntimeInstaller;")
        host_string = inside_manifest["host"].encode("ascii")
        found = dex_strings(apk, (*descriptors, host_string))
        require(all(value in found for value in descriptors), "APK：DEX 缺少 DSH helper 或 RuntimeInstaller 描述符")
        require(host_string in found, "APK：DEX 中未找到 metadata 目标宿主指纹字符串")
    with opened_zip(payload_path, "payload", manifest) as payload, opened_zip(runtime_path, "runtime") as runtime:
        for record in manifest["records"]:
            name = record["path"]
            if record["kind"] == "delete":
                require(name not in runtime[1], f"runtime：delete 未缺失 {name}")
                continue
            actual = entry_digest(payload, name, MAX_FILE)
            require(actual["size"] == record["size"] and actual["sha256"] == record["sha256"], f"payload：实际文件 SHA/size 不符 {name}")
            regular(runtime, name, record["mode"])
            full = entry_digest(runtime, name, MAX_FILE)
            require(full == actual, f"runtime：文件与 payload/manifest 不同 {name}")
        core_versions, host_hash, host_files = verify_runtime(runtime, manifest, meta)
        runtime_zip64 = runtime[2]["zip64Count"]
        runtime_entries = len(runtime[1])
        uncompressed = sum(e["size"] for e in runtime[1].values())
    apk_hash = file_digest(apk_path, MAX_ARCHIVE)
    return {
        "schema": 1, "apk": str(apk_path), "runtime": str(runtime_path), "project": str(project),
        "apkSha256": apk_hash["sha256"], "apkSize": apk_hash["size"],
        "from": inside_manifest["from"], "to": inside_manifest["to"], "coreVersions": core_versions,
        "baseHostFingerprint": inside_manifest["baseHost"], "hostFingerprint": host_hash, "hostFiles": host_files,
        "metadataSha256": packaged_meta["sha256"], "manifestSha256": packaged_manifest["sha256"], "manifestSize": packaged_manifest["size"],
        "payloadSha256": packaged_payload["sha256"], "payloadSize": packaged_payload["size"],
        "runtimeSha256": packaged_runtime["sha256"], "runtimeSize": packaged_runtime["size"], "sourceRuntimeSha256": source_runtime["sha256"],
        "runtimeEntries": runtime_entries, "runtimeUncompressedBytes": uncompressed, "runtimeZip64Count": runtime_zip64,
        "files": len(manifest["files"]), "retiredFiles": len(manifest["records"]) - len(manifest["files"]), "unpackedBytes": manifest["unpackedBytes"],
        "androidHelperDescriptorsFound": True, "hostFingerprintStringInDex": True,
        "checksPassed": True, "baselineVerified": False, "nonDshFilesPreserved": None,
        "deviceInstalled": False, "deviceVerified": False,
        "remainingChecks": ["本脚本不验证 previous 旧文件；需要构建前验证器的 --baseline 检查。",
                            "DEX 字符串存在不证明 BuildConfig 引用或 Android 执行通过；仍需设备安装、升级及功能自检。"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path, help="待验证的最终 APK")
    parser.add_argument("runtime", type=Path, help="已经验证的外部完整 runtime.zip")
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parent.parent, help="包含 android/app/src/main/assets 的项目目录")
    parser.add_argument("--report", type=Path, help="可选的独占创建 JSON 报告路径；父目录须已存在")
    args = parser.parse_args()
    result = verify(args.apk.resolve(), args.runtime.resolve(), args.project.resolve())
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        with args.report.open("x", encoding="utf-8") as output:
            output.write(text)
    print(text, end="")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, RecursionError, zipfile.BadZipFile, NotImplementedError, zlib.error) as error:
        print(f"DSH APK 验证失败：{error}", file=sys.stderr)
        sys.exit(1)
