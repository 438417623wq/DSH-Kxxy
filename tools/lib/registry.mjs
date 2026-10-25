/**
 * 共享工具：HTTP、Termux apt 索引解析、deb(ar) 读取、asar 读取。
 *
 * 这些能力在 Windows 上没有现成命令可用（无 bash / dpkg / ar / zip），
 * 所以全部用 Node 内置模块实现，避免给构建机引入额外依赖。
 */
import https from "node:https";
import http from "node:http";
import { createHash } from "node:crypto";
import {
  readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync,
  existsSync, statSync, openSync, closeSync, writeSync, rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

const UA = "dsh-kxxy-runtime-builder/1.0";

/**
 * 强制**不做内容编码协商**。
 *
 * 为什么必须有：这两个助手用的是 `node:http(s)`，它们**不会**自动解压响应体；
 * 而 Node 的 `fetch`（undici）会自动带上 `accept-encoding: gzip, deflate` 并解压。
 * 服务端一旦按压缩表示回应，`Content-Length` / `Content-Range` 报的就是
 * **压缩后**的长度，可我们拿到手的是原始字节 —— 用 Range 分段拉时段的边界
 * 全错，拼出来的文件是半截的，而且 `downloadTo` 的「大小 == Content-Length」
 * 自检还会**通过**。
 *
 * 实测：`tessdata_fast/chi_sim.traineddata` 走 jsdelivr 时响应头报
 * `Content-Length: 1700263`，实际解码后是 `2469156` —— 差 30%，
 * 正是这条被悄悄引入的 gzip 表示。原始站（raw.githubusercontent）的头与
 * 实体一致，所以那个源没暴露问题。加了这个头之后两边行为统一。
 */
const NO_ENCODING = { "accept-encoding": "identity" };

/**
 * 带重试的 GET，返回 Buffer。npmmirror/Termux 偶发 TLS 断连，必须重试。
 *
 * ⚠️ 除了 socket 空闲超时（req.setTimeout，对端慢滴滴几字节就会复位），
 * 还必须有**墙钟硬超时**：实测 libllvm（29 MB）会在「每几秒来几个字节」的
 * 连接上无限挂起 —— socket 永不空闲、重试永不触发。墙钟到点直接 destroy，
 * 走重试重新建连（慢连接通常是服务端/中间盒的问题，重连就好）。
 */
export async function fetchBuffer(url, { retries = 4, timeoutMs = 180_000, hardTimeoutMs = 150_000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const mod = url.startsWith("https:") ? https : http;
        const req = mod.get(url, { headers: { "user-agent": UA, ...NO_ENCODING } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            settled = true;
            clearTimeout(hardTimer);
            resolve(fetchBuffer(new URL(res.headers.location, url).toString(), { retries, timeoutMs, hardTimeoutMs }));
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            settled = true;
            clearTimeout(hardTimer);
            reject(new Error(`HTTP ${res.statusCode} ${url}`));
            return;
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            settled = true;
            clearTimeout(hardTimer);
            resolve(Buffer.concat(chunks));
          });
          res.on("error", (e) => {
            if (!settled) {
              settled = true;
              clearTimeout(hardTimer);
              reject(e);
            }
          });
        });
        req.on("error", (e) => {
          if (!settled) {
            settled = true;
            clearTimeout(hardTimer);
            reject(e);
          }
        });
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`timeout after ${timeoutMs}ms: ${url}`));
        });
        const hardTimer = setTimeout(() => {
          if (!settled) {
            req.destroy(new Error(`hard timeout after ${hardTimeoutMs}ms: ${url}`));
            settled = true;
            reject(new Error(`hard timeout after ${hardTimeoutMs}ms: ${url}`));
          }
        }, hardTimeoutMs);
      });
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1200 * attempt));
        continue;
      }
    }
  }
  throw lastErr;
}

/** 下载到文件，已存在且非空则跳过（构建可续跑）。
 *
 * 两层抗慢策略（都来自对 packages.termux.dev 的实测）：
 *
 * 1. **限速是每连接的**（单流 ~30 KB/s，6 并行 ~6 倍聚合），大文件走
 *    并行分段：探测总长 → 切 4 MiB 段 → N 个 worker 各用独立连接拉自己的段
 *    （段内按 512 KiB 块请求，块级重试；段完成才落盘）→ 顺序拼装 → 原子改名。
 * 2. 服务器不认 Range（回 200 全量）时退回单流断点续传（.part 追加）。
 *
 * 两种路径最后都做「大小 == Content-Length」校验，杜绝半截文件冒充缓存。
 */
