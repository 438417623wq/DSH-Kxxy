#!/usr/bin/env node
/**
 * 固定签名：用仓库内的 kxxy-signing.jks 给 APK 签名，并**硬校验**证书指纹。
 *
 * ── 为什么要有这个脚本（真实事故）──────────────────────────────────────────
 *
 * 用户原话：「能不能固定签名啊，换了几次了，每次要卸载」。
 *
 * 根因是 `build-apk.ps1` 第 6 步用的是
 *
 *     $ks = "$env:USERPROFILE\.android\debug.keystore"
 *
 * 那是 AGP 在缺失时**自动生成**的一次性密钥（密码固定 `android`、别名
 * `androiddebugkey`）—— 每台机器、每个 Windows 用户各一份。换构建机、换用户、
 * 清了 `%USERPROFILE%`，都会得到一把新钥匙，设备上于是报
 *
 *     INSTALL_FAILED_UPDATE_INCOMPATIBLE:
 *     Package app.kxxy signatures do not match previously installed version
 *
 * 这条错误**没有绕过手段**（版本号降级还能 `adb install -d` 硬压，签名不符不行），
 * 只能卸载 —— 而卸载会连 `/data/data/app.kxxy/` 下的引擎、713 MiB 运行时、
 * 会话、已装扩展一起删掉。
 *
 * ── 这个脚本做的四件事 ─────────────────────────────────────────────────────
 *
 *   1. 从 `android/keystore/kxxy-signing.properties` 读密钥（**唯一事实源**，
 *      gradle 的 signingConfigs 读的是同一份）；
 *   2. 找一个可用的 apksigner：SDK build-tools 优先，否则用仓库内自带的
 *      `tools/prebuilt/apksigner/apksigner.jar`（`java -jar`）——
 *      **不依赖本机装过 Android SDK**，这正是换机器不再出事的另一半；
 *   3. 签完立刻 `verify --print-certs`，把实际证书 SHA-256 与 properties 里的
 *      `certSha256` 比对，不等就直接抛错；
 *   4. 若目标路径上已存在上一次的产物，再比一次**新旧指纹**，不一致时打印
 *      「这次装上去需要先卸载」，把事故提前到构建期可见（而不是到手机上）。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────────
 *
 *   node tools/sign-apk.mjs --in app-aligned.apk --out app-signed.apk
 *   node tools/sign-apk.mjs --print app-signed.apk          # 只打印证书指纹
 *   node tools/sign-apk.mjs --check app-signed.apk          # 断言指纹与仓库一致
 *
 * 退出码：0 成功；1 失败（含指纹不符）；2 参数错误。
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolve(HERE, '..')
const KEYSTORE_DIR = join(PROJECT, 'android', 'keystore')
const PROPS_FILE = join(KEYSTORE_DIR, 'kxxy-signing.properties')
const VENDORED_JAR = join(PROJECT, 'tools', 'prebuilt', 'apksigner', 'apksigner.jar')

function die(msg, code = 1) {
  process.stderr.write(`sign-apk: ${msg}\n`)
  process.exit(code)
}

function note(msg) {
  process.stdout.write(`${msg}\n`)
}

function human(n) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(2)} MiB`
  return `${(n / 1073741824).toFixed(2)} GiB`
}

//#region 参数

function parseArgs(argv) {
  const opts = { in: null, out: null, print: null, check: null, apksigner: null, java: null, quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--in') opts.in = resolve(argv[++i])
    else if (a === '--out') opts.out = resolve(argv[++i])
    else if (a === '--print') opts.print = resolve(argv[++i])
    else if (a === '--check') opts.check = resolve(argv[++i])
    else if (a === '--apksigner') opts.apksigner = resolve(argv[++i])
    else if (a === '--java') opts.java = resolve(argv[++i])
    else if (a === '--quiet') opts.quiet = true
    else if (a === '-h' || a === '--help') {
      note(
        [
          'sign-apk —— 用仓库内固定密钥签名 APK',
          '',
          '  --in <apk> --out <apk>   签名（输入通常是对齐后的 app-aligned.apk）',
          '  --print <apk>            只打印证书 SHA-256 / SHA-1 / DN',
          '  --check <apk>            断言该 APK 的证书与 kxxy-signing.properties 一致',
          '  --apksigner <path>       指定 apksigner（.bat 或 .jar）',
          '  --java <path>            指定 java.exe（用 jar 形态时需要）',
        ].join('\n'),
      )
      process.exit(0)
    } else die(`未知参数：${a}`, 2)
  }
  return opts
}

//#endregion

//#region 配置

/** 读 `kxxy-signing.properties`：`key=value`，`#` 起注释，忽略空行。 */
function readSigningConfig() {
  if (!existsSync(PROPS_FILE)) {
    die(
      `找不到固定签名配置 ${PROPS_FILE}\n` +
        '  本项目的签名密钥随仓库分发（android/keystore/），请确认检出完整：\n' +
        '    git checkout -- android/keystore/\n' +
        '  绝不要临时用 keytool 生成一个新的 —— 那会让所有已装设备无法覆盖升级。',
    )
  }
  const out = {}
  for (const raw of readFileSync(PROPS_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue
    const at = line.indexOf('=')
    if (at < 0) continue
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  for (const key of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword', 'certSha256']) {
    if (!out[key]) die(`${PROPS_FILE} 缺少字段 ${key}`)
  }
  out.storePath = resolve(KEYSTORE_DIR, out.storeFile)
  if (!existsSync(out.storePath)) {
    die(
      `固定签名密钥不存在：${out.storePath}\n` +
        '  它是入库文件，检出缺失请 git checkout -- android/keystore/；' +
        '不要重新生成（见 android/keystore/README.md）。',
    )
  }
  // 指纹统一成小写无冒号，方便与 apksigner 输出直接比对。
  out.certSha256 = out.certSha256.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  if (out.certSha256.length !== 64) {
    die(`certSha256 不是 64 位十六进制（去掉冒号后 ${out.certSha256.length} 位）`)
  }
  return out
}

//#endregion

//#region 工具链探测

function firstExisting(paths) {
  for (const p of paths) if (p && existsSync(p)) return p
  return null
}

/** 从 local.properties / 环境变量找 SDK 根。 */
function findSdkRoot() {
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
  const localProps = join(PROJECT, 'android', 'local.properties')
  if (existsSync(localProps)) {
    const m = /^sdk\.dir\s*=\s*(.+)$/m.exec(readFileSync(localProps, 'utf8'))
    if (m) candidates.push(m[1].trim().replace(/\\\\/g, '\\').replace(/\\([:\s])/g, '$1'))
  }
  candidates.push('C:\\KF\\fbtools\\sdk')
  for (const root of candidates) {
    if (root && existsSync(join(root, 'build-tools'))) return root
  }
  return null
}

/** build-tools 里版本最高的那一项（按目录名里的数字段比较）。 */
function highestBuildToolsDir() {
  const sdk = findSdkRoot()
  if (!sdk) return null
  const btRoot = join(sdk, 'build-tools')
  const names = readdirSync(btRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => {
      const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
      const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0)
        if (d !== 0) return d
      }
      return 0
    })
    .reverse()
  for (const name of names) {
    const dir = join(btRoot, name)
    if (existsSync(join(dir, 'apksigner.bat')) || existsSync(join(dir, 'lib', 'apksigner.jar'))) {
      return { name, dir }
    }
  }
  return null
}

