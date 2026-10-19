/**
 * DSH Kxxy Host Dashboard - Core Client Logic
 * Standard ES2020 Implementation without external dependencies
 *
 * 功能分布：
 *   · 概览：引擎状态 / 运行时完整性检查 / 宿主环境指标
 *   · 扩展：扩展中心渲染真实目录（包池 × 安装状态），「获取」走 202 + jobId 轮询
 *   · 设置：外观 / 系统权限 / 权限等级 / 守护开关 / 关于弹窗
 *   · 重启引擎 / 导出日志 / 权限 / 开关全部走真分派表
 *
 * 注：镜像源测速与切换的 UI 已从控制台移除（后端仍保留），
 *     原「终端」页也已移除（它只是 engine.log 尾巴查看器）。
 */

(() => {
  'use strict';

  // ==========================================
  // 常量与状态配置
  // ==========================================
  const POLL_INTERVAL = 5000;
  const JOB_POLL_INTERVAL = 800;
  let pollTimer = null;

  /** 安装轮询计时器集合：有活动安装时冻结列表重渲染，避免把进度按钮刷掉。 */
  const jobPollTimers = new Set();

  /** 扩展多选集合（跨重渲染保持）。 */
  const selectedExts = new Set();

  /** 跟随系统深浅色：theme.css 的暗色块挂在 body[data-ds-dark-theme] 上。 */
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  /**
   * 主题偏好（三轮①）：与官方对话页同一份 ui-theme 设置。
   * light/dark 显式；system 跟随系统。由 /kxxy/api/state 轮询与外观卡驱动。
   */
  let themePreference = 'system';

  function applyTheme() {
    const dark = themePreference === 'dark' ||
      (themePreference === 'system' && darkQuery.matches);
    document.body.toggleAttribute('data-ds-dark-theme', dark);
  }

  /** 最近一次 /kxxy/api/state 快照（权限可用性灰化用）。 */
  let lastStateSnapshot = null;

  const CATEGORY_LABELS = {
    toolchain: '语言与编译链',
    media: '媒体与文档',
    devtools: '开发工具'
  };

  // ==========================================
  // DOM 元素引用
  // ==========================================
  const dom = {
    // 顶部与全局
    headerPulseDot: document.getElementById('header-pulse-dot'),
    headerStatusLabel: document.getElementById('header-status-label'),
    toastContainer: document.getElementById('toast-container'),

    // 概览视图元素
    engineStatusText: document.getElementById('engine-status-text'),
    heroPulseDot: document.getElementById('hero-pulse-dot'),
    enginePidBadge: document.getElementById('engine-pid-badge'),
    engineArchBadge: document.getElementById('engine-arch-badge'),
    engineNodeBadge: document.getElementById('engine-node-badge'),
    metricMemory: document.getElementById('metric-memory'),
    metricUptime: document.getElementById('metric-uptime'),
    metricPort: document.getElementById('metric-port'),
    runtimeChecksContainer: document.getElementById('runtime-checks-container'),
    runtimeAllStatus: document.getElementById('runtime-all-status'),
    btnQuickRefresh: document.getElementById('btn-quick-refresh'),

    // 扩展视图元素
    extensionsList: document.getElementById('extensions-list'),
    builtinSummary: document.getElementById('builtin-summary'),
    extBatchBar: document.getElementById('ext-batch-bar'),
    extBatchCount: document.getElementById('ext-batch-count'),
    btnExtSelectAll: document.getElementById('btn-ext-select-all'),
    btnExtSelectNone: document.getElementById('btn-ext-select-none'),
    btnExtBatchInstall: document.getElementById('btn-ext-batch-install'),
    btnExtBatchRemove: document.getElementById('btn-ext-batch-remove'),
    categoryChips: document.querySelectorAll('.category-chip'),

    // 设置视图元素
    privCards: document.getElementById('priv-cards'),
    privModeDescription: document.getElementById('priv-mode-description'),
    btnPrivApply: document.getElementById('btn-priv-apply'),
    appearanceList: document.getElementById('appearance-list'),
    permList: document.getElementById('perm-list'),
    toggleForeground: document.getElementById('toggle-foreground'),
    toggleWatchdog: document.getElementById('toggle-watchdog'),
    toggleLan: document.getElementById('toggle-lan'),
    infoNodeVer: document.getElementById('info-node-ver'),
    infoPnpmVer: document.getElementById('info-pnpm-ver'),
    aboutEntry: document.getElementById('about-entry'),
    aboutDialog: document.getElementById('about-dialog'),
    aboutDialogVersion: document.getElementById('about-dialog-version'),
    btnAboutClose: document.getElementById('btn-about-close'),
    btnAboutDismiss: document.getElementById('btn-about-dismiss'),
    btnRestartEngine: document.getElementById('btn-restart-engine'),
    btnExportLogs: document.getElementById('btn-export-logs'),

    // 体检视图元素（方案 K 常驻形态）
    healthRing: document.getElementById('health-ring'),
    healthRingIcon: document.getElementById('health-ring-icon'),
    healthHeadline: document.getElementById('health-headline'),
    healthSubline: document.getElementById('health-subline'),
    healthChecks: document.getElementById('health-checks'),
    healthCountBadge: document.getElementById('health-count-badge'),
    healthRepairCard: document.getElementById('health-repair-card'),
    healthRepairHint: document.getElementById('health-repair-hint'),
    healthLevels: document.getElementById('health-levels'),
    healthRepairFoot: document.getElementById('health-repair-foot'),
    healthLastCard: document.getElementById('health-last-card'),
    healthLastTime: document.getElementById('health-last-time'),
    healthLastChanges: document.getElementById('health-last-changes'),
    healthBusy: document.getElementById('health-busy'),
    healthBusyTitle: document.getElementById('health-busy-title'),
    healthBusyDesc: document.getElementById('health-busy-desc'),
    btnHealthRefresh: document.getElementById('btn-health-refresh'),
    btnHealthUndo: document.getElementById('btn-health-undo'),

    // 导航 Tab
    tabItems: document.querySelectorAll('.tab-item'),
    viewPanes: document.querySelectorAll('.view-pane')
  };

  // ==========================================
  // Toast 通知系统
  // ==========================================
  function showToast(message, type = 'info') {
    if (!dom.toastContainer) return;

    const toast = document.createElement('div');
    toast.className = `toast-item toast-${type}`;

    let icon = 'ℹ️';
    if (type === 'success') icon = '✓';
    else if (type === 'error') icon = '✕';
    else if (type === 'warning') icon = '⚠️';

    toast.innerHTML = `<span style="font-weight:bold;margin-right:4px;">${icon}</span><span>${escapeHtml(message)}</span>`;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-fade-out');
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, 4200);
  }

  // ==========================================
  // 辅助格式化函数
  // ==========================================
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatUptime(seconds) {
    if (typeof seconds !== 'number' || isNaN(seconds)) return '00:00:00';
    const s = Math.floor(seconds);
    const hrs = Math.floor(s / 3600).toString().padStart(2, '0');
    const mins = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const secs = Math.floor(s % 60).toString().padStart(2, '0');
    return `${hrs}:${mins}:${secs}`;
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return '';
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function getExtBadgeInfo(id) {
    const lower = (id || '').toLowerCase();
    if (lower.includes('python') || lower.includes('py')) {
      return { text: 'Py', colorClass: 'python-color' };
    }
    if (lower.includes('git') || lower.includes('ssh')) {
      return { text: 'Git', colorClass: 'git-color' };
    }
    if (lower.includes('ffmpeg') || lower.includes('media') || lower.includes('sox') || lower.includes('yt-dlp')) {
      return { text: 'FF', colorClass: 'media-color' };
    }
    if (lower.includes('tesseract') || lower.includes('ocr')) {
      return { text: 'OCR', colorClass: 'media-color' };
    }
    if (lower.includes('magick') || lower.includes('poppler') || lower.includes('pdf') || lower.includes('exif')) {
      return { text: '图', colorClass: 'media-color' };
    }
    if (lower.includes('rust') || lower.includes('cargo')) {
      return { text: 'Rs', colorClass: 'rust-color' };
    }
    if (lower.includes('clang') || lower.includes('llvm') || lower.includes('c++')) {
      return { text: 'C++', colorClass: 'clang-color' };
    }
    if (lower.includes('rg') || lower.includes('fd')) {
      return { text: 'Rg', colorClass: 'rg-color' };
    }
    return { text: (id ? id.slice(0, 2).toUpperCase() : 'EX'), colorClass: 'clang-color' };
  }

  // ==========================================
  // API 请求工具 (安全封装)
  // ==========================================
  async function apiGet(url) {
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        cache: 'no-store'
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} (${response.statusText})`);
      }
      return await response.json();
    } catch (err) {
      showToast(`获取数据失败: ${err.message}`, 'error');
      throw err;
    }
  }

  /**
   * POST JSON。与旧版的差别：4xx/5xx 抛出的错误信息里带上服务端的
   * error 字段 —— 分派表对未知动作返回 501 {error:'not implemented'}，
   * 用户看到的就是真实原因而不是笼统的「HTTP 501」。
   */
  async function apiPost(url, data) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(data)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = body && body.error ? body.error : '';
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      return body;
    } catch (err) {
      showToast(`执行操作失败: ${err.message}`, 'error');
      throw err;
    }
  }

  // ==========================================
  // 1. Tab 切换系统
  // ==========================================
  function initTabSwitch() {
    dom.tabItems.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetView = btn.getAttribute('data-target');
        if (!targetView) return;

        // 更新 Tab 按钮选中态
        dom.tabItems.forEach(item => item.classList.remove('active'));
        btn.classList.add('active');

        // 更新视图面板显隐态
        dom.viewPanes.forEach(pane => {
          if (pane.getAttribute('data-view') === targetView) {
            pane.classList.add('active');
          } else {
            pane.classList.remove('active');
          }
        });
      });
    });
  }

  // ==========================================
  // 2. 状态轮询系统 (fetch('/kxxy/api/state'))
  // ==========================================
  async function fetchState() {
    try {
      const data = await apiGet('/kxxy/api/state');
      if (!data) return;

      const engine = data.engine || {};
      const runtime = data.runtime || {};
      lastStateSnapshot = engine;

      // 1) 顶部 Header 状态
      if (dom.headerPulseDot && dom.headerStatusLabel) {
        if (runtime.allOk !== false) {
          dom.headerPulseDot.className = 'pulse-dot dot-green';
          dom.headerStatusLabel.textContent = '引擎正常';
        } else {
          dom.headerPulseDot.className = 'pulse-dot dot-orange';
          dom.headerStatusLabel.textContent = '存在异常';
        }
      }

      // 2) 引擎状态卡片
      if (dom.engineStatusText) {
        dom.engineStatusText.textContent = engine.pid ? '引擎运行中' : '引擎已停止';
      }
      if (dom.heroPulseDot) {
        dom.heroPulseDot.className = engine.pid ? 'pulse-dot-large dot-green' : 'pulse-dot-large dot-red';
      }
      if (dom.enginePidBadge) {
        dom.enginePidBadge.textContent = engine.pid ? `PID: ${engine.pid}` : 'PID: 未运行';
      }
      if (dom.engineArchBadge && engine.arch) {
        dom.engineArchBadge.textContent = engine.arch;
      }
      if (dom.engineNodeBadge && engine.node) {
        dom.engineNodeBadge.textContent = `Node.js ${engine.node}`;
      }

      // 3) 三大指标小卡
      if (dom.metricMemory && engine.memoryMB !== undefined) {
        dom.metricMemory.textContent = engine.memoryMB;
      }
      if (dom.metricUptime && engine.uptimeSec !== undefined) {
        dom.metricUptime.textContent = formatUptime(engine.uptimeSec);
      }
      if (dom.metricPort && engine.port !== undefined) {
        dom.metricPort.textContent = engine.port;
      }

      // 4) 运行时完整性检查
      if (Array.isArray(runtime.checks) && dom.runtimeChecksContainer) {
        renderRuntimeChecks(runtime.checks);
      }
      if (dom.runtimeAllStatus) {
        const checks = runtime.checks || [];
        const okCount = checks.filter(c => c.ok).length;
        const total = checks.length;
        if (total > 0) {
          dom.runtimeAllStatus.textContent = `${okCount} / ${total} 通过`;
          dom.runtimeAllStatus.className = okCount === total ? 'badge badge-success' : 'badge badge-accent';
        }
      }

      // 5) 设置页面静态信息同步
      if (dom.infoNodeVer && engine.node) {
        dom.infoNodeVer.textContent = engine.node;
      }
      // 主题偏好：随轮询刷新（官方设置页改了外观，控制台几秒内跟随）
      if (engine.themePreference && engine.themePreference !== themePreference) {
        themePreference = engine.themePreference;
        applyTheme();
      }
      renderAppearance(engine.themePreference);
      // 权限等级卡片：effectivePrivMode 缺失时按 normal 处理，卡片照常渲染
      if (dom.privCards) {
        renderPrivCards(engine);
      }
      // 6) 系统权限卡片
      renderPermissions(engine);
      // 终端 shell 缓存自愈（原「终端」页已删，这里静默处理）
      repairShellCache(runtime.engineRoot);
    } catch {
      // 错误已在 apiGet 中通过 showToast 提示
    }
  }

  /**
   * 外观卡（三轮①）：三个选项读写官方 ui-theme.preference。
   * 写入走 POST /kxxy/api/theme —— 官方同一份文档，对话界面立即跟随。
   */
  function renderAppearance(current) {
    if (!dom.appearanceList) return;
    const pref = current || themePreference || 'system';
    const options = [
      { id: 'system', label: '跟随 DSH 设置', desc: '与对话界面的外观设置保持一致（系统深浅色仅在其为「跟随系统」时生效）' },
      { id: 'light', label: '浅色', desc: '管理页与对话页都使用浅色主题' },
      { id: 'dark', label: '深色', desc: '管理页与对话页都使用深色主题' },
    ];
    dom.appearanceList.innerHTML = '';
    options.forEach((opt) => {
      const active = pref === opt.id;
      const div = document.createElement('div');
      div.className = 'appearance-row' + (active ? ' active' : '');
      div.innerHTML = `
        <div class="setting-info">
          <span class="setting-title">${escapeHtml(opt.label)}${active ? ' <span class="perm-ok">✓</span>' : ''}</span>
          <span class="setting-desc">${escapeHtml(opt.desc)}</span>
        </div>
      `;
      const select = el(`<button class="button ${active ? 'button-installed' : 'button-subtle'} button-sm">${active ? '当前' : '选择'}</button>`);
      select.addEventListener('click', async () => {
        if (active) return;
        try {
          const res = await apiPost('/kxxy/api/theme', { preference: opt.id });
          themePreference = opt.id;
          applyTheme();
          showToast(res && res.note ? res.note : `外观已切换为${opt.label}`, 'success');
          renderAppearance(opt.id);
        } catch {
          // 错误已提示
        }
      });
      div.appendChild(select);
      dom.appearanceList.appendChild(div);
    });
  }

  /**
   * 终端 shell 缓存的静默自愈（原「终端」页的诊断卡已随该页删除）。
   *
   * ⚠ 关于 `dsh.terminal.shell` 这个键：它**已被官方前端废弃**。
   * 在运行时 bundle 里逐文件统计（sidebar-terminal / client.terminal /
   * terminal-bash / terminal 四个包）对 `/terminal\.shell/`、`/localStorage/`
   * 的命中数都是 0 —— 官方当前版本根本不读这个键。官方新建终端走的是
   * `webTerminals.selectShell(path)` → 打开 tab 时把 `shellPath` 作为参数传下去。
   *
   * 但早期版本写过这个键，而失效值会让「新建终端」持续失败。实测设备上曾缓存
   * `…/engine/bin/cmd`（Android 的 `cmd` 服务工具，`cmd --help` 报
   * "Can't find service"，完全不是 shell）。以前靠用户点卡片清除；现在改为
   * 打开控制台时直接判定并自动清掉，用户无感。
   */
  const SHELL_CACHE_KEY = 'dsh.terminal.shell';
  /** 引擎 bin/ 下真正的 shell（实测清单：ash 4320B / bash 880416B / dash 117040B / sh 117040B）。 */
  const KNOWN_SHELLS = ['bash', 'sh', 'dash', 'ash', 'zsh', 'fish'];

  function repairShellCache(engineRoot) {
    let cached = null;
    try {
      cached = localStorage.getItem(SHELL_CACHE_KEY);
    } catch {
      return; // 隐私模式等场景下 localStorage 不可用，直接跳过
    }
    if (!cached) return;

    const inEngine = engineRoot ? cached.startsWith(engineRoot + '/') : false;
    const base = cached.slice(cached.lastIndexOf('/') + 1).toLowerCase();
    if (inEngine && KNOWN_SHELLS.includes(base)) return; // 缓存有效，不动

    try {
      localStorage.removeItem(SHELL_CACHE_KEY);
    } catch {
      return;
    }
    showToast('已自动清理失效的终端 shell 缓存（旧值会让新建终端失败）', 'success');
  }

  /**
   * 设置页「系统权限」卡片：Android 能力开关的真实状态 + 一键申请。
   * 申请走 kxxy://perm/request?name=… 桥（MainActivity 拦截后发起系统对话框），
   * 状态来自原生心跳写进 kxxy-state.json 的 permissions 字段，轮询自动刷新。
   */
  function renderPermissions(engine) {
    if (!dom.permList) return;
    const perms = engine.permissions || {};
    const rows = [
      { label: '通知', desc: '引擎状态常驻通知（Android 13+ 需授权）', value: perms.notifications, action: 'notifications', actionLabel: '去授权' },
      { label: '所有文件访问', desc: '导出日志写入 Download/kxxy/（Android 11+，系统设置页开启）', value: perms.allFiles, action: 'all-files', actionLabel: '去开启' },
      { label: '电池优化白名单', desc: '防止后台引擎被系统休眠策略中止', value: perms.battery, action: 'battery', actionLabel: '去设置' },
    ];
    if (perms.legacyStorage !== null && perms.legacyStorage !== undefined) {
      rows.push({ label: '存储（旧版）', desc: 'Android 10 及以下的文件读写授权', value: perms.legacyStorage, action: 'storage', actionLabel: '去授权' });
    }

    dom.permList.innerHTML = '';
    rows.forEach((row) => {
      const div = document.createElement('div');
      div.className = 'setting-row';
      const granted = row.value === true;
      div.innerHTML = `
        <div class="setting-info">
          <span class="setting-title">${escapeHtml(row.label)}${granted ? ' <span class="perm-ok">✓</span>' : ''}</span>
          <span class="setting-desc">${escapeHtml(row.desc)}</span>
        </div>
      `;
      if (!granted && row.action) {
        const btn = el(`<button class="button button-subtle button-sm">${escapeHtml(row.actionLabel)}</button>`);
        btn.addEventListener('click', () => {
          // kxxy:// 由原生层拦截（应设置页在 WebView 内，权限请求必须由 Activity 发起）
          window.location.href = `kxxy://perm/request?name=${encodeURIComponent(row.action)}`;
        });
        div.appendChild(btn);
      }
      dom.permList.appendChild(div);
    });
  }

  function renderRuntimeChecks(checks) {
    dom.runtimeChecksContainer.innerHTML = '';
    checks.forEach(item => {
      const div = document.createElement('div');
      div.className = 'check-item';

      const iconClass = item.ok ? 'check-status-icon success' : 'check-status-icon fail';
      const iconSymbol = item.ok ? '✓' : '✕';
      const badgeText = item.badge || (item.ok ? '正常' : '缺失');

      div.innerHTML = `
        <div class="${iconClass}" aria-hidden="true">${iconSymbol}</div>
        <div class="check-content">
          <div class="check-main">
            <span class="check-name">${escapeHtml(item.label || item.path || '检查项')}</span>
            <span class="check-badge">${escapeHtml(badgeText)}</span>
          </div>
          <div class="check-detail">${escapeHtml(item.detail || item.path || '')}</div>
        </div>
      `;
      dom.runtimeChecksContainer.appendChild(div);
    });
  }

  // ==========================================
  // 3. 扩展中心（真实目录 + 离线包池安装 + 批量激活）
  // ==========================================
  async function fetchExtensions() {
    if (!dom.extensionsList) return;
    // 有安装任务在跑时冻结重渲染：进度按钮的状态由 job 轮询驱动
    if (jobPollTimers.size > 0) return;
    try {
      const data = await apiGet('/kxxy/api/extensions');
      renderExtensions(data || {});
    } catch {
      // 错误已由 apiGet 提示
    }
  }

  /** 当前渲染的条目（id → item），供全选/批量操作使用。 */
  let renderedItems = [];

  /**
   * 折叠分组的展开态（groupKey → true 表示用户展开过）。
   *
   * ⚠ 必须存在模块级：`renderExtensions` 每次都会把整个列表 `innerHTML = ''`
   * 重建，而 `fetchExtensions` 每 5 秒被轮询调一次 —— 展开态若只存在 DOM 的
   * class 上，用户点开「已激活」后最多 5 秒就会被重建回 `collapsed`，
   * 表现为「展开了又自己折叠回去」。这里记住用户意图，渲染时恢复。
   */
  const expandedGroups = new Set();

  function renderExtensions(data) {
    if (!dom.extensionsList) return;
    const items = Array.isArray(data.items) ? data.items : [];
    renderedItems = items;

    // 「已内置」摘要条（④ 档：220 包预装进 runtime.zip，不占扩展卡）
    if (dom.builtinSummary) {
      const builtin = data.builtin;
      if (builtin && builtin.summary) {
        dom.builtinSummary.style.display = '';
        dom.builtinSummary.textContent = builtin.summary;
      } else {
        dom.builtinSummary.style.display = 'none';
      }
    }

    if (items.length === 0) {
      dom.extensionsList.innerHTML =
        '<div class="empty-state">暂无可用扩展</div>';
      updateBatchBar();
      return;
    }

    // 分组：已激活排最前（默认折叠），其余按类目；未知类目归入开发工具
    const pending = items.filter(i => !i.installed);
    const groups = [
      { key: 'installed', label: `已激活`, items: items.filter(i => i.installed), collapsible: true },
      { key: 'toolchain', label: CATEGORY_LABELS.toolchain, items: pending.filter(i => i.category === 'toolchain') },
      { key: 'media', label: CATEGORY_LABELS.media, items: pending.filter(i => i.category === 'media') },
      { key: 'devtools', label: CATEGORY_LABELS.devtools, items: pending.filter(i => i.category !== 'toolchain' && i.category !== 'media') },
    ].filter(g => g.items.length > 0);

    dom.extensionsList.innerHTML = '';
    for (const group of groups) {
      const section = document.createElement('div');
      section.className = 'ext-group';
      section.setAttribute('data-group', group.key);

      const title = document.createElement('div');
      title.className = 'ext-group-title';
      title.innerHTML = `<span>${escapeHtml(group.label)}</span><span class="ext-group-count">${group.items.length}</span>`;
      section.appendChild(title);

      const body = document.createElement('div');
      body.className = 'ext-group-body';
      // 已激活组：默认折叠，但恢复用户上次的展开态（见 expandedGroups 注释）
      if (group.collapsible) {
        if (!expandedGroups.has(group.key)) body.classList.add('collapsed');
        title.classList.add('clickable');
        if (!body.classList.contains('collapsed')) title.classList.add('expanded');
        title.addEventListener('click', () => {
          body.classList.toggle('collapsed');
          const nowExpanded = !body.classList.contains('collapsed');
          if (nowExpanded) expandedGroups.add(group.key);
          else expandedGroups.delete(group.key);
          title.classList.toggle('expanded', nowExpanded);
        });
      }

      group.items.forEach(ext => body.appendChild(renderExtCard(ext, group.collapsible)));
      section.appendChild(body);
      dom.extensionsList.appendChild(section);
    }

    applyCategoryFilter();
    updateBatchBar();
  }

  function renderExtCard(ext, inInstalledGroup) {
    const id = ext.id || '';
    const name = ext.name || id;
    const version = ext.installedVersion || ext.version || '';
    const desc = ext.description || 'DSH 内置包池扩展，点击「获取」后本地解包，全程无需联网。';
    const badge = getExtBadgeInfo(id);

    let binsHtml = '';
    if (Array.isArray(ext.bins) && ext.bins.length > 0) {
      binsHtml = ext.bins.slice(0, 6).map(b => `<span class="tag-item">${escapeHtml(b)}</span>`).join('');
    }

    const sizeLabel = formatSize(ext.sizeBytes);
    const metaBits = [];
    if (sizeLabel) metaBits.push(`约 ${sizeLabel}`);
    if (ext.bundled) metaBits.push('内置包池 · 零联网');
    else if (!ext.installed) metaBits.push('非包池来源');
    if (CATEGORY_LABELS[ext.category]) metaBits.push(CATEGORY_LABELS[ext.category]);

    const card = document.createElement('div');
    card.className = 'card ext-card';
    card.setAttribute('data-category', ext.category || 'devtools');
    card.setAttribute('data-ext-id', id);

    card.innerHTML = `
      <div class="ext-card-inner">
        <label class="ext-select" title="加入多选">
          <input type="checkbox" data-ext-check="${escapeHtml(id)}" ${selectedExts.has(id) ? 'checked' : ''}>
          <span class="ext-checkmark"></span>
        </label>
        <div class="ext-icon-box ${badge.colorClass}">${escapeHtml(badge.text)}</div>
        <div class="ext-body">
          <div class="ext-header">
            <h4 class="ext-name">${escapeHtml(name)}</h4>
            <span class="ext-version">${escapeHtml(version)}</span>
          </div>
          <p class="ext-desc">${escapeHtml(desc)}</p>
          ${binsHtml ? `<div class="ext-tags">${binsHtml}</div>` : ''}
          ${metaBits.length ? `<div class="ext-meta">${escapeHtml(metaBits.join(' · '))}</div>` : ''}
        </div>
        <div class="ext-action" data-ext-action="${escapeHtml(id)}"></div>
      </div>
    `;

    const action = card.querySelector('.ext-action');
    const installing = ext.installing;
    if (installing) {
      action.appendChild(progressButton(installing));
    } else if (ext.installed) {
      action.appendChild(el('<button class="button button-installed button-sm" disabled>已激活</button>'));
      const un = el('<button class="button button-subtle button-sm ext-remove">卸载</button>');
      un.addEventListener('click', () => removeExtension(ext.id, name));
      action.appendChild(un);
    } else if (ext.bundled) {
      const btn = el('<button class="button button-primary button-sm">获取</button>');
      btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = '提交…';
        installOne(ext.id, name, null)
          .catch((e) => showToast(`扩展 ${name} 安装失败：${e.message}`, 'error'))
          .finally(() => fetchExtensions());
      });
      action.appendChild(btn);
    } else {
      action.appendChild(el('<button class="button button-subtle button-sm" disabled title="包池缺失，需重新构建 APK">不可用</button>'));
    }

    // 多选勾选（已激活组默认收起，勾选动作照常可用）
    card.querySelector('[data-ext-check]').addEventListener('change', (e) => {
      if (e.target.checked) selectedExts.add(id);
      else selectedExts.delete(id);
      updateBatchBar();
    });

    return card;
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function progressButton(job) {
    const label = job.phase === 'link' ? '接入中' : '解包中';
    return el(`<button class="button button-primary button-sm" disabled>${label} ${job.percent || 0}%</button>`);
  }

  /**
   * 单个扩展的完整安装流（提交 → 轮询 job → 完成/失败）。
   * 单卡「获取」与批量激活共用；onProgress(job) 用于批量时推进聚合进度条。
   */
  function installOne(id, name, onProgress) {
    return apiPost('/kxxy/api/extensions/install', { id }).then((res) => {
      if (!res || !res.jobId) throw new Error('服务端未返回 jobId');
      return new Promise((resolve, reject) => {
        const timer = setInterval(async () => {
          try {
            const r = await fetch(`/kxxy/api/extensions/job?id=${encodeURIComponent(res.jobId)}`, { cache: 'no-store' });
            if (!r.ok) return;
            const job = await r.json();
            if (onProgress) onProgress(job);
            // 就地更新按钮文本（找不到按钮就等下一次 fetchExtensions）
            const action = dom.extensionsList
              && dom.extensionsList.querySelector(`[data-ext-action="${CSS.escape(id)}"]`);
            const btn = action && action.querySelector('button');
            if (btn && job.phase !== 'done' && job.phase !== 'error') {
              const label = job.phase === 'link' ? '接入中' : '解包中';
              btn.textContent = `${label} ${job.percent || 0}%`;
            }
            if (job.phase === 'done') {
              clearInterval(timer);
              jobPollTimers.delete(timer);
              showToast(`扩展 ${name} 安装完成`, 'success');
              resolve(job);
            } else if (job.phase === 'error') {
              clearInterval(timer);
              jobPollTimers.delete(timer);
              reject(new Error(job.message || '未知错误'));
            }
          } catch {
            // 轮询失败不终止安装；下一轮再试
          }
        }, JOB_POLL_INTERVAL);
        jobPollTimers.add(timer);
      });
    });
  }

  function pollInstallJob(jobId, id, name) {
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/kxxy/api/extensions/job?id=${encodeURIComponent(jobId)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const job = await res.json();
        if (job.phase === 'done') {
          clearInterval(timer);
          jobPollTimers.delete(timer);
          showToast(`扩展 ${name} 安装完成：${job.message || '命令已接入 PATH'}`, 'success');
          fetchExtensions();
        } else if (job.phase === 'error') {
          clearInterval(timer);
          jobPollTimers.delete(timer);
          showToast(`扩展 ${name} 安装失败：${job.message || '未知错误'}`, 'error');
          fetchExtensions();
        }
      } catch {
        // 轮询失败不终止安装；下一轮再试
      }
    }, JOB_POLL_INTERVAL);
    jobPollTimers.add(timer);
  }

  function removeExtension(id, name) {
    if (!confirm(`确定要卸载扩展 ${name} 吗？其命令会从 PATH 中移除。`)) return Promise.resolve();
    return apiPost('/kxxy/api/extensions/remove', { id })
      .then((res) => {
        showToast(`扩展 ${name} 已卸载（清理 ${res.removedBins || 0} 个命令 / ${res.removedLibs || 0} 个库）`, 'success');
        fetchExtensions();
      })
      .catch(() => { /* 错误已提示 */ });
  }

  // ── 批量操作 ────────────────────────────────────────────────────────

  function updateBatchBar() {
    if (!dom.extBatchBar) return;
    const n = selectedExts.size;
    dom.extBatchBar.hidden = n === 0;
    if (n > 0 && dom.extBatchCount) {
      dom.extBatchCount.textContent = `已选 ${n} 项`;
    }
    if (dom.btnExtBatchRemove) dom.btnExtBatchRemove.disabled = n === 0;
    if (dom.btnExtBatchInstall) {
      // 只有「未安装且包池可用」的所选项目能批量激活
      const installable = [...selectedExts].filter((id) => {
        const item = renderedItems.find((i) => i.id === id);
        return item && !item.installed && item.bundled;
      }).length;
      dom.btnExtBatchInstall.disabled = installable === 0;
      dom.btnExtBatchInstall.textContent = `激活所选 (${installable})`;
    }
  }

  function initBatchActions() {
    if (!dom.extBatchBar) return;

    dom.btnExtSelectAll.addEventListener('click', () => {
      // 全选 = 当前可见（未被分类过滤隐藏）的卡片
      dom.extensionsList.querySelectorAll('.ext-card').forEach((card) => {
        if (card.style.display === 'none') return;
        const id = card.getAttribute('data-ext-id');
        if (id) selectedExts.add(id);
        const box = card.querySelector('[data-ext-check]');
        if (box) box.checked = true;
      });
      updateBatchBar();
    });

    dom.btnExtSelectNone.addEventListener('click', () => {
      selectedExts.clear();
      dom.extensionsList.querySelectorAll('[data-ext-check]').forEach((box) => { box.checked = false; });
      updateBatchBar();
    });

    dom.btnExtBatchInstall.addEventListener('click', async () => {
      const targets = [...selectedExts]
        .map((id) => renderedItems.find((i) => i.id === id))
        .filter((i) => i && !i.installed && i.bundled);
      if (!targets.length) return;
      if (!confirm(`确定要批量激活 ${targets.length} 个扩展吗？将在后台依次本地解包。`)) return;

      dom.btnExtBatchInstall.disabled = true;
      let done = 0;
      const failed = [];
      for (const item of targets) {
        // 服务端 installChain 本来就串行；这里逐个 await 拿到真实进度
        try {
          await installOne(item.id, item.name, (job) => {
            if (dom.extBatchCount) {
              dom.extBatchCount.textContent =
                `${done}/${targets.length} 完成 · ${item.name} ${job.percent || 0}%`;
            }
          });
          done += 1;
        } catch (e) {
          failed.push(`${item.name}：${e.message}`);
        }
      }
      showToast(
        failed.length
          ? `批量激活完成：${done} 成功，${failed.length} 失败（${failed[0]}${failed.length > 1 ? ' 等' : ''}）`
          : `批量激活完成：${done} 个扩展已就绪`,
        failed.length ? 'warning' : 'success',
      );
      selectedExts.clear();
      fetchExtensions();
    });

    dom.btnExtBatchRemove.addEventListener('click', async () => {
      const targets = [...selectedExts]
        .map((id) => renderedItems.find((i) => i.id === id))
        .filter((i) => i && i.installed);
      if (!targets.length) return;
      if (!confirm(`确定要卸载所选的 ${targets.length} 个扩展吗？其命令会从 PATH 中移除。`)) return;
      dom.btnExtBatchRemove.disabled = true;
      let done = 0;
      for (const item of targets) {
        try {
          await apiPost('/kxxy/api/extensions/remove', { id: item.id });
          done += 1;
        } catch { /* 单个失败继续 */ }
      }
      showToast(`批量卸载完成：${done}/${targets.length}`, done === targets.length ? 'success' : 'warning');
      selectedExts.clear();
      fetchExtensions();
    });
  }

  function initCategoryFilter() {
    dom.categoryChips.forEach(chip => {
      chip.addEventListener('click', () => {
        dom.categoryChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        applyCategoryFilter(chip.getAttribute('data-category'));
      });
    });
  }

  /** 按类目显隐卡片；整组卡片都被隐藏时把组标题一并藏起来。 */
  function applyCategoryFilter(cat = 'all') {
    if (!dom.extensionsList) return;
    dom.extensionsList.querySelectorAll('.ext-group').forEach(group => {
      let visibleInGroup = 0;
      group.querySelectorAll('.ext-card').forEach(card => {
        const show = cat === 'all' || card.getAttribute('data-category') === cat;
        card.style.display = show ? 'block' : 'none';
        if (show) visibleInGroup += 1;
      });
      group.style.display = visibleInGroup > 0 ? 'block' : 'none';
    });
  }

  // ==========================================
  // 4. 关于弹窗：入口卡点击 → 弹出信息（作者 + 宿主环境参数）
  // ==========================================
  // 原「镜像源」卡片已按需求从控制台移除（后端 /kxxy/api/mirror* 与 lib/mirror.mjs
  // 仍保留：镜像源本身是「对话页侧栏 → 插件 → + 添加插件」那个入口在用的，
  // 只是控制台不再暴露测速/切换 UI）。
  // 原「宿主环境参数」卡片的内容整体移进了这个弹窗。

  /** 打开「关于」弹窗（版本号从页头同步，避免两处各写一份）。 */
  function openAboutDialog() {
    if (!dom.aboutDialog) return;
    const headerVersion = document.querySelector('.header-version');
    if (dom.aboutDialogVersion && headerVersion) {
      dom.aboutDialogVersion.textContent = headerVersion.textContent.trim();
    }
    dom.aboutDialog.setAttribute('data-open', 'true');
  }

  function closeAboutDialog() {
    if (!dom.aboutDialog) return;
    dom.aboutDialog.setAttribute('data-open', 'false');
  }

  function initAboutDialog() {
    if (!dom.aboutEntry || !dom.aboutDialog) return;

    dom.aboutEntry.addEventListener('click', openAboutDialog);
    // 键盘可达（卡片是 role="button" tabindex="0"）
    dom.aboutEntry.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openAboutDialog();
      }
    });

    if (dom.btnAboutClose) dom.btnAboutClose.addEventListener('click', closeAboutDialog);
    if (dom.btnAboutDismiss) dom.btnAboutDismiss.addEventListener('click', closeAboutDialog);

    // 点遮罩关闭（点弹窗本体不关）
    dom.aboutDialog.addEventListener('click', (e) => {
      if (e.target === dom.aboutDialog) closeAboutDialog();
    });

    // Esc 关闭：只在弹窗打开时拦截，避免影响页面其它按键
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dom.aboutDialog.getAttribute('data-open') === 'true') {
        closeAboutDialog();
      }
    });
  }

  // ==========================================
  // 5. 动作按钮与交互控制
  // ==========================================
  // ==========================================
  // 权限等级：模式卡片组（三轮③）
  // ==========================================

  /** 当前选中的模式（null = 未选择，按钮禁用）。 */
  let selectedPrivMode = null;

  const PRIV_MODE_DEFS = [
    {
      id: 'normal',
      icon: '🛡️',
      name: '沙箱 Normal',
      tagline: '应用私有目录隔离，引擎以应用身份运行，不申请任何提权。',
      caps: [
        ['✓', '全部 Agent 编码、脚本与工具链任务'],
        ['✓', '内置 ④ 档工具链（clang / python / openjdk / proot）'],
        ['✗', 'su 系统调用与特权管理'],
      ],
    },
    {
      id: 'shizuku',
      icon: '⚡',
      name: 'Shizuku ADB',
      tagline: '经 Shizuku 获得 ADB shell 级身份；引擎以应用身份运行，特权命令按需走 shz 通道。',
      caps: [
        ['✓', '引擎内可用 shz 以 adb / shell 身份执行命令'],
        ['✓', '引擎内 DSH_ANDROID_PRIV_MODE=shizuku，脚本可感知'],
        ['✗', '引擎进程本身不提权（Shizuku 的固有边界）'],
      ],
      needs: 'shizuku',
      unavailableReason: '未检测到 Shizuku 管理器',
      guide: { label: 'Shizuku 官网', url: 'https://shizuku.rikka.app/' },
    },
    {
      id: 'root',
      icon: '👑',
      name: 'Root 提权',
      tagline: '经 su 整体提权启动引擎；启动前自动修复数据目录属主并滚动备份。',
      caps: [
        ['✓', 'su 系统调用与无限制底层操作'],
        ['✓', '启动前属主修复 + dsh-home 备份（自动）'],
        ['⚠', '引擎执行的任何命令都不再受沙箱限制'],
      ],
      needs: 'root',
      unavailableReason: '未检测到可用的 su（需 Magisk / KernelSU）',
    },
  ];

  /**
   * 渲染三张模式卡。数据全部来自 /kxxy/api/state：
   *   effectivePrivMode（实际生效） / requestedPrivMode（已保存待生效） /
   *   privAvailable（root/shizuku 可用性）。
   */
  function renderPrivCards(engine) {
    if (!dom.privCards) return;
    const avail = engine.privAvailable || {};
    const effective = engine.effectivePrivMode || engine.privMode || 'normal';
    const pending = engine.requestedPrivMode && engine.requestedPrivMode !== effective
      ? engine.requestedPrivMode
      : null;
    if (selectedPrivMode === null) selectedPrivMode = effective;

    dom.privCards.innerHTML = '';
    PRIV_MODE_DEFS.forEach((mode) => {
      const available = mode.needs ? Boolean(avail[mode.needs]) : true;
      const isEffective = effective === mode.id;
      const isPending = pending === mode.id;
      const isSelected = selectedPrivMode === mode.id;

      const card = document.createElement('div');
      card.className = 'priv-card' +
        (isSelected ? ' selected' : '') +
        (isEffective ? ' effective' : '') +
        (available ? '' : ' unavailable');

      let badge;
      if (isEffective) badge = '<span class="priv-badge badge-ok">当前生效</span>';
      else if (isPending) badge = '<span class="priv-badge badge-pending">已保存 · 重启引擎后生效</span>';
      else if (!available) badge = `<span class="priv-badge badge-off">不可用 · ${escapeHtml(mode.unavailableReason)}</span>`;
      else badge = '<span class="priv-badge">可启用</span>';

      card.innerHTML = `
        <div class="priv-card-head">
          <span class="priv-icon">${mode.icon}</span>
          <div class="priv-titles">
            <span class="priv-name">${escapeHtml(mode.name)}</span>
            <span class="priv-tagline">${escapeHtml(mode.tagline)}</span>
          </div>
          ${badge}
        </div>
        <div class="priv-caps">
          ${mode.caps.map(([mark, text]) =>
            `<div class="priv-cap"><span class="priv-cap-mark ${mark === '✓' ? 'ok' : mark === '⚠' ? 'warn' : 'off'}">${mark}</span>${escapeHtml(text)}</div>`).join('')}
        </div>
      `;

      // Shizuku 通道未就绪时，把确切原因和「请求授权」入口直接给出来。
      //
      // 为什么必须在这里给：装了管理器但服务没起 / 没授权，是 Shizuku 最常见的
      // 两种状态，而它们在 UI 上都表现为「这个模式点了没用」。只写「不可用」
      // 等于把用户扔在原地 —— 实测中用户正是这么描述的（「Shizuku ADB 权限有问题」）。
      if (mode.id === 'shizuku' && available && !engine.privAvailable?.shizukuUsable) {
        const why = engine.privAvailable?.shizukuError || '';
        const tip = el(`<div class="priv-hint">${escapeHtml(why || 'Shizuku 通道未就绪')}</div>`);
        card.appendChild(tip);
        if (engine.privAvailable?.shizukuGranted === false) {
          const btn = el('<button class="button button-subtle button-sm">请求授权</button>');
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.location.href = 'kxxy://perm/request?name=shizuku';
            showToast('已发起 Shizuku 授权请求，请在 Shizuku 弹窗中确认', 'info');
          });
          card.appendChild(btn);
        }
      }

      if (!available && mode.guide) {
        const guide = el(`<a class="button button-subtle button-sm" href="${escapeHtml(mode.guide.url)}" target="_blank" rel="noreferrer">${escapeHtml(mode.guide.label)}</a>`);
        // 不让指南按钮触发下面整卡的「不可用」提示
        guide.addEventListener('click', (e) => e.stopPropagation());
        card.appendChild(guide);
      }

      if (available) {
        card.addEventListener('click', () => {
          if (isEffective) {
            // 已是生效值：明确反馈，而不是看起来「点了没反应」
            showToast(`当前已以「${mode.name}」等级运行`, 'info');
            return;
          }
          selectedPrivMode = mode.id;
          renderPrivCards(engine);
        });
      } else {
        // 不可用的档位也不是死的：点了告诉用户为什么、去哪开
        card.addEventListener('click', () => {
          showToast(`${mode.name}不可用：${mode.unavailableReason}`, 'warning');
        });
      }

      dom.privCards.appendChild(card);
    });

    updatePrivApplyBar(engine, effective, pending);

    if (dom.privModeDescription) {
      const mode = PRIV_MODE_DEFS.find((m) => m.id === effective);
      dom.privModeDescription.textContent = pending
        ? `已保存「${PRIV_MODE_DEFS.find((m) => m.id === pending)?.name ?? pending}」，重启引擎后生效（当前仍以 ${mode?.name ?? effective} 运行）。`
        : `当前以「${mode?.name ?? effective}」运行。`;
    }
  }

  function updatePrivApplyBar(engine, effective, pending) {
    if (!dom.btnPrivApply) return;
    const target = selectedPrivMode;
    const needsApply = target !== null && target !== effective;
    dom.btnPrivApply.disabled = !needsApply;
    dom.btnPrivApply.textContent = needsApply
      ? `应用「${PRIV_MODE_DEFS.find((m) => m.id === target)?.name ?? target}」并重启引擎`
      : pending
        ? '重启引擎使已保存的等级生效'
        : '应用并重启引擎';
    // 已保存待生效但没改选择：按钮仍可用（等于一键重启让保存值落地）
  }

  async function applyPrivMode() {
    const engine = lastStateSnapshot || {};
    const effective = engine.effectivePrivMode || 'normal';
    const target = selectedPrivMode;
    if (!target) return;

    if (target === 'root' &&
        !confirm('确定要以 Root 模式运行引擎吗？\n\n· 启动前会自动备份并修复数据目录属主\n· 引擎将拥有系统级权限，任何由它执行的命令都不再受沙箱限制')) {
      return;
    }

    dom.btnPrivApply.disabled = true;
    try {
      const res = await apiPost('/kxxy/api/action', { action: 'set-priv-mode', value: target });
      showToast(res && res.note ? res.note : `权限等级已保存为 ${target}`, 'success');
      // 保存后立即重启让等级落地（引擎侧 spawnEngine 读 kxxy-prefs.json）
      await apiPost('/kxxy/api/action', { action: 'restart-engine' });
      showToast('重启请求已提交，引擎将在 1~2 秒内以新等级启动', 'success');
      setTimeout(fetchState, 4000);
      setTimeout(fetchState, 9000);
    } catch {
      dom.btnPrivApply.disabled = false;
      fetchState();
    }
  }

  function initActionButtons() {
    // 快速刷新按钮
    if (dom.btnQuickRefresh) {
      dom.btnQuickRefresh.addEventListener('click', async () => {
        showToast('正在刷新状态...', 'info');
        await Promise.all([fetchState(), fetchExtensions()]);
        showToast('数据已更新', 'success');
      });
    }

    // 重启引擎进程（真通道：restart.request → 原生层轮询消费）
    if (dom.btnRestartEngine) {
      dom.btnRestartEngine.addEventListener('click', async () => {
        if (!confirm('确定要重启 DSH Harness 引擎进程吗？这可能会短暂中断当前任务。')) {
          return;
        }
        dom.btnRestartEngine.disabled = true;
        showToast('正在发送重启命令...', 'warning');
        try {
          const res = await apiPost('/kxxy/api/action', { action: 'restart-engine' });
          showToast(res && res.note ? res.note : '引擎正在重启，稍后自动恢复连接', 'success');
          // 重启后状态要过一会才回来，多等几拍
          setTimeout(fetchState, 4000);
          setTimeout(fetchState, 9000);
        } catch {
          // 错误已提示
        } finally {
          setTimeout(() => { dom.btnRestartEngine.disabled = false; }, 3000);
        }
      });
    }

    // 导出诊断日志（A+B 双写：优先 Download/kxxy，失败退回应用私有目录）
    if (dom.btnExportLogs) {
      dom.btnExportLogs.addEventListener('click', async () => {
        dom.btnExportLogs.disabled = true;
        showToast('正在打包诊断日志...', 'info');
        try {
          const res = await apiPost('/kxxy/api/action', { action: 'export-logs' });
          if (res && res.ok) {
            if (res.location === 'download') {
              showToast(`已保存到下载目录：${res.path}`, 'success');
            } else {
              showToast(`已保存到应用私有目录：${res.path}`, 'warning');
              showToast('可在系统设置中开启「所有文件访问」后重试，即可保存到下载目录', 'info');
            }
          }
        } finally {
          dom.btnExportLogs.disabled = false;
        }
      });
    }

    // 权限等级：模式卡选中后「应用并重启引擎」
    if (dom.btnPrivApply) {
      dom.btnPrivApply.addEventListener('click', () => applyPrivMode());
    }

    // 开关绑定 (常驻前台 / 看门狗 / 局域网反代)
    const toggleBindings = [
      { el: dom.toggleForeground, key: 'foreground' },
      { el: dom.toggleWatchdog, key: 'watchdog' },
      { el: dom.toggleLan, key: 'lan' }
    ];

    toggleBindings.forEach(({ el: toggleEl, key }) => {
      if (!toggleEl) return;
      toggleEl.addEventListener('change', async () => {
        const checked = toggleEl.checked;
        try {
          await apiPost('/kxxy/api/action', {
            action: 'set-toggle',
            key,
            value: checked
          });
          showToast(`已${checked ? '启用' : '禁用'}相应守护项`, 'success');
        } catch {
          toggleEl.checked = !checked; // 失败时恢复状态
        }
      });
    });
  }

  // ==========================================
  // 7. 启动配置体检（方案 K 的常驻形态）
  // ==========================================
  //
  // 为什么体检在前端做轮询而不是推送：体检本身很便宜（六个文件解析），
  // 但引擎侧没有推送通道，且这个页面的刷新语义就是「我现在看一眼」。
  // 用户切到体检页时拉一次，之后每 POLL_INTERVAL 拉一次。
  //
  // 为什么不自动定时刷新：解析三层 YAML 虽然快，但没必要在用户没看的时候
  // 每 5 秒跑一遍。只在体检页可见时才轮询（见 initHealth 的可见性判断）。

  /** 体检结果缓存：修复时要拿它的 level 决定推荐力度。 */
  let lastHealth = null;
  /** 体检轮询定时器（仅体检页可见时存在）。 */
  let healthTimer = null;
  /** 修复请求是否已发出、正在等引擎重启。 */
  let recoveryPending = false;

  const LEVEL_META = {
    L1: {
      title: 'L1 · 软恢复',
      desc: '移走写坏的配置补丁，把插件列表收回核心三项。不删数据、不联网，可撤销。',
      className: ''
    },
    L2: {
      title: 'L2 · 隔离第三方插件',
      desc: '在 L1 基础上把第三方插件挪到隔离区，插件包仍保留，随时能装回。',
      className: ''
    },
    L3: {
      title: 'L3 · 重建插件目录',
      desc: '备份后整体重建 profile 的 node_modules，需要联网重新下载。不影响会话数据。',
      className: 'danger'
    }
  };

  async function fetchHealth(manual) {
    if (!dom.healthChecks) return;
    try {
      const data = await apiGet('/kxxy/api/health');
      lastHealth = data;
      renderHealth(data);
      if (manual) showToast('体检完成', 'success');
    } catch {
      // apiGet 已提示；这里把页面切到「读不到」而不是留旧数据骗人
      if (dom.healthHeadline) dom.healthHeadline.textContent = '体检失败';
      if (dom.healthSubline) dom.healthSubline.textContent = '无法连接引擎，稍后重试';
      if (dom.healthRing) dom.healthRing.setAttribute('data-state', 'warn');
      if (dom.healthRingIcon) dom.healthRingIcon.textContent = '!';
    }
  }

  function renderHealth(data) {
    if (!data) return;
    const checks = Array.isArray(data.checks) ? data.checks : [];
    const bad = checks.filter(c => c.verdict === 'BAD');
    const unknown = checks.filter(c => c.verdict === 'UNKNOWN');

    // ── 总评 ──────────────────────────────────────────────
    let ringState = 'ok';
    let ringIcon = '✓';
    if (bad.length) {
      ringState = 'bad';
      ringIcon = '✕';
    } else if (unknown.length) {
      ringState = 'warn';
      ringIcon = '!';
    }
    if (dom.healthRing) dom.healthRing.setAttribute('data-state', ringState);
    if (dom.healthRingIcon) dom.healthRingIcon.textContent = ringIcon;
    if (dom.healthHeadline) dom.healthHeadline.textContent = data.headline || '体检完成';
    if (dom.healthSubline) {
      const okCount = checks.length - bad.length - unknown.length;
      dom.healthSubline.textContent = `${okCount}/${checks.length} 项正常`
        + (bad.length ? ` · ${bad.length} 项有问题` : '')
        + (unknown.length ? ` · ${unknown.length} 项无法验证` : '')
        + ' · ' + formatClock(data.checkedAt);
    }

    // ── 检查项列表 ────────────────────────────────────────
    if (dom.healthChecks) {
      dom.healthChecks.innerHTML = '';
      checks.forEach(item => {
        const div = document.createElement('div');
        div.className = 'check-item';

        // 三态映射。UNKNOWN 刻意用中性灰：它是「我没法验证」，
        // 染成绿色会让人误以为没问题，染成红色又是在报假警。
        let iconClass = 'check-status-icon success';
        let iconSymbol = '✓';
        let badgeText = '正常';
        if (item.verdict === 'BAD') {
          iconClass = 'check-status-icon fail';
          iconSymbol = '✕';
          badgeText = '有问题';
        } else if (item.verdict === 'UNKNOWN') {
          iconClass = 'check-status-icon unknown';
          iconSymbol = '–';
          badgeText = '未知';
        }

        const fixHint = item.verdict === 'BAD' && item.fixHint
          ? `<div class="check-fixhint">${escapeHtml(item.fixHint)}</div>`
          : '';

        div.innerHTML = `
          <div class="${iconClass}" aria-hidden="true">${iconSymbol}</div>
          <div class="check-content">
            <div class="check-main">
              <span class="check-name">${escapeHtml(item.title || item.code)}</span>
              <span class="check-badge">${escapeHtml(badgeText)}</span>
            </div>
            <div class="check-detail">${escapeHtml(item.detail || '')}</div>
            ${fixHint}
          </div>
        `;
        dom.healthChecks.appendChild(div);
      });
    }

    if (dom.healthCountBadge) {
      dom.healthCountBadge.textContent = bad.length
        ? `${bad.length} 项待修`
        : (unknown.length ? `${unknown.length} 项未知` : '全部通过');
    }

    // ── 修复区 ────────────────────────────────────────────
    // 只在真有 BAD 项时出现。全绿却给个「修复」按钮，用户会以为有隐患。
    if (dom.healthRepairCard) {
      dom.healthRepairCard.hidden = bad.length === 0;
    }
    if (bad.length && dom.healthLevels) {
      renderRepairLevels(data.level || 'L1');
    }

    // ── 上次修复记录 ──────────────────────────────────────
    const last = data.lastRecovery;
    if (dom.healthLastCard) {
      dom.healthLastCard.hidden = !last;
    }
    if (last) {
      if (dom.healthLastTime) {
        dom.healthLastTime.textContent = `${formatClock(last.createdAt)} · ${last.level}`
          + (last.headline ? ` · ${last.headline}` : '');
      }
      if (dom.healthLastChanges) {
        dom.healthLastChanges.innerHTML = '';
        const changes = Array.isArray(last.changes) ? last.changes : [];
        if (!changes.length) {
          const empty = document.createElement('div');
          empty.className = 'repair-change-item';
          empty.textContent = '这次修复没有改动任何文件（配置本来就正常）。';
          dom.healthLastChanges.appendChild(empty);
        }
        changes.forEach(text => {
          const row = document.createElement('div');
          row.className = 'repair-change-item';
          row.innerHTML = `<span class="repair-change-dot"></span><span>${escapeHtml(text)}</span>`;
          dom.healthLastChanges.appendChild(row);
        });
      }
    }

    // ── 撤销按钮 ──────────────────────────────────────────
    if (dom.healthRepairFoot) {
      dom.healthRepairFoot.hidden = !(data.recoveryCount > 0);
    }
  }

  /**
   * 渲染三档修复按钮。
   *
   * 推荐档由后端给（`data.level`）：后端看的是「哪一项坏了」，
   * 运行时坏了才推荐 L3，配置坏了推荐 L1。前端不重复这套判断。
   *
   * 三档都始终可点（除了 L3 需二次确认），因为用户可能知道后端不知道
   * 的事 —— 比如刚装了某个插件想整体回退。但推荐档必须显眼。
   */
  function renderRepairLevels(recommended) {
    dom.healthLevels.innerHTML = '';
    ['L1', 'L2', 'L3'].forEach(level => {
      const meta = LEVEL_META[level];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'repair-level'
        + (level === recommended ? ' recommended' : '')
        + (meta.className ? ` ${meta.className}` : '');
      btn.innerHTML = `
        <span class="repair-level-badge">${level}</span>
        <span class="repair-level-text">
          <span class="repair-level-title">${escapeHtml(meta.title)}${level === recommended ? ' · 推荐' : ''}</span>
          <span class="repair-level-desc">${escapeHtml(meta.desc)}</span>
        </span>
        <svg class="repair-level-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 5L16 12L9 19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      btn.addEventListener('click', () => requestRecovery(level));
      dom.healthLevels.appendChild(btn);
    });
  }

  /**
   * 发起修复。
   *
   * 通道：POST /kxxy/api/recovery → 引擎写 recovery.request →
   * 原生 EngineSupervisor 的请求轮询消费 → RecoveryManager 执行 →
   * 引擎重启 → 新进程写 recovery-result.json。
   *
   * 为什么不在引擎里直接修：修复要移文件、重写清单、重启自身进程 ——
   * 一个进程没法体面地重启自己，而且引擎正在被修的目录里跑着。
   */
  async function requestRecovery(level) {
    if (recoveryPending) {
      showToast('上一次修复还在进行中', 'warning');
      return;
    }

    // L3 会重建 node_modules（联网 + 耗时长），必须二次确认。
    if (level === 'L3') {
      const ok = confirm(
        'L3 会备份并重建插件目录，需要联网重新下载依赖，可能需要几分钟。\n'
        + '会话记录、工作区文件不受影响。\n\n确定继续吗？'
      );
      if (!ok) return;
    }

    recoveryPending = true;
    setHealthBusy(true, `正在执行 ${level} 修复…`, '引擎会重启，完成后页面自动刷新');

    try {
      await apiPost('/kxxy/api/recovery', { level, headline: lastHealth ? lastHealth.headline : '' });
      showToast(`${level} 修复已下发，引擎正在重启`, 'success');
      // 引擎重启需要时间：轮询等它回来，回来后重新体检一次确认效果
      pollAfterRecovery();
    } catch {
      recoveryPending = false;
      setHealthBusy(false);
    }
  }

  /**
   * 修复后等待引擎恢复。
   *
   * 引擎重启期间所有 API 都会失败（连接被拒），所以这里不能用 apiGet
   * （它会弹一堆「获取数据失败」的 toast）。改用裸 fetch + 吞掉异常，
   * 直到 /api/health 能返回 200 为止。
   *
   * 最多等 90 秒（引擎启动 + 健康检查超时是 45 秒，留一倍余量），
   * 超时就明确告诉用户「没等到」，而不是无限转圈。
   */
  function pollAfterRecovery() {
    const deadline = Date.now() + 90_000;
    const tick = async () => {
      if (Date.now() > deadline) {
        recoveryPending = false;
        setHealthBusy(false);
        showToast('引擎重启耗时较长，请稍后手动刷新体检页', 'warning');
        return;
      }
      try {
        const res = await fetch('/kxxy/api/health', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          lastHealth = data;
          renderHealth(data);
          recoveryPending = false;
          setHealthBusy(false);
          if (data.ok) {
            showToast('修复完成，配置已恢复正常', 'success');
          } else {
            // 修复完还有红项：可能是 L1 解不了的问题，让用户看到真实结论
            showToast('引擎已恢复，但仍有问题项，请查看下方结论', 'warning');
          }
          // 修复结果文件读一次，把「修了什么」补进页面
          fetchRecoveryResult();
          return;
        }
      } catch {
        // 引擎还没起来，正常
      }
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 3000);
  }

  /**
   * 读原生层写的修复结果（recovery-result.json）。
   *
   * 与 /api/health 里的 lastRecovery 有重叠但不等价：lastRecovery 读的是
   * 备份目录里的 manifest.json（持久、跨重启有效），result 是原生层刚写完
   * 的那一次（可能包含失败原因）。两者都读，页面上以 lastRecovery 为准，
   * 失败原因用 result 补充。
   */
  async function fetchRecoveryResult() {
    try {
      const data = await apiGet('/kxxy/api/recovery/result');
      const result = data && data.result;
      if (result && result.ok === false && result.error) {
        showToast(`修复未完成：${result.error}`, 'error');
      }
    } catch {
      // 读不到就算了，不影响主流程
    }
  }

  async function undoLastRecovery() {
    if (!confirm('撤销上次修复会把移走的配置文件放回去、恢复原来的插件列表，然后重启引擎。\n\n如果原来的配置本来就是坏的，撤销后引擎会再次起不来。确定继续吗？')) {
      return;
    }
    setHealthBusy(true, '正在撤销…', '引擎会重启，完成后页面自动刷新');
    try {
      // 撤销同样是「请原生层动手」：引擎自己搬不动正在用的文件。
      await apiPost('/kxxy/api/recovery', { level: 'UNDO' });
      showToast('撤销已下发，引擎正在重启', 'success');
      pollAfterRecovery();
    } catch {
      setHealthBusy(false);
    }
  }

  function setHealthBusy(busy, title, desc) {
    if (dom.healthBusy) dom.healthBusy.hidden = !busy;
    if (busy && title && dom.healthBusyTitle) dom.healthBusyTitle.textContent = title;
    if (busy && desc && dom.healthBusyDesc) dom.healthBusyDesc.textContent = desc;
    // 修复期间禁用按钮，避免连点下发多次
    if (dom.healthLevels) {
      dom.healthLevels.querySelectorAll('.repair-level').forEach(b => {
        b.disabled = busy;
      });
    }
  }

  /** 时间戳 → HH:mm:ss（体检页的时间显示，跨天不显示日期，够用）。 */
  function formatClock(ms) {
    if (!ms) return '—';
    const d = new Date(Number(ms));
    if (isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /**
   * 体检页初始化。
   *
   * 轮询只在「体检页可见」时跑：
   *   · 切到体检 tab → 立刻拉一次 + 开轮询
   *   · 切走 → 停轮询（省电，也别在用户没看时反复解析 YAML）
   *   · 整个页面隐藏（切后台）→ initLifecycle 会统一停掉所有轮询
   *
   * 注意：不能只在 init() 里拉一次 —— 用户可能开着体检页等引擎自己
   * 恢复，这时候需要持续刷新才能看到状态变化。
   */
  function initHealth() {
    if (dom.btnHealthRefresh) {
      dom.btnHealthRefresh.addEventListener('click', () => fetchHealth(true));
    }
    if (dom.btnHealthUndo) {
      dom.btnHealthUndo.addEventListener('click', undoLastRecovery);
    }

    // Tab 切换时控制体检轮询（复用 initTabSwitch 的点击，这里额外挂一个）
    dom.tabItems.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-target');
        if (target === 'health') startHealthPolling();
        else stopHealthPolling();
      });
    });
  }

  function startHealthPolling() {
    fetchHealth(false);
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      // 修复进行中时不要抢着刷新（引擎正在重启，拉了也是失败）
      if (!recoveryPending) fetchHealth(false);
    }, POLL_INTERVAL);
  }

  function stopHealthPolling() {
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  }

  // ==========================================
  // 8. 轮询生命周期管理 (支持 visibilitychange)
  // ==========================================
  function startPolling() {
    if (pollTimer) return;
    fetchState();
    pollTimer = setInterval(() => {
      fetchState();
      // 扩展列表一并刷新（有安装任务时 renderExtensions 会自动跳过）
      fetchExtensions();
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function initLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopPolling();
      } else {
        startPolling();
      }
    });
  }

  // ==========================================
  // 初始化引导入口
  // ==========================================
  function init() {
    applyTheme();
    // 老 WebView 的 addEventListener 可能在 matchMedia 上不可用，做能力判断
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', applyTheme);
    else if (darkQuery.addListener) darkQuery.addListener(applyTheme);

    initTabSwitch();
    initCategoryFilter();
    initActionButtons();
    initAboutDialog();
    initBatchActions();
    initHealth();
    initLifecycle();

    // 启动初始拉取
    startPolling();
    fetchExtensions();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
