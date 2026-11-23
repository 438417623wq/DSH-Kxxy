/**
 * 构建期脚本模板的读入：一律按 LF 交出去。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────────────
 *
 * `tools/prebuilt/wrappers/*.sh`、`tools/prebuilt/kxxy-tools/*.py` 会被原样打进
 * 运行时、装到手机上**直接 exec**（`/system/bin/sh` 或解释器读 shebang）。这些
 * 文件又是在 Windows 上编辑的：只要某个编辑器/工具把它写成 CRLF，shebang 就变成
 * `#!/system/bin/sh\r` —— 内核会去找一个叫 `sh\r` 的解释器，报的是
 * `No such file or directory`。用户看到的是「预置失败」，而且
 * `.gitattributes` 的 `* text=auto eol=lf` 会把这层差异在 `git diff` / `git status`
 * 里抹平，**提交前根本看不出来**（`git show :<path>` 是 LF，工作区却是 CRLF）。
 *
 * 真机事故（v0.9.79）：`extensions/glibc/bin/kxxy-glibc-provision` 163 行全是
 * CRLF，于是 `python -V`、`dotnet`、`julia`、`wkhtmltopdf` 的首次预置全部
 * exit 127，整套 Python 科学计算栈跟着不可用。
 *
 * ── 为什么是「归一化 + 警告」而不是「直接报错」 ────────────────────────────
 *
 * 报错会让构建在最后一步炸掉（而且报错位置与真正的原因隔了十几分钟），修的人
 * 还得先意识到是换行符。归一化成 LF 得到的字节**正是 git 索引里的那份**，所以
 * 既不影响产物正确性，也不会掩盖问题 —— 警告里带文件名和行数，源文件该修还是要
 * 修（`git checkout -- <path>` 或编辑器切 LF）。
 *
 * @module tools/lib/script-source
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

/** 本轮已经警告过的文件，避免同一个模板被读三次就刷三遍。 */
const warned = new Set()

/**
 * 把文本里的 CRLF（以及孤立 CR）归一化成 LF。
 *
 * 孤立 CR 也要处理：老式 Mac 换行同样是「文件里多一个不可见字符」，
 * shell 里一样是语法错。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeScriptText(text) {
  return String(text).replace(/\r\n?/g, '\n')
}

/**
 * 读一个脚本模板，保证返回值是 LF。
 *
 * @param {string} file 绝对路径
 * @param {string} [label] 警告里显示的名字（默认相对 cwd 的路径）
 * @returns {string}
 */
export function readScriptText(file, label) {
  const raw = readFileSync(file, 'utf8')
  if (!raw.includes('\r')) return raw
  const name = label ?? relative(process.cwd(), file)
  if (!warned.has(file)) {
    warned.add(file)
    const lines = (raw.match(/\r\n/g) ?? []).length
    console.warn(
      `      ! ${name} 是 CRLF（${lines} 行），已按 LF 打进运行时 —— ` +
      '源文件该修（编辑器切 LF 或 `git checkout -- <path>`），否则直接 exec 会报 ' +
      '「No such file or directory」',
    )
  }
  return normalizeScriptText(raw)
}

/** 已警告的文件名（测试/自检用）。 */
export function crlfWarnedFiles() {
  return [...warned]
}