/**
 * 定位 apksigner。
 *
 * 顺序：显式指定 → **java + apksigner.jar** → `.bat` 兜底。
 *
 * 为什么把 jar 放在 .bat 前面（这是实测踩出来的，不是洁癖）：
 *   · Node 18+ 直接 spawn `.bat` 会抛 `EINVAL`（CVE-2024-27980 之后的硬限制）；
 *   · 改走 `cmd /c` 又撞第二层：spawnSync 不用 shell 时会把参数里的引号转义成
 *     `\"`，cmd 于是把 `\"C:\…\apksigner.bat\"` 当成一个不存在的命令名；
 *   · 而且 `apksigner.bat` 自己还要 `JAVA_HOME`（实测未设时报
 *     `ERROR: JAVA_HOME is not set and no 'java' command could be found`）。
 * 三条叠起来，`java -jar apksigner.jar` 反而是唯一没有环境依赖的形态 ——
 * 参数是干净的数组、不需要 shell、也不需要 JAVA_HOME（我们直接给 java.exe 路径）。
 *
 * jar 的来源同样按优先级：SDK build-tools 的 `lib/apksigner.jar`（跟着 SDK 升级）
 * → 仓库自带 `tools/prebuilt/apksigner/apksigner.jar`（换机器也能签）。
 */
