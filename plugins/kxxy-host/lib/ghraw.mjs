/**
 * GitHub 直链的「等效接口」绕过（缺陷 EH 的方案 C）。
 *
 * ── 为什么镜像不够 ────────────────────────────────────────────────────────
 *
 * `raw.githubusercontent.com` 在本机被 DNS 返 `0.0.0.0`。之前给的绕法是
 * 换第三方代理（`ghproxy` 之类），但实测发现两件事：
 *
 *   ① 用 DoH 拿到真实 IP（`185.199.109.133`）后 `curl --resolve` 直连，连续
 *      四次全是 `Connection reset` —— **不只是 DNS 层，IP 直连也被重置**；
 *   ② 于是"换个域名前缀"的代理同样可能被同一层拦，实测四个候选常常全军覆没。
 *
 * 而 `api.github.com` / `codeload.github.com` 是通的。所以真正稳的绕法是
 * **换接口而不是换域名**：
 *
 *     raw: https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
 *     api: https://api.github.com/repos/<owner>/<repo>/contents/<path>?ref=<ref>
 *          + Accept: application/vnd.github.raw
 *
 * 同一份内容，走一个没被拦的域名。这一点已经实测（`octocat/Hello-World`）。
 *
 * ── 为什么同时给 bash 助手 ────────────────────────────────────────────────
 *
 * 这个转换对**我们自己的代码**毫无帮助：真正在读 raw 直链的是用户在终端里
 * 跑的 `curl`、`wget`、安装脚本。所以这里产出两个 POSIX sh 脚本，装进
 * `$HOME/.kxxy/bin`（`EngineConfig` 已把它加进 PATH）：
 *
 *     ghraw <raw-url>                    # 直接取内容
 *     ghraw <owner> <repo> <ref> <path>  # 分支名带 / 时用它
 *     echo <raw-url> | raw2api           # 只做 URL 转换，交给别的工具
 *
 * ── 分支名带 `/` 的歧义 ──────────────────────────────────────────────────
 *
 * `/<owner>/<repo>/<ref>/<path>` 里 ref 与 path 的边界在纯文本层面**不可判定**
 * （`main/docs/README.md` 与 `feature/x/README.md` 同形）。所以：
 *   · `apiCandidates()` 按 ref 取 1、2、3 段各给一个候选，依次试到 200；
 *   · shell 版做同样的事（最多三轮）；
 *   · `raw2api` 是纯 sed，只取第一段 —— 它的注释里明说了这个限制。
 *
 * ── 限流 ──────────────────────────────────────────────────────────────────
 *
 * 未认证 `api.github.com` 是 **60 次/小时/IP**，私人仓库必须带 token。所以
 * 脚本读 `GH_TOKEN`（或 `GITHUB_TOKEN`），命中 403/429 时把这条直接说出来，
 * 而不是让人对着一个空输出猜。
 *
 * @module kxxy-host/ghraw
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

/** 助手脚本的目录（相对 `$DSH_HOME`）。`EngineConfig` 的 PATH 里钉的是同一个。 */
export const HELPER_DIR_REL = '.kxxy/bin'

/** 取原始内容的 Accept（GitHub 的 raw 媒体类型）。 */
const RAW_ACCEPT = 'application/vnd.github.raw'

/** 一次 raw URL 最多尝试几个 ref 切分（见文件头的歧义说明）。 */
const MAX_REF_SEGMENTS = 3

/** 把路径里的每一段单独编码，保留分隔符 `/`（整段 encode 会把 `/` 变成 %2F）。 */
function encPath(p) {
  return String(p)
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/')
}

/**
 * 解析 raw URL 成 owner / repo / 剩余片段。
 *
 * 容忍 `?raw=true` 与 `#L12` 这类尾巴 —— 从网页复制链接时很常见，而它们对
 * API 调用毫无意义（fragment 甚至不该发到服务端）。
 *
 * @param {string} rawUrl
 * @returns {{owner: string, repo: string, segments: string[]} | null}
 */
export function parseRawUrl(rawUrl) {
  let s = String(rawUrl ?? '').trim()
  if (!s) return null
  const hash = s.indexOf('#')
  if (hash >= 0) s = s.slice(0, hash)
  const q = s.indexOf('?')
  if (q >= 0) s = s.slice(0, q)

  const m = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+)$/i.exec(s)
  if (!m) return null
  const segments = m[3].split('/').filter(Boolean)
  // 至少要有 `<ref>/<path>`；只有 `<ref>` 是目录请求，走 Contents API 也会变
  // JSON，对我们没有意义。
  if (segments.length < 2) return null
  return { owner: m[1], repo: m[2], segments }
}

