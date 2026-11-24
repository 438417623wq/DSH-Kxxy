/**
 * `pydeps@4` 的判据回归：标记什么时候**不再成立**、探针走哪个解释器。
 *
 * 背景（真事故）：v1..v3 的标记只记 `revision` + `status`，于是
 *   · `engine/bin/python3` 探出一次 ok 之后，用户执行
 *     `kxxy-glibc-provision python-ml` 把解释器换成了容器里的 3.12，
 *   · 或者整包升级换了运行时，
 * 标记里那句 `ok` 依然成立，`ensurePythonLibs()` 直接跳过 —— 用户看到的
 * 就是「文档库一整个 import 不到，体检页却写着 ok」。这类错误**运行期完全静默**，
 * 只能靠回归钉住，所以这里逐条测纯函数，不 spawn、不联网、不写标记。
 *
 * 用法：node tools/test-pydeps-probe.mjs
 * 覆盖：
 *   1. REVISION 已推进，`markerMatches` 要求四项全等（任一项变化即失效）；
 *   2. 探针源码：glibc 模式不探 pandas/matplotlib，其余模式连 ML 一起探；
 *   3. `isElf` 只认 ELF 魔数（软链先解析、短文件不误判）；
 *   4. `glibcPythonReady` 判据 = `.kxxy-seed` **且** `usr/bin/python3` 是真 ELF；
 *   5. `effectivePython` 只认引擎根内的 PATH 条目，并按落点给出 glibc/bionic/
 *      dispatcher 三种模式；
 *   6. `runtimeAnchor` 随清单 size/mtime 与 patchset 版本变化。
 *
 * 不验证：真实 pip 安装、Android 上 PATH 的实际内容、SELinux。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __pydepsInternals as P } from '../plugins/kxxy-host/lib/pydeps.mjs'

const work = mkdtempSync(path.join(os.tmpdir(), 'kxxy-pydeps-'))
let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])
const touchElf = (target) => {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, ELF)
  return target
}
const withPath = (value, fn) => {
  const saved = process.env.PATH
  process.env.PATH = value
  try {
    return fn()
  } finally {
    process.env.PATH = saved === undefined ? '' : saved
  }
}
/** PATH 分隔符必须是 `path.delimiter`：宿主是 Windows 时写死 `:` 会拼成一条无效条目。 */
const joinPath = (...dirs) => dirs.join(path.delimiter)

