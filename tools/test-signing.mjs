/**
 * 固定签名的契约测试。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────────────
 *
 * 缺陷 DX 的起因不是「写错了一行」，而是**三处各自决定用什么钥匙**：
 *
 *   · `android/app/build.gradle.kts` 没有 signingConfigs → AGP 套默认 debug 密钥；
 *   · `tools/build-apk.ps1` 第 6 步读 `$HOME/.android/debug.keystore` → 同一类钥匙；
 *   · 两者都不是入库文件 → 换机器就换钥匙 → 设备报
 *     `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，只能卸载。
 *
 * 修法是把「钥匙是谁」收成**一份入库文件**（`android/keystore/kxxy-signing.properties`）
 * 并让三处都读它。而这类「多处必须一致」的约定，只要靠人记就一定会复发
 * （仓库里已有先例：`kxxy-host@N` 标记漏递增，见缺陷 DP）。所以这里用机器守住：
 *
 *   [1] properties 五个字段齐全、指纹是 64 位十六进制
 *   [2] keystore 文件存在、`certSha256` 与 keystore 里的**真实**证书一致
 *   [3] 仓库里没有任何一处还在用 debug.keystore / androiddebugkey
 *   [4] gradle 侧真的把 signingConfigs 接进了 debug 与 release 两个变体
 *   [5] build-apk.ps1 第 6 步真的调 tools/sign-apk.mjs，且**不再**自己拼 apksigner
 *   [6] sign-apk.mjs 自带的 apksigner.jar 可用（是 zip、有 MANIFEST）
 *   [7] properties 本身是合法 UTF-8（真踩过：一次 GBK 写回留下 U+FFFD）
 *   [8] .gitattributes 把 *.jks / *.keystore 钉成 binary（`* text=auto` 会改坏二进制）
 *   [9] （可选，`--apk <path>`）一个真实产物的证书指纹
 *
 * [2] 用 `keytool -printcert -rfc` 走的是 JDK 的解析器，与 apksigner 独立 ——
 * 两条独立链路给出同一个指纹，才说明 properties 里那串不是抄错的。
 * 没有 keytool 时这一条 SKIP（并明确说明跳过了什么），其余照跑。
 *
 * 用法：
 *   node tools/test-signing.mjs
 *   node tools/test-signing.mjs --apk <已签名的.apk>   # 额外验一个真实产物
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolve(HERE, '..')
const KEYSTORE_DIR = join(PROJECT, 'android', 'keystore')
const PROPS = join(KEYSTORE_DIR, 'kxxy-signing.properties')
const GRADLE = join(PROJECT, 'android', 'app', 'build.gradle.kts')
const BUILD_APK = join(PROJECT, 'tools', 'build-apk.ps1')
const SIGN_APK = join(PROJECT, 'tools', 'sign-apk.mjs')
const VENDORED_JAR = join(PROJECT, 'tools', 'prebuilt', 'apksigner', 'apksigner.jar')

let passed = 0
let failed = 0
let skipped = 0

function check(label, cond, detail) {
  if (cond) {
    passed += 1
    console.log(`  ok   ${label}`)
    return true
  }
  failed += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : `  —— ${detail}`}`)
  return false
}

function skip(label, why) {
  skipped += 1
  console.log(`  SKIP ${label}  —— ${why}`)
}

function readProps() {
  const out = {}
  for (const raw of readFileSync(PROPS, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at < 0) continue
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

/** 找 keytool：KXXY_KEYTOOL → JAVA_HOME → 与 sign-apk.mjs 同一套探测链。 */
function findKeytool() {
  const candidates = [process.env.KXXY_KEYTOOL]
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, 'bin', 'keytool.exe'))
  if (process.env.KXXY_JAVA) {
    candidates.push(join(dirname(process.env.KXXY_JAVA), 'keytool.exe'))
  }
  for (const root of (process.env.KXXY_JDK_ROOTS ?? '').split(';').map((s) => s.trim()).filter(Boolean)) {
    candidates.push(join(root, 'bin', 'keytool.exe'))
  }
  candidates.push(
    'C:\\Program Files\\Java\\bin\\keytool.exe',
    'C:\\Program Files\\Eclipse Adoptium\\bin\\keytool.exe',
  )
  for (const c of candidates) if (c && existsSync(c)) return c
  const where = spawnSync('where.exe', ['keytool'], { encoding: 'utf8' })
  if (where.status === 0) {
    const first = where.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (first && existsSync(first)) return first
  }
  return null
}

