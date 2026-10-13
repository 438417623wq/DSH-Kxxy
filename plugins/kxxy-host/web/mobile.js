/* kxxy-mobile-ui@3 */
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
 * ── 两种形态 ────────────────────────────────────────────────────
 * 窄屏下左侧栏只有两个状态，由本脚本给 frame 打类切换：
 *
 *   ① 隐藏态 .kxxy-rail-hidden（默认）
 *      第一列压到 0px、整列 visibility:hidden → 主内容拿到全部宽度。
 *      唯一残留的是**官方那个开合按钮**（mobile.css ⑫ 用 visibility:visible
 *      把它单独放出来并 fixed 到左上角原位）—— 用户要求「用官方原本那个按钮」，
 *      所以这里不自造任何 UI。
 *   ② 抽屉态 .kxxy-rail-open（点官方按钮后）
 *      官方把 inline grid 改成 280px，本脚本随即把它转成覆盖层 + 半透明遮罩。
 *      点遮罩 → 调官方自己的「收起侧边栏」按钮 → 官方回落 → 下一 tick 回到隐藏态。
 *
 * 两个状态之间**没有第三种态**：官方那 56px 图标栏在窄屏下不再出现。
 *
 * ── 为什么不直接用 CSS 判断「官方是否展开」──────────────────────
 * 官方展开态没有稳定的 CSS 锚点：语义类 `_2H3hWW_collapsed` 挂在侧栏**内部**
 * （哈希前缀跨版本会变），而 :has() 需要 Chrome 105+，目标设备 WebView 是 104。
 * 所以由本脚本读 frame 的 **inline** grid-template-columns 第一列来判断。
 *
 * ⚠ 读 inline 而不是 computed —— 我们自己会用 !important 把 computed 压成 0px，
 *   读 computed 会永远得到 0px，判断失效。
 *
 * ── 安全阀 ──────────────────────────────────────────────────────
 * 只有定位到官方开合按钮时才隐藏整列（canHide）。按钮找不到就保持官方 56px
 * 图标栏原样 —— 隐藏态的唯一入口就是那个按钮，宁可不好看也不能把入口锁死。
 */
(function () {
  'use strict';

  if (window.__kxxyMobileUiInstalled) return;
  window.__kxxyMobileUiInstalled = true;

  var FRAME_NEEDLE = 'BynINW_frame';
  var SIDEBAR_NEEDLE = 'sidebarCol';
  var OPEN_CLASS = 'kxxy-rail-open';
  var HIDDEN_CLASS = 'kxxy-rail-hidden';

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

  // ── 抽屉开合 ───────────────────────────────────────────────────

  /**
   * 打开抽屉。
   *
   * ⚠ 必须优先走官方 toggle 按钮 —— 官方侧栏的**内容形态**取决于它自己的
   *   折叠状态：折叠态只渲染图标栏（新会话 / 插件 / 设置 三个图标），展开态
   *   才渲染品牌头、工作区列表与会话列表。若我们只把折叠态那 56px 拉宽成
   *   280px 覆盖层，得到的是一个「拉宽了的图标栏」，不是用户要的抽屉。
   *   点官方按钮让官方把 inline grid 改成 280px，下一 tick 的 sync() 再打上
   *   OPEN_CLASS 把它转成覆盖层 —— 内容与层级就都对了。
   *
   * 这里**不自造按钮**：窄屏隐藏态下官方那个 toggle 已经被 CSS 单独放出来
   * （mobile.css ⑫：整列 visibility:hidden，唯独 toggle visibility:visible），
   * 用户点它就走官方原生链路，外观与行为都与官方一致。
   */
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
    if (!frame) return;
    bindFrame(frame);

    if (!isNarrow()) {
      setClass(frame, OPEN_CLASS, false);
      setClass(frame, HIDDEN_CLASS, false);
      return;
    }

    var expanded = officialWidth(frame) >= EXPANDED_MIN_PX;

    if (expanded) {
      // 官方已展开 → 转成覆盖式抽屉
      openDrawer(frame);
      return;
    }

    // 官方已折叠 → 完全隐藏，只留官方那个开合按钮
    setClass(frame, OPEN_CLASS, false);
    setClass(frame, HIDDEN_CLASS, canHide(frame));
  }

  /**
   * 只有在官方开合按钮定位得到时才允许完全隐藏。
   *
   * 隐藏态的入口就是官方那个按钮（mobile.css ⑫ 把它单独放出来）。若按钮
   * 定位不到（跨版本类名大改），隐藏会让用户**永久失去侧栏入口** —— 宁可
   * 保留官方 56px 图标栏不好看，也不能把功能锁死。
   */
  function canHide(frame) {
    var col = childByNeedle(frame, SIDEBAR_NEEDLE);
    return !!(col && findToggle(col));
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
