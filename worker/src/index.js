// Cloud Gold store on Cloudflare Workers. One Worker serves the app API, the NOWPayments webhook
// and the Telegram admin bot. State lives in D1 (env.DB).
import { json, err, ApiError, safeEqual, logError, rateLimit } from './util.js';
import { first, run, insert } from './db.js';
import * as auth from './auth.js';
import * as account from './account.js';
import * as orders from './orders.js';
import { handleWebhook, sendBackup, statsText, notifyAdmin } from './telegram.js';
import { requireUser } from './auth.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-device-id,x-device-model,x-hwid,x-device-os,x-ver-os,x-app-version',
  'access-control-max-age': '86400',
};

const DEFAULT_PLANS = [
  { name: 'Monthly', duration_days: 30, data_limit_gb: 0, device_limit: 2, price_toman: 189000, old_price_toman: 0, badge: '', trial_days: 0, sort: 1 },
  { name: 'Annual', duration_days: 365, data_limit_gb: 0, device_limit: 3, price_toman: 459000, old_price_toman: 999000, badge: 'Recommended', trial_days: 7, sort: 2 },
  { name: '6 month', duration_days: 180, data_limit_gb: 0, device_limit: 3, price_toman: 259000, old_price_toman: 849000, badge: '', trial_days: 0, sort: 3 },
];

async function ensureSeed(env) {
  if (globalThis.__cgSeeded) return;
  const row = await first(env, 'SELECT COUNT(*) c FROM plans');
  if (row.c === 0) {
    for (const p of DEFAULT_PLANS) await insert(env, 'plans', { ...p, description: '', is_active: 1 });
  }
  globalThis.__cgSeeded = true;
}

