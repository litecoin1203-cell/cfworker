/* Settings. Kill Switch and Always-On only mirror what Android itself reports (S.policy); the app cannot turn them on,
 * so they never show "on" unless Android said so. Auto-connect and notifications show the state the phone really saved,
 * and fall back with an explanation when Android says no. Nothing here needs a new API. */
(function () {
  'use strict';
  const CG = window.CG;
  const { t, esc, S, on, screens, call } = CG;
  const I18 = CG.i18n;

  // what Android told us about one of its two VPN options
  function policyText(which) {
    const p = S.policy || {};
    if (p.known) return t(p[which] ? 'st.state.on' : 'st.state.off');
    return t(p.reason === 'old_android' ? 'st.state.old' : 'st.state.unknown');
  }
  const policyShort = (which) => { const p = S.policy || {}; return t(!p.known ? 'st.short.unknown' : p[which] ? 'st.short.on' : 'st.short.off'); };
  const policyKind = (which) => { const p = S.policy || {}; return !p.known ? 'idle' : p[which] ? 'ok' : 'warn'; };

  // a radio group of chips, e.g. the theme
  const choice = (id, label, items, cur) => `<div class="chips wrap" role="radiogroup" aria-label="${esc(label)}" id="${id}">${items.map(([v, l]) =>
    `<button type="button" class="chip" role="radio" data-v="${esc(v)}" aria-checked="${v === cur}">${esc(l)}</button>`).join('')}</div>`;

  function sysGuide(after) {
    return CG.ui.fsheet(`<h3>${esc(t('st.sys.title'))}</h3>
      <p class="t-body c-2">${esc(t('st.sys.why'))}</p>
      <ol class="steps">${['s1', 's2', 's3', 's4'].map((k) => `<li>${esc(t('st.sys.' + k))}</li>`).join('')}</ol>
      <button type="button" class="btn primary js-open">${esc(t('st.sys.open'))}</button>
      <button type="button" class="btn quiet js-no">${esc(t('common.later'))}</button>`, (el, close) => {
      el.querySelector('.js-no').onclick = close;
      el.querySelector('.js-open').onclick = async () => {
        close();
        try { const r = await call('vpnSystemSettings', {}); if (r && r.opened === false) CG.toast(t('st.sys.failed'), true); else after(); }
        catch (e) { CG.toast(t('st.sys.failed'), true); }
      };
    });
  }

  function googleSheet(r) {
    if (!r || r.error) { CG.toast(t('st.gtest.fail'), true); return; }
    const gcc = r.google_cc, iran = gcc === 'IR';
    const gem = r.gemini === true || (r.gemini == null && gcc && !['IR', 'CN', 'RU', 'KP', 'SY', 'CU', 'BY', 'HK', 'MO'].includes(gcc));
    const good = !iran && !r.google_blocked && gem;
    // only what Google sees; the server's own exit address is never shown
    const row = (k, v, ok) => `<div class="kv"><span>${esc(k)}</span><b class="${ok === false ? 'c-bad' : ok ? 'c-ok' : ''}">${esc(v)}</b></div>`;
    CG.ui.fsheet(`<h3>${esc(t(good ? 'st.gtest.ok' : 'st.gtest.bad'))}</h3>
      <div class="card">
        ${row(t('st.gtest.sees'), gcc ? I18.country(gcc) : '?', gcc ? !iran : null)}
        ${row(t('st.gtest.gemini'), t(gem ? 'st.gtest.open' : 'st.gtest.closed'), !!gem)}
        ${row(t('st.gtest.search'), t(r.google_blocked ? 'st.gtest.captcha' : 'st.gtest.normal'), !r.google_blocked)}
      </div>
      ${good ? '' : `<button type="button" class="btn primary js-fix">${esc(t('st.gtest.fix'))}</button>`}
      <button type="button" class="btn quiet js-no">${esc(t('common.close'))}</button>`, (el, close) => {
      el.querySelector('.js-no').onclick = close;
      const fx = el.querySelector('.js-fix');
      if (fx) fx.onclick = () => { close(); CG.setGoogleMode(true); CG.setAuto(true); CG.connect(); };
    });
  }

  screens.settings = {
    flow: true,
    html: () => {
      const ui = CG.ui;
      return `
      <div class="fl-scroll"><div class="fl-col settings">
        ${ui.appBar(t('st.title'))}
        <h2 class="section">${esc(t('st.protect'))}</h2>
        <div class="list">
          <button type="button" class="row" id="st-ks">${ui.ic('lock', 'ri lead-ic')}<span class="rb"><b>${esc(t('st.ks'))}</b><span>${esc(t('st.ks.sub'))}</span><em class="status sm js-ksv"></em></span>${ui.ic('chevron', 'ri')}</button>
          <button type="button" class="row" id="st-aon">${ui.ic('shieldOk', 'ri lead-ic')}<span class="rb"><b>${esc(t('st.aon'))}</b><span>${esc(t('st.aon.sub'))}</span><em class="status sm js-aonv"></em></span>${ui.ic('chevron', 'ri')}</button>
        </div>
        <p class="t-small c-2 st-why js-polwhy" hidden></p>
        <div class="js-sysnote"></div>

        <h2 class="section">${esc(t('st.conn'))}</h2>
        <div class="list">
          ${ui.switchRow('st-boot', t('st.auto'), t('st.auto.sub'), false, ' aria-disabled="true"')}
          ${ui.switchRow('st-smart', t('st.smart'), t('st.smart.sub'), S.auto)}
          ${ui.switchRow('st-google', t('st.google'), t('st.google.sub'), S.googleMode)}
          ${ui.switchRow('st-iran', t('st.iran'), t('st.iran.sub'), false, ' aria-disabled="true"')}
        </div>
        <div class="js-bootnote"></div>
        <div class="list gap-top">
          ${ui.linkRow('st-gtest', 'globe', t('st.gtest'), '', '')}
          ${ui.linkRow('st-sync', 'refresh', t('sv.refresh'), '', '')}
          ${ui.linkRow('st-test', 'signal', t('sv.test'), '', '')}
        </div>

        <h2 class="section">${esc(t('st.notif'))}</h2>
        <div class="list">${ui.switchRow('st-notif', t('st.notif'), t('st.notif.sub'), false, ' aria-disabled="true"')}</div>
        <div class="js-notifnote"></div>

        <h2 class="section">${esc(t('st.look'))}</h2>
        <div class="st-look">
          <p class="t-small c-2 lead" id="st-theme-l">${esc(t('st.theme'))}</p>
          ${choice('st-theme', t('st.theme'), [['system', t('st.theme.system')], ['dark', t('st.theme.dark')], ['light', t('st.theme.light')]], CG.themeSetting())}
        </div>

        <h2 class="section">${esc(t('st.account'))}</h2>
        <div class="list">
          ${ui.linkRow('st-acc', 'user', t('st.acc.devices'), '', '')}
          ${ui.linkRow('st-wallet', 'wallet', t('st.acc.wallet'), '', '')}
          ${ui.linkRow('st-invite', 'gift', t('st.acc.invite'), '', '')}
          ${ui.linkRow('st-orders', 'receipt', t('st.acc.orders'), '', '')}
          ${ui.linkRow('st-sup', 'chat', t('st.acc.support'), '', '')}
          ${ui.linkRow('st-out', 'logout', t('st.acc.logout'), '', '')}
        </div>

        <h2 class="section">${esc(t('st.about'))}</h2>
        <div class="card">
          <div class="kv"><span>${esc(t('st.version'))}</span><b class="js-ver"></b></div>
          <div class="kv"><span>${esc(t('st.core'))}</span><b class="js-core"></b></div>
        </div>
      </div></div>
      ${ui.tabs('settings')}`;
    },
    mount(root, p) {
      const $ = (c) => root.querySelector(c);
      const ui = CG.ui;
      ui.bindTabs(root);
      const setSw = (id, v, ready) => { const b = $('#' + id); b.setAttribute('aria-checked', v ? 'true' : 'false'); if (ready) b.removeAttribute('aria-disabled'); };
      const busy = (id) => $('#' + id).getAttribute('aria-disabled') === 'true';

      // ---- Kill Switch / Always-On: Android's answer, nothing else ----
      let waitingSys = false;
      function paintPolicy() {
        [['js-ksv', 'lockdown', 'st-ks', 'st.ks'], ['js-aonv', 'alwaysOn', 'st-aon', 'st.aon']].forEach(([cls, which, id, label]) => {
          const v = $('.' + cls);
          v.className = 'status ' + policyKind(which) + ' ' + cls;
          v.textContent = policyShort(which);
          $('#' + id).setAttribute('aria-label', t(label) + t('common.sep') + policyText(which) + '. ' + t('st.sys.title'));
        });
        // why it is unknown, once, under the two rows
        const pol = S.policy || {};
        const box = $('.js-polwhy');
        box.textContent = pol.known ? '' : t(pol.reason === 'old_android' ? 'st.state.old' : 'st.state.unknown');
        box.hidden = !!pol.known;
      }
      const openGuide = () => sysGuide(() => { waitingSys = true; });
      $('#st-ks').onclick = openGuide;
      $('#st-aon').onclick = openGuide;
      function afterSys() {
        if (!waitingSys) return;
        waitingSys = false;
        CG.refreshPolicy().then(() => {
          const pol = S.policy || {};
          const what = t('st.ks');
          const msg = !pol.known ? t('st.sys.back.unknown') : pol.lockdown ? t('st.sys.back.on', { what }) : t('st.sys.back.off', { what });
          $('.js-sysnote').innerHTML = ui.notice(!pol.known ? 'info' : pol.lockdown ? 'ok' : 'warn', msg);
          ui.announce(msg);
        });
      }

      // ---- auto-connect after boot: the saved setting, and Android's VPN permission ----
      call('getAutoStart', {}).then((r) => setSw('st-boot', r && r.on, true)).catch(() => {});
      $('#st-boot').onclick = async () => {
        if (busy('st-boot')) return;
        const want = $('#st-boot').getAttribute('aria-checked') !== 'true';
        $('#st-boot').setAttribute('aria-disabled', 'true');
        $('.js-bootnote').innerHTML = '';
        try {
          const r = await call('setAutoStart', { on: want });
          setSw('st-boot', r && r.on, true);
          if (want && !(r && r.on)) {
            const msg = t(r && r.noServer ? 'st.auto.noserver' : 'st.auto.denied');
            $('.js-bootnote').innerHTML = ui.notice('warn', msg);
            ui.announce(msg);
          } else ui.announce(t('st.saved'));
        } catch (e) { setSw('st-boot', !want, true); CG.toast(ui.errText(e), true); }
      };

      // ---- smart connect / Google mode: kept on this phone ----
      $('#st-smart').onclick = () => { CG.setAuto(!S.auto); setSw('st-smart', S.auto); ui.announce(t('st.saved')); };
      $('#st-google').onclick = () => { CG.setGoogleMode(!S.googleMode); setSw('st-google', S.googleMode); ui.announce(t('st.saved')); };

      // ---- Iranian sites direct: the core's routing setting ----
      call('getTune', {}).then((r) => setSw('st-iran', r && r.iranDirect, true)).catch(() => {});
      $('#st-iran').onclick = async () => {
        if (busy('st-iran')) return;
        const want = $('#st-iran').getAttribute('aria-checked') !== 'true';
        $('#st-iran').setAttribute('aria-disabled', 'true');
        try { const r = await call('setTune', { iranDirect: want }); setSw('st-iran', r && r.iranDirect, true); ui.announce(t('st.saved')); }
        catch (e) { setSw('st-iran', !want, true); CG.toast(ui.errText(e), true); }
      };

      $('#st-gtest').onclick = async (ev) => {
        if (!S.vpn.running) { CG.toast(t('st.gtest.needconn')); return; }
        const b = ev.currentTarget; b.setAttribute('aria-busy', 'true');
        try { googleSheet(await CG.probeGoogle(true)); } catch (e) { CG.toast(t('st.gtest.fail'), true); } finally { b.removeAttribute('aria-busy'); }
      };
      $('#st-sync').onclick = async (ev) => {
        const b = ev.currentTarget; b.setAttribute('aria-busy', 'true');
        try { const r = await CG.syncVpn(); CG.toast(t(r && r.stale ? 'sv.stale' : 'sv.updated')); }
        catch (e) { CG.toast(ui.errText(e), true); } finally { b.removeAttribute('aria-busy'); }
      };
      $('#st-test').onclick = async (ev) => {
        const b = ev.currentTarget; b.setAttribute('aria-busy', 'true');
        try { await CG.testAll(9000); ui.announce(t('sv.tested')); CG.toast(t('sv.tested')); } finally { b.removeAttribute('aria-busy'); }
      };

      // ---- notifications: whatever Android says ----
      let notif = { on: false };
      const paintNotif = (r) => { notif = r || notif; setSw('st-notif', notif.on, true); };
      const notifNote = (msg) => {
        $('.js-notifnote').innerHTML = msg ? ui.notice('warn', msg, '', `<button type="button" class="btn quiet js-nset">${esc(t('st.notif.open'))}</button>`) : '';
        const b = $('.js-nset'); if (b) b.onclick = () => call('openNotifSettings', {}).catch(() => {});
        if (msg) ui.announce(msg);
      };
      const loadNotif = () => call('notifState', {}).then(paintNotif).catch(() => {});
      loadNotif();
      $('#st-notif').onclick = async () => {
        if (busy('st-notif')) return;
        if (notif.on) { notifNote(t('st.notif.off')); return; } // only Android can turn them off
        $('#st-notif').setAttribute('aria-disabled', 'true');
        try {
          const r = await call('notifEnable', {});
          paintNotif(r);
          notifNote(r && r.on ? '' : t('st.notif.denied'));
        } catch (e) { paintNotif(); notifNote(t('st.notif.denied')); }
      };

      // ---- look ----
      const pickIn = (id, fn) => $('#' + id).querySelectorAll('[data-v]').forEach((b) => {
        b.onclick = () => {
          $('#' + id).querySelectorAll('[data-v]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
          fn(b.dataset.v);
        };
      });
      pickIn('st-theme', (v) => { CG.setTheme(v); ui.announce(t('st.saved')); });

      // ---- account ----
      $('#st-acc').onclick = () => CG.go('account');
      $('#st-wallet').onclick = () => CG.go('wallet');
      $('#st-invite').onclick = () => CG.go('invite');
      $('#st-orders').onclick = () => CG.go('orders');
      $('#st-sup').onclick = () => CG.openSupport();
      $('#st-out').onclick = () => ui.fsheet(`<h3>${esc(t('st.logout.title'))}</h3><p class="t-body c-2">${esc(t('st.logout.sub'))}</p>
        <button type="button" class="btn danger js-yes">${esc(t('st.acc.logout'))}</button>
        <button type="button" class="btn quiet js-no">${esc(t('common.cancel'))}</button>`, (el, close) => {
        el.querySelector('.js-no').onclick = close;
        el.querySelector('.js-yes').onclick = async () => {
          close();
          await call('logout', {}).catch(() => {}); // stops the VPN and forgets this phone's session only
          S.me = null; CG.reset('auth', { mode: 'login' });
        };
      });

      call('session', {}).then((x) => {
        if (!x) return;
        $('.js-ver').textContent = x.version || '';
        $('.js-core').textContent = 'v2rayNG ' + (x.core || '');
      }).catch(() => {});

      const off = on('conn', (w) => { if (w.policy) paintPolicy(); if (w.auto) { setSw('st-smart', S.auto); setSw('st-google', S.googleMode); } });
      const offR = on('resume', () => { loadNotif(); call('getAutoStart', {}).then((r) => setSw('st-boot', r && r.on, true)).catch(() => {}); setTimeout(afterSys, 400); });
      paintPolicy();
      CG.refreshPolicy();
      if (p && p.ks) openGuide();
      return () => { off(); offR(); };
    },
  };
})();
