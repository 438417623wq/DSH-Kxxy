import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { makeFixture, scenarioNames, snapshotFixture, advanceFixture } from './codex-ui-scenarios.mjs'

// Static-only checks against the actual client: no browser, real network, CLI or filesystem tools.
const source = (await readFile(new URL('../../plugins/dsh-codex-sidebar/lib/client.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const css = await readFile(new URL('../../plugins/dsh-codex-sidebar/web/codex.css', import.meta.url), 'utf8')
new vm.Script(source)
let hooks = [], cursor = 0, effects = [], exposed, registration
const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) } } },
  useState(value) { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof value === 'function' ? value() : value; return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }] },
  useRef(value) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: value }; return hooks[index] },
  useEffect(fn) { cursor++; effects.push(fn) },
}
const sandbox = {
  window: { __ModuleLoader__: { load({ factory }) { registration = factory(name => name === 'react' ? React : {}) } }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
  document: { activeElement: null, addEventListener() {}, removeEventListener() {} },
  URL, URLSearchParams, AbortController, setTimeout, clearTimeout, crypto: { randomUUID: () => 'fixture-request-uuid' },
  fetch: async () => { throw new Error('This static test must not access a network') },
  EventSource: class { addEventListener() {} close() {} },
}
const marker = '    return {\n      inject:'
assert.ok(source.includes(marker), 'test exposure point must match the real factory')
vm.runInNewContext(source.replace(marker, `    window.__test = { Popup, closePopup, createModel, emptyModelForm, modelPreset, modelConfiguration, ModelMenu, ModelSettings, Sheet, AccessSheet, CodexBody, diagnosticKey, modelDiagnostic, diagnosticFailure, reasoningValues, defaultEffort, uiKey, userText, assistantText, turnSegments, turnMetadata, Fold, Markdown, CodeBlock, Message, TurnView, EffortMenu, ApprovalMenu, ActionSheet, copyText, CopyButton };\n${marker}`), sandbox)
exposed = sandbox.window.__test
const reset = () => { hooks = []; cursor = 0; effects = [] }
const render = (component, props) => { cursor = 0; effects = []; return component(props) }
const all = (node, predicate) => {
  const found = []
  const visit = value => { if (!value || typeof value !== 'object') return; if (predicate(value)) found.push(value); for (const child of value.props?.children || []) visit(child) }
  visit(node); return found
}
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : (node?.props?.children || []).map(text).join(' ')
const element = (node, name) => all(node, item => item.props?.name === name)[0]
const button = (node, label) => all(node, item => (item.type === 'button' || item.type?.name === 'Button') && (item.props?.['aria-label'] === label || item.props?.label === label || text(item) === label))[0]
const plain = value => JSON.parse(JSON.stringify(value))
let checks = 0
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`) }

check('three protocols, optional no-auth and private JSON omission', () => {
  for (const apiFormat of ['chat-completions', 'responses', 'anthropic-messages']) {
    const form = exposed.emptyModelForm({ baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiFormat, engine: 'native', authType: 'none' })
    const input = exposed.modelConfiguration(form)
    assert.equal(input.apiFormat, apiFormat); assert.equal(input.engine, 'native'); assert.equal(input.apiKey, '')
    assert.equal('headers' in input, false); assert.equal('query' in input, false); assert.equal('profile' in input, false)
    assert.equal(input.maxOutputTokens, null); assert.equal(input.thinkingBudget, null)
  }
})
check('blank key preserves stored authentication; new authenticated services require key', () => {
  const form = exposed.emptyModelForm({ baseUrl: 'https://fixture.invalid', model: 'fixture', hasApiKey: true, authType: 'x-api-key' })
  assert.equal(exposed.modelConfiguration(form).apiKey, '')
  assert.throws(() => exposed.modelConfiguration({ ...form, hasApiKey: false }), /密钥/)
  assert.equal(exposed.emptyModelForm({ apiFormat: 'anthropic-messages' }).authType, 'x-api-key')
})
check('JSON blank retains and empty object clears; arrays and scalar rejected', () => {
  const form = exposed.emptyModelForm({ baseUrl: 'https://fixture.invalid', model: 'fixture', authType: 'none' })
  assert.deepEqual(plain(exposed.modelConfiguration({ ...form, headersJson: '{}', queryJson: '{}' }).headers), {})
  for (const invalid of ['[]', 'null', '2', '"secret"', '{broken']) assert.throws(() => exposed.modelConfiguration({ ...form, headersJson: invalid }), /JSON|对象/)
})
check('explicit provider presets have visible compatible protocol and reasoning values', () => {
  for (const profile of ['standard', 'deepseek', 'local', 'anthropic']) {
    const form = { ...exposed.emptyModelForm({ baseUrl: 'https://fixture.invalid', model: 'fixture' }), ...exposed.modelPreset(profile), profile, apiKey: 'fixture-memory-only' }
    const input = exposed.modelConfiguration(form)
    assert.equal(input.profile, profile)
    if (profile === 'anthropic') { assert.equal(input.apiFormat, 'anthropic-messages'); assert.equal(input.authType, 'x-api-key'); assert.equal(input.thinkingBudget, 1024) }
    if (profile === 'deepseek') { assert.deepEqual(plain(input.reasoningEfforts), ['none', 'high']); assert.equal(input.reasoningEffort, 'high') }
    if (profile === 'local') { assert.equal(input.authType, 'none'); assert.equal(input.compat.parallelToolCalls, false) }
  }
})
check('limits and reasoning values are validated before submission', () => {
  const form = exposed.emptyModelForm({ baseUrl: 'https://fixture.invalid', model: 'fixture', authType: 'none' })
  assert.throws(() => exposed.modelConfiguration({ ...form, reasoningEffort: 'high' }), /推理/)
  assert.throws(() => exposed.modelConfiguration({ ...form, maxOutputTokens: '-1' }), /token/)
  assert.throws(() => exposed.modelConfiguration({ ...form, thinkingBudget: '1' }), /思考/)
  assert.throws(() => exposed.modelConfiguration({ ...form, thinkingBudget: '1024', maxOutputTokens: '1024' }), /思考/)
})
check('per-model diagnostics are revision keyed and preserve failure details', () => {
  const entry = { id: 'id', configVersion: 'v1', diagnostic: { checkedAt: 100, ok: false } }
  const local = { checkedAt: new Date(200).toISOString(), ok: true }
  assert.equal(exposed.modelDiagnostic(entry, { [exposed.diagnosticKey(entry)]: local }), local)
  assert.notEqual(exposed.diagnosticKey(entry), exposed.diagnosticKey({ ...entry, configVersion: 'v2' }))
  const error = Object.assign(new Error('fixture failure'), { code: 'model-error', status: 502, details: { upstreamStatus: 429, checks: [{ id: 'tools', status: 'unsupported' }] } })
  const result = exposed.diagnosticFailure(error, 'tools')
  assert.equal(result.code, error.code); assert.equal(result.status, 502); assert.equal(result.details.upstreamStatus, 429)
  assert.equal(result.checks[0].status, 'unsupported')
})
check('custom effort survives metadata normalization', () => {
  const entry = { source: 'custom', reasoningEfforts: ['none', 'high'], reasoningEffort: 'high' }
  assert.deepEqual(plain(exposed.reasoningValues(entry)), ['none', 'high']); assert.equal(exposed.defaultEffort(entry), 'high')
  assert.doesNotMatch(source, /if \(custom\)\s*\{\s*if \(effort\) setEffort\(''\)/)
})
check('model selector supports searching, protocol groups and management when empty', () => {
  reset()
  const fixture = makeFixture('catalog')
  let tree = render(exposed.ModelMenu, { entries: fixture.models, catalog: fixture.models[0], selectedModel: fixture.models[0].id, effort: 'medium', onChoose() {}, onEffort() {}, onManage() {} })
  assert.ok(all(tree, node => node.props?.type === 'search').length)
  assert.ok(text(tree).includes('本机兼容桥')); assert.ok(text(tree).includes('Anthropic Messages'))
  assert.ok(button(tree, '管理连接'))
  const search = all(tree, node => node.props?.type === 'search')[0]
  search.props.onChange({ target: { value: 'impossible-search' } })
  tree = render(exposed.ModelMenu, { entries: fixture.models, catalog: fixture.models[0], selectedModel: fixture.models[0].id, effort: 'medium', onChoose() {}, onEffort() {}, onManage() {} })
  assert.ok(text(tree).includes('没有匹配的模型'))
})
check('settings accepts all protocols in native mode without coercing Responses', () => {
  reset()
  let form = exposed.emptyModelForm({ baseUrl: 'https://fixture.invalid', model: 'fixture', name: 'Fixture', authType: 'none' })
  const props = () => ({ entries: [], diagnostics: {}, warnings: [], form, check: 'text', onForm(value) { form = value }, onCheck() {} })
  let tree = render(exposed.ModelSettings, props())
  element(tree, 'engine').props.onChange({ target: { value: 'native' } })
  assert.equal(form.apiFormat, 'chat-completions')
  tree = render(exposed.ModelSettings, props())
  assert.equal(element(tree, 'apiFormat').props.disabled, false)
  assert.equal(element(tree, 'apiKey').props.required, false)
  element(tree, 'apiFormat').props.onChange({ target: { value: 'anthropic-messages' } })
  tree = render(exposed.ModelSettings, props())
  assert.equal(element(tree, 'apiFormat').props.children.length, 3)
})
check('modal semantics are on the actual card, avoiding host mobile selector', () => {
  reset()
  const tree = render(exposed.Sheet, { title: 'Fixture dialog', onClose() {}, footer: 'footer', children: 'body' })
  assert.equal(tree.props.role, undefined)
  const card = all(tree, node => node.props?.role === 'dialog')[0]
  assert.equal(card.props['aria-modal'], true)
  assert.equal(card.props.className, 'codex-sheet-card')
  const firstChildLast = card.props.children[0].props.children.at(-1)
  assert.equal(firstChildLast.type, 'button')
  assert.equal(firstChildLast.props.children.some(node => node.type === 'button'), false)
})

function bodyHarness(scenario = 'catalog') {
  reset()
  const fixture = makeFixture(scenario)
  const model = exposed.createModel('static-session')
  model.update({ ...snapshotFixture(fixture), ...fixture.initial, phase: 'ready' })
  const calls = []
  model.post = async (path, input) => { calls.push({ path, input }); if (path === '/thread/new') return { thread: { id: 'created-fixture-thread' } }; return { ok: true } }
  const props = { model, useTabInfo: () => ({ tab: { active: true } }) }
  const renderBody = () => { hooks[0] = model.get(); return render(exposed.CodexBody, props) }
  return { model, calls, renderBody }
}
check('switching official native A to B starts a new thread and preserves old history', () => {
  const harness = bodyHarness()
  const old = { id: 'official-old', model: 'official-ui-a', engine: 'native', source: 'native', mode: 'agent', turns: [] }
  harness.model.update({ selectedModel: 'official-ui-a', current: old.id, threads: [old], history: [old] })
  // Reset hooks so useModel observes the staged snapshot on first mount.
  reset()
  const tree = harness.renderBody()
  const menu = all(tree, node => node.type?.name === 'ModelMenu')[0]
  menu.props.onChoose('official-ui-b')
  assert.equal(harness.model.get().current, null)
  assert.equal(harness.model.get().history[0].id, old.id)
})
check('no-workspace settings still provides independent CLI connection controls', () => {
  const harness = bodyHarness('no-workspace')
  const tree = harness.renderBody()
  assert.ok(text(tree).includes('本机 CLI 连接'))
  assert.ok(button(tree, '连接本机 Codex CLI'))
  assert.ok(text(tree).includes('不影响连接 CLI'))
})
check('running approvals remain discoverable from settings with return and stop actions', () => {
  const harness = bodyHarness('approvals')
  harness.model.update({ view: 'settings' }); reset()
  const tree = harness.renderBody()
  assert.ok(button(tree, '返回运行任务')); assert.ok(button(tree, '停止运行任务'))
  assert.ok(text(tree).includes('待审批 · 3 项'))
})
check('multiple approvals use one bounded region and show cwd', () => {
  const harness = bodyHarness('approvals')
  const tree = harness.renderBody()
  const regions = all(tree, node => node.props?.className === 'codex-approval-stack')
  assert.equal(regions.length, 1)
  assert.equal(all(regions[0], node => node.props?.className === 'codex-approval').length, 3)
  assert.equal(all(regions[0], node => node.props?.className === 'codex-approval-cwd').length, 3)
})
check('send uses a single disabled reason for button, keyboard and form', () => {
  const harness = bodyHarness('empty')
  const tree = harness.renderBody()
  assert.equal(button(tree, '发送消息').props.disabled, true)
  assert.ok(button(tree, '管理连接'))
  const textarea = all(tree, node => node.type === 'textarea')[0]
  assert.equal(textarea.props['aria-describedby'], button(tree, '发送消息').props['aria-describedby'])
})

{
  const harness = bodyHarness('native-bridge')
  let release
  harness.model.post = async (path, input) => {
    harness.calls.push({ path, input })
    if (path === '/thread/new') return { thread: { id: 'created-fixture-thread' } }
    if (path === '/turn') return new Promise(resolve => { release = resolve })
    return { ok: true }
  }
  const tree = harness.renderBody()
  const form = all(tree, node => node.props?.className === 'codex-composer')[0]
  form.props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(typeof release, 'function', JSON.stringify({ calls: harness.calls, error: harness.model.get().error, sendButton: button(tree, '发送消息')?.props }))
  harness.model.update({ draft: 'new draft typed while sending', files: ['new-file.ts'] })
  release({ ok: true }); await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(harness.model.get().draft, 'new draft typed while sending')
  assert.deepEqual(plain(harness.model.get().files), ['new-file.ts'])
  assert.equal(harness.calls.filter(call => call.path === '/turn').length, 1)
  checks++; console.log('PASS asynchronous send preserves newer draft and attachments')
}
{
  const harness = bodyHarness('native-bridge')
  const tree = harness.renderBody()
  const textarea = all(tree, node => node.type === 'textarea')[0]
  let prevented = false
  textarea.props.onCompositionStart()
  textarea.props.onKeyDown({ key: 'Enter', keyCode: 229, nativeEvent: { isComposing: true }, preventDefault() { prevented = true } })
  assert.equal(prevented, false); assert.equal(harness.calls.length, 0)
  sandbox.window.matchMedia = () => ({ matches: true })
  reset()
  const mobile = harness.renderBody()
  all(mobile, node => node.type === 'textarea')[0].props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() { prevented = true } })
  assert.equal(prevented, false); assert.equal(harness.calls.length, 0)
  checks++; console.log('PASS IME and mobile Enter do not submit')
}
check('send contrast and shrinking model bar use sufficiently specific native rules', () => {
  assert.match(css, /\.codex-sidebar \.codex-send \{[^}]*color: var\(--codex-on-accent\)/)
  assert.match(css, /\.codex-bar-end \{[^}]*min-width: 0;[^}]*flex: 1 1 0%/)
  assert.match(css, /\.codex-model-menu > summary \.codex-menu-value \{[^}]*min-width: 0/)
  assert.doesNotMatch(source, /localStorage|sessionStorage|window\.confirm/)
  assert.doesNotMatch(source, /approvalPolicy: '(?:never|on-request)'/)
})
check('every isolated scenario has no real credentials and only reserved upstream names', () => {
  for (const name of scenarioNames) {
    const fixture = makeFixture(name)
    for (const entry of fixture.customModels) { assert.equal(entry.hasApiKey, false); assert.equal(entry.apiKey, undefined); assert.equal(new URL(entry.baseUrl).hostname, 'ui-fixture.invalid') }
    assert.equal('draft' in snapshotFixture(fixture), false, 'bootstrap must not overwrite a newer client draft')
  }
})
check('saved checks require confirmation and send only id plus check', () => {
  reset()
  const fixture = makeFixture('catalog')
  const calls = []
  const props = { entries: fixture.customModels, diagnostics: {}, warnings: [], form: exposed.emptyModelForm(), check: 'tools', onForm() {}, onCheck() {}, onTest: async (...args) => { calls.push(args) } }
  let tree = render(exposed.ModelSettings, props)
  const selected = fixture.customModels[0]
  const trigger = button(tree, `检查模型 ${selected.name}`)
  assert.equal(trigger.props.disabled, false)
  trigger.props.onClick()
  assert.equal(calls.length, 0)
  tree = render(exposed.ModelSettings, props)
  const dialog = all(tree, node => node.type?.name === 'ConfirmSheet')[0]
  assert.ok(dialog); assert.equal(dialog.props.confirmLabel, '发送检查请求')
  assert.match(text(dialog), /不发送工作区文件/)
  dialog.props.onConfirm()
  assert.equal(calls.length, 1)
  assert.deepEqual(plain(calls[0][0]), { id: selected.id, check: 'tools' })
})
check('draft checks confirm first then preserve protocol and private JSON overrides', () => {
  reset()
  const calls = []
  const form = exposed.emptyModelForm({ baseUrl: 'https://fixture.invalid', model: 'fixture-local', name: 'Draft', authType: 'none', engine: 'native', apiFormat: 'chat-completions' })
  form.headersJson = '{"X-Project":"static-fixture"}'; form.queryJson = '{}'; form.revision = 7
  const props = { entries: [], diagnostics: {}, warnings: [], form, check: 'stream', onForm() {}, onCheck() {}, onTest: async (...args) => { calls.push(args) } }
  let tree = render(exposed.ModelSettings, props)
  button(tree, '检查当前模型配置').props.onClick()
  assert.equal(calls.length, 0)
  tree = render(exposed.ModelSettings, props)
  const dialog = all(tree, node => node.type?.name === 'ConfirmSheet')[0]
  assert.ok(dialog)
  dialog.props.onConfirm()
  assert.equal(calls[0][0].check, 'stream'); assert.equal(calls[0][0].engine, 'native'); assert.equal(calls[0][0].apiFormat, 'chat-completions')
  assert.deepEqual(plain(calls[0][0].headers), { 'X-Project': 'static-fixture' }); assert.deepEqual(plain(calls[0][0].query), {})
  assert.equal(calls[0][2], 7)
})
check('delete requires accessible confirmation before mutating saved models', () => {
  reset()
  const fixture = makeFixture('catalog'), removed = []
  const props = { entries: fixture.customModels, diagnostics: {}, warnings: [], form: exposed.emptyModelForm(), check: 'text', onForm() {}, onCheck() {}, onDelete: async entry => { removed.push(entry.id); return { ok: true } } }
  let tree = render(exposed.ModelSettings, props)
  button(tree, `删除模型 ${fixture.customModels[0].name}`).props.onClick()
  assert.equal(removed.length, 0)
  tree = render(exposed.ModelSettings, props)
  const dialog = all(tree, node => node.type?.name === 'ConfirmSheet')[0]
  assert.equal(dialog.props.confirmLabel, '删除连接')
  dialog.props.onConfirm()
  assert.deepEqual(removed, [fixture.customModels[0].id])
})

check('adjacent process groups preserve exact item order and expose errors', () => {
  const fixture = makeFixture('error'), turn = fixture.threads[0].turns[0]
  const segments = exposed.turnSegments(turn)
  assert.deepEqual(plain(segments.flatMap(segment => segment.items.map(value => value.item.id))), turn.items.map(item => item.id))
  assert.equal(segments.find(segment => segment.items.some(value => value.item.error)).process, false)
  assert.equal(segments.find(segment => segment.items.some(value => value.item.id === 'answer-between')).process, false)
  assert.ok(segments.some(segment => segment.process && segment.items.length > 1))
})
check('copy combines all agent Markdown and never reasoning or logs', () => {
  const turn = makeFixture('multi-tool').threads[0].turns[0]
  const copied = exposed.assistantText(turn)
  assert.ok(copied.includes('工具之前')); assert.ok(copied.includes('两组工具之间')); assert.ok(copied.includes('```js'))
  assert.ok(!copied.includes('不会加入')); assert.ok(!copied.includes('固定日志'))
  assert.equal(exposed.userText({ content: [{ text: ' original ' }, { text: 'second' }] }), ' original \nsecond')
})
check('folds are stable across refresh and remount without cross-thread collisions', () => {
  const model = exposed.createModel('fold-test'), key = exposed.uiKey('thread-a', 'turn-a', 'item-a', 'block-2')
  assert.notEqual(key, exposed.uiKey('thread-b', 'turn-a', 'item-a', 'block-2'))
  reset(); let tree = render(exposed.Fold, { model, foldKey: key, summary: '过程', children: 'body' })
  assert.equal(tree.props.open, false); assert.ok(!text(tree).includes('body'))
  tree.props.onToggle({ currentTarget: { open: true } })
  model.update(snapshotFixture(makeFixture('stream')))
  reset(); tree = render(exposed.Fold, { model, foldKey: key, summary: '过程', children: 'body' })
  assert.equal(tree.props.open, true); assert.ok(text(tree).includes('body'))
  tree.props.onToggle({ currentTarget: { open: false } })
  reset(); tree = render(exposed.Fold, { model, foldKey: key, summary: '过程', defaultOpen: true, children: 'body' })
  assert.equal(tree.props.open, false)
})
check('completed Markdown is cached and changed or streaming text stays fresh', () => {
  const model = exposed.createModel('markdown-test'), props = { model, foldKey: 'm', text: '**old**', completed: true }
  const first = exposed.Markdown(props)
  assert.equal(exposed.Markdown(props), first)
  assert.notEqual(exposed.Markdown({ ...props, text: '**new**' }), first)
  assert.notEqual(exposed.Markdown({ ...props, completed: false }), first)
  reset(); const block = render(exposed.CodeBlock, { model, foldKey: 'code', text: 'x\n'.repeat(30), language: 'text' })
  assert.equal(all(block, node => node.type?.name === 'Fold')[0].props.defaultOpen, false)
})
check('historical metadata never comes from the live model picker', () => {
  const thread = makeFixture('branches').threads[0]
  const recorded = exposed.turnMetadata(thread, thread.turns[0])
  assert.equal(recorded.model, '本轮记录的模型'); assert.equal(recorded.effort, '低'); assert.equal(recorded.recorded, true)
  const old = exposed.turnMetadata({ ...thread, binding: { model: 'known-binding', effort: 'high', engine: 'workspace' } }, thread.turns[1])
  assert.equal(old.model, 'known-binding'); assert.equal(old.recorded, false); assert.equal(old.startedAt, '未记录')
  assert.equal('tokens' in recorded, false)
})
check('independent effort menu uses declared values only including unsupported default', () => {
  reset(); const empty = render(exposed.EffortMenu, { catalog: { defaultReasoningEffort: 'ultra' }, effort: 'ultra' })
  assert.equal(empty.props.disabled, true); assert.ok(text(empty).includes('默认')); assert.equal(exposed.defaultEffort({ defaultReasoningEffort: 'ultra' }), '')
  reset(); const tree = render(exposed.EffortMenu, { catalog: { reasoningEfforts: ['none', 'high'] }, effort: 'high' })
  assert.ok(text(tree).includes('高')); assert.ok(!text(tree).includes('Ultra')); assert.equal(all(tree, node => node.props?.role === 'menuitemradio').length, 2)
  assert.match(css, /\.codex-effort-menu \{ flex: 0 0 auto/)
})
check('native readonly and unsafe retry/undo are disabled with honest reasons', () => {
  reset(); const thread = makeFixture('running').threads[0]
  const menu = render(exposed.ApprovalMenu, { native: true, access: thread.access, capabilities: thread.capabilities })
  const readonly = all(menu, node => node.props?.role === 'menuitemradio' && text(node).includes('只读'))[0]
  assert.equal(readonly.props.disabled, true); assert.match(text(readonly), /尚未验证/)
  const turn = { ...thread.turns[0], status: 'completed' }
  reset(); const tree = render(exposed.TurnView, { thread, turn, model: exposed.createModel('turn-view'), disabled: false })
  assert.equal(button(tree, '重新回答').props.disabled, true); assert.match(button(tree, '重新回答').props.title, /原生 CLI/)
  assert.equal(button(tree, '撤销本轮文件变更').props.disabled, true)
})
check('full access requires an explicit checked challenge and expiry is enforced', () => {
  reset(); const action = { kind: 'full', token: 'fixture-token', expiresAt: '2099-01-01T00:00:00Z', checked: false, scope: { threadId: 'a', cwd: 'fixture', model: 'm', engine: 'workspace' } }
  let tree = render(exposed.ActionSheet, { action, busy: false })
  assert.equal(tree.props.disabled, true)
  tree = render(exposed.ActionSheet, { action: { ...action, checked: true }, busy: false })
  assert.equal(tree.props.disabled, false)
  tree = render(exposed.ActionSheet, { action: { ...action, checked: true, expiresAt: '2000-01-01T00:00:00Z' }, busy: false })
  assert.equal(tree.props.disabled, true)
})
check('propose changes appends to the existing draft without submitting', () => {
  const harness = bodyHarness('branches'), tree = harness.renderBody()
  const turn = all(tree, node => node.type?.name === 'TurnView')[0]
  const before = harness.model.get().draft
  turn.props.onRevise(turn.props.turn)
  assert.ok(harness.model.get().draft.startsWith(before + '\n\n'))
  assert.match(harness.model.get().draft, /修改要求/); assert.equal(harness.calls.length, 0)
})
{
  const harness = bodyHarness('branches')
  const sourceThread = harness.model.get().threads[0]
  let tree = harness.renderBody(), turn = all(tree, node => node.type?.name === 'TurnView')[0]
  turn.props.onEdit(turn.props.turn, turn.props.turn.items[0]); assert.equal(harness.calls.length, 0)
  tree = harness.renderBody()
  const sheet = all(tree, node => node.type?.name === 'ActionSheet')[0]
  assert.equal(sheet.props.action.kind, 'edit')
  harness.model.post = async (path, input) => { harness.calls.push({ path, input }); return { thread: { ...sourceThread, id: 'fixture-branch-new' }, binding: { model: sourceThread.model, mode: 'agent', effort: 'low' }, turnId: 'new-turn' } }
  harness.model.refresh = async () => {}
  await Promise.all([sheet.props.onConfirm(), sheet.props.onConfirm()])
  assert.equal(harness.calls.filter(call => call.path === '/thread/edit').length, 1)
  assert.equal(harness.calls.filter(call => call.path === '/turn').length, 0)
  assert.equal(harness.model.get().current, 'fixture-branch-new')
  assert.ok(harness.model.get().draft.includes('已有草稿'))
  checks++; console.log('PASS edit confirms before a single branch submission and preserves draft')
}
{
  const harness = bodyHarness('native-bridge'), tree = harness.renderBody()
  const menu = all(tree, node => node.type?.name === 'ApprovalMenu')[0]
  await menu.props.onCreate()
  assert.equal(harness.calls.filter(call => call.path === '/thread/new').length, 1)
  assert.equal(harness.calls.filter(call => call.path === '/turn').length, 0)
  checks++; console.log('PASS access preparation creates an empty thread without sending')
}
{
  const harness = bodyHarness('approvals'), tree = harness.renderBody()
  const releases = []
  harness.model.post = (path, input) => { harness.calls.push({ path, input }); return new Promise(resolve => releases.push(resolve)) }
  const cards = all(tree, node => node.props?.className === 'codex-approval')
  const first = button(cards[0], '本次允许'), second = button(cards[1], '本次允许')
  const a = first.props.onClick(); first.props.onClick(); const b = second.props.onClick(); const stop = button(tree, '停止任务').props.onClick()
  assert.equal(harness.calls.filter(call => call.path === '/approval').length, 2)
  assert.equal(harness.calls.filter(call => call.path === '/interrupt').length, 1)
  assert.equal(Object.keys(harness.model.get().approvalBusy).length, 2)
  releases.forEach(resolve => resolve({ ok: true })); await Promise.all([a, b, stop])
  assert.equal(Object.keys(harness.model.get().approvalBusy).length, 0)
  checks++; console.log('PASS per-card approval locks deduplicate without blocking other cards or stop')
}
check('deterministic stream advances state without reordering earlier messages', () => {
  const fixture = makeFixture('stream'), turn = fixture.threads[0].turns[0]
  const start = turn.items[1].text
  advanceFixture(fixture); assert.ok(turn.items[1].text.startsWith(start)); assert.ok(turn.items[1].text.length > start.length)
  advanceFixture(fixture); advanceFixture(fixture)
  assert.deepEqual(turn.items.map(item => item.id), ['user-1', 'answer-before', 'stream-reason', 'stream-tool', 'stream-after'])
  advanceFixture(fixture); advanceFixture(fixture)
  assert.equal(turn.status, 'completed'); assert.ok(turn.items.at(-1).text.includes('fixed-chunk-2'))
  assert.doesNotMatch(source, /setInterval|typewriter|typingTimer/)
  assert.doesNotMatch(source, /await model\.post\('\/turn'[\s\S]{0,800}stick\.current = true/)
  assert.match(source, /data-message-key/); assert.match(source, /olderAnchor/); assert.match(source, /有新消息 · 回到最新/)
})
{
  const previousFetch = sandbox.fetch, PreviousSource = sandbox.EventSource
  let calls = 0, eventSource
  sandbox.fetch = async () => { calls++; return { ok: true, json: async () => structuredClone(snapshotFixture(makeFixture('stream'))) } }
  sandbox.EventSource = class { constructor() { eventSource = this } addEventListener(name, callback) { this[name] = callback } close() {} }
  const model = exposed.createModel('sse-test'), release = model.retain()
  await new Promise(resolve => setTimeout(resolve, 5))
  for (let index = 0; index < 40; index++) eventSource.change()
  await new Promise(resolve => setTimeout(resolve, 110))
  assert.equal(calls, 2, 'initial refresh plus one coalesced SSE burst')
  release(); model.dispose(); sandbox.fetch = previousFetch; sandbox.EventSource = PreviousSource
  checks++; console.log('PASS SSE refresh bursts coalesce into one additional bootstrap')
}
{
  const previousDocument = sandbox.document, previousNavigator = sandbox.navigator
  let value = '', removed = false, selected = false
  sandbox.navigator = { clipboard: { writeText: async () => { throw new Error('denied') } } }
  sandbox.document = { activeElement: null, body: { append() {} }, createElement() { return { set value(text) { value = text }, style: {}, setAttribute() {}, select() { selected = true }, remove() { removed = true } } }, execCommand: () => true }
  await exposed.copyText('raw **Markdown**')
  assert.equal(value, 'raw **Markdown**'); assert.equal(removed, true); assert.equal(selected, true)
  sandbox.document.execCommand = () => false
  await assert.rejects(exposed.copyText('manual'), /手动复制/)
  reset(); const tree = render(exposed.CopyButton, { text: 'manual', label: '复制' })
  await button(tree, '复制').props.onClick()
  const failed = render(exposed.CopyButton, { text: 'manual', label: '复制' })
  assert.ok(all(failed, node => node.props?.['aria-label'] === '手动复制原文').length)
  sandbox.document = previousDocument; sandbox.navigator = previousNavigator
  checks++; console.log('PASS clipboard fallback reports failure and offers manual raw text')
}

{
  const harness = bodyHarness('permissions'), thread = harness.model.get().threads[0]
  harness.model.post = async (path, input) => { harness.calls.push({ path, input }); return path === '/access/prepare' ? { token: 'memory-challenge', expiresAt: '2099-01-01T00:00:00Z', scope: { threadId: thread.id, cwd: thread.cwd, model: thread.model, engine: thread.engine } } : { access: { ...thread.access, mode: 'full' } } }
  let tree = harness.renderBody()
  await all(tree, node => node.type?.name === 'ApprovalMenu')[0].props.onChoose('full')
  tree = harness.renderBody(); let dialog = all(tree, node => node.type?.name === 'ActionSheet')[0]
  await dialog.props.onConfirm()
  assert.equal(harness.calls.filter(call => call.path === '/access/apply').length, 0)
  dialog.props.onChecked(true)
  tree = harness.renderBody(); dialog = all(tree, node => node.type?.name === 'ActionSheet')[0]
  await Promise.all([dialog.props.onConfirm(), dialog.props.onConfirm()])
  assert.equal(harness.calls.filter(call => call.path === '/access/apply').length, 1)
  assert.equal(harness.model.get().threads[0].access.mode, 'full')
  assert.equal(harness.calls.find(call => call.path === '/access/apply').input.token, 'memory-challenge')
  checks++; console.log('PASS full access prepares a scoped token then requires checked confirmation')
}
{
  const harness = bodyHarness('undo-conflict')
  harness.model.post = async (path, input) => { harness.calls.push({ path, input }); return path === '/changes/preview' ? { token: 'undo-token', expiresAt: '2099-01-01T00:00:00Z', files: [{ path: 'fixture.ts', kind: 'update' }] } : { ok: false, status: 'conflict', conflicts: [{ path: 'fixture.ts', reason: 'later modification' }] } }
  let tree = harness.renderBody(), turn = all(tree, node => node.type?.name === 'TurnView')[0]
  await turn.props.onUndo(turn.props.turn)
  assert.equal(harness.calls.length, 1); assert.equal(harness.calls[0].path, '/changes/preview')
  tree = harness.renderBody(); await all(tree, node => node.type?.name === 'ActionSheet')[0].props.onConfirm()
  tree = harness.renderBody(); const dialog = all(tree, node => node.type?.name === 'ActionSheet')[0]
  assert.match(dialog.props.action.error, /fixture.ts/); assert.equal(dialog.props.action.token, null)
  assert.equal(harness.calls.filter(call => call.path === '/changes/revert').length, 1)
  checks++; console.log('PASS undo preview precedes confirmation and conflicts stay visible')
}
{
  const harness = bodyHarness('branches')
  let height = 1000, top = 0
  const node = { get scrollHeight() { return height }, clientHeight: 200, get scrollTop() { return top }, set scrollTop(value) { top = Math.max(0, Math.min(height - 200, value)) }, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0 }) }
  const followEffect = () => { const effect = effects.find(fn => fn.toString().includes('scrollContext.current.key')); assert.ok(effect); effect() }
  let tree = harness.renderBody(), region = all(tree, item => item.props?.className === 'codex-scroll')[0]
  region.props.ref.current = node; followEffect(); assert.equal(top, 800)
  node.scrollTop = 600; region.props.onScroll(); assert.equal(harness.model.scrollFor(harness.model.get().current).follow, false)
  const threads = plain(harness.model.get().threads); threads[0].turns.push({ id: 'new-turn', status: 'completed', items: [{ id: 'new-text', type: 'agentMessage', text: 'new message' }] })
  height = 1400; harness.model.update({ threads }); tree = harness.renderBody(); followEffect(); assert.equal(top, 600)
  tree = harness.renderBody(); assert.ok(button(tree, '有新消息 · 回到最新'))
  button(tree, '历史对话').props.onClick(); tree = harness.renderBody(); followEffect(); assert.equal(top, 0)
  button(tree, '返回对话').props.onClick(); tree = harness.renderBody(); followEffect(); assert.equal(top, 600)
  button(tree, '有新消息 · 回到最新').props.onClick(); assert.equal(top, 1200)
  checks++; console.log('PASS scrolling up pauses follow and returning from history restores position')
}
{
  const harness = bodyHarness('branches')
  let height = 1000, top = 500, contentTop = 550
  const anchor = { dataset: { messageKey: 'stable-visible-item' }, getBoundingClientRect: () => ({ top: contentTop - top, bottom: contentTop - top + 100 }) }
  const node = { get scrollHeight() { return height }, clientHeight: 200, get scrollTop() { return top }, set scrollTop(value) { top = value }, querySelectorAll: () => [anchor], getBoundingClientRect: () => ({ top: 0 }) }
  let tree = harness.renderBody(); all(tree, item => item.props?.className === 'codex-scroll')[0].props.ref.current = node
  harness.model.post = async (path, input) => { harness.calls.push({ path, input }); height += 400; contentTop += 400; return { thread: harness.model.get().threads[0] } }
  await button(tree, '加载更早的消息').props.onClick()
  tree = harness.renderBody(); effects.find(fn => fn.toString().includes('scrollContext.current.key'))()
  assert.equal(top, 900); assert.equal(anchor.getBoundingClientRect().top, 50)
  checks++; console.log('PASS loading older messages preserves the visible item anchor')
}

