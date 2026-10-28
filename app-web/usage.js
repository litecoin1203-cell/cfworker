/* Usage and expiry: used / remaining / total, the expiry date and time left, the 80/95/100% warning, and when the
 * plan has stopped, why and how to renew. Every number on this page is a field of GET /me; nothing is added up here. */
(function () {
  'use strict';
  const CG = window.CG;
  const { t, esc, S, on, screens, loadMe } = CG;
  const I18 = CG.i18n;

  const STOP_KIND = { limited: 'bad', expired: 'bad', disabled: 'bad', missing: 'bad', on_hold: 'warn' };
  const R = 52, C = 2 * Math.PI * R; // ring geometry (viewBox 120)

  // the ring and its middle text: the server's used_percent, or the word "unlimited"
  function ring(sub) {
    const pct = sub.used_percent;
    const w = CG.planWarning(sub);
    const kind = !sub.active ? 'bad' : w ? w.kind : 'ok';
    const label = sub.unlimited_data
      ? t('us.unlimited')
      : t('us.ring.a11y', { used: I18.size(sub.used_bytes), total: I18.size(sub.data_limit_bytes), left: I18.size(sub.remaining_bytes) });
    const dash = pct == null ? 0 : (C * Math.min(100, Math.max(0, pct))) / 100;
    return `<div class="ring ${kind}" role="img" aria-label="${esc(label)}">
      <svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-track" cx="60" cy="60" r="${R}"/>
        ${dash > 0 ? `<circle class="ring-val" cx="60" cy="60" r="${R}" stroke-dasharray="${dash.toFixed(2)} ${C.toFixed(2)}"/>` : ''}</svg>
      <div class="ring-mid" aria-hidden="true">${pct == null
        ? `<b>∞</b><span>${esc(t('us.unlimited'))}</span>`
        : `<b>${esc(I18.n(pct))}٪</b><span>${esc(t('us.used'))}</span>`}</div>
    </div>`;
  }

  function dataRows(sub) {
    const row = (label, value) => `<div class="kv"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
    return row(t('us.used'), I18.size(sub.used_bytes))
      + row(t('us.remaining'), sub.unlimited_data ? t('us.unlimited') : I18.size(sub.remaining_bytes))
      + row(t('us.total'), sub.unlimited_data ? t('us.unlimited') : I18.size(sub.data_limit_bytes));
  }

  // days left from days_left; on the last day, whole hours from seconds_left (a unit change, not a calculation)
  function timeBlock(sub) {
    if (sub.unlimited_time) return `<div class="big"><b>∞</b><span>${esc(t('us.no_expiry'))}</span></div>`;
    const lastDay = sub.active && sub.seconds_left != null && sub.seconds_left < 86400;
    const n = lastDay ? Math.floor(sub.seconds_left / 3600) : sub.days_left;
    const unit = lastDay ? t('us.hours_left') : t('us.days_left');
    return `<div class="big" role="text" aria-label="${esc(I18.n(n) + ' ' + unit)}"><b>${esc(I18.n(n))}</b><span>${esc(unit)}</span></div>
      ${sub.expires_at ? `<div class="kv"><span>${esc(t('us.expiry'))}</span><b>${esc(I18.date(sub.expires_at))}</b></div>` : ''}`;
  }

  function body() {
    const sub = S.me && S.me.subscription;
    const ui = CG.ui;
    if (!sub) {
      return ui.notice('info', t('stop.none'), t('stop.none.sub'))
        + `<button type="button" class="btn primary js-renew">${esc(t('conn.btn.buy'))}</button>`;
    }
    const reason = sub.active ? (sub.status === 'on_hold' ? 'on_hold' : null) : (STOP_KIND[sub.status] ? sub.status : 'expired');
    const support = reason && ['disabled', 'missing'].includes(reason) && S.config && S.config.support_url;
    let top = '';
    if (reason) {
      const act = support
        ? `<button type="button" class="btn quiet js-sup">${esc(t('stop.support'))}</button>`
        : reason === 'on_hold' ? '' : `<button type="button" class="btn quiet js-renew">${esc(t('conn.btn.renew'))}</button>`;
      top = ui.notice(STOP_KIND[reason], t('stop.' + reason), t('stop.' + reason + '.sub'), act);
    } else {
      const w = CG.planWarning(sub);
      if (w) top = ui.notice(w.kind, w.title, w.sub, `<button type="button" class="btn quiet js-renew">${esc(t('conn.btn.renew'))}</button>`);
    }
    const statusKind = sub.active ? (sub.status === 'on_hold' ? 'warn' : 'ok') : 'bad';
    return `${top}
      <section class="card us-card" aria-labelledby="us-plan">
        <div class="us-head">
          <h2 class="t-h2" id="us-plan">${esc(sub.plan_name || t('app.name'))}</h2>
          <span class="status ${statusKind}">${CG.ui.ic(sub.active ? 'check' : 'stop')}<span>${esc(t('us.status.' + (sub.status || 'unknown')))}</span></span>
        </div>
        <div class="us-data">${ring(sub)}<div class="kvs">${dataRows(sub)}</div></div>
      </section>
      <section class="card us-card">
        <h2 class="section" style="margin-top:0">${esc(t('us.time'))}</h2>
        ${timeBlock(sub)}
        <div class="kv"><span>${esc(t('us.devices'))}</span><b>${esc(sub.device_limit ? I18.n(sub.device_limit) : t('us.unlimited'))}</b></div>
      </section>
      ${sub.live === false ? `<p class="t-small c-2 us-stale">${CG.ui.ic('info')}<span>${esc(t('us.stale'))}</span></p>` : ''}
      <button type="button" class="btn primary js-renew2">${esc(t('us.renew'))}</button>
      <div class="list" style="margin-top:var(--s-4)">${CG.ui.linkRow('us-acc', 'user', t('us.account'), '', '')}</div>`;
  }

  screens.usage = {
    flow: true,
    html: () => `
      <div class="fl-scroll"><div class="fl-col uspage">
        ${CG.ui.appBar(t('us.title'), { trailing: `<button type="button" class="iconbtn js-refresh" aria-label="${esc(t('us.refresh'))}">${CG.ui.ic('refresh')}</button>` })}
        <div class="js-body">${S.me ? body() : '<div class="skel" style="height:14rem"></div>'}</div>
      </div></div>
      ${CG.ui.tabs('usage')}`,
    mount(root) {
      CG.ui.bindTabs(root);
      const box = root.querySelector('.js-body');
      const paint = () => {
        const html = body();
        if (box.dataset.h === html) return;
        box.dataset.h = html; box.innerHTML = html;
        box.querySelectorAll('.js-renew, .js-renew2').forEach((b) => { b.onclick = () => CG.go('premium', { from: 'usage' }); });
        const sp = box.querySelector('.js-sup'); if (sp) sp.onclick = () => CG.openSupport();
        const acc = box.querySelector('#us-acc'); if (acc) acc.onclick = () => CG.go('account');
      };
      const refresh = root.querySelector('.js-refresh');
      const load = (say) => {
        refresh.setAttribute('aria-busy', 'true');
        return loadMe().then(() => { paint(); if (say) CG.ui.announce(t('us.updated')); })
          .catch((e) => { if (say) CG.toast(CG.ui.errText(e), true); })
          .finally(() => refresh.removeAttribute('aria-busy'));
      };
      refresh.onclick = () => load(true);
      if (S.me) paint();
      // fresh numbers from the server every time the page opens
      load(false);
      CG.loadConfig().then(paint).catch(() => null);
      const off = on('conn', (w) => { if (w.me) paint(); });
      return off;
    },
  };
})();
