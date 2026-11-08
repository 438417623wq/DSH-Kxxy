/**
 * 真机验收：把「装完之后要我一个个手敲的验收命令」做成一次点击。
 *
 * ── 为什么需要这个东西 ────────────────────────────────────────────────────
 *
 * 前几轮整改的验收全是**人工命令**：`yarn --version`、`echo $GYP_DEFINES`、
 * `ghraw octocat Hello-World master README`、`npm i microtime` ……每次都要
 * 用户在手机终端里敲一遍，然后把输出贴回来。这有三处浪费：
 *
 *   ① 敲错/敲漏（`$GYP_DEFINES` 在 sh 里没引号会被分词）→ 报上来的现象是假的；
 *   ② 环境不对（用 `adb shell` 而不是**引擎拉起的** shell，PATH 里没有扩展）；
 *   ③ 一次只验一条，四条要来回四轮。
 *
 * 所以这里把可以**在引擎进程内部判定**的那几条收成一个只读的自检：
 * 引擎进程的 env / PATH / 文件系统跟用户在终端里拿到的是一套（都是
 * `EngineConfig.buildEnv` 产出的），由它跑一遍等于让用户在同一环境里敲命令。
 *
 * ── 边界：这里只诊断，不修 ────────────────────────────────────────────────
 *
 * 修的动作各有各的入口（`heal-ext` / `install-ghraw` / `apply-raw-mirror`），
 * 这里**一律不改盘**，只如实报「现在是好是坏、证据是什么、坏了点哪个按钮」。
 * 一个按钮顺手改了四个地方，出问题时没人说得清是哪一步动的。
 *
 * ── 不做什么 ──────────────────────────────────────────────────────────────
 *
 * `npm i <原生包>` 不进自检：它要联网 + 调 node-gyp 编译，几十秒到几分钟，
 * 放在一个按钮后面必然超时，然后被误读成"编译坏了"。那条只能人工跑，
 * 自检只查它的**前置条件**（`GYP_DEFINES` 有没有指对目录）。
 *
 * @module kxxy-host/selftest
 */

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { promises as dnsPromises } from 'node:dns'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { authDetail } from './auth.mjs'
import { HELPER_DIR_REL, HELPERS } from './ghraw.mjs'

/** 单条外部命令的上限。`yarn --version` 正常 200ms 内返回，8s 已经极宽。 */
export const CMD_TIMEOUT_MS = 8000

/** DNS 查询上限（`dns.lookup` 本身没有 timeout 选项，只能自己掐）。 */
export const DNS_TIMEOUT_MS = 3000

/** 自检的严重度。`skip` 不是失败：构建机上跑不了的那几条不该报红。 */
export const Level = {
  PASS: 'pass',
  WARN: 'warn',
  FAIL: 'fail',
  SKIP: 'skip',
}

/**
 * 一条自检结果。
 * @typedef {{id: string, title: string, status: string, detail: string, hint?: string}} Item
 */

function item(id, title, status, detail, hint) {
  return hint ? { id, title, status, detail, hint } : { id, title, status, detail }
}

// ---------------------------------------------------------------------------
// 判定（纯函数：入参是"观察到的现象"，出参是结论）
//
// 拆出来的原因很实际：真机上的坏形状很难在本机复现，判定逻辑一旦和采集
// 写在一起，就只剩"在能跑通的机器上看着它变绿"这一种验证方式 —— 上一轮
// 鉴权那个 bug（桩和实现一起错）就是这么漏出去的。
// ---------------------------------------------------------------------------

/**
 * 鉴权判定入口是否可用。
 *
 * 真机症状：整页「鉴权服务不可用」。那次是因为插件调了服务上不存在的方法，
 * 降级链最后落到 `unavailable`。`authDetail()` 会把**判定路径**吐出来，
 * 所以这里读的是路径本身，而不是页面上的那句人话 —— 上一轮只有「不可用」
 * 三个字，谁也没法判断是服务没注册、接口改名，还是判定器抛错。
 *
 * 通过的形状不止一种：`admit:peer`（放行）、`admit:401/403`（拒绝，但**判定
 * 链路是通的**）都算通过。要报红的是那些"链子断了"的形状：
 * `no-service` / `no-verifier` / `admit:shape` / `admit:nopeer` / `threw:*`。
 *
 * @param {string} detail
 * @returns {Item}
 */
