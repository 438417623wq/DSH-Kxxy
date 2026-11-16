/**
 * 只重建 `plugins/kxxy-host/web/theme.css`，不跑全量运行时装配。
 *
 * 为什么需要这个入口：theme.css 的来源是上游 asar 里的主题模块，而全量
 * `build-runtime.mjs` 要重新解析 6 万条 stage/asar 条目、重打 777 MiB（数十分钟）。
 * 调主题抽取、或只想补一份新 token 表时，单跑这一步几十毫秒就够了。
 *
 * 用法：
 *   node tools/gen-theme-css.mjs --asar .cache/dsh-rb3/app/resources/app.asar
 *   node tools/gen-theme-css.mjs --asar <asar> --out <dir>/theme.css --print
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openAsar } from "./lib/registry.mjs";
import { themeCssFromAsarFiles } from "./lib/theme-css.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, "..");

/** 不同版本/装配形态下主题模块可能落的路径，按顺序试。 */
const CANDIDATES = [
  "/lib/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js",
  "/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js",
  "/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js",
];

function parseArgs(argv) {
  const opts = {
    asar: join(PROJECT, ".cache", "dsh-rb3", "app", "resources", "app.asar"),
    out: join(PROJECT, "plugins", "kxxy-host", "web", "theme.css"),
    print: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--asar") opts.asar = resolve(argv[++i]);
    else if (a === "--out") opts.out = resolve(argv[++i]);
    else if (a === "--print") opts.print = true;
    else if (a === "--help" || a === "-h") {
      console.log("用法：node tools/gen-theme-css.mjs [--asar <app.asar>] [--out <theme.css>] [--print]");
      process.exit(0);
    } else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const asar = openAsar(opts.asar);

let hit = null;
for (const candidate of CANDIDATES) {
  try {
    hit = { path: candidate, data: asar.readFile(candidate) };
    break;
  } catch {
    /* 试下一条 */
  }
}
if (!hit) throw new Error(`${opts.asar} 里找不到 dsh-client-ui-theme/lib/client.js`);

const asarFiles = new Map([[hit.path.replace(/^\//, ""), { data: hit.data }]]);
const theme = themeCssFromAsarFiles(asarFiles);
if (!theme) throw new Error("主题模块里没有解析出 --dsw token 块");

writeFileSync(opts.out, theme.css, "utf8");
console.log(`来源 ${hit.path}（${hit.data.length} B）`);
console.log(`写出 ${opts.out}：${theme.blocks} 个 token 块 / ${Buffer.byteLength(theme.css, "utf8")} B`);
if (opts.print) console.log(theme.css);
