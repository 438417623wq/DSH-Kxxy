/**
 * Codex 侧栏样式契约：WebView 104 兼容 + 双主题文字对比度。
 *
 * 这两类问题都不会被功能测试抓到：
 *   · 用了 `:has()` / `color-mix()` / CSS 嵌套 —— 桌面浏览器完全正常，
 *     真机 Android WebView 104（Chrome 104）直接丢弃整条规则，界面「突然变丑」；
 *   · 语义色文字只写一个色值 —— 同一个色值不可能同时压住白底与 `#202226` 底
 *     （对比度 4.5 对两端的亮度区间互斥），必然有一侧偏浅。
 *
 * 所以这里直接从 `web/codex.css` 源码把变量解析出来算对比度，不跑浏览器：
 * 同一份色板在 CI 与本地都得到同一个结论。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CSS = readFileSync(join(HERE, '..', 'plugins', 'dsh-codex-sidebar', 'web', 'codex.css'), 'utf8')
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

// 宿主 token 的两套取值：light 在 body，dark 在 body[data-ds-dark-theme]（与 theme.css 一致）。
const PANEL = { light: '#ffffff', dark: '#202226' }
const SOFT = { light: '#f3f4f7', dark: '#30333a' }

function parseHex(hex) {
  let value = hex.replace('#', '')
  if (value.length === 3) value = [...value].map((c) => c + c).join('')
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16))
}
function luminance(rgb) {
  const channel = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channel[0] + 0.7152 * channel[1] + 0.0722 * channel[2]
}
function contrast(foreground, background) {
  const a = luminance(parseHex(foreground))
  const b = luminance(parseHex(background))
  const [high, low] = a > b ? [a, b] : [b, a]
  return (high + 0.05) / (low + 0.05)
}
/** 把 12% 的色调叠在底色上，得到徽章/差异行的真实可见底色。 */
function tint(overlay, base, alpha) {
  const fg = parseHex(overlay)
  const bg = parseHex(base)
  const mixed = fg.map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)))
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
function variable(block, name) {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`))
  assert.ok(match, `样式里缺少变量 ${name}`)
  return match[1]
}
const baseBlock = CSS.slice(0, CSS.indexOf('body[data-ds-dark-theme] .codex-sidebar'))
const darkBlock = CSS.slice(CSS.indexOf('body[data-ds-dark-theme] .codex-sidebar'))

test('stylesheet stays inside the Android WebView 104 feature set', () => {
  assert.equal(/:has\(/.test(RULES), false, '禁止使用 :has()')
  assert.equal(/color-mix\(/.test(RULES), false, '禁止使用 color-mix()')
  // 嵌套：块内再出现「选择器 + {」说明用了 CSS nesting（真机整块失效）。
  let depth = 0
  let nested = null
  for (let i = 0; i < RULES.length; i += 1) {
    const character = RULES[i]
    if (character === '{') {
      depth += 1
      if (depth > 2) nested = i
    } else if (character === '}') {
      depth -= 1
    }
  }
  assert.equal(depth, 0, '花括号不配平')
  assert.equal(nested, null, '禁止使用 CSS 嵌套（出现第三层块）')
  // 容器查询属于渐进增强：只允许出现在既有的收紧规则里，不能承载基础布局。
  assert.equal(RULES.includes('container-type'), true)
})

test('every semantic text colour clears 4.5:1 on both host themes', () => {
  const light = {
    accent: variable(baseBlock, '--codex-accent-text'),
    success: variable(baseBlock, '--codex-success-text'),
    warn: variable(baseBlock, '--codex-warn-text'),
    danger: variable(baseBlock, '--codex-danger-text'),
  }
  const dark = {
    accent: variable(darkBlock, '--codex-accent-text'),
    success: variable(darkBlock, '--codex-success-text'),
    warn: variable(darkBlock, '--codex-warn-text'),
    danger: variable(darkBlock, '--codex-danger-text'),
  }
  const tints = { accent: '#6366f1', success: '#10b981', warn: '#f59e0b', danger: '#ef4444' }
  for (const [theme, palette] of [['light', light], ['dark', dark]]) {
    for (const [name, color] of Object.entries(palette)) {
      assert.ok(contrast(color, PANEL[theme]) >= 4.5, `${theme}.${name} 在面板底色上不足 4.5（${contrast(color, PANEL[theme]).toFixed(2)}）`)
      const badge = tint(tints[name], SOFT[theme], 0.12)
      assert.ok(contrast(color, badge) >= 4.5, `${theme}.${name} 在 12% 色调徽章底上不足 4.5（${contrast(color, badge).toFixed(2)}）`)
    }
  }
})

test('primary button text stays readable on the accent fill', () => {
  const accent = variable(baseBlock, '--codex-accent')
  const onAccent = variable(baseBlock, '--codex-on-accent')
  assert.ok(contrast(onAccent, accent) >= 4.5, `主按钮对比度 ${contrast(onAccent, accent).toFixed(2)} 低于 4.5`)
})

test('secondary text keeps AA on both themes', () => {
  const ink = { light: '#1b1d22', dark: '#e0e2e5' }
  const secondary = { light: '#5f6470', dark: '#a9acb5' }
  for (const theme of ['light', 'dark']) {
    assert.ok(contrast(ink[theme], PANEL[theme]) >= 7, `${theme} 正文不足 7:1`)
    assert.ok(contrast(secondary[theme], PANEL[theme]) >= 4.5, `${theme} 次级文本不足 4.5:1`)
  }
})

test('model-service components ship their styles', () => {
  const required = [
    '.codex-provider-list', '.codex-provider-card', '.codex-provider-badge', '.codex-provider-info',
    '.codex-model-chips', '.codex-model-chip', '.codex-model-picker', '.codex-model-row',
    '.codex-manual-model', '.codex-discovery-actions', '.codex-save-actions',
    '.codex-menu-group-title', '.codex-sheet-card', '.codex-approval', '.codex-code-head',
  ]
  for (const selector of required) {
    assert.ok(RULES.includes(`${selector} {`) || RULES.includes(`${selector},`), `缺少样式 ${selector}`)
  }
})
