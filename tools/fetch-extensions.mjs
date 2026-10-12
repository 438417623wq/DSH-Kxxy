/**
 * 阶段 1.5：构建扩展包池（五项改进方案 §4.3 第二层「包池」）。
 *
 * 做什么：
 *   1. 拉取 Termux aarch64 索引；
 *   2. 对 POOL_ITEMS 的每一项求「闭包 − 预装闭包（SEED_PACKAGES）」的边际集合
 *      —— 预装（④ 全能精选档）已有的包绝不重复打进池子；
 *   3. 下载边际 deb 到共享缓存 .cache/debs（与 fetch-runtime.mjs 同一份）；
 *   4. 调 tools/lib/poolextract.py 把每个边际集合的 data.tar.xz 解出、
 *      符号链接物化、重打成 android/app/src/main/assets/ext-pool/<id>.tar.gz；
 *   5. 生成 plugins/kxxy-host/extensions.json（真实版本号/体积来自索引，
 *      扩展中心 UI 的数据源）。
 *
 * 产物幂等：deb 与 tar.gz 都按内容缓存，重跑只做增量。
 *
 * 用法：node tools/fetch-extensions.mjs
 */
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  downloadTo, fetchBuffer, human, parsePackagesIndex, resolveClosure,
} from "./lib/registry.mjs";
import { POOL_ITEMS, SEED_PACKAGES, TERMUX_REPO } from "./lib/seeds.mjs";

/**
 * 池内条目可能住在 Termux 的其他仓库：yt-dlp 在 root 仓库（termux-main 没有）。
 * 索引按「主仓库优先」合并 —— 同名包以主仓库为准，每个包记下自己的 base，
 * 下载时按 base 拼 URL（Filename 字段是相对各仓库根的路径）。
 */
const EXTRA_REPOS = ["https://packages.termux.dev/apt/termux-root"];