/**
 * 拼一个 Contents API 的下载地址。
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ref 分支/标签，可含 `/`
 * @param {string} path 仓库内路径
 * @returns {string}
 */
export function apiUrl(owner, repo, ref, path) {
  const refEnc = String(ref)
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/contents/${encPath(path)}?ref=${refEnc}`
}

/**
 * 整仓下载地址（`codeload`，同域另一台没被拦的机器）。
 *
 * `refKind` 决定是 `refs/heads/` 还是 `refs/tags/`；省略时按分支处理 —— 这也是
 * 绝大多数场景（`main`/`master`）。
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ref
 * @param {'heads'|'tags'} [refKind]
 * @returns {string}
 */
export function codeloadUrl(owner, repo, ref, refKind = 'heads') {
  return `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/tar.gz/refs/${refKind}/${String(ref)
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')}`
}

/**
 * 给出一个 raw URL 的所有候选（ref 取 1..3 段）。
 *
 * 顺序即尝试顺序：短 ref 优先（`main`/`master` 这类最常见，一个请求就中）。
 *
 * @param {string} rawUrl
 * @returns {Array<{ref: string, path: string, url: string}>}
 */
export function apiCandidates(rawUrl) {
  const p = parseRawUrl(rawUrl)
  if (!p) return []
  const out = []
  const max = Math.min(MAX_REF_SEGMENTS, p.segments.length - 1)
  for (let n = 1; n <= max; n += 1) {
    const ref = p.segments.slice(0, n).join('/')
    const path = p.segments.slice(n).join('/')
    out.push({ ref, path, url: apiUrl(p.owner, p.repo, ref, path) })
  }
  return out
}

/** 从响应头里读限流信息（有没有、剩多少），纯展示用。 */
function rateFrom(res) {
  const remaining = res.headers?.get?.('x-ratelimit-remaining')
  const limit = res.headers?.get?.('x-ratelimit-limit')
  if (remaining === null || remaining === undefined) return null
  return { remaining: Number(remaining), limit: Number(limit ?? 0) }
}

/**
 * 取一份 raw 内容（走 API 接口）。
 *
 * 任何失败都返回结构而不是抛：这个函数的存在意义就是"在坏网络里取到东西"，
 * 它自己不能被坏网络带崩。调用方看 `ok` 与 `tried` 决定下一步。
 *
 * @param {string} rawUrl raw.githubusercontent.com 链接
 * @param {object} [opts]
 * @param {string} [opts.token] 默认取 `GH_TOKEN` / `GITHUB_TOKEN`
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok: boolean, via?: string, body?: string, status?: number,
 *   rate?: object|null, tried: Array<{url: string, status?: number, error?: string}>}>}
 */
export async function fetchRaw(rawUrl, opts = {}) {
  const token = opts.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? ''
  const timeoutMs = opts.timeoutMs ?? 8000
  const cands = apiCandidates(rawUrl)
  const tried = []
  if (!cands.length) {
    return { ok: false, tried, error: 'not-a-raw-url' }
  }

  for (const c of cands) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const headers = {
        accept: RAW_ACCEPT,
        'user-agent': 'kxxy-ghraw',
      }
      if (token) headers.authorization = `Bearer ${token}`
      const res = await fetch(c.url, { headers, signal: ctl.signal })
      const rate = rateFrom(res)
      if (res.ok) {
        const body = await res.text()
        tried.push({ url: c.url, status: res.status })
        return { ok: true, via: 'api', ref: c.ref, path: c.path, body, status: res.status, rate, tried }
      }
      tried.push({ url: c.url, status: res.status })
      // 401/403/429 与 ref 猜错无关，再试别的切分只是浪费剩余额度
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        return { ok: false, status: res.status, rate, tried, error: token ? 'forbidden' : 'rate-limited' }
      }
    } catch (e) {
      tried.push({ url: c.url, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e) })
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, status: tried[tried.length - 1]?.status, tried, error: 'not-found' }
}