export function judgeAuth(detail) {
  const d = String(detail ?? '')
  if (/^(admit:(peer|401|403|40[0-9]|4[0-9]{2})|requestRejection:pass|isAuthenticated:true)$/.test(d)) {
    return item('AUTH', '鉴权判定入口', Level.PASS, `判定链路正常（${d}）`)
  }
  if (d === 'init') {
    return item(
      'AUTH',
      '鉴权判定入口',
      Level.WARN,
      '这个进程还没判定过任何请求（init）',
      '正常情况下点这个按钮的请求自己就会经过判定链，不会是 init。' +
        '看到 init 说明插件不在真实宿主里跑（或请求绕过了守卫），重开控制台再测一次。',
    )
  }
  if (!d) {
    return item(
      'AUTH',
      '鉴权判定入口',
      Level.WARN,
      '拿不到判定细节（authDetail 为空）',
      '说明这一版插件的诊断代码没跑起来：确认插件版本，必要时重装后重启引擎。',
    )
  }
  return item(
    'AUTH',
    '鉴权判定入口',
    Level.FAIL,
    `判定链没拿到结论（${d}）`,
    '这是「鉴权服务不可用」的成因。dsh-client-connection 的版本可能又变了：' +
      '以 `admit(request)` 返回 {peer} 为准 —— `isAuthenticated` 只在内部 BrowserAuth 上，服务实例没有。',
  )
}

/**
 * `yarn --version` 的实际输出判定。
 *
 * 坏形状（缺陷 EB）：`Cannot find module '…/extensions/…/bin/yarn.js'` ——
 * 命令在 PATH 上，wrapper 却找不到同目录的兄弟文件。修法是 `healExtensions`，
 * 而它只在**扩展目录**上生效，所以这里要给出"点哪个按钮"。
 *
 * @param {{code?: number|null, out?: string, err?: string, error?: Error|null}} r
 * @returns {Item}
 */
export function judgeYarn(r) {
  const out = String(r?.out ?? '').trim()
  const err = String(r?.err ?? '').trim()
  const blob = `${out}\n${err}`
  const ver = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(out)
  if (r?.code === 0 && ver) {
    return item('YARN', '包管理器命令（yarn）', Level.PASS, `yarn ${ver[1]}`)
  }
  const firstLine = (err || out || String(r?.error?.message ?? '没有输出')).split('\n')[0]
  const missingSibling = /Cannot find module/i.test(blob)
  return item(
    'YARN',
    '包管理器命令（yarn）',
    Level.FAIL,
    `yarn --version 失败：${firstLine}`,
    missingSibling
      ? '这是「wrapper 找不到兄弟文件」：点下面的「修复命令链接」（或重启引擎，启动时也会自动修）。' +
        '修完要**重开终端**，已开着的 shell 里 PATH 与命令缓存不会自己刷新。'
      : '点「修复命令链接」试一次；仍失败就导出诊断日志，看这条命令到底解析到了哪个文件。',
  )
}

/**
 * `android_ndk_path` 是否指到一个**存在的**目录。
 *
 * 只需桩目录（真 NDK 的 host 工具链是 linux-x86_64，arm64 手机跑不了），
 * 这个变量只被 common.gypi 用来拼 `-I<(…)/sources/android/cpufeatures`。
 * 目录不存在也能过 configure，但极少数包会真的去 include 那个头文件，
 * 所以「变量指了 + 目录在」才算绿，「变量指了 + 目录不在」报黄。
 *
 * @param {{gyp?: string, ndkPath?: string|null, dirOk?: boolean, featOk?: boolean}} r
 * @returns {Item}
 */
