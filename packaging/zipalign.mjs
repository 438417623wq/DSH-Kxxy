#!/usr/bin/env node
/**
 * zipalign —— Android APK 对齐工具（纯 JS 实现，设备上可直接跑）。
 *
 * ── 为什么需要自己写 ────────────────────────────────────────────────────
 *
 * `zipalign` 是 Android SDK build-tools 里的 C++ 二进制，**从不在 Termux
 * 仓库**（`tools/lib/seeds.mjs` G10 注释已写明），Windows/NDK 那份 x86_64
 * 也在设备上跑不起来 —— 这就是用户清单缺口 B 的一半。
 *
 * 但它的算法本身不需要任何 Android 私有逻辑：
 *
 *   1. 条目数据区起点 `local header 偏移 + 30 + 文件名长 + extra 长`
 *      必须是 align（通常 4）的倍数；
 *   2. 不满足就在 **local extra field** 末尾补 `(align - pos % align) % align`
 *      字节（`id=0xd935`、内容 0），同时更新该 local header 的 extra 长度；
 *   3. 中央目录里每个条目的 relative offset 全部重算，CD 与 EOCD 重写。
 *
 * 规则源自 AOSP `zipalign.cpp` 的 `ZipAlign::Align` / `ZipEntry::GetPadding`。
 * AOSP 有一条硬要求：alignment extra **自身至少 4 字节**（`ZipFileRO` 解析时
 * 依赖它对齐）。
 *
 * ── 关键约束：数据区原样搬运 ────────────────────────────────────────────
 *
 * 只支持 STORE（0）与 DEFLATE（8）—— Android 本来也只装这两种。数据**不重压**，
 * 所以 CRC / compressedSize / uncompressedSize 全部原样保留，绝不可能像
 * 「解压再压」那样改坏内容。只有 local extra 与 CD 里的 offset 会变。
 *
 * ── 顺序 ────────────────────────────────────────────────────────────────
 *
 * APK 的 v2/v3 签名块位于 CD 之后、EOCD 之前，且覆盖整个文件字节；重排
 * offset 必然让它失效。所以标准顺序是 **先 zipalign，再 apksigner**。
 * 检测到输入已带 `APK Sig Block 42` 时这里只警告，不中止 —— 有些流程确实
 * 会对已签名包做「仅检查」（`-c`）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *
 *   zipalign -c -v 4 app.apk             # 检查，不写盘；已对齐则退出码 0
 *   zipalign -f 4 in.apk out.apk         # 对齐并写出
 *   zipalign -p 4 in.apk out.apk         # .so 按页对齐（见 -P）
 *   zipalign -f -p -P 16384 4 in.apk out.apk
 */
import { openSync, readSync, writeSync, closeSync, fstatSync, existsSync, rmSync } from 'node:fs'

const ALIGNMENT_EXTRA_ID = 0xd935
const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LFH_SIG = 0x04034b50
const APK_SIG_MAGIC = Buffer.from('APK Sig Block 42', 'latin1')
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
const CHUNK = 4 * 1024 * 1024

function usage(code) {
  process.stdout.write(
    [
      'zipalign [-c|-f] [-v] [-p] [-P <pagesize>] <align> <infile> [<outfile>]',
      '',
      '  -c        只检查，不写盘（已对齐时退出码 0）',
      '  -f        覆盖已存在的输出文件',
      '  -v        逐条目打印偏移变化',
      '  -p        把 .so 按页对齐（默认 4096）',
      '  -P <n>    .so 的页大小（Android 15+ 可为 16384）',
      '  <align>   对齐字节数，通常 4（必须是 2 的幂）',
      '',
    ].join('\n'),
  )
  process.exit(code)
}

function readAt(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length)
  const n = readSync(fd, buf, 0, length, offset)
  return n === length ? buf : buf.subarray(0, n)
}

function findEocd(fd, size) {
  const maxTail = Math.min(size, 0xffff + 22)
  const start = size - maxTail
  const tail = readAt(fd, start, maxTail)
  // 从后往前找：最后出现的 EOCD 才是真的（注释里可能含伪签名）
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      return { offset: start + i, buf: tail.subarray(i, i + 22) }
    }
  }
  return null
}

