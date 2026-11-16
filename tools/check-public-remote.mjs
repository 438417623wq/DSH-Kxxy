#!/usr/bin/env node
/**
 * 公网远程接入的分层验收。
 *
 * ## 为什么需要它
 *
 * 「手机打开了一个页面」和「真的能远程用电脑上的 DSH」之间隔着五层，
 * 而每一层失败时的现象都差不多：白屏、转圈、或者一句英文 401。用户能
 * 拿到的唯一线索往往就是「连不上」，于是只能来回试。
 *
 * 这个脚本把那条链路拆开，逐层给出「通 / 不通 / 警告」，并把不通的那一层
 * 翻译成下一步动作。它**只读**：不部署、不改配置、不写设备数据。
 *
 * ## 用法
 *
 *     node tools/check-public-remote.mjs https://kxxy.example.com --code a1b2c3d4
 *     node tools/check-public-remote.mjs https://kxxy.example.com --code a1b2c3d4 --json
 *
 *     # 本机自测（连接器刚起、还没接隧道时也能跑）
 *     node tools/check-public-remote.mjs http://192.168.1.23:8080 --code a1b2c3d4 --allow-http
 *
 * ## 退出码
 *
 *   0  全部通过（可能有警告）
 *   1  有一层失败
 *   2  参数不对
 *
 * ## 它不做什么
 *
 * 不验证「DSH 的模型能不能回话」——那需要真的发一条会话请求、会消耗额度，
 * 而且属于产品功能验收，不是接入验收。它止步于「这条链路能把 DSH 的页面
 * 与实时通道送到手机」。
 */

import dns from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'
import https from 'node:https'
import http from 'node:http'

const args = parseArgs(process.argv.slice(2))

if (args.help || args.h || !args._[0]) {
  console.log(`用法：node tools/check-public-remote.mjs <入口地址> --code <配对码> [选项]

  <入口地址>      手机实际访问的地址，例如 https://kxxy.example.com
  --code <str>    连接器当前打印的配对码（8 位十六进制）
  --json          只输出 JSON（给脚本/CI 用）
  --allow-http    允许 http 入口（仅本机/局域网自测，公网不要开）
  --timeout <ms>  单步超时（默认 8000）
  --help          显示本帮助

验收五层：DNS → TLS 证书 → 配对与来源校验 → 页面/鉴权 → 实时通道（WebSocket）`)
  process.exit(args.help || args.h ? 0 : 2)
}

const rawUrl = String(args._[0])
let target
try {
  target = new URL(rawUrl)
} catch {
  fail('入口地址不是合法 URL：' + rawUrl)
}

const code = typeof args.code === 'string' ? args.code : ''
const timeoutMs = Number(args.timeout ?? 8000) || 8000
const isHttps = target.protocol === 'https:'
const allowHttp = Boolean(args['allow-http'])
const jsonOnly = Boolean(args.json)

if (!isHttps && !allowHttp) {
  fail('公网入口必须是 https://。本机自测请显式加 --allow-http')
}

const results = []
const t0 = Date.now()

function record(name, status, detail, hint) {
  results.push({ name, status, detail, hint })
  if (!jsonOnly) {
    const mark = status === 'ok' ? '✓' : status === 'warn' ? '!' : '✗'
    const color = status === 'ok' ? '\x1b[32m' : status === 'warn' ? '\x1b[33m' : '\x1b[31m'
    console.log(`  ${color}${mark}\x1b[0m ${name}`)
    if (detail) console.log(`    ${detail}`)
    if (hint && status !== 'ok') console.log(`    → ${hint}`)
  }
}

function fail(message) {
  console.error(message)
  process.exit(2)
}

const host = target.hostname
const port = Number(target.port || (isHttps ? 443 : 80))

if (!jsonOnly) {
  console.log('')
  console.log(`  验收目标  ${target.origin}`)
  console.log(`  配对码    ${code ? code.slice(0, 2) + '••••' + code.slice(-2) : '（没给，跳过配对层）'}`)
  console.log('')
}

