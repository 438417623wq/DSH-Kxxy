/**
 * `theme.css` 抽取与浅色主题的回归测试。
 *
 * 事故背景（0.9.57）：`build-runtime.mjs` 用「配对双引号」的正则去上游主题模块里
 * 捞 CSS 片段，而那份模块把 CSS 放在**模板字面量**里、代码里另有双引号，于是
 * 抓出来的片段夹着 `` `;var design_platform_css_default=` `` 这种 JS 胶水。浏览器
 * 解析到反引号会把整条规则丢弃 —— 被丢掉的是浅色那套 `body{--dsw-static-*}`，
 * alias 层引用的 static 随之失效，host.css 的兜底全部落到深色值：
 *
 *   深色主题 → 另有一套字面量，看着正常；浅色主题 → 整页发黑、顶栏白底白字。
 *
 * 四个断言组：
 *   [1] 抽取器只认字符串字面量，模板插值/正则/注释里的引号不许把扫描带偏；
 *   [2] 生成物里不许出现反引号、`var x=`、未定义的 `var(--dsw-*)` 引用；
 *   [3] 仓库里**已提交**的 theme.css 必须通过同一套自检（防止手工改坏后直接发布）；
 *   [4] host.css 的兜底值必须分深浅色 —— 否则 token 再丢一次，浅色还是回落到深色。
 *
 * 用法：node tools/test-theme-css.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertThemeCss,
  buildThemeCss,
  stringLiterals,
  themeCssFromAsarFiles,
} from './lib/theme-css.mjs'

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = join(PROJECT, 'plugins', 'kxxy-host', 'web')

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass += 1
  else {
    fail += 1
    console.log(`FAIL ${label}\n  期望 ${JSON.stringify(expected)}\n  实得 ${JSON.stringify(actual)}`)
  }
}

/** 复刻上游模块的真实形状：CSS 在模板字面量里，代码里另有双引号、正则与嵌套模板。 */
const CLIENT_JS = `
var base_css_default = ":root{--dsh-font-family-text-default:-apple-system}";
var design_platform_css_default = \`body{--dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-950:#151517}
body[data-ds-dark-theme]{--dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-950:#151517}
body{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00);--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-950)}
body[data-ds-dark-theme]{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950);--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-00)}\`;
var tip = \`共 \${count} 项，\${settings.map((s) => \`<\${s.key}>\`).join(', ')} 已启用\`;
var re = /"([^"]+)"/g;
var trailing = 'body{--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-00)}';
`

// [1] 抽取器行为
const fragments = stringLiterals(CLIENT_JS)
check('只收集含 token 的字符串字面量', fragments.length, 2)
check('模板字面量整段拿到（不含 JS 胶水）', fragments[0].startsWith('body{--dsw-static-neutral-bluish-00:#fff'), true)
check('正则里的引号没有把扫描带偏', fragments.every((f) => !f.includes('var ')), true)

const { css, blocks } = buildThemeCss(fragments)
check('token 块全部识别（浅/深 × static/alias + 零散单条）', blocks.length, 5)
check('浅色 static 块在位', css.includes('--dsw-static-neutral-bluish-00:#fff'), true)
check('深色块在位', css.includes('body[data-ds-dark-theme]{--dsw-alias-bg-base'), true)
check('输出不含反引号', css.includes('`'), false)

// 事故产物（0.9.57 的 theme.css 前两条 token 块）必须被自检拒收
const broken = `/* header */
body{--dsw-static-neutral-bluish-00:#fff}
\`;var design_platform_css_default=\`body{--dsw-static-neutral-bluish-950:#151517}
body{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00)}
`
let rejected = ''
try {
  assertThemeCss(broken)
} catch (error) {
  rejected = error.message
}
check('自检能拒收混入 JS 胶水的产物', rejected.includes('反引号'), true)
check('自检能指出未定义的 token 引用', (() => {
  const missing = '/* header */\nbody{--dsw-static-neutral-bluish-00:#fff}\nbody[data-ds-dark-theme]{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950)}\n'
  try {
    assertThemeCss(missing.replace('--dsw-alias-bg-base', '--dsw-alias-bg-layer-1'))
    return ''
  } catch (error) {
    return error.message
  }
})().includes('未定义的 token'), true)

// [3] 工作区里的产物（theme.css 是构建期生成物、不进版本库，冷仓库里可能没有）
const themeCssPath = join(WEB, 'theme.css')
if (existsSync(themeCssPath)) {
  const shipped = readFileSync(themeCssPath, 'utf8')
  let shippedError = ''
  try {
    assertThemeCss(shipped)
  } catch (error) {
    shippedError = error.message
  }
  check('工作区的 theme.css 通过自检', shippedError, '')
  check('工作区的 theme.css 含浅色 static 层', shipped.includes('--dsw-static-neutral-bluish-00:'), true)
  check('工作区的 theme.css 含深色 alias 层', shipped.includes('body[data-ds-dark-theme]{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950)'), true)
} else {
  console.log('跳过：工作区没有 theme.css（未跑过构建装配）')
}

// [4] host.css 的兜底必须分主题
const hostCss = readFileSync(join(WEB, 'host.css'), 'utf8')
check('兜底不使用写死的深色值', /--dsw-alias-bg-base,\s*#151517/.test(hostCss), false)
check('兜底按 data-ds-dark-theme 分套', hostCss.includes('body[data-ds-dark-theme] {\n  --fb-bg-base: #151517;'), true)
check('浅色兜底是浅色', hostCss.includes('--fb-bg-base: #ffffff;'), true)

// [2] 有上游 asar 时跑一遍真实抽取（构建机上才有，缺失不算失败）
const asarPath = join(PROJECT, '.cache', 'dsh-rb3', 'app', 'resources', 'app.asar')
if (existsSync(asarPath)) {
  const { openAsar } = await import('./lib/registry.mjs')
  const asar = openAsar(asarPath)
  const data = asar.readFile('/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js')
  const real = themeCssFromAsarFiles(new Map([['dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js', { data }]]))
  check('真实 asar 能抽出 token 块', real.blocks >= 6, true)
  check('真实产物无反引号', real.css.includes('`'), false)
  check('真实产物含浅色 static 层', real.css.includes('--dsw-static-neutral-bluish-00:#fff'), true)
} else {
  console.log('跳过：没有 .cache/dsh-rb3/…/app.asar（真实抽取只在构建机验证）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
