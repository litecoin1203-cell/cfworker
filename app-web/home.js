/* Home: the connect button, the connection state (icon + word + color), current server, latency, duration,
 * this session's usage and the Kill Switch indicator. Repaints only the part that changed (see vpn.js events). */
(function () {
  'use strict';
  const CG = window.CG;
  const { t, esc, S, on, screens, halo, mark, hasActivePlan, syncVpn } = CG;
  const I18 = CG.i18n;

  // HH:MM:SS, always left to right, in the language's digits
  const clock = (sec) => [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60].map(I18.n2).join(':');

  function serverName(srv) {
    if (!srv) return '';
    const c = srv.cc ? I18.country(srv.cc) : '';
    return c && c !== srv.cc ? c : srv.name;
  }
  CG.serverName = serverName;

  // the warning the plan deserves now, from the server's own numbers (used_percent, days_left)
  function planWarning(sub) {
    if (!sub || !sub.active) return null;
    const pct = sub.used_percent;
    if (pct != null && pct >= 100) return { kind: 'bad', title: t('us.w100'), sub: t('us.w100.sub') };
    if (pct != null && pct >= 95) return { kind: 'bad', title: t('us.w95'), sub: t('us.w95.sub', { left: I18.size(sub.remaining_bytes) }) };
    if (pct != null && pct >= 80) return { kind: 'warn', title: t('us.w80'), sub: t('us.w80.sub', { left: I18.size(sub.remaining_bytes) }) };
    if (!sub.unlimited_time && sub.days_left != null && sub.days_left <= 3) return { kind: 'warn', title: t('us.wdays', { n: I18.n(sub.days_left) }), sub: '' };
    return null;
  }
  CG.planWarning = planWarning;

  screens.home = {
    flow: true,
    html: () => `
      <div class="fl-scroll"><div class="fl-col home">
        <div class="home-top">
          <span class="home-brand">${mark(28)}<span>${esc(t('app.name'))}</span></span>
          <button type="button" class="planchip js-plan" hidden></button>
        </div>
        <div class="js-notices"></div>
        <section class="hero">
          <button type="button" class="pb off js-coin">${halo()}</button>
          <div class="hero-state">
            <div class="js-status" aria-live="polite"></div>
            <p class="t-small c-2 js-sub"></p>
          </div>
          <div class="js-cta"></div>
        </section>
        <div class="list facts">
          <button type="button" class="row js-server">
            <span class="flag-c js-flag" aria-hidden="true"></span>
            <span class="rb"><span>${esc(t('conn.server'))}</span><b class="js-sname"></b></span>
            ${CG.ui.ic('chevron', 'ri flip-rtl')}
          </button>
          <div class="row">${CG.ui.ic('signal', 'ri')}<span class="rb"><span>${esc(t('conn.latency'))}</span><b class="js-lat"></b></span></div>
          <div class="row">${CG.ui.ic('clock', 'ri')}<span class="rb"><span>${esc(t('conn.duration'))}</span><b class="js-dur num-ltr"></b></span></div>
          <div class="row">${CG.ui.ic('arrows', 'ri')}<span class="rb"><span>${esc(t('conn.session'))}</span><b class="js-sess"></b></span></div>
          <button type="button" class="row js-ks">${CG.ui.ic('lock', 'ri')}<span class="rb"><span>${esc(t('conn.ks.label'))}</span><b class="js-ksv"></b></span>${CG.ui.ic('chevron', 'ri flip-rtl')}</button>
        </div>
      </div></div>
      ${CG.ui.tabs('home')}`,
    mount(root) {
      const $ = (c) => root.querySelector(c);
      const ui = CG.ui;
      CG.ui.bindTabs(root);
      const coin = $('.js-coin');

      coin.onclick = () => {
        const p = CG.phase();
        if (p === 'blocked') return CG.go('premium', { from: 'home' });
        if (p === 'disconnecting') return;
        if (p === 'connected' || p === 'connecting') return CG.disconnect();
        CG.connect();
      };
      $('.js-server').onclick = () => {
        if (!hasActivePlan()) return CG.go('premium', { from: 'home' });
        if (S.syncError && S.syncError.code === 'device_limit') return CG.go('account');
        if (S.syncError || !S.servers.length) { syncVpn().then(() => { S.syncError = null; paintServer(); }).catch((e) => { S.syncError = e; paintNotices(); }); return; }
        CG.tab('servers');
      };
      $('.js-ks').onclick = () => CG.tab('settings');
      $('.js-plan').onclick = () => CG.tab('usage');

      // ---- painters: each touches only its own nodes ----
      let lastPhase = '';
      function paintPhase() {
        const p = CG.phase();
        const cls = p === 'connected' ? 'on' : p === 'connecting' || p === 'disconnecting' ? 'busy' : 'off';
        if (!coin.classList.contains(cls)) { coin.classList.remove('on', 'busy', 'off'); coin.classList.add(cls); }
        coin.classList.toggle('blocked', p === 'blocked');
        const action = p === 'connected' ? 'conn.btn.disconnect' : p === 'connecting' ? 'conn.btn.cancel' : p === 'blocked' ? (S.me && S.me.subscription ? 'conn.btn.renew' : 'conn.btn.buy') : 'conn.btn.connect';
        const stateWord = t(ui.PHASE[p].word);
        coin.setAttribute('aria-label', t(action) + t('common.sep') + stateWord);
        coin.setAttribute('aria-disabled', p === 'disconnecting' ? 'true' : 'false');
        if (p !== lastPhase) $('.js-status').innerHTML = ui.statusChip(p);
        const reason = CG.stopReason();
        $('.js-sub').textContent = p === 'blocked' ? t('stop.' + reason) + '. ' + t('stop.' + reason + '.sub')
          : p === 'connecting' ? t(S.vpn.label || 'conn.sub.connecting')
          : p === 'error' ? CG.ui.errText({ code: S.vpn.error })
          : t('conn.sub.' + (p === 'connected' ? 'connected' : p === 'disconnecting' ? 'disconnecting' : 'disconnected'));
        const support = p === 'blocked' && ['disabled', 'missing'].includes(reason) && S.config && S.config.support_url;
        $('.js-cta').innerHTML = p !== 'blocked' ? '' : support
          ? `<button type="button" class="btn primary js-sup">${esc(t('stop.support'))}</button>`
          : `<button type="button" class="btn primary js-renew">${esc(t(action))}</button>`;
        const r = $('.js-renew'); if (r) r.onclick = () => CG.go('premium', { from: 'home' });
        const sp = $('.js-cta .js-sup'); if (sp) sp.onclick = () => CG.openSupport();
        root.querySelector('.facts').classList.toggle('dim', p !== 'connected');
        lastPhase = p;
        paintTick(); paintPing(); paintNotices();
      }
      function paintServer() {
        const srv = CG.selectedServer();
        $('.js-flag').textContent = srv && srv.cc ? CG.ccToFlag(srv.cc) : '';
        $('.js-server').setAttribute('aria-label', t('conn.server') + ': ' + (S.auto && !S.vpn.running && srv ? t('conn.smart.on') : serverName(srv) || t('conn.none')) + '. ' + t('conn.change'));
        $('.js-sname').textContent = !hasActivePlan() ? t('conn.none') : !srv ? t('sv.loading') : S.auto && !S.vpn.running ? t('conn.smart.on') : serverName(srv);
      }
      function paintPing() {
        const q = S.vpn.running ? CG.quality() : null;
        $('.js-lat').textContent = S.vpn.running && S.ping
          ? t('conn.ms.short', { n: I18.n(S.ping) }) + (q ? t('common.sep') + t('conn.quality') + ' ' + t(q.word) : '')
          : t('conn.none');
      }
      function paintTick() {
        $('.js-dur').textContent = S.vpn.running ? clock(CG.durationSec()) : t('conn.none');
        $('.js-sess').textContent = S.vpn.running ? I18.size(CG.sessionBytes()) : t('conn.none');
      }
      function paintPolicy() {
        const p = S.policy || {};
        $('.js-ksv').textContent = p.known ? t(p.lockdown ? 'conn.ks.on' : 'conn.ks.off') : t('conn.ks.unknown');
        $('.js-ks').setAttribute('aria-label', t('conn.ks.a11y', { state: $('.js-ksv').textContent }));
      }
      function paintPlan() {
        const sub = S.me && S.me.subscription;
        const chip = $('.js-plan');
        if (!sub || !sub.active) { chip.hidden = true; return; }
        chip.hidden = false;
        const w = planWarning(sub);
        chip.className = 'planchip js-plan' + (w ? ' ' + w.kind : '');
        const days = sub.unlimited_time ? t('us.no_expiry') : I18.n(sub.days_left) + ' ' + t('us.days_left');
        chip.innerHTML = `${ui.ic('gauge')}<span>${esc(days)}</span>`;
      }
      function paintNotices() {
        const out = [];
        const p = CG.phase();
        if (S.offline) out.push(ui.notice('warn', t('conn.offline')));
        if (S.vpn.dropped && !S.vpn.running) out.push(ui.notice('bad', t('conn.dropped'), t('conn.dropped.sub')));
        // the stop reason itself sits under the button (paintPhase); here only the early warnings
        if (p !== 'blocked') {
          const w = planWarning(S.me && S.me.subscription);
          if (w) out.push(ui.notice(w.kind, w.title, w.sub, `<button type="button" class="btn quiet js-renew2">${esc(t('conn.btn.renew'))}</button>`));
        }
        if (p === 'error' && S.vpn.error === 'device_limit') out.push(ui.notice('bad', t('err.device_limit'), '', `<button type="button" class="btn quiet js-acc">${esc(t('us.account'))}</button>`));
        if (S.vpn.running && CG.quality() && CG.quality().kind === 'bad' && !S.auto) out.push(ui.notice('warn', t('conn.weak')));
        const box = $('.js-notices');
        const html = out.join('');
        if (box.dataset.h !== html) {
          box.dataset.h = html; box.innerHTML = html;
          const r = box.querySelector('.js-renew2'); if (r) r.onclick = () => CG.go('premium', { from: 'home' });
          const a = box.querySelector('.js-acc'); if (a) a.onclick = () => CG.go('account');
        }
      }

      const off = on('conn', (w) => {
        if (w.phase || w.net || w.me) { paintPhase(); paintPlan(); }
        if (w.server || w.phase || w.auto) paintServer();
        if (w.ping) { paintPing(); paintNotices(); }
        if (w.policy) paintPolicy();
      });
      // one timer for the two counting numbers; it writes two text nodes only, and only while connected
      const tick = setInterval(() => { if (S.vpn.running) paintTick(); }, 1000);

      CG.startLive();
      paintPhase(); paintServer(); paintPolicy(); paintPlan();
      CG.refreshPolicy();
      CG.loadMe().then(() => { paintPhase(); paintPlan(); paintServer(); }).catch(() => {});
      CG.loadConfig().catch(() => null);
      if (hasActivePlan() && !S.servers.length && !S.syncError) syncVpn().then(paintServer).catch((e) => { S.syncError = e; paintNotices(); });
      return () => { off(); clearInterval(tick); CG.stopLive(); };
    },
  };
})();