// ---------------------------------------------------------------------------
// 1. DNS
// ---------------------------------------------------------------------------
let resolved = null
try {
  const records = await dns.lookup(host, { all: true })
  resolved = records
  record(
    'DNS 解析',
    'ok',
    records.map((r) => `${r.address} (IPv${r.family})`).join(', '),
  )
} catch (err) {
  record('DNS 解析', 'fail', `${host} 解析不到：${err.code || err.message}`,
    '域名没生效或拼错了。隧道服务一般会要求你先在它的面板里绑定这个域名。')
}

// ---------------------------------------------------------------------------
// 2. TLS 证书
// ---------------------------------------------------------------------------
let session = ''
if (isHttps) {
  try {
    const info = await probeTls(host, port)
    const cert = info.cert
    const selfSigned = cert.issuer && cert.subject && cert.issuer.CN === cert.subject.CN
    const daysLeft = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000)
    const san = String(cert.subjectaltname || '')
    const coversHost = san.includes(`DNS:${host}`) || san.includes(`DNS:*.${host.split('.').slice(1).join('.')}`)

    if (!coversHost) {
      record('TLS 证书', 'fail', `证书没有签给 ${host}（SAN: ${san || '空'}）`,
        '隧道域名与证书不匹配。Cloudflare 命名隧道要在面板里确认 Public Hostname 指向了这台机器。')
    } else if (daysLeft < 0) {
      record('TLS 证书', 'fail', `证书已过期 ${-daysLeft} 天`, '续期或换一张证书。过期证书在手机上一定会被拒。')
    } else if (daysLeft < 14) {
      record('TLS 证书', 'warn', `${cert.issuer?.O || cert.issuer?.CN}，还有 ${daysLeft} 天到期`,
        '续期窗口内。续期如果换了证书，手机上固定过的指纹会失效，需要删掉设备重扫。')
    } else if (selfSigned) {
      record('TLS 证书', 'warn', `自签证书「${cert.subject?.CN || host}」，还有 ${daysLeft} 天`,
        '可以用：手机首次连接会记录指纹（TOFU）。但换证书后需要删掉设备重扫，否则会被拒绝。')
    } else {
      record('TLS 证书', 'ok', `${cert.issuer?.O || cert.issuer?.CN}，还有 ${daysLeft} 天`)
    }
  } catch (err) {
    record('TLS 证书', 'fail', `握手失败：${err.code || err.message}`,
      '隧道进程没在跑、端口不通、或者证书链不完整。先在电脑上 `curl -v ' + target.origin + '` 看服务端报什么。')
  }
}

// ---------------------------------------------------------------------------
// 3. 配对与来源校验
// ---------------------------------------------------------------------------
if (code) {
  const pairPath = `/__kxxy_pair?code=${encodeURIComponent(code)}&label=check`
  try {
    const res = await request(target.origin + pairPath, { redirect: 'manual' })
    if (res.status === 421) {
      record('配对与来源校验', 'fail', 'HTTP 421：连接器不认识这个 Host',
        '连接器带了 --public-origin，但值和你现在访问的域名不一致。两者必须完全相同（含协议）。')
    } else if (res.status === 429) {
      record('配对与来源校验', 'fail', 'HTTP 429：这个来源被限流了',
        '之前有多次配对失败。等锁定期过去，或重启连接器换一个配对码。')
    } else if (res.status === 401) {
      record('配对与来源校验', 'fail', 'HTTP 401：配对码不对或已过期',
        '以电脑终端里**当前**打印的配对码为准。带 --code-ttl 启动时，过期要重启。')
    } else if (res.status === 302 || res.status === 303) {
      const cookie = pickCookie(res.headers['set-cookie'], 'kxxy_pair')
      if (!cookie) {
        record('配对与来源校验', 'fail', '配对通过了，但没有下发会话 cookie',
          '隧道可能过滤了 Set-Cookie。检查隧道是否开了「重写 Cookie」之类的选项。')
      } else {
        session = cookie
        const secure = /;\s*Secure/i.test(String(res.headers['set-cookie']))
        record(
          '配对与来源校验',
          secure || !isHttps ? 'ok' : 'warn',
          `配对成功，已拿到会话票据（${cookie.length} 字符）${secure ? '，Secure' : '，未标 Secure'}`,
          secure ? '' : '公网 https 入口应该带 Secure。连接器要加 --public-origin 才会标它。',
        )
      }
    } else {
      record('配对与来源校验', 'fail', `配对返回 HTTP ${res.status}`,
        '入口指向的可能不是连接器（是 DSH 本身？）。注意暴露的是连接器端口，不是 3080。')
    }
  } catch (err) {
    record('配对与来源校验', 'fail', `请求失败：${err.code || err.message}`,
      '这一层失败通常是隧道没把请求转回本机连接器。先确认隧道进程在跑、映射端口对。')
  }
}