try {
  // ── 1. 标记判据 ─────────────────────────────────────────────────────────
  check('REVISION 已推进到 pydeps@4', P.REVISION === 'pydeps@4', P.REVISION)
  const expect = { revision: P.REVISION, python: '/e/bin/python3', mode: 'bionic', runtime: '12:34/kxxy-patchset@40' }
  const record = { ...expect, status: 'ok' }
  check('四项全等才算成立', P.markerMatches(record, expect) === true)
  for (const field of ['revision', 'python', 'mode', 'runtime']) {
    check(
      `${field} 变了就失效（不能只比 revision）`,
      P.markerMatches({ ...record, [field]: `${record[field]}-changed` }, expect) === false,
    )
  }
  check('解释器换人（mode 不变、路径变）也失效', P.markerMatches({ ...record, python: '/e/glibc/bin/python3' }, expect) === false)
  check('没有标记时不算成立', P.markerMatches(null, expect) === false)
  check('标记缺字段不算成立', P.markerMatches({ revision: P.REVISION }, expect) === false)

  // ── 2. 探针源码 ─────────────────────────────────────────────────────────
  const glibcProbe = P.probeSource('glibc')
  const bionicProbe = P.probeSource('bionic')
  check('glibc 模式不把 pandas 当门槛', !/pandas/.test(glibcProbe), glibcProbe)
  check('glibc 模式不把 matplotlib 当门槛', !/matplotlib/.test(glibcProbe), glibcProbe)
  check('bionic 模式探 pandas', /import pandas/.test(bionicProbe))
  check('bionic 模式探 matplotlib（Agg 后端，无 DISPLAY 也能跑）', /matplotlib\.use\("Agg"\)/.test(bionicProbe))
  check('两条模式的 BASE 探针都在', P.BASE_IMPORTS.every((line) => glibcProbe.includes(line) && bionicProbe.includes(line)))
  check('探针以 print("ok") 收尾', glibcProbe.endsWith('print("ok")') && bionicProbe.endsWith('print("ok")'))

  // ── 3. isElf ────────────────────────────────────────────────────────────
  const elf = touchElf(path.join(work, 'elf', 'python3'))
  const text = path.join(work, 'elf', 'not-elf')
  writeFileSync(text, '#!/system/bin/sh\nexit 0\n')
  const short = path.join(work, 'elf', 'short')
  writeFileSync(short, Buffer.from([0x7f]))
  check('ELF 魔数认作 ELF', P.isElf(elf) === true)
  check('脚本不认作 ELF', P.isElf(text) === false)
  check('不足 4 字节不误判', P.isElf(short) === false)
  check('文件不存在返回 false（不抛）', P.isElf(path.join(work, 'elf', 'nope')) === false)

  // ── 4. glibcPythonReady ─────────────────────────────────────────────────
  const ready = path.join(work, 'ready')
  touchElf(path.join(ready, 'glibc', 'rootfs', 'usr', 'bin', 'python3'))
  mkdirSync(path.join(ready, 'glibc', 'rootfs'), { recursive: true })
  check('没有 .kxxy-seed 就不算就绪', P.glibcPythonReady(ready) === false)
  writeFileSync(path.join(ready, 'glibc', 'rootfs', '.kxxy-seed'), '')
  check('种子 + 真 ELF 才就绪', P.glibcPythonReady(ready) === true)

  const seedOnly = path.join(work, 'seed-only')
  mkdirSync(path.join(seedOnly, 'glibc', 'rootfs'), { recursive: true })
  writeFileSync(path.join(seedOnly, 'glibc', 'rootfs', '.kxxy-seed'), '')
  check('只有种子、没有 /usr/bin/python3 不算就绪', P.glibcPythonReady(seedOnly) === false)

  const linked = path.join(work, 'linked')
  mkdirSync(path.join(linked, 'glibc', 'rootfs'), { recursive: true })
  writeFileSync(path.join(linked, 'glibc', 'rootfs', '.kxxy-seed'), '')
  const linkedElf = touchElf(path.join(linked, 'glibc', 'rootfs', 'usr', 'lib', 'python3.12'))
  try {
    symlinkSync(linkedElf, path.join(linked, 'glibc', 'rootfs', 'usr', 'bin', 'python3'), 'file')
    check('软链到 ELF 也算就绪（先 realpath 再判）', P.glibcPythonReady(linked) === true)
  } catch {
    console.log('SKIP 宿主不允许建软链，跳过 realpath 断言')
  }

  // ── 5. effectivePython ──────────────────────────────────────────────────
  const engine = path.join(work, 'engine')
  const enginePy = touchElf(path.join(engine, 'bin', 'python3'))
  const dispatcherDir = path.join(engine, 'libexec', 'python-default', 'bin')
  const dispatcherPy = path.join(dispatcherDir, 'python3')
  mkdirSync(dispatcherDir, { recursive: true })
  writeFileSync(dispatcherPy, '#!/system/bin/sh\nexec kxxy-glibc python3 "$@"\n')

  const hostOnly = withPath(joinPath('/usr/bin', '/bin'), () => P.effectivePython(engine))
  check('PATH 里没有引擎条目时回退 <root>/bin/python3', hostOnly?.path === enginePy && hostOnly?.mode === 'bionic', JSON.stringify(hostOnly))

  const viaBin = withPath(joinPath(path.join(engine, 'bin'), '/usr/bin'), () => P.effectivePython(engine))
  check('PATH 命中 <root>/bin 判 bionic', viaBin?.mode === 'bionic' && viaBin?.path === enginePy, JSON.stringify(viaBin))

  const stillDispatcher = withPath(joinPath(dispatcherDir, '/usr/bin'), () => P.effectivePython(engine))
  check('容器没就绪时判 dispatcher（不是 glibc）', stillDispatcher?.mode === 'dispatcher', JSON.stringify(stillDispatcher))

  // 容器就绪（种子 + 真 ELF）之后，同一个 dispatcher 落点要翻成 glibc 模式。
  const engineReady = path.join(work, 'engine-ready')
  touchElf(path.join(engineReady, 'glibc', 'rootfs', 'usr', 'bin', 'python3'))
  writeFileSync(path.join(engineReady, 'glibc', 'rootfs', '.kxxy-seed'), '')
  const readyDispatcher = path.join(engineReady, 'libexec', 'python-default', 'bin')
  mkdirSync(readyDispatcher, { recursive: true })
  writeFileSync(path.join(readyDispatcher, 'python3'), '#!/system/bin/sh\nexec kxxy-glibc python3 "$@"\n')
  const asGlibc = withPath(joinPath(readyDispatcher, '/usr/bin'), () => P.effectivePython(engineReady))
  check('容器就绪时判 glibc', asGlibc?.mode === 'glibc', JSON.stringify(asGlibc))

  const outsideOnly = withPath(joinPath('/usr/bin', '/bin'), () => P.effectivePython(path.join(work, 'no-engine')))
  check('引擎根里连 bin/python3 都没有时返回 null', outsideOnly === null, JSON.stringify(outsideOnly))

  const dirCase = path.join(work, 'dir-case')
  mkdirSync(path.join(dirCase, 'bin', 'python3'), { recursive: true })
  const asDir = withPath(path.join(dirCase, 'bin'), () => P.effectivePython(dirCase))
  check('同名目录不被当成解释器', asDir === null, JSON.stringify(asDir))

  // ── 6. runtimeAnchor ────────────────────────────────────────────────────
  const anchored = path.join(work, 'anchored')
  mkdirSync(path.join(anchored, 'lib', 'node_modules', 'kxxy-host'), { recursive: true })
  check('两样都没有时是 unknown', P.runtimeAnchor(anchored) === 'unknown', P.runtimeAnchor(anchored))

  writeFileSync(path.join(anchored, 'kxxy-runtime.json'), '{"entries":[]}')
  const first = P.runtimeAnchor(anchored)
  check('只有清单时也能判等', first !== 'unknown' && /^\d+:\d+$/.test(first), first)

  writeFileSync(path.join(anchored, 'lib', 'node_modules', 'kxxy-host', 'patchset.version'), 'kxxy-patchset@40')
  const withPatch = P.runtimeAnchor(anchored)
  check('补丁集版本进锚', withPatch.endsWith('kxxy-patchset@40') && withPatch !== first, withPatch)
  check('同一份运行时锚稳定', P.runtimeAnchor(anchored) === withPatch)

  writeFileSync(
    path.join(anchored, 'lib', 'node_modules', 'kxxy-host', 'patchset.version'),
    'kxxy-patchset@41',
  )
  check('补丁集涨了就换锚', P.runtimeAnchor(anchored) !== withPatch, P.runtimeAnchor(anchored))

  const beforeReplace = P.runtimeAnchor(anchored)
  writeFileSync(path.join(anchored, 'kxxy-runtime.json'), '{"entries":[],"more":true}')
  const future = new Date(Date.now() + 60_000)
  utimesSync(path.join(anchored, 'kxxy-runtime.json'), future, future)
  check('清单换了（size + mtime）就换锚', P.runtimeAnchor(anchored) !== beforeReplace, P.runtimeAnchor(anchored))
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发占用，忽略 */
  }
}

assert.equal(P.REVISION, 'pydeps@4')
console.log(`\nRESULT ${JSON.stringify({ failures, passed: failures === 0 })}`)
process.exit(failures === 0 ? 0 : 1)
