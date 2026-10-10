package app.kxxy

import android.util.Log
import android.webkit.WebView

/**
 * 方案 R：官方布局适配层。
 *
 * 设计原则（全部来自对官方前端 dist 的实测，而非猜测）：
 *
 * 1. **不接管布局，只补触控细节**
 *    实测发现官方布局是 **JS 驱动**的：`dsh-web-frontend/dist` 的两个 CSS
 *    （合计 105,717 B）里 `@media` 块只有 10 个，**条件全部是
 *    `(prefers-reduced-motion:reduce)`**，`max-width`/`min-width` 断点 **0 个**。
 *    真正的控制点在 `dsh-client-ui-layout` 的 `SIDEBAR_AUTO_COLLAPSE = 1024`，
 *    且 `computeColumns()` 在 390pt 下已产出正确的 `56 / 334 / 0` 三列。
 *    ⇒ 所以本层**绝不**改 `gridTemplateColumns`、不隐藏侧栏、不重排中列。
 *
 * 2. **插槽守恒**
 *    官方插槽注册表有 86 个精确插槽，其中 `sidebar.right.pane.tab` 有 9 个
 *    官方贡献者、`conversation.chat.node` 有 5 个。这些插槽注册的是 **React 组件**。
 *    若本层对插槽容器用 `display:none`，插件 UI 会**静默消失**（不报错、
 *    不留日志，最难排查）。⇒ 硬规则：禁止任何 `display:none` 作用于插槽容器。
 *
 * 3. **选择器写法**
 *    官方类名是 `_语义_hash_行号` 三段式（实测 331 个类名 100% 符合，
 *    251 个语义名）。语义名在**中间**，所以：
 *      `[class$="_composerSeat"]`  ❌ 不匹配
 *      `[class*="_composerSeat_"]` ✅ 正确
 *    优先使用官方主动暴露的 `data-*` 锚点（比类名哈希稳定得多）。
 *
 * 4. **幂等与可撤销**
 *    用 `data-plugin-css` 属性做唯一标识，避免重复注入；卸载时能干净移除。
 */
object AdaptLayer {

    private const val TAG = "KxxyAdapt"

    /** 注入样式表的唯一标识。 */
    private const val CSS_ID = "dsh-kxxy/mobile-adapt.css"

    /** 适配激活时挂在 body 上的类名。 */
    private const val ACTIVE_CLASS = "dsh-kxxy-portrait"

    /**
     * 向 WebView 注入适配层。
     *
     * 用 `evaluateJavascript` 注入而非 `insertCSS`：前者可以携带逻辑
     * （激活条件判定、状态监听），后者只能塞静态样式。
     */
    fun inject(webView: WebView) {
        val js = buildScript()
        webView.evaluateJavascript(js) { result ->
            Log.i(TAG, "adapt layer injected: $result")
        }
    }

