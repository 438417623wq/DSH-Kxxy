window.__ModuleLoader__.load({
  id: 'dsh-codex-sidebar',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef } = React
    const useLayoutEffect = React.useLayoutEffect || useEffect
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const models = new Map()
    const PREFIX = '/kxxy/codex'
    let nextDomId = 0

    function createModel(sessionId) {
      // UI state and completed Markdown stay in this session's memory, never in storage.
      let snapshot = { phase: 'loading', history: [], threads: [], approvals: [], models: [], customModels: [], health: { phase: 'disconnected' }, current: null, draft: '', draftVersion: 0, files: [], filesVersion: 0, modelForm: null, modelDiagnostics: {}, error: null, folds: {}, approvalBusy: {}, stopping: {}, connectionEpoch: 0 }
      const listeners = new Set()
      const markdownCache = new Map()
      const scrollPositions = new Map()
      let source = null
      let pending = null
      let reload = false
      let nonce = null
      let retained = 0
      let controller = null
      let refreshTimer = null
      const publish = (patch) => {
        if (Object.prototype.hasOwnProperty.call(patch, 'draft')) patch = { ...patch, draftVersion: (snapshot.draftVersion || 0) + 1 }
        if (Object.prototype.hasOwnProperty.call(patch, 'files')) patch = { ...patch, filesVersion: (snapshot.filesVersion || 0) + 1 }
        snapshot = { ...snapshot, ...patch }
        for (const listener of listeners) listener(snapshot)
      }
      // Coalesce SSE bursts, without delaying or synthesizing the actual answer text.
      const scheduleRefresh = () => {
        if (refreshTimer !== null) return
        refreshTimer = setTimeout(() => { refreshTimer = null; refresh() }, 80)
      }
      const refresh = async () => {
        if (pending) { reload = true; return pending }
        if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null }
        controller = new AbortController()
        pending = (async () => {
          try {
            const response = await fetch(`${PREFIX}/bootstrap?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin', signal: controller.signal, cache: 'no-store' })
            const data = await response.json()
            if (!response.ok) throw new Error(data.message || 'Codex 状态读取失败')
            nonce = data.nonce
            delete data.nonce
            publish({ ...data, phase: 'ready' })
          } catch (error) {
            if (error.name !== 'AbortError') publish({ phase: 'failed', error: error.message })
          } finally {
            pending = null
            controller = null
            if (reload) { reload = false; if (retained) scheduleRefresh() }
          }
        })()
        return pending
      }
      const post = async (path, body = {}) => {
        if (!nonce) await refresh()
        if (!nonce) throw new Error('缺少会话校验信息，请刷新后重试')
        if (path === '/connect' || path === '/refresh') publish({ connectionEpoch: snapshot.connectionEpoch + 1 })
        const response = await fetch(`${PREFIX}${path}`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-kxxy-nonce': nonce },
          body: JSON.stringify({ ...body, sessionId }),
        })
        let result
        try { result = await response.json() } catch { throw Object.assign(new Error('Codex 返回了无法读取的响应'), { status: response.status }) }
        if (!response.ok) {
          const error = Object.assign(new Error(result.message || 'Codex 请求失败'), { code: result.error || result.code, status: response.status, details: result.details })
          await refresh()
          throw error
        }
        await refresh()
        return result
      }
      return {
        get: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
        update: publish, refresh, post,
        setFold(key, open) { if (snapshot.folds[key] !== open) publish({ folds: { ...snapshot.folds, [key]: open } }) },
        scrollFor(key = 'new') { if (!scrollPositions.has(key)) scrollPositions.set(key, { follow: true, top: 0, revision: '', unseen: false }); return scrollPositions.get(key) },
        markdown(key, text, render) {
          const cached = markdownCache.get(key)
          if (cached?.text === text) return cached.node
          const node = render()
          markdownCache.delete(key)
          markdownCache.set(key, { text, node })
          if (markdownCache.size > 240) markdownCache.delete(markdownCache.keys().next().value)
          return node
        },
        retain() {
          retained += 1
          if (retained === 1) {
            refresh()
            source = new EventSource(`${PREFIX}/events?sessionId=${encodeURIComponent(sessionId)}`)
            source.addEventListener('change', scheduleRefresh)
            source.onopen = () => { publish({ disconnected: false, connectionEpoch: snapshot.connectionEpoch + 1 }); scheduleRefresh() }
            source.onerror = () => publish({ disconnected: true, connectionEpoch: snapshot.connectionEpoch + 1 })
          }
          return () => {
            retained -= 1
            if (!retained) { source?.close(); source = null; clearTimeout(refreshTimer); refreshTimer = null; controller?.abort() }
          }
        },
        dispose() { retained = 0; source?.close(); controller?.abort(); clearTimeout(refreshTimer); refreshTimer = null; markdownCache.clear(); scrollPositions.clear(); listeners.clear() },
      }
    }

    function useModel(model) {
      const [state, setState] = useState(model.get())
      useEffect(() => { setState(model.get()); const off = model.subscribe(setState); const release = model.retain(); return () => { off(); release() } }, [model])
      return state
    }

    function Button({ children, label, onClick, disabled, primary, ...props }) {
      return h('button', { type: 'button', className: `codex-button${primary ? ' codex-primary' : ''}`, 'aria-label': label, onClick, disabled, ...props }, children)
    }

    function Icon({ name, size = 18 }) {
      const paths = {
        spark: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z',
        plus: 'M12 5v14M5 12h14',
        folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z',
        settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
        history: 'M3 11a9 9 0 1 1 2.6 7M3 5v6h6m3-4v5l3 2',
        link: 'M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.8M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.8',
        check: 'm5 12 4 4L19 6',
        terminal: 'm5 7 5 5-5 5m8 0h6',
        arrow: 'M5 12h14m-6-6 6 6-6 6',
        up: 'M12 19V5m-6 6 6-6 6 6',
        shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6',
        chevron: 'm7 10 5 5 5-5',
        hand: 'M9 11V6a1.6 1.6 0 0 1 3.2 0v5m0-1.2a1.6 1.6 0 0 1 3.2 0V11m0-.8a1.6 1.6 0 0 1 3.2 0v5a5.6 5.6 0 0 1-5.6 5.6h-2.4a4 4 0 0 1-2.9-1.2l-3-3a1.6 1.6 0 0 1 2.3-2.3L9.2 16',
        alert: 'M12 3.4a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2ZM12 8v4.6M12 15.7h.01',
        file: 'M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Zm0 0v6h6',
        stop: 'M8.5 8.5h7v7h-7z',
        close: 'M6 6l12 12M18 6 6 18',
        code: 'm9 8-4 4 4 4m6-8 4 4-4 4',
        copy: 'M9 9h11v12H9ZM15 6V3H3v12h3',
        edit: 'm15 4 5 5M4 20l4-1L21 6l-4-4L4 15ZM4 20h16',
        retry: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2',
      }
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false }, h('path', { d: paths[name] || paths.spark }))
    }

    const statusLabel = (status) => ({ inProgress: '进行中', completed: '已完成', failed: '失败', declined: '已拒绝', interrupted: '已停止', pending: '待确认', awaitingApproval: '待确认' })[status] || status || '处理中'
    const EFFORT_LABELS = { none: '无', minimal: '极少', low: '低', medium: '中', high: '高', xhigh: '极高' }
    const effortLabel = (effort) => EFFORT_LABELS[effort] || effort || ''
    const changeLabel = (kind) => ({ add: '新增', create: '新增', update: '修改', delete: '删除', remove: '删除' })[kind] || '修改'
    const closePopup = (event) => {
      const node = event.currentTarget?.closest?.('details')
      if (node) { node.open = false; node.querySelector('summary')?.focus() }
    }
    const nativeModel = (entry) => entry?.engine === 'native' || ['native', 'native-custom'].includes(entry?.source)
    const apiFormatLabel = (format) => ({ 'chat-completions': 'Chat Completions', responses: 'Responses', 'anthropic-messages': 'Anthropic Messages' })[format] || '官方服务'
    const modelEngineLabel = (entry) => `${nativeModel(entry) ? 'Codex CLI' : '工作区助手'} · ${apiFormatLabel(entry.apiFormat)}${nativeModel(entry) && entry.apiFormat && entry.apiFormat !== 'responses' ? ' · 本机兼容桥' : ''}`
    const reasoningValues = (entry) => [...new Set((entry?.supportedReasoningEfforts || entry?.reasoningEfforts || []).map((value) => typeof value === 'string' ? value : value.reasoningEffort).filter(Boolean))]
    const defaultEffort = (entry) => { const values = reasoningValues(entry); const value = entry?.defaultReasoningEffort ?? entry?.reasoningEffort; return values.includes(value) ? value : values[0] || '' }
    const diagnosticKey = (entry) => `${entry.id}:${entry.configVersion || entry.revision || JSON.stringify([entry.model, entry.baseUrl, entry.apiFormat, entry.engine, entry.authType, entry.profile, entry.compat, entry.reasoningEfforts, entry.reasoningEffort, entry.maxOutputTokens, entry.thinkingBudget, entry.headerNames, entry.queryNames])}`
    const checkLabel = (value) => ({ text: '文本回复', stream: '流式回复', tools: '工具协议', 'native-environment': '本机 CLI 环境', 'native-tools': '原生 CLI 工具' })[value] || value
    const checkStatusLabel = (value) => ({ passed: '通过', failed: '失败', unsupported: '不支持', untested: '未测试' })[value] || '未测试'
    const diagnosticFailure = (error, check) => ({ ok: false, check, checkedAt: new Date().toISOString(), message: error.message, code: error.code, status: error.status, upstreamStatus: error.details?.upstreamStatus, details: error.details, checks: Array.isArray(error.details?.checks) ? error.details.checks : [{ id: check, status: 'failed', message: error.message, code: error.code, upstreamStatus: error.details?.upstreamStatus }] })
    const modelDiagnostic = (entry, diagnostics) => {
      const local = diagnostics[diagnosticKey(entry)]
      const remote = entry.diagnostic
      if (!local) return remote
      if (!remote) return local
      return new Date(remote.checkedAt).getTime() > new Date(local.checkedAt).getTime() ? remote : local
    }
    const focusElement = (node) => { if (node) { try { node.focus({ preventScroll: true }) } catch { node.focus() } } }

    function diffStats(diff) {
      let added = 0
      let removed = 0
      for (const line of String(diff || '').split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue
        if (line.startsWith('+')) added += 1
        else if (line.startsWith('-')) removed += 1
      }
      return { added, removed }
    }

    function Diff({ text }) {
      const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
      return h('pre', { className: 'codex-diff' }, ...lines.map((line, index) => {
        const tone = /^(\+\+\+|---|diff |index |new file|deleted file)/.test(line) ? 'meta'
          : line.startsWith('@@') ? 'hunk'
            : line.startsWith('+') ? 'add'
              : line.startsWith('-') ? 'del' : 'plain'
        return h('span', { key: `line-${index}`, className: 'codex-diff-line', 'data-tone': tone }, line || ' ')
      }))
    }

    function DiffStat({ diff }) {
      const { added, removed } = diffStats(diff)
      if (!added && !removed) return null
      return h('span', { className: 'codex-diff-stat' }, added > 0 && h('span', { className: 'codex-add' }, `+${added}`), removed > 0 && h('span', { className: 'codex-del' }, `−${removed}`))
    }

    // 统一的下拉面板：点外部或按 Esc 关闭，和 VS Code 里 Codex 的菜单行为一致。
    function Popup({ className = '', label, summary, disabled, panelLabel, panelRole = 'menu', align = 'start', children }) {
      const ref = useRef(null)
      const panel = useRef(null)
      const id = useRef(`codex-popup-${++nextDomId}`)
      const expanded = useRef(false)
      const disabledRef = useRef(disabled)
      disabledRef.current = disabled
      const [open, setOpen] = useState(false)
      const position = () => {
        const node = ref.current
        if (!node?.open || !panel.current) return
        const bounds = node.closest('.codex-sidebar').getBoundingClientRect()
        const anchor = node.getBoundingClientRect()
        const width = Math.min(328, bounds.width - 24, window.innerWidth - 24)
        const left = Math.max(bounds.left + 12, Math.min(align === 'end' ? anchor.right - width : anchor.left, bounds.right - width - 12))
        panel.current.style.width = `${Math.max(180, width)}px`
        panel.current.style.left = `${left - anchor.left}px`
        panel.current.style.right = 'auto'
        panel.current.style.maxHeight = `${Math.max(100, Math.min(430, anchor.top - Math.max(bounds.top, 0) - 12))}px`
      }
      const changeOpen = (value, focus = false, restore = false) => {
        const node = ref.current
        if (!node) return
        const next = !!value && !disabledRef.current
        expanded.current = next
        node.open = next
        setOpen(next)
        const trigger = node.querySelector('summary')
        trigger?.setAttribute('aria-expanded', String(next))
        if (next) {
          position()
          if (focus) focusElement(panel.current?.querySelector('[data-popup-autofocus], [aria-checked="true"]') || panel.current?.querySelector('button:not(:disabled)'))
        } else if (restore) focusElement(trigger)
      }
      useEffect(() => {
        const outside = (event) => { const node = ref.current; if (node?.open && !node.contains(event.target)) changeOpen(false) }
        const escape = (event) => { const node = ref.current; if (node?.open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); changeOpen(false, false, true) } }
        document.addEventListener('pointerdown', outside, true)
        document.addEventListener('keydown', escape)
        window.addEventListener('resize', position)
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(position) : null
        if (ref.current) observer?.observe(ref.current.closest('.codex-sidebar'))
        return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); window.removeEventListener('resize', position); observer?.disconnect() }
      }, [])
      useEffect(() => { if (disabled) changeOpen(false) }, [disabled])
      const navigate = (event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) && event.key !== 'ArrowDown') return
        const options = [...panel.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')]
        if (!options.length) return
        const index = options.indexOf(document.activeElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowDown' ? (index + 1) % options.length : (index - 1 + options.length) % options.length
        event.preventDefault()
        focusElement(options[next])
      }
      return h('details', { className: `codex-popup codex-popup-${align} ${className}`, ref, onToggle: () => {
        const value = !!ref.current?.open && !disabledRef.current
        // Native/queued toggle events must not toggle twice or steal focus after a click.
        if (expanded.current !== value || ref.current?.open !== value) changeOpen(value)
      }, onBlur: (event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) changeOpen(false) } },
        h('summary', { role: 'button', 'aria-label': label, 'aria-expanded': open, 'aria-controls': id.current, 'aria-haspopup': panelRole, 'aria-disabled': disabled || undefined,
          onClick: (event) => { event.preventDefault(); if (!disabledRef.current) changeOpen(!ref.current?.open, true) },
          onKeyDown: (event) => {
            if (!['Enter', ' ', 'ArrowDown'].includes(event.key)) return
            event.preventDefault()
            if (!disabledRef.current && !event.repeat) changeOpen(event.key === 'ArrowDown' || !ref.current?.open, true)
          },
        }, summary),
        h('div', { id: id.current, ref: panel, className: 'codex-popup-panel', role: panelRole, 'aria-label': panelLabel || label, onKeyDown: navigate }, children))
    }

    function markdownInline(value, prefix = 'inline', depth = 0) {
      const text = String(value || '')
      if (depth > 2) return text
      const tokens = /(`[^`\n]+`|\*\*[^\n]+?\*\*|__[^\n]+?__|\*[^*\n]+\*|\[[^\]\n]{1,300}\]\([^\s)]{1,2048}\))/g
      const children = []
      let position = 0
      let match
      while ((match = tokens.exec(text))) {
        if (match.index > position) children.push(text.slice(position, match.index))
        const token = match[0]
        const key = `${prefix}-${match.index}`
        if (token.startsWith('`')) children.push(h('code', { key }, token.slice(1, -1)))
        else if (token.startsWith('**') || token.startsWith('__')) children.push(h('strong', { key }, markdownInline(token.slice(2, -2), key, depth + 1)))
        else if (token.startsWith('*')) children.push(h('em', { key }, markdownInline(token.slice(1, -1), key, depth + 1)))
        else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          let url
          try { const parsed = new URL(link[2]); if (['http:', 'https:'].includes(parsed.protocol)) url = parsed.href } catch {}
          children.push(url ? h('a', { key, href: url, target: '_blank', rel: 'noopener noreferrer' }, link[1]) : token)
        }
        position = tokens.lastIndex
      }
      if (position < text.length) children.push(text.slice(position))
      return children
    }

    const uiKey = (...parts) => JSON.stringify(parts)
    const userText = (item) => typeof item.text === 'string' ? item.text : (item.content || []).map((content) => content.text || '').join('\n')
    const assistantText = (turn) => (turn.items || []).filter((item) => item.type === 'agentMessage').map((item) => item.text || '').filter(Boolean).join('\n\n')
    const longText = (text) => String(text || '').length > 1800 || String(text || '').split('\n').length > 24
    const itemAttention = (item) => item.type === 'error' || !!item.error || ['error', 'failed', 'declined', 'interrupted', 'awaitingApproval'].includes(item.status)
    const printable = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) || ''
    const timeLabel = (value) => { if (value === undefined || value === null || value === '') return '未记录'; const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value); return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString() }
    function turnMetadata(thread, turn) {
      const recorded = !!turn.metadata
      const values = turn.metadata || thread.binding || thread
      return { recorded, model: values.modelLabel || values.model || '未记录', effort: values.effort ? effortLabel(values.effort) : '未记录', engine: values.engine || '未记录', source: turn.metadata?.source || thread.binding?.source || thread.source || '未记录', startedAt: timeLabel(turn.metadata?.startedAt), completedAt: timeLabel(turn.metadata?.completedAt) }
    }
    // Only adjacent process items are grouped. A message/error always ends the group.
    function turnSegments(turn) {
      const segments = []
      for (const [index, item] of (turn.items || []).entries()) {
        const key = item.id || `item-${index}`
        const process = !['userMessage', 'agentMessage'].includes(item.type) && !itemAttention(item)
        const previous = segments[segments.length - 1]
        if (process && previous?.process) previous.items.push({ item, key })
        else segments.push({ key, process, items: [{ item, key }] })
      }
      return segments
    }
    function Fold({ model, foldKey, summary, children, defaultOpen = false, className = 'codex-fold' }) {
      const [expanded, setExpanded] = useState(() => model?.get().folds[foldKey] ?? defaultOpen)
      useEffect(() => {
        const sync = () => setExpanded(model?.get().folds[foldKey] ?? defaultOpen)
        sync()
        return model?.subscribe(sync)
      }, [model, foldKey, defaultOpen])
      return h('details', { className, open: expanded, 'data-fold-key': foldKey, onToggle: (event) => {
        const open = event.currentTarget.open
        // Mount/controlled toggle events must not overwrite a user's remembered choice.
        if (open === expanded) return
        setExpanded(open)
        model?.setFold(foldKey, open)
      } }, h('summary', null, summary), expanded ? children : null)
    }
    async function copyText(text) {
      try { if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return } } catch {}
      const previous = document.activeElement
      const input = document.createElement('textarea')
      input.value = text
      input.setAttribute('aria-label', '复制原文')
      input.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0'
      document.body.append(input)
      let copied = false
      try { input.select(); copied = document.execCommand?.('copy') === true } finally { input.remove(); focusElement(previous) }
      if (!copied) throw new Error('自动复制失败，请在下方选择原文后手动复制。')
    }
    function CopyButton({ text, label = '复制原文' }) {
      const [feedback, setFeedback] = useState('')
      const copy = async () => { try { await copyText(text); setFeedback('已复制') } catch { setFeedback('自动复制失败，请选择原文手动复制。') } }
      return h('span', { className: 'codex-copy-control' }, h(Button, { label, onClick: copy }, h(Icon, { name: feedback === '已复制' ? 'check' : 'copy', size: 13 }), feedback === '已复制' ? '已复制' : label),
        feedback && h('span', { className: feedback === '已复制' ? 'codex-sr-only' : 'codex-copy-error', role: 'status' }, feedback),
        feedback && feedback !== '已复制' && h('textarea', { className: 'codex-copy-fallback', 'aria-label': '手动复制原文', readOnly: true, value: text, onFocus: (event) => event.currentTarget.select() }))
    }
    function CodeBlock({ language, text, model, foldKey }) {
      return h('div', { className: 'codex-code-block' },
        h('div', { className: 'codex-code-head' }, h('span', { className: 'codex-code-language' }, language || 'code'), h(CopyButton, { text, label: '复制代码' })),
        h(Fold, { model, foldKey, defaultOpen: text.length < 1200 && text.split('\n').length <= 18, summary: `代码 · ${text.split('\n').length} 行` }, h('pre', null, h('code', null, text))))
    }
    function LogBlock({ text, model, foldKey, label = '输出', error = false }) {
      return h(Fold, { model, foldKey, defaultOpen: error || !longText(text), className: `codex-fold${error ? ' codex-tool-error' : ''}`, summary: `${label} · ${String(text || '').split('\n').length} 行` }, h('pre', { className: 'codex-tool-output' }, text))
    }
    function Markdown({ text, model, foldKey, completed = false }) {
      const render = () => renderMarkdown({ text, model, foldKey })
      return completed && model ? model.markdown(foldKey, text, render) : render()
    }
    function renderMarkdown({ text, model, foldKey }) {
      const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      const isBlock = (line) => /^\s*(?:`{3,}|~{3,}|#{1,6}\s|>\s?|[-+*]\s+|\d+[.)]\s+|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line)
      for (let index = 0; index < lines.length;) {
        const key = `block-${index}`
        const line = lines[index]
        if (!line.trim()) { index += 1; continue }
        const fence = /^\s*(`{3,}|~{3,})([^\s]*)\s*$/.exec(line)
        if (fence) {
          const content = []
          const closeFence = new RegExp(`^\\s*${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`)
          index += 1
          while (index < lines.length && !closeFence.test(lines[index])) content.push(lines[index++])
          if (index < lines.length) index += 1
          blocks.push(h(CodeBlock, { key, language: fence[2], text: content.join('\n'), model, foldKey: uiKey(foldKey, key) }))
          continue
        }
        const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
        if (heading) { blocks.push(h(`h${Math.max(3, heading[1].length)}`, { key }, markdownInline(heading[2], key))); index += 1; continue }
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push(h('hr', { key })); index += 1; continue }
        const list = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(line)
        if (list) {
          const ordered = /^\d/.test(list[1])
          const items = []
          while (index < lines.length) {
            const item = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(lines[index])
            if (!item || /^\d/.test(item[1]) !== ordered) break
            items.push(h('li', { key: `${key}-${index}` }, markdownInline(item[2], `${key}-${index}`)))
            index += 1
          }
          blocks.push(h(ordered ? 'ol' : 'ul', { key, ...(ordered ? { start: parseInt(list[1], 10) } : {}) }, items))
          continue
        }
        if (/^\s*>/.test(line)) {
          const quoted = []
          while (index < lines.length && /^\s*>/.test(lines[index])) quoted.push(lines[index++].replace(/^\s*>\s?/, ''))
          blocks.push(h('blockquote', { key }, markdownInline(quoted.join('\n'), key)))
          continue
        }
        const paragraph = [line]
        index += 1
        while (index < lines.length && lines[index].trim() && !isBlock(lines[index])) paragraph.push(lines[index++])
        blocks.push(h('p', { key }, markdownInline(paragraph.join('\n'), key)))
      }
      return h('div', { className: 'codex-message codex-markdown' }, blocks)
    }

    function EnvironmentCheck({ result, resultRef }) {
      if (!result) return null
      return h('section', { ref: resultRef, className: 'codex-environment-check', 'aria-label': '开发环境检查结果', role: 'status' },
        h('div', { className: 'codex-environment-check-heading' }, h(Icon, { name: 'terminal', size: 16 }), h('strong', null, '开发环境检查'), h('span', { className: `codex-chip${result.ok ? ' codex-chip-success' : ''}` }, result.ok ? '检查通过' : '查看检查结果')),
        result.environment?.cwd && h('code', { className: 'codex-check-path' }, result.environment.cwd),
        h('ul', { className: 'codex-environment-checks' }, ...(result.checks || []).map((check, index) => h('li', { key: check.id || index, 'data-status': check.status }, h('span', { className: 'codex-check-indicator', 'aria-hidden': true }, ['ok', 'passed', 'available', 'success'].includes(check.status) ? '✓' : '·'), h('div', null, h('strong', null, check.label || check.id), check.detail && h('span', null, check.detail))))),
        h('p', { className: 'codex-muted' }, '检查直接使用当前工作区和应用开发环境。模型能否调用工具，还取决于所选模式及模型服务。'))
    }

    function ToolRow({ tone, icon, label, detail, status, children, open, model, foldKey }) {
      return h(Fold, { model, foldKey, className: `codex-tool codex-tool-${tone}`, defaultOpen: !!open,
        summary: [h('span', { key: 'dot', className: 'codex-status-dot', 'data-status': status, 'aria-hidden': true }), icon && h(Icon, { key: 'icon', name: icon, size: 14 }), h('span', { key: 'label', className: 'codex-tool-label' }, label), detail && h('code', { key: 'detail', className: 'codex-tool-detail' }, detail), h('span', { key: 'status', className: 'codex-muted' }, statusLabel(status))],
      }, children)
    }
    function Message({ item, model, foldKey, completed, onEdit, editDisabled, editReason }) {
      const markdown = (text, suffix = 'text') => h(Markdown, { text, model, foldKey: uiKey(foldKey, suffix), completed })
      const log = (value, suffix, label, error = false) => h(LogBlock, { text: printable(value), model, foldKey: uiKey(foldKey, suffix), label, error })
      const row = { model, foldKey: uiKey(foldKey, 'item'), status: item.status || (completed ? 'completed' : 'inProgress'), open: itemAttention(item) }
      if (item.type === 'userMessage' || item.type === 'agentMessage') {
        const user = item.type === 'userMessage'
        const text = user ? userText(item) : item.text || ''
        const body = user ? h('div', { className: 'codex-user-text' }, text) : markdown(text)
        return h('section', { className: user ? 'codex-user' : 'codex-assistant', 'data-item-id': item.id },
          h('div', { className: 'codex-message-label' }, user ? '你' : '助手'),
          longText(text) ? h(Fold, { model, foldKey: uiKey(foldKey, 'body'), defaultOpen: !completed, className: 'codex-fold codex-body-fold', summary: '长正文 · 展开 / 收起' }, body) : body,
          user && h('div', { className: 'codex-message-actions' }, h(CopyButton, { text, label: '复制原文' }), h(Button, { label: '修改并重发', disabled: editDisabled, title: editReason, onClick: () => onEdit(item) }, h(Icon, { name: 'edit', size: 13 }), '修改并重发')))
      }
      if (item.type === 'reasoning') return h(ToolRow, { ...row, tone: 'reasoning', icon: 'spark', label: '思考摘要' }, markdown(item.text || (item.summary || []).map((entry) => typeof entry === 'string' ? entry : entry.text || '').join('\n')))
      if (item.type === 'workspaceTool') return h(ToolRow, { ...row, tone: 'workspace', icon: 'folder', label: ({ list_files: '查看文件', read_file: '读取文件', search_files: '搜索文件', get_environment: '查看环境', list_directory: '浏览目录', search: '搜索工作区' })[item.name] || item.name || '工作区操作' },
        item.arguments && log(item.arguments, 'arguments', '参数'), item.result !== undefined && log(item.result, 'result', '结果', itemAttention(item)), item.error && log(item.error, 'error', '错误', true))
      if (item.type === 'fileChange') {
        const changes = item.changes || []
        return h(ToolRow, { ...row, tone: 'file', icon: 'file', label: `文件变更 · ${changes.length} 个` },
          ...changes.map((change, index) => h(Fold, { key: `${change.path}-${index}`, model, foldKey: uiKey(foldKey, 'file', change.path, index), className: 'codex-change', summary: [h('span', { key: 'path', className: 'codex-change-path' }, change.path), h(DiffStat, { key: 'stats', diff: change.diff }), h('span', { key: 'kind', className: 'codex-chip' }, changeLabel(change.kind))] }, change.diff ? h(Diff, { text: change.diff }) : h('p', null, '未记录差异'))),
          item.aggregatedOutput && log(item.aggregatedOutput, 'output', '变更输出'), item.error && log(item.error, 'error', '错误', true))
      }
      if (item.type === 'commandExecution') return h(ToolRow, { ...row, tone: 'command', icon: 'terminal', label: String(item.command || '命令').split('\n')[0].slice(0, 80) },
        h('div', { className: 'codex-tool-meta' }, item.exitCode !== null && item.exitCode !== undefined && h('span', { className: `codex-chip${item.exitCode === 0 ? ' codex-chip-success' : ' codex-chip-danger'}` }, `exit ${item.exitCode}`), item.outputTruncated && h('span', null, '输出已截断')),
        h('pre', { className: 'codex-command' }, `$ ${item.command}`), log(item.aggregatedOutput || '暂无输出', 'output', '命令输出', itemAttention(item)), item.error && log(item.error, 'error', '错误', true))
      if (item.type === 'plan') return h(ToolRow, { ...row, tone: 'plan', icon: 'check', label: '计划' }, item.text && markdown(item.text), item.explanation && h('p', { className: 'codex-muted' }, item.explanation),
        h('ol', { className: 'codex-plan-list' }, ...(item.plan || item.steps || []).map((step, index) => h('li', { key: index, 'data-status': step.status }, h('span', null, step.step || step.text || step.description || ''), h('span', { className: 'codex-muted' }, statusLabel(step.status))))))
      if (item.type === 'mcpToolCall') return h(ToolRow, { ...row, tone: 'mcp', icon: 'link', label: `${item.server || 'MCP'} · ${item.tool || '工具'}` }, item.arguments && log(item.arguments, 'arguments', '参数'), item.result !== undefined && log(item.result, 'result', '结果'), item.error && log(item.error, 'error', '错误', true))
      return h(ToolRow, { ...row, tone: 'other', icon: 'code', label: item.type || '操作' }, log(item, 'raw', '记录', itemAttention(item)))
    }
    function TurnView({ thread, turn, model, disabled, disabledReason, onEdit, onRetry, onRevise, onUndo }) {
      const base = uiKey(thread.id, turn.id)
      const completed = turn.status !== 'inProgress'
      const caps = thread.capabilities || {}
      const answer = assistantText(turn)
      const metadata = turnMetadata(thread, turn)
      const editReason = disabledReason || (!completed ? '本轮仍在运行' : !caps.edit ? '此会话未提供修改重发能力' : '')
      const retryReason = disabledReason || (!completed ? '本轮仍在运行' : !caps.retry ? caps.retryReason || '此后端不支持安全重答' : '')
      const undoReason = disabledReason || (!completed ? '本轮仍在运行' : !caps.undo || !turn.undo?.available ? turn.undo?.reason || caps.undoReason || '本轮没有可用文件快照，不能撤销' : '')
      return h('article', { className: 'codex-turn', 'data-turn-id': turn.id },
        ...turnSegments(turn).map((segment) => {
          const messages = segment.items.map(({ item, key }) => h('div', { key, 'data-message-key': uiKey(base, key) }, itemAttention(item) && h('div', { className: 'codex-item-alert', role: 'status' }, `${statusLabel(item.status)}${item.error ? ` · ${printable(item.error)}` : ''}`), h(Message, { item, model, foldKey: uiKey(base, key), completed: completed || item.status === 'completed', editDisabled: disabled || !completed || !caps.edit, editReason, onEdit: (item) => onEdit(turn, item) })))
          return segment.process ? h(Fold, { key: segment.key, model, foldKey: uiKey(base, segment.key, 'process'), className: 'codex-fold codex-process', summary: `过程 · ${segment.items.length} 项 · ${segment.items.some(({ item }) => item.status === 'inProgress') ? '进行中' : '查看工具与思考摘要'}` }, messages) : h('div', { key: segment.key }, messages)
        }),
        turn.error && h('div', { className: 'codex-error', role: 'alert' }, turn.error.message || printable(turn.error)),
        h('div', { className: 'codex-turn-status', role: completed ? undefined : 'status' }, statusLabel(turn.status)),
        answer && h('div', { className: 'codex-message-actions', 'aria-label': '本轮回复操作' }, h(CopyButton, { text: answer, label: '复制本轮回复' }), h(Button, { label: '提出修改', onClick: () => onRevise(turn) }, h(Icon, { name: 'edit', size: 13 }), '提出修改'), h(Button, { label: '重新回答', disabled: disabled || !completed || !caps.retry, title: retryReason, onClick: () => onRetry(turn) }, h(Icon, { name: 'retry', size: 13 }), '重新回答')),
        h(Fold, { model, foldKey: uiKey(base, 'details'), className: 'codex-fold codex-turn-details', summary: '详情 · 模型 / 时间 / 文件变更' },
          !metadata.recorded && h('p', { className: 'codex-muted' }, '本轮元数据未记录；以下仅为已知会话绑定，不代表本轮实际配置。'),
          h('dl', { className: 'codex-metadata' }, h('dt', null, '模型'), h('dd', null, metadata.model), h('dt', null, '强度'), h('dd', null, metadata.effort), h('dt', null, '执行器'), h('dd', null, metadata.engine), h('dt', null, '来源'), h('dd', null, metadata.source), h('dt', null, '开始'), h('dd', null, metadata.startedAt), h('dt', null, '结束'), h('dd', null, metadata.completedAt)),
          retryReason && h('p', { className: 'codex-muted' }, `重答不可用：${retryReason}`),
          turn.plan?.length > 0 && h(Message, { model, foldKey: uiKey(base, 'plan-snapshot'), completed, item: { type: 'plan', plan: turn.plan, explanation: '本轮计划快照（未记录其时间位置）' } }),
          turn.diff && h(Fold, { model, foldKey: uiKey(base, 'diff'), summary: '本轮完整差异' }, h(Diff, { text: turn.diff })),
          h(Button, { disabled: disabled || !completed || !caps.undo || !turn.undo?.available, title: undoReason, onClick: () => onUndo(turn) }, '撤销本轮文件变更'),
          h('p', { className: 'codex-muted' }, undoReason || '先预览涉及文件，再确认撤销；不强行覆盖后续修改。')))
    }

    function formCompatDefaults(apiFormat) {
      return { systemRole: 'system', tokenField: 'max_tokens', parallelToolCalls: true, strictTools: false, store: apiFormat === 'responses', includeReasoning: apiFormat === 'responses', reasoningFormat: 'none' }
    }

    function modelPreset(profile, apiFormat = 'chat-completions') {
      const defaults = { compat: formCompatDefaults(apiFormat), reasoningEffortsText: '', reasoningEffort: '', maxOutputTokens: '', thinkingBudget: '' }
      if (profile === 'local') return { ...defaults, authType: 'none', compat: { ...defaults.compat, parallelToolCalls: false } }
      if (profile === 'deepseek') return { ...defaults, apiFormat: 'chat-completions', authType: 'bearer', compat: { ...formCompatDefaults('chat-completions'), includeReasoning: true, reasoningFormat: 'deepseek' }, reasoningEffortsText: 'none, high', reasoningEffort: 'high' }
      if (profile === 'anthropic') return { ...defaults, apiFormat: 'anthropic-messages', authType: 'x-api-key', compat: { ...formCompatDefaults('anthropic-messages'), includeReasoning: true, reasoningFormat: 'thinking' }, reasoningEffortsText: 'none, high', reasoningEffort: 'none', maxOutputTokens: 4096, thinkingBudget: 1024 }
      return { ...defaults, authType: apiFormat === 'anthropic-messages' ? 'x-api-key' : 'bearer' }
    }

    function emptyModelForm(entry = {}) {
      return { id: '', name: '', model: '', baseUrl: '', apiFormat: 'chat-completions', engine: 'workspace', hasApiKey: false, ...entry, apiKey: '', authType: entry.authType || (entry.apiFormat === 'anthropic-messages' ? 'x-api-key' : 'bearer'), authExplicit: !!entry.authType, profile: entry.profile || '', profileChanged: false, compat: { ...formCompatDefaults(entry.apiFormat || 'chat-completions'), ...(entry.compat || {}) }, headersJson: '', queryJson: '', reasoningEffortsText: reasoningValues(entry).join(', '), reasoningEffort: entry.reasoningEffort ?? entry.defaultReasoningEffort ?? '', maxOutputTokens: entry.maxOutputTokens ?? '', thinkingBudget: entry.thinkingBudget ?? '', advancedChanged: {}, dirty: false, revision: 0 }
    }

    function modelConfiguration(form, requireModel = true) {
      const fail = (message, field) => { throw Object.assign(new Error(message), { field }) }
      let url
      try { url = new URL(form.baseUrl.trim()) } catch { fail('请输入有效的 HTTP 或 HTTPS 服务地址。', 'baseUrl') }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(form.baseUrl)) fail('服务地址不能包含账号、密码、查询参数或片段；额外参数请在高级设置填写。', 'baseUrl')
      if (requireModel && !form.model.trim()) fail('请输入模型 ID。', 'model')
      if (form.authType !== 'none' && !form.apiKey.trim() && !form.hasApiKey) fail('此认证方式需要 API 密钥；无密钥服务请选择“无认证”。', 'apiKey')
      const input = { ...(form.id ? { id: form.id } : {}), baseUrl: form.baseUrl.trim(), apiKey: form.apiKey, apiFormat: form.apiFormat, engine: form.engine, authType: form.authType, model: form.model.trim() }
      if (form.profile) input.profile = form.profile
      if (Object.keys(form.compat).length || form.profileChanged) input.compat = { ...form.compat }
      for (const field of ['headers', 'query']) {
        const text = form[`${field}Json`].trim()
        if (!text) continue
        let value
        try { value = JSON.parse(text) } catch { fail(`${field === 'headers' ? '请求头' : '查询参数'} JSON 格式不正确。`, `${field}Json`) }
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field === 'headers' ? '请求头' : '查询参数'}必须是 JSON 对象，不能是数组、null 或单个值。`, `${field}Json`)
        input[field] = value
      }
      input.reasoningEfforts = [...new Set(form.reasoningEffortsText.split(/[,，\s]+/).filter(Boolean))]
      input.reasoningEffort = form.reasoningEffort.trim()
      if (input.reasoningEfforts.length > 16 || input.reasoningEfforts.some((value) => !/^[\da-z_-]{1,32}$/i.test(value))) fail('推理值最多 16 个，仅使用字母、数字、下划线或连字符，每项最多 32 字符。', 'reasoningEffortsText')
      if (input.reasoningEffort && !input.reasoningEfforts.includes(input.reasoningEffort)) fail('默认推理强度须包含在支持的推理值列表中。', 'reasoningEffortsText')
      for (const field of ['maxOutputTokens', 'thinkingBudget']) {
        const text = String(form[field]).trim()
        if (!text) { input[field] = null; continue }
        const value = Number(text)
        const minimum = field === 'thinkingBudget' ? 1024 : 1
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum || value > 1048576) fail(`${field === 'maxOutputTokens' ? '最大输出 token' : '思考预算'}须为 ${minimum}–1048576 的整数或留空。`, field)
        input[field] = value
      }
      if (input.thinkingBudget !== null && input.maxOutputTokens !== null && input.thinkingBudget >= input.maxOutputTokens) fail('思考预算须小于最大输出 token。', 'thinkingBudget')
      return input
    }

    function ModelDiagnostic({ result }) {
      if (!result) return null
      const date = new Date(result.checkedAt)
      const failed = !result.ok && !result.stale
      const checks = Array.isArray(result.checks) ? result.checks : []
      const detail = typeof result.details === 'string' ? result.details : result.details?.detail || result.details?.message || result.details?.hint
      return h('section', { className: `codex-model-feedback ${result.stale ? 'codex-feedback-neutral' : failed ? 'codex-feedback-error' : 'codex-feedback-success'}`, 'aria-label': '模型检查结果', role: failed ? 'alert' : 'status' },
        h('div', null, h(Icon, { name: result.stale ? 'history' : failed ? 'alert' : 'check', size: 15 }), h('strong', null, result.stale ? '配置已变更，请重新检查' : `${checkLabel(result.check || 'text')} · ${result.ok ? '检查通过' : '检查未通过'}`), Number.isFinite(result.latencyMs) && h('span', { className: 'codex-latency' }, `${result.latencyMs} ms`)),
        result.message && h('p', null, result.message),
        (result.code || result.status || result.upstreamStatus) && h('p', { className: 'codex-diagnostic-code' }, [result.code, result.status && `HTTP ${result.status}`, result.upstreamStatus && `上游 HTTP ${result.upstreamStatus}`].filter(Boolean).join(' · ')),
        checks.length > 0 && h('ul', { className: 'codex-model-checks' }, ...checks.map((check, index) => h('li', { key: `${check.id}-${index}`, 'data-status': check.status }, h('div', null, h('strong', null, checkLabel(check.id)), h('span', { className: 'codex-chip' }, checkStatusLabel(check.status))), check.message && h('p', null, check.message), (check.code || check.upstreamStatus) && h('code', null, [check.code, check.upstreamStatus && `上游 HTTP ${check.upstreamStatus}`].filter(Boolean).join(' · '))))),
        detail && h('p', null, typeof detail === 'string' ? detail : JSON.stringify(detail)),
        result.preview && h('details', { className: 'codex-diagnostic-preview' }, h('summary', null, '查看回复摘录'), h('p', null, result.preview)),
        !Number.isNaN(date.getTime()) && h('p', { className: 'codex-muted' }, `检查时间：${date.toLocaleString()}`),
        h('p', { className: 'codex-muted' }, '仅检查模型服务的 HTTP 能力，不代表原生 CLI 的文件、命令或 MCP 工具已验证。'))
    }

    function ModelSettings({ entries, disabled, onSave, onDelete, onUse, onFetch, onTest, form: savedForm, onForm, diagnostics, draftDiagnostic, check, onCheck, warnings }) {
      const form = savedForm || emptyModelForm()
      const [operation, setOperation] = useState('')
      const [status, setStatus] = useState('')
      const [formError, setFormError] = useState(null)
      const [fetchResult, setFetchResult] = useState(null)
      const [available, setAvailable] = useState([])
      const [query, setQuery] = useState('')
      const [confirmation, setConfirmation] = useState(null)
      const [focusField, setFocusField] = useState('')
      const formNode = useRef(null)
      const submitIntent = useRef('save')
      const locked = disabled || !!operation
      const ready = !!form.baseUrl.trim() && (form.authType === 'none' || !!form.apiKey.trim() || form.hasApiKey)
      const canSave = ready && !!form.model.trim() && !!form.name.trim()
      const setForm = (value) => onForm(typeof value === 'function' ? value(form) : value)
      const resetFeedback = () => { setStatus(''); setFormError(null); setFetchResult(null) }
      useEffect(() => {
        if (!focusField || !formNode.current) return
        const input = formNode.current.querySelector(`[name="${focusField}"]`)
        let parent = input?.parentElement
        while (parent && parent !== formNode.current) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement }
        ;(input || formNode.current).scrollIntoView({ block: 'nearest' })
        focusElement(input)
        setFocusField('')
      }, [focusField, form.id])
      const change = (field) => (event) => {
        const value = event.target.value
        const advancedField = field === 'reasoningEffortsText' ? 'reasoningEfforts' : field
        setForm((current) => ({ ...current, [field]: value, dirty: true, advancedChanged: { ...current.advancedChanged, [advancedField]: true }, ...(field === 'authType' ? { authExplicit: true } : {}), ...(field === 'apiFormat' ? { compat: formCompatDefaults(value), ...(!current.authExplicit ? { authType: value === 'anthropic-messages' ? 'x-api-key' : 'bearer' } : {}) } : {}), ...(field === 'profile' ? { ...modelPreset(value, current.apiFormat), profileChanged: true, authExplicit: false, advancedChanged: {} } : {}) }))
        resetFeedback()
        if (['baseUrl', 'apiKey', 'apiFormat', 'authType', 'profile', 'headersJson', 'queryJson'].includes(field)) { setAvailable([]); setQuery('') }
      }
      const changeCompat = (field, boolean = false) => (event) => {
        const value = boolean ? event.target.checked : event.target.value
        const compat = { ...form.compat }
        if (!boolean && value === '') delete compat[field]
        else compat[field] = value
        setForm({ ...form, compat, dirty: true })
        resetFeedback()
      }
      const replaceForm = (entry) => { setForm(emptyModelForm(entry)); resetFeedback(); setAvailable([]); setQuery(''); setFocusField('baseUrl') }
      const edit = (entry = {}) => { if (form.dirty) setConfirmation({ kind: 'replace', entry }); else replaceForm(entry) }
      const configuration = () => {
        try { return modelConfiguration(form) } catch (error) { setFormError(error); setFocusField(error.field || 'baseUrl'); return null }
      }
      const fetchModels = async () => {
        if (locked || !ready) return
        let values
        try { values = modelConfiguration(form, false) } catch (error) { setFormError(error); setFocusField(error.field || 'baseUrl'); return }
        setOperation('fetch'); resetFeedback()
        try {
          const response = await onFetch(values)
          setAvailable(response.models || []); setQuery('')
          setFetchResult({ ok: true, message: `已获取 ${response.count ?? response.models?.length ?? 0} 个模型`, latencyMs: response.latencyMs })
        } catch (error) { setFetchResult({ ok: false, message: error.message, code: error.code, status: error.status }) }
        finally { setOperation('') }
      }
      const requestTest = (entry) => {
        if (locked) return
        const values = entry ? { id: entry.id } : configuration()
        if (values) setConfirmation({ kind: 'test', entry, values: { ...values, check }, formVersion: form.revision })
      }
      const testModel = async (target) => {
        setConfirmation(null); setOperation(target.entry ? `test-${target.entry.id}` : 'test'); resetFeedback()
        try { await onTest(target.values, target.entry, target.formVersion) }
        finally { setOperation('') }
      }
      const submit = async (event) => {
        event.preventDefault()
        if (locked) return
        const values = configuration()
        if (!values) return
        if (!form.name.trim()) { setFormError({ message: '请输入显示名称。', field: 'name' }); setFocusField('name'); return }
        const useAfter = (event.nativeEvent?.submitter?.value || submitIntent.current) === 'use'
        submitIntent.current = 'save'
        setOperation('save'); resetFeedback()
        try {
          const saved = await onSave({ ...values, name: form.name.trim() })
          if (!saved) return
          setForm(emptyModelForm(saved)); setAvailable([])
          setStatus('已保存，未自动连接或测试模型服务。')
          if (useAfter) onUse(saved.id, true)
        } catch (error) { setFormError(error) }
        finally { setOperation('') }
      }
      const remove = async (entry) => {
        setConfirmation(null)
        if (locked) return
        setOperation('delete'); resetFeedback()
        try {
          if (!await onDelete(entry)) return
          if (form.id === entry.id) setForm(emptyModelForm())
          setStatus(`已删除连接“${entry.name}”，历史对话仍保留。`)
        } finally { setOperation('') }
      }
      const checkSelect = (label) => h('label', { className: 'codex-check-select' }, label, h('select', { 'aria-label': label, value: check, onChange: (event) => onCheck(event.target.value), disabled: locked }, h('option', { value: 'text' }, '文本回复'), h('option', { value: 'stream' }, '流式回复'), h('option', { value: 'tools' }, '工具协议')))
      const inputProps = (field) => ({ name: field, value: form[field], onChange: change(field), disabled: locked, 'aria-invalid': formError?.field === field || undefined })
      const selectCompat = (field, title, options, help) => h('label', null, title, h('select', { 'aria-label': title, value: form.compat[field] ?? '', onChange: changeCompat(field), disabled: locked }, h('option', { value: '' }, '跟随配置 / 预设'), ...options.map(([value, label]) => h('option', { key: value, value }, label))), help && h('span', { className: 'codex-muted' }, help))
      const checkboxCompat = (field, title, help) => h('label', { className: 'codex-checkbox-label' }, h('input', { type: 'checkbox', checked: form.compat[field] === true, onChange: changeCompat(field, true), disabled: locked }), h('span', null, title, help && h('small', { className: 'codex-muted' }, help)))
      const filteredAvailable = available.filter((entry) => `${entry.id} ${entry.name || ''}`.toLowerCase().includes(query.toLowerCase()))
      return h('section', { className: 'codex-custom-settings', 'aria-label': '模型服务', 'aria-busy': locked },
        h('div', { className: 'codex-section-heading' }, h('div', null, h('h3', null, '模型服务'), h('span', { className: 'codex-muted' }, `${entries.length} 个已保存连接`)), h(Button, { disabled: locked, onClick: () => edit(), label: '新建模型连接' }, h(Icon, { name: 'plus', size: 14 }), '新建连接')),
        h('p', { className: 'codex-section-description' }, '服务协议与执行引擎独立选择。非 Responses 服务可经本机兼容桥交给 Codex CLI；保存不联网，不代表已验证。'),
        (warnings || []).length > 0 && h('div', { className: 'codex-warning', role: 'status' }, h('strong', null, '部分模型配置未加载，原配置保留'), h('ul', null, ...warnings.map((warning, index) => h('li', { key: index }, typeof warning === 'string' ? warning : [warning.name || warning.id, warning.message || warning.error || warning.code].filter(Boolean).join(' · '))))),
        entries.length > 0 && checkSelect('已保存模型检查项目'),
        entries.length > 0 && h('div', { className: 'codex-saved-models' }, ...entries.map((entry) => {
          const result = modelDiagnostic(entry, diagnostics)
          return h('article', { className: 'codex-saved-model', key: entry.id },
            h('div', { className: 'codex-saved-model-heading' }, h('span', { className: 'codex-model-icon' }, h(Icon, { name: nativeModel(entry) ? 'terminal' : 'spark' })), h('div', { className: 'codex-saved-model-info' }, h('strong', { title: entry.name }, entry.name), h('span', { className: 'codex-muted', title: entry.model }, entry.model)), h('span', { className: 'codex-chip' }, !result || result.stale ? '已保存 / 未验证' : result.ok ? `${checkLabel(result.check || 'text')}已检查` : '检查未通过')),
            h('div', { className: 'codex-model-engine' }, h(Icon, { name: nativeModel(entry) ? 'terminal' : 'folder', size: 14 }), modelEngineLabel(entry)),
            h('div', { className: 'codex-model-endpoint' }, h(Icon, { name: 'link', size: 14 }), h('span', null, entry.baseUrl)),
            h('div', { className: 'codex-settings-actions' },
              h(Button, { disabled: locked, primary: true, onClick: () => onUse(entry.id), label: `使用模型 ${entry.name}` }, '使用', h(Icon, { name: 'arrow', size: 14 })),
              h(Button, { disabled: locked, onClick: () => requestTest(entry), label: `检查模型 ${entry.name}` }, operation === `test-${entry.id}` ? '检查中…' : '检查'),
              h(Button, { disabled: locked, onClick: () => edit(entry), label: `编辑模型 ${entry.name}` }, '编辑'),
              h(Button, { disabled: locked, onClick: () => setConfirmation({ kind: 'delete', entry }), label: `删除模型 ${entry.name}` }, '删除')),
            h(ModelDiagnostic, { result }))
        })),
        h('form', { ref: formNode, className: 'codex-model-form', onSubmit: submit, autoComplete: 'off' },
          h('div', { className: 'codex-form-heading' }, h(Icon, { name: 'settings' }), h('strong', null, form.id ? '编辑连接' : '新建连接'), form.dirty && h('span', { className: 'codex-chip' }, '未保存')),
          h('div', { className: 'codex-form-section' },
            h('label', null, '执行引擎', h('select', { ...inputProps('engine'), 'aria-label': '执行引擎' }, h('option', { value: 'native' }, 'Codex CLI（原生智能体）'), h('option', { value: 'workspace' }, '工作区助手（HTTP 模型）')), h('span', { className: 'codex-muted' }, form.engine === 'native' ? '使用本机 CLI 的计划、文件、命令与审批；不会更改所选服务协议。' : '通过 HTTP 模型使用工作区工具，也可仅聊天。')),
            h('label', null, '服务协议', h('select', { ...inputProps('apiFormat'), 'aria-label': '服务协议' }, h('option', { value: 'chat-completions' }, 'Chat Completions'), h('option', { value: 'responses' }, 'Responses'), h('option', { value: 'anthropic-messages' }, 'Anthropic Messages')), form.engine === 'native' && form.apiFormat !== 'responses' && h('span', { className: 'codex-muted' }, '本机兼容桥：CLI 请求在应用内转为此协议；能力需按服务检查。')),
            h('label', null, '服务地址（URL）', h('input', { ...inputProps('baseUrl'), type: 'url', placeholder: 'https://api.example.com/v1', required: true, maxLength: 2048, autoCapitalize: 'none', spellCheck: false }), h('span', { className: 'codex-muted' }, '基础地址或完整接口地址；查询参数在高级设置填写。')),
            h('label', null, '认证方式', h('select', { ...inputProps('authType'), 'aria-label': '认证方式' }, h('option', { value: 'bearer' }, 'Bearer Token'), h('option', { value: 'x-api-key' }, 'x-api-key（Anthropic 默认）'), h('option', { value: 'api-key' }, 'api-key'), h('option', { value: 'none' }, '无认证'))),
            h('label', null, form.authType === 'none' ? 'API 密钥（无认证时不发送）' : form.hasApiKey ? 'API 密钥（已保存，留空保留）' : 'API 密钥（此认证方式必填）', h('input', { ...inputProps('apiKey'), type: 'password', autoComplete: 'new-password', required: form.authType !== 'none' && !form.hasApiKey, placeholder: form.hasApiKey ? '已保存；留空保留原密钥' : form.authType === 'none' ? '无需填写' : '请输入服务提供的 API 密钥', maxLength: 4096, autoCapitalize: 'none', spellCheck: false }), h('span', { className: 'codex-muted' }, form.authType === 'none' ? '无认证不会发送密钥。留空保留已存密钥；未保存内容仅在内存中。' : form.hasApiKey ? '留空保留原密钥；页面不会读取已存密钥。' : 'Bearer、x-api-key、api-key 需要密钥；无密钥的本地服务请选择“无认证”。'))),
          h('div', { className: 'codex-form-section' },
            h('div', { className: 'codex-form-step codex-form-step-actions' }, h('strong', null, '模型'), h(Button, { disabled: locked || !ready, onClick: fetchModels, label: '获取模型列表' }, operation === 'fetch' ? '获取中…' : '获取模型')),
            h('p', { className: 'codex-muted' }, '获取列表会连接上方服务，不发送文件。服务不支持列表时可手填模型 ID。'),
            fetchResult && h('div', { className: `codex-model-feedback ${fetchResult.ok ? 'codex-feedback-success' : 'codex-feedback-error'}`, role: fetchResult.ok ? 'status' : 'alert' }, fetchResult.message, (fetchResult.code || fetchResult.status) && h('p', null, [fetchResult.code, fetchResult.status && `HTTP ${fetchResult.status}`].filter(Boolean).join(' · '))),
            available.length > 0 && h('div', { className: 'codex-model-discovery' },
              h('label', { className: 'codex-search-label' }, '搜索获取的模型', h('input', { type: 'search', value: query, placeholder: '输入名称或模型 ID', disabled: locked, onChange: (event) => setQuery(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') event.preventDefault() } })),
              h('div', { className: 'codex-discovered-models', role: 'group', 'aria-label': '获取的模型' }, ...filteredAvailable.map((entry) => h(Button, { key: entry.id, 'aria-pressed': form.model === entry.id, disabled: locked, onClick: () => { setForm({ ...form, model: entry.id, name: form.name || entry.name || entry.id, dirty: true }); resetFeedback() } }, h('span', null, entry.name || entry.id), entry.name && entry.name !== entry.id && h('small', null, entry.id), form.model === entry.id && h(Icon, { name: 'check', size: 15 }))), !filteredAvailable.length && h('p', { className: 'codex-muted' }, '没有匹配的模型，可直接输入模型 ID。'))),
            h('label', null, '模型 ID', h('input', { ...inputProps('model'), placeholder: '例如：deepseek-chat', required: true, maxLength: 256, autoCapitalize: 'none', spellCheck: false })),
            h('label', null, '显示名称', h('input', { ...inputProps('name'), placeholder: '例如：本地开发模型', required: true, maxLength: 80 }))),
          h('details', { className: 'codex-form-advanced' },
            h('summary', null, '兼容预设与请求参数', h(Icon, { name: 'chevron', size: 14 })),
            h('div', { className: 'codex-form-section' },
              h('p', { className: 'codex-muted' }, '仅显式选择时应用预设，不根据域名或模型名称猜测。切换预设会重置下方兼容与推理覆盖；保存前可再调整。'),
              form.engine === 'native' && form.apiFormat === 'responses' && h('p', { className: 'codex-warning' }, '原生 Responses 直连由 CLI 构造请求。以下兼容参数主要用于 HTTP 检查、工作区助手和本机兼容桥，不保证影响 CLI 直连请求；认证、额外请求头 / 查询与推理强度按 CLI 支持映射。'),
              h('label', null, '兼容预设', h('select', { ...inputProps('profile'), 'aria-label': '兼容预设' }, h('option', { value: '', disabled: !!form.profile }, '不应用预设'), h('option', { value: 'standard' }, 'Standard · 通用'), h('option', { value: 'deepseek' }, 'DeepSeek'), h('option', { value: 'local' }, 'Local · 本地服务'), h('option', { value: 'anthropic' }, 'Anthropic'))),
              selectCompat('systemRole', '系统消息角色', [['system', 'system'], ['developer', 'developer']]),
              selectCompat('tokenField', '输出 token 字段', [['max_tokens', 'max_tokens'], ['max_completion_tokens', 'max_completion_tokens']]),
              checkboxCompat('parallelToolCalls', '发送禁用并行工具参数', '勾选时发送 parallel_tool_calls:false；不勾选省略。'),
              checkboxCompat('strictTools', '发送严格工具 schema', '仅在服务支持 strict 工具定义时启用。'),
              checkboxCompat('store', '发送不保存响应参数', '勾选时发送 store:false；不会请求上游持久保存。'))),
          h('details', { className: 'codex-form-advanced' },
            h('summary', null, '推理与输出限制', h(Icon, { name: 'chevron', size: 14 })),
            h('div', { className: 'codex-form-section' },
              selectCompat('reasoningFormat', '推理格式', [['none', '不发送推理字段'], ['reasoning_effort', 'reasoning_effort'], ['deepseek', 'DeepSeek'], ['thinking', 'Anthropic thinking']]),
              h('label', null, '支持的推理值', h('input', { ...inputProps('reasoningEffortsText'), placeholder: 'low, medium, high', spellCheck: false }), h('span', { className: 'codex-muted' }, '逗号分隔，只填服务实际支持的值；保存后可在底栏选择。')),
              h('label', null, '默认推理强度', h('input', { ...inputProps('reasoningEffort'), placeholder: 'medium；留空使用服务默认', spellCheck: false })),
              checkboxCompat('includeReasoning', '转发服务返回的推理上下文', '仅在协议需要此上下文时启用。'),
              h('label', null, '最大输出 token', h('input', { ...inputProps('maxOutputTokens'), type: 'number', inputMode: 'numeric', min: 1, step: 1, placeholder: '留空使用服务默认' })),
              h('label', null, '思考预算 token', h('input', { ...inputProps('thinkingBudget'), type: 'number', inputMode: 'numeric', min: 1024, max: 1048576, step: 1, placeholder: '留空不指定' })))),
          h('details', { className: 'codex-form-advanced' },
            h('summary', null, '额外请求头与查询参数', h(Icon, { name: 'chevron', size: 14 })),
            h('div', { className: 'codex-form-section' }, h('p', { className: 'codex-muted' }, '仅接受 JSON 对象。空白保留已存值，{} 清空；页面只显示已存字段名，不读取值。敏感内容仅在未保存表单内存中保留。'),
              ...['headers', 'query'].map((field) => h('label', { key: field }, field === 'headers' ? '额外请求头（JSON）' : '额外查询参数（JSON）', h('textarea', { ...inputProps(`${field}Json`), rows: 3, spellCheck: false, autoCapitalize: 'none', placeholder: field === 'headers' ? '{"X-Project": "example"}' : '{"api-version": "example"}' }), h('span', { className: 'codex-muted' }, (form[`${field === 'headers' ? 'header' : 'query'}Names`] || []).length ? `已存字段：${form[field === 'headers' ? 'headerNames' : 'queryNames'].join(', ')}` : form[field === 'headers' ? 'hasHeaders' : 'hasQuery'] ? '已有配置；留空保留。' : '尚无已存字段。'))))),
          h('div', { className: 'codex-form-section' },
            checkSelect('当前配置检查项目'),
            h('div', { className: 'codex-test-row' }, h(Button, { disabled: locked || !ready || !form.model.trim(), onClick: () => requestTest(), label: '检查当前模型配置' }, h(Icon, { name: 'link', size: 15 }), operation === 'test' ? '检查中…' : '检查配置'), h('span', { className: 'codex-muted' }, '确认后发送少量、不含文件的请求；工具检查不执行命令。')),
            h(ModelDiagnostic, { result: draftDiagnostic?.formVersion === form.revision ? draftDiagnostic : null }),
            formError && h('p', { className: 'codex-error', role: 'alert' }, formError.message)),
          h('div', { className: 'codex-settings-actions codex-save-actions' },
            h('button', { type: 'submit', value: 'save', className: 'codex-button codex-primary', disabled: locked || !canSave, onClick: () => { submitIntent.current = 'save' } }, operation === 'save' ? '保存中…' : '保存连接'),
            h('button', { type: 'submit', value: 'use', className: 'codex-button', disabled: locked || !canSave, onClick: () => { submitIntent.current = 'use' } }, '保存并使用'))),
        status && h('p', { className: 'codex-model-status', role: 'status' }, status),
        confirmation && h(ConfirmSheet, {
          title: confirmation.kind === 'test' ? `检查${checkLabel(confirmation.values.check)}？` : confirmation.kind === 'delete' ? '删除模型连接？' : '放弃未保存的修改？',
          confirmLabel: confirmation.kind === 'test' ? '发送检查请求' : confirmation.kind === 'delete' ? '删除连接' : '放弃修改',
          onClose: () => setConfirmation(null), onConfirm: () => { if (confirmation.kind === 'test') testModel(confirmation); else if (confirmation.kind === 'delete') remove(confirmation.entry); else { setConfirmation(null); replaceForm(confirmation.entry) } },
        }, confirmation.kind === 'test'
          ? h('div', null, h('p', null, `将向“${confirmation.entry?.name || form.name || form.model}”的模型服务发送少量请求，可能产生费用。`), h('p', null, '不发送工作区文件或对话历史。工具检查仅使用固定、无副作用的测试工具，不执行真实文件操作或命令。'), h('p', { className: 'codex-muted' }, '检查结果仅代表所选服务的 HTTP 能力，与本机 CLI 运行环境独立。'))
          : confirmation.kind === 'delete' ? h('p', null, `将删除“${confirmation.entry.name}”的连接配置。历史消息会保留；继续使用需重新添加连接。`)
            : h('p', null, '当前表单含未保存的修改。切换视图会保留草稿，但新建或编辑另一连接将替换它。')))
    }

    // 模型 + 推理强度放在同一个面板里，对应 VS Code 里那颗「6.1 Sol Ultra」按钮。
    function ModelMenu({ entries, catalog, selectedModel, unavailable, disabled, onChoose, onManage }) {
      const [query, setQuery] = useState('')
      const name = unavailable ? '模型已删除' : catalog?.displayName || catalog?.name || catalog?.model || '选择模型'
      const groups = new Map()
      const filter = query.trim().toLowerCase()
      for (const entry of entries) {
        const description = modelEngineLabel(entry)
        if (filter && !`${entry.displayName || entry.name} ${entry.id} ${entry.model} ${description}`.toLowerCase().includes(filter)) continue
        if (!groups.has(description)) groups.set(description, [])
        groups.get(description).push(entry)
      }
      return h(Popup, {
        className: 'codex-model-menu', align: 'end', label: `选择模型：${name}`, panelLabel: '模型', panelRole: 'dialog', disabled,
        summary: [h('span', { className: 'codex-menu-value', title: name }, name), h(Icon, { name: 'chevron', size: 12 })],
      },
      h('div', { className: 'codex-menu-head' }, h('strong', null, '模型'), h('button', { type: 'button', className: 'codex-link', onClick: (event) => { closePopup(event); onManage() } }, '管理连接')),
      h('label', { className: 'codex-menu-search' }, h('span', { className: 'codex-sr-only' }, '搜索模型'), h('input', { type: 'search', 'data-popup-autofocus': true, value: query, placeholder: '搜索名称或协议', onChange: (event) => setQuery(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') event.preventDefault() } })),
      ...[...groups.entries()].map(([group, models]) => h('div', { key: group, className: 'codex-menu-group', role: 'group', 'aria-label': group },
        h('div', { className: 'codex-menu-group-title' }, group),
        ...models.map((entry) => h(Button, { key: entry.id, 'aria-pressed': selectedModel === entry.id, disabled,
          onClick: (event) => { onChoose(entry.id); closePopup(event) },
        }, h('div', { className: 'codex-menu-item' }, h('strong', { title: entry.displayName || entry.name || entry.model }, entry.displayName || entry.name || entry.model), h('span', null, entry.model)), selectedModel === entry.id && h(Icon, { name: 'check', size: 15 }))))),
      !groups.size && h('p', { className: 'codex-menu-empty' }, entries.length ? '没有匹配的模型。' : '尚未添加模型。可在“管理连接”中添加服务或连接官方 CLI。'))
    }
    function EffortMenu({ catalog, effort, disabled, onEffort }) {
      const values = reasoningValues(catalog)
      if (!values.length) return h('button', { type: 'button', className: 'codex-effort-default', disabled: true, 'aria-label': '推理强度：默认（模型未声明可选值）', title: '模型未声明可选推理强度，使用服务默认值' }, '默认')
      return h(Popup, { className: 'codex-effort-menu', align: 'end', disabled, label: `推理强度：${effortLabel(effort) || '默认'}`, panelLabel: '推理强度', summary: [h('span', { title: `推理强度：${effortLabel(effort) || '默认'}` }, effortLabel(effort) || '默认'), h(Icon, { name: 'chevron', size: 12 })] },
        h('div', { className: 'codex-menu-head' }, h('strong', null, '推理强度')),
        ...values.map((value) => h(Button, { key: value, role: 'menuitemradio', 'aria-checked': effort === value, disabled, title: value, onClick: (event) => { onEffort(value); closePopup(event) } }, effortLabel(value))),
        h('p', { className: 'codex-menu-note' }, '只列出该模型声明的值；仅影响下一次发送，不改写历史配置。'))
    }
    const accessLabel = (mode) => ({ approval: '请求批准', readonly: '只读', full: '完全访问' })[mode] || '访问范围'
    function ApprovalMenu({ disabled, access, capabilities = {}, native, onLearn, onChoose, onCreate }) {
      const options = [
        { mode: 'approval', icon: 'hand', title: '请求批准', description: native ? '按 CLI 规则请求确认；不保证文件写入逐次弹窗' : '写入与命令按后端审批规则确认', supported: !!access },
        { mode: 'readonly', icon: 'shield', title: '只读', description: native ? '原生 CLI 只读尚未验证；可另建工作区只读对话，不自动切换执行器' : '后端禁止文件写入与命令执行', supported: !!access?.supportsReadOnly && capabilities.readOnly === true },
        { mode: 'full', icon: 'alert', title: '完全访问', description: '跳过本对话执行审批；须查看范围并勾选二次确认', supported: !!access?.supportsFull && capabilities.fullAccess === true },
      ]
      return h(Popup, { className: 'codex-approval-menu', align: 'start', label: '访问范围', panelLabel: '访问范围', disabled,
        summary: [h('span', { title: accessLabel(access?.mode) }, ({ approval: '审批', readonly: '只读', full: '全访问' })[access?.mode] || '权限'), h(Icon, { name: 'chevron', size: 12 })],
      }, h('div', { className: 'codex-menu-head' }, h('strong', null, '仅当前对话'), h('button', { type: 'button', className: 'codex-link', onClick: (event) => { closePopup(event); onLearn() } }, '了解更多')),
      !access && h(Button, { disabled, onClick: (event) => { closePopup(event); onCreate() } }, '先创建对话以选择权限（不发送消息）'),
      ...options.map((option) => h('button', { key: option.mode, type: 'button', role: 'menuitemradio', 'aria-checked': access?.mode === option.mode, className: 'codex-menu-option', disabled: disabled || !option.supported, onClick: (event) => { closePopup(event); onChoose(option.mode) } },
        h('span', { className: 'codex-menu-option-icon' }, h(Icon, { name: option.icon, size: 16 })),
        h('span', { className: 'codex-menu-option-copy' }, h('strong', null, option.title, !option.supported && h('span', { className: 'codex-chip' }, '不可用')), h('span', null, option.description)))),
      h('p', { className: 'codex-menu-note' }, access?.reason || '完全访问不默认、不继承到新分支；重连后失效。以服务返回的当前权限为准。'))
    }

    function ModeMenu({ mode, native, disabled, choices, onChoose }) {
      const current = choices.find((entry) => entry.value === mode) || choices[0]
      return h(Popup, {
        className: 'codex-mode-menu', align: 'start', label: '工作模式', panelLabel: '工作模式', disabled,
        summary: [h(Icon, { name: current.icon, size: 13 }), h('span', null, current.label), h(Icon, { name: 'chevron', size: 12 })],
      },
      h('div', { className: 'codex-menu-head' }, h('strong', null, '工作模式')),
      ...choices.map((entry) => h(Button, {
        key: entry.value, role: 'menuitemradio', 'aria-checked': mode === entry.value, disabled: disabled || entry.disabled,
        onClick: (event) => { onChoose(entry.value); const node = event.currentTarget.closest('details'); if (node) node.open = false },
      }, h('div', { className: 'codex-menu-item' }, h('strong', null, entry.label), h('span', null, entry.description)), mode === entry.value && h(Icon, { name: 'check', size: 15 }))),
      h('p', { className: 'codex-menu-note' }, native ? '原生 Codex CLI 目前只有智能体模式。' : '切换模式会从新对话开始；原对话可在历史中继续。'))
    }

    function Sheet({ title, onClose, children, footer }) {
      const card = useRef(null)
      const close = useRef(onClose)
      close.current = onClose
      const titleId = useRef(`codex-sheet-title-${++nextDomId}`)
      useEffect(() => {
        const previous = document.activeElement
        const focusables = () => [...card.current.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((node) => node.getClientRects().length)
        focusElement(card.current.querySelector('[data-dialog-initial]') || focusables()[0] || card.current)
        const key = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
          if (event.key !== 'Tab') return
          const nodes = focusables()
          if (!nodes.length) { event.preventDefault(); focusElement(card.current); return }
          if (event.shiftKey && (document.activeElement === nodes[0] || !card.current.contains(document.activeElement))) { event.preventDefault(); focusElement(nodes[nodes.length - 1]) }
          else if (!event.shiftKey && (document.activeElement === nodes[nodes.length - 1] || !card.current.contains(document.activeElement))) { event.preventDefault(); focusElement(nodes[0]) }
        }
        const focus = (event) => { if (card.current && !card.current.contains(event.target)) focusElement(focusables()[0] || card.current) }
        document.addEventListener('keydown', key, true)
        document.addEventListener('focusin', focus, true)
        return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('focusin', focus, true); if (previous?.isConnected) focusElement(previous) }
      }, [])
      return h('div', { className: 'codex-sheet', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { ref: card, className: 'codex-sheet-card', role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId.current, tabIndex: -1 },
          h('div', { className: 'codex-sheet-head' }, h('strong', { id: titleId.current }, title), h('button', { type: 'button', className: 'codex-icon-button', 'aria-label': '关闭弹层', onClick: onClose }, h(Icon, { name: 'close', size: 16 }))),
          h('div', { className: 'codex-sheet-body' }, children), h('div', { className: 'codex-sheet-foot' }, footer)))
    }

    function ConfirmSheet({ title, confirmLabel, onClose, onConfirm, children, disabled = false }) {
      return h(Sheet, { title, onClose, footer: h('div', { className: 'codex-confirm-actions' }, h(Button, { onClick: onClose, 'data-dialog-initial': true }, '取消'), h(Button, { primary: true, disabled, onClick: onConfirm }, confirmLabel)) }, children)
    }
    function AccessSheet({ onClose }) {
      return h(Sheet, { title: '审批与访问范围', onClose, footer: h(Button, { primary: true, onClick: onClose }, '知道了') },
        h('p', null, '权限只作用于当前已创建的对话。新对话和编辑、重答分支不会继承完全访问；重连或重置后需要重新确认。'),
        h('ul', null,
          h('li', null, h('strong', null, '请求批准'), '：按后端规则确认命令与变更；原生 CLI 不保证每次文件写入都弹窗。'),
          h('li', null, h('strong', null, '只读'), '：工作区后端禁止写入与命令执行；原生 CLI 只读尚未验证，不会自动切换执行器。'),
          h('li', null, h('strong', null, '完全访问'), '：仅服务声明支持时开放，先查看范围，再勾选二次确认。它会跳过当前对话的操作审批。'),
          h('li', null, h('strong', null, '文件撤销'), '：只有具备快照的回合可用。先预览，遇到冲突不强制覆盖。'),
          h('li', null, h('strong', null, '停止'), '：审批处理中仍可停止，不会自动重发。')),
        h('p', { className: 'codex-muted' }, '原生 CLI 使用应用身份与操作系统权限；工作区是启动目录，不是访问边界。'))
    }
    function ActionSheet({ action, busy, onClose, onConfirm, onText, onChecked }) {
      if (!action) return null
      const edit = action.kind === 'edit'
      const full = action.kind === 'full'
      const undo = action.kind === 'undo'
      const expired = (full || undo) && (!action.token || !Number.isFinite(new Date(action.expiresAt).getTime()) || new Date(action.expiresAt).getTime() <= Date.now())
      return h(ConfirmSheet, { title: edit ? '修改并重发' : full ? '确认完全访问范围' : undo ? '撤销本轮文件变更' : '重新回答', confirmLabel: busy ? '处理中…' : edit ? '创建分支并发送一次' : full ? '启用当前对话完全访问' : undo ? '确认撤销' : '创建分支并重新回答', disabled: busy || expired || (edit && !action.text.trim()) || (full && !action.checked), onClose, onConfirm },
        edit || action.kind === 'retry' ? h('p', null, '将在同一模型服务和工作目录创建新的文字分支，不回滚任何文件，不继承完全访问权限。确认后只提交一次。原对话保留。') : h('p', null, action.message),
        edit && h('textarea', { className: 'codex-edit-text', 'aria-label': '修改后的消息', value: action.text, disabled: busy, onChange: (event) => onText(event.target.value) }),
        full && h('dl', { className: 'codex-metadata' }, ...['threadId', 'cwd', 'model', 'engine'].flatMap((key) => [h('dt', { key: `${key}-label` }, ({ threadId: '对话', cwd: '目录', model: '模型', engine: '执行器' })[key]), h('dd', { key }, action.scope?.[key] || '未提供')])),
        full && h('label', { className: 'codex-checkbox-label' }, h('input', { type: 'checkbox', checked: !!action.checked, disabled: busy, onChange: (event) => onChecked(event.target.checked) }), h('span', null, '我确认仅对上述当前对话跳过操作审批；命令和写入可能直接执行。')),
        undo && h('div', null, ...(action.files || []).map((file, index) => h('section', { key: `${file.path}-${index}` }, h('p', null, `${changeLabel(file.kind)} · ${file.path}`), file.diff && h(Diff, { text: file.diff }))), h('p', { className: 'codex-muted' }, '后续改动可能导致冲突；不会强制覆盖。撤销只影响文件，不删除对话。')),
        expired && h('p', { role: 'alert' }, '确认已过期，请关闭后重新预览。'), action.error && h('p', { role: 'alert', className: 'codex-tool-error' }, action.error))
    }

    function CodexBody({ model, useTabInfo }) {
      const state = useModel(model)
      const info = useTabInfo()
      const [view, setView] = useState(state.view || 'chat')
      const [busy, setBusy] = useState(false)
      const operationPending = useRef(false)
      const [selectedModel, setSelectedModel] = useState(state.selectedModel || '')
      const [effort, setEffort] = useState(state.selectedEffort || defaultEffort(state.models.find((entry) => entry.id === state.selectedModel)))
      const [mode, setMode] = useState(state.selectedMode || 'agent')
      const [consent, setConsent] = useState(false)
      const [file, setFile] = useState('')
      const [contextOpen, setContextOpen] = useState(false)
      const [apiKey, setApiKey] = useState('')
      const [login, setLogin] = useState(null)
      const [selectionNotice, setSelectionNotice] = useState('')
      const [environmentCheck, setEnvironmentCheck] = useState(null)
      const [checkingEnvironment, setCheckingEnvironment] = useState(false)
      const [sheet, setSheet] = useState('')
      const [action, setAction] = useState(null)
      const [unseen, setUnseen] = useState(false)
      const [check, setCheck] = useState(state.modelCheck || 'text')
      const textarea = useRef(null)
      const composing = useRef(false)
      const composerReasonId = useRef(`codex-composer-reason-${++nextDomId}`)
      const connectionRef = useRef(null)
      const modelsRef = useRef(null)
      const accountRef = useRef(null)
      const settingsTarget = useRef(null)
      const [mobileInput, setMobileInput] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px), (pointer: coarse)').matches)
      const environmentContext = useRef({ model, cwd: state.cwd })
      if (environmentContext.current.model !== model || environmentContext.current.cwd !== state.cwd) environmentContext.current = { model, cwd: state.cwd }
      const environmentResult = useRef(null)
      const pendingEnvironmentScroll = useRef(null)
      const scroll = useRef(null)
      const stick = useRef(true)
      const scrollContext = useRef({ key: null, view: null, programmaticTop: null })
      const olderAnchor = useRef(null)
      const touchY = useRef(null)
      const active = state.threads.find((thread) => thread.id === state.current)
      const scrollState = model.scrollFor(state.current || 'new')
      const revision = JSON.stringify((active?.turns || []).map((turn) => [turn.id, turn.status, (turn.items || []).map((item) => [item.id, item.status, item.text?.length, item.aggregatedOutput?.length, item.result !== undefined ? printable(item.result).length : 0]), !!turn.error]))
      const catalog = state.models.find((entry) => entry.id === selectedModel)
      const unavailableCustom = !catalog && active?.model === selectedModel && (active?.source === 'custom' || active?.model?.startsWith('custom-'))
      const custom = ['custom', 'native-custom'].includes(catalog?.source) || unavailableCustom
      const native = catalog?.engine === 'native' || ['native', 'native-custom'].includes(catalog?.source) || (!catalog && (active?.engine === 'native' || ['native', 'native-custom'].includes(active?.source)))
      const workspaceCustom = custom && !native
      const workspaceName = state.cwd?.split(/[\\/]/).filter(Boolean).pop() || (state.phase === 'ready' ? '未选择工作区' : '正在读取工作区')
      const environment = state.environment || active?.environment
      const visibleEnvironmentCheck = environmentCheck?.environment?.cwd === state.cwd ? environmentCheck : null
      const runningThread = state.threads.find((thread) => state.approvals.some((approval) => approval.threadId === thread.id)) || state.threads.find((thread) => thread.pending || thread.turns?.some((turn) => turn.status === 'inProgress'))
      const runningThreadId = runningThread?.id || state.approvals[0]?.threadId
      const running = !!runningThreadId
      const activeApprovals = state.approvals.filter((entry) => entry.threadId === state.current)
      const connected = state.health.phase === 'connected'
      const permitted = native ? connected && state.health.nativeApp?.available === true && !!catalog && mode === 'agent' : custom ? !!catalog && (catalog.supportedModes || ['agent', 'chat']).includes(mode) : connected && state.health[mode] === true
      const loggedIn = custom || (state.account && (!state.account.requiresAuth || state.account.loggedIn))
      useEffect(() => {
        if (catalog || unavailableCustom) return
        const next = state.models.find((entry) => entry.id === active?.model) || state.models.find((entry) => entry.isDefault) || state.models[0]
        if (next) {
          const changesProvider = active && active.model !== next.id
          if (changesProvider) { model.update({ current: null }); setSelectionNotice('已切换模型，将从新对话开始，原对话保留在历史中。') }
          setSelectedModel(next.id); setEffort(defaultEffort(next)); setMode(active?.model === next.id ? active.mode || 'agent' : 'agent')
        }
        else if (selectedModel && state.phase === 'ready') setSelectedModel('')
      }, [state.models, catalog, active, selectedModel, state.phase, unavailableCustom, model])
      useEffect(() => {
        if (native && mode !== 'agent') setMode('agent')
        if (custom && catalog && !(catalog.supportedModes || ['agent', 'chat']).includes(mode)) setMode((catalog.supportedModes || []).includes('agent') ? 'agent' : 'chat')
        if (catalog && !reasoningValues(catalog).includes(effort)) setEffort(defaultEffort(catalog))
      }, [catalog, effort, custom, native, mode])
      useEffect(() => { model.update({ selectedModel, selectedMode: mode, selectedEffort: effort, view }) }, [model, selectedModel, mode, effort, view])
      useEffect(() => {
        if (typeof window.matchMedia !== 'function') return
        const media = window.matchMedia('(max-width: 767px), (pointer: coarse)')
        const changed = () => setMobileInput(media.matches)
        if (media.addEventListener) media.addEventListener('change', changed)
        else media.addListener(changed)
        return () => { if (media.removeEventListener) media.removeEventListener('change', changed); else media.removeListener(changed) }
      }, [])
      useEffect(() => {
        const node = textarea.current
        if (!node || view !== 'chat') return
        node.style.height = 'auto'
        const style = window.getComputedStyle(node)
        const maxHeight = parseFloat(style.maxHeight) || 160
        const minHeight = parseFloat(style.minHeight) || 44
        node.style.height = `${Math.max(minHeight, Math.min(node.scrollHeight, maxHeight))}px`
        node.style.overflowY = node.scrollHeight > maxHeight ? 'auto' : 'hidden'
      }, [state.draft, view, mobileInput])
      useEffect(() => {
        const valid = new Set((state.customModels || []).map(diagnosticKey))
        const previous = state.modelDiagnostics || {}
        if (Object.keys(previous).some((key) => !valid.has(key))) model.update({ modelDiagnostics: Object.fromEntries(Object.entries(previous).filter(([key]) => valid.has(key))) })
      }, [state.customModels, model])
      useEffect(() => { pendingEnvironmentScroll.current = null; setEnvironmentCheck(null) }, [model, state.cwd])
      const setScrollTop = (top) => {
        if (!scroll.current) return
        scroll.current.scrollTop = top
        scrollContext.current.programmaticTop = scroll.current.scrollTop
        scrollState.top = scroll.current.scrollTop
      }
      const pauseFollow = () => { stick.current = false; scrollState.follow = false; scrollContext.current.programmaticTop = null }
      const handleScroll = () => {
        const node = scroll.current
        if (view !== 'chat' || !node) return
        if (scrollContext.current.programmaticTop !== null && Math.abs(node.scrollTop - scrollContext.current.programmaticTop) < 2) { scrollContext.current.programmaticTop = null; return }
        const upward = node.scrollTop < scrollState.top - 1
        const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 60
        scrollState.follow = !upward && atBottom
        stick.current = scrollState.follow
        scrollState.top = node.scrollTop
        if (scrollState.follow) { scrollState.unseen = false; setUnseen(false) }
      }
      const jumpLatest = () => { scrollState.follow = true; scrollState.unseen = false; stick.current = true; setUnseen(false); setScrollTop(scroll.current?.scrollHeight || 0) }
      useLayoutEffect(() => {
        const node = scroll.current
        if (!node) return
        if (view !== 'chat') { if (scrollContext.current.view !== view) node.scrollTop = 0; scrollContext.current.view = view; return }
        const changedView = scrollContext.current.key !== state.current || scrollContext.current.view !== view
        const anchor = olderAnchor.current
        if (anchor?.threadId === state.current) {
          const element = [...node.querySelectorAll('[data-message-key]')].find((entry) => entry.dataset.messageKey === anchor.key)
          if (element) setScrollTop(node.scrollTop + element.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset)
          else setScrollTop(anchor.top + node.scrollHeight - anchor.height)
          if (anchor.finished) olderAnchor.current = null
        } else if (changedView) setScrollTop(scrollState.follow ? node.scrollHeight : scrollState.top)
        else if (revision !== scrollState.revision) {
          if (scrollState.follow && stick.current) setScrollTop(node.scrollHeight)
          else { scrollState.unseen = true; setUnseen(true) }
        }
        if (changedView && scrollState.revision && scrollState.revision !== revision && !scrollState.follow) scrollState.unseen = true
        scrollState.revision = revision
        scrollContext.current.key = state.current
        scrollContext.current.view = view
        stick.current = scrollState.follow
        setUnseen(scrollState.unseen)
      }, [revision, state.current, state.approvals.length, view, busy])
      // Changes in composer/card height should only follow when the reader still wants it.
      useEffect(() => {
        const node = scroll.current
        if (!node || view !== 'chat' || typeof ResizeObserver !== 'function') return
        const observer = new ResizeObserver(() => { if (scrollState.follow && stick.current && !olderAnchor.current) setScrollTop(node.scrollHeight) })
        observer.observe(node)
        return () => observer.disconnect()
      }, [view, state.current])
      useEffect(() => { if (action && (action.threadId !== state.current || action.cwd !== state.cwd || action.epoch !== state.connectionEpoch || state.disconnected)) setAction(null) }, [state.current, state.cwd, state.connectionEpoch, state.disconnected, action])
      useEffect(() => {
        const context = pendingEnvironmentScroll.current
        if (!context) return
        pendingEnvironmentScroll.current = null
        if (context !== environmentContext.current || !visibleEnvironmentCheck || !scroll.current || !environmentResult.current) return
        const node = scroll.current
        node.scrollTop += environmentResult.current.getBoundingClientRect().top - node.getBoundingClientRect().top - 8
        stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60
      }, [visibleEnvironmentCheck, view])
      const run = async (operation) => {
        if (operationPending.current) return null
        operationPending.current = true
        setBusy(true)
        model.update({ error: null })
        try { return await operation() } catch (error) { model.update({ error: error.message }); return null } finally { operationPending.current = false; setBusy(false) }
      }
      const openSettings = (target = 'models') => {
        settingsTarget.current = target
        setView('settings')
        setTimeout(() => {
          const ref = target === 'connection' ? connectionRef : target === 'account' ? accountRef : modelsRef
          if (!ref.current) return
          if (ref.current.tagName === 'DETAILS') ref.current.open = true
          ref.current.scrollIntoView({ block: 'start' })
          focusElement(ref.current.querySelector('summary, h3') || ref.current)
          settingsTarget.current = null
        }, 0)
      }
      const chooseModel = (id, afterSave = false) => {
        if ((!afterSave && (busy || operationPending.current)) || running) return
        const next = model.get().models.find((entry) => entry.id === id)
        if (!next) return
        const nextNative = nativeModel(next)
        if (model.get().current && active?.model !== id) {
          model.update({ current: null, error: null })
          setSelectionNotice('已切换模型，将从新对话开始。原对话保留在历史中。')
        }
        setSelectedModel(id)
        setEffort(defaultEffort(next))
        setMode(nextNative ? 'agent' : active?.model === id ? active.mode || 'agent' : (next.supportedModes || ['agent', 'chat']).includes('agent') ? 'agent' : 'chat')
      }
      const enableDevelopmentTools = (modelId = selectedModel) => run(async () => {
        const entry = model.get().models.find((value) => value.id === modelId)
        if (running || entry?.source !== 'custom' || !(entry.supportedModes || ['agent', 'chat']).includes('agent')) return
        if (active?.mode === 'chat' && active.model === modelId) {
          const created = await model.post('/thread/new', { model: modelId, effort: modelId === selectedModel ? effort : defaultEffort(entry), mode: 'agent', engine: 'workspace', continueFrom: active.id })
          model.update({ current: created.thread.id })
          setSelectionNotice('已启用开发工具。之前的聊天已保留作为上下文，并在新的工作区助手会话中继续。')
        } else {
          model.update({ current: null, error: null })
          setSelectionNotice('已启用开发工具，可以读取工作区，确认后修改文件和运行命令。')
        }
        setSelectedModel(modelId)
        setMode('agent')
        setEffort(modelId === selectedModel ? effort : defaultEffort(entry))
        setView('chat')
      })
      const chooseMode = (value) => {
        if (busy || running || value === mode) return
        if (custom && value === 'agent') { enableDevelopmentTools(); return }
        if (state.current) { model.update({ current: null, error: null }); setSelectionNotice(value === 'chat' ? '已选择仅聊天，将从新对话开始。原会话可在历史中继续。' : '模式已切换，将从新对话开始。') }
        setMode(value)
      }
      const newConversation = () => {
        if (busy || operationPending.current || running) return
        model.update({ current: null, error: null })
        if (custom) setMode((catalog?.supportedModes || ['agent', 'chat']).includes('agent') ? 'agent' : 'chat')
        setSelectionNotice('')
        setView('chat')
      }
      const useCustomModel = (id, afterSave = false) => {
        if ((!afterSave && (busy || operationPending.current)) || running) return
        if (!afterSave && model.get().current === active?.id && active?.model === id && active.mode === 'chat') { enableDevelopmentTools(id); return }
        chooseModel(id, afterSave)
        const entry = model.get().models.find((value) => value.id === id)
        setMode((entry?.supportedModes || ['agent', 'chat']).includes('agent') ? 'agent' : 'chat')
        setView('chat')
      }
      const checkEnvironment = () => run(async () => {
        const context = environmentContext.current
        setCheckingEnvironment(true)
        try {
          const result = await model.post('/environment/check')
          if (environmentContext.current === context && result.environment?.cwd === model.get().cwd) {
            pendingEnvironmentScroll.current = context
            pauseFollow()
            setEnvironmentCheck(result)
          }
        } finally { setCheckingEnvironment(false) }
      })
      const inspectModel = async (path, values) => {
        if (operationPending.current) throw new Error('另一项操作仍在进行，请稍后重试。')
        operationPending.current = true
        setBusy(true)
        model.update({ error: null })
        try { return await model.post(path, values) } finally { operationPending.current = false; setBusy(false) }
      }
      const updateModelForm = (value) => model.update({ modelForm: { ...value, revision: (model.get().modelForm?.revision || 0) + 1 }, draftDiagnostic: null })
      const invalidateDiagnostics = (id) => {
        const diagnostics = Object.fromEntries(Object.entries(model.get().modelDiagnostics || {}).filter(([key]) => !key.startsWith(`${id}:`)))
        model.update({ modelDiagnostics: diagnostics })
      }
      const testCustomModel = async (values, entry, formVersion) => {
        let result
        try { result = { check: values.check, checkedAt: new Date().toISOString(), ...await inspectModel('/models/test', values) } }
        catch (error) { result = diagnosticFailure(error, values.check) }
        if (entry) {
          const currentEntry = model.get().customModels?.find((value) => value.id === entry.id)
          if (currentEntry && diagnosticKey(currentEntry) === diagnosticKey(entry)) model.update({ modelDiagnostics: { ...model.get().modelDiagnostics, [diagnosticKey(entry)]: result } })
        } else if (model.get().modelForm?.revision === formVersion) model.update({ draftDiagnostic: { ...result, formVersion } })
        return result
      }
      const saveCustomModel = (values) => run(async () => {
        const saved = await model.post('/models/save', values)
        invalidateDiagnostics(saved.id)
        if (active?.model === saved.id) {
          model.update({ current: null })
          setSelectionNotice('模型配置已更新，将从新对话开始，原历史保留。')
        }
        return model.get().customModels?.find((entry) => entry.id === saved.id) || saved
      })
      const deleteCustomModel = (entry) => run(async () => {
        const deleted = await model.post('/models/delete', { id: entry.id })
        invalidateDiagnostics(entry.id)
        if (selectedModel === entry.id && active?.model !== entry.id) { setSelectedModel(''); setMode('agent'); setEffort('') }
        return deleted
      })
      const send = () => {
        if (sendBlock || operationPending.current) return
        const snapshot = model.get()
        const currentCatalog = snapshot.models.find((entry) => entry.id === selectedModel)
        const sendEffort = reasoningValues(currentCatalog).includes(effort) ? effort : defaultEffort(currentCatalog)
        const text = snapshot.draft.trim()
        const files = snapshot.files.slice()
        const draftVersion = snapshot.draftVersion
        const filesVersion = snapshot.filesVersion
        return run(async () => {
          let threadId = snapshot.current
          if (!threadId) {
            const created = await model.post('/thread/new', { model: selectedModel, effort: sendEffort, mode, engine: native ? 'native' : 'workspace', ...(native ? { approvalPolicy: 'untrusted' } : {}) })
            threadId = created.thread.id
            model.update({ current: threadId })
          }
          const requestId = crypto.randomUUID()
          await model.post('/turn', { threadId, requestId, text, model: selectedModel, effort: sendEffort, mode, engine: native ? 'native' : 'workspace', files })
          const current = model.get()
          // A user can continue typing or change attachments while the request is in flight.
          const sameDraft = current.draftVersion === draftVersion
          model.update({ ...(sameDraft ? { draft: '' } : {}), ...(sameDraft && current.filesVersion === filesVersion ? { files: [] } : {}) })
          setSelectionNotice('')
        })
      }
      const addContext = () => {
        const name = file.trim()
        if (name && !state.files.includes(name) && state.files.length < 5) model.update({ files: [...state.files, name] })
        setFile('')
        setContextOpen(false)
      }
      const openHistory = (entry) => run(async () => {
        await model.post('/thread/resume', { threadId: entry.id })
        model.update({ current: entry.id })
        setSelectedModel(entry.model)
        setEffort(entry.effort || '')
        setMode(entry.mode || 'agent')
        setSelectionNotice('')
        setView('chat')
      })
      const loginLink = login?.verificationUrl && (() => {
        try { const url = new URL(login.verificationUrl); return url.protocol === 'https:' && ['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname) ? url.href : null } catch { return null }
      })()
      const supportedModes = catalog?.supportedModes || ['agent', 'chat']
      const modeChoices = [
        { value: 'agent', label: native ? '原生智能体' : custom ? '工作区助手' : '智能体', icon: 'terminal', description: native ? '官方 CLI 执行计划、文件操作与命令' : '可读取工作区，改文件和跑命令前确认', disabled: unavailableCustom || !supportedModes.includes('agent') },
        { value: 'chat', label: custom ? '仅聊天' : '对话', icon: 'link', description: native ? '原生 CLI 目前只有智能体模式' : '不读取文件、不执行操作', disabled: native || unavailableCustom || !supportedModes.includes('chat') },
      ]
      const suggestions = native || (custom && mode === 'agent')
        ? ['跑一遍构建，看看有没有报错', '介绍一下这个项目的结构', '找出最近改动最多的文件']
        : ['用一句话说明你能做什么', '帮我理清这段思路的结构']
      const returnToTask = () => {
        if (runningThread) {
          model.update({ current: runningThread.id })
          setSelectedModel(runningThread.model)
          setMode(runningThread.mode || 'agent')
          setEffort(runningThread.effort || defaultEffort(state.models.find((entry) => entry.id === runningThread.model)))
        } else if (runningThreadId) model.update({ current: runningThreadId })
        setView('chat')
      }
      const actionBlock = busy ? '请求处理中' : state.phase !== 'ready' || state.disconnected ? '会话状态尚不可用' : !state.cwd ? '请先选择工作区' : running ? '请等待任务结束或停止' : !catalog || !permitted || !loggedIn ? '模型或执行环境不可用' : active?.cwd && active.cwd !== state.cwd ? '此对话不属于当前工作目录' : ''
      const assertActionReady = (threadId, turnId, capability) => {
        const snapshot = model.get()
        const thread = snapshot.threads.find((entry) => entry.id === threadId)
        const turn = thread?.turns?.find((entry) => entry.id === turnId)
        if (snapshot.phase !== 'ready' || snapshot.disconnected || !snapshot.cwd || snapshot.current !== threadId || !thread || (thread.cwd && thread.cwd !== snapshot.cwd)) throw new Error('会话或工作目录已改变，请刷新后重试。')
        if (snapshot.approvals.length || snapshot.threads.some((entry) => entry.pending || entry.turns?.some((item) => item.status === 'inProgress'))) throw new Error('任务仍在运行，请先等待或停止。')
        if (nativeModel(thread) && (snapshot.health.phase !== 'connected' || !snapshot.health.nativeApp?.available)) throw new Error('CLI 连接不可用。')
        if (capability && thread.capabilities?.[capability] !== true) throw new Error('服务未开放此能力。')
        if (turnId && (!turn || turn.status === 'inProgress')) throw new Error('源回合不可用或仍在运行。')
        return { snapshot, thread, turn }
      }
      const putThread = (thread, binding) => {
        if (!thread?.id) throw new Error('服务未返回对话。')
        const snapshot = model.get()
        const merged = { ...snapshot.threads.find((entry) => entry.id === thread.id), ...thread, ...(binding ? { binding } : {}) }
        model.update({ current: thread.id, threads: [...snapshot.threads.filter((entry) => entry.id !== thread.id), merged] })
        return merged
      }
      const ensureThread = async () => {
        if (model.get().current) return model.get().threads.find((entry) => entry.id === model.get().current)
        const created = await model.post('/thread/new', { model: selectedModel, effort: reasoningValues(catalog).includes(effort) ? effort : defaultEffort(catalog), mode, engine: native ? 'native' : 'workspace', ...(native ? { approvalPolicy: 'untrusted' } : {}) })
        return putThread(created.thread, created.binding)
      }
      const actionContext = (kind, turn, extra = {}) => ({ kind, threadId: active.id, turnId: turn?.id, cwd: state.cwd, epoch: state.connectionEpoch, requestId: crypto.randomUUID(), ...extra })
      const editMessage = (turn, item) => { if (!actionBlock && active.capabilities?.edit && turn.status !== 'inProgress') setAction(actionContext('edit', turn, { itemId: item.id, text: userText(item) })) }
      const retryTurn = (turn) => { if (!actionBlock && active.capabilities?.retry && turn.status !== 'inProgress') setAction(actionContext('retry', turn)) }
      const reviseTurn = (turn) => {
        const draft = model.get().draft
        const quote = assistantText(turn).slice(0, 600)
        model.update({ draft: `${draft}${draft ? '\n\n' : ''}请修改本轮回复（${turn.id}）：\n${quote.split('\n').map((line) => `> ${line}`).join('\n')}\n\n修改要求：` })
        setSelectionNotice(draft ? '修改请求已追加到现有草稿，未覆盖原内容。' : '修改请求已填入草稿，补充要求后再发送。')
        setView('chat'); focusElement(textarea.current)
      }
      const prepareUndo = (turn) => {
        if (actionBlock) return
        return run(async () => {
          assertActionReady(active.id, turn.id, 'undo')
          if (!turn.undo?.available) throw new Error(turn.undo?.reason || '本轮没有可用文件快照。')
          const context = actionContext('undo', turn)
          const preview = await model.post('/changes/preview', { threadId: active.id, turnId: turn.id })
          if (preview.ok === false || ['conflict', 'partial'].includes(preview.status)) {
            const details = (preview.conflicts?.length ? preview.conflicts : preview.files || []).map((entry) => typeof entry === 'string' ? entry : `${entry.path || ''}${entry.reason ? `：${entry.reason}` : ''}`).filter(Boolean).join('\n')
            setAction(null)
            throw new Error(`${preview.message || '撤销预览发现冲突，未执行文件修改。'}${details ? `\n${details}` : ''}`)
          }
          if (!preview.token || !Number.isFinite(new Date(preview.expiresAt).getTime()) || new Date(preview.expiresAt).getTime() <= Date.now()) {
            setAction(null)
            throw new Error('撤销预览未提供有效确认凭据，请重新预览。')
          }
          setAction({ ...context, ...preview, checked: false })
        })
      }
      const createForAccess = () => {
        if (actionBlock) return
        return run(async () => { await ensureThread(); setSelectionNotice('已创建空对话，未发送消息。请再次打开访问范围选择权限。') })
      }
      const chooseAccess = (value) => {
        if (actionBlock || !active) return
        return run(async () => {
          const { thread } = assertActionReady(active.id)
          if (value === 'full') {
            if (!thread.access?.supportsFull || !thread.capabilities?.fullAccess) throw new Error('当前对话不支持完全访问。')
            const context = actionContext('full')
            const challenge = await model.post('/access/prepare', { threadId: active.id, mode: 'full' })
            setAction({ ...context, ...challenge, checked: false })
          } else {
            if (value === 'readonly' && (!thread.access?.supportsReadOnly || !thread.capabilities?.readOnly)) throw new Error('此执行器只读尚未验证。')
            if (!['approval', 'readonly'].includes(value)) return
            const result = await model.post('/access/apply', { threadId: active.id, mode: value })
            if (result.access) putThread({ ...model.get().threads.find((entry) => entry.id === active.id), access: result.access })
          }
        })
      }
      const confirmAction = () => {
        if (!action || operationPending.current) return
        const target = action
        return run(async () => {
          try {
            const capability = target.kind === 'edit' ? 'edit' : target.kind === 'retry' ? 'retry' : target.kind === 'undo' ? 'undo' : 'fullAccess'
            const { snapshot, thread, turn } = assertActionReady(target.threadId, target.turnId, capability)
            if (target.cwd !== snapshot.cwd || target.epoch !== snapshot.connectionEpoch) throw new Error('连接或工作目录已改变，请重新确认。')
            if (target.kind === 'full' || target.kind === 'undo') {
              if (!target.token || !Number.isFinite(new Date(target.expiresAt).getTime()) || new Date(target.expiresAt).getTime() <= Date.now()) throw new Error('确认已过期，请关闭后重新预览。')
              if (target.kind === 'full') {
                if (!target.checked || target.scope?.threadId !== thread.id || target.scope?.cwd !== snapshot.cwd || !thread.access?.supportsFull) throw new Error('请核对范围并勾选确认。')
                const result = await model.post('/access/apply', { threadId: thread.id, mode: 'full', token: target.token })
                if (result.access) putThread({ ...model.get().threads.find((entry) => entry.id === thread.id), access: result.access })
              } else {
                if (!turn.undo?.available) throw new Error('本轮撤销状态已改变，请重新预览。')
                const result = await model.post('/changes/revert', { threadId: thread.id, turnId: target.turnId, token: target.token, requestId: target.requestId })
                if (!result.ok || ['conflict', 'partial'].includes(result.status)) {
                  const conflicts = (result.conflicts || result.files || []).map((entry) => typeof entry === 'string' ? entry : `${entry.path}${entry.reason ? `：${entry.reason}` : ''}`).join('\n')
                  setAction({ ...target, token: null, error: `撤销${result.status === 'partial' ? '部分完成' : '遇到冲突'}，未强制覆盖。\n${conflicts}` })
                  return
                }
                setSelectionNotice('文件撤销已完成，对话历史保留。')
              }
            } else {
              if (target.kind === 'edit' && !target.text.trim()) throw new Error('消息不能为空。')
              const result = await model.post(target.kind === 'edit' ? '/thread/edit' : '/thread/retry', { threadId: thread.id, turnId: target.turnId, requestId: target.requestId, ...(target.kind === 'edit' ? { itemId: target.itemId, text: target.text } : {}) })
              const branch = putThread(result.thread, result.binding)
              setSelectedModel(result.binding?.model || branch.model)
              setEffort(result.binding?.effort || branch.effort || '')
              setMode(result.binding?.mode || branch.mode || 'agent')
              setView('chat')
              setSelectionNotice('已创建文字分支并提交一次；原对话和文件保持不变，现有草稿保留。')
              await model.refresh()
            }
            setAction(null)
          } catch (error) { setAction({ ...target, error: error.message }); throw error }
        })
      }
      const loadOlder = () => {
        if (busy || !active) return
        const node = scroll.current
        if (node) {
          const bounds = node.getBoundingClientRect()
          const first = [...node.querySelectorAll('[data-message-key]')].find((entry) => entry.getBoundingClientRect().bottom > bounds.top)
          olderAnchor.current = { threadId: active.id, key: first?.dataset.messageKey, offset: first ? first.getBoundingClientRect().top - bounds.top : 0, top: node.scrollTop, height: node.scrollHeight }
          pauseFollow()
        }
        return run(async () => { try { const result = await model.post('/thread/older', { threadId: active.id }); if (result.thread) putThread(result.thread, result.binding) } finally { if (olderAnchor.current) olderAnchor.current.finished = true } })
      }
      const independent = async (kind, key, operation) => {
        const snapshot = model.get()
        if (snapshot[kind]?.[key] || snapshot.phase !== 'ready' || snapshot.disconnected || !snapshot.cwd) return
        model.update({ [kind]: { ...snapshot[kind], [key]: true }, error: null })
        try { return await operation() } catch (error) { model.update({ error: error.message }) } finally { const next = { ...model.get()[kind] }; delete next[key]; model.update({ [kind]: next }) }
      }
      const decideApproval = (entry, decision) => independent('approvalBusy', entry.id, () => model.post('/approval', { approvalId: entry.id, decision }))
      const stopTask = () => { if (runningThreadId) return independent('stopping', runningThreadId, () => model.post('/interrupt', { threadId: runningThreadId })) }
      const sendBlock = state.phase !== 'ready' ? { message: '正在读取侧栏状态，暂不可发送。', action: '刷新状态', onAction: () => model.refresh() }
        : state.disconnected ? { message: '状态连接已断开，恢复连接后再发送；不会自动重发。', action: '刷新状态', onAction: () => model.refresh() }
          : unavailableCustom || !catalog ? { message: unavailableCustom ? '此连接已删除，请选择其他模型。' : '先选择或添加一个模型连接。', action: '管理连接', onAction: () => openSettings('models') }
            : !state.cwd ? { message: '尚未选择工作区；模型连接和 CLI 设置仍可独立管理。', action: '查看连接', onAction: () => openSettings('connection') }
              : !custom && !loggedIn && connected ? { message: '官方模型需要先完成账号登录。', action: '登录账号', onAction: () => openSettings('account') }
                : !permitted ? { message: !connected && (!custom || native) ? '本机 Codex CLI 尚未连接。' : native ? '本机 CLI 运行环境暂不可用。' : '当前执行模式尚未开放，不降低安全限制。', action: !connected ? '连接 CLI' : '查看设置', onAction: () => openSettings('connection') }
                  : !loggedIn ? { message: '请先完成模型账号登录。', action: '登录账号', onAction: () => openSettings('account') }
                    : running ? { message: state.approvals.length ? '任务等待操作确认，请先处理审批。' : '任务正在运行，请等待结束或停止。', quiet: view === 'chat' }
                      : busy ? { message: '请求处理中，仍可继续编辑下一条消息。' }
                        : !state.draft.trim() ? { message: '输入消息后发送。', empty: true } : null
      return h('section', { className: 'codex-sidebar', 'aria-label': 'Codex 独立对话', 'data-codex-sidebar': '', 'data-engine': native ? 'native' : 'workspace', 'data-active': info.tab?.active },
        h('header', { className: 'codex-header' },
          h('div', { className: 'codex-brand' }, h('span', { className: 'codex-brand-mark' }, h(Icon, { name: 'spark', size: 17 })), h('strong', null, 'Codex')),
          h('div', { className: 'codex-header-actions' },
            h('button', { type: 'button', className: 'codex-icon-button', 'aria-label': '新建对话', 'aria-disabled': running || busy || undefined, disabled: running || busy, onClick: newConversation }, h(Icon, { name: 'plus', size: 17 })),
            h('nav', { className: 'codex-tabs', 'aria-label': 'Codex 视图' },
              h(Button, { label: '返回对话', 'data-selected': view === 'chat', 'aria-current': view === 'chat' ? 'page' : undefined, onClick: () => setView('chat') }, '对话'),
              h(Button, { label: '历史对话', 'data-selected': view === 'history', 'aria-current': view === 'history' ? 'page' : undefined, onClick: () => setView('history') }, h(Icon, { name: 'history', size: 15 }), '历史'),
              h(Button, { label: 'Codex 设置', 'data-selected': view === 'settings', 'aria-current': view === 'settings' ? 'page' : undefined, onClick: () => setView('settings') }, h(Icon, { name: 'settings', size: 15 }), '设置')))),
        running && h('div', { className: 'codex-running-bar', 'data-compact': view === 'chat', role: 'status' }, h('span', { className: 'codex-status-dot', 'data-status': state.approvals.length ? 'awaitingApproval' : 'inProgress', 'aria-hidden': true }), h('span', null, state.approvals.length ? `待审批 · ${state.approvals.length} 项` : '任务运行中'), view !== 'chat' && h(Button, { onClick: returnToTask, label: '返回运行任务' }, '返回任务'), view !== 'chat' && h(Button, { disabled: !!state.stopping[runningThreadId] || state.disconnected || !state.cwd, onClick: stopTask, label: '停止运行任务' }, h(Icon, { name: 'stop', size: 12 }), '停止')),
        h('details', { className: 'codex-workspace' }, h('summary', null, h('div', { className: 'codex-workspace-name' }, h(Icon, { name: 'folder', size: 16 }), h('strong', null, workspaceName)), h('span', { className: `codex-chip${(native || custom && mode === 'agent') ? ' codex-chip-success' : ''}` }, native ? 'Codex CLI · 原生' : custom ? (mode === 'agent' ? '开发工具已启用' : '仅聊天 · 工具关闭') : '当前工作区')),
          h('div', { className: 'codex-environment-path' }, h('span', null, '当前路径'), h('code', null, state.cwd || (state.phase === 'ready' ? '未选择工作区；连接设置仍可使用' : '正在读取工作区…')), environment?.platform && h('span', { className: 'codex-muted' }, `${({ win32: 'Windows', linux: 'Linux', darwin: 'macOS', android: 'Android' })[environment.platform] || environment.platform}${environment.arch ? ` · ${environment.arch}` : ''}`),
            native && h('span', { className: 'codex-muted' }, '使用应用访问权限；工作区是起始目录，CLI 可访问应用有权访问的其他目录。'),
            h(Button, { label: '检查开发环境', disabled: busy || running, onClick: checkEnvironment }, h(Icon, { name: 'terminal', size: 14 }), checkingEnvironment ? '检查中…' : '检查开发环境'))),
        view === 'chat' && workspaceCustom && mode === 'chat' && h('section', { className: 'codex-mode-banner', 'aria-label': '开发工具未启用' },
          h('div', { className: 'codex-mode-banner-copy' }, h(Icon, { name: 'terminal', size: 18 }), h('div', null, h('strong', null, '当前是仅聊天模式，开发工具未启用'), h('p', null, '启用工作区助手后，模型才能读取文件、确认后写入文件和运行命令。'))),
          h(Button, { primary: true, label: '启用开发工具', disabled: busy || running || unavailableCustom || !(catalog?.supportedModes || ['agent', 'chat']).includes('agent'), onClick: () => enableDevelopmentTools() }, '启用开发工具', h(Icon, { name: 'arrow', size: 14 }))),
        state.disconnected && h('div', { className: 'codex-warning', role: 'status' }, '状态连接中断，正在重连；不会自动重发任务。'),
        state.error && h('div', { className: 'codex-error', role: 'alert' }, state.error, h(Button, { onClick: () => model.refresh() }, '刷新状态')),
        h('div', { className: 'codex-scroll', ref: scroll, onScroll: handleScroll, onWheel: (event) => { if (event.deltaY < 0) pauseFollow() }, onTouchStart: (event) => { touchY.current = event.touches[0]?.clientY }, onTouchMove: (event) => { const y = event.touches[0]?.clientY; if (touchY.current !== null && y > touchY.current) pauseFollow(); touchY.current = y }, onKeyDown: (event) => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pauseFollow() } },
          view === 'history' ? h('section', { className: 'codex-history' }, h('div', { className: 'codex-section-heading' }, h('h3', null, '历史对话'), h('span', { className: 'codex-chip' }, `${state.history.length} 条`)), h('p', { className: 'codex-section-description' }, '继续上次的对话，或创建新的工作区任务。'),
            state.historyError && h('p', { role: 'alert' }, state.historyError),
            state.history.length ? state.history.map((entry) => h(Button, { key: entry.id, label: entry.title, disabled: busy || running || ((entry.engine === 'native' || ['native', 'native-custom'].includes(entry.source)) ? !connected || !state.health.nativeApp?.available : !connected && entry.source !== 'custom' && !entry.model?.startsWith('custom-')), onClick: () => openHistory(entry) }, h('div', { className: 'codex-history-entry' }, h('strong', null, entry.title), h('span', { className: 'codex-muted' }, `${entry.engine === 'native' || ['native', 'native-custom'].includes(entry.source) ? 'Codex CLI' : entry.mode === 'chat' ? '对话' : '工作区助手'}${state.models.find((item) => item.id === entry.model)?.displayName ? ` · ${state.models.find((item) => item.id === entry.model).displayName}` : ''}`)), h(Icon, { name: 'arrow', size: 16 }))) : h('p', { className: 'codex-muted' }, '还没有 Codex 对话。')) :
          view === 'settings' ? h('section', { className: 'codex-settings' },
            h('section', { ref: connectionRef, className: 'codex-connection-settings', 'aria-label': '本机 CLI 连接', tabIndex: -1 },
              h('div', { className: 'codex-section-heading' }, h('h3', { tabIndex: -1 }, '本机 CLI 连接'), h('span', { className: 'codex-chip' }, ({ connected: '已连接', connecting: '连接中', failed: '连接失败', disconnected: '未连接' })[state.health.phase] || '未检测')),
              h('p', { className: 'codex-section-description' }, 'CLI 运行环境与所选模型、工作区独立。工作区助手无需连接 CLI；自定义 CLI 模型无需官方账号。'),
              h('dl', null, h('dt', null, 'CLI 版本'), h('dd', null, state.health.nativeApp?.version || state.health.version || '尚未检测'), h('dt', null, '原生执行环境'), h('dd', null, state.health.nativeApp?.available ? '可用 · 以应用身份运行' : state.health.nativeApp?.reason || '连接后检测'), h('dt', null, '工作区'), h('dd', null, state.cwd || '未选择（不影响连接 CLI 或管理模型）')),
              state.health.reason && h('p', { className: 'codex-muted' }, state.health.reason),
              state.workspaceError && h('p', { className: 'codex-muted', role: 'status' }, typeof state.workspaceError === 'string' ? state.workspaceError : state.workspaceError.message),
              !connected && h('label', { className: 'codex-checkbox-label' }, h('input', { type: 'checkbox', checked: consent, onChange: (event) => setConsent(event.target.checked), disabled: busy }), h('span', null, '我了解：实际发送任务时，需求、选中代码和工具结果会交给所选模型服务。')),
              h('div', { className: 'codex-settings-actions' }, !connected && h(Button, { primary: true, disabled: busy || running || !consent, onClick: () => run(() => model.post('/connect', { consent: true })) }, state.health.phase === 'connecting' ? '连接中…' : '连接本机 Codex CLI'), h(Button, { disabled: busy, onClick: () => run(() => connected ? model.post('/refresh') : model.refresh()) }, '刷新 CLI 状态'), h(Button, { onClick: () => setSheet('access') }, '审批与访问范围')),
              h('p', { className: 'codex-muted' }, '环境可用不代表模型或原生工具已通过验证。权限仅作用于当前对话，以服务声明为准。')),
            h('details', { ref: accountRef, className: 'codex-native-settings' }, h('summary', null, h(Icon, { name: 'terminal', size: 17 }), 'Codex 官方账号', h('span', { className: 'codex-muted' }, state.account?.loggedIn ? '已登录' : '可选')),
              h('p', { className: 'codex-muted' }, '仅使用官方账号模型时需要。凭据保存在应用私有 Codex 数据目录，不复用主对话凭据。'),
              h('dl', null, h('dt', null, '账号'), h('dd', null, state.account?.loggedIn ? state.account.type || '已登录' : '未登录')),
              !connected && h('p', { className: 'codex-muted' }, '先在上方连接本机 CLI，再完成官方账号登录。'),
              h(Button, { disabled: !connected || busy || running, onClick: () => run(async () => setLogin(await model.post('/login', { type: 'chatgptDeviceCode' }))) }, '使用 ChatGPT 登录'),
              login && h('div', { className: 'codex-login' }, loginLink ? h('a', { href: loginLink, target: '_blank', rel: 'noopener noreferrer' }, '打开官方授权页面') : h('span', null, '未返回可识别的官方授权地址'), h('code', null, login.userCode), h(Button, { disabled: busy, onClick: () => run(async () => { await model.post('/login/cancel', { loginId: login.loginId }); setLogin(null) }) }, '取消登录')),
              h('label', null, '或使用官方 API key', h('input', { type: 'password', autoComplete: 'new-password', value: apiKey, onChange: (event) => setApiKey(event.target.value), placeholder: '仅发送给本机 Codex', disabled: busy })),
              h(Button, { disabled: !connected || busy || running || !apiKey.trim(), onClick: () => run(async () => { const key = apiKey; await model.post('/login', { type: 'apiKey', apiKey: key }); setApiKey((current) => current === key ? '' : current) }) }, '保存到 Codex'),
              h(Button, { disabled: !connected || busy, onClick: () => run(() => model.post('/refresh')) }, '刷新账号和官方模型')),
            h('div', { ref: modelsRef, tabIndex: -1 }, h(ModelSettings, { entries: state.customModels || [], disabled: busy || running, form: state.modelForm, onForm: updateModelForm, diagnostics: state.modelDiagnostics || {}, draftDiagnostic: state.draftDiagnostic, check, onCheck: (value) => { setCheck(value); model.update({ modelCheck: value }) }, warnings: state.modelWarnings || [], onSave: saveCustomModel, onDelete: deleteCustomModel, onUse: useCustomModel, onFetch: (values) => inspectModel('/models/fetch', values), onTest: testCustomModel })),
            h('section', { className: 'codex-environment-settings' }, h('div', { className: 'codex-section-heading' }, h('h3', null, '当前工作区环境'), h(Button, { label: '检查开发环境', disabled: busy || running || !state.cwd, onClick: checkEnvironment }, checkingEnvironment ? '检查中…' : '检查开发环境')), h('p', { className: 'codex-section-description' }, state.cwd ? '仅检查当前工作区文件读写、终端、Node、Python 和 Git；不请求模型服务。' : '选择工作区后可检查文件读写和开发工具；不影响上方 CLI 与模型连接设置。'), h(EnvironmentCheck, { result: visibleEnvironmentCheck, resultRef: environmentResult }))) :
          h('div', { className: 'codex-transcript' },
            selectionNotice && h('p', { className: 'codex-muted', role: 'status' }, selectionNotice),
            !selectionNotice && active?.continuedFrom && h('p', { className: 'codex-muted', role: 'status' }, '已在工作区助手中继续之前的聊天。继承的消息作为上下文保留。'),
            h(EnvironmentCheck, { result: visibleEnvironmentCheck, resultRef: environmentResult }),
            unavailableCustom && h('p', { className: 'codex-muted', role: 'status' }, '此模型已删除，仍可查看历史消息。选择其他模型可开始新对话。'),
            active?.historyCursor && h(Button, { disabled: busy || state.disconnected, onClick: loadOlder }, '加载更早的消息'),
            !active && !connected && (!custom || native) ? h('div', { className: 'codex-empty' }, h('h3', null, native ? '连接 Codex CLI' : '在这里与 Codex 对话'), h('p', null, native ? '使用官方 CLI 处理任务。你选中的模型服务将接收需求、上下文和工具结果。' : '在设置中添加自定义模型即可开始对话，也可以连接本机 Codex。'),
              h(Button, { disabled: busy || running, onClick: () => setView('settings') }, '添加自定义模型'),
              h('label', { className: 'codex-consent' }, h('input', { type: 'checkbox', checked: consent, onChange: (event) => setConsent(event.target.checked) }), '我了解实际发送时，需求和选中的代码将交给 Codex 配置的模型服务。'),
              h(Button, { primary: true, disabled: busy || !consent, onClick: () => run(() => model.post('/connect', { consent: true })) }, busy ? '连接中…' : '连接 Codex')) :
            !active ? h('div', { className: 'codex-empty' }, h('span', { className: 'codex-empty-icon' }, h(Icon, { name: mode === 'agent' ? 'spark' : 'link', size: 26 })), h('h3', null, native ? 'Codex 能帮你做什么？' : custom ? (mode === 'agent' ? '一起处理工作区任务' : `与 ${catalog.displayName || catalog.name || catalog.model} 对话`) : '新对话'), h('p', null, native ? loggedIn ? '描述你的目标，让 Codex 制订计划、编辑文件和运行命令。操作按 CLI 规则请求批准。' : '请先在设置中完成 Codex 登录，或选择自定义 CLI 模型。' : custom ? (mode === 'agent' ? '描述你的目标。助手可以查看工作区，修改文件和运行命令前会向你确认。' : '模型会了解当前环境。输入问题即可开始，也可以引用工作区文件。') : loggedIn ? '输入需求，让 Codex 分析和处理当前工作区。' : '请先在设置中完成 Codex 登录。'),
              permitted && loggedIn && h('div', { className: 'codex-suggestions' }, ...suggestions.map((text) => h('button', { key: text, type: 'button', className: 'codex-suggestion', disabled: busy || running, onClick: () => model.update({ draft: text }) }, h('span', null, text), h(Icon, { name: 'arrow', size: 13 })))),
              (custom || native) && h('div', { className: 'codex-empty-context' }, h(Icon, { name: 'folder', size: 15 }), workspaceName)) :
            (active.turns ?? []).map((turn) => h(TurnView, { key: turn.id, thread: active, turn, model, disabled: !!actionBlock, disabledReason: actionBlock, onEdit: editMessage, onRetry: retryTurn, onRevise: reviseTurn, onUndo: prepareUndo })),
            active?.lastError && h('div', { className: 'codex-error', role: 'alert' }, printable(active.lastError)),
            native && connected && !state.health.nativeApp?.available && h('div', { className: 'codex-warning' }, h('strong', null, '原生 Codex CLI 暂不可用'), h('p', null, state.health.nativeApp?.reason || '尚未完成应用执行环境检查。')),
            !native && !custom && connected && !state.health.agent && h('div', { className: 'codex-warning' }, h('strong', null, 'CLI 已连接，但此设备暂不能安全执行'), h('p', null, state.health.reason || '执行隔离尚未通过验证。'), h('p', null, '不会通过关闭沙箱开放操作；当前也未验证无工具对话模式。')))),
        view === 'chat' && unseen && h(Button, { className: 'codex-button codex-new-messages', onClick: jumpLatest }, '有新消息 · 回到最新'),
        view === 'chat' && activeApprovals.length > 0 && h('div', { className: 'codex-approval-stack', role: 'region', 'aria-label': `${activeApprovals.length} 项待审批操作` }, ...activeApprovals.map((entry) => h('section', { key: entry.id, className: 'codex-approval', 'aria-label': '操作确认', 'aria-busy': !!state.approvalBusy[entry.id] },
          h('div', { className: 'codex-approval-heading' },
            h('span', { className: 'codex-approval-icon' }, h(Icon, { name: entry.kind === 'fileChange' ? 'file' : 'terminal', size: 15 })),
            h('div', null, h('strong', null, entry.kind === 'fileChange' ? '允许修改文件？' : entry.kind === 'commandExecution' ? '允许运行这条命令？' : '允许这次操作？'), h('span', { className: 'codex-chip' }, '等待确认'))),
          h('p', { className: 'codex-approval-reason' }, entry.reason || (entry.kind === 'fileChange' ? '模型请求修改下列文件，请核对路径和差异。' : '模型请求执行下列操作，请核对命令与工作目录。')),
          h('div', { className: 'codex-approval-cwd' }, h('span', null, '工作目录'), h('code', null, entry.cwd || active?.cwd || state.cwd || '未提供，请先核对操作范围')),
          entry.command && h('pre', { className: 'codex-command' }, `$ ${entry.command}`),
          entry.diff && h(Diff, { text: entry.diff }),
          entry.path && h('code', { className: 'codex-approval-path' }, entry.path),
          h('p', { className: 'codex-muted' }, entry.source === 'custom' || active?.source === 'custom' ? '只允许本次操作，后续写入和命令仍需确认。' : '只对本次操作生效；后续按 CLI untrusted 规则处理。工作区是起始目录，应用访问范围不变。'),
          h('div', { className: 'codex-approval-actions' },
            h(Button, { disabled: !!state.approvalBusy[entry.id] || state.disconnected || !state.cwd, onClick: () => decideApproval(entry, 'decline') }, '拒绝'),
            h(Button, { disabled: !!state.approvalBusy[entry.id] || state.disconnected || !state.cwd, primary: true, onClick: () => decideApproval(entry, 'accept') }, state.approvalBusy[entry.id] ? '处理中…' : '本次允许'))))),
        view === 'chat' && h('form', { className: 'codex-composer', onSubmit: (event) => { event.preventDefault(); send() } },
          state.files.length > 0 && h('div', { className: 'codex-context' }, ...state.files.map((name) => h('button', { key: name, type: 'button', className: 'codex-context-chip', 'aria-label': `移除 ${name}`, onClick: () => model.update({ files: state.files.filter((entry) => entry !== name) }) }, h(Icon, { name: 'file', size: 12 }), h('span', null, name), h(Icon, { name: 'close', size: 11 })))),
          contextOpen && h('div', { className: 'codex-context-picker' }, h('input', { 'aria-label': '工作区相对文件路径', placeholder: 'src/example.ts', value: file, autoFocus: true, autoCapitalize: 'none', spellCheck: false, onChange: (event) => setFile(event.target.value), onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault(); setContextOpen(false); focusElement(textarea.current) } else if (event.key === 'Enter' && !event.nativeEvent?.isComposing && event.keyCode !== 229) { event.preventDefault(); addContext() } } }), h(Button, { disabled: !file.trim(), onClick: addContext }, '引用')),
          h('textarea', { ref: textarea, 'aria-label': '给 Codex 的消息', 'aria-describedby': sendBlock ? composerReasonId.current : undefined, placeholder: native ? '询问问题，或让 Codex 完成任务…' : custom ? (mode === 'agent' ? '描述任务，让助手帮你处理工作区…' : '输入问题，与所选模型对话…') : '询问问题，或让 Codex 完成任务…', rows: 2, value: state.draft, onChange: (event) => model.update({ draft: event.target.value }), onCompositionStart: () => { composing.current = true }, onCompositionEnd: () => { composing.current = false },
            onKeyDown: (event) => { if (event.key === 'Enter' && !mobileInput && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !composing.current && !event.nativeEvent?.isComposing && event.keyCode !== 229) { event.preventDefault(); send() } } }),
          h('div', { className: 'codex-composer-bar' },
            h('div', { className: 'codex-bar-start' },
              h(Popup, {
                className: 'codex-add-menu', label: '添加上下文', align: 'start', disabled: busy || running,
                summary: [h(Icon, { name: 'plus', size: 16 })],
              },
              h('button', { type: 'button', className: 'codex-menu-option codex-menu-option-inline', onClick: (event) => { setContextOpen(true); closePopup(event) } },
                h('span', { className: 'codex-menu-option-icon' }, h(Icon, { name: 'file', size: 16 })),
                h('span', { className: 'codex-menu-option-copy' }, h('strong', null, '引用工作区文件'), h('span', null, '填写相对路径，随下一条消息发送'))),
              h('button', { type: 'button', className: 'codex-menu-option codex-menu-option-inline', onClick: (event) => { checkEnvironment(); closePopup(event) } },
                h('span', { className: 'codex-menu-option-icon' }, h(Icon, { name: 'terminal', size: 16 })),
                h('span', { className: 'codex-menu-option-copy' }, h('strong', null, '检查开发环境'), h('span', null, '确认文件读写、终端与 Node / Python / Git'))),
              h('button', { type: 'button', className: 'codex-menu-option codex-menu-option-inline', onClick: (event) => { newConversation(); closePopup(event) } },
                h('span', { className: 'codex-menu-option-icon' }, h(Icon, { name: 'plus', size: 16 })),
                h('span', { className: 'codex-menu-option-copy' }, h('strong', null, '新建对话'), h('span', null, '保留当前对话，从空白开始'))),
              h('div', { className: 'codex-menu-section', role: 'group', 'aria-label': '工作模式' },
                h('div', { className: 'codex-menu-head' }, h('strong', null, '工作模式')),
                ...modeChoices.map((entry) => h('button', { key: entry.value, type: 'button', role: 'menuitemradio', 'aria-checked': mode === entry.value, 'aria-label': `工作模式：${entry.value === 'chat' ? '仅聊天' : native ? '原生智能体' : '工作区助手'}`, className: 'codex-menu-option', disabled: busy || running || entry.disabled, onClick: (event) => { chooseMode(entry.value); closePopup(event) } },
                  h('span', { className: 'codex-menu-option-icon' }, h(Icon, { name: entry.icon, size: 16 })),
                  h('span', { className: 'codex-menu-option-copy' }, h('strong', null, entry.value === 'chat' ? '仅聊天' : native ? '原生智能体' : '工作区助手'), h('span', null, entry.description)), mode === entry.value && h(Icon, { name: 'check', size: 14 }))),
                h('p', { className: 'codex-menu-note' }, native ? '原生 CLI 不支持仅聊天，不会自动更换执行器。' : '切换模式会从新对话开始；原对话保留。'))),
              h(ApprovalMenu, { access: active?.access, capabilities: active?.capabilities, native, disabled: !!actionBlock, onLearn: () => setSheet('access'), onChoose: chooseAccess, onCreate: createForAccess })),
            h('div', { className: 'codex-bar-end' },
              h(ModelMenu, { entries: state.models.map((entry) => ({ ...state.customModels?.find((value) => value.id === entry.id), ...entry })), catalog, selectedModel, unavailable: unavailableCustom, disabled: busy || running, onChoose: chooseModel, onManage: () => openSettings('models') }),
              h(EffortMenu, { catalog, effort, disabled: busy || running, onEffort: (value) => { if (reasoningValues(catalog).includes(value)) setEffort(value) } }),
              running
                ? h('button', { type: 'button', className: 'codex-send codex-send-stop', 'aria-label': '停止任务', disabled: !!state.stopping[runningThreadId] || state.disconnected || !state.cwd, onClick: stopTask }, h(Icon, { name: 'stop', size: 15 }))
                : h('button', { type: 'submit', className: 'codex-send', 'aria-label': '发送消息', 'aria-describedby': sendBlock ? composerReasonId.current : undefined, title: sendBlock?.message || '发送消息', disabled: !!sendBlock }, h(Icon, { name: 'up', size: 17 })))),
          sendBlock && h('div', { id: composerReasonId.current, className: sendBlock.empty || sendBlock.quiet ? 'codex-sr-only' : 'codex-send-reason', role: sendBlock.quiet ? undefined : 'status' }, h('span', null, sendBlock.message), sendBlock.action && h('button', { type: 'button', className: 'codex-link', onClick: sendBlock.onAction }, sendBlock.action)),
          h('span', { className: 'codex-input-hint' }, mobileInput ? 'Enter 换行 · 点箭头发送' : 'Enter 发送 · Shift+Enter 换行')),
        view === 'chat' && h('footer', { className: 'codex-footer' }, h(Icon, { name: native || custom && mode === 'agent' ? 'shield' : 'link', size: 13 }), unavailableCustom ? '历史消息可查看 · 选择其他模型开始新对话' : active?.access?.mode === 'full' ? '当前对话完全访问 · 操作不再逐次确认' : active?.access?.mode === 'readonly' ? '当前对话只读 · 禁止写入与命令' : native ? '官方 CLI · 按规则审批 · 文件变更可在记录中查看' : custom ? (mode === 'agent' ? '可读取工作区 · 修改文件和运行命令需确认' : '包含当前环境信息 · 仅对话，不执行操作') : state.health.agent ? '工作区隔离 · 操作按规则确认' : '执行未开放 · 不降低安全限制'),
          sheet === 'access' && h(AccessSheet, { onClose: () => setSheet('') }),
          action && h(ActionSheet, { action, busy, onClose: () => { if (!busy) setAction(null) }, onConfirm: confirmAction, onText: (text) => setAction((value) => ({ ...value, text })), onChecked: (checked) => setAction((value) => ({ ...value, checked })) }))
    }

    function Guide({ title, description, useTabInfo }) {
      const { tab } = useTabInfo()
      return h('button', { className: 'codex-guide', onClick: () => tab.actions.openTab('codex', { replaceTab: true }) }, h('strong', null, title), h('span', null, description))
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        const id = 'dsh-codex-sidebar'
        ctx.effect(() => {
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = `${PREFIX}/style.css`
          link.dataset.plugin = id
          document.head.append(link)
          return () => link.remove()
        }, 'codex-sidebar: styles')
        ctx.effect(() => ctx.locale.register('codexSidebar', { zh: { title: 'Codex' }, en: { title: 'Codex' } }), 'codex-sidebar: locale')
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id, kind: 'codex', multiple: false, keepMounted: true, title: () => 'Codex',
          guide: [{ id: 'open', order: 25, title: () => 'Codex', description: () => '独立对话、模型选择与工作区操作', icon: primitives.PluginArtworkTerminal }],
        }), 'codex-sidebar: tab')
        const getModel = (sessionId) => {
          if (!models.has(sessionId)) models.set(sessionId, createModel(sessionId))
          return models.get(sessionId)
        }
        ctx.effect(() => ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({ name: 'sidebar.right.tab.guide.entry', key: id, locale: 'codexSidebar' }, Guide)), 'codex-sidebar: guide')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id, locale: 'codexSidebar', inject: (sessionId) => ({ model: getModel(sessionId) }) }, CodexBody)), 'codex-sidebar: body')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: id }, () => h('span', null, 'Codex'))), 'codex-sidebar: title')
        ctx.effect(() => () => { for (const model of models.values()) model.dispose(); models.clear() }, 'codex-sidebar: client cleanup')
      },
    }
  },
})
