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

          // ── 终端 shell 缓存自愈（三轮问题 2）────────────────────────
          // 官方终端 UI 把选中的 shell 路径缓存在 localStorage['dsh.terminal.shell']，
          // 新建终端时**缓存优先**、显式传给引擎。SHELL 未设的旧版本解析出的
          // Termux 内置路径已被缓存 —— 引擎侧修复后它仍会覆盖默认值，导致
          // 「新建终端」持续失败。这里在每次页面加载（对话页与 /kxxy 同源共缓存）
          // 时精确清除已知坏前缀，不动其他值。
          (function healShellCache() {
            try {
              var KEY = 'dsh.terminal.shell';
              var v = localStorage.getItem(KEY);
              if (v && v.indexOf('/data/data/com.termux') === 0) {
                localStorage.removeItem(KEY);
                console.log('[dsh-kxxy] removed stale terminal shell cache: ' + v);
              }
            } catch (e) { /* storage 不可用时忽略（无缓存即无问题） */ }
          })();

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

          // ── 宿主管理页入口（悬浮按钮：拖动 / 吸附 / 靠边隐藏 / 鲸鱼图标）──
          // 不用插槽：官方 slots 是浏览器侧 SlotCore，host 侧插件进不去。
          // 只在官方 UI（路径以 / 开头且不是 /kxxy）上挂；管理页自身不挂。
          //
          // 交互规格（五项改进方案 §1）：
          //   按下 → 跟手拖动（transform: translate3d，避免重排）
          //   抬手 → 位移 < 6px 视为点击（跳 /kxxy）；≥ 6px 视为拖动
          //        → 吸附最近一侧边缘，Y 夹在安全区内
          //        → 位置持久化 localStorage['dsh-kxxy-entry-pos'] = {side,yRatio}
          //   闲置 2.6s → 收进边缘，只留 14px 滑块 + opacity .34
          //   触摸滑块 → 立即展开，计时器重置
          //
          // 两个已知陷阱（缺一即复现）：
          //   ① 本文件下方挂在 document 上的 touchstart/touchend 侧栏手势是
          //     **冒泡阶段**监听 —— 按钮上所有 touch 事件必须 stopPropagation，
          //     否则拖按钮会误触发侧栏开合。Pointer Events 与 Touch Events 是
          //     两条独立事件流，只拦 touch 不够，pointerdown 也要拦。
          //   ② touch-action:none + touchmove 内 preventDefault({passive:false})，
          //     否则拖动时页面跟着滚。
          var ENTRY_ID = 'dsh-kxxy-host-entry';
          var ENTRY_POS_KEY = 'dsh-kxxy-entry-pos';
          var ENTRY_IDLE_MS = 2600;
          var ENTRY_DRAG_THRESHOLD = 6;

          var WHALE_SVG =
            '<svg width="18" height="18" viewBox="0 0 32 32" fill="none" aria-hidden="true">' +
            '<path d="M4.6 17.6c0-5.4 4.5-9.3 10.3-9.3 4.8 0 8.7 2.6 10.3 6.6h1.6' +
            'c1.4-2 3.4-2.9 4.6-2.5-.8.9-1.1 2.1-.8 3.2-1 .4-1.8 1.2-2.2 2.2h-1.9' +
            'c-1.5 4.2-5.5 7-10.4 7-5.9 0-10.5-3.2-10.5-7.2z" ' +
            'fill="rgba(0,192,255,.16)" stroke="#00C0FF" stroke-width="1.6" stroke-linejoin="round"/>' +
            '<circle cx="10.2" cy="16.4" r="1.3" fill="#00C0FF"/>' +
            '<path d="M11.5 6.2c-1.2-1-1.8-2.3-1.7-3.9M14.8 6.4c-.9-1.3-1.2-2.7-.9-4.2" ' +
            'stroke="#2F80ED" stroke-width="1.4" stroke-linecap="round"/>' +
            '<path d="M8.2 20.8c3.4 2.2 8.6 2.2 12.1-.2" stroke="#2F80ED" ' +
            'stroke-width="1.2" stroke-linecap="round" opacity=".7"/>' +
            '</svg>';

          function ensureHostEntry() {
            var path = location.pathname;
            if (path.indexOf('/kxxy') === 0) return;      // 已在管理页
            if (document.getElementById(ENTRY_ID)) return;

            var host = document.body || document.documentElement;

            var a = document.createElement('a');
            a.id = ENTRY_ID;
            a.href = '/kxxy';
            a.title = 'DSH Kxxy 宿主管理';
            a.setAttribute('data-kxxy-entry', '1');
            a.setAttribute('aria-label', '打开 DSH Kxxy 宿主管理');
            // 内联样式而非外部 CSS：这个按钮必须在适配层未激活时也存在
            // （横屏 / 强制桌面模式下用户同样需要进管理页）。
            a.style.cssText = [
              'position:fixed', 'z-index:2147483000',
              'top:0', 'left:0',                 // 位置完全由 JS 计算（left/top + transform）
              'display:flex', 'align-items:center', 'gap:5px',
              'padding:6px 11px 6px 8px', 'border-radius:16px',
              'background:rgba(20,24,34,.85)', 'color:#cfe3ff',
              'font:600 12px/1.6 system-ui,sans-serif',
              'text-decoration:none', 'border:1px solid rgba(120,160,255,.35)',
              'backdrop-filter:blur(8px)', '-webkit-backdrop-filter:blur(8px)',
              'box-shadow:0 2px 10px rgba(0,0,0,.35)',
              'opacity:.78',
              'touch-action:none',
              'user-select:none', '-webkit-user-select:none',
              '-webkit-touch-callout:none',
              'will-change:transform',
              'transition:opacity .22s ease, padding .22s ease, border-radius .22s ease',
              'overscroll-behavior:contain'
            ].join(';');
            a.innerHTML = WHALE_SVG + '<span style="letter-spacing:.5px">宿主</span>';
            host.appendChild(a);

            var svgEl = a.querySelector('svg');
            var labelEl = a.querySelector('span');

            /** env(safe-area-inset-*) 只在 CSS 里生效 —— 用探针元素取回数值。 */
            function safeInsets() {
              var probe = document.createElement('div');
              probe.style.cssText = [
                'position:fixed', 'visibility:hidden', 'pointer-events:none',
                'padding:env(safe-area-inset-top) env(safe-area-inset-right)',
                'env(safe-area-inset-bottom) env(safe-area-inset-left)'
              ].join(';');
              host.appendChild(probe);
              var cs = getComputedStyle(probe);
              var out = {
                top: parseFloat(cs.paddingTop) || 0,
                right: parseFloat(cs.paddingRight) || 0,
                bottom: parseFloat(cs.paddingBottom) || 0,
                left: parseFloat(cs.paddingLeft) || 0
              };
              probe.remove();
              return out;
            }

            var state = { side: 'right', yRatio: 0.72 };   // 缺省：右缘偏低（原版位置附近）
            try {
              var saved = JSON.parse(localStorage.getItem(ENTRY_POS_KEY) || 'null');
              if (saved && (saved.side === 'left' || saved.side === 'right') &&
                  typeof saved.yRatio === 'number' && isFinite(saved.yRatio)) {
                state.side = saved.side;
                state.yRatio = Math.min(1, Math.max(0, saved.yRatio));
              }
            } catch (e) { /* 损坏的持久化数据按缺省处理 */ }

            var collapsed = false;
            var idleTimer = null;

            /** 把按钮摆到 (side, yRatio) 对应的落点。collapsed 时收成 14px 滑块。 */
            function place() {
              var inset = safeInsets();
              var vw = window.innerWidth, vh = window.innerHeight;
              var m = 8;                                  // 距边缘最小间距
              var w = a.offsetWidth, h = a.offsetHeight;
              var minY = inset.top + m;
              var maxY = Math.max(minY, vh - inset.bottom - m - h);
              var y = minY + (maxY - minY) * state.yRatio;
              var x;
              if (collapsed) {
                // 滑块：14px 宽，紧贴边缘，保留同侧圆角
                x = state.side === 'right' ? vw - 14 : 0;
                a.style.borderRadius = state.side === 'right' ? '10px 0 0 10px' : '0 10px 10px 0';
                a.style.opacity = '.34';
              } else {
                x = state.side === 'right' ? vw - w - m - inset.right : m + inset.left;
                a.style.borderRadius = '16px';
                a.style.opacity = '.78';
              }
              a.style.left = Math.round(x) + 'px';
              a.style.top = Math.round(y) + 'px';
            }

            function collapse() {
              collapsed = true;
              svgEl.style.display = 'none';
              labelEl.style.display = 'none';
              a.style.padding = '9px 0';
              a.style.minWidth = '14px';
              a.style.boxShadow = 'none';
              place();
            }

            function expand() {
              if (!collapsed) { scheduleIdle(); return; }
              collapsed = false;
              svgEl.style.display = '';
              labelEl.style.display = '';
              a.style.padding = '6px 11px 6px 8px';
              a.style.minWidth = '';
              a.style.boxShadow = '0 2px 10px rgba(0,0,0,.35)';
              place();
              scheduleIdle();
            }

            function scheduleIdle() {
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(collapse, ENTRY_IDLE_MS);
            }

            function persist() {
              try {
                localStorage.setItem(ENTRY_POS_KEY, JSON.stringify(state));
              } catch (e) { /* 隐私模式等场景写不进就算了 */ }
            }

            // ── 拖动状态机 ────────────────────────────────────────────
            var drag = null;      // {x0, y0, dx, dy, moved}
            var suppressClick = false;

            // ① 双事件流拦截：Touch 与 Pointer 各一条，缺一条都会误触侧栏手势
            a.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
            a.addEventListener('touchstart', function (e) {
              e.stopPropagation();
              if (e.touches.length !== 1) return;
              var t = e.touches[0];
              drag = { x0: t.clientX, y0: t.clientY, dx: 0, dy: 0, moved: false };
              suppressClick = false;
              expand();                                  // 触摸滑块 → 立即展开
            }, { passive: true });

            a.addEventListener('touchmove', function (e) {
              e.stopPropagation();
              if (!drag || e.touches.length !== 1) return;
              e.preventDefault();                        // ② 不让页面跟着滚
              var t = e.touches[0];
              drag.dx = t.clientX - drag.x0;
              drag.dy = t.clientY - drag.y0;
              if (Math.abs(drag.dx) >= ENTRY_DRAG_THRESHOLD ||
                  Math.abs(drag.dy) >= ENTRY_DRAG_THRESHOLD) {
                drag.moved = true;
              }
              // 拖动中的 Y 夹取：不允许拖出安全区
              var inset = safeInsets();
              var h = a.offsetHeight;
              var baseTop = parseFloat(a.style.top) || 0;
              var ny = baseTop + drag.dy;
              var minY = inset.top + 8;
              var maxY = window.innerHeight - inset.bottom - 8 - h;
              if (ny < minY) drag.dy += minY - ny;
              if (ny > maxY) drag.dy += maxY - ny;
              a.style.transform = 'translate3d(' + drag.dx + 'px,' + drag.dy + 'px,0)';
            }, { passive: false });

            function endDrag(e) {
              e.stopPropagation();
              if (!drag) return;
              var wasMoved = drag.moved;
              var dx = drag.dx, dy = drag.dy;
              drag = null;
              a.style.transform = '';
              if (wasMoved) {
                suppressClick = true;                    // 拖动结束，吞掉合成的 click
                // 吸附：按拖动后的中心 X 判断贴哪侧；Y 换算成比率持久化
                var inset = safeInsets();
                var vw = window.innerWidth, vh = window.innerHeight;
                var w = a.offsetWidth, h = a.offsetHeight;
                var baseLeft = parseFloat(a.style.left) || 0;
                var baseTop = parseFloat(a.style.top) || 0;
                var cx = baseLeft + dx + w / 2;
                state.side = cx < vw / 2 ? 'left' : 'right';
                var minY = inset.top + 8;
                var maxY = Math.max(minY, vh - inset.bottom - 8 - h);
                var y = Math.min(maxY, Math.max(minY, baseTop + dy));
                state.yRatio = (y - minY) / Math.max(1, maxY - minY);
                persist();
                collapsed = true;                        // expand() 内部 place() 会按展开态重摆
                expand();
              } else {
                scheduleIdle();
              }
            }
            a.addEventListener('touchend', endDrag, { passive: true });
            a.addEventListener('touchcancel', endDrag, { passive: true });

            // 鼠标（桌面 WebView 调试）与合成 click 的兜底：拖动后的合成 click 被吞，
            // 真实的 mouse click 仍走 href 导航。
            a.addEventListener('click', function (e) {
              if (suppressClick) {
                e.preventDefault();
                suppressClick = false;
              }
            });

            window.addEventListener('resize', function () { place(); });
            place();
            scheduleIdle();
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