export async function downloadTo(url, dest, {
  concurrency = 4,
  spanBytes = 4 * 1024 * 1024,
  chunkBytes = 512 * 1024,
  chunkTimeoutMs = 60_000,
} = {}) {
  if (existsSync(dest) && statSync(dest).size > 0) return "cached";
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;

  // ── 探测总长（Range: bytes=0-0）──────────────────────────────────
  let total = null;
  try {
    const probe = await fetchChunk(url, 0, 0, chunkTimeoutMs);
    if (probe.status === 206 && probe.total) total = probe.total;
  } catch {
    // 探测失败按不支持 Range 处理，走单流
  }

  if (total === null) {
    return singleStreamResume(url, dest, part, chunkTimeoutMs);
  }

  // 上一次运行已经拿全但没来得及改名 → 直接采用
  if (existsSync(part) && statSync(part).size === total) {
    renameSync(part, dest);
    return "ok";
  }

  // ── 并行分段 ─────────────────────────────────────────────────────
  const spans = [];
  for (let start = 0; start < total; start += spanBytes) {
    spans.push([start, Math.min(start + spanBytes, total) - 1]);
  }
  const tmpDir = `${dest}.parts`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  try {
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next += 1;
        if (i > spans.length) return;
        const [s, e] = spans[i - 1];
        await downloadSpan(url, s, e, join(tmpDir, String(i - 1)), chunkBytes, chunkTimeoutMs);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, spans.length) }, () => worker()),
    );

    const fd = openSync(part, "w");
    try {
      for (let i = 0; i < spans.length; i += 1) {
        const buf = readFileSync(join(tmpDir, String(i)));
        writeSync(fd, buf);
      }
    } finally {
      closeSync(fd);
    }
    if (statSync(part).size !== total) {
      throw new Error(`size mismatch after assembly: ${statSync(part).size}/${total}: ${url}`);
    }
    renameSync(part, dest);
    return "ok";
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** 单个 worker 拉一段 [start, end]：按块请求、块级重试（带退避），段成功才写 tmp。 */
async function downloadSpan(url, start, end, tmp, chunkBytes, chunkTimeoutMs) {
  const parts = [];
  let pos = start;
  while (pos <= end) {
    const stop = Math.min(pos + chunkBytes - 1, end);
    let buf = null;
    for (let retry = 0; retry < 5 && !buf; retry += 1) {
      try {
        const res = await fetchChunk(url, pos, stop, chunkTimeoutMs);
        if (res.status !== 206) throw new Error(`expected 206, got ${res.status}`);
        if (!res.buf || res.buf.length === 0) throw new Error("empty chunk body");
        buf = res.buf;
      } catch {
        // 块失败退避重试（连接被掐断是常态；连续失败说明服务端在限流，
        // 拉长间隔给对端冷却窗口）
        await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
      }
    }
    if (!buf) throw new Error(`span ${start}-${end} failed at ${pos}: ${url}`);
    parts.push(buf);
    pos += buf.length;
  }
  writeFileSync(tmp, Buffer.concat(parts));
}

/** 服务器不支持 Range 时的兜底：单流 + .part 断点续传。 */
async function singleStreamResume(url, dest, part, chunkTimeoutMs) {
  for (let round = 0; round < 60; round += 1) {
    const have = existsSync(part) ? statSync(part).size : 0;
    let res;
    try {
      res = await fetchChunk(url, have, null, chunkTimeoutMs);
    } catch {
      await new Promise((r) => setTimeout(r, 2_000)); // 别用瞬时重试打服务器
      continue;
    }
    if (res.done) break;
    if (res.buf && res.buf.length > 0) {
      if (res.status === 200 && have > 0) writeFileSync(part, res.buf);
      else appendFileSync(part, res.buf);
    }
    if (res.total === null && (!res.buf || res.buf.length === 0)) break;
  }
  if (!existsSync(part)) throw new Error(`download failed: ${url}`);
  const size = statSync(part).size;
  if (size === 0) throw new Error(`incomplete download 0 bytes: ${url}`);
  renameSync(part, dest);
  return "ok";
}

