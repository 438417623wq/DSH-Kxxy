/**
 * 客户端插件兼容补丁的契约测试。
 *
 * 这两条补丁都是为了同一件事：**装了不兼容的插件，对话页也不该整页停摆**。
 * 它们改的是压缩产物的文本，靠肉眼看 diff 无法判断「改完还能不能跑」，所以
 * 把三件事钉在这里：
 *
 *   [1] 别名补丁真的插进了加载器的种子表构造点，且指到 store 种子
 *   [2] 别名补丁幂等（重跑一次不会插两遍）
 *   [3] 降级补丁改写后的前端 boot 汇总语句**仍能通过语法检查**
 *   [4] 改写后的判定语义正确：第三方插件失败只告警、官方包失败仍然抛错
 *   [5] 改完的前端主 chunk 仍是合法的 ESM（`node --check`）
 *
 * 为什么不直接跑真机：这条链路在 WebView 里，触发需要装一个坏插件 + 重启引擎；
 * 而补丁的全部风险都在「文本替换后代码还成不成立」，vm 里跑一遍就够。
 *
 * 用法：node tools/test-client-compat.mjs [runtime.zip]
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { openZip } from './lib/zipread.mjs'
import { openAsar } from './lib/registry.mjs'
import { createPatchContext, patchClientRuntimeAlias, patchFrontendLenientBoot } from './lib/patches.mjs'

let pass = 0
let fail = 0

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const here = fileURLToPath(new URL('.', import.meta.url))
const CANDIDATES = [
  process.argv[2],
  join(here, '..', '.cache', 'apk-assets-hold', 'runtime.zip'),
  join(here, '..', 'android', 'app', 'src', 'main', 'assets', 'runtime.zip'),
].filter(Boolean)

const CLIENT_MODULES = 'lib/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js'
const FE_PREFIX = 'lib/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/'

/**
 * 参照物优先取 `.cache/app.asar`（未打补丁的原始产物）。
 *
 * `runtime.zip` 是 build-runtime 的**产物**，里面已经跑过 applyAllPatches ——
 * 拿它当「打补丁前」的样本，「上游本体里没有别名记号」这条断言就永远为假，
 * 而失败信息会把人引向「补丁坏了」这个错误结论。app.asar 才是补丁的真正输入。
 */
const asarPath = join(here, '..', '.cache', 'app.asar')
const useAsar = !process.argv[2] && existsSync(asarPath)

let files
if (useAsar) {
  console.log(`参照物：${asarPath}（未打补丁）`)
  const asar = openAsar(asarPath)
  files = new Map()
  files.set(CLIENT_MODULES, {
    data: asar.readFile('/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js'),
    mode: 0o644,
  })
  asar.walkFiles('/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets', (p) => {
    if (!/\/index-[^/]+\.js$/.test(p)) return
    files.set(`${FE_PREFIX}${p.split('/').pop()}`, { data: asar.readFile(p), mode: 0o644 })
  })
} else {
  const zipPath = CANDIDATES.find((p) => existsSync(p))
  if (!zipPath) {
    console.error('找不到 runtime.zip 或 .cache/app.asar：先跑一次 tools/build-runtime.mjs')
    process.exit(2)
  }
  console.log(`运行时：${zipPath}`)
  const zip = openZip(zipPath)
  const allNames = zip.names()

  /** 只把补丁要用到的条目喂进内存表（整棵树上万文件，没必要全读）。 */
  files = new Map()
  for (const name of allNames) {
    if (!(name === CLIENT_MODULES || (name.startsWith(FE_PREFIX) && /\/index-[^/]+\.js$/.test(name)))) continue
    const data = zip.read(name)
    if (!data) continue
    files.set(name, { data, mode: 0o644 })
  }
}

ok('取到加载器本体', files.has(CLIENT_MODULES))
const feKey = [...files.keys()].find((k) => /\/index-[^/]+\.js$/.test(k))
ok('取到前端主 chunk', Boolean(feKey), feKey ?? '(缺)')

const ctx = createPatchContext(files)

// ── [1] 别名补丁 ────────────────────────────────────────────────────────
console.log('[1] 客户端运行时总包别名')
const before = ctx.read('@deepseek-ai/dsh-client-modules/lib/client.js')
ok('上游本体里没有别名记号', !before.includes('KXXY_CLIENT_RUNTIME_ALIAS'))
const r1 = patchClientRuntimeAlias(ctx)
ok('补丁报告成功', /别名/.test(r1), r1)

