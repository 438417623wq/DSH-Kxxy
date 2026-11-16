/**
 * 插件安装入口的隔离页面：真实 web 资源 + 模拟 API，不加载插件 apply()。
 * 用法：node tools/preview-plugin-install.mjs [--port 3187]
 * /kxxy?count=40 提供长清单，/test-plugin-install 运行浏览器布局回归。
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', 'plugins', 'kxxy-host', 'web')
const portIndex = process.argv.indexOf('--port')
const port = portIndex < 0 ? 3187 : Number(process.argv[portIndex + 1])
const assets = new Map([
  ['theme.css', 'text/css'], ['host.css', 'text/css'], ['host.js', 'text/javascript'],
])

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, type, body) => {
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' })
    res.end(body)
  }
  if (req.method !== 'GET') {
    req.resume()
    return send(405, 'application/json', JSON.stringify({ error: '隔离夹具不执行安装或写操作' }))
  }
  if (url.pathname === '/kxxy') {
    const html = readFileSync(join(WEB, 'index.html'), 'utf8').replace(
      '<head>', '<head><meta name="kxxy-nonce" content="isolated-test">',
    )
    return send(200, 'text/html', html)
  }
  if (url.pathname === '/test-plugin-install') {
    return send(200, 'text/html', readFileSync(join(HERE, 'fixtures', 'plugin-install.html'), 'utf8'))
  }
  const asset = url.pathname.replace('/kxxy/assets/', '')
  if (url.pathname.startsWith('/kxxy/assets/') && assets.has(asset)) {
    return send(200, assets.get(asset), readFileSync(join(WEB, asset)))
  }
  const json = (body) => send(200, 'application/json', JSON.stringify(body))
  if (url.pathname === '/kxxy/api/plugins') {
    const referer = new URL(req.headers.referer || '/kxxy', 'http://127.0.0.1')
    const count = Math.max(0, Math.min(80, Number(referer.searchParams.get('count') ?? 40)))
    return json({ ok: true, plugins: Array.from({ length: count }, (_, i) => ({
      name: `fixture-plugin-${i + 1}`, version: '1.0.0', enabled: true,
      description: '隔离测试插件，不会加载或安装',
    })) })
  }
  if (url.pathname === '/kxxy/api/state') {
    return json({ engine: { pid: 123, arch: 'arm64', node: '24.21.0', port, themePreference: 'light' }, runtime: { allOk: true, checks: [] } })
  }
  if (url.pathname === '/kxxy/api/extensions') return json({ items: [] })
  if (url.pathname === '/kxxy/api/health') return json({ checks: [], headline: '隔离测试', checkedAt: Date.now() })
  if (url.pathname === '/kxxy/api/attention/active') return json({ requests: [] })
  return send(404, 'application/json', JSON.stringify({ error: `模拟接口未定义：${url.pathname}` }))
})
server.listen(port, '127.0.0.1', () => {
  console.log(`隔离页面：http://127.0.0.1:${port}/kxxy?count=40`)
  console.log(`布局回归：http://127.0.0.1:${port}/test-plugin-install`)
})
