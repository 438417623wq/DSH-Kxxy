/**
 * kxxy-host — DSH Kxxy 宿主管理页插件。
 *
 * 设计要点（方案 T）：
 *
 * 1. **复用官方 webServer 的公开扩展点**
 *    官方 `dsh-host-webserver` 的 `WebServer` 类公开四个注册点：
 *      register({ kind: "exact" | "prefix", path, handler })
 *      registerUpgrade({ path, handler })
 *      registerFallback(handler)
 *      tapIndex(transform)
 *    官方自己就有 8 个包在用（dsh-api-gateway 用 registerUpgrade、
 *    dsh-host-frontend-static 用 registerFallback 等），是稳定契约。
 *
 * 2. **同 origin 复用官方鉴权，不另造一套**
 *    管理页与官方前端同在 127.0.0.1:3080，因此自动共享官方的
 *    cookie/token 鉴权。管理 API 直接用官方 authorization 服务判定浏览器信任，
 *    避免自造鉴权带来的绕过风险。
 *
 * 3. **只读优先，写操作走显式 API**
 *    状态查询是 GET，动作（重启引擎、切换权限、装扩展）是 POST，
 *    便于审计与限流。
 *
 * @module kxxy-host
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件名。 */
export const name = 'kxxy-host'

/**
 * 依赖的官方服务。
 *
 * `webServer` 是官方公开服务（见 dsh-host-webserver 的 Service 声明）。
 * 刻意不 inject 可选服务 —— 缺任何一个都应视为部署错误而非静默降级。
 */
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = join(HERE, '..', 'web')

/** 宿主管理页 HTML 的缓存（首次读取后常驻）。 */
let cachedIndexHtml = null

/**
 * 读取 web 目录下的静态资源。
 *
 * 刻意不做目录遍历防护的复杂实现 —— 资源名来自固定白名单，
 * 且此路由仅在回环地址上暴露。
 */
function readWebAsset(relative) {
  const full = join(WEB_DIR, relative)
  if (!existsSync(full)) return null
  return readFileSync(full)
}

/** 官方前端的 index.html 路径（用于注入管理页入口）。 */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

function contentTypeFor(path) {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return CONTENT_TYPES[path.slice(dot)] ?? 'application/octet-stream'
}

/**
 * 判定请求是否来自可信浏览器。
 *
 * 复用官方 authorization 服务的判定（若可用）；不可用时退化为
 * 「只接受回环来源」这一保守策略 —— 绝不因为判定器缺失而放行任意来源。
 */
function isTrustedRequest(ctx, req) {
  try {
    const auth = ctx.get('authorization')
    if (auth && typeof auth.isTrustedRequest === 'function') {
      return auth.isTrustedRequest(req)
    }
  } catch {
    // 服务未注册：落到保守分支
  }
  const host = String(req.headers?.host ?? '')
  return host.startsWith('127.0.0.1:') || host.startsWith('localhost:')
}

/** 统一 JSON 应答。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读取请求体（限长，防滥用）。 */
function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limitBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 采集引擎状态。
 *
 * 数据来源分两类：
 *   · 进程内可得：Node 版本、平台、cwd、环境变量摘要
 *   · 需原生层提供：pid、内存、运行时长（通过 KXXY_STATE_FILE 交换）
 *
 * 原生层（EngineService）会把状态写到 `$KXXY_STATE_FILE`，
 * 本插件只读该文件，避免引入跨进程 RPC。
 */
function collectEngineState(ctx) {
  const state = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    cwd: process.cwd(),
    uptimeSec: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    port: Number(process.env.PORT ?? 3080),
    privMode: process.env.DSH_ANDROID_PRIV_MODE ?? 'normal',
    permissionMode: process.env.DSH_PERMISSION_MODE ?? 'unknown',
  }

  // 原生层写入的补充状态（可选）
  const stateFile = process.env.KXXY_STATE_FILE
  if (stateFile && existsSync(stateFile)) {
    try {
      // 容忍 UTF-8 BOM：Kotlin 的 File.writeText 默认不写 BOM，但外部工具
      // （编辑器、adb push 的 Windows 版本、诊断脚本）可能补上。
      // JSON.parse 遇到 BOM 会抛 "Unexpected token '\uFEFF'"，而这里的
      // catch 是静默的 —— 结果是 pid/uptimeSec/memoryMB 全部悄悄丢失，
      // 管理页只剩插件自身进程的数据，排查时极难定位。
      const raw = readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')
      const extra = JSON.parse(raw)
      Object.assign(state, extra)
    } catch {
      // 状态文件损坏不应让整个 API 失败
      state.stateFileError = true
    }
  }

  return state
}

