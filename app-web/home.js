/* Home (network globe + power button) and Servers (slide to connect) screens. */
(function () {
  'use strict';
  const { esc, flag, call, api, on, S, go, toast, screens, I, selectedServer, hasActivePlan, syncVpn, faNum, bytes } = window.CG;

  const D = Math.PI / 180;
  let globe = null;
  const getGlobe = () => (globe = globe || window.makeNetGlobe(window.CG_LAND05));
  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(['fa'], { type: 'region' }); } catch (e) {}
  function countryName(srv) {
    if (!srv) return '';
    if (srv.cc) { try { const n = regionNames && regionNames.of(srv.cc); if (n && n !== srv.cc) return n; } catch (e) {} }
    return srv.name;
  }
  const pad = (n) => (n < 10 ? '0' : '') + n;
  function clock(sec) { return pad(Math.floor(sec / 3600)) + ':' + pad(Math.floor(sec % 3600 / 60)) + ':' + pad(sec % 60); }
  function mode() {
    if (S.vpn.busy) return S.vpn.busy;
    return S.vpn.running ? 'connected' : 'disconnected';
  }
  function bars(ms, size) {
    const g = '#40FF00', dim = 'rgba(64,255,0,.3)', lvl = !ms ? 0 : ms < 150 ? 4 : ms < 300 ? 3 : ms < 600 ? 2 : 1;
    const c = (i) => (i <= lvl ? g : dim);
    return size === 'big'
      ? `<svg aria-hidden="true" width="14" height="9" viewBox="0 0 14 9"><rect x="0" y="6" width="2.2" height="3" fill="${c(1)}"/><rect x="3.8" y="4" width="2.2" height="5" fill="${c(2)}"/><rect x="7.6" y="2" width="2.2" height="7" fill="${c(3)}"/><rect x="11.4" y="0" width="2.2" height="9" fill="${c(4)}"/></svg>`
      : `<svg aria-hidden="true" width="12" height="9" viewBox="0 0 12 9"><rect x="0" y="6" width="2" height="3" fill="${c(1)}"/><rect x="3.3" y="4" width="2" height="5" fill="${c(2)}"/><rect x="6.6" y="2" width="2" height="7" fill="${c(3)}"/><rect x="9.9" y="0" width="2" height="9" fill="${c(4)}"/></svg>`;
  }

  // ---- live numbers shared by Home and Servers ----
  const live = { ip: '', publicIp: '', up: 0, down: 0, last: null, timer: null, pingTimer: null, users: 0 };
  function startLive() {
    if (live.users++ > 0) return;
    const tick = async () => {
      try {
        const t = await call('traffic', {});
        const now = Date.now();
        if (live.last && S.vpn.running) {
          const dt = Math.max(0.5, (now - live.last.at) / 1000);
          live.up = Math.max(0, (t.tx - live.last.tx) / dt);
          live.down = Math.max(0, (t.rx - live.last.rx) / dt);
        } else { live.up = live.down = 0; }
        live.last = { at: now, rx: t.rx, tx: t.tx };
      } catch (e) {}
    };
    live.timer = setInterval(tick, 1000);
    tick();
    const ping = () => { if (S.vpn.running) call('vpnPing', {}).catch(() => {}); };
    live.pingTimer = setInterval(ping, 10000);
    ping();
    if (!live.publicIp) api('GET', '/ip').then((r) => { if (!S.vpn.running) live.publicIp = r.ip; }).catch(() => {});
  }
  function stopLive() {
    if (--live.users > 0) return;
    clearInterval(live.timer); clearInterval(live.pingTimer);
  }
  on('ping', (v) => { if (v && v.ip) live.ip = v.ip; });
  on('vpn', (v) => {
    if (v && v.running) { setTimeout(() => call('vpnPing', {}).catch(() => {}), 1200); }
    else { live.ip = ''; S.ping = null; api('GET', '/ip').then((r) => { live.publicIp = r.ip; }).catch(() => {}); }
  });

  // ---- smart connect: test every server, use the fastest, and move on by itself if one stops answering ----
  const recall = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  S.auto = recall('cg_auto', '1') === '1';
  function setAuto(v) { S.auto = !!v; keep('cg_auto', v ? '1' : '0'); }
  window.CG.setAuto = setAuto;

  let testing = null;
  function testAll(maxWait) {
    if (testing) return testing;
    const pings = S.serverPings = S.serverPings || {};
    testing = new Promise((res) => {
      const got = new Set();
      let over = false, off = null, t = 0;
      const done = () => { if (over) return; over = true; clearTimeout(t); if (off) off(); S.pingAt = Date.now(); testing = null; res(); };
      off = on('serverPing', (v) => { if (v && v.guid) { pings[v.guid] = v.ms; got.add(v.guid); if (got.size >= S.servers.length) done(); } });
      t = setTimeout(done, maxWait || 7000);
      call('vpnTestAll', {}).catch(done);
    });
    return testing;
  }
  window.CG.testAll = testAll;
  const ranked = (exclude) => {
    const p = S.serverPings || {};
    return S.servers.filter((s) => p[s.guid] > 0 && !(exclude || []).includes(s.guid)).sort((a, b) => p[a.guid] - p[b.guid]);
  };
  async function bestServer(exclude) {
    const fresh = S.pingAt && Date.now() - S.pingAt < 10 * 60 * 1000 && ranked(exclude).length;
    if (!fresh) await testAll(7000);
    return ranked(exclude)[0] || null;
  }

  let connectWatch = null;
  const fo = { tried: [], misses: 0 };
  async function connect(guid, opts) {
    opts = opts || {};
    if (!hasActivePlan()) { go('premium', { from: 'home' }); return; }
    try {
      if (!S.servers.length) await syncVpn();
      if (!S.servers.length) { toast('هنوز سروری برای اشتراک شما تعریف نشده. چند دقیقه دیگر دوباره امتحان کن.', true); return; }
      if (!opts.failover) { fo.tried = []; fo.misses = 0; }
      S.vpn.busy = 'connecting';
      if (guid) S.selected = guid;
      else if (S.auto && S.servers.length > 1) {
        S.vpn.label = 'در حال پیدا کردن سریع‌ترین سرور...';
        const best = await bestServer(fo.tried);
        S.vpn.label = null;
        if (S.vpn.busy !== 'connecting') return; // cancelled meanwhile
        if (best) S.selected = best.guid;
      }
      fo.tried.push(S.selected);
      clearTimeout(connectWatch);
      connectWatch = setTimeout(() => { if (S.vpn.busy === 'connecting') { S.vpn.busy = null; failover('timeout') || toast('اتصال خیلی طول کشید. لوکیشن دیگری را امتحان کن.', true); } }, 30000);
      const r = await call(S.vpn.running ? 'vpnSelect' : 'vpnConnect', { guid: S.selected });
      if (r && r.denied) { S.vpn.busy = null; toast('برای اتصال، درخواست VPN را تأیید کن.', true); }
    } catch (e) {
      S.vpn.busy = null; S.vpn.label = null;
      toast(e.message || 'اتصال برقرار نشد.', true);
    }
  }
  // in smart mode, a server that fails or stops answering is replaced by the next fastest one (at most twice)
  function failover(why) {
    if (!S.auto || fo.tried.length >= 3) return false;
    const next = ranked(fo.tried)[0] || S.servers.find((s) => !fo.tried.includes(s.guid));
    if (!next) return false;
    toast(why === 'dead' ? 'این سرور جواب نمی‌دهد؛ رفتیم سراغ سرور بعدی...' : 'اتصال برقرار نشد؛ سرور بعدی را امتحان می‌کنیم...');
    connect(next.guid, { failover: true });
    return true;
  }
  on('vpnError', () => { if (fo.tried.length) failover('error'); });
  on('ping', (v) => {
    if (!S.vpn.running) return;
    if (v && v.ms) { fo.misses = 0; return; }
    if (++fo.misses >= 2 && failover('dead')) fo.misses = 0;
    else if (fo.misses === 2 && !S.auto) toast('این سرور الان جواب نمی‌دهد. لوکیشن دیگری را امتحان کن.', true);
  });
  on('vpn', (v) => { if (v && v.running) { clearTimeout(connectWatch); setTimeout(() => window.CG.loadMe().catch(() => {}), 2500); } });

  async function disconnect() {
    S.vpn.busy = 'disconnecting'; S.vpn.label = null;
    try { await call('vpnDisconnect', {}); } catch (e) { S.vpn.busy = null; }
    setTimeout(() => { if (S.vpn.busy === 'disconnecting') S.vpn.busy = null; }, 5000);
  }
  window.CG.connect = connect;
  window.CG.disconnect = disconnect;

  // ---- drawer ----
  const MENU_ICONS = {
    servers: 'M4 5h16v5H4zM4 14h16v5H4zM7.5 7.5h.01M7.5 16.5h.01',
    premium: 'M6 3h12l4 6-10 12L2 9zM2 9h20',
    wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-3v3M16.5 13.5h.01',
    invite: 'M16 11a4 4 0 1 0-8 0M3 21a9 9 0 0 1 18 0M19 4v6M16 7h6',
    plan: 'M4 6h16v12H4zM4 10h16',
    support: 'M21 12a9 9 0 1 1-4-7.5M21 4v5h-5M9 10h6M9 14h4',
    settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  };
  function drawerHtml() {
    const sub = S.me && S.me.subscription;
    const line = sub && sub.active ? `${esc(sub.plan_name || 'اشتراک')} · ${sub.unlimited_time ? 'بدون محدودیت زمان' : faNum(sub.days_left) + ' روز مانده'}` : 'اشتراک فعال ندارید';
    const items = [
      ['servers', 'سرورها', 'servers'], ['premium', 'خرید و تمدید اشتراک', 'premium'], ['wallet', 'کیف پول', 'wallet'],
      ['invite', 'دعوت دوستان', 'invite'], ['plan', 'اشتراک من', 'account'],
    ];
    if (S.config && S.config.support_url) items.push(['support', 'پشتیبانی', 'support']);
    items.push(['settings', 'تنظیمات اتصال', 'conn']);
    return `<div class="drawer-scrim" style="opacity:0;pointer-events:none"></div>
      <nav class="drawer" aria-label="منو" style="transform:translateX(300px);padding-top:70px">
        <div style="font-family:Michroma;font-size:15px;letter-spacing:3.5px">CLOUD GOLD</div>
        <div style="margin-top:6px;font-family:Outfit;font-size:13px;color:#8EA3BC">${line}</div>
        <div class="ltr" style="margin-top:2px;font-family:Outfit;font-size:12px;color:#5f7590;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right">${esc(S.me ? S.me.email : '')}</div>
        <div style="margin-top:24px;display:flex;flex-direction:column;gap:4px">
          ${items.map(([ic, label, to], i) => `<button type="button" class="item" data-to="${to}" style="${i === 0 ? 'background:rgba(127,196,255,.1)' : ''}">
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9CC4EE" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${MENU_ICONS[ic]}"/></svg>${label}</button>`).join('')}
        </div>
        <button type="button" class="item" data-to="logout" style="position:absolute;left:20px;right:20px;bottom:30px;width:auto;color:#ff8a8e">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ff8a8e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/></svg>خروج از حساب</button>
      </nav>`;
  }
  function bindDrawer(root) {
    const scrim = root.querySelector('.drawer-scrim'), nav = root.querySelector('.drawer');
    const open = (yes) => {
      scrim.style.opacity = yes ? 1 : 0; scrim.style.pointerEvents = yes ? 'auto' : 'none';
      nav.style.transform = yes ? 'none' : 'translateX(300px)';
    };
    scrim.onclick = () => open(false);
    nav.querySelectorAll('[data-to]').forEach((b) => {
      b.onclick = async () => {
        open(false);
        const to = b.dataset.to;
        if (to === 'advanced') return call('advanced', {});
        if (to === 'conn') return window.CG.connSettings();
        if (to === 'support') return call('openUrl', { url: S.config.support_url });
        if (to === 'logout') {
          window.CG.sheet(`<h3>از حساب خارج می‌شوی؟</h3><p>VPN روی این گوشی قطع می‌شود. هر وقت خواستی دوباره وارد شو.</p>
            <button class="pill-btn white" data-yes>خروج</button><div style="height:10px"></div><button class="pill-btn dark" data-no>انصراف</button>`, (el, close) => {
            el.querySelector('[data-no]').onclick = close;
            el.querySelector('[data-yes]').onclick = async () => {
              close();
              try { await call('logout', {}); } catch (e) {}
              S.me = null; S.servers = []; S.selected = null;
              window.CG.reset('auth', { mode: 'login' });
            };
          });
          return;
        }
        go(to, { from: 'home' });
      };
    });
    return open;
  }

  // days/data left as one short line + a 0..100 bar + a warning level (0 ok, 1 soon, 2 over)
  function usageInfo(sub) {
    const days = sub.days_left, dataLeft = sub.remaining_bytes;
    const parts = [];
    if (sub.status === 'limited') parts.push('حجم تمام شده');
    else if (sub.status === 'expired' || (days === 0 && !sub.unlimited_time)) parts.push('زمان تمام شده');
    else {
      parts.push(sub.unlimited_time ? 'زمان نامحدود' : faNum(days) + ' روز');
      parts.push(sub.unlimited_data ? 'حجم نامحدود' : bytes(dataLeft) + ' مانده');
    }
    const timePct = sub.unlimited_time ? 100 : sub.period_days ? Math.min(100, Math.round((100 * (sub.seconds_left || 0)) / (sub.period_days * 86400))) : 100;
    const dataPct = sub.unlimited_data ? 100 : sub.data_limit_bytes ? Math.round((100 * (dataLeft || 0)) / sub.data_limit_bytes) : 100;
    const pct = Math.max(0, Math.min(timePct, dataPct));
    const over = !sub.active;
    const soon = !over && ((!sub.unlimited_time && days <= 3) || (!sub.unlimited_data && dataPct <= 10));
    return { line: parts.join(' · '), pct: over ? 100 : Math.max(3, pct), level: over ? 2 : soon ? 1 : 0 };
  }
  window.CG.usageInfo = usageInfo;

  // once a day, when the plan is about to run out (or has), offer a one-tap renewal
  function maybeRemind() {
    const sub = S.me && S.me.subscription;
    if (!sub || document.querySelector('.sheet')) return;
    const u = usageInfo(sub);
    if (u.level === 0) return;
    const today = new Date().toDateString();
    if (recall('cg_remind', '') === today) return;
    keep('cg_remind', today);
    const title = u.level === 2 ? (sub.status === 'limited' ? 'حجم اشتراکت تمام شد' : 'اشتراکت تمام شد') : 'اشتراکت رو به اتمام است';
    const text = u.level === 2 ? 'برای ادامه‌ی استفاده از VPN اشتراک را تمدید کن. زمان و حجم باقی‌مانده‌ی قبلی از بین نمی‌رود.' : `فقط ${u.line} باقی مانده. برای اینکه وسط کار قطع نشوی همین حالا تمدید کن.`;
    window.CG.sheet(`<h3>${title}</h3><p>${text}</p><button class="pill-btn white" data-go>تمدید اشتراک</button><div style="height:10px"></div><button class="pill-btn dark" data-no>بعداً</button>`, (el, close) => {
      el.querySelector('[data-no]').onclick = close;
      el.querySelector('[data-go]').onclick = () => { close(); go('premium', { from: 'home' }); };
    });
  }

  // ---------------- HOME ----------------
  screens.home = {
    fit: 'both',
    bg: 'linear-gradient(180deg,#000 0%,#010812 12%,#010812 100%)',
    html: () => `
      <canvas aria-hidden="true" class="h-canvas" style="position:absolute;left:0;top:0;width:390px;height:var(--sh)"></canvas>
      <button type="button" aria-label="منو" class="h-menu" style="position:absolute;left:339px;top:63px;width:40px;height:40px">
        <svg aria-hidden="true" width="26" height="20" viewBox="0 0 26 20" style="position:absolute;left:7px;top:10px" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M2 2.5h22M2 10h22M2 17.5h15"/></svg>
      </button>
      <button type="button" class="h-glass usage h-usage" aria-label="اشتراک من" style="left:143px;width:190px;display:none"><span class="u1"></span><span class="u2"><i style="width:0"></i></span></button>
      <button type="button" class="h-prem" style="position:absolute;left:17px;top:63px;width:119px;height:41px;border-radius:21px;background:linear-gradient(90deg,#3465A1 0%,#4C55A8 55%,#5844AE 100%);border:1px solid rgba(255,255,255,.14);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 6px 18px rgba(60,70,180,.35);display:flex;align-items:center;justify-content:center;gap:7px;font-family:Outfit;font-size:15px;font-weight:600;letter-spacing:0">${I.gem}<span class="h-premt">خرید اشتراک</span></button>
      <div class="h-cluster" style="position:absolute;left:0;top:var(--hdy,0px);width:390px;height:0">
      <svg aria-hidden="true" width="390" height="480" viewBox="0 0 390 480" style="position:absolute;top:0;left:0;pointer-events:none">
        <circle cx="195" cy="315" r="112" fill="none" stroke="#fff" stroke-opacity=".07"/>
        <circle cx="195" cy="315" r="159" fill="none" stroke="#fff" stroke-opacity=".06"/>
      </svg>
      <div aria-hidden="true" class="h-rip" style="position:absolute;left:36px;top:156px;width:318px;height:318px;display:none;pointer-events:none">
        <span class="ripple"></span><span class="ripple" style="animation-delay:-.9s"></span>
      </div>
      <div aria-live="polite" class="h-time ltr" style="position:absolute;left:0;top:159px;width:390px;text-align:center;font-family:Outfit;font-size:44px;font-weight:600;line-height:52px;letter-spacing:-.3px;font-variant-numeric:tabular-nums;transition:color 400ms">00:00:00</div>
      <div class="h-sec" style="position:absolute;left:0;top:215px;width:390px;height:16px;display:flex;align-items:center;justify-content:center;gap:5px;font-family:Outfit;font-size:12px;transition:color 400ms"></div>
      <button class="h-disc" type="button" style="position:absolute;left:126px;top:246px;width:138px;height:138px;border-radius:50%">
        <span aria-hidden="true" class="h-arc spin" style="display:none;position:absolute;left:-5px;top:-5px;width:148px;height:148px;border-radius:50%;background:conic-gradient(from 0deg,rgba(127,196,255,0) 0deg,rgba(127,196,255,0) 230deg,rgba(160,215,255,.95) 350deg,rgba(127,196,255,0) 360deg);-webkit-mask:radial-gradient(closest-side,transparent calc(100% - 3px),#000 calc(100% - 2px));mask:radial-gradient(closest-side,transparent calc(100% - 3px),#000 calc(100% - 2px));animation-duration:1.1s"></span>
        <svg aria-hidden="true" width="46" height="48" viewBox="0 0 46 48" style="position:absolute;left:46px;top:44px"><path class="h-ic" d="M23 4v19" fill="none" stroke="#fff" stroke-width="4.6" stroke-linecap="round"/><path class="h-ic" d="M13.5 10.6A17.2 17.2 0 1 0 32.5 10.6" fill="none" stroke="#fff" stroke-width="4.6" stroke-linecap="round"/></svg>
      </button>
      <div class="h-status" style="position:absolute;left:0;top:396px;width:390px;text-align:center;font-family:Outfit;font-size:21px;font-weight:700;line-height:24px;letter-spacing:.1px;transition:color 400ms"></div>
      <div style="position:absolute;left:0;top:425px;width:390px;height:22px;display:flex;align-items:center;justify-content:center;gap:7px;font-family:Outfit;font-size:16.5px;letter-spacing:.1px">${I.gem}<span class="h-ip"></span></div>
      </div>
      <div class="h-marker" style="position:absolute;left:0;top:0;width:0;height:0;display:none">
        <span class="h-dot" aria-hidden="true" style="position:absolute;left:-7px;top:-7px;width:14px;height:14px;border-radius:50%"></span>
        <div dir="ltr" class="h-glass h-fade h-card" style="position:absolute;left:1px;top:0;width:183px;height:94px;border-radius:16px;padding:12px 0 0 12px;font-family:Outfit">
          <div style="display:flex;align-items:center;gap:6px;height:18px;font-size:13.5px"><span class="h-cflag"></span><span class="h-cname" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px"></span></div>
          <div style="margin-top:8px;display:flex;align-items:center;gap:6px;height:18px;font-size:14px">${I.globe.replace('width="14" height="14"', 'width="16" height="16"')}<span class="h-cip"></span></div>
          <div style="margin-top:8px;display:flex;align-items:center;gap:6px;height:16px;font-size:11px;font-variant-numeric:tabular-nums">
            <svg aria-hidden="true" width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round"><path d="M1.5 9.5l8-8M3.5 1.5h6v6"/></svg><span class="h-up"></span>
            <svg aria-hidden="true" width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" style="margin-left:6px"><path d="M9.5 1.5l-8 8M7.5 9.5h-6v-6"/></svg><span class="h-down"></span>
          </div>
        </div>
      </div>
      <button type="button" class="h-glass h-pill" style="position:absolute;left:19px;top:calc(var(--sh) - 93px);width:350px;height:64px;border-radius:32px;text-align:right;font-family:Outfit;transition:transform 140ms">
        <span class="h-pflag" style="position:absolute;right:6px;top:4px"></span>
        <span class="h-pname" style="position:absolute;right:69px;top:7px;left:40px;font-size:16px;font-weight:500;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span>
        <span class="h-pip" style="position:absolute;right:69px;left:40px;top:27px;font-size:11px;line-height:14px;color:#E8EEF6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span>
        <span class="h-pping" style="position:absolute;right:69px;top:43px;display:flex;align-items:center;gap:4px;font-size:11px;line-height:14px;font-variant-numeric:tabular-nums"></span>
        <svg aria-hidden="true" width="9" height="15" viewBox="0 0 9 15" style="position:absolute;left:20px;top:25px" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 1.5l-6 6 6 6"/></svg>
      </button>
      ${drawerHtml()}`,
    mount(root) {
      const $ = (c) => root.querySelector(c);
      const canvas = $('.h-canvas'), ctx = canvas.getContext('2d');
      const G = getGlobe();
      const openDrawer = bindDrawer(root);
      $('.h-menu').onclick = () => openDrawer(true);
      $('.h-prem').onclick = () => go('premium', { from: 'home' });
      $('.h-usage').onclick = () => go('account');
      $('.h-pill').onclick = () => {
        if (!hasActivePlan()) return go('premium', { from: 'home' });
        if (S.syncError && S.syncError.code === 'device_limit') return go('account');
        if (S.syncError || !S.servers.length) { syncVpn().then(() => { S.syncError = null; }).catch((e) => { S.syncError = e; toast(e.message, true); }); return; }
        go('servers');
      };
      $('.h-disc').onclick = () => {
        const m = mode();
        if (m === 'connecting') return disconnect();
        if (m === 'disconnecting') return;
        if (m === 'connected') return disconnect();
        connect();
      };
      startLive();

      let reduce = false;
      try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
      let pw = S.vpn.running ? 1 : 0.12, view = null, raf = 0, lastKey = '', lastSec = -1;
      const marker = $('.h-marker');

      function targetView(srv) {
        const g = srv && srv.cc && window.CG_GEO[srv.cc];
        if (!g) return { lat: -11, lon: 15.5, has: false };
        const lat = g[0], lon = g[1];
        const vlat = Math.max(-85, Math.min(60, lat - 63.4));
        const dl = Math.asin(Math.max(-1, Math.min(1, -0.12 / Math.max(0.2, Math.cos(lat * D))))) / D;
        return { lat: vlat, lon: lon - dl, has: true, glat: lat, glon: lon };
      }
      function size() {
        const s = Math.min(2, S.k * (window.devicePixelRatio || 1));
        canvas.width = Math.round(390 * s); canvas.height = Math.round(S.sh * s);
        return s;
      }
      let scale = size(), gOff = 0;
      // short phones: lift the power cluster and sink the globe; tall phones: centre the cluster in the extra room
      function fitHeight() {
        const c = 844 - S.sh;
        const dy = c <= 0 ? -c * 0.3 : -Math.min(56, c * 0.36);
        gOff = c > 0 ? c * 0.6 : 0;
        root.style.setProperty('--hdy', dy + 'px');
      }
      fitHeight();
      screens.home.resize = () => { scale = size(); fitHeight(); };

      function paint() {
        const m = mode(), srv = selectedServer(), act = hasActivePlan();
        const onn = m === 'connected', busy = m === 'connecting' || m === 'disconnecting';
        const sec = onn && S.vpn.since ? Math.floor((Date.now() - S.vpn.since) / 1000) : 0;
        if (sec !== lastSec) { $('.h-time').textContent = clock(sec); lastSec = sec; }
        const sub = S.me && S.me.subscription;
        const key = [m, act, srv && srv.guid, S.syncError && S.syncError.code, live.ip, live.publicIp, S.ping, Math.round(live.up / 100), Math.round(live.down / 100), S.vpn.label, S.meAt, S.auto].join('|');
        if (key === lastKey) return;
        lastKey = key;
        $('.h-time').style.color = onn || m === 'disconnecting' ? '#fff' : 'rgba(255,255,255,.38)';
        const secColor = onn ? '#43FF00' : m === 'connecting' ? '#7FC4FF' : '#FF5A5F';
        const secText = onn ? 'اتصال شما امن است' : m === 'connecting' ? (S.vpn.label || 'در حال امن کردن اتصال...') : 'اتصال شما محافظت نمی‌شود';
        $('.h-sec').style.color = secColor;
        $('.h-sec').innerHTML = `<svg aria-hidden="true" width="11" height="12" viewBox="0 0 11 12"><path d="M5.5.4l4.8 1.8v3.6c0 3-2.1 5.1-4.8 5.9C2.8 10.9.7 8.8.7 5.8V2.2z" fill="${secColor}"/>${onn ? '<path d="M3.2 5.9l1.6 1.6 3-3.2" fill="none" stroke="#031006" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' : m === 'connecting' ? '' : '<path d="M5.5 3.4v3M5.5 8.3v.2" fill="none" stroke="#1a0606" stroke-width="1.4" stroke-linecap="round"/>'}</svg>${secText}`;
        const statusMap = { connected: ['متصل', '#52FF00'], connecting: ['در حال اتصال...', '#7FC4FF'], disconnecting: ['در حال قطع...', '#9FB0C4'], disconnected: act ? ['قطع', '#FF5A5F'] : [sub ? (sub.status === 'limited' ? 'حجم تمام شده' : 'اشتراک تمام شده') : 'اشتراک فعال ندارید', '#FCFF58'] };
        $('.h-status').textContent = statusMap[m][0];
        $('.h-status').style.color = statusMap[m][1];
        const ipEl = $('.h-ip');
        ipEl.textContent = onn ? (live.ip || 'در حال بررسی IP...') : !act ? (sub ? 'برای اتصال، اشتراک را تمدید کن' : 'برای اتصال، اشتراک بگیر') : live.publicIp ? 'IP شما ' + live.publicIp : 'برای اتصال دکمه را بزن';
        ipEl.style.color = onn ? '#fff' : 'rgba(255,255,255,.6)';
        const disc = $('.h-disc');
        disc.style.background = onn ? 'radial-gradient(circle at 50% 30%,#3E434C 0%,#343840 55%,#2D3138 100%)' : 'radial-gradient(circle at 50% 30%,#2F333A 0%,#262A31 60%,#20232A 100%)';
        disc.style.boxShadow = onn ? '0 0 0 1px rgba(255,255,255,.05),0 0 46px rgba(67,255,0,.16),0 14px 30px rgba(0,0,0,.45)' : '0 0 0 1px rgba(255,255,255,.05),0 14px 30px rgba(0,0,0,.45)';
        disc.setAttribute('aria-label', onn ? 'قطع اتصال' : m === 'connecting' ? 'لغو اتصال' : 'اتصال');
        root.querySelectorAll('.h-ic').forEach((p) => p.setAttribute('stroke', onn ? '#fff' : m === 'connecting' ? '#BFE2FF' : 'rgba(255,255,255,.7)'));
        $('.h-arc').style.display = m === 'connecting' ? 'block' : 'none';
        $('.h-rip').style.display = m === 'connecting' ? 'block' : 'none';
        // live usage from the panel: days and data left
        const chip = $('.h-usage');
        $('.h-premt').textContent = sub ? 'تمدید اشتراک' : 'خرید اشتراک';
        if (sub) {
          const u = usageInfo(sub);
          chip.style.display = 'flex';
          chip.classList.toggle('warn', u.level === 1); chip.classList.toggle('bad', u.level === 2);
          chip.querySelector('.u1').textContent = u.line;
          chip.querySelector('.u2 i').style.width = u.pct + '%';
        } else chip.style.display = 'none';
        // marker card
        const dot = $('.h-dot');
        dot.style.background = onn ? '#3DDC5A' : '#7D8896';
        dot.style.boxShadow = '0 0 0 5px ' + (onn ? 'rgba(61,220,90,.28)' : 'rgba(125,136,150,.25)');
        dot.classList.toggle('pulse', onn);
        dot.style.animation = onn ? 'cgPulse 2s ease-out infinite' : 'none';
        const card = $('.h-card');
        card.style.opacity = onn ? 1 : 0; card.style.transform = onn ? 'none' : 'translateY(8px)';
        $('.h-cflag').innerHTML = flag(srv && srv.cc, 16);
        $('.h-cname').textContent = countryName(srv);
        $('.h-cip').textContent = live.ip || '...';
        const kb = (v) => (v / 1024).toFixed(1) + ' kB/s';
        $('.h-up').textContent = kb(live.up); $('.h-down').textContent = kb(live.down);
        // server pill
        if (srv && act) {
          $('.h-pflag').innerHTML = flag(srv.cc, 54);
          $('.h-pname').textContent = countryName(srv);
          const alias = srv.name && srv.name !== countryName(srv) && srv.name.indexOf(countryName(srv)) === 0 ? srv.name : '';
          $('.h-pip').textContent = onn && live.ip ? 'IP ' + live.ip : S.auto && !onn ? 'اتصال هوشمند: سریع‌ترین سرور' : alias || 'آماده';
          $('.h-pping').innerHTML = onn && S.ping ? `<span class="ltr" style="display:flex;align-items:center;gap:4px">${bars(S.ping)} ${S.ping} ms</span>` : busy ? 'لطفاً صبر کن...' : 'برای تغییر لوکیشن بزن';
        } else {
          $('.h-pflag').innerHTML = `<span class="flag" style="width:54px;height:54px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#3465A1,#5844AE)">${I.gem}</span>`;
          const se = act && S.syncError;
          $('.h-pname').textContent = se ? (se.code === 'device_limit' ? 'سقف تعداد گوشی پر شده' : 'سرورها در دسترس نیستند') : act ? 'یک لوکیشن انتخاب کن' : 'خرید اشتراک Cloud Gold';
          $('.h-pip').textContent = se ? (se.code === 'device_limit' ? 'یک گوشی قدیمی را از «اشتراک من» حذف کن' : 'برای تلاش دوباره بزن') : act ? 'در حال دریافت سرورها...' : 'سرورهای پرسرعت در کشورهای مختلف';
          $('.h-pping').textContent = act ? '' : 'شروع از ' + (S.plans && S.plans.length ? faNum(Math.min(...S.plans.map((p) => p.monthly_toman))) + ' تومان در ماه' : 'چند لمس');
        }
      }

      const t0 = performance.now();
      function frame(now) {
        const t = (now - t0) / 1000, m = mode(), srv = selectedServer();
        const goal = m === 'connected' ? 1 : m === 'connecting' ? 0.55 : 0.12;
        pw += (goal - pw) * 0.06;
        const tv = targetView(srv);
        if (!view) view = { lat: tv.lat, lon: tv.lon };
        let dlon = ((tv.lon - view.lon + 540) % 360) - 180;
        view.lon += dlon * 0.05; view.lat += (tv.lat - view.lat) * 0.05;
        const drift = reduce ? 0 : Math.sin(t * 0.09) * 3.2 * (tv.has ? 0.35 : 1);
        const s = scale;
        const o = { cx: 195 * s, cy: (S.sh + 96 + gOff) * s, R: 420 * s, lon: view.lon + drift, lat: view.lat, t: reduce ? 3 : t, power: pw,
          target: tv.has ? G.cityIndex(tv.glat, tv.glon) : -1, packets: m === 'disconnected' ? 0 : pw, dpr: s, bandY: (S.sh - 519 + gOff) * s };
        G.draw(ctx, canvas.width, canvas.height, o);
        if (tv.has && hasActivePlan()) {
          const p = G.project(tv.glat, tv.glon, o);
          marker.style.display = p[2] > 0 ? 'block' : 'none';
          marker.style.transform = `translate(${(p[0] / s).toFixed(1)}px,${(p[1] / s).toFixed(1)}px)`;
        } else marker.style.display = 'none';
        paint();
        raf = requestAnimationFrame(frame);
      }
      raf = requestAnimationFrame(frame);
      const refresh = () => window.CG.loadMe().then(maybeRemind).catch(() => {});
      const offResume = on('resume', refresh);
      // usage and days left come live from the panel; refresh them every minute while home is open
      const meTimer = setInterval(refresh, 60000);
      if (!S.meAt || Date.now() - S.meAt > 20000) refresh(); else setTimeout(maybeRemind, 800);
      return () => { cancelAnimationFrame(raf); stopLive(); offResume(); clearInterval(meTimer); screens.home.resize = null; };
    },
  };

  // ---------------- SERVERS ----------------
  screens.servers = {
    fit: 'width',
    bg: 'linear-gradient(180deg,#0B2232 0%,#071826 22%,#030D17 48%,#04101C 78%,#071321 100%)',
    html: () => `
      <button type="button" aria-label="بازگشت" class="sv-back" style="position:absolute;left:340px;top:58px;width:32px;height:32px;display:flex;align-items:center;justify-content:center">${I.chevL}</button>
      <h1 style="position:absolute;left:0;top:63px;width:390px;margin:0;text-align:center;font-family:Outfit;font-size:16.5px;font-weight:400;line-height:22px;pointer-events:none">سرورها</h1>
      <button type="button" aria-label="تنظیمات سرورها" class="sv-gear" style="position:absolute;left:18px;top:58px;width:32px;height:32px;display:flex;align-items:center;justify-content:center">
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linejoin="round"><path d="M10.3 2.6h3.4l.5 2.6 1.9 1.1 2.5-.9 1.7 2.9-2 1.7v2.2l2 1.7-1.7 2.9-2.5-.9-1.9 1.1-.5 2.6h-3.4l-.5-2.6-1.9-1.1-2.5.9-1.7-2.9 2-1.7v-2.2l-2-1.7 1.7-2.9 2.5.9 1.9-1.1z"/><circle cx="12" cy="12" r="3.1"/></svg>
      </button>
      <div style="position:absolute;left:17px;top:108px;width:356px;height:256px;border-radius:34px;background:linear-gradient(180deg,#1C2F3D 0%,#1A2633 45%,#171E28 100%);border:1px solid rgba(255,255,255,.05);box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 20px 40px rgba(0,0,0,.35);font-family:Outfit">
        <span class="sv-flag" style="position:absolute;right:16px;top:16px"></span>
        <div class="sv-name" style="position:absolute;right:83px;top:21px;left:16px;font-size:21px;font-weight:500;line-height:26px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
        <div style="position:absolute;right:83px;top:50px;display:flex;align-items:center;gap:5px;font-size:12.5px;line-height:16px">${I.globe.replace('width="14" height="14"', 'width="13" height="13"')}<span class="sv-ip"></span></div>
        <div dir="ltr" class="sv-stats" style="position:absolute;left:0;top:104px;width:356px;height:46px;transition:opacity 300ms">
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" style="position:absolute;left:20px;top:18px" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round"><path d="M10.5 1.5l-9 9M8 10.5H1.5V4"/></svg>
          <span style="position:absolute;left:47px;top:0;font-size:12px;line-height:16px;color:#8C9297">دانلود</span>
          <span style="position:absolute;left:47px;top:19px;font-size:19.5px;font-weight:600;line-height:26px;font-variant-numeric:tabular-nums"><span class="sv-dl">--</span><span style="font-size:13px;font-weight:500">mbps</span></span>
          <span style="position:absolute;left:124px;top:3px;width:1px;height:34px;background:rgba(255,255,255,.08)"></span>
          <span class="sv-bars" style="position:absolute;left:140px;top:18px"></span>
          <span style="position:absolute;left:169px;top:0;font-size:12px;line-height:16px;color:#8C9297">پینگ</span>
          <span style="position:absolute;left:169px;top:19px;font-size:19.5px;font-weight:600;line-height:26px;font-variant-numeric:tabular-nums"><span class="sv-ping">--</span><span style="font-size:13px;font-weight:500">ms</span></span>
          <span style="position:absolute;left:236px;top:3px;width:1px;height:34px;background:rgba(255,255,255,.08)"></span>
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" style="position:absolute;left:255px;top:18px" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round"><path d="M1.5 10.5l9-9M4 1.5h6.5V8"/></svg>
          <span style="position:absolute;left:282px;top:0;font-size:12px;line-height:16px;color:#8C9297">آپلود</span>
          <span style="position:absolute;left:282px;top:19px;font-size:19.5px;font-weight:600;line-height:26px;font-variant-numeric:tabular-nums"><span class="sv-ul">--</span><span style="font-size:13px;font-weight:500">mbps</span></span>
        </div>
        <div dir="ltr" class="sv-track" style="position:absolute;left:16px;top:174px;width:324px;height:65px;border-radius:33px;background:linear-gradient(180deg,#2A323B 0%,#2E363F 100%);box-shadow:inset 0 2px 6px rgba(0,0,0,.35),inset 0 -1px 0 rgba(255,255,255,.04)">
          <span class="sv-label" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:16.5px;pointer-events:none"></span>
          <svg aria-hidden="true" class="sv-chev" width="38" height="16" viewBox="0 0 38 16" style="position:absolute;left:257px;top:25px;pointer-events:none" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path style="animation:svChev 1.6s ease-in-out infinite" d="M2 1.5l6.5 6.5L2 14.5"/><path style="animation:svChev 1.6s ease-in-out infinite;animation-delay:.2s" d="M14 1.5l6.5 6.5L14 14.5"/><path style="animation:svChev 1.6s ease-in-out infinite;animation-delay:.4s" d="M26 1.5l6.5 6.5L26 14.5"/></svg>
          <button type="button" class="knob sv-knob" style="position:absolute;left:6px;top:6px;width:52px;height:52px;border-radius:50%;box-shadow:0 4px 14px rgba(40,50,140,.45),inset 0 1px 0 rgba(255,255,255,.25)">
            <svg aria-hidden="true" class="sv-spin spin" width="22" height="22" viewBox="0 0 22 22" style="position:absolute;left:15px;top:15px;animation-duration:.9s"><circle cx="11" cy="11" r="8.5" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="2.2"/><path d="M11 2.5a8.5 8.5 0 0 1 8.5 8.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>
            <svg aria-hidden="true" class="sv-arrow" width="20" height="16" viewBox="0 0 20 16" style="position:absolute;left:16px;top:18px" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8h16M11 1.5L17.5 8 11 14.5"/></svg>
          </button>
        </div>
      </div>
      <div class="scroll sv-list" style="top:392px;font-family:Outfit"></div>`,
    mount(root) {
      const $ = (c) => root.querySelector(c);
      $('.sv-back').onclick = () => window.CG.back('home');
      $('.sv-gear').onclick = () => window.CG.connSettings(() => renderList());
      startLive();
      const expanded = {};
      const pings = window.CG.S.serverPings = window.CG.S.serverPings || {};
      const offPing = on('serverPing', (v) => { if (v && v.guid) { pings[v.guid] = v.ms; schedule(); } });
      let pend = 0;
      const schedule = () => { clearTimeout(pend); pend = setTimeout(renderList, 250); };

      function groups() {
        const map = new Map();
        S.servers.forEach((s) => {
          const key = s.cc || '_' + s.name;
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(s);
        });
        return Array.from(map.values());
      }
      const best = (list) => list.slice().sort((a, b) => (pings[a.guid] > 0 ? pings[a.guid] : 1e9) - (pings[b.guid] > 0 ? pings[b.guid] : 1e9))[0];
      function renderList() {
        const el = $('.sv-list');
        const act = hasActivePlan();
        if (!act) {
          el.innerHTML = `<div style="padding:10px 24px;text-align:center;color:#8F949B;font-size:15px;line-height:23px">برای دسترسی به همه‌ی لوکیشن‌ها اشتراک بگیر یا تمدید کن.<div style="height:16px"></div><button class="pill-btn white" data-buy>دیدن پلن‌ها</button></div>`;
          el.querySelector('[data-buy]').onclick = () => go('premium', { from: 'servers' });
          return;
        }
        if (!S.servers.length) {
          el.innerHTML = `<h2 style="margin:0;padding:0 17px;font-size:17.5px;font-weight:500;line-height:24px">لوکیشن‌ها</h2>${[0, 1, 2].map(() => '<div class="srv-row"><div class="skeleton" style="width:38px;height:38px;border-radius:50%"></div><div class="skeleton" style="width:140px;height:16px"></div></div>').join('')}`;
          return;
        }
        const m = mode(), gs = groups();
        const autoOn = S.auto;
        let h = `<button type="button" class="smart" data-smart style="${autoOn ? '' : 'background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)'}">
            <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="${autoOn ? '#52FF00' : '#9FB0C4'}" stroke-width="1.9" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>
            <span style="flex:1;min-width:0"><b>اتصال هوشمند ${autoOn ? '<span style="display:inline;color:#52FF00;font-size:12px;font-weight:500">· روشن</span>' : ''}</b><span>سریع‌ترین سرور خودکار انتخاب می‌شود و اگر قطع شد، سرور بعدی</span></span></button>
          <h2 style="margin:12px 0 0;padding:0 17px;font-size:17.5px;font-weight:500;line-height:24px">لوکیشن‌ها</h2>`;
        gs.forEach((list, gi) => {
          const head = list[0], isCur = list.some((s) => s.guid === S.selected);
          const ms = list.map((s) => pings[s.guid]).filter((x) => x > 0);
          const sub = `${faNum(list.length)} سرور${ms.length ? ' · ' + Math.min(...ms) + ' ms' : ''}`;
          const label = isCur && m === 'connected' ? 'متصل' : isCur && m === 'connecting' ? 'در حال اتصال' : 'اتصال';
          const last = gi === gs.length - 1 && !expanded[gi];
          h += `<div class="srv-row" data-g="${gi}" style="${last ? 'border-bottom:0' : ''}">
            ${flag(head.cc, 38).replace('class="flag"', 'class="flag" style="box-shadow:0 0 0 1px rgba(255,255,255,.06)"').replace('" style="width', ';width')}
            <div style="min-width:0;flex:1">
              <div style="font-size:16px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(countryName(head))}</div>
              <div style="font-size:10.5px;line-height:14px;color:#8F949B;margin-top:4px">${sub}${list.length > 1 ? (expanded[gi] ? ' ▴' : ' ▾') : ''}</div>
            </div>
            <button type="button" class="srv-btn" data-pick="${gi}" style="background:${isCur && m === 'connected' ? 'rgba(64,255,0,.16)' : '#1A2A37'}">${label}</button>
          </div>`;
          if (expanded[gi]) {
            list.forEach((s, si) => {
              const cur = s.guid === S.selected;
              h += `<div class="srv-row" style="height:56px;padding-left:49px;${gi === gs.length - 1 && si === list.length - 1 ? 'border-bottom:0' : ''}">
                <div style="min-width:0;flex:1"><div style="font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</div>
                <div style="font-size:10.5px;color:#8F949B;margin-top:2px">${esc((s.type || '').toUpperCase())}${pings[s.guid] > 0 ? ' · ' + pings[s.guid] + ' ms' : pings[s.guid] < 0 ? ' · بدون پاسخ' : ''}</div></div>
                <button type="button" class="srv-btn" data-one="${esc(s.guid)}" style="width:80px;height:30px;background:${cur && m === 'connected' ? 'rgba(64,255,0,.16)' : '#1A2A37'}">${cur && m === 'connected' ? 'فعال' : 'انتخاب'}</button></div>`;
            });
          }
        });
        el.innerHTML = h + '<div style="height:40px"></div>';
        el.querySelectorAll('[data-g]').forEach((row) => {
          row.onclick = (ev) => {
            if (ev.target.closest('button')) return;
            const gi = +row.dataset.g;
            if (gs[gi].length > 1) { expanded[gi] = !expanded[gi]; renderList(); }
          };
        });
        el.querySelectorAll('[data-pick]').forEach((b) => {
          b.onclick = () => {
            const list = gs[+b.dataset.pick];
            if (list.some((s) => s.guid === S.selected) && (m === 'connected' || m === 'connecting')) return;
            window.CG.setAuto(false);
            connect(best(list).guid);
            renderList();
          };
        });
        el.querySelectorAll('[data-one]').forEach((b) => { b.onclick = () => { window.CG.setAuto(false); connect(b.dataset.one); renderList(); }; });
        const smart = el.querySelector('[data-smart]');
        if (smart) smart.onclick = () => {
          window.CG.setAuto(true);
          renderList();
          if (m === 'connecting' || m === 'disconnecting') return;
          toast('در حال پیدا کردن سریع‌ترین سرور...');
          window.CG.testAll(7000).then(() => { renderList(); connect(); });
        };
      }

      // slide-to-connect knob
      const knob = $('.sv-knob'), MAXX = 260;
      let dragX = 0, suppressTap = false, lastMode = '';
      function finish() {
        const m = mode();
        if (m === 'connected') { knob.style.transform = `translateX(${MAXX}px)`; disconnect(); }
        else if (m === 'disconnected') { knob.style.transform = `translateX(${MAXX}px)`; setTimeout(() => connect(), 250); }
      }
      knob.onpointerdown = (ev) => {
        const m = mode();
        if (m === 'connecting' || m === 'disconnecting') return;
        const x0 = ev.clientX, k = S.k;
        let moved = false;
        knob.classList.add('drag');
        try { knob.setPointerCapture(ev.pointerId); } catch (e) {}
        const move = (e) => { const dx = Math.max(0, Math.min(MAXX, (e.clientX - x0) / k)); if (dx > 4) moved = true; knob.style.transform = `translateX(${dx}px)`; dragX = dx; };
        const up = () => {
          knob.removeEventListener('pointermove', move); knob.removeEventListener('pointerup', up); knob.removeEventListener('pointercancel', up);
          knob.classList.remove('drag');
          suppressTap = moved;
          if (dragX > MAXX * 0.72) finish(); else knob.style.transform = 'translateX(0)';
          dragX = 0;
        };
        knob.addEventListener('pointermove', move); knob.addEventListener('pointerup', up); knob.addEventListener('pointercancel', up);
      };
      knob.onclick = () => { if (suppressTap) { suppressTap = false; return; } finish(); };

      function paint() {
        const m = mode(), srv = selectedServer(), onn = m === 'connected', busy = m === 'connecting' || m === 'disconnecting';
        $('.sv-flag').innerHTML = srv ? flag(srv.cc, 54) : `<span class="flag" style="width:54px;height:54px;background:linear-gradient(135deg,#3465A1,#5844AE)"></span>`;
        $('.sv-name').textContent = srv ? countryName(srv) : hasActivePlan() ? 'یک لوکیشن انتخاب کن' : 'اشتراک فعال ندارید';
        $('.sv-ip').textContent = onn ? live.ip || 'در حال بررسی...' : busy ? (S.vpn.label || (srv ? srv.name : '')) : 'متصل نیستی';
        $('.sv-stats').style.opacity = onn ? 1 : 0.45;
        const mbps = (v) => (v * 8 / 1e6 >= 10 ? Math.round(v * 8 / 1e6) : (v * 8 / 1e6).toFixed(1));
        $('.sv-dl').textContent = onn ? mbps(live.down) : '--';
        $('.sv-ul').textContent = onn ? mbps(live.up) : '--';
        $('.sv-ping').textContent = onn && S.ping ? S.ping : '--';
        $('.sv-bars').innerHTML = bars(onn ? S.ping : 0, 'big');
        const labels = { connected: 'قطع اتصال', disconnected: 'برای اتصال بکش', connecting: 'در حال اتصال...', disconnecting: 'در حال قطع...' };
        $('.sv-label').textContent = labels[m];
        knob.setAttribute('aria-label', labels[m]);
        knob.style.background = m === 'disconnected' ? 'linear-gradient(135deg,#2FBF5A 0%,#1E8F7E 100%)' : 'linear-gradient(135deg,#3663A2 0%,#4B55A9 55%,#5046AA 100%)';
        $('.sv-chev').setAttribute('stroke', m === 'disconnected' ? '#7BE59A' : '#74AAE0');
        $('.sv-spin').style.display = busy ? 'block' : 'none';
        $('.sv-arrow').style.display = busy ? 'none' : 'block';
        if (m !== lastMode) {
          if (!knob.classList.contains('drag')) knob.style.transform = busy ? `translateX(${MAXX}px)` : 'translateX(0)';
          if (lastMode) renderList();
          lastMode = m;
        }
      }
      renderList();
      paint();
      const iv = setInterval(paint, 500);
      if (hasActivePlan() && !S.servers.length) syncVpn().then(renderList).catch((e) => toast(e.message, true));
      return () => { clearInterval(iv); stopLive(); offPing(); clearTimeout(pend); };
    },
  };
})();
