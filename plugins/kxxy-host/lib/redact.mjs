/**
 * 日志脱敏（缺陷 EB）。
 *
 * ── 事故形状 ──────────────────────────────────────────────────────────────
 *
 * `/kxxy/api/log` 原来是 `readFileSync(engine.log).slice(-64KB)` 原样返回。
 * 而 DSH 每次启动都会往自己的日志里打一行：
 *
 *     dsh web: http://127.0.0.1:3080/?token=…
 *
 * 那个 token 是本次进程的 launch token —— 拿它换一次 cookie 就是完整会话。
 * 再叠上「接口免鉴权」（缺陷 DZ），就形成「匿名读日志 → 拿到有效凭证」的直线。
 *
 * ── 为什么修在读取侧而不是写入侧 ──────────────────────────────────────────
 *
 * 上游每启动一次就写一行，追着擦是徒劳的；而 `engine.log` 在 app 私有目录，
 * 只有同 uid 能读，真正的暴露面就是这个 HTTP 接口。所以：
 * 把它当**出口**治理，而不是当**存储**治理。
 *
 * ⚠️ 这条边界要记住：日志文件里仍然是明文。任何新增的"把日志发出去"的功能
 * （导出、上传、分享）都必须过一遍 `redactLog`。
 *
 * ── 设计取舍 ──────────────────────────────────────────────────────────────
 *
 * · 宁多勿少：多盖掉一段普通文本只是难看，漏掉一个 token 就是事故。
 * · 不删行、不截断行：用户拿日志排障，行数与行内容的结构比"完全干净"更重要。
 * · 顺序有意义：先长规则（URL 参数、头）再短规则（裸 key 形状），否则短规则
 *   会先把 token 打碎，长规则就匹配不上整段了。
 *
 * @module kxxy-host/redact
 */

/** 尾部读取的默认上限（字节）。够排障，又不至于把响应撑大。 */
export const LOG_TAIL_BYTES = 32 * 1024

/**
 * 单条脱敏规则：正则 + 替换。`keep` 是捕获组保留的前缀。
 *
 * 顺序即优先级，见文件头注释。
 */
const RULES = [
  // 1. URL 查询参数里的凭证。配对码单独处理（它也是 code=，但值形状固定）。
  [/([?&](?:token|access_token|api_key|apikey|key|secret|password|passwd|pwd)=)[^&\s"'<>`]+/gi, '$1***'],

  // 2. 远程配对码：/__kxxy_pair?code=8位十六进制
  [/__kxxy_pair\?code=[0-9a-f]{6,16}/gi, '__kxxy_pair?code=***'],

  // 3. Authorization 头（Bearer / Basic 都盖）
  [/(authorization:\s*(?:bearer|basic|token)\s+)\S+/gi, '$1***'],

  // 4. Cookie 头：整行值都算凭证
  [/(cookie:\s*).+/gi, '$1***'],

  // 5. Set-Cookie 的值
  [/(set-cookie:\s*[^=;=\s]+=)[^;\r\n]+/gi, '$1***'],

  // 6. 常见 API key 形状（OpenAI 系）
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***'],

  // 7. GitHub PAT / OAuth token 形状
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, '***'],

  // 8. 裸的 32/40/64 位十六进制串（常见 token / 密钥哈希）——只在像赋值时盖，
  //    避免把 commit sha 也糊掉（仓库里到处是 7 位短 sha，不在此列）。
  [/\b(token|secret|password|api[_a-z]*key)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}["']?/gi, '$1=***'],

  // 9. 家目录绝对路径 → ~（隐私：日志里常带完整私有目录，没必要吐出去）
  [/\/data\/user\/0\/app\.kxxy\/files\/home/g, '~'],
  [/\/data\/user\/\d+\/[^/\s]+\/files\/home/g, '~'],
]

/**
 * 脱敏一段文本。
 *
 * @param {string} text
 * @returns {string}
 */
export function redactLog(text) {
  let out = String(text ?? '')
  for (const [re, rep] of RULES) out = out.replace(re, rep)
  return out
}

/**
 * 取日志尾部：先按字节切，再对齐到行首，最后脱敏。
 *
 * 先脱敏再切会漏掉跨边界的半截 token；先切再脱敏则半行可能留下没头的凭证。
 * 所以顺序是「切 → 对齐行 → 脱敏」，脱敏在最后，看到的是完整行。
 *
 * @param {string} text 全文
 * @param {number} [maxBytes]
 * @returns {{tail: string, lines: number, truncated: boolean}}
 */
export function redactLogTail(text, maxBytes = LOG_TAIL_BYTES) {
  const all = String(text ?? '')
  if (Buffer.byteLength(all, 'utf8') <= maxBytes) {
    const tail = redactLog(all)
    return { tail, lines: tail ? tail.split('\n').length : 0, truncated: false }
  }

  // 按字节切，再从第一个换行处开始 —— 避免把半行（尤其是半个 token）留在开头
  let slice = all.slice(-maxBytes)
  const nl = slice.indexOf('\n')
  if (nl >= 0 && nl < slice.length - 1) slice = slice.slice(nl + 1)

  const tail = redactLog(slice)
  return { tail, lines: tail ? tail.split('\n').length : 0, truncated: true }
}
