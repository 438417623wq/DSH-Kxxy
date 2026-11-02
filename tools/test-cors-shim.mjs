/**
 * 跨源补丁的契约测试（`android/app/src/main/assets/guard/kxxy-cors.cjs`）。
 *
 * 真机上的现象没法在本地复现（Android WebView 的同源策略是系统行为），
 * 但补丁本身的语义是纯 Node 的，可以在这里钉死 —— 每一条都对应一个
 * 「没验过就会在真机上变成事故」的点：
 *
 *   [1] 本机 Origin（127.0.0.1:3080）→ 回显 ACAO + credentials + Vary
 *   [2] **同源请求不受影响**：不带 Origin 就一个头都不加（绝大多数流量）
 *   [3] 外部 Origin 不回显：本机端口存着 API Key 与对话，不能被网站读走
 *   [4] 预检 OPTIONS 直接 204，且**业务 handler 不执行**（否则日志里全是
 *       ERR_HTTP_HEADERS_SENT）
 *   [5] 响应体一个字节都不动（JSON 与流式都一样）
 *   [6] 重复 require 不叠加：多层包装会让每个请求多跑几次 emit
 *   [7] KXXY_CORS=0 可以关掉（排查时不用改代码）
 *
 * 用法：node tools/test-cors-shim.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// 反斜杠在 NODE_OPTIONS 的双引号里会被吃成转义，一律换成正斜杠（同 test-guard）。
const SHIM = resolve('android/app/src/main/assets/guard/kxxy-cors.cjs').replace(/\\/g, '/')
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

/**
 * fixture：一个「插件自己起的本地服务」。
 *
 * 刻意做成最小形态 —— 只有 http.createServer，不引框架。补丁包的是
 * `http.Server.prototype.emit`，所以这里验证的正是插件真实走的那条路。
 */
const FIXTURE = `
'use strict'
const http = require('http')
let handlerRanForPreflight = false
const server = http.createServer((req, res) => {
  const url = req.url || '/'
  if (url.startsWith('/preflight')) {
    handlerRanForPreflight = true
  }
  if (url.startsWith('/seen')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ handlerRanForPreflight }))
    return
  }
  if (url.startsWith('/sse')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    let n = 0
    const timer = setInterval(() => {
      n += 1
      res.write('data: chunk-' + n + '\\n\\n')
      if (n >= 3) {
        clearInterval(timer)
        res.end()
      }
    }, 10)
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, path: url }))
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\\n')
})
`

