/**
 * 真机验收自检（`plugins/kxxy-host/lib/selftest.mjs`）的单元测试。
 *
 * 被测的是**判定**而不是**采集**：真机上的坏形状在本机大多复现不出来
 * （DNS 黑洞、`/tmp` 不可写、wrapper 缺兄弟文件），只能把"观察到什么 → 得出
 * 什么结论"这段逻辑单独钉住。上一轮鉴权那个事故（桩和实现一起错、测试全绿）
 * 就是判定与采集搅在一起、且谁也没对照真机形状的结果。
 *
 * 采集侧用注入的假实现（`deps`）跑，覆盖：
 *   · 全绿 → ok=true / verdict=pass
 *   · 有失败 → ok=false / note 里点名是哪几条
 *   · 构建机跳过 → skip 不计入失败
 *   · 计数与 items 长度自洽
 *
 * 用法：node tools/test-selftest.mjs
 */

import {
  Level,
  judgeAuth,
  judgeHelpers,
  judgeNdk,
  judgeRaw,
  judgeTmp,
  judgeYarn,
  pathHasDir,
  runSelftest,
} from '../plugins/kxxy-host/lib/selftest.mjs'

let passed = 0
let failed = 0

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

function equal(name, actual, expected) {
  check(name, actual === expected, `实际 ${JSON.stringify(actual)}`)
}

// 全绿的注入环境：真机该有的样子
function greenDeps(over = {}) {
  return {
    home: '/data/user/0/app.kxxy/files/kxxy-home',
    pathEnv: '/system/bin:/data/user/0/app.kxxy/files/kxxy-home/.kxxy/bin',
    platform: 'android',
    authDetail: 'admit:peer',
    gyp: 'android_ndk_path=/data/user/0/app.kxxy/files/kxxy-home/.cache/kxxy-ndk-stub',
    exists: (p) => /cpufeatures$|\.kxxy\/bin$|ghraw$|raw2api$|ndk-stub$/.test(p),
    canExec: () => true,
    probe: () => null,
    lookup: async () => ({ addresses: ['185.199.109.133'], error: null }),
    exec: () => ({ code: 0, out: '1.22.22\n', err: '', error: null }),
    now: () => 1762500000000,
    ...over,
  }
}

// ── 1. 鉴权判定入口 ────────────────────────────────────────────────────
console.log('\n[1] 鉴权判定入口（上次整页「不可用」的那条）')
{
  equal('放行：admit:peer', judgeAuth('admit:peer').status, Level.PASS)
  equal('拒绝 401 也算链路通', judgeAuth('admit:401').status, Level.PASS)
  equal('拒绝 403 也算链路通', judgeAuth('admit:403').status, Level.PASS)
  equal('requestRejection 兜底也通过', judgeAuth('requestRejection:pass').status, Level.PASS)

  equal('服务不在 → 失败', judgeAuth('no-service').status, Level.FAIL)
  equal('服务在但没认得的判定方法 → 失败', judgeAuth('no-verifier').status, Level.FAIL)
  equal('返回形状不对 → 失败', judgeAuth('admit:shape').status, Level.FAIL)
  equal('放行但没给 peer → 失败', judgeAuth('admit:nopeer').status, Level.FAIL)
  equal('判定器抛错 → 失败', judgeAuth('threw:boom').status, Level.FAIL)
  check('threw 的原始信息保留在 detail 里', judgeAuth('threw:boom').detail.includes('boom'))

  equal('init（还没判过）→ 留意而非失败', judgeAuth('init').status, Level.WARN)
  equal('空串 → 留意', judgeAuth('').status, Level.WARN)
  check(
    'no-verifier 的提示说出了正确入口',
    judgeAuth('no-verifier').hint.includes('admit(request)'),
  )
}

// ── 2. yarn ────────────────────────────────────────────────────────────
console.log('\n[2] yarn --version')
{
  const ok = judgeYarn({ code: 0, out: '1.22.22\n', err: '', error: null })
  equal('正常输出 → 通过', ok.status, Level.PASS)
  check('版本号进了 detail', ok.detail.includes('1.22.22'))

  const broken = judgeYarn({
    code: 1,
    out: '',
    err: "Error: Cannot find module '/data/…/extensions/yarn/bin/yarn.js'",
    error: null,
  })
  equal('Cannot find module → 失败', broken.status, Level.FAIL)
  check('detail 带现场的第一行', broken.detail.includes('Cannot find module'))
  check('提示指向「修复命令链接」', broken.hint.includes('修复命令链接'))
  check('提示要求重开终端', broken.hint.includes('重开终端'))

  const other = judgeYarn({ code: 127, out: '', err: 'sh: yarn: not found', error: null })
  equal('找不到命令 → 失败', other.status, Level.FAIL)
  check('127 的提示指向「扩展没装」，不是修复按钮', other.hint.includes('扩展') && !other.hint.includes('修复命令链接'))

  const timedOut = judgeYarn({ code: null, out: '', err: '', error: { code: 'ETIMEDOUT' } })
  equal('超时 → 失败而不是通过', timedOut.status, Level.FAIL)
}

