/* kxxy-mobile-ui@2 */
/**
 * dsh-kxxy 移动端 UI 适配 —— 左侧栏「覆盖式抽屉」
 *
 * ── 要解决的问题 ────────────────────────────────────────────────
 * 官方布局父 BynINW_frame 是 CSS grid，列宽由 React 写死在 inline style 上：
 *
 *   折叠态  grid-template-columns: 56px  minmax(0px, 1fr) minmax(0px, 0px)
 *   展开态  grid-template-columns: 280px minmax(0px, 1fr) minmax(0px, 0px)
 *
 * 411px 视口下展开态主内容只剩 131px，中文标题逐字竖排、按钮溢出卡片。
 * 官方展开态没有任何「覆盖层」概念，它就是硬挤第二列。
 *
 * ── 做法 ────────────────────────────────────────────────────────
 * 官方进入展开态时，给 frame 打上 .kxxy-rail-open（规则见 mobile.css ⑪）：
 *   · 第一列压到 0px（inline 没有 !important，所以 CSS !important 能胜出）
 *   · 侧栏脱离 grid 流 → position:absolute 覆盖层 + 半透明遮罩
 *   · 主内容显式回到第 2 列（脱流后 grid 会把 centerCol 自动排到第 1 列 0px 宽）
 * 点遮罩 → 调官方自己的「收起侧边栏」按钮，让官方状态与我们的类同步回落。
 *
 * ── 为什么不直接用 CSS 判断「官方是否展开」──────────────────────
 * 官方展开态没有稳定的 CSS 锚点：语义类 `_2H3hWW_collapsed` 挂在侧栏**内部**
 * （哈希前缀跨版本会变），而 :has() 需要 Chrome 105+，目标设备 WebView 是 104。
 * 所以由本脚本读 frame 的 **inline** grid-template-columns 第一列来判断。
 *
 * ⚠ 读 inline 而不是 computed —— 我们自己会用 !important 把 computed 压成 0px，
 *   读 computed 会永远得到 0px，判断失效。
 *
 * ── 兜底 ────────────────────────────────────────────────────────
 * 若官方 toggle 按钮定位不到（跨版本类名大改），退化为 .kxxy-rail-hidden：
 * 直接把侧栏 display:none，并在左下角浮出一个恢复按钮。这条路径只在
 * 「官方按钮找不到」时才走，正常版本不会出现。
 */
