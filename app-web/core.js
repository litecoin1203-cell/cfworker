/* Cloud Gold app shell: native bridge, state, router and helpers. Classic script (no modules). */
(function () {
  'use strict';

  // ---------------- helpers ----------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toman = (n) => Number(n || 0).toLocaleString('fa-IR');
  const faNum = (n) => Number(n || 0).toLocaleString('fa-IR');
  // Persian/Arabic digits typed on a Persian keyboard -> ASCII
  const num = (s) => +String(s || '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '') || 0;
  function faDate(iso, opts) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('fa-IR-u-ca-persian', opts || { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return new Date(iso).toLocaleDateString(); }
  }
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

  function ccToFlag(cc) {
    if (!cc || cc.length !== 2) return '🌐';
    return String.fromCodePoint(...cc.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  }
  function parseRemark(remark) {
    const m = (remark || '').match(FLAG_RE);
    let cc = '';
    if (m) cc = Array.from(m[0]).map((ch) => String.fromCharCode(ch.codePointAt(0) - 0x1f1e6 + 65)).join('');
    const name = (remark || '').replace(FLAG_RE, '').replace(/^[\s\-|·]+|[\s\-|·]+$/g, '') || 'سرور';
    return { cc, name };
  }
  function flag(cc, size) {
    return `<span class="flag" style="width:${size}px;height:${size}px"><i style="font-size:${Math.round(size * 0.62)}px">${ccToFlag(cc)}</i></span>`;
  }
  function bytes(n) {
    n = Number(n || 0);
    const f = (v, d) => Number(v.toFixed(d)).toLocaleString('fa-IR');
    if (n >= 1024 ** 3) return f(n / 1024 ** 3, n >= 100 * 1024 ** 3 ? 0 : 1) + ' گیگ';
    if (n >= 1024 ** 2) return f(n / 1024 ** 2, 0) + ' مگ';
    return f(n / 1024, 0) + ' کیلوبایت';
  }

  // ---------------- bridge ----------------
  let seq = 0;
  const pending = {};
  const listeners = {};
  window.__cgResolve = function (id, ok, payload) {
    const p = pending[id];
    delete pending[id];
    if (!p) return;
    let v = null;
    try { v = payload ? JSON.parse(payload) : null; } catch (e) { v = payload; }
    ok ? p.res(v) : p.rej(v || { message: 'مشکلی پیش آمد.' });
  };
  window.__cgEvent = function (name, payload) {
    let v = null;
    try { v = payload ? JSON.parse(payload) : null; } catch (e) { v = payload; }
    (listeners[name] || []).slice().forEach((fn) => fn(v));
  };
  const on = (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); return () => { listeners[name] = listeners[name].filter((f) => f !== fn); }; };

  const host = window.CGHost || window.CGMockHost;
  function call(method, args) {
    return new Promise((res, rej) => {
      const id = ++seq;
      pending[id] = { res, rej };
      host.call(id, method, JSON.stringify(args || {}));
    });
  }

  class ApiError extends Error {
    constructor(status, detail) {
      super((detail && detail.message) || 'مشکلی پیش آمد.');
      this.status = status;
      this.code = (detail && detail.code) || 'error';
      this.detail = detail;
    }
  }
  const NET_MSG = 'اتصال به سرور برقرار نشد. اینترنت را بررسی کن و دوباره امتحان کن.';
  async function api(method, path, body) {
    let r;
    try {
      r = await call('api', { method, path, body: body == null ? null : body });
    } catch (e) {
      throw new ApiError(0, { code: 'network', message: NET_MSG });
    }
    if (r.status === 0) throw new ApiError(0, { code: 'network', message: NET_MSG });
    if (r.status >= 400) {
      const d = r.data && r.data.detail;
      const detail = typeof d === 'object' && d ? d : { code: 'error', message: typeof d === 'string' ? d : (r.status >= 500 ? 'سرور موقتاً در دسترس نیست. چند لحظه دیگر دوباره امتحان کن.' : 'مشکلی پیش آمد.') };
      if (r.status === 401 && ['token_invalid', 'token_expired', 'not_authenticated'].includes(detail.code)) {
        await call('logout', {});
        go('auth', { mode: 'login' });
      }
      throw new ApiError(r.status, detail);
    }
    return r.data;
  }

  // ---------------- state ----------------
  const S = {
    me: null, plans: null, config: null,
    servers: [], selected: null,
    vpn: { running: false, busy: null, since: 0 },
    ping: null, traffic: { up: 0, down: 0 },
  };

  async function loadMe() { S.me = await api('GET', '/me'); S.meAt = Date.now(); return S.me; }
  async function loadConfig() { if (!S.config) S.config = await api('GET', '/app-config'); return S.config; }

  // a short key that is the same for this server on every phone (protocol|host|port) — for per-ISP stats
  function serverKey(s) {
    let h = 0x811c9dc5;
    const str = `${s.type || ''}|${s.server || ''}|${s.port || ''}`.toLowerCase();
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return 'k' + h.toString(16).padStart(8, '0');
  }
  function decorate(list) {
    S.serverPings = S.serverPings || {};
    (list || []).forEach((s) => { if (s.delay) S.serverPings[s.guid] = s.delay; });
    return (list || []).map((s) => Object.assign({}, s, parseRemark(s.remarks), { k: serverKey(s) }));
  }
  async function syncVpn() {
    let r;
    try { r = await call('vpnSync', {}); } catch (e) { S.syncError = e; throw e; }
    S.syncError = null;
    S.servers = decorate(r.servers);
    S.selected = r.selected || (S.servers[0] && S.servers[0].guid) || null;
    return r;
  }
  async function refreshServers() {
    const r = await call('vpnServers', {});
    S.servers = decorate(r.servers);
    S.selected = r.selected || (S.servers[0] && S.servers[0].guid) || null;
  }
  const selectedServer = () => S.servers.find((s) => s.guid === S.selected) || S.servers[0] || null;
  const hasActivePlan = () => !!(S.me && S.me.subscription && S.me.subscription.active);

  // VPN events from the native core
  on('vpn', (v) => {
    const was = S.vpn.running;
    S.vpn.running = !!(v && v.running);
    if (S.vpn.running && !was) { S.vpn.since = Date.now(); try { localStorage.setItem('cg_since', String(S.vpn.since)); } catch (e) {} }
    if (!S.vpn.running) S.vpn.since = 0;
    // while switching servers the core stops before it starts again; keep showing "Connecting..."
    if (S.vpn.running || S.vpn.busy !== 'connecting') S.vpn.busy = null;
  });
  on('vpnError', (v) => { S.vpn.busy = null; toast((v && v.message) || 'اتصال برقرار نشد.', true); });
  on('ping', (v) => { S.ping = v && v.ms ? v.ms : null; });

  // ---------------- ui helpers ----------------
  let toastTimer = null;
  function toast(msg, bad) {
    const old = $('.toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.setAttribute('role', 'status');
    el.textContent = msg;
    ($('.stage') || document.body).appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), Math.min(8000, 3000 + String(msg).length * 45));
    el.onclick = () => el.remove();
  }
  function busyButton(btn, busy, dark) {
    if (!btn) return;
    if (busy) {
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner${dark ? ' light' : ''}"></span>`;
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }
  }
  function sheet(html, onMount) {
    const scr = $('.stage');
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="sheet-scrim"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
    const close = () => { wrap.remove(); };
    wrap.querySelector('.sheet-scrim').onclick = close;
    scr.appendChild(wrap);
    if (onMount) onMount(wrap.querySelector('.sheet'), close);
    return close;
  }

  // ---------------- theme and text size ----------------
  // 'system' | 'dark' | 'light'; applies to the Phase-2 screens (the sign-in and payment flows stay dark)
  const themeQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function themeSetting() { try { return localStorage.getItem('cg_theme') || 'system'; } catch (e) { return 'system'; } }
  function applyTheme() {
    const v = themeSetting();
    const light = v === 'light' || (v === 'system' && themeQuery && themeQuery.matches);
    document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
    const flow = current && screens[current.name] && screens[current.name].flow;
    // status/navigation bar icons follow the screen; ignored by older app builds
    if (host) call('systemBars', { light: !!(light && flow) }).catch(() => {});
  }
  function setTheme(v) { try { localStorage.setItem('cg_theme', v); } catch (e) {} applyTheme(); }
  if (themeQuery && themeQuery.addEventListener) themeQuery.addEventListener('change', applyTheme);
  // Android's font size setting (the WebView itself is pinned to 100% so the older px-drawn screens keep their layout)
  function applyFontScale(fs) {
    const v = Math.max(0.85, Math.min(2, Number(fs) || 1));
    document.documentElement.style.setProperty('--fs', String(v));
  }

  // ---------------- router ----------------
  const screens = {};
  let current = null;
  let cleanup = null;
  const stack = [];

  // Every screen is laid out in 390-wide design units inside .stage, then scaled to the phone width.
  // fit:'both' screens (no text inputs) also shrink to fit short phones; the stage height grows with tall ones.
  function layout() {
    if (!current) return;
    const def = screens[current.name];
    const W = window.innerWidth || 390, H = window.innerHeight || 844;
    // width always fills the phone; screens that are positioned absolutely adapt to the leftover height themselves
    const k = Math.max(0.6, Math.min(W / 390, 1.6));
    S.k = k; S.sh = H / k;
    const scr = $('.screen');
    if (scr) { scr.style.setProperty('--k', k); scr.style.setProperty('--sh', S.sh + 'px'); scr.style.setProperty('--c', Math.max(0, 844 - S.sh) + 'px'); }
    if (def.resize) def.resize(S.sh, k);
  }
  window.addEventListener('resize', layout);

  function render(name, params, push) {
    if (cleanup) { try { cleanup(); } catch (e) {} cleanup = null; }
    const def = screens[name];
    if (!def) throw new Error('Unknown screen ' + name);
    const app = $('#app');
    current = { name, params: params || {} };
    // flow screens (Phase 2) are laid out in normal document flow, follow the app's language direction and theme
    app.innerHTML = def.flow
      ? `<div class="screen flow" data-screen="${name}" dir="${CGI18n.dir}" lang="${CGI18n.lang}"><div class="stage">${def.html(current.params)}</div></div>`
      : `<div class="screen" data-screen="${name}" style="background:${def.bg || 'var(--bg)'}"><div class="stage">${def.html(current.params)}</div></div>`;
    layout();
    const root = $('.stage', app);
    if (push !== false && name !== stack[stack.length - 1]) stack.push(name);
    if (stack.length > 12) stack.splice(0, stack.length - 12);
    const c = def.mount ? def.mount(root, current.params) : null;
    if (typeof c === 'function') cleanup = c;
    applyTheme();
  }
  function go(name, params) { render(name, params, true); }
  // replace the whole history, e.g. after login or after a purchase lands on home
  function reset(name, params) { stack.length = 0; render(name, params, true); }
  // bottom tabs: home is always the root, the other tabs replace each other on top of it
  function tab(name, params) { stack.length = 0; if (name !== 'home') stack.push('home'); render(name, params, true); }
  function back(fallback) {
    stack.pop();
    const prev = stack.pop();
    go(prev || fallback || 'home');
  }
  // Android back button
  window.__cgBack = function () {
    const scrim = $('.sheet-scrim');
    if (scrim) { scrim.click(); return true; }
    const drawer = $('.drawer-scrim');
    if (drawer && drawer.style.pointerEvents === 'auto') { drawer.click(); return true; }
    if (!current || ['home', 'onboarding', 'splash'].includes(current.name) || stack.length <= 1) return false;
    back();
    return true;
  };

  // ---------------- icons ----------------
  const I = {
    close: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#F2EADB" stroke-width="2" stroke-linecap="round"><path d="M1.5 1.5l13 13M14.5 1.5l-13 13"/></svg>',
    back: '<svg aria-hidden="true" width="20" height="16" viewBox="0 0 20 16" fill="none" stroke="#F2EADB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8h17.5M12 1.5L18.5 8 12 14.5"/></svg>',
    chevL: '<svg aria-hidden="true" width="11" height="18" viewBox="0 0 11 18" fill="none" stroke="#F2EADB" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 1.5L9.2 9 2 16.5"/></svg>',
    check: '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="#F2EADB" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.4l3 3 6-6.6"/></svg>',
    gem: '<svg aria-hidden="true" width="18" height="16" viewBox="0 0 18 16"><defs><linearGradient id="cgGem" x1="0" y1="0" x2="18" y2="16" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#F6E3AA"/><stop offset=".5" stop-color="#D6AE5C"/><stop offset="1" stop-color="#8E6A2C"/></linearGradient></defs><path d="M4.2.8h9.6l3.4 4.6L9 15.2.8 5.4z" fill="url(#cgGem)"/><path d="M.8 5.4h16.4M4.2.8l2.2 4.6L9 15.2l2.6-9.8L13.8.8M6.4 5.4L9 .8l2.6 4.6" fill="none" stroke="#3A2A0E" stroke-opacity=".45" stroke-width=".7" stroke-linejoin="round"/></svg>',
    globe: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#F2EADB" stroke-width="1.3"><circle cx="8" cy="8" r="6.6"/><path d="M1.4 8h13.2M8 1.4c2 2 2.8 4.2 2.8 6.6S10 12.6 8 14.6C6 12.6 5.2 10.4 5.2 8S6 3.4 8 1.4z"/></svg>',
    wallet: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F2EADB" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-3v3"/><circle cx="16.5" cy="13.5" r="1.3" fill="#F2EADB"/></svg>',
    card: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F2EADB" stroke-width="1.8"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/></svg>',
    crypto: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F2EADB" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 7.5h4a2.2 2.2 0 0 1 0 4.4h-4zM9.5 11.9h4.6a2.3 2.3 0 0 1 0 4.6H9.5zM9.5 7.5v9M11 6v1.5M13 6v1.5M11 16.5V18M13 16.5V18"/></svg>',
    copy: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F2EADB" stroke-width="1.8" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  };

  // ---------------- the Quiet Halo ----------------
  // Cloud Gold's mark: a black lacquer disc inside one hairline gold ring. The CSS lives in app.css (.pb);
  // halo() returns the button's inner markup, with gradient ids unique per instance.
  let haloUid = 0;
  const POWER = '<path d="M110.86 84.68A20 20 0 1 1 85.14 84.68"/><path d="M98 74v23"/>';
  const CHECK = '<path d="M78 98.5L92 112.5L118 84.5" stroke-linejoin="round"/>';
  function halo(opts) {
    opts = opts || {};
    const n = ++haloUid;
    const metal = 'pbh-metal-' + n, gilt = 'pbh-gilt-' + n;
    const glyph = opts.icon === 'check' ? CHECK : POWER;
    const icon = opts.icon === false ? '' : `
  <svg class="pb-icon" viewBox="0 0 196 196" aria-hidden="true">
    <g class="pb-ico pb-ico-ash">${glyph}</g>
    <g class="pb-ico pb-ico-gold" stroke="url(#${gilt})">${glyph}</g>
  </svg>`;
    return `<span class="pb-bloom"></span>
  <span class="pb-glow"></span>
  <span class="pb-pulse"></span>
  <svg class="pb-ring" viewBox="0 0 196 196" aria-hidden="true">
    <defs>
      <linearGradient id="${metal}" gradientUnits="userSpaceOnUse" x1="60" y1="4" x2="136" y2="192">
        <stop offset="0" stop-color="#F6E3AA"/><stop offset=".38" stop-color="#E2BE6A"/>
        <stop offset=".7" stop-color="#C99A45"/><stop offset="1" stop-color="#8E6A2C"/>
      </linearGradient>
      <linearGradient id="${gilt}" gradientUnits="userSpaceOnUse" x1="0" y1="72" x2="0" y2="122">
        <stop offset="0" stop-color="#FFF4D6"/><stop offset=".45" stop-color="#F5DDA2"/>
        <stop offset="1" stop-color="#E0BB6C"/>
      </linearGradient>
    </defs>
    <circle class="pb-track" cx="98" cy="98" r="94" stroke="url(#${metal})"/>
    <path class="pb-halo" pathLength="100" d="M98 4a94 94 0 1 1 0 188a94 94 0 1 1 0-188" stroke="url(#${metal})"/>
  </svg>
  <span class="pb-comet"><span class="pb-arc"></span><span class="pb-head"></span></span>
  <span class="pb-disc"><span class="pb-face"></span><span class="pb-warm"></span><span class="pb-lamp"></span><span class="pb-gloss"></span></span>${icon}`;
  }

  // the small brand mark: a black disc in a thin gold ring with a gilt power glyph (22-34px)
  let markUid = 0;
  const mark = (px) => {
    const id = ++markUid, m = 'cgm' + id, g = 'cgg' + id, d = 'cgd' + id;
    return `<span class="mark" style="width:${px}px;height:${px}px;position:relative;display:inline-block"><svg aria-hidden="true" viewBox="0 0 40 40" style="width:100%;height:100%;display:block;overflow:visible"><defs>
      <linearGradient id="${m}" gradientUnits="userSpaceOnUse" x1="9" y1="1" x2="31" y2="39"><stop offset="0" stop-color="#F6E3AA"/><stop offset=".38" stop-color="#E2BE6A"/><stop offset=".7" stop-color="#C99A45"/><stop offset="1" stop-color="#8E6A2C"/></linearGradient>
      <linearGradient id="${g}" gradientUnits="userSpaceOnUse" x1="0" y1="12" x2="0" y2="28"><stop offset="0" stop-color="#FFF4D6"/><stop offset=".45" stop-color="#F5DDA2"/><stop offset="1" stop-color="#E0BB6C"/></linearGradient>
      <radialGradient id="${d}" cx=".5" cy=".62" r=".75"><stop offset="0" stop-color="#1D1914"/><stop offset=".6" stop-color="#0C0B09"/><stop offset="1" stop-color="#050505"/></radialGradient>
    </defs>
      <circle cx="20" cy="20" r="18.4" fill="none" stroke="url(#${m})" stroke-width="1.7"/>
      <circle cx="20" cy="20" r="15" fill="url(#${d})" stroke="rgba(255,238,206,.16)" stroke-width=".7"/>
      <g fill="none" stroke="url(#${g})" stroke-width="1.8" stroke-linecap="round"><path d="M24 16.2A6.2 6.2 0 1 1 16 16.2"/><path d="M20 12.9V20"/></g>
    </svg></span>`;
  };

  window.CG = { t: CGI18n.t, i18n: CGI18n, themeSetting, setTheme, applyTheme, applyFontScale, esc, toman, faNum, num, faDate, $, $$, sleep, flag, ccToFlag, parseRemark, bytes, call, api, ApiError, on, S, loadMe, loadConfig,
    syncVpn, refreshServers, selectedServer, hasActivePlan, toast, busyButton, sheet, screens, go, reset, back, tab, layout, I, halo, mark,
    get current() { return current; } };
})();
