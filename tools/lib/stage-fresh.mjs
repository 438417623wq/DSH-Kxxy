/**
 * 「`.cache/stage` 是否还对得上 `.cache/debs/manifest.json`」的唯一判据。
 *
 * 抽成模块的理由：`tools/prepare-stage.mjs`（解包前判断）与
 * `tools/build-runtime.mjs`（装配 runtime.zip 前断言）必须用**同一份**规则。
 * 两边各写一套的后果已经出现过一次 —— 判据漂移时，恰恰是「打包脚本认为没问题、
 * 装配脚本也认为没问题、而 stage 本身停在几周前」这种不会报错的局面。
 *
 * 事故背景见 `tools/prepare-stage.mjs` 的头注释。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @returns {{ ok: boolean, reasons: string[], want: string[], manifestPath: string, stagePath: string }}
 */
export function stageStaleness(project) {
  const debs = join(project, '.cache', 'debs');
  const stage = join(project, '.cache', 'stage');
  const manifestPath = join(debs, 'manifest.json');
  const entries = join(stage, 'entries.json');
  const sidecar = join(stage, 'package-set.json');

  if (!existsSync(manifestPath)) {
    // 没有清单就无从判断（例如只更新插件、不重打运行时的场合）。交给调用方。
    return { ok: true, reasons: [], want: [], manifestPath, stagePath: stage };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const want = manifest.packages.map((p) => `${p.name}@${p.version}`).sort();

  const reasons = [];
  if (!existsSync(entries)) {
    reasons.push('stage 尚未解包（缺 entries.json）');
  } else {
    if (existsSync(sidecar)) {
      const got = JSON.parse(readFileSync(sidecar, 'utf8')).packages ?? [];
      const gotSet = new Set(got);
      const wantSet = new Set(want);
      const added = want.filter((x) => !gotSet.has(x));
      const removed = got.filter((x) => !wantSet.has(x));
      if (added.length || removed.length || got.length !== want.length) {
        reasons.push(
          `包集合与清单不一致（清单 ${want.length} / stage ${got.length}` +
            `${added.length ? `；新增 ${added.slice(0, 8).join(', ')}${added.length > 8 ? ` 等 ${added.length} 个` : ''}` : ''}` +
            `${removed.length ? `；移除 ${removed.length} 个` : ''}）`,
        );
      }
    } else {
      reasons.push('stage 没有包集合记录（旧版产物），无法证明它按当前清单解出');
    }
    if (statSync(entries).mtimeMs < statSync(manifestPath).mtimeMs) {
      reasons.push('entries.json 比 deb 清单旧');
    }
  }
  return { ok: reasons.length === 0, reasons, want, manifestPath, stagePath: stage };
}