(function () {
  'use strict';

  if (window.__kxxyMobileUiInstalled) return;
  window.__kxxyMobileUiInstalled = true;

  var FRAME_NEEDLE = 'BynINW_frame';
  var SIDEBAR_NEEDLE = 'sidebarCol';
  var OPEN_CLASS = 'kxxy-rail-open';
  var HIDDEN_CLASS = 'kxxy-rail-hidden';
  var RESTORE_CLASS = 'kxxy-rail-restore';
  var RESTORE_ID = 'kxxy-rail-restore';
  var BODY_FLAG = 'kxxy-rail-hidden-active';

  var NARROW_QUERY = '(max-width: 767px)';
  var EXPANDED_MIN_PX = 120;   // 官方折叠 56px / 展开 280px，取中间值判档
  var TICK_MS = 400;

  var frameRef = null;
  var boundFrame = null;

  // ── 基础工具 ───────────────────────────────────────────────────

  function isNarrow() {
    if (window.matchMedia) return window.matchMedia(NARROW_QUERY).matches;
    return window.innerWidth <= 767;
  }

  /** 只在状态真的变化时改 class —— 否则 MutationObserver / 轮询会自己触发自己。 */
  function setClass(el, name, on) {
    var has = el.classList.contains(name);
    if (on && !has) el.classList.add(name);
    else if (!on && has) el.classList.remove(name);
  }

  function childByNeedle(parent, needle) {
    var kids = parent.children;
    for (var i = 0; i < kids.length; i++) {
      var cls = kids[i].getAttribute('class') || '';
      if (cls.indexOf(needle) >= 0) return kids[i];
    }
    return null;
  }

  function findFrame() {
    var list = document.querySelectorAll('div[class*="' + FRAME_NEEDLE + '"]');
    for (var i = 0; i < list.length; i++) {
      if (childByNeedle(list[i], SIDEBAR_NEEDLE)) return list[i];
    }
    return null;
  }

  /** 官方写在 frame inline style 上的第一列宽度；解析不出返回 -1。 */
  function officialWidth(frame) {
    var raw = frame.style.gridTemplateColumns || '';
    var m = /^\s*(\d+(?:\.\d+)?)px/.exec(raw);
    return m ? parseFloat(m[1]) : -1;
  }

  /**
   * 定位官方侧栏开合按钮。
   * 首选语义类中缀 `toggle`（实测展开态与折叠态都是 _2H3hWW_iconButton _2H3hWW_toggle），
   * 兜底再用 aria-label 文案 —— 文案会随语言变，只作最后手段。
   */
  function findToggle(sidebarCol) {
    var btns = sidebarCol.querySelectorAll('button');
    var i, cls, label;
    for (i = 0; i < btns.length; i++) {
      cls = btns[i].getAttribute('class') || '';
      if (cls.indexOf('toggle') >= 0) return btns[i];
    }
    for (i = 0; i < btns.length; i++) {
      label = btns[i].getAttribute('aria-label') || '';
      if (label.indexOf('侧边栏') >= 0 || /sidebar/i.test(label)) return btns[i];
    }
    return null;
  }

  // ── 恢复按钮（仅兜底路径用）────────────────────────────────────

  function ensureRestoreButton() {
    var btn = document.getElementById(RESTORE_ID);
    if (btn) return btn;
    if (!document.body) return null;

    btn = document.createElement('button');
    btn.id = RESTORE_ID;
    btn.type = 'button';
    btn.className = RESTORE_CLASS;
    btn.setAttribute('aria-label', '打开侧边栏');
    btn.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" stroke-width="1.7"/>' +
      '<path d="M9 4v16" stroke="currentColor" stroke-width="1.7"/>' +
      '</svg>';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var frame = frameRef || findFrame();
      if (!frame) return;
      setClass(frame, HIDDEN_CLASS, false);
      setClass(frame, OPEN_CLASS, true);
      syncRestore();
    });
    document.body.appendChild(btn);
    return btn;
  }

  function syncRestore() {
    var on = document.body && document.body.classList.contains(BODY_FLAG);
    var btn = document.getElementById(RESTORE_ID);
    if (on && !btn) btn = ensureRestoreButton();
    if (btn) btn.style.display = on ? 'flex' : 'none';
  }

  function setBodyFlag(on) {
    if (!document.body) return;
    var has = document.body.classList.contains(BODY_FLAG);
    if (on && !has) document.body.classList.add(BODY_FLAG);
    else if (!on && has) document.body.classList.remove(BODY_FLAG);
  }

  // ── 抽屉开合 ───────────────────────────────────────────────────

  function openDrawer(frame) {
    setClass(frame, HIDDEN_CLASS, false);
    setClass(frame, OPEN_CLASS, true);
  }

  /** 点遮罩 → 交给官方按钮收起；找不到按钮才走兜底隐藏。 */
  function closeDrawer(frame) {
    var col = childByNeedle(frame, SIDEBAR_NEEDLE);
    var btn = col ? findToggle(col) : null;
    if (btn) {
      // 官方会把 inline 改回 56px，下一 tick 的 sync() 会摘掉 OPEN_CLASS
      btn.click();
      return;
    }
    setClass(frame, OPEN_CLASS, false);
    setClass(frame, HIDDEN_CLASS, true);
    syncRestore();
  }

  function bindFrame(frame) {
    if (boundFrame === frame) return;
    boundFrame = frame;
    // capture 阶段：早于 React 在根容器上的委托监听，避免官方先处理掉这次点击
    frame.addEventListener('click', function (e) {
      if (!frame.classList.contains(OPEN_CLASS)) return;
      var col = childByNeedle(frame, SIDEBAR_NEEDLE);
      if (col && col.contains(e.target)) return;   // 点侧栏内部不关
      closeDrawer(frame);
    }, true);
  }

  // ── 状态同步 ───────────────────────────────────────────────────

  function sync() {
    var frame = frameRef;
    if (!frame || !frame.isConnected) {
      frameRef = findFrame();
      frame = frameRef;
      boundFrame = null;
    }
    if (!frame) {
      setBodyFlag(false);
      syncRestore();
      return;
    }
    bindFrame(frame);

    if (!isNarrow()) {
      setClass(frame, OPEN_CLASS, false);
      setClass(frame, HIDDEN_CLASS, false);
      setBodyFlag(false);
      syncRestore();
      return;
    }

    var expanded = officialWidth(frame) >= EXPANDED_MIN_PX;

    // 官方已折叠 → 兜底隐藏态没有存在意义，撤掉
    if (!expanded) setClass(frame, HIDDEN_CLASS, false);

    if (expanded && !frame.classList.contains(HIDDEN_CLASS)) openDrawer(frame);
    else setClass(frame, OPEN_CLASS, false);

    setBodyFlag(frame.classList.contains(HIDDEN_CLASS));
    syncRestore();
  }

  // ── 启动 ───────────────────────────────────────────────────────

  function start() {
    sync();
    window.setInterval(sync, TICK_MS);

    if (window.matchMedia) {
      var mq = window.matchMedia(NARROW_QUERY);
      if (mq.addEventListener) mq.addEventListener('change', sync);
      else if (mq.addListener) mq.addListener(sync);   // WebView 104 走这条
    }
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
