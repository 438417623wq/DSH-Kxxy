/**
 * 共享工具：HTTP、Termux apt 索引解析、deb(ar) 读取、asar 读取。
 *
 * 这些能力在 Windows 上没有现成命令可用（无 bash / dpkg / ar / zip），
 * 所以全部用 Node 内置模块实现，避免给构建机引入额外依赖。
 */
import https from "node:https";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const UA = "dsh-kxxy-runtime-builder/1.0";

/** 带重试的 GET，返回 Buffer。npmmirror/Termux 偶发 TLS 断连，必须重试。 */
export async function fetchBuffer(url, { retries = 4, timeoutMs = 180_000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const mod = url.startsWith("https:") ? https : http;
        const req = mod.get(url, { headers: { "user-agent": UA } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            resolve(fetchBuffer(new URL(res.headers.location, url).toString(), { retries, timeoutMs }));
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} ${url}`));
            return;
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`timeout after ${timeoutMs}ms: ${url}`));
        });
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

/** 下载到文件，已存在且非空则跳过（构建可续跑）。 */
export async function downloadTo(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) return "cached";
  mkdirSync(dirname(dest), { recursive: true });
  const buf = await fetchBuffer(url);
  // 先写 .part 再原子改名：避免半截文件被下次运行当作缓存命中
  const tmp = `${dest}.part`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
  return "ok";
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
  const base = 16 + headerSize;
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