export function judgeNdk(r) {
  const gyp = String(r?.gyp ?? '')
  const m = /android_ndk_path=([^;\s]+)/.exec(gyp)
  if (!m) {
    return item(
      'NDK',
      'node-gyp 的 android_ndk_path',
      Level.FAIL,
      'GYP_DEFINES 里没有 android_ndk_path',
      'node-gyp 加载 binding.gyp 时会报 `Undefined variable android_ndk_path`，一个 .node 都产不出来。' +
        '引擎启动时本应设好这条；缺了说明引擎版本旧了，或用的是外部 shell（重开终端试试）。',
    )
  }
  const p = r?.ndkPath || m[1]
  if (!r?.dirOk) {
    return item(
      'NDK',
      'node-gyp 的 android_ndk_path',
      Level.WARN,
      `指向 ${p}，但该目录不存在`,
      '大多数包只需要这个变量有值就能过 configure；目录也建出来的话更稳。' +
        '重启一次引擎会自动建好桩目录（$HOME/.cache/kxxy-ndk-stub）。',
    )
  }
  return item(
    'NDK',
    'node-gyp 的 android_ndk_path',
    Level.PASS,
    `→ ${p}${r?.featOk ? '（含 sources/android/cpufeatures）' : '（缺 sources/android/cpufeatures，仅影响少数包）'}`,
  )
}

/**
 * 临时目录是否可写。
 *
 * 用户报的是 `/tmp` 不可写：那是沙箱边界（引擎的根只在 App 私有目录里），
 * 不是配置问题 —— 所以**`/tmp` 写不进去不该报红**，只当证据列出来。
 * 真正要保证的是 `TMPDIR`/`os.tmpdir()` 落到的那个目录能写，因为绝大多数
 * 安装脚本用的是它。这里就验这一个。
 *
 * @param {{dir?: string, error?: string|null, code?: string|null, uid?: number|null,
 *          gid?: number|null, slashTmpError?: string|null}} r
 * @returns {Item}
 */
export function judgeTmp(r) {
  const dir = r?.dir || '(未知)'
  const extra = [
    r?.uid != null ? `uid=${r.uid}` : '',
    r?.gid != null ? `gid=${r.gid}` : '',
  ].filter(Boolean).join(' ')
  const slash = r?.slashTmpError ? `；/tmp 不可写（沙箱边界，正常）` : ''
  if (!r?.error) {
    return item(
      'TMP',
      '临时目录可写',
      Level.PASS,
      `${dir} 写入正常${extra ? `（${extra}）` : ''}${slash}`,
    )
  }
  return item(
    'TMP',
    '临时目录可写',
    Level.FAIL,
    `${dir} 写不进去：${r.error}`,
    '安装脚本在这里落临时文件，写不进去会报一堆莫名的 EACCES。' +
      '先确认应用私有目录没被清理工具接管；`TMPDIR` 指向别处时可在 ~/.bashrc 里改回来。',
  )
}

/**
 * `ghraw` / `raw2api` 两个助手的落地情况。
 *
 * 三者都要：文件在、有执行位、目录在 PATH 上。少任何一条用户都会看到
 * `ghraw: not found` 或 `Permission denied`，而这跟"助手没装"是两回事。
 *
 * @param {{dir?: string, files?: Array<{name: string, exists: boolean, exec: boolean}>,
 *          pathHas?: boolean}} r
 * @returns {Item}
 */
export function judgeHelpers(r) {
  const dir = r?.dir || `$HOME/${HELPER_DIR_REL}`
  const files = Array.isArray(r?.files) ? r.files : []
  const missing = files.filter((f) => !f.exists).map((f) => f.name)
  const noexec = files.filter((f) => f.exists && !f.exec).map((f) => f.name)
  if (!files.length || missing.length) {
    return item(
      'HELPERS',
      'GitHub 直链助手',
      Level.FAIL,
      missing.length ? `${dir} 里缺 ${missing.join('、')}` : `${dir} 为空`,
      '点「装 GitHub 直链助手」写入（引擎每次启动也会幂等刷新一次）。',
    )
  }
  if (noexec.length) {
    return item(
      'HELPERS',
      'GitHub 直链助手',
      Level.WARN,
      `${noexec.join('、')} 没有执行位`,
      '点一次「装 GitHub 直链助手」会补上 chmod 755；' +
        `或 chmod +x ${dir}/${noexec[0]}。`,
    )
  }
  if (!r?.pathHas) {
    return item(
      'HELPERS',
      'GitHub 直链助手',
      Level.WARN,
      `助手已就位（${files.map((f) => f.name).join('、')}），但 ${dir} 不在 PATH 上`,
      '引擎拉起的终端一定有这条（EngineConfig 注入）；外部 shell 需要自己加。',
    )
  }
  return item(
    'HELPERS',
    'GitHub 直链助手',
    Level.PASS,
    `${files.map((f) => f.name).join('、')} 就位且在 PATH 上（${dir}）`,
  )
}

