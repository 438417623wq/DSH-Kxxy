/**
 * 在主机上模拟 `RuntimeInstaller.kt` 的安装管线，对真实的 runtime.zip 做端到端断言。
 *
 * 为什么需要这个脚本：verify-runtime.mjs 只看 zip 的**结构**（条目数、LINK 注释、
 * 占位符是否写对），它不回答「照 RuntimeInstaller 的步骤走一遍之后，设备上会不会
 * 真的长出一棵能启动的树」。而 RuntimeInstaller 的每一步都有事故背书
 * （SONAME 别名两阶段、占位符定点重写、exec 位恢复、kxxy-host 完整性锚点），
 * 任何一步在真机上失效都只在 logcat 里留一行日志。
 *
 * 本脚本按 RuntimeInstaller 的**精确顺序**复刻（见该文件 :65-95）：
 *   readZipIndex → extract（跳过 LINK）→ materialiseLinks → rewriteRootPlaceholder
 *   → materialiseSonameAliases → restoreExecBits → isComplete（五锚点）
 *
 * 用法：node tools/simulate-install.mjs [zip 路径] [目标目录]
 * 默认目标目录：<系统临时目录>/kxxy-sim-install（每次运行前清空）
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";

const zipPath = process.argv[2] ?? "F:/KF/DSKX/dsh-kxxy/android/app/src/main/assets/runtime.zip";
const target = resolve(process.argv[3] ?? join(tmpdir(), "kxxy-sim-install"));

/** 与 RuntimeInstaller 的 companion object 保持一致。 */
const MANIFEST_NAME = "kxxy-runtime.json";
const LINK_PREFIX = "LINK:";
const ROOT_PLACEHOLDER = "@DSH_ROOT@";
const RUNTIME_VERSION = "v0.1.0-arm64";
const MIN_DSH_AI_FILES = 100;
const EXECUTABLE_NAMES = new Set(["rg", "esbuild", "node", "sharp", "swc", "dprint", "biome"]);
const SONAME_ALIASES = [
  ["lib/libreadline.so.8", "lib/libreadline.so.8.3"],
  ["lib/libhistory.so.8", "lib/libhistory.so.8.3"],
  ["lib/libncursesw.so.6", "lib/libncursesw.so.6.5"],
  ["lib/libncurses.so.6", "lib/libncurses.so.6.5"],
  ["lib/libncurses.so", "lib/libncurses.so.6.5"],
];

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  ✗ ${msg}`);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

// ---------------------------------------------------------------- readZipIndex
const buf = readFileSync(zipPath);
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
if (eocd < 0) throw new Error("找不到 EOCD");
const count = buf.readUInt16LE(eocd + 10);
const cdStart = buf.readUInt32LE(eocd + 16);

/** name → { method, csize, usize, localOffset, comment } */
const index = new Map();
const topDirs = new Set();
{
  let p = cdStart;
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const comment = commentLen
      ? buf.toString("utf8", p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen)
      : "";
    index.set(name, { method, csize, usize, localOffset, comment });
    const slash = name.indexOf("/");
    if (slash > 0) topDirs.add(name.slice(0, slash));
    p += 46 + nameLen + extraLen + commentLen;
  }
}

const linkTargets = new Map();
for (const [name, e] of index) {
  if (e.comment.startsWith(LINK_PREFIX)) linkTargets.set(name, e.comment.slice(LINK_PREFIX.length));
}
let manifest = null;
{
  const e = index.get(MANIFEST_NAME);
  if (e !== void 0) manifest = JSON.parse(readEntryData(MANIFEST_NAME, e).toString("utf8"));
}

console.log(`runtime.zip：${count} 条目，LINK ${linkTargets.size}，顶层目录 ${topDirs.size}`);
console.log(`manifest：runtimeVersion=${manifest?.runtimeVersion} entries=${manifest?.entries} placeholderPaths=${manifest?.placeholderPaths?.length}`);
console.log(`模拟安装到：${target}\n`);

/** 读一个条目的原始内容（method=0 直接切片，否则 inflateRaw）。 */
function readEntryData(name, e) {
  const lp = e.localOffset;
  if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error(`local header 签名错误：${name}`);
  const nameLen = buf.readUInt16LE(lp + 26);
  const extraLen = buf.readUInt16LE(lp + 28);
  const start = lp + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.csize);
  return e.method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
}

// ---------------------------------------------------------------- extract
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

let extracted = 0;
let skippedLinks = 0;
const canonicalRoot = resolve(target);
for (const [name, e] of index) {
  if (name.endsWith("/")) {
    mkdirSync(join(target, name), { recursive: true });
    continue;
  }
  if (linkTargets.has(name)) {
    skippedLinks += 1;
    continue;
  }
  const dest = join(target, name);
  // zip-slip 防护，与 RuntimeInstaller 的 canonicalPath 比对同义
  if (!resolve(dest).startsWith(canonicalRoot + sep) && resolve(dest) !== canonicalRoot) {
    throw new Error(`zip-slip：${name}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readEntryData(name, e));
  extracted += 1;
}
const dirCount = [...index.keys()].filter((n) => n.endsWith("/")).length;
console.log(`[1] extract：写出 ${extracted} 个文件，跳过 ${skippedLinks} 个 LINK`);
{
  // manifest.entries 含自身与全部目录条目：实体文件 = entries - 1(manifest) - links - dirs
  // manifest.entries 已含全部目录条目与 manifest 自身：
  //   entries = 目录 + LINK + 实体文件（实体文件数里已包含 kxxy-runtime.json）
  const expect = manifest.entries - linkTargets.size - dirCount;
  if (extracted !== expect) fail(`实体文件数不符：期望 ${expect} 实得 ${extracted}`);
  else ok(`实体文件数与 manifest 一致（${extracted} = ${manifest.entries} - ${linkTargets.size} LINK - ${dirCount} 目录）`);
}