console.log('固定签名契约测试（tools/test-signing.mjs）\n')

//#region [1] properties 完整性

console.log('[1] android/keystore/kxxy-signing.properties')
if (!check('配置文件存在', existsSync(PROPS), PROPS)) {
  process.exit(1)
}
const props = readProps()
for (const key of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword', 'certSha256']) {
  check(`字段 ${key} 非空`, Boolean(props[key]), `实际 ${JSON.stringify(props[key] ?? null)}`)
}
const certSha256 = (props.certSha256 ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
check('certSha256 是 64 位十六进制', /^[0-9a-f]{64}$/.test(certSha256), `长度 ${certSha256.length}`)
check(
  'storeFile 指向的文件存在',
  existsSync(join(KEYSTORE_DIR, props.storeFile ?? '')),
  join(KEYSTORE_DIR, props.storeFile ?? ''),
)

//#endregion

//#region [2] keystore 与 certSha256 必须一致

console.log('\n[2] keystore 实际证书 vs properties.certSha256')
const keytool = findKeytool()
if (!keytool) {
  skip('用 keytool 复核指纹', '找不到 keytool.exe（设 KXXY_KEYTOOL / JAVA_HOME 后重跑）')
} else {
  // ⚠️ 必须用 `-exportcert -rfc` 而不是 `-printcert -keystore`：后者对 **PKCS12**
  // 里的私钥条目直接报 `java.lang.Exception: 证书`（keytool 只把它当「证书库」读，
  // 而我们的 .jks 名字虽叫 jks，实际是 PKCS12 私钥库）。`-exportcert -alias` 才是
  // 导出「该条目的证书」的正路。
  // 拿到 PEM 后指纹由**我们自己**对 DER 求 sha256 —— 不让 keytool 的格式化输出
  // 参与比对，避免「两边都用同一段文本」的自证。
  const pem = spawnSync(
    keytool,
    [
      '-exportcert', '-rfc',
      '-keystore', join(KEYSTORE_DIR, props.storeFile),
      '-storepass', props.storePassword,
      '-alias', props.keyAlias,
    ],
    { encoding: 'utf8' },
  )
  if (pem.status !== 0) {
    failed += 1
    console.log(`  FAIL keytool 导不出证书  —— ${(pem.stderr || pem.stdout || '').trim().split('\n')[0]}`)
  } else {
    checkFingerprint(pem.stdout)
  }

  function checkFingerprint(text) {
    const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(text)
    if (!m) {
      failed += 1
      console.log('  FAIL keytool 输出里没有 PEM 证书块')
      return
    }
    const der = Buffer.from(m[1].replace(/\s+/g, ''), 'base64')
    const actual = createHash('sha256').update(der).digest('hex')
    check(
      'keystore 证书指纹与 certSha256 一致',
      actual === certSha256,
      `keystore ${actual}\n        properties ${certSha256}`,
    )
    // 证书 DN 里不该出现 Android 的默认调试身份 —— 那说明有人在某个环节
    // 又用回了 debug.keystore（DN 是 CN=Android Debug, O=Android, C=US）。
    const subject = spawnSync(
      keytool,
      [
        '-list', '-v',
        '-keystore', join(KEYSTORE_DIR, props.storeFile),
        '-storepass', props.storePassword,
        '-alias', props.keyAlias,
      ],
      { encoding: 'utf8' },
    )
    const dnText = `${subject.stdout ?? ''}${subject.stderr ?? ''}`
    check('证书不是 Android 默认调试证书', !/CN=Android Debug/i.test(dnText), '仍是 CN=Android Debug')
  }
}

//#endregion

//#region [3] 全仓不得再引用 debug.keystore

console.log('\n[3] 仓库里不得再有 debug.keystore / androiddebugkey 的活引用')
// 只扫「会真正影响产物」的文件类型；README 里讨论历史缺陷是允许的，
// 所以按文件白名单扫，而不是全仓 grep。
const SCAN = [
  ['android/app/build.gradle.kts', GRADLE],
  ['android/build.gradle.kts', join(PROJECT, 'android', 'build.gradle.kts')],
  ['tools/build-apk.ps1', BUILD_APK],
  ['tools/sign-apk.mjs', SIGN_APK],
]
for (const [label, file] of SCAN) {
  if (!existsSync(file)) {
    check(`${label} 存在`, false, file)
    continue
  }
  const text = readFileSync(file, 'utf8')
  // 注释里提到它们是**应该**的（那是缺陷说明），所以只判「非注释行」。
  const live = text
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*')) return false
      return true
    })
    .join('\n')
  const bad = []
  if (/debug\.keystore/i.test(live)) bad.push('debug.keystore')
  if (/androiddebugkey/i.test(live)) bad.push('androiddebugkey')
  if (/pass:android\b/.test(live)) bad.push('pass:android')
  check(`${label} 无活引用`, bad.length === 0, bad.join(', '))
}

