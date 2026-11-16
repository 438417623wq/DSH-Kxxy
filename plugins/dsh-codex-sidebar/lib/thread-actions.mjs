import { randomUUID, createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { CodexError } from './transport.mjs'
import { modelRevision } from './custom-models.mjs'
import { conversationMessages, validateMessages, MAX_HISTORY_BYTES } from './custom-chat.mjs'

function identifier(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new CodexError('action-input', `${label}不正确`)
  return value
}

async function nativeHistory(service, binding) {
  const rpc = service.rpc()
  const generation = service.transportGeneration
  const stored = await rpc.request('thread/read', { threadId: binding.id, includeTurns: false })
  if (stored.thread?.id !== binding.id || await realpath(stored.thread.cwd) !== binding.cwd) throw new CodexError('thread-invalid', '原会话工作区不匹配', 403)
  const turns = [], seen = new Set()
  let cursor = null
  for (let page = 0; page < 10; page += 1) {
    const result = await rpc.request('thread/turns/list', { threadId: binding.id, limit: 20, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) })
    for (const turn of result.data ?? []) {
      if (!turn?.id || seen.has(turn.id)) throw new CodexError('history-invalid', '会话历史轮次标识不正确', 502)
      turns.push(turn); seen.add(turn.id)
    }
    if (turns.length > 100 || Buffer.byteLength(JSON.stringify(turns)) > MAX_HISTORY_BYTES) throw new CodexError('action-history-limit', '此会话过长，不能安全创建编辑分支', 413)
    if (!result.nextCursor) {
      if (generation !== service.transportGeneration || rpc.closed || rpc !== service.transport) throw new CodexError('not-connected', '读取分支历史时连接已改变，请重新操作', 503)
      return turns.reverse()
    }
    if (result.nextCursor === cursor) throw new CodexError('history-pagination', '会话历史分页异常', 502)
    cursor = result.nextCursor
  }
  throw new CodexError('action-history-limit', '会话历史未完整加载，不能创建分支', 413)
}

function selectTurn(turns, input, kind) {
  const index = turns.findIndex((turn) => turn.id === input.turnId)
  if (index < 0) throw new CodexError('turn-missing', '所选消息轮次不存在，请刷新后重试', 404)
  const turn = turns[index]
  if (turn.status === 'inProgress') throw new CodexError('busy', '不能修改正在生成的消息', 409)
  const users = (turn.items ?? []).filter((item) => item.type === 'userMessage')
  const item = input.itemId ? users.find((value) => value.id === input.itemId) : users.length === 1 ? users[0] : null
  if (!item) throw new CodexError('message-missing', '无法唯一定位该轮用户消息', 409)
  if (kind === 'retry' && turn.status !== 'completed') throw new CodexError('retry-incomplete', '此轮未完整结束，不能保证工具结果完整；请提出新修改要求', 409)
  if (turns.slice(0, index).some((entry) => entry.status !== 'completed')) throw new CodexError('action-history-incomplete', '此前包含未完成轮次，请从完整的会话记录创建新对话', 409)
  return { index, turn, item, prefix: turns.slice(0, index) }
}

function cloneTurns(turns) {
  return structuredClone(turns).map((turn) => ({ ...turn, id: randomUUID(), imported: true, items: (turn.items ?? []).map((item) => ({ ...item, id: randomUUID() })) }))
}

function savedContext(item) {
  const original = (item.content ?? []).map((entry) => entry.text ?? '').join('\n')
  if (!item.providerText) return ''
  if (!item.providerText.startsWith(original)) throw new CodexError('context-unavailable', '该消息的引用文件快照无法验证，请重新引用文件', 409)
  return item.providerText.slice(original.length)
}

function retryContext(prefix, turn, item) {
  const messages = conversationMessages({ turns: prefix }, '').slice(0, -1)
  let current
  if (Array.isArray(turn.providerMessages)) {
    current = structuredClone(turn.providerMessages)
    // Completed tool outputs stay in context. The final answer being replaced does not.
    if (current.at(-1)?.role === 'assistant' && !current.at(-1)?.tool_calls?.length) current.pop()
  } else {
    const hasTools = (turn.items ?? []).some((entry) => ['workspaceTool', 'commandExecution', 'fileChange', 'mcpToolCall'].includes(entry.type))
    if (hasTools) throw new CodexError('retry-unavailable', '旧轮次缺少完整工具回传，不能安全重新回答', 409)
    current = [{ role: 'user', content: item.providerText ?? (item.content ?? []).map((entry) => entry.text ?? '').join('\n') }]
  }
  messages.push(...current)
  messages.push({ role: 'user', content: '请基于以上已完成的工具结果重新组织文字回答。当前没有提供工具，不得要求重新执行或假装进行了新的文件操作。' })
  validateMessages(messages)
  return messages
}

