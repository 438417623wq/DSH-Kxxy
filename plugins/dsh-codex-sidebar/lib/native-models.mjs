import { CodexError } from './transport.mjs'
import { providerHeaders } from './provider-config.mjs'

/** This configuration exists only in server-side ThreadStart/ThreadResume requests. */
export function nativeProviderParameters(provider, { bridge = null } = {}) {
  if (provider.engine !== 'native') throw new CodexError('engine-change', '此模型未配置为原生 Codex，请在设置中选择引擎并新建对话', 409)
  if (provider.apiFormat !== 'responses' && !bridge) throw new CodexError('model-format', '此协议需要本机 Responses 兼容桥，请重新连接 Codex')
  const modelProvider = `kxxy_${provider.id}`
  const headers = providerHeaders(provider, { json: false, stream: false })
  for (const name of Object.keys(headers)) if (['accept', 'content-type'].includes(name.toLowerCase())) delete headers[name]
  const bearer = bridge ? bridge.apiKey : (provider.authType ?? 'bearer') === 'bearer' ? provider.apiKey : null
  if (bearer) for (const name of Object.keys(headers)) if (name.toLowerCase() === 'authorization') delete headers[name]
  const configuration = {
    name: provider.name,
    base_url: bridge?.baseUrl ?? provider.baseUrl,
    wire_api: 'responses',
    ...(bearer ? { experimental_bearer_token: bearer } : {}),
    ...(!bridge && Object.keys(headers).length ? { http_headers: headers } : {}),
    ...(!bridge && Object.keys(provider.query ?? {}).length ? { query_params: provider.query } : {}),
    requires_openai_auth: false,
    supports_websockets: false,
    request_max_retries: 0,
    stream_max_retries: 0,
    ...(bridge ? { capabilities: { remote_compaction: 'unsupported', external_web_access: false }, supports_standalone_web_search: false } : {}),
  }
  return {
    model: provider.model,
    modelProvider,
    config: {
      [`model_providers.${modelProvider}`]: configuration,
      ...(bridge ? { web_search: 'disabled', 'features.tool_search': false, 'features.responses_websockets': false, 'features.responses_websockets_v2': false } : {}),
    },
  }
}

export function nativeExecutionParameters(health, mode, approvalPolicy = 'untrusted', { accessMode = 'approval' } = {}) {
  if (mode !== 'agent') throw new CodexError('mode-invalid', '原生 Codex CLI 当前仅支持智能体模式')
  // The third argument is untrusted client input; it can never enable full access.
  if (approvalPolicy !== 'untrusted') throw new CodexError('approval-policy', '此版本保留 Codex CLI 的 untrusted 用户审批策略')
  if (!['approval', 'readonly', 'full'].includes(accessMode)) throw new CodexError('access-mode', '未知的访问权限模式')
  if (accessMode === 'readonly') throw new CodexError('access-unsupported', '当前原生 Android 应用执行环境不支持可靠的只读沙箱，请使用工作区只读模式', 409)
  if (!health?.available) throw new CodexError('execution-unavailable', health?.reason || '请先连接并验证原生 Codex CLI 应用权限能力', 503)
  return { approvalPolicy: accessMode === 'full' ? 'never' : 'untrusted', approvalsReviewer: 'user', sandbox: 'danger-full-access' }
}