// ── 3. NDK ─────────────────────────────────────────────────────────────
console.log('\n[3] node-gyp 的 android_ndk_path')
{
  const ok = judgeNdk({
    gyp: 'android_ndk_path=/data/…/kxxy-ndk-stub',
    ndkPath: '/data/…/kxxy-ndk-stub',
    dirOk: true,
    featOk: true,
  })
  equal('变量在且目录在 → 通过', ok.status, Level.PASS)
  check('detail 报出实际路径', ok.detail.includes('kxxy-ndk-stub'))

  const noVar = judgeNdk({ gyp: '', dirOk: false, featOk: false })
  equal('变量缺失 → 失败（configure 必挂）', noVar.status, Level.FAIL)
  check('hint 里给出 gyp 的原始报错', noVar.hint.includes('Undefined variable android_ndk_path'))

  const noDir = judgeNdk({ gyp: 'android_ndk_path=/nope', ndkPath: '/nope', dirOk: false })
  equal('变量在但目录不在 → 留意（多数包仍能过）', noDir.status, Level.WARN)

  const appended = judgeNdk({
    gyp: 'foo=1 android_ndk_path=/stub',
    ndkPath: '/stub',
    dirOk: true,
    featOk: false,
  })
  equal('用户已有别的定义时仍能解析到 → 通过', appended.status, Level.PASS)
  check('缺 cpufeatures 时 detail 说明只影响少数包', appended.detail.includes('少数包'))
}

// ── 4. 临时目录 ────────────────────────────────────────────────────────
console.log('\n[4] 临时目录')
{
  const ok = judgeTmp({ dir: '/data/user/0/app.kxxy/cache', error: null, uid: 10234, gid: 10234 })
  equal('能写 → 通过', ok.status, Level.PASS)
  check('uid/gid 作为证据出现在 detail', ok.detail.includes('uid=10234'))

  const bad = judgeTmp({ dir: '/tmp', error: 'EACCES', uid: 10234 })
  equal('写不进去 → 失败', bad.status, Level.FAIL)
  check('detail 带 errno', bad.detail.includes('EACCES'))

  // `/tmp` 字面量写不进去是沙箱边界，不该把整条判红
  const slash = judgeTmp({
    dir: '/data/user/0/app.kxxy/cache',
    error: null,
    slashTmpError: 'EACCES',
    uid: 10234,
  })
  equal('/tmp 不可写但 TMPDIR 可写 → 仍然通过', slash.status, Level.PASS)
  check('并且把「沙箱边界，正常」写在证据里', slash.detail.includes('沙箱边界'))
}

// ── 5. 直链助手 ────────────────────────────────────────────────────────
console.log('\n[5] ghraw / raw2api')
{
  const ok = judgeHelpers({
    dir: '/h/.kxxy/bin',
    files: [
      { name: 'ghraw', exists: true, exec: true },
      { name: 'raw2api', exists: true, exec: true },
    ],
    pathHas: true,
  })
  equal('都在 + 有执行位 + 在 PATH → 通过', ok.status, Level.PASS)

  const missing = judgeHelpers({
    dir: '/h/.kxxy/bin',
    files: [
      { name: 'ghraw', exists: false, exec: false },
      { name: 'raw2api', exists: true, exec: true },
    ],
    pathHas: true,
  })
  equal('缺一个 → 失败', missing.status, Level.FAIL)
  check('点名缺哪个', missing.detail.includes('ghraw'))

  const noexec = judgeHelpers({
    dir: '/h/.kxxy/bin',
    files: [
      { name: 'ghraw', exists: true, exec: false },
      { name: 'raw2api', exists: true, exec: true },
    ],
    pathHas: true,
  })
  equal('没执行位 → 留意（能修）', noexec.status, Level.WARN)

  const noPath = judgeHelpers({
    dir: '/h/.kxxy/bin',
    files: [
      { name: 'ghraw', exists: true, exec: true },
      { name: 'raw2api', exists: true, exec: true },
    ],
    pathHas: false,
  })
  equal('文件在但不在 PATH → 留意', noPath.status, Level.WARN)
  check('说明引擎拉起的终端一定有这条', noPath.hint.includes('EngineConfig'))
}

