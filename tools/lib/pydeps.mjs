/**
 * 纯 Python 依赖的内置化（pandas / matplotlib 的缺失依赖）。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────
 * Termux 的 `python-pandas` 与 `matplotlib` **不把纯 Python 依赖打进 deb**：
 * deb 的 Depends 里只有 numpy/openblas 这类原生件，`dateutil` / `packaging`
 * 这些留给了 `pip install`。而 Termux 主仓索引里同样搜不到
 * `python-dateutil`、`python-packaging`、`python-pytz`、`python-six`、
 * `python-pyparsing`、`python-fonttools` —— 在 Termux 里它们也要靠 pip 联网装。
 *
 * 于是「离线可用」这条前提直接崩了。真机症状（v0.9.67 / v0.9.68）：
 *     pandas     ImportError: Unable to import required dependency dateutil
 *     matplotlib ModuleNotFoundError: No module named 'packaging'
 * 两个包的文件都躺在 site-packages 里，只是差几个纯 Python 兄弟包。
 *
 * ── 为什么可以直接解 wheel ────────────────────────────────────────
 * 这几个包全部发布 `*-none-any.whl`（纯 Python，无 ABI 概念），解出来丢进
 * `site-packages` 就能用，不涉及 NDK 编译，也不受 Android bionic 影响。
 * 因此这里只做「下载 → 校验 sha256 → 解包成文件表」，不跑 pip、不联网解析依赖。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 钉住版本。升级时改这里，并把 tools/pydeps.lock.json 里对应项删掉重跑。 */
export const PYDEPS = [
  // pandas → dateutil → six。dateutil **刻意停在 2.9**：4.0 是新一轮大版本，
  // pandas 3.1.1 的 `_libs.tslibs` 仍按 2.x 的 API 使用，先不跟。
  { pypi: "python-dateutil", version: "2.9.0.post0" },
  { pypi: "six", version: "1.17.0" },
  // 时区数据库（Android 无系统 tzdata，pandas 3 走 tzdata 包）
  { pypi: "tzdata", version: "2026.6" },
  { pypi: "pytz", version: "2026.6" },
  // matplotlib → cycler / packaging / pyparsing / fonttools
  { pypi: "cycler", version: "0.12.1" },
  { pypi: "packaging", version: "26.3" },
  { pypi: "pyparsing", version: "3.3.3" },
  { pypi: "fonttools", version: "4.68.0" },
  // sympy（Termux 无 python-sympy）→ mpmath
  { pypi: "sympy", version: "1.14.0" },
  { pypi: "mpmath", version: "1.4.1" },
  // torch 的**导入期**依赖（Termux 的 python-torch deb 同样不带这些纯 Python 包）。
  // 缺 typing_extensions 时 `import torch` 第一行就炸（v0.9.69 真机实测），
  // 而 torch 池 374 MB 已经装好、白装一场。
  //
  // 只补导入链上真需要的四个：typing_extensions（`torch/__init__.py` 直接
  // import）、filelock、networkx、fsspec。**不补 jinja2/markupsafe**：
  // MarkupSafe 只发平台轮子（`cp314-…whl`），没有 `none-any`，解不了；
  // 它们只在 `torch.compile` / inductor 路径上用得到，核心张量运算不需要。
  { pypi: "typing_extensions", version: "4.16.0" },
  { pypi: "filelock", version: "4.2.12" },
  { pypi: "networkx", version: "3.7" },
  { pypi: "fsspec", version: "2026.9.0" },
  // joblib / threadpoolctl：scikit-learn 的两个**纯 Python** 运行时依赖。
  // 说明：sklearn 本体在 Termux 生态里没有 aarch64 包（主仓与 TUR 都没有，
  // PyPI 只有 glibc 轮子、bionic 上加载不了），详见
  // docs/2026-11-19-v0.9.71-……md 的「sklearn / cv2 为什么仍然缺」。
  // 之所以仍然内置这两个：joblib 自己就有用（`joblib.dump/load` 的大数组落盘、
  // `Parallel` 多进程），threadpoolctl 用来查/限 BLAS 线程数，
  // 而且等将来真有原生 sklearn 时不用再补一轮。
  { pypi: "joblib", version: "1.6.0" },
  { pypi: "threadpoolctl", version: "3.8.0" },
];

const LOCK = join(PROJECT_ROOT, "tools", "pydeps.lock.json");
const CACHE = join(PROJECT_ROOT, ".cache", "pydeps");

/** 站点包根（与 stage / runtime.zip 内的路径一致）。 */
export const PY_SITE = "lib/python3.14/site-packages";