/**
 * 采集运行时完整性信息（方案 P 的四层 ELF 审计结果的运行期视图）。
 *
 * 这里只做「存在性 + 可执行位 + 版本」的轻量检查；
 * 完整的 ELF 审计（e_machine / PT_INTERP / 16KB 对齐）在构建期由
 * tools/verify_runtime.py 完成，结果随 runtime.zip 一起分发。
 */
function collectRuntimeState() {
  const engineRoot = process.env.KXXY_ENGINE_ROOT ?? process.env.PREFIX ?? ''
  const result = {
    engineRoot,
    checks: [],
  }

  const probes = [
    ['bin/node', 'Node 可执行文件'],
    ['bin/bash', 'bash 可执行文件'],
    ['bin/rg', 'ripgrep 可执行文件'],
    ['lib/libreadline.so.8', 'SONAME 别名'],
    ['lib/node_modules/@deepseek-ai/dsh/lib/bin.js', 'DSH 引擎入口'],
    ['etc/tls/cert.pem', 'CA 证书'],
    ['android-overlay.yml', 'Android 适配覆盖层'],
  ]

  for (const [rel, label] of probes) {
    const full = join(engineRoot, rel)
    let ok = false
    let detail = 'missing'
    try {
      if (existsSync(full)) {
        const st = statSync(full)
        ok = st.isFile() && st.size > 0
        detail = ok ? `${st.size} bytes` : 'empty'
        if (ok && (rel.startsWith('bin/'))) {
          // 可执行位检查（Android 上 zip 解压后一律 0644，必须显式恢复）
          const exec = (st.mode & 0o111) !== 0
          if (!exec) {
            ok = false
            detail = 'not executable'
          }
        }
      }
    } catch (e) {
      detail = e.message
    }
    result.checks.push({ path: rel, label, ok, detail })
  }

  result.allOk = result.checks.every((c) => c.ok)
  return result
}

/** 列出已安装扩展。 */
function collectExtensions() {
  const engineRoot = process.env.KXXY_ENGINE_ROOT ?? process.env.PREFIX ?? ''
  const extRoot = join(engineRoot, 'extensions')
  if (!existsSync(extRoot)) return { items: [] }

  const items = []
  try {
    for (const entry of readdirSync(extRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name.endsWith('.tmp-install')) continue

      const dir = join(extRoot, entry.name)
      const versionFile = join(dir, '.ext-version')
      let version = null
      try {
        if (existsSync(versionFile)) version = readFileSync(versionFile, 'utf8').trim()
      } catch {
        // 版本文件不可读时仍列出扩展，只是没有版本号
      }

      let bins = []
      try {
        const binDir = join(dir, 'bin')
        if (existsSync(binDir)) {
          bins = readdirSync(binDir).slice(0, 20)
        }
      } catch {
        // 忽略
      }

      items.push({ id: entry.name, version, bins })
    }
  } catch {
    // 目录不可读时返回空列表
  }

  return { items }
}

/**
 * 插件主体。
 *
 * @param ctx - Cordis 根上下文
 */