// ---------------------------------------------------------------- materialiseLinks
let madeLinks = 0;
const missingLinkTargets = [];
for (const [alias, targetRel] of linkTargets) {
  const src = join(target, targetRel);
  const dst = join(target, alias);
  if (!existsSync(src)) {
    missingLinkTargets.push(`${alias} → ${targetRel}`);
    continue;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  madeLinks += 1;
}
console.log(`[2] materialiseLinks：物化 ${madeLinks}/${linkTargets.size} 个别名`);
if (missingLinkTargets.length) fail(`LINK 目标缺失 ${missingLinkTargets.length} 条：${missingLinkTargets.slice(0, 5).join(", ")}`);
else ok("全部 LINK 目标都在包内（可物化）");

// ---------------------------------------------------------------- rewriteRootPlaceholder
const placeholders = manifest.placeholderPaths ?? [];
let rewritten = 0;
const stillHasTermux = [];
for (const rel of placeholders) {
  const f = join(target, rel);
  if (!existsSync(f)) {
    fail(`placeholderPaths 指向不存在的文件：${rel}`);
    continue;
  }
  const text = readFileSync(f).toString("latin1");
  if (!text.includes(ROOT_PLACEHOLDER)) {
    fail(`placeholderPaths 声明的文件里没有占位符：${rel}`);
    continue;
  }
  writeFileSync(f, Buffer.from(text.split(ROOT_PLACEHOLDER).join(canonicalRoot), "latin1"));
  rewritten += 1;
  if (readFileSync(f).toString("latin1").includes("com.termux")) stillHasTermux.push(rel);
}
console.log(`[3] rewriteRootPlaceholder：改写 ${rewritten}/${placeholders.length} 个脚本`);
if (stillHasTermux.length) fail(`改写后仍含 com.termux：${stillHasTermux.slice(0, 5).join(", ")}`);
else ok("改写后无残留 com.termux");

// ---------------------------------------------------------------- materialiseSonameAliases
let sonames = 0;
for (const [alias, real] of SONAME_ALIASES) {
  const src = join(target, real);
  const dst = join(target, alias);
  if (!existsSync(src)) {
    fail(`SONAME 别名本体缺失：${real}`);
    continue;
  }
  if (existsSync(dst)) {
    sonames += 1;
    continue;
  }
  copyFileSync(src, dst);
  sonames += 1;
}
console.log(`[4] materialiseSonameAliases：${sonames}/${SONAME_ALIASES.length}`);
if (sonames === SONAME_ALIASES.length) ok("五个 SONAME 别名齐备");

// ---------------------------------------------------------------- restoreExecBits
const chmodded = [];
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};
for (const full of walk(target)) {
  const base = full.slice(full.lastIndexOf(sep) + 1);
  const rel = relative(target, full).split(sep).join("/");
  const head = readFileSync(full, { encoding: null }).subarray(0, 4);
  const isElf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
  const isScript = head[0] === 0x23 && head[1] === 0x21;
  if ((isElf || isScript) && (rel.startsWith("bin/") || rel.startsWith("libexec/") || EXECUTABLE_NAMES.has(base))) {
    chmodSync(full, 0o755);
    chmodded.push(rel);
  }
}
console.log(`[5] restoreExecBits：${chmodded.length} 个可执行文件置 0755`);