function replayIds(turns) {
  const itemIds = new Set(), callIds = new Set()
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 8) return
    if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return }
    if (['agentMessage', 'reasoning', 'function_call', 'custom_tool_call', 'message'].includes(value.type) && typeof value.id === 'string') itemIds.add(value.id)
    for (const key of ['call_id', 'callId', 'tool_call_id']) if (typeof value[key] === 'string') callIds.add(value[key])
    for (const [key, entry] of Object.entries(value)) if (['items', 'content', 'output', 'tool_calls', 'response'].includes(key)) visit(entry, depth + 1)
  }
  for (const turn of turns) visit(turn.items)
  return { itemIds: [...itemIds], callIds: [...callIds] }
}

async function nativeFork(service, source, prefix, reservation) {
  if (!prefix.length) return service.create(source.sessionId, { model: source.model, effort: source.effort, mode: 'agent', engine: 'native', approvalPolicy: 'untrusted' }, { reservation })
  const bridgeScope = randomUUID()
  const parameters = await service.nativeParameters(source.model, source.effort, source.mode, null, 'untrusted', bridgeScope)
  if (parameters.providerRevision !== source.providerRevision) throw new CodexError('model-change', '原生模型服务已改变，不能将旧历史发送到新服务', 409)
  const targetBridge = service.bridgeBindings.get(bridgeScope)
  try {
    if (targetBridge) {
      const sourceBridge = service.bridgeBindings.get(source.bridgeScope || source.id)
      if (!sourceBridge) throw new CodexError('bridge-replay-unavailable', '原会话的模型回放已失效，请新建空白对话', 409)
      const result = service.bridge.forkReplay(sourceBridge.bindingId, targetBridge.bindingId, replayIds(prefix))
      if (result.missing.itemIds.length || result.missing.callIds.length) throw new CodexError('bridge-replay-unavailable', '无法可靠映射原生历史的模型回放，请新建空白对话或重新引用上下文', 409)
    }
    const { effort, providerId, providerRevision, credentialRevision, source: origin, ...overrides } = parameters
    const generation = service.transportGeneration
    const result = await service.rpc().request('thread/fork', { ...overrides, threadId: source.id, lastTurnId: prefix.at(-1).id, cwd: source.cwd, excludeTurns: true })
    if (generation !== service.transportGeneration || service.transport?.closed) throw new CodexError('outcome-unknown', '创建分支后连接中断，不能自动重试', 409)
    const thread = service.sanitize(result.thread)
    if (!thread?.id || thread.id === source.id || await realpath(thread.cwd) !== source.cwd) throw new CodexError('thread-invalid', 'Codex 返回了不匹配的分支或工作区', 502)
    const binding = { id: thread.id, sessionId: source.sessionId, cwd: source.cwd, title: `${source.title || '对话'} · 编辑分支`, model: source.model, effort: source.effort || '', mode: 'agent', source: origin, engine: 'native', executionMode: 'app-process', permissionMode: 'app-process', approvalPolicy: 'untrusted', providerId, providerRevision, ...(targetBridge ? { bridgeScope } : {}), updatedAt: Date.now(), branchedFrom: source.id }
    // The UI can use known immutable prefix records without another unsafely broad history fork.
    thread.turns = service.sanitize(prefix.map((turn) => ({ ...turn, imported: true })))
    thread.status = { type: 'idle' }
    service.reservedThreads.set(thread.id, reservation)
    service.actionLocks.add(thread.id)
    service.bindings.set(thread.id, binding)
    service.threads.set(thread.id, thread)
    service.markLoaded(binding, credentialRevision)
    try { await service.save() } catch (error) {
      service.bindings.delete(thread.id); service.threads.delete(thread.id)
      service.reservedThreads.delete(thread.id); service.actionLocks.delete(thread.id)
      throw error
    }
    return { thread, binding }
  } catch (error) {
    if (targetBridge) { service.bridge.revoke(targetBridge.bindingId); service.bridgeBindings.delete(bridgeScope) }
    throw error
  }
}

