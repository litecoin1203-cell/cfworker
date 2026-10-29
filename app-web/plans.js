/* Buy and renew: only the plans the server sends (GET /plans), each with its data, duration, devices and price.
 * Paying goes through the existing flows (CG.payFor); a renewal lands on the same account, never a new one.
 * After payment the page reloads /me and shows the new status the server reports. */
(function () {
  'use strict';
  const CG = window.CG;
  const { t, esc, S, screens, api, loadMe, loadConfig } = CG;
  const I18 = CG.i18n;

  const dataText = (pl) => (pl.data_limit_gb ? t('pl.gb', { n: I18.n(pl.data_limit_gb) }) : t('pl.unlimited'));
  const daysText = (pl) => t('pl.days', { n: I18.n(pl.duration_days) });
  const devText = (pl) => (pl.device_limit ? t('pl.devices.n', { n: I18.n(pl.device_limit) }) : t('pl.unlimited'));
  const toman = (v) => t('pl.toman', { n: I18.n(v) });

  // a line under the page title that says where the account stands now, from /me
  function nowLine() {
    const sub = S.me && S.me.subscription;
    if (!sub) return '';
    const left = sub.unlimited_data ? t('us.unlimited') : I18.size(sub.remaining_bytes);
    const days = sub.unlimited_time ? t('us.no_expiry') : I18.n(sub.days_left) + ' ' + t('us.days_left');
    return t('pl.now', { status: t('us.status.' + (sub.status || 'unknown')) }) + t('common.sep') + left + ' ' + t('pl.left') + t('common.sep') + days;
  }

  screens.premium = {
    flow: true,
    html: (p) => `
      <div class="fl-scroll"><div class="fl-col plans">
        ${CG.ui.appBar(t('pl.title'), { back: !!(p && p.from) })}
        <p class="t-body c-2 lead js-lead"></p>
        <p class="t-small c-2 lead js-now"></p>
        <div class="js-plans plans-list" role="radiogroup" aria-label="${esc(t('pl.title'))}">
          <span class="skel h-block" role="status" aria-label="${esc(t('common.loading'))}"></span><span class="skel h-block"></span>
        </div>
        <div class="js-tail" hidden>
          <p class="t-small c-2 pl-after">${CG.ui.ic('info')}<span>${esc(t('pl.after'))}</span></p>
          <button type="button" class="btn primary js-cta"></button>
          <div class="list gap-top">
            ${CG.ui.linkRow('pl-orders', 'receipt', t('pl.orders'), '', '')}
            ${CG.ui.linkRow('pl-sup', 'chat', t('pl.support'), '', '')}
          </div>
        </div>
      </div></div>`,
    mount(root, p) {
      const $ = (c) => root.querySelector(c);
      const bk = $('.js-back'); if (bk) bk.onclick = () => CG.back(p.from === 'usage' ? 'usage' : 'home');
      $('#pl-orders').onclick = () => CG.go('orders');
      $('#pl-sup').onclick = () => CG.openSupport();
      let plans = S.plans || [], sel = -1;
      const trialOk = () => S.me && S.me.trial_available;

      function card(pl, i) {
        const on = i === sel, sale = pl.old_price_toman > pl.price_toman;
        const months = Math.max(1, Math.round(pl.duration_days / 30));
        const trial = pl.trial_days > 0 && trialOk();
        const a11y = t('pl.select.a11y', { name: pl.name, data: dataText(pl), days: daysText(pl), price: toman(pl.price_toman) })
          + (sale ? t('common.sep') + t('pl.off', { n: I18.n(pl.save_percent) }) : '') + (trial ? t('common.sep') + t('pl.trial', { n: I18.n(pl.trial_days) }) : '');
        return `<button type="button" class="plan${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-i="${i}" aria-label="${esc(a11y)}">
          <span class="plan-top"><b class="plan-name">${esc(pl.name)}</b>${pl.badge ? `<span class="plan-badge">${esc(pl.badge)}</span>` : ''}</span>
          <span class="plan-radio" aria-hidden="true"></span>
          <span class="plan-facts" aria-hidden="true">
            <span>${CG.ui.ic('gauge')}${esc(dataText(pl))}</span><span>${CG.ui.ic('clock')}${esc(daysText(pl))}</span><span>${CG.ui.ic('user')}${esc(devText(pl))}</span>
          </span>
          <span class="plan-price" aria-hidden="true">
            ${sale ? `<s>${esc(I18.n(pl.old_price_toman))}</s>` : ''}<b class="t-read-m">${esc(I18.n(pl.price_toman))}</b><span class="cur">${esc(t('pl.currency'))}</span>
            ${months > 1 && pl.monthly_toman ? `<span class="c-2">${esc(t('pl.monthly', { n: I18.n(pl.monthly_toman) }))}</span>` : ''}
            ${sale ? `<span class="plan-off">${esc(t('pl.off', { n: I18.n(pl.save_percent) }))}</span>` : ''}
          </span>
          ${trial ? `<span class="plan-trial" aria-hidden="true">${CG.ui.ic('gift')}${esc(t('pl.trial', { n: I18.n(pl.trial_days) }))}</span>` : ''}
        </button>`;
      }
      function draw() {
        const sub = S.me && S.me.subscription;
        $('.js-lead').textContent = t(sub ? 'pl.sub.renew' : 'pl.sub.buy');
        $('.js-now').textContent = nowLine();
        $('.js-now').hidden = !sub;
        const box = $('.js-plans');
        if (!plans.length) { box.classList.remove('plans-list'); box.innerHTML = CG.ui.notice('info', t('pl.empty')); $('.js-tail').hidden = true; return; }
        box.classList.add('plans-list');
        if (sel < 0) { sel = plans.findIndex((x) => x.badge); if (sel < 0) sel = 0; }
        box.innerHTML = plans.map(card).join('');
        box.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => { sel = +b.dataset.i; draw(); box.querySelector(`[data-i="${sel}"]`).focus(); }; });
        const pl = plans[sel];
        $('.js-cta').textContent = pl.trial_days > 0 && trialOk() ? t('pl.cta.trial', { n: I18.n(pl.trial_days) }) : t(sub ? 'pl.cta.renew' : 'pl.cta.buy');
        $('.js-tail').hidden = false;
      }
      draw();
      Promise.all([api('GET', '/plans'), loadConfig().catch(() => null), loadMe().catch(() => null)])
        .then(([pl]) => { S.plans = plans = pl || []; draw(); })
        .catch((e) => { if (!plans.length) { $('.js-plans').classList.remove('plans-list'); $('.js-plans').innerHTML = CG.ui.notice('bad', t('pl.err.load'), CG.ui.errText(e)); } });

      $('.js-cta').onclick = async (ev) => {
        const pl = plans[sel];
        if (!pl) return;
        if (!S.me) { CG.go('auth', { mode: 'register' }); return; }
        if (pl.trial_days > 0 && trialOk()) {
          const btn = ev.currentTarget;
          CG.busyButton(btn, true);
          try {
            S.me = await api('POST', '/trial', { plan_id: pl.id });
            try { await CG.syncVpn(); } catch (e) { /* servers load again on home */ }
            CG.go('success', { title: t('pl.done.title'), text: esc(t('pl.trial.done')) });
          } catch (e) { CG.toast(CG.ui.errText(e), true); } finally { if (document.body.contains(btn)) CG.busyButton(btn, false); }
          return;
        }
        CG.payFor({ plan: pl });
      };
    },
  };

  // what the success page says after a plan is paid for: the status the server reports now
  CG.planDoneText = function () {
    const sub = S.me && S.me.subscription;
    if (!sub) return '';
    return t('pl.done.sub', {
      status: t('us.status.' + (sub.status || 'unknown')),
      left: sub.unlimited_data ? t('us.unlimited') : I18.size(sub.remaining_bytes),
      days: sub.unlimited_time ? t('us.no_expiry') : I18.n(sub.days_left) + ' ' + t('us.days_left'),
    });
  };
})();
