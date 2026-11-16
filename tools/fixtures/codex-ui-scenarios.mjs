// Isolated UI scenarios. Endpoints are reserved .invalid names and no credentials are included.
// Imported by preview-codex-client.mjs; never invokes a model service, CLI, file tool or command.
export const scenarioNames = ['catalog', 'empty', 'disconnected', 'no-workspace', 'native-bridge', 'failure', 'running', 'approvals', 'stream', 'multi-tool', 'long-code', 'error', 'fold-retention', 'branches', 'permissions', 'undo-conflict']
const stamp = '2026-11-11T09:30:00.000Z'
const custom = (id, name, apiFormat, engine, extra = {}) => ({
  id, name, model: `fixture-${apiFormat}`, baseUrl: 'https://ui-fixture.invalid/v1', apiFormat, engine,
  authType: apiFormat === 'anthropic-messages' ? 'x-api-key' : 'none', hasApiKey: false,
  source: engine === 'native' ? 'native-custom' : 'custom', profile: 'standard', compat: {},
  reasoningEfforts: ['low', 'medium', 'high'], reasoningEffort: 'medium', maxOutputTokens: null, thinkingBudget: null,
  headerNames: [], queryNames: [], hasHeaders: false, hasQuery: false, configVersion: `fixture-version-${id}`,
  ...extra,
})
export function toCatalog(entry) {
  return { ...entry, displayName: entry.name, isDefault: false, supportedModes: entry.engine === 'native' ? ['agent'] : ['agent', 'chat'], defaultReasoningEffort: entry.reasoningEffort, supportedReasoningEfforts: entry.reasoningEfforts.map(reasoningEffort => ({ reasoningEffort })) }
}
export function makeFixture(name = 'catalog') {
  if (!scenarioNames.includes(name)) throw new Error(`Unknown UI scenario: ${name}`)
  const customModels = [
    custom('custom-ui-chat', '本地无密钥 · Chat Completions', 'chat-completions', 'workspace', { model: 'fixture-local-chat', profile: 'local' }),
    custom('custom-ui-responses', 'Responses 工作区模型', 'responses', 'workspace'),
    custom('custom-ui-anthropic', 'Anthropic Messages · 超长模型名称用于验证窄侧栏与手机菜单不会挤出发送按钮', 'anthropic-messages', 'workspace', { headerNames: ['anthropic-version', 'X-Project'], hasHeaders: true }),
    custom('custom-ui-bridge', '原生 CLI · DeepSeek 兼容桥 · A-Very-Long-Model-Name-For-Panel-Ellipsis', 'chat-completions', 'native', { profile: 'deepseek', model: 'fixture-bridge-reasoner' }),
    custom('custom-ui-native-responses', '原生 CLI · Responses 直连', 'responses', 'native'),
    custom('custom-ui-native-anthropic', '原生 CLI · Anthropic 兼容桥', 'anthropic-messages', 'native'),
  ]
  const official = ['a', 'b'].map((suffix, index) => ({ id: `official-ui-${suffix}`, model: `official-ui-${suffix}`, displayName: `官方 CLI 模型 ${suffix.toUpperCase()}（仅 UI 夹具）`, engine: 'native', source: 'native', supportedModes: ['agent'], isDefault: index === 0, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort })) }))
  const fixture = {
    nonce: 'isolated-ui-fixture-nonce', cwd: 'E:\\fixture-workspace\\a-long-development-project',
    health: { phase: 'connected', version: 'UI fixture — not a CLI build', agent: false, chat: false, nativeApp: { available: true, version: 'UI fixture — not a CLI build' } },
    environment: { cwd: 'E:\\fixture-workspace\\a-long-development-project', platform: 'win32', arch: 'x64' },
    account: { loggedIn: true, requiresAuth: true, type: 'fixture account (not real)' },
    history: [], threads: [], approvals: [], customModels, models: [...official, ...customModels.map(toCatalog)], modelWarnings: [],
    initial: { selectedModel: 'custom-ui-chat', current: null, draft: '' },
  }
  if (name === 'empty') {
    fixture.customModels = []; fixture.models = []
    fixture.health = { phase: 'disconnected', agent: false, chat: false }
    fixture.account = null; fixture.initial = { current: null, selectedModel: '' }
  }
  if (name === 'disconnected' || name === 'no-workspace') {
    fixture.health = { phase: 'disconnected', agent: false, chat: false }
    fixture.account = null
    fixture.initial = { selectedModel: 'custom-ui-bridge', current: null, view: 'settings' }
    if (name === 'no-workspace') { fixture.cwd = null; fixture.environment = null }
  }
  if (name === 'native-bridge') fixture.initial = { selectedModel: 'custom-ui-bridge', current: null, draft: '这是一条未发送的草稿，仅用于检查单色发送按钮对比度。' }
  if (name === 'failure') {
    const diagnostic = { ok: false, check: 'tools', checkedAt: stamp, latencyMs: 184, stale: false, message: '夹具模拟：服务不接受工具参数。', code: 'provider-tools-unsupported', upstreamStatus: 400, checks: [{ id: 'text', status: 'passed', message: '固定文本能力检查通过（夹具）。' }, { id: 'stream', status: 'passed', message: '固定流式能力检查通过（夹具）。' }, { id: 'tools', status: 'unsupported', message: '此协议端点未提供 function tools。', code: 'provider-tools-unsupported', upstreamStatus: 400 }, { id: 'native-tools', status: 'untested', message: 'HTTP 检查不验证 CLI 工具。' }] }
    fixture.customModels[1].diagnostic = diagnostic
    fixture.models = [...official, ...fixture.customModels.map(toCatalog)]
    fixture.modelWarnings = [{ id: 'fixture-invalid-entry', message: '隔离夹具示例：一个无效旧条目未加载；原始配置保留。' }]
    fixture.initial = { selectedModel: 'custom-ui-responses', current: null, view: 'settings' }
  }
  if (name === 'running' || name === 'approvals') {
    const thread = { id: 'fixture-thread-active', model: 'custom-ui-bridge', source: 'native-custom', engine: 'native', mode: 'agent', effort: 'high', cwd: fixture.cwd, pending: true, title: '当前运行任务（固定 UI 数据）', turns: [{ id: 'fixture-turn-active', status: 'inProgress', items: [
      { id: 'fixture-user', type: 'userMessage', content: [{ text: '检查项目构建问题，先展示计划和变更。' }] },
      { id: 'fixture-plan', type: 'plan', steps: [{ step: '查看项目结构', status: 'completed' }, { step: '核对构建命令和文件变更', status: 'inProgress' }] },
      { id: 'fixture-read', type: 'workspaceTool', name: 'read_file', status: 'completed', arguments: { path: 'package.json' }, result: '固定示例内容（未读取真实文件）' },
      { id: 'fixture-answer', type: 'agentMessage', text: '这是固定夹具消息，**没有执行构建**。以下工具和审批用于检查布局。\n\n```text\npreview-only\n```' },
      { id: 'fixture-command', type: 'commandExecution', status: name === 'approvals' ? 'awaitingApproval' : 'inProgress', command: 'npm run build -- --fixture-only', aggregatedOutput: '固定 UI 输出，不代表实际命令结果。' },
    ] }] }
    fixture.threads = [thread]
    fixture.history = [{ ...thread, turns: undefined }]
    fixture.initial = { current: thread.id, selectedModel: thread.model, selectedEffort: 'high', draft: '运行时可保留的下一条草稿' }
    if (name === 'approvals') fixture.approvals = [
      { id: 'fixture-approval-command', threadId: thread.id, kind: 'commandExecution', source: 'native-custom', cwd: fixture.cwd, reason: '固定示例：执行项目定义的构建脚本。该预览不会真正运行。', command: 'npm run build -- --fixture-only' },
      { id: 'fixture-approval-file', threadId: thread.id, kind: 'fileChange', source: 'native-custom', cwd: fixture.cwd, reason: '固定示例：核对文件路径及差异；接受也不会写入真实文件。', path: 'src/components/a-long-component-name.ts', diff: '--- a/src/components/a-long-component-name.ts\n+++ b/src/components/a-long-component-name.ts\n@@ -1 +1 @@\n-const enabled = false\n+const enabled = true' },
      { id: 'fixture-approval-more', threadId: thread.id, kind: 'commandExecution', source: 'native-custom', cwd: fixture.cwd, command: 'npm run fixture-check' },
    ]
  }
  if (['stream', 'multi-tool', 'long-code', 'error', 'fold-retention', 'branches', 'permissions', 'undo-conflict'].includes(name)) {
    const thread = { id: 'fixture-conversation', model: 'custom-ui-chat', source: 'custom', engine: 'workspace', mode: 'agent', effort: 'medium', cwd: fixture.cwd, title: '对话优先验收（仅内存夹具）', historyCursor: 'fixture-older', turns: [] }
    const code = Array.from({ length: 72 }, (_, index) => `const fixture${index} = 'preview only, no execution';`).join('\n')
    const turn = { id: 'fixture-turn-1', status: 'completed', metadata: { model: 'fixture-local-chat', modelLabel: '本轮记录的模型', effort: 'low', engine: 'workspace', startedAt: stamp, completedAt: '2026-11-11T09:30:12.000Z' }, undo: { available: true, status: 'available', files: [{ path: 'src/fixture-only.ts', kind: 'update' }], count: 1 }, items: [
      { id: 'user-1', type: 'userMessage', content: [{ text: '先说明问题，再检查工具输出；不要把后来文本移到前面。' }] },
      { id: 'answer-before', type: 'agentMessage', text: '先给出方向：这段正文出现在工具之前。**这是固定夹具，不是运行结果。**' },
      { id: 'reason-1', type: 'reasoning', summary: ['仅展示摘要；不会加入“复制本轮回复”。'], status: 'completed' },
      { id: 'tool-1', type: 'workspaceTool', name: 'read_file', status: 'completed', arguments: { path: 'src/fixture-only.ts' }, result: '仅内存示例：没有读取任何工作区。' },
      { id: 'answer-between', type: 'agentMessage', text: '这是两组工具之间的解释，应留在原位置。' },
      { id: 'tool-2', type: 'commandExecution', command: 'fixture-only --not-executed', status: 'completed', exitCode: 0, aggregatedOutput: Array.from({ length: 45 }, (_, index) => `固定日志 ${index + 1}：未运行命令。`).join('\n') },
      { id: 'files-1', type: 'fileChange', status: 'completed', changes: [{ path: 'src/fixture-only.ts', kind: 'update', diff: '--- a/src/fixture-only.ts\n+++ b/src/fixture-only.ts\n@@ -1 +1 @@\n-const demo = false\n+const demo = true' }] },
      { id: 'answer-final', type: 'agentMessage', text: `最后是完整答复。\n\n\`\`\`js\n${code}\n\`\`\`\n\n${Array.from({ length: 8 }, (_, index) => `说明 ${index + 1}：${'正文仅用于检验多层折叠和阅读锚点，不是构建证据。'.repeat(4)}`).join('\n\n')}` },
    ] }
    thread.turns = [turn]
    if (name === 'stream') {
      turn.status = 'inProgress'; delete turn.metadata.completedAt
      turn.items = turn.items.slice(0, 2); turn.items[1].text = '真实状态第一段：'
      thread.pending = true
      turn.undo = { available: false, status: 'unavailable', reason: '运行中，尚未生成快照。', files: [] }
    }
    if (name === 'error') { turn.status = 'failed'; turn.items[5].status = 'failed'; turn.items[5].error = '固定工具错误：权限不足（未执行）'; turn.error = { message: '夹具模拟：上游中断，已收到文本保留。' } }
    if (name === 'fold-retention') for (let index = 2; index <= 5; index++) thread.turns.push({ ...structuredClone(turn), id: `fixture-turn-${index}` })
    if (name === 'branches') {
      thread.turns.push({ id: 'legacy-turn', status: 'completed', items: [{ id: 'legacy-user', type: 'userMessage', content: [{ text: '未记录本轮元数据的旧消息' }] }, { id: 'legacy-agent', type: 'agentMessage', text: '只能显示已知会话绑定，不能取当前选择器冒充历史。' }] })
      fixture.initial.draft = '已有草稿：必须保留此内容。'
    }
    fixture.threads = [thread]; fixture.history = [{ ...thread, turns: undefined }]
    fixture.initial = { ...fixture.initial, selectedModel: thread.model, current: thread.id, selectedEffort: 'medium' }
  }
  for (const thread of fixture.threads) Object.assign(thread, fixtureThreadPolicy(thread))
  fixture.fixtureState = { scenario: name, step: 0 }
  return fixture
}
export function fixtureThreadPolicy(thread) {
  const native = thread.engine === 'native'
  return { access: { mode: 'approval', supportsReadOnly: !native, supportsFull: true, scope: 'thread', ...(native ? { reason: '原生 CLI 只读尚未验证。' } : {}) }, capabilities: { edit: true, retry: !native, undo: !native, readOnly: !native, fullAccess: true, ...(native ? { retryReason: '原生 CLI 不提供无工具结果回放重答。', undoReason: '原生 CLI 没有本轮文件快照。' } : {}) } }
}
// One explicit advance equals one deterministic server-state change plus one SSE notification.
export function advanceFixture(fixture) {
  const step = ++fixture.fixtureState.step
  const thread = fixture.threads[fixture.threads.length - 1]
  if (!thread) return { step, message: '没有活动对话。' }
  let turn = thread.turns[thread.turns.length - 1]
  if (fixture.fixtureState.scenario === 'stream' && turn?.status === 'inProgress') {
    if (step === 1) turn.items[1].text += '正文直接来自增量状态，不使用逐字定时器。'
    if (step === 2) turn.items.push({ id: 'stream-reason', type: 'reasoning', status: 'completed', summary: ['固定摘要。'] }, { id: 'stream-tool', type: 'workspaceTool', name: 'read_file', status: 'inProgress', arguments: { path: 'fixture-only.txt' } })
    if (step === 3) { const tool = turn.items.find(item => item.id === 'stream-tool'); tool.status = 'completed'; tool.result = '仅内存内容。'; turn.items.push({ id: 'stream-after', type: 'agentMessage', text: '工具之后的下一段正文。\n\n```text\nfixed-chunk-1' }) }
    if (step === 4) turn.items.find(item => item.id === 'stream-after').text += '\nfixed-chunk-2\n```\n\n流式代码围栏已闭合。'
    if (step >= 5) { turn.status = 'completed'; turn.metadata.completedAt = '2026-11-11T09:30:15.000Z'; thread.pending = false }
  } else if (fixture.fixtureState.scenario === 'permissions') {
    thread.access.mode = 'approval'
    thread.access.reason = '夹具模拟重连：完全访问已失效。'
  } else {
    thread.turns.push({ id: `fixture-new-${step}`, status: 'completed', metadata: { model: 'fixture-local-chat', effort: 'medium', engine: 'workspace', startedAt: stamp, completedAt: stamp }, items: [{ id: `new-user-${step}`, type: 'userMessage', content: [{ text: `新增消息 ${step}（固定状态）` }] }, { id: `new-agent-${step}`, type: 'agentMessage', text: `新增回复 ${step}。上翻阅读时不应跳到底部；通过按钮返回最新。` }] })
  }
  return { step, message: `已推进到固定状态 ${step}` }
}
export function snapshotFixture(fixture) {
  const { initial, ...snapshot } = fixture
  return snapshot
}
export function fixtureTestResult(check = 'text', failed = false) {
  const selected = ['text', 'stream', 'tools'].includes(check) ? check : 'text'
  const count = ['text', 'stream', 'tools'].indexOf(selected)
  return { ok: !failed, check: selected, model: 'ui-fixture-model', latencyMs: 128, preview: failed ? '' : '固定检查回复；未发送任何上游请求。', checkedAt: new Date().toISOString(), checks: ['text', 'stream', 'tools'].map((id, index) => ({ id, status: index > count ? 'untested' : failed && index === count ? 'failed' : 'passed', message: index > count ? '本次未检查。' : failed && index === count ? '夹具模拟：服务返回 HTTP 429，请稍后重试。' : '固定夹具检查结果。', ...(failed && index === count ? { code: 'provider-rate-limit', upstreamStatus: 429 } : {}) })).concat({ id: 'native-tools', status: 'untested', message: '未执行原生 CLI 工具。' }) }
}
