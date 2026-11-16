import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { makeFixture, scenarioNames, snapshotFixture, toCatalog, fixtureTestResult, fixtureThreadPolicy, advanceFixture } from './fixtures/codex-ui-scenarios.mjs'

const [projectArg, assetsArg, portArg = '0'] = process.argv.slice(2)
if (!projectArg || !assetsArg) throw new Error('Usage: node tools/preview-codex-client.mjs <project> <isolated-react-assets> [port]')
const project = resolve(projectArg)
const assets = resolve(assetsArg)
const port = Number(portArg)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0..65535')
const routes = new Map([
  ['/react.js', [join(assets, 'react', 'react.js'), 'text/javascript']],
  ['/react-dom.js', [join(assets, 'react-dom', 'react-dom.js'), 'text/javascript']],
  ['/plugin.js', [join(project, 'plugins/dsh-codex-sidebar/lib/client.js'), 'text/javascript']],
  ['/kxxy/codex/style.css', [join(project, 'plugins/dsh-codex-sidebar/web/codex.css'), 'text/css']],
])
const sessions = new Map()
const events = new Map()
let serial = 0
const challenges = new Map()
const appliedRequests = new Map()
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }) }
const expiry = () => new Date(Date.now() + 120000).toISOString()
const findThread = (fixture, input, idle = true) => {
  const thread = fixture.threads.find(value => value.id === input.threadId)
  if (!thread) fail('夹具对话不存在。', 404)
  if (idle && (thread.pending || thread.turns.some(turn => turn.status === 'inProgress'))) fail('请先等待任务结束或停止。')
  return thread
}
const consumeChallenge = (input, kind) => {
  const challenge = challenges.get(input.token)
  challenges.delete(input.token)
  if (!challenge || challenge.kind !== kind || challenge.sessionId !== input.sessionId || challenge.threadId !== input.threadId || (kind === 'undo' && challenge.turnId !== input.turnId) || Date.parse(challenge.expiresAt) <= Date.now()) fail('夹具确认已失效，请重新预览。')
  return challenge
}
const notify = sessionId => { for (const res of events.get(sessionId) || []) res.write('event: change\ndata: {}\n\n') }
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
const sessionFixture = sessionId => {
  if (!sessions.has(sessionId)) {
    const name = scenarioNames.find(name => sessionId.startsWith(`ui-${name}-`)) || 'catalog'
    sessions.set(sessionId, makeFixture(name))
  }
  return sessions.get(sessionId)
}
const readBody = async req => {
  let body = ''
  for await (const chunk of req) { body += chunk; if (body.length > 128 * 1024) throw new Error('Fixture request is too large') }
  return body ? JSON.parse(body) : {}
}
function page(url) {
  const scenario = scenarioNames.includes(url.searchParams.get('scenario')) ? url.searchParams.get('scenario') : 'catalog'
  const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'
  const panel = ['320', '360', '430', '760', 'full'].includes(url.searchParams.get('panel')) ? url.searchParams.get('panel') : 'full'
  const initial = makeFixture(scenario).initial
  const view = ['chat', 'settings', 'history'].includes(url.searchParams.get('view')) ? url.searchParams.get('view') : initial.view || 'chat'
  return `<!doctype html><html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex 实际客户端 · 隔离 UI 夹具</title><style>
:root{--dsw-alias-label-primary:#24272d;--dsw-alias-label-secondary:#656c77;--dsw-alias-bg-layer-1:#fafafa;--dsw-alias-bg-layer-2:#eceef2;--dsw-alias-border-l3:#d9dde4;color-scheme:light}
:root[data-theme=dark]{--dsw-alias-label-primary:#e0e2e5;--dsw-alias-label-secondary:#a9acb5;--dsw-alias-bg-layer-1:#202226;--dsw-alias-bg-layer-2:#30333a;--dsw-alias-border-l3:#3a3d45;color-scheme:dark}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:flex;flex-direction:column;font:13px/1.5 system-ui;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.test-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);flex:none}.test-toolbar label{display:flex;align-items:center;gap:4px;font-size:11px}.test-toolbar select{min-width:0;max-width:160px;padding:3px;font:inherit;background:var(--dsw-alias-bg-layer-2);color:inherit;border:1px solid var(--dsw-alias-border-l3);border-radius:4px}.test-toolbar strong{font-size:11px}.test-caption{font-size:10px;color:var(--dsw-alias-label-secondary)}.preview-stage{display:flex;justify-content:flex-end;flex:1;min-height:0;overflow:hidden}#root{height:100%;width:${panel === 'full' ? '100%' : panel + 'px'};max-width:100%;border-left:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1)}@media(max-width:767px){#root{width:100%}.test-toolbar select{max-width:130px}}
</style></head><body><div class="test-toolbar" aria-label="隔离预览控制"><strong>真实客户端 · 无上游请求</strong><label>场景<select id="scenario">${scenarioNames.map(name => `<option value="${name}"${scenario === name ? ' selected' : ''}>${name}</option>`).join('')}</select></label><label>主题<select id="theme"><option value="light"${theme === 'light' ? ' selected' : ''}>浅色</option><option value="dark"${theme === 'dark' ? ' selected' : ''}>深色</option></select></label><label>桌面侧栏宽<select id="panel">${['full', '320', '360', '430', '760'].map(value => `<option value="${value}"${panel === value ? ' selected' : ''}>${value}</option>`).join('')}</select></label><button id="advance" type="button">推进固定状态</button><button id="refresh-fixture" type="button">重复通知 × 20</button><span id="fixture-status" class="test-caption" role="status"></span><span class="test-caption">所有内容为固定 UI 夹具，不是构建或模型执行证据。</span></div><div class="preview-stage"><div id="root"></div></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
for (const key of ['scenario','theme','panel']) document.getElementById(key).addEventListener('change',event=>{const next=new URL(location.href);next.searchParams.set(key,event.target.value);location.href=next.href});
window.__ModuleLoader__={load({factory}){
 let Body,injected;const sessionId='ui-${scenario}-'+Math.random().toString(36).slice(2);
 const advance=async action=>{const response=await fetch('/kxxy/codex'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId})});const value=await response.json();document.getElementById('fixture-status').textContent=value.message||'已发送重复通知';};
 document.getElementById('advance').onclick=()=>advance('/fixture/advance');
 document.getElementById('refresh-fixture').onclick=()=>advance('/fixture/notify');
 const p=factory(name=>name==='react'?React:{Button:props=>React.createElement('button',props,props.children),PluginArtworkTerminal:()=>null});
 p.apply({effect(fn){return fn()},locale:{register(){return()=>{}}},sidebarRight:{openTab(){}},sidebarRightTabs:{register(){return()=>{}}},slots:{inject(name,fn){return fn()},register(def,Component){if(def.name==='sidebar.right.pane.tab'){Body=Component;injected=def.inject(sessionId)}return()=>{}}}});
 injected.model.update(${JSON.stringify({ ...initial, view }).replace(/</g, '\\u003c')});
 ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Body,{...injected,useTabInfo:()=>({tab:{id:'tab-ui',active:true}})}));
}};
</script><script src="/plugin.js"></script></body></html>`
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page(url)); return }
    const route = routes.get(url.pathname)
    if (route && req.method === 'GET') { res.writeHead(200, { 'content-type': `${route[1]}; charset=utf-8`, 'cache-control': 'no-store' }); res.end(await readFile(route[0])); return }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
    const sessionId = url.searchParams.get('sessionId')
    if (url.pathname === '/kxxy/codex/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write(': isolated UI events\n\n')
      if (!events.has(sessionId)) events.set(sessionId, new Set())
      events.get(sessionId).add(res)
      req.on('close', () => { events.get(sessionId)?.delete(res); res.end() }); return
    }
    if (url.pathname === '/kxxy/codex/bootstrap') { json(res, 200, snapshotFixture(sessionFixture(sessionId || 'ui-catalog-default'))); return }
    if (req.method !== 'POST' || !url.pathname.startsWith('/kxxy/codex/')) { json(res, 404, { error: 'fixture-not-found', message: '隔离夹具没有此路由' }); return }
    const input = await readBody(req)
    const fixture = sessionFixture(input.sessionId)
    const action = url.pathname.slice('/kxxy/codex'.length)
    let result = { ok: true }
    if (action === '/fixture/advance') {
      result = advanceFixture(fixture)
      if (fixture.fixtureState.scenario === 'permissions') for (const [token, challenge] of challenges) if (challenge.sessionId === input.sessionId) challenges.delete(token)
    } else if (action === '/fixture/notify') {
      for (let index = 0; index < 20; index++) notify(input.sessionId)
    } else if (action === '/connect') {
      if (!input.consent) { json(res, 403, { error: 'consent-required', message: '请先确认发送范围。' }); return }
      fixture.health = { phase: 'connected', version: 'UI fixture — not a CLI build', agent: false, chat: false, nativeApp: { available: true, version: 'UI fixture — not a CLI build' } }
      fixture.account = { loggedIn: false, requiresAuth: true }
      for (const thread of fixture.threads) thread.access.mode = 'approval'
      for (const [token, challenge] of challenges) if (challenge.sessionId === input.sessionId) challenges.delete(token)
    } else if (action === '/refresh') {
      result = snapshotFixture(fixture)
    } else if (action === '/models/fetch') {
      result = { count: 3, latencyMs: 86, models: [{ id: 'fixture-discovered-chat', name: '固定发现模型 Chat' }, { id: 'fixture-discovered-reasoner', name: '固定发现模型 Reasoner' }, { id: 'fixture-discovered-no-key', name: '固定发现模型 · 无密钥' }] }
    } else if (action === '/models/test') {
      await new Promise(resolve => setTimeout(resolve, 320))
      const entry = fixture.customModels.find(entry => entry.id === input.id)
      const failed = input.sessionId.startsWith('ui-failure-')
      result = fixtureTestResult(input.check, failed)
      if (entry && Object.keys(input).every(key => ['sessionId', 'id', 'check'].includes(key))) {
        entry.diagnostic = result
        const catalog = fixture.models.find(value => value.id === entry.id)
        if (catalog) catalog.diagnostic = result
      }
      if (failed) { notify(input.sessionId); json(res, 502, { error: 'provider-rate-limit', message: '夹具模拟：模型服务限制请求频率。', details: { upstreamStatus: 429, checks: result.checks, detail: '仅用于 UI 错误状态验收，没有上游请求。' } }); return }
    } else if (action === '/models/save') {
      const existing = fixture.customModels.find(entry => entry.id === input.id)
      const { apiKey, headers, query, sessionId: ignored, ...safe } = input
      result = { ...existing, ...safe, id: input.id || `custom-ui-new-${++serial}`, hasApiKey: !!apiKey || !!existing?.hasApiKey, headerNames: headers === undefined ? existing?.headerNames || [] : Object.keys(headers), queryNames: query === undefined ? existing?.queryNames || [] : Object.keys(query), hasHeaders: headers === undefined ? !!existing?.hasHeaders : !!Object.keys(headers).length, hasQuery: query === undefined ? !!existing?.hasQuery : !!Object.keys(query).length, source: input.engine === 'native' ? 'native-custom' : 'custom', configVersion: `fixture-save-${++serial}`, diagnostic: undefined, reasoningEfforts: input.reasoningEfforts || [], reasoningEffort: input.reasoningEffort || '' }
      fixture.customModels = [...fixture.customModels.filter(entry => entry.id !== result.id), result]
      fixture.models = [...fixture.models.filter(entry => entry.id !== result.id), toCatalog(result)]
    } else if (action === '/models/delete') {
      fixture.customModels = fixture.customModels.filter(entry => entry.id !== input.id)
      fixture.models = fixture.models.filter(entry => entry.id !== input.id)
    } else if (action === '/thread/new') {
      const entry = fixture.models.find(entry => entry.id === input.model)
      const thread = { id: `fixture-thread-${++serial}`, model: input.model, source: entry?.source, engine: input.engine, mode: input.mode, effort: input.effort, cwd: fixture.cwd, turns: [], title: '固定预览对话' }
      Object.assign(thread, fixtureThreadPolicy(thread))
      fixture.threads.push(thread); fixture.history.push({ ...thread, turns: undefined }); result = { thread, binding: { model: thread.model, mode: thread.mode, effort: thread.effort, engine: thread.engine, source: thread.source, cwd: thread.cwd } }
    } else if (action === '/turn') {
      await new Promise(resolve => setTimeout(resolve, 1000))
      const thread = fixture.threads.find(thread => thread.id === input.threadId)
      if (!thread) throw new Error('Fixture thread not found')
      thread.turns.push({ id: `fixture-turn-${++serial}`, status: 'completed', metadata: { model: fixture.models.find(entry => entry.id === thread.model)?.model || thread.model, effort: thread.effort, engine: thread.engine, startedAt: '2026-11-11T09:40:00.000Z', completedAt: '2026-11-11T09:40:01.000Z' }, undo: { available: false, status: 'unavailable', reason: '本轮没有文件写入。', files: [] }, items: [{ id: `fixture-message-${serial}-user`, type: 'userMessage', content: [{ text: input.text }] }, { id: `fixture-message-${serial}-agent`, type: 'agentMessage', text: '这是隔离夹具的固定回复。没有向模型发送消息，也没有读取文件或执行命令。' }] })
    } else if (action === '/thread/edit' || action === '/thread/retry') {
      const requestKey = input.sessionId + ':' + input.requestId
      if (appliedRequests.has(requestKey)) { json(res, 200, appliedRequests.get(requestKey)); return }
      const sourceThread = findThread(fixture, input)
      const index = sourceThread.turns.findIndex(turn => turn.id === input.turnId)
      if (index < 0) fail('源回合不存在。', 404)
      if (action === '/thread/retry' && !sourceThread.capabilities.retry) fail(sourceThread.capabilities.retryReason)
      if (action === '/thread/edit' && (!sourceThread.capabilities.edit || !input.text?.trim())) fail('消息为空或不能编辑。')
      const original = sourceThread.turns[index]
      const branch = { ...structuredClone(sourceThread), id: 'fixture-branch-' + (++serial), title: '新的文字分支（仅内存）', continuedFrom: sourceThread.id, turns: sourceThread.turns.slice(0, index).map(turn => ({ ...structuredClone(turn), undo: { available: false, status: 'unavailable', reason: '文字分支不继承文件快照。', files: [] } })) }
      Object.assign(branch, fixtureThreadPolicy(branch))
      const user = original.items.find(item => item.id === input.itemId || item.type === 'userMessage')
      const turn = { id: 'fixture-branch-turn-' + serial, status: 'completed', metadata: { model: 'fixture-local-chat', effort: branch.effort, engine: branch.engine, startedAt: '2026-11-11T09:35:00.000Z', completedAt: '2026-11-11T09:35:01.000Z' }, items: [{ id: 'branch-user-' + serial, type: 'userMessage', content: [{ text: action === '/thread/edit' ? input.text : (user?.content || []).map(value => value.text || '').join('\n') }] }, { id: 'branch-agent-' + serial, type: 'agentMessage', text: '固定分支回复。仅创建文字分支；没有回滚文件、执行命令或调用模型。' }] }
      branch.turns.push(turn); fixture.threads.push(branch); fixture.history.push({ ...branch, turns: undefined })
      result = { thread: branch, binding: { model: branch.model, effort: branch.effort, mode: branch.mode, engine: branch.engine, cwd: branch.cwd, source: branch.source }, turnId: turn.id }
      appliedRequests.set(requestKey, result)
    } else if (action === '/access/prepare') {
      const thread = findThread(fixture, input)
      if (input.mode !== 'full' || !thread.access.supportsFull) fail('此对话不支持完全访问。')
      const token = 'fixture-access-' + (++serial)
      result = { token, expiresAt: expiry(), scope: { threadId: thread.id, cwd: thread.cwd, model: thread.model, engine: thread.engine }, message: '仅内存夹具：跳过当前对话的审批。不会运行命令或读取真实工作区。' }
      challenges.set(token, { ...result, kind: 'full', threadId: thread.id, sessionId: input.sessionId })
    } else if (action === '/access/apply') {
      const thread = findThread(fixture, input)
      if (input.mode === 'full') consumeChallenge(input, 'full')
      else if (input.mode === 'readonly' && !thread.access.supportsReadOnly) fail('原生 CLI 只读尚未验证。')
      else if (!['approval', 'readonly'].includes(input.mode)) fail('未知权限档位。')
      thread.access = { ...thread.access, mode: input.mode, reason: undefined }
      result = { access: thread.access }
    } else if (action === '/changes/preview') {
      const thread = findThread(fixture, input)
      const turn = thread.turns.find(value => value.id === input.turnId)
      if (!thread.capabilities.undo || !turn?.undo?.available) fail('本轮没有文件快照。')
      const token = 'fixture-undo-' + (++serial)
      result = { token, expiresAt: expiry(), files: turn.items.flatMap(item => item.changes || []), message: '只预览固定内存差异；确认也不会写入真实文件。' }
      challenges.set(token, { ...result, kind: 'undo', threadId: thread.id, turnId: turn.id, sessionId: input.sessionId })
    } else if (action === '/changes/revert') {
      const key = input.sessionId + ':' + input.requestId
      if (appliedRequests.has(key)) { json(res, 200, appliedRequests.get(key)); return }
      const thread = findThread(fixture, input)
      const turn = thread.turns.find(value => value.id === input.turnId)
      const challenge = consumeChallenge(input, 'undo')
      const conflict = fixture.fixtureState.scenario === 'undo-conflict'
      turn.undo = { ...turn.undo, available: false, status: conflict ? 'conflict' : 'undone', reason: conflict ? '夹具模拟：文件存在后续修改。' : '已撤销（仅内存模拟）。' }
      result = { ok: !conflict, status: turn.undo.status, files: challenge.files, ...(conflict ? { conflicts: [{ path: 'src/fixture-only.ts', reason: '预览后文件已改变；未覆盖。' }] } : {}) }
      appliedRequests.set(key, result)
    } else if (action === '/thread/resume' || action === '/thread/older') {
      const thread = findThread(fixture, input, false)
      if (action === '/thread/older') {
        const older = Array.from({ length: 4 }, (_, index) => ({ id: 'older-turn-' + index, status: 'completed', items: [{ id: 'older-user-' + index, type: 'userMessage', content: [{ text: '更早消息 ' + index }] }, { id: 'older-agent-' + index, type: 'agentMessage', text: '加载更早消息后应保持原阅读锚点。'.repeat(12) }] }))
        thread.turns.unshift(...older); thread.historyCursor = null
      }
      result = { thread }
    } else if (action === '/interrupt') {
      for (const thread of fixture.threads.filter(thread => thread.id === input.threadId)) { thread.pending = false; for (const turn of thread.turns) if (turn.status === 'inProgress') turn.status = 'interrupted' }
      fixture.approvals = fixture.approvals.filter(entry => entry.threadId !== input.threadId)
    } else if (action === '/approval') {
      await new Promise(resolve => setTimeout(resolve, 800))
      fixture.approvals = fixture.approvals.filter(entry => entry.id !== input.approvalId)
      if (!fixture.approvals.length) for (const thread of fixture.threads) { thread.pending = false; for (const turn of thread.turns) if (turn.status === 'inProgress') turn.status = 'completed' }
    } else if (action === '/environment/check') {
      result = { ok: true, environment: { cwd: fixture.cwd, platform: 'win32', arch: 'x64' }, checks: [{ id: 'fixture-only', label: '固定 UI 环境结果', status: 'ok', detail: '未执行真实环境命令，不构成工具可用性证据。' }] }
    } else if (action === '/login/cancel') {
      result = { ok: true }
    } else {
      json(res, 400, { error: 'fixture-disabled', message: '此隔离夹具不执行真实登录、命令或模型请求。' }); return
    }
    notify(input.sessionId)
    json(res, 200, result)
  } catch (error) { json(res, error.status || 500, { error: 'fixture-error', message: error.message }) }
})
server.listen(port, '127.0.0.1', () => console.log(`Codex actual-client isolated preview: http://127.0.0.1:${server.address().port}/?scenario=native-bridge&theme=dark&panel=360\nScenarios: ${scenarioNames.join(', ')}\nMobile: set viewport to 320/360/430; desktop: viewport >= 768 with panel=320/360/430. No real model service or CLI calls.`))
