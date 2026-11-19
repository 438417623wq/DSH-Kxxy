/**
 * 让 `.cache/stage`（Termux 闭包解包结果）与 `.cache/debs/manifest.json` 保持一致。
 *
 * 为什么需要这一步（v0.9.68 真事故，用户第 3 项）：
 *   `build-apk.ps1` 从头到尾**不碰 stage** —— 它只检查 `.cache/apk-assets-hold/
 *   runtime.zip` 在不在。而 `runtime.zip` 是 `build-runtime.mjs` 读 `.cache/stage`
 *   装配的。于是只要有人改了种子表、跑了 `fetch-runtime` 把新 deb 拉下来，
 *   却忘了手动重跑 `debextract.py`，打包链就会**安静地**用几周前的 stage 出包：
 *
 *       `.cache/stage/entries.json` 停在 2026-10-25（279 包）
 *       `.cache/debs/manifest.json` 是 2026-11-18（290 包）
 *
 *   设备上看到的就是「pandas / lxml / Pillow / matplotlib 一个都不在
 *   site-packages 里」，而种子表里写得明明白白 —— 用户报的
 *   「pandas 17:40 还正常，现在 ModuleNotFoundError」正是这么来的。
 *   这类事故不会抛错、不会告警，只能靠比对清单发现，所以固化成一步，
 *   并且让 `build-runtime.mjs` 自己也断言（判据见 `lib/stage-fresh.mjs`）。
 *
 * 解包是**原地**进行的：`debextract.py` 的 blobs 按内容寻址、`entries.json`
 * 每次整体重写，所以旧 blob 只会变成无人引用的垃圾（不参与装配），
 * 不需要「先删再建」—— 那在 8 GiB 的量级上既慢又容易触发批量删除的审计钩子。
 *
 * 用法：`node tools/prepare-stage.mjs [--force] [--python <exe>]`
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageStaleness } from './lib/stage-fresh.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function main() {
  const force = process.argv.includes('--force');
  const pi = process.argv.indexOf('--python');
  const python = pi > 0 ? process.argv[pi + 1] : process.env.KXXY_PYTHON ?? 'python';

  const state = stageStaleness(PROJECT);
  const reasons = [...state.reasons];
  if (force) reasons.unshift('--force');

  if (!reasons.length) {
    console.log(`stage 已是最新（${state.want.length} 包），跳过解包`);
    return;
  }
  if (!existsSync(state.manifestPath)) {
    fail(`缺少 ${state.manifestPath} —— 先跑 node tools/fetch-runtime.mjs`);
  }

  console.log(`[stage] 需要重解：${reasons.join('；')}`);
  const r = spawnSync(
    python,
    [
      join(PROJECT, 'tools', 'lib', 'debextract.py'),
      '--debs', join(PROJECT, '.cache', 'debs'),
      '--out', state.stagePath,
    ],
    { stdio: 'inherit', cwd: PROJECT },
  );
  if (r.error) fail(`无法启动 ${python}：${r.error.message}`);
  if (r.status !== 0) fail(`debextract 退出码 ${r.status}`);

  const entriesPath = join(state.stagePath, 'entries.json');
  if (!existsSync(entriesPath)) fail(`解包完成但没有 ${entriesPath}`);

  writeFileSync(
    join(state.stagePath, 'package-set.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), packages: state.want }, null, 2)}\n`,
  );
  const entries = JSON.parse(readFileSync(entriesPath, 'utf8'));
  console.log(
    `[stage] 完成：${state.want.length} 包 → ${entries.count} 条目` +
      `（文件 ${entries.stats.file} / 软链 ${entries.stats.symlink} / 目录 ${entries.stats.dir}）`,
  );
}

main();
