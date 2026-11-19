#!/usr/bin/env node
/**
 * 预取纯 Python 依赖（pandas / matplotlib / sympy 的那几个兄弟包）。
 *
 * 产物落在 `.cache/pydeps/`（wheel 原件）与 `.cache/pydeps-site/`（解包后的
 * site-packages 树，可直接推真机做单点验证）。构建时 `build-runtime.mjs` 会
 * 自己再解一遍并写进 runtime.zip，不依赖这个目录。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyDeps, PY_SITE } from "./lib/pydeps.mjs";

// 必须走 fileURLToPath：工作区路径里有空格，`new URL(...).pathname` 会留 `%20`。
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".cache", "pydeps-site");

const { files, resolved } = await loadPyDeps({ log: (m) => console.log("   ", m) });
console.log(`\n[1/2] 下载完成：${resolved.length} 个包`);
for (const r of resolved) console.log(`   ${r.pypi.padEnd(18)} ${r.version.padEnd(14)} ${r.filename}`);

console.log(`\n[2/2] 解包到 ${out}`);
let bytes = 0;
for (const [path, file] of files) {
  const rel = path.startsWith(PY_SITE + "/") ? path.slice(PY_SITE.length + 1) : path;
  const target = join(out, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.data);
  bytes += file.data.length;
}
console.log(`     ${files.size} 个文件，${(bytes / 1048576).toFixed(1)} MiB`);