async function fetchMergedIndex() {
  console.log(`[1/5] 拉取 Termux 索引 ${TERMUX_REPO}${EXTRA_REPOS.length ? ` (+${EXTRA_REPOS.length} 附加仓库)` : ""} ...`);
  // 索引拉取外层再兜一层：晚间高峰 packages.termux.dev 会间歇性拒绝握手，
  // fetchBuffer 的 4 连重试可能全落在同一个拥塞窗口里。
  let indexText = null;
  for (let round = 1; round <= 4 && indexText === null; round += 1) {
    try {
      indexText = (await fetchBuffer(`${TERMUX_REPO}/dists/stable/main/binary-aarch64/Packages`)).toString("utf8");
    } catch (e) {
      if (round === 4) throw e;
      console.warn(`      ⚠️ 主索引第 ${round} 次拉取失败（${String(e.message).slice(0, 60)}），20s 后重试`);
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
  const index = parsePackagesIndex(indexText);
  for (const base of EXTRA_REPOS) {
    let text = null;
    for (let round = 1; round <= 3 && text === null; round += 1) {
      try {
        text = (await fetchBuffer(`${base}/dists/stable/main/binary-aarch64/Packages`)).toString("utf8");
      } catch (e) {
        if (round === 3) {
          console.warn(`      ⚠️ 附加仓库不可用（${base}）：${e.message}`);
          break;
        }
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
    if (text === null) continue;
    const extra = parsePackagesIndex(text);
    let added = 0;
    for (const [name, pkg] of extra) {
      if (index.has(name)) continue;
      pkg.base = base;
      index.set(name, pkg);
      added += 1;
    }
    console.log(`      ${base}：+${added} 个包（仅取主仓库没有的）`);
  }
  console.log(`      合计 ${index.size} 个包可用`);
  return index;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, "..");
const CACHE = join(PROJECT, ".cache");
const POOL_OUT = join(PROJECT, "android", "app", "src", "main", "assets", "ext-pool");
const CATALOG_OUT = join(PROJECT, "plugins", "kxxy-host", "extensions.json");
const STAGE_DIR = join(CACHE, "stage");

/** Windows 文件名安全化（与 fetch-runtime.mjs 一致）。 */
const safeName = (s) => s.replace(/[:*?"<>|\\/]/g, "_");

async function main() {
  const debsDir = process.env.KXXY_CACHE ?? join(CACHE, "debs");
  mkdirSync(debsDir, { recursive: true });
  mkdirSync(dirname(CATALOG_OUT), { recursive: true });

  const index = await fetchMergedIndex();

  console.log("[2/5] 求预装闭包（④ 全能精选档种子）...");
  const baseline = resolveClosure(index, SEED_PACKAGES);
  const baselineNames = new Set(baseline.ordered.filter((n) => index.has(n)));
  console.log(`      预装闭包 ${baselineNames.size} 包，池内条目按边际集合求取`);

  console.log("[3/5] 下载池内边际 deb ...");
  const spec = { generatedAt: new Date().toISOString(), items: [] };
  const missingAll = [];
  const failedItems = [];
  for (const item of POOL_ITEMS) {
    const closure = resolveClosure(index, item.seeds);
    const marginal = closure.ordered.filter((n) => index.has(n) && !baselineNames.has(n));
    const missing = closure.missing.filter((n) => !index.has(n));
    if (missing.length) missingAll.push(`${item.id}: ${missing.join(", ")}`);
    if (marginal.length === 0) {
      console.log(`      ⊘ ${item.id}: 边际集合为空（全部已预装），跳过`);
      continue;
    }

    const packages = [];
    let downloadBytes = 0;
    let allGood = true;
    for (const name of marginal) {
      const pkg = index.get(name);
      const dest = join(debsDir, safeName(`${name}_${pkg.version}_${pkg.arch}.deb`));
      try {
        await downloadTo(`${pkg.base ?? TERMUX_REPO}/${pkg.filename}`, dest);
      } catch (err) {
        console.error(`      ✗ ${name}: ${err.message}`);
        allGood = false;
        break;
      }
      downloadBytes += pkg.size;
      packages.push({ name, file: dest.split(/[\\/]/).pop(), size: pkg.size });
    }
    if (!allGood) {
      failedItems.push(item);
      console.log(`      ⏳ ${item.id} 本轮失败，留待二轮`);
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    console.log(
      `      + ${item.id}: ${packages.length} 包 / ${human(downloadBytes)}` +
      (missing.length ? `（缺索引: ${missing.join(",")}）` : ""),
    );
    spec.items.push({
      id: item.id,
      version: index.get(item.seeds[0])?.version ?? "unknown",
      packages,
    });
  }

  // 二轮重试：Termux 主站对连续大流量有限流窗口，冷却 30s 后给失败项再一次机会
  if (failedItems.length) {
    console.log(`      ⏳ ${failedItems.length} 个池条目失败，冷却 30s 后二轮重试 ...`);
    await new Promise((r) => setTimeout(r, 30_000));
    for (const item of failedItems) {
      const closure = resolveClosure(index, item.seeds);
      const marginal = closure.ordered.filter((n) => index.has(n) && !baselineNames.has(n));
      const packages = [];
      let allGood = true;
      for (const name of marginal) {
        const pkg = index.get(name);
        const dest = join(debsDir, safeName(`${name}_${pkg.version}_${pkg.arch}.deb`));
        try {
          await downloadTo(`${pkg.base ?? TERMUX_REPO}/${pkg.filename}`, dest);
        } catch (err) {
          console.error(`      ✗ ${name}: ${err.message}`);
          allGood = false;
          break;
        }
        packages.push({ name, file: dest.split(/[\\/]/).pop(), size: pkg.size });
      }
      if (!allGood) {
        console.error(`      ✗ ${item.id}: 二轮仍失败，跳过（重跑本脚本可续）`);
        process.exitCode = 1;
        continue;
      }
      console.log(`      ↻ ${item.id}: ${packages.length} 包 二轮成功`);
      spec.items.push({
        id: item.id,
        version: index.get(item.seeds[0])?.version ?? "unknown",
        packages,
      });
    }
  }
  if (missingAll.length) {
    console.warn("      ⚠️ 以下种子在索引中不存在（对应条目按可用子集打包）：");
    for (const m of missingAll) console.warn(`         ${m}`);
  }

  const specPath = join(CACHE, "pool-spec.json");
  writeFileSync(specPath, JSON.stringify(spec, null, 2));

  console.log("[4/5] 解 deb → 物化符号链接 → 重打 tar.gz（poolextract.py）...");
  const reportPath = join(CACHE, "pool-report.json");
  // 本机常有「装了 Python 但不在 PATH」的情况（Windows 商店版/自定义安装），
  // 按候选逐个探测；KXXY_PYTHON 始终最高优先。
  const PY_CANDIDATES = [
    process.env.KXXY_PYTHON,
    "python",
    "python3",
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python312", "python.exe"),
    "C:\\Python312\\python.exe",
  ].filter(Boolean);
  let py = null;
  for (const cand of PY_CANDIDATES) {
    const probe = spawnSync(cand, ["--version"], { stdio: "ignore" });
    if (probe.status === 0 || !probe.error) {
      py = cand;
      break;
    }
  }
  if (py === null) {
    throw new Error(
      `找不到 Python 解释器（试过：${PY_CANDIDATES.join(", ")}）。` +
      "poolextract.py 依赖 Python 标准库解 data.tar.xz（Node 无 xz）。",
    );
  }
  const run = spawnSync(py, [
    join(HERE, "lib", "poolextract.py"),
    "--debs", debsDir,
    "--spec", specPath,
    "--stage", STAGE_DIR,
    "--out", POOL_OUT,
    "--report", reportPath,
  ], { stdio: "inherit" });
  if (run.error) {
    throw new Error(`无法启动 Python（${py}）：${run.error.message}`);
  }
  if (run.status !== 0) {
    throw new Error(`poolextract.py 退出码 ${run.status}`);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));

  console.log("[5/5] 生成扩展目录 extensions.json ...");
  const reportById = new Map(report.items.map((r) => [r.id, r]));
  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo: TERMUX_REPO,
    arch: "aarch64",
    builtin: {
      packageCount: baselineNames.size,
      summary:
        `${baselineNames.size} 个包已预装进 runtime.zip：C/C++ 编译链（clang/llvm）、` +
        "安卓打包链（openjdk-21/d8/apksigner）、Python/脚本工具、proot 容器、" +
        "termux-api 移动端能力、完整 Unix 工具集 —— 开箱即用，无需获取。",
    },
    items: POOL_ITEMS.map((item) => {
      const r = reportById.get(item.id);
      return {
        id: item.id,
        name: item.name,
        version: spec.items.find((s) => s.id === item.id)?.version ?? "unknown",
        category: item.category,
        description: item.description,
        bins: item.bins,
        sizeBytes: r?.totalBytes ?? 0,
        fileCount: r?.files ?? 0,
      };
    }).filter((item) => reportById.has(item.id)),
  };
  writeFileSync(CATALOG_OUT, `${JSON.stringify(catalog, null, 2)}\n`);

  let poolBytes = 0;
  for (const item of catalog.items) {
    const f = join(POOL_OUT, `${item.id}.pool`);
    if (existsSync(f)) poolBytes += statSync(f).size;
  }
  console.log(
    `\n完成：包池 ${catalog.items.length} 项（${human(poolBytes)}），` +
    `目录 → ${CATALOG_OUT}`,
  );
  for (const item of catalog.items) {
    console.log(
      `      ${item.id.padEnd(14)} v${String(item.version).padEnd(16)} ` +
      `${human(item.sizeBytes).padStart(10)} · ${item.fileCount} 文件`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