//#endregion

//#region [4] gradle 侧接线

console.log('\n[4] android/app/build.gradle.kts 的 signingConfigs 接线')
const gradleText = readFileSync(GRADLE, 'utf8')
check(
  'signingConfigs 读的是仓库内 properties',
  /keystore\/kxxy-signing\.properties/.test(gradleText),
  '没有引用 android/keystore/kxxy-signing.properties',
)
check('建了名为 kxxy 的 signingConfig', /create\("kxxy"\)/.test(gradleText))
check(
  'debug 变体用了它',
  /debug\s*\{[^}]*signingConfig\s*=\s*signingConfigs\.getByName\("kxxy"\)/s.test(gradleText),
  'debug 仍会落回 AGP 默认 debug 密钥',
)
check(
  'release 变体用了它',
  /release\s*\{[^}]*signingConfig\s*=\s*signingConfigs\.getByName\("kxxy"\)/s.test(gradleText),
)
check('缺少 keystore 时抛错而不是静默回落', /throw GradleException/.test(gradleText))

//#endregion

//#region [5] build-apk.ps1 走 sign-apk.mjs

console.log('\n[5] tools/build-apk.ps1 第 6 步')
const psText = readFileSync(BUILD_APK, 'utf8')
check('调用了 tools/sign-apk.mjs', /tools\\sign-apk\.mjs/.test(psText))
check('不再自己拼 apksigner 命令', !/&\s*\$signer\s+sign/.test(psText), '仍有 `& $signer sign` 分支')
check(
  '不再读 $env:USERPROFILE 下的 debug.keystore',
  !/\$ks\s*=\s*"\$env:USERPROFILE\\\.android\\debug\.keystore"/.test(psText),
)
check('签名失败会中止构建', /sign-apk\.mjs"[\s\S]{0,200}LASTEXITCODE[\s\S]{0,80}throw/.test(psText))

//#endregion

//#region [6] 自带 apksigner.jar 可用

console.log('\n[6] tools/prebuilt/apksigner/apksigner.jar')
if (check('文件存在', existsSync(VENDORED_JAR), VENDORED_JAR)) {
  const size = statSync(VENDORED_JAR).size
  check('体积合理（>1 MiB）', size > 1024 * 1024, `${size} B`)
  const head = readFileSync(VENDORED_JAR, { encoding: 'latin1', flag: 'r' }).slice(0, 4)
  check('是 zip（本地头 PK\\x03\\x04）', head === 'PK\x03\x04', JSON.stringify(head))
  // 中央目录里有 META-INF/MANIFEST.MF 才算一个能跑的 jar（不是被截断的下载）。
  const buf = readFileSync(VENDORED_JAR)
  check('中央目录含 META-INF/MANIFEST.MF', buf.includes(Buffer.from('META-INF/MANIFEST.MF')))
}

//#endregion

//#region [7] properties 必须是合法 UTF-8（真踩过）

console.log('\n[7] kxxy-signing.properties 的编码')
// 为什么单独验：这份文件是**中文注释 + 五个 ASCII 键值**，而它会被三方按不同方式读 ——
// gradle 的 `Properties.load(InputStream)` 按 ISO-8859-1 解、`sign-apk.mjs` 按 UTF-8
// 解、`.gitattributes` 的 `* text=auto eol=lf` 还会在检出时做一次换行归一化。
// 键值全是 ASCII 所以解析结果不受影响，**但注释会**：某次编辑工具按 GBK 写回后，
// 文件里留下 `EF BF BD`（U+FFFD 替换字符）与 `E2 80 3F` 这类非法序列，
// 于是 `read` / 编辑器 / 网页预览全是乱码，而所有测试照旧全绿 ——
// 因为没人验过「这份文件本身是不是合法 UTF-8」。
{
  const bytes = readFileSync(PROPS)
  let decoded = null
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    decoded = null
  }
  check(
    '是合法 UTF-8（无替换字符 / 无截断的多字节序列）',
    decoded !== null,
    '文件含非法 UTF-8 序列 —— 用编辑器按 UTF-8 重存，别让它按 GBK 写回',
  )
  if (decoded !== null) {
    check('不含 U+FFFD 替换字符', !decoded.includes('\uFFFD'), '注释里出现 \uFFFD，说明曾被有损转码')
    // 五个键必须是纯 ASCII：`Properties.load(InputStream)` 不做任何字符集转换，
    // 键名一旦混进非 ASCII，gradle 侧读到的会是另一串字节。
    check(
      '键名与取值都是 ASCII',
      Object.entries(props).every(([k, v]) => /^[\x20-\x7e]*$/.test(k) && /^[\x20-\x7e]*$/.test(v)),
    )
  }
}