/**
 * 实测一次 API 路线是否可用（给 netdiag 的体检结论用）。
 *
 * 只取头部 64 字节：能拿到 2xx 就说明这条链路通，正文没必要下。
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, status?: number, ms: number, rate?: object|null, error?: string}>}
 */
export async function probeApiRoute(timeoutMs = 3000) {
  const started = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(apiUrl('git', 'git', 'master', 'README.md'), {
      headers: {
        accept: RAW_ACCEPT,
        range: 'bytes=0-64',
        'user-agent': 'kxxy-ghraw-probe',
      },
      signal: ctl.signal,
    })
    return {
      ok: res.ok || res.status === 206,
      status: res.status,
      ms: Date.now() - started,
      rate: rateFrom(res),
    }
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e),
    }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 装进 $HOME/.kxxy/bin 的两个 shell 助手
// ---------------------------------------------------------------------------

/**
 * `ghraw` —— 用 Contents API 取 raw 文件。
 *
 * 写成 POSIX sh 而不是 node 脚本：读文件这种活 node 启动要 60 ms 以上，而
 * `curl` 就在 runtime 里；更重要的是它在 `mksh`（`/system/bin/sh`）下也能跑。
 * `TMPDIR` 优先（Android 上 `/tmp` 不可写，见体检的 PLATFORM 项）。
 */
const GHRAW_SH = `#!/system/bin/sh
# [kxxy] ghraw —— 用 GitHub Contents API 读 raw 文件。
#
# raw.githubusercontent.com 在部分网络里被 DNS 返 0.0.0.0，且拿真实 IP 直连
# 也会被 reset；而 api.github.com 是通的。这个脚本把同一份内容换个接口取。
#
#   ghraw <raw-url>
#   ghraw <owner> <repo> <ref> <path>
#
# 环境变量 GH_TOKEN（或 GITHUB_TOKEN）可提高限流额度：未认证 60 次/小时，按 IP 计。
set -u

err() { echo "ghraw: $*" >&2; }

fetch() { # $1=owner $2=repo $3=ref $4=path
  _o=$1; _r=$2; _ref=$3; _p=$4
  _api="https://api.github.com/repos/$_o/$_r/contents/$_p?ref=$_ref"
  _tmp="\${TMPDIR:-/data/local/tmp}/ghraw.\$\$"
  if [ -n "\${GH_TOKEN:-}" ]; then
    _code=$(curl -sSL --max-time 60 -H 'Accept: application/vnd.github.raw' \\
      -H "Authorization: Bearer \$GH_TOKEN" -o "\$_tmp" -w '%{http_code}' "\$_api" 2>/dev/null)
  elif [ -n "\${GITHUB_TOKEN:-}" ]; then
    _code=$(curl -sSL --max-time 60 -H 'Accept: application/vnd.github.raw' \\
      -H "Authorization: Bearer \$GITHUB_TOKEN" -o "\$_tmp" -w '%{http_code}' "\$_api" 2>/dev/null)
  else
    _code=$(curl -sSL --max-time 60 -H 'Accept: application/vnd.github.raw' \\
      -o "\$_tmp" -w '%{http_code}' "\$_api" 2>/dev/null)
  fi
  case "\$_code" in
    200)
      cat "\$_tmp"
      rm -f "\$_tmp"
      return 0
      ;;
    404)
      rm -f "\$_tmp"
      return 1
      ;;
    401|403|429)
      err "HTTP \$_code：额度用完或被拒（未认证 60 次/小时，按 IP 计）"
      err "设 GH_TOKEN=<personal access token> 后重试"
      rm -f "\$_tmp"
      exit 3
      ;;
    *)
      err "HTTP \$_code (\$_api)"
      rm -f "\$_tmp"
      return 1
      ;;
  esac
}

if [ \$# -eq 4 ]; then
  if fetch "$1" "$2" "$3" "$4"; then exit 0; fi
  err "取不到：$1/$2@$3:$4"
  exit 1
fi

if [ \$# -ne 1 ]; then
  err "用法: ghraw <raw-url> | ghraw <owner> <repo> <ref> <path>"
  exit 2
fi

_url=$1
case "\$_url" in
  *raw.githubusercontent.com/*) ;;
  *)
    err "不是 raw.githubusercontent.com 链接：\$_url"
    exit 2
    ;;
esac

_rest=\${_url#*raw.githubusercontent.com/}
_owner=\${_rest%%/*}
_rest=\${_rest#*/}
if [ "\$_owner" = "\$_rest" ] || [ -z "\$_owner" ]; then
  err "链接缺少 owner/repo：\$_url"
  exit 2
fi
_repo=\${_rest%%/*}
_rest=\${_rest#*/}
if [ "\$_repo" = "\$_rest" ] || [ -z "\$_repo" ]; then
  err "链接缺少 ref/path：\$_url"
  exit 2
fi

# 分支名可能带 /（feature/x），纯文本判不出边界，按 1→3 段依次试。
_head=""
_tries=0
while [ "\$_tries" -lt 3 ]; do
  case "\$_rest" in
    */*) ;;
    *) break ;;
  esac
  _seg=\${_rest%%/*}
  _rest=\${_rest#*/}
  if [ -z "\$_head" ]; then _head="\$_seg"; else _head="\$_head/\$_seg"; fi
  if fetch "\$_owner" "\$_repo" "\$_head" "\$_rest"; then exit 0; fi
  _tries=\$((_tries + 1))
done

err "取不到：\$_owner/\$_repo（试了 \$_tries 个 ref 切分）"
err "分支名带 / 时改用：ghraw <owner> <repo> <ref> <path>"
exit 1
`

