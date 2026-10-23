// 层叠验证：把 compat.js 里真实的 MOBILE_LAYOUT_CSS 抽出来，铺进一个模仿
// 真实宿主的 DOM + 模仿插件那几条 !important 规则的页面上，用无头 Chromium
// 读 computed style。目的是在重打 1.9 GB APK 之前先证明选择器真的命中。
//
// 生成两份夹具：
//   a = 带上插件自己打的 data-mobile-nav="stats"（容器锚点 A 生效）
//   b = 不带该属性，只留宿主自己的 data-composer-stat（只有锚点 B 能救）
// 两份的期望结果必须一样 —— 否则「插件改了属性名就静默失效」这条退路是假的。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const compat = readFileSync(join(ROOT, 'plugins/kxxy-host/web/compat.js'), 'utf8')

// 抽出 `var MOBILE_LAYOUT_CSS = [ ... ].join('\n')` 的数组字面量，直接求值 ——
// 拿到的一定是随产物发出去的那份文本，不是手抄版。
const start = compat.indexOf('var MOBILE_LAYOUT_CSS = [')
if (start < 0) throw new Error('compat.js 里找不到 MOBILE_LAYOUT_CSS')
const end = compat.indexOf("].join('\\n')", start)
if (end < 0) throw new Error('MOBILE_LAYOUT_CSS 的数组没闭合')
const literal = compat.slice(start + 'var MOBILE_LAYOUT_CSS = '.length, end + 1)
const rules = new Function(`return ${literal}`)()
const ours = rules.join('\n')

// 宿主侧真实样式（摘自 dsh-client-ui-chat/StatsPills、ui-agent-preset/
// AgentPresetLabel、ui-conversation 的 titleRow，只裁掉无关段）。
const hostCss = `
.ueqFMa_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:20px;display:inline-flex}
.ueqFMa_pill{box-sizing:border-box;border-radius:6px;max-width:100%;color:#888;font:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.ueqFMa_label{text-overflow:ellipsis;min-width:0;overflow:hidden}
.ueqFMa_sep{color:#ccc;margin:0 6px}
.f8BMvq_label{border-radius:4px;background:#f2f2f2;max-width:180px;height:22px;color:#888;white-space:nowrap;align-items:center;gap:4px;padding:0 2px 0 0;font-size:12px;line-height:22px;display:inline-flex;overflow:hidden}
.f8BMvq_icon{opacity:.7;flex:none}
._727C8a_titleRow{min-height:30px;align-items:center;gap:0;display:flex;container-type:inline-size}
._727C8a_headerCorner{margin-left:auto;margin-right:-16px}
._727C8a_headerActions{display:flex;align-items:center;gap:6px}
header{display:block}
.statsRow{display:flex;align-items:center}
`

// 插件侧那几条会和我们抢的属性（原文摘自 dsh-web-mobile/lib/client.js）。
const pluginCss = `
[data-mobile-nav="frame"] [data-phase] header:has([class*="_headerLeading"]) > :first-child > :last-child[class*="_headerCorner"] {
  display: flex !important;
  flex: 0 0 auto !important;
  margin-left: 4px !important;
  margin-right: 0 !important;
}
[data-mobile-nav="frame"] [data-phase] [data-mobile-nav="stats"] [class*="_sep"] { margin: 0 2px !important; }
[data-mobile-nav="frame"] [data-phase] [data-mobile-nav="stats"] [class*="_pill"] {
  padding-left: 6px !important;
  padding-right: 6px !important;
}
`

const makeHtml = (statsAttr) => `<!doctype html>
<html><head><meta charset="utf-8">
<style>${hostCss}</style>
<style>${pluginCss}</style>
<style data-kxxy-mobile-layout>${ours}</style>
</head><body>
<div data-mobile-nav="frame"><div data-phase="idle">
<header>
  <div class="row">
    <div class="_727C8a_titleRow titleRow">
      <div class="_headerLeading" data-header-leading>&#9776;</div>
      <div class="titleCluster">&#36816;&#34892;&#25991;&#20214;&#22841;&#20013;&#30340;&#24037;&#20855;&#38598;</div>
      <div class="_727C8a_headerActions _headerActions headerActions">
        <span class="f8BMvq_label"><svg class="f8BMvq_icon" width="14" height="14"></svg>&#26631;&#20934;&#27169;&#24335;</span>
      </div>
      <div class="_727C8a_headerCorner _headerCorner" data-conversation-header-corner><button>corner</button></div>
    </div>
  </div>
</header>
<div class="statsRow"${statsAttr}>
  <span class="ueqFMa_anchor" data-composer-stat="activity"><span class="ueqFMa_pill"><span class="ueqFMa_label">1 &#36718; 23 &#27493; &middot; 15 &#31186;</span></span></span>
  <span class="ueqFMa_sep">&#183;</span>
  <span class="ueqFMa_anchor" data-composer-stat="usage"><span class="ueqFMa_pill"><span class="ueqFMa_label">396K tok &middot; &#32531;&#23384; 91%</span></span></span>
  <span class="pct">3%</span>
</div>
</div></div>
<pre id="result"></pre>
<script>
const r = [];
const q = (s) => document.querySelector(s);
const cs = (el, p) => el === null ? 'MISSING' : getComputedStyle(el).getPropertyValue(p);
r.push('viewportWidth=' + innerWidth);
r.push('corner.display=' + cs(q('[data-conversation-header-corner]'), 'display'));
r.push('chipIcon.display=' + cs(q('.f8BMvq_icon'), 'display'));
r.push('statAnchor.fontSize=' + cs(q('[data-composer-stat]'), 'font-size'));
r.push('statPill.paddingLeft=' + cs(q('.ueqFMa_pill'), 'padding-left'));
r.push('statSep.marginLeft=' + cs(q('.ueqFMa_sep'), 'margin-left'));
document.getElementById('result').textContent = r.join('\\n');
</script>
</body></html>`

const cases = [
  ['a', ' data-mobile-nav="stats"'],
  ['b', ''],
]
for (const [name, attr] of cases) {
  const out = join(ROOT, `.cache/layout-check-${name}.html`)
  writeFileSync(out, makeHtml(attr), 'utf8')
  console.log(`写出 ${out}`)
}
console.log(`参与测试的布局规则共 ${rules.length} 条`)
