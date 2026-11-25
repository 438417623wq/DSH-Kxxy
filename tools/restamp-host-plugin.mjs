/**
 * 把 `plugins/kxxy-host/` 的当前内容**增量**重封进一份已有的 `runtime.zip`。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 *
 * 控制台（`lib/node_modules/kxxy-host/web/*`）是纯前端资源，改一次配色、调一次
 * 行高都要经过 `build-runtime.mjs` —— 那意味着重新解析 6 万条 stage/asar 条目、
 * 重打 1.9 GiB 未压缩内容。而实际变化的只有插件目录里那几个 html/css/js。
 *
 * `restamp-mobile-plugin.mjs` 只处理 `dsh-web-mobile`，改了 kxxy-host 的样式
 * 就得跑全量。本脚本补上这一块，与它是同一套机制的兄弟实现。
 *
 * 与 mobile 版的关键差别：**宿主插件的内容指纹必须重算**。
 * `build-runtime.mjs` 对整棵 `kxxy-host/` 树（路径 + 内容）求 sha256，写进
 * `lib/.fingerprint`，并把入口首行改写成 `kxxy-host@<指纹前12位>`；设备侧锚点 8
 * 拿 APK 里的期望指纹与设备上的文件比对，不等就强制重装。只换 web 文件而不同步
 * 指纹，结果是「APK 装了新包、设备还在跑旧界面」—— 一声不响。所以这里直接复用
 * `lib/host-fingerprint.mjs` 的 `stampHostPluginFingerprint`，与全量构建逐字节一致。
 *
 * ── 补丁集标记也必须一起动 ──────────────────────────────────────────────────
 *
 * 光换文件 + 换指纹**不够**：设备上 `isComplete()` 的锚点 11 只看
 * `kxxy-host/patchset.version` 这一行标记。标记不变时它判「运行时完整」，
 * 直接返回，连 `lib/` 都不会重解压 —— 而 `PythonRuntimeRepair.HOST_WEB_FILES`
 * 的受管名单只有 `index.html` 与 `host.js`，样式表(`host.css`)、`theme.css`、
 * `compat.js`、`modern.js` 根本没人换。真机现象：结构是新版、视觉是旧版
 * （0.9.59 #959002：`.dsl-fab` 没有 54px 圆框，SVG 按默认 300×150 撑满半屏）。
 *
 * 所以这里同时把 `patchset.version` 重写成当前编号，取值直接读
 * `build-runtime.mjs` 的 `PATCHSET_MARKER`，并与 `RuntimeInstaller.kt` 对账 ——
 * 两边不一致时设备会判「标记不符」而无限重装，必须当场拦下。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *
 *   node tools/restamp-host-plugin.mjs \
 *     --in  .cache/apk-assets-hold/runtime.zip \
 *     --out .cache/rt-host/runtime.zip \
 *     --meta android/app/src/main/assets/meta/build.json
 *
 * `--out` 目录里会同时复制一份 `alias-links.txt`（`build-codex-apk.ps1` 要求同级）。
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

import { HOST_PLUGIN_BASE, stampHostPluginFingerprint } from './lib/host-fingerprint.mjs'
import { PYTHON_HOST_FILES, createPythonRepairAssets } from './lib/python-runtime.mjs'
import { readZipDirectory } from './lib/zipread.mjs'
import { zipEndRecords, MAX_ZIP_ENTRIES, ZIP32_SENTINEL } from './lib/zipwrite.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolve(HERE, '..')
const HOST_SOURCE = join(PROJECT, 'plugins', 'kxxy-host')

const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const COPY_CHUNK = 8 * 1024 * 1024

/** 只有这些顶层子目录会进运行时（与 build-runtime 的 collect 规则一致）。 */
const SOURCE_SKIP_DIRS = new Set(['node_modules', '.git', 'docs', 'dist'])

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    meta: join(PROJECT, 'android', 'app', 'src', 'main', 'assets', 'meta', 'build.json'),
    assets: join(PROJECT, 'android', 'app', 'src', 'main', 'assets', 'python-repair'),
    alias: null,
    checkOnly: false,
    replace: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--in') opts.input = resolve(argv[++i])
    else if (a === '--out') opts.output = resolve(argv[++i])
    else if (a === '--meta') opts.meta = resolve(argv[++i])
    else if (a === '--assets') opts.assets = resolve(argv[++i])
    else if (a === '--alias') opts.alias = resolve(argv[++i])
    else if (a === '--replace') {
      const spec = argv[++i] ?? ''
      const eq = spec.indexOf('=')
      if (eq <= 0) throw new Error(`--replace 需要 <运行时内路径>=<本机文件>：${spec}`)
      opts.replace.push([spec.slice(0, eq), resolve(spec.slice(eq + 1))])
    }
    else if (a === '--check-only') opts.checkOnly = true
    else if (a === '--help' || a === '-h') {
      console.log('用法：node tools/restamp-host-plugin.mjs --in <runtime.zip> --out <new.zip> [--meta <build.json>] [--assets <python-repair>] [--replace <entry>=<file>]... [--check-only]')
      process.exit(0)
    } else throw new Error(`未知参数：${a}`)
  }
  if (!opts.input) throw new Error('缺少 --in <runtime.zip>')
  if (!opts.checkOnly && !opts.output) throw new Error('缺少 --out <new.zip>')
  return opts
}