// ---------------------------------------------------------------- isComplete（五锚点）
console.log("[6] isComplete 五锚点：");
const anchors = [
  ["锚点 1 dsh 引擎入口", join(target, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js")],
  ["锚点 2 SONAME 别名 libreadline.so.8", join(target, "lib/libreadline.so.8")],
  ["锚点 3 node 可执行", join(target, "bin/node")],
  ["锚点 5 kxxy-host 插件", join(target, "lib/node_modules/kxxy-host/package.json")],
];
for (const [label, f] of anchors) {
  if (!existsSync(f)) fail(`${label} 缺失：${f.slice(target.length + 1)}`);
  else ok(`${label} 存在`);
}
{
  const aiDir = join(target, "lib/node_modules/@deepseek-ai");
  const n = existsSync(aiDir) ? walk(aiDir).length : 0;
  if (n < MIN_DSH_AI_FILES) fail(`锚点 4 @deepseek-ai 文件数 ${n} < ${MIN_DSH_AI_FILES}`);
  else ok(`锚点 4 @deepseek-ai 文件数 ${n} ≥ ${MIN_DSH_AI_FILES}`);
}

// ---------------------------------------------------------------- 引擎启动路径
console.log("\n[7] 引擎启动路径检查（EngineProcess.spawn 的 argv 依赖）：");
const entry = join(target, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js");
const nodeBin = join(target, "bin/node");
for (const [label, f] of [["bin/node", nodeBin], ["dsh/lib/bin.js", entry]]) {
  if (!existsSync(f)) {
    fail(`${label} 缺失`);
    continue;
  }
  const head = readFileSync(f).subarray(0, 4);
  if (f === nodeBin) {
    const isElf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
    if (!isElf) fail(`${label} 不是 ELF（Android 无法 execve）`);
    else ok(`${label} 是 ELF 且可执行位已置`);
  } else ok(`${label} 存在`);
}
{
  // profile 解析链：kxxy-host 必须出现在 dsh 的 dependencies 里
  const pj = JSON.parse(readFileSync(join(target, "lib/node_modules/@deepseek-ai/dsh/package.json"), "utf8"));
  if (pj.dependencies?.["kxxy-host"] === void 0) fail("kxxy-host 未注册进 @deepseek-ai/dsh 的 dependencies（profile 解析会落空）");
  else ok(`kxxy-host 已注册（dependencies 共 ${Object.keys(pj.dependencies).length} 项，声明版本 ${pj.dependencies["kxxy-host"]}）`);
  // installAnchor 的 resolve.paths() 首项必须是 <root>/lib/node_modules
  if (!existsSync(join(target, "lib/node_modules/kxxy-host/lib/index.js"))) fail("kxxy-host/lib/index.js 缺失");
  else ok("kxxy-host 落在 installAnchor 的 node_modules 查找路径上");
}

// ---------------------------------------------------------------- 产出摘要
let totalBytes = 0;
let totalFiles = 0;
for (const full of walk(target)) {
  totalBytes += statSync(full).size;
  totalFiles += 1;
}
console.log(`\n安装后：${totalFiles} 个文件 / ${(totalBytes / 1048576).toFixed(1)} MiB（含 ${madeLinks} 个物化别名）`);
console.log(failures === 0 ? "\n结论：模拟安装全部通过" : `\n结论：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