/**
 * `raw2api` —— 只做 URL 转换，输出交给别的工具（`xargs curl` 之类）。
 *
 * 刻意保持成一条 sed：它的价值是"能塞进管道"，不是再写一遍 ghraw。
 * 分支名带 `/` 时取第一段（见注释）。
 */
const RAW2API_SH = `#!/system/bin/sh
# [kxxy] raw2api —— 把 raw URL 换成等价的 Contents API URL。
#
#   echo https://raw.githubusercontent.com/o/r/main/a/b.txt | raw2api
#   raw2api <raw-url>
#
# ⚠️ 分支名带 / 时这个纯文本替换判不出边界，会取第一段。那种情况用
#    ghraw <owner> <repo> <ref> <path>
if [ \$# -ge 1 ]; then
  printf '%s\\n' "$1"
else
  cat
fi | sed -E 's#^https?://raw\\.githubusercontent\\.com/([^/]+)/([^/]+)/([^/]+)/(.*)\$#https://api.github.com/repos/\\1/\\2/contents/\\4?ref=\\3#'
`

/** 助手脚本的真值表：文件名 → 内容。自检（selftest）也用它列名单。 */
export const HELPERS = [
  { name: 'ghraw', body: GHRAW_SH },
  { name: 'raw2api', body: RAW2API_SH },
]

/**
 * 把两个助手脚本写进 `$DSH_HOME/.kxxy/bin`（幂等：内容一致就不碰文件）。
 *
 * 为什么是插件写而不是原生写：脚本内容需要和这里的 URL 转换逻辑保持一致，
 * 放两处必然漂移。原生只负责把这个目录加进 PATH。
 *
 * @param {string} home `$DSH_HOME`
 * @returns {{ok: boolean, dir: string, written: string[], unchanged: string[], error?: string}}
 */
export function installHelpers(home) {
  const dir = home ? join(home, HELPER_DIR_REL) : ''
  const out = { ok: false, dir, written: [], unchanged: [] }
  if (!dir) {
    out.error = 'DSH_HOME 未知'
    return out
  }
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch (e) {
    out.error = `建目录失败：${e?.message ?? e}`
    return out
  }

  for (const h of HELPERS) {
    const file = join(dir, h.name)
    try {
      let same = false
      if (existsSync(file)) {
        try {
          same = readFileSync(file, 'utf8') === h.body
        } catch {
          same = false
        }
      }
      if (!same) {
        writeFileSync(file, h.body, { mode: 0o755 })
        out.written.push(h.name)
      } else {
        out.unchanged.push(h.name)
      }
      // writeFileSync 的 mode 只在新建时生效；已存在但没执行位的情况（解包工具
      // 常见）要补一次 chmod，否则 `ghraw` 会报 Permission denied。
      try {
        chmodSync(file, 0o755)
      } catch {
        // 某些文件系统不支持 chmod：报出来比假装成功好，但不阻断另一条
      }
    } catch (e) {
      out.error = `写 ${h.name} 失败：${e?.message ?? e}`
    }
  }
  out.ok = !out.error
  return out
}