/** 递归收集 `plugins/kxxy-host/` → Map<zip 路径, { data, mode }>。 */
function collectHostFiles() {
  const files = new Map()
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name.startsWith('.') && item.name !== '.fingerprint') continue
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        if (dir === HOST_SOURCE && SOURCE_SKIP_DIRS.has(item.name)) continue
        walk(full)
        continue
      }
      if (!item.isFile()) continue
      const rel = relative(HOST_SOURCE, full).split(sep).join('/')
      if (rel === 'lib/.fingerprint') continue // 构建期产物，由指纹函数重写
      files.set(HOST_PLUGIN_BASE + rel, { data: readFileSync(full), mode: 0o644 })
    }
  }
  walk(HOST_SOURCE)
  return files
}

/**
 * 当前补丁集编号：以 `build-runtime.mjs` 的 `PATCHSET_MARKER` 为准，
 * 并与 `RuntimeInstaller.PATCHSET_MARKER`（设备侧锚点 11 的判据）逐字对账。
 * 两边不一致时设备会判「标记不符」而无限重装，所以这里直接拒绝出包。
 */
function resolvePatchsetMarker() {
  const read = (rel, re, label) => {
    const value = re.exec(readFileSync(join(PROJECT, rel), 'utf8'))?.[1]
    if (!value) throw new Error(`${label} 里找不到补丁集编号`)
    return value
  }
  const built = read('tools/build-runtime.mjs', /const PATCHSET_MARKER = "([^"]+)"/, 'build-runtime.mjs')
  const installed = read(
    'android/app/src/main/java/app/kxxy/engine/RuntimeInstaller.kt',
    /PATCHSET_MARKER\s*=\s*"([^"]+)"/,
    'RuntimeInstaller.kt',
  )
  if (built !== installed) {
    throw new Error(`补丁集编号不一致：build-runtime=${built} 而 RuntimeInstaller=${installed}；设备会判标记不符`)
  }
  return built
}

function readAt(fd, offset, len) {
  const buf = Buffer.allocUnsafe(len)
  let got = 0
  while (got < len) {
    const n = readSync(fd, buf, 0, len - got, offset + got)
    if (n <= 0) throw new Error(`只读到 ${got}/${len} 字节（@${offset}）`)
    got += n
  }
  return buf
}

