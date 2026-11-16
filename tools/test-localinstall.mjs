/**
 * 本地 npm .tgz 检查回归测试。
 *
 * 只调用公开的 handleInspectRequest / discardUpload，不提交安装、不起服务器、
 * 不联网、不跑 npm 或包内代码。每个合成归档都放在独立的新临时目录里；
 * DSH_HOME / HOME 指向临时 profile，引擎依赖目录同样隔离，结束后全部回收。
 *
 * 用法：node tools/test-localinstall.mjs
 */

import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { tarGzSync } from '../plugins/kxxy-host/lib/tar.mjs'

let passed = 0
let failed = 0

function check(label, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

function equal(label, actual, expected) {
  check(label, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`)
}

const BLOCK = 512
const padded = (size) => Math.ceil(size / BLOCK) * BLOCK
const workdir = mkdtempSync(join(tmpdir(), 'kxxy-localinstall-'))
const home = join(workdir, 'home')
const profile = join(home, 'profiles', 'web')
const staging = join(profile, '.kxxy-plugin-staging')
const archiveRoot = join(workdir, 'archives')
const engineRoot = join(workdir, 'engine')
const marker = join(workdir, 'package-code-executed')
const manifest = `${JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`
const savedEnv = { DSH_HOME: process.env.DSH_HOME, HOME: process.env.HOME }
const activeUploads = new Set()
let discardUpload

/** 手工合成异常头，保留 ustar 布局与 checksum；绝不生成真实文件系统链接。 */
function header({ name = 'package/extra.bin', size = 0, type = '0', linkname = '' } = {}) {
  const hdr = Buffer.alloc(BLOCK)
  hdr.write(name, 0, 100, 'utf8')
  hdr.write('0000644', 100, 8, 'ascii')
  hdr.write('0000000', 108, 8, 'ascii')
  hdr.write('0000000', 116, 8, 'ascii')
  hdr.write(size.toString(8).padStart(11, '0'), 124, 12, 'ascii')
  hdr.write('00000000000', 136, 12, 'ascii')
  hdr.write('        ', 148, 8, 'ascii')
  hdr[156] = type.charCodeAt(0)
  hdr.write(linkname, 157, 100, 'utf8')
  hdr.write('ustar\0', 257, 6, 'ascii')
  hdr.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of hdr) sum += byte
  hdr.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return hdr
}

function entry(options = {}) {
  const data = options.data ?? Buffer.alloc(0)
  return Buffer.concat([header({ ...options, size: data.length }), data, Buffer.alloc(padded(data.length) - data.length)])
}

function packageFile(name = 'kxxy-localinstall-fixture', extra = {}) {
  return {
    name: 'package/package.json',
    data: Buffer.from(JSON.stringify({ name, version: '1.0.0', main: 'index.cjs', ...extra })),
  }
}

function payload(size, name = `package/data-${size}.bin`) {
  // 非零数据避免把漏读的文件体误认成 tar 结束块。
  return { name, data: Buffer.alloc(size, 0x61), mode: 0o644 }
}

function stagedDirs() {
  return existsSync(staging) ? readdirSync(staging).filter((name) => name.startsWith('inspect-')) : []
}

function cleanStaging(label) {
  const uploads = join(staging, 'uploads')
  check(`${label}：上传和 staging 已回收`, stagedDirs().length === 0 && (!existsSync(uploads) || readdirSync(uploads).length === 0))
}

try {
  process.env.DSH_HOME = home
  process.env.HOME = home
  mkdirSync(profile, { recursive: true })
  mkdirSync(archiveRoot)
  mkdirSync(engineRoot)
  writeFileSync(join(profile, 'package.json'), manifest)

  // 先完成隔离再加载被测接口，不使用真实 profile 或引擎目录。
  const api = await import('../plugins/kxxy-host/lib/localinstall.mjs')
  const { CORE_BUNDLES } = await import('../plugins/kxxy-host/lib/health.mjs')
  discardUpload = api.discardUpload

  async function inspect(tgz) {
    const inputDir = mkdtempSync(join(archiveRoot, 'case-'))
    const file = join(inputDir, 'fixture.tgz')
    try {
      writeFileSync(file, tgz)
      const req = createReadStream(file)
      req.headers = { 'content-length': String(tgz.length) }
      const report = await api.handleInspectRequest(req, engineRoot)
      if (report.uploadId) activeUploads.add(report.uploadId)
      return report
    } finally {
      rmSync(inputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }

  async function accepted(label, tgz, files, { entryCount = files.length } = {}) {
    const report = await inspect(tgz)
    try {
      equal(`${label}：inspect 接受`, report.ok, true)
      if (!report.ok) {
        console.log(`       ${report.error}`)
        return
      }
      equal(`${label}：清单条目数`, report.entryCount, entryCount)
      equal(`${label}：未压缩字节数`, report.uncompressedBytes, files.reduce((sum, f) => sum + f.data.length, 0))
      check(`${label}：有效上传会话`, typeof report.uploadId === 'string' && report.uploadId.length > 0)
      const dirs = stagedDirs()
      equal(`${label}：仅一个隔离 staging`, dirs.length, 1)
      if (dirs.length === 1) {
        const dir = join(staging, dirs[0])
        check(`${label}：全部文件内容与大小准确`, files.every((f) => {
          const full = join(dir, ...f.name.split('/'))
          return existsSync(full) && statSync(full).size === f.data.length && readFileSync(full).equals(f.data)
        }))
      }
      return report
    } finally {
      if (report.uploadId) {
        discardUpload(report.uploadId)
        activeUploads.delete(report.uploadId)
      }
      cleanStaging(label)
    }
  }

  async function rejected(label, tgz, errorPattern, { staticCheck = true } = {}) {
    const report = await inspect(tgz)
    equal(`${label}：inspect 拒绝`, report.ok, false)
    check(`${label}：错误原因准确`, errorPattern.test(report.error ?? ''), JSON.stringify(report))
    check(`${label}：没有上传会话`, !report.uploadId)
    if (staticCheck) equal(`${label}：第一遍静态检查拒绝`, report.detail, '静态检查未通过，已放弃安装。')
    if (report.uploadId) {
      discardUpload(report.uploadId)
      activeUploads.delete(report.uploadId)
    }
    cleanStaging(label)
  }

  console.log('[1] 普通文件边界：完整跳过数据和 512 字节填充')
  for (const size of [1, 511, 512, 513]) {
    const files = [payload(size), packageFile()]
    await accepted(`${size} 字节`, tarGzSync(files), files)
  }
  {
    const files = [packageFile(), payload(0), ...[1, 511, 512, 513].map((size) => payload(size)), payload(256 * 1024 * 2 + 513)]
    await accepted('多个文件及跨 256 KiB 分块', tarGzSync(files), files)
  }
  {
    const files = [packageFile(), payload(1, 'package/nul.bin'), payload(511, 'package/space.bin'), payload(513, 'package/contiguous.bin')]
    const raw = Buffer.concat([
      entry({ name: 'package/', type: '5' }),
      ...files.map((f, i) => entry({ ...f, type: ['0', '\0', ' ', '7'][i] })),
      Buffer.alloc(BLOCK * 2),
    ])
    await accepted('目录及 NUL/空格/7 文件类型', gzipSync(raw), files, { entryCount: files.length + 1 })
  }

  console.log('\n[2] 普通文件及条目头截断（gzip 本身完整）')
  const pkg = packageFile()
  const prefix = entry(pkg)
  for (const size of [1, 511, 512, 513]) {
    const hdr = header({ size })
    await rejected(`${size} 字节数据截断`, gzipSync(Buffer.concat([prefix, hdr, Buffer.alloc(size - 1, 0x61)])), /数据区截断/)
    const padding = padded(size) - size
    if (padding > 0) {
      await rejected(`${size} 字节填充截断`, gzipSync(Buffer.concat([prefix, hdr, Buffer.alloc(size, 0x61), Buffer.alloc(padding - 1)])), /填充区截断/)
    }
  }
  await rejected('跨分块数据截断', gzipSync(Buffer.concat([prefix, header({ size: 256 * 1024 + 513 }), Buffer.alloc(256 * 1024 + 512, 0x61)])), /数据区截断/)
  await rejected('下一条目头只剩 511 字节', gzipSync(Buffer.concat([prefix, header().subarray(0, 511)])), /条目头处截断/)

  console.log('\n[3] 需要跳过或读取数据的扩展/空目标/目录分支')
  for (const [type, name, error] of [
    ['g', 'package/global-pax', /PAX 全局扩展头处截断/],
    ['L', '././@LongLink', /GNU longname 条目处截断/],
    ['x', 'package/pax', /PAX 扩展头处截断/],
    ['X', 'package/pax-upper', /PAX 扩展头处截断/],
    ['0', '', /空目标条目处截断/],
    ['5', 'package/subdir/', /数据区截断|填充区截断/],
  ]) {
    for (const [label, body] of [
      ['数据', Buffer.alloc(512, 0x61)],
      ['填充', Buffer.concat([Buffer.alloc(513, 0x61), Buffer.alloc(510)])],
    ]) {
      await rejected(`type ${type} ${name || '空目标'} ${label}截断`, gzipSync(Buffer.concat([prefix, header({ type, name, size: 513 }), body])), error)
    }
  }
  {
    const file = payload(513, `package/${'long-'.repeat(24)}data.bin`)
    const files = [file, pkg]
    await accepted('完整 GNU longname', tarGzSync(files), files)
  }
  for (const type of ['x', 'X']) {
    const file = payload(513, `package/pax-${type}.bin`)
    const line = `path=${file.name}\n`
    let length = Buffer.byteLength(line) + 2
    while (length !== Buffer.byteLength(`${length} ${line}`)) length = Buffer.byteLength(`${length} ${line}`)
    const raw = Buffer.concat([
      entry({ name: 'package/pax', type, data: Buffer.from(`${length} ${line}`) }),
      entry({ name: 'package/placeholder.bin', data: file.data }),
      prefix,
      Buffer.alloc(BLOCK * 2),
    ])
    await accepted(`完整 PAX ${type}`, gzipSync(raw), [file, pkg])
  }
  await accepted('完整全局 PAX 与空目标跳过', gzipSync(Buffer.concat([
    entry({ name: 'package/global-pax', type: 'g', data: Buffer.from('comment=fixture\n') }),
    entry({ name: '', data: Buffer.alloc(513, 0x61) }),
    prefix,
    Buffer.alloc(BLOCK * 2),
  ])), [pkg])

  console.log('\n[4] 链接、路径越界、类型与大小边界不能被放宽')
  for (const [type, label] of [['1', '硬链接'], ['2', '符号链接']]) {
    await rejected(label, gzipSync(Buffer.concat([prefix, entry({ name: 'package/link', type, linkname: 'package/package.json' }), Buffer.alloc(BLOCK * 2)])), /链接条目/)
    // 即使恶意声明巨量或截断链接数据，也应直接拒绝链接，不分配数据缓冲。
    await rejected(`${label}声明巨量数据`, gzipSync(Buffer.concat([prefix, header({ name: 'package/link', type, size: 128 * 1024 * 1024 + 1 })])), /链接条目/)
  }
  for (const name of ['../escape.bin', 'package/../../escape.bin', '/absolute.bin', 'C:/escape.bin', 'package\\escape.bin']) {
    await rejected(`路径 ${name}`, gzipSync(Buffer.concat([prefix, entry({ name, data: Buffer.from('fixture') }), Buffer.alloc(BLOCK * 2)])), /路径越界|绝对路径|盘符|反斜杠/)
  }
  await rejected('不支持的 FIFO 类型', gzipSync(Buffer.concat([prefix, header({ type: '6', size: 128 * 1024 * 1024 + 1 })])), /不支持的条目类型/)
  await rejected('单文件超 128 MiB', gzipSync(Buffer.concat([prefix, header({ size: 128 * 1024 * 1024 + 1 })])), /单文件超过上限/)
  await rejected('条目数超 6000', gzipSync(Buffer.concat([
    prefix,
    ...Array.from({ length: 6000 }, (_, i) => header({ name: `package/empty-${i}.bin` })),
    Buffer.alloc(BLOCK * 2),
  ])), /归档条目数超过上限/)

  console.log('\n[5] 受保护包与缺失依赖：仅静态检查，不安装')
  for (const name of [...CORE_BUNDLES, 'kxxy-host']) {
    // 既有 validPkgName 会把 @scope 当成不含 @ 的片段校验，两个 scoped 核心包
    // 因而可能先被命名校验拒绝；此回归只锁定“不可安装”，不放宽命名规则。
    const error = name.startsWith('@') ? /受保护的核心组件|包名不合法/ : /受保护的核心组件/
    await rejected(`受保护包 ${name}`, tarGzSync([packageFile(name)]), error, { staticCheck: false })
  }
  {
    const files = [packageFile('kxxy-localinstall-fixture', { dependencies: { 'kxxy-fixture-missing-dependency': '1.0.0' } })]
    const report = await accepted('缺失依赖报告', tarGzSync(files), files)
    equal('依赖保持缺失，不联网补齐', report?.depsMissing?.join(','), 'kxxy-fixture-missing-dependency')
  }

  console.log('\n[6] 包内入口及生命周期脚本只落 staging、不执行')
  {
    // 唯一副作用是写测试临时目录内的 marker；不含联网/安装/读取凭证代码。
    const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected execution')\n`
    const files = [
      packageFile('kxxy-localinstall-fixture', { scripts: { preinstall: 'node install.cjs', install: 'node install.cjs', postinstall: 'node install.cjs' } }),
      { name: 'package/index.cjs', data: Buffer.from(source), mode: 0o644 },
      { name: 'package/install.cjs', data: Buffer.from(source), mode: 0o644 },
    ]
    await accepted('带脚本 npm 包', tarGzSync(files), files)
    check('入口和生命周期脚本均未执行', !existsSync(marker))
  }
  equal('临时 profile 清单未改动', readFileSync(join(profile, 'package.json'), 'utf8'), manifest)
  check('没有安装到 node_modules', !existsSync(join(profile, 'node_modules')))
  equal('隔离引擎目录保持空白', readdirSync(engineRoot).length, 0)
  equal('所有输入归档目录已回收', readdirSync(archiveRoot).length, 0)
  cleanStaging('最终检查')
} catch (error) {
  failed += 1
  console.error(`  FAIL 未预期异常：${error.stack ?? error}`)
} finally {
  for (const id of activeUploads) discardUpload?.(id)
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

console.log(`\n本地插件检查测试：${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