// ── 6. raw 直链 ────────────────────────────────────────────────────────
console.log('\n[6] raw 直链的 DNS 现状')
{
  const ok = judgeRaw({ addresses: ['185.199.109.133'], error: null })
  equal('正常解析 → 通过', ok.status, Level.PASS)

  const hole = judgeRaw({ addresses: ['0.0.0.0'], error: null })
  equal('0.0.0.0 黑洞 → 留意', hole.status, Level.WARN)
  check('给出 ghraw 这条出路', hole.hint.includes('ghraw'))

  const empty = judgeRaw({ addresses: [], error: null })
  equal('无记录 → 留意', empty.status, Level.WARN)

  const err = judgeRaw({ addresses: [], error: 'ENOTFOUND' })
  equal('解析失败 → 留意', err.status, Level.WARN)
  check('detail 带 errno', err.detail.includes('ENOTFOUND'))

  const loopback = judgeRaw({ addresses: ['127.0.0.1'], error: null })
  equal('指向回环也算黑洞', loopback.status, Level.WARN)
}

// ── 7. 汇总 ────────────────────────────────────────────────────────────
console.log('\n[7] runSelftest 汇总（注入依赖）')
{
  const all = await runSelftest(greenDeps())
  equal('全绿 → ok', all.ok, true)
  equal('全绿 → verdict=pass', all.verdict, 'pass')
  equal('六条都在', all.items.length, 6)
  equal('计数与条目数自洽', all.counts.pass + all.counts.warn + all.counts.fail + all.counts.skip, all.items.length)
  equal('没有失败', all.counts.fail, 0)
  check('note 说的是「全部通过」', all.note.includes('全部通过'))
  equal('at 用注入的时钟', all.at, 1762500000000)
  check('每条都有 id / title / status / detail', all.items.every((i) => i.id && i.title && i.status && 'detail' in i))

  const idOrder = all.items.map((i) => i.id).join(',')
  equal('顺序固定（鉴权在最前）', idOrder, 'AUTH,YARN,NDK,TMP,HELPERS,RAW')

  const broken = await runSelftest(
    greenDeps({
      exec: () => ({ code: 127, out: '', err: 'sh: yarn: not found', error: null }),
      lookup: async () => ({ addresses: ['0.0.0.0'], error: null }),
    }),
  )
  equal('有失败 → ok=false', broken.ok, false)
  equal('有失败 → verdict=fail', broken.verdict, 'fail')
  check('note 点名失败项', broken.note.includes('包管理器命令（yarn）'))
  equal('失败项计数', broken.counts.fail, 1)

  const warned = await runSelftest(
    greenDeps({ lookup: async () => ({ addresses: ['0.0.0.0'], error: null }) }),
  )
  equal('只有留意项 → ok 仍为 true', warned.ok, true)
  equal('只有留意项 → verdict=warn', warned.verdict, 'warn')
  check('note 说明「不影响使用」', warned.note.includes('不影响使用'))

  const skipped = await runSelftest(greenDeps({ platform: 'win32' }))
  equal('构建机上 yarn 跳过', skipped.items.find((i) => i.id === 'YARN').status, Level.SKIP)
  equal('构建机上临时目录跳过', skipped.items.find((i) => i.id === 'TMP').status, Level.SKIP)
  equal('跳过不算失败', skipped.counts.fail, 0)

  // 没有 DSH_HOME 时不能去猜路径（猜错会把用户引到别人的目录上）
  const noHome = await runSelftest(greenDeps({ home: '' }))
  const h = noHome.items.find((i) => i.id === 'HELPERS')
  equal('DSH_HOME 未知 → 助手项失败', h.status, Level.FAIL)
  check('并且不提具体目录', h.detail.includes('$HOME'))
}

// ── 8. PATH 判定 ───────────────────────────────────────────────────────
console.log('\n[8] 目录是否在 PATH 上')
{
  const P = '/data/user/0/app.kxxy/files/kxxy-home/.kxxy/bin'
  equal('posix 精确命中', pathHasDir(`/system/bin:${P}`, P, 'linux'), true)
  equal('结尾斜杠不影响', pathHasDir(`/system/bin:${P}/`, P, 'linux'), true)
  equal('不在里面就是 false', pathHasDir('/system/bin:/usr/bin', P, 'linux'), false)
  equal('空 PATH → false', pathHasDir('', P, 'linux'), false)
  equal('空目录 → false', pathHasDir('/system/bin', '', 'linux'), false)
  equal('反斜杠也认（构建机）', pathHasDir('C:\\a\\bin;D:\\b', 'D:\\b', 'win32'), true)
  equal('windows 用 ; 分隔（不会把盘符当分隔）', pathHasDir('C:\\a;C:\\b', 'C:\\a', 'win32'), true)
}

console.log(`\n真机验收自检测试：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
