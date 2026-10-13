/**
 * DSH Kxxy Host Dashboard - Core Client Logic
 * Standard ES2020 Implementation without external dependencies
 *
 * 五项改进方案落地版：
 *   · 扩展中心渲染真实目录（包池 × 安装状态），「获取」走 202 + jobId 轮询
 *   · 镜像源真实测速（POST /kxxy/api/mirror/test）与真实切换（/apply）
 *   · 重启引擎 / 导出日志 / 权限 / 开关 / 终端快捷键全部走真分派表
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

  // 检测减少动效偏好
  const prefersReducedMotion = () => {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    currentMirrorName: document.getElementById('current-mirror-name'),
    mirrorSub: document.getElementById('mirror-sub'),
    mirrorResults: document.getElementById('mirror-results'),
    btnSwitchMirror: document.getElementById('btn-switch-mirror'),
    extensionsList: document.getElementById('extensions-list'),
    builtinSummary: document.getElementById('builtin-summary'),
    extBatchBar: document.getElementById('ext-batch-bar'),
    extBatchCount: document.getElementById('ext-batch-count'),
    btnExtSelectAll: document.getElementById('btn-ext-select-all'),
    btnExtSelectNone: document.getElementById('btn-ext-select-none'),
    btnExtBatchInstall: document.getElementById('btn-ext-batch-install'),
    btnExtBatchRemove: document.getElementById('btn-ext-batch-remove'),
    categoryChips: document.querySelectorAll('.category-chip'),

    // 终端视图元素
    terminalViewport: document.getElementById('terminal-viewport'),
    terminalCodeStream: document.getElementById('terminal-code-stream'),
    btnTermClear: document.getElementById('btn-term-clear'),
    btnTermRefresh: document.getElementById('btn-term-refresh'),
    termKeys: document.querySelectorAll('.term-key'),

    // 设置视图元素
    privCards: document.getElementById('priv-cards'),
    privModeDescription: document.getElementById('priv-mode-description'),
    btnPrivApply: document.getElementById('btn-priv-apply'),
    appearanceList: document.getElementById('appearance-list'),
    shellDiagBody: document.getElementById('shell-diag-body'),
    permList: document.getElementById('perm-list'),
    toggleForeground: document.getElementById('toggle-foreground'),
    toggleWatchdog: document.getElementById('toggle-watchdog'),
    toggleLan: document.getElementById('toggle-lan'),
    infoNodeVer: document.getElementById('info-node-ver'),
    infoPnpmVer: document.getElementById('info-pnpm-ver'),
    btnRestartEngine: document.getElementById('btn-restart-engine'),
    btnExportLogs: document.getElementById('btn-export-logs'),

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

  function renderAnsi(text) {
    if (!text) return '';
    let escaped = escapeHtml(text);

    // 标准 ANSI 常用颜色码转换
    escaped = escaped
      .replace(/\x1b\[31m([\s\S]*?)\x1b\[0m/g, '<span style="color:var(--accent-red)">$1</span>')
      .replace(/\x1b\[32m([\s\S]*?)\x1b\[0m/g, '<span class="ansi-green">$1</span>')
      .replace(/\x1b\[33m([\s\S]*?)\x1b\[0m/g, '<span class="ansi-yellow">$1</span>')
      .replace(/\x1b\[36m([\s\S]*?)\x1b\[0m/g, '<span class="ansi-cyan">$1</span>')
      .replace(/\x1b\[\d+(?:;\d+)*m/g, ''); // 移除剩余 ANSI 代码

    // 关键字语义词法高亮
    escaped = escaped
      .replace(/(\[dsh(?:-[a-zA-Z0-9]+)?\]|\[agent\])/g, '<span class="ansi-cyan">$1</span>')
      .replace(/(\[boot\]|\bWARN(?:ING)?\b)/g, '<span class="ansi-yellow">$1</span>')
      .replace(/(\[http\]|\bSUCCESS\b|\bOK\b)/g, '<span class="ansi-green">$1</span>')
      .replace(/(\bERR(?:OR)?\b|\bFAIL(?:ED)?\b|\[error\])/gi, '<span style="color:var(--accent-red)">$1</span>');

    return escaped;
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

        // 切换到终端视图时自动滚动到底部
        if (targetView === 'terminal') {
          scrollTerminalToBottom();
        }
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
      // 6) 系统权限卡片 + 终端 shell 诊断
      renderPermissions(engine);
      renderShellDiagnostics(runtime.engineRoot);
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
   * 终端 shell 诊断卡（三轮②）。
   *
   * ⚠ 关于 `dsh.terminal.shell` 这个键：它**已被官方前端废弃**。
   * 在运行时 bundle 里逐文件统计（sidebar-terminal / client.terminal /
   * terminal-bash / terminal 四个包）对 `/terminal\.shell/`、`/localStorage/`
   * 的命中数都是 0 —— 官方当前版本根本不读这个键。官方新建终端走的是
   * `webTerminals.selectShell(path)` → 打开 tab 时把 `shellPath` 作为参数传下去。
   *
   * 所以这张卡的定位是「历史遗留缓存的清理入口」，不是「终端故障的唯一解释」。
   * 早期版本的判据只有 `cached.startsWith(engineRoot + '/')`，于是引擎 bin 目录下的
   * **任何**可执行文件都算「有效」—— 实测设备上缓存着 `…/engine/bin/cmd`
   * （那是 Android 的 `cmd` 服务工具，`cmd --help` 报 "Can't find service"，
   * 完全不是 shell），卡片却显示「✓ 缓存有效」，误导用户以为终端没问题/问题在此。
   * 现在判据收紧到「必须是已知 shell 的可执行文件名」。
   */
  const SHELL_CACHE_KEY = 'dsh.terminal.shell';
  /** 引擎 bin/ 下真正的 shell（实测清单：ash 4320B / bash 880416B / dash 117040B / sh 117040B）。 */
  const KNOWN_SHELLS = ['bash', 'sh', 'dash', 'ash', 'zsh', 'fish'];
  let shellWarnShown = false;

  function shellCacheState(engineRoot) {
    let cached = null;
    try {
      cached = localStorage.getItem(SHELL_CACHE_KEY);
    } catch {
      cached = null;
    }
    if (!cached) return { cached: null, valid: null, reason: '未缓存（新建终端将使用引擎默认 shell）' };
    if (!engineRoot) return { cached, valid: null, reason: '引擎根目录未知，无法校验' };
    const inEngine = cached.startsWith(engineRoot + '/');
    const base = cached.slice(cached.lastIndexOf('/') + 1).toLowerCase();
    const isShell = KNOWN_SHELLS.includes(base);
    const valid = inEngine && isShell;
    return {
      cached,
      valid,
      reason: valid
        ? '缓存指向引擎自带的 shell'
        : !inEngine
          ? '缓存路径不在引擎目录内（多半是 SHELL 修复前留下的旧路径）'
          : `缓存指向的不是 shell（${base}），新建终端会失败`,
    };
  }

  function renderShellDiagnostics(engineRoot) {
    if (!dom.shellDiagBody) return;
    const st = shellCacheState(engineRoot);
    dom.shellDiagBody.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'setting-row';

    if (st.cached === null) {
      div.innerHTML = `
        <div class="setting-info">
          <span class="setting-title">✓ 未缓存 shell</span>
          <span class="setting-desc">新建终端将使用引擎自带的 bash（${escapeHtml(engineRoot || '<engineRoot>' )}/bin/bash）</span>
        </div>
      `;
    } else if (st.valid === true) {
      div.innerHTML = `
        <div class="setting-info">
          <span class="setting-title">✓ ${escapeHtml(st.reason)}</span>
          <span class="setting-desc code-font">${escapeHtml(st.cached)}</span>
        </div>
      `;
    } else {
      div.innerHTML = `
        <div class="setting-info">
          <span class="setting-title" style="color:var(--accent-red)">⚠ ${escapeHtml(st.reason)}</span>
          <span class="setting-desc code-font">${escapeHtml(st.cached)}</span>
          <span class="setting-desc">这是早期版本留下的缓存；不清除的话「新建终端」会一直用它并失败。</span>
        </div>
      `;
      const btn = el('<button class="button button-warning button-sm">清除缓存</button>');
      btn.addEventListener('click', () => {
        try {
          localStorage.removeItem(SHELL_CACHE_KEY);
        } catch { /* 隐私模式等场景 */ }
        showToast('已清除终端 shell 缓存，回到对话界面重新打开/新建终端即可', 'success');
        renderShellDiagnostics(engineRoot);
      });
      div.appendChild(btn);
    }
    dom.shellDiagBody.appendChild(div);

    // 进入控制台后提示一次（不强制清除）
    if (st.valid === false && !shellWarnShown) {
      shellWarnShown = true;
      showToast('检测到终端 shell 缓存失效（新建终端会失败的常见原因），请到「终端」页一键清除', 'warning');
    }
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
      if (group.collapsible) body.classList.add('collapsed');
      // 已激活组：点标题展开/收起（其余组保持常开）
      if (group.collapsible) {
        title.addEventListener('click', () => body.classList.toggle('collapsed'));
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
  // 4. 镜像源：真实测速 + 真实切换
  // ==========================================
  async function fetchMirror() {
    try {
      const m = await apiGet('/kxxy/api/mirror');
      if (!m) return;
      if (dom.currentMirrorName && m.name) {
        dom.currentMirrorName.textContent = m.name;
      }
      if (dom.mirrorSub) {
        dom.mirrorSub.textContent = '点击「测速」获取各源真实延迟';
      }
    } catch {
      // 错误已提示
    }
  }

  function initMirrorActions() {
    if (!dom.btnSwitchMirror) return;
    dom.btnSwitchMirror.addEventListener('click', async () => {
      dom.btnSwitchMirror.disabled = true;
      dom.btnSwitchMirror.textContent = '测速中...';
      if (dom.mirrorResults) dom.mirrorResults.innerHTML = '';
      try {
        const res = await apiPost('/kxxy/api/mirror/test', {});
        renderMirrorResults((res && res.results) || []);
      } catch {
        // 错误已提示
      } finally {
        dom.btnSwitchMirror.disabled = false;
        dom.btnSwitchMirror.textContent = '测速';
      }
    });
  }

  function renderMirrorResults(results) {
    if (!dom.mirrorResults) return;
    dom.mirrorResults.innerHTML = '';
    if (!results.length) {
      dom.mirrorResults.innerHTML = '<div class="mirror-row"><span class="mirror-ms">测速失败</span></div>';
      return;
    }
    const sorted = [...results].sort((a, b) => (a.ms ?? 1e9) - (b.ms ?? 1e9));
    sorted.forEach(m => {
      const row = document.createElement('div');
      row.className = 'mirror-row';
      const msText = m.ms === null || m.ms === undefined ? '超时' : `${m.ms} ms`;
      row.innerHTML = `
        <span class="mirror-row-name">${escapeHtml(m.name)}</span>
        <span class="mirror-ms">${escapeHtml(msText)}</span>
      `;
      const applyBtn = el('<button class="button button-subtle button-sm">应用</button>');
      if (m.ms === null) applyBtn.disabled = true;
      applyBtn.addEventListener('click', () => applyMirror(m));
      row.appendChild(applyBtn);
      dom.mirrorResults.appendChild(row);
    });
  }

  async function applyMirror(m) {
    try {
      const res = await apiPost('/kxxy/api/mirror/apply', { id: m.id });
      if (dom.currentMirrorName && res.mirror && res.mirror.name) {
        dom.currentMirrorName.textContent = res.mirror.name;
      }
      showToast(`${m.name} 已写入 npmrc。重启引擎后对引擎生效`, 'success');
      // 一键重启（restart-engine 现在是真通道：原生层 1~2 秒内消费）
      if (confirm('镜像源已写入。是否立即重启引擎使其生效？')) {
        await apiPost('/kxxy/api/action', { action: 'restart-engine' });
        showToast('重启请求已提交，引擎将在 1~2 秒内重启', 'success');
      }
    } catch {
      // 错误已提示
    }
  }

  // ==========================================
  // 5. 终端日志系统 (fetch('/kxxy/api/log'))
  // ==========================================
  async function fetchLog() {
    if (!dom.terminalCodeStream) return;
    try {
      const data = await apiGet('/kxxy/api/log');
      if (data && typeof data.tail === 'string') {
        dom.terminalCodeStream.innerHTML = renderAnsi(data.tail) || '<span style="color:var(--text-muted)">（暂无日志输出）</span>';
        scrollTerminalToBottom();
      }
    } catch {
      // 终端日志拉取失败静默通知
    }
  }

  function scrollTerminalToBottom() {
    if (!dom.terminalViewport) return;
    const reduce = prefersReducedMotion();
    dom.terminalViewport.scrollTo({
      top: dom.terminalViewport.scrollHeight,
      behavior: reduce ? 'auto' : 'smooth'
    });
  }

  function initTerminalActions() {
    if (dom.btnTermClear && dom.terminalCodeStream) {
      dom.btnTermClear.addEventListener('click', () => {
        dom.terminalCodeStream.textContent = '';
        showToast('终端显示已清空', 'info');
      });
    }

    if (dom.btnTermRefresh) {
      dom.btnTermRefresh.addEventListener('click', async () => {
        dom.btnTermRefresh.textContent = '刷新中';
        await fetchLog();
        dom.btnTermRefresh.textContent = '刷新';
        showToast('日志已刷新', 'success');
      });
    }

    dom.termKeys.forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-key');
        if (key === 'clear') {
          if (dom.terminalCodeStream) dom.terminalCodeStream.textContent = '';
          showToast('终端已清空', 'info');
        } else {
          // 真通道：后端把按键写进 stdin.request，原生层写进引擎 PTY（约 1 秒延迟）
          try {
            await apiPost('/kxxy/api/action', { action: 'term-key', key });
          } catch {
            // 容错
          }
        }
      });
    });
  }

  // ==========================================
  // 6. 动作按钮与交互控制
  // ==========================================
  // ==========================================
  // 5. 权限等级：模式卡片组（三轮③）
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
        await Promise.all([fetchState(), fetchLog(), fetchExtensions(), fetchMirror()]);
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
  // 7. 轮询生命周期管理 (支持 visibilitychange)
  // ==========================================
  function startPolling() {
    if (pollTimer) return;
    fetchState();
    fetchLog();
    pollTimer = setInterval(() => {
      fetchState();
      fetchLog();
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
    initTerminalActions();
    initActionButtons();
    initMirrorActions();
    initBatchActions();
    initLifecycle();

    // 启动初始拉取
    startPolling();
    fetchExtensions();
    fetchMirror();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