    private fun buildScript(): String = """
        (function () {
          if (window.__kxxyAdaptInstalled) return 'already-installed';
          window.__kxxyAdaptInstalled = true;

          var CSS_ID = ${jsString(CSS_ID)};
          var ACTIVE_CLASS = ${jsString(ACTIVE_CLASS)};

          // ── 激活条件 ────────────────────────────────────────────────
          // max-width:1023px 与官方 SIDEBAR_AUTO_COLLAPSE=1024 **严格互补**，
          // 保证只在官方进入窄屏模式时激活。
          // pointer:coarse 保证只在真触屏启用（窄窗口的桌面浏览器不受影响）。
          var QUERY = '(max-width: 1023px) and (pointer: coarse)';
          var FORCE_DESKTOP_KEY = 'dsh-kxxy-force-desktop';

          function shouldActivate() {
            if (sessionStorage.getItem(FORCE_DESKTOP_KEY) === '1') return false;
            return window.matchMedia(QUERY).matches;
          }

          // ── 样式表 ──────────────────────────────────────────────────
          // 选择器优先级：data-* 属性锚点 > [class*="_语义_"] 中缀选择器
          // 绝不出现 display:none 作用于插槽容器（插槽守恒）
          var CSS = [
            // ① 触控目标 ≥ 44px（官方为鼠标设计，行高偏小）
            '.' + ACTIVE_CLASS + ' [class*="_row_"] { min-height: 44px; }',
            '.' + ACTIVE_CLASS + ' [class*="_actionButton_"] { min-height: 44px; min-width: 44px; }',
            '.' + ACTIVE_CLASS + ' [class*="_button_"] { min-height: 40px; }',
            '.' + ACTIVE_CLASS + ' [class*="_iconButton_"] { min-height: 44px; min-width: 44px; }',
            '.' + ACTIVE_CLASS + ' [class*="_tab_"] { min-height: 44px; }',
            // 插槽容器内部的按钮同样提权（插件自己按桌面尺寸写的）
            '.' + ACTIVE_CLASS + ' [class*="_paneBody_"] button { min-height: 44px; min-width: 44px; }',
            '.' + ACTIVE_CLASS + ' [class*="_turnTail_"] button { min-height: 44px; }',

            // ② 输入框字号 ≥ 16px（低于 16px 时聚焦会自动放大页面）
            '.' + ACTIVE_CLASS + ' textarea { font-size: 16px !important; }',
            '.' + ACTIVE_CLASS + ' input[type="text"] { font-size: 16px !important; }',
            '.' + ACTIVE_CLASS + ' input[type="search"] { font-size: 16px !important; }',
            '.' + ACTIVE_CLASS + ' [class*="_composerSeat_"] textarea { font-size: 16px !important; }',
            '.' + ACTIVE_CLASS + ' [class*="_composerSeat_"] input { font-size: 16px !important; }',

            // ③ safe-area 内边距（刘海屏 / 手势条）
            '.' + ACTIVE_CLASS + ' [class*="_composerSeat_"] { padding-bottom: max(8px, env(safe-area-inset-bottom)) !important; }',
            '.' + ACTIVE_CLASS + ' [class*="_frame_"] { padding-top: env(safe-area-inset-top); }',

            // ④ 去 hover 态残留（触屏无 hover，会「粘住」高亮）
            '.' + ACTIVE_CLASS + ' [class*="_chevronHover_"] { opacity: 1 !important; }',
            '.' + ACTIVE_CLASS + ' [class*="_row_"]:hover { background: transparent; }',
            '.' + ACTIVE_CLASS + ' [class*="_sessionRow_"]:hover { background: transparent; }',

            // ⑤ 抑制 tooltip 气泡（触屏上点击后残留）
            '.' + ACTIVE_CLASS + ' [class*="_tooltip_"] { display: none !important; }',

            // ⑥ 官方窄屏下右栏自动全屏（<768px 由官方派生），
            //    这里只保证全屏态关闭按钮触控达标
            '[data-rightbar-fullscreen] button { min-height: 44px; min-width: 44px; }'
          ].join('\n');

          function ensureCss() {
            var existing = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]');
            if (existing) existing.remove();
            var style = document.createElement('style');
            style.setAttribute('data-plugin-css', CSS_ID);
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
          }

          function removeCss() {
            var existing = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]');
            if (existing) existing.remove();
          }

          // ── 宿主管理页入口（悬浮按钮）────────────────────────────────
          // 不用插槽：官方 slots 是浏览器侧 SlotCore，host 侧插件进不去。
          // 只在官方 UI（路径以 / 开头且不是 /kxxy）上挂；管理页自身不挂。
          var ENTRY_ID = 'dsh-kxxy-host-entry';

          function ensureHostEntry() {
            var path = location.pathname;
            if (path.indexOf('/kxxy') === 0) return;      // 已在管理页
            if (document.getElementById(ENTRY_ID)) return;

            var a = document.createElement('a');
            a.id = ENTRY_ID;
            a.href = '/kxxy';
            a.textContent = '宿主';
            a.title = 'DSH Kxxy 宿主管理';
            a.setAttribute('data-kxxy-entry', '1');
            // 内联样式而非外部 CSS：这个按钮必须在适配层未激活时也存在
            // （横屏 / 强制桌面模式下用户同样需要进管理页）。
            a.style.cssText = [
              'position:fixed', 'z-index:2147483000',
              'right:max(10px, env(safe-area-inset-right))',
              'bottom:calc(max(10px, env(safe-area-inset-bottom)) + 64px)',
              'padding:6px 12px', 'border-radius:14px',
              'background:rgba(20,24,34,.82)', 'color:#cfe3ff',
              'font:600 12px/1.6 system-ui,sans-serif',
              'text-decoration:none', 'border:1px solid rgba(120,160,255,.35)',
              'backdrop-filter:blur(8px)', 'opacity:.72',
              'box-shadow:0 2px 10px rgba(0,0,0,.35)'
            ].join(';');
            // 半透明 + 贴边，尽量不遮挡官方输入框；按下时提到全不透明。
            a.addEventListener('click', function () { a.style.opacity = '1'; });
            (document.body || document.documentElement).appendChild(a);
          }

          // ── 应用/撤销 ───────────────────────────────────────────────
          function evaluate() {
            var on = shouldActivate();
            document.body.classList.toggle(ACTIVE_CLASS, on);
            if (on) ensureCss(); else removeCss();
          }

          // body 可能还没解析完，等它就绪
          function whenBody(fn) {
            if (document.body) return fn();
            var t = setInterval(function () {
              if (document.body) { clearInterval(t); fn(); }
            }, 50);
          }

          whenBody(function () {
            evaluate();
            window.matchMedia(QUERY).addEventListener('change', evaluate);

            // ⑦ 宿主管理页入口
            //    官方插槽是**浏览器侧**概念（dsh-client-ui-slots 只在 client
            //    bundle 里跑），host 侧插件无法往里注册。所以入口只能在原生层
            //    注入。只在官方 UI 根路径上挂，管理页自己不挂。
            ensureHostEntry();

            // ⑥ 左滑收起侧栏 / 右滑展开
            //    用官方 ctx.layout 的等价行为：读 data-sidebar-collapsed 决定方向，
            //    点击侧栏外区域关闭。这里只做手势探测，实际开关交给官方的
            //    汉堡按钮（避免与官方 store 竞争）。
            var startX = 0, startY = 0, tracking = false;
            document.addEventListener('touchstart', function (e) {
              if (e.touches.length !== 1) return;
              startX = e.touches[0].clientX;
              startY = e.touches[0].clientY;
              tracking = true;
            }, { passive: true });

            document.addEventListener('touchend', function (e) {
              if (!tracking) return;
              tracking = false;
              var dx = e.changedTouches[0].clientX - startX;
              var dy = e.changedTouches[0].clientY - startY;
              // 只认水平滑动：横向位移 > 60px 且明显大于纵向
              if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

              var frame = document.querySelector('[class*="_frame_"]');
              if (!frame) return;
              var collapsed = frame.hasAttribute('data-sidebar-collapsed');
              // 向右滑且侧栏折叠 → 展开；向左滑且侧栏展开 → 收起
              var wantExpand = (dx > 0 && collapsed) || (dx < 0 && !collapsed);
              if (!wantExpand) return;

              // 交给官方的侧栏开关（第一个带 aria-label 的按钮通常就是它）
              var toggle = document.querySelector('[data-sidebar-toggle]')
                || document.querySelector('button[aria-label*="sidebar" i]')
                || document.querySelector('button[aria-label*="侧栏"]');
              if (toggle) toggle.click();
            }, { passive: true });

            // 诊断上报，便于在真机 logcat 里确认适配层生效
            console.log('[dsh-kxxy] adapt installed, active=' + document.body.classList.contains(ACTIVE_CLASS));
          });

          return 'installed';
        })();
    """.trimIndent()

    /** 把 Kotlin 字符串安全嵌入 JS 单引号字面量。 */
    private fun jsString(s: String): String =
        "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"
}
