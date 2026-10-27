/* Splash, onboarding, sign in / sign up, plans, payments, wallet, invite and account screens. */
(function () {
  'use strict';
  const CG = window.CG;
  const { esc, toman, call, api, on, S, go, reset, back, toast, busyButton, sheet, screens, I, loadMe, loadConfig, syncVpn, hasActivePlan } = CG;

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
  const closeBtn = (cls) => `<button type="button" aria-label="Close" class="${cls || 'js-close'}" style="position:absolute;right:20px;top:56px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;z-index:5">${I.close}</button>`;
  function wireBack(root, fallback) {
    root.querySelectorAll('.js-back,.js-close').forEach((b) => { b.onclick = () => back(fallback || 'home'); });
  }

  // ---------------- SPLASH ----------------
  screens.splash = {
    fit: 'both',
    html: () => `
      <svg aria-hidden="true" width="390" height="844" viewBox="0 0 390 844" style="position:absolute;left:0;top:calc((var(--sh) - 844px) / 2)">
        <defs>
          <radialGradient id="spBg" cx="195" cy="398" r="215" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00007C"/><stop offset=".3" stop-color="#000484"/><stop offset=".55" stop-color="#000266"/><stop offset=".8" stop-color="#010238" stop-opacity=".8"/><stop offset="1" stop-color="#010315" stop-opacity="0"/></radialGradient>
          <linearGradient id="spWord" x1="45" y1="0" x2="345" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset=".6" stop-color="#F4F4F8"/><stop offset="1" stop-color="#A6A6B8"/></linearGradient>
          <filter id="spBlur8" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter>
          <filter id="spBlur3" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
          <filter id="spBlur1" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2"/></filter>
        </defs>
        <g class="sp-glow"><rect width="390" height="844" fill="url(#spBg)"/></g>
        <g class="sp-logo">
          <circle cx="195" cy="393" r="66" fill="none" stroke="#2E2BFF" stroke-width="7" opacity=".55" filter="url(#spBlur3)"/>
          <circle cx="195" cy="393" r="66" fill="none" stroke="#4B47FF" stroke-width="2.6"/>
          <circle cx="195" cy="393" r="58" fill="none" stroke="#2A27D6" opacity=".6"/>
          <g class="sp-pink">
            <path d="M107.5 365A92 92 0 0 0 107.5 421" fill="none" stroke="#FF3FD8" stroke-width="5" opacity=".6" filter="url(#spBlur3)"/><path d="M107.5 365A92 92 0 0 0 107.5 421" fill="none" stroke="#FF7BE9" stroke-width="2.2" stroke-linecap="round"/>
            <path d="M282.5 365A92 92 0 0 1 282.5 421" fill="none" stroke="#FF3FD8" stroke-width="5" opacity=".6" filter="url(#spBlur3)"/><path d="M282.5 365A92 92 0 0 1 282.5 421" fill="none" stroke="#FF7BE9" stroke-width="2.2" stroke-linecap="round"/>
            <path d="M124 378A74 74 0 0 0 124 410" fill="none" stroke="#3A36FF" stroke-width="2" stroke-linecap="round"/><path d="M266 378A74 74 0 0 1 266 410" fill="none" stroke="#3A36FF" stroke-width="2" stroke-linecap="round"/>
          </g>
          <g class="sp-arcs">
            <path d="M178.3 300.5A96 96 0 0 1 289.5 378.3" fill="none" stroke="#3346FF" stroke-width="22" opacity=".85" filter="url(#spBlur8)"/><path d="M178.3 300.5A96 96 0 0 1 289.5 378.3" fill="none" stroke="#8E9BFF" stroke-width="7" opacity=".9" filter="url(#spBlur3)"/><path d="M178.3 300.5A96 96 0 0 1 289.5 378.3" fill="none" stroke="#F1F3FF" stroke-width="3.2" stroke-linecap="round" filter="url(#spBlur1)"/>
            <path d="M211.7 489.5A96 96 0 0 1 100.5 411.7" fill="none" stroke="#3346FF" stroke-width="22" opacity=".85" filter="url(#spBlur8)"/><path d="M211.7 489.5A96 96 0 0 1 100.5 411.7" fill="none" stroke="#8E9BFF" stroke-width="7" opacity=".9" filter="url(#spBlur3)"/><path d="M211.7 489.5A96 96 0 0 1 100.5 411.7" fill="none" stroke="#F1F3FF" stroke-width="3.2" stroke-linecap="round" filter="url(#spBlur1)"/>
            <g class="sp-flare"><ellipse cx="256" cy="322" rx="20" ry="7" transform="rotate(40 256 322)" fill="#fff" opacity=".85" filter="url(#spBlur3)"/><ellipse cx="256" cy="322" rx="9" ry="3" transform="rotate(40 256 322)" fill="#FFE8FA"/><ellipse cx="134" cy="468" rx="20" ry="7" transform="rotate(40 134 468)" fill="#fff" opacity=".85" filter="url(#spBlur3)"/><ellipse cx="134" cy="468" rx="9" ry="3" transform="rotate(40 134 468)" fill="#FFE8FA"/></g>
          </g>
          <text x="195" y="412" text-anchor="middle" font-family="Michroma, sans-serif" font-size="26" letter-spacing="6" fill="url(#spWord)" stroke="url(#spWord)" stroke-width=".7">CLOUD GOLD</text>
        </g>
      </svg>
      <div class="sp-msg" style="position:absolute;left:0;right:0;bottom:60px;text-align:center;color:#8f94c0;font-size:13px"></div>`,
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
    { img: 'img/tiles.webp', top: 140, h: 380, title: 'Get Access to Any Site', text: 'Open every app and website you love, from anywhere, with no limits and no slowdowns.' },
    { img: 'img/servers.webp', top: 130, h: 410, title: 'Choose From Over 100 Servers', text: 'Pick a fast, private server in any country and switch between locations with a single tap.' },
    { img: 'img/coins.webp', top: 110, h: 450, title: 'Invite Friends and Earn Money', text: 'Share your link with friends and get a reward for every plan they buy.' },
  ];
  screens.onboarding = {
    fit: 'both',
    html: (p) => {
      const i = p.step || 0, o = OB[i];
      return `
      <div aria-hidden="true" style="position:absolute;left:15px;top:calc(120px + (var(--sh) - 844px) * .45);width:360px;height:380px;border-radius:50%;background:radial-gradient(closest-side,rgba(28,42,190,.42),rgba(10,16,110,.22) 55%,rgba(1,3,21,0) 100%);animation:cgShimmer 4s ease-in-out infinite"></div>
      <div aria-hidden="true" class="ob-art float" style="top:calc(${o.top}px + (var(--sh) - 844px) * .45);height:${o.h}px"><img src="${o.img}" alt="" style="width:390px;height:${o.h}px"></div>
      <div style="position:absolute;top:57px;left:0;width:390px;height:30px">
        <button type="button" aria-label="Skip" class="ob-skip" style="position:absolute;left:14px;top:0;width:30px;height:30px;display:flex;align-items:center;justify-content:center">${I.close}</button>
        <div role="progressbar" aria-label="Step ${i + 1} of 3" aria-valuemin="1" aria-valuemax="3" aria-valuenow="${i + 1}" class="ob-progress" style="position:absolute;left:82px;top:13.5px">
          ${[0, 1, 2].map((j) => `<div class="${j < i ? 'done' : j === i ? 'now' : ''}">${j === i ? '<i></i>' : ''}</div>`).join('')}
        </div>
        <button type="button" class="ob-next" style="position:absolute;right:18px;top:0;height:30px;font-size:15px;font-weight:600;letter-spacing:-.1px">${i < 2 ? 'Next' : 'Start'}</button>
      </div>
      <div class="ob-copy enter" style="bottom:173px"><h1 class="title-grad">${o.title}</h1><p>${o.text}</p></div>
      <div class="ob-actions">
        <button type="button" class="pill-btn white ob-in">Sign In</button>
        <button type="button" class="pill-btn dark ob-up" style="height:49px">Sign up</button>
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
        if (dx < -50) next(); else if (dx > 50 && i > 0) CG.reset('onboarding', { step: i - 1 });
      });
      return () => clearTimeout(t);
    },
  };

  // ---------------- AUTH (email + password, no verification code) ----------------
  const AUTH = {
    login: ['Welcome back', 'Sign in with your Cloud Gold account.'],
    register: ['Create your account', 'One account works on all your phones. Your VPN is set up right after you buy a plan.'],
    forgot: ['Forgot password', ''],
  };
  screens.auth = {
    fit: 'width',
    html: (p) => {
      const m = p.mode || 'login', [title, sub] = AUTH[m];
      let form = '';
      if (m === 'forgot') {
        form = `<p class="sub">For your security, passwords are reset by our support team. Message us and we'll help you back in.</p>
          <button type="button" class="pill-btn white js-support">Contact support</button>
          <div class="swap"><button type="button" class="js-swap">Back to Sign In</button></div>`;
      } else {
        form = `<p class="sub">${sub}</p>
          <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" placeholder="you@example.com" value="${esc(p.email || '')}"></label>
          <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="${m === 'login' ? 'current-password' : 'new-password'}" placeholder="${m === 'login' ? 'Your password' : 'At least 8 characters'}"></label>
          ${m === 'register' ? `<label class="field"><span>Invite code (optional)</span><input class="input" name="ref" autocapitalize="characters" autocomplete="off" placeholder="e.g. GOLD7XQ" value="${esc(recall('cg_ref') || '')}"></label>` : ''}
          <div class="err" role="alert"></div>
          <button class="pill-btn white js-go" type="submit">${m === 'login' ? 'Sign In' : 'Create account'}</button>
          ${m === 'login' ? '<div style="text-align:center;margin-top:10px"><button type="button" class="link-btn js-forgot">Forgot password?</button></div>' : ''}
          <div class="swap">${m === 'login' ? 'New to Cloud Gold? <button type="button" class="js-swap">Sign up</button>' : 'Already have an account? <button type="button" class="js-swap">Sign In</button>'}</div>`;
      }
      return `<div class="scroll"><div class="auth-glow"></div>
        <form class="auth-wrap enter" novalidate>
          <div style="font-family:Michroma;font-size:13px;letter-spacing:4px;color:#b8bfff">CLOUD GOLD</div>
          <h1 class="title-grad">${title}</h1>${form}
        </form></div>`;
    },
    mount(root, p) {
      const m = p.mode || 'login';
      const form = root.querySelector('form'), err = root.querySelector('.err'), go_ = root.querySelector('.js-go');
      const val = (n) => { const el = form.querySelector(`[name="${n}"]`); return el ? el.value.trim() : ''; };
      const fail = (e) => {
        if (err) err.textContent = e.message || 'Something went wrong';
        if (e.detail && e.detail.field) { const el = form.querySelector(`[name="${e.detail.field}"]`); if (el) el.focus(); }
      };
      const dev = () => call('device', {}).catch(() => ({}));
      const swap = root.querySelector('.js-swap');
      if (swap) swap.onclick = () => reset('auth', { mode: m === 'login' ? 'register' : 'login', email: val('email') || p.email });
      const forgot = root.querySelector('.js-forgot');
      if (forgot) forgot.onclick = () => go('auth', { mode: 'forgot' });
      const support = root.querySelector('.js-support');
      if (support) support.onclick = () => (S.config && S.config.support_url ? call('openUrl', { url: S.config.support_url }) : toast('Support link is not set yet'));
      if (!form.onsubmit && m !== 'forgot') {
        const submit = async () => {
          err.textContent = '';
          busyButton(go_, true);
          try {
            const d = await dev();
            if (!val('email') || !val('password')) throw { message: m === 'login' ? 'Enter your email and password' : 'Enter your email and choose a password' };
            if (m === 'register') {
              if (val('password').length < 8) throw { message: 'Use at least 8 characters for your password', detail: { field: 'password' } };
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

  // ---------------- PREMIUM ----------------
  screens.premium = {
    fit: 'both',
    html: (p) => `
      <svg aria-hidden="true" class="pr-bowl" width="390" height="260" viewBox="0 0 390 260" style="position:absolute;top:0;left:0">
        <defs>
          <radialGradient id="prBowl" cx="195" cy="150" r="230" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0618B8"/><stop offset=".35" stop-color="#0715A6"/><stop offset=".7" stop-color="#0A1CC8"/><stop offset=".9" stop-color="#1D33FF"/><stop offset="1" stop-color="#3550FF"/></radialGradient>
          <linearGradient id="prTop" x1="0" y1="0" x2="0" y2="70" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#010533" stop-opacity=".95"/><stop offset="1" stop-color="#010533" stop-opacity="0"/></linearGradient>
          <radialGradient id="prUnder" cx="195" cy="180" r="120" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2A33A0" stop-opacity=".55"/><stop offset="1" stop-color="#010315" stop-opacity="0"/></radialGradient>
          <clipPath id="prClip"><circle cx="195" cy="-42" r="220"/></clipPath>
          <filter id="prB8" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter>
          <filter id="prB3" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
          <filter id="prB1" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1"/></filter>
        </defs>
        <ellipse cx="195" cy="185" rx="210" ry="40" fill="url(#prUnder)"/>
        <circle cx="195" cy="-42" r="220" fill="url(#prBowl)"/>
        <g clip-path="url(#prClip)">
          <rect width="390" height="70" fill="url(#prTop)"/>
          <ellipse cx="195" cy="150" rx="120" ry="70" fill="#0A1060" opacity=".55" filter="url(#prB8)"/>
          <circle cx="195" cy="196" r="76" fill="none" stroke="#2D2BFF" stroke-width="6" opacity=".6" filter="url(#prB3)"/>
          <circle cx="195" cy="196" r="76" fill="none" stroke="#4A46FF" stroke-width="2"/>
          <path d="M104 150A100 100 0 0 1 108 140" stroke="#FF57E0" stroke-width="5" opacity=".6" filter="url(#prB3)" fill="none"/>
          <path d="M102 156A100 100 0 0 1 110 138" stroke="#FF8BEF" stroke-width="2.2" stroke-linecap="round" fill="none"/>
          <path d="M288 156A100 100 0 0 0 280 138" stroke="#FF8BEF" stroke-width="2.2" stroke-linecap="round" fill="none"/>
          <g class="pr-orbit">
            <path d="M111 134A104 104 0 0 1 247 106" fill="none" stroke="#3E55FF" stroke-width="14" opacity=".8" filter="url(#prB8)"/>
            <path d="M111 134A104 104 0 0 1 247 106" fill="none" stroke="#B9C4FF" stroke-width="2.6" stroke-linecap="round" filter="url(#prB1)"/>
            <g class="pr-flare"><ellipse cx="164" cy="95" rx="26" ry="8" transform="rotate(-14 164 95)" fill="#fff" opacity=".85" filter="url(#prB3)"/><ellipse cx="164" cy="95" rx="11" ry="3.4" transform="rotate(-14 164 95)" fill="#FFE6FA"/></g>
          </g>
        </g>
        <g class="pr-flare"><ellipse cx="180" cy="70" rx="70" ry="26" fill="#C9D1FF" opacity=".55" filter="url(#prB8)"/><ellipse cx="180" cy="70" rx="26" ry="9" fill="#fff" opacity=".95" filter="url(#prB3)"/></g>
        <g class="pr-rim"><circle cx="195" cy="-42" r="220" fill="none" stroke="#5266FF" stroke-width="12" opacity=".7" filter="url(#prB8)"/><circle cx="195" cy="-42" r="220" fill="none" stroke="#C7CEFF" stroke-width="4" opacity=".9" filter="url(#prB3)"/><circle cx="195" cy="-42" r="220" fill="none" stroke="#fff" stroke-width="1.8"/></g>
      </svg>
      ${p.from ? `<button type="button" aria-label="Close" class="js-close" style="position:absolute;left:14px;top:56px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;z-index:5">${I.close}</button>` : ''}
      <h1 class="title-grad pr-h1" style="position:absolute;left:21px;top:197px;margin:0;font-size:27px;font-weight:500;line-height:36px;letter-spacing:-.3px">Cloud Gold Premium</h1>
      <ul class="pr-perks" style="position:absolute;left:21px;top:254px;margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:20px">
        ${['Get Access to Any Site', 'Choose from over 100 servers', 'Invite Friends and Earn Money'].map((t) => `<li style="display:flex;align-items:center;gap:11px;height:24px"><span aria-hidden="true" style="width:24px;height:24px;border-radius:50%;background:#2B40FF;display:flex;align-items:center;justify-content:center;flex-shrink:0">${I.check}</span><span style="font-size:15.2px;font-weight:500;line-height:20px">${t}</span></li>`).join('')}
      </ul>
      <div role="radiogroup" aria-label="Choose a plan" class="pr-plans" style="position:absolute;left:20px;top:390px;width:350px;display:flex;flex-direction:column;gap:24px">
        ${[0, 1, 2].map(() => '<div class="skeleton" style="height:70px;border-radius:20px"></div>').join('')}
      </div>
      <button type="button" class="pill-btn white pr-cta" style="position:absolute;left:20px;top:calc(var(--sh) - 145px);width:350px;font-size:16px">Continue</button>
      <div style="position:absolute;left:0;top:calc(var(--sh) - 83px);width:390px;display:flex;justify-content:center;align-items:center;gap:12px;font-size:11.3px;font-weight:500">
        <button type="button" class="pr-support" style="color:#8997FF;padding:4px 0">Questions? Contact support</button>
        <span aria-hidden="true" style="width:4px;height:4px;border-radius:50%;background:#B3C7FF"></span>
        <button type="button" class="pr-orders" style="color:#8997FF;padding:4px 0">My payments</button>
      </div>`,
    mount(root, p) {
      const $ = (c) => root.querySelector(c);
      const c = $('.js-close'); if (c) c.onclick = () => back('home');
      $('.pr-support').onclick = () => (S.config && S.config.support_url ? call('openUrl', { url: S.config.support_url }) : toast('Support link is not set yet'));
      $('.pr-orders').onclick = () => go('orders');
      let plans = S.plans || [], sel = -1;
      // the design is 844 tall; on shorter phones pull the header up and tighten the gaps so the CTA never covers a plan
      function place() {
        const c = 844 - S.sh, up = c > 0 ? Math.min(c * 0.55, 90) : 0;
        $('.pr-bowl').style.transform = `translateY(${-up}px)`;
        $('.pr-h1').style.top = 197 - up + 'px';
        const perks = $('.pr-perks');
        perks.style.top = 254 - up + 'px';
        perks.style.gap = c > 60 ? '12px' : '20px';
        perks.style.display = c > 175 ? 'none' : 'flex';
        const pl = $('.pr-plans');
        pl.style.top = (c > 175 ? 254 - up : 390 - (c > 0 ? Math.min(c * 0.8, 140) : 0)) + 'px';
        pl.style.gap = c > 60 ? '16px' : '24px';
      }
      screens.premium.resize = place;
      const trialOk = () => S.me && S.me.trial_available;
      function draw() {
        if (!plans.length) { $('.pr-plans').innerHTML = '<p style="color:#CFC9EA;text-align:center">No plans are on sale right now. Please check back soon.</p>'; return; }
        if (sel < 0) { sel = plans.findIndex((x) => x.badge); if (sel < 0) sel = 0; }
        place();
        $('.pr-plans').innerHTML = plans.slice(0, 4).map((pl, i) => {
          const onn = i === sel, hasOld = pl.old_price_toman > pl.price_toman, trial = onn && pl.trial_days > 0 && trialOk();
          const months = Math.max(1, Math.round(pl.duration_days / 30));
          const right = months > 1 ? `${toman(pl.monthly_toman)} T / mo` : `${toman(pl.price_toman)} T`;
          const h = hasOld ? (trial ? 97 : 71) : trial ? 90 : 70;
          return `<div style="position:relative">
            ${pl.badge ? `<div class="badge" style="z-index:2">${esc(pl.badge)}</div>` : ''}
            <button type="button" role="radio" aria-checked="${onn}" data-i="${i}" class="plan-card${onn ? ' on' : ''}" style="height:${h}px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
                <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
                  <span style="font-size:${onn ? 17 : 15.5}px;font-weight:${onn ? 600 : 500};line-height:22px">${esc(pl.name)}</span>
                  ${hasOld ? `<span style="font-size:13.5px;font-weight:500;line-height:18px"><s style="color:#AFA9BB;font-weight:400">${toman(pl.old_price_toman)}</s>  ${toman(pl.price_toman)} T</span>` : pl.device_limit ? `<span style="font-size:12.5px;line-height:18px;color:rgba(255,255,255,.65)">${pl.device_limit} device${pl.device_limit > 1 ? 's' : ''}${pl.data_limit_gb ? ' · ' + pl.data_limit_gb + ' GB' : ' · Unlimited data'}</span>` : ''}
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
                  <span style="font-size:${onn ? 17 : 15.5}px;font-weight:${onn ? 600 : 500};line-height:22px">${right}</span>
                  ${hasOld ? `<span style="font-size:12.5px;font-weight:500;line-height:18px;color:#FAFBFF">Save ${pl.save_percent}%</span>` : ''}
                </div>
              </div>
              ${trial ? `<div style="margin-top:9px;font-size:15px;font-weight:600;line-height:20px;color:#FEFF5B">${pl.trial_days} days free trial. Pay only if you stay.</div>` : ''}
            </button></div>`;
        }).join('');
        root.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => { sel = +b.dataset.i; draw(); }; });
        const pl = plans[sel];
        $('.pr-cta').textContent = pl && pl.trial_days > 0 && trialOk() ? 'Start Free Trial' : 'Continue';
      }
      draw();
      Promise.all([api('GET', '/plans'), loadConfig().catch(() => null), S.me ? null : loadMe().catch(() => null)])
        .then(([pl]) => { S.plans = plans = pl; draw(); }).catch((e) => toast(e.message, true));
      $('.pr-cta').onclick = async (ev) => {
        const pl = plans[sel];
        if (!pl) return;
        if (!S.me) { go('auth', { mode: 'register' }); return; }
        if (pl.trial_days > 0 && trialOk()) {
          const btn = ev.currentTarget;
          busyButton(btn, true);
          try {
            S.me = await api('POST', '/trial', { plan_id: pl.id });
            await syncVpn();
            go('success', { title: 'Your free trial is on', text: `Enjoy ${pl.trial_days} days of Cloud Gold Premium. Tap the power button to connect.` });
          } catch (e) { toast(e.message, true); } finally { if (document.body.contains(btn)) busyButton(btn, false); }
          return;
        }
        payFor({ plan: pl });
      };
    },
  };

  // ---------------- PAYMENT ----------------
  // what: {plan} or {topup: amount}
  function payFor(what) {
    const amount = what.plan ? what.plan.price_toman : what.topup;
    const cfg = S.config || {};
    const bal = S.me ? S.me.wallet_balance : 0;
    const methods = [];
    if (what.plan) methods.push({ id: 'wallet', icon: I.wallet, name: 'Wallet', note: bal >= amount ? `Balance ${toman(bal)} T` : `Balance ${toman(bal)} T · not enough`, off: bal < amount });
    if (cfg.card_enabled) methods.push({ id: 'card', icon: I.card, name: 'Card to card', note: 'Transfer, then upload the receipt' });
    if (cfg.crypto_enabled) methods.push({ id: 'crypto', icon: I.crypto, name: 'Crypto (USDT, TRX, BTC...)', note: 'Activated automatically after payment' });
    if (!methods.filter((m) => !m.off).length && !methods.length) { toast('No payment method is available right now. Contact support.', true); return; }
    let pick = (methods.find((m) => !m.off) || {}).id;
    sheet(`<h3>${what.plan ? esc(what.plan.name) + ' plan' : 'Top up wallet'}</h3>
      <p>${toman(amount)} Toman${what.plan ? ` · ${what.plan.duration_days} days · ${what.plan.device_limit || 'unlimited'} device${what.plan.device_limit === 1 ? '' : 's'}` : ''}</p>
      <div class="pm-list">${methods.map((m) => `<button type="button" class="method${m.id === pick ? ' on' : ''}" data-m="${m.id}" ${m.off ? 'disabled style="opacity:.45"' : ''}><span class="mi">${m.icon}</span><span style="min-width:0"><b>${m.name}</b><span>${m.note}</span></span></button>`).join('')}</div>
      <div style="height:6px"></div><button type="button" class="pill-btn white pm-go">Pay ${toman(amount)} T</button>`, (el, close) => {
      el.querySelectorAll('[data-m]').forEach((b) => {
        b.onclick = () => { pick = b.dataset.m; el.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b)); };
      });
      el.querySelector('.pm-go').onclick = async (ev) => {
        if (!pick) return;
        const btn = ev.currentTarget;
        busyButton(btn, true);
        try {
          const order = await api('POST', '/orders', Object.assign({ method: pick }, what.plan ? { plan_id: what.plan.id } : { topup_toman: what.topup }));
          close();
          if (order.status === 'paid') return afterPaid(order);
          if (pick === 'card') return go('card', { order });
          if (pick === 'crypto') { call('openUrl', { url: order.crypto_pay_url }); return go('order', { id: order.id }); }
        } catch (e) { busyButton(btn, false); toast(e.message, true); }
      };
    });
  }
  CG.payFor = payFor;

  async function afterPaid(order) {
    try { await loadMe(); } catch (e) {}
    if (order.kind === 'plan') {
      try { await syncVpn(); } catch (e) { toast(e.message, true); }
      go('success', { title: 'You are all set', text: `${esc(order.plan_name || 'Your plan')} is active. Tap the power button to connect.` });
    } else {
      go('success', { title: 'Wallet topped up', text: `${toman(order.amount_toman)} Toman was added to your wallet.`, to: 'wallet' });
    }
  }

  screens.success = {
    fit: 'both',
    html: (p) => `
      <div aria-hidden="true" style="position:absolute;left:-40px;right:-40px;top:calc(var(--sh) * .14);height:420px;border-radius:50%;background:radial-gradient(closest-side,rgba(40,63,255,.5),rgba(10,16,110,.2) 60%,transparent)"></div>
      <div class="enter" style="position:absolute;left:0;right:0;top:calc(var(--sh) * .25);display:flex;flex-direction:column;align-items:center;text-align:center;padding:0 30px">
        <div style="width:120px;height:120px;border-radius:50%;background:radial-gradient(circle at 50% 30%,#3E434C,#2D3138);box-shadow:0 0 0 1px rgba(255,255,255,.06),0 0 60px rgba(67,255,0,.22);display:flex;align-items:center;justify-content:center">
          <svg aria-hidden="true" width="54" height="54" viewBox="0 0 14 14" fill="none" stroke="#52FF00" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.4l3 3 6-6.6"/></svg></div>
        <h1 class="title-grad" style="margin:34px 0 10px;font-size:27px;font-weight:500;line-height:34px">${esc(p.title)}</h1>
        <p style="margin:0;color:var(--body);font-size:15px;line-height:24px;max-width:300px">${p.text}</p>
      </div>
      <button type="button" class="pill-btn white js-done" style="position:absolute;left:20px;width:350px;top:calc(var(--sh) - 110px)">${p.to === 'wallet' ? 'Back to wallet' : 'Go to Home'}</button>`,
    mount(root, p) { root.querySelector('.js-done').onclick = () => (p.to === 'wallet' ? (reset('home'), go('wallet')) : reset('home')); },
  };

  // card to card
  const fmtCard = (n) => String(n || '').replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');
  screens.card = {
    fit: 'width',
    html: (p) => {
      const o = p.order, c = o.card || {};
      return `${backBtn()}<div class="scroll"><div class="page enter">
        <h1 class="title-grad">Card to card</h1>
        <div class="panel" style="background:linear-gradient(135deg,#283FFF 0%,#3C2BD0 55%,#1A1C6E 100%);position:relative;overflow:hidden">
          <div aria-hidden="true" style="position:absolute;right:-60px;top:-60px;width:200px;height:200px;border-radius:50%;border:1px solid rgba(255,255,255,.18)"></div>
          <div style="font-size:12.5px;color:rgba(255,255,255,.7)">Amount to transfer</div>
          <div style="font-family:Outfit;font-size:30px;font-weight:600;margin-top:4px;letter-spacing:-.3px">${toman(o.amount_toman)} <span style="font-size:16px;font-weight:500">Toman</span></div>
          <div style="font-size:12.5px;color:rgba(255,255,255,.7);margin-top:18px">Card number</div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:4px">
            <div dir="ltr" style="font-family:Outfit;font-size:21px;letter-spacing:1.5px;font-variant-numeric:tabular-nums">${esc(fmtCard(c.number))}</div>
            <button type="button" class="icon-btn glass js-copy" aria-label="Copy card number">${I.copy}</button>
          </div>
          <div style="margin-top:14px;font-size:14px">${esc(c.holder || '')}${c.bank ? ' · ' + esc(c.bank) : ''}</div>
        </div>
        <ol style="margin:22px 0 18px;padding-left:20px;color:var(--body);font-size:14px;line-height:23px">
          <li>Transfer exactly <b style="color:#fff">${toman(o.amount_toman)} Toman</b> to the card above.</li>
          <li>Take a screenshot of the bank receipt.</li>
          <li>Upload it here. We usually confirm within minutes.</li>
        </ol>
        <label class="field"><span>Tracking or reference number (optional)</span><input class="input js-ref" inputmode="numeric" placeholder="e.g. 123456"></label>
        <div style="height:8px"></div>
        <button type="button" class="pill-btn white js-up">Upload receipt</button>
        <div style="height:10px"></div>
        <button type="button" class="pill-btn dark js-cancel">Cancel order</button>
        <p class="muted" style="font-size:12px;line-height:18px;margin-top:14px;text-align:center">Order #${o.id}. Your plan is activated as soon as the payment is confirmed.</p>
      </div></div>`;
    },
    mount(root, p) {
      wireBack(root);
      const o = p.order;
      root.querySelector('.js-copy').onclick = () => { call('copy', { text: String((o.card || {}).number || '').replace(/\D/g, '') }); toast('Card number copied'); };
      root.querySelector('.js-cancel').onclick = async () => {
        try { await api('POST', `/orders/${o.id}/cancel`); toast('Order cancelled'); back('premium'); } catch (e) { toast(e.message, true); }
      };
      root.querySelector('.js-up').onclick = async (ev) => {
        const btn = ev.currentTarget;
        busyButton(btn, true);
        try {
          const r = await call('uploadReceipt', { path: `/orders/${o.id}/receipt`, ref: root.querySelector('.js-ref').value.trim() });
          if (r && r.cancelled) return;
          if (r.status >= 400) throw new CG.ApiError(r.status, r.data && r.data.detail);
          go('order', { id: o.id });
        } catch (e) { toast(e.message || 'Upload failed', true); } finally { if (document.body.contains(btn)) busyButton(btn, false); }
      };
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
      const icon = (color, path) => `<div style="width:96px;height:96px;margin:0 auto;border-radius:50%;background:radial-gradient(circle at 50% 30%,#2F333A,#20232A);box-shadow:0 0 50px ${color}33;display:flex;align-items:center;justify-content:center"><svg aria-hidden="true" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg></div>`;
      function show(o) {
        if (o.status === lastStatus) return;
        lastStatus = o.status;
        if (o.status === 'paid') { alive = false; afterPaid(o); return; }
        let h = '';
        if (o.status === 'pending' && o.method === 'crypto') {
          h = `${icon('#7FC4FF', 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z')}<h1 class="title-grad" style="margin-top:28px">Waiting for payment</h1>
            <p style="color:var(--body);font-size:15px;line-height:24px">Finish the payment on the crypto page. This screen updates by itself when the network confirms it, usually within a few minutes.</p>
            <div style="height:14px"></div><button class="pill-btn white js-open">Open payment page</button><div style="height:10px"></div><button class="pill-btn dark js-cancel">Cancel order</button>`;
        } else if (o.status === 'pending') {
          h = `<h1 class="title-grad">Receipt needed</h1><p style="color:var(--body)">Upload your transfer receipt to continue.</p><button class="pill-btn white js-card">Continue</button>`;
        } else if (o.status === 'review') {
          h = `${icon('#FCFF58', 'M9 12l2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z')}<h1 class="title-grad" style="margin-top:28px">Receipt received</h1>
            <p style="color:var(--body);font-size:15px;line-height:24px">We are checking your transfer. Your plan turns on automatically once it is confirmed. You can close the app; we will be ready when you come back.</p>
            <div style="height:14px"></div><button class="pill-btn dark js-home">Back to Home</button>`;
        } else if (o.status === 'rejected') {
          h = `${icon('#FF5A5F', 'M15 9l-6 6M9 9l6 6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z')}<h1 class="title-grad" style="margin-top:28px">Receipt not accepted</h1>
            <p style="color:var(--body);font-size:15px;line-height:24px">${esc(o.admin_note || 'We could not match this receipt to a transfer.')}</p>
            <div style="height:14px"></div><button class="pill-btn white js-card">Upload another receipt</button><div style="height:10px"></div><button class="pill-btn dark js-support">Contact support</button>`;
        } else {
          h = `${icon('#9FB0C4', 'M12 8v4M12 16h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z')}<h1 class="title-grad" style="margin-top:28px">Order ${o.status}</h1>
            <p style="color:var(--body)">This order is closed. You can start a new one any time.</p><div style="height:14px"></div><button class="pill-btn white js-plans">See plans</button>`;
        }
        body.innerHTML = h;
        const b = (c, fn) => { const el = body.querySelector(c); if (el) el.onclick = fn; };
        b('.js-open', () => call('openUrl', { url: o.crypto_pay_url }));
        b('.js-cancel', async () => { try { await api('POST', `/orders/${o.id}/cancel`); reset('home'); } catch (e) { toast(e.message, true); } });
        b('.js-home', () => reset('home'));
        b('.js-card', async () => {
          try { go('card', { order: await api('GET', `/orders/${o.id}`) }); } catch (e) { toast(e.message, true); }
        });
        b('.js-support', () => (S.config && S.config.support_url ? call('openUrl', { url: S.config.support_url }) : toast('Support link is not set yet')));
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
      const label = { pending: 'Waiting', review: 'In review', paid: 'Paid', rejected: 'Rejected', cancelled: 'Cancelled', expired: 'Expired' };
      const color = { paid: '#52FF00', review: '#FCFF58', rejected: '#FF5A5F', pending: '#7FC4FF' };
      api('GET', '/orders').then((rows) => {
        const el = root.querySelector('.js-list');
        if (!rows.length) { el.innerHTML = '<p class="muted" style="margin:0;text-align:center">No payments yet.</p>'; return; }
        el.innerHTML = rows.map((o) => `<button type="button" class="row-line" data-id="${o.id}" style="width:100%;text-align:left">
          <span><b style="font-weight:500">${o.kind === 'plan' ? esc(o.plan_name || 'Plan') : 'Wallet top-up'}</b><br><span class="muted" style="font-size:12px">#${o.id} · ${o.method} · ${new Date(o.created_at).toLocaleDateString()}</span></span>
          <span style="text-align:right">${toman(o.amount_toman)} T<br><span style="font-size:12px;color:${color[o.status] || '#8F949B'}">${label[o.status] || o.status}</span></span></button>`).join('');
        el.querySelectorAll('[data-id]').forEach((b) => {
          const o = rows.find((x) => x.id === +b.dataset.id);
          b.onclick = () => (o.status === 'pending' && o.method === 'card' ? go('card', { order: o }) : ['pending', 'review', 'rejected'].includes(o.status) ? go('order', { id: o.id }) : null);
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
        <div class="js-bal" style="font-family:Outfit;font-size:38px;font-weight:600;letter-spacing:-.5px;margin-top:6px">${toman(S.me ? S.me.wallet_balance : 0)} <span style="font-size:17px;font-weight:500">T</span></div>
        <div class="muted" style="font-size:12.5px;margin-top:6px">Pay for plans instantly. Invite rewards land here too.</div>
      </div>
      <h2 style="font-size:17px;font-weight:500;margin:26px 0 12px">Top up</h2>
      <div class="js-chips" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px"></div>
      <label class="field" style="margin-top:12px"><span>Or enter an amount (Toman)</span><input class="input js-amt" inputmode="numeric" placeholder="e.g. 300,000"></label>
      <button type="button" class="pill-btn white js-top">Top up</button>
      <h2 style="font-size:17px;font-weight:500;margin:28px 0 8px">History</h2>
      <div class="panel js-tx" style="padding:4px 18px"><div class="skeleton" style="height:44px;margin:12px 0"></div></div>
    </div></div>`,
    mount(root) {
      wireBack(root);
      const amt = root.querySelector('.js-amt');
      const min = (S.config && S.config.min_topup_toman) || 50000;
      const presets = [100000, 200000, 500000].map((v) => Math.max(v, min));
      root.querySelector('.js-chips').innerHTML = presets.map((v) => `<button type="button" class="method" data-v="${v}" style="justify-content:center;padding:14px 6px;margin:0;font-family:Outfit;font-size:15px">${toman(v)}</button>`).join('');
      root.querySelectorAll('[data-v]').forEach((b) => { b.onclick = () => { amt.value = toman(b.dataset.v); root.querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('on', x === b)); }; });
      amt.oninput = () => { const d = amt.value.replace(/\D/g, ''); amt.value = d ? toman(d) : ''; root.querySelectorAll('[data-v]').forEach((x) => x.classList.remove('on')); };
      root.querySelector('.js-top').onclick = () => {
        const v = +amt.value.replace(/\D/g, '');
        if (!v) return toast('Choose or enter an amount', true);
        if (v < min) return toast(`Minimum top-up is ${toman(min)} Toman`, true);
        payFor({ topup: v });
      };
      const reasons = { topup: 'Top-up', purchase: 'Plan purchase', referral: 'Invite reward', refund: 'Refund', admin: 'Adjustment' };
      api('GET', '/wallet').then((w) => {
        root.querySelector('.js-bal').innerHTML = `${toman(w.balance)} <span style="font-size:17px;font-weight:500">T</span>`;
        if (S.me) S.me.wallet_balance = w.balance;
        const el = root.querySelector('.js-tx');
        el.innerHTML = w.transactions.length ? w.transactions.map((t) => `<div class="row-line"><span>${esc(reasons[t.reason] || t.reason)}<br><span class="muted" style="font-size:12px">${new Date(t.created_at).toLocaleDateString()}${t.note ? ' · ' + esc(t.note) : ''}</span></span>
          <span style="color:${t.amount >= 0 ? '#52FF00' : '#fff'};font-family:Outfit;font-size:15px">${t.amount >= 0 ? '+' : ''}${toman(t.amount)}</span></div>`).join('') : '<p class="muted" style="margin:14px 0;text-align:center">No transactions yet.</p>';
      }).catch((e) => toast(e.message, true));
    },
  };

  // ---------------- INVITE (affiliate) ----------------
  screens.invite = {
    fit: 'both',
    bg: '#000214',
    html: () => `
      <div aria-hidden="true" style="position:absolute;left:-160px;top:120px;width:620px;height:520px;background:radial-gradient(closest-side,rgba(104,86,182,1),rgba(82,66,162,.7) 45%,rgba(0,2,20,0) 100%);transform:rotate(-28deg);animation:cgShimmer 6s ease-in-out infinite"></div>
      <div aria-hidden="true" style="position:absolute;left:-80px;top:150px;width:340px;height:90px;background:linear-gradient(90deg,rgba(180,170,255,0) 0%,rgba(200,190,255,.55) 40%,rgba(180,170,255,0) 100%);transform:rotate(32deg);filter:blur(10px)"></div>
      <div aria-hidden="true" style="position:absolute;left:-60px;top:260px;width:300px;height:40px;background:linear-gradient(90deg,rgba(180,170,255,0) 0%,rgba(170,160,255,.25) 50%,rgba(180,170,255,0) 100%);transform:rotate(32deg);filter:blur(8px)"></div>
      <div aria-hidden="true" style="position:absolute;left:0;top:0;width:390px;height:160px;background:linear-gradient(180deg,#000214 0%,rgba(0,2,20,.6) 55%,rgba(0,2,20,0) 100%)"></div>
      <div aria-hidden="true" class="float" style="position:absolute;left:15px;top:calc(300px + (var(--sh) - 844px) * .5);width:360px;height:286px;mix-blend-mode:screen">
        <img src="img/rings.webp" alt="" style="display:block;width:360px;height:286px;-webkit-mask-image:radial-gradient(ellipse 50% 50% at 50% 50%,#000 72%,transparent 100%);mask-image:radial-gradient(ellipse 50% 50% at 50% 50%,#000 72%,transparent 100%)">
      </div>
      ${backBtn()}${closeBtn()}
      <div style="position:absolute;left:0;top:118px;width:390px;display:flex;flex-direction:column;align-items:center;text-align:center">
        <h1 class="title-grad" style="margin:0;font-size:42px;font-weight:500;line-height:49px;letter-spacing:-.8px">Cloud Gold<br>Affiliate Program</h1>
        <p class="js-pct" style="margin:18px 0 0;font-size:14.5px;line-height:20px;color:#B2AFC6">Earn a reward on every plan your friends buy</p>
        <p class="js-stats" style="margin:8px 0 0;font-size:13px;color:#8f8ab0"></p>
      </div>
      <div style="position:absolute;left:20px;top:calc(var(--sh) - 198px);width:350px;display:flex;flex-direction:column;gap:12px">
        <div style="height:54px;border-radius:18px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 18px">
          <span style="font-size:13px;color:#9b96bd">Your code</span>
          <span class="js-code" style="font-family:Outfit;font-size:18px;font-weight:600;letter-spacing:2px;color:#D9D4F2">·······</span>
          <button type="button" class="js-copy" style="height:38px;padding:0 16px;border-radius:13px;background:rgba(167,155,255,.18);font-size:14px;font-weight:600">Copy</button>
        </div>
        <button type="button" class="pill-btn white js-share" style="font-size:16px">Invite friends</button>
      </div>`,
    mount(root) {
      wireBack(root);
      let ref = null;
      api('GET', '/referral').then((r) => {
        ref = r;
        root.querySelector('.js-code').textContent = r.code;
        if (r.percent) root.querySelector('.js-pct').textContent = `Earn ${r.percent}% of every plan your friends buy`;
        root.querySelector('.js-stats').textContent = `${r.invited} friend${r.invited === 1 ? '' : 's'} joined · ${toman(r.earned_toman)} T earned`;
      }).catch((e) => toast(e.message, true));
      const copy = root.querySelector('.js-copy');
      copy.onclick = () => { if (!ref) return; call('copy', { text: ref.code }); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1600); };
      root.querySelector('.js-share').onclick = () => { if (ref) call('share', { text: `${ref.share_text}. Enter the code when you sign up in the Cloud Gold VPN app.` }); };
    },
  };

  // ---------------- ACCOUNT / MY SUBSCRIPTION ----------------
  const fmtBytes = CG.bytes;
  screens.account = {
    fit: 'width',
    bg: 'linear-gradient(180deg,#030418 0%,#040522 45%,#0B0840 75%,#1C1258 100%)',
    html: () => {
      const me = S.me || {}, sub = me.subscription;
      const exp = sub && sub.expires_at ? new Date(sub.expires_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      const pct = sub && sub.data_limit_bytes ? Math.min(100, Math.round(100 * sub.used_bytes / sub.data_limit_bytes)) : 0;
      return `${backBtn()}<div class="scroll"><div class="page enter" style="padding-top:110px">
        <div style="position:relative;border-radius:26px;overflow:hidden;padding:26px 22px 22px;background:radial-gradient(140% 22% at 50% 0%,rgba(170,140,255,.55) 0%,rgba(110,70,230,0) 100%),linear-gradient(180deg,#8762E6 0%,#6A45D2 5%,#3A22A0 12%,#1B1068 24%,#0E0A44 40%,#07062A 62%,#03031A 85%,#010214 100%);border:1px solid rgba(255,255,255,.1);box-shadow:0 24px 60px rgba(0,0,0,.55)">
          <div aria-hidden="true" style="position:absolute;left:0;top:0;right:0;height:2px;background:linear-gradient(90deg,rgba(220,205,255,.2),rgba(235,225,255,.85),rgba(220,205,255,.2))"></div>
          <div style="font-size:12px;font-weight:500">${sub ? esc(sub.plan_name || 'Cloud Gold') : 'No plan yet'}</div>
          <div style="display:flex;align-items:baseline;gap:8px;margin-top:10px"><span style="font-family:Outfit;font-size:34px;font-weight:500;letter-spacing:-.5px">${sub ? (sub.active ? sub.days_left : 0) : '--'}</span><span style="font-size:13px;color:#A0A5C0">days left</span></div>
          <div style="font-size:12.5px;margin-top:6px;color:${sub && sub.active ? '#52FF00' : '#FF8A8E'}">${sub ? (sub.active ? 'Active' : sub.status === 'expired' ? 'Expired' : sub.status === 'limited' ? 'Data limit reached' : sub.status) : 'Buy a plan to start'}${exp ? ` · until ${exp}` : ''}</div>
          ${sub ? `<div style="height:1px;background:rgba(255,255,255,.08);margin:18px 0"></div>
          <div style="display:flex;justify-content:space-between;font-size:12.5px;color:#C3C6DA"><span>Data</span><span>${fmtBytes(sub.used_bytes)} ${sub.data_limit_bytes ? 'of ' + fmtBytes(sub.data_limit_bytes) : '· unlimited'}</span></div>
          ${sub.data_limit_bytes ? `<div style="height:6px;border-radius:3px;background:rgba(255,255,255,.1);margin-top:8px;overflow:hidden"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#8997FF,#B26BFF)"></div></div>` : ''}
          <div style="display:flex;justify-content:space-between;font-size:12.5px;color:#C3C6DA;margin-top:12px"><span>Devices</span><span>${sub.device_limit || 'Unlimited'}</span></div>` : ''}
          <button type="button" class="pill-btn white js-renew" style="margin-top:22px;height:44px;font-size:14px">${sub && sub.active ? 'Extend or change plan' : 'See plans'}</button>
        </div>
        <h2 style="font-size:17px;font-weight:500;margin:28px 0 8px">Devices</h2>
        <div class="panel js-devs" style="padding:4px 18px;background:rgba(255,255,255,.04)"><div class="skeleton" style="height:44px;margin:12px 0"></div></div>
        <h2 style="font-size:17px;font-weight:500;margin:28px 0 8px">Account</h2>
        <div class="panel" style="padding:4px 18px;background:rgba(255,255,255,.04)">
          <div class="row-line"><span class="muted">Email</span><span style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(me.email || '')}</span></div>
          <button type="button" class="row-line js-pass" style="width:100%">Change password<span>›</span></button>
          <button type="button" class="row-line js-orders" style="width:100%">My payments<span>›</span></button>
          <button type="button" class="row-line js-adv" style="width:100%">Advanced settings<span>›</span></button>
          <button type="button" class="row-line js-all" style="width:100%;color:#ff8a8e">Sign out of all phones<span>›</span></button>
        </div>
        <p class="muted js-ver" style="text-align:center;font-size:12px;margin-top:22px"></p>
      </div></div>`;
    },
    mount(root) {
      wireBack(root);
      const b = (c, fn) => { root.querySelector(c).onclick = fn; };
      b('.js-renew', () => go('premium', { from: 'account' }));
      b('.js-orders', () => go('orders'));
      b('.js-adv', () => call('advanced', {}));
      call('session', {}).then((s) => { if (s && s.version) root.querySelector('.js-ver').textContent = `Cloud Gold VPN ${s.version} · core v2rayNG ${s.core || ''}`; }).catch(() => {});
      b('.js-pass', () => sheet(`<h3>Change password</h3><p>Other phones stay signed in.</p>
        <label class="field"><span>Current password</span><input class="input" name="cur" type="password" autocomplete="current-password"></label>
        <label class="field"><span>New password</span><input class="input" name="new" type="password" autocomplete="new-password" placeholder="At least 8 characters"></label>
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
      b('.js-all', () => sheet(`<h3>Sign out everywhere?</h3><p>Every phone signed in to this account, including this one, will need to sign in again.</p>
        <button class="pill-btn white js-yes">Sign out everywhere</button><div style="height:10px"></div><button class="pill-btn dark js-no">Cancel</button>`, (el, close) => {
        el.querySelector('.js-no').onclick = close;
        el.querySelector('.js-yes').onclick = async () => {
          try { await api('POST', '/auth/logout-all'); } catch (e) {}
          close(); await call('logout', {}); S.me = null; reset('auth', { mode: 'login' });
        };
      }));
      const loadDevs = () => Promise.all([api('GET', '/devices'), call('device', {}).catch(() => ({}))]).then(([rows, mine]) => {
        const el = root.querySelector('.js-devs');
        el.innerHTML = rows.length ? rows.map((d) => `<div class="row-line"><span>${esc(d.model || 'Phone')}${d.device_id === mine.id ? ' <span style="color:#8997FF;font-size:12px">· this phone</span>' : ''}<br><span class="muted" style="font-size:12px">Last used ${new Date(d.last_seen).toLocaleDateString()}</span></span>
          ${d.device_id === mine.id ? '' : `<button type="button" class="link-btn" data-del="${d.id}" style="color:#ff8a8e">Remove</button>`}</div>`).join('') : '<p class="muted" style="margin:14px 0;text-align:center">No devices yet.</p>';
        el.querySelectorAll('[data-del]').forEach((x) => {
          x.onclick = async () => { try { await api('DELETE', `/devices/${x.dataset.del}`); toast('Device removed'); loadDevs(); } catch (e) { toast(e.message, true); } };
        });
      }).catch((e) => toast(e.message, true));
      loadDevs();
      loadMe().then(() => {}).catch(() => {});
    },
  };
})();