/**
 * raw 直链的 DNS 现状。
 *
 * 已核实：本机把 `raw.githubusercontent.com` 解析成 `0.0.0.0`，且用 DoH 拿到
 * 真 IP 后 IP 直连被 reset —— 所以这里**只看 DNS 不够，但 DNS 坏了至少能
 * 直接给出"用 ghraw"这个结论**，不用让用户去猜是网络还是仓库问题。
 *
 * @param {{host?: string, addresses?: string[], error?: string|null}} r
 * @returns {Item}
 */
export function judgeRaw(r) {
  const host = r?.host || 'raw.githubusercontent.com'
  const addrs = Array.isArray(r?.addresses) ? r.addresses.filter(Boolean) : []
  if (r?.error) {
    return item(
      'RAW',
      'raw 直链可达性',
      Level.WARN,
      `${host} 解析失败：${r.error}`,
      '解析都失败时 raw 直链必然不通；用 ghraw 走 api.github.com（不依赖这个域名）。',
    )
  }
  const blackholed = addrs.filter((a) => /^(0\.0\.0\.0|127\.|::1?$|::$)/.test(a))
  if (blackholed.length || !addrs.length) {
    return item(
      'RAW',
      'raw 直链可达性',
      Level.WARN,
      `${host} → ${blackholed.join('、') || '（无记录）'}（被黑洞）`,
      'raw 直链在这台机器上不可用，这属于网络侧，改不了。' +
        '用 `ghraw <raw-url>` 走 api.github.com 取同一份内容；git clone 走的是另一个域名，通常不受影响。',
    )
  }
  return item(
    'RAW',
    'raw 直链可达性',
    Level.PASS,
    `${host} → ${addrs.slice(0, 2).join('、')}`,
  )
}

// ---------------------------------------------------------------------------
// 采集（真机上才跑得动的那一半）
// ---------------------------------------------------------------------------

/** 跑一条命令，绝不抛。超时也算一种结果。 */
function runShell(cmd, cwd, env) {
  try {
    const r = spawnSync('sh', ['-c', cmd], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT_MS,
      cwd: cwd || undefined,
      env: env || process.env,
    })
    const timedOut = r?.error && r.error.code === 'ETIMEDOUT'
    return {
      code: r?.status,
      out: r?.stdout ?? '',
      err: timedOut ? `超时（>${CMD_TIMEOUT_MS}ms）` : (r?.stderr ?? ''),
      error: r?.error ?? null,
    }
  } catch (e) {
    return { code: null, out: '', err: '', error: e }
  }
}

/** 带超时的 DNS 查询，绝不抛。 */
function lookupHost(host) {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve({ addresses: [], error: `超时（>${DNS_TIMEOUT_MS}ms）` })
    }, DNS_TIMEOUT_MS)
    dnsPromises.lookup(host, { all: true }).then(
      (list) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ addresses: (list || []).map((x) => x.address), error: null })
      },
      (e) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ addresses: [], error: e?.code || String(e?.message ?? e) })
      },
    )
  })
}

/**
 * 目录是否在 PATH 上（按平台的分隔符，容忍 `\` 与结尾 `/`）。
 *
 * 拿到构建机上跑时 `join()` 产出的是反斜杠路径，而 PATH 可能写正斜杠、
 * 可能多一个结尾斜杠，分隔符也从 `:` 变成 `;` —— 直接字符串比较会假阴性。
 * 真机上真阴性的概率很低，但一条「只在真机上成立」的判定等于没测过。
 *
 * @param {string} pathEnv
 * @param {string} dir
 * @param {string} [platform]
 * @returns {boolean}
 */
export function pathHasDir(pathEnv, dir, platform = process.platform) {
  if (!pathEnv || !dir) return false
  const sep = platform === 'win32' ? ';' : ':'
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  const want = norm(dir)
  return String(pathEnv)
    .split(sep)
    .some((p) => norm(p) === want)
}

/** 探一次可写：写完就删，不留垃圾。 */
function probeWritable(file) {
  try {
    writeFileSync(file, 'kxxy-probe\n')
    try {
      unlinkSync(file)
    } catch {
      // 删不掉不影响"能写"这个结论
    }
    return null
  } catch (e) {
    return e?.code || String(e?.message ?? e)
  }
}

