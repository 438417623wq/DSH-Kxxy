/**
 * 自研 tar 读写器 —— 扩展包池解包与诊断日志导出的共同底座。
 *
 * 为什么自己写：引擎运行时里只有 Node 内置模块。Node 有 zlib（gzip/deflate/
 * brotli）但**没有 xz/lzma**，所以构建期把 Termux deb 的 data.tar.xz 转码成
 * tar.gz（tools/fetch-extensions.mjs），设备端用这里的读器解开；导出日志
 * 则用这里的写器打 tar.gz（同样是零依赖）。
 *
 * 读器是**流式**的：包池最大单项（gradle 闭包）解压后可达数百 MiB，
 * gunzipSync 整块解会顶到手机内存上限；流式逐块吐盘只占固定缓冲。
 *
 * 支持的条目类型（构建期 poolextract.py 已把符号链接全部物化成实体文件，
 * 所以设备端只要求最小集）：
 *   '0'/'\0'  普通文件（GNU longname 'L' 与 PAX 'x' 的 path 覆盖也认）
 *   '5'       目录
 *   '1'       硬链接（从已解出的实体复制 —— 容错路径，正常不应出现）
 *   '2'       符号链接（跳过并记账 —— 构建期应当已物化）
 *   其他      跳过数据区
 */

