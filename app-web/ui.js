/* Shared components of the Phase-2 screens. Each returns markup built from tokens.css classes; every text comes
 * from CG.t (i18n.js). Icons are decorative (aria-hidden) and always sit next to a word. */
(function () {
  'use strict';
  const CG = window.CG;
  const { t, esc } = CG;

  // 24px line icons, stroke = currentColor so they take the state color
  const P = {
    shieldOk: 'M12 2.8l7.5 2.8v5.6c0 4.8-3.2 8.3-7.5 10-4.3-1.7-7.5-5.2-7.5-10V5.6zM8.6 12.1l2.4 2.4 4.6-4.9',
    shieldOff: 'M12 2.8l7.5 2.8v5.6c0 4.8-3.2 8.3-7.5 10-4.3-1.7-7.5-5.2-7.5-10V5.6zM12 8v4.6M12 15.8v.2',
    sync: 'M20 11a8 8 0 0 0-14.3-4.6L4 8.5M4 13a8 8 0 0 0 14.3 4.6L20 15.5M4 4v4.5h4.5M20 20v-4.5h-4.5',
    alert: 'M12 3.5l9.5 16.5h-19zM12 9.5v4.6M12 17v.2',
    stop: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8',
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 10.8v5.4M12 7.6v.2',
    check: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.2l2.8 2.8L16.2 9.4',
    power: 'M16.2 6.7a7.5 7.5 0 1 1-8.4 0M12 3v8.4',
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.4 2.4 3.4 5.4 3.4 9s-1 6.6-3.4 9c-2.4-2.4-3.4-5.4-3.4-9S9.6 5.4 12 3z',
    servers: 'M4 4.5h16v6H4zM4 13.5h16v6H4zM7.5 7.5h.01M7.5 16.5h.01',
    gauge: 'M4.2 17.5a9 9 0 1 1 15.6 0M12 13l4-5M10.5 13a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0',
    gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10.3 2.6h3.4l.5 2.6 1.9 1.1 2.5-.9 1.7 2.9-2 1.7v2.2l2 1.7-1.7 2.9-2.5-.9-1.9 1.1-.5 2.6h-3.4l-.5-2.6-1.9-1.1-2.5.9-1.7-2.9 2-1.7v-2.2l-2-1.7 1.7-2.9 2.5.9 1.9-1.1z',
    back: 'M19 12H5M11 5l-7 7 7 7',
    chevron: 'M9 5l7 7-7 7',
    search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.3 15.3L20 20',
    star: 'M12 3.4l2.6 5.5 6 .8-4.4 4.1 1.1 5.9-5.3-2.9-5.3 2.9 1.1-5.9L3.4 9.7l6-.8z',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5V12l3 2',
    arrows: 'M7 17V4M3.5 7.5L7 4l3.5 3.5M17 7v13M13.5 16.5L17 20l3.5-3.5',
    signal: 'M4 20v-3M9 20v-7M14 20v-11M19 20V4',
    lock: 'M6 10.5h12v10H6zM8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3',
    sort: 'M4 6h16M7 12h10M10 18h4',
    wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-3v3M16.5 13.5h.01',
    gift: 'M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7c-1.5-3-5-3.5-5-1.2C7 7 9.5 7 12 7zM12 7c1.5-3 5-3.5 5-1.2C17 7 14.5 7 12 7z',
    receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
    chat: 'M4 5h16v11H9l-5 4z',
    logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
    user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20a7.5 7.5 0 0 1 15 0',
    bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5h4',
    moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
    lang: 'M4 5h9M8.5 3v2M6 5c.5 3 3 6 6 7.5M11 5c-.8 3.5-3.3 6.4-7 8M13 21l4-10 4 10M14.5 17.5h5',
    refresh: 'M20 12a8 8 0 1 1-2.3-5.7L20 8.5M20 4v4.5h-4.5',
    tag: 'M3 12V4h8l10 10-8 8z M7.5 7.5h.01',
  };
  function ic(name, cls) {
    return `<svg aria-hidden="true" class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${P[name]}"/></svg>`;
  }

  // connection phase -> chip kind, icon and word. Color is never the only signal.
  const PHASE = {
    connected: { kind: 'ok', icon: 'shieldOk', word: 'conn.connected' },
    connecting: { kind: 'busy', icon: 'sync', word: 'conn.connecting' },
    disconnecting: { kind: 'busy', icon: 'sync', word: 'conn.disconnecting' },
    disconnected: { kind: 'idle', icon: 'shieldOff', word: 'conn.disconnected' },
    error: { kind: 'bad', icon: 'alert', word: 'conn.error' },
    blocked: { kind: 'bad', icon: 'stop', word: 'conn.blocked' },
  };
  function statusChip(phase) {
    const p = PHASE[phase] || PHASE.disconnected;
    return `<span class="status ${p.kind}">${ic(p.icon)}<span>${esc(t(p.word))}</span></span>`;
  }

  function notice(kind, title, sub, action) {
    const icon = kind === 'ok' ? 'check' : kind === 'info' ? 'info' : kind === 'bad' ? 'stop' : 'alert';
    return `<div class="notice ${kind}" role="${kind === 'bad' || kind === 'warn' ? 'alert' : 'status'}">${ic(icon)}<div class="nb"><b>${esc(title)}</b>${sub ? `<p>${esc(sub)}</p>` : ''}${action || ''}</div></div>`;
  }

  function appBar(title, opts) {
    opts = opts || {};
    const back = opts.back ? `<button type="button" class="iconbtn js-back" aria-label="${esc(t('common.back'))}">${ic('back', 'flip-rtl')}</button>` : '';
    return `<header class="appbar">${back}<h1 class="t-h1">${esc(title)}</h1>${opts.trailing || ''}</header>`;
  }

  const TABS = [['home', 'power', 'tab.home'], ['servers', 'servers', 'tab.servers'], ['usage', 'gauge', 'tab.usage'], ['settings', 'gear', 'tab.settings']];
  function tabs(active) {
    return `<nav class="tabs" aria-label="${esc(t('tab.nav'))}">${TABS.map(([id, icon, label]) =>
      `<button type="button" class="tab" data-tab="${id}" ${id === active ? 'aria-current="page"' : ''}><span class="tab-ic">${ic(icon)}</span><span>${esc(t(label))}</span></button>`).join('')}</nav>`;
  }
  // tabs replace each other instead of stacking, so Android back from any tab leaves to home, then the app
  function bindTabs(root) {
    root.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => {
        const to = b.dataset.tab;
        if (CG.current && CG.current.name === to) return;
        CG.tab(to);
      };
    });
    root.querySelectorAll('.js-back').forEach((b) => { b.onclick = () => CG.back('home'); });
  }

  function switchRow(id, title, sub, checked, extra) {
    return `<button type="button" class="row" role="switch" id="${id}" aria-checked="${checked ? 'true' : 'false'}"${extra || ''}>
      <span class="rb"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</span><span class="sw" aria-hidden="true"></span></button>`;
  }
  function linkRow(id, icon, title, sub, value) {
    return `<button type="button" class="row" id="${id}">${icon ? ic(icon, 'ri') : ''}<span class="rb"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</span>${value ? `<span class="rv">${value}</span>` : ''}${ic('chevron', 'ri flip-rtl')}</button>`;
  }

  // a themed bottom sheet for flow screens; returns close()
  function fsheet(html, onMount) {
    const stage = document.querySelector('.stage');
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="fsheet-scrim"></div><div class="fsheet" role="dialog" aria-modal="true"><div class="grab" aria-hidden="true"></div>${html}</div>`;
    const prev = document.activeElement;
    const close = () => { wrap.remove(); if (prev && prev.focus) try { prev.focus(); } catch (e) {} };
    wrap.querySelector('.fsheet-scrim').onclick = close;
    stage.appendChild(wrap);
    const sh = wrap.querySelector('.fsheet');
    const h = sh.querySelector('h3');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
    if (onMount) onMount(sh, close);
    return close;
  }

  // the user-facing message for an error from the bridge or the API: by code, never raw server/core text
  function errText(e) {
    const code = e && e.code;
    if (code && CG.i18n.t('err.' + code) !== 'err.' + code) return t('err.' + code);
    if (e && e.status === 0) return t('err.network');
    if (e && e.status >= 500) return t('err.server');
    // the API's own Persian messages (validation etc.) are written for people; show them only in Persian
    if (e && e.status >= 400 && e.message && CG.i18n.lang === 'fa') return e.message;
    return t('err.generic');
  }

  // one live-region per screen for announcements that are not on screen as text (TalkBack)
  function announce(text) {
    let el = document.getElementById('cg-live');
    if (!el) { el = document.createElement('div'); el.id = 'cg-live'; el.className = 'sr-only'; el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
    el.textContent = '';
    setTimeout(() => { el.textContent = text; }, 50);
  }

  CG.ui = { ic, statusChip, notice, appBar, tabs, bindTabs, switchRow, linkRow, fsheet, errText, announce, PHASE };
})();