// ---------------------------------------------------------------------------
// 4. 页面与鉴权
// ---------------------------------------------------------------------------
if (session) {
  try {
    const res = await request(target.origin + '/', {
      redirect: 'manual',
      headers: { cookie: `kxxy_pair=${session}`, 'sec-fetch-dest': 'document', accept: 'text/html' },
    })
    if (res.status === 302 && String(res.headers.location || '').includes('token=')) {
      record('页面与鉴权', 'ok', '连接器把首次访问导向带 token 的地址（上游还没换 cookie，属正常）')
      // 跟随一次，看上游是否愿意换 cookie
      const followed = await request(target.origin + String(res.headers.location), {
        redirect: 'manual',
        headers: { cookie: `kxxy_pair=${session}`, 'sec-fetch-dest': 'document', accept: 'text/html' },
      })
      const upstreamCookie = pickCookie(followed.headers['set-cookie'], '')
      if (followed.status === 401 || followed.status === 403) {
        record('DSH 上游', 'fail', `上游返回 ${followed.status}：token 没换成会话`,
          '电脑上的 DSH 可能重启过、token 变了。用 --target 带上当前 token 重启连接器。')
      } else if (followed.status >= 500) {
        record('DSH 上游', 'fail', `上游返回 ${followed.status}`,
          'DSH 进程本身有问题。先在电脑上直接打开 127.0.0.1:3080 确认。')
      } else if (upstreamCookie) {
        // 上游用 token 换到了会话 cookie —— 这正是这一层要证明的事。
        // 状态码是 302 还是 200 不重要：DSH 换完 cookie 会再跳一次首页。
        record('DSH 上游', 'ok', `token 已换成上游会话（HTTP ${followed.status}）`)
      } else if (followed.status === 200) {
        record('DSH 上游', 'ok', '上游返回 200，页面可取（未下发新 cookie，说明已有会话）')
      } else {
        record('DSH 上游', 'warn', `上游返回 ${followed.status}，且没有下发会话 cookie`,
          '可能是 DSH 版本不认这个 token，或隧道改写了 Cookie。先在电脑上直接访问确认。')
      }
    } else if (res.status === 200) {
      record('页面与鉴权', 'ok', '直接 200：浏览器已有上游会话')
    } else if (res.status === 401) {
      record('页面与鉴权', 'fail', '会话票据被拒', '连接器可能重启过（会话存在内存里）。重新配对。')
    } else if (res.status >= 500) {
      record('页面与鉴权', 'fail', `HTTP ${res.status}`,
        '连接器活着但上游不通。先在电脑上确认 DSH 桌面端在运行。')
    } else {
      record('页面与鉴权', 'warn', `HTTP ${res.status}`)
    }
  } catch (err) {
    record('页面与鉴权', 'fail', `请求失败：${err.code || err.message}`)
  }
}

// ---------------------------------------------------------------------------
// 5. 实时通道（WebSocket）
// ---------------------------------------------------------------------------
if (session) {
  try {
    const line = await probeUpgrade(host, port, isHttps, session, timeoutMs)
    if (/^HTTP\/1\.1 101/.test(line)) {
      record('实时通道', 'ok', 'WebSocket 握手 101：流式对话的通道是通的')
    } else if (/401/.test(line)) {
      record('实时通道', 'fail', `升级被拒：${line}`,
        '会话在 upgrade 阶段失效。若上一步是 200，说明隧道把 Cookie 丢了 —— 检查隧道是否原样转发 Cookie 头。')
    } else {
      record('实时通道', 'fail', `升级没成功：${line || '（无响应）'}`,
        '隧道可能不支持 WebSocket / 长连接。Cloudflare 支持；某些免费反代会在 100 秒后掐断。')
    }
  } catch (err) {
    record('实时通道', 'fail', `握手失败：${err.code || err.message}`,
      '连不上或超时。若页面能开而这里挂，问题通常在隧道的长连接支持上。')
  }
}

