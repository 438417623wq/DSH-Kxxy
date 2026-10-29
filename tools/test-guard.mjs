/**
 * 引擎异常兜底的契约测试（`android/app/src/main/assets/guard/kxxy-guard.cjs`）。
 *
 * 真机上的东西本地没法端到端跑，但兜底逻辑是纯 Node 的，可以在这里把四条
 * 契约钉死 —— 每一条都对应一个「没验过就会在真机上变成事故」的点：
 *
 *   [1] 未捕获的 Promise rejection 不再杀进程，并且落进 state.json
 *   [2] 定时器回调里抛出的异常同样被接住
 *   [3] 子进程**不**继承兜底（否则插件跑 `npm install` 时会吞掉致命错误、
 *       表现为构建卡死）—— 判据是子进程仍然以非零码退出
 *   [4] 同一条错误连续 3 次主动 exit(1)：别留一个半死的进程在那儿占着端口
 *
 * 用法：node tools/test-guard.mjs
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// 反斜杠在 NODE_OPTIONS 的双引号里会被吃成转义（`\d` → `d`），一律换成正斜杠。
const GUARD = resolve('android/app/src/main/assets/guard/kxxy-guard.cjs').replace(/\\/g, '/')
const NODE = process.execPath

let pass = 0
let fail = 0

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

/** 跑一个入口脚本，返回 { code, stdout, stderr, signal }。 */
function run(entry, { guard = true, extraEnv = {}, timeoutMs = 15000 } = {}) {
  const dir = join(entry, '..')
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.KXXY_GUARD_MAIN
  delete env.KXXY_GUARD_DIR
  if (guard) {
    env.NODE_OPTIONS = `--require "${GUARD}"`
    env.KXXY_GUARD_MAIN = '1'
    env.KXXY_GUARD_DIR = join(dir, 'guard')
  }
  Object.assign(env, extraEnv)

  return new Promise((resolveRun) => {
    const child = spawn(NODE, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolveRun({ code, signal, stdout, stderr })
    })
  })
}

function readState(dir) {
  const f = join(dir, 'guard', 'guard-state.json')
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch (_) {
    return null
  }
}

const root = mkdtempSync(join(tmpdir(), 'kxxy-guard-'))

/** 建一个用例目录（每个用例独立，state/log 互不干扰）。 */
function caseDir(name) {
  const d = join(root, name)
  mkdirSync(d, { recursive: true })
  return d
}

