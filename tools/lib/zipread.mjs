/**
 * 最小 ZIP 读取器（只读、只解 STORE/DEFLATE）。
 *
 * 为什么需要它：冒烟测试要验证体检模块的 YAML 判定，而判定依赖官方同源的
 * 解析器（`yaml` 或 `js-yaml`）。仓库里没有 `node_modules`（这个项目刻意
 * 不引入 npm 依赖，所有第三方代码都从 `runtime.zip` 里取），开发机上也没
 * 装这两个包 —— 于是 `require('js-yaml')` 在 CI 里必然失败，所有 YAML 项
 * 都退化成 UNKNOWN，判定逻辑一行都测不到。
 *
 * `runtime.zip` 里就有 `lib/node_modules/js-yaml`（33 个文件）。让冒烟测试
 * 从这里把它解到临时目录，测试就自带解析器、不依赖开发机的环境。
 *
 * 刻意不复用 `simulate-install.mjs` 里那段解析：那份代码和安装语义绑在
 * 一起（LINK 注释、placeholder 改写、root 重写），抽出来会把两件事耦合。
 * 这里只要「列名字、取内容」两件事，30 行就够。
 */
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const LOCAL_SIG = 0x04034b50
const MAX_COMMENT = 66_000

/**
 * 逐条枚举 zip 内容，**保持原始压缩字节**。
 *
 * 与 [openZip] 的区别：这里不做解压，只把 `method` / `crc` / 压缩后的字节
 * 原样交出来。用途是「过滤 + 重打包」——调用方先决定留哪些条目，再按自己的
 * 压缩策略重新写一遍。
 *
 * 为什么不能只留下解压后的内容、重打包时一律 store：`aapt2` 解析
 * `resources.arsc` 时会用条目头里的 `compressed_size` 做「data 是否被外层
 * 截断」的健全性检查，store 化会让它算出 `chunk size is bigger than given
 * data` 而拒绝加载（缺陷 CQ 实测）。
 *
 * @param {string} path zip 路径
 * @returns {Array<{ name: string, method: number, crc: number, size: number, raw: Buffer }>}
 *   `raw` 是**压缩后**的字节（method 0 时即原始内容），`size` 是解压后大小。
 */
export function readZipEntries(path) {
  const buf = readFileSync(path)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - MAX_COMMENT); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(`不是合法的 zip（找不到 EOCD）：${path}`)

  const count = buf.readUInt16LE(eocd + 10)
  const cdStart = buf.readUInt32LE(eocd + 16)

  const out = []
  let p = cdStart
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录签名错误（第 ${i} 项）`)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`local header 签名错误：${name}`)
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + lNameLen + lExtraLen
    out.push({ name, method, crc, size, raw: buf.subarray(start, start + csize) })

    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/**
 * 打开一个 zip 并建立中央目录索引。
 *
 * @param {string} path zip 路径
 * @returns {{ names: () => string[], read: (name: string) => Buffer|null }}
 */
export function openZip(path) {
  const buf = readFileSync(path)

  // EOCD 在文件尾部，但可能被 zip 注释挤开（最长 65535 字节）。从尾部向前
  // 找第一个签名 —— 不能假定它正好在末尾 22 字节处。
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - MAX_COMMENT); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(`不是合法的 zip（找不到 EOCD）：${path}`)

  const count = buf.readUInt16LE(eocd + 10)
  const cdStart = buf.readUInt32LE(eocd + 16)

  /** name → { method, csize, localOffset } */
  const index = new Map()
  let p = cdStart
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录签名错误（第 ${i} 项）`)
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    index.set(name, { method, csize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }

  return {
    names: () => [...index.keys()],

    /** 读一个条目的解压内容；目录条目或不存在返回 null。 */
    read(name) {
      const e = index.get(name)
      if (!e) return null
      const lp = e.localOffset
      if (buf.readUInt32LE(lp) !== LOCAL_SIG) throw new Error(`local header 签名错误：${name}`)
      // 注意：local header 的 name/extra 长度可以和中央目录不同（zip 允许
      // 只在其中一处放 extra），所以必须重新读，不能沿用中央目录的值。
      const nameLen = buf.readUInt16LE(lp + 26)
      const extraLen = buf.readUInt16LE(lp + 28)
      const start = lp + 30 + nameLen + extraLen
      const raw = buf.subarray(start, start + e.csize)
      if (e.method === 0) return Buffer.from(raw)
      if (e.method === 8) return inflateRawSync(raw)
      throw new Error(`不支持的压缩方式 ${e.method}：${name}`)
    },
  }
}