function resolveApksigner(opts) {
  const explicit = firstExisting([opts.apksigner, process.env.KXXY_APKSIGNER])
  if (explicit) {
    return explicit.toLowerCase().endsWith('.jar')
      ? { kind: 'jar', path: explicit }
      : { kind: 'bat', path: explicit }
  }

  const java = findJava(opts.java)
  if (java) {
    const bt = highestBuildToolsDir()
    const sdkJar = bt ? join(bt.dir, 'lib', 'apksigner.jar') : null
    if (sdkJar && existsSync(sdkJar)) return { kind: 'jar', path: sdkJar, source: `SDK build-tools ${bt.name}` }
    if (existsSync(VENDORED_JAR)) return { kind: 'jar', path: VENDORED_JAR, source: '仓库自带' }
  }

  // 没有 java 时才退到 .bat（它自己会去找 java；找不到会报 JAVA_HOME）。
  const bt = highestBuildToolsDir()
  if (bt && existsSync(join(bt.dir, 'apksigner.bat'))) {
    return { kind: 'bat', path: join(bt.dir, 'apksigner.bat'), source: `SDK build-tools ${bt.name}` }
  }

  die(
    '找不到可用的 apksigner。试过的路径：\n' +
      '  · --apksigner / KXXY_APKSIGNER 环境变量\n' +
      `  · SDK build-tools（SDK 根：${findSdkRoot() ?? '未找到'}）\n` +
      `  · 仓库自带 ${VENDORED_JAR}\n` +
      '  仓库自带那份缺失时，从 Termux 的 apksigner deb 里取：\n' +
      '    .cache/debs/apksigner_*_all.deb → data.tar.xz → usr/share/java/apksigner.jar\n' +
      '  也可以直接给 java：--java <java.exe> 或设 JAVA_HOME / KXXY_JAVA。',
  )
  return null
}

/** java.exe：KXXY_JAVA → JAVA_HOME → 常见安装位置 → PATH。 */
function findJava(explicit) {
  const direct = firstExisting([
    explicit,
    process.env.KXXY_JAVA,
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java.exe') : null,
    'C:\\KF\\fbtools\\jdk\\bin\\java.exe',
  ])
  if (direct) return direct

  // 常见安装位置：IDE 自带的 JBR、`~/.jdks`（IDEA 下载的 JDK）、Adoptium、
  // 以及 KXXY_JDK_ROOTS 显式列出的目录（分号分隔，每个下面按「子目录/bin/java.exe」找）。
  // 刻意**不**扫描整盘：那是分钟级操作，而这条路径只是「顺手找一下」。
  const extraRoots = (process.env.KXXY_JDK_ROOTS ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  const roots = [
    ...extraRoots,
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Android Studio', 'jbr'),
    'C:\\Program Files\\Android\\Android Studio\\jbr',
    join(process.env.USERPROFILE ?? '', '.jdks'),
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
  ]
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    if (root.toLowerCase().endsWith('.exe')) {
      if (existsSync(root)) return root
      continue
    }
    // root 本身就是 JDK 根（…/jbr）时先直接试一次
    const direct = join(root, 'bin', 'java.exe')
    if (existsSync(direct)) return direct
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const cand = join(root, d.name, 'bin', 'java.exe')
      if (existsSync(cand)) return cand
    }
  }
  // 最后交给 PATH：用 `where java` 取真实路径，避免把 shell 内建当成文件。
  const where = spawnSync('where.exe', ['java'], { encoding: 'utf8' })
  if (where.status === 0) {
    const first = where.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (first && existsSync(first)) return first
  }
  return null
}

//#endregion

//#region 调用 apksigner

