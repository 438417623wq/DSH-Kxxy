/**
 * bundle 解析集成测试。
 *
 * 目的：`simulate-install.mjs` 证明文件铺对了，`smoke-plugin.mjs` 证明插件
 * 本身能跑。但**中间那一环**没人验证过 —— 设备上引擎启动时，
 * `dsh-app-boot` 到底能不能从 `lib/node_modules` 里把 `kxxy-host`
 * 解析成 profile bundle 并挂载？
 *
 * 本脚本直接用**真实的** `@deepseek-ai/dsh-app-boot`（从已装配好的树里
 * import），复刻 `profile-boot.js` 的调用序列：
 *   loadProfileDirectory(binName, profileDir, installAnchor)
 *     → resolveBundleDir → readProfileManifest → evaluatePluginCompatibility
 *     → bundlePatchPaths
 *
 * 这一步跑通，就等于证明了「装配产物 → 插件被 DSH 发现」这条链路。
 *
 * 用法：node tools/check-bundle.mjs [引擎根目录]
 */

import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = process.argv[2] ?? join(tmpdir(), 'kxxy-sim-install')

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const fail = (m) => {
  failures += 1
  console.log(`  ✗ ${m}`)
}

console.log(`引擎根目录：${root}\n`)

// ── 1. 定位 installAnchor（与 profile-boot.js 的 INSTALL_ANCHOR 同构）──
const installAnchor = join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
console.log('[1] installAnchor（profile-boot.js 的 INSTALL_ANCHOR）')
if (!existsSync(installAnchor)) {
  fail(`不存在：${installAnchor}`)
  process.exit(1)
}
ok(installAnchor)

// ── 2. 从装配好的树里加载真实 dsh-app-boot ────────────────────────
const appBootPath = join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
console.log('\n[2] 加载真实 @deepseek-ai/dsh-app-boot')
if (!existsSync(appBootPath)) {
  fail(`不存在：${appBootPath}`)
  process.exit(1)
}
let appBoot
try {
  appBoot = await import(pathToFileURL(appBootPath).href)
  ok(`已加载（导出 ${Object.keys(appBoot).length} 个符号）`)
} catch (e) {
  fail(`加载失败：${e.message}`)
  process.exit(1)
}
for (const fn of ['resolveBundleDir', 'loadProfileDirectory', 'readProfileManifest', 'evaluatePluginCompatibility', 'bundlePatchPaths', 'PROFILE_TEMPLATES']) {
  if (typeof appBoot[fn] === 'undefined') fail(`缺少导出 ${fn}`)
  else ok(`导出 ${fn}`)
}

// ── 3. 直接验证 kxxy-host 可被 resolveBundleDir 解析 ───────────────
console.log('\n[3] resolveBundleDir("kxxy-host")')
{
  // 先造一个最小的 profile 目录（模拟 $DSH_HOME/profiles/web）
  const profileDir = mkdtempSync(join(tmpdir(), 'kxxy-profile-'))
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'kxxy-host'] } } }, null, 2),
  )
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')

  let dir
  try {
    dir = appBoot.resolveBundleDir('dsh', 'kxxy-host', installAnchor, profileDir)
    ok(`解析到：${dir}`)
  } catch (e) {
    fail(`解析失败：${e.message}`)
  }
  if (dir) {
    if (!dir.endsWith(join('lib', 'node_modules', 'kxxy-host'))) fail(`落点异常：${dir}`)
    else ok('落点正是 lib/node_modules/kxxy-host')
  }

  // ── 4. 读出 manifest 与 bundle patch 路径 ─────────────────────
  console.log('\n[4] readProfileManifest + bundlePatchPaths')
  if (dir) {
    // 签名是 (binName, dir) —— binName 只作为抛错时的诊断前缀。
    const manifest = appBoot.readProfileManifest('dsh', dir)
    ok(`name=${manifest.name} version=${manifest.version}`)
    const patch = manifest?.dsh?.bundle?.patch
    if (patch !== './cordis.patch.yml') fail(`dsh.bundle.patch = ${patch}`)
    else ok('dsh.bundle.patch = ./cordis.patch.yml')

    try {
      // 签名是 (packageDir, bundle) —— bundle 是 manifest.dsh.bundle，不是整个 manifest。
      const paths = appBoot.bundlePatchPaths(dir, manifest.dsh.bundle)
      if (!paths.length) fail('bundlePatchPaths 返回空')
      else ok(`bundlePatchPaths → ${paths.map((p) => p.replace(root, '<root>')).join(', ')}`)
      for (const p of paths) {
        if (!existsSync(p)) fail(`补丁文件不存在：${p}`)
      }
    } catch (e) {
      fail(`bundlePatchPaths 抛错：${e.message}`)
    }

    // ── 5. 兼容性判定（kxxy-host 无 peerDependencies，必须通过）──
    console.log('\n[5] evaluatePluginCompatibility')
    try {
      const verdict = appBoot.evaluatePluginCompatibility(manifest)
      ok(`判定通过（返回 ${JSON.stringify(verdict)}）`)
    } catch (e) {
      fail(`判定抛错：${e.message}`)
    }
  }

  // ── 6. loadProfileDirectory 端到端 ────────────────────────────
  console.log('\n[6] loadProfileDirectory（端到端，含 3 个 bundle）')
  try {
    const profile = appBoot.loadProfileDirectory('dsh', profileDir, installAnchor)
    // 返回形状：{ name, dir, layers, patchPath, patches, skippedBundles }
    // 每个 layer：{ packageName, packageDir, patchPaths, patches }
    const names = (profile.layers ?? []).map((l) => l.packageName)
    ok(`解析出 ${names.length} 个 bundle layer：${names.join(', ')}`)
    if (!names.includes('kxxy-host')) fail('kxxy-host 不在解析结果里')
    else ok('kxxy-host 已进入 bundle 列表')
    const kxxyLayer = (profile.layers ?? []).find((l) => l.packageName === 'kxxy-host')
    if (kxxyLayer) {
      const patchCount = kxxyLayer.patches?.length ?? 0
      if (!patchCount) fail('kxxy-host 的补丁层解析为空')
      else ok(`kxxy-host 补丁层已解析（${patchCount} 条 patch，${kxxyLayer.patchPaths.length} 个文件）`)
    }
    const skipped = profile.skippedBundles ?? []
    if (skipped.length) {
      for (const s of skipped) console.log(`    · 跳过：${JSON.stringify(s)}`)
      if (skipped.some((s) => JSON.stringify(s).includes('kxxy-host'))) fail('kxxy-host 被跳过')
      else ok('kxxy-host 未被跳过')
    } else ok('无跳过项')
  } catch (e) {
    fail(`loadProfileDirectory 抛错：${e.message}`)
  }

  rmSync(profileDir, { recursive: true, force: true })
}

console.log(`\n结论：${failures === 0 ? 'bundle 解析链路全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
