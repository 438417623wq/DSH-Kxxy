/**
 * 契约测试：Office 的 glibc 原生后端，**三处必须指向同一个可执行文件**，而且必须是
 * `program/soffice.bin` 而不是 `/usr/bin/soffice`。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 *
 * v0.9.97 的桥接写对了逻辑，但调的是 `/usr/bin/soffice` —— 那是 oosplash 启动器，
 * 在 proot 里自检 `/proc` 失败会直接退 1（真机实测：`ERROR: /proc not mounted`，
 * 连 `--version` 都不回）。于是「探测到文件就报 native」这一步通过了，真正转换却
 * 必然失败、又按设计回退 WASM：用户看到的仍是 `backend: "wasm"`，而代码里每一行
 * 看起来都对。整个链路没有任何单元测试盯着「到底调的是哪个文件」，所以只能靠人肉
 * 上机发现。
 *
 * 这个测试把「同一个路径」这件事钉成契约，并覆盖读取结果的那半边：
 *
 *   1. `tools/lib/patches.mjs` 的 `guestSoffice` = `program/soffice.bin`
 *   2. `tools/prebuilt/wrappers/kxxy-glibc-provision.sh` 的 `LO_BIN` 与 ①一致
 *   3. `tools/lib/seeds.mjs` 里 soffice / libreoffice 两条垫片的 `exe` 与 ①一致
 *   4. 桥接必须校验产物存在且非空（soffice.bin 对不认识的输入会 0 退出却不产文件）
 *   5. 引擎根回退级数正确（`lib/index.js` 所在的 `lib/` 往上 5 级才是引擎根）
 *
 * 纯源码文本断言，不需要 asar 与设备，构建机上秒级可跑。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const GUEST_SOFFICE = '/usr/lib/libreoffice/program/soffice.bin';
const LAUNCHER = '/usr/bin/soffice';

let failed = 0;
let checks = 0;
function check(ok, label, detail) {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

// ── 1. 桥接的目标路径 ────────────────────────────────────────────────────────
console.log('── 1. patches.mjs：桥接调哪个文件');
const patches = read('tools/lib/patches.mjs');
const fnAt = patches.indexOf('export function patchLibreOfficeKitGlibcNative');
const loPatch = patches.slice(fnAt);
// `lib/cli.js` 是打包产物，把 discoverRuntime / execute 内联了一份：
// capabilities / convert / render 三条命令全走它。只改 index.js 时能力探针永远报 wasm。
check(loPatch.includes('"@deepseek-ai/libreoffice-kit/lib/cli.js"'), 'cli.js 也是补丁目标（自带一份实现）');
check(loPatch.includes('"@deepseek-ai/libreoffice-kit/lib/index.js"'), 'index.js 是补丁目标（库入口）');
const guestDecl = patches.match(/const guestSoffice = "([^"]+)";/);
check(!!guestDecl, '能找到 guestSoffice 声明', '补丁结构变了？');
check(guestDecl?.[1] === GUEST_SOFFICE, `guestSoffice === ${GUEST_SOFFICE}`, `实际：${guestDecl?.[1]}`);
// /usr/bin/soffice 只允许出现在注释里解释「为什么不用它」，不能出现在字符串字面量里
const launcherLiterals = patches
  .split('\n')
  .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('/*') && !line.trim().startsWith('//'))
  .filter((line) => line.includes(`"${LAUNCHER}"`) || line.includes(`'${LAUNCHER}'`) || line.includes('`${LAUNCHER}'))
  .filter((line) => !line.includes(GUEST_SOFFICE));
check(
  launcherLiterals.length === 0,
  '没有任何代码路径真的去执行 /usr/bin/soffice',
  launcherLiterals.join('\n      '),
);

// ── 2. 预置脚本的 LO_BIN ────────────────────────────────────────────────────
console.log('── 2. kxxy-glibc-provision.sh：探测哪个文件');
const provision = read('tools/prebuilt/wrappers/kxxy-glibc-provision.sh');
const loBin = provision.match(/^LO_BIN=(.+)$/m);
check(!!loBin, '能找到 LO_BIN', '预置脚本里没这个变量');
check(loBin?.[1] === GUEST_SOFFICE, `LO_BIN === ${GUEST_SOFFICE}`, `实际：${loBin?.[1]}`);
check(
  !/in_guest\s+'[^']*\bsoffice --version/.test(provision),
  '没有残留 `soffice --version` 探测（oosplash 在 proot 里恒失败）',
);
check(provision.includes('lo_ok() {'), 'lo_ok() 存在（判定统一走 soffice.bin）');

// ── 3. 命令垫片的 exe ───────────────────────────────────────────────────────
console.log('── 3. seeds.mjs：两条命令垫片指向哪个文件');
const seeds = read('tools/lib/seeds.mjs');
const shims = [...seeds.matchAll(/name: "(soffice|libreoffice)", exe: "([^"]+)"/g)];
check(shims.length === 2, '找到 soffice / libreoffice 两条垫片', `实际 ${shims.length} 条`);
for (const [, name, exe] of shims) {
  check(exe === GUEST_SOFFICE, `${name} → ${GUEST_SOFFICE}`, `实际：${exe}`);
}

// ── 4. 产物校验 ─────────────────────────────────────────────────────────────
console.log('── 4. 桥接必须确认产物真的写出来了');
check(
  patches.includes('glibc soffice produced no output'),
  '校验产物存在（0 退出但不产文件 → 抛错）',
);
check(patches.includes('glibc soffice produced an empty'), '校验产物非空');
// `-env:UserInstallation=file://…` 在真机上让 soffice.bin 无输出退出 81（同一份
// .odt 去掉它立刻成功，四种写法全 81）。只允许出现在解释性注释里。
const userInstall = patches
  .split('\n')
  .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('/*') && !line.trim().startsWith('//'))
  .filter((line) => line.includes('UserInstallation'));
check(
  userInstall.length === 0,
  '没有给 soffice.bin 传 -env:UserInstallation（真机上必退 81）',
  userInstall.join('\n      '),
);

// ── 5. 引擎根回退级数 ───────────────────────────────────────────────────────
console.log('── 5. 根目录回退级数');
const fallback = patches
  .slice(patches.indexOf('export function patchLibreOfficeKitGlibcNative'))
  .match(/fileURLToPath\(import\.meta\.url\)\), "((?:\.\.\/)*\.\.)"/);
check(!!fallback, '能找到根目录回退串');
// 文件在 lib/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js，
// import.meta.url 的 dirname 就是 .../libreoffice-kit/lib（5 段）。
// 回退级数必须正好等于段数，少一级就落到 lib/（v0.9.97 之前就是这样，探测恒失败）。
const fromDir = 'lib/node_modules/@deepseek-ai/libreoffice-kit/lib';
const dirDepth = fromDir.split('/').length;
const upCount = fallback ? fallback[1].split('/').filter((s) => s === '..').length : -1;
const leftover = dirDepth - upCount;
check(
  leftover === 0,
  `回退 ${upCount} 级正好到引擎根（${fromDir} 共 ${dirDepth} 段）`,
  leftover < 0 ? `多退了 ${-leftover} 级，会跑到引擎根之外` : `还差 ${leftover} 级（落点：${fromDir.split('/').slice(0, leftover).join('/') || '引擎根'}）`,
);

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('');
if (failed > 0) {
  console.log(`RESULT ${JSON.stringify({ checks, passed: checks - failed, failed })}`);
  process.exit(1);
}
console.log(`RESULT ${JSON.stringify({ checks, passed: checks, failed: 0 })}`);