function fail(msg, code) {
  process.stderr.write(`zipalign: ${msg}\n`)
  process.exit(code === undefined ? 1 : code)
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0) usage(1)

  let checkOnly = false
  let force = false
  let verbose = false
  let pageAlignSo = false
  let pageSize = 4096
  let align = null
  const files = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-c') checkOnly = true
    else if (a === '-f') force = true
    else if (a === '-v') verbose = true
    else if (a === '-p') pageAlignSo = true
    else if (a === '-P') pageSize = Number(argv[++i]) || 4096
    else if (a === '-h' || a === '--help') usage(0)
    else if (/^\d+$/.test(a) && align === null) align = Number(a)
    else files.push(a)
  }

  if (align === null || files.length === 0) usage(1)
  if (align <= 0 || (align & (align - 1)) !== 0) fail(`对齐必须是 2 的幂，收到 ${align}`)

  const inFile = files[0]
  const outFile = files[1]
  if (!checkOnly && !outFile) usage(1)
  if (!existsSync(inFile)) fail(`找不到输入文件 ${inFile}`)

  const fd = openSync(inFile, 'r')
  let outFd = null
  try {
    const size = fstatSync(fd).size
    const eocd = findEocd(fd, size)
    if (!eocd) fail('找不到 EOCD（不是 zip 文件？）')

    const e = eocd.buf
    const cdSize = e.readUInt32LE(12)
    const cdOffset = e.readUInt32LE(16)
    const count = e.readUInt16LE(10)
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      fail('不支持 zip64 EOCD（APK 不会这么大）')
    }
    if (cdOffset + cdSize > size) fail('中央目录越界，文件可能被截断')

    // ── 解析中央目录 ──────────────────────────────────────────────────
    const cd = readAt(fd, cdOffset, cdSize)
    const entries = []
    let q = 0
    while (q + 46 <= cd.length) {
      if (cd.readUInt32LE(q) !== CD_SIG) break
      const nameLen = cd.readUInt16LE(q + 28)
      const extraLen = cd.readUInt16LE(q + 30)
      const commentLen = cd.readUInt16LE(q + 32)
      entries.push({
        name: cd.subarray(q + 46, q + 46 + nameLen).toString('utf8'),
        cdRaw: cd.subarray(q, q + 46 + nameLen + extraLen + commentLen),
        method: cd.readUInt16LE(q + 10),
        compSize: cd.readUInt32LE(q + 20),
        localOffset: cd.readUInt32LE(q + 42),
        offsetFieldAt: 42, // cdRaw 内的字段位置，写回时用
      })
      q += 46 + nameLen + extraLen + commentLen
    }
    if (entries.length === 0) fail('中央目录为空')
    if (entries.length !== count) {
      fail(`CD 条目数 ${entries.length} 与 EOCD 记录的 ${count} 不符`)
    }

    for (const en of entries) {
      if (en.method !== METHOD_STORE && en.method !== METHOD_DEFLATE) {
        fail(`${en.name} 的压缩方法是 ${en.method}，Android 只支持 store/deflate`)
      }
      if (en.compSize === 0xffffffff || en.localOffset === 0xffffffff) {
        fail(`${en.name} 用了 zip64 尺寸字段，不支持`)
      }
    }

    // ── 读每个 local header，算新布局（按物理顺序！）───────────────────
    const physical = [...entries].sort((a, b) => a.localOffset - b.localOffset)
    for (const en of physical) {
      const lfh = readAt(fd, en.localOffset, 30)
      if (lfh.length < 30 || lfh.readUInt32LE(0) !== LFH_SIG) {
        fail(`${en.name} 的 local header 签名不对（偏移 ${en.localOffset}）`)
      }
      const nameLen = lfh.readUInt16LE(26)
      const extraLen = lfh.readUInt16LE(28)
      en.lfh = lfh
      en.lfhName = readAt(fd, en.localOffset + 30, nameLen)
      en.lfhExtra = readAt(fd, en.localOffset + 30 + nameLen, extraLen)
      en.dataOffset = en.localOffset + 30 + nameLen + extraLen
      en.origDataOffset = en.dataOffset
    }

    let cursor = 0
    for (const en of physical) {
      const want = pageAlignSo && en.name.endsWith('.so') ? Math.max(align, pageSize) : align
      const nameLen = en.lfhName.length
      // AOSP 的做法是**在原有 extra 之后追加**一个 alignment extra，
      // 而不是覆写它 —— 原本的 extra 可能带 UT 时间戳、zip64 扩展等，
      // 覆写会直接把条目弄坏。alignment extra 自身占 4 字节头
      // （id 2 + size 2），数据部分才是填充，所以「至少 4 字节」
      // 这条 AOSP 硬要求天然满足。
      const origExtraLen = en.lfhExtra.length
      const head = cursor + 30 + nameLen + origExtraLen + 4
      const padChars = (want - (head % want)) % want
      en.newOffset = cursor
      en.newExtraLen = origExtraLen + 4 + padChars
      en.newDataOffset = cursor + 30 + nameLen + en.newExtraLen
      en.alignWanted = want
      en.padChars = padChars
      cursor = en.newDataOffset + en.compSize
    }

    // ── 检查模式 ──────────────────────────────────────────────────────
    if (checkOnly) {
      let bad = 0
      for (const en of physical) {
        if (en.dataOffset % en.alignWanted === 0) {
          if (verbose) {
            process.stdout.write(`  ${en.name}: ok (offset=${en.dataOffset})\n`)
          }
          continue
        }
        bad++
        if (verbose) {
          process.stdout.write(
            `  ${en.name}: BAD offset=${en.dataOffset} 未按 ${en.alignWanted} 对齐\n`,
          )
        }
      }
      if (bad === 0) {
        process.stdout.write('Verification successful\n')
        return
      }
      process.stderr.write(`Verification FAILED: ${bad} 个条目未对齐\n`)
      process.exitCode = 1
      return
    }

    if (existsSync(outFile) && !force) fail(`${outFile} 已存在（用 -f 覆盖）`)

    // 输入带 v2/v3 签名块时警告（重排一定会让它失效）
    const cdEnd = cdOffset + cdSize
    if (cdEnd + 16 <= size) {
      const probe = readAt(fd, cdEnd, Math.min(32, size - cdEnd))
      if (probe.includes(APK_SIG_MAGIC)) {
        process.stderr.write(
          'zipalign: 警告：输入带 v2/v3 签名块，重排后该签名失效。\n' +
            '          正确顺序是「先 zipalign，再 apksigner」。\n',
        )
      }
    }

    // ── 写出 ──────────────────────────────────────────────────────────
    outFd = openSync(outFile, 'w')
    for (const en of physical) {
      const lfh = Buffer.from(en.lfh)
      lfh.writeUInt16LE(en.newExtraLen, 28)
      writeSync(outFd, lfh)
      writeSync(outFd, en.lfhName)
      // 原 extra 原样保留，尾部追加 alignment extra（至少 4 字节）
      const extra = Buffer.alloc(en.newExtraLen)
      en.lfhExtra.copy(extra, 0)
      const at = Math.max(en.lfhExtra.length, 4)
      extra.writeUInt16LE(ALIGNMENT_EXTRA_ID, 0)
      extra.writeUInt16LE(at - 4, 2) // 本 extra 的数据长度（不含这 4 字节头）
      writeSync(outFd, extra)

      let left = en.compSize
      let pos = en.dataOffset
      while (left > 0) {
        const n = Math.min(CHUNK, left)
        writeSync(outFd, readAt(fd, pos, n))
        pos += n
        left -= n
      }
    }

    const newCdOffset = cursor
    for (const en of physical) {
      const raw = Buffer.from(en.cdRaw)
      raw.writeUInt32LE(en.newOffset, en.offsetFieldAt)
      writeSync(outFd, raw)
    }

    const eocdOut = Buffer.from(e)
    eocdOut.writeUInt32LE(eocdOut.readUInt32LE(12), 12) // cdSize 不变（CD 内容长度未变）
    eocdOut.writeUInt32LE(newCdOffset, 16)
    writeSync(outFd, eocdOut)

    const outSize = newCdOffset + cdSize + 22
    if (verbose) {
      for (const en of physical) {
        const delta = en.newDataOffset - en.origDataOffset
        process.stdout.write(
          `  ${en.name}: ${en.origDataOffset} → ${en.newDataOffset}（${delta >= 0 ? '+' : ''}${delta}，对齐 ${en.alignWanted}）\n`,
        )
      }
      process.stdout.write(`共 ${physical.length} 个条目，输出 ${outSize} 字节\n`)
    }
    process.stdout.write('Verification successful\n')
  } finally {
    if (outFd !== null) closeSync(outFd)
    closeSync(fd)
  }
}

main()
