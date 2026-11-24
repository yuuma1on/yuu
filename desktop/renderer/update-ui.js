(() => {
  'use strict';

  function start() {
    if (document.getElementById('pulseDesktopUpdatePanel')) return;

    const api = window.pulseDesktop;
    const statuses = new Set(['idle', 'checking', 'available', 'downloading', 'ready', 'upToDate', 'error', 'unsupported']);
    const busyStatuses = new Set(['checking', 'available', 'downloading']);
    let state = { status: 'idle', appVersion: '' };
    let revision = 0;
    let checkRequest = 0;
    let checking = false;
    let installing = false;
    let notice = '';
    let unsubscribe;

    const element = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const text = (node, value) => {
      if (node.textContent !== value) node.textContent = value;
    };
    const version = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
    const panel = element('section', 'pulse-desktop-update');
    panel.id = 'pulseDesktopUpdatePanel';
    panel.setAttribute('aria-labelledby', 'pulseDesktopUpdateHeading');
    const heading = element('h2', 'pulse-desktop-update__heading', 'アプリの更新');
    heading.id = 'pulseDesktopUpdateHeading';
    const current = element('p', 'pulse-desktop-update__version');
    const status = element('p', 'pulse-desktop-update__status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    const next = element('p', 'pulse-desktop-update__next');
    const detail = element('p', 'pulse-desktop-update__detail');
    detail.id = 'pulseDesktopUpdateDetail';
    const progressWrap = element('div', 'pulse-desktop-update__progress');
    const progress = element('progress');
    progress.max = 100;
    progress.setAttribute('aria-label', '更新のダウンロード');
    const progressLabel = element('span', 'pulse-desktop-update__percent');
    progressWrap.append(progress, progressLabel);
    const action = element('button', 'pulse-desktop-update__action');
    action.type = 'button';
    action.setAttribute('aria-describedby', detail.id);
    panel.append(heading, current, status, next, detail, progressWrap, action);

    const narrow = window.matchMedia('(max-width: 740px)');
    function placePanel() {
      const focused = panel.contains(document.activeElement) ? document.activeElement : null;
      const sidebar = document.querySelector('.sidebar-bottom');
      const topbar = document.querySelector('.topbar');
      if (narrow.matches && topbar?.parentElement) {
        topbar.insertAdjacentElement('afterend', panel);
        panel.dataset.location = 'content';
      } else if (sidebar) {
        sidebar.insertBefore(panel, sidebar.querySelector('.sidebar-footer'));
        panel.dataset.location = 'sidebar';
      } else {
        (document.querySelector('.app-shell') || document.body).append(panel);
        panel.dataset.location = 'content';
      }
      focused?.focus({ preventScroll: true });
    }

    function render() {
      const shownStatus = checking && !busyStatuses.has(state.status) && state.status !== 'ready' ? 'checking' : state.status;
      const copy = {
        idle: ['新しいバージョンを確認できます。', ''],
        checking: ['更新を確認しています…', ''],
        available: ['新しいバージョンが見つかりました。', 'まもなくダウンロードを始めます。'],
        downloading: ['更新をダウンロードしています。', '解析はそのまま続けられます。'],
        ready: ['更新の準備ができました。', '必要な結果を保存してから、再起動してください。'],
        upToDate: ['最新のバージョンです。', ''],
        error: ['更新を進められませんでした。', '時間をおいて、もう一度お試しください。'],
        unsupported: ['この環境では自動更新を利用できません。', '']
      }[shownStatus];
      panel.dataset.status = shownStatus;
      text(current, state.appVersion ? `現在のアプリ v${state.appVersion}` : '現在のバージョン —');
      text(status, notice || copy[0]);
      text(detail, copy[1]);
      detail.hidden = !copy[1];
      const showNext = state.availableVersion && ['available', 'downloading', 'ready'].includes(state.status);
      text(next, showNext ? `新しいバージョン v${state.availableVersion}` : '');
      next.hidden = !showNext;
      progressWrap.hidden = !['available', 'downloading'].includes(state.status);
      if (typeof state.progress === 'number' && Number.isFinite(state.progress) && state.status === 'downloading') {
        const percent = Math.min(100, Math.max(0, state.progress));
        progress.value = percent;
        text(progressLabel, `${Math.floor(percent)}%`);
      } else {
        progress.removeAttribute('value');
        text(progressLabel, state.status === 'available' ? '準備中…' : 'ダウンロード中…');
      }
      action.hidden = state.status === 'unsupported';
      action.disabled = installing || (state.status !== 'ready' && (checking || busyStatuses.has(state.status)));
      const label = installing ? '再起動しています…'
        : state.status === 'ready' ? '再起動して更新'
          : checking || state.status === 'checking' ? '確認中…'
            : ['available', 'downloading'].includes(state.status) ? '更新中…'
              : state.status === 'error' ? 'もう一度確認' : '更新を確認';
      text(action, label);
    }

    function receive(value) {
      if (!value || !statuses.has(value.status)) return false;
      revision++;
      state = {
        status: value.status,
        appVersion: version(value.appVersion) || state.appVersion,
        availableVersion: version(value.availableVersion),
        progress: value.progress
      };
      notice = '';
      if (state.status !== 'checking') checking = false;
      if (state.status !== 'ready') installing = false;
      render();
      return true;
    }

    async function check() {
      if (checking || installing || busyStatuses.has(state.status)) return;
      const request = ++checkRequest;
      checking = true;
      notice = '';
      render();
      const startedAt = ++revision;
      try {
        const value = await api.checkForUpdates();
        // Pushed states are authoritative when they arrive during this request.
        if (revision === startedAt && !receive(value)) throw new Error('Missing update state');
      } catch {
        if (request === checkRequest && (revision === startedAt || state.status === 'checking')) receive({ ...state, status: 'error' });
      } finally {
        if (request === checkRequest) checking = false;
        render();
      }
    }

    async function install() {
      if (state.status !== 'ready' || installing) return;
      installing = true;
      notice = '';
      render();
      try {
        await api.installUpdate();
      } catch {
        installing = false;
        if (state.status === 'ready') notice = '再起動できませんでした。もう一度お試しください。';
        render();
      }
    }

    action.addEventListener('click', () => {
      if (state.status === 'ready') void install();
      else void check();
    });
    placePanel();
    narrow.addEventListener('change', placePanel);
    render();

    if (!api || !['getUpdateState', 'checkForUpdates', 'installUpdate', 'onUpdateState'].every(name => typeof api[name] === 'function')) {
      receive({ status: 'unsupported' });
      return;
    }

    // Subscribe before requesting a snapshot so a late snapshot cannot hide a
    // download or ready event that was already delivered to this window.
    try {
      unsubscribe = api.onUpdateState(receive);
    } catch {
      receive({ ...state, status: 'error' });
    }
    const startedAt = revision;
    Promise.resolve().then(() => api.getUpdateState()).then(value => {
      if (revision === startedAt && !receive(value)) receive({ ...state, status: 'error' });
    }).catch(() => {
      if (revision === startedAt) receive({ ...state, status: 'error' });
    });
    window.addEventListener('pagehide', () => {
      if (typeof unsubscribe === 'function') unsubscribe();
      narrow.removeEventListener('change', placePanel);
    }, { once: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
