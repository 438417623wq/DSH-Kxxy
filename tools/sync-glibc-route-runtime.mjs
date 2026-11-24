#!/usr/bin/env node
/**
 * 把 `runtime.zip` 里的 `libexec/python-default/kxxy-glibc` 换成当前源码版本。
 *
 * 为什么需要单独一步：这份脚本在运行时里**存在两份**
 *   ① `extensions/glibc/bin/kxxy-glibc` —— 随扩展池（`glibc.pool`）分发；
 *   ② `libexec/python-default/kxxy-glibc` —— 随 runtime.zip 分发，是裸
 *      `python3` / `pip` 路由的容器入口（`python-default.py` 直接 exec 它）。
 * 两份来自同一份源码（`tools/prebuilt/wrappers/kxxy-glibc.sh`），
 * `verify-runtime.mjs` 会逐字节比对 ②，源码一改而不重封就出不了包
 * （报错原文：`路由未与当前源码同步：libexec/python-default/kxxy-glibc`）。
 *
 * 为什么不整包重跑 `build-runtime.mjs`：那份产物 2.5 GiB / 7.7 万条目，
 * 为一个 7 KiB 的脚本重编全部内容，既慢又会顺带改动别的条目（插件指纹、
 * Python 修复资产的字节绑定都要跟着重算）。这里只替换这一个条目，其余条目
 * **原始压缩字节整段搬运**，与 restamp / repair-python 同一套做法。
 *
 * 用法：
 *   node tools/sync-glibc-route-runtime.mjs \
 *     --in  .cache/apk-assets-hold/runtime.zip \
 *     --out .cache/runtime-0.9.81/runtime.zip \
 *     --meta android/app/src/main/assets/meta/build.json
 *
 * 产出：新的 runtime.zip + 更新后的 build.json（sha256 / 体积 / 未压缩字节）。
 * `--out` 必须不存在（拒绝覆盖）；条目数必须与 build.json 一致。
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { openIndexedZip, patchZip } from './lib/zipedit.mjs'
import { PYTHON_DEFAULT_GLIBC, pythonDefaultWrappers } from './lib/python-default.mjs'

function die(message) {
  console.error(`sync-glibc-route: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--in') opts.input = resolve(argv[++i])
    else if (a === '--out') opts.output = resolve(argv[++i])
    else if (a === '--meta') opts.meta = resolve(argv[++i])
    else if (a === '--help' || a === '-h') opts.help = true
    else die(`未知参数：${a}`)
  }
  return opts
}

function sha256OfFile(path) {
  const fd = openSync(path, 'r')
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafeSlow(4 * 1024 * 1024)
  try {
    let n
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return digest.digest('hex')
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help || !opts.input || !opts.output || !opts.meta) {
  console.log('用法：node tools/sync-glibc-route-runtime.mjs --in <runtime.zip> --out <new.zip> --meta <build.json>')
  process.exit(opts.help ? 0 : 1)
}
if (resolve(opts.input) === resolve(opts.output)) die('--out 不能与 --in 相同')
if (existsSync(opts.output)) die(`拒绝覆盖已有归档：${opts.output}`)

const expected = pythonDefaultWrappers().find((f) => f.path === PYTHON_DEFAULT_GLIBC)
if (!expected) die('源码里没有生成 python-default 路由条目，检查 tools/lib/python-default.mjs')

const meta = JSON.parse(readFileSync(opts.meta, 'utf8'))
const input = openIndexedZip(opts.input)
const beforeEntries = input.entries.length
let before
try {
  const entry = input.byName.get(PYTHON_DEFAULT_GLIBC)
  if (!entry) die(`输入里没有 ${PYTHON_DEFAULT_GLIBC}`)
  if (entry.comment.startsWith('LINK:')) die(`${PYTHON_DEFAULT_GLIBC} 是软链条目，形态不符`)
  before = input.read(PYTHON_DEFAULT_GLIBC)
  if (before.equals(expected.data)) die('运行时里的路由脚本已经与源码一致，不需要重封')
  console.log(`[1/3] ${PYTHON_DEFAULT_GLIBC}: ${before.length} B → ${expected.data.length} B（${expected.data.length - before.length >= 0 ? '+' : ''}${expected.data.length - before.length}）`)
} finally {
  input.close()
}

console.log('[2/3] 重封（只替换这一个条目，其余原始压缩字节搬运）…')
const result = await patchZip(
  opts.input,
  opts.output,
  new Map([[PYTHON_DEFAULT_GLIBC, { data: expected.data, mode: 0o755 }]]),
  new Set(),
  { allowZip64Count: true },
)

// 结构复核：条目数不变，除被替换那条外名称/大小/CRC 全部一致。
if (result.entries !== beforeEntries) die(`条目数变化：${result.entries} != ${beforeEntries}`)
if (Number.isFinite(meta.runtimeEntries) && meta.runtimeEntries !== beforeEntries) {
  die(`build.json 的 runtimeEntries=${meta.runtimeEntries} 与输入 ${beforeEntries} 不一致`)
}
const out = openIndexedZip(opts.output)
const ref = openIndexedZip(opts.input)
try {
  for (const [name, entry] of ref.byName) {
    const got = out.byName.get(name)
    if (!got) die(`重封后缺条目：${name}`)
    if (name === PYTHON_DEFAULT_GLIBC) continue
    if (got.size !== entry.size || got.crc !== entry.crc) die(`条目内容被改动：${name}`)
  }
  if (out.entries.length !== ref.entries.length) die('重封后条目数不一致')
} finally {
  out.close()
  ref.close()
}

console.log('[3/3] 更新 build.json …')
const sha256 = sha256OfFile(opts.output)
const delta = expected.data.length - before.length
meta.runtimeSha256 = sha256
meta.runtimeSize = result.size
meta.runtimeEntries = result.entries
meta.runtimeUncompressedBytes = (meta.runtimeUncompressedBytes ?? 0) + delta
writeFileSync(opts.meta, `${JSON.stringify(meta, null, 2)}\n`)

console.log(`完成：${opts.output}`)
console.log(`  ${result.size} B，${result.entries} 条目，sha256 ${sha256}`)
console.log(`  未压缩字节 ${meta.runtimeUncompressedBytes}（${delta >= 0 ? '+' : ''}${delta}）`)
