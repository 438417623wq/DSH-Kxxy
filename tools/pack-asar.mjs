/**
 * 把**解包安装**的 DSH 桌面版目录打成 `app.asar`（缺陷 DH 的构建期补丁）。
 *
 * ## 为什么需要它
 *
 * `tools/build-runtime.mjs` 的 `--asar` 参数要的是一个**真的 asar 文件**：
 * `tools/lib/registry.mjs` 的 `openAsar(path)` 第一行就是 `readFileSync(path)`，
 * 然后按 `UInt32LE@12` 读 JSON 头、按 `offset` 切数据段。它没有任何「目录模式」。
 *
 * 而 DSH 桌面版有两种发行形态：
 *   · **asar 形态** —— `resources/app.asar`（打包发行版）；
 *   · **解包形态** —— `resources/app/{package.json,lib/,node_modules/}`（开发版 /
 *     某些 electron-builder 配置 / 本机这种）。
 *
 * 本项目 README 写的是「从本机已安装的 DSH 桌面版 `app.asar` 抽取」，所以在
 * 解包形态的机器上构建会在第 4 阶段直接抛 `asar 不存在`。本工具补上这一步：
 * 把 `resources/app` 按 asar 规范重新封装，目录映射为
 *
 *     resources/app/node_modules/**  →  /dsh/node_modules/**      （ASAR_NM）
 *
 * 与 `assemble.mjs` 里 `ASAR_NM = "/dsh/node_modules"` 的约定一致 ——
 * `asar.header.files.dsh.files.node_modules` 是 `resolveClosure` 的唯一入口。
 *
 * ## asar 格式（照 Electron 的 pickle 布局，逐字节对齐）
 *
 * ```
 * +0   UInt32LE  4                       pickle0 的 payload 长度（恒 4）
 * +4   UInt32LE  8 + align4(jsonLen)     pickle1 的总长度（= 4 + f8）
 * +8   UInt32LE  4 + align4(jsonLen)     pickle1 的 payload 长度（= f12 + json + pad）
 * +12  UInt32LE  jsonLen                 JSON 字符串长度（不含长度前缀）
 * +16  bytes     json                    header JSON
 *      pad       align4                  补齐到 4 字节边界
 * base bytes     file payloads          按 offset 顺序紧接其后
 * ```
 *
 * 其中 `base = 16 + align4(jsonLen) = 8 + f4`，条目里的 `offset` 是**相对
 * base** 的偏移。已用本机真实 asar（Landrop 65,996,135 B，jsonLen=7,157,311）
 * 逐字段反推核对：f4=7,157,320、f8=7,157,316、base=7,157,328，且 base 处正好
 * 是首个文件（MIT License）的开头。另用本仓库自己的 `openAsar` 做往返验证
 * （见 `--verify`）。
 *
 * ## 用法
 *
 * ```
 * node tools/pack-asar.mjs [--app <resources/app>] [--out <.cache/app.asar>] [--verify]
 * ```
 *
 * 默认 `--app` 取 `DSH_APP_DIR`，否则按常见安装位置探测；`--out` 默认
 * `.cache/app.asar`。`--verify` 会用 `openAsar` 读回来逐条比对（文件数、
 * 抽样内容、header 结构），不通过就非零退出。
 */
import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeSync, closeSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { openAsar, human } from "./lib/registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, "..");

/** 解包形态的候选安装位置（按优先级）。 */
const APP_CANDIDATES = [
  process.env.DSH_APP_DIR,
  "C:/KF/deepseek harness/DSH Desktop/resources/app",
  "F:/dsh-desktop/resources/app",
  join(process.env.LOCALAPPDATA ?? "", "Programs/DSH Desktop/resources/app"),
  join(process.env.PROGRAMFILES ?? "", "DSH Desktop/resources/app"),
].filter(Boolean);

/** 对齐到 4 字节（asar/pickle 的通用约束）。 */
const align4 = (n) => (n + 3) & ~3;

