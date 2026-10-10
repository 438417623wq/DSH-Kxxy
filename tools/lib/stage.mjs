/**
 * Termux 运行时「文件系统视图」：读 entries.json，做裁剪决策、符号链接解析、
 * 别名（multi-call applet / SONAME）物化。
 *
 * 与参考项目 collect-termux-runtime.sh 的关键差异：
 *   参考项目在 Linux 上直接 cp -a 把符号链接原样打进 zip，靠 App 侧
 *   解压时建 symlink。而 Android app 域既禁硬链接也禁符号链接（linker
 *   解析不到），最终仍要复制实体 —— 它是在解压阶段才发现这件事的。
 *   我们直接在构建期算清楚：内容重复的别名条目用「LINK 条目」表达
 *   （数据区留空 + zip comment 写目标），本体只存一份。
 */
import { readFileSync } from "node:fs";
import { posix } from "node:path";

/**
 * Termux 的编译期 prefix。构建期把文本文件里的这个前缀换成 `@DSH_ROOT@`，
 * App 侧解压后再替换成真实 `filesDir/engine` 路径（见 RuntimeInstaller）。
 */
export const TERMUX_PREFIX = "/data/data/com.termux/files/usr/";

/** 裁剪目录：运行时用不到，占 33 MiB 量级。 */
export const PRUNE_DIRS = [
  "include/",
  "share/doc/",
  "share/man/",
  "share/info/",
  "share/gitweb/",
  "share/perl5/",
  "share/zsh/",
  "share/fish/",
  "share/aclocal/",
  "share/examples/",
  "share/et/",
  "libexec/installed-tests/",
];

/** 裁剪扩展名：静态库与文档。 */
export const PRUNE_EXT = [".a", ".la", ".md", ".ps1", ".cmd", ".map"];

/** 保留链接的顶层目录 —— 只有这三处的别名会被运行时真正打开。 */
const KEEP_LINK_TOPDIRS = new Set(["bin", "lib", "libexec"]);

export function isPruned(path) {
  if (PRUNE_DIRS.some((d) => path.startsWith(d))) return true;
  return PRUNE_EXT.some((e) => path.endsWith(e));
}

/** 把绝对 Termux 路径归一为运行时相对路径。 */
export function stripPrefix(target) {
  if (target.startsWith(TERMUX_PREFIX)) return target.slice(TERMUX_PREFIX.length);
  return null; // 指向 usr 之外（如 /system/bin），构建期无法解析
}

/**
 * 解析全部符号链接，得到 path → 最终实体路径（可能多层）。
 * 相对目标的基准是【链接自身所在目录】，不是根 —— 这一点写错会静默
 * 让 1,266/1,268 个链接解析失败。
 */
export function resolveSymlinks(entries) {
  const links = new Map(); // path -> target（已归一为相对路径或 null）
  const files = new Map(); // path -> entry

  for (const e of entries) {
    if (e.type === "file") files.set(e.path, e);
    else if (e.type === "hardlink") files.set(e.path, e); // 硬链接语义等同实体
    else if (e.type === "symlink") {
      let target;
      if (e.target.startsWith("/")) {
        target = stripPrefix(e.target);
      } else {
        target = posix.normalize(posix.join(posix.dirname(e.path), e.target));
      }
      links.set(e.path, target);
    }
  }

  // 多轮迭代：目标本身可能是另一个符号链接（实测 2 轮收敛）。
  const resolved = new Map();
  const unresolved = [];
  for (const [path, firstTarget] of links) {
    let target = firstTarget;
    let ok = target !== null;
    let hops = 0;
    const seen = new Set([path]);
    while (ok && links.has(target) && hops < 16) {
      if (seen.has(target)) { ok = false; break; } // 环
      seen.add(target);
      target = links.get(target);
      hops += 1;
      if (target === null) { ok = false; break; }
    }
    if (ok && files.has(target)) resolved.set(path, target);
    else unresolved.push({ path, target: firstTarget, reason: ok ? "目标不是实体文件" : "指向 usr 之外或成环" });
  }
  return { links, files, resolved, unresolved };
}

/**
 * 内容哈希 → 实体路径分组。用于决定哪些别名可以退化成 LINK 条目。
 * 同一组内只保留一个本体，其余写成 LINK。
 */
export function groupByContent(files, hashOf) {
  const byHash = new Map();
  for (const [path, entry] of files) {
    const digest = hashOf(entry);
    if (!digest) continue;
    if (!byHash.has(digest)) byHash.set(digest, []);
    byHash.get(digest).push(path);
  }
  return byHash;
}

/**
 * 从一组同内容路径里选本体：优先「无版本号」名（lib/x.so 优于 lib/x.so.1.2.3），
 * 与参考项目 dedupe-runtime.py 的 rank 一致。
 */
export function pickCanonical(paths) {
  const rank = (p) => {
    const base = posix.basename(p);
    return [base.split(".").length > 2 ? 1 : 0, p];
  };
  return [...paths].sort((a, b) => {
    const [ra, pa] = rank(a);
    const [rb, pb] = rank(b);
    return ra - rb || (pa < pb ? -1 : pa > pb ? 1 : 0);
  })[0];
}

/** 顶层目录归属。 */
export function topDir(path) {
  const i = path.indexOf("/");
  return i < 0 ? path : path.slice(0, i);
}

export { KEEP_LINK_TOPDIRS };

/** 读取 debextract.py 的输出。 */
export function loadStage(dir) {
  const data = JSON.parse(readFileSync(`${dir}/entries.json`, "utf8"));
  return { ...data, blobRoot: `${dir}/blobs` };
}
