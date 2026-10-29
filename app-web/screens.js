/* Splash, onboarding, sign in / sign up, plans, payments, wallet, invite and account screens. */
(function () {
  'use strict';
  const CG = window.CG;
  const { esc, toman, call, api, on, S, go, reset, back, toast, busyButton, sheet, screens, I, loadMe, loadConfig, syncVpn, hasActivePlan, faNum, num, faDate, halo, mark } = CG;

  let store = {};
  const remember = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { store[k] = v; } };
  const recall = (k) => { try { return localStorage.getItem(k); } catch (e) { return store[k] || null; } };

  // After any sign-in: fetch the account, import the VPN subscription when there is one, then land on home.
  async function enterApp(opts) {
    await Promise.all([loadMe(), loadConfig().catch(() => null), api('GET', '/plans').then((p) => { S.plans = p; }).catch(() => {})]);
    if (hasActivePlan()) {
      try { await syncVpn(); } catch (e) { toast(e.message, true); }
      reset('home');
    } else if (opts && opts.fresh) {
      reset('home'); go('premium', { from: 'home' });
    } else reset('home');
  }
  CG.enterApp = enterApp;

  const backBtn = (cls) => `<button type="button" aria-label="Back" class="${cls || 'js-back'}" style="position:absolute;left:14px;top:56px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;z-index:5">${I.back}</button>`;
  const closeBtn = (cls) => `<button type="button" aria-label="Close" class="${cls || 'js-close'}" style="position:absolute;left:20px;top:56px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;z-index:5">${I.close}</button>`;
  function wireBack(root, fallback) {
    root.querySelectorAll('.js-back,.js-close').forEach((b) => { b.onclick = () => back(fallback || 'home'); });
  }

  const openSupport = () => (S.config && S.config.support_url ? call('openUrl', { url: S.config.support_url }) : toast('Support link is not set up yet.'));
  CG.openSupport = openSupport;

  // ---------------- SPLASH ----------------
  screens.splash = {
    fit: 'both',
    html: () => `
      <div aria-hidden="true" style="position:absolute;left:-60px;right:-60px;top:calc(var(--sh) * .5 - 300px);height:520px;border-radius:50%;background:radial-gradient(closest-side,rgba(150,108,38,.30),rgba(80,58,20,.10) 60%,transparent)"></div>
      <div style="position:absolute;left:0;right:0;top:calc(var(--sh) * .5 - 150px);display:flex;flex-direction:column;align-items:center">
        <div aria-hidden="true" class="sp-core" style="width:150px;height:150px;position:relative"><div class="pb on" style="position:absolute;left:0;top:0;display:block;transform:scale(${150 / 196});transform-origin:0 0;cursor:default">${halo({ icon: 'power' })}</div></div>
        <div class="serif sp-word" style="margin-top:26px;font-size:46px;font-weight:600;line-height:52px;color:var(--ivory)">Cloud Gold</div>
        <div class="sp-word2" style="margin-top:6px;font-size:13px;color:var(--ash)">Open internet, gold-grade security</div>
      </div>
      <div class="sp-msg" style="position:absolute;left:0;right:0;bottom:60px;text-align:center;color:var(--ash);font-size:13px"></div>`,
    mount(root) {
      let alive = true;
      const t0 = Date.now();
      const settle = async (fn) => { const wait = 1300 - (Date.now() - t0); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); if (alive) fn(); };
      (async () => {
        let session = null;
        try { session = await call('session', {}); } catch (e) {}
        if (!session || !session.loggedIn) {
          return settle(() => (recall('cg_onboarded') ? reset('auth', { mode: 'login' }) : reset('onboarding', { step: 0 })));
        }
        try {
          await enterApp();
        } catch (e) {
          if (e.status === 401) return settle(() => reset('auth', { mode: 'login' }));
          root.querySelector('.sp-msg').innerHTML = `${esc(e.message)}<div style="height:12px"></div><button class="pill-btn dark" style="width:180px;margin:0 auto;height:42px">Try again</button>`;
          root.querySelector('.sp-msg button').onclick = () => reset('splash');
        }
      })();
      return () => { alive = false; };
    },
  };

  // ---------------- ONBOARDING ----------------
  const OB = [
    { img: 'img/tiles.webp', top: 140, h: 380, title: 'Open access to every site', text: 'Open any app or site you like, from anywhere, with no limits and no slowdown.' },
    { img: 'img/servers.webp', top: 130, h: 410, title: 'Fast servers in many countries', text: 'The fastest server is picked for you; one tap changes the location.' },
    { img: 'img/coins.webp', top: 110, h: 450, title: 'Invite friends and earn rewards', text: 'Send your invite code; every purchase your friends make adds a reward to your wallet.' },
  ];
  screens.onboarding = {
    fit: 'both',
    html: (p) => {
      const i = p.step || 0, o = OB[i];
      return `
      <div aria-hidden="true" style="position:absolute;left:15px;top:calc(120px + (var(--sh) - 844px) * .45);width:360px;height:380px;border-radius:50%;background:radial-gradient(closest-side,rgba(160,118,44,.30),rgba(90,64,22,.10) 55%,rgba(11,10,8,0) 100%)"></div>
      <div aria-hidden="true" class="ob-art float" style="top:calc(${o.top}px + (var(--sh) - 844px) * .45);height:${o.h}px"><img src="${o.img}" alt="" style="width:390px;height:${o.h}px"></div>
      <div style="position:absolute;top:57px;left:0;width:390px;height:30px">
        <button type="button" aria-label="Skip" class="ob-skip" style="position:absolute;right:14px;top:0;width:30px;height:30px;display:flex;align-items:center;justify-content:center">${I.close}</button>
        <div role="progressbar" aria-label="Step ${i + 1} of 3" aria-valuemin="1" aria-valuemax="3" aria-valuenow="${i + 1}" class="ob-progress" style="position:absolute;left:82px;top:13.5px">
          ${[0, 1, 2].map((j) => `<div class="${j < i ? 'done' : j === i ? 'now' : ''}">${j === i ? '<i></i>' : ''}</div>`).join('')}
        </div>
        <button type="button" class="ob-next" style="position:absolute;left:18px;top:0;height:30px;font-size:15px;font-weight:600;color:var(--gilt)">${i < 2 ? 'Next' : 'Start'}</button>
      </div>
      <div class="ob-copy enter" style="bottom:173px"><h1 class="title-grad">${o.title}</h1><p>${o.text}</p></div>
      <div class="ob-actions">
        <button type="button" class="pill-btn white ob-up">Create account</button>
        <button type="button" class="pill-btn dark ob-in" style="height:49px">Sign in</button>
      </div>`;
    },
    mount(root, p) {
      const i = p.step || 0;
      remember('cg_onboarded', '1');
      const next = () => (i < 2 ? CG.reset('onboarding', { step: i + 1 }) : reset('auth', { mode: 'register' }));
      const t = setTimeout(next, 5000);
      root.querySelector('.ob-next').onclick = next;
      root.querySelector('.ob-skip').onclick = () => reset('auth', { mode: 'register' });
      root.querySelector('.ob-in').onclick = () => reset('auth', { mode: 'login' });
      root.querySelector('.ob-up').onclick = () => reset('auth', { mode: 'register' });
      let x0 = null;
      root.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
      root.addEventListener('pointerup', (e) => {
        if (x0 == null) return;
        const dx = e.clientX - x0; x0 = null;
        if (dx > 50) next(); else if (dx < -50 && i > 0) CG.reset('onboarding', { step: i - 1 });
      });
      return () => clearTimeout(t);
    },
  };

  // ---------------- AUTH (email + password, no verification code) ----------------
  const AUTH = {
    login: ['Welcome back', 'Sign in with your Cloud Gold account.'],
    register: ['Create account', 'One account connects all your phones. After signing up you can start the free trial.'],
    forgot: ['Forgot password', ''],
  };
  screens.auth = {
    fit: 'width',
    html: (p) => {
      const m = p.mode || 'login', [title, sub] = AUTH[m];
      let form = '';
      if (m === 'forgot') {
        form = `<p class="sub">To keep your account safe, support changes the password. Message us and we will help quickly.</p>
          <button type="button" class="pill-btn white js-support">Message support</button>
          <div class="swap"><button type="button" class="js-swap">Back to sign in</button></div>`;
      } else {
        form = `<p class="sub">${sub}</p>
          <label class="field"><span>Email</span><input class="input" dir="ltr" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" placeholder="you@example.com" value="${esc(p.email || '')}"></label>
          <label class="field"><span>Password</span><input class="input" dir="ltr" name="password" type="password" autocomplete="${m === 'login' ? 'current-password' : 'new-password'}" placeholder="${m === 'login' ? 'Account password' : 'At least 8 characters'}"></label>
          ${m === 'register' ? `<label class="field"><span>Invite code (optional)</span><input class="input" dir="ltr" name="ref" autocapitalize="characters" autocomplete="off" placeholder="GOLD7XQ" value="${esc(recall('cg_ref') || '')}"></label>` : ''}
          <div class="err" role="alert"></div>
          <button class="pill-btn white js-go" type="submit">${m === 'login' ? 'Sign in' : 'Create account'}</button>
          ${m === 'login' ? '<div style="text-align:center;margin-top:10px"><button type="button" class="link-btn js-forgot">Forgot your password?</button></div>' : ''}
          <div class="swap">${m === 'login' ? 'No account? <button type="button" class="js-swap">Sign up</button>' : 'Already have an account? <button type="button" class="js-swap">Sign in</button>'}</div>`;
      }
      return `<div class="scroll"><div class="auth-glow"></div>
        <form class="auth-wrap enter" novalidate>
          <div style="display:flex;align-items:center;gap:10px">${mark(34)}<span class="serif" style="font-size:24px;font-weight:600;color:var(--gilt);line-height:30px">Cloud Gold</span></div>
          <h1 class="title-grad">${title}</h1>${form}
        </form></div>`;
    },
    mount(root, p) {
      const m = p.mode || 'login';
      const form = root.querySelector('form'), err = root.querySelector('.err'), go_ = root.querySelector('.js-go');
      const val = (n) => { const el = form.querySelector(`[name="${n}"]`); return el ? el.value.trim() : ''; };
      const fail = (e) => {
        if (err) err.textContent = e.message || 'Something went wrong.';
        if (e.detail && e.detail.field) { const el = form.querySelector(`[name="${e.detail.field}"]`); if (el) el.focus(); }
      };
      const dev = () => call('device', {}).catch(() => ({}));
      const swap = root.querySelector('.js-swap');
      if (swap) swap.onclick = () => reset('auth', { mode: m === 'login' ? 'register' : 'login', email: val('email') || p.email });
      const forgot = root.querySelector('.js-forgot');
      if (forgot) forgot.onclick = () => go('auth', { mode: 'forgot' });
      const support = root.querySelector('.js-support');
      if (support) support.onclick = openSupport;
      if (!form.onsubmit && m !== 'forgot') {
        const submit = async () => {
          err.textContent = '';
          busyButton(go_, true);
          try {
            const d = await dev();
            if (!val('email') || !val('password')) throw { message: m === 'login' ? 'Enter your email and password.' : 'Enter your email and choose a password.' };
            if (m === 'register') {
              if (val('password').length < 8) throw { message: 'The password must be at least 8 characters.', detail: { field: 'password' } };
              const t = await api('POST', '/auth/register', { email: val('email'), password: val('password'), referral_code: val('ref') || null, device_id: d.id, device_model: d.model });
              await call('setSession', Object.assign({ email: val('email') }, t));
              remember('cg_ref', null);
              await enterApp({ fresh: true });
            } else {
              const t = await api('POST', '/auth/login', { email: val('email'), password: val('password'), device_id: d.id, device_model: d.model });
              await call('setSession', Object.assign({ email: val('email') }, t));
              await enterApp();
            }
          } catch (e) { fail(e); } finally { if (document.body.contains(go_)) busyButton(go_, false); }
        };
        form.onsubmit = (e) => { e.preventDefault(); submit(); };
      }
    },
  };

  const planFacts = (pl) => [
    `${faNum(pl.duration_days)} days`,
    pl.data_limit_gb ? `${faNum(pl.data_limit_gb)} GB` : 'Unlimited data',
    pl.device_limit ? `${faNum(pl.device_limit)} devices` : 'Unlimited devices',
  ].join(' · ');
  CG.planFacts = planFacts;

  // ---------------- PREMIUM ----------------
  // the plan list is in plans.js

  // ---------------- PAYMENT ----------------
  // what: {plan} or {topup: amount}
  function payFor(what) {
    const cfg = S.config || {};
    const bal = S.me ? S.me.wallet_balance : 0;
    const plan = what.plan;
    let coupon = null; // {code, final_toman, percent}
    const price = () => (plan ? (coupon ? coupon.final_toman : plan.price_toman) : what.topup);
    const online = [];
    if (cfg.card_enabled) online.push({ id: 'card', icon: I.card, name: 'Card to card', note: 'Transfer, then send a photo of the receipt' });
    const coins = cfg.coins || [];
    if (coins.length) online.push({ id: 'coin', icon: I.crypto, name: 'Cryptocurrency', note: coins.slice(0, 3).map((c) => c.fa).join(', ') + (coins.length > 3 ? ' and more' : '') });
    if (cfg.crypto_enabled) online.push({ id: 'crypto', icon: I.crypto, name: 'Crypto gateway', note: 'Activates automatically after payment' });
    if (!plan && !online.length) { toast('No payment method is available right now. Contact support.', true); return; }
    function methods() {
      const amount = price(), out = [];
      if (plan) {
        if (bal >= amount) out.push({ id: 'wallet', icon: I.wallet, name: 'Wallet', note: `Balance ${toman(bal)} Toman` });
        else if (bal > 0 && online.length) out.push({ id: 'mix', icon: I.wallet, name: 'Wallet + pay the rest', note: `${toman(bal)} from wallet, ${toman(amount - bal)} Toman to pay` });
        else out.push({ id: 'wallet', icon: I.wallet, name: 'Wallet', note: `Balance ${toman(bal)} Toman, not enough`, off: true });
      }
      return out.concat(online);
    }
    let pick = null, mixVia = online[0] && online[0].id, coinPick = coins[0] && coins[0].id;
    const body = (el) => {
      const ms = methods(), amount = price();
      if (!ms.find((m) => m.id === pick && !m.off)) pick = (ms.find((m) => !m.off) || {}).id;
      const showVia = pick === 'mix' && online.length > 1;
      el.querySelector('.pm-price').innerHTML = plan
        ? `${coupon ? `<s style="color:var(--dim)">${toman(plan.price_toman)}</s> ` : ''}<b style="color:var(--gilt)">${toman(amount)} Toman</b> · ${planFacts(plan)}`
        : `<b style="color:var(--gilt)">${toman(amount)} Toman</b>`;
      el.querySelector('.pm-list').innerHTML = ms.map((m) => `<button type="button" class="method${m.id === pick ? ' on' : ''}" data-m="${m.id}" ${m.off ? 'disabled style="opacity:.45"' : ''}><span class="mi">${m.icon}</span><span style="min-width:0"><b>${m.name}</b><span>${m.note}</span></span></button>`).join('')
        + (showVia ? `<div style="display:flex;gap:8px;margin:-2px 0 10px">${online.map((o) => `<button type="button" class="method${o.id === mixVia ? ' on' : ''}" data-via="${o.id}" style="margin:0;padding:10px;justify-content:center;font-size:13px">${o.name.split(' ')[0]}</button>`).join('')}</div>` : '')
        + (pick === 'coin' || (pick === 'mix' && mixVia === 'coin') ? `<div class="coin-grid">${coins.map((c) => `<button type="button" class="coin-chip${c.id === coinPick ? ' on' : ''}" data-coin="${c.id}">${coinBadge(c, 30)}<b>${c.symbol}${c.auto ? ' <em class="auto-dot" title="Automatic confirmation">⚡</em>' : ''}</b><span>${esc(c.fa)}</span></button>`).join('')}</div><p class="muted" style="font-size:11.5px;margin:-4px 0 12px;text-align:center;line-height:18px">All have very low transfer fees${coins.some((c) => c.auto) ? ', ⚡ means it activates automatically about a minute after you pay' : ''}</p>` : '');
      const due = pick === 'mix' ? amount - bal : pick === 'wallet' || amount === 0 ? 0 : amount;
      el.querySelector('.pm-go').textContent = !pick ? 'Choose a payment method' : due === 0 ? (amount === 0 ? 'Activate for free' : `Pay ${toman(amount)} Toman from wallet`) : `Pay ${toman(due)} Toman`;
      el.querySelector('.pm-go').disabled = !pick;
      el.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => { pick = b.dataset.m; body(el); }; });
      el.querySelectorAll('[data-via]').forEach((b) => { b.onclick = () => { mixVia = b.dataset.via; body(el); }; });
      el.querySelectorAll('[data-coin]').forEach((b) => { b.onclick = () => { coinPick = b.dataset.coin; body(el); }; });
    };
    sheet(`<h3>${plan ? 'Buy plan ' + esc(plan.name) : 'Top up wallet'}</h3>
      <p class="pm-price"></p>
      ${plan ? `<div class="coupon-row"><input class="input pm-code" dir="ltr" autocapitalize="characters" autocomplete="off" placeholder="Discount code (optional)"><button type="button" class="pm-apply">Apply</button></div><div class="err pm-cerr" style="margin-top:-6px"></div>` : ''}
      <div class="pm-list"></div>
      <div style="height:6px"></div><button type="button" class="pill-btn white pm-go">Pay</button>`, (el, close) => {
      body(el);
      const apply = el.querySelector('.pm-apply');
      if (apply) apply.onclick = async () => {
        const code = el.querySelector('.pm-code').value.trim();
        const cerr = el.querySelector('.pm-cerr');
        cerr.textContent = '';
        if (!code) { coupon = null; body(el); return; }
        busyButton(apply, true, true);
        try { coupon = await api('POST', '/coupons/check', { code, plan_id: plan.id }); cerr.style.color = '#8FCFA4'; cerr.textContent = `${faNum(coupon.percent)}% discount applied.`; }
        catch (e) { coupon = null; cerr.style.color = ''; cerr.textContent = e.message; }
        finally { busyButton(apply, false); body(el); }
      };
      el.querySelector('.pm-go').onclick = async (ev) => {
        if (!pick) return;
        const btn = ev.currentTarget;
        busyButton(btn, true);
        try {
          const method = pick === 'mix' ? mixVia : pick;
          const req = plan
            ? { method, plan_id: plan.id, coupon_code: coupon ? coupon.code : null, use_wallet: pick === 'mix' || pick === 'wallet' }
            : { method, topup_toman: what.topup };
          if (method === 'coin') req.coin = coinPick;
          const order = await api('POST', '/orders', req);
          close();
          if (order.status === 'paid') return afterPaid(order);
          if (order.method === 'card') return go('card', { order });
          if (order.method === 'coin') return go('coin', { order });
          if (order.method === 'crypto') { call('openUrl', { url: order.crypto_pay_url }); return go('order', { id: order.id }); }
        } catch (e) { busyButton(btn, false); body(el); toast(e.message, true); }
      };
    });
  }
  CG.payFor = payFor;

  async function afterPaid(order) {
    try { await loadMe(); } catch (e) {}
    const planName = order.kind === 'plan' ? order.plan_name : order.activate_plan_name;
    if (order.kind === 'plan' || order.plan_activated) {
      try { await syncVpn(); } catch (e) { /* home retries */ }
      // the new status as the server now reports it (plans.js); same account, no new UUID
      go('success', { title: 'Your plan is active', text: `${esc(planName || 'Plan')} is active. ${esc(CG.planDoneText ? CG.planDoneText() : '')}` });
    } else if (order.activate_plan_id) {
      go('success', { title: 'Wallet topped up', text: `${toman(order.amount_toman)} Toman was added to your wallet, but the plan was not activated automatically. Buy the plan with your wallet from the plans page, or contact support.`, to: 'wallet' });
    } else {
      go('success', { title: 'Wallet topped up', text: `${toman(order.amount_toman)} Toman was added to your wallet.`, to: 'wallet' });
    }
  }

  screens.success = {
    fit: 'both',
    html: (p) => `
      <div aria-hidden="true" style="position:absolute;left:-40px;right:-40px;top:calc(var(--sh) * .12);height:420px;border-radius:50%;background:radial-gradient(closest-side,rgba(170,124,44,.32),rgba(90,64,22,.1) 60%,transparent)"></div>
      <div class="enter" style="position:absolute;left:0;right:0;top:calc(var(--sh) * .25);display:flex;flex-direction:column;align-items:center;text-align:center;padding:0 30px">
        <div aria-hidden="true" style="width:150px;height:150px;position:relative"><div class="pb on" style="position:absolute;left:0;top:0;display:block;transform:scale(${150 / 196});transform-origin:0 0;cursor:default">${halo({ icon: 'check' })}</div></div>
        <h1 class="title-grad" style="margin:30px 0 10px;font-size:34px;line-height:42px">${esc(p.title)}</h1>
        <p style="margin:0;color:var(--body);font-size:15px;line-height:24px;max-width:300px">${p.text}</p>
      </div>
      <button type="button" class="pill-btn white js-done" style="position:absolute;left:20px;width:350px;top:calc(var(--sh) - 110px)">${p.to === 'wallet' ? 'Back to wallet' : 'Go to home'}</button>`,
    mount(root, p) { root.querySelector('.js-done').onclick = () => (p.to === 'wallet' ? (reset('home'), go('wallet')) : reset('home')); },
  };

  // card to card — a gateway-style page: the bank card in its own colours, the exact unique amount, auto-confirm
  const fmtCard = (n) => String(n || '').replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');
  const CHIP = '<svg aria-hidden="true" width="42" height="32" viewBox="0 0 42 32"><defs><linearGradient id="chipG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F6E3A1"/><stop offset=".5" stop-color="#D4AF5A"/><stop offset="1" stop-color="#A9822F"/></linearGradient></defs><rect x="1" y="1" width="40" height="30" rx="6" fill="url(#chipG)"/><path d="M1 11h12v10H1M41 11H29v10h12M13 1v30M29 1v30M13 16h16" fill="none" stroke="#8C6A22" stroke-width="1.1" opacity=".7"/></svg>';
  screens.card = {
    fit: 'width',
    bg: 'radial-gradient(120% 55% at 50% -10%,#241D12 0%,#110F0B 45%,#0B0A08 100%)',
    html: (p) => {
      const o = p.order, c = o.card || {};
      const amt = toman(o.amount_toman);
      const odd = o.amount_toman % 1000 !== 0;
      // highlight the last three digits (the unique part) in gold
      const amtHtml = odd ? `${esc(amt.slice(0, -3))}<em>${esc(amt.slice(-3))}</em>` : esc(amt);
      return `${backBtn()}<div class="scroll"><div class="page enter" style="padding-top:96px">
        <div class="pay-brand"><span class="pay-logo">${I.card}</span><span><b>Cloud Gold Pay</b><span>Secure card to card</span></span>
          <span class="pay-lock"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8FCFA4" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>Secure</span></div>
        <div class="pay-steps">${['Transfer', c.auto ? 'Automatic match' : 'Send receipt', 'Review', 'Activation'].map((t, i) => `<div class="pay-step${i === 0 ? ' now' : ''}"><i>${faNum(i + 1)}</i><span>${t}</span></div>`).join('<b></b>')}</div>

        <div class="bank-card" style="background:linear-gradient(135deg,${esc(c.color1 || '#3A3020')} 0%,${esc(c.color2 || '#14110C')} 100%)">
          <span class="bank-glare"></span>
          <div class="bank-top"><b>${c.bank ? 'Bank ' + esc(c.bank.replace(/^بانک\s*/, '')) : 'Destination card'}</b><span class="bank-shetab">Shetab</span></div>
          <div class="bank-chip">${CHIP}</div>
          <div class="bank-num ltr">${esc(fmtCard(c.number))}</div>
          <div class="bank-bottom"><span>${esc(c.holder || '')}</span><button type="button" class="bank-copy js-copy" aria-label="Copy card number">${I.copy}<span>Copy</span></button></div>
        </div>

        <div class="pay-card" style="margin-top:16px">
          <span class="muted" style="font-size:12.5px">Exact amount to transfer</span>
          <div class="card-amount">${amtHtml} <small>Toman</small></div>
          <div class="card-rial"><span>= <b class="ltr">${esc((c.amount_rial || o.amount_toman * 10).toLocaleString('en-US'))}</b> Rial</span>
            <button type="button" class="icon-btn glass js-copy-rial" aria-label="Copy amount in Rial">${I.copy}</button></div>
          ${odd ? `<div class="pay-warn" style="margin:14px 0 0"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F3DDA0" stroke-width="2" stroke-linecap="round"><path d="M12 3l10 18H2zM12 10v5M12 18h.01"/></svg><span><b>Send exactly this amount</b>, including the last <b>${esc(amt.slice(-3))}</b> Toman. That way your payment is matched without delay. (Most banking apps ask for the amount in <b>Rial</b>.)</span></div>` : ''}
          ${c.auto ? `<div class="pay-auto" style="margin:14px 0 0"><span class="pay-auto-pulse"></span><span><b>Automatic confirmation is on</b>After you transfer, you are usually active in under a minute. Sending the receipt is optional.</span></div>` : ''}
        </div>

        <label class="field" style="margin-top:16px"><span>Reference number (optional)</span><input class="input js-ref" dir="ltr" inputmode="numeric" placeholder="123456"></label>
        <button type="button" class="pill-btn ${c.auto ? 'ghost' : 'white'} js-up">${c.auto ? 'Send receipt photo (optional)' : 'Send receipt photo'}</button>
        <div style="height:10px"></div>
        <button type="button" class="pill-btn dark js-cancel">Cancel order</button>
        <p class="muted" style="font-size:12px;line-height:19px;margin-top:14px;text-align:center">Order #${faNum(o.id)} · ${o.activate_plan_id ? `After confirmation, the plan ${esc(o.activate_plan_name || '')} activates automatically.` : o.kind === 'plan' ? 'After the payment is confirmed, your plan activates automatically.' : 'After confirmation, the amount is added to your wallet.'}</p>
      </div></div>`;
    },
    mount(root, p) {
      wireBack(root);
      const o = p.order, c = o.card || {};
      let alive = true, timer = 0;
      root.querySelector('.js-copy').onclick = () => { call('copy', { text: String(c.number || '').replace(/\D/g, '') }); toast('Card number copied'); };
      root.querySelector('.js-copy-rial').onclick = () => { call('copy', { text: String(c.amount_rial || o.amount_toman * 10) }); toast('Amount in Rial copied'); };
      root.querySelector('.js-cancel').onclick = () => sheet(`<h3>Cancel this order?</h3><p>If you have already transferred, do not cancel; wait for confirmation or send the receipt.</p>
        <button class="pill-btn white" data-yes>Cancel order</button><div style="height:10px"></div><button class="pill-btn dark" data-no>Back</button>`, (el, close) => {
        el.querySelector('[data-no]').onclick = close;
        el.querySelector('[data-yes]').onclick = async () => { close(); try { await api('POST', `/orders/${o.id}/cancel`); toast('Order cancelled'); back('premium'); } catch (e) { toast(e.message, true); } };
      });
      root.querySelector('.js-up').onclick = async (ev) => {
        const btn = ev.currentTarget;
        busyButton(btn, true, btn.classList.contains('ghost'));
        try {
          const r = await call('uploadReceipt', { path: `/orders/${o.id}/receipt`, ref: root.querySelector('.js-ref').value.trim() });
          if (r && r.cancelled) return;
          if (r.status >= 400) throw new CG.ApiError(r.status, r.data && r.data.detail);
          alive = false;
          go('order', { id: o.id });
        } catch (e) { toast(e.message || 'Sending failed.', true); } finally { if (document.body.contains(btn)) busyButton(btn, false); }
      };
      // the bank SMS can confirm this order while the user is still here
      const poll = async () => {
        if (!alive) return;
        try {
          const x = await api('GET', `/orders/${o.id}`);
          if (x.status === 'paid') { alive = false; return afterPaid(x); }
          if (x.status === 'review') { alive = false; return go('order', { id: o.id }); }
        } catch (e) {}
        if (alive) timer = setTimeout(poll, 6000);
      };
      timer = setTimeout(poll, 6000);
      const off = on('resume', () => { clearTimeout(timer); poll(); });
      return () => { alive = false; clearTimeout(timer); off(); };
    },
  };

  // order status (crypto waiting, receipt under review, rejected...)
  screens.order = {
    fit: 'width',
    html: () => `${closeBtn()}<div class="scroll"><div class="page enter js-body" style="padding-top:120px;text-align:center"><span class="spinner light" style="display:inline-block"></span></div></div>`,
    mount(root, p) {
      root.querySelector('.js-close').onclick = () => reset('home');
      let alive = true, timer = 0, lastStatus = '';
      const body = root.querySelector('.js-body');
      const icon = (color, path) => `<div style="width:96px;height:96px;margin:0 auto;border-radius:50%;background:radial-gradient(circle at 50% 30%,#241E15,#100E0A);box-shadow:inset 0 0 0 1px rgba(214,174,92,.35),0 0 60px ${color}26;display:flex;align-items:center;justify-content:center"><svg aria-hidden="true" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg></div>`;
      function show(o) {
        if (o.status === lastStatus) return;
        lastStatus = o.status;
        if (o.status === 'paid') { alive = false; afterPaid(o); return; }
        let h = '';
        if (o.status === 'pending' && o.method === 'crypto') {
          h = `${icon('#F3DDA0', 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z')}<h1 class="title-grad" style="margin-top:28px">Waiting for payment</h1>
            <p style="color:var(--body);font-size:15px;line-height:25px">Finish the payment on the crypto page. When the network confirms it (usually a few minutes), this page updates by itself.</p>
            <div style="height:14px"></div><button class="pill-btn white js-open">Open payment page</button><div style="height:10px"></div><button class="pill-btn dark js-cancel">Cancel order</button>`;
        } else if (o.status === 'pending') {
          h = `<h1 class="title-grad">Receipt needed</h1><p style="color:var(--body)">To continue, send a photo of the transfer receipt.</p><button class="pill-btn white js-card">Continue</button>`;
        } else if (o.status === 'review') {
          h = `${icon('#E8C77A', 'M9 12l2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z')}<h1 class="title-grad" style="margin-top:28px">Receipt received</h1>
            <p style="color:var(--body);font-size:15px;line-height:25px">We are checking the transfer. After confirmation, ${o.kind === 'topup' && !o.activate_plan_id ? 'your wallet is topped up' : 'your plan activates automatically'}. You can close the app; everything will be ready when you come back.</p>
            <div style="height:14px"></div><button class="pill-btn dark js-home">Back to home</button>`;
        } else if (o.status === 'rejected') {
          h = `${icon('#E2715C', 'M15 9l-6 6M9 9l6 6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z')}<h1 class="title-grad" style="margin-top:28px">Receipt not accepted</h1>
            <p style="color:var(--body);font-size:15px;line-height:25px">${esc(o.admin_note || 'This receipt did not match a transfer.')}</p>
            <div style="height:14px"></div><button class="pill-btn white js-card">Send another receipt</button><div style="height:10px"></div><button class="pill-btn dark js-support">Message support</button>`;
        } else {
          h = `${icon('#A39783', 'M12 8v4M12 16h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z')}<h1 class="title-grad" style="margin-top:28px">${{ cancelled: 'Order cancelled', expired: 'Order time ran out' }[o.status] || 'Order closed'}</h1>
            <p style="color:var(--body)">This order is closed. Place a new order any time.</p><div style="height:14px"></div><button class="pill-btn white js-plans">See plans</button>`;
        }
        body.innerHTML = h;
        const b = (c, fn) => { const el = body.querySelector(c); if (el) el.onclick = fn; };
        b('.js-open', () => call('openUrl', { url: o.crypto_pay_url }));
        b('.js-cancel', async () => { try { await api('POST', `/orders/${o.id}/cancel`); reset('home'); } catch (e) { toast(e.message, true); } });
        b('.js-home', () => reset('home'));
        b('.js-card', async () => {
          try { go('card', { order: await api('GET', `/orders/${o.id}`) }); } catch (e) { toast(e.message, true); }
        });
        b('.js-support', openSupport);
        b('.js-plans', () => { reset('home'); go('premium', { from: 'home' }); });
      }
      const poll = async () => {
        if (!alive) return;
        try { show(await api('GET', `/orders/${p.id}`)); } catch (e) { if (!lastStatus) body.innerHTML = `<p style="color:var(--body)">${esc(e.message)}</p>`; }
        if (alive) timer = setTimeout(poll, 4000);
      };
      poll();
      const off = on('resume', () => { clearTimeout(timer); poll(); });
      return () => { alive = false; clearTimeout(timer); off(); };
    },
  };

  screens.orders = {
    fit: 'width',
    html: () => `${backBtn()}<div class="scroll"><div class="page enter"><h1 class="title-grad">My payments</h1><div class="panel js-list"><div class="skeleton" style="height:48px"></div></div></div></div>`,
    mount(root) {
      wireBack(root, 'premium');
      const label = { pending: 'Waiting for payment', review: 'Under review', paid: 'Paid', rejected: 'Rejected', cancelled: 'Cancelled', expired: 'Expired' };
      const mlabel = { card: 'Card to card', wallet: 'Wallet', crypto: 'Crypto', coin: 'Cryptocurrency' };
      const color = { paid: '#8FCFA4', review: '#E8C77A', rejected: '#E2715C', pending: '#F3DDA0' };
      api('GET', '/orders').then((rows) => {
        const el = root.querySelector('.js-list');
        if (!rows.length) { el.innerHTML = '<p class="muted" style="margin:0 0 14px;text-align:center;line-height:22px">No payments yet. After your first plan, its receipt stays here.</p><button type="button" class="pill-btn dark js-buy" style="height:44px;font-size:14px">See plans</button>'; el.querySelector('.js-buy').onclick = () => go('premium', { from: 'orders' }); return; }
        el.innerHTML = rows.map((o) => `<button type="button" class="row-line" data-id="${o.id}" style="width:100%">
          <span><b style="font-weight:500">${o.kind === 'plan' ? esc(o.plan_name || 'Plan') : o.activate_plan_id ? 'Top up and buy ' + esc(o.activate_plan_name || '') : 'Top up wallet'}</b><br><span class="muted" style="font-size:12px">#${faNum(o.id)} · ${mlabel[o.method] || o.method} · ${faDate(o.created_at)}</span></span>
          <span style="text-align:left"><span class="serif" style="font-size:18px;color:var(--ivory)">${toman(o.amount_toman)}</span> <span class="muted" style="font-size:12px">Toman</span><br><span style="font-size:12px;color:${color[o.status] || '#8F8676'}">${label[o.status] || o.status}</span></span></button>`).join('');
        el.querySelectorAll('[data-id]').forEach((b) => {
          const o = rows.find((x) => x.id === +b.dataset.id);
          b.onclick = () => (o.method === 'coin' && ['pending', 'review', 'rejected', 'expired'].includes(o.status) ? go('coin', { order: o }) : o.status === 'pending' && o.method === 'card' ? go('card', { order: o }) : ['pending', 'review', 'rejected'].includes(o.status) ? go('order', { id: o.id }) : null);
        });
      }).catch((e) => toast(e.message, true));
    },
  };

  // ---------------- WALLET ----------------
  screens.wallet = {
    fit: 'width',
    html: () => `${backBtn()}<div class="scroll"><div class="page enter">
      <h1 class="title-grad">Wallet</h1>
      <div class="panel" style="text-align:center;padding:26px 20px">
        <div class="muted" style="font-size:13px">Balance</div>
        <div class="js-bal serif" style="font-size:48px;font-weight:600;line-height:58px;margin-top:4px;color:var(--gilt)">${toman(S.me ? S.me.wallet_balance : 0)} <span style="font-size:20px;font-weight:500;color:var(--body)">Toman</span></div>
        <div class="muted" style="font-size:12.5px;margin-top:6px">Buy a plan instantly with your wallet. Invite rewards also arrive here.</div>
      </div>
      <h2 style="font-size:17px;font-weight:500;margin:26px 0 12px">Top up wallet</h2>
      <div class="js-chips" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px"></div>
      <label class="field" style="margin-top:12px"><span>Or a custom amount (Toman)</span><input class="input js-amt" inputmode="numeric" placeholder="300,000"></label>
      <button type="button" class="pill-btn white js-top">Top up</button>
      <h2 style="font-size:17px;font-weight:500;margin:28px 0 8px">Transactions</h2>
      <div class="panel js-tx" style="padding:4px 18px"><div class="skeleton" style="height:44px;margin:12px 0"></div></div>
    </div></div>`,
    mount(root) {
      wireBack(root);
      const amt = root.querySelector('.js-amt');
      const min = (S.config && S.config.min_topup_toman) || 50000;
      const presets = [100000, 200000, 500000].map((v) => Math.max(v, min));
      root.querySelector('.js-chips').innerHTML = presets.map((v) => `<button type="button" class="method" data-v="${v}" style="justify-content:center;padding:14px 6px;margin:0;font-size:15px;font-weight:600">${toman(v)}</button>`).join('');
      root.querySelectorAll('[data-v]').forEach((b) => { b.onclick = () => { amt.value = toman(b.dataset.v); root.querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('on', x === b)); }; });
      amt.oninput = () => { const d = num(amt.value); amt.value = d ? toman(d) : ''; root.querySelectorAll('[data-v]').forEach((x) => x.classList.remove('on')); };
      root.querySelector('.js-top').onclick = () => {
        const v = num(amt.value);
        if (!v) return toast('Choose or enter an amount.', true);
        if (v < min) return toast(`The minimum top-up is ${toman(min)} Toman.`, true);
        payFor({ topup: v });
      };
      const reasons = { topup: 'Top up', purchase: 'Plan purchase', referral: 'Invite reward', refund: 'Refund', admin: 'Correction by support' };
      api('GET', '/wallet').then((w) => {
        root.querySelector('.js-bal').innerHTML = `${toman(w.balance)} <span style="font-size:20px;font-weight:500;color:var(--body)">Toman</span>`;
        if (S.me) S.me.wallet_balance = w.balance;
        const el = root.querySelector('.js-tx');
        el.innerHTML = w.transactions.length ? w.transactions.map((t) => `<div class="row-line"><span>${esc(reasons[t.reason] || t.reason)}<br><span class="muted" style="font-size:12px">${faDate(t.created_at)}${t.note ? ' · ' + esc(t.note) : ''}</span></span>
          <span class="ltr" style="color:${t.amount >= 0 ? '#8FCFA4' : '#F2EADB'};font-size:15px;font-weight:600">${t.amount >= 0 ? '+' : '−'}${toman(Math.abs(t.amount))}</span></div>`).join('') : '<p class="muted" style="margin:14px 0;text-align:center">No transactions yet.</p>';
      }).catch((e) => toast(e.message, true));
    },
  };

  // ---------------- INVITE (affiliate) ----------------
  screens.invite = {
    fit: 'both',
    bg: '#0B0A08',
    html: () => `
      <div aria-hidden="true" style="position:absolute;left:-160px;top:160px;width:620px;height:520px;background:radial-gradient(closest-side,rgba(150,108,38,.42),rgba(90,64,22,.18) 50%,rgba(11,10,8,0) 100%)"></div>
      <div aria-hidden="true" style="position:absolute;left:-80px;top:170px;width:340px;height:70px;background:linear-gradient(90deg,rgba(214,174,92,0) 0%,rgba(243,221,160,.22) 45%,rgba(214,174,92,0) 100%);transform:rotate(32deg);filter:blur(12px)"></div>
      <div aria-hidden="true" class="float" style="position:absolute;left:15px;top:calc(300px + (var(--sh) - 844px) * .5);width:360px;height:286px;mix-blend-mode:screen">
        <img src="img/rings.webp" alt="" style="display:block;width:360px;height:286px;-webkit-mask-image:radial-gradient(ellipse 50% 50% at 50% 50%,#000 72%,transparent 100%);mask-image:radial-gradient(ellipse 50% 50% at 50% 50%,#000 72%,transparent 100%)">
      </div>
      ${backBtn()}${closeBtn()}
      <div style="position:absolute;left:0;top:118px;width:390px;display:flex;flex-direction:column;align-items:center;text-align:center">
        <h1 class="title-grad" style="margin:0;font-size:44px;line-height:54px">Invite friends<br>and earn rewards</h1>
        <p class="js-pct" style="margin:16px 26px 0;font-size:14.5px;line-height:23px;color:var(--body)">Earn a reward from every purchase your friends make</p>
        <p class="js-stats" style="margin:8px 0 0;font-size:13px;color:var(--gilt)"></p>
      </div>
      <div style="position:absolute;left:20px;top:calc(var(--sh) - 198px);width:350px;display:flex;flex-direction:column;gap:12px">
        <div style="height:58px;border-radius:18px;border:1px dashed rgba(214,174,92,.45);background:#13110D;display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 18px">
          <span style="font-size:13px;color:var(--ash)">Your code</span>
          <span class="js-code ltr" style="font-size:19px;font-weight:700;letter-spacing:3px;color:var(--gilt)">·······</span>
          <button type="button" class="js-copy" style="height:40px;padding:0 16px;border-radius:13px;background:rgba(214,174,92,.12);color:var(--gilt);font-size:14px;font-weight:600">Copy</button>
        </div>
        <button type="button" class="pill-btn white js-share" style="font-size:16px">Send invite</button>
      </div>`,
    mount(root) {
      wireBack(root);
      let ref = null;
      api('GET', '/referral').then((r) => {
        ref = r;
        root.querySelector('.js-code').textContent = r.code;
        if (r.percent) root.querySelector('.js-pct').textContent = `${faNum(r.percent)}% of every purchase your friends make is added to your wallet`;
        root.querySelector('.js-stats').textContent = `${faNum(r.invited)} friends joined, ${toman(r.earned_toman)} Toman earned`;
      }).catch((e) => toast(e.message, true));
      const copy = root.querySelector('.js-copy');
      copy.onclick = () => { if (!ref) return; call('copy', { text: ref.code }); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1600); };
      root.querySelector('.js-share').onclick = () => { if (ref) call('share', { text: `${ref.share_text}. Enter the code when you sign up.` }); };
    },
  };

  // ---------------- CLOUD GOLD PAY (crypto straight to our wallet) ----------------
  function coinBadge(c, size) {
    const fs = c.symbol.length > 3 ? size * 0.28 : size * 0.33;
    return `<span class="coin-badge" style="width:${size}px;height:${size}px;background:radial-gradient(circle at 35% 30%,${c.color}ee,${c.color} 55%,${c.color}aa);box-shadow:0 0 0 1px rgba(255,255,255,.12),0 4px 14px ${c.color}55"><i style="font-size:${fs}px">${esc(c.symbol)}</i></span>`;
  }
  CG.coinBadge = coinBadge;

  // QR drawn as gold dots on midnight blue, with the coin badge in the middle (high error correction)
  function qrSvg(text, px) {
    if (!window.qrcode) return '';
    const q = window.qrcode(0, 'H');
    q.addData(text);
    q.make();
    const n = q.getModuleCount(), m = 2, cell = px / (n + m * 2);
    let dots = '';
    const finder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (!q.isDark(r, c) || finder(r, c)) continue;
      const x = (c + m) * cell, y = (r + m) * cell;
      dots += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(cell * 0.86).toFixed(2)}" height="${(cell * 0.86).toFixed(2)}" rx="${(cell * 0.3).toFixed(2)}"/>`;
    }
    const eye = (r, c) => {
      const x = (c + m) * cell, y = (r + m) * cell;
      return `<rect x="${(x + cell * 0.5).toFixed(2)}" y="${(y + cell * 0.5).toFixed(2)}" width="${(cell * 6).toFixed(2)}" height="${(cell * 6).toFixed(2)}" rx="${(cell * 1.8).toFixed(2)}" fill="none" stroke="url(#qrG)" stroke-width="${cell.toFixed(2)}"/>`
        + `<rect x="${(x + cell * 2).toFixed(2)}" y="${(y + cell * 2).toFixed(2)}" width="${(cell * 3).toFixed(2)}" height="${(cell * 3).toFixed(2)}" rx="${(cell * 0.9).toFixed(2)}" fill="url(#qrG)"/>`;
    };
    return `<svg width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" role="img" aria-label="Wallet address QR"><defs><linearGradient id="qrG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE7A3"/><stop offset=".55" stop-color="#E9B949"/><stop offset="1" stop-color="#B9832A"/></linearGradient></defs>
      <rect width="${px}" height="${px}" rx="22" fill="#0E0C09"/><g fill="url(#qrG)">${dots}</g>${eye(0, 0)}${eye(0, n - 7)}${eye(n - 7, 0)}</svg>`;
  }

  const COIN_STEPS = ['Send coins', 'Report payment', 'Network confirmation', 'Activation'];
  const shortTx = (t) => (t && t.length > 18 ? t.slice(0, 8) + '…' + t.slice(-8) : t || '');
  const mmss = (sec) => { sec = Math.max(0, sec | 0); return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };

  screens.coin = {
    fit: 'width',
    bg: 'radial-gradient(120% 55% at 50% -10%,#241D12 0%,#110F0B 45%,#0B0A08 100%)',
    html: () => `${closeBtn()}<div class="scroll"><div class="page enter js-body" style="padding-top:96px"><div style="text-align:center;padding-top:60px"><span class="spinner light" style="display:inline-block"></span></div></div></div>`,
    mount(root, p) {
      root.querySelector('.js-close').onclick = () => back('premium');
      const body = root.querySelector('.js-body');
      let o = p.order || null, alive = true, poll = 0, tick = 0, lastKey = '';
      const step = (st) => (st === 'paid' ? 4 : st === 'review' ? 2 : 0);

      function head(c) {
        return `<div class="pay-brand"><span class="pay-logo">${I.gem}</span><span><b>Cloud Gold Pay</b><span>Secure cryptocurrency payment</span></span>
          <span class="pay-lock"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8FCFA4" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>Secure</span></div>`;
      }
      function steps(cur) {
        return `<div class="pay-steps">${COIN_STEPS.map((t, i) => `<div class="pay-step${i < cur ? ' done' : i === cur ? ' now' : ''}"><i>${i < cur ? I.check : faNum(i + 1)}</i><span>${t}</span></div>`).join('<b></b>')}</div>`;
      }
      function txBox(label) {
        return `<label class="field" style="margin-top:16px"><span>${label}</span><input class="input js-tx" dir="ltr" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="TXID / Hash" value="${esc(o.txid || '')}" style="font-family:monospace;font-size:13.5px"></label><div class="err js-txerr"></div>`;
      }

      function render() {
        const c = o.coin;
        if (!c) { body.innerHTML = '<p class="muted" style="text-align:center">This order is not a cryptocurrency payment.</p>'; return; }
        const key = o.status + '|' + (o.txid || '') + '|' + (o.admin_note || '');
        if (key === lastKey) return;
        lastKey = key;
        if (o.status === 'paid') { alive = false; afterPaid(o); return; }
        let h = head(c);
        if (o.status === 'pending') {
          h += steps(0) + `
            <div class="pay-card">
              <div class="pay-amount-row">${coinBadge(c, 44)}<div style="flex:1;min-width:0"><span class="muted" style="font-size:12.5px">Amount to pay</span>
                <div class="pay-amount ltr"><b>${esc(c.amount)}</b> ${esc(c.symbol)}</div><span class="muted" style="font-size:12px">≈ ${toman(o.amount_toman)} Toman</span></div>
                <button type="button" class="icon-btn glass js-copy-amt" aria-label="Copy amount">${I.copy}</button></div>
              <div class="pay-warn"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F3DDA0" stroke-width="2" stroke-linecap="round"><path d="M12 3l10 18H2zM12 10v5M12 18h.01"/></svg><span>Send <b>exactly this amount</b>, only on the <b>${esc(c.network)}</b> network${c.memo ? `, and be sure to enter the <b>${esc(c.memo_label)}</b>` : ''}.</span></div>
              <div class="pay-fee"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8FCFA4" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>Network fee: <b>${esc(c.fee || 'Low')}</b></div>
              ${c.auto ? `<div class="pay-auto"><span class="pay-auto-pulse"></span><span><b>Automatic confirmation is on</b>After you send, the network is checked automatically and you are usually active in under a minute. You do not need to do anything.</span></div>` : ''}
              <div class="pay-qr">${qrSvg(c.address, 208)}<span class="pay-qr-logo">${coinBadge(c, 40)}</span></div>
              <span class="muted" style="font-size:12.5px;display:block;margin-top:14px">Wallet address ${esc(c.fa)}</span>
              <div class="pay-addr"><span class="ltr">${esc(c.address)}</span><button type="button" class="icon-btn glass js-copy-addr" aria-label="Copy address">${I.copy}</button></div>
              ${c.memo ? `<span style="font-size:12.5px;display:block;margin-top:14px;color:#EE9A86"><b>${esc(c.memo_label)}</b>, without it the deposit cannot be credited</span>
              <div class="pay-addr pay-memo"><span class="ltr">${esc(c.memo)}</span><button type="button" class="icon-btn glass js-copy-memo" aria-label="Copy ${esc(c.memo_label)}">${I.copy}</button></div>` : ''}
              <div class="pay-timer"><svg width="38" height="38" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="none" stroke="rgba(214,174,92,.14)" stroke-width="3"/><circle class="js-ring" cx="20" cy="20" r="17" fill="none" stroke="url(#tmG)" stroke-width="3" stroke-linecap="round" stroke-dasharray="106.8" transform="rotate(-90 20 20)"/><defs><linearGradient id="tmG"><stop offset="0" stop-color="#FFE7A3"/><stop offset="1" stop-color="#E9B949"/></linearGradient></defs></svg>
                <span><b class="js-left ltr">--:--</b><span class="muted" style="font-size:12px;display:block">Your price is locked until this time</span></span></div>
            </div>
            ${c.auto ? '' : txBox('Transaction hash (optional; makes confirmation faster)')}
            <button type="button" class="pill-btn gold js-paid">${c.auto ? 'I have paid (optional)' : 'I have paid'}</button>
            <div style="height:10px"></div><button type="button" class="pill-btn dark js-cancel">Cancel order</button>
            <p class="muted" style="font-size:12px;line-height:19px;text-align:center;margin-top:14px">Order #${faNum(o.id)}, after network confirmation, ${o.kind === 'topup' && !o.activate_plan_id ? 'your wallet is topped up automatically' : 'your plan activates automatically'}.</p>`;
        } else if (o.status === 'review') {
          h += steps(2) + `
            <div class="pay-card" style="text-align:center;padding:30px 20px">
              <div class="pay-verify">${coinBadge(c, 64)}<span></span><span></span></div>
              <h2 style="margin:22px 0 8px;font-size:20px;font-weight:600">Confirming the transaction</h2>
              <p style="color:var(--body);font-size:14px;line-height:24px;margin:0">Pay <b class="ltr" style="color:var(--gilt)">${esc(c.amount)} ${esc(c.symbol)}</b> on the ${esc(c.network)} network is being checked. After confirmation, ${o.kind === 'topup' && !o.activate_plan_id ? 'your wallet is topped up' : 'your plan activates automatically'}; this page updates by itself.</p>
              ${o.txid ? `<div class="pay-tx ltr">${esc(shortTx(o.txid))}</div>` : ''}
            </div>
            ${o.txid ? '' : txBox('If you have the transaction hash, send it here for faster confirmation') + '<button type="button" class="pill-btn dark js-paid">Send transaction hash</button>'}
            <div style="height:10px"></div><button type="button" class="pill-btn ghost js-home">Back to home</button>`;
        } else if (o.status === 'expired' || o.status === 'rejected') {
          const exp = o.status === 'expired';
          h += `<div class="pay-card" style="text-align:center;padding:28px 20px">
              <div class="pay-verify off">${coinBadge(c, 56)}</div>
              <h2 style="margin:20px 0 8px;font-size:20px;font-weight:600">${exp ? 'The locked price has expired' : 'Deposit not confirmed'}</h2>
              <p style="color:var(--body);font-size:14px;line-height:24px;margin:0">${exp ? 'If you have not sent anything yet, create a new order at the new price. If you have, send the transaction hash so we can check.' : esc(o.admin_note || 'No deposit with these details was found.')}</p>
            </div>
            ${txBox('Transaction hash')}
            <button type="button" class="pill-btn white js-paid">${exp ? 'I have paid, please check' : 'Send the hash again'}</button>
            <div style="height:10px"></div><button type="button" class="pill-btn dark js-new">New order</button>
            <div style="height:10px"></div><button type="button" class="pill-btn ghost js-support">Message support</button>`;
        } else {
          h += `<p class="muted" style="text-align:center">This order is closed.</p><button type="button" class="pill-btn white js-new">New order</button>`;
        }
        body.innerHTML = h;
        bind();
        timer();
      }

      function bind() {
        const b = (sel, fn) => { const el = body.querySelector(sel); if (el) el.onclick = fn; };
        const c = o.coin;
        b('.js-copy-amt', () => { call('copy', { text: c.amount }); toast('Amount copied'); });
        b('.js-copy-addr', () => { call('copy', { text: c.address }); toast('Wallet address copied'); });
        b('.js-copy-memo', () => { call('copy', { text: c.memo }); toast(`${c.memo_label} copied`); });
        b('.js-home', () => reset('home'));
        b('.js-support', openSupport);
        b('.js-new', () => { reset('home'); go('premium', { from: 'home' }); });
        b('.js-cancel', () => sheet(`<h3>Cancel this order?</h3><p>If you have sent the coins, do not cancel; tap “I have paid”.</p>
          <button class="pill-btn white" data-yes>Cancel order</button><div style="height:10px"></div><button class="pill-btn dark" data-no>Back</button>`, (el, close) => {
          el.querySelector('[data-no]').onclick = close;
          el.querySelector('[data-yes]').onclick = async () => { close(); try { await api('POST', `/orders/${o.id}/cancel`); toast('Order cancelled'); back('premium'); } catch (e) { toast(e.message, true); } };
        }));
        b('.js-paid', async (ev) => {
          const btn = ev.currentTarget, inp = body.querySelector('.js-tx'), errEl = body.querySelector('.js-txerr');
          if (errEl) errEl.textContent = '';
          busyButton(btn, true, btn.classList.contains('dark'));
          try { o = await api('POST', `/orders/${o.id}/paid`, { txid: inp ? inp.value.trim() : '' }); lastKey = ''; render(); schedule(); }
          catch (e) { busyButton(btn, false); if (errEl && e.detail && e.detail.field === 'txid') errEl.textContent = e.message; else toast(e.message, true); }
        });
      }

      function timer() {
        clearInterval(tick);
        if (!o || o.status !== 'pending' || !o.coin) return;
        const end = Date.now() + (o.coin.seconds_left || 0) * 1000, total = Math.max(30 * 60, o.coin.seconds_left || 0);
        const draw = () => {
          const left = Math.max(0, Math.round((end - Date.now()) / 1000));
          const el = body.querySelector('.js-left'), ring = body.querySelector('.js-ring');
          if (el) el.textContent = mmss(left);
          if (ring) ring.setAttribute('stroke-dashoffset', String(106.8 * (1 - Math.min(1, left / total))));
          if (left <= 0) { clearInterval(tick); refresh(); }
        };
        draw();
        tick = setInterval(draw, 1000);
      }

      async function refresh() {
        if (!alive) return;
        try { o = await api('GET', `/orders/${o ? o.id : p.id}`); render(); } catch (e) { if (!o) body.innerHTML = `<p class="muted" style="text-align:center">${esc(e.message)}</p>`; }
      }
      // the admin can approve at any moment, so keep listening while this screen is open
      function schedule() {
        clearTimeout(poll);
        if (!alive) return;
        poll = setTimeout(async () => { await refresh(); schedule(); }, o && (o.status === 'review' || (o.coin && o.coin.auto)) ? 5000 : 8000);
      }
      if (o) render(); else refresh();
      schedule();
      const off = on('resume', refresh);
      return () => { alive = false; clearTimeout(poll); clearInterval(tick); off(); };
    },
  };

  // ---------------- CONNECTION SETTINGS ----------------
  // these used to be sheets; they all live on the settings tab now (settings.js)
  CG.connSettings = () => CG.tab('settings');
  CG.killSwitchGuide = () => CG.tab('settings', { ks: true });

  // ---------------- ACCOUNT / MY SUBSCRIPTION ----------------
  // the plan card lives on the usage tab now; here only a short line that leads there, from /me's own fields
  function subCard(sub) {
    if (!sub) return `<button type="button" class="row-line js-usage" style="width:100%">${esc(CG.t('stop.none'))}<span>›</span></button>`;
    const left = sub.unlimited_time ? CG.t('us.no_expiry') : CG.i18n.n(sub.days_left) + ' ' + CG.t('us.days_left');
    return `<button type="button" class="row-line js-usage" style="width:100%"><span>${esc(sub.plan_name || CG.t('app.name'))} · ${esc(CG.t('us.status.' + (sub.status || 'unknown')))}<br><span class="muted" style="font-size:12px">${esc(left)}</span></span><span>›</span></button>`;
  }
  screens.account = {
    fit: 'width',
    bg: 'linear-gradient(180deg,#0B0A08 0%,#0B0A08 55%,#16120B 100%)',
    html: () => {
      const me = S.me || {};
      const ann = S.config && S.config.announcement;
      return `${backBtn()}<div class="scroll"><div class="page enter" style="padding-top:110px">
        <h1 class="title-grad" style="margin-top:0">My plan</h1>
        ${ann ? `<div class="ann">${esc(ann)}</div>` : ''}
        <div style="position:relative;border-radius:26px;overflow:hidden;background:linear-gradient(155deg,#2A2216 0%,#16130E 38%,#100E0A 100%);box-shadow:inset 0 1px 0 rgba(243,221,160,.25),inset 0 0 0 1px rgba(214,174,92,.28),0 30px 60px -24px rgba(0,0,0,.9)">
          <svg aria-hidden="true" width="260" height="260" viewBox="0 0 260 260" fill="none" stroke="#D6AE5C" style="position:absolute;left:-90px;top:-90px;opacity:.13;pointer-events:none"><circle cx="130" cy="130" r="94" stroke-width="1.2"/><circle cx="130" cy="130" r="124" stroke-width="1"/></svg>
          <div class="js-card" style="position:relative;padding:6px 18px">${subCard(me.subscription)}</div>
        </div>
        <h2 style="font-size:17px;font-weight:500;margin:28px 0 8px">Devices</h2>
        <div class="panel js-devs" style="padding:4px 18px"><div class="skeleton" style="height:44px;margin:12px 0"></div></div>
        <h2 style="font-size:17px;font-weight:500;margin:28px 0 8px">Account</h2>
        <div class="panel" style="padding:4px 18px">
          <div class="row-line"><span class="muted">Email</span><span class="ltr" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(me.email || '')}</span></div>
          <div class="row-line"><span class="muted">Wallet balance</span><span>${toman(me.wallet_balance || 0)} Toman</span></div>
          <button type="button" class="row-line js-conn" style="width:100%">Connection settings<span>›</span></button>
          <button type="button" class="row-line js-pass" style="width:100%">Change password<span>›</span></button>
          <button type="button" class="row-line js-orders" style="width:100%">My payments<span>›</span></button>
          <button type="button" class="row-line js-sup" style="width:100%">Support<span>›</span></button>
          <button type="button" class="row-line js-all" style="width:100%;color:#EE9A86">Sign out of all phones<span>›</span></button>
        </div>
        <p class="muted js-ver ltr" style="text-align:center;font-size:12px;margin-top:22px"></p>
      </div></div>`;
    },
    mount(root) {
      wireBack(root);
      const b = (c, fn) => { const el = root.querySelector(c); if (el) el.onclick = fn; };
      const bindCard = () => b('.js-usage', () => CG.tab('usage'));
      const paintCard = () => { root.querySelector('.js-card').innerHTML = subCard(S.me && S.me.subscription); bindCard(); };
      bindCard();
      b('.js-orders', () => go('orders'));
      b('.js-conn', () => CG.connSettings());
      b('.js-sup', openSupport);
      call('session', {}).then((x) => { if (x && x.version) root.querySelector('.js-ver').textContent = `Cloud Gold ${x.version} · core v2rayNG ${x.core || ''}`; }).catch(() => {});
      b('.js-pass', () => sheet(`<h3>Change password</h3><p>Other phones stay signed in.</p>
        <label class="field"><span>Current password</span><input class="input" dir="ltr" name="cur" type="password" autocomplete="current-password"></label>
        <label class="field"><span>New password</span><input class="input" dir="ltr" name="new" type="password" autocomplete="new-password" placeholder="At least 8 characters"></label>
        <div class="err"></div><button class="pill-btn white js-save">Save</button>`, (el, close) => {
        el.querySelector('.js-save').onclick = async (ev) => {
          const btn = ev.currentTarget;
          busyButton(btn, true);
          try {
            const t = await api('POST', '/auth/change-password', { current_password: el.querySelector('[name=cur]').value, new_password: el.querySelector('[name=new]').value });
            await call('setSession', Object.assign({ email: S.me.email }, t));
            close(); toast('Password changed');
          } catch (e) { busyButton(btn, false); el.querySelector('.err').textContent = e.message; }
        };
      }));
      b('.js-all', () => sheet(`<h3>Sign out of all phones?</h3><p>Every phone signed in with this account, including this one, has to sign in again.</p>
        <button class="pill-btn white js-yes">Sign out of all</button><div style="height:10px"></div><button class="pill-btn dark js-no">Cancel</button>`, (el, close) => {
        el.querySelector('.js-no').onclick = close;
        el.querySelector('.js-yes').onclick = async () => {
          try { await api('POST', '/auth/logout-all'); } catch (e) {}
          close(); await call('logout', {}); S.me = null; reset('auth', { mode: 'login' });
        };
      }));
      const loadDevs = () => Promise.all([api('GET', '/devices'), call('device', {}).catch(() => ({}))]).then(([rows, mine]) => {
        const el = root.querySelector('.js-devs');
        el.innerHTML = rows.length ? rows.map((d) => `<div class="row-line"><span><span class="ltr">${esc(d.model || 'Phone')}</span>${d.device_id === mine.id ? ' <span style="color:var(--gilt);font-size:12px">, this phone</span>' : ''}<br><span class="muted" style="font-size:12px">Last used ${faDate(d.last_seen)}</span></span>
          ${d.device_id === mine.id ? '' : `<button type="button" class="link-btn" data-del="${d.id}" style="color:#EE9A86">Remove</button>`}</div>`).join('') : '<p class="muted" style="margin:14px 0;text-align:center">No devices yet.</p>';
        el.querySelectorAll('[data-del]').forEach((x) => {
          x.onclick = async () => { try { await api('DELETE', `/devices/${x.dataset.del}`); toast('Device removed'); loadDevs(); } catch (e) { toast(e.message, true); } };
        });
      }).catch((e) => toast(e.message, true));
      loadDevs();
      // always show fresh numbers from the panel
      loadMe().then(paintCard).catch(() => {});
      loadConfig().catch(() => null);
    },
  };
})();