/** 起一个 fixture 子进程，返回 { port, stop }。 */
function startFixture({ shim = true, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kxxy-cors-'))
  const entry = join(dir, 'server.cjs')
  writeFileSync(entry, FIXTURE, 'utf8')

  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.KXXY_CORS
  if (shim) env.NODE_OPTIONS = `--require "${SHIM}" --require "${SHIM}"`
  Object.assign(env, extraEnv)

  const child = spawn(NODE, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolvePort, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('fixture 启动超时')), 15000)
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const m = /PORT=(\d+)/.exec(buf)
      if (m) {
        clearTimeout(timer)
        resolvePort({
          port: Number(m[1]),
          stop: () => {
            try {
              child.kill()
            } catch {
              /* 忽略 */
            }
            try {
              rmSync(dir, { recursive: true, force: true })
            } catch {
              /* 忽略 */
            }
          },
        })
      }
    })
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[fixture] ${chunk}`)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`fixture 提前退出，code=${code}`))
    })
  })
}

/** 裸 http 请求（不经过 fetch，才能看到真实的原始响应头）。 */
function request(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolveRes, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        resolveRes({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')))
    req.end()
  })
}

const LOCAL_ORIGIN = 'http://127.0.0.1:3080'

async function main() {
  console.log('[1] 本机页面的跨源请求')
  {
    const fx = await startFixture()
    try {
      const res = await request(fx.port, { path: '/api', headers: { origin: LOCAL_ORIGIN } })
      ok('回显 Origin（不是 *）', res.headers['access-control-allow-origin'] === LOCAL_ORIGIN,
        String(res.headers['access-control-allow-origin']))
      ok('允许携带凭证', res.headers['access-control-allow-credentials'] === 'true')
      ok('声明 Vary: Origin', /origin/i.test(String(res.headers.vary || '')))
      ok('状态码与响应体不变', res.status === 200 && JSON.parse(res.body).ok === true, res.body.slice(0, 80))
    } finally {
      fx.stop()
    }
  }

  console.log('[2] 同源请求（不带 Origin）不动声色')
  {
    const fx = await startFixture()
    try {
      const res = await request(fx.port, { path: '/api' })
      ok('不加 Access-Control-Allow-Origin', res.headers['access-control-allow-origin'] === undefined)
      ok('不加 credentials', res.headers['access-control-allow-credentials'] === undefined)
      ok('响应体正常', JSON.parse(res.body).ok === true)
    } finally {
      fx.stop()
    }
  }

  console.log('[3] 外部网页的 Origin 不回显')
  {
    const fx = await startFixture()
    try {
      for (const origin of ['https://example.com', 'http://192.168.1.9:3080', 'null']) {
        const res = await request(fx.port, { path: '/api', headers: { origin } })
        ok(`不回显 ${origin}`, res.headers['access-control-allow-origin'] === undefined,
          String(res.headers['access-control-allow-origin']))
      }
    } finally {
      fx.stop()
    }
  }

  console.log('[4] 预检：204 直接应答，业务 handler 不跑')
  {
    const fx = await startFixture()
    try {
      const pre = await request(fx.port, {
        method: 'OPTIONS',
        path: '/preflight',
        headers: {
          origin: LOCAL_ORIGIN,
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'content-type,x-custom',
        },
      })
      ok('状态码 204', pre.status === 204, String(pre.status))
      ok('回显允许的方法', /PUT/.test(String(pre.headers['access-control-allow-methods'])))
      ok('回显允许的请求头', String(pre.headers['access-control-allow-headers']).includes('x-custom'))
      ok('带 credentials', pre.headers['access-control-allow-credentials'] === 'true')
      ok('空响应体', pre.body === '', pre.body.slice(0, 40))

      const seen = await request(fx.port, { path: '/seen', headers: { origin: LOCAL_ORIGIN } })
      ok('业务 handler 没被执行', JSON.parse(seen.body).handlerRanForPreflight === false)
    } finally {
      fx.stop()
    }
  }

  console.log('[5] 流式响应照常，且带 CORS 头')
  {
    const fx = await startFixture()
    try {
      const res = await request(fx.port, { path: '/sse', headers: { origin: LOCAL_ORIGIN } })
      ok('content-type 仍是 text/event-stream', /text\/event-stream/.test(String(res.headers['content-type'])))
      ok('三块数据都到齐', (res.body.match(/data: chunk-/g) || []).length === 3, JSON.stringify(res.body))
      ok('SSE 也带 ACAO', res.headers['access-control-allow-origin'] === LOCAL_ORIGIN)
    } finally {
      fx.stop()
    }
  }

  console.log('[6] 重复注入只装一次')
  {
    // 上面所有 fixture 都用 `--require SHIM --require SHIM` 起的。
    // 若没有幂等保护，emit 会被包两层：一次请求里 setHeader 两次虽然看不出，
    // 但预检会被第一层吞掉、第二层却已经跑过 origEmit —— 这里用「预检 handler
    // 是否执行」间接验证只有一层在生效（[4] 已断言 false）。
    const fx = await startFixture()
    try {
      const res = await request(fx.port, { path: '/api', headers: { origin: LOCAL_ORIGIN } })
      ok('双层 require 下响应仍然正确', res.status === 200 && JSON.parse(res.body).ok === true)
    } finally {
      fx.stop()
    }
  }

  console.log('[7] KXXY_CORS=0 关闭')
  {
    const fx = await startFixture({ extraEnv: { KXXY_CORS: '0' } })
    try {
      const res = await request(fx.port, { path: '/api', headers: { origin: LOCAL_ORIGIN } })
      ok('不注入任何 CORS 头', res.headers['access-control-allow-origin'] === undefined)
      ok('业务照常', JSON.parse(res.body).ok === true)
    } finally {
      fx.stop()
    }
  }

  console.log('')
  console.log(fail === 0 ? `全部通过（${pass} 项）` : `${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