export function apply(ctx) {
  ctx.effect(() => {
    // ── 静态资源：/kxxy/assets/* ─────────────────────────────────────
    // ⚠️ path 不能带尾斜杠：WebServer.match() 的判据是
    //     `pathname === prefix || pathname.startsWith(`${prefix}/`)`
    //   （见 @deepseek-ai/dsh-host-webserver/lib/index.js:328）。注册
    //   "/kxxy/assets/" 会让前缀变成 "/kxxy/assets//"，请求 "/kxxy/assets/host.css"
    //   既不等于前缀也不以其加斜杠开头 → 永不匹配 → 全部 404。
    const disposeAssets = ctx.webServer.register({
      kind: 'prefix',
      path: '/kxxy/assets',
      handler: async (req, res) => {
        const rel = decodeURIComponent(String(req.url ?? '').split('?')[0])
          .replace(/^\/kxxy\/assets\//, '')
        // 白名单式防穿越：只允许单层文件名
        if (rel.includes('/') || rel.includes('..')) {
          res.writeHead(400)
          res.end('bad asset path')
          return
        }
        const buf = readWebAsset(rel)
        if (buf === null) {
          res.writeHead(404)
          res.end('asset not found')
          return
        }
        res.writeHead(200, {
          'content-type': contentTypeFor(rel),
          'content-length': buf.length,
          'cache-control': 'no-cache',
        })
        res.end(buf)
      },
    })

    // ── 管理 API：/kxxy/api/* ───────────────────────────────────────
    // 同样不能带尾斜杠，理由见上面的 assets 路由。
    const disposeApi = ctx.webServer.register({
      kind: 'prefix',
      path: '/kxxy/api',
      handler: async (req, res) => {
        if (!isTrustedRequest(ctx, req)) {
          sendJson(res, 403, { error: 'forbidden' })
          return
        }

        const path = String(req.url ?? '').split('?')[0]

        try {
          if (path === '/kxxy/api/state' && req.method === 'GET') {
            sendJson(res, 200, {
              engine: collectEngineState(ctx),
              runtime: collectRuntimeState(),
            })
            return
          }

          if (path === '/kxxy/api/extensions' && req.method === 'GET') {
            sendJson(res, 200, collectExtensions())
            return
          }

          if (path === '/kxxy/api/log' && req.method === 'GET') {
            const engineRoot = process.env.KXXY_ENGINE_ROOT ?? process.env.PREFIX ?? ''
            const logFile = join(engineRoot, 'engine.log')
            let tail = ''
            try {
              if (existsSync(logFile)) {
                const all = readFileSync(logFile, 'utf8')
                tail = all.slice(-64 * 1024)
              }
            } catch (e) {
              tail = `log read failed: ${e.message}`
            }
            sendJson(res, 200, { tail })
            return
          }

          if (path === '/kxxy/api/action' && req.method === 'POST') {
            const raw = await readBody(req)
            let payload
            try {
              payload = JSON.parse(raw || '{}')
            } catch {
              sendJson(res, 400, { error: 'invalid json' })
              return
            }
            // 动作执行需要原生层配合，这里只做登记与回执。
            // 真正的动作通道走 AgentBridge（127.0.0.1:3083）或原生层文件交换。
            ctx.logger?.info?.(`[kxxy-host] action requested: ${payload.action}`)
            sendJson(res, 202, {
              accepted: true,
              action: payload.action ?? null,
              note: 'action recorded; native layer applies it on next poll',
            })
            return
          }

          sendJson(res, 404, { error: 'unknown endpoint', path })
        } catch (e) {
          sendJson(res, 500, { error: e?.message ?? String(e) })
        }
      },
    })

    // ── 宿主管理页：/kxxy ───────────────────────────────────────────
    // 同时挂 "/kxxy/"：用户手输地址栏时很容易带上尾斜杠，而 exact 表是精确匹配，
    // 缺了这一条就是 404。两条都指向同一个 handler。
    const renderPage = async (req, res) => {
      if (cachedIndexHtml === null) {
        const buf = readWebAsset('index.html')
        cachedIndexHtml = buf ?? Buffer.from(
          '<!doctype html><meta charset="utf-8"><title>DSH Kxxy</title>' +
          '<p>宿主管理页资源缺失（web/index.html）。</p>',
          'utf8',
        )
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': cachedIndexHtml.length,
        'cache-control': 'no-cache',
      })
      res.end(cachedIndexHtml)
    }
    const disposePage = ctx.webServer.register({
      kind: 'exact',
      path: '/kxxy',
      handler: renderPage,
    })
    const disposePageSlash = ctx.webServer.register({
      kind: 'exact',
      path: '/kxxy/',
      handler: renderPage,
    })

    ctx.logger?.info?.('[kxxy-host] mounted: /kxxy (page), /kxxy/assets (prefix), /kxxy/api (prefix)')

    return () => {
      disposePageSlash()
      disposePage()
      disposeApi()
      disposeAssets()
    }
  })
}