//#endregion

//#region [8] .gitattributes 必须把密钥当二进制

console.log('\n[8] .gitattributes 对签名密钥的处置')
// `* text=auto eol=lf` 会让 git 对「看起来像文本」的文件做 CRLF→LF 归一化。
// .jks 是 PKCS12 二进制，里面混着随机盐，一旦某几个 0x0D 0x0A 被当成行尾改掉，
// 这把钥匙就打不开了 —— 而它丢了等于所有已装设备必须卸载重装。
// git 的 binary 判定是**启发式**（前 8,000 字节里有没有 NUL），换一把钥匙可能变卦，
// 所以必须显式钉死，而不是靠它自己猜对。
{
  const attrFile = join(PROJECT, '.gitattributes')
  if (check('.gitattributes 存在', existsSync(attrFile), attrFile)) {
    const attrText = readFileSync(attrFile, 'utf8')
    check('把 *.jks 标成 binary', /^\s*\*\.jks\s+binary\s*$/m.test(attrText))
    check('把 *.keystore 标成 binary', /^\s*\*\.keystore\s+binary\s*$/m.test(attrText))
  }
}

//#endregion

//#region [9] 可选：验一个真实产物

const apkArgIdx = process.argv.indexOf('--apk')
if (apkArgIdx >= 0) {
  const apk = resolve(process.argv[apkArgIdx + 1] ?? '')
  console.log(`\n[9] 真实产物 ${apk}`)
  if (!check('APK 存在', existsSync(apk), apk)) {
    // 不 return，让汇总照常打印
  } else {
    const r = spawnSync(
      process.execPath,
      [SIGN_APK, '--check', apk, '--quiet'],
      { encoding: 'utf8' },
    )
    check(
      'APK 证书指纹与仓库固定密钥一致',
      r.status === 0,
      `${(r.stdout || r.stderr || '').trim().split('\n').slice(-2).join(' / ')}`,
    )
  }
}

//#endregion

console.log('')
if (failed === 0) {
  console.log(`固定签名契约测试全部通过（${passed} 项，跳过 ${skipped} 项）`)
} else {
  console.log(`固定签名契约测试失败 ${failed} 项（通过 ${passed} 项，跳过 ${skipped} 项）`)
  process.exitCode = 1
}
