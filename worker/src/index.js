// Cloud Gold store on Cloudflare Workers. One Worker serves the app API, the NOWPayments webhook
// and the Telegram admin bot. State lives in D1 (env.DB).
import { json, err, ApiError } from './util.js';
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
    // every minute: look for crypto deposits on the blockchain and confirm matching orders
    if (event && event.cron && event.cron !== '30 20 * * *') {
      ctx.waitUntil((async () => { try { const { scanAll } = await import('./chainwatch.js'); await scanAll(env); } catch (e) {} })());
      return;
    }
    ctx.waitUntil((async () => {
      if (!env.TELEGRAM_CHAT_ID) return;
      let rate = '';
      try { const { usdRateInfo } = await import('./usdrate.js'); const ri = await usdRateInfo(env, { force: true }); rate = ri.rate ? `\n💵 دلار: ${ri.rate.toLocaleString('en-US')} تومان (${ri.from === 'live' ? 'زنده' : ri.from === 'saved' ? 'ذخیره‌شده' : 'دستی'})` : '\n⚠️ قیمت دلار از صرافی‌ها دریافت نشد → /rate'; } catch (e) {}
      try { await notifyAdmin(env, '🌙 گزارش روزانه\n' + (await statsText(env)) + rate); } catch (e) {}
      try { await sendBackup(env); } catch (e) {}
      try { const { prune } = await import('./netstats.js'); await prune(env); } catch (e) {}
    })());
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/health') return json({ ok: true });
      if (path === '/pay/done') return payDonePage(url.searchParams.get('cancelled'));

      // bank SMS forwarded from the admin's phone (secret key in the path)
      if (path.startsWith('/sms/') && request.method === 'POST') {
        const { smsWebhook } = await import('./sms.js');
        return await smsWebhook(env, request, path.slice(5));
      }

      // Telegram webhook at a secret path so only Telegram can reach it
      if (path === `/tg/${env.TELEGRAM_WEBHOOK_SECRET || 'webhook'}` && request.method === 'POST') {
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
      console.log('error', e && e.stack || e);
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

  // auth
  if (p === '/auth/register' && m === 'POST') return auth.register(env, await body(request), H);
  if (p === '/auth/login' && m === 'POST') return auth.login(env, await body(request), H);
  if (p === '/auth/refresh' && m === 'POST') return auth.refresh(env, await body(request));

  // crypto webhook (no auth, signature-checked)
  if (p === '/payments/nowpayments/ipn' && m === 'POST') return orders.nowpaymentsIpn(env, request);

  // everything below needs a logged-in user
  const authed = [
    '/me', '/trial', '/vpn', '/vpn/sub', '/vpn/servers', '/devices', '/orders', '/wallet', '/referral', '/coupons/check',
    '/auth/change-password', '/auth/logout-all', '/net/report', '/net/rank', '/net/google',
  ];
  const needsAuth = authed.includes(p) || p.startsWith('/devices/') || p.startsWith('/orders/');
  if (!needsAuth) return json({ detail: { code: 'not_found', message: 'پیدا نشد.' } }, 404);
  const user = await requireUser(env, request);

  if (p === '/auth/change-password' && m === 'POST') return auth.changePassword(env, user, await body(request));
  if (p === '/auth/logout-all' && m === 'POST') return auth.logoutAll(env, user);
  if (p === '/me' && m === 'GET') return account.me(env, user);
  if (p === '/trial' && m === 'POST') return account.startTrial(env, user, await body(request), request);
  if (p === '/vpn' && m === 'GET') return account.vpn(env, user, request);
  if (p === '/vpn/servers' && m === 'GET') return account.vpnServers(env, user);
  if (p === '/vpn/sub' && m === 'GET') return account.vpnSub(env, user, request);
  if (p === '/net/report' && m === 'POST') { const ns = await import('./netstats.js'); return ns.report(env, user, request, await body(request)); }
  if (p === '/net/rank' && m === 'GET') { const ns = await import('./netstats.js'); return ns.rank(env, request); }
  if (p === '/net/google' && m === 'POST') { const ns = await import('./netstats.js'); return ns.googleReport(env, user, await body(request)); }
  if (p === '/coupons/check' && m === 'POST') return orders.checkCoupon(env, user, await body(request));
  if (p === '/devices' && m === 'GET') return account.devices(env, user);
  if (p === '/wallet' && m === 'GET') return orders.wallet(env, user);
  if (p === '/referral' && m === 'GET') return orders.referral(env, user);
  if (p === '/orders' && m === 'GET') return orders.listOrders(env, user);
  if (p === '/orders' && m === 'POST') return orders.createOrder(env, user, await body(request));

  let mm;
  if ((mm = p.match(/^\/devices\/(\d+)$/)) && m === 'DELETE') return account.removeDevice(env, user, parseInt(mm[1], 10));
  if ((mm = p.match(/^\/orders\/(\d+)$/)) && m === 'GET') return orders.getOrder(env, user, parseInt(mm[1], 10));
  if ((mm = p.match(/^\/orders\/(\d+)\/receipt$/)) && m === 'POST') return orders.uploadReceipt(env, user, parseInt(mm[1], 10), request);
  if ((mm = p.match(/^\/orders\/(\d+)\/cancel$/)) && m === 'POST') return orders.cancelOrder(env, user, parseInt(mm[1], 10));
  if ((mm = p.match(/^\/orders\/(\d+)\/paid$/)) && m === 'POST') return orders.markCoinPaid(env, user, parseInt(mm[1], 10), await body(request));

  return json({ detail: { code: 'not_found', message: 'پیدا نشد.' } }, 404);
}