try {
  // ── [1] rejection 不再杀进程 ────────────────────────────────────────────
  console.log('[1] 未捕获 rejection 被接住')
  {
    const dir = caseDir('case1')
    const entry = join(dir, 'main.mjs')
    writeFileSync(
      entry,
      `Promise.reject(new Error('boom-async'))
       setTimeout(() => { console.log('ALIVE') }, 300)
       setTimeout(() => { process.exit(0) }, 600)
      `,
    )
    const r = await run(entry)
    ok('进程存活到自然退出（code=0）', r.code === 0, `code=${r.code}`)
    ok('入口没有提前终止', r.stdout.includes('ALIVE'), JSON.stringify(r.stdout))
    const st = readState(dir)
    ok('state.json 记录到 1 次拦截', st && st.total === 1, JSON.stringify(st && st.total))
    ok('记录里带上了原因', st && /boom-async/.test(st.lastMessage || ''), st && st.lastMessage)
    ok('kind 正确', st && st.lastKind === 'unhandledRejection', st && st.lastKind)
  }

  // ── [2] 定时器里抛的异常 ────────────────────────────────────────────────
  console.log('[2] 定时器回调异常被接住')
  {
    const dir = caseDir('case2')
    const entry = join(dir, 'main.mjs')
    writeFileSync(
      entry,
      `setTimeout(() => { throw new TypeError('timer-boom') }, 50)
       setTimeout(() => { console.log('ALIVE') }, 300)
       setTimeout(() => { process.exit(0) }, 600)
      `,
    )
    const r = await run(entry)
    ok('进程存活（code=0）', r.code === 0, `code=${r.code}`)
    ok('入口继续执行', r.stdout.includes('ALIVE'), JSON.stringify(r.stdout))
    const st = readState(dir)
    ok('记录为 uncaughtException', st && st.lastKind === 'uncaughtException', st && st.lastKind)
    ok('日志文件已写出', existsSync(join(dir, 'guard', 'guard.log')))
  }

  // ── [3] 子进程不继承兜底 ────────────────────────────────────────────────
  console.log('[3] 子进程不继承兜底')
  {
    const dir = caseDir('case3')
    const child = join(dir, 'child.mjs')
    const entry = join(dir, 'main.mjs')
    writeFileSync(child, `Promise.reject(new Error('child-boom'))\n`)
    writeFileSync(
      entry,
      `import { spawnSync } from 'node:child_process'
       const r = spawnSync(process.execPath, [${JSON.stringify(child)}], { stdio: 'inherit' })
       console.log('CHILD_STATUS=' + r.status)
       process.exit(0)
      `,
    )
    const r = await run(entry)
    const m = /CHILD_STATUS=(-?\d+)/.exec(r.stdout)
    const status = m ? Number(m[1]) : 0
    ok('子进程按 Node 默认行为失败退出', status !== 0, `status=${status}`)
    // 子进程崩了会把 stderr 打出来，说明没被兜住
    ok('子进程的错误确实冒出来了', /child-boom/.test(r.stderr), r.stderr.slice(0, 200))
  }

  // ── [4] 同一条错误连续 3 次 → 主动退出 ─────────────────────────────────
  console.log('[4] 连环同一错误时主动退出')
  {
    const dir = caseDir('case4')
    const entry = join(dir, 'main.mjs')
    writeFileSync(
      entry,
      `const bad = setInterval(() => { throw new Error('same-boom') }, 30)
       setTimeout(() => { clearInterval(bad); console.log('SHOULD_NOT_REACH'); process.exit(0) }, 2000)
      `,
    )
    const r = await run(entry)
    ok('以非零码退出（交给监管循环重启）', r.code !== 0, `code=${r.code}`)
    ok('退出前没有再执行后续逻辑', !r.stdout.includes('SHOULD_NOT_REACH'))
    const log = readFileSync(join(dir, 'guard', 'guard.log'), 'utf8')
    ok('日志里写明放弃原因', /give-up/.test(log), log.slice(-200))
  }

  // ── [5] 没有开关时不安装 ────────────────────────────────────────────────
  console.log('[5] 缺少主进程开关时不接管')
  {
    const dir = caseDir('case5')
    const entry = join(dir, 'main.mjs')
    writeFileSync(entry, `Promise.reject(new Error('no-guard'))\n`)
    const r = await run(entry, { extraEnv: { KXXY_GUARD_MAIN: '' } })
    ok('进程按 Node 默认行为死亡', r.code !== 0, `code=${r.code}`)
  }
  // ── [6] 归因：profile 下的插件 vs 引擎根下的内核 ─────────────────────
  console.log('[6] 栈归因（插件 / 内核）')
  {
    const dir = caseDir('case6')
    const engine = join(dir, 'engine')
    const pluginDir = join(dir, 'profiles', 'web', 'node_modules', 'fake-plugin')
    const coreDir = join(engine, 'lib', 'node_modules', '@deepseek-ai', 'dsh-core', 'lib')
    mkdirSync(pluginDir, { recursive: true })
    mkdirSync(coreDir, { recursive: true })

    const pluginFile = join(pluginDir, 'index.cjs')
    const coreFile = join(coreDir, 'boom.cjs')
    writeFileSync(pluginFile, 'exports.boom = () => { throw new Error("plugin-side") }\n')
    writeFileSync(coreFile, 'exports.boom = () => { throw new Error("core-side") }\n')

    // 两个入口分开跑，state 各自独立
    for (const [label, file, expectPlugin, expectCore] of [
      ['插件帧', pluginFile, 'fake-plugin', false],
      ['内核帧', coreFile, '@deepseek-ai/dsh-core', true],
    ]) {
      const caseDirName = label === '插件帧' ? 'case6-plugin' : 'case6-core'
      const d = caseDir(caseDirName)
      const entry = join(d, 'main.mjs')
      writeFileSync(
        entry,
        `import { createRequire } from 'node:module'
         const require = createRequire(import.meta.url)
         const mod = require(${JSON.stringify(file)})
         setTimeout(() => { mod.boom() }, 30)
         setTimeout(() => { process.exit(0) }, 500)
        `,
      )
      const r = await run(entry, { extraEnv: { PREFIX: engine } })
      const st = readState(d)
      ok(`${label}：进程存活`, r.code === 0, `code=${r.code}`)
      ok(`${label}：包名 = ${expectPlugin}`, st && st.lastPlugin === expectPlugin, st && st.lastPlugin)
      ok(
        `${label}：core=${expectCore}`,
        st && st.lastCore === expectCore,
        st && String(st.lastCore),
      )
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