/**
 * 拉一个 Range 块 [from, to]（to=null 表示到文件尾）。
 * 返回 {status, buf, total, done}。
 */
function fetchChunk(url, from, to, hardTimeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      fn(val);
    };
    const range = to === null ? (from > 0 ? `bytes=${from}-` : undefined) : `bytes=${from}-${to}`;
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(
      url,
      { headers: { "user-agent": UA, ...NO_ENCODING, ...(range ? { range } : {}) } },
      (res) => {
        if (res.statusCode === 416) {
          res.resume();
          finish(resolve, { status: 416, buf: null, total: null, done: true });
          return;
        }
        const total = res.statusCode === 206
          ? Number(String(res.headers["content-range"] ?? "").split("/")[1]) || null
          : Number(res.headers["content-length"]) || null;
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          finish(reject, new Error(`HTTP ${res.statusCode} ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => finish(resolve, { status: res.statusCode, buf: Buffer.concat(chunks), total, done: false }));
        res.on("error", (e) => finish(reject, e));
      },
    );
    req.on("error", (e) => finish(reject, e));
    req.setTimeout(60_000, () => req.destroy());
    const hardTimer = setTimeout(() => {
      req.destroy();
      finish(reject, new Error(`chunk hard timeout after ${hardTimeoutMs}ms: ${url}`));
    }, hardTimeoutMs);
  });
}

// ---------------------------------------------------------------- Termux apt

/**
 * 解析 Debian `Packages` 索引。
 * 返回 Map<包名, {name, version, arch, depends[], filename, size, sha256, installedSize}>。
 */
export function parsePackagesIndex(text) {
  const out = new Map();
  for (const para of text.split(/\n\n+/)) {
    if (!para.trim()) continue;
    const fields = new Map();
    let key = null;
    for (const line of para.split("\n")) {
      if (/^\s/.test(line) && key) {
        fields.set(key, `${fields.get(key)} ${line.trim()}`);
        continue;
      }
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      key = line.slice(0, idx).trim();
      fields.set(key, line.slice(idx + 1).trim());
    }
    const name = fields.get("Package");
    if (!name) continue;
    const dependsRaw = fields.get("Depends") ?? "";
    const depends = dependsRaw
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean)
      // 去掉版本约束与 arch 限定：`readline (>= 8.3)` / `foo:any`
      .map((d) => d.replace(/\s*\([^)]*\)/g, "").replace(/:\w+$/, "").trim())
      .filter((d) => d && !d.includes("|"));
    out.set(name, {
      name,
      version: fields.get("Version") ?? "",
      arch: fields.get("Architecture") ?? "",
      depends,
      filename: fields.get("Filename") ?? "",
      size: Number(fields.get("Size") ?? 0),
      sha256: fields.get("SHA256") ?? "",
      installedSize: Number(fields.get("Installed-Size") ?? 0),
    });
  }
  return out;
}

/** 从种子包递归求解依赖闭包。返回按拓扑序（依赖在前）的包名数组。 */
export function resolveClosure(index, seeds) {
  const seen = new Set();
  const ordered = [];
  const missing = [];
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const pkg = index.get(name);
    if (!pkg) {
      missing.push(name);
      return;
    }
    for (const dep of pkg.depends) visit(dep);
    ordered.push(name);
  };
  for (const s of seeds) visit(s);
  return { ordered, missing };
}

// ---------------------------------------------------------------- deb (ar)

/**
 * 极简 ar 读取器。.deb 是 `!<arch>\n` + 60 字节头 + 数据 的序列。
 * 返回 [{name, data}]。
 */
export function readAr(buf) {
  if (buf.subarray(0, 8).toString("latin1") !== "!<arch>\n") {
    throw new Error("not an ar archive (missing !<arch> magic)");
  }
  const members = [];
  let off = 8;
  while (off + 60 <= buf.length) {
    const hdr = buf.subarray(off, off + 60).toString("latin1");
    const name = hdr.slice(0, 16).trim().replace(/\/+$/, "");
    const size = Number.parseInt(hdr.slice(48, 58).trim(), 10);
    if (!Number.isFinite(size) || size < 0) break;
    const start = off + 60;
    members.push({ name, data: buf.subarray(start, start + size) });
    off = start + size + (size % 2);
  }
  return members;
}

/** 取出 .deb 里的 data.tar.* 成员。 */
export function debDataMember(debBuf) {
  const members = readAr(debBuf);
  const data = members.find((m) => /^data\.tar/.test(m.name));
  if (!data) {
    throw new Error(`no data.tar member in deb (have: ${members.map((m) => m.name).join(", ")})`);
  }
  return data;
}

// ---------------------------------------------------------------- asar

/**
 * 读取 Electron asar 归档。
 *
 * 格式：4 字节 pickle 大小 + 4 字节 header 大小 + JSON 目录 + 拼接的 payload。
 * 目录项的 offset 是【字符串】，必须 Number() 转换 —— 否则 `base + offset`
 * 变成字符串拼接，静默读到错误位置（这个坑在本项目的侦察阶段踩过一次）。
 */
export function openAsar(path) {
  const buf = readFileSync(path);
  const headerSize = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString("utf8"));
  // payload 起点是 `16 + align4(headerSize)`，**不是** `16 + headerSize`。
  //
  // Electron 写 asar 时把 header JSON 补齐到 4 字节边界再拼 payload（见
  // `tools/pack-asar.mjs` 的 `padded = align4(jsonLen)`，以及本文件头注释里
  // 「base = 16 + align4(jsonLen) = 8 + f4」那条反推）。真实桌面版 asar 的
  // jsonLen 是 4,748,087（% 4 = 3），少算这 1 字节会让**每个**条目整体错位：
  // `package.json` 读出来首字符是 `\0`，JSON.parse 直接抛错，闭包只剩 3 个根包、
  // 接缝包全部「漏出闭包」—— 报错信息完全指向别处。
  //
  // 只有 jsonLen % 4 == 0 时两种写法才等价，所以这个缺陷在头部长度碰巧对齐的
  // 机器上不可见。
  const base = 16 + ((headerSize + 3) & ~3);
  // electron-builder 会把带原生二进制 / 需保留权限位的文件从 asar 里「解包」到
  // <asar>.unpacked 下的同构目录树，header 里只留 {size, unpacked:true, integrity}
  // 而没有 offset —— 直接按 offset 读会得到 0 字节。必须回退到磁盘。
  const unpackedRoot = `${path}.unpacked`;

  /** 目录项 → 磁盘上的解包路径；未解包时返回 null。 */
  function unpackedPathOf(node, asarPath) {
    if (!node.unpacked) return null;
    const rel = asarPath.replace(/^\/+/, "");
    const full = join(unpackedRoot, rel);
    return existsSync(full) ? full : null;
  }

  /** 按 asar 内路径（如 "/dsh/node_modules/zod/package.json"）取文件内容。 */
  function readFile(asarPath) {
    const parts = asarPath.replace(/^\/+/, "").split("/").filter(Boolean);
    let node = header;
    for (const part of parts) {
      if (!node.files || !node.files[part]) throw new Error(`asar path not found: ${asarPath}`);
      node = node.files[part];
    }
    if (node.files) throw new Error(`asar path is a directory: ${asarPath}`);
    if (node.unpacked) {
      const full = unpackedPathOf(node, asarPath);
      if (full === null) {
        throw new Error(`asar entry is marked unpacked but missing on disk: ${full}`);
      }
      return readFileSync(full);
    }
    const offset = base + Number(node.offset);
    return buf.subarray(offset, offset + Number(node.size));
  }

  /** 遍历某目录下所有【文件】，回调 (asarPath, size)。 */
  function walkFiles(dirPath, onFile) {
    const parts = dirPath.replace(/^\/+/, "").split("/").filter(Boolean);
    let node = header;
    for (const part of parts) {
      if (!node.files || !node.files[part]) throw new Error(`asar dir not found: ${dirPath}`);
      node = node.files[part];
    }
    const rec = (n, prefix) => {
      for (const [name, child] of Object.entries(n.files ?? {})) {
        const p = `${prefix}/${name}`;
        if (child.files) rec(child, p);
        else onFile(p, Number(child.size ?? 0));
      }
    };
    rec(node, dirPath.replace(/\/+$/, ""));
  }

  return { readFile, walkFiles, header, base, path };
}

// ---------------------------------------------------------------- misc

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