check('chat running chrome is compact with one stop and no duplicate reason bar', () => {
  for (const scenario of ['stream', 'approvals']) {
    const harness = bodyHarness(scenario), tree = harness.renderBody()
    const status = all(tree, node => node.props?.className === 'codex-running-bar')[0]
    assert.equal(status.props['data-compact'], true)
    assert.equal(all(status, node => node.type === 'button' || node.type?.name === 'Button').length, 0)
    assert.ok(button(tree, '停止任务')); assert.equal(button(tree, '停止运行任务'), undefined)
    assert.equal(button(tree, '返回运行任务'), undefined)
    assert.equal(all(tree, node => node.props?.className === 'codex-send-reason').length, 0)
    const input = all(tree, node => node.type === 'textarea')[0]
    assert.ok(all(tree, node => node.props?.id === input.props['aria-describedby'] && node.props.className === 'codex-sr-only').length)
  }
})
check('running connection errors remain visible instead of hiding in normal status', () => {
  const harness = bodyHarness('stream')
  harness.model.update({ disconnected: true })
  const tree = harness.renderBody()
  const reason = all(tree, node => node.props?.className === 'codex-send-reason')[0]
  assert.ok(reason); assert.match(text(reason), /连接已断开/)
})
check('single-row composer keeps explicit mode choices inside the add menu', () => {
  const harness = bodyHarness('branches'), tree = harness.renderBody()
  const bar = all(tree, node => node.props?.className === 'codex-composer-bar')[0]
  assert.equal(all(bar, node => node.type?.name === 'ModeMenu').length, 0)
  const start = all(bar, node => node.props?.className === 'codex-bar-start')[0]
  assert.equal(start.props.children[0].props.className, 'codex-add-menu')
  assert.equal(start.props.children[1].type.name, 'ApprovalMenu')
  const add = start.props.children[0]
  assert.ok(button(add, '工作模式：工作区助手')); assert.ok(button(add, '工作模式：仅聊天'))
  assert.equal(button(add, '工作模式：仅聊天').props.disabled, false)
  reset(); const effort = render(exposed.EffortMenu, { catalog: { reasoningEfforts: ['medium'] }, effort: 'medium' })
  assert.equal(effort.props.summary.map(text).join(''), '中')
  assert.match(css, /\.codex-composer-bar \{[^}]*flex-wrap: nowrap/)
  assert.doesNotMatch(css, /\.codex-bar-(?:start|end) \{[^}]*order:/)
  const native = bodyHarness('native-bridge').renderBody()
  assert.equal(button(native, '工作模式：仅聊天').props.disabled, true)
})
check('message actions retain Chinese labels with compact icons and readable disabled states', () => {
  reset(); const copy = render(exposed.CopyButton, { text: 'text', label: '复制原文' })
  assert.ok(all(button(copy, '复制原文'), node => node.type?.name === 'Icon' && node.props.name === 'copy').length)
  const thread = makeFixture('branches').threads[0], turn = thread.turns[0]
  reset(); const message = render(exposed.Message, { item: turn.items[0], model: exposed.createModel('icons'), foldKey: 'message', completed: true, editDisabled: true })
  assert.ok(all(button(message, '修改并重发'), node => node.type?.name === 'Icon' && node.props.name === 'edit').length)
  assert.equal(button(message, '修改并重发').props.disabled, true)
  reset(); const response = render(exposed.TurnView, { thread, turn, model: exposed.createModel('icons-turn') })
  assert.ok(all(button(response, '重新回答'), node => node.type?.name === 'Icon' && node.props.name === 'retry').length)
  assert.match(css, /\.codex-message-actions \.codex-button, \.codex-code-head \.codex-button \{[^}]*font-size: 12px/)
  assert.match(css, /\.codex-message-actions \.codex-button:disabled \{ opacity: \.72/)
})

{
  for (const preview of [
    { ok: false, status: 'conflict', files: [{ path: 'fixture.ts' }], conflicts: [{ path: 'fixture.ts', reason: 'changed before preview' }] },
    { ok: true, files: [{ path: 'fixture.ts' }] },
  ]) {
    const harness = bodyHarness('undo-conflict')
    harness.model.post = async (path, input) => { harness.calls.push({ path, input }); return preview }
    let tree = harness.renderBody(), turn = all(tree, node => node.type?.name === 'TurnView')[0]
    await turn.props.onUndo(turn.props.turn)
    tree = harness.renderBody()
    assert.equal(all(tree, node => node.type?.name === 'ActionSheet').length, 0)
    assert.equal(harness.calls.filter(call => call.path === '/changes/revert').length, 0)
    assert.match(harness.model.get().error, preview.ok === false ? /fixture.ts/ : /有效确认凭据/)
  }
  checks++; console.log('PASS conflicted or tokenless undo previews never offer executable confirmation')
}
{
  const harness = bodyHarness('branches')
  harness.model.post = async (path, input) => { harness.calls.push({ path, input }); return path === '/changes/preview' ? { token: 'undo-token', expiresAt: '2099-01-01T00:00:00Z', files: [{ path: 'fixture.ts', kind: 'update' }] } : { ok: true, status: 'reverted', files: [{ path: 'fixture.ts' }] } }
  let tree = harness.renderBody(), turn = all(tree, node => node.type?.name === 'TurnView')[0]
  await turn.props.onUndo(turn.props.turn)
  tree = harness.renderBody(); await all(tree, node => node.type?.name === 'ActionSheet')[0].props.onConfirm()
  tree = harness.renderBody()
  assert.equal(all(tree, node => node.type?.name === 'ActionSheet').length, 0)
  assert.equal(harness.calls.filter(call => call.path === '/changes/revert').length, 1)
  assert.ok(text(tree).includes('文件撤销已完成'))
  checks++; console.log('PASS successful reverted status is treated as completed undo')
}

function popupHarness(disabled = false) {
  reset()
  const props = { label: '推理强度：中', panelLabel: '推理强度', align: 'end', disabled, summary: '中' }
  const trigger = { attrs: {}, focusCount: 0, setAttribute(name, value) { this.attrs[name] = value }, focus() { this.focusCount++; sandbox.document.activeElement = this } }
  const option = { focusCount: 0, focus() { this.focusCount++; sandbox.document.activeElement = this } }
  const body = { style: {}, querySelector: () => option, querySelectorAll: () => [option] }
  const node = { open: false, querySelector: () => trigger, contains: target => [trigger, option, body].includes(target), closest: () => ({ getBoundingClientRect: () => ({ left: 0, right: 360, top: 0, width: 360 }) }), getBoundingClientRect: () => ({ left: 268, right: 308, top: 700 }) }
  sandbox.window.innerWidth = 360
  let tree = render(exposed.Popup, props)
  tree.props.ref.current = node
  tree.props.children[1].props.ref.current = body
  const listeners = new Map(), cleanups = []
  const previousAdd = sandbox.document.addEventListener, previousRemove = sandbox.document.removeEventListener
  sandbox.document.addEventListener = (name, handler) => listeners.set(name, handler)
  sandbox.document.removeEventListener = (name) => listeners.delete(name)
  for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup) }
  const renderPopup = (changes = {}) => { Object.assign(props, changes); tree = render(exposed.Popup, props); return tree }
  const event = (extra = {}) => ({ prevented: false, preventDefault() { this.prevented = true }, stopPropagation() {}, ...extra })
  return { node, trigger, option, body, props, listeners, event, renderPopup, get tree() { return tree }, dispose() { cleanups.forEach(cleanup => cleanup()); sandbox.document.addEventListener = previousAdd; sandbox.document.removeEventListener = previousRemove } }
}
check('popup pointer activation opens and closes immediately without a native default action', () => {
  const harness = popupHarness()
  try {
    const click = harness.event()
    harness.tree.props.children[0].props.onClick(click)
    assert.equal(click.prevented, true)
    assert.equal(harness.node.open, true)
    assert.equal(harness.trigger.attrs['aria-expanded'], 'true')
    assert.equal(harness.option.focusCount, 1)
    assert.equal(harness.body.style.width, '328px')
    assert.equal(harness.renderPopup().props.children[0].props.role, 'button')
    harness.tree.props.onToggle()
    assert.equal(harness.node.open, true)
    assert.equal(harness.option.focusCount, 1, 'queued toggle must not reopen or move focus a second time')
    harness.tree.props.children[0].props.onClick(harness.event())
    harness.tree.props.onToggle()
    assert.equal(harness.node.open, false)
    assert.equal(harness.trigger.attrs['aria-expanded'], 'false')
  } finally { harness.dispose() }
})
check('popup keyboard, outside dismissal and disabled transitions keep open state synchronized', () => {
  const harness = popupHarness()
  try {
    const space = harness.event({ key: ' ' })
    harness.tree.props.children[0].props.onKeyDown(space)
    assert.equal(space.prevented, true); assert.equal(harness.node.open, true)
    harness.renderPopup()
    harness.listeners.get('keydown')(harness.event({ key: 'Escape' }))
    assert.equal(harness.node.open, false)
    assert.equal(sandbox.document.activeElement, harness.trigger)
    harness.renderPopup().props.children[0].props.onKeyDown(harness.event({ key: 'ArrowDown' }))
    assert.equal(harness.node.open, true)
    harness.listeners.get('pointerdown')({ target: harness.option })
    assert.equal(harness.node.open, true, 'option presses stay inside the popup')
    harness.listeners.get('pointerdown')({ target: {} })
    assert.equal(harness.node.open, false)
    harness.renderPopup({ disabled: true }).props.children[0].props.onClick(harness.event())
    assert.equal(harness.node.open, false)
    harness.node.open = true
    harness.tree.props.onToggle()
    assert.equal(harness.node.open, false, 'a disabled native toggle cannot expose the menu')
    harness.renderPopup({ disabled: false }).props.children[0].props.onClick(harness.event())
    assert.equal(harness.node.open, true)
  } finally { harness.dispose() }
})
check('effort selection updates its parent and closes the popup without sending a turn', () => {
  reset()
  let selected = ''
  const summary = { focused: false, focus() { this.focused = true } }
  const popup = { open: true, querySelector: () => summary }
  const tree = render(exposed.EffortMenu, { catalog: { reasoningEfforts: ['low', 'medium', 'high'] }, effort: 'medium', onEffort: value => { selected = value } })
  const high = all(tree, node => node.props?.role === 'menuitemradio' && text(node) === '高')[0]
  high.props.onClick({ currentTarget: { closest: () => popup } })
  assert.equal(selected, 'high'); assert.equal(popup.open, false); assert.equal(summary.focused, true)
  assert.match(css, /\.codex-effort-menu > summary \{ min-width: 40px/)
  assert.match(css, /\.codex-effort-menu > summary > \* \{ pointer-events: none/)
})

{
  const harness = bodyHarness('permissions')
  harness.model.update({ draft: '确认下一条消息使用高推理强度' })
  let tree = harness.renderBody()
  all(tree, node => node.type?.name === 'EffortMenu')[0].props.onEffort('high')
  tree = harness.renderBody()
  assert.equal(all(tree, node => node.type?.name === 'EffortMenu')[0].props.effort, 'high')
  const form = all(tree, node => node.props?.className === 'codex-composer')[0]
  form.props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setTimeout(resolve, 0))
  const sent = harness.calls.filter(call => call.path === '/turn')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].input.effort, 'high')
  checks++; console.log('PASS selected reasoning effort reaches the next turn request unchanged')
}

console.log('\n' + checks + ' actual-client static checks passed. No network or CLI calls were made.')