function readCentralDirectory(fd, size) {
  const { count, cdSize, cdOffset } = readZipDirectory((offset, length) => readAt(fd, offset, length), size)
  const cd = readAt(fd, cdOffset, cdSize)
  const entries = []
  let p = 0
  for (let i = 0; i < count; i += 1) {
    if (cd.readUInt32LE(p) !== CD_SIG) throw new Error(`中央目录项 ${i} 签名错误 @${p}`)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    entries.push({
      cdHeader: Buffer.from(cd.subarray(p, p + 46)),
      nameBuf: Buffer.from(cd.subarray(p + 46, p + 46 + nameLen)),
      name: cd.toString('utf8', p + 46, p + 46 + nameLen),
      extra: Buffer.from(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)),
      comment: Buffer.from(cd.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen)),
      localOffset: cd.readUInt32LE(p + 42),
      method: cd.readUInt16LE(p + 10),
      flags: cd.readUInt16LE(p + 8),
      crc: cd.readUInt32LE(p + 16),
      csize: cd.readUInt32LE(p + 20),
      usize: cd.readUInt32LE(p + 24),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  if (p !== cdSize) throw new Error(`中央目录长度不符（解析 ${p} / 声明 ${cdSize}）`)
  return { entries, cdSize, cdOffset, count }
}

function measureLocalRecords(fd, entries, cdOffset) {
  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset)
  let cursor = 0
  for (const entry of sorted) {
    if (entry.localOffset !== cursor) {
      throw new Error(
        `条目未首尾相接：${entry.name} @${entry.localOffset}，期望 @${cursor}。` +
          '（存在对齐填充或其它 zip 写入器产物，请改用 build-runtime.mjs 全量重编）',
      )
    }
    const lh = readAt(fd, entry.localOffset, 30)
    if (lh.readUInt32LE(0) !== LOCAL_SIG) throw new Error(`本地头签名错误：${entry.name}`)
    if (lh.readUInt16LE(6) & 0x0008) throw new Error(`条目使用 data descriptor，无法整段拷贝：${entry.name}`)
    const nameLen = lh.readUInt16LE(26)
    const extraLen = lh.readUInt16LE(28)
    entry.extent = 30 + nameLen + extraLen + entry.csize
    entry.template = Buffer.from(lh)
    cursor = entry.localOffset + entry.extent
  }
  if (cursor !== cdOffset) throw new Error(`条目总长 ${cursor} 与中央目录起点 ${cdOffset} 不符（尾部有额外数据）`)
  return sorted
}

function readEntryData(fd, entry) {
  const nameLen = entry.template.readUInt16LE(26)
  const extraLen = entry.template.readUInt16LE(28)
  const start = entry.localOffset + 30 + nameLen + extraLen
  const raw = readAt(fd, start, entry.csize)
  return entry.method === 8 ? inflateRawSync(raw) : raw
}