function parseArgs(argv) {
  const opts = { app: null, out: join(PROJECT, ".cache", "app.asar"), verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--app") opts.app = resolve(argv[++i]);
    else if (a === "--out") opts.out = resolve(argv[++i]);
    else if (a === "--verify") opts.verify = true;
    else if (a === "--help" || a === "-h") {
      console.log("用法：node tools/pack-asar.mjs [--app <resources/app>] [--out <.cache/app.asar>] [--verify]");
      process.exit(0);
    } else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

/**
 * 递归收集一个目录下的全部文件。
 *
 * 刻意**不**跟随符号链接：asar 没有「链接」概念，跟随会让同一个文件被写两次
 * 且体积翻倍。遇到链接就跳过并记账 —— 上游 dsh 依赖树里正常没有链接。
 * @param root - 目录绝对路径。
 * @returns `[{ rel, size }]`，rel 用 `/` 分隔。
 */
function collectFiles(root) {
  const out = [];
  let skippedLinks = 0;
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        skippedLinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        out.push({ rel, size: statSync(full).size });
      }
    }
  };
  walk(root, "");
  return { files: out, skippedLinks };
}

/**
 * 把扁平文件列表折成 asar 的嵌套 header 树。
 *
 * asar 的节点形态：目录是 `{ files: {...} }`，文件是 `{ size, offset }`。
 * 文件项在**序列化之后**才补 offset（那时才知道每个 payload 的落点）。
 * @param files - `[{ rel, size }]`。
 * @returns 根节点。
 */
function buildHeaderTree(files) {
  const root = { files: {} };
  for (const f of files) {
    const parts = f.rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node.files[name]) node.files[name] = { files: {} };
      node = node.files[name];
    }
    node.files[parts[parts.length - 1]] = { size: f.size };
  }
  return root;
}

/**
 * 按深度优先顺序给文件节点补 offset。
 *
 * **顺序必须与写盘顺序完全一致** —— offset 就是「相对 base 的累计字节数」。
 * 两者共用同一个 `files` 数组，所以顺序天然一致；这里只负责把 offset 写回
 * 树里对应的节点。
 * @param tree - header 根节点。
 * @param files - 与写盘相同的扁平列表（同序）。
 */
function assignOffsets(tree, files) {
  let cursor = 0;
  for (const f of files) {
    const parts = f.rel.split("/");
    let node = tree;
    for (let i = 0; i < parts.length; i++) node = node.files[parts[i]];
    node.offset = String(cursor);
    cursor += f.size;
  }
  return cursor;
}