/**
 * 跑一遍自检。
 *
 * 依赖全部可注入（`deps`），这样构建机上能验判定逻辑，真机上才走真命令 ——
 * 与 `healExtensions` / `installHelpers` 的做法一致。
 *
 * @param {{home?: string, pathEnv?: string, exec?: Function, lookup?: Function,
 *          exists?: Function, canExec?: Function, probe?: Function, now?: Function}} [deps]
 * @returns {Promise<{at: number, ok: boolean, verdict: string, counts: object, items: Item[], note: string}>}
 */
export async function runSelftest(deps = {}) {
  const home = deps.home ?? process.env.DSH_HOME ?? ''
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? ''
  const exists = deps.exists ?? ((p) => existsSync(p))
  const canExec = deps.canExec ?? ((p) => {
    try {
      accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  const probe = deps.probe ?? probeWritable
  const lookup = deps.lookup ?? lookupHost
  const exec = deps.exec ?? runShell
  const now = deps.now ?? Date.now
  const platform = deps.platform ?? process.platform
  const isWin = platform === 'win32'
  const items = []

  // ① 鉴权判定入口 —— 上一版整页「不可用」的那条，最先看
  items.push(judgeAuth(deps.authDetail ?? authDetail()))

  // ② yarn（构建机上是 sh 的语义，npm 包管理器未必装了，跳过而不是报红）
  if (isWin) {
    items.push(item('YARN', '包管理器命令（yarn）', Level.SKIP, '构建机上不判（PATH 与真机不同）'))
  } else {
    items.push(judgeYarn(exec('yarn --version', home)))
  }

  // ③ node-gyp 的 NDK 变量
  const gyp = String(deps.gyp ?? process.env.GYP_DEFINES ?? '')
  const m = /android_ndk_path=([^;\s]+)/.exec(gyp)
  const ndkPath = m ? m[1] : null
  items.push(
    judgeNdk({
      gyp,
      ndkPath,
      dirOk: ndkPath ? exists(ndkPath) : false,
      featOk: ndkPath ? exists(join(ndkPath, 'sources/android/cpufeatures')) : false,
    }),
  )

  // ④ 临时目录（`/tmp` 的字面量单独探一次，只当证据）
  if (isWin) {
    items.push(item('TMP', '临时目录可写', Level.SKIP, '构建机上不判'))
  } else {
    const dir = tmpdir()
    const probeFile = join(dir, `.kxxy-tmp-${randomBytes(4).toString('hex')}`)
    const err = probe(probeFile)
    items.push(
      judgeTmp({
        dir,
        error: err,
        uid: typeof process.getuid === 'function' ? process.getuid() : null,
        gid: typeof process.getgid === 'function' ? process.getgid() : null,
        slashTmpError: probe('/tmp/.kxxy-tmp-probe'),
      }),
    )
  }

  // ⑤ ghraw / raw2api
  const helperDir = home ? join(home, HELPER_DIR_REL) : ''
  const files = HELPERS.map((h) => {
    const p = helperDir ? join(helperDir, h.name) : ''
    const present = Boolean(p) && exists(p)
    return { name: h.name, exists: present, exec: present ? canExec(p) : false }
  })
  items.push(
    judgeHelpers({
      dir: helperDir || undefined,
      files,
      pathHas: Boolean(helperDir) && pathHasDir(pathEnv, helperDir, platform),
    }),
  )

  // ⑥ raw 直链的 DNS 现状
  const raw = await lookup('raw.githubusercontent.com')
  items.push(judgeRaw({ host: 'raw.githubusercontent.com', ...raw }))

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const it of items) {
    if (counts[it.status] != null) counts[it.status] += 1
  }
  const ok = counts.fail === 0
  const verdict = counts.fail ? 'fail' : counts.warn ? 'warn' : 'pass'
  const note = ok
    ? counts.warn
      ? `${counts.pass} 项通过，${counts.warn} 项需要留意（不影响使用，逐条看提示）`
      : '全部通过'
    : `${counts.fail} 项失败：${items.filter((i) => i.status === Level.FAIL).map((i) => i.title).join('、')}`

  return { at: now(), ok, verdict, counts, items, note }
}
