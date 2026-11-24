#!/usr/bin/env node
/**
 * 把 `tools/prebuilt/wrappers/kxxy-glibc.sh` 同步成 APK 资产
 * `android/app/src/main/assets/glibc-route/kxxy-glibc.sh`。
 *
 * ── 为什么需要这份重复 ────────────────────────────────────────────────────
 *
 * 同一个 glibc 启动器在设备上有两份（`extensions/glibc/bin/kxxy-glibc` 与
 * `libexec/python-default/kxxy-glibc`），它们分别由扩展池与 runtime.zip 分发，
 * 而这两条路径在**升级后的第一次启动**上都不保证是新的：
 *   · 扩展池要先由 `RuntimeInstaller.ensureExtensionPool` 拷到引擎根，
 *     再由 `kxxy-host` 的 `staleExtensions` 判落后才重装 —— 而后者在引擎
 *     初始化时就跑完了，早于前者（时序详见 `RuntimeInstaller.healGlibcLaunchers`
 *     的注释）；
 *   · runtime.zip 里那份只是「内容变了」，不新增锚点，`isComplete()` 照样通过，
 *     老设备根本不会重解压那 2.5 GiB。
 * 所以原生层需要一份**随 APK 走、构建期与源码逐字节一致**的模板，启动同步路径
 * 上直接回填占位符覆盖两份。这份资产就是它。
 *
 * ── 为什么不从 runtime.zip 里抽 ───────────────────────────────────────────
 *
 * `ZipFile` 只接受文件路径（`ZipInputStream` 读不到中央目录的 LINK 注释，
 * 那条路已被 `readZipIndex` 的理由否掉），抽一个条目要先把 982 MB 的 zip 整份
 * 拷到 cacheDir。启动路径上不可接受。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────
 *
 *   node tools/sync-glibc-route-asset.mjs            # 写成资产
 *   node tools/sync-glibc-route-asset.mjs --check    # 只校验（不一致时 exit 1）
 *
 * 换行一律按 LF 写出：`#!/system/bin/sh\r` 会让内核去找一个叫 `sh\r` 的解释器，
 * 报的是 `No such file or directory`（v0.9.79 在 provision 脚本上踩过）。
 * 内容走 `readScriptText`，与 runtime.zip / 扩展池两条分发路径同一套归一化。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readScriptText } from './lib/script-source.mjs'

const project = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(project, 'tools/prebuilt/wrappers/kxxy-glibc.sh')
const ASSET = join(project, 'android/app/src/main/assets/glibc-route/kxxy-glibc.sh')

/**
 * 模板必须带的功能特征。第一个与 `RuntimeInstaller.GLIBC_LAUNCHER_FEATURE` 同名，
 * 设备侧拿它判「APK 里的模板是不是新的」；第二个是上一轮的 DNS 修复，留着当哨兵
 * ——两个都在才说明这份源码同时具备 /etc 与 /dev/shm 两条挂载。
 *
 * 注意：这**不再**是「盘上文件是否最新」的判据（v0.9.83 起改为逐字节比对），
 * 所以以后改启动器不必再动这里的常量。
 */
const MARKS = [':/dev/shm', 'GUEST_ETC=']

const check = process.argv.includes('--check')
const expected = readScriptText(SOURCE, relative(project, SOURCE))
/** 日志里报**字节数**：模板里有 `→` 这类多字节字符，字符串长度会少报几个。 */
const bytes = (text) => Buffer.byteLength(text, 'utf8')

for (const mark of MARKS) {
  if (!expected.includes(mark)) {
    console.error(`sync-glibc-route-asset: 源码里没有 ${mark}，设备侧会判「模板是旧的」并放弃`)
    process.exit(1)
  }
}
if (expected.includes('\r')) {
  console.error('sync-glibc-route-asset: 归一化后仍有 CR，检查 tools/lib/script-source.mjs')
  process.exit(1)
}

if (check) {
  if (!existsSync(ASSET)) {
    console.error(`sync-glibc-route-asset: 缺资产 ${relative(project, ASSET)}，先跑一次不带 --check 的`)
    process.exit(1)
  }
  const actual = readFileSync(ASSET, 'utf8')
  if (actual !== expected) {
    console.error(
      `sync-glibc-route-asset: 资产与源码不一致（${bytes(actual)} B ≠ ${bytes(expected)} B）：` +
      `${relative(project, ASSET)}\n  跑 node tools/sync-glibc-route-asset.mjs 重新生成`,
    )
    process.exit(1)
  }
  console.log(`glibc 启动器资产与源码一致（${bytes(expected)} B）`)
  process.exit(0)
}

mkdirSync(dirname(ASSET), { recursive: true })
const before = existsSync(ASSET) ? readFileSync(ASSET, 'utf8') : null
if (before === expected) {
  console.log(`glibc 启动器资产已是最新（${bytes(expected)} B）`)
  process.exit(0)
}
writeFileSync(ASSET, expected, 'utf8')
console.log(
  `glibc 启动器资产已更新：${relative(project, ASSET)} ` +
  `(${before === null ? '新建' : `${bytes(before)} B → `}${bytes(expected)} B)`,
)
