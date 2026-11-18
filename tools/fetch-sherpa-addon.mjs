#!/usr/bin/env node
/**
 * 取 sherpa-onnx 的 Node 绑定源码（用于交叉编译 Android 版 `sherpa-onnx.node`）。
 *
 * 为什么不去 clone 整个仓库：node 绑定的 `.cc` 在仓库里都是**软链**，
 *   scripts/node-addon-api/src/x.cc -> ../../../harmony-os/.../cpp/x.cc
 * 真正被编的是 harmony-os 那一份。这里按 GitHub contents API 递归取那一个目录，
 * 几十个文件、两百来 KB，比 clone 一个带测试语料的仓库快两个数量级。
 *
 * 用法：node tools/fetch-sherpa-addon.mjs [--tag v1.13.8] [--out .cache/sherpa/src]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const TAG = argOf("--tag", "v1.13.8");
const OUT = resolve(argOf("--out", ".cache/sherpa/src"));
const REPO = "k2-fsa/sherpa-onnx";
const SRC_DIR = "harmony-os/SherpaOnnxHar/sherpa_onnx/src/main/cpp";

function get(url, binary = false) {
  return new Promise((ok, fail) => {
    const req = (u, hops = 0) => {
      if (hops > 5) return fail(new Error(`重定向过多: ${u}`));
      import("node:https").then(({ default: https }) => {
        https
          .get(u, { headers: { "user-agent": "kxxy-build", "accept": "application/vnd.github+json" } }, (r) => {
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
              r.resume();
              return req(r.headers.location, hops + 1);
            }
            if (r.statusCode !== 200) {
              r.resume();
              return fail(new Error(`HTTP ${r.statusCode} ${u}`));
            }
            const bufs = [];
            r.on("data", (d) => bufs.push(d));
            r.on("end", () => ok(binary ? Buffer.concat(bufs) : Buffer.concat(bufs).toString("utf8")));
          })
          .on("error", fail);
      }, fail);
    };
    req(url);
  });
}

/** 递归列出目录，返回 [{path, type}]。 */
async function walk(dir, acc = []) {
  const list = JSON.parse(
    await get(`https://api.github.com/repos/${REPO}/contents/${dir}?ref=${TAG}`),
  );
  for (const e of list) {
    if (e.type === "dir") await walk(e.path, acc);
    else if (e.type === "file") acc.push({ path: e.path, size: e.size });
  }
  return acc;
}

const files = await walk(SRC_DIR);
console.log(`sherpa ${TAG}: ${files.length} 个源码文件`);
let bytes = 0;
for (const f of files) {
  const rel = f.path.slice(SRC_DIR.length + 1);
  const dest = join(OUT, rel);
  const buf = await get(`https://raw.githubusercontent.com/${REPO}/${TAG}/${f.path}`, true);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  bytes += buf.length;
  console.log(`  ${rel} (${buf.length} B)`);
}
console.log(`完成：${(bytes / 1024).toFixed(1)} KiB → ${OUT}`);