function payDonePage(cancelled) {
  const msg = cancelled ? 'پرداخت لغو شد.' : 'پرداخت دریافت شد. می‌توانید به برنامه بازگردید.';
  return new Response(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloud Gold</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#010315;color:#fff;font-family:system-ui,sans-serif;text-align:center}a{color:#8997FF}</style></head>
<body><div><h2>Cloud Gold VPN</h2><p>${msg}</p><p><a href="cloudgold://payment">بازگشت به برنامه</a></p></div></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export default {
  // daily: backup file + short report to the admin's Telegram (cron in wrangler.jsonc)
  async scheduled(event, env, ctx) {
    // every minute: crypto deposits on the blockchain, one slice of the panel usage sync (quota and expiry
    // stops), and the Telegram webhook kept pointed at this Worker
    // every 2 minutes, on its own invocation (its own subrequest budget): one page of the broadcast being sent
    if (event && event.cron === '*/2 * * * *') {
      ctx.waitUntil((async () => {
        try { const { broadcastTick } = await import('./admin-actions.js'); await broadcastTick(env); } catch (e) { logError('broadcast failed', e); }
        // a new Pleat build on the release: told to the admin once (GitHub is asked every 10 minutes)
        if (new Date().getUTCMinutes() % 10 < 2) {
          try { const { checkNewBuild } = await import('./appupdate.js'); await checkNewBuild(env, (t, kb) => notifyAdmin(env, t, kb)); } catch (e) { logError('app build check failed', e); }
        }
      })());
      return;
    }
    if (event && event.cron && event.cron !== '30 20 * * *') {
      ctx.waitUntil((async () => {
        try { const { scanAll } = await import('./chainwatch.js'); await scanAll(env); } catch (e) { logError('chain scan failed', e); }
        try { const { runSync } = await import('./sync.js'); await runSync(env); } catch (e) { logError('panel sync failed', e); }
        try { const { ensureWebhook } = await import('./telegram.js'); await ensureWebhook(env); } catch (e) { logError('webhook check failed', e); }
      })());
      return;
    }
    ctx.waitUntil((async () => {
      if (!env.TELEGRAM_CHAT_ID) return;
      let rate = '';
      try { const { usdRateInfo } = await import('./usdrate.js'); const ri = await usdRateInfo(env, { force: true }); rate = ri.rate ? `\n💵 دلار: ${ri.rate.toLocaleString('en-US')} تومان (${ri.from === 'live' ? 'زنده' : ri.from === 'saved' ? 'ذخیره‌شده' : 'دستی'})` : '\n⚠️ قیمت دلار از صرافی‌ها دریافت نشد → /rate'; } catch (e) { logError('daily usd rate failed', e); }
      try { await notifyAdmin(env, '🌙 گزارش روزانه\n' + (await statsText(env)) + rate); } catch (e) { logError('daily report failed', e); }
      try { await sendBackup(env); } catch (e) { logError('daily backup failed', e); }
      try { const { prune } = await import('./netstats.js'); await prune(env); } catch (e) { logError('net stats prune failed', e); }
    })());
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/health' && url.searchParams.get('deep') !== '1') return json({ ok: true });
      // Mini App stage 0: a throw-away page that tests whether a Mini App opens on Iranian networks (account.js)
      if (path === '/mini/probe' && request.method === 'GET') return account.miniProbePage(env, request);
      // for an outside uptime monitor: is the per-minute cron still running? (the panel sync stamps its cursor
      // every run while a panel is active). 503 when it has been quiet for 10 minutes. One read, no details.
      if (path === '/health') {
        const { first } = await import('./db.js');
        const row = await first(env, 'SELECT MAX(run_at) t FROM sync_cursor').catch(() => null);
        const age = row && row.t ? Math.max(0, Math.floor(Date.now() / 1000) - row.t) : null;
        const ok = age !== null && age < 600;
        return json({ ok, cron_age_sec: age }, ok ? 200 : 503);
      }
      if (path === '/pay/done') return payDonePage(url.searchParams.get('cancelled'));

      // bank SMS forwarded from the admin's phone. The secret key goes in the X-SMS-Key header (kept out of
      // request logs); the older form with the key in the path still works.
      if ((path === '/sms' || path.startsWith('/sms/')) && request.method === 'POST') {
        const { smsWebhook } = await import('./sms.js');
        return await smsWebhook(env, request, request.headers.get('x-sms-key') || path.slice(5));
      }

      // Telegram webhook at /tg, checked by the secret_token header Telegram sends (the Worker registers it
      // itself, see ensureWebhook). The secret is no longer in the path, so it never shows up in request logs;
      // the old /tg/<secret> path still works until the webhook is re-registered. Without
      // TELEGRAM_WEBHOOK_SECRET the bot stays closed: anyone who knew the admin's chat id could otherwise
      // approve orders or change the card number.
      if ((path === '/tg' || path.startsWith('/tg/')) && request.method === 'POST') {
        const secret = env.TELEGRAM_WEBHOOK_SECRET;
        const okPath = path === '/tg' || (!!secret && (await safeEqual(path.slice(4), secret)));
        const okHeader = !!secret && (await safeEqual(request.headers.get('x-telegram-bot-api-secret-token') || '', secret));
        if (!okPath || !okHeader) return json({ detail: { code: 'not_found', message: 'پیدا نشد.' } }, 404);
        const update = await request.json().catch(() => ({}));
        ctx.waitUntil(handleWebhook(env, update));
        return json({ ok: true });
      }

      if (path.startsWith('/api/v1/')) {
        await ensureSeed(env);
        const res = await route(request, env, path.slice('/api/v1'.length));
        for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
        return res;
      }
      return json({ detail: { code: 'not_found', message: 'پیدا نشد.' } }, 404);
    } catch (e) {
      if (e instanceof ApiError) return json(e.body, e.status, CORS);
      logError('request failed', e, { method: request.method, path });
      return json({ detail: { code: 'server_error', message: 'مشکلی در سرور پیش آمد. چند لحظه دیگر دوباره امتحان کن.' } }, 500, CORS);
    }
  },
};

async function body(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

async function route(request, env, p) {
  const m = request.method;
  const H = request.headers;

  // public
  if (p === '/app-config' && m === 'GET') return account.appConfig(env);
  if (p === '/plans' && m === 'GET') return account.plans(env);
  if (p === '/ip' && m === 'GET') return account.myIp(env, request);

  // auth (rate-limited per IP, and login also per email, against password guessing and mass sign-ups)
  const ip = H.get('cf-connecting-ip') || '';
  if (p === '/auth/register' && m === 'POST') {
    await rateLimit(env, 'RL_IP', 'register:' + ip);
    return auth.register(env, await body(request), H);
  }
  if (p === '/auth/login' && m === 'POST') {
    const b = await body(request);
    await rateLimit(env, 'RL_IP', 'login:' + ip);
    await rateLimit(env, 'RL_LOGIN', 'login:' + String(b.login ?? b.email ?? '').trim().toLowerCase().replace(/^@/, ''));
    return auth.login(env, b, H);
  }
  // Telegram sign-up / login (6-digit code from the bot); verify is also limited per sign-in link
  if (p === '/auth/tg/start' && m === 'POST') {
    await rateLimit(env, 'RL_IP', 'tgstart:' + ip);
    return auth.tgStart(env);
  }
  if (p === '/auth/tg/verify' && m === 'POST') {
    const b = await body(request);
    await rateLimit(env, 'RL_IP', 'tgverify:' + ip);
    await rateLimit(env, 'RL_LOGIN', 'tgverify:' + String(b.nonce || '').slice(0, 64));
    return auth.tgVerify(env, b, H);
  }
  if (p === '/auth/tg/register' && m === 'POST') {
    await rateLimit(env, 'RL_IP', 'register:' + ip);
    return auth.tgRegister(env, await body(request), H);
  }
  // Telegram Mini App sign-in (initData signed by Telegram) and one-tap account
  if (p === '/auth/tg/webapp' && m === 'POST') {
    await rateLimit(env, 'RL_IP', 'webapp:' + ip);
    return auth.webappLogin(env, await body(request));
  }
  if (p === '/auth/tg/webapp/register' && m === 'POST') {
    await rateLimit(env, 'RL_IP', 'register:' + ip);
    return auth.webappRegister(env, await body(request));
  }
  if (p === '/mini/probe' && m === 'POST') {
    await rateLimit(env, 'RL_IP', 'miniprobe:' + ip);
    return account.miniProbeReport(env, await body(request), request);
  }
  if (p === '/auth/refresh' && m === 'POST') {
    await rateLimit(env, 'RL_IP', 'refresh:' + ip);
    return auth.refresh(env, await body(request));
  }

  // crypto webhook (no auth, signature-checked)
  if (p === '/payments/nowpayments/ipn' && m === 'POST') return orders.nowpaymentsIpn(env, request);

  // the admin panel in the Telegram Mini App (admin-api.js): sign in with initData, then an admin token
  if (p.startsWith('/admin/')) {
    const adm = await import('./admin-api.js');
    if (p === '/admin/auth' && m === 'POST') {
      await rateLimit(env, 'RL_LOGIN', 'admin:' + ip);
      return adm.adminAuth(env, await body(request));
    }
    const admin = await adm.requireAdmin(env, request);
    // panel tests, the dollar price and the backup reach other servers: the same per-IP limit as a sign-in
    if (m === 'POST' && /^\/admin\/(panels(\/\d+\/(cred|test))?|backup)$/.test(p)) await rateLimit(env, 'RL_LOGIN', 'admin-op:' + admin.tgId);
    const res = await adm.route(env, request, p, new URL(request.url), admin, () => body(request));
    if (res) return res;
    return json({ detail: { code: 'not_found', message: 'Not found.' } }, 404);
  }

  // everything below needs a logged-in user
  const authed = [
    '/me', '/trial', '/vpn', '/vpn/sub', '/vpn/servers', '/devices', '/orders', '/wallet', '/referral', '/coupons/check',
    '/app/apk', '/auth/change-password', '/auth/logout-all', '/me/packages', '/me/photo', '/me/email', '/me/avatar', '/me/telegram/start', '/me/telegram/verify', '/me/ip', '/net/report', '/net/rank', '/net/google',
  ];
  const needsAuth = authed.includes(p) || p.startsWith('/devices/') || p.startsWith('/orders/');
  if (!needsAuth) return json({ detail: { code: 'not_found', message: 'پیدا نشد.' } }, 404);
  const user = await requireUser(env, request);
  // a Mini App token reads the account and buys; VPN configs stay with Pleat (no panel or node address in a web page)
  if (user._mini && (p === '/vpn' || p.startsWith('/vpn/') || p.startsWith('/devices'))) throw err(403, 'use_pleat', 'Open the Pleat app for this.');

  if (p === '/auth/change-password' && m === 'POST') return auth.changePassword(env, user, await body(request));
  if (p === '/auth/logout-all' && m === 'POST') return auth.logoutAll(env, user);
  if (p === '/me' && m === 'GET') return account.me(env, user, request);
  // the address this request came from and where Cloudflare places it: through the VPN, the exit's public IP,
  // country and city (Pleat's Home shows them while connected); nothing is stored
  if (p === '/me/ip' && m === 'GET') {
    const cf = request.cf || {};
    return json({ ip: String(request.headers.get('cf-connecting-ip') || '').slice(0, 45), cc: /^[A-Z]{2}$/.test(cf.country || '') ? cf.country : '',
      city: String(cf.city || '').slice(0, 60), region: String(cf.region || '').slice(0, 60) });
  }
  // the announced Pleat update (appupdate.js), passed through from the private release; limited per user (resumes are new requests)
  if (p === '/app/apk' && m === 'GET') {
    await rateLimit(env, 'RL_IP', 'apk:' + user.id);
    const { apkDownload } = await import('./appupdate.js');
    return apkDownload(env, request);
  }
  if (p === '/me/packages' && m === 'GET') return account.packages(env, user);
  if (p === '/me/photo' && m === 'GET') return account.photo(env, user);
  if (p === '/me/email' && m === 'POST') {
    await rateLimit(env, 'RL_LOGIN', 'email:' + user.id); // it checks the password
    return auth.setEmail(env, user, await body(request));
  }
  if (p === '/me/avatar' && m === 'POST') return auth.setAvatar(env, user, await body(request));
  if (p === '/me/telegram/start' && m === 'POST') {
    await rateLimit(env, 'RL_IP', 'tgstart:' + ip);
    return auth.tgLinkStart(env, user);
  }
  if (p === '/me/telegram/verify' && m === 'POST') {
    const b = await body(request);
    await rateLimit(env, 'RL_LOGIN', 'tgverify:' + String(b.nonce || '').slice(0, 64));
    return auth.tgLinkVerify(env, user, b);
  }
  if (p === '/trial' && m === 'POST') {
    await rateLimit(env, 'RL_IP', 'trial:' + ip);
    return account.startTrial(env, user, await body(request), request);
  }
  if (p === '/vpn' && m === 'GET') return account.vpn(env, user, request);
  if (p === '/vpn/servers' && m === 'GET') return account.vpnServers(env, user, request);
  if (p === '/vpn/sub' && m === 'GET') return account.vpnSub(env, user, request);
  if (p === '/net/report' && m === 'POST') { const ns = await import('./netstats.js'); return ns.report(env, user, request, await body(request)); }
  if (p === '/net/rank' && m === 'GET') { const ns = await import('./netstats.js'); return ns.rank(env, request, new URL(request.url).searchParams.get('kind')); }
  if (p === '/net/google' && m === 'POST') { const ns = await import('./netstats.js'); return ns.googleReport(env, user, await body(request)); }
  if (p === '/coupons/check' && m === 'POST') return orders.checkCoupon(env, user, await body(request));
  if (p === '/devices' && m === 'GET') return account.devices(env, user);
  if (p === '/wallet' && m === 'GET') return orders.wallet(env, user);
  if (p === '/referral' && m === 'GET') return orders.referral(env, user);
  if (p === '/orders' && m === 'GET') return orders.listOrders(env, user);
  // new orders, receipts and "I paid" are limited per account (each one messages the admin or reserves an amount)
  if (p === '/orders' && m === 'POST') {
    await rateLimit(env, 'RL_IP', 'order:' + user.id);
    return orders.createOrder(env, user, await body(request));
  }

  let mm;
  if ((mm = p.match(/^\/devices\/(\d+)$/)) && m === 'DELETE') return account.removeDevice(env, user, parseInt(mm[1], 10));
  if ((mm = p.match(/^\/orders\/(\d+)$/)) && m === 'GET') return orders.getOrder(env, user, parseInt(mm[1], 10));
  if ((mm = p.match(/^\/orders\/(\d+)\/receipt$/)) && m === 'POST') {
    await rateLimit(env, 'RL_IP', 'receipt:' + user.id);
    return orders.uploadReceipt(env, user, parseInt(mm[1], 10), request);
  }
  if ((mm = p.match(/^\/orders\/(\d+)\/cancel$/)) && m === 'POST') return orders.cancelOrder(env, user, parseInt(mm[1], 10));
  if ((mm = p.match(/^\/orders\/(\d+)\/paid$/)) && m === 'POST') {
    await rateLimit(env, 'RL_IP', 'paid:' + user.id);
    return orders.markCoinPaid(env, user, parseInt(mm[1], 10), await body(request));
  }

  return json({ detail: { code: 'not_found', message: 'پیدا نشد.' } }, 404);
}