const META_MIRRORS = [
  (p, v) => `https://pypi.org/pypi/${p}/${v}/json`,
  (p, v) => `https://pypi.tuna.tsinghua.edu.cn/pypi/${p}/${v}/json`,
];

/**
 * 取**指定版本**的元数据。
 *
 * 刻意不用 `/pypi/<name>/json`（最新版）：那个端点的版本号会随时间漂移，
 * 一旦上游发新版，构建就会因为「钉版失效」而随机构建失败 —— 用钉版端点
 * 则永远拿到同一份清单，可复现性由 `tools/pydeps.lock.json` 里的 sha256 兜住。
 */
async function pypiJson(name, version) {
  let last;
  for (const build of META_MIRRORS) {
    try {
      const res = await fetch(build(name, version), { headers: { "user-agent": "dsh-kxxy-build" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`PyPI 元数据获取失败：${name}@${version}（${last?.message || last}）`);
}

function readLock() {
  if (!existsSync(LOCK)) return {};
  try {
    return JSON.parse(readFileSync(LOCK, "utf8"));
  } catch {
    return {};
  }
}

/** 只接受纯 Python wheel：文件名必须以 `none-any.whl` 结尾（否则免谈 bionic）。 */
function pickWheel(meta) {
  const wheels = (meta.urls || []).filter((u) => u.filename.endsWith("none-any.whl"));
  if (!wheels.length) {
    throw new Error(
      `${meta.info?.name || "?"} ${meta.info?.version} 没有 pure-Python wheel` +
        `（可用：${(meta.urls || []).map((u) => u.filename).join(", ")}）`,
    );
  }
  return wheels[0];
}

/** 解 wheel（zip）为 Map<path, {data, mode}>，路径已加上 PY_SITE 前缀。 */
function unzipToFiles(buf, prefix) {
  const files = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("wheel 不是合法 zip（找不到 EOCD）");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("wheel 中央目录损坏");
    const method = buf.readUInt16LE(p + 10);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const mode = (buf.readUInt32LE(p + 38) >>> 16) & 0o777;
    const csize = buf.readUInt32LE(p + 20);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    // `*.data/` 是 wheel 里「属于前缀而非 site-packages」的部分（man/头文件/脚本），
    // 我们只内置 import 用的库代码，整目录跳过。
    if (name.includes(".data/")) continue;
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`wheel 含非法路径：${name}`);
    }
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`wheel 压缩方式不支持：method=${method} ${name}`);
    files.set(`${prefix}/${name}`, { data, mode: mode ? mode : 0o644 });
  }
  return files;
}

/**
 * 下载并解出全部纯 Python 依赖。
 * @returns {Promise<{files: Map<string,{data:Buffer,mode:number}>, resolved: object[]}>}
 */
export async function loadPyDeps({ log = () => {} } = {}) {
  const lock = readLock();
  const files = new Map();
  const resolved = [];
  mkdirSync(CACHE, { recursive: true });

  for (const dep of PYDEPS) {
    const known = lock[dep.pypi];
    let filename;
    let sha256;
    if (known && known.version === dep.version) {
      filename = known.filename;
      sha256 = known.sha256;
    } else {
      const wheel = pickWheel(await pypiJson(dep.pypi, dep.version));
      filename = wheel.filename;
      sha256 = wheel.digests.sha256;
    }

    const path = join(CACHE, filename);
    let buf;
    if (existsSync(path)) {
      buf = readFileSync(path);
    } else {
      const meta = await pypiJson(dep.pypi, dep.version);
      const wheel = (meta.urls || []).find((u) => u.filename === filename);
      if (!wheel) throw new Error(`PyPI 上找不到 ${filename}`);
      log(`下载 ${filename}（${(wheel.size / 1048576).toFixed(1)} MiB）`);
      const res = await fetch(wheel.url, { headers: { "user-agent": "dsh-kxxy-build" } });
      if (!res.ok) throw new Error(`下载失败 ${filename}：HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(path, buf);
    }
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== sha256) {
      throw new Error(
        `${filename} sha256 不匹配（期望 ${sha256.slice(0, 16)}…，实得 ${got.slice(0, 16)}…）`,
      );
    }

    for (const [k, v] of unzipToFiles(buf, PY_SITE)) files.set(k, v);
    resolved.push({ pypi: dep.pypi, version: dep.version, filename, sha256 });
    lock[dep.pypi] = { version: dep.version, filename, sha256 };
  }

  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
  return { files, resolved };
}