function locateApp(explicit) {
  if (explicit !== null) {
    if (!existsSync(join(explicit, "package.json"))) {
      throw new Error(`--app 指向的目录没有 package.json：${explicit}`);
    }
    return explicit;
  }
  for (const candidate of APP_CANDIDATES) {
    if (existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "node_modules"))) {
      return candidate;
    }
  }
  throw new Error(
    `找不到解包形态的 DSH 桌面版（试过：\n  ${APP_CANDIDATES.join("\n  ")}\n）。` +
      `请用 --app <resources/app> 指定，或设 DSH_APP_DIR。`,
  );
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const appDir = locateApp(opts.app);
  console.log(`[1/4] 源目录 ${appDir}`);

  const nmDir = join(appDir, "node_modules");
  if (!existsSync(nmDir)) throw new Error(`缺少 node_modules：${nmDir}`);

  // 只打 node_modules：asar 侧唯一被读取的路径是 /dsh/node_modules（ASAR_NM）。
  // package.json / lib 之类不参与 runtime 装配，打进来只是白白增大体积。
  console.log(`[2/4] 扫描 node_modules …`);
  const { files, skippedLinks } = collectFiles(nmDir);
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  console.log(
    `      ${files.length} 个文件 / ${human(totalBytes)}` +
      (skippedLinks > 0 ? `（跳过 ${skippedLinks} 个符号链接）` : ""),
  );

  const tree = buildHeaderTree(files);
  const payloadBytes = assignOffsets(tree, files);

  // 根节点按 ASAR_NM 的约定套上 dsh/node_modules 两层。
  const header = { files: { dsh: { files: { node_modules: tree } } } };

  console.log(`[3/4] 写出 ${opts.out} …`);
  mkdirSync(dirname(opts.out), { recursive: true });

  const json = Buffer.from(JSON.stringify(header), "utf8");
  const jsonLen = json.length;
  const padded = align4(jsonLen);
  // pickle 布局（用真实 asar 反推，见文件头注释）：
  //   f0  = 4                        pickle0 的 payload 长度
  //   f4  = 8 + padded               pickle1 的总长度（= 4 + f8）
  //   f8  = 4 + padded               pickle1 的 payload 长度（f12 + json + pad）
  //   f12 = jsonLen                  JSON 字符串长度
  //   base = 16 + padded = 8 + f4
  const f0 = 4;
  const f8 = 4 + padded;
  const f4 = 8 + padded;
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeUInt32LE(f0, 0);
  sizeBuf.writeUInt32LE(f4, 4);
  const headerHead = Buffer.alloc(8);
  headerHead.writeUInt32LE(f8, 0);
  headerHead.writeUInt32LE(jsonLen, 4);
  const padding = Buffer.alloc(padded - jsonLen);

  const fd = openSync(opts.out, "w");
  let written = 0;
  try {
    writeSync(fd, sizeBuf);
    writeSync(fd, headerHead);
    writeSync(fd, json);
    writeSync(fd, padding);
    written = 16 + padded;
    // base 必须恰好等于「pickle0(8) + pickle1(f4)」，否则整份文件错位。
    const expectedBase = 8 + f4;
    if (written !== expectedBase) {
      throw new Error(`header 长度不符：写了 ${written} B，应为 ${expectedBase} B`);
    }
    for (const f of files) {
      const buf = readFileSync(join(nmDir, f.rel.split("/").join(sep)));
      if (buf.length !== f.size) {
        throw new Error(`读取长度不符：${f.rel} 期望 ${f.size} 实得 ${buf.length}`);
      }
      writeSync(fd, buf);
    }
  } finally {
    closeSync(fd);
  }

  const size = statSync(opts.out).size;
  console.log(`      完成：${size.toLocaleString()} B（${human(size)}）`);
  console.log(`      payload ${payloadBytes.toLocaleString()} B，header ${jsonLen.toLocaleString()} B`);

  if (!opts.verify) {
    console.log(`[4/4] 跳过校验（加 --verify 启用）`);
    return;
  }

  // ── 往返校验：用构建链自己的 openAsar 读回来 ──────────────────────────
  console.log(`[4/4] 用 openAsar 读回校验 …`);
  const asar = openAsar(opts.out);
  const nm = asar.header?.files?.dsh?.files?.node_modules;
  if (!nm || !nm.files) throw new Error("校验失败：header 里没有 dsh/node_modules");

  // 抽样：包数量、三个闭包根、以及每个文件的长度一致。
  const pkgs = Object.keys(nm.files).filter((k) => !k.startsWith("@"));
  const scoped = Object.keys(nm.files).filter((k) => k.startsWith("@"));
  console.log(`      顶层包 ${pkgs.length} 个 + ${scoped.length} 个 scope`);

  for (const need of ["@deepseek-ai/dsh", "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]) {
    const read = asar.readFile(`/dsh/node_modules/${need}/package.json`);
    const pkg = JSON.parse(read.toString("utf8"));
    if (pkg.name !== need) throw new Error(`校验失败：${need} 的 package.json 里 name=${pkg.name}`);
  }
  console.log(`      闭包根 3 个包可读且 name 自洽`);

  let checked = 0;
  let bytes = 0;
  for (const f of files) {
    const data = asar.readFile(`/dsh/node_modules/${f.rel}`);
    if (data.length !== f.size) {
      throw new Error(`校验失败：${f.rel} 长度 ${data.length} != ${f.size}`);
    }
    checked += 1;
    bytes += data.length;
  }
  if (checked !== files.length) throw new Error(`校验失败：只读回 ${checked}/${files.length}`);
  console.log(`      ${checked} 个文件长度全部一致（${human(bytes)}）`);
  console.log(`\n结论：asar 往返校验通过 —— 可直接给 build-runtime.mjs --asar 用`);
}

main();
