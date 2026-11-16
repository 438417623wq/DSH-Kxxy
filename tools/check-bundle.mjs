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
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 传相对路径时 dsh-app-boot 会把它原样交给 `module.createRequire()`，报
// ERR_INVALID_ARG_VALUE。这里统一转绝对路径，避免误判成产品缺陷。
const root = resolve(process.argv[2] ?? join(tmpdir(), 'kxxy-sim-install'))

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
for (const fn of ['resolveBundleDir', 'loadProfileDirectory', 'readProfileManifest', 'evaluatePluginCompatibility', 'bundlePatchPaths']) {
  if (typeof appBoot[fn] === 'undefined') fail(`缺少导出 ${fn}`)
  else ok(`导出 ${fn}`)
}
// 0.2.2-rc.2 起 `PROFILE_TEMPLATES` 不再由 dsh-app-boot 转出，改为从
// `@deepseek-ai/dsh-official-bundles` 直接 import（见 dsh-app-boot/lib/index.js:15）。
// 项目自身不直接消费该表，所以只在任一入口可用时放行，缺失才算真问题。
if (typeof appBoot.PROFILE_TEMPLATES !== 'undefined') {
  ok('导出 PROFILE_TEMPLATES（dsh-app-boot 转出）')
} else {
  const bundlesEntry = join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh-official-bundles', 'lib', 'index.js')
  let templates
  try {
    templates = (await import(pathToFileURL(bundlesEntry).href)).PROFILE_TEMPLATES
  } catch (e) {
    fail(`PROFILE_TEMPLATES 不可用：dsh-app-boot 未转出，且 dsh-official-bundles 加载失败（${e.message}）`)
  }
  if (templates !== undefined) ok('PROFILE_TEMPLATES 由 @deepseek-ai/dsh-official-bundles 提供')
  else if (failures === 0) fail('PROFILE_TEMPLATES 在两个入口都缺失')
}

// ── 3. 直接验证 kxxy-host 可被 resolveBundleDir 解析 ───────────────
console.log('\n[3] resolveBundleDir("kxxy-host")')
{
  // 先造一个最小的 profile 目录（模拟 $DSH_HOME/profiles/web）
  const profileDir = mkdtempSync(join(tmpdir(), 'kxxy-profile-'))
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'kxxy-host', 'dsh-codex-sidebar'] } } }, null, 2),
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
  console.log('\n[6] loadProfileDirectory（端到端，含 4 个 bundle）')
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
    const codexLayer = (profile.layers ?? []).find((layer) => layer.packageName === 'dsh-codex-sidebar')
    if (!codexLayer?.patches?.length) fail('dsh-codex-sidebar 缺少有效的 profile 补丁层')
    else {
      ok(`dsh-codex-sidebar 补丁层已解析（${codexLayer.patches.length} 条 patch）`)
      const codexManifest = appBoot.readProfileManifest('dsh', codexLayer.packageDir)
      if (codexManifest.dsh?.client?.platform !== 'web' || codexManifest.exports?.['./client'] !== './lib/client.js') fail('Codex 客户端安装合同不匹配')
      else ok('Codex 客户端声明与 installation-scope 解析一致')
      for (const path of ['lib/client.js', 'lib/service.mjs', 'lib/provider-config.mjs', 'lib/provider-http.mjs', 'lib/provider-protocols.mjs', 'lib/responses-bridge.mjs', 'lib/responses-bridge-codec.mjs', 'lib/access-policy.mjs', 'lib/file-changes.mjs', 'lib/thread-actions.mjs']) {
        if (!existsSync(join(codexLayer.packageDir, path))) fail(`Codex 运行文件缺失：${path}`)
      }
    }
    if (skipped.some((entry) => JSON.stringify(entry).includes('dsh-codex-sidebar'))) fail('dsh-codex-sidebar 被兼容性判定跳过')
  } catch (e) {
    fail(`loadProfileDirectory 抛错：${e.message}`)
  }

  rmSync(profileDir, { recursive: true, force: true })
}

console.log(`\n结论：${failures === 0 ? 'bundle 解析链路全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