const after = ctx.read('@deepseek-ai/dsh-client-modules/lib/client.js')
const anchorIdx = after.indexOf('this.seed = new Map(Object.entries(options.staticModules));')
ok('种子表构造行还在', anchorIdx >= 0)
ok('别名插在构造行之后', after.indexOf('KXXY_CLIENT_RUNTIME_ALIAS') > anchorIdx)
ok(
  '别名指向 store 种子',
  after.includes('["@deepseek-ai/dsh-client-runtime/client","@deepseek-ai/dsh-client-store"]'),
)
ok('只改 seed 表，不动解析逻辑', after.includes('missed the module table'))

// 语法：加载器是普通脚本（window.__ModuleLoader__.load({...})），编译一遍即可。
try {
  new vm.Script(after, { filename: 'client-modules.client.js' })
  ok('改完的加载器能通过语法检查', true)
} catch (e) {
  ok('改完的加载器能通过语法检查', false, e.message)
}

// ── [2] 幂等 ────────────────────────────────────────────────────────────
console.log('[2] 幂等')
const r2 = patchClientRuntimeAlias(ctx)
ok('重跑一次不重复插入', /已打过/.test(r2), r2)
const aliasCount = (ctx.read('@deepseek-ai/dsh-client-modules/lib/client.js').match(/KXXY_CLIENT_RUNTIME_ALIAS/g) ?? []).length
ok('记号只出现一次', aliasCount === 1, `got ${aliasCount}`)

// ── [3] 降级补丁 ────────────────────────────────────────────────────────
console.log('[3] 前端 boot 降级')
const r3 = patchFrontendLenientBoot(ctx)
ok('补丁报告成功', /降级/.test(r3), r3)

const feInfo = [...files.entries()].find(([k]) => /\/index-[^/]+\.js$/.test(k))
const fe = feInfo[1].data.toString('utf8')
ok('写入「已跳过」措辞（体检与原生落盘都认它）', fe.includes('failed and were skipped'))
ok('官方包仍然硬失败', fe.includes('did not activate'))
ok('不再无条件抛错', /if\(kxxyFatal\.length>0\)throw new Error\("web boot: "/.test(fe))

console.log('[4] 降级判定语义')
// 把生成的三个语句抠出来，在 vm 里用假数组跑一遍：
//   · 第三方插件 → 只告警
//   · 官方包     → 抛错
const snippetMatch = /const kxxyFatal=(\w+)\.filter[\s\S]*?\);(\s*if\(kxxyFatal[\s\S]*?\);)(\s*if\(\1\.length>0\)console\.warn[\s\S]*?\)\);)/.exec(fe)
ok('抠出改写后的判定片段', snippetMatch !== null)
if (snippetMatch) {
  const id = snippetMatch[1]
  const body = `${snippetMatch[0]}`
  const warned = []
  const run = new vm.Script(`(function(${id}){${body}})`)
  const fn = run.runInNewContext({ console: { warn: (m) => warned.push(String(m)) } })

  let threw = null
  try {
    fn(['@neystan/dsh-pet: import failed: client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table'])
  } catch (e) {
    threw = e
  }
  ok('第三方插件失败不抛错', threw === null, threw && threw.message)
  ok('第三方插件失败有告警', warned.length === 1 && /were skipped/.test(warned[0]), JSON.stringify(warned))
  ok('告警里带包名（插件页/体检据此归因）', warned[0].includes('@neystan/dsh-pet'))

  threw = null
  warned.length = 0
  try {
    fn(['@deepseek-ai/dsh-client-ui-chat: failed'])
  } catch (e) {
    threw = e
  }
  ok('官方包失败仍然抛错', threw !== null && /did not activate/.test(threw.message), threw ? threw.message : '(没抛)')
  ok('官方包失败不再走告警', warned.length === 0)

  threw = null
  try {
    fn(['@neystan/dsh-pet: failed', '@deepseek-ai/dsh-client-ui-chat: pending (waiting for service: uiSlots)'])
  } catch (e) {
    threw = e
  }
  ok('混合失败时官方包那一档仍然致命', threw !== null && !threw.message.includes('@neystan'), threw && threw.message)
}

// ── [5] 改完的前端 chunk 仍是合法 ESM ───────────────────────────────────
console.log('[5] 产物语法')
const tmp = mkdtempSync(join(tmpdir(), 'kxxy-fe-'))
try {
  const f = join(tmp, 'index.mjs')
  writeFileSync(f, fe)
  execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  ok('前端主 chunk 通过 node --check', true)
} catch (e) {
  ok('前端主 chunk 通过 node --check', false, String(e.stderr || e.message).slice(0, 200))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// 幂等重跑
const r4 = patchFrontendLenientBoot(ctx)
ok('降级补丁幂等', /已打过/.test(r4), r4)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