import { chmodSync, closeSync, copyFileSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { createGunzip, gzipSync } from 'node:zlib'
import { createReadStream } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

const BLOCK = 512

// ---------------------------------------------------------------------------
// 读：tar.gz → 磁盘
// ---------------------------------------------------------------------------

/** 把任意流变成「按需取 n 字节」的读取器。 */
class ChunkReader {
  constructor(stream) {
    this.iter = stream[Symbol.asyncIterator]()
    this.buf = Buffer.alloc(0)
    this.ended = false
  }

  async fill(n) {
    while (this.buf.length < n && !this.ended) {
      const { value, done } = await this.iter.next()
      if (done) {
        this.ended = true
        break
      }
      this.buf = this.buf.length === 0 ? value : Buffer.concat([this.buf, value])
    }
  }

  /** 取 n 字节；流已尽且不足 n 时返回 null（调用方负责清掉残余）。 */
  async read(n) {
    await this.fill(n)
    if (this.buf.length < n) return null
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }
}

/** 512 对齐后的块数。 */
const padded = (n) => Math.ceil(n / BLOCK) * BLOCK

function parseOctal(buf) {
  const text = buf.toString('ascii').replace(/[\0 \u00ff]+$/g, '').trim()
  if (!/^[0-7]*$/.test(text)) return 0
  const n = parseInt(text, 8)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function headerName(hdr) {
  let name = hdr.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '')
  // ustar 前缀段（345..500）：非空时拼在名字前
  const prefixBuf = hdr.subarray(345, 500)
  if (prefixBuf.some((b) => b !== 0)) {
    const prefix = prefixBuf.toString('utf8').replace(/\0[\s\S]*$/, '')
    if (prefix) name = `${prefix}/${name}`
  }
  return name
}

/** zip-slip 防护：解析后的绝对路径必须落在 destDir 内。 */
function safeJoin(destDir, name) {
  const root = resolve(destDir)
  const full = resolve(destDir, name)
  if (full !== root && !full.startsWith(root + sep)) return null
  return full
}

/**
 * 解 tar.gz 到目录。
 *
 * @param {string} gzPath        tar.gz 文件路径
 * @param {string} destDir       目标目录（自动创建）
 * @param {object} [opts]
 * @param {(info: {name: string, size: number, written: number, total: number}) => void}
 *   [opts.onProgress] 每落完一个文件回调一次；total 为已知未压缩总量估计值
 * @param {number} [opts.totalBytes] 未压缩总量估计（用于进度），未知传 0
 * @returns {Promise<{files: number, bytes: number, skipped: string[]}>}
 */
export async function extractTarGz(gzPath, destDir, { onProgress, totalBytes = 0 } = {}) {
  mkdirSync(destDir, { recursive: true })

  const reader = new ChunkReader(
    createReadStream(gzPath).pipe(createGunzip()),
  )
  let written = 0
  let files = 0
  const skipped = []
  let longName = null
  let paxPath = null

  for (;;) {
    const hdr = await reader.read(BLOCK)
    if (hdr === null) break
    // 全零块 = 归档结束（其后通常还有一个零块与填充，直接收尾）
    if (hdr.every((b) => b === 0)) break

    const size = parseOctal(hdr.subarray(124, 136))
    const mode = parseOctal(hdr.subarray(100, 108)) || 0o644
    const typeCode = hdr[156]
    const type = typeCode === 0 || typeCode === 0x20 ? '0' : String.fromCharCode(typeCode)
    let name = headerName(hdr)

    if (type === 'L') {
      const data = await reader.read(padded(size))
      if (data === null) break
      longName = data.subarray(0, size).toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (type === 'x' || type === 'X') {
      // PAX 扩展头：只关心 path 覆盖（`<len> path=<value>\n` 记录序列）
      const data = await reader.read(padded(size))
      if (data === null) break
      const text = data.subarray(0, size).toString('utf8')
      const m = text.match(/^\d+ path=([^\n]*)$/m)
      if (m) paxPath = m[1]
      continue
    }
    if (type === 'g') {
      await reader.read(padded(size))
      continue
    }

    if (longName !== null) name = longName
    else if (paxPath !== null) name = paxPath
    longName = null
    paxPath = null

    const target = name.replace(/\/+$/, '')
    if (!target) {
      await reader.read(padded(size))
      continue
    }

    if (type === '5') {
      const full = safeJoin(destDir, target)
      if (full === null) skipped.push(target)
      else mkdirSync(full, { recursive: true })
      continue
    }

    if (type === '1' || type === '2') {
      // 硬链接 / 符号链接：构建期已物化成实体文件，正常不应出现。
      // 硬链接尽量从已解出的实体复制兜底；符号链接只能跳过并记账。
      const linkTarget = hdr.subarray(157, 257).toString('utf8').replace(/\0[\s\S]*$/, '')
      await reader.read(padded(size))
      const full = safeJoin(destDir, target)
      if (full === null) {
        skipped.push(target)
      } else if (type === '1') {
        const src = safeJoin(destDir, linkTarget)
        if (src !== null) {
          mkdirSync(dirname(full), { recursive: true })
          try {
            copyFileSync(src, full)
            files += 1
          } catch {
            skipped.push(target)
          }
        }
      } else {
        skipped.push(`${target} (symlink -> ${linkTarget})`)
      }
      continue
    }

    if (type !== '0' && type !== '7') {
      // 其他类型（char/block/fifo…）：丢弃数据区
      await reader.read(padded(size))
      skipped.push(`${target} (type ${type})`)
      continue
    }

    // 普通文件：逐块吐盘，避免为单个大文件分配整块缓冲
    const full = safeJoin(destDir, target)
    if (full === null) {
      await reader.read(padded(size))
      skipped.push(target)
      continue
    }
    mkdirSync(dirname(full), { recursive: true })

    const CHUNK = 256 * 1024
    let remaining = size
    const fd = openSync(full, 'w')
    try {
      while (remaining > 0) {
        const take = Math.min(CHUNK, remaining)
        const chunk = await reader.read(take)
        if (chunk === null) throw new Error(`tar 数据区截断：${target}（差 ${remaining} 字节）`)
        writeSync(fd, chunk)
        remaining -= chunk.length
      }
    } finally {
      closeSync(fd)
    }
    if (mode & 0o111) {
      try {
        chmodSync(full, 0o755)
      } catch { /* Windows 构建机上没有可执行位，忽略 */ }
    }
    await reader.read(padded(size) - size) // 丢弃对齐填充

    files += 1
    written += size
    if (onProgress) {
      onProgress({ name: target, size, written, total: totalBytes })
    }
  }

  return { files, bytes: written, skipped }
}

// ---------------------------------------------------------------------------
// 写：内存条目 → tar.gz（Buffer）
// ---------------------------------------------------------------------------

function tarHeader(name, size, mode, mtimeSec) {
  const hdr = Buffer.alloc(BLOCK)
  const nameBuf = Buffer.from(name, 'utf8')
  if (nameBuf.length > 100) throw new Error(`tar 文件名超长（${name}），应走 GNU longname 入口`)

  hdr.write(name, 0, 100, 'utf8')
  hdr.write(`${mode.toString(8).padStart(7, '0')}`, 100, 8, 'ascii')
  hdr.write('0000000', 108, 8, 'ascii') // uid
  hdr.write('0000000', 116, 8, 'ascii') // gid
  hdr.write(size.toString(8).padStart(11, '0'), 124, 12, 'ascii')
  hdr.write(mtimeSec.toString(8).padStart(11, '0'), 136, 12, 'ascii')
  hdr.write('        ', 148, 8, 'ascii') // checksum 占位（空格）
  hdr.write('0', 156, 1, 'ascii') // typeflag: 普通文件
  hdr.write('ustar\0', 257, 6, 'ascii')
  hdr.write('00', 263, 2, 'ascii')

  let sum = 0
  for (const b of hdr) sum += b
  hdr.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return hdr
}

/**
 * 把若干内存条目打成 tar.gz。
 *
 * @param {Array<{name: string, data: Buffer, mode?: number, mtimeSec?: number}>} files
 *   name 用 POSIX 相对路径（不以 / 开头）。
 * @returns {Buffer} gzip 后的 tar
 */
export function tarGzSync(files) {
  const blocks = []

  for (const f of files) {
    const name = String(f.name).replace(/\\/g, '/')
    if (name.startsWith('/') || name.includes('..')) {
      throw new Error(`拒绝打包越界路径：${name}`)
    }
    let headerName = name
    if (Buffer.byteLength(name, 'utf8') > 100) {
      // GNU longname：先写一条 'L' 类型条目承载真实名字；
      // ustar 主头放一个截断名占位（读取器发现 'L' 后以它为准）。
      const nameData = Buffer.concat([Buffer.from(`${name}\0`, 'utf8')])
      const ln = Buffer.alloc(BLOCK)
      ln.write('././@LongLink', 0, 100, 'ascii')
      ln.write(nameData.length.toString(8).padStart(11, '0'), 124, 12, 'ascii')
      ln.write('        ', 148, 8, 'ascii')
      ln.write('L', 156, 1, 'ascii')
      ln.write('ustar\0', 257, 6, 'ascii')
      ln.write('00', 263, 2, 'ascii')
      let lsum = 0
      for (const b of ln) lsum += b
      ln.write(`${lsum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
      blocks.push(ln, nameData, Buffer.alloc(padded(nameData.length) - nameData.length))
      headerName = name.slice(0, 100)
    }
    blocks.push(
      tarHeader(headerName, f.data.length, f.mode ?? 0o644, f.mtimeSec ?? Math.floor(Date.now() / 1000)),
      f.data,
      Buffer.alloc(padded(f.data.length) - f.data.length),
    )
  }

  // 收尾两个零块
  blocks.push(Buffer.alloc(BLOCK * 2))
  const tar = Buffer.concat(blocks)
  return gzipSync(tar, { level: 6 })
}
