import { mkdir, readFile, writeFile, rename, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { CodexError, CodexTransport, redact } from './transport.mjs'
import { runtimePaths, childEnvironment, probeRuntime, probeNativeApp, contextFile, CHAT_UNAVAILABLE } from './security.mjs'
import { CustomModels, modelRevision, credentialRevision, providerSecrets } from './custom-models.mjs'
import { providerConfiguration, fetchProviderModels, testProviderModel } from './provider-api.mjs'
import { ResponsesBridge } from './responses-bridge.mjs'
import { streamCustomChat, conversationMessages, validateMessages, MAX_HISTORY_BYTES, MAX_OUTPUT_CHARS } from './custom-chat.mjs'
import { WORKSPACE_TOOLS, readOnlyTools, WorkspaceTools, workspaceEnvironment, checkWorkspaceEnvironment } from './workspace-tools.mjs'
import { AccessPolicy } from './access-policy.mjs'
import { FileChanges } from './file-changes.mjs'
import { runMessageAction } from './thread-actions.mjs'
import { nativeProviderParameters, nativeExecutionParameters } from './native-models.mjs'

const APPROVAL_METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'])
const EVENTS = new Set([
  'thread/started', 'thread/status/changed', 'turn/started', 'turn/completed',
  'item/started', 'item/completed', 'item/agentMessage/delta', 'item/reasoning/summaryTextDelta',
  'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/fileChange/patchUpdated',
  'turn/diff/updated', 'turn/plan/updated', 'error', 'serverRequest/resolved',
])

function requireString(value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new CodexError('invalid-input', `${label}格式不正确`)
  return value
}

export function reduceEvent(thread, method, params) {
  if (method === 'thread/started' && params.thread) return params.thread
  const next = structuredClone(thread)
  next.turns ??= []
  if (method === 'thread/status/changed') next.status = params.status
  if ((method === 'turn/started' || method === 'turn/completed') && params.turn) {
    const index = next.turns.findIndex((turn) => turn.id === params.turn.id)
    const existing = index === -1 ? {} : next.turns[index]
    if (method === 'turn/started' && existing.status && existing.status !== 'inProgress') return next
    const turn = { ...existing, ...params.turn }
    if ((!turn.items || !turn.items.length) && existing.items?.length) turn.items = existing.items
    if (index === -1) next.turns.push(turn)
    else next.turns[index] = turn
  }
  if (params.turnId) {
    let turn = next.turns.find((value) => value.id === params.turnId)
    if (!turn) {
      turn = { id: params.turnId, status: 'inProgress', items: [] }
      next.turns.push(turn)
    }
    turn.items ??= []
    if ((method === 'item/started' || method === 'item/completed') && params.item) {
      const index = turn.items.findIndex((item) => item.id === params.item.id)
      if (index === -1) turn.items.push(params.item)
      else turn.items[index] = { ...turn.items[index], ...params.item }
    }
    if (method === 'turn/diff/updated') turn.diff = params.diff
    if (method === 'turn/plan/updated') turn.plan = params.plan
    if (params.itemId && typeof params.delta === 'string') {
      let item = turn.items.find((value) => value.id === params.itemId)
      if (!item) {
        item = { id: params.itemId, type: method.includes('agentMessage') ? 'agentMessage' : method.includes('commandExecution') ? 'commandExecution' : 'reasoning' }
        turn.items.push(item)
      }
      const field = method.includes('commandExecution') || method.includes('fileChange') ? 'aggregatedOutput' : 'text'
      item[field] = (item[field] ?? '') + params.delta
      if (item[field].length > 262144) {
        item[field] = item[field].slice(-262144)
        item.outputTruncated = true
      }
    }
    if (method === 'item/fileChange/patchUpdated') {
      const item = turn.items.find((value) => value.id === params.itemId)
      if (item && params.changes) item.changes = params.changes
    }
  }
  return next
}

/** Only this plugin's recorded threads may be addressed; a thread id is not authorization. */
export class CodexService {
  constructor({ ctx, paths, resolveWorkspace, transportFactory = (options) => new CodexTransport(options), bridgeFactory = (options) => new ResponsesBridge(options), probe = probeRuntime, nativeProbe = probeNativeApp, env = process.env, fetchImpl = globalThis.fetch, customTimeoutMs = 120000, customAgentTimeoutMs = 600000 }) {
    Object.assign(this, { ctx, paths, resolveWorkspace, transportFactory, bridgeFactory, probe, nativeProbe, env, fetchImpl, customTimeoutMs, customAgentTimeoutMs })
    this.transport = null
    this.connecting = null
    this.health = { phase: 'disconnected', agent: false, chat: false, reason: null, chatReason: CHAT_UNAVAILABLE, nativeApp: { available: false, executionMode: 'app-process', permissionMode: 'app-process', sandboxVerified: false, approvalPolicies: ['untrusted'], reason: '请先连接原生 Codex CLI' } }
    this.account = null
    this.models = []
    this.bindings = new Map()
    this.threads = new Map()
    this.approvals = new Map()
    this.listeners = new Set()
    this.requests = new Map()
    this.running = new Set()
    this.preparing = new Set()
    this.customModels = null
    this.customControllers = new Map()
    this.customOperations = new Set()
    this.environmentChecks = new Map()
    this.queue = Promise.resolve()
    this.loaded = false
    this.loading = null
    this.disposed = false
    this.nativeSecrets = new Set()
    this.transportGeneration = 0
    this.loadedThreads = new Map()
    this.resumingThreads = new Map()
    this.bridge = null
    this.bridgeOpening = null
    this.bridgeBindings = new Map()
    this.modelVersions = new Map()
    this.modelDiagnostics = new Map()
    this.modelChecks = new Map()
    this.accessPolicy = new AccessPolicy()
    this.fileChanges = null
    this.actionLocks = new Set()
    this.reservedThreads = new Map()
    this.accessEpochs = new Map()
    this.activeAccess = new Map()
    this.messageActions = new Map()
    this.undoViews = new Map()
  }

  async load() {
    if (this.loaded) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      this.paths ??= runtimePaths(this.env, { requireExecutable: false })
      await mkdir(this.paths.home, { recursive: true, mode: 0o700 })
      this.customModels ??= new CustomModels(this.paths.home)
      await this.customModels.load()
      try {
        const raw = await readFile(join(this.paths.home, 'sidebar-threads.json'))
        if (raw.byteLength > 64 * 1024 * 1024) throw new Error('Oversized thread index')
        const data = JSON.parse(raw.toString('utf8'))
        if (data.version !== 1 || !Array.isArray(data.threads)) throw new Error('Unsupported thread index')
        const bindings = new Map()
        for (const binding of data.threads) {
          if (typeof binding.id !== 'string' || typeof binding.sessionId !== 'string' || typeof binding.cwd !== 'string' || bindings.has(binding.id)) throw new Error('Invalid thread index')
          if (binding.source === 'custom' && (typeof binding.providerId !== 'string' || typeof binding.providerRevision !== 'string' || !['chat', 'agent'].includes(binding.mode))) throw new Error('Invalid custom binding')
          if (binding.engine === 'native' && (!['native', 'native-custom'].includes(binding.source) || binding.mode !== 'agent' || binding.executionMode !== 'app-process' || binding.permissionMode !== 'app-process' || binding.approvalPolicy !== 'untrusted' || typeof binding.providerId !== 'string' || typeof binding.providerRevision !== 'string')) throw new Error('Invalid native binding')
          if (binding.source === 'native-custom' && binding.engine !== 'native') throw new Error('Invalid native provider binding')
          if (binding.readOnly !== undefined && typeof binding.readOnly !== 'boolean') throw new Error('Invalid read-only binding')
          if (binding.readOnly && (binding.source !== 'custom' || binding.mode !== 'agent')) throw new Error('Unsupported read-only binding')
          if (binding.replyOnly !== undefined && (binding.replyOnly !== true || binding.source !== 'custom' || binding.mode !== 'chat')) throw new Error('Invalid text-only branch')
          bindings.set(binding.id, binding)
        }
        if (data.customThreads !== undefined && !Array.isArray(data.customThreads)) throw new Error('Invalid custom history')
        const threads = new Map()
        for (const thread of data.customThreads ?? []) {
          if (bindings.get(thread.id)?.source !== 'custom' || threads.has(thread.id) || !Array.isArray(thread.turns) || thread.turns.length > 100 || Buffer.byteLength(JSON.stringify(thread)) > MAX_HISTORY_BYTES) throw new Error('Invalid custom history')
          for (const turn of thread.turns) {
            if (typeof turn.id !== 'string' || !Array.isArray(turn.items) || turn.items.length > 150 || turn.items.some((item) => !['userMessage', 'agentMessage', 'reasoning', 'workspaceTool', 'commandExecution', 'fileChange'].includes(item.type))) throw new Error('Invalid custom turn')
            if (turn.providerMessages !== undefined && !Array.isArray(turn.providerMessages)) throw new Error('Invalid tool conversation')
            if (turn.status === 'inProgress') {
              turn.status = 'interrupted'
              turn.error = { message: '应用重启已中断此请求；不会自动重新发送，请发送一条新消息继续。' }
              for (const item of turn.items) if (['inProgress', 'pending', 'awaitingApproval'].includes(item.status)) item.status = 'interrupted'
            }
          }
          thread.status = { type: 'idle' }
          threads.set(thread.id, thread)
        }
        for (const binding of bindings.values()) if (binding.source === 'custom' && !threads.has(binding.id)) throw new Error('Missing custom history')
        this.bindings = bindings
        for (const [id, thread] of threads) this.threads.set(id, thread)
      } catch (error) {
        if (error.code !== 'ENOENT') throw new CodexError('history-invalid', 'Codex 会话索引损坏；原文件已保留，请先修复', 503)
      }
      this.loaded = true
    })().finally(() => { this.loading = null })
    return this.loading
  }

  async save() {
    const snapshot = JSON.stringify({ version: 1, threads: [...this.bindings.values()], customThreads: [...this.threads.values()].filter((thread) => this.bindings.get(thread.id)?.source === 'custom') }, null, 2) + '\n'
    if (Buffer.byteLength(snapshot) > 64 * 1024 * 1024) throw new CodexError('history-limit', '本地对话历史超过上限，请减少历史记录', 413)
    const task = this.queue.then(async () => {
      const path = join(this.paths.home, 'sidebar-threads.json')
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' })
        await rename(temporary, path)
      } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
      }
    })
    this.queue = task.catch(() => {})
    await task
  }

  async connect(consent) {
    if (consent !== true) throw new CodexError('consent-required', '首次连接需确认 Codex 的模型服务和代码发送范围', 403)
    if (this.disposed) throw new CodexError('disposed', '插件已停用', 503)
    if (this.transport && !this.transport.closed) return this.status()
    if (this.connecting) return this.connecting
    this.connecting = this.open().finally(() => { this.connecting = null })
    return this.connecting
  }

  async open() {
    await this.load()
    this.health = { ...this.health, phase: 'connecting', reason: null }
    this.publish()
    try {
      if (!this.paths.executable) throw new CodexError('binary-unavailable', '未配置 Codex 可执行文件；自定义模型可直接用于对话', 503)
      const childEnv = childEnvironment(this.paths, this.env)
      const checks = await this.probe(this.paths, { env: childEnv })
      const transport = this.transportFactory({ executable: this.paths.executable, env: childEnv, cwd: this.paths.home, sanitize: (value) => this.sanitize(value) })
      const generation = ++this.transportGeneration
      this.revokeAccess()
      this.loadedThreads.clear()
      this.transport = transport
      const current = () => this.transport === transport && this.transportGeneration === generation
      transport.on('notification', (message) => { if (current()) this.event(message) })
      transport.on('request', (message) => { if (current()) this.approval(message) })
      transport.on('failure', (error) => { if (current()) this.failed(error.message) })
      transport.on('exit', ({ code, signal }) => { if (current()) this.failed(`Codex 进程已退出 (${code ?? signal})`) })
      await transport.start()
      if (this.disposed) { transport.stop(); throw new CodexError('disposed', '插件已停用', 503) }
      const nativeApp = await this.nativeProbe(this.paths, { env: childEnv, rpc: transport })
      this.health = { ...checks, nativeApp, phase: 'connected' }
      await this.refreshAccount()
      await this.refreshModels()
      this.publish()
      return this.status()
    } catch (error) {
      this.transport?.stop()
      this.failed(error.message)
      throw error
    }
  }

  failed(reason) {
    this.revokeAccess()
    this.loadedThreads.clear()
    this.bridge?.abort()
    this.health = { ...this.health, phase: 'failed', agent: false, chat: false, reason: this.sanitize(reason), nativeApp: { ...this.health.nativeApp, available: false, reason: this.sanitize(reason) } }
    for (const [id, approval] of this.approvals) if (approval.source !== 'custom') { clearTimeout(approval.timer); this.approvals.delete(id) }
    for (const id of this.running) if (this.bindings.get(id)?.source !== 'custom') this.running.delete(id)
    for (const [id, thread] of this.threads) {
      if (this.bindings.get(id)?.source === 'custom') continue
      thread.status = { type: 'idle' }
      for (const turn of thread.turns ?? []) if (turn.status === 'inProgress') turn.status = 'interrupted'
      thread.lastError = 'Codex 连接已中断。重连后会先恢复会话，不会自动重发上一条任务。'
    }
    this.publish()
  }

  rpc() {
    if (!this.transport || this.transport.closed) throw new CodexError('not-connected', '请先连接 Codex', 503)
    return this.transport
  }

  async refreshAccount() {
    const result = await this.rpc().request('account/read', { refreshToken: false })
    this.account = { type: result.account?.type ?? null, requiresAuth: result.requiresOpenaiAuth === true, loggedIn: !!result.account }
    return this.account
  }

  async refreshModels() {
    const output = []
    let cursor = null
    for (let page = 0; page < 10; page += 1) {
      const result = await this.rpc().request('model/list', { ...(cursor ? { cursor } : {}), limit: 100 })
      for (const model of result.data ?? []) {
        if (model.hidden) continue
        output.push({ id: model.id, model: model.model, displayName: model.displayName, isDefault: model.isDefault, source: 'native', engine: 'native', supportedModes: ['agent'], defaultReasoningEffort: model.defaultReasoningEffort, supportedReasoningEfforts: model.supportedReasoningEfforts ?? [] })
      }
      if (!result.nextCursor) break
      if (result.nextCursor === cursor) throw new CodexError('model-pagination', '模型列表分页异常', 502)
      cursor = result.nextCursor
    }
    this.models = output
    return output
  }

  rememberProvider(provider) {
    if (!provider) return
    for (const secret of providerSecrets(provider)) if (secret) this.nativeSecrets.add(secret)
  }

  sanitize(value) {
    const secrets = new Set([...this.nativeSecrets, ...[...(this.customModels?.models?.values() ?? [])].flatMap((model) => providerSecrets(model))])
    const scrub = (item) => {
      if (typeof item === 'string') {
        for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) item = item.split(secret).join('[redacted]')
        return redact(item)
      }
      if (Array.isArray(item)) return item.map(scrub)
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => !/^(?:apiKey|api_key|experimental_bearer_token|access_token|refresh_token|authorization|headers|query|http_headers|query_params|credentialRevision|providerRevision|bridgeScope|providerMessages|provider_replay|responses_output|providerText|retryMessages|editContext|actionRecords)$/i.test(key)).map(([key, entry]) => [key, scrub(entry)]))
      return item
    }
    return scrub(value)
  }

  modelVersion(id) {
    if (!this.modelVersions.has(id)) this.modelVersions.set(id, randomUUID())
    return this.modelVersions.get(id)
  }

  modelView(entry) {
    const configVersion = this.modelVersion(entry.id)
    const diagnostic = this.modelDiagnostics.get(entry.id)
    return { ...entry, configVersion, ...(diagnostic ? { diagnostic: { ...diagnostic, stale: diagnostic.configVersion !== configVersion } } : {}) }
  }

  status() {
    return this.sanitize({
      health: this.health, account: this.account,
      models: [...this.models, ...(this.customModels?.catalog() ?? []).map((entry) => this.modelView(entry))],
      customModels: (this.customModels?.metadata() ?? []).map((entry) => this.modelView(entry)),
      modelWarnings: this.customModels?.warnings() ?? [],
    })
  }

  async saveModel(input) {
    // Model settings remain usable even if the native conversation index needs repair.
    this.paths ??= runtimePaths(this.env, { requireExecutable: false })
    this.customModels ??= new CustomModels(this.paths.home)
    await this.customModels.load()
    this.rememberProvider(this.customModels.get(input.id))
    const result = await this.customModels.save(input)
    this.rememberProvider(this.customModels.get(result.id))
    this.modelVersions.set(result.id, randomUUID())
    this.modelDiagnostics.delete(result.id)
    for (const binding of this.bindings.values()) if (binding.providerId === result.id) {
      this.revokeAccess(binding.id)
      this.loadedThreads.delete(binding.id)
    }
    this.publish()
    return this.sanitize(this.modelView(result))
  }

  async deleteModel(id) {
    this.paths ??= runtimePaths(this.env, { requireExecutable: false })
    this.customModels ??= new CustomModels(this.paths.home)
    await this.customModels.load()
    this.rememberProvider(this.customModels.get(id))
    const result = await this.customModels.delete(id)
    for (const binding of this.bindings.values()) if (binding.providerId === id) {
      this.revokeAccess(binding.id)
      this.loadedThreads.delete(binding.id)
    }
    for (const [scope, bridge] of this.bridgeBindings) if (bridge.providerId === id) {
      this.bridge?.revoke(bridge.bindingId)
      this.bridgeBindings.delete(scope)
    }
    this.modelVersions.delete(id)
    this.modelDiagnostics.delete(id)
    this.publish()
    return result
  }

  async inspectModel(input, discovery = false) {
    if (this.disposed) throw new CodexError('disposed', '插件已停用', 503)
    this.paths ??= runtimePaths(this.env, { requireExecutable: false })
    this.customModels ??= new CustomModels(this.paths.home)
    await this.customModels.load()
    if (this.disposed) throw new CodexError('disposed', '插件已停用', 503)
    const provider = providerConfiguration(input, { models: this.customModels, requireModel: !discovery })
    this.rememberProvider(provider)
    const saved = input.id && this.customModels.get(input.id)
    const same = !discovery && saved && modelRevision(provider) === modelRevision(saved) && credentialRevision(provider) === credentialRevision(saved)
    const version = same ? this.modelVersion(saved.id) : null
    const key = input.id || 'unsaved'
    if (this.modelChecks.has(key) || this.modelChecks.size >= 2) throw new CodexError('model-check-busy', '模型检查正在进行，请稍后再试', 429)
    const controller = new AbortController()
    const record = { controller, completion: null }
    this.modelChecks.set(key, record)
    const store = (diagnostic) => {
      if (same && !this.disposed && this.customModels.get(saved.id) && this.modelVersions.get(saved.id) === version) {
        this.modelDiagnostics.set(saved.id, { ...diagnostic, configVersion: version, check: input.check || 'text', checkedAt: diagnostic.checkedAt || Date.now() })
        this.publish()
      }
    }
    try {
      record.completion = (discovery ? fetchProviderModels : testProviderModel)({ ...provider, id: undefined, check: input.check }, { fetchImpl: this.fetchImpl, signal: controller.signal })
      const result = await record.completion
      const diagnostic = { ...result, checks: [...(result.checks ?? [])] }
      if (!discovery && provider.engine === 'native') {
        diagnostic.checks.push({ id: 'native-environment', status: this.health.nativeApp?.available ? 'passed' : 'untested', message: this.health.nativeApp?.available ? '原生 CLI 应用运行环境已验证；本次仅检查模型 HTTP 协议' : '原生 CLI 环境尚未验证，请先连接 Codex' })
        diagnostic.checks.push({ id: 'native-tools', status: 'untested', message: '原生 Codex 完整工具链仍需在实际任务中验证；HTTP 测试通过不代表所有原生工具兼容' })
      }
      const safeDiagnostic = this.sanitize(diagnostic)
      store(safeDiagnostic)
      return safeDiagnostic
    } catch (error) {
      store(this.sanitize({ ok: false, checks: error.details?.checks ?? [{ id: input.check || 'text', status: 'failed', message: error.message, code: error.code }], details: error.details }))
      throw error
    } finally {
      this.modelChecks.delete(key)
    }
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish() {
    for (const listener of this.listeners) {
      try { listener() } catch { /* A disconnected observer cannot stop Codex. */ }
    }
  }

  async snapshot(sessionId) {
    let cwd = null
    let workspaceError = null
    try { cwd = await this.resolveWorkspace(sessionId) } catch (error) {
      if (!['workspace-unavailable', 'workspace-invalid'].includes(error.code)) throw error
      workspaceError = error.message
    }
    const environment = cwd ? (() => {
      const { platform, arch, shell, permissionMode } = workspaceEnvironment(cwd, this.env)
      return { cwd, platform, arch, shell, permissionMode }
    })() : null
    let historyError = null
    try { await this.load() } catch (error) { historyError = error.message }
    const bindings = [...this.bindings.values()].filter((entry) => cwd && entry.sessionId === sessionId && entry.cwd === cwd)
    const ids = new Set(bindings.map((entry) => entry.id))
    for (const binding of this.bindings.values()) if (binding.sessionId === sessionId && binding.cwd !== cwd) {
      this.revokeAccess(binding.id)
      this.loadedThreads.delete(binding.id)
    }
    const threads = await Promise.all([...this.threads.values()].filter((thread) => ids.has(thread.id)).map(async (thread) => {
      const binding = this.bindings.get(thread.id)
      const turns = await Promise.all((thread.turns ?? []).map(async (turn) => ({ ...turn, ...(turn.metadata ? {} : binding.turnMetadata?.[turn.id] ? { metadata: binding.turnMetadata[turn.id] } : {}), undo: await this.turnUndo(binding, turn) })))
      return { ...thread, turns, model: binding.model, mode: binding.mode, source: binding.source ?? 'native', engine: binding.engine ?? 'workspace', approvalPolicy: binding.approvalPolicy ?? 'untrusted', permissionMode: binding.permissionMode ?? environment.permissionMode, environment: { ...environment, toolsMode: binding.mode, executionMode: binding.executionMode, permissionMode: binding.permissionMode ?? environment.permissionMode, sandboxVerified: binding.engine === 'native' ? false : undefined }, pending: this.running.has(thread.id), access: this.accessView(binding), capabilities: this.threadCapabilities(binding) }
    }))
    return this.sanitize({
      ...this.status(), cwd, environment, historyError, workspaceError,
      history: bindings.sort((a, b) => b.updatedAt - a.updatedAt),
      threads,
      approvals: [...this.approvals.values()].filter((entry) => ids.has(entry.threadId)).map(({ timer, requestId, resolveApproval, abortHandler, ...view }) => view),
    })
  }

  async bound(sessionId, threadId) {
    await this.load()
    const binding = this.bindings.get(threadId)
    if (!binding || binding.sessionId !== sessionId) throw new CodexError('thread-forbidden', '该 Codex 会话不属于当前 DSH 会话', 403)
    const cwd = await this.resolveWorkspace(sessionId)
    if (cwd !== binding.cwd) {
      this.revokeAccess(binding.id)
      this.loadedThreads.delete(binding.id)
      throw new CodexError('workspace-changed', '工作区已改变，请创建新的 Codex 会话', 409)
    }
    return binding
  }

  revokeAccess(threadId) {
    const ids = threadId ? [threadId] : [...this.bindings.keys()]
    for (const id of ids) {
      this.accessEpochs.set(id, (this.accessEpochs.get(id) ?? 0) + 1)
      if (this.activeAccess.get(id) === 'full') {
        this.customControllers.get(id)?.abort(new Error('access-revoked'))
        const binding = this.bindings.get(id)
        const bridge = binding && this.bridgeBindings.get(binding.bridgeScope || binding.id)
        if (bridge) this.bridge?.abort(bridge.bindingId)
        const turn = this.threads.get(id)?.turns?.findLast((value) => value.status === 'inProgress')
        if (binding?.engine === 'native' && turn && this.transport && !this.transport.closed) this.transport.request('turn/interrupt', { threadId: id, turnId: turn.id }, 2000).catch(() => {})
      }
    }
    this.accessPolicy.invalidate(threadId)
    this.fileChanges?.invalidate(threadId)
  }

  accessView(binding) {
    const native = binding.engine === 'native'
    const editable = binding.source === 'custom' && binding.mode === 'agent'
    return { mode: this.accessPolicy.mode(binding, this.transportGeneration), supportsReadOnly: editable, supportsFull: editable || native && this.health.nativeApp?.available === true, scope: 'thread', ...(native ? { reason: '原生只读沙箱尚未验证；完全访问仅代表 Android 应用权限。' } : binding.mode === 'chat' ? { reason: '此对话没有文件或命令工具。' } : {}) }
  }

  threadCapabilities(binding) {
    const native = binding.engine === 'native'
    const custom = binding.source === 'custom'
    return { edit: custom || native, retry: custom, undo: custom && !binding.replyOnly, readOnly: custom && binding.mode === 'agent', fullAccess: custom && binding.mode === 'agent' || native && this.health.nativeApp?.available === true,
      ...(!custom ? { retryReason: '原生 CLI 尚未验证无工具重新回答；可使用“提出修改”，按正常权限发送新任务。', undoReason: '原生变更没有受控的文件前后快照，不能自动撤销。' } : {}) }
  }

  assertIdle(binding) {
    if (this.disposed) throw new CodexError('disposed', '插件已停用', 503)
    const thread = this.threads.get(binding.id)
    if (this.running.has(binding.id) || this.preparing.has(binding.id) || this.actionLocks.has(binding.id) || thread?.status?.type === 'active' || thread?.turns?.some((turn) => turn.status === 'inProgress')) throw new CodexError('busy', '会话正在执行，请先停止或等待完成', 409)
  }

  async validateBindingModel(binding) {
    if (binding.source === 'custom') return this.customParameters(binding.model, binding.mode, binding)
    if (binding.engine === 'native') return this.nativeParameters(binding.model, binding.effort, binding.mode, binding, binding.approvalPolicy)
    throw new CodexError('action-unsupported', '此历史会话不支持该操作，请新建对话', 409)
  }

  async prepareAccess(sessionId, { threadId, mode }) {
    if (mode !== 'full') throw new CodexError('access-mode', '只有完全访问需要二次确认')
    const binding = await this.bound(sessionId, threadId)
    this.assertIdle(binding)
    if (!this.accessView(binding).supportsFull) throw new CodexError('access-unsupported', '当前会话不支持完全访问', 409)
    await this.validateBindingModel(binding)
    this.assertIdle(binding)
    const prepared = this.accessPolicy.prepare(binding, this.transportGeneration)
    return this.sanitize({ ...prepared, scope: { ...prepared.scope, threadId: binding.id } })
  }

  async applyAccess(sessionId, { threadId, mode, token }) {
    const binding = await this.bound(sessionId, threadId)
    this.assertIdle(binding)
    const access = this.accessView(binding)
    if (mode === 'readonly' && !access.supportsReadOnly || mode === 'full' && !access.supportsFull) throw new CodexError('access-unsupported', mode === 'readonly' ? '原生只读环境尚未验证；请明确新建工作区只读会话。' : '当前会话不支持完全访问', 409)
    await this.validateBindingModel(binding)
    this.assertIdle(binding)
    this.actionLocks.add(binding.id)
    const previous = binding.readOnly
    try {
      this.accessPolicy.apply(binding, this.transportGeneration, mode, token)
      if (mode === 'readonly') binding.readOnly = true
      else delete binding.readOnly
      this.loadedThreads.delete(binding.id)
      this.fileChanges?.invalidate(binding.id)
      await this.save()
      this.publish()
      return { access: this.accessView(binding) }
    } catch (error) {
      this.accessPolicy.invalidate(binding.id)
      if (previous === undefined) delete binding.readOnly
      else binding.readOnly = previous
      throw error
    } finally { this.actionLocks.delete(binding.id) }
  }

  async changes() {
    this.paths ??= runtimePaths(this.env, { requireExecutable: false })
    this.fileChanges ??= new FileChanges(this.paths.home)
    await this.fileChanges.load()
    return this.fileChanges
  }

  async turnUndo(binding, turn) {
    if (binding.source !== 'custom' || turn.imported || binding.replyOnly) return { available: false, status: 'unavailable', reason: '此轮没有受控的原始文件快照。', files: [] }
    const key = `${binding.id}:${turn.id}`
    if (turn.status === 'inProgress') return { available: false, status: 'unavailable', reason: '请等待本轮结束后再查看撤销。', files: [] }
    if (this.undoViews.has(key)) return this.undoViews.get(key)
    try {
      const result = await (await this.changes()).describe(binding.id, turn.id)
      const view = { ...result, status: result.status === 'reverted' ? 'undone' : result.status === 'pending' ? 'unavailable' : result.status }
      this.undoViews.set(key, view)
      return view
    } catch { return { available: false, status: 'unavailable', reason: '文件变更日志不可用，不能安全撤销。', files: [] } }
  }

  async previewChanges(sessionId, { threadId, turnId }) {
    const binding = await this.bound(sessionId, threadId)
    this.assertIdle(binding)
    if (binding.source !== 'custom' || binding.replyOnly || binding.readOnly) throw new CodexError('undo-unavailable', '当前会话没有可安全撤销的文件变更', 409)
    const turn = this.threads.get(threadId)?.turns?.find((entry) => entry.id === turnId)
    if (!turn || turn.imported || turn.status === 'inProgress') throw new CodexError('turn-invalid', '只能撤销当前会话已结束且未导入的轮次', 409)
    this.actionLocks.add(binding.id)
    try { return await (await this.changes()).preview({ binding, turnId }) } finally { this.actionLocks.delete(binding.id) }
  }

  async revertChanges(sessionId, { threadId, turnId, token, requestId }) {
    const binding = await this.bound(sessionId, threadId)
    this.assertIdle(binding)
    if (binding.source !== 'custom' || binding.replyOnly || binding.readOnly) throw new CodexError('undo-unavailable', '当前会话不可执行文件撤销', 409)
    const turn = this.threads.get(threadId)?.turns?.find((entry) => entry.id === turnId)
    if (!turn || turn.imported || turn.status === 'inProgress') throw new CodexError('turn-invalid', '只能撤销当前会话已结束的轮次', 409)
    requireString(requestId, '请求标识', 100)
    this.actionLocks.add(binding.id)
    try {
      const result = await (await this.changes()).revert({ binding, turnId, token, requestId })
      this.undoViews.delete(`${binding.id}:${turnId}`)
      this.publish()
      return this.sanitize(result)
    } finally { this.actionLocks.delete(binding.id) }
  }

  turnMetadata(binding, effort = binding.effort, startedAt = Date.now()) {
    const entry = this.customModels?.get(binding.model) || this.models.find((model) => model.id === binding.model)
    return { model: entry?.model ?? binding.model, modelLabel: entry?.name || entry?.displayName || entry?.model || binding.model, effort: effort || '', engine: binding.engine || 'workspace', access: this.accessPolicy.mode(binding, this.transportGeneration), startedAt }
  }

  async environmentCheck(sessionId) {
    if (this.disposed) throw new CodexError('disposed', '插件已停用', 503)
    const cwd = await this.resolveWorkspace(sessionId)
    if (this.disposed) throw new CodexError('disposed', '插件已停用', 503)
    if (this.environmentChecks.has(sessionId) || this.environmentChecks.size >= 2) throw new CodexError('environment-busy', '环境检查正在进行，请稍后再试', 429)
    const controller = new AbortController()
    const record = { controller, completion: null }
    this.environmentChecks.set(sessionId, record)
    const timer = setTimeout(() => controller.abort(new Error('timeout')), 30000)
    timer.unref?.()
    record.completion = checkWorkspaceEnvironment({ cwd, env: this.env, signal: controller.signal })
    try { return await record.completion } finally {
      clearTimeout(timer)
      this.environmentChecks.delete(sessionId)
    }
  }

  parameters(modelId, effort, mode) {
    if (mode !== 'agent' && mode !== 'chat') throw new CodexError('mode-invalid', '不支持的工作模式')
    if (!this.health[mode]) throw new CodexError('execution-unavailable', mode === 'chat' ? this.health.chatReason : this.health.reason || '本机隔离能力未通过验证', 503)
    const model = this.models.find((item) => item.id === modelId)
    if (!model) throw new CodexError('model-invalid', '所选模型不在 Codex 的可用列表中')
    if (!model.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)) throw new CodexError('effort-invalid', '所选模型不支持该推理强度')
    return { model: model.model, effort, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'workspace-write' }
  }

  customParameters(modelId, mode, binding = null, engine = 'workspace') {
    if (this.disposed) throw new CodexError('disposed', '插件已停用', 503)
    if (!['chat', 'agent'].includes(mode)) throw new CodexError('mode-invalid', '请选择智能体或对话模式')
    if (binding && binding.mode !== mode) throw new CodexError('mode-change', '切换工作模式需要新建对话', 409)
    const model = this.customModels?.get(modelId)
    if (!model) throw new CodexError('model-missing', '此自定义模型已被删除，请在设置中添加模型并新建对话', 404)
    if ((model.engine ?? 'workspace') !== engine) throw new CodexError('engine-change', '模型执行引擎已改变，请新建对话', 409)
    if (binding && (binding.providerId !== model.id || binding.providerRevision !== modelRevision(model))) throw new CodexError('model-change', '模型、URL 或接口类型已改变，请新建对话，避免将历史消息发送到其他模型服务', 409)
    // Copy the provider so editing or deleting settings cannot redirect an accepted request.
    return { ...model }
  }

  async nativeParameters(modelId, effort, mode, binding = null, approvalPolicy = 'untrusted', bridgeScope = binding?.bridgeScope || binding?.id) {
    const accessMode = binding ? this.accessPolicy.mode(binding, this.transportGeneration) : 'approval'
    const execution = nativeExecutionParameters(this.health.nativeApp, mode, approvalPolicy, { accessMode })
    if (binding && (binding.engine !== 'native' || binding.executionMode !== 'app-process' || binding.permissionMode !== 'app-process' || binding.approvalPolicy !== 'untrusted')) throw new CodexError('engine-change', '原生执行绑定不匹配，请新建对话', 409)
    if (binding && binding.model !== modelId) throw new CodexError('model-change', '切换原生模型需要新建对话', 409)
    const custom = this.customModels?.get(modelId)
    if (custom || binding?.source === 'native-custom') {
      const provider = this.customParameters(modelId, mode, binding, 'native')
      const selectedEffort = this.providerEffort(provider, effort, binding)
      this.rememberProvider(provider)
      const endpoint = provider.apiFormat === 'responses' ? null : await this.nativeBridge(provider, bridgeScope)
      const parameters = nativeProviderParameters(provider, { bridge: endpoint })
      return { ...parameters, ...execution, ...(selectedEffort ? { effort: selectedEffort } : {}), providerId: provider.id, providerRevision: modelRevision(provider), credentialRevision: credentialRevision(provider), source: 'native-custom' }
    }
    const model = this.models.find((item) => item.id === modelId)
    if (!model) throw new CodexError('model-invalid', '所选模型不在 Codex 的可用列表中')
    if (!model.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)) throw new CodexError('effort-invalid', '所选模型不支持该推理强度')
    const providerRevision = createHash('sha256').update(JSON.stringify(['openai', model.model])).digest('hex')
    if (binding && (binding.providerId !== 'openai' || binding.providerRevision !== providerRevision)) throw new CodexError('model-change', '原生模型配置已改变，请新建对话', 409)
    return { model: model.model, modelProvider: 'openai', effort, ...execution, providerId: 'openai', providerRevision, source: 'native' }
  }

  providerEffort(provider, effort, binding = null) {
    const selected = effort === undefined ? binding?.effort ?? provider.reasoningEffort ?? '' : effort
    if (!selected) return ''
    const supported = provider.reasoningEfforts ?? []
    // Old native Responses settings accepted the CLI's conventional effort values.
    const legacy = provider.engine === 'native' && provider.apiFormat === 'responses' && !supported.length && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(selected)
    if (!legacy && !supported.includes(selected)) throw new CodexError('effort-invalid', '此模型未配置该推理强度，请在模型设置中添加支持的值')
    return selected
  }

  async nativeBridge(provider, scope) {
    if (!scope) throw new CodexError('bridge-binding', '兼容模型缺少独立会话绑定', 409)
    if (!this.bridge) this.bridge = this.bridgeFactory({ fetchImpl: this.fetchImpl, timeoutMs: this.customTimeoutMs, customGrammarMode: 'wrap-known' })
    if (!this.bridgeOpening) this.bridgeOpening = this.bridge.start().catch((error) => { this.bridgeOpening = null; throw error })
    await this.bridgeOpening
    if (this.disposed) throw new CodexError('disposed', '插件已停用', 503)
    const revision = modelRevision(provider)
    const credentials = credentialRevision(provider)
    const existing = this.bridgeBindings.get(scope)
    if (existing) {
      if (existing.providerId !== provider.id || existing.providerRevision !== revision) throw new CodexError('model-change', '兼容模型的服务配置已改变，请新建对话', 409)
      if (existing.credentialRevision !== credentials) {
        this.bridge.rotateCredentials(existing.bindingId, provider)
        existing.credentialRevision = credentials
      }
      return existing.endpoint
    }
    const bindingId = randomUUID()
    const endpoint = this.bridge.bind(provider, { bindingId, scope })
    this.nativeSecrets.add(endpoint.apiKey)
    this.bridgeBindings.set(scope, { bindingId, endpoint, providerId: provider.id, providerRevision: revision, credentialRevision: credentials })
    return endpoint
  }

  loadedThread(binding, credentials) {
    const loaded = this.loadedThreads.get(binding.id)
    return loaded?.generation === this.transportGeneration && loaded.credentialRevision === credentials
  }

  markLoaded(binding, credentials) {
    this.loadedThreads.set(binding.id, { generation: this.transportGeneration, credentialRevision: credentials })
  }

  async createCustom(sessionId, { model, effort, mode, continueFrom }, { reservation = null } = {}) {
    const provider = this.customParameters(model, mode)
    const selectedEffort = this.providerEffort(provider, effort)
    const cwd = await this.resolveWorkspace(sessionId)
    let inherited = [], source = null
    if (continueFrom !== undefined) {
      requireString(continueFrom, '原对话标识', 200)
      const original = await this.bound(sessionId, continueFrom)
      if (mode !== 'agent' || original.source !== 'custom' || original.mode !== 'chat') throw new CodexError('continuation-invalid', '仅支持将自定义模型的对话继续为工作区助手', 409)
      this.customParameters(model, 'chat', original)
      source = this.threads.get(continueFrom)
      if (!source || source.cwd !== cwd || await realpath(source.cwd) !== cwd) throw new CodexError('workspace-changed', '原对话工作区已改变，请新建工作区助手', 409)
      if (this.running.has(continueFrom) || this.preparing.has(continueFrom) || source.status?.type === 'active' || source.turns.some((turn) => turn.status === 'inProgress')) throw new CodexError('busy', '原对话仍在执行，请等待完成或停止后切换', 409)
      inherited = structuredClone(source.turns.filter((turn) => turn.status === 'completed'))
      if (inherited.length >= 100) throw new CodexError('continuation-limit', '原对话已达到轮数上限，请新建工作区助手', 413)
      // Reuse only completed messages as context. No request ids or approvals are inherited,
      // and imported turns are never submitted again to the provider or the workspace tools.
      // Leave room for the new agent's system instructions as well as the next user turn.
      validateMessages([{ role: 'system', content: ' '.repeat(4096) }, ...conversationMessages({ turns: inherited }, '')])
      for (const turn of inherited) {
        turn.id = randomUUID()
        turn.imported = true
        for (const item of turn.items) item.id = randomUUID()
      }
    }
    if ([...this.bindings.values()].filter((entry) => entry.source === 'custom').length >= 200) throw new CodexError('history-limit', '最多可保存 200 个自定义模型对话', 413)
    const id = `custom-thread-${randomUUID()}`
    const binding = { id, sessionId, cwd, title: '新对话', model, effort: selectedEffort, mode, source: 'custom', engine: 'workspace', providerId: provider.id, providerRevision: modelRevision(provider), updatedAt: Date.now() }
    const thread = { id, cwd, source: 'custom', status: { type: 'idle' }, turns: inherited, historyCursor: null }
    if (source) {
      binding.title = this.bindings.get(source.id).title
      Object.assign(binding, { continuedFrom: source.id, inheritedTurns: inherited.length })
      Object.assign(thread, { continuedFrom: source.id, inheritedTurns: inherited.length })
    }
    if (Buffer.byteLength(JSON.stringify(thread)) + (source ? MAX_OUTPUT_CHARS * 4 : 0) > MAX_HISTORY_BYTES) throw new CodexError('history-limit', '原对话上下文超过历史上限，请新建工作区助手', 413)
    if (reservation) { this.reservedThreads.set(id, reservation); this.actionLocks.add(id) }
    this.bindings.set(id, binding)
    this.threads.set(id, thread)
    try { await this.save() } catch (error) {
      this.bindings.delete(id); this.threads.delete(id)
      this.reservedThreads.delete(id); this.actionLocks.delete(id)
      throw error
    }
    this.publish()
    return { thread, binding }
  }

  sendCustom(binding, input, key, { contextSuffix = '', preparedMessages = null } = {}) {
    const provider = this.customParameters(input.model, input.mode, binding)
    const selectedEffort = this.providerEffort(provider, input.effort, binding)
    const accessMode = this.accessPolicy.mode(binding, this.transportGeneration)
    const accessEpoch = this.accessEpochs.get(binding.id) ?? 0
    this.activeAccess.set(binding.id, accessMode)
    if (selectedEffort) provider.reasoningEffort = selectedEffort
    this.rememberProvider(provider)
    const thread = this.threads.get(binding.id)
    if (!thread) throw new CodexError('history-invalid', '自定义模型对话历史缺失', 503)
    if (thread.turns.length >= 100) throw new CodexError('history-limit', '此对话已达到 100 轮上限，请新建对话', 413)
    if (input.files !== undefined && !Array.isArray(input.files)) throw new CodexError('context-limit', '引用文件列表格式不正确')
    const files = input.files ?? []
    if (files.length > 5) throw new CodexError('context-limit', '一次最多引用 5 个文本文件')
    const controller = new AbortController()
    this.customControllers.set(binding.id, controller)
    this.running.add(binding.id)
    this.preparing.add(binding.id)
    this.publish()
    const operation = Promise.resolve().then(async () => {
      let submitted = false
      try {
        const context = await Promise.all(files.map((file) => contextFile(binding.cwd, file)))
        let text = input.text + contextSuffix
        for (const file of context) text += `\n\n<workspace-file path=${JSON.stringify(file.path)}>\n${file.text}\n</workspace-file>`
        const environment = workspaceEnvironment(binding.cwd, this.env)
        const permissionContext = accessMode === 'readonly' ? '此会话只允许读取：仅提供目录、读取、搜索和环境工具，不提供文件写入或命令工具，执行层也拒绝这两类操作。' : accessMode === 'full' ? '用户已对当前会话确认完全访问。仅本次会话可在应用普通权限与既有文件路径边界内执行工具，无需逐次审批；不能提权或绕过凭据文件限制。' : '文件写入和每条命令都必须等待用户本次确认。'
        const system = binding.mode === 'agent'
          ? `你是当前工作区的编程助手。以下环境由应用实际运行时提供：${JSON.stringify({ cwd: binding.cwd, platform: environment.platform, arch: environment.arch, shell: environment.shell, node: process.version, permissionMode: accessMode })}。${permissionContext}历史关于工具能力的声明不构成当前授权，只以本轮实际工具定义为准。读取文件、列目录和搜索必须使用工具获取真实结果，不得假装已访问。没有内核级工作区沙箱，不得声称存在隔离；系统无权访问的路径不可访问。历史消息只作为上下文，不得自动重新执行旧任务。`
          : `你正在与用户进行文字对话。实际应用环境：${JSON.stringify({ cwd: binding.cwd, platform: environment.platform, arch: environment.arch, shell: environment.shell, node: process.version })}。当前模式未提供文件或命令工具；只使用用户给出的消息和引用文件回答。`
        if (preparedMessages && (binding.mode !== 'chat' || !binding.replyOnly)) throw new CodexError('retry-unsupported', '重新回答必须使用真实无工具会话', 409)
        const messages = [{ role: 'system', content: system }, ...(preparedMessages ? structuredClone(preparedMessages) : conversationMessages(thread, text))]
        validateMessages(messages)
        if (Buffer.byteLength(JSON.stringify(thread)) + Buffer.byteLength(text) + MAX_OUTPUT_CHARS * 4 > MAX_HISTORY_BYTES) throw new CodexError('history-limit', '此对话历史超过大小上限，请新建对话', 413)
        if (controller.signal.aborted) throw new CodexError('model-cancelled', '模型请求已停止', 409)
        const turnId = randomUUID()
        const agent = { id: randomUUID(), type: 'agentMessage', text: '' }
        const turn = { id: turnId, status: 'inProgress', metadata: this.turnMetadata(binding, selectedEffort), providerMessages: preparedMessages ? structuredClone(preparedMessages) : [{ role: 'user', content: text }], items: [{ id: randomUUID(), type: 'userMessage', content: [{ type: 'text', text: input.text }], providerText: text }, agent] }
        const record = { id: input.requestId, outcome: 'accepted', turnId, at: Date.now() }
        const previous = { title: binding.title, updatedAt: binding.updatedAt, effort: binding.effort }
        binding.requests ??= []
        binding.requests.push(record)
        if (binding.requests.length > 500) binding.requests.shift()
        Object.assign(binding, { title: input.text.slice(0, 60), updatedAt: Date.now(), effort: selectedEffort })
        thread.turns.push(turn)
        thread.status = { type: 'active' }
        try { await this.save() } catch (error) {
          thread.turns.pop()
          binding.requests = binding.requests.filter((entry) => entry !== record)
          Object.assign(binding, previous)
          thread.status = { type: 'idle' }
          throw error
        }
        if (accessMode === 'full' && ((this.accessEpochs.get(binding.id) ?? 0) !== accessEpoch || this.accessPolicy.mode(binding, this.transportGeneration) !== 'full')) controller.abort(new Error('access-revoked'))
        submitted = true
        this.publish()
        const completion = this.runCustomTurn({ binding, thread, turn, agent, record, provider, messages, controller, accessMode })
        this.customOperations.add(completion)
        completion.finally(() => this.customOperations.delete(completion)).catch(() => {})
        return { turnId }
      } catch (error) {
        if (!submitted) {
          this.running.delete(binding.id)
          this.customControllers.delete(binding.id)
          this.activeAccess.delete(binding.id)
          this.publish()
        }
        throw error
      } finally {
        this.preparing.delete(binding.id)
      }
    })
    this.requests.set(key, operation)
    if (this.requests.size > 500) this.requests.delete(this.requests.keys().next().value)
    return operation
  }

  async runCustomTurn({ binding, thread, turn, agent, record, provider, messages, controller, accessMode = 'approval' }) {
    let outputLength = 0
    let toolCount = 0
    const completedCalls = new Set()
    let currentItemId = null
    const agentTimer = binding.mode === 'agent' ? setTimeout(() => controller.abort(new Error('timeout')), this.customAgentTimeoutMs) : null
    agentTimer?.unref?.()
    try {
      const journal = binding.mode === 'agent' && accessMode !== 'readonly' ? (await this.changes()).adapter({ binding, turnId: turn.id, signal: controller.signal, secrets: providerSecrets(provider) }) : null
      const tools = new WorkspaceTools({ cwd: binding.cwd, env: this.env, signal: controller.signal, secrets: providerSecrets(provider), accessMode, journal,
        approve: (operation) => this.askCustomApproval(binding, turn, currentItemId, operation, controller.signal),
        onItem: (item) => {
          const index = turn.items.findIndex((entry) => entry.id === item.id)
          if (index === -1) turn.items.push(item)
          else turn.items[index] = { ...turn.items[index], ...item }
          this.publish()
        },
      })
      for (let round = 0; round < 12; round += 1) {
        if (controller.signal.aborted) throw new CodexError('model-cancelled', '模型请求已停止', 409)
        if (round) { agent = { id: randomUUID(), type: 'agentMessage', text: '' }; turn.items.push(agent) }
        let reasoning = null
        const response = await streamCustomChat({ model: provider, messages, controller, fetchImpl: this.fetchImpl, timeoutMs: this.customTimeoutMs, tools: binding.mode === 'agent' ? accessMode === 'readonly' ? readOnlyTools : WORKSPACE_TOOLS : [], onDelta: (delta) => {
          outputLength += delta.length
          if (outputLength > MAX_OUTPUT_CHARS) throw new CodexError('model-output-limit', '本轮智能体回复超过长度上限', 413)
          agent.text += delta
          this.publish()
        }, onReasoningDelta: (delta) => {
          outputLength += delta.length
          if (outputLength > MAX_OUTPUT_CHARS) throw new CodexError('model-output-limit', '本轮智能体推理超过长度上限', 413)
          reasoning ??= { id: randomUUID(), type: 'reasoning', text: '' }
          if (!turn.items.includes(reasoning)) turn.items.push(reasoning)
          reasoning.text += delta
          this.publish()
        } })
        const assistant = { role: 'assistant', content: response.text }
        if (provider.apiFormat === 'responses' && response.providerOutput.length) assistant.responses_output = response.providerOutput
        if (response.providerReplay) assistant.provider_replay = response.providerReplay
        if (response.reasoningContent) assistant.reasoning_content = response.reasoningContent
        if (response.toolCalls.length) assistant.tool_calls = response.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }))
        messages.push(assistant)
        turn.providerMessages.push(assistant)
        if (!response.toolCalls.length) break
        if (round === 11 || toolCount + response.toolCalls.length > 40) throw new CodexError('model-tools-limit', '本轮智能体已达到工具调用上限，请发送新消息继续', 413)
        for (const call of response.toolCalls) {
          if (controller.signal.aborted) throw new CodexError('model-cancelled', '模型请求已停止', 409)
          await this.bound(binding.sessionId, binding.id)
          if (completedCalls.has(call.id)) throw new CodexError('model-tools-duplicate', '模型重复使用工具调用标识，已停止以避免重复执行', 409)
          completedCalls.add(call.id)
          toolCount += 1
          currentItemId = randomUUID()
          const item = { id: currentItemId, type: 'workspaceTool', name: call.name, arguments: call.arguments, status: 'inProgress' }
          turn.items.push(item)
          this.publish()
          let result
          try {
            const argumentsValue = JSON.parse(call.arguments)
            if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) throw new Error('invalid arguments')
            result = await tools.execute(call.name, argumentsValue)
          } catch (error) {
            if (controller.signal.aborted || error.name === 'AbortError') throw error
            result = { ok: false, code: 'tool-input', error: '工具参数不是有效 JSON 对象或工具执行失败' }
          }
          item.status = result.ok ? 'completed' : 'failed'
          item.result = result
          const toolMessage = { role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify(result) }
          messages.push(toolMessage)
          turn.providerMessages.push(toolMessage)
          if (Buffer.byteLength(JSON.stringify(thread)) > MAX_HISTORY_BYTES) throw new CodexError('history-limit', '本轮工具结果超过历史上限，已停止，请新建对话', 413)
          await this.save()
          this.publish()
        }
        validateMessages(messages)
      }
      turn.status = 'completed'
      record.outcome = 'completed'
    } catch (error) {
      turn.status = controller.signal.aborted && controller.signal.reason?.message !== 'timeout' || error.code === 'model-cancelled' ? 'interrupted' : 'failed'
      turn.error = controller.signal.aborted
        ? { code: controller.signal.reason?.message === 'timeout' ? 'model-timeout' : 'model-cancelled', message: controller.signal.reason?.message === 'timeout' ? '智能体任务超时，已停止；不会自动重新执行工具。' : '模型请求已停止' }
        : { code: error.code ?? 'model-network', message: error instanceof CodexError ? error.message : '模型请求失败，请检查服务状态' }
      for (const item of turn.items) if (item.status === 'inProgress' || item.status === 'pending' || item.status === 'awaitingApproval') item.status = turn.status
      record.outcome = turn.status
    } finally {
      if (turn.metadata) turn.metadata.completedAt = Date.now()
      this.undoViews.clear()
      clearTimeout(agentTimer)
      this.clearApprovals(binding.id)
      thread.status = { type: 'idle' }
      binding.updatedAt = Date.now()
      this.running.delete(binding.id)
      this.customControllers.delete(binding.id)
      this.activeAccess.delete(binding.id)
      try { await this.save() } catch { thread.lastError = '对话历史保存失败，请检查应用私有目录是否可写；此请求不会自动重发。' }
      this.publish()
    }
  }

  messageAction(sessionId, input, kind) { return runMessageAction(this, sessionId, input, kind) }

  async create(sessionId, { model, effort, mode, continueFrom, engine = 'workspace', approvalPolicy = 'untrusted' }, { reservation = null } = {}) {
    await this.load()
    if (!['workspace', 'native'].includes(engine)) throw new CodexError('engine-invalid', '请选择工作区助手或原生 Codex 引擎')
    if (engine === 'native') {
      if (continueFrom !== undefined) throw new CodexError('continuation-invalid', '原生 Codex 需要新建独立线程', 409)
      const bridgeScope = randomUUID()
      const parameters = await this.nativeParameters(model, effort, mode, null, approvalPolicy, bridgeScope)
      const cwd = await this.resolveWorkspace(sessionId)
      if (parameters.source === 'native' && this.account?.requiresAuth && !this.account.loggedIn) throw new CodexError('login-required', '请先完成 Codex 登录', 401)
      const { effort: selectedEffort, providerId, providerRevision, credentialRevision: credentials, source, ...start } = parameters
      const generation = this.transportGeneration
      let result
      try { result = await this.rpc().request('thread/start', { ...start, cwd }) } catch (error) {
        const bridge = this.bridgeBindings.get(bridgeScope)
        if (bridge) { this.bridge?.revoke(bridge.bindingId); this.bridgeBindings.delete(bridgeScope) }
        throw error
      }
      if (generation !== this.transportGeneration || this.transport?.closed) throw new CodexError('not-connected', 'Codex 连接已改变，请重新创建会话', 503)
      const thread = this.sanitize(result.thread)
      if (!thread?.id || await realpath(thread.cwd) !== cwd) throw new CodexError('thread-invalid', 'Codex 返回了不匹配的工作区', 502)
      const binding = { id: thread.id, sessionId, cwd, title: '新对话', model, effort: selectedEffort ?? '', mode, source, engine: 'native', executionMode: 'app-process', permissionMode: 'app-process', approvalPolicy: 'untrusted', providerId, providerRevision, ...(this.bridgeBindings.has(bridgeScope) ? { bridgeScope } : {}), updatedAt: Date.now() }
      if (reservation) { this.reservedThreads.set(thread.id, reservation); this.actionLocks.add(thread.id) }
      this.bindings.set(thread.id, binding)
      try { await this.save() } catch (error) {
        this.bindings.delete(thread.id)
        this.reservedThreads.delete(thread.id); this.actionLocks.delete(thread.id)
        throw error
      }
      this.threads.set(thread.id, thread)
      this.markLoaded(binding, credentials)
      this.publish()
      return this.sanitize({ thread, binding })
    }
    if (this.customModels.get(model)) return this.createCustom(sessionId, { model, effort, mode, continueFrom }, { reservation })
    if (continueFrom !== undefined) throw new CodexError('continuation-invalid', '仅支持将自定义模型的对话继续为工作区助手', 409)
    const parameters = this.parameters(model, effort, mode)
    const cwd = await this.resolveWorkspace(sessionId)
    if (this.account?.requiresAuth && !this.account.loggedIn) throw new CodexError('login-required', '请先完成 Codex 登录', 401)
    const { effort: unused, ...start } = parameters
    const result = await this.rpc().request('thread/start', { ...start, cwd })
    const thread = result.thread
    if (!thread?.id || await realpath(thread.cwd) !== cwd) throw new CodexError('thread-invalid', 'Codex 返回了不匹配的工作区', 502)
    const binding = { id: thread.id, sessionId, cwd, title: '新对话', model, effort, mode, engine: 'workspace', updatedAt: Date.now() }
    this.bindings.set(thread.id, binding)
    await this.save()
    this.threads.set(thread.id, thread)
    this.markLoaded(binding)
    this.publish()
    return { thread, binding }
  }

  async resume(sessionId, threadId) {
    const binding = await this.bound(sessionId, threadId)
    if (binding.source === 'custom') {
      const thread = this.threads.get(threadId)
      if (!thread) throw new CodexError('history-invalid', '自定义模型对话历史缺失', 503)
      this.publish()
      return thread
    }
    return this.resumeNative(binding)
  }

  async resumeNative(binding, acceptedParameters = null) {
    if (!acceptedParameters && this.running.has(binding.id) && !this.preparing.has(binding.id) && this.threads.has(binding.id)) return this.threads.get(binding.id)
    if (this.resumingThreads.has(binding.id)) return this.resumingThreads.get(binding.id)
    const operation = this.loadNativeThread(binding, acceptedParameters)
    this.resumingThreads.set(binding.id, operation)
    try { return await operation } finally {
      if (this.resumingThreads.get(binding.id) === operation) this.resumingThreads.delete(binding.id)
    }
  }

  async loadNativeThread(binding, acceptedParameters) {
    const threadId = binding.id
    const generation = this.transportGeneration
    // Verify the provider binding before loading history or workspace configuration.
    const native = acceptedParameters || (binding.engine === 'native' ? await this.nativeParameters(binding.model, binding.effort, binding.mode, binding, binding.approvalPolicy) : null)
    const rpc = this.rpc()
    const stored = await rpc.request('thread/read', { threadId, includeTurns: false })
    if (await realpath(stored.thread.cwd) !== binding.cwd) throw new CodexError('thread-invalid', 'Codex 历史工作区与绑定不一致', 403)
    let thread = stored.thread
    if (native) {
      const { effort: unused, providerId, providerRevision, credentialRevision: credentials, source, ...parameters } = native
      const result = await rpc.request('thread/resume', { ...parameters, threadId, cwd: binding.cwd, excludeTurns: true })
      thread = result.thread
      if (!thread?.id || thread.id !== threadId || await realpath(thread.cwd) !== binding.cwd) throw new CodexError('thread-invalid', 'Codex 恢复了不匹配的会话或工作区', 403)
    } else if (this.health.agent) {
      const result = await rpc.request('thread/resume', { threadId, cwd: binding.cwd, sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user', excludeTurns: true })
      thread = result.thread
    }
    const page = await rpc.request('thread/turns/list', { threadId, limit: 20, sortDirection: 'desc', itemsView: 'full' })
    if (generation !== this.transportGeneration || rpc !== this.transport || rpc.closed) throw new CodexError('not-connected', '恢复会话时 Codex 连接已改变，请重连后再试', 503)
    thread = this.sanitize({ ...thread, turns: [...(page.data ?? [])].reverse(), historyCursor: page.nextCursor ?? null })
    this.threads.set(threadId, thread)
    this.markLoaded(binding, native?.credentialRevision)
    if (thread.turns.some((turn) => turn.status === 'inProgress') || thread.status?.type === 'active') this.running.add(threadId)
    else if (!this.preparing.has(threadId)) this.running.delete(threadId)
    this.publish()
    return thread
  }

  async older(sessionId, threadId) {
    const binding = await this.bound(sessionId, threadId)
    if (binding.source === 'custom') return this.threads.get(threadId)
    const current = this.threads.get(threadId)
    if (!current?.historyCursor) return current
    const page = await this.rpc().request('thread/turns/list', { threadId, cursor: current.historyCursor, limit: 20, sortDirection: 'desc', itemsView: 'full' })
    if (page.nextCursor === current.historyCursor) throw new CodexError('history-pagination', '会话历史分页异常', 502)
    const ids = new Set(current.turns.map((turn) => turn.id))
    const older = (page.data ?? []).filter((turn) => !ids.has(turn.id)).reverse()
    const updated = this.sanitize({ ...current, turns: [...older, ...current.turns], historyCursor: page.nextCursor ?? null })
    this.threads.set(threadId, updated)
    this.publish()
    return updated
  }

  async send(sessionId, input, { reservation = null, contextSuffix = '', preparedMessages = null } = {}) {
    const binding = await this.bound(sessionId, input.threadId)
    const reserved = this.reservedThreads.get(binding.id)
    if (reserved && reserved !== reservation) throw new CodexError('busy', '新分支正在接收首次消息，请稍后重试', 409)
    requireString(input.requestId, '请求标识', 100)
    requireString(input.text, '消息', 64000)
    const key = `${binding.id}:${input.requestId}`
    if (this.requests.has(key)) return this.requests.get(key)
    const prior = binding.requests?.find((entry) => entry.id === input.requestId)
    if (prior) {
      if (prior.turnId) return { turnId: prior.turnId }
      throw new CodexError('outcome-unknown', '此请求已提交，结果需从历史确认；不会重复执行', 409)
    }
    if (this.running.has(binding.id) || this.actionLocks.has(binding.id) && (!reservation || reserved !== reservation)) throw new CodexError('busy', '当前会话仍在执行或处理修改，请先停止或等待完成', 409)
    if (binding.source === 'custom') return this.sendCustom(binding, input, key, { contextSuffix, preparedMessages })
    if (input.mode !== undefined && input.mode !== binding.mode) throw new CodexError('mode-change', '切换工作模式需要新建会话，避免继承已授权工具', 409)
    this.running.add(binding.id)
    this.preparing.add(binding.id)
    const acceptedAccess = this.accessPolicy.mode(binding, this.transportGeneration)
    const acceptedEpoch = this.accessEpochs.get(binding.id) ?? 0
    this.activeAccess.set(binding.id, acceptedAccess)
    this.publish()
    const operation = Promise.resolve().then(async () => {
      try {
        let parameters
        if (binding.engine === 'native') {
          parameters = await this.nativeParameters(input.model, input.effort, binding.mode, binding, binding.approvalPolicy)
        } else {
          if (this.customModels.get(input.model)) throw new CodexError('model-change', '切换为自定义模型需要新建对话', 409)
          parameters = this.parameters(input.model, input.effort, input.mode)
        }
        const generation = this.transportGeneration
        const rpc = this.rpc()
        // Only ThreadStart/ThreadResume carry provider config or private revisions.
        const { sandbox, modelProvider, config, providerId, providerRevision, credentialRevision: credentials, source, ...turnParameters } = parameters
        const sandboxPolicy = binding.engine === 'native'
          ? { type: 'dangerFullAccess' }
          : { type: 'workspaceWrite', writableRoots: [binding.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
        const files = Array.isArray(input.files) ? input.files : []
        if (files.length > 5) throw new CodexError('context-limit', '一次最多引用 5 个文本文件')
        const context = await Promise.all(files.map((file) => contextFile(binding.cwd, file)))
        let text = input.text
        for (const file of context) text += `\n\n<workspace-file path=${JSON.stringify(file.path)}>\n${file.text}\n</workspace-file>`
        if (!this.loadedThread(binding, credentials)) {
          const resumed = await this.resumeNative(binding, binding.engine === 'native' ? parameters : null)
          if (resumed.status?.type === 'active' || resumed.turns.some((turn) => turn.status === 'inProgress')) throw new CodexError('busy', '恢复的会话仍在运行，请先等待或停止', 409)
          if (!this.loadedThread(binding, credentials)) throw new CodexError('provider-stale', '会话凭据需要重新绑定，请恢复会话后再发送', 409)
        }
        if (generation !== this.transportGeneration || this.transport?.closed) throw new CodexError('not-connected', '发送前 Codex 连接已改变，请重连后再试', 503)
        binding.requests ??= []
        binding.requests.push({ id: input.requestId, outcome: 'submitted', at: Date.now() })
        if (binding.requests.length > 500) binding.requests.shift()
        await this.save()
        await this.bound(sessionId, binding.id)
        const currentParameters = binding.engine === 'native'
          ? await this.nativeParameters(input.model, input.effort, binding.mode, binding, binding.approvalPolicy)
          : this.parameters(input.model, input.effort, input.mode)
        if (generation !== this.transportGeneration || rpc !== this.transport || rpc.closed) throw new CodexError('not-connected', '发送前 Codex 连接已改变，任务未提交', 503)
        if ((this.accessEpochs.get(binding.id) ?? 0) !== acceptedEpoch || this.accessPolicy.mode(binding, generation) !== acceptedAccess || currentParameters.approvalPolicy !== turnParameters.approvalPolicy || currentParameters.providerRevision !== providerRevision || currentParameters.credentialRevision !== credentials) throw new CodexError('access-changed', '发送前权限或模型配置已改变，任务未提交，请重新确认', 409)
        const metadata = this.turnMetadata(binding, input.effort)
        const result = await rpc.request('turn/start', {
          ...turnParameters, threadId: binding.id, cwd: binding.cwd,
          clientUserMessageId: input.requestId,
          sandboxPolicy,
          input: [{ type: 'text', text, text_elements: [] }],
        })
        const current = this.threads.get(binding.id)
        if (generation !== this.transportGeneration || rpc !== this.transport || rpc.closed) throw new CodexError('outcome-unknown', '任务已提交但连接已改变，请先恢复历史确认，不会自动重发', 409)
        this.threads.set(binding.id, reduceEvent(current, 'turn/started', { turn: result.turn }))
        const live = this.threads.get(binding.id).turns.find((turn) => turn.id === result.turn.id)
        if (live) {
          live.metadata = { ...metadata, ...(live.metadata ?? {}) }
          if (live.status !== 'inProgress') live.metadata.completedAt ??= Date.now()
          binding.turnMetadata ??= {}
          binding.turnMetadata[live.id] = live.metadata
          const ids = Object.keys(binding.turnMetadata)
          if (ids.length > 100) delete binding.turnMetadata[ids[0]]
        }
        const record = binding.requests.find((entry) => entry.id === input.requestId)
        if (record) { record.turnId = result.turn.id; record.outcome = 'accepted' }
        if (this.threads.get(binding.id).turns.find((turn) => turn.id === result.turn.id)?.status !== 'inProgress') this.running.delete(binding.id)
        Object.assign(binding, { title: input.text.slice(0, 60), model: input.model, updatedAt: Date.now() })
        if (input.effort) binding.effort = input.effort
        await this.save()
        this.publish()
        return { turnId: result.turn.id }
      } catch (error) {
        if (error.code !== 'rpc-timeout' && error.code !== 'busy') this.running.delete(binding.id)
        this.publish()
        throw error
      } finally {
        this.preparing.delete(binding.id)
      }
    })
    this.requests.set(key, operation)
    // Bounded idempotency cache. A timeout remains cached, so it cannot be resent blindly.
    if (this.requests.size > 500) this.requests.delete(this.requests.keys().next().value)
    return operation
  }

  event({ method, params = {} }) {
    if (method === 'account/updated' || method === 'account/login/completed') {
      this.refreshAccount().then(() => this.refreshModels()).then(() => this.publish()).catch((error) => { this.health.accountError = redact(error.message); this.publish() })
      return
    }
    if (method === 'serverRequest/resolved') {
      for (const [key, entry] of this.approvals) if (entry.requestId === params.requestId) { clearTimeout(entry.timer); this.approvals.delete(key) }
      this.publish()
      return
    }
    if (!EVENTS.has(method)) return
    const threadId = params.threadId ?? params.thread?.id
    if (!this.bindings.has(threadId)) return
    if (this.bindings.get(threadId).source === 'custom') return
    const thread = this.threads.get(threadId) ?? { id: threadId, turns: [] }
    this.threads.set(threadId, reduceEvent(thread, method, params))
    if (method === 'turn/started' && this.threads.get(threadId).turns.find((turn) => turn.id === params.turn?.id)?.status === 'inProgress') this.running.add(threadId)
    if (method === 'turn/completed') {
      const turn = this.threads.get(threadId)?.turns?.find((entry) => entry.id === params.turn?.id)
      if (turn?.metadata) turn.metadata.completedAt = Date.now()
      const binding = this.bindings.get(threadId)
      if (turn?.metadata && binding) { binding.turnMetadata ??= {}; binding.turnMetadata[turn.id] = turn.metadata }
      this.running.delete(threadId)
      this.activeAccess.delete(threadId)
      this.clearApprovals(threadId, false)
      this.save().catch(() => { this.threads.get(threadId).lastError = '会话元信息保存失败，请检查私有目录空间。' })
    }
    if (method === 'error') this.threads.get(threadId).lastError = redact(params.error?.message ?? params.message ?? 'Codex 操作失败')
    this.publish()
  }

  approval({ id, method, params = {} }) {
    const binding = this.bindings.get(params.threadId)
    // Workspace threads require verified sandbox isolation; native threads require the
    // verified app-process server. Each capability gates its own bindings only.
    const native = binding?.engine === 'native'
    const executionReady = native ? this.health.nativeApp?.available === true : this.health.agent === true
    if (!binding || binding.source === 'custom' || !APPROVAL_METHODS.has(method) || !executionReady || !params.turnId || !params.itemId) {
      this.rpc().refuse(id)
      return
    }
    const liveTurn = this.threads.get(binding.id)?.turns?.find((turn) => turn.id === params.turnId)
    if (!this.running.has(binding.id) || liveTurn?.status !== 'inProgress') { this.rpc().respond(id, { decision: 'cancel' }); return }
    // Persistent grants are not represented by a one-time approval button.
    if (params.grantRoot) { this.rpc().respond(id, { decision: 'decline' }); return }
    const key = randomUUID()
    const entry = {
      id: key, requestId: id, method, threadId: binding.id, turnId: params.turnId,
      itemId: params.itemId, command: params.command ?? null, cwd: params.cwd ?? binding.cwd,
      reason: params.reason ?? null, createdAt: Date.now(),
      // Distinguishes native CLI approvals in the UI; never equals the custom source.
      source: binding.source,
    }
    entry.timer = setTimeout(() => {
      this.approvals.delete(key)
      try { this.rpc().respond(id, { decision: 'cancel' }) } catch { /* Process exited. */ }
      this.publish()
    }, 5 * 60 * 1000)
    entry.timer.unref()
    this.approvals.set(key, entry)
    this.publish()
  }

  askCustomApproval(binding, turn, itemId, operation, signal) {
    if (signal.aborted || turn.status !== 'inProgress' || !this.running.has(binding.id)) return Promise.resolve(false)
    const id = randomUUID()
    return new Promise((resolve) => {
      let settled = false
      const entry = {
        id, source: 'custom', kind: operation.kind, threadId: binding.id, turnId: turn.id,
        itemId: operation.itemId ?? itemId, command: operation.command ?? null, cwd: operation.cwd ?? binding.cwd,
        path: operation.path ?? null, diff: operation.diff ?? null,
        expectedHash: operation.expectedHash ?? null,
        reason: operation.kind === 'commandExecution' ? '此命令将在应用普通权限下运行，请确认命令及目录。' : '请确认本次文件变更。确认后将重新检查文件，避免覆盖已修改内容。',
        createdAt: Date.now(),
      }
      entry.resolveApproval = (approved) => {
        if (settled) return
        settled = true
        clearTimeout(entry.timer)
        signal.removeEventListener('abort', entry.abortHandler)
        this.approvals.delete(id)
        this.publish()
        resolve(approved)
      }
      entry.abortHandler = () => entry.resolveApproval(false)
      entry.timer = setTimeout(() => entry.resolveApproval(false), 5 * 60 * 1000)
      entry.timer.unref?.()
      signal.addEventListener('abort', entry.abortHandler, { once: true })
      this.approvals.set(id, entry)
      this.publish()
      if (signal.aborted) entry.resolveApproval(false)
    })
  }

  async decide(sessionId, { approvalId, decision }) {
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw new CodexError('decision-invalid', '只支持本次允许、拒绝或取消')
    const entry = this.approvals.get(approvalId)
    if (!entry) throw new CodexError('approval-expired', '审批已过期或已处理', 409)
    await this.bound(sessionId, entry.threadId)
    if (this.approvals.get(approvalId) !== entry || this.threads.get(entry.threadId)?.turns?.find((turn) => turn.id === entry.turnId)?.status !== 'inProgress') throw new CodexError('approval-expired', '该轮操作已结束或审批已被处理', 409)
    if (entry.source === 'custom') {
      entry.resolveApproval(decision === 'accept')
      return { ok: true }
    }
    const native = this.bindings.get(entry.threadId)?.engine === 'native'
    if (native ? this.health.nativeApp?.available !== true : !this.health.agent) {
      throw new CodexError('execution-unavailable', native ? this.health.nativeApp?.reason || '原生 Codex 执行能力已不可用' : '执行隔离不可用', 503)
    }
    this.rpc().respond(entry.requestId, { decision })
    clearTimeout(entry.timer)
    this.approvals.delete(approvalId)
    this.publish()
    return { ok: true }
  }

  clearApprovals(threadId, notify = true) {
    for (const [key, entry] of this.approvals) {
      if (entry.threadId !== threadId) continue
      if (entry.source === 'custom') { entry.resolveApproval(false); continue }
      clearTimeout(entry.timer)
      this.approvals.delete(key)
      if (notify) try { this.rpc().respond(entry.requestId, { decision: 'cancel' }) } catch { /* Process exited. */ }
    }
  }

  async interrupt(sessionId, threadId) {
    const binding = await this.bound(sessionId, threadId)
    if (binding.source === 'custom') {
      const controller = this.customControllers.get(threadId)
      this.clearApprovals(threadId)
      controller?.abort(new Error('cancelled'))
      this.publish()
      return { requested: !!controller }
    }
    const thread = this.threads.get(threadId)
    let turn = thread?.turns?.findLast((entry) => entry.status === 'inProgress')
    if (!turn && this.running.has(threadId)) {
      const fresh = await this.resume(sessionId, threadId)
      turn = fresh.turns?.findLast((entry) => entry.status === 'inProgress')
      if (!turn && fresh.status?.type === 'active') throw new CodexError('turn-unknown', '运行中的轮次尚未同步，请刷新后再停止', 409)
    }
    this.clearApprovals(threadId)
    const bridge = this.bridgeBindings.get(binding.bridgeScope || binding.id)
    if (bridge) this.bridge?.abort(bridge.bindingId)
    if (turn) await this.rpc().request('turn/interrupt', { threadId, turnId: turn.id })
    // Wait for turn/completed to clear running, rather than treating the RPC ack as completion.
    this.publish()
    return { requested: !!turn }
  }

  async login(input) {
    if (input.type === 'chatgptDeviceCode') return this.rpc().request('account/login/start', { type: 'chatgptDeviceCode' })
    if (input.type === 'apiKey') {
      requireString(input.apiKey, 'API key', 4096)
      this.nativeSecrets.add(input.apiKey)
      const result = await this.rpc().request('account/login/start', { type: 'apiKey', apiKey: input.apiKey })
      await this.refreshAccount()
      await this.refreshModels()
      this.publish()
      return result
    }
    throw new CodexError('login-type', '不支持的登录方式')
  }

  async dispose() {
    this.disposed = true
    this.revokeAccess()
    this.bridge?.abort()
    for (const check of this.modelChecks.values()) check.controller.abort(new Error('cancelled'))
    for (const check of this.environmentChecks.values()) check.controller.abort(new Error('cancelled'))
    for (const binding of this.bindings.values()) if (binding.source === 'custom') this.clearApprovals(binding.id)
    for (const controller of this.customControllers.values()) controller.abort(new Error('cancelled'))
    for (const binding of this.bindings.values()) {
      if (binding.source === 'custom') continue
      this.clearApprovals(binding.id)
      const turn = this.threads.get(binding.id)?.turns?.findLast((entry) => entry.status === 'inProgress')
      if (turn && this.transport && !this.transport.closed) {
        try { await this.transport.request('turn/interrupt', { threadId: binding.id, turnId: turn.id }, 2000) } catch { /* Stop the process below. */ }
      }
    }
    this.transport?.stop()
    await this.bridgeOpening?.catch(() => {})
    await this.bridge?.dispose()
    this.bridgeBindings.clear()
    this.loadedThreads.clear()
    await Promise.allSettled([...this.resumingThreads.values()])
    await Promise.allSettled([...this.customOperations])
    await Promise.allSettled([...this.modelChecks.values()].map((check) => check.completion))
    await Promise.allSettled([...this.environmentChecks.values()].map((check) => check.completion))
    this.listeners.clear()
  }
}
