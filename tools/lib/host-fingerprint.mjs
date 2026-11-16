/** 与全量装配共用的宿主内容指纹；入口标记和指纹文件不参与自指。 */
import { createHash } from 'node:crypto'

export const HOST_PLUGIN_BASE = 'lib/node_modules/kxxy-host/'
export const HOST_MARK_LINE_RE = /^\/\* kxxy-host@[^\n]*?\*\/\r?\n/
const digest = (data) => createHash('sha256').update(data).digest('hex')

export function stampHostPluginFingerprint(files) {
  const rows = []
  for (const [path, file] of files) {
    if (!path.startsWith(HOST_PLUGIN_BASE) || path === `${HOST_PLUGIN_BASE}lib/.fingerprint`) continue
    const rel = path.slice(HOST_PLUGIN_BASE.length)
    const data = rel === 'lib/index.js'
      ? Buffer.from(file.data.toString('utf8').replace(HOST_MARK_LINE_RE, '')) : file.data
    rows.push(`${rel}\0${digest(data)}`)
  }
  if (!rows.length) throw new Error('宿主插件树为空，无法计算指纹')
  const fingerprint = digest(Buffer.from(rows.sort().join('\n')))
  const path = `${HOST_PLUGIN_BASE}lib/index.js`
  const entry = files.get(path)
  if (!entry) throw new Error(`缺少插件入口：${path}`)
  const body = entry.data.toString('utf8').replace(HOST_MARK_LINE_RE, '')
  files.set(path, { ...entry, data: Buffer.from(`/* kxxy-host@${fingerprint.slice(0, 12)} */\n${body}`) })
  files.set(`${HOST_PLUGIN_BASE}lib/.fingerprint`, {
    data: Buffer.from(`algorithm:sha256\nfingerprint:${fingerprint}\nfiles:${rows.length}\nmarker:kxxy-host@${fingerprint.slice(0, 12)}\n`), mode: 0o644,
  })
  return fingerprint
}