/** Bound IDs and a persisted action ledger authorize branching, never caller-supplied history. */
export async function runMessageAction(service, sessionId, input, kind) {
  if (!['edit', 'retry'].includes(kind)) throw new CodexError('action-invalid', '不支持的消息操作')
  identifier(input.requestId, '请求标识', 100)
  identifier(input.turnId, '轮次标识')
  if (kind === 'edit' && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 64000)) throw new CodexError('action-input', '修改消息不能为空且不得超过长度上限')
  const source = await service.bound(sessionId, input.threadId)
  const cacheKey = `${source.id}:${input.requestId}`
  const fingerprint = createHash('sha256').update(JSON.stringify([kind, input.turnId, input.itemId ?? null, kind === 'edit' ? input.text : null])).digest('hex')
  const cached = service.messageActions.get(cacheKey)
  if (cached) {
    if (cached.fingerprint !== fingerprint) throw new CodexError('action-reused', '此请求标识已用于不同的消息操作', 409)
    return cached.operation
  }
  const prior = source.actionRecords?.find((entry) => entry.id === input.requestId)
  if (prior) {
    if (prior.kind !== kind || prior.turnId !== input.turnId || prior.fingerprint !== fingerprint) throw new CodexError('action-reused', '此请求标识已用于其他消息操作', 409)
    if (prior.createdThreadId && prior.acceptedTurnId) {
      const binding = service.bindings.get(prior.createdThreadId)
      if (binding && binding.sessionId === sessionId && binding.cwd === source.cwd) return service.sanitize({ thread: service.threads.get(binding.id) || { id: binding.id }, binding, turnId: prior.acceptedTurnId })
    }
    throw new CodexError('outcome-unknown', '此消息操作已提交，请在历史中确认分支；不会重复创建或执行', 409)
  }
  service.assertIdle(source)
  if (!service.threadCapabilities(source)[kind]) throw new CodexError(`${kind}-unsupported`, kind === 'retry' ? '原生 CLI 尚未验证无工具重新回答，请使用“提出修改”' : '当前会话不支持编辑分支', 409)
  service.actionLocks.add(source.id)
  const reservation = Symbol('message-action')
  const operation = (async () => {
    let record = null
    let targetId = null
    try {
      const provider = await service.validateBindingModel(source)
      const originalRevision = source.providerRevision
      const turns = source.source === 'custom' ? service.threads.get(source.id)?.turns : await nativeHistory(service, source)
      if (!Array.isArray(turns)) throw new CodexError('history-invalid', '消息历史尚未加载', 409)
      if (turns.some((turn) => turn.status === 'inProgress') || service.running.has(source.id)) throw new CodexError('busy', '原会话仍有执行中的任务', 409)
      await service.bound(sessionId, source.id)
      await service.validateBindingModel(source)
      if (source.providerRevision !== originalRevision) throw new CodexError('model-change', '模型服务已改变，请重新创建分支', 409)
      const selected = selectTurn(turns, input, kind)
      const suffix = source.source === 'custom' && kind === 'edit' ? savedContext(selected.item) : ''
      const retryMessages = kind === 'retry' ? retryContext(selected.prefix, selected.turn, selected.item) : null
      if (selected.prefix.length >= 99) throw new CodexError('action-history-limit', '分支历史已达到上限，请新建对话', 413)
      record = { id: input.requestId, fingerprint, kind, turnId: input.turnId, outcome: 'submitted', at: Date.now() }
      source.actionRecords ??= []
      source.actionRecords.push(record)
      if (source.actionRecords.length > 200) source.actionRecords.shift()
      await service.save()
      let created
      if (source.source === 'custom') {
        const current = service.customParameters(source.model, source.mode, source)
        if (modelRevision(current) !== modelRevision(provider)) throw new CodexError('model-change', '创建分支时模型配置已改变', 409)
        created = await service.createCustom(sessionId, { model: source.model, effort: source.effort, mode: kind === 'retry' ? 'chat' : source.mode }, { reservation })
        targetId = created.thread.id
        const live = service.bindings.get(created.binding.id)
        if (live.cwd !== source.cwd || live.providerRevision !== originalRevision) throw new CodexError('model-change', '创建分支期间模型服务或工作区改变，未发送历史', 409)
        live.branchedFrom = source.id
        live.branchTurnId = selected.turn.id
        if (source.readOnly && kind === 'edit') live.readOnly = true
        if (kind === 'retry') live.replyOnly = true
        else created.thread.turns = cloneTurns(selected.prefix)
        // A retry's complete provider context is stored privately on its new turn, never copied into the UI.
        await service.save()
      } else created = await nativeFork(service, source, selected.prefix, reservation)
      targetId = created.thread.id
      record.createdThreadId = created.thread.id
      await service.save()
      const binding = service.bindings.get(created.thread.id)
      await service.bound(sessionId, binding.id)
      if (binding.cwd !== source.cwd || binding.providerRevision !== originalRevision) throw new CodexError('model-change', '分支配置与原会话不一致，未发送历史', 409)
      if (kind === 'edit' && binding.source !== 'custom') {
        binding.branchedFrom = source.id
        binding.branchTurnId = selected.turn.id
      }
      const text = kind === 'edit' ? input.text : '重新回答上一轮（不重新执行工具）'
      const request = { threadId: binding.id, model: binding.model, effort: binding.effort, mode: binding.mode, engine: binding.engine, requestId: input.requestId, text, files: [] }
      const accepted = await service.send(sessionId, request, { reservation, contextSuffix: suffix, preparedMessages: retryMessages })
      record.acceptedTurnId = accepted.turnId
      record.outcome = 'accepted'
      await service.save()
      service.publish()
      return service.sanitize({ thread: service.threads.get(binding.id), binding, turnId: accepted.turnId })
    } catch (error) {
      if (record) { record.outcome = 'unknown'; await service.save().catch(() => {}) }
      throw error
    } finally {
      if (targetId && service.reservedThreads.get(targetId) === reservation) {
        service.reservedThreads.delete(targetId)
        service.actionLocks.delete(targetId)
      }
      service.actionLocks.delete(source.id)
      service.publish()
    }
  })()
  service.messageActions.set(cacheKey, { fingerprint, operation })
  if (service.messageActions.size > 200) service.messageActions.delete(service.messageActions.keys().next().value)
  return operation
}