function buildLocalRecord(template, name, data, time, day) {
  const deflated = deflateRawSync(data, { level: 6 })
  const method = deflated.length < data.length ? 8 : 0
  const payload = method === 8 ? deflated : data
  const crc = crc32(data)
  const nameBuf = Buffer.from(name, 'utf8')
  const head = Buffer.alloc(30)
  head.writeUInt32LE(LOCAL_SIG, 0)
  head.writeUInt16LE(template.readUInt16LE(4), 4)
  head.writeUInt16LE(template.readUInt16LE(6) & ~0x0008, 6)
  head.writeUInt16LE(method, 8)
  head.writeUInt16LE(time, 10)
  head.writeUInt16LE(day, 12)
  head.writeUInt32LE(crc, 14)
  head.writeUInt32LE(payload.length, 18)
  head.writeUInt32LE(data.length, 22)
  head.writeUInt16LE(nameBuf.length, 26)
  head.writeUInt16LE(0, 28)
  return { head, nameBuf, payload, method, crc, csize: payload.length, usize: data.length }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosOf(template) {
  return { time: template.readUInt16LE(10), day: template.readUInt16LE(12) }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.checkOnly && existsSync(opts.output)) throw new Error(`拒绝覆盖已存在的运行时：${opts.output}`)
  if (!existsSync(opts.input)) throw new Error(`找不到运行时：${opts.input}`)
  if (!existsSync(HOST_SOURCE)) throw new Error(`找不到插件源码：${HOST_SOURCE}`)

  // ── 先读源 zip：插件目录里除了源码树，还有构建期产物 ───────────────────
  //
  // 这一条是踩过的坑：`plugins/kxxy-host/` 只有 26 个源文件，而运行时里
  // `lib/node_modules/kxxy-host/` 有 36 个 —— 多出来的 10 个是构建期生成的
  // （office 字体、packaging/ 里的 zipalign + bundletool、以及
  //  patchset/tessdata/texlive/androidjar/packaging 五个 .version 标记）。
  // 它们**不在源码树里，但绝不能删**：删了设备上字体与打包工具链直接消失。
  // 同时它们也参与内容指纹，所以必须并进指纹计算的集合，否则算出来的值
  // 与全量构建不一致。
  const stat = statSync(opts.input)
  const fd = openSync(opts.input, 'r')
  const cd = readCentralDirectory(fd, stat.size)
  const sorted = measureLocalRecords(fd, cd.entries, cd.cdOffset)
  console.log(`源运行时 ${(stat.size / 1024 / 1024).toFixed(2)} MiB，条目 ${cd.entries.length}，首尾相接 ✓`)

  const oldHost = sorted.filter((e) => e.name.startsWith(HOST_PLUGIN_BASE) && !e.name.endsWith('/'))
  if (!oldHost.length) throw new Error('源 zip 里没有 kxxy-host 条目，无法增量重封')

  const files = collectHostFiles()
  if (!files.has(`${HOST_PLUGIN_BASE}lib/index.js`)) throw new Error('插件树里缺少 lib/index.js')

  const kept = new Map()
  for (const entry of oldHost) {
    if (files.has(entry.name)) continue
    if (entry.name === `${HOST_PLUGIN_BASE}lib/.fingerprint`) continue
    kept.set(entry.name, { data: readEntryData(fd, entry), mode: 0o644 })
  }
  console.log(`源码树 ${files.size} 个文件；运行时另有 ${kept.size} 个构建期产物（原样保留）`)

  // 补丁集标记必须跟着走，否则设备锚点 11 判「已完整」、整个 lib/ 都不重解压，
  // 新样式表永远落不到设备上（详见文件头「补丁集标记也必须一起动」）。
  // 注意要进 `files`（替换集）而不是只进 `kept`：写出阶段只重写 `files` 里的条目，
  // `kept` 仅参与指纹计算与「保留 N 个」的计数 —— 上一版就是这么漏的。
  const patchsetMarker = resolvePatchsetMarker()
  const patchsetPath = `${HOST_PLUGIN_BASE}patchset.version`
  if (!kept.has(patchsetPath)) throw new Error(`运行时缺少补丁集标记：${patchsetPath}`)
  const patchsetBefore = kept.get(patchsetPath).data.toString('utf8').trim()
  if (patchsetBefore !== patchsetMarker) {
    kept.delete(patchsetPath)
    files.set(patchsetPath, { data: Buffer.from(`${patchsetMarker}\n`, 'utf8'), mode: 0o644 })
    console.log(`补丁集标记 ${patchsetBefore} → ${patchsetMarker}（设备将重解压整个 lib/）`)
  } else {
    console.log(`  ! 补丁集标记已是 ${patchsetMarker} —— 设备不会因此重解压`)
  }

  // 修复包要用到的旧字节必须在 fd 关闭前读完（写出阶段结束时 fd 已 close）
  const repairPrevious = new Map()
  for (const name of PYTHON_HOST_FILES) {
    const path = `${HOST_PLUGIN_BASE}${name}`
    const entry = oldHost.find((e) => e.name === path)
    if (entry) repairPrevious.set(path, readEntryData(fd, entry))
  }


  // ── 内容指纹：与全量构建同源（整棵树，含构建期产物）────────────────────
  const tree = new Map([...kept, ...files])
  const fingerprint = stampHostPluginFingerprint(tree)
  const marker = `kxxy-host@${fingerprint.slice(0, 12)}`
  // stamp 会改写 index.js 首行标记并写入 lib/.fingerprint，把它们带回替换集
  files.set(`${HOST_PLUGIN_BASE}lib/index.js`, tree.get(`${HOST_PLUGIN_BASE}lib/index.js`))
  files.set(`${HOST_PLUGIN_BASE}lib/.fingerprint`, tree.get(`${HOST_PLUGIN_BASE}lib/.fingerprint`))
  console.log(`指纹 ${fingerprint}（${marker}）`)

  /*
   * 额外替换：运行时里**不属于 kxxy-host** 的上游文件（例如修 pi-ai 的
   * `defaultInput` 空数组回归只需换掉一个 `lib/index.js`，没必要重打 1.9 GiB）。
   *
   * 必须晚于树指纹计算再进 `files`：`stampHostPluginFingerprint` 只对
   * `kxxy-host/` 树求值，把上游文件混进去会让指纹与全量构建不一致，
   * 设备侧锚点 8 会判「插件指纹不符」而无限重装。
   */
  for (const [entryName, srcPath] of opts.replace) {
    if (!existsSync(srcPath)) throw new Error(`--replace 源文件不存在：${srcPath}`)
    if (!cd.entries.some((e) => e.name === entryName)) {
      throw new Error(`--replace 目标不在运行时里：${entryName}（新增条目请走全量构建）`)
    }
    files.set(entryName, { data: readFileSync(srcPath), mode: 0o644 })
    console.log(`替换运行时条目 ${entryName}（${statSync(srcPath).size} 字节）`)
  }

  const manifestEntry = cd.entries.find((e) => e.name === 'kxxy-runtime.json')
  if (!manifestEntry) throw new Error('运行时缺少 kxxy-runtime.json')
  const oldManifestBytes = readEntryData(fd, manifestEntry)
  const oldManifest = JSON.parse(oldManifestBytes.toString('utf8'))
  const fpBefore = oldManifest.plugins?.hostFingerprint
  if (!/^[a-f0-9]{64}$/.test(fpBefore ?? '')) throw new Error('kxxy-runtime.json 缺少 plugins.hostFingerprint')
  // 输入必须是**干净的基线**：`lib/.fingerprint` 与 kxxy-runtime.json 的声明
  // 必须一致。拿一份已经被重封过一半的 zip 当输入，`previous`（旧字节）就会
  // 指向新内容，设备端三方比对必然失败 —— 这是实测踩过的第二个坑。
  const fpFileEntry = cd.entries.find((e) => e.name === `${HOST_PLUGIN_BASE}lib/.fingerprint`)
  const fpFile = fpFileEntry
    ? (readEntryData(fd, fpFileEntry).toString('utf8').match(/fingerprint:([0-9a-f]{64})/)?.[1] ?? '')
    : ''
  if (fpFile && fpFile !== fpBefore) {
    throw new Error(
      `输入运行时自相矛盾：lib/.fingerprint=${fpFile.slice(0, 12)} 而 kxxy-runtime.json 声明 ${fpBefore.slice(0, 12)}。` +
        '请换成未被重封过的基线包（例如 .cache/rt-<上一版>/runtime.zip）。',
    )
  }
  console.log(`旧指纹 ${fpBefore}`)

  /*
   * 修复包不是「只有宿主那 7 个文件」——它还得带上**受管的 Python 字节**
   * （site-packages、原生后端 .so、bin/python3、dist-info 元数据与版本文件），
   * 否则设备侧会以「清单缺少 Python 原生后端、包元数据或版本文件」拒绝修复
   * （实测踩过：只带宿主文件时，第二个 Refused 就是这个）。
   *
   * 这些字节在运行时里原样存在，而且这次重封根本不动它们，所以清单直接从
   * **上一份 python-repair 的 manifest** 抄路径、从输入 zip 取值即可 ——
   * 既不依赖打包机上的 wheel 归档，也不会与全量构建的文件集漂移。
   */
  const repairPythonFiles = new Map()
  if (opts.assets) {
    const prevRepairPath = join(opts.assets, 'manifest.json')
    if (existsSync(prevRepairPath)) {
      const prevRepair = JSON.parse(readFileSync(prevRepairPath, 'utf8'))
      /*
       * 接受两种基线，本质是同一件事：**输入 zip 必须是设备上真实存在的那个状态**。
       *
       *   · 等于上一份 manifest 的 `baseHostFingerprint` —— 还在同一个已发布基线上重封；
       *   · 等于上一份 manifest 的 `hostFingerprint` —— 上一版**已经发出去**了，这次是
       *     从它接续（链式）。这时新的 base 就是它，`previous` 取输入 zip 里的字节，
       *     正好等于设备上现在的内容，三方比对才成立。
       *
       * 少了第二条，每改一次样式都得回到 0.9.58 那份老包当基线，设备的宿主指纹
       * 既不是 base 也不是 host ⇒ PythonRuntimeRepair 判「不适用」⇒ 每次装机都
       * 白重解压 790 MiB。0.9.60 就是这么装的。
       */
      const prevBase = prevRepair.baseHostFingerprint
      const prevHost = prevRepair.hostFingerprint
      if (fpBefore !== prevBase && fpBefore !== prevHost) {
        throw new Error(
          `python-repair 基线指纹 ${String(prevBase).slice(0, 12)}（或已发布的 ${String(prevHost).slice(0, 12)}）` +
            `与运行时 ${fpBefore.slice(0, 12)} 不符，请先从上一版 APK 里恢复 assets/python-repair 再重封`,
        )
      }
      console.log(
        fpBefore === prevHost
          ? `修复包链式接续：上一版已发布指纹 ${fpBefore.slice(0, 12)} 作为新基线`
          : `修复包延续同一基线 ${fpBefore.slice(0, 12)}`,
      )
      for (const record of prevRepair.files) {
        if (record.role !== 'python') continue
        const entry = cd.entries.find((e) => e.name === record.path)
        if (!entry) throw new Error(`运行时缺少修复包声明的 Python 文件：${record.path}`)
        repairPythonFiles.set(record.path, { data: readEntryData(fd, entry), mode: record.mode })
      }
      console.log(`Python 修复包：沿用上一份清单的 ${repairPythonFiles.size} 个受管 Python 文件`)
    } else {
      throw new Error(`找不到 ${prevRepairPath} —— 修复包必须以上一版为基线增量重算`)
    }
  }
  if (fpBefore === fingerprint) console.log('  ! 指纹与旧包一致 —— 这次重封不会触发设备重装')

  // 源码里删掉的文件：只报告，不主动从运行时剔除（那 10 个产物看起来就像
  // 「源码里没有」，删了会断功能）
  // kxxy-runtime.json 里还有一份插件指纹，设备侧 PythonRuntimeRepair 的 lineage
  // 校验读的正是 `plugins.hostFingerprint`。只改 .fingerprint 而漏了这里，
  // 设备会以「目标宿主指纹与 APK metadata 不符」拒绝启动（实测踩过）。
  const newManifest = {
    ...oldManifest,
    plugins: { ...(oldManifest.plugins ?? {}), hostFingerprint: fingerprint, hostMarker: marker },
    builtAt: new Date().toISOString(),
  }
  const newManifestBytes = Buffer.from(`${JSON.stringify(newManifest, null, 2)}\n`, 'utf8')
  files.set('kxxy-runtime.json', { data: newManifestBytes, mode: 0o644 })

  const stale = oldHost.map((e) => e.name).filter((name) => !files.has(name) && !kept.has(name))
  const additions = [...files.keys()].filter((name) => !cd.entries.some((e) => e.name === name))
  console.log(`将替换 ${files.size} 个、新增 ${additions.length} 个、保留 ${kept.size} 个`)
  if (stale.length) console.log(`  ! 源码里已不存在的条目（保留不动）：${stale.join(', ')}`)

  const staleNames = new Set()

  if (opts.checkOnly) {
    closeSync(fd)
    console.log('--check-only：结构可增量重封，未写出任何文件')
    return
  }

  // ── 流式重写 ─────────────────────────────────────────────────────────
  const outDir = dirname(opts.output)
  mkdirSync(outDir, { recursive: true })
  const tmp = `${opts.output}.tmp-${process.pid}`
  const outFd = openSync(tmp, 'w')
  const digest = createHash('sha256')
  let offset = 0
  const emit = (buf) => {
    if (offset + buf.length >= ZIP32_SENTINEL) throw new Error('运行时超过 32 位大小/偏移上限')
    let written = 0
    while (written < buf.length) {
      const n = writeSync(outFd, buf, written, buf.length - written)
      if (n <= 0) throw new Error('写入失败')
      written += n
    }
    digest.update(buf)
    offset += buf.length
  }

  const replacements = [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const replaceNames = new Set(replacements.map(([name]) => name))
  const templateEntry =
    sorted.find((e) => e.name === `${HOST_PLUGIN_BASE}lib/index.js`) ??
    sorted.find((e) => e.name === `${HOST_PLUGIN_BASE}web/index.html`) ??
    sorted[0]
  const { time: stampTime, day: stampDay } = dosOf(templateEntry.template)

  const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK, Math.max(stat.size, 1)))
  let replaced = false
  const newOffsets = new Map()
  for (const entry of sorted) {
    if (staleNames.has(entry.name)) continue
    if (replaceNames.has(entry.name)) {
      if (replaced) continue
      replaced = true
      for (const [name, file] of replacements) {
        const record = buildLocalRecord(templateEntry.template, name, file.data, stampTime, stampDay)
        const localOffset = offset
        emit(record.head)
        emit(record.nameBuf)
        if (record.payload.length) emit(record.payload)
        newOffsets.set(name, {
          localOffset,
          method: record.method,
          crc: record.crc,
          csize: record.csize,
          usize: record.usize,
          fresh: true,
        })
      }
      continue
    }
    const localOffset = offset
    let read = 0
    while (read < entry.extent) {
      const want = Math.min(buffer.length, entry.extent - read)
      const n = readSync(fd, buffer, 0, want, entry.localOffset + read)
      if (n <= 0) throw new Error(`拷贝中断：${entry.name}`)
      emit(Buffer.from(buffer.subarray(0, n)))
      read += n
    }
    newOffsets.set(entry.name, {
      localOffset,
      method: entry.method,
      crc: entry.crc,
      csize: entry.csize,
      usize: entry.usize,
      fresh: false,
    })
  }
  if (!replaced) throw new Error('源 zip 里没有 kxxy-host 条目，无法增量重封')

  const cdEntries = cd.entries.filter((entry) => newOffsets.has(entry.name))
  for (const name of additions) {
    const file = files.get(name)
    const nameBuf = Buffer.from(name, 'utf8')
    const cdHeader = Buffer.from(templateEntry.cdHeader)
    cdHeader.writeUInt16LE(nameBuf.length, 28)
    cdHeader.writeUInt16LE(0, 30)
    cdHeader.writeUInt16LE(0, 32)
    cdHeader.writeUInt32LE(((0o100000 | file.mode) << 16) >>> 0, 38)
    cdEntries.push({ name, nameBuf, cdHeader, extra: Buffer.alloc(0), comment: Buffer.alloc(0) })
  }
  if (cdEntries.length > MAX_ZIP_ENTRIES) throw new Error('重封后条目数超过 ZIP64 计数上限')
  const cdStart = offset
  for (const entry of cdEntries) {
    const next = newOffsets.get(entry.name)
    if (!next) throw new Error(`中央目录条目未写本地记录：${entry.name}`)
    const head = Buffer.from(entry.cdHeader)
    head.writeUInt16LE(next.method, 10)
    if (next.fresh) {
      head.writeUInt16LE(templateEntry.template.readUInt16LE(4), 6)
      head.writeUInt16LE(templateEntry.template.readUInt16LE(6) & ~0x0008, 8)
      head.writeUInt16LE(stampTime, 12)
      head.writeUInt16LE(stampDay, 14)
      head.writeUInt16LE(0, 30)
    }
    head.writeUInt32LE(next.crc, 16)
    head.writeUInt32LE(next.csize, 20)
    head.writeUInt32LE(next.usize, 24)
    head.writeUInt32LE(next.localOffset, 42)
    emit(head)
    emit(entry.nameBuf)
    if (!next.fresh && entry.extra.length) emit(entry.extra)
    if (entry.comment.length) emit(entry.comment)
  }
  const cdSize = offset - cdStart
  emit(zipEndRecords(cdEntries.length, cdSize, cdStart, { allowZip64Count: true }))
  closeSync(outFd)
  closeSync(fd)

  if (existsSync(opts.output)) throw new Error(`拒绝覆盖已存在的运行时：${opts.output}`)
  renameSync(tmp, opts.output)
  const sha = digest.digest('hex')
  console.log(`写出 ${opts.output}`)
  console.log(`  ${(offset / 1024 / 1024).toFixed(2)} MiB（${offset} B），条目 ${cdEntries.length}`)
  console.log(`  sha256 ${sha}`)

  const aliasSrc = opts.alias ?? join(dirname(opts.input), 'alias-links.txt')
  if (existsSync(aliasSrc)) {
    copyFileSync(aliasSrc, join(outDir, 'alias-links.txt'))
    console.log(`  alias-links.txt ← ${aliasSrc}`)
  } else {
    console.log(`  ! 未找到 alias-links.txt（${aliasSrc}），打包前请手工放一份`)
  }

  /*
   * Python 修复资产（`assets/python-repair/{payload.zip,manifest.json}`）里也钉着
   * 宿主指纹，而且是**两份**：`baseHostFingerprint`（设备当前该有的）与
   * `hostFingerprint`（这次要装到的）。只更新 build.json 会让两者对不上，
   * 设备侧 PythonRuntimeRepair 直接 Refused，表现为「装完新包反而开不了机」。
   *
   * 这里按「上一份运行时 → 这一份」重算：base 取旧 zip 的指纹，host 取新指纹，
   * `previous` 提供旧字节以便设备做三方比对。
   */
  if (opts.assets) {
    const repairFiles = new Map(repairPythonFiles)
    const previous = new Map(repairPrevious)
    for (const name of PYTHON_HOST_FILES) {
      const path = `${HOST_PLUGIN_BASE}${name}`
      const file = files.get(path)
      if (file) repairFiles.set(path, file)
    }
    repairFiles.set('kxxy-runtime.json', { data: newManifestBytes, mode: 0o644 })
    previous.set('kxxy-runtime.json', oldManifestBytes)
    const assets = await createPythonRepairAssets(opts.assets, repairFiles, {
      baseHostFingerprint: fpBefore,
      hostFingerprint: fingerprint,
      previous,
    })
    console.log(`Python 修复资产 → ${opts.assets}（base ${fpBefore.slice(0, 12)} → host ${fingerprint.slice(0, 12)}）`)
    if (opts.meta && existsSync(opts.meta)) {
      const meta = JSON.parse(readFileSync(opts.meta, 'utf8'))
      meta.pythonRepairManifestSha256 = assets.manifestSha256
      writeFileSyncSafe(opts.meta, `${JSON.stringify(meta, null, 2)}\n`)
    }
  }

  if (opts.meta && existsSync(opts.meta)) {
    const meta = JSON.parse(readFileSync(opts.meta, 'utf8'))
    meta.generatedAt = new Date().toISOString()
    meta.runtimeSha256 = sha
    meta.runtimeSize = offset
    meta.runtimeEntries = cdEntries.length
    meta.kxxyHostFingerprint = fingerprint
    meta.kxxyHostMarker = marker
    writeFileSyncSafe(opts.meta, `${JSON.stringify(meta, null, 2)}\n`)
    console.log(`  meta 已更新：${opts.meta}（${marker}）`)
  }

  /*
   * `.cache/build-meta.json` 是**构建机副本**：`build-apk.ps1` 拿它打日志，
   * `verify-runtime.mjs`（锚点 8）与 `simulate-install.mjs` 拿它跟产物对账。
   * 不同步的后果是产物明明对了，校验却报「指纹与 build-meta.json 不符」——
   * 上一次重封就踩在这里，白查了一轮。
   */
  const cacheMetaPath = join(PROJECT, '.cache', 'build-meta.json')
  if (existsSync(cacheMetaPath)) {
    const cacheMeta = JSON.parse(readFileSync(cacheMetaPath, 'utf8'))
    cacheMeta.generatedAt = new Date().toISOString()
    cacheMeta.runtimeSha256 = sha
    cacheMeta.runtimeSize = offset
    cacheMeta.runtimeEntries = cdEntries.length
    cacheMeta.kxxyHostFingerprint = fingerprint
    cacheMeta.kxxyHostMarker = marker
    if (opts.meta && existsSync(opts.meta)) {
      const meta = JSON.parse(readFileSync(opts.meta, 'utf8'))
      if (meta.pythonRepairManifestSha256) cacheMeta.pythonRepairManifestSha256 = meta.pythonRepairManifestSha256
    }
    writeFileSyncSafe(cacheMetaPath, `${JSON.stringify(cacheMeta, null, 2)}\n`)
    console.log(`  构建机副本同步：${cacheMetaPath}`)
  }
}

function writeFileSyncSafe(path, text) {
  const tmp = `${path}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w')
  try {
    const buf = Buffer.from(text, 'utf8')
    let written = 0
    while (written < buf.length) {
      const n = writeSync(fd, buf, written, buf.length - written)
      if (n <= 0) throw new Error('写入失败')
      written += n
    }
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

await main()