// ---------------------------------------------------------------------------
// 结论
// ---------------------------------------------------------------------------
const failed = results.filter((r) => r.status === 'fail')
const warned = results.filter((r) => r.status === 'warn')
const elapsed = Date.now() - t0

if (jsonOnly) {
  console.log(JSON.stringify({ target: target.origin, elapsedMs: elapsed, results }, null, 2))
} else {
  console.log('')
  if (failed.length) {
    console.log(`  结论：${failed.length} 层不通 —— 先修「${failed[0].name}」`)
  } else if (warned.length) {
    console.log(`  结论：链路可用，${warned.length} 条警告`)
  } else {
    console.log('  结论：五层全通。')
  }
  console.log(`  耗时：${elapsed} ms`)
  console.log('')
  console.log('  下一步（手机上）：关掉 Wi-Fi，用蜂窝网络扫一次连接串，发一条消息看有没有流式回复。')
  console.log('  这一步不能省：能在这里跑通，只说明「从这台电脑访问」是通的。')
  console.log('')
}

process.exit(failed.length ? 1 : 0)

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      out._.push(arg)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

function probeTls(hostname, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, ALPNProtocols: ['http/1.1'], timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate()
        const protocol = socket.getProtocol()
        socket.destroy()
        if (!cert || !cert.valid_to) {
          reject(new Error('服务端没有提供证书'))
          return
        }
        resolve({ cert, protocol })
      },
    )
    socket.on('timeout', () => {
      socket.destroy()
      reject(Object.assign(new Error('TLS 握手超时'), { code: 'ETIMEDOUT' }))
    })
    socket.on('error', reject)
  })
}

/** 发一个请求，默认不跟随重定向（我们要看 302 本身）。 */
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http
    const req = mod.request(
      url,
      {
        method: opts.method || 'GET',
        headers: {
          // 用一个真实的移动端 UA：某些隧道/WAF 会按 UA 拦截空 UA。
          'user-agent': 'KxxyRemoteCheck/1.0',
          accept: '*/*',
          ...(opts.headers || {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume()
        resolve({ status: res.statusCode, headers: res.headers })
      },
    )
    req.on('timeout', () => req.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    req.end()
  })
}

/**
 * 手工做一次 WebSocket 升级。
 *
 * 不用第三方库：要验的正是「隧道有没有把 Upgrade 原样转过去」，任何封装
 * 都可能替我们抹平失败原因。
 */
function probeUpgrade(hostname, port, secure, sessionCookie, timeout) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host: hostname, port, servername: hostname, timeout })
      : net.connect({ host: hostname, port, timeout })

    let raw = ''
    const done = () => {
      socket.destroy()
      resolve(raw.split('\r\n')[0] || '')
    }

    socket.on(secure ? 'secureConnect' : 'connect', () => {
      socket.write(
        [
          'GET /ws HTTP/1.1',
          `Host: ${hostname}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          `Cookie: kxxy_pair=${sessionCookie}`,
          'User-Agent: KxxyRemoteCheck/1.0',
          '',
          '',
        ].join('\r\n'),
      )
    })

    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      raw += chunk
      if (raw.includes('\r\n')) done()
    })
    socket.on('timeout', () => {
      socket.destroy()
      reject(Object.assign(new Error('WebSocket 握手超时'), { code: 'ETIMEDOUT' }))
    })
    socket.on('error', reject)
  })
}

/** 从 Set-Cookie 里挑一个 cookie，返回 `name=value`。`name` 为空时取第一个。 */
function pickCookie(raw, name) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  for (const item of list) {
    const pair = String(item).split(';')[0].trim()
    if (!pair) continue
    if (!name || pair.startsWith(`${name}=`)) return pair.slice(pair.indexOf('=') + 1)
  }
  return ''
}
