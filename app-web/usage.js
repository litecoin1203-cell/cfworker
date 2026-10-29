/* Usage and expiry: the ingot (used_percent), used / remaining / total, the expiry date and time left, the
 * 80/95/100% warning, and when the plan has stopped, why and how to renew. Every number on this page is a field of
 * GET /me; nothing is added up here. */
(function () {
  'use strict';
  const CG = window.CG;
  const { t, esc, S, on, screens, loadMe } = CG;
  const I18 = CG.i18n;

  const STOP_KIND = { limited: 'bad', expired: 'bad', disabled: 'bad', missing: 'bad', on_hold: 'warn' };

  // the big number and the ingot: the server's used_percent, or the word "Unlimited" (no bar to fill)
  function meter(sub) {
    const pct = sub.used_percent;
    const w = CG.planWarning(sub);
    const kind = !sub.active ? 'bad' : w ? w.kind : '';
    if (sub.unlimited_data || pct == null) {
      return `<div class="big"><b class="t-read-l">${esc(t('us.unlimited'))}</b><span>${esc(I18.size(sub.used_bytes) + ' ' + t('us.used').toLowerCase())}</span></div>`;
    }
    const label = t('us.ring.a11y', { used: I18.size(sub.used_bytes), total: I18.size(sub.data_limit_bytes), left: I18.size(sub.remaining_bytes) });
    const v = Math.min(100, Math.max(0, pct));
    return `<div class="big ${kind}"><b class="t-read-l">${esc(I18.n(v))}<span class="unit">%</span></b><span>${esc(t('us.of', { total: I18.size(sub.data_limit_bytes) }))}</span></div>
      <div class="ingot ${kind}" role="img" aria-label="${esc(label)}"><i style="width:${v}%"></i>
        <span class="tick t80" style="left:80%" aria-hidden="true"><em>80%</em></span><span class="tick t95" style="left:95%" aria-hidden="true"><em>95%</em></span></div>`;
  }

  function dataRows(sub) {
    const row = (label, value) => `<div class="kv"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
    return row(t('us.used'), I18.size(sub.used_bytes))
      + row(t('us.remaining'), sub.unlimited_data ? t('us.unlimited') : I18.size(sub.remaining_bytes))
      + row(t('us.total'), sub.unlimited_data ? t('us.unlimited') : I18.size(sub.data_limit_bytes));
  }

  // days left from days_left; on the last day, whole hours from seconds_left (a unit change, not a calculation)
  function timeBlock(sub) {
    if (sub.unlimited_time) return `<div class="big"><b class="t-read-l">∞</b><span>${esc(t('us.no_expiry'))}</span></div>`;
    const lastDay = sub.active && sub.seconds_left != null && sub.seconds_left < 86400;
    const n = lastDay ? Math.floor(sub.seconds_left / 3600) : sub.days_left;
    const unit = lastDay ? t('us.hours_left') : t('us.days_left');
    return `<div class="big" role="text" aria-label="${esc(I18.n(n) + ' ' + unit)}"><b class="t-read-l">${esc(I18.n(n))}</b><span>${esc(unit)}</span></div>
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
      <section class="us-panel" aria-labelledby="us-plan">
        <div class="us-head">
          <h2 class="t-h2" id="us-plan">${esc(sub.plan_name || t('app.name'))}</h2>
          <span class="status ${statusKind}">${CG.ui.ic(sub.active ? 'check' : 'stop')}<span>${esc(t('us.status.' + (sub.status || 'unknown')))}</span></span>
        </div>
        ${meter(sub)}
        ${dataRows(sub)}
      </section>
      <section class="us-panel" aria-labelledby="us-time">
        <h2 class="section" id="us-time">${esc(t('us.time'))}</h2>
        ${timeBlock(sub)}
        <div class="kv"><span>${esc(t('us.devices'))}</span><b>${esc(sub.device_limit ? I18.n(sub.device_limit) : t('us.unlimited'))}</b></div>
      </section>
      ${sub.live === false ? `<p class="t-small c-2 us-stale">${CG.ui.ic('info')}<span>${esc(t('us.stale'))}</span></p>` : ''}
      <button type="button" class="btn primary js-renew2">${esc(t('us.renew'))}</button>
      <div class="list us-actions">${CG.ui.linkRow('us-acc', 'user', t('us.account'), '', '')}</div>`;
  }

  screens.usage = {
    flow: true,
    html: () => `
      <div class="fl-scroll"><div class="fl-col uspage">
        ${CG.ui.appBar(t('us.title'), { trailing: `<button type="button" class="iconbtn js-refresh" aria-label="${esc(t('us.refresh'))}">${CG.ui.ic('refresh')}</button>` })}
        <div class="js-body">${S.me ? body() : '<span class="skel h-panel" role="status" aria-label="' + esc(t('common.loading')) + '"></span>'}</div>
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
