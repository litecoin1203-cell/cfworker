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

  const backBtn = (cls) => `<button type="button" aria-label="بازگشت" class="${cls || 'js-back'}" style="position:absolute;right:14px;top:56px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;z-index:5">${I.back}</button>`;
  const closeBtn = (cls) => `<button type="button" aria-label="بستن" class="${cls || 'js-close'}" style="position:absolute;left:20px;top:56px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;z-index:5">${I.close}</button>`;
  function wireBack(root, fallback) {
    root.querySelectorAll('.js-back,.js-close').forEach((b) => { b.onclick = () => back(fallback || 'home'); });
  }

  const openSupport = () => (S.config && S.config.support_url ? call('openUrl', { url: S.config.support_url }) : toast('لینک پشتیبانی هنوز تنظیم نشده است.'));
  CG.openSupport = openSupport;

  // ---------------- SPLASH ----------------
  screens.splash = {
    fit: 'both',
    html: () => `
      <div aria-hidden="true" style="position:absolute;left:-60px;right:-60px;top:calc(var(--sh) * .5 - 300px);height:520px;border-radius:50%;background:radial-gradient(closest-side,rgba(150,108,38,.30),rgba(80,58,20,.10) 60%,transparent)"></div>
      <div style="position:absolute;left:0;right:0;top:calc(var(--sh) * .5 - 150px);display:flex;flex-direction:column;align-items:center">
        <div aria-hidden="true" class="sp-core" style="width:150px;height:150px;position:relative"><div class="pb on" style="position:absolute;left:0;top:0;display:block;transform:scale(${150 / 196});transform-origin:0 0;cursor:default">${halo({ icon: 'power' })}</div></div>
        <div class="serif sp-word" style="margin-top:26px;font-size:46px;font-weight:600;line-height:52px;color:var(--ivory)">Cloud Gold</div>
        <div class="sp-word2" style="margin-top:6px;font-size:13px;color:var(--ash)">اینترنت آزاد، با امنیت طلایی</div>
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
          root.querySelector('.sp-msg').innerHTML = `${esc(e.message)}<div style="height:12px"></div><button class="pill-btn dark" style="width:180px;margin:0 auto;height:42px">تلاش دوباره</button>`;
          root.querySelector('.sp-msg button').onclick = () => reset('splash');
        }
      })();
      return () => { alive = false; };
    },
  };

  // ---------------- ONBOARDING ----------------
  const OB = [
    { img: 'img/tiles.webp', top: 140, h: 380, title: 'دسترسی آزاد به همه‌ی سایت‌ها', text: 'هر اپ و سایتی که دوست داری را از هر جا، بدون محدودیت و بدون کندی باز کن.' },
    { img: 'img/servers.webp', top: 130, h: 410, title: 'سرورهای پرسرعت در کشورهای مختلف', text: 'سریع‌ترین سرور خودکار انتخاب می‌شود؛ با یک لمس هم می‌توانی لوکیشن را عوض کنی.' },
    { img: 'img/coins.webp', top: 110, h: 450, title: 'دوستانت را دعوت کن و پاداش بگیر', text: 'کد دعوتت را بفرست و از هر خرید دوستانت پاداش به کیف پولت اضافه می‌شود.' },
  ];
  screens.onboarding = {
    fit: 'both',
    html: (p) => {
      const i = p.step || 0, o = OB[i];
      return `
      <div aria-hidden="true" style="position:absolute;left:15px;top:calc(120px + (var(--sh) - 844px) * .45);width:360px;height:380px;border-radius:50%;background:radial-gradient(closest-side,rgba(160,118,44,.30),rgba(90,64,22,.10) 55%,rgba(11,10,8,0) 100%)"></div>
      <div aria-hidden="true" class="ob-art float" style="top:calc(${o.top}px + (var(--sh) - 844px) * .45);height:${o.h}px"><img src="${o.img}" alt="" style="width:390px;height:${o.h}px"></div>
      <div style="position:absolute;top:57px;left:0;width:390px;height:30px">
        <button type="button" aria-label="رد کردن" class="ob-skip" style="position:absolute;right:14px;top:0;width:30px;height:30px;display:flex;align-items:center;justify-content:center">${I.close}</button>
        <div role="progressbar" aria-label="مرحله ${i + 1} از ۳" aria-valuemin="1" aria-valuemax="3" aria-valuenow="${i + 1}" class="ob-progress" style="position:absolute;left:82px;top:13.5px">
          ${[0, 1, 2].map((j) => `<div class="${j < i ? 'done' : j === i ? 'now' : ''}">${j === i ? '<i></i>' : ''}</div>`).join('')}
        </div>
        <button type="button" class="ob-next" style="position:absolute;left:18px;top:0;height:30px;font-size:15px;font-weight:600;color:var(--gilt)">${i < 2 ? 'بعدی' : 'شروع'}</button>
      </div>
      <div class="ob-copy enter" style="bottom:173px"><h1 class="title-grad">${o.title}</h1><p>${o.text}</p></div>
      <div class="ob-actions">
        <button type="button" class="pill-btn white ob-up">ساخت حساب</button>
        <button type="button" class="pill-btn dark ob-in" style="height:49px">ورود</button>
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
    login: ['خوش برگشتی', 'با حساب Cloud Gold خودت وارد شو.'],
    register: ['ساخت حساب', 'با یک حساب روی همه‌ی گوشی‌هایت وصل شو. بعد از ثبت‌نام می‌توانی تست رایگان را فعال کنی.'],
    forgot: ['فراموشی رمز', ''],
  };
  screens.auth = {
    fit: 'width',
    html: (p) => {
      const m = p.mode || 'login', [title, sub] = AUTH[m];
      let form = '';
      if (m === 'forgot') {
        form = `<p class="sub">برای امنیت حسابت، رمز را پشتیبانی عوض می‌کند. به ما پیام بده تا سریع کمکت کنیم.</p>
          <button type="button" class="pill-btn white js-support">پیام به پشتیبانی</button>
          <div class="swap"><button type="button" class="js-swap">بازگشت به ورود</button></div>`;
      } else {
        form = `<p class="sub">${sub}</p>
          <label class="field"><span>ایمیل</span><input class="input" dir="ltr" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" placeholder="you@example.com" value="${esc(p.email || '')}"></label>
          <label class="field"><span>رمز عبور</span><input class="input" dir="ltr" name="password" type="password" autocomplete="${m === 'login' ? 'current-password' : 'new-password'}" placeholder="${m === 'login' ? 'رمز حساب' : 'حداقل ۸ کاراکتر'}"></label>
          ${m === 'register' ? `<label class="field"><span>کد دعوت (اختیاری)</span><input class="input" dir="ltr" name="ref" autocapitalize="characters" autocomplete="off" placeholder="GOLD7XQ" value="${esc(recall('cg_ref') || '')}"></label>` : ''}
          <div class="err" role="alert"></div>
          <button class="pill-btn white js-go" type="submit">${m === 'login' ? 'ورود' : 'ساخت حساب'}</button>
          ${m === 'login' ? '<div style="text-align:center;margin-top:10px"><button type="button" class="link-btn js-forgot">رمز را فراموش کرده‌ای؟</button></div>' : ''}
          <div class="swap">${m === 'login' ? 'حساب نداری؟ <button type="button" class="js-swap">ثبت‌نام کن</button>' : 'قبلاً حساب ساخته‌ای؟ <button type="button" class="js-swap">وارد شو</button>'}</div>`;
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
        if (err) err.textContent = e.message || 'مشکلی پیش آمد.';
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
            if (!val('email') || !val('password')) throw { message: m === 'login' ? 'ایمیل و رمز را وارد کن.' : 'ایمیل را وارد کن و یک رمز انتخاب کن.' };
            if (m === 'register') {
              if (val('password').length < 8) throw { message: 'رمز باید حداقل ۸ کاراکتر باشد.', detail: { field: 'password' } };
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
    `${faNum(pl.duration_days)} روز`,
    pl.data_limit_gb ? `${faNum(pl.data_limit_gb)} گیگ` : 'حجم نامحدود',
    pl.device_limit ? `${faNum(pl.device_limit)} کاربره` : 'بدون محدودیت دستگاه',
  ].join(' · ');
  CG.planFacts = planFacts;

  // ---------------- PREMIUM ----------------
  screens.premium = {
    fit: 'both',
    html: (p) => `
      <div aria-hidden="true" class="pr-bowl" style="position:absolute;left:0;top:0;width:390px;height:250px;overflow:hidden">
        <div style="position:absolute;left:-40px;right:-40px;top:-225px;height:420px;border-radius:50%;background:radial-gradient(closest-side,rgba(120,88,30,.14) 0,rgba(190,140,52,.30) 62%,rgba(170,124,44,.2) 70%,rgba(100,72,24,.07) 84%,transparent)"></div>
        <div class="pb on" style="position:absolute;left:45px;top:-165px;display:block;transform:scale(${300 / 196});transform-origin:0 0;cursor:default">${halo({ icon: false })}</div>
        <div style="position:absolute;left:0;right:0;bottom:0;height:90px;background:linear-gradient(180deg,rgba(11,10,8,0),#0B0A08)"></div>
      </div>
      ${p.from ? `<button type="button" aria-label="بستن" class="js-close" style="position:absolute;right:14px;top:56px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;z-index:5">${I.close}</button>` : ''}
      <h1 class="title-grad pr-h1" style="position:absolute;right:21px;top:190px;margin:0;font-size:32px;line-height:42px">اشتراک ویژه‌ی Cloud Gold</h1>
      <ul class="pr-perks" style="position:absolute;right:21px;top:254px;margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:20px">
        ${['دسترسی آزاد به همه‌ی سایت‌ها و اپ‌ها', 'اتصال هوشمند به سریع‌ترین سرور', 'سرعت بالا و اتصال پایدار'].map((t) => `<li style="display:flex;align-items:center;gap:11px;height:24px"><span aria-hidden="true" style="width:24px;height:24px;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(214,174,92,.55);display:flex;align-items:center;justify-content:center;flex-shrink:0">${I.check.replace('stroke="#F2EADB"', 'stroke="#E8C77A"')}</span><span style="font-size:15px;font-weight:500;line-height:20px;color:#E6DCC8">${t}</span></li>`).join('')}
      </ul>
      <div role="radiogroup" aria-label="انتخاب پلن" class="pr-plans" style="position:absolute;left:20px;top:390px;width:350px;display:flex;flex-direction:column;gap:24px">
        ${[0, 1, 2].map(() => '<div class="skeleton" style="height:70px;border-radius:20px"></div>').join('')}
      </div>
      <button type="button" class="pill-btn white pr-cta" style="position:absolute;left:20px;top:calc(var(--sh) - 145px);width:350px;font-size:16px">ادامه</button>
      <div style="position:absolute;left:0;top:calc(var(--sh) - 83px);width:390px;display:flex;justify-content:center;align-items:center;gap:12px;font-size:11.3px;font-weight:500">
        <button type="button" class="pr-support" style="color:var(--bullion);padding:4px 0">سؤال داری؟ پیام به پشتیبانی</button>
        <span aria-hidden="true" style="width:3px;height:3px;border-radius:50%;background:var(--dim)"></span>
        <button type="button" class="pr-orders" style="color:var(--bullion);padding:4px 0">پرداخت‌های من</button>
      </div>`,
    mount(root, p) {
      const $ = (c) => root.querySelector(c);
      const c = $('.js-close'); if (c) c.onclick = () => back('home');
      $('.pr-support').onclick = openSupport;
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
        if (!plans.length) { $('.pr-plans').innerHTML = '<p style="color:var(--body);text-align:center">فعلاً پلنی برای فروش نیست. کمی بعد دوباره سر بزن.</p>'; return; }
        if (sel < 0) { sel = plans.findIndex((x) => x.badge); if (sel < 0) sel = 0; }
        place();
        $('.pr-plans').innerHTML = plans.slice(0, 4).map((pl, i) => {
          const onn = i === sel, hasOld = pl.old_price_toman > pl.price_toman, trial = onn && pl.trial_days > 0 && trialOk();
          const months = Math.max(1, Math.round(pl.duration_days / 30));
          const right = months > 1 ? `ماهی ${toman(pl.monthly_toman)} ت` : `${toman(pl.price_toman)} تومان`;
          const h = hasOld ? (trial ? 97 : 71) : trial ? 90 : 70;
          return `<div style="position:relative">
            ${pl.badge ? `<div class="badge" style="z-index:2">${esc(pl.badge)}</div>` : ''}
            <button type="button" role="radio" aria-checked="${onn}" data-i="${i}" class="plan-card${onn ? ' on' : ''}" style="height:${h}px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
                <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
                  <span style="font-size:${onn ? 17 : 15.5}px;font-weight:${onn ? 700 : 500};line-height:22px;color:${onn ? 'var(--gilt)' : 'var(--ivory)'}">${esc(pl.name)}</span>
                  ${hasOld ? `<span style="font-size:13.5px;font-weight:500;line-height:18px"><s style="color:var(--dim);font-weight:400">${toman(pl.old_price_toman)}</s>  ${toman(pl.price_toman)} تومان</span>` : `<span style="font-size:12.5px;line-height:18px;color:var(--ash)">${planFacts(pl)}</span>`}
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
                  <span class="serif" style="font-size:${onn ? 22 : 19}px;font-weight:600;line-height:24px;color:${onn ? 'var(--gilt)' : 'var(--ivory)'}">${right}</span>
                  ${hasOld ? `<span style="font-size:12px;font-weight:600;line-height:18px;color:var(--jade)">${faNum(pl.save_percent)}٪ تخفیف</span>` : ''}
                </div>
              </div>
              ${trial ? `<div style="margin-top:9px;font-size:14px;font-weight:600;line-height:20px;color:var(--gilt)">${faNum(pl.trial_days)} روز تست رایگان؛ اگر راضی بودی بخر.</div>` : ''}
            </button></div>`;
        }).join('');
        root.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => { sel = +b.dataset.i; draw(); }; });
        const pl = plans[sel];
        $('.pr-cta').textContent = pl && pl.trial_days > 0 && trialOk() ? `شروع ${faNum(pl.trial_days)} روز تست رایگان` : (S.me && S.me.subscription ? 'تمدید با این پلن' : 'خرید این پلن');
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
            try { await syncVpn(); } catch (e) { /* servers load again on home */ }
            go('success', { title: 'تست رایگان فعال شد', text: `${faNum(pl.trial_days)} روز اشتراک ویژه برایت فعال شد. دکمه‌ی اتصال را بزن.` });
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
    const cfg = S.config || {};
    const bal = S.me ? S.me.wallet_balance : 0;
    const plan = what.plan;
    let coupon = null; // {code, final_toman, percent}
    const price = () => (plan ? (coupon ? coupon.final_toman : plan.price_toman) : what.topup);
    const online = [];
    if (cfg.card_enabled) online.push({ id: 'card', icon: I.card, name: 'کارت‌به‌کارت', note: 'واریز کن و عکس رسید را بفرست' });
    const coins = cfg.coins || [];
    if (coins.length) online.push({ id: 'coin', icon: I.crypto, name: 'ارز دیجیتال', note: coins.slice(0, 3).map((c) => c.fa).join('، ') + (coins.length > 3 ? ' و ...' : '') });
    if (cfg.crypto_enabled) online.push({ id: 'crypto', icon: I.crypto, name: 'درگاه کریپتو', note: 'بعد از پرداخت خودکار فعال می‌شود' });
    if (!plan && !online.length) { toast('الان هیچ روش پرداختی فعال نیست. با پشتیبانی تماس بگیر.', true); return; }
    function methods() {
      const amount = price(), out = [];
      if (plan) {
        if (bal >= amount) out.push({ id: 'wallet', icon: I.wallet, name: 'کیف پول', note: `موجودی ${toman(bal)} تومان` });
        else if (bal > 0 && online.length) out.push({ id: 'mix', icon: I.wallet, name: 'کیف پول + پرداخت مابقی', note: `${toman(bal)} از کیف پول، ${toman(amount - bal)} تومان را بپرداز` });
        else out.push({ id: 'wallet', icon: I.wallet, name: 'کیف پول', note: `موجودی ${toman(bal)} تومان · کافی نیست`, off: true });
      }
      return out.concat(online);
    }
    let pick = null, mixVia = online[0] && online[0].id, coinPick = coins[0] && coins[0].id;
    const body = (el) => {
      const ms = methods(), amount = price();
      if (!ms.find((m) => m.id === pick && !m.off)) pick = (ms.find((m) => !m.off) || {}).id;
      const showVia = pick === 'mix' && online.length > 1;
      el.querySelector('.pm-price').innerHTML = plan
        ? `${coupon ? `<s style="color:var(--dim)">${toman(plan.price_toman)}</s> ` : ''}<b style="color:var(--gilt)">${toman(amount)} تومان</b> · ${planFacts(plan)}`
        : `<b style="color:var(--gilt)">${toman(amount)} تومان</b>`;
      el.querySelector('.pm-list').innerHTML = ms.map((m) => `<button type="button" class="method${m.id === pick ? ' on' : ''}" data-m="${m.id}" ${m.off ? 'disabled style="opacity:.45"' : ''}><span class="mi">${m.icon}</span><span style="min-width:0"><b>${m.name}</b><span>${m.note}</span></span></button>`).join('')
        + (showVia ? `<div style="display:flex;gap:8px;margin:-2px 0 10px">${online.map((o) => `<button type="button" class="method${o.id === mixVia ? ' on' : ''}" data-via="${o.id}" style="margin:0;padding:10px;justify-content:center;font-size:13px">${o.name.split(' ')[0]}</button>`).join('')}</div>` : '')
        + (pick === 'coin' || (pick === 'mix' && mixVia === 'coin') ? `<div class="coin-grid">${coins.map((c) => `<button type="button" class="coin-chip${c.id === coinPick ? ' on' : ''}" data-coin="${c.id}">${coinBadge(c, 30)}<b>${c.symbol}${c.auto ? ' <em class="auto-dot" title="تأیید خودکار">⚡</em>' : ''}</b><span>${esc(c.fa)}</span></button>`).join('')}</div><p class="muted" style="font-size:11.5px;margin:-4px 0 12px;text-align:center;line-height:18px">همه کارمزد انتقال خیلی کمی دارند${coins.some((c) => c.auto) ? ' · ⚡ یعنی بعد از واریز، خودکار و در حد یک دقیقه فعال می‌شود' : ''}</p>` : '');
      const due = pick === 'mix' ? amount - bal : pick === 'wallet' || amount === 0 ? 0 : amount;
      el.querySelector('.pm-go').textContent = !pick ? 'روش پرداخت را انتخاب کن' : due === 0 ? (amount === 0 ? 'فعال‌سازی رایگان' : `پرداخت ${toman(amount)} تومان از کیف پول`) : `پرداخت ${toman(due)} تومان`;
      el.querySelector('.pm-go').disabled = !pick;
      el.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => { pick = b.dataset.m; body(el); }; });
      el.querySelectorAll('[data-via]').forEach((b) => { b.onclick = () => { mixVia = b.dataset.via; body(el); }; });
      el.querySelectorAll('[data-coin]').forEach((b) => { b.onclick = () => { coinPick = b.dataset.coin; body(el); }; });
    };
    sheet(`<h3>${plan ? 'خرید پلن ' + esc(plan.name) : 'شارژ کیف پول'}</h3>
      <p class="pm-price"></p>
      ${plan ? `<div class="coupon-row"><input class="input pm-code" dir="ltr" autocapitalize="characters" autocomplete="off" placeholder="کد تخفیف (اختیاری)"><button type="button" class="pm-apply">اعمال</button></div><div class="err pm-cerr" style="margin-top:-6px"></div>` : ''}
      <div class="pm-list"></div>
      <div style="height:6px"></div><button type="button" class="pill-btn white pm-go">پرداخت</button>`, (el, close) => {
      body(el);
      const apply = el.querySelector('.pm-apply');
      if (apply) apply.onclick = async () => {
        const code = el.querySelector('.pm-code').value.trim();
        const cerr = el.querySelector('.pm-cerr');
        cerr.textContent = '';
        if (!code) { coupon = null; body(el); return; }
        busyButton(apply, true, true);
        try { coupon = await api('POST', '/coupons/check', { code, plan_id: plan.id }); cerr.style.color = '#8FCFA4'; cerr.textContent = `${faNum(coupon.percent)}٪ تخفیف اعمال شد.`; }
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
      go('success', { title: 'اشتراکت فعال شد', text: `${esc(planName || 'پلن')} فعال است. دکمه‌ی اتصال را بزن و وصل شو.` });
    } else if (order.activate_plan_id) {
      go('success', { title: 'کیف پول شارژ شد', text: `${toman(order.amount_toman)} تومان به کیف پولت اضافه شد ولی فعال‌سازی خودکار پلن انجام نشد. از صفحه‌ی خرید، پلن را با کیف پول بخر یا با پشتیبانی تماس بگیر.`, to: 'wallet' });
    } else {
      go('success', { title: 'کیف پول شارژ شد', text: `${toman(order.amount_toman)} تومان به کیف پولت اضافه شد.`, to: 'wallet' });
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
      <button type="button" class="pill-btn white js-done" style="position:absolute;left:20px;width:350px;top:calc(var(--sh) - 110px)">${p.to === 'wallet' ? 'بازگشت به کیف پول' : 'برو به صفحه‌ی اصلی'}</button>`,
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
        <div class="pay-brand"><span class="pay-logo">${I.card}</span><span><b>Cloud Gold Pay</b><span>کارت‌به‌کارت امن</span></span>
          <span class="pay-lock"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8FCFA4" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>امن</span></div>
        <div class="pay-steps">${['واریز', c.auto ? 'شناسایی خودکار' : 'ارسال رسید', 'بررسی', 'فعال‌سازی'].map((t, i) => `<div class="pay-step${i === 0 ? ' now' : ''}"><i>${faNum(i + 1)}</i><span>${t}</span></div>`).join('<b></b>')}</div>

        <div class="bank-card" style="background:linear-gradient(135deg,${esc(c.color1 || '#3A3020')} 0%,${esc(c.color2 || '#14110C')} 100%)">
          <span class="bank-glare"></span>
          <div class="bank-top"><b>${c.bank ? 'بانک ' + esc(c.bank.replace(/^بانک\s*/, '')) : 'کارت مقصد'}</b><span class="bank-shetab">شتاب</span></div>
          <div class="bank-chip">${CHIP}</div>
          <div class="bank-num ltr">${esc(fmtCard(c.number))}</div>
          <div class="bank-bottom"><span>${esc(c.holder || '')}</span><button type="button" class="bank-copy js-copy" aria-label="کپی شماره کارت">${I.copy}<span>کپی</span></button></div>
        </div>

        <div class="pay-card" style="margin-top:16px">
          <span class="muted" style="font-size:12.5px">مبلغ دقیق واریز</span>
          <div class="card-amount">${amtHtml} <small>تومان</small></div>
          <div class="card-rial"><span>= <b class="ltr">${esc((c.amount_rial || o.amount_toman * 10).toLocaleString('fa-IR'))}</b> ریال</span>
            <button type="button" class="icon-btn glass js-copy-rial" aria-label="کپی مبلغ به ریال">${I.copy}</button></div>
          ${odd ? `<div class="pay-warn" style="margin:14px 0 0"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F3DDA0" stroke-width="2" stroke-linecap="round"><path d="M12 3l10 18H2zM12 10v5M12 18h.01"/></svg><span><b>دقیقاً همین مبلغ</b> را بفرست، حتی <b>${esc(amt.slice(-3))}</b> تومان آخرش. این‌طوری پرداختت بدون معطلی شناسایی می‌شود. (بیشتر اپ‌های بانکی مبلغ را به <b>ریال</b> می‌خواهند.)</span></div>` : ''}
          ${c.auto ? `<div class="pay-auto" style="margin:14px 0 0"><span class="pay-auto-pulse"></span><span><b>تأیید خودکار روشن است</b>بعد از واریز، معمولاً در کمتر از یک دقیقه فعال می‌شوی. فرستادن رسید اختیاری است.</span></div>` : ''}
        </div>

        <label class="field" style="margin-top:16px"><span>شماره پیگیری (اختیاری)</span><input class="input js-ref" dir="ltr" inputmode="numeric" placeholder="123456"></label>
        <button type="button" class="pill-btn ${c.auto ? 'ghost' : 'white'} js-up">${c.auto ? 'ارسال عکس رسید (اختیاری)' : 'ارسال عکس رسید'}</button>
        <div style="height:10px"></div>
        <button type="button" class="pill-btn dark js-cancel">لغو سفارش</button>
        <p class="muted" style="font-size:12px;line-height:19px;margin-top:14px;text-align:center">سفارش #${faNum(o.id)} · ${o.activate_plan_id ? `بعد از تأیید، پلن ${esc(o.activate_plan_name || '')} خودکار فعال می‌شود.` : o.kind === 'plan' ? 'بعد از تأیید پرداخت، اشتراکت خودکار فعال می‌شود.' : 'بعد از تأیید، مبلغ به کیف پولت اضافه می‌شود.'}</p>
      </div></div>`;
    },
    mount(root, p) {
      wireBack(root);
      const o = p.order, c = o.card || {};
      let alive = true, timer = 0;
      root.querySelector('.js-copy').onclick = () => { call('copy', { text: String(c.number || '').replace(/\D/g, '') }); toast('شماره کارت کپی شد'); };
      root.querySelector('.js-copy-rial').onclick = () => { call('copy', { text: String(c.amount_rial || o.amount_toman * 10) }); toast('مبلغ به ریال کپی شد'); };
      root.querySelector('.js-cancel').onclick = () => sheet(`<h3>سفارش لغو شود؟</h3><p>اگر واریز کرده‌ای لغو نکن؛ صبر کن تا تأیید شود یا رسید را بفرست.</p>
        <button class="pill-btn white" data-yes>لغو سفارش</button><div style="height:10px"></div><button class="pill-btn dark" data-no>بازگشت</button>`, (el, close) => {
        el.querySelector('[data-no]').onclick = close;
        el.querySelector('[data-yes]').onclick = async () => { close(); try { await api('POST', `/orders/${o.id}/cancel`); toast('سفارش لغو شد'); back('premium'); } catch (e) { toast(e.message, true); } };
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
        } catch (e) { toast(e.message || 'ارسال ناموفق بود.', true); } finally { if (document.body.contains(btn)) busyButton(btn, false); }
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
          h = `${icon('#F3DDA0', 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z')}<h1 class="title-grad" style="margin-top:28px">در انتظار پرداخت</h1>
            <p style="color:var(--body);font-size:15px;line-height:25px">پرداخت را در صفحه‌ی کریپتو تمام کن. وقتی شبکه تأیید کند (معمولاً چند دقیقه) این صفحه خودش به‌روز می‌شود.</p>
            <div style="height:14px"></div><button class="pill-btn white js-open">باز کردن صفحه‌ی پرداخت</button><div style="height:10px"></div><button class="pill-btn dark js-cancel">لغو سفارش</button>`;
        } else if (o.status === 'pending') {
          h = `<h1 class="title-grad">رسید لازم است</h1><p style="color:var(--body)">برای ادامه، عکس رسید واریز را بفرست.</p><button class="pill-btn white js-card">ادامه</button>`;
        } else if (o.status === 'review') {
          h = `${icon('#E8C77A', 'M9 12l2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z')}<h1 class="title-grad" style="margin-top:28px">رسید دریافت شد</h1>
            <p style="color:var(--body);font-size:15px;line-height:25px">در حال بررسی واریز هستیم. بعد از تأیید، ${o.kind === 'topup' && !o.activate_plan_id ? 'کیف پولت شارژ می‌شود' : 'اشتراکت خودکار فعال می‌شود'}. می‌توانی اپ را ببندی؛ وقتی برگردی همه‌چیز آماده است.</p>
            <div style="height:14px"></div><button class="pill-btn dark js-home">بازگشت به صفحه‌ی اصلی</button>`;
        } else if (o.status === 'rejected') {
          h = `${icon('#E2715C', 'M15 9l-6 6M9 9l6 6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z')}<h1 class="title-grad" style="margin-top:28px">رسید تأیید نشد</h1>
            <p style="color:var(--body);font-size:15px;line-height:25px">${esc(o.admin_note || 'این رسید با واریزی مطابقت نداشت.')}</p>
            <div style="height:14px"></div><button class="pill-btn white js-card">ارسال رسید دیگر</button><div style="height:10px"></div><button class="pill-btn dark js-support">پیام به پشتیبانی</button>`;
        } else {
          h = `${icon('#A39783', 'M12 8v4M12 16h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z')}<h1 class="title-grad" style="margin-top:28px">${{ cancelled: 'سفارش لغو شد', expired: 'مهلت سفارش تمام شد' }[o.status] || 'سفارش بسته شد'}</h1>
            <p style="color:var(--body)">این سفارش بسته شده. هر وقت خواستی سفارش جدید ثبت کن.</p><div style="height:14px"></div><button class="pill-btn white js-plans">دیدن پلن‌ها</button>`;
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
    html: () => `${backBtn()}<div class="scroll"><div class="page enter"><h1 class="title-grad">پرداخت‌های من</h1><div class="panel js-list"><div class="skeleton" style="height:48px"></div></div></div></div>`,
    mount(root) {
      wireBack(root, 'premium');
      const label = { pending: 'در انتظار پرداخت', review: 'در حال بررسی', paid: 'پرداخت شده', rejected: 'رد شده', cancelled: 'لغو شده', expired: 'منقضی' };
      const mlabel = { card: 'کارت‌به‌کارت', wallet: 'کیف پول', crypto: 'کریپتو', coin: 'ارز دیجیتال' };
      const color = { paid: '#8FCFA4', review: '#E8C77A', rejected: '#E2715C', pending: '#F3DDA0' };
      api('GET', '/orders').then((rows) => {
        const el = root.querySelector('.js-list');
        if (!rows.length) { el.innerHTML = '<p class="muted" style="margin:0 0 14px;text-align:center;line-height:22px">هنوز پرداختی نداشته‌ای. با خرید اولین پلن، رسیدش اینجا می‌ماند.</p><button type="button" class="pill-btn dark js-buy" style="height:44px;font-size:14px">دیدن پلن‌ها</button>'; el.querySelector('.js-buy').onclick = () => go('premium', { from: 'orders' }); return; }
        el.innerHTML = rows.map((o) => `<button type="button" class="row-line" data-id="${o.id}" style="width:100%">
          <span><b style="font-weight:500">${o.kind === 'plan' ? esc(o.plan_name || 'پلن') : o.activate_plan_id ? 'شارژ و خرید ' + esc(o.activate_plan_name || '') : 'شارژ کیف پول'}</b><br><span class="muted" style="font-size:12px">#${faNum(o.id)} · ${mlabel[o.method] || o.method} · ${faDate(o.created_at)}</span></span>
          <span style="text-align:left"><span class="serif" style="font-size:18px;color:var(--ivory)">${toman(o.amount_toman)}</span> <span class="muted" style="font-size:12px">تومان</span><br><span style="font-size:12px;color:${color[o.status] || '#8F8676'}">${label[o.status] || o.status}</span></span></button>`).join('');
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
      <h1 class="title-grad">کیف پول</h1>
      <div class="panel" style="text-align:center;padding:26px 20px">
        <div class="muted" style="font-size:13px">موجودی</div>
        <div class="js-bal serif" style="font-size:48px;font-weight:600;line-height:58px;margin-top:4px;color:var(--gilt)">${toman(S.me ? S.me.wallet_balance : 0)} <span style="font-size:20px;font-weight:500;color:var(--body)">تومان</span></div>
        <div class="muted" style="font-size:12.5px;margin-top:6px">با کیف پول پلن را فوری بخر. پاداش دعوت دوستان هم اینجا می‌آید.</div>
      </div>
      <h2 style="font-size:17px;font-weight:500;margin:26px 0 12px">شارژ کیف پول</h2>
      <div class="js-chips" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px"></div>
      <label class="field" style="margin-top:12px"><span>یا مبلغ دلخواه (تومان)</span><input class="input js-amt" inputmode="numeric" placeholder="۳۰۰٬۰۰۰"></label>
      <button type="button" class="pill-btn white js-top">شارژ</button>
      <h2 style="font-size:17px;font-weight:500;margin:28px 0 8px">تراکنش‌ها</h2>
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
        if (!v) return toast('یک مبلغ انتخاب یا وارد کن.', true);
        if (v < min) return toast(`حداقل مبلغ شارژ ${toman(min)} تومان است.`, true);
        payFor({ topup: v });
      };
      const reasons = { topup: 'شارژ', purchase: 'خرید پلن', referral: 'پاداش دعوت', refund: 'بازگشت وجه', admin: 'اصلاح توسط پشتیبانی' };
      api('GET', '/wallet').then((w) => {
        root.querySelector('.js-bal').innerHTML = `${toman(w.balance)} <span style="font-size:20px;font-weight:500;color:var(--body)">تومان</span>`;
        if (S.me) S.me.wallet_balance = w.balance;
        const el = root.querySelector('.js-tx');
        el.innerHTML = w.transactions.length ? w.transactions.map((t) => `<div class="row-line"><span>${esc(reasons[t.reason] || t.reason)}<br><span class="muted" style="font-size:12px">${faDate(t.created_at)}${t.note ? ' · ' + esc(t.note) : ''}</span></span>
          <span class="ltr" style="color:${t.amount >= 0 ? '#8FCFA4' : '#F2EADB'};font-size:15px;font-weight:600">${t.amount >= 0 ? '+' : '−'}${toman(Math.abs(t.amount))}</span></div>`).join('') : '<p class="muted" style="margin:14px 0;text-align:center">هنوز تراکنشی نداری.</p>';
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
        <h1 class="title-grad" style="margin:0;font-size:44px;line-height:54px">دعوت دوستان<br>و کسب پاداش</h1>
        <p class="js-pct" style="margin:16px 26px 0;font-size:14.5px;line-height:23px;color:var(--body)">از هر خرید دوستانت پاداش بگیر</p>
        <p class="js-stats" style="margin:8px 0 0;font-size:13px;color:var(--gilt)"></p>
      </div>
      <div style="position:absolute;left:20px;top:calc(var(--sh) - 198px);width:350px;display:flex;flex-direction:column;gap:12px">
        <div style="height:58px;border-radius:18px;border:1px dashed rgba(214,174,92,.45);background:#13110D;display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 18px">
          <span style="font-size:13px;color:var(--ash)">کد تو</span>
          <span class="js-code ltr" style="font-size:19px;font-weight:700;letter-spacing:3px;color:var(--gilt)">·······</span>
          <button type="button" class="js-copy" style="height:40px;padding:0 16px;border-radius:13px;background:rgba(214,174,92,.12);color:var(--gilt);font-size:14px;font-weight:600">کپی</button>
        </div>
        <button type="button" class="pill-btn white js-share" style="font-size:16px">ارسال دعوت</button>
      </div>`,
    mount(root) {
      wireBack(root);
      let ref = null;
      api('GET', '/referral').then((r) => {
        ref = r;
        root.querySelector('.js-code').textContent = r.code;
        if (r.percent) root.querySelector('.js-pct').textContent = `${faNum(r.percent)}٪ از مبلغ هر خرید دوستانت به کیف پولت اضافه می‌شود`;
        root.querySelector('.js-stats').textContent = `${faNum(r.invited)} دوست عضو شده · ${toman(r.earned_toman)} تومان پاداش`;
      }).catch((e) => toast(e.message, true));
      const copy = root.querySelector('.js-copy');
      copy.onclick = () => { if (!ref) return; call('copy', { text: ref.code }); copy.textContent = 'کپی شد'; setTimeout(() => { copy.textContent = 'کپی'; }, 1600); };
      root.querySelector('.js-share').onclick = () => { if (ref) call('share', { text: `${ref.share_text}. موقع ثبت‌نام کد را وارد کن.` }); };
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
    return `<svg width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" role="img" aria-label="QR آدرس ولت"><defs><linearGradient id="qrG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE7A3"/><stop offset=".55" stop-color="#E9B949"/><stop offset="1" stop-color="#B9832A"/></linearGradient></defs>
      <rect width="${px}" height="${px}" rx="22" fill="#0E0C09"/><g fill="url(#qrG)">${dots}</g>${eye(0, 0)}${eye(0, n - 7)}${eye(n - 7, 0)}</svg>`;
  }

  const COIN_STEPS = ['ارسال ارز', 'ثبت پرداخت', 'تأیید شبکه', 'فعال‌سازی'];
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
        return `<div class="pay-brand"><span class="pay-logo">${I.gem}</span><span><b>Cloud Gold Pay</b><span>پرداخت امن با ارز دیجیتال</span></span>
          <span class="pay-lock"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8FCFA4" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>امن</span></div>`;
      }
      function steps(cur) {
        return `<div class="pay-steps">${COIN_STEPS.map((t, i) => `<div class="pay-step${i < cur ? ' done' : i === cur ? ' now' : ''}"><i>${i < cur ? I.check : faNum(i + 1)}</i><span>${t}</span></div>`).join('<b></b>')}</div>`;
      }
      function txBox(label) {
        return `<label class="field" style="margin-top:16px"><span>${label}</span><input class="input js-tx" dir="ltr" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="TXID / Hash" value="${esc(o.txid || '')}" style="font-family:monospace;font-size:13.5px"></label><div class="err js-txerr"></div>`;
      }

      function render() {
        const c = o.coin;
        if (!c) { body.innerHTML = '<p class="muted" style="text-align:center">این سفارش پرداخت ارز دیجیتال نیست.</p>'; return; }
        const key = o.status + '|' + (o.txid || '') + '|' + (o.admin_note || '');
        if (key === lastKey) return;
        lastKey = key;
        if (o.status === 'paid') { alive = false; afterPaid(o); return; }
        let h = head(c);
        if (o.status === 'pending') {
          h += steps(0) + `
            <div class="pay-card">
              <div class="pay-amount-row">${coinBadge(c, 44)}<div style="flex:1;min-width:0"><span class="muted" style="font-size:12.5px">مبلغ قابل پرداخت</span>
                <div class="pay-amount ltr"><b>${esc(c.amount)}</b> ${esc(c.symbol)}</div><span class="muted" style="font-size:12px">≈ ${toman(o.amount_toman)} تومان</span></div>
                <button type="button" class="icon-btn glass js-copy-amt" aria-label="کپی مبلغ">${I.copy}</button></div>
              <div class="pay-warn"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F3DDA0" stroke-width="2" stroke-linecap="round"><path d="M12 3l10 18H2zM12 10v5M12 18h.01"/></svg><span>فقط روی شبکه‌ی <b>${esc(c.network)}</b> و <b>دقیقاً همین مبلغ</b> را بفرست${c.memo ? `، و <b>${esc(c.memo_label)}</b> را حتماً وارد کن` : ''}.</span></div>
              <div class="pay-fee"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8FCFA4" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>کارمزد شبکه: <b>${esc(c.fee || 'کم')}</b></div>
              ${c.auto ? `<div class="pay-auto"><span class="pay-auto-pulse"></span><span><b>تأیید خودکار روشن است</b>بعد از واریز، شبکه خودکار بررسی می‌شود و معمولاً در کمتر از یک دقیقه فعال می‌شوی. لازم نیست کاری بکنی.</span></div>` : ''}
              <div class="pay-qr">${qrSvg(c.address, 208)}<span class="pay-qr-logo">${coinBadge(c, 40)}</span></div>
              <span class="muted" style="font-size:12.5px;display:block;margin-top:14px">آدرس ولت ${esc(c.fa)}</span>
              <div class="pay-addr"><span class="ltr">${esc(c.address)}</span><button type="button" class="icon-btn glass js-copy-addr" aria-label="کپی آدرس">${I.copy}</button></div>
              ${c.memo ? `<span style="font-size:12.5px;display:block;margin-top:14px;color:#EE9A86"><b>${esc(c.memo_label)}</b> · بدون آن واریز به حساب نمی‌نشیند</span>
              <div class="pay-addr pay-memo"><span class="ltr">${esc(c.memo)}</span><button type="button" class="icon-btn glass js-copy-memo" aria-label="کپی ${esc(c.memo_label)}">${I.copy}</button></div>` : ''}
              <div class="pay-timer"><svg width="38" height="38" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="none" stroke="rgba(214,174,92,.14)" stroke-width="3"/><circle class="js-ring" cx="20" cy="20" r="17" fill="none" stroke="url(#tmG)" stroke-width="3" stroke-linecap="round" stroke-dasharray="106.8" transform="rotate(-90 20 20)"/><defs><linearGradient id="tmG"><stop offset="0" stop-color="#FFE7A3"/><stop offset="1" stop-color="#E9B949"/></linearGradient></defs></svg>
                <span><b class="js-left ltr">--:--</b><span class="muted" style="font-size:12px;display:block">قیمت تا این زمان برایت قفل است</span></span></div>
            </div>
            ${c.auto ? '' : txBox('هش تراکنش (اختیاری؛ تأیید را سریع‌تر می‌کند)')}
            <button type="button" class="pill-btn gold js-paid">${c.auto ? 'پرداخت کردم (اختیاری)' : 'پرداخت کردم'}</button>
            <div style="height:10px"></div><button type="button" class="pill-btn dark js-cancel">لغو سفارش</button>
            <p class="muted" style="font-size:12px;line-height:19px;text-align:center;margin-top:14px">سفارش #${faNum(o.id)} · بعد از تأیید شبکه، ${o.kind === 'topup' && !o.activate_plan_id ? 'کیف پولت خودکار شارژ می‌شود' : 'اشتراکت خودکار فعال می‌شود'}.</p>`;
        } else if (o.status === 'review') {
          h += steps(2) + `
            <div class="pay-card" style="text-align:center;padding:30px 20px">
              <div class="pay-verify">${coinBadge(c, 64)}<span></span><span></span></div>
              <h2 style="margin:22px 0 8px;font-size:20px;font-weight:600">در حال تأیید تراکنش</h2>
              <p style="color:var(--body);font-size:14px;line-height:24px;margin:0">پرداخت <b class="ltr" style="color:var(--gilt)">${esc(c.amount)} ${esc(c.symbol)}</b> روی شبکه‌ی ${esc(c.network)} در حال بررسی است. بعد از تأیید، ${o.kind === 'topup' && !o.activate_plan_id ? 'کیف پولت شارژ می‌شود' : 'اشتراکت خودکار فعال می‌شود'}؛ این صفحه خودش به‌روز می‌شود.</p>
              ${o.txid ? `<div class="pay-tx ltr">${esc(shortTx(o.txid))}</div>` : ''}
            </div>
            ${o.txid ? '' : txBox('اگر هش تراکنش را داری، اینجا بفرست تا سریع‌تر تأیید شود') + '<button type="button" class="pill-btn dark js-paid">ارسال هش تراکنش</button>'}
            <div style="height:10px"></div><button type="button" class="pill-btn ghost js-home">بازگشت به صفحه‌ی اصلی</button>`;
        } else if (o.status === 'expired' || o.status === 'rejected') {
          const exp = o.status === 'expired';
          h += `<div class="pay-card" style="text-align:center;padding:28px 20px">
              <div class="pay-verify off">${coinBadge(c, 56)}</div>
              <h2 style="margin:20px 0 8px;font-size:20px;font-weight:600">${exp ? 'زمان قیمت قفل‌شده تمام شد' : 'واریز تأیید نشد'}</h2>
              <p style="color:var(--body);font-size:14px;line-height:24px;margin:0">${exp ? 'اگر هنوز چیزی نفرستاده‌ای، یک سفارش تازه با قیمت جدید بساز. اگر فرستاده‌ای، هش تراکنش را بفرست تا بررسی کنیم.' : esc(o.admin_note || 'واریزی با این مشخصات پیدا نشد.')}</p>
            </div>
            ${txBox('هش تراکنش')}
            <button type="button" class="pill-btn white js-paid">${exp ? 'پرداخت کرده‌ام، بررسی کنید' : 'ارسال دوباره‌ی هش'}</button>
            <div style="height:10px"></div><button type="button" class="pill-btn dark js-new">سفارش جدید</button>
            <div style="height:10px"></div><button type="button" class="pill-btn ghost js-support">پیام به پشتیبانی</button>`;
        } else {
          h += `<p class="muted" style="text-align:center">این سفارش بسته شده است.</p><button type="button" class="pill-btn white js-new">سفارش جدید</button>`;
        }
        body.innerHTML = h;
        bind();
        timer();
      }

      function bind() {
        const b = (sel, fn) => { const el = body.querySelector(sel); if (el) el.onclick = fn; };
        const c = o.coin;
        b('.js-copy-amt', () => { call('copy', { text: c.amount }); toast('مبلغ کپی شد'); });
        b('.js-copy-addr', () => { call('copy', { text: c.address }); toast('آدرس ولت کپی شد'); });
        b('.js-copy-memo', () => { call('copy', { text: c.memo }); toast(`${c.memo_label} کپی شد`); });
        b('.js-home', () => reset('home'));
        b('.js-support', openSupport);
        b('.js-new', () => { reset('home'); go('premium', { from: 'home' }); });
        b('.js-cancel', () => sheet(`<h3>سفارش لغو شود؟</h3><p>اگر ارز را فرستاده‌ای، لغو نکن؛ «پرداخت کردم» را بزن.</p>
          <button class="pill-btn white" data-yes>لغو سفارش</button><div style="height:10px"></div><button class="pill-btn dark" data-no>بازگشت</button>`, (el, close) => {
          el.querySelector('[data-no]').onclick = close;
          el.querySelector('[data-yes]').onclick = async () => { close(); try { await api('POST', `/orders/${o.id}/cancel`); toast('سفارش لغو شد'); back('premium'); } catch (e) { toast(e.message, true); } };
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

  // ---------------- CONNECTION SETTINGS (sheet) ----------------
  CG.connSettings = function (after) {
    sheet(`<h3>تنظیمات اتصال</h3><p>این تنظیمات برای بهترین کیفیت اتصال از قبل روشن شده‌اند.</p>
      <div class="panel" style="padding:4px 16px;margin-bottom:14px">
        <button type="button" class="row-line js-auto" style="width:100%;gap:12px"><span style="flex:1"><b style="font-weight:500">اتصال هوشمند</b><br><span class="muted" style="font-size:12px">سریع‌ترین سرور خودکار انتخاب می‌شود و اگر جواب نداد، سرور بعدی</span></span><span class="switch${S.auto ? ' on' : ''}"></span></button>
        <button type="button" class="row-line js-gmode" style="width:100%;gap:12px"><span style="flex:1"><b style="font-weight:500"><span class="g-dot" style="display:inline-block;margin-inline-end:6px"></span>حالت گوگل و Gemini</b><br><span class="muted" style="font-size:12px">فقط به سرورهایی وصل شو که گوگل آن‌ها را ایران نمی‌بیند و Gemini روی‌شان باز است</span></span><span class="switch${S.googleMode ? ' on' : ''}"></span></button>
        <button type="button" class="row-line js-iran" style="width:100%;gap:12px"><span style="flex:1"><b style="font-weight:500">سایت‌های ایرانی بدون VPN</b><br><span class="muted" style="font-size:12px">بانک‌ها و سایت‌های داخلی سریع‌تر باز می‌شوند و از حجم اشتراکت کم نمی‌شود</span></span><span class="switch"></span></button>
      </div>
      <button type="button" class="row-line js-kill" style="width:100%;gap:12px;margin:-6px 0 14px;padding:14px 16px;border-radius:18px;background:rgba(226,113,92,.06);border:1px solid rgba(226,113,92,.22)"><span style="flex:1"><b style="font-weight:500">Kill Switch: اینترنت بدون VPN قطع شود</b><br><span class="muted" style="font-size:12px">اگر VPN قطع شد، IP واقعی‌ات لو نرود</span></span><span>‹</span></button>
      <div class="js-isp muted" style="font-size:12px;text-align:center;margin:-4px 0 6px;line-height:19px"></div>
      <div class="js-leak" style="font-size:11.5px;text-align:center;margin:0 0 12px;color:#8FCFA4;line-height:18px"></div>
      ${S.vpn.running ? '<button class="pill-btn gold js-gtest" style="margin-bottom:10px">تست گوگل و Gemini روی همین اتصال</button>' : ''}
      <button class="pill-btn white" data-sync>به‌روزرسانی لیست سرورها</button><div style="height:10px"></div>
      <button class="pill-btn dark" data-test>تست سرعت همه‌ی سرورها</button><div style="height:10px"></div>
      <button class="pill-btn ghost" data-adv>تنظیمات پیشرفته (v2rayNG)</button>`, (el, close) => {
      const iranSw = el.querySelector('.js-iran .switch');
      call('getTune', {}).then((t) => {
        iranSw.classList.toggle('on', !!(t && t.iranDirect));
        const box = el.querySelector('.js-leak');
        if (box) box.innerHTML = `🛡 ضد نشت: DNS و WebRTC از داخل تونل · IPv6 ${t && t.ipv6Tunnel ? 'از داخل تونل' : 'مسدود (بدون نشت)'} · QUIC مسدود`;
      }).catch(() => {});
      el.querySelector('.js-auto').onclick = () => { CG.setAuto(!S.auto); el.querySelector('.js-auto .switch').classList.toggle('on', S.auto); toast(S.auto ? 'اتصال هوشمند روشن شد' : 'اتصال هوشمند خاموش شد؛ لوکیشن را خودت انتخاب کن'); if (after) after(); };
      el.querySelector('.js-iran').onclick = async () => {
        const on_ = !iranSw.classList.contains('on');
        iranSw.classList.toggle('on', on_);
        try { await call('setTune', { iranDirect: on_ }); toast(on_ ? 'سایت‌های ایرانی مستقیم باز می‌شوند' : 'همه‌ی ترافیک از VPN عبور می‌کند'); }
        catch (e) { iranSw.classList.toggle('on', !on_); toast(e.message, true); }
      };
      el.querySelector('[data-sync]').onclick = async (ev) => {
        busyButton(ev.currentTarget, true);
        try { const r = await syncVpn(); close(); toast(r && r.stale ? 'به سرور دسترسی نبود؛ لیست قبلی حفظ شد.' : `لیست سرورها به‌روز شد (${faNum(S.servers.length)} سرور)`); if (after) after(); }
        catch (e) { busyButton(ev.currentTarget, false); toast(e.message, true); }
      };
      el.querySelector('[data-test]').onclick = () => { close(); toast('در حال تست سرورها...'); CG.testAll(9000).then(() => { toast('تست تمام شد'); if (after) after(); }); };
      el.querySelector('[data-adv]').onclick = () => { close(); call('advanced', {}); };
      el.querySelector('.js-kill').onclick = () => { close(); killSwitchGuide(); };
      el.querySelector('.js-gmode').onclick = () => {
        CG.setGoogleMode(!S.googleMode);
        el.querySelector('.js-gmode .switch').classList.toggle('on', S.googleMode);
        toast(S.googleMode ? 'حالت گوگل روشن شد: اتصال هوشمند فقط سرورهای سالم برای گوگل را انتخاب می‌کند' : 'حالت گوگل خاموش شد');
        if (after) after();
      };
      const gt = el.querySelector('.js-gtest');
      if (gt) gt.onclick = async () => {
        busyButton(gt, true);
        try { const r = await CG.probeGoogle(true); close(); googleResult(r); }
        catch (e) { busyButton(gt, false); toast(e.message || 'تست انجام نشد.', true); }
      };
      if (CG.ispRank) CG.ispRank().then((r) => {
        const q = CG.quality && S.vpn.running ? CG.quality() : null;
        const box = el.querySelector('.js-isp');
        if (box && r && r.asn) box.textContent = `اینترنت شما: ${r.isp}${r.geo ? ' · ' + r.geo : ''}${q ? ` · کیفیت فعلی ${faNum(q.score)} (${q.label})` : ''} · سرورها بر اساس تجربه‌ی کاربران همین اپراتور در همین استان، در ساعت‌های اخیر مرتب می‌شوند`;
      }).catch(() => {});
    });
  };

  // what Google sees through the connected server, in plain words
  const COUNTRY_FA = (cc) => { try { return new Intl.DisplayNames(['fa'], { type: 'region' }).of(cc); } catch (e) { return cc; } };
  function googleResult(r) {
    if (!r || r.error) { toast(r && r.error === 'no_network' ? 'از این سرور به گوگل دسترسی نبود.' : 'تست انجام نشد؛ دوباره امتحان کن.', true); return; }
    const gcc = r.google_cc, iran = gcc === 'IR';
    const gem = r.gemini === true || (r.gemini == null && gcc && !['IR', 'CN', 'RU', 'KP', 'SY', 'CU', 'BY', 'HK', 'MO'].includes(gcc));
    const good = !iran && !r.google_blocked && gem;
    const row = (k, v, ok) => `<div class="gp-row"><span class="muted">${k}</span><b style="color:${ok === false ? '#EE9A86' : ok ? '#8FCFA4' : '#F2EADB'}">${v}</b></div>`;
    sheet(`<h3>${good ? '✅ این اتصال برای گوگل و Gemini سالم است' : '⚠️ این اتصال برای گوگل مناسب نیست'}</h3>
      <p>${good ? 'گوگل تو را در ' + esc(COUNTRY_FA(gcc) || gcc || '?') + ' می‌بیند، نه ایران.' : iran ? 'گوگل IP این سرور را «ایران» می‌شناسد؛ برای همین Gemini و بعضی سرویس‌ها باز نمی‌شوند.' : r.google_blocked ? 'گوگل این IP را مشکوک می‌داند و کپچا نشان می‌دهد.' : 'Gemini روی این سرور در دسترس نیست.'}</p>
      <div class="panel" style="padding:2px 16px;margin-bottom:14px">
        ${row('IP خروجی', `<span class="ltr">${esc(r.ip || '?')}</span>`)}
        ${row('کشور از دید اینترنت', esc(COUNTRY_FA(r.cc) || r.cc || '?'))}
        ${row('کشور از دید گوگل', esc(COUNTRY_FA(gcc) || gcc || '?'), gcc ? !iran : null)}
        ${row('Gemini', gem ? 'باز است' : 'بسته است', gem)}
        ${row('جست‌وجوی گوگل', r.google_blocked ? 'کپچا / مشکوک' : 'عادی', !r.google_blocked)}
      </div>
      ${good ? '' : '<button class="pill-btn white" data-gclean>وصل شدن به یک سرور سالم برای گوگل</button><div style="height:10px"></div>'}
      <button class="pill-btn dark" data-no>بستن</button>`, (el, close) => {
      el.querySelector('[data-no]').onclick = close;
      const pk = el.querySelector('[data-gclean]');
      if (pk) pk.onclick = () => { close(); CG.setGoogleMode(true); CG.setAuto(true); CG.connect(); };
    });
  }
  CG.googleResult = googleResult;

  // Android's own always-on VPN + "block connections without VPN" is the strongest kill switch there is
  function killSwitchGuide() {
    sheet(`<h3>Kill Switch</h3><p>با این دو گزینه‌ی خود اندروید، اگر VPN به هر دلیلی قطع شود، اینترنت گوشی هم قطع می‌شود تا IP واقعی‌ات لو نرود. VPN هم بعد از ری‌استارت گوشی خودکار وصل می‌شود.</p>
      <ol class="ks-steps">
        <li>دکمه‌ی زیر را بزن تا صفحه‌ی <b>VPN</b> اندروید باز شود.</li>
        <li>کنار <b>Cloud Gold</b> روی آیکن چرخ‌دنده ⚙️ بزن.</li>
        <li><b>VPN همیشه روشن</b> (Always-on VPN) را روشن کن.</li>
        <li><b>مسدود کردن اتصال‌های بدون VPN</b> (Block connections without VPN) را روشن کن.</li>
      </ol>
      <button class="pill-btn white" data-open>باز کردن تنظیمات VPN اندروید</button><div style="height:10px"></div><button class="pill-btn dark" data-no>بعداً</button>`, (el, close) => {
      el.querySelector('[data-no]').onclick = close;
      el.querySelector('[data-open]').onclick = async () => {
        close();
        try { const r = await call('vpnSystemSettings', {}); if (r && r.opened === false) toast('تنظیمات VPN باز نشد؛ از تنظیمات گوشی ← شبکه ← VPN برو.', true); }
        catch (e) { toast('این قابلیت در نسخه‌ی جدید اپ فعال می‌شود.', true); }
      };
    });
  }
  CG.killSwitchGuide = killSwitchGuide;

  // ---------------- ACCOUNT / MY SUBSCRIPTION ----------------
  const fmtBytes = CG.bytes;
  const STATUS_FA = { active: 'فعال', expired: 'تمام شده', limited: 'حجم تمام شده', disabled: 'غیرفعال', on_hold: 'در انتظار شروع', missing: 'پیدا نشد', unknown: 'فعال' };
  function subCard(sub) {
    if (!sub) {
      return `<div style="font-size:12.5px;font-weight:500">اشتراک نداری</div>
        <div style="font-size:14px;margin-top:10px;color:var(--body);line-height:23px">با یک پلن یا تست رایگان، به همه‌ی سرورها وصل شو.</div>
        <button type="button" class="pill-btn white js-renew" style="margin-top:22px;height:44px;font-size:14px">دیدن پلن‌ها</button>`;
    }
    const u = CG.usageInfo(sub);
    const cls = u.level === 2 ? ' bad' : u.level === 1 ? ' warn' : '';
    const timePct = sub.unlimited_time ? 100 : sub.period_days ? Math.max(2, Math.min(100, Math.round((100 * (sub.seconds_left || 0)) / (sub.period_days * 86400)))) : 100;
    const dataPct = sub.unlimited_data ? 100 : sub.data_limit_bytes ? Math.max(2, Math.round((100 * (sub.remaining_bytes || 0)) / sub.data_limit_bytes)) : 100;
    const hrs = sub.seconds_left != null && sub.days_left <= 1 ? Math.floor(sub.seconds_left / 3600) : null;
    return `<div style="display:flex;justify-content:space-between;align-items:center"><span style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--gilt)">${mark(22)}${esc(sub.plan_name || 'Cloud Gold')}</span>
        <span style="font-size:12px;padding:3px 10px;border-radius:10px;color:${sub.active ? '#8FCFA4' : '#EE9A86'};background:${sub.active ? 'rgba(143,207,164,.1)' : 'rgba(226,113,92,.1)'}">${STATUS_FA[sub.status] || sub.status}</span></div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:12px"><span class="serif" style="font-size:58px;font-weight:600;line-height:60px;color:var(--ivory)">${sub.unlimited_time ? '∞' : hrs != null && hrs < 24 && sub.active ? faNum(hrs) : faNum(sub.days_left)}</span>
        <span style="font-size:14px;color:var(--body)">${sub.unlimited_time ? 'زمان نامحدود' : hrs != null && hrs < 24 && sub.active ? 'ساعت مانده' : 'روز مانده'}</span></div>
      ${sub.expires_at ? `<div style="font-size:12.5px;margin-top:2px;color:var(--ash)">تا ${faDate(sub.expires_at)}</div>` : ''}
      <div class="meter${cls}"><i style="width:${timePct}%"></i></div>
      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(214,174,92,.3),transparent);margin:20px 0"></div>
      <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--body)"><span>حجم باقی‌مانده</span><span>${sub.unlimited_data ? 'نامحدود' : fmtBytes(sub.remaining_bytes) + ' از ' + fmtBytes(sub.data_limit_bytes)}</span></div>
      ${sub.unlimited_data ? '' : `<div class="meter${cls}"><i style="width:${dataPct}%"></i></div>`}
      <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--ash);margin-top:12px"><span>مصرف شده</span><span>${fmtBytes(sub.used_bytes)}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--ash);margin-top:8px"><span>تعداد دستگاه</span><span>${sub.device_limit ? faNum(sub.device_limit) : 'نامحدود'}</span></div>
      ${sub.live === false ? '<div style="font-size:11.5px;color:var(--gilt);margin-top:10px">اطلاعات زنده از سرور در دسترس نبود؛ آخرین اطلاعات نمایش داده شده.</div>' : ''}
      <div style="display:flex;gap:10px;margin-top:20px">
        <button type="button" class="pill-btn white js-renew" style="height:44px;font-size:14px;flex:2">${sub.active ? 'تمدید یا تغییر پلن' : 'تمدید اشتراک'}</button>
        <button type="button" class="pill-btn ghost js-refresh" style="height:44px;font-size:14px;flex:1">به‌روزرسانی</button>
      </div>`;
  }
  screens.account = {
    fit: 'width',
    bg: 'linear-gradient(180deg,#0B0A08 0%,#0B0A08 55%,#16120B 100%)',
    html: () => {
      const me = S.me || {};
      const ann = S.config && S.config.announcement;
      return `${backBtn()}<div class="scroll"><div class="page enter" style="padding-top:110px">
        <h1 class="title-grad" style="margin-top:0">اشتراک من</h1>
        ${ann ? `<div class="ann">${esc(ann)}</div>` : ''}
        <div style="position:relative;border-radius:26px;overflow:hidden;background:linear-gradient(155deg,#2A2216 0%,#16130E 38%,#100E0A 100%);box-shadow:inset 0 1px 0 rgba(243,221,160,.25),inset 0 0 0 1px rgba(214,174,92,.28),0 30px 60px -24px rgba(0,0,0,.9)">
          <svg aria-hidden="true" width="260" height="260" viewBox="0 0 260 260" fill="none" stroke="#D6AE5C" style="position:absolute;left:-90px;top:-90px;opacity:.13;pointer-events:none"><circle cx="130" cy="130" r="94" stroke-width="1.2"/><circle cx="130" cy="130" r="124" stroke-width="1"/></svg>
          <div class="js-card" style="position:relative;padding:22px 22px 22px">${subCard(me.subscription)}</div>
        </div>
        <h2 style="font-size:17px;font-weight:500;margin:28px 0 8px">دستگاه‌ها</h2>
        <div class="panel js-devs" style="padding:4px 18px"><div class="skeleton" style="height:44px;margin:12px 0"></div></div>
        <h2 style="font-size:17px;font-weight:500;margin:28px 0 8px">حساب کاربری</h2>
        <div class="panel" style="padding:4px 18px">
          <div class="row-line"><span class="muted">ایمیل</span><span class="ltr" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(me.email || '')}</span></div>
          <div class="row-line"><span class="muted">موجودی کیف پول</span><span>${toman(me.wallet_balance || 0)} تومان</span></div>
          <button type="button" class="row-line js-conn" style="width:100%">تنظیمات اتصال<span>‹</span></button>
          <button type="button" class="row-line js-pass" style="width:100%">تغییر رمز<span>‹</span></button>
          <button type="button" class="row-line js-orders" style="width:100%">پرداخت‌های من<span>‹</span></button>
          <button type="button" class="row-line js-sup" style="width:100%">پشتیبانی<span>‹</span></button>
          <button type="button" class="row-line js-all" style="width:100%;color:#EE9A86">خروج از همه‌ی گوشی‌ها<span>‹</span></button>
        </div>
        <p class="muted js-ver ltr" style="text-align:center;font-size:12px;margin-top:22px"></p>
      </div></div>`;
    },
    mount(root) {
      wireBack(root);
      const b = (c, fn) => { const el = root.querySelector(c); if (el) el.onclick = fn; };
      const bindCard = () => {
        b('.js-renew', () => go('premium', { from: 'account' }));
        b('.js-refresh', async (ev) => {
          const btn = ev.currentTarget; busyButton(btn, true, true);
          try { await loadMe(); paintCard(); toast('اطلاعات اشتراک به‌روز شد'); } catch (e) { busyButton(btn, false); toast(e.message, true); }
        });
      };
      const paintCard = () => { root.querySelector('.js-card').innerHTML = subCard(S.me && S.me.subscription); bindCard(); };
      bindCard();
      b('.js-orders', () => go('orders'));
      b('.js-conn', () => CG.connSettings());
      b('.js-sup', openSupport);
      call('session', {}).then((x) => { if (x && x.version) root.querySelector('.js-ver').textContent = `Cloud Gold VPN ${x.version} · core v2rayNG ${x.core || ''}`; }).catch(() => {});
      b('.js-pass', () => sheet(`<h3>تغییر رمز</h3><p>گوشی‌های دیگر وارد حساب می‌مانند.</p>
        <label class="field"><span>رمز فعلی</span><input class="input" dir="ltr" name="cur" type="password" autocomplete="current-password"></label>
        <label class="field"><span>رمز جدید</span><input class="input" dir="ltr" name="new" type="password" autocomplete="new-password" placeholder="حداقل ۸ کاراکتر"></label>
        <div class="err"></div><button class="pill-btn white js-save">ذخیره</button>`, (el, close) => {
        el.querySelector('.js-save').onclick = async (ev) => {
          const btn = ev.currentTarget;
          busyButton(btn, true);
          try {
            const t = await api('POST', '/auth/change-password', { current_password: el.querySelector('[name=cur]').value, new_password: el.querySelector('[name=new]').value });
            await call('setSession', Object.assign({ email: S.me.email }, t));
            close(); toast('رمز عوض شد');
          } catch (e) { busyButton(btn, false); el.querySelector('.err').textContent = e.message; }
        };
      }));
      b('.js-all', () => sheet(`<h3>از همه‌ی گوشی‌ها خارج می‌شوی؟</h3><p>همه‌ی گوشی‌هایی که با این حساب وارد شده‌اند، از جمله همین گوشی، باید دوباره وارد شوند.</p>
        <button class="pill-btn white js-yes">خروج از همه</button><div style="height:10px"></div><button class="pill-btn dark js-no">انصراف</button>`, (el, close) => {
        el.querySelector('.js-no').onclick = close;
        el.querySelector('.js-yes').onclick = async () => {
          try { await api('POST', '/auth/logout-all'); } catch (e) {}
          close(); await call('logout', {}); S.me = null; reset('auth', { mode: 'login' });
        };
      }));
      const loadDevs = () => Promise.all([api('GET', '/devices'), call('device', {}).catch(() => ({}))]).then(([rows, mine]) => {
        const el = root.querySelector('.js-devs');
        el.innerHTML = rows.length ? rows.map((d) => `<div class="row-line"><span><span class="ltr">${esc(d.model || 'Phone')}</span>${d.device_id === mine.id ? ' <span style="color:var(--gilt);font-size:12px">· همین گوشی</span>' : ''}<br><span class="muted" style="font-size:12px">آخرین استفاده ${faDate(d.last_seen)}</span></span>
          ${d.device_id === mine.id ? '' : `<button type="button" class="link-btn" data-del="${d.id}" style="color:#EE9A86">حذف</button>`}</div>`).join('') : '<p class="muted" style="margin:14px 0;text-align:center">هنوز دستگاهی ثبت نشده.</p>';
        el.querySelectorAll('[data-del]').forEach((x) => {
          x.onclick = async () => { try { await api('DELETE', `/devices/${x.dataset.del}`); toast('دستگاه حذف شد'); loadDevs(); } catch (e) { toast(e.message, true); } };
        });
      }).catch((e) => toast(e.message, true));
      loadDevs();
      // always show fresh numbers from the panel
      loadMe().then(paintCard).catch(() => {});
      loadConfig().catch(() => null);
    },
  };
})();
