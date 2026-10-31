/**
 * 网页端 / 引擎启动失败的**统一解析层**。
 *
 * 为什么单独一个模块：同一件事有两个观察点，两个消费者——
 *
 *   ① 服务端 `engine.log`：`dsh-app-boot` 把未激活的 entry 与跳过的 bundle
 *      打到 stderr（`<bin>: warning: N entries did not activate` /
 *      `<bin>: skipping profile bundle "x": reason`）；
 *   ② 浏览器 console：前端 boot 阶段解析 client-modules 失败时会整页替换成
 *      `Failed to load plugins`，那条错误由原生 `WebBootLog` 落盘。
 *
 * 体检要用它回答「页面进不进得去」，插件页要用它回答「哪个插件加载失败了」。
 * 两边各写一份正则必然漂移 —— 一份说加载失败、另一份说正常，是最难排查的
 * 那种自相矛盾。所以格式解析只在这里做一次。
 *
 * 全部只读，不写盘。
 *
 * @module kxxy-host/bootreport
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 引擎日志里一次启动的分隔标记（EngineProcess 写入，单位毫秒）。 */
const START_MARKER = /---- engine start (\d+) ----/g

/** 只看日志尾部这么多：引擎日志有 2 MB 环形上限，尾部足够覆盖本次启动。 */
const TAIL_BYTES = 256 * 1024

/**
 * 从日志尾部找本次启动的时刻。
 *
 * 取**最后一个**标记：日志是追加写的，环形截断后可能从上一轮的中间开始，
 * 但最后一轮启动标记之后才是当前进程的输出。找不到返回 0（调用方按
 * 「整段都属于本次」处理 —— 宁可多报一条旧失败，也不要因为格式变了就静默）。
 */
export function currentRunStart(text) {
  if (typeof text !== 'string' || !text) return 0
  let last = 0
  START_MARKER.lastIndex = 0
  let m
  while ((m = START_MARKER.exec(text)) !== null) {
    const v = Number(m[1])
    if (Number.isFinite(v) && v > last) last = v
  }
  return last
}

/**
 * 从一句话里摘出插件名。
 *
 * 两种措辞都出现过：
 *   · `web boot: 4 entries did not activate @a/b @c/d`（前端，空格分隔）
 *   · `web boot: warning: 4 entries did not activate`  + 下一行 `@a/b (name): detail`
 *
 * 只认「@scope/name」或「看起来像包名」的 token，避免把
 * `entries`/`did`/`not` 这类单词当成插件名。
 */
export function pluginNamesFrom(text) {
  if (typeof text !== 'string') return []
  const out = new Set()
  const re = /(@[a-z0-9._-]+\/[a-z0-9._-]+)|\b((?:dsh|kxxy)[a-z0-9._-]*)\b/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const name = (m[1] || m[2] || '').trim()
    // 短于 3 个字符的（如 `dsh`）几乎都是正文词，不是包名
    if (name && name.length >= 4) out.add(name)
  }
  return [...out]
}

/**
 * 解析日志尾部（只看本次启动之后的部分）。
 *
 * 返回：
 *   · `skipped`  —— 解析不到目录、被整体跳过的 bundle（装了但没生效）
 *   · `inactive` —— 进入了 Loader 但 fiber 没激活的 entry（更细的粒度）
 *   · `required` —— 出现 `startup failed`，意味着引擎**根本没起来**
 *   · `started`  —— 本次启动时刻
 */
export function parseEngineLog(text) {
  const started = currentRunStart(text)
  // 只解析最后一轮启动之后的部分：日志是环形的，可能从上一轮中间开始。
  // 没有标记时（老版本日志、格式变化）退回整段，宁可多报也不静默。
  const idx = typeof text === 'string' ? text.lastIndexOf('---- engine start') : -1
  const body = idx >= 0 ? text.slice(idx) : (text ?? '')

  const skipped = []
  const inactive = []
  let required = false

  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    const skip = /skipping profile bundle\s+"([^"]+)"\s*:\s*(.*)$/.exec(line)
    if (skip) {
      skipped.push({ name: skip[1], reason: skip[2].trim() })
      continue
    }

    if (/startup failed:.*required plugin/.test(line)) {
      required = true
      continue
    }

    // `web boot: warning: 4 entries did not activate` —— 详情在紧随其后的行里，
    // 形如 `@scope/name (name): phase: error`。逐行吃到下一条 warning 或空行为止。
    if (/warning:\s*\d+\s+entr(?:y|ies)\s+did not activate/.test(line)) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j]
        if (!next.trim()) break
        if (/warning:\s*\d+\s+entr/.test(next)) break
        const detail = /^(\S+)\s*(?:\([^)]*\))?\s*:\s*(.*)$/.exec(next.trim())
        if (detail) inactive.push({ id: detail[1], detail: detail[2].slice(0, 300) })
        else break
      }
    }
  }

  return { started, skipped, inactive, required }
}

/** 读原生落盘的浏览器侧启动失败（`$HOME/web-boot/web-boot.json`）。 */
export function readWebBootFile(home) {
  const file = home ? join(home, 'web-boot', 'web-boot.json') : ''
  if (!file || !existsSync(file)) return { file, entries: [] }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const entries = Array.isArray(raw?.entries) ? raw.entries : []
    return { file, entries }
  } catch {
    // 文件坏了不该让体检或插件页崩：当成「没抓到」处理，另有用例覆盖
    return { file, entries: [], corrupt: true }
  }
}

/**
 * 一次汇总。
 *
 * `browser` 只保留**本次启动之后**的记录：引擎重启会清空这个文件，但用户
 * 可能在中途清数据、或文件被别的东西恢复，按时间再兜一层，避免拿上个月的
 * 失败把现在的绿状态染红。
 */
export function collectBootReport(engineRoot, home) {
  let logText = ''
  try {
    const logFile = engineRoot ? join(engineRoot, 'engine.log') : ''
    if (logFile && existsSync(logFile)) {
      const all = readFileSync(logFile, 'utf8')
      logText = all.slice(-TAIL_BYTES)
    }
  } catch {
    logText = ''
  }

  const parsed = parseEngineLog(logText)
  const { entries } = readWebBootFile(home)
  const since = parsed.started || 0
  const browser = entries
    .filter((e) => {
      const at = Number(e?.at) || 0
      return since > 0 ? at >= since : true
    })
    .map((e) => ({
      at: Number(e.at) || 0,
      message: String(e.message ?? ''),
      names: pluginNamesFrom(String(e.message ?? '')),
    }))

  // 名字去重：同一句错误里可能既出现包名又出现 entry id，合并成一条
  const failedNames = new Set()
  for (const b of browser) for (const n of b.names) failedNames.add(n)
  for (const i of parsed.inactive) for (const n of pluginNamesFrom(i.id)) failedNames.add(n)
  for (const s of parsed.skipped) failedNames.add(s.name)

  return {
    started: parsed.started,
    skipped: parsed.skipped,
    inactive: parsed.inactive,
    required: parsed.required,
    browser,
    failedNames: [...failedNames],
  }
}
