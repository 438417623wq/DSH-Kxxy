import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AUTH_ALLOW, authVerdict, checkNonce, checkWriteRequest } from 'kxxy-host/auth'
import { CodexService } from './service.mjs'
import { CodexError } from './transport.mjs'
import { workspaceForSession, sessionForCodex } from './security.mjs'

export const name = 'dsh-codex-sidebar'
export const inject = ['webServer']
const PREFIX = '/kxxy/codex'
const MAX_BODY = 800 * 1024

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

async function body(req) {
  const parts = []
  let bytes = 0
  for await (const part of req) {
    bytes += part.length
    if (bytes > MAX_BODY) throw new CodexError('request-too-large', '请求内容超过上限', 413)
    parts.push(part)
  }
  let value
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { throw new CodexError('json-invalid', '请求不是有效 JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CodexError('json-invalid', '请求必须是对象')
  return value
}

/** A separate same-origin endpoint; no open port and no unauthenticated process API. */
export function apply(ctx) {
  const service = new CodexService({ ctx, resolveWorkspace: (id) => workspaceForSession(ctx, id) })
  const nonce = randomBytes(32).toString('hex')
  const streams = new Set()
  const route = ctx.webServer.register({
    kind: 'prefix', path: PREFIX,
    handler: async (req, res) => {
      if (authVerdict(ctx, req) !== AUTH_ALLOW) { json(res, 401, { error: 'unauthorized', message: '需要有效的 DSH 会话' }); return }
      if (req.headers['sec-fetch-site'] === 'cross-site') { json(res, 403, { error: 'cross-site', message: '拒绝跨站请求' }); return }
      const url = new URL(req.url, 'http://dsh.invalid')
      const action = url.pathname.slice(PREFIX.length)
      try {
        if (req.method === 'GET' && action === '/style.css') {
          const css = await readFile(fileURLToPath(new URL('../web/codex.css', import.meta.url)))
          res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
          res.end(css)
          return
        }
        const sessionId = url.searchParams.get('sessionId')
        if (req.method === 'GET' && action === '/bootstrap') {
          await sessionForCodex(ctx, sessionId)
          const snapshot = await service.snapshot(sessionId)
          json(res, 200, { nonce, ...snapshot })
          return
        }
        if (req.method === 'GET' && action === '/events') {
          if (streams.size >= 8) throw new CodexError('stream-limit', '打开的 Codex 观察连接过多', 429)
          await sessionForCodex(ctx, sessionId)
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' })
          res.flushHeaders?.()
          let closed = false
          let timer = null
          const flush = () => {
            if (closed || timer) return
            timer = setTimeout(() => {
              timer = null
              if (authVerdict(ctx, req) !== AUTH_ALLOW) { close(); return }
              // Events are invalidations, not growing transcripts; reconnect re-reads authoritative state.
              if (!res.write('event: change\ndata: {}\n\n')) close()
            }, 120)
          }
          const unsubscribe = service.subscribe(flush)
          const heartbeat = setInterval(() => {
            if (authVerdict(ctx, req) !== AUTH_ALLOW) close()
            else if (!res.write(': heartbeat\n\n')) close()
          }, 15000)
          const close = () => {
            if (closed) return
            closed = true
            clearTimeout(timer)
            clearInterval(heartbeat)
            unsubscribe()
            streams.delete(close)
            res.end()
          }
          streams.add(close)
          res.on('close', close)
          flush()
          return
        }
        if (req.method !== 'POST') { json(res, 404, { error: 'not-found', message: '不存在的 Codex 接口' }); return }
        const origin = checkWriteRequest(req)
        const token = checkNonce(req, [nonce])
        if (!origin.ok || !token.ok) {
          const failure = origin.ok ? token : origin
          json(res, failure.status, { error: 'write-rejected', message: failure.error })
          return
        }
        const input = await body(req)
        await sessionForCodex(ctx, input.sessionId)
        if (!['/connect', '/models/save', '/models/delete', '/models/fetch', '/models/test', '/refresh', '/login', '/login/cancel'].includes(action)) await workspaceForSession(ctx, input.sessionId)
        let result
        switch (action) {
          case '/connect': result = await service.connect(input.consent); break
          case '/models/save': result = await service.saveModel(input); break
          case '/models/delete': result = await service.deleteModel(input.id); break
          case '/environment/check': result = await service.environmentCheck(input.sessionId); break
          case '/models/fetch': result = await service.inspectModel(input, true); break
          case '/models/test': result = await service.inspectModel(input); break
          case '/refresh':
            await service.refreshAccount()
            await service.refreshModels()
            result = service.status()
            break
          case '/thread/new': result = await service.create(input.sessionId, input); break
          case '/thread/resume': result = await service.resume(input.sessionId, input.threadId); break
          case '/thread/older': result = await service.older(input.sessionId, input.threadId); break
          case '/thread/edit': result = await service.messageAction(input.sessionId, input, 'edit'); break
          case '/thread/retry': result = await service.messageAction(input.sessionId, input, 'retry'); break
          case '/access/prepare': result = await service.prepareAccess(input.sessionId, input); break
          case '/access/apply': result = await service.applyAccess(input.sessionId, input); break
          case '/changes/preview': result = await service.previewChanges(input.sessionId, input); break
          case '/changes/revert': result = await service.revertChanges(input.sessionId, input); break
          case '/turn': result = await service.send(input.sessionId, input); break
          case '/interrupt': result = await service.interrupt(input.sessionId, input.threadId); break
          case '/approval': result = await service.decide(input.sessionId, input); break
          case '/login': result = await service.login(input); break
          case '/login/cancel': result = await service.rpc().request('account/login/cancel', { loginId: input.loginId }); break
          default: throw new CodexError('not-found', '不存在的 Codex 接口', 404)
        }
        json(res, 200, service.sanitize(result))
      } catch (error) {
        if (res.headersSent) { res.end(); return }
        json(res, error.status ?? 500, service.sanitize({ error: error.code ?? 'internal', message: error.message, ...(error.details ? { details: error.details } : {}) }))
      }
    },
  })
  ctx.effect(() => async () => {
    route()
    for (const close of streams) close()
    await service.dispose()
  }, 'codex-sidebar: routes and process')
}