function runApksigner(tool, java, args, { quiet = false } = {}) {
  const isJar = tool.kind === 'jar'
  if (isJar && !java) {
    die(
      `需要用 java -jar 运行 ${tool.path}，但找不到 java.exe。\n` +
        '  用 --java 指定，或设 JAVA_HOME / KXXY_JAVA。',
    )
  }

  let file
  let argv
  if (isJar) {
    file = java
    argv = ['-jar', tool.path, ...args]
  } else {
    // ⚠️ `.bat` 不能直接 spawn：Node 18+ 对 Windows 批处理文件的 spawn 会抛
    // `EINVAL`（CVE-2024-27980 之后的硬限制，必须显式走 shell）。而 `shell:true`
    // 下 Node 只是把 argv 用空格拼起来，**带空格的路径会被拆成两个参数** ——
    // 本仓库路径里就有空格（`dsh kxxy`），所以这里自己拼一条 cmd 命令行并逐项加引号。
    // 用 `cmd.exe /d /s /c ""<bat>" <args>"` 这个形态：`/s` + 外层一对引号是
    // cmd 官方推荐的「保留内层引号」写法。
    const quote = (s) => (/[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
    const line = [quote(tool.path), ...args.map(quote)].join(' ')
    file = process.env.COMSPEC || 'cmd.exe'
    argv = ['/d', '/s', '/c', `"${line}"`]
  }

  const r = spawnSync(file, argv, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  if (r.error) die(`启动 apksigner 失败：${r.error.message}`)
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (!quiet && text.trim() !== '') process.stdout.write(text)
  return { status: r.status, text }
}

/** 从 `apksigner verify --print-certs` 的输出里取三个指纹。 */
function parseCerts(text) {
  const grab = (label) => {
    const m = new RegExp(`${label}[^:]*:\\s*([0-9a-fA-F:]+)`, 'i').exec(text)
    return m ? m[1].replace(/[^0-9a-fA-F]/g, '').toLowerCase() : null
  }
  const dn = /certificate DN:\s*(.+)/i.exec(text)
  return {
    sha256: grab('SHA-256 digest'),
    sha1: grab('SHA-1 digest'),
    dn: dn ? dn[1].trim() : null,
    v1: /Verified using v1 scheme[^:]*:\s*(true|false)/i.exec(text)?.[1] ?? null,
    v2: /Verified using v2 scheme[^:]*:\s*(true|false)/i.exec(text)?.[1] ?? null,
  }
}

function printCerts(apk, tool, java) {
  if (!existsSync(apk)) die(`找不到 APK：${apk}`)
  // `-v` 与 `--print-certs` 必须一起给：只给 --print-certs 时输出里**没有**
  // v1/v2 那几行（实测 apksigner 0.9），而 v2 是否生效是本项目的硬要求
  // （targetSdk=28，见 build.gradle.kts 的 signingConfigs）。
  const r = runApksigner(tool, java, ['verify', '-v', '--print-certs', apk], { quiet: true })
  const certs = parseCerts(r.text)
  if (!certs.sha256) {
    die(`读不出证书指纹（apksigner exit ${r.status}）：\n${r.text.trim()}`)
  }
  return certs
}

function formatSha256(hex) {
  return (hex.match(/.{2}/g) ?? []).join(':').toUpperCase()
}

//#endregion

//#region 主流程

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const cfg = readSigningConfig()
  const tool = resolveApksigner(opts)
  const java = tool.kind === 'jar' ? findJava(opts.java) : null

  if (!opts.quiet) {
    note(`  keystore  = ${cfg.storePath}`)
    note(`  alias     = ${cfg.keyAlias}`)
    note(`  期望指纹  = ${formatSha256(cfg.certSha256)}`)
    const via = tool.source ? `（${tool.source}）` : ''
    note(`  apksigner = ${tool.kind === 'jar' ? `${java} -jar ${tool.path}` : tool.path}${via}`)
  }

  // ── --print / --check：只读 ───────────────────────────────────────────
  if (opts.print || opts.check) {
    const apk = opts.print ?? opts.check
    const certs = printCerts(apk, tool, java)
    note(`  APK       = ${apk}（${human(statSync(apk).size)}）`)
    note(`  实际指纹  = ${formatSha256(certs.sha256)}`)
    note(`  DN        = ${certs.dn ?? '?'}`)
    note(`  v1 / v2   = ${certs.v1 ?? '?'} / ${certs.v2 ?? '?'}`)
    if (opts.check) {
      if (certs.sha256 !== cfg.certSha256) {
        die(
          `指纹不符！\n` +
            `  期望 ${formatSha256(cfg.certSha256)}\n` +
            `  实得 ${formatSha256(certs.sha256)}\n` +
            '  这个包装到设备上会报 INSTALL_FAILED_UPDATE_INCOMPATIBLE（只能卸载）。',
        )
      }
      note('  ✓ 指纹与仓库内固定密钥一致')
    }
    return
  }

  // ── 签名 ─────────────────────────────────────────────────────────────
  if (!opts.in || !opts.out) die('签名需要 --in 与 --out（或改用 --print / --check）', 2)
  if (!existsSync(opts.in)) die(`找不到输入 APK：${opts.in}`)

  const inSize = statSync(opts.in).size

  // 目标已存在时先记下它的指纹 —— 用于「这次装上去要不要卸载」的提前告警。
  let previous = null
  if (existsSync(opts.out)) {
    try {
      previous = printCerts(opts.out, tool, java)
    } catch {
      previous = null // 旧产物本身坏了/没签名，不当成阻塞条件
    }
  }

  // apksigner 的 --out 会在**同一目录**写临时文件，不允许多线程共用输入输出。
  // 这里先签到一个兄弟临时文件，成功后再原子改名 —— 失败时不会留下一个
  // 「看着像产物、其实是半截」的 app-signed.apk（历史上真出过这种包）。
  const tmp = `${opts.out}.signing`
  rmSync(tmp, { force: true })
  mkdirSync(dirname(opts.out), { recursive: true })

  const signArgs = [
    'sign',
    '--ks', cfg.storePath,
    '--ks-type', 'PKCS12',
    '--ks-pass', `pass:${cfg.storePassword}`,
    '--ks-key-alias', cfg.keyAlias,
    '--key-pass', `pass:${cfg.keyPassword}`,
    '--v1-signing-enabled', 'true',
    '--v2-signing-enabled', 'true',
    '--out', tmp,
    opts.in,
  ]
  const signed = runApksigner(tool, java, signArgs)
  if (signed.status !== 0) {
    rmSync(tmp, { force: true })
    die(`apksigner sign 失败（exit ${signed.status}）`)
  }
  if (!existsSync(tmp)) die('apksigner 声称成功，但没有写出文件')

  // 硬校验 ①：签完的包必须真的比输入大（多出签名块）。踩过一次 —— apksigner
  // 声称 exit 0，但 signed 与 aligned 字节完全相同、也没有 APK Signing Block，
  // 装设备时才报 INSTALL_PARSE_FAILED_NO_CERTIFICATES。
  const outSize = statSync(tmp).size
  if (outSize <= inSize) {
    rmSync(tmp, { force: true })
    die(`签名无效：输出 ${outSize} B 未大于输入 ${inSize} B（apksigner 没改动文件）`)
  }

  // 硬校验 ②：证书指纹必须与仓库内固定密钥一致。
  const certs = printCerts(tmp, tool, java)
  if (certs.sha256 !== cfg.certSha256) {
    rmSync(tmp, { force: true })
    die(
      `签出来的包指纹不对！\n` +
        `  期望 ${formatSha256(cfg.certSha256)}\n` +
        `  实得 ${formatSha256(certs.sha256)}\n` +
        '  keystore 与 kxxy-signing.properties 的 certSha256 不同步 —— ' +
        '检查是否有人换过 keystore（换过就必须同步改 certSha256，并接受老设备要卸载）。',
    )
  }
  if (certs.v2 !== 'true') {
    rmSync(tmp, { force: true })
    die(`v2 签名没有生效（apksigner 报 v2=${certs.v2}）—— targetSdk=28 必须带 v2`)
  }

  renameSync(tmp, opts.out)

  note('')
  note(`  ✓ 已签名 ${opts.out}`)
  note(`      ${human(inSize)} → ${human(outSize)}（+${outSize - inSize} B 签名块）`)
  note(`      证书 SHA-256 ${formatSha256(certs.sha256)}`)
  note(`      DN ${certs.dn ?? '?'}   v1=${certs.v1} v2=${certs.v2}`)

  if (previous && previous.sha256 !== certs.sha256) {
    note('')
    note('  ⚠️ 上一版产物用的是**另一把**签名密钥：')
    note(`      旧 ${formatSha256(previous.sha256)}`)
    note(`      新 ${formatSha256(certs.sha256)}`)
    note('    设备上装过旧包的话，这次必须先卸载（会清掉引擎/运行时/会话）：')
    note('      adb uninstall app.kxxy')
  }
}

main()
//#endregion
