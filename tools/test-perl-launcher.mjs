/**
 * `bin/perl` launcher 回归：安装期写成 wrapper、自愈时不退回软链、运行期按盘重算
 * PERL5LIB。
 *
 * 背景：`PERL5LIB` 是引擎启动时算好的快照，而 exiftool 这类扩展是启动后才装的；
 * 只靠 `.bashrc`（kxxy-shell@8）覆盖不到 execve 直呼 `$PREFIX/bin/perl` 的路径。
 *
 * 用法：node tools/test-perl-launcher.mjs
 * 覆盖：
 *   1. buildViews 把 `<root>/bin/perl` 写成 wrapper（普通文件 + 标记 + 可执行位）；
 *   2. relinkAll 保留 wrapper，不会换回软链；
 *   3. wrapper 被删掉后 relinkAll 能重建（依赖 .links.json 的 bins 记录）；
 *   4. wrapper 自己算出的 PERL5LIB 覆盖**装完之后才有**的 site_perl/<ver>；
 *   5. `sh -n` 语法自检（宿主没有 sh 时跳过）。
 *
 * 不验证：真实 perl 的 @INC 行为、Android 上的可执行位恢复。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildViews, relinkAll } from '../plugins/kxxy-host/lib/extinstall.mjs'

const MARKER = 'KXXY_PERL5LIB_WRAPPER'
const work = mkdtempSync(path.join(os.tmpdir(), 'kxxy-perl-launcher-'))
const root = path.join(work, 'engine')
const home = path.join(work, 'home')
mkdirSync(home, { recursive: true })
let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

try {
  // ── 夹具：perl 扩展 + 启动后才装出来的 exiftool 模块目录 ─────────────────
  const perlExt = path.join(root, 'extensions', 'perl')
  mkdirSync(path.join(perlExt, 'bin'), { recursive: true })
  writeFileSync(path.join(perlExt, 'bin', 'perl'), '#!/system/bin/sh\nexit 0\n')
  mkdirSync(path.join(root, 'lib', 'perl5', '5.44.0'), { recursive: true })
  mkdirSync(path.join(root, 'extensions', 'exiftool', 'lib', 'perl5', 'site_perl', '5.44.0', 'Image'), { recursive: true })

  buildViews(root, 'perl', perlExt)
  const target = path.join(root, 'bin', 'perl')
  const text = readFileSync(target, 'utf8')

  check('bin/perl 是普通文件而非软链', existsSync(target) && !lstatSync(target).isSymbolicLink())
  check('带 KXXY_PERL5LIB_WRAPPER 标记', text.includes(MARKER))
  check('会扫 extensions/*/lib/perl5', text.includes('"$root"/extensions/*/lib/perl5'))
  check('跳过自己所在目录（防 exec 递归）', text.includes('self=$(cd "$d" && pwd)'))

  // ── 自愈：保留 wrapper、删掉后能重建 ────────────────────────────────────
  writeFileSync(
    path.join(perlExt, '.links.json'),
    JSON.stringify({ bins: [{ name: 'perl', target, src: path.join(perlExt, 'bin', 'perl') }], libs: [], views: [] }),
  )
  writeFileSync(path.join(root, 'extensions', '.relink'), '1')
  relinkAll(root)
  check('relinkAll 不把 wrapper 换回软链', !lstatSync(target).isSymbolicLink() && readFileSync(target, 'utf8').includes(MARKER))

  unlinkSync(target)
  relinkAll(root)
  check('wrapper 被删后 relinkAll 能重建', existsSync(target) && readFileSync(target, 'utf8').includes(MARKER))

  // 旧设备升级场景：target 原先是指向真 perl 二进制的软链，relinkAll 替换成 wrapper 时不得沿软链覆写真身。
  const realPerl = path.join(perlExt, 'bin', 'perl')
  const originalRealPerl = readFileSync(realPerl, 'utf8')
  try {
    unlinkSync(target)
    symlinkSync(realPerl, target, 'file')
    writeFileSync(path.join(root, 'extensions', '.relink'), '1')
    relinkAll(root)
    check('旧软链被 relinkAll 替换成普通 wrapper', existsSync(target) && !lstatSync(target).isSymbolicLink() && readFileSync(target, 'utf8').includes(MARKER))
    check('旧软链被替换时不覆写真 perl 二进制', readFileSync(realPerl, 'utf8') === originalRealPerl)
  } catch {
    console.log('SKIP 宿主不允许建软链，跳过旧软链防穿透覆写断言')
  }

  // ── 运行期：按磁盘现状重算 PERL5LIB ────────────────────────────────────
  const cut = text.slice(0, text.indexOf('# 真身'))
  const probe = path.join(work, 'probe.sh')
  writeFileSync(probe, `${cut}\nprintf "%s\\n" "$PERL5LIB"\n`)
  let shAvailable = true
  let computed = ''
  try {
    computed = execFileSync('sh', [probe], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, KXXY_ENGINE_ROOT: root, PERL5LIB: '/opt/agent-owned/perl' },
    })
  } catch (error) {
    shAvailable = false
    console.log(`SKIP sh 不可用，跳过运行期断言（${String(error?.message ?? error).slice(0, 80)}）`)
  }
  if (shAvailable) {
    // 宿主是 Windows 时路径分隔符与 shell 输出不一致，比较前统一成正斜杠。
    const norm = (value) => value.replace(/\\/g, '/')
    const entries = computed.trim().split(':').map(norm)
    check('包含 engine 的版本目录', entries.some((p) => p.endsWith(norm(path.join('lib', 'perl5', '5.44.0')))), computed)
    check(
      '包含启动后才装出来的 site_perl/5.44.0',
      entries.some((p) => p.endsWith(norm(path.join('exiftool', 'lib', 'perl5', 'site_perl', '5.44.0')))),
      computed,
    )
    check('保留用户自己的 PERL5LIB 条目', entries.includes('/opt/agent-owned/perl'), computed)
    check(
      'local::lib 不看存在性（目录尚未由 cpan 创建）',
      entries.some((p) => p.endsWith(norm(path.join('.perl5', 'lib', 'perl5', 'aarch64-android')))),
      computed,
    )
    execFileSync('sh', ['-n', probe], { stdio: 'pipe' })
    check('sh -n 语法自检通过', true)
  }
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* Windows 上偶发占用，忽略 */ }
}

console.log(`\nRESULT ${JSON.stringify({ failures, passed: failures === 0 })}`)
process.exit(failures === 0 ? 0 : 1)
