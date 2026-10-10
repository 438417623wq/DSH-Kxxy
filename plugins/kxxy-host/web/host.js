/**
 * DSH Kxxy Host Dashboard - Core Client Logic
 * Standard ES2020 Implementation without external dependencies
 */

(() => {
  'use strict';

  // ==========================================
  // 常量与状态配置
  // ==========================================
  const POLL_INTERVAL = 5000;
  let pollTimer = null;

  const PRIV_DESCRIPTIONS = {
    normal: '当前处于标准应用沙箱环境，保护隐私同时满足绝大多数 Harness Agent 代码任务。',
    shizuku: '通过 Shizuku 授权获取系统 ADB 调试级执行能力，可管理部分系统设置与调试服务。',
    root: '已请求 Root 超级用户权限，允许 su 执行无限制底层系统调用与挂载操作。'
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
    btnSwitchMirror: document.getElementById('btn-switch-mirror'),
    extensionsList: document.getElementById('extensions-list'),
    categoryChips: document.querySelectorAll('.category-chip'),

    // 终端视图元素
    terminalViewport: document.getElementById('terminal-viewport'),
    terminalCodeStream: document.getElementById('terminal-code-stream'),
    btnTermClear: document.getElementById('btn-term-clear'),
    btnTermRefresh: document.getElementById('btn-term-refresh'),
    termKeys: document.querySelectorAll('.term-key'),

    // 设置视图元素
    privModeSegment: document.getElementById('priv-mode-segment'),
    privModeDescription: document.getElementById('priv-mode-description'),
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
    }, 3000);
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
    if (lower.includes('clang') || lower.includes('llvm') || lower.includes('c++')) {
      return { text: 'C++', colorClass: 'clang-color' };
    }
    if (lower.includes('ffmpeg') || lower.includes('media')) {
      return { text: 'FF', colorClass: 'media-color' };
    }
    if (lower.includes('ripgrep') || lower.includes('rg') || lower.includes('fd')) {
      return { text: 'Rg', colorClass: 'rg-color' };
    }
    if (lower.includes('rust') || lower.includes('cargo')) {
      return { text: 'Rs', colorClass: 'rust-color' };
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
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} (${response.statusText})`);
      }
      return await response.json().catch(() => ({ success: true }));
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
      if (engine.privMode && dom.privModeSegment) {
        updatePrivModeUi(engine.privMode);
      }
    } catch {
      // 错误已在 apiGet 中通过 showToast 提示
    }
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
  // 3. 扩展视图系统 (fetch('/kxxy/api/extensions'))
  // ==========================================
  async function fetchExtensions() {
    if (!dom.extensionsList) return;
    try {
      const data = await apiGet('/kxxy/api/extensions');
      const items = (data && data.items) || [];
      renderExtensionsList(items);
    } catch {
      // 错误已由 apiGet 提示
    }
  }

  function renderExtensionsList(items) {
    if (!dom.extensionsList) return;
    if (!items || items.length === 0) {
      return; // 保持原有占位或空态
    }

    dom.extensionsList.innerHTML = '';
    items.forEach(ext => {
      const id = ext.id || '';
      const name = ext.name || id;
      const version = ext.version || 'v1.0.0';
      const desc = ext.description || 'Harness 专有 Android 环境编译与运行时扩展支持。';
      const isInstalled = Boolean(ext.installed || (ext.bins && ext.bins.length > 0));
      const badge = getExtBadgeInfo(id);

      const card = document.createElement('div');
      card.className = 'card ext-card';
      card.setAttribute('data-category', ext.category || 'devtools');

      let binsHtml = '';
      if (Array.isArray(ext.bins)) {
        binsHtml = ext.bins.map(b => `<span class="tag-item">${escapeHtml(b)}</span>`).join('');
      } else if (id) {
        binsHtml = `<span class="tag-item">${escapeHtml(id)}</span>`;
      }

      card.innerHTML = `
        <div class="ext-card-inner">
          <div class="ext-icon-box ${badge.colorClass}">${escapeHtml(badge.text)}</div>
          <div class="ext-body">
            <div class="ext-header">
              <h4 class="ext-name">${escapeHtml(name)}</h4>
              <span class="ext-version">${escapeHtml(version)}</span>
            </div>
            <p class="ext-desc">${escapeHtml(desc)}</p>
            <div class="ext-tags">${binsHtml}</div>
          </div>
          <div class="ext-action">
            ${
              isInstalled
                ? `<button class="button button-installed button-sm" disabled>已激活</button>`
                : `<button class="button button-primary button-sm" data-action="install-ext" data-ext-id="${escapeHtml(id)}">获取</button>`
            }
          </div>
        </div>
      `;

      // 绑定安装动作
      const installBtn = card.querySelector('[data-action="install-ext"]');
      if (installBtn) {
        installBtn.addEventListener('click', async () => {
          installBtn.disabled = true;
          installBtn.textContent = '安装中...';
          try {
            await apiPost('/kxxy/api/action', { action: 'install-ext', id });
            showToast(`扩展 ${name} 安装成功`, 'success');
            fetchExtensions();
          } catch {
            installBtn.disabled = false;
            installBtn.textContent = '获取';
          }
        });
      }

      dom.extensionsList.appendChild(card);
    });
  }

  function initCategoryFilter() {
    dom.categoryChips.forEach(chip => {
      chip.addEventListener('click', () => {
        dom.categoryChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');

        const cat = chip.getAttribute('data-category');
        const cards = dom.extensionsList ? dom.extensionsList.querySelectorAll('.ext-card') : [];
        cards.forEach(card => {
          if (cat === 'all' || card.getAttribute('data-category') === cat) {
            card.style.display = 'block';
          } else {
            card.style.display = 'none';
          }
        });
      });
    });
  }

  // ==========================================
  // 4. 终端日志系统 (fetch('/kxxy/api/log'))
  // ==========================================
  async function fetchLog() {
    if (!dom.terminalCodeStream) return;
    try {
      const data = await apiGet('/kxxy/api/log');
      if (data && typeof data.tail === 'string') {
        dom.terminalCodeStream.innerHTML = renderAnsi(data.tail);
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
          showToast(`已向终端发送 ${key.toUpperCase()}`, 'info');
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
  // 5. 动作按钮与交互控制
  // ==========================================
  function updatePrivModeUi(mode) {
    if (!dom.privModeSegment) return;
    const buttons = dom.privModeSegment.querySelectorAll('.segment-btn');
    buttons.forEach(btn => {
      const isMatch = btn.getAttribute('data-mode') === mode;
      btn.classList.toggle('active', isMatch);
      btn.setAttribute('aria-checked', isMatch ? 'true' : 'false');
    });

    if (dom.privModeDescription && PRIV_DESCRIPTIONS[mode]) {
      dom.privModeDescription.textContent = PRIV_DESCRIPTIONS[mode];
    }
  }

  function initActionButtons() {
    // 快速刷新按钮
    if (dom.btnQuickRefresh) {
      dom.btnQuickRefresh.addEventListener('click', async () => {
        showToast('正在刷新状态...', 'info');
        await Promise.all([fetchState(), fetchLog(), fetchExtensions()]);
        showToast('数据已更新', 'success');
      });
    }

    // 重启引擎进程
    if (dom.btnRestartEngine) {
      dom.btnRestartEngine.addEventListener('click', async () => {
        if (!confirm('确定要重启 DSH Harness 引擎进程吗？这可能会短暂中断当前任务。')) {
          return;
        }
        dom.btnRestartEngine.disabled = true;
        showToast('正在发送重启命令...', 'warning');
        try {
          await apiPost('/kxxy/api/action', { action: 'restart-engine' });
          showToast('引擎正在重启，稍后自动恢复连接', 'success');
          setTimeout(() => {
            fetchState();
            fetchLog();
            dom.btnRestartEngine.disabled = false;
          }, 3000);
        } catch {
          dom.btnRestartEngine.disabled = false;
        }
      });
    }

    // 导出诊断日志
    if (dom.btnExportLogs) {
      dom.btnExportLogs.addEventListener('click', async () => {
        dom.btnExportLogs.disabled = true;
        showToast('正在打包诊断日志...', 'info');
        try {
          const res = await apiPost('/kxxy/api/action', { action: 'export-logs' });
          if (res && res.downloadUrl) {
            window.open(res.downloadUrl, '_blank');
          }
          showToast('诊断日志导出就绪', 'success');
        } finally {
          dom.btnExportLogs.disabled = false;
        }
      });
    }

    // 切换/测速镜像源
    if (dom.btnSwitchMirror) {
      dom.btnSwitchMirror.addEventListener('click', async () => {
        dom.btnSwitchMirror.disabled = true;
        dom.btnSwitchMirror.textContent = '测速中...';
        try {
          const res = await apiPost('/kxxy/api/action', { action: 'switch-mirror' });
          if (res && res.mirrorName && dom.currentMirrorName) {
            dom.currentMirrorName.textContent = res.mirrorName;
          }
          showToast('镜像源测速与切换完成', 'success');
        } finally {
          dom.btnSwitchMirror.disabled = false;
          dom.btnSwitchMirror.textContent = '测速';
        }
      });
    }

    // 权限分段单选控件
    if (dom.privModeSegment) {
      const segBtns = dom.privModeSegment.querySelectorAll('.segment-btn');
      segBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
          const mode = btn.getAttribute('data-mode');
          if (!mode) return;
          updatePrivModeUi(mode);
          try {
            await apiPost('/kxxy/api/action', { action: 'set-priv-mode', value: mode });
            showToast(`权限等级已设置为: ${mode}`, 'success');
          } catch {
            fetchState(); // 失败时回滚状态
          }
        });
      });
    }

    // 开关绑定 (常驻前台 / 看门狗 / 局域网反代)
    const toggleBindings = [
      { el: dom.toggleForeground, key: 'foreground' },
      { el: dom.toggleWatchdog, key: 'watchdog' },
      { el: dom.toggleLan, key: 'lan' }
    ];

    toggleBindings.forEach(({ el, key }) => {
      if (!el) return;
      el.addEventListener('change', async () => {
        const checked = el.checked;
        try {
          await apiPost('/kxxy/api/action', {
            action: 'set-toggle',
            key,
            value: checked
          });
          showToast(`已${checked ? '启用' : '禁用'}相应守护项`, 'success');
        } catch {
          el.checked = !checked; // 失败时恢复状态
        }
      });
    });
  }

  // ==========================================
  // 6. 轮询生命周期管理 (支持 visibilitychange)
  // ==========================================
  function startPolling() {
    if (pollTimer) return;
    fetchState();
    fetchLog();
    pollTimer = setInterval(() => {
      fetchState();
      fetchLog();
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
    initTabSwitch();
    initCategoryFilter();
    initTerminalActions();
    initActionButtons();
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
