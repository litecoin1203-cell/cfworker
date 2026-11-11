// Drives the real Worker through many scenarios. Run: node --experimental-sqlite test/run.mjs
import { AsyncLocalStorage } from 'node:async_hooks';
import { makeDB, installFakes } from './shim.mjs';
import { hmacSha512Hex } from '../src/util.js';
import { panelBases, decodeSub } from '../src/pasarguard.js';
import { fetchUsdRate, usdRateInfo } from '../src/usdrate.js';

const PANEL = 'http://panel.test';
const fakes = installFakes({ panelBase: PANEL });
const realWorker = (await import('../src/index.js')).default;
// Every request and cron run is one Worker invocation, and on the Free plan an invocation may send D1 at most
// 50 queries (a batch is one); the 51st fails. Each invocation (with its waitUntil work, which inherits the async
// context) is counted on its own, also when several run at once, and the suite fails if any went over.
const QUERY_CAP = 50;
const invocation = new AsyncLocalStorage();
const overCap = [];
const allInv = []; // every invocation's {label, q}, for tests that check one path's cost
const counted = (label, fn) => { const st0 = { label, q: 0 }; allInv.push(st0); return invocation.run(st0, fn); };
const worker = {
  fetch: (req, e, c) => counted(`${req.method} ${new URL(req.url).pathname}`, () => realWorker.fetch(req, e, c)),
  // each cron run as on a fresh isolate (the "nothing missing, skip for 10 minutes" memory is tested on its own)
  scheduled: (ev, e, c) => { if (!globalThis.__keepIsolate) globalThis.__cgNoMissingUntil = 0; return counted(`cron ${ev.cron || ''}`, () => realWorker.scheduled(ev, e, c)); },
};

const env = {
  DB: makeDB(new URL('../migrations/0001_init.sql', import.meta.url).pathname),
  SECRET_KEY: 'test-secret-key-long-enough-0123456789',
  PUBLIC_BASE_URL: 'https://api.test',
  PASARGUARD_URL: PANEL,
  PASARGUARD_USERNAME: 'admin',
  PASARGUARD_PASSWORD: 'pass',
  PASARGUARD_USERNAME_PREFIX: 'cg',
  NOWPAYMENTS_API_KEY: 'np-key',
  NOWPAYMENTS_IPN_SECRET: 'np-secret',
  TELEGRAM_BOT_TOKEN: 'bot:token',
  TELEGRAM_CHAT_ID: '12345',
  TELEGRAM_WEBHOOK_SECRET: 'hook',
};
env.DB.onQuery = () => { const s = invocation.getStore(); if (s && ++s.q === QUERY_CAP + 1) overCap.push(s); };
const _pending = [];
const ctx = { waitUntil: (p) => { _pending.push(Promise.resolve(p)); } };
async function drain() { const ps = _pending.splice(0); await Promise.all(ps); }

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function section(name) { console.log('• ' + name); }

// Telegram always says what kind of chat an update came from and who sent it; tests that leave those out
// mean the admin writing in their private chat
function asTelegram(u) {
  if (!u || typeof u !== 'object') return u;
  const fill = (m, from) => {
    if (!m || !m.chat) return;
    if (m.chat.type === undefined) m.chat.type = 'private';
    if (from && !from.from) from.from = { id: m.chat.id };
  };
  if (u.message) fill(u.message, u.message);
  if (u.callback_query) fill(u.callback_query.message, u.callback_query);
  return u;
}

async function call(method, path, { token, json: j, headers = {}, form, cf } = {}) {
  if (path.startsWith('/tg')) j = asTelegram(j);
  const h = { ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  let bodyInit;
  if (form) bodyInit = form;
  else if (j !== undefined) { h['content-type'] = 'application/json'; bodyInit = JSON.stringify(j); }
  const req = new Request('https://api.test' + path, { method, headers: h, body: bodyInit });
  if (cf) Object.defineProperty(req, 'cf', { value: cf });
  const res = await worker.fetch(req, env, ctx);
  let data = null;
  try { data = await res.clone().json(); } catch (e) {}
  return { status: res.status, data, res };
}

async function signup(email, { referral, device = 'dev-1', password = 'password123' } = {}) {
  const r = await call('POST', '/api/v1/auth/register', { json: { email, password, referral_code: referral, device_id: device, device_model: 'Pixel' } });
  ok(r.status === 201, `register ${email} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.access_token;
}

// admin settings via the Telegram bot webhook
const TG = { 'x-telegram-bot-api-secret-token': 'hook' }; // what Telegram sends after setWebhook(secret_token)
async function botSet(key, value) {
  await call('POST', '/tg/hook', { headers: TG, json: { message: { chat: { id: 12345 }, text: `/set ${key} ${value}` } } });
  await drain(); // the bot answers after the webhook returns (waitUntil)
}
async function tgWebhook(update) { const r = await call('POST', '/tg/hook', { headers: TG, json: update }); await drain(); return r; }

// ---------------- tests ----------------
section('health');
ok((await call('GET', '/health')).data.ok === true, 'health ok');

section('plans seeded');
{
  const r = await call('GET', '/api/v1/plans');
  ok(r.data.length === 3, 'three default plans');
  ok(r.data.some((p) => p.badge === 'پیشنهاد ویژه' && p.trial_days === 7), 'annual has trial + badge');
}

section('register / login / me');
{
  const tok = await signup('ali@example.com');
  const me = await call('GET', '/api/v1/me', { token: tok });
  ok(me.data.email === 'ali@example.com' && me.data.subscription === null, 'me, no sub');
  ok(me.data.trial_available === true, 'trial available');
  const dup = await call('POST', '/api/v1/auth/register', { json: { email: 'ali@example.com', password: 'password123' } });
  ok(dup.status === 409 && dup.data.detail.code === 'email_taken', 'duplicate email rejected');
  const bad = await call('POST', '/api/v1/auth/login', { json: { email: 'ali@example.com', password: 'wrong' } });
  ok(bad.status === 401, 'wrong password rejected');
  const good = await call('POST', '/api/v1/auth/login', { json: { email: 'ali@example.com', password: 'password123' } });
  ok(good.status === 200 && good.data.access_token, 'login ok');
  const weak = await call('POST', '/api/v1/auth/register', { json: { email: 'weak@example.com', password: 'short' } });
  ok(weak.status === 422 && weak.data.detail.field === 'password', 'weak password rejected');
}

section('token refresh + change password + logout-all');
{
  const tok = await signup('rot@example.com');
  const login = await call('POST', '/api/v1/auth/login', { json: { email: 'rot@example.com', password: 'password123' } });
  const refreshed = await call('POST', '/api/v1/auth/refresh', { json: { refresh_token: login.data.refresh_token } });
  ok(refreshed.status === 200 && refreshed.data.access_token, 'refresh works');
  const ch = await call('POST', '/api/v1/auth/change-password', { token: tok, json: { current_password: 'password123', new_password: 'newpassword123' } });
  ok(ch.status === 200, 'password changed');
  const oldRefresh = await call('POST', '/api/v1/auth/refresh', { json: { refresh_token: login.data.refresh_token } });
  ok(oldRefresh.status === 401, 'old refresh invalid after password change');
}

section('card purchase -> telegram -> approve -> servers');
{
  await botSet('card_number', '6037991234567893');
  await botSet('card_unique', '0'); // the older tests expect round amounts; unique amounts are tested below
  await botSet('card_holder', 'Ali');
  // the older tests start trials on email accounts; the Telegram-only rule is tested below
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('trial_needs_telegram', '0')").run();
  const tok = await signup('buyer@example.com', { device: 'buyer-phone' });
  const plans = (await call('GET', '/api/v1/plans')).data;
  const monthly = plans.find((p) => p.name === 'یک ماهه');
  const order = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card' } });
  ok(order.status === 201 && order.data.card.number === '6037991234567893', 'card order returns card details');
  // upload receipt (tiny PNG)
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(0)]);
  const form = new FormData();
  form.set('file', new Blob([png], { type: 'image/png' }), 'r.png');
  form.set('ref', '998877');
  const up = await call('POST', `/api/v1/orders/${order.data.id}/receipt`, { token: tok, form });
  ok(up.status === 200 && up.data.status === 'review', 'receipt -> review');
  ok(fakes.tg.photos.length === 1, 'receipt photo sent to telegram');
  // the app sends a kept receipt again with the same upload id: the admin gets it once
  form.set('upload_id', 'up-1');
  const again1 = await call('POST', `/api/v1/orders/${order.data.id}/receipt`, { token: tok, form });
  const again2 = await call('POST', `/api/v1/orders/${order.data.id}/receipt`, { token: tok, form });
  ok(again1.status === 200 && again2.status === 200 && again2.data.status === 'review', 'resent receipt answers like the first');
  ok(fakes.tg.photos.length === 2, 'same upload id is sent to the admin only once');
  form.delete('upload_id');
  // admin approves via inline button
  const ap = await tgWebhook({ callback_query: { id: 'c1', data: `ap:${order.data.id}`, message: { chat: { id: 12345 }, message_id: 1 } } });
  ok(ap.status === 200, 'approve callback handled');
  ok(!!(await env.DB.prepare("SELECT 1 x FROM admin_audit WHERE action = 'order.approve' AND target_id = ?").bind(String(order.data.id)).first()), 'receipt-button approval is in the admin log');
  const me = await call('GET', '/api/v1/me', { token: tok });
  ok(me.data.subscription && me.data.subscription.active, 'subscription active after approval');
  const servers = await call('GET', '/api/v1/vpn/servers', { token: tok });
  ok(servers.status === 200 && servers.data.length === 3, 'three servers parsed');
  ok(servers.data[0].country_code === 'NL', 'flag -> country code');
  const sk = await env.DB.prepare('SELECT keys FROM user_skeys').bind().first();
  ok(sk && Object.keys(JSON.parse(sk.keys)).length === 3, 'the server list remembers which servers this user can report on');
  const vpn = await call('GET', '/api/v1/vpn', { token: tok, headers: { 'x-device-id': 'buyer-phone' } });
  ok(vpn.status === 200 && vpn.data.subscription.sub_url, 'vpn returns sub url');
}

section('app-config: extra addresses and bridge links for filtered lines');
{
  const empty = (await call('GET', '/api/v1/app-config')).data;
  ok(Array.isArray(empty.api_bases) && empty.api_bases.length === 0 && empty.bridges.length === 0, 'nothing set -> empty lists');
  await botSet('app_api_bases', 'https://a.example.org, https://b.example.org/ http://plain.example.org https://x.org/path');
  await botSet('app_bridges', 'vless://u@h.example:443?security=tls#br1 nonsense https://not-a-link.org');
  const cfg = (await call('GET', '/api/v1/app-config')).data;
  ok(cfg.api_bases.join() === 'https://a.example.org,https://b.example.org', 'only https hosts are handed out: ' + cfg.api_bases.join());
  ok(cfg.bridges.length === 1 && cfg.bridges[0].startsWith('vless://'), 'only share links are handed out as bridges');
  await botSet('app_api_bases', '');
  await botSet('app_bridges', '');
}

section('reject receipt');
{
  await signup('rej@example.com');
  const tok = (await call('POST', '/api/v1/auth/login', { json: { email: 'rej@example.com', password: 'password123' } })).data.access_token;
  const plans = (await call('GET', '/api/v1/plans')).data;
  const order = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: plans[0].id, method: 'card' } });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(20).fill(1)]);
  const form = new FormData(); form.set('file', new Blob([png], { type: 'image/png' }), 'r.png');
  await call('POST', `/api/v1/orders/${order.data.id}/receipt`, { token: tok, form });
  await tgWebhook({ callback_query: { id: 'c2', data: `rj:${order.data.id}`, message: { chat: { id: 12345 }, message_id: 2 } } });
  const got = await call('GET', `/api/v1/orders/${order.data.id}`, { token: tok });
  ok(got.data.status === 'rejected' && got.data.admin_note, 'order rejected with note');
}

section('wallet top-up (approve) + buy with wallet + referral');
{
  const refTok = await signup('inviter@example.com');
  const refCode = (await call('GET', '/api/v1/referral', { token: refTok })).data.code;
  const tok = await signup('spender@example.com', { referral: refCode });
  // top-up 500k via card
  const top = await call('POST', '/api/v1/orders', { token: tok, json: { topup_toman: 500000, method: 'card' } });
  const png = new Uint8Array([0xff, 0xd8, 0xff, ...new Array(20).fill(2)]);
  const form = new FormData(); form.set('file', new Blob([png], { type: 'image/jpeg' }), 'r.jpg');
  await call('POST', `/api/v1/orders/${top.data.id}/receipt`, { token: tok, form });
  await tgWebhook({ callback_query: { id: 'c3', data: `ap:${top.data.id}`, message: { chat: { id: 12345 }, message_id: 3 } } });
  const w = await call('GET', '/api/v1/wallet', { token: tok });
  ok(w.data.balance === 500000, 'wallet credited 500k');
  // buy annual with wallet
  const annual = (await call('GET', '/api/v1/plans')).data.find((p) => p.name === 'یک ساله');
  const buy = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: annual.id, method: 'wallet' } });
  ok(buy.status === 201 && buy.data.status === 'paid', 'wallet purchase paid instantly');
  const w2 = await call('GET', '/api/v1/wallet', { token: tok });
  ok(w2.data.balance === 500000 - annual.price_toman, 'wallet debited');
  // referral commission to inviter (10% of annual)
  const rw = await call('GET', '/api/v1/wallet', { token: refTok });
  ok(rw.data.balance === Math.floor(annual.price_toman * 0.1), `referral commission ${rw.data.balance}`);
}

section('wallet purchase refunds when panel is down');
{
  const tok = await signup('refund@example.com');
  const top = await call('POST', '/api/v1/orders', { token: tok, json: { topup_toman: 500000, method: 'card' } });
  const png = new Uint8Array([0xff, 0xd8, 0xff, ...new Array(20).fill(3)]);
  const form = new FormData(); form.set('file', new Blob([png], { type: 'image/jpeg' }), 'r.jpg');
  await call('POST', `/api/v1/orders/${top.data.id}/receipt`, { token: tok, form });
  await tgWebhook({ callback_query: { id: 'c4', data: `ap:${top.data.id}`, message: { chat: { id: 12345 }, message_id: 4 } } });
  const annual = (await call('GET', '/api/v1/plans')).data.find((p) => p.name === 'یک ساله');
  const savedUrl = env.PASARGUARD_URL;
  env.PASARGUARD_URL = 'http://panel.down';   // make provisioning fail
  const buy = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: annual.id, method: 'wallet' } });
  env.PASARGUARD_URL = savedUrl;
  ok(buy.status === 400 && buy.data.detail.code === 'activation_failed', 'purchase fails when panel down');
  const w = await call('GET', '/api/v1/wallet', { token: tok });
  ok(w.data.balance === 500000, 'wallet refunded in full');
}

section('wallet is atomic under concurrent purchases');
{
  const { walletApply } = await import('../src/billing.js');
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
  const ledgerOk = async (uid) => {
    const u = await q('SELECT wallet_balance b FROM users WHERE id = ?', uid);
    const l = await q('SELECT COALESCE(SUM(amount),0) s FROM wallet_tx WHERE user_id = ?', uid);
    const last = await q('SELECT balance_after a FROM wallet_tx WHERE user_id = ? ORDER BY id DESC LIMIT 1', uid);
    return u.b >= 0 && u.b === l.s && (!last || last.a === u.b);
  };

  // straight on the wallet: 300k, ten debits of 100k fired at once -> exactly three go through
  await signup('race1@example.com');
  const u1 = await q("SELECT * FROM users WHERE email = 'race1@example.com'");
  await walletApply(env, { ...u1 }, 300000, 'topup', 900001, 'test');
  const results = await Promise.allSettled([...Array(10)].map((_, i) => walletApply(env, { ...u1 }, -100000, 'purchase', 900100 + i, 'test')));
  ok(results.filter((r) => r.status === 'fulfilled').length === 3, 'exactly 3 of 10 concurrent debits succeed');
  ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'insufficient_balance'), 'the rest fail with insufficient_balance');
  ok((await q('SELECT wallet_balance b FROM users WHERE id = ?', u1.id)).b === 0, 'balance ends at 0, never negative');
  ok(await ledgerOk(u1.id), 'ledger matches balance after concurrent debits');

  // the same order+reason applied twice at once is applied only once (e.g. SMS and admin approve together)
  await Promise.all([walletApply(env, { ...u1 }, 50000, 'topup', 900200, 'x'), walletApply(env, { ...u1 }, 50000, 'topup', 900200, 'x')]);
  ok((await q('SELECT wallet_balance b FROM users WHERE id = ?', u1.id)).b === 50000, 'duplicate concurrent credit applied once');
  // a credit racing a debit is not lost
  await Promise.all([walletApply(env, { ...u1 }, 70000, 'topup', 900201, 'x'), walletApply(env, { ...u1 }, -40000, 'purchase', 900202, 'x')]);
  ok((await q('SELECT wallet_balance b FROM users WHERE id = ?', u1.id)).b === 80000, 'concurrent credit + debit: no lost update');
  ok(await ledgerOk(u1.id), 'ledger matches balance after mixed updates');

  // end to end: wallet holds one annual plan, five purchases sent at once -> one paid, the rest refused
  const tok = await signup('race2@example.com');
  const u2 = await q("SELECT * FROM users WHERE email = 'race2@example.com'");
  const annual = (await call('GET', '/api/v1/plans')).data.find((p) => p.name === 'یک ساله');
  await walletApply(env, { ...u2 }, annual.price_toman, 'topup', 900300, 'test');
  const buys = await Promise.all([...Array(5)].map(() => call('POST', '/api/v1/orders', { token: tok, json: { plan_id: annual.id, method: 'wallet' } })));
  const paid = buys.filter((b) => b.status === 201 && b.data.status === 'paid').length;
  ok(paid === 1, `one concurrent wallet purchase paid, got ${paid}`);
  ok(buys.filter((b) => b.status === 400).every((b) => b.data.detail.code === 'insufficient_balance'), 'other concurrent purchases refused for balance');
  const w = await call('GET', '/api/v1/wallet', { token: tok });
  ok(w.data.balance === 0, `wallet not over-spent: ${w.data.balance}`);
  ok(await ledgerOk(u2.id), 'ledger matches balance after concurrent purchases');
}

section('settle is claimed once under concurrent confirmations');
{
  const { settle } = await import('../src/billing.js');
  const get = async (id) => env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.duration_days === 30);
  const daysLeft = async (email) => {
    const sub = await env.DB.prepare('SELECT s.expires_at e FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE u.email = ?').bind(email).first();
    return Math.round((sub.e - Date.now() / 1000) / 86400);
  };

  // a new user's first order confirmed twice at once: one panel account, one delivery
  const tok = await signup('claim1@example.com');
  const o = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card' } });
  const row = await get(o.data.id);
  const panelBefore = Object.keys(fakes.pg.users).length;
  const rs = await Promise.allSettled([settle(env, { ...row }), settle(env, { ...row }), settle(env, { ...row })]);
  ok(rs.every((r) => r.status === 'fulfilled' || r.reason.code === 'settle_busy'), 'concurrent settles either deliver or report busy');
  ok(Object.keys(fakes.pg.users).length === panelBefore + 1, 'exactly one panel account created');
  ok((await get(o.data.id)).status === 'paid', 'order paid');
  ok(await daysLeft('claim1@example.com') === 30, 'plan days added once');
  await settle(env, { ...row }); // a late duplicate (stale object) is a no-op
  ok(await daysLeft('claim1@example.com') === 30, 'late duplicate settle adds nothing');

  // admin button while the order is being settled: told it is busy, no second delivery
  const o2 = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card' } });
  await env.DB.prepare("UPDATE orders SET status = 'settling', settling_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000), o2.data.id).run();
  await tgWebhook({ callback_query: { id: 'cb-busy', data: `rj:${o2.data.id}`, message: { chat: { id: 12345 }, message_id: 9 } } });
  ok((await get(o2.data.id)).status === 'settling', 'reject does not touch an order being settled');
  const busy = await settle(env, await get(o2.data.id)).catch((e) => e);
  ok(busy && busy.code === 'settle_busy', 'second settle sees the claim');

  // a claim left by a crashed run expires; the retry does not add the days again if the panel was already done
  await env.DB.prepare("UPDATE orders SET settling_at = ?, provisioned_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 600, Math.floor(Date.now() / 1000) - 600, o2.data.id).run();
  await settle(env, await get(o2.data.id));
  ok((await get(o2.data.id)).status === 'paid', 'stale claim is settled by the retry');
  ok(await daysLeft('claim1@example.com') === 30, 'retry after crash does not extend the account twice');

  // a failed delivery puts the order back where it was
  const o3 = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card' } });
  const savedUrl = env.PASARGUARD_URL; env.PASARGUARD_URL = 'http://panel.down';
  const f = await settle(env, await get(o3.data.id), { quiet: true }).catch((e) => e);
  env.PASARGUARD_URL = savedUrl;
  ok(f && f.code === 'activation_failed' && (await get(o3.data.id)).status === 'pending', 'failed settle releases the claim');
}

section('telegram webhook needs the secret path and header');
{
  const upd = { message: { chat: { id: 12345 }, text: '/set card_holder Mallory' } };
  ok((await call('POST', '/tg/hook', { json: upd })).status === 404, 'no secret header -> 404');
  ok((await call('POST', '/tg/hook', { json: upd, headers: { 'x-telegram-bot-api-secret-token': 'nope' } })).status === 404, 'wrong header -> 404');
  ok((await call('POST', '/tg/webhook', { json: upd, headers: TG })).status === 404, 'default path is closed');
  const saved = env.TELEGRAM_WEBHOOK_SECRET; delete env.TELEGRAM_WEBHOOK_SECRET;
  ok((await call('POST', '/tg/webhook', { json: upd })).status === 404, 'no secret configured -> bot closed');
  env.TELEGRAM_WEBHOOK_SECRET = saved;
  const holder = await env.DB.prepare("SELECT value FROM settings WHERE key = 'card_holder'").first();
  ok(!holder || holder.value !== 'Mallory', 'forged updates changed nothing');
  ok((await call('POST', '/tg/hook', { json: { message: { chat: { id: 12345 }, text: '/help' } }, headers: TG })).status === 200, 'real Telegram call accepted');
}

section('crypto invoice + IPN');
{
  await botSet('usdt_rate_toman', '70000');
  const tok = await signup('crypto@example.com');
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.name === 'یک ماهه');
  const order = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'crypto' } });
  ok(order.status === 201 && order.data.crypto_pay_url, 'crypto invoice created');
  const invoiceId = fakes.np.invoices.slice(-1)[0].id;
  const payload = { order_id: String(order.data.id), invoice_id: invoiceId, payment_status: 'finished', price_amount: 3 };
  // sign exactly like NOWPayments (sorted keys)
  const sortedStringify = (o) => Array.isArray(o) ? '[' + o.map(sortedStringify).join(',') + ']'
    : (o && typeof o === 'object') ? '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + sortedStringify(o[k])).join(',') + '}'
      : JSON.stringify(o);
  const sig = await hmacSha512Hex('np-secret', sortedStringify(payload));
  const ipn = await call('POST', '/api/v1/payments/nowpayments/ipn', { json: payload, headers: { 'x-nowpayments-sig': sig } });
  ok(ipn.status === 200 && ipn.data.ok, 'ipn accepted');
  const me = await call('GET', '/api/v1/me', { token: tok });
  ok(me.data.subscription && me.data.subscription.active, 'crypto order activated subscription');
  const badSig = await call('POST', '/api/v1/payments/nowpayments/ipn', { json: payload, headers: { 'x-nowpayments-sig': 'deadbeef' } });
  ok(badSig.status === 401, 'bad IPN signature rejected');
}

section('free trial once per account and phone');
{
  const tok = await signup('trial1@example.com', { device: 'phoneT' });
  const annual = (await call('GET', '/api/v1/plans')).data.find((p) => p.trial_days > 0);
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.trial_days === 0);
  ok((await call('POST', '/api/v1/trial', { token: tok, json: { plan_id: monthly.id } })).data.detail.code === 'no_trial', 'no trial on monthly');
  const t = await call('POST', '/api/v1/trial', { token: tok, json: { plan_id: annual.id }, headers: { 'x-device-id': 'phoneT' } });
  ok(t.status === 200 && t.data.subscription.active && !t.data.trial_available, 'trial activated');
  ok(t.data.subscription.days_left >= 6 && t.data.subscription.days_left <= 7, 'trial length ~7 days');
  const again = await call('POST', '/api/v1/trial', { token: tok, json: { plan_id: annual.id } });
  ok(again.data.detail.code === 'trial_used', 'no second trial on same account');
  const tok2 = await signup('trial2@example.com', { device: 'phoneT' });
  const t2 = await call('POST', '/api/v1/trial', { token: tok2, json: { plan_id: annual.id }, headers: { 'x-device-id': 'phoneT' } });
  ok(t2.data.detail.code === 'trial_used', 'no trial reuse on same phone');
}

section('device limit + freeing a slot frees panel HWID');
{
  const tok = await signup('dev@example.com', { device: 'phone-a' });
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.name === 'یک ماهه'); // device_limit = 2
  // grant via bot so we do not need wallet
  await tgWebhook({ message: { chat: { id: 12345 }, text: `/grant dev@example.com ${monthly.id}` } });
  ok((await call('GET', '/api/v1/vpn', { token: tok, headers: { 'x-device-id': 'phone-a' } })).status === 200, 'device a ok');
  ok((await call('GET', '/api/v1/vpn', { token: tok, headers: { 'x-device-id': 'phone-b' } })).status === 200, 'device b ok');
  ok((await call('GET', '/api/v1/vpn', { token: tok, headers: { 'x-device-id': 'phone-c' } })).data.detail.code === 'device_limit', 'device c blocked (limit 2)');
  const devs = (await call('GET', '/api/v1/devices', { token: tok })).data;
  await call('DELETE', `/api/v1/devices/${devs[devs.length - 1].id}`, { token: tok });
  ok(fakes.pg.deletedHwids.length >= 1, 'panel HWID freed on device removal');
}

section('used_percent on /me comes from the server');
{
  // the limit is the control plane's; the usage is read from the panel (it only ever grows)
  const tok = await signup('pct@example.com', { device: 'pct-phone' });
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.name === 'یک ماهه');
  await tgWebhook({ message: { chat: { id: 12345 }, text: `/grant pct@example.com ${monthly.id}` } });
  const u = Object.values(fakes.pg.users).find((x) => (x.note || '').includes('pct@example.com'));
  ok(!!u, 'panel user for pct@example.com');
  const uid = (await env.DB.prepare("SELECT id FROM users WHERE email = 'pct@example.com'").first()).id;
  await env.DB.prepare('UPDATE subscriptions SET data_limit_bytes = 1000 WHERE user_id = ?').bind(uid).run();
  const pct = async (used) => { u.used_traffic = used; return (await call('GET', '/api/v1/me', { token: tok })).data.subscription; };
  let s = await pct(799);
  ok(s.used_percent === 79, 'rounded down, so the 80% warning starts at 80 ' + JSON.stringify(s));
  s = await pct(850);
  ok(s.used_percent === 85 && s.used_bytes === 850 && s.remaining_bytes === 150, '85% used ' + JSON.stringify(s));
  s = await pct(1000);
  ok(s.used_percent === 100 && s.status === 'limited' && s.stop_reason === 'quota' && !s.active, '100% = used up, reason quota');
  ok(u.status === 'disabled', 'panel account switched off at once');
  s = await pct(1500);
  ok(s.used_percent === 100, 'capped at 100');
  const tok2 = await signup('pct2@example.com', { device: 'pct2-phone' });
  await tgWebhook({ message: { chat: { id: 12345 }, text: `/grant pct2@example.com ${monthly.id}` } });
  const u2 = Object.values(fakes.pg.users).find((x) => (x.note || '').includes('pct2@example.com'));
  u2.used_traffic = 5000;
  s = (await call('GET', '/api/v1/me', { token: tok2 })).data.subscription;
  ok(s.used_percent === null && s.unlimited_data === true && s.used_bytes === 5000, 'unlimited data has no percent');
}

section('telegram admin commands');
{
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/stats' } });
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/reset ali@example.com brandnewpass' } });
  const relogin = await call('POST', '/api/v1/auth/login', { json: { email: 'ali@example.com', password: 'brandnewpass' } });
  ok(relogin.status === 200, 'admin /reset changed the password');
  const outsider = await tgWebhook({ message: { chat: { id: 999 }, text: '/stats' } });
  ok(outsider.status === 200, 'non-admin command ignored without error');
}


section('telegram button menu');
{
  const A = { chat: { id: 12345 } };
  const tap = (data, message = { ...A, message_id: 500, text: 'menu' }) => tgWebhook({ callback_query: { id: 'mq-' + data, data, message } });
  const say = (text, extra = {}) => tgWebhook({ message: { ...A, text, ...extra } });
  const since = (n) => fakes.tg.calls.slice(n);
  const kbData = (c) => ((c.body && c.body.reply_markup && c.body.reply_markup.inline_keyboard) || []).flat().map((x) => x.callback_data).filter(Boolean);
  const sent = (n) => since(n).filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.body);

  let n = fakes.tg.calls.length;
  await say('/menu');
  const homeMsg = since(n).find((c) => c.method === 'sendMessage');
  ok(homeMsg && homeMsg.body.text.includes('مدیریت Cloud Gold') && ['m:in', 'm:usr', 'm:pl', 'm:or', 'm:pa', 'm:cp', 'm:pay', 'm:app', 'm:net', 'm:bc', 'm:st', 'm:sys'].every((d) => kbData(homeMsg).includes(d)), '/menu opens the 12-section menu');
  n = fakes.tg.calls.length;
  await say('/start');
  ok(since(n).some((c) => c.method === 'sendMessage' && kbData(c).includes('m:usr')), '/start opens the menu for the admin');
  n = fakes.tg.calls.length;
  await say('/help');
  ok(since(n).some((c) => c.method === 'sendMessage' && kbData(c).includes('m:usr')), '/help opens the button menu');

  // navigation edits the same message
  n = fakes.tg.calls.length;
  await tap('m:usr');
  const ed = since(n).find((c) => c.method === 'editMessageText');
  ok(ed && ed.body.message_id === 500 && ed.body.text.includes('کاربران') && kbData(ed).includes('m:w:find'), 'users screen edits the menu message in place');
  ok(since(n).some((c) => c.method === 'answerCallbackQuery'), 'button tap is answered (no spinner)');

  // search by email: the bot asks, the next message is the answer
  await tap('m:w:find');
  n = fakes.tg.calls.length;
  await say('ali@example.com');
  const card = since(n).find((c) => c.method === 'sendMessage' && c.body.text.includes('👤 ali@example.com'));
  ok(card && kbData(card).some((d) => d.startsWith('m:ug:')) && kbData(card).some((d) => d.startsWith('m:usec:')), 'search answer shows the user card with grant / security buttons');
  const openSession = async () => !!(await env.DB.prepare('SELECT 1 x FROM bot_session').first());
  ok(!(await openSession()), 'an answer is used once; the question is gone after it');

  // text /find gets the same buttons
  n = fakes.tg.calls.length;
  await say('/find ali@example.com');
  ok(since(n).some((c) => c.method === 'sendMessage' && kbData(c).some((d) => d.startsWith('m:ug:'))), '/find shows the user buttons too');

  // password reset from the card; the message with the password is deleted
  const ali = await env.DB.prepare("SELECT id FROM users WHERE email = 'ali@example.com'").first();
  await tap(`m:w:reset:${ali.id}`);
  n = fakes.tg.calls.length;
  await say('menu-pass-123', { message_id: 777 });
  ok(since(n).some((c) => c.method === 'deleteMessage' && c.body.message_id === 777), 'the message holding the new password is deleted');
  ok((await call('POST', '/api/v1/auth/login', { json: { email: 'ali@example.com', password: 'menu-pass-123' } })).status === 200, 'password changed from the menu');

  // cancel drops the question
  await tap('m:w:find');
  await tap('m:cancel:usr');
  ok(!(await openSession()), 'cancel clears the question');

  // an old question expires
  await tap('m:w:find');
  await env.DB.prepare('UPDATE bot_session SET expires_at = 1').run();
  n = fakes.tg.calls.length;
  await say('nobody-here@example.com');
  ok(!sent(n).some((m) => m.text.includes('👤')) && !(await openSession()), 'an expired question is ignored (the text is only a lookup)');

  // plans: edit a field and switch a plan off/on
  const p = await env.DB.prepare('SELECT * FROM plans ORDER BY id LIMIT 1').first();
  n = fakes.tg.calls.length;
  await tap(`m:p:${p.id}`);
  ok(since(n).some((c) => c.method === 'editMessageText' && kbData(c).includes(`m:w:plan:${p.id}:price`)), 'plan screen has field buttons');
  await tap(`m:w:plan:${p.id}:price`);
  n = fakes.tg.calls.length;
  await say('123,456');
  ok((await env.DB.prepare('SELECT price_toman FROM plans WHERE id = ?').bind(p.id).first()).price_toman === 123456, 'plan price changed by answering the question');
  ok(sent(n).some((m) => kbData({ body: m }).includes(`m:p:${p.id}`)), 'answer carries a back button to the plan');
  await tap(`m:pt:${p.id}`);
  ok((await env.DB.prepare('SELECT is_active FROM plans WHERE id = ?').bind(p.id).first()).is_active === 0, 'plan switched off');
  await tap(`m:pt:${p.id}`);
  ok((await env.DB.prepare('SELECT is_active FROM plans WHERE id = ?').bind(p.id).first()).is_active === 1, 'plan switched on again');
  await env.DB.prepare('UPDATE plans SET price_toman = ? WHERE id = ?').bind(p.price_toman, p.id).run();

  // grant asks "are you sure?" first
  await signup('menugrant@example.com');
  const mg = await env.DB.prepare("SELECT id FROM users WHERE email = 'menugrant@example.com'").first();
  n = fakes.tg.calls.length;
  await tap(`m:ug:${mg.id}`);
  ok(since(n).some((c) => kbData(c).includes(`m:ugp:${mg.id}:${p.id}`)), 'grant shows the plans as buttons');
  n = fakes.tg.calls.length;
  await tap(`m:ugp:${mg.id}:${p.id}`);
  ok(!(await env.DB.prepare('SELECT 1 x FROM subscriptions WHERE user_id = ?').bind(mg.id).first()), 'nothing granted before the second tap');
  const confirm = since(n).find((c) => c.method === 'sendMessage' && c.body.text.includes('مطمئنی'));
  const cf = kbData(confirm).find((d) => d.startsWith('cf:'));
  await tap(cf, { ...A, message_id: 600, text: confirm.body.text });
  ok(!!(await env.DB.prepare('SELECT 1 x FROM subscriptions WHERE user_id = ?').bind(mg.id).first()), 'plan granted after "yes"');
  ok(!!(await env.DB.prepare("SELECT 1 x FROM admin_audit WHERE action = 'user.grant' AND target_id = ?").bind(String(mg.id)).first()), 'grant is in the admin log');

  // coupons: create by answering, delete with confirm
  await tap('m:f:coupon');
  await say('menu10');
  await tap('m:fa:1:10');
  await say('5');
  await tap('m:fa:3:0');
  await tap('m:fa:4:0');
  await tap('m:fok:coupon');
  ok(!!(await env.DB.prepare("SELECT 1 x FROM coupons WHERE code = 'MENU10' AND percent = 10 AND max_uses = 5").first()), 'coupon made from the step-by-step form');
  n = fakes.tg.calls.length;
  await tap('m:cd:MENU10');
  const dc = since(n).find((c) => c.method === 'sendMessage' && c.body.text.includes('MENU10'));
  await tap(kbData(dc).find((d) => d.startsWith('cf:')), { ...A, message_id: 601, text: dc.body.text });
  ok(!(await env.DB.prepare("SELECT 1 x FROM coupons WHERE code = 'MENU10'").first()), 'coupon deleted after "yes"');

  // payment modes: only the known keys and values
  await tap('m:sv:coin_auto:detect');
  ok((await env.DB.prepare("SELECT value FROM settings WHERE key = 'coin_auto'").first()).value === 'detect', 'crypto auto-confirm mode set by button');
  await tap('m:sv:card_number:auto');
  ok((await env.DB.prepare("SELECT value FROM settings WHERE key = 'card_number'").first())?.value !== 'auto', 'buttons cannot write other settings');
  await tap('m:sv:coin_auto:auto');

  // settings key screen + answer goes through /set (with its checks)
  await tap('m:w:set:wallet_xlm');
  n = fakes.tg.calls.length;
  await say('not-a-stellar-address');
  ok(sent(n).some((m) => m.text.includes('درست به نظر نمی‌رسد')), 'settings answers keep the /set checks');

  // a command button runs the text command and adds a back button
  n = fakes.tg.calls.length;
  await tap('m:x:home|/stats');
  ok(sent(n).some((m) => m.text.includes('کاربران') && kbData({ body: m }).includes('m:home')), 'command buttons answer with a back button');

  // pending receipts are sent again with approve / reject
  const tok = await signup('menurcpt@example.com');
  const ord = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: p.id, method: 'card' } });
  await env.DB.prepare("UPDATE orders SET status = 'review', receipt_file_id = 'photo_x' WHERE id = ?").bind(ord.data.id).run();
  n = fakes.tg.calls.length;
  await tap('m:ord');
  const ph = since(n).find((c) => c.method === 'sendPhoto');
  ok(ph && ph.body.photo === 'photo_x' && kbData(ph).includes(`ap:${ord.data.id}`) && kbData(ph).includes(`rj:${ord.data.id}`), 'waiting receipt re-sent with approve / reject');
  await tap(`rj:${ord.data.id}`, { ...A, message_id: 602, photo: [{}] });
  ok((await env.DB.prepare('SELECT status FROM orders WHERE id = ?').bind(ord.data.id).first()).status === 'rejected', 'reject from the list works');

  // every screen: buttons fit Telegram's 64-byte limit
  for (const d of ['m:home', 'm:st', 'm:usr', 'm:pl', `m:p:${p.id}`, 'm:pa', 'm:pp:1', 'm:cp', 'm:pay', 'm:set', 'm:wl', 'm:sk:wallet_xlm_memo', 'm:help', `m:u:${mg.id}`, 'm:un', `m:un:${mg.id}`]) {
    n = fakes.tg.calls.length;
    await tap(d);
    const e = since(n).find((c) => c.method === 'editMessageText');
    ok(e && e.body.text && kbData(e).length && kbData(e).every((x) => new TextEncoder().encode(x).length <= 64), `screen ${d} renders with valid buttons`);
  }

  // outsiders cannot use the menu
  n = fakes.tg.calls.length;
  await tgWebhook({ callback_query: { id: 'out', data: 'm:usr', message: { chat: { id: 999 }, message_id: 1, text: 'x' } } });
  ok(!since(n).some((c) => c.method === 'editMessageText') && since(n).some((c) => c.body && c.body.text === 'اجازه نداری'), 'non-admin taps are refused');
  n = fakes.tg.calls.length;
  await tgWebhook({ message: { chat: { id: 999 }, text: '/menu' } });
  ok(!since(n).some((c) => c.method === 'sendMessage'), 'non-admin /menu gets nothing');
  const bk = await (await import('../src/telegram.js')).backupJson(env);
  ok(!bk.includes('bot_wait'), 'menu state is not in the backup');
}

section('panel address normalisation + sub decoding');
{
  const b = panelBases('https://p.rain.rest/hub/#/login');
  ok(b[0] === 'https://p.rain.rest' && b[1] === 'https://p.rain.rest/hub', 'hub/#/login -> origin first ' + JSON.stringify(b));
  ok(panelBases('p.example.com:8000/dashboard/')[0] === 'https://p.example.com:8000', 'bare host + dashboard path');
  ok(panelBases('https://x.com/')[1] === undefined, 'plain origin has one base');
  const lines = decodeSub(btoa('vless://a@b:1#x\nvmess://abc\n'));
  ok(lines.length === 2, 'base64 subscription decoded');
}

section('reseller without full group access: falls back to simple list');
{
  fakes.pg.groupsSudoOnly = true;
  globalThis.__cgPg = {};
  const tok = await signup('reseller@example.com', { device: 'rs-phone' });
  const annual = (await call('GET', '/api/v1/plans')).data.find((p) => p.trial_days > 0);
  const t = await call('POST', '/api/v1/trial', { token: tok, json: { plan_id: annual.id }, headers: { 'x-device-id': 'rs-phone' } });
  ok(t.status === 200 && t.data.subscription.active, 'trial created via groups/simple ' + JSON.stringify(t.data));
  const pgUser = Object.values(fakes.pg.users).find((u) => (u.note || '').includes('reseller@example.com'));
  ok(pgUser && pgUser.group_ids.join(',') === '1,2', 'user got the reseller groups');
  ok(t.data.subscription.remaining_bytes === null && t.data.subscription.unlimited_data === true, 'unlimited data reported');
  fakes.pg.groupsSudoOnly = false;
}

section('trial failure tells the admin the exact panel error');
{
  fakes.pg.failCreate = 'Admin data limit reached';
  const before = fakes.tg.messages.length;
  const tok = await signup('failtrial@example.com', { device: 'ft-phone' });
  const annual = (await call('GET', '/api/v1/plans')).data.find((p) => p.trial_days > 0);
  const t = await call('POST', '/api/v1/trial', { token: tok, json: { plan_id: annual.id }, headers: { 'x-device-id': 'ft-phone' } });
  ok(t.status === 503 && t.data.detail.code === 'provision_failed', 'trial fails cleanly');
  const msg = fakes.tg.messages.slice(before).map((m) => m.text).join('\n');
  ok(msg.includes('Admin data limit reached'), 'admin sees panel reason');
  const me = await call('GET', '/api/v1/me', { token: tok });
  ok(me.data.trial_available === true, 'trial still available after failure');
  fakes.pg.failCreate = null;
}

section('card approval failure -> retry button -> activates');
{
  const tok = await signup('retry@example.com', { device: 'rt-phone' });
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.name === 'یک ماهه');
  ok(!!monthly, 'plan names shown in Persian');
  const order = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card' } });
  const form = new FormData(); form.set('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: 'image/jpeg' }), 'r.jpg');
  await call('POST', `/api/v1/orders/${order.data.id}/receipt`, { token: tok, form });
  fakes.pg.failCreate = 'group 9 not found';
  const before = fakes.tg.messages.length;
  await tgWebhook({ callback_query: { id: 'r1', data: `ap:${order.data.id}`, message: { chat: { id: 12345 }, message_id: 9 } } });
  const sent = fakes.tg.messages.slice(before);
  ok(sent.some((m) => m.text.includes('group 9 not found') && m.reply_markup && JSON.stringify(m.reply_markup).includes(`rp:${order.data.id}`)), 'error + retry button sent');
  ok((await call('GET', `/api/v1/orders/${order.data.id}`, { token: tok })).data.status === 'review', 'order still in review');
  fakes.pg.failCreate = null;
  await tgWebhook({ callback_query: { id: 'r2', data: `rp:${order.data.id}`, message: { chat: { id: 12345 }, message_id: 10 } } });
  ok((await call('GET', `/api/v1/orders/${order.data.id}`, { token: tok })).data.status === 'paid', 'retry activated the order');
  const me = await call('GET', '/api/v1/me', { token: tok });
  ok(me.data.subscription.active && me.data.subscription.days_left >= 29, 'subscription live after retry');
}

section('subscription proxy through the Worker forwards HWID');
{
  const tok = (await call('POST', '/api/v1/auth/login', { json: { email: 'retry@example.com', password: 'password123' } })).data.access_token;
  const r = await call('GET', '/api/v1/vpn/sub', { token: tok, headers: { 'x-device-id': 'rt-phone', 'x-hwid': 'rt-phone' } });
  const text = await r.res.text();
  ok(r.status === 200 && decodeSub(text).length === 3, 'proxied subscription has 3 configs');
  ok(fakes.pg.lastSubHeaders.hwid === 'rt-phone' && fakes.pg.lastSubHeaders.ua.startsWith('v2rayNG'), 'hwid + core UA forwarded');
}

section('panel that answers v2rayNG with Xray JSON');
{
  const tok = (await call('POST', '/api/v1/auth/login', { json: { email: 'retry@example.com', password: 'password123' } })).data.access_token;
  fakes.pg.subJson = true;
  const r = await call('GET', '/api/v1/vpn/servers', { token: tok, headers: { 'x-device-id': 'rt-phone', 'x-hwid': 'rt-phone' } });
  fakes.pg.subJson = false;
  ok(r.status === 200 && r.data.length === 3, 'falls back to the /links format');
  ok(fakes.pg.lastLinksHwid === 'rt-phone', 'hwid forwarded on the fallback too');
}

section('discount codes');
{
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/coupon GOLD50 50 1' } });
  const tok = await signup('coupon@example.com');
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.name === 'یک ماهه');
  const chk = await call('POST', '/api/v1/coupons/check', { token: tok, json: { code: 'gold50', plan_id: monthly.id } });
  ok(chk.status === 200 && chk.data.final_toman === Math.round(monthly.price_toman / 2 / 1000) * 1000, 'coupon check halves price ' + JSON.stringify(chk.data));
  const bad = await call('POST', '/api/v1/coupons/check', { token: tok, json: { code: 'NOPE', plan_id: monthly.id } });
  ok(bad.status === 400 && bad.data.detail.code === 'coupon_invalid', 'unknown code rejected');
  const order = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card', coupon_code: 'GOLD50' } });
  ok(order.data.amount_toman === chk.data.final_toman && order.data.list_price_toman === monthly.price_toman, 'order uses discounted price');
  const form = new FormData(); form.set('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 9])], { type: 'image/jpeg' }), 'r.jpg');
  await call('POST', `/api/v1/orders/${order.data.id}/receipt`, { token: tok, form });
  await tgWebhook({ callback_query: { id: 'k1', data: `ap:${order.data.id}`, message: { chat: { id: 12345 }, message_id: 11 } } });
  const again = await call('POST', '/api/v1/coupons/check', { token: tok, json: { code: 'GOLD50', plan_id: monthly.id } });
  ok(again.status === 400, 'coupon used up after one use: ' + again.data.detail.code);
  const free = await (async () => { await tgWebhook({ message: { chat: { id: 12345 }, text: '/coupon FREE100 100' } }); return call('POST', '/api/v1/orders', { token: await signup('free@example.com'), json: { plan_id: monthly.id, method: 'card', coupon_code: 'FREE100' } }); })();
  ok(free.data.status === 'paid' && free.data.amount_toman === 0, '100% code activates instantly');
}

section('pay the difference by card, plan activates from wallet automatically');
{
  const tok = await signup('diff@example.com', { device: 'df' });
  // give 100k to the wallet with a top-up
  const top = await call('POST', '/api/v1/orders', { token: tok, json: { topup_toman: 100000, method: 'card' } });
  const f1 = new FormData(); f1.set('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 4])], { type: 'image/jpeg' }), 'r.jpg');
  await call('POST', `/api/v1/orders/${top.data.id}/receipt`, { token: tok, form: f1 });
  await tgWebhook({ callback_query: { id: 'd1', data: `ap:${top.data.id}`, message: { chat: { id: 12345 }, message_id: 12 } } });
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.name === 'یک ماهه');
  const o = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card', use_wallet: true } });
  ok(o.data.kind === 'topup' && o.data.amount_toman === monthly.price_toman - 100000 && o.data.activate_plan_id === monthly.id, 'only the difference is asked ' + JSON.stringify(o.data));
  const f2 = new FormData(); f2.set('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 5])], { type: 'image/jpeg' }), 'r.jpg');
  await call('POST', `/api/v1/orders/${o.data.id}/receipt`, { token: tok, form: f2 });
  await tgWebhook({ callback_query: { id: 'd2', data: `ap:${o.data.id}`, message: { chat: { id: 12345 }, message_id: 13 } } });
  const done = await call('GET', `/api/v1/orders/${o.data.id}`, { token: tok });
  ok(done.data.status === 'paid' && done.data.plan_activated === true, 'plan auto-activated');
  const w = await call('GET', '/api/v1/wallet', { token: tok });
  ok(w.data.balance === 0, 'wallet used up exactly');
  const me = await call('GET', '/api/v1/me', { token: tok });
  ok(me.data.subscription && me.data.subscription.active, 'subscription active');
}

section('bot: /panel diagnostic, /find, /plan, /backup');
{
  const before = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/panel' } });
  const report = fakes.tg.messages.slice(before).map((m) => m.text).join('\n');
  ok(report.includes('ورود به API موفق') && report.includes('ساخت اکانت آزمایشی موفق') && report.includes('3 کانفیگ'), 'panel report all green:\n' + report);
  ok(!report.includes('panel.test') && !report.includes(env.PASARGUARD_USERNAME + '»') && !/https?:\/\//.test(report), 'panel report shows no address or user name');
  ok(!Object.keys(fakes.pg.users).some((n) => n.startsWith('cgtest_')), 'test user cleaned up');
  const b2 = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/find diff@example.com' } });
  ok(fakes.tg.messages.slice(b2).some((m) => m.text.includes('روز') && m.text.includes('حجم')), '/find shows live usage');
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/plan 1 name اقتصادی یک ماهه' } });
  ok((await call('GET', '/api/v1/plans')).data.some((p) => p.name === 'اقتصادی یک ماهه'), '/plan renames');
  const r = await worker.scheduled({}, env, ctx); await drain();
  ok(true, 'scheduled ran');
}


section('Cloud Gold Pay: low-fee crypto straight to the admin wallet');
{
  const XLM = 'G' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 55);
  const TON = 'UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG';
  const before = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/set wallet_xlm 0xnotastellaraddress' } });
  ok(fakes.tg.messages.slice(before).some((m) => m.text.includes('درست به نظر نمی‌رسد')), 'bad wallet address refused');
  const b0 = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/set wallet_xrp_memo abc' } });
  ok(fakes.tg.messages.slice(b0).some((m) => m.text.includes('فقط عدد')), 'XRP tag must be a number');
  await botSet('usd_rate_toman', '100000');
  await botSet('wallet_xlm', XLM);
  await botSet('wallet_xlm_memo', '84021733');
  await botSet('wallet_ton', TON);
  const cfg = (await call('GET', '/api/v1/app-config')).data;
  ok(cfg.coins.map((c) => c.id).join() === 'xlm,ton', 'only coins with a wallet are offered: ' + JSON.stringify(cfg.coins.map((c) => c.id)));
  ok(!cfg.coins.some((c) => /usdt|btc|eth/i.test(c.symbol)) && cfg.coins[0].fee, 'low-fee coins only, with fee label');

  const tok = await signup('coin@example.com', { device: 'coin-phone' });
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.price_toman === 189000);
  const o = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'coin', coin: 'xlm' } });
  ok(o.status === 201 && o.data.status === 'pending' && o.data.coin && o.data.coin.address === XLM, 'xlm order quoted ' + JSON.stringify(o.data.coin));
  ok(o.data.coin.memo === '84021733' && o.data.coin.memo_label === 'Memo', 'memo travels with the order');
  // 189000 toman / 100000 = $1.89 / $0.4 = 4.725 XLM, + a few unique 0.00001 units
  const amt = parseFloat(o.data.coin.amount);
  ok(amt > 4.725 && amt < 4.725 + 0.0009 + 1e-9, 'amount ~ price + unique units: ' + o.data.coin.amount);
  ok(o.data.coin.seconds_left > 1700 && o.data.coin.seconds_left <= 1800, '30 min price lock');
  const bad = await call('POST', `/api/v1/orders/${o.data.id}/paid`, { token: tok, json: { txid: 'nope' } });
  ok(bad.status === 422, 'garbage txid refused');
  const b2 = fakes.tg.messages.length;
  const tx = 'a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d';
  const paid = await call('POST', `/api/v1/orders/${o.data.id}/paid`, { token: tok, json: { txid: tx } });
  ok(paid.status === 200 && paid.data.status === 'review' && paid.data.txid === tx, 'paid -> review');
  const notice = fakes.tg.messages.slice(b2).find((m) => m.text.includes('پرداخت ارز دیجیتال'));
  ok(notice && notice.text.includes(o.data.coin.amount) && notice.text.includes(XLM) && notice.text.includes('Memo: 84021733')
    && JSON.stringify(notice.reply_markup).includes('stellar.expert/explorer/public/tx/' + tx) && JSON.stringify(notice.reply_markup).includes(`ap:${o.data.id}`), 'admin notice has amount, wallet, memo, explorer link and buttons');
  const o2 = await call('POST', '/api/v1/orders', { token: tok, json: { topup_toman: 100000, method: 'coin', coin: 'ton' } });
  ok(o2.status === 201 && o2.data.coin.symbol === 'TON' && o2.data.kind === 'topup' && o2.data.coin.memo === null, 'ton top-up quoted, no memo set');
  const dup = await call('POST', `/api/v1/orders/${o2.data.id}/paid`, { token: tok, json: { txid: tx } });
  ok(dup.status === 409, 'reused txid refused');
  await tgWebhook({ callback_query: { id: 'cp1', data: `ap:${o.data.id}`, message: { chat: { id: 12345 }, message_id: 77, text: notice.text } } });
  ok((await call('GET', `/api/v1/orders/${o.data.id}`, { token: tok })).data.status === 'paid', 'approved -> paid');
  const me = await call('GET', '/api/v1/me', { token: tok });
  ok(me.data.subscription && me.data.subscription.active, 'subscription activated by crypto');
  env.DB.exec(`UPDATE orders SET coin_expires_at = 1 WHERE id = ${o2.data.id}`);
  ok((await call('GET', `/api/v1/orders/${o2.data.id}`, { token: tok })).data.status === 'expired', 'stale quote expires');
  const late = await call('POST', `/api/v1/orders/${o2.data.id}/paid`, { token: tok, json: { txid: 'b'.repeat(64) } });
  ok(late.data.status === 'review', 'late payment still reviewable');
  const nope = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'coin', coin: 'sol' } });
  ok(nope.status === 400 && nope.data.detail.code === 'coin_unavailable', 'unconfigured coin refused');
  const gone = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'coin', coin: 'btc' } });
  ok(gone.status === 422, 'high-fee BTC is not offered');
  globalThis.__cgPrices = null; globalThis.__fakePriceDown = true;
  env.DB.exec("DELETE FROM settings WHERE key = 'coin_prices_cache'");
  const down = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'coin', coin: 'xlm' } });
  ok(down.status === 503 && down.data.detail.code === 'price_unavailable', 'no price -> clean error');
  globalThis.__fakePriceDown = false;
  const b3 = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/wallets' } });
  ok(fakes.tg.messages.slice(b3).some((m) => m.text.includes('✅ XLM') && m.text.includes('⚪️ XRP') && m.text.includes('Memo: 84021733')), '/wallets overview');
}


section('live dollar rate from Iranian exchanges');
{
  const live = await fetchUsdRate();
  ok(live.rate === 100000, 'median of exchanges = 100,000 toman: ' + live.rate);
  ok(!live.used.includes('tabdeal') && live.used.length === 4, 'outlier exchange ignored: ' + live.used.join(','));
  globalThis.__cgUsd = null;
  const info = await usdRateInfo(env, { force: true });
  ok(info.from === 'live' && info.rate === 100000, 'live rate used');
  // every exchange down -> last saved price
  globalThis.__fakeRateDown = true; globalThis.__cgUsd = null;
  const saved = await usdRateInfo(env, { force: true });
  ok(saved.from === 'saved' && saved.rate === 100000, 'falls back to the saved rate');
  // saved too old and no manual -> nothing; then manual setting as the last resort
  env.DB.exec("UPDATE settings SET value = '{\"at\":1,\"rate\":100000}' WHERE key = 'usd_rate_cache'");
  env.DB.exec("DELETE FROM settings WHERE key IN ('usd_rate_toman','usdt_rate_toman')");
  const none = await usdRateInfo(env, { force: true });
  ok(none.rate === 0 && none.from === 'none', 'no rate at all reported as none');
  await botSet('usd_rate_toman', '98000');
  const manual = await usdRateInfo(env, { force: true });
  ok(manual.rate === 98000 && manual.from === 'manual', 'manual rate is the last resort');
  globalThis.__fakeRateDown = false; globalThis.__cgUsd = null;
  const b = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/rate' } });
  const msg = fakes.tg.messages.slice(b).map((m) => m.text).join('\n');
  ok(msg.includes('✅ نوبیتکس') && msg.includes('⚠️ تبدیل') && msg.includes('زنده از صرافی‌ها'), '/rate shows each exchange:\n' + msg);
}


section('on-chain auto-confirmation (XLM, XRP, TRX, TON, ALGO)');
{
  const { scanAll, toUnits } = await import('../src/chainwatch.js');
  const XLM = 'G' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 55);
  const XRP = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
  const TRX = 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9';
  const TON = 'UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG';
  const ALGO = 'A'.repeat(58);
  await botSet('wallet_xlm', XLM); await botSet('wallet_xlm_memo', '84021733');
  await botSet('wallet_xrp', XRP); await botSet('wallet_xrp_memo', '1048576');
  await botSet('wallet_trx', TRX); await botSet('wallet_ton', TON); await botSet('wallet_algo', ALGO);
  await botSet('wallet_ton_memo', '');
  await botSet('coin_auto', 'auto');
  ok(toUnits('4.72502', 7) === 47250200n && toUnits('12', 6) === 12000000n, 'exact unit maths');
  const cfg = (await call('GET', '/api/v1/app-config')).data;
  ok(cfg.coins.find((c) => c.id === 'xlm').auto === true, 'app told which coins confirm automatically');

  const tok = await signup('chain@example.com', { device: 'chain-phone' });
  const plans = (await call('GET', '/api/v1/plans')).data;
  const monthly = plans.find((p) => p.price_toman === 189000);
  const order = async (coin) => (await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'coin', coin } })).data;
  const now = new Date().toISOString();

  // 1) XLM: exact amount + right memo, user never pressed "I paid" -> paid by the cron
  const x = await order('xlm');
  globalThis.__chain.xlm = [
    { type: 'payment', to: XLM, asset_type: 'native', amount: String(Number(x.coin.amount) + 0), transaction_hash: 'f'.repeat(64), created_at: now, transaction: { memo: '999' } }, // wrong memo
    { type: 'payment', to: XLM, asset_type: 'credit_alphanum4', amount: x.coin.amount, transaction_hash: 'e'.repeat(64), created_at: now, transaction: { memo: '84021733' } }, // a token, not XLM
  ];
  await scanAll(env);
  ok((await call('GET', `/api/v1/orders/${x.id}`, { token: tok })).data.status === 'pending', 'wrong memo / fake token ignored');
  globalThis.__chain.xlm.push({ type: 'payment', to: XLM, asset_type: 'native', amount: x.coin.amount, transaction_hash: 'a'.repeat(64), created_at: now, transaction: { memo: '84021733' } });
  const before = fakes.tg.messages.length;
  await scanAll(env);
  const xo = (await call('GET', `/api/v1/orders/${x.id}`, { token: tok })).data;
  ok(xo.status === 'paid' && xo.txid === 'a'.repeat(64), 'XLM payment confirmed automatically');
  ok(fakes.tg.messages.slice(before).some((m) => m.text.includes('تأیید خودکار')), 'admin told about the auto-confirm');

  // 2) XRP: partial-payment trick (Amount big, delivered small) must not pay; real one does
  const r = await order('xrp');
  const drops = (a) => String(toUnits(a, 6));
  globalThis.__chain.xrp = [{ validated: true, tx: { TransactionType: 'Payment', Destination: XRP, Amount: drops(r.coin.amount), DestinationTag: 1048576, hash: 'B'.repeat(64), date: 800000000 }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '1' } }];
  await scanAll(env);
  ok((await call('GET', `/api/v1/orders/${r.id}`, { token: tok })).data.status === 'pending', 'XRP partial payment rejected');
  globalThis.__chain.xrp.push({ validated: true, tx: { TransactionType: 'Payment', Destination: XRP, Amount: drops(r.coin.amount), DestinationTag: 1048576, hash: 'C'.repeat(64), date: 900000000 }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: drops(r.coin.amount) } });
  // checked instantly when the app polls the order
  globalThis.__cgChk = {};
  const ro = (await call('GET', `/api/v1/orders/${r.id}`, { token: tok })).data;
  ok(ro.status === 'paid', 'XRP confirmed the moment the payment screen polls');

  // 3) TRX: a TRC10 token transfer with the same number is ignored; the TRX one counts; hash reuse blocked
  const t = await order('trx');
  const sun = String(toUnits(t.coin.amount, 6));
  globalThis.__chain.trx = [
    { txID: 'd1', ret: [{ contractRet: 'SUCCESS' }], raw_data: { contract: [{ type: 'TransferAssetContract', parameter: { value: { amount: sun } } }] }, block_timestamp: Date.now() },
    { txID: 'a'.repeat(64), ret: [{ contractRet: 'SUCCESS' }], raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { amount: sun } } }] }, block_timestamp: Date.now() },
  ];
  await scanAll(env);
  ok((await call('GET', `/api/v1/orders/${t.id}`, { token: tok })).data.status === 'pending', 'token transfer ignored, already-used hash not reused');
  globalThis.__chain.trx.push({ txID: 'c3'.repeat(32), ret: [{ contractRet: 'SUCCESS' }], raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { amount: sun } } }] }, block_timestamp: Date.now() });
  await scanAll(env);
  ok((await call('GET', `/api/v1/orders/${t.id}`, { token: tok })).data.status === 'paid', 'TRX confirmed');

  // 4) TON: 3% short (exchange fee) -> manual review with a warning, never auto
  const n = await order('ton');
  const want = toUnits(n.coin.amount, 9);
  globalThis.__chain.ton = [{ utime: Math.floor(Date.now() / 1000), transaction_id: { hash: btoa('tonhash-1234567890') }, in_msg: { source: 'EQsender', value: String((want * 97n) / 100n), message: '' }, out_msgs: [] }];
  const b2 = fakes.tg.messages.length;
  await scanAll(env);
  const no = (await call('GET', `/api/v1/orders/${n.id}`, { token: tok })).data;
  ok(no.status === 'review' && fakes.tg.messages.slice(b2).some((m) => m.text.includes('کمتر از مبلغ سفارش')), 'TON underpayment flagged for review, not auto-activated');

  // 5) ALGO in "detect" mode: found and flagged, waits for the admin's tap
  await botSet('coin_auto', 'detect');
  const g = await order('algo');
  globalThis.__chain.algo = [{ id: 'ALGOTX' + 'Q'.repeat(46), 'confirmed-round': 123, 'round-time': Math.floor(Date.now() / 1000), 'payment-transaction': { amount: Number(toUnits(g.coin.amount, 6)), receiver: ALGO } }];
  const b3 = fakes.tg.messages.length;
  await scanAll(env);
  const go = (await call('GET', `/api/v1/orders/${g.id}`, { token: tok })).data;
  ok(go.status === 'review' && fakes.tg.messages.slice(b3).some((m) => m.text.includes('پیدا و با مبلغ سفارش تطبیق')), 'detect mode flags the match for one-tap approval');
  // "off": nothing happens
  await botSet('coin_auto', 'off');
  const off = await order('xlm');
  globalThis.__chain.xlm.push({ type: 'payment', to: XLM, asset_type: 'native', amount: off.coin.amount, transaction_hash: '9'.repeat(64), created_at: now, transaction: { memo: '84021733' } });
  await scanAll(env);
  ok((await call('GET', `/api/v1/orders/${off.id}`, { token: tok })).data.status === 'pending', 'off mode leaves it to the admin');
  await botSet('coin_auto', 'auto');
  // the every-minute cron runs the scan
  await worker.scheduled({ cron: '* * * * *' }, env, ctx); await drain();
  ok((await call('GET', `/api/v1/orders/${off.id}`, { token: tok })).data.status === 'paid', 'per-minute cron confirms it');
}


section('card-to-card gateway: unique amount, bank, SMS auto-confirm');
{
  const b0 = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/set card_number 6037991234567890' } });
  ok(fakes.tg.messages.slice(b0).some((m) => m.text.includes('درست نیست')), 'invalid card number (Luhn) refused');
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/set card_number 6037991234567893' } });
  ok(fakes.tg.messages.slice(-1)[0].text.includes('بانک ملی'), 'bank detected from card number');
  await botSet('card_unique', '1');
  await botSet('card_auto', 'auto');
  await botSet('sms_senders', '');
  const tok = await signup('cardsms@example.com', { device: 'cs' });
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.price_toman === 189000);
  const o1 = (await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card' } })).data;
  const o2 = (await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card' } })).data;
  ok(o1.amount_toman > 189000 && o1.amount_toman < 189100 && o2.amount_toman !== o1.amount_toman, `unique amounts ${o1.amount_toman} / ${o2.amount_toman}`);
  ok(o1.card.bank === 'ملی' && o1.card.color1 && o1.card.amount_rial === o1.amount_toman * 10, 'card shows bank colours and rial amount');
  const cfg = (await call('GET', '/api/v1/app-config')).data;
  ok(cfg.card_auto === false, 'no trusted bank sender yet -> app does not promise auto');

  // the SMS webhook needs the secret key
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/sms' } });
  const key = env.DB.prepare ? (await env.DB.prepare("SELECT value FROM settings WHERE key = 'sms_key'").bind().first()).value : '';
  ok(key && key.length >= 20 && fakes.tg.messages.slice(-1)[0].text.includes('/sms/' + key), '/sms shows the forwarder URL');
  ok((await call('POST', '/sms/wrongkey', { json: { from: 'x', text: 'y' } })).status === 404, 'wrong SMS key refused');

  const rial = (n) => n.toLocaleString('en-US');
  const smsText = (o) => `بانک ملی ایران\nحساب: 0101234567001\nواریز: ${rial(o.amount_toman * 10)}\nمانده: 25,300,000\n1405/08/06-10:22`;
  // 1) first SMS from the bank's sender: not trusted yet -> admin decides, with a "trust this sender" button
  const b1 = fakes.tg.messages.length;
  const r1 = await call('POST', '/sms/' + key, { json: { from: '+98 9100', text: smsText(o1), sentStamp: 1, receivedStamp: 1, sim: 'sim1' } });
  ok(r1.status === 200 && r1.data.result === 'review' && r1.data.orderId === o1.id, 'untrusted sender -> review ' + JSON.stringify(r1.data));
  const n1 = fakes.tg.messages.slice(b1).find((m) => m.reply_markup && JSON.stringify(m.reply_markup).includes('ts:'));
  ok(!!n1, 'admin gets the SMS with a trust-sender button');
  ok((await call('GET', `/api/v1/orders/${o1.id}`, { token: tok })).data.status === 'review', 'order waits for admin');
  // forwarder retries the same SMS: ignored
  ok((await call('POST', '/sms/' + key, { json: { from: '+98 9100', text: smsText(o1) } })).data.result === 'duplicate', 'duplicate SMS ignored');
  // admin trusts the sender
  const tsData = n1.reply_markup.inline_keyboard.flat().find((b) => b.callback_data && b.callback_data.startsWith('ts:')).callback_data;
  await tgWebhook({ callback_query: { id: 't1', data: tsData, message: { chat: { id: 12345 }, message_id: 1, text: 'x' } } });
  ok(((await call('GET', '/api/v1/app-config')).data.card_auto) === true, 'trusted sender saved -> auto badge on');
  // 2) next SMS from the same bank sender (written differently) confirms o2 by itself
  const r2 = await call('POST', '/sms/' + key, { json: { from: '00989100', text: smsText(o2) } });
  ok(r2.data.result === 'paid' && (await call('GET', `/api/v1/orders/${o2.id}`, { token: tok })).data.status === 'paid', 'trusted bank SMS -> paid automatically');
  // 3) a withdrawal SMS or an unknown amount does nothing
  ok((await call('POST', '/sms/' + key, { json: { from: '+989100', text: 'بانک ملی\nبرداشت: 500,000\nمانده: 1,000,000' } })).data.result === 'not_deposit', 'withdrawal ignored');
  const b3 = fakes.tg.messages.length;
  ok((await call('POST', '/sms/' + key, { json: { from: '+989100', text: 'واریز: 7,777,770\nمانده 1' } })).data.result === 'no_order', 'unknown amount -> no order');
  ok(fakes.tg.messages.slice(b3).some((m) => m.text.includes('سفارش کارت‌به‌کارتی با این مبلغ باز نیست')), 'admin told about the stray deposit');
  // 4) fake SMS from a random number with the right amount: never auto, admin decides
  const o3 = (await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card' } })).data;
  const r4 = await call('POST', '/sms/' + key, { json: { from: '09121234567', text: `تبریک! واریز ${rial(o3.amount_toman * 10)} ریال انجام شد` } });
  ok(r4.data.result === 'review', 'fake SMS from unknown number never auto-activates');
  // 5) admin pastes the real bank SMS into the bot -> paid
  const b5 = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: 12345 }, text: `بانک ملی\nواریز: ${rial(o3.amount_toman * 10)}\nمانده: 9,000,000\n1405/08/07` } });
  ok((await call('GET', `/api/v1/orders/${o3.id}`, { token: tok })).data.status === 'paid' && fakes.tg.messages.slice(b5).some((m) => m.text.includes(`#${o3.id} تأیید`)), 'pasted SMS in bot confirms the order');
  // 6) detect mode: trusted SMS still waits for the tap
  await botSet('card_auto', 'detect');
  const o4 = (await call('POST', '/api/v1/orders', { token: tok, json: { topup_toman: 100000, method: 'card' } })).data;
  const r6 = await call('POST', '/sms/' + key, { json: { from: '+989100', text: `واریز ${rial(o4.amount_toman * 10)} ریال` } });
  ok(r6.data.result === 'review', 'detect mode asks the admin');
  await botSet('card_auto', 'auto');
  // amounts written in toman (some banks) also match
  const o5 = (await call('POST', '/api/v1/orders', { token: tok, json: { topup_toman: 100000, method: 'card' } })).data;
  ok((await call('POST', '/sms/' + key, { json: { from: '+989100', text: `واریز ${rial(o5.amount_toman)} تومان` } })).data.result === 'paid', 'toman amounts match too');
  // a plain-text body (other forwarder apps) works
  const o6 = (await call('POST', '/api/v1/orders', { token: tok, json: { topup_toman: 100000, method: 'card' } })).data;
  const r7 = await worker.fetch(new Request('https://api.test/sms/' + key, { method: 'POST', body: `from=%2B989100&text=${encodeURIComponent('واریز ' + rial(o6.amount_toman * 10))}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } }), env, ctx);
  ok((await r7.json()).result === 'paid', 'form-encoded forwarders supported');
}


section('ISP intelligence: best servers per operator, anonymously');
{
  const MCI = { asn: 197207, asOrganization: 'Mobile Communication Company of Iran PLC' };
  const MTN = { asn: 44244, asOrganization: 'Iran Cell Service and Communication Company' };
  const toks = [];
  for (let i = 0; i < 3; i++) toks.push(await signup(`isp${i}@example.com`));
  // on MCI server "aaaaaa11" works and "bbbbbb22" fails; on Irancell it is the other way round
  for (const t of toks) {
    globalThis.__cgNet = {};
    await call('POST', '/api/v1/net/report', { token: t, cf: MCI, json: { results: [{ k: 'aaaaaa11', ok: true, ms: 120 }, { k: 'bbbbbb22', ok: false }] } });
    globalThis.__cgNet = {};
    await call('POST', '/api/v1/net/report', { token: t, cf: MTN, json: { results: [{ k: 'aaaaaa11', ok: false }, { k: 'bbbbbb22', ok: true, ms: 90 }] } });
  }
  const r1 = (await call('GET', '/api/v1/net/rank', { token: toks[0], cf: MCI })).data;
  ok(r1.isp === 'همراه اول' && r1.servers.aaaaaa11.score > r1.servers.bbbbbb22.score, 'MCI users get server A first ' + JSON.stringify(r1));
  const r2 = (await call('GET', '/api/v1/net/rank', { token: toks[0], cf: MTN })).data;
  ok(r2.isp === 'ایرانسل' && r2.servers.bbbbbb22.score > r2.servers.aaaaaa11.score, 'Irancell users get server B first');
  ok(r1.servers.aaaaaa11.ms === 120 && r1.servers.aaaaaa11.n === 3, 'pings and counts aggregated');
  // throttle + garbage keys
  const t0 = await call('POST', '/api/v1/net/report', { token: toks[0], cf: MCI, json: { results: [{ k: 'aaaaaa11', ok: true, ms: 100 }] } });
  const t1 = await call('POST', '/api/v1/net/report', { token: toks[0], cf: MCI, json: { results: [{ k: 'aaaaaa11', ok: true, ms: 100 }] } });
  ok(t1.data.skipped === 'throttled', 'reports throttled per phone');
  globalThis.__cgNet = {};
  const bad = await call('POST', '/api/v1/net/report', { token: toks[0], cf: MCI, json: { results: [{ k: "x'; DROP TABLE users;--", ok: true }] } });
  ok(bad.data.stored === 0, 'invalid server keys ignored');
  const rows = env.DB.prepare ? await env.DB.prepare("SELECT * FROM net_geo LIMIT 1").bind().first() : null;
  ok(rows && !('user_id' in rows), 'no user id stored');
}


section('city/province intelligence with recency');
{
  const MASHHAD = { asn: 197207, asOrganization: 'MCCI', region: 'Razavi Khorasan', city: 'Mashhad' };
  const TEHRAN = { asn: 197207, asOrganization: 'MCCI', region: 'Tehran', city: 'Tehran' };
  const toks = [];
  for (let i = 0; i < 4; i++) toks.push(await signup(`geo${i}@example.com`));
  // same operator, opposite results in two provinces
  for (const t of toks) {
    globalThis.__cgNet = {};
    await call('POST', '/api/v1/net/report', { token: t, cf: MASHHAD, json: { results: [{ k: 'cccccc33', ok: false }, { k: 'dddddd44', ok: true, ms: 150 }] } });
    globalThis.__cgNet = {};
    await call('POST', '/api/v1/net/report', { token: t, cf: TEHRAN, json: { results: [{ k: 'cccccc33', ok: true, ms: 80 }, { k: 'dddddd44', ok: false }] } });
  }
  const m = (await call('GET', '/api/v1/net/rank', { token: toks[0], cf: MASHHAD })).data;
  ok(m.geo === 'خراسان رضوی' && m.servers.dddddd44.score > m.servers.cccccc33.score && m.servers.dddddd44.level === 'city', 'Mashhad gets D first (city level) ' + JSON.stringify(m.servers));
  const t = (await call('GET', '/api/v1/net/rank', { token: toks[0], cf: TEHRAN })).data;
  ok(t.geo === 'تهران' && t.servers.cccccc33.score > t.servers.dddddd44.score, 'Tehran gets C first');
  // a province with no data of its own falls back to the operator-wide picture
  const s = (await call('GET', '/api/v1/net/rank', { token: toks[0], cf: { asn: 197207, region: 'Yazd' } })).data;
  ok(s.servers.cccccc33.level === 'isp' && Math.abs(s.servers.cccccc33.score - s.servers.dddddd44.score) < 0.2, 'new province uses ISP-wide data');
  // recency: old failures fade, a fresh block counts more
  const now = Math.floor(Date.now() / 1000 / 10800);
  env.DB.exec(`INSERT INTO net_geo (asn, geo, skey, bucket, ok, fail, ms_sum, ms_n) VALUES (197207, 'razavi khorasan', 'eeeeee55', ${now - 20}, 0, 30, 0, 0)`);
  env.DB.exec(`INSERT INTO net_geo (asn, geo, skey, bucket, ok, fail, ms_sum, ms_n) VALUES (197207, 'razavi khorasan', 'eeeeee55', ${now}, 6, 0, 600, 6)`);
  const r = (await call('GET', '/api/v1/net/rank', { token: toks[0], cf: MASHHAD })).data;
  ok(r.servers.eeeeee55.score > 0.6, 'server that recovered today ranks well despite old failures: ' + r.servers.eeeeee55.score);
}

section('Google / Gemini view of each server');
{
  const tok = await signup('goog@example.com');
  const rep = (b) => { globalThis.__cgGoo = {}; return call('POST', '/api/v1/net/google', { token: tok, json: b }); };
  await rep({ k: 'ffff0001', name: 'Germany 1', ip: '1.2.3.4', cc: 'DE', google_cc: 'DE', gemini: true, google_blocked: false });
  await rep({ k: 'ffff0002', name: 'NL 2', ip: '5.6.7.8', cc: 'NL', google_cc: 'IR', gemini: false, google_blocked: false });
  await rep({ k: 'ffff0003', name: 'US 3', ip: '9.9.9.9', cc: 'US', google_cc: 'US', gemini: true, google_blocked: true });
  const x = await rep({ k: 'ffff0004', name: 'FR 4', cc: 'FR', google_cc: 'FR' }); // gemini marker unreadable
  ok(x.data.status === 'google', 'unreadable Gemini marker falls back to Google country');
  const g = (await call('GET', '/api/v1/net/rank', { token: tok })).data.google;
  ok(g.ffff0001.status === 'google' && g.ffff0001.google_cc === 'DE', 'clean server: Google + Gemini OK');
  ok(g.ffff0002.status === 'iran', 'server Google sees as Iran is labelled');
  ok(g.ffff0003.status === 'flagged', 'server behind Google captcha wall is labelled');
  await call('POST', '/api/v1/net/google', { token: tok, json: { k: 'ffff0001', cc: 'DE', google_cc: 'DE', gemini: true } });
  const thr = await call('POST', '/api/v1/net/google', { token: tok, json: { k: 'ffff0001', cc: 'DE', google_cc: 'DE', gemini: true } });
  ok(thr.data.skipped === 'throttled', 'one test per server per minute per phone');
  const b0 = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/google' } });
  const msg = fakes.tg.messages.slice(b0).map((m) => m.text).join('\n');
  ok(msg.includes('🔴 NL 2') && msg.includes('🟢 Germany 1') && msg.includes('🟠 US 3'), '/google report for the admin:\n' + msg);
}

section('auth tokens: expired, tampered, wrong type, other key');
{
  const { signJwt } = await import('../src/util.js');
  const tok = await signup('jwt@example.com');
  const me = (t) => call('GET', '/api/v1/me', { token: t });
  ok((await call('GET', '/api/v1/me')).status === 401, 'no token -> 401');
  const parts = tok.split('.');
  const tampered = [parts[0], btoa(JSON.stringify({ ...JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))), sub: '1' })).replace(/=+$/, ''), parts[2]].join('.');
  ok((await me(tampered)).status === 401, 'payload changed without re-signing -> 401');
  const uid = String((await me(tok)).data.id);
  const expired = await signJwt({ sub: uid, ver: 0, typ: 'access' }, env.SECRET_KEY, -10);
  ok((await me(expired)).status === 401, 'expired access token -> 401');
  const login = await call('POST', '/api/v1/auth/login', { json: { email: 'jwt@example.com', password: 'password123' } });
  ok((await me(login.data.refresh_token)).status === 401, 'refresh token is not accepted as an access token');
  ok((await call('POST', '/api/v1/auth/refresh', { json: { refresh_token: login.data.access_token } })).status === 401, 'access token is not accepted as a refresh token');
  const forged = await signJwt({ sub: uid, ver: 0, typ: 'access' }, 'some-other-key-0123456789', 600);
  ok((await me(forged)).status === 401, 'token signed with another key -> 401');
  // a separate JWT_SECRET: old tokens stop working, new logins work, passwords are untouched
  env.JWT_SECRET = 'jwt-only-secret-0123456789abcdef';
  ok((await me(tok)).status === 401, 'tokens signed with SECRET_KEY rejected once JWT_SECRET is set');
  const relog = await call('POST', '/api/v1/auth/login', { json: { email: 'jwt@example.com', password: 'password123' } });
  ok(relog.status === 200 && (await me(relog.data.access_token)).status === 200, 'login and API work with JWT_SECRET');
  delete env.JWT_SECRET;
  const unknown = await call('POST', '/api/v1/auth/login', { json: { email: 'nobody@example.com', password: 'password123' } });
  ok(unknown.status === 401 && unknown.data.detail.code === 'bad_credentials', 'unknown email gets the same answer as a wrong password');
}

section("a user cannot read or change another user's order");
{
  const a = await signup('owner@example.com');
  const b = await signup('other@example.com');
  const o = await call('POST', '/api/v1/orders', { token: a, json: { topup_toman: 500000, method: 'card' } });
  ok(o.status === 201, 'order created ' + o.status);
  ok((await call('GET', `/api/v1/orders/${o.data.id}`, { token: b })).status === 404, "other user's order -> 404");
  ok((await call('POST', `/api/v1/orders/${o.data.id}/cancel`, { token: b })).status === 404, "cannot cancel another user's order");
  ok((await call('GET', `/api/v1/orders/${o.data.id}`, { token: a })).status === 200, 'owner can read it');
}

section('rate limits on login, sign-up and free trial');
{
  // a stand-in for the Workers Rate Limiting binding: N calls per key
  const limiter = (n) => { const seen = new Map(); return { limit: async ({ key }) => { const c = (seen.get(key) || 0) + 1; seen.set(key, c); return { success: c <= n }; } }; };
  await signup('rl@example.com');
  env.RL_LOGIN = limiter(5);
  const tries = [];
  for (let i = 0; i < 6; i++) tries.push((await call('POST', '/api/v1/auth/login', { json: { email: 'RL@example.com', password: 'wrong-' + i } })).status);
  ok(tries.slice(0, 5).every((s) => s === 401) && tries[5] === 429, 'sixth login attempt for one email in a minute -> 429: ' + tries.join(','));
  ok((await call('POST', '/api/v1/auth/login', { json: { email: 'someone@example.com', password: 'x' } })).status === 401, 'other emails are not affected');
  delete env.RL_LOGIN;
  env.RL_IP = limiter(2);
  const ipH = { 'cf-connecting-ip': '5.6.7.8' };
  const regs = [];
  for (let i = 0; i < 3; i++) regs.push((await call('POST', '/api/v1/auth/register', { headers: ipH, json: { email: `rlreg${i}@example.com`, password: 'password123' } })).status);
  ok(regs[0] === 201 && regs[1] === 201 && regs[2] === 429, 'third sign-up from one IP in a minute -> 429: ' + regs.join(','));
  ok((await call('POST', '/api/v1/auth/register', { headers: { 'cf-connecting-ip': '9.9.9.9' }, json: { email: 'rlreg-other@example.com', password: 'password123' } })).status === 201, 'another IP can still sign up');
  env.RL_IP = { limit: async () => { throw new Error('limiter down'); } };
  ok((await call('POST', '/api/v1/auth/login', { json: { email: 'rl@example.com', password: 'password123' } })).status === 200, 'a failing limiter never locks users out');
  delete env.RL_IP;
}

section('two sign-ups with the same email at the same moment');
{
  const r = await Promise.all([1, 2].map(() => call('POST', '/api/v1/auth/register', { json: { email: 'race@example.com', password: 'password123' } })));
  const st = r.map((x) => x.status).sort();
  ok(st[0] === 201 && st[1] === 409, 'one account, the other gets 409 (not 500): ' + st.join(','));
}

section('free trial requested twice at the same moment');
{
  const tok = await signup('trialrace@example.com', { device: 'race-phone' });
  const annual = (await call('GET', '/api/v1/plans')).data.find((p) => p.trial_days > 0);
  const created = fakes.pg.users ? Object.keys(fakes.pg.users).length : null;
  const r = await Promise.all([1, 2].map(() => call('POST', '/api/v1/trial', { token: tok, json: { plan_id: annual.id }, headers: { 'x-device-id': 'race-phone' } })));
  const good = r.filter((x) => x.status === 200).length;
  ok(good === 1 && r.some((x) => x.data.detail && x.data.detail.code === 'trial_used'), 'exactly one trial: ' + r.map((x) => x.status).join(','));
  if (created !== null) ok(Object.keys(fakes.pg.users).length === created + 1, 'one panel account built');
}

section('a discount code cannot be used twice through two open orders');
{
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/coupon TWICE30 30' } });
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.price_toman >= 10000);
  const tok = await signup('twice@example.com');
  const o1 = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card', coupon_code: 'TWICE30' } });
  ok(o1.status === 201 && o1.data.amount_toman < monthly.price_toman, 'first order gets the discount');
  const o2 = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card', coupon_code: 'TWICE30' } });
  ok(o2.status === 400 && o2.data.detail.code === 'coupon_in_use', 'second open order with the same code refused: ' + JSON.stringify(o2.data));
  await call('POST', `/api/v1/orders/${o1.data.id}/cancel`, { token: tok });
  const o3 = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card', coupon_code: 'TWICE30' } });
  ok(o3.status === 201, 'after cancelling, the code can be used again');
  // a code with one use left is reserved by the first open order
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/coupon LAST1 20 1' } });
  const u1 = await signup('last1a@example.com');
  const u2 = await signup('last1b@example.com');
  ok((await call('POST', '/api/v1/orders', { token: u1, json: { plan_id: monthly.id, method: 'card', coupon_code: 'LAST1' } })).status === 201, 'first user reserves the last use');
  const late = await call('POST', '/api/v1/orders', { token: u2, json: { plan_id: monthly.id, method: 'card', coupon_code: 'LAST1' } });
  ok(late.status === 400 && late.data.detail.code === 'coupon_used_up', 'second user cannot oversell it: ' + JSON.stringify(late.data));
}

section('backup never contains password hashes');
{
  const { backupJson } = await import('../src/telegram.js');
  const b = JSON.parse(await backupJson(env));
  ok(b.tables.users.length > 0 && b.tables.users.every((u) => !('password_hash' in u) && u.email), 'users are backed up without password_hash');
}


// ================= Phase 1: control plane over several panels =================
const { runSync: runSyncRaw } = await import('../src/sync.js');
const runSync = (e) => { if (!globalThis.__keepIsolate) globalThis.__cgNoMissingUntil = 0; return counted('runSync', () => runSyncRaw(e)); };
const GB = 1024 ** 3;
const P2 = 'http://panel2.test', P3 = 'http://panel3.test';
const pg2 = fakes.addPanel(P2, 'n2.example.net');
const pg3 = fakes.addPanel(P3, 'n3.example.org');
env.PANEL_2_CRED = JSON.stringify({ url: P2, username: 'admin2', password: 'pass2' });
env.PANEL_3_CRED = JSON.stringify({ url: P3, username: 'admin3', password: 'pass3' });
const admin = (text) => tgWebhook({ message: { chat: { id: 12345 }, text } });
const lastText = () => fakes.tg.messages[fakes.tg.messages.length - 1].text;
const syncRounds = async (n) => { for (let i = 0; i < n; i++) await runSync(env); };
const panelUser = (pg, email) => Object.values(pg.users).find((x) => (x.note || '').endsWith('· ' + email));
const userId = async (email) => (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()).id;
let tenGb;

section('bot: add, test and roll out panels (with admin log)');
{
  await admin('/addpanel pasarguard پنل دوم');
  ok(lastText().includes('یوزرنیم و رمز') && lastText().includes('پاک می‌شود') && !lastText().includes('pass2'), 'add panel asks for the login in a message that is deleted');
  await admin('/addpanel pasarguard پنل سوم');
  await admin('/rollout 2 100');
  ok(lastText().includes('اول پنل را تست کن'), 'an untested panel cannot take users');
  await admin('/paneltest 2');
  ok(lastText().includes('سالم است') && lastText().includes('1.0.0-test'), 'health test passes and reads the version: ' + lastText());
  await admin('/paneltest 3');
  await admin('/rollout 2 100');
  await admin('/rollout 3 100');
  const states = (await env.DB.prepare('SELECT state FROM panels ORDER BY id').all()).results.map((r) => r.state);
  ok(states.join() === 'active,active,active', 'three active panels: ' + states.join());
  const outsider = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: 777 }, text: '/drainpanel 2' } });
  ok(fakes.tg.messages.length === outsider, 'non-admin gets nothing back');
  const log = (await env.DB.prepare('SELECT action FROM admin_audit').all()).results.map((r) => r.action);
  ok(log.includes('panel.add') && log.includes('panel.test') && log.includes('panel.rollout'), 'admin log has the changes: ' + log.join());
  await admin('/newplan ده گیگ|30|10|0|100000');
  tenGb = (await env.DB.prepare("SELECT * FROM plans WHERE name = 'ده گیگ'").first());
}

section('acceptance: 2 + 4 + 5 GB on three panels = 11 GB; a 10 GB plan stops on every panel');
{
  const tok = await signup('q@example.com', { device: 'q-phone' });
  await admin(`/grant q@example.com ${tenGb.id}`);
  const [a, b, c] = [panelUser(fakes.pg, 'q@example.com'), panelUser(pg2, 'q@example.com'), panelUser(pg3, 'q@example.com')];
  ok(a && b && c, 'one account on each of the three panels');
  ok(a.data_limit === 10 * GB && b.data_limit === 10 * GB && !b.hwid_limit && a.hwid_limit === undefined, 'same limit everywhere; no panel HWID on the new panels');
  a.used_traffic = 2 * GB; b.used_traffic = 4 * GB;
  await syncRounds(3);
  ok(c.data_limit <= 4 * GB + 64 * 1024 * 1024 && c.data_limit >= 4 * GB, 'panel 3 is tightened to what is left overall (4 GB): ' + c.data_limit);
  c.used_traffic = 5 * GB;
  await syncRounds(3);
  const s = (await call('GET', '/api/v1/me', { token: tok, headers: { 'x-app-version': '1.9.0 (Android 14)' } })).data.subscription;
  ok(s.used_bytes === 11 * GB, 'usage is summed across panels: ' + s.used_bytes);
  ok(s.status === 'limited' && s.stop_reason === 'quota' && s.active === false && s.used_percent === 100, 'stopped, reason quota');
  ok([a, b, c].every((x) => x.status === 'disabled'), 'disabled on all three panels');
  const puts = [fakes.pg, pg2, pg3].map((p) => p.putLog.filter((n) => [a, b, c].some((x) => x.username === n)).length);
  await syncRounds(4);
  await call('GET', '/api/v1/me', { token: tok });
  const puts2 = [fakes.pg, pg2, pg3].map((p) => p.putLog.filter((n) => [a, b, c].some((x) => x.username === n)).length);
  ok(puts.join() === puts2.join(), 'stopping again changes nothing (idempotent): ' + puts + ' / ' + puts2);
}

section('panel accounts are named after the Telegram @username; taken names and users without one fall back');
{
  const { panelNames, panelNameBase } = await import('../src/sync.js');
  ok(panelNameBase({ id: 5, tg_username: 'Ali__Gold_' }) === 'ali_gold', 'sanitized: lower case, no double or trailing underscore');
  ok(panelNameBase({ id: 5, tg_id: 777, tg_username: null }) === 'tg777', 'no @username: tg<numeric id>');
  ok(panelNameBase({ id: 5, email: 'a@b.c' }) === null, 'no Telegram: no Telegram name');
  const long = panelNames({ id: 123456, tg_username: 'a'.repeat(32) });
  ok(long.every((n) => n.length <= 32 && /^[a-z0-9_]+$/.test(n) && !/__/.test(n)) && long[1].endsWith('_123456'), 'every candidate fits all three panels: ' + long.join(','));
  ok(/^cg_9_[0-9a-f]{4}$/.test(panelNames({ id: 9 })[0]), 'email-only users keep the old cg_<id>_<random> name');

  await signup('tgname@example.com', { device: 'tgn-phone' });
  const id1 = await userId('tgname@example.com');
  await env.DB.prepare('UPDATE users SET tg_id = 900001, tg_username = ? WHERE id = ?').bind('gold_ali', id1).run();
  // someone made "gold_ali" on panel 2 by hand: that panel answers 409 and the next name is used
  pg2.users['gold_ali'] = { id: 4242, username: 'gold_ali', status: 'active', expire: 0, data_limit: 0, used_traffic: 0, token: 'hand' };
  await admin(`/grant tgname@example.com ${tenGb.id}`);
  const rows = (await env.DB.prepare('SELECT panel_id, remote_username FROM panel_accounts WHERE user_id = ? ORDER BY panel_id').bind(id1).all()).results;
  ok(rows.length === 3, 'one account on each panel');
  ok(rows[0].remote_username === 'gold_ali' && rows[2].remote_username === 'gold_ali', 'named after the @username: ' + rows.map((r) => r.remote_username));
  ok(rows[1].remote_username === `gold_ali_${id1}` && pg2.users['gold_ali'].id === 4242, 'taken on panel 2 -> gold_ali_<id>, the hand-made account untouched');
  ok(fakes.pg.users['gold_ali'].note.includes('tg 900001'), 'the panel note carries the numeric Telegram id');
  // the user changes @username in Telegram: the panel name stays (it is fixed at creation)
  await env.DB.prepare('UPDATE users SET tg_username = ? WHERE id = ?').bind('new_name', id1).run();
  await admin(`/grant tgname@example.com ${tenGb.id}`);
  const again = (await env.DB.prepare('SELECT remote_username FROM panel_accounts WHERE user_id = ? AND panel_id = 1').bind(id1).first()).remote_username;
  ok(again === 'gold_ali', 'renewal keeps the same panel account after an @username change');

  section('bot: per-panel usage, dates, last connection and online now');
  const now = Math.floor(Date.now() / 1000);
  fakes.pg.users['gold_ali'].used_traffic = 1 * GB;
  fakes.pg.users['gold_ali'].online_at = new Date((now - 30) * 1000).toISOString().replace('Z', '');
  pg2.users[`gold_ali_${id1}`].used_traffic = 2 * GB;
  pg2.users[`gold_ali_${id1}`].online_at = new Date((now - 3 * 3600) * 1000).toISOString();
  await syncRounds(3);
  const stored = (await env.DB.prepare('SELECT MAX(online_at) m FROM usage_counters WHERE period_id = (SELECT period_id FROM subscriptions WHERE user_id = ?)').bind(id1).first()).m;
  ok(Math.abs(stored - (now - 30)) <= 1, 'the last connection is stored with the usage reading: ' + stored);
  const S = await import('../src/telegram-screens.js');
  const scr = await S.userPanels(env, id1);
  ok(scr.text.includes('👤 gold_ali') && scr.text.includes(`👤 gold_ali_${id1}`), 'each panel account by name');
  ok(scr.text.includes('🟢 الان آنلاین') && scr.text.includes('۳') === false && /3 ساعت پیش/.test(scr.text), 'online now on panel 1, 3 hours ago on panel 2');
  ok(scr.text.includes('جمع مصرف: 3.00') && scr.text.includes('ساخت: 2026-11-01'), 'total and creation date shown');
  ok(scr.kb.flat().some((x) => x.callback_data === `m:uac:${id1}`), 'refresh is a button');
  const card = await S.userCard(env, id1);
  ok(card.text.includes('آخرین اتصال: 🟢 الان آنلاین') && card.kb.flat().some((x) => x.callback_data === `m:uac:${id1}`), 'user card shows last connection and the panels button');
  ok(S.seenFa(null) === 'هنوز وصل نشده' && S.seenFa(now - 5 * 86400, now).startsWith('5 روز پیش'), 'never / days ago');
}

section('a broken panel is never counted as zero; the stop is retried until it sticks');
{
  const tok = await signup('r@example.com', { device: 'r-phone' });
  await admin(`/grant r@example.com ${tenGb.id}`);
  const [a, b, c] = [panelUser(fakes.pg, 'r@example.com'), panelUser(pg2, 'r@example.com'), panelUser(pg3, 'r@example.com')];
  a.used_traffic = 1 * GB; b.used_traffic = 2 * GB; c.used_traffic = 3 * GB;
  await syncRounds(3);
  pg2.down = true;
  let s = (await call('GET', '/api/v1/me', { token: tok })).data.subscription;
  ok(s.used_bytes === 6 * GB && s.active, 'panel 2 down: its 2 GB still count: ' + s.used_bytes);
  await syncRounds(3);
  ok((await call('GET', '/api/v1/me', { token: tok })).data.subscription.used_bytes === 6 * GB, 'still 6 GB after sync rounds with panel 2 down');
  c.used_traffic = 7 * GB; // 1 + 2 + 7 = 10 -> stop while panel 2 cannot be reached
  s = (await call('GET', '/api/v1/me', { token: tok })).data.subscription;
  ok(s.stop_reason === 'quota' && a.status === 'disabled' && c.status === 'disabled' && b.status !== 'disabled', 'stopped where reachable');
  const pending = (await env.DB.prepare("SELECT COUNT(*) c FROM panel_accounts WHERE user_id = ? AND dirty = 1").bind(await userId('r@example.com')).first()).c;
  ok(pending === 1, 'the stop on panel 2 is still pending');
  pg2.down = false;
  await syncRounds(2);
  ok(b.status === 'disabled', 'panel 2 back: the stop reaches it');
}

section('acceptance: removing a panel keeps its usage history and moves its users');
{
  const tok = await signup('d@example.com', { device: 'd-phone' });
  await admin(`/grant d@example.com ${tenGb.id}`);
  const c = panelUser(pg3, 'd@example.com');
  c.used_traffic = 3 * GB;
  panelUser(fakes.pg, 'd@example.com').used_traffic = 1 * GB;
  await syncRounds(3);
  await admin('/drainpanel 3');
  const ask = fakes.tg.messages[fakes.tg.messages.length - 1];
  ok(ask.text.includes('مطمئنی') && JSON.stringify(ask.reply_markup).includes('cf:'), 'removal asks "are you sure?" first');
  ok((await env.DB.prepare('SELECT state FROM panels WHERE id = 3').first()).state === 'active', 'nothing happens before the confirmation');
  const token = JSON.stringify(ask.reply_markup).match(/cf:([0-9a-f]+)/)[1];
  await tgWebhook({ callback_query: { id: 'd1', data: `cf:${token}`, message: { chat: { id: 12345 }, message_id: 50, text: ask.text } } });
  ok((await env.DB.prepare('SELECT state FROM panels WHERE id = 3').first()).state === 'draining', 'confirmed: panel 3 is draining');
  await tgWebhook({ callback_query: { id: 'd2', data: `cf:${token}`, message: { chat: { id: 12345 }, message_id: 50, text: ask.text } } });
  ok((await env.DB.prepare("SELECT COUNT(*) c FROM admin_audit WHERE action = 'panel.drain'").first()).c === 1, 'a confirmation works once; logged once');
  const sub = await call('GET', '/api/v1/vpn/sub', { token: tok, headers: { 'x-device-id': 'd-phone' } });
  const body = await sub.res.text();
  ok(!body.includes('n3.example.org') && body.includes('n2.example.net') && body.includes('example.com'), 'draining panel left the list at once');
  await syncRounds(4);
  ok((await env.DB.prepare('SELECT state FROM panels WHERE id = 3').first()).state === 'disabled', 'after its last reading the panel is disabled');
  ok(c.status === 'disabled' && !!pg3.users[c.username], 'its accounts are switched off, not deleted');
  const s = (await call('GET', '/api/v1/me', { token: tok })).data.subscription;
  ok(s.used_bytes === 4 * GB && s.active, 'usage from the removed panel is still counted: ' + s.used_bytes);
  const kept = (await env.DB.prepare('SELECT COUNT(*) c FROM usage_counters WHERE panel_id = 3').first()).c;
  ok(kept > 0, 'usage rows of the removed panel are kept');
  ok(!!panelUser(fakes.pg, 'd@example.com') && !!panelUser(pg2, 'd@example.com'), 'its users are on the healthy panels');
  await admin('/drainpanel 3');
  ok(lastText().includes('قبلاً خارج شده'), 'cannot remove twice');
}

section('acceptance: expiry stops like a used-up quota, with its own reason, and the history keeps the period');
{
  const tok = await signup('e@example.com', { device: 'e-phone' });
  await admin(`/grant e@example.com ${tenGb.id}`);
  const uid = await userId('e@example.com');
  await env.DB.prepare('UPDATE subscriptions SET expires_at = ? WHERE user_id = ?').bind(Math.floor(Date.now() / 1000) - 5, uid).run();
  await runSync(env);
  const s = (await call('GET', '/api/v1/me', { token: tok })).data.subscription;
  ok(s.status === 'expired' && s.stop_reason === 'expired' && !s.active, 'expired, reason expired');
  ok(panelUser(fakes.pg, 'e@example.com').status === 'disabled' && panelUser(pg2, 'e@example.com').status === 'disabled', 'switched off on every panel');
  const per = await env.DB.prepare('SELECT * FROM sub_periods WHERE user_id = ? ORDER BY id DESC').bind(uid).first();
  ok(per.end_reason === 'expired' && per.ended_at, 'the period is closed with its reason');
  // renewing starts a new period and switches the accounts back on
  await admin(`/grant e@example.com ${tenGb.id}`);
  const s2 = (await call('GET', '/api/v1/me', { token: tok })).data.subscription;
  ok(s2.active && s2.used_bytes === 0 && s2.days_left >= 29, 'renewed from today');
  ok(panelUser(pg2, 'e@example.com').status === 'active', 'back on');
  ok((await env.DB.prepare('SELECT COUNT(*) c FROM sub_periods WHERE user_id = ?').bind(uid).first()).c === 2, 'both periods are in the history');
}

section('acceptance: the user sees one list with no trace of the panels');
{
  const tok = await signup('one@example.com', { device: 'one-phone' });
  await admin(`/grant one@example.com ${tenGb.id}`);
  const H = { 'x-device-id': 'one-phone', 'x-app-version': '1.9.0 (Android 14)' };
  const bodies = [];
  for (const p of ['/api/v1/me', '/api/v1/vpn', '/api/v1/vpn/servers', '/api/v1/vpn/sub']) {
    const r = await call('GET', p, { token: tok, headers: H });
    ok(r.status === 200, p + ' -> ' + r.status);
    bodies.push(await r.res.text());
  }
  const all = bodies.join("\n").replace(/"panel":\d+/g, "");  // the panel number (P1, P2) is shown to every user; no name or address
  ok(!/panel|\.test|MyPanel|sub_url|پنل/i.test(all), 'no panel name, address, label or link anywhere');
  const servers = JSON.parse(bodies[2]);
  ok(servers.length === 6 && servers.every((x) => /^(NL|DE|US) \d$/.test(x.name)), 'one merged list of 6, renamed by country: ' + servers.map((x) => x.name).join(', '));
  ok(new Set(servers.map((x) => x.link)).size === 6, 'no duplicates');
  const info = (await call('GET', '/api/v1/vpn/sub', { token: tok, headers: H })).res.headers.get('subscription-userinfo');
  ok(/total=10737418240/.test(info), 'usage header is the logical total: ' + info);
  const old = await call('GET', '/api/v1/vpn', { token: tok, headers: { 'x-device-id': 'one-phone', 'x-app-version': '1.8.0 (Android 14)' } });
  ok(!!old.data.subscription.sub_url, 'apps before 1.9.0 still get their link (no forced update)');
}

section('bot: link an existing panel account to an app user, without creating one');
{
  const A = { chat: { id: 12345 } };
  const since = (n) => fakes.tg.calls.slice(n);
  const kbData = (c) => ((c.body && c.body.reply_markup && c.body.reply_markup.inline_keyboard) || []).flat().map((x) => x.callback_data).filter(Boolean);
  const tap = (data, text = 'x') => tgWebhook({ callback_query: { id: 'lk-' + data, data, message: { ...A, message_id: 900, text } } });
  const confirmOf = (n) => since(n).find((c) => c.method === 'sendMessage' && c.body.text.includes('مطمئنی'));
  const now = Math.floor(Date.now() / 1000);
  const mkPanelUser = (name, extra = {}) => (fakes.pg.users[name] = { id: 5000 + Object.keys(fakes.pg.users).length, username: name, status: 'active',
    expire: now + 20 * 86400, data_limit: 30 * GB, used_traffic: 5 * GB, token: 'tok_' + name, note: 'made by hand', ...extra });

  const v2 = mkPanelUser('ali_v2');
  const tok = await signup('link1@example.com', { device: 'pleat-phone' });
  const uid = await userId('link1@example.com');
  const panelCount = Object.keys(fakes.pg.users).length;

  await admin('/link link1@example.com nobody_here');
  ok(lastText().includes('پیدا نشد'), 'a panel user that does not exist is refused: ' + lastText());
  await admin('/link link1@example.com');
  ok(lastText().includes('شکل درست'), 'missing username shows the usage');

  let n = fakes.tg.calls.length;
  await admin('/link link1@example.com ali_v2');
  const c1 = confirmOf(n);
  ok(c1 && c1.body.text.includes('ali_v2') && c1.body.text.includes('20 روز') && c1.body.text.includes('5.00 از 30.0'), 'asks first, showing the panel account: ' + (c1 && c1.body.text));
  ok(!(await env.DB.prepare('SELECT 1 x FROM panel_accounts WHERE user_id = ?').bind(uid).first()), 'nothing linked before "yes"');
  await tap(kbData(c1).find((d) => d.startsWith('lp:') && d.endsWith(':0')), c1.body.text);

  const pa = await env.DB.prepare('SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = 1').bind(uid).first();
  ok(pa && pa.remote_username === 'ali_v2' && pa.sub_path.includes('tok_ali_v2') && pa.desired === 'active', 'the app user now owns that panel account');
  ok(!Object.values(fakes.pg.users).some((x) => (x.note || '').endsWith('· link1@example.com') && Object.keys(fakes.pg.users).indexOf(x.username) < panelCount) && Object.keys(fakes.pg.users).length === panelCount,
    'no account was created on panel 1');
  ok(v2.status === 'active' && v2.token === 'tok_ali_v2' && v2.used_traffic === 5 * GB && v2.data_limit === 30 * GB, 'the panel account is unchanged (v2rayNG keeps working)');
  const me = (await call('GET', '/api/v1/me', { token: tok, headers: { 'x-app-version': '1.9.0 (Android 14)' } })).data;
  ok(me.subscription && me.subscription.active && me.subscription.used_bytes === 5 * GB && me.subscription.data_limit_bytes === 30 * GB && me.subscription.days_left === 20,
    'the app shows the same time, data and usage as the panel: ' + JSON.stringify(me.subscription));
  ok(me.trial_available === false, 'no free trial on top of a linked account');
  const servers = await call('GET', '/api/v1/vpn/servers', { token: tok, headers: { 'x-device-id': 'pleat-phone', 'x-app-version': '1.9.0 (Android 14)' } });
  ok(servers.status === 200 && servers.data.length >= 3 && fakes.pg.lastSubPath === '/sub/tok_ali_v2/', 'configs come from the linked account: ' + fakes.pg.lastSubPath);
  ok(!!(await env.DB.prepare("SELECT 1 x FROM admin_audit WHERE action = 'user.link' AND target_id = ? AND summary LIKE '%ali_v2%'").bind(String(uid)).first()), 'link is in the admin log');

  // usage on the panel keeps counting
  v2.used_traffic = 7 * GB;
  const me2 = (await call('GET', '/api/v1/me', { token: tok })).data;
  ok(me2.subscription.used_bytes === 7 * GB, 'new usage on the panel is counted: ' + me2.subscription.used_bytes);

  // the same panel account cannot go to a second user, or twice to the same one
  await signup('link2@example.com');
  await admin('/link link2@example.com ali_v2');
  ok(lastText().includes('link1@example.com'), 'already owned by another user is refused: ' + lastText());
  await admin('/link link1@example.com ali_v2');
  ok(lastText().includes('از قبل'), 'linking twice says it is already linked');

  // a used confirmation button cannot run again
  const before = (await env.DB.prepare("SELECT COUNT(*) c FROM admin_audit WHERE action = 'user.link'").first()).c;
  await tap(kbData(c1).find((d) => d.startsWith('lp:') && d.endsWith(':0')), c1.body.text);
  ok((await env.DB.prepare("SELECT COUNT(*) c FROM admin_audit WHERE action = 'user.link'").first()).c === before, 'a confirmation works once');

  // a user who already got an account (free trial / grant) gets it replaced; the old one is switched off, not deleted
  await signup('link3@example.com');
  await admin(`/grant link3@example.com ${tenGb.id}`);
  const uid3 = await userId('link3@example.com');
  const made = (await env.DB.prepare('SELECT remote_username FROM panel_accounts WHERE user_id = ? AND panel_id = 1').bind(uid3).first()).remote_username;
  const v3 = mkPanelUser('reza_v2', { expire: 0, data_limit: 0, used_traffic: 1 * GB });
  n = fakes.tg.calls.length;
  await admin('/link link3@example.com reza_v2');
  const c3 = confirmOf(n);
  ok(c3 && c3.body.text.includes('جایگزین') && c3.body.text.includes(made) && c3.body.text.includes('نامحدود'), 'the question warns about the current plan and account');
  await tap(kbData(c3).find((d) => d.startsWith('lp:') && d.endsWith(':0')), c3.body.text);
  const pa3 = await env.DB.prepare('SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = 1').bind(uid3).first();
  ok(pa3.remote_username === 'reza_v2', 'panel-1 account is now the linked one');
  ok(fakes.pg.users[made] && fakes.pg.users[made].status === 'disabled', 'the old account is switched off on the panel, not deleted');
  ok(v3.status === 'active', 'the linked account stays on');
  const s3 = await env.DB.prepare('SELECT * FROM subscriptions WHERE user_id = ?').bind(uid3).first();
  ok(s3.expires_at === null && s3.data_limit_bytes === 0 && s3.state === 'active' && s3.pg_username === 'reza_v2', 'subscription mirrors the linked account (unlimited)');
  const periods = (await env.DB.prepare('SELECT * FROM sub_periods WHERE user_id = ? ORDER BY id').bind(uid3).all()).results;
  ok(periods.length === 2 && periods[0].ended_at && periods[0].end_reason === 'admin' && !periods[1].ended_at, 'the granted period stays in the history');
  const others = (await env.DB.prepare('SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id != 1').bind(uid3).all()).results;
  ok(others.every((a) => a.desired_expire === null && a.desired_limit_bytes === 0), 'accounts on the other panels follow the new expiry and limit');

  // an account that is already out of time is linked, then stopped at once with its reason
  mkPanelUser('old_v2', { status: 'expired', expire: now - 86400 });
  await signup('link4@example.com');
  n = fakes.tg.calls.length;
  await admin('/link link4@example.com old_v2');
  const c4 = confirmOf(n);
  ok(c4 && c4.body.text.includes('تمام شده'), 'the question says the time is over');
  await tap(kbData(c4).find((d) => d.startsWith('lp:') && d.endsWith(':0')), c4.body.text);
  const s4 = await env.DB.prepare('SELECT state, stop_reason FROM subscriptions WHERE user_id = ?').bind(await userId('link4@example.com')).first();
  ok(s4.state === 'stopped' && s4.stop_reason === 'expired', 'an expired panel account shows as expired in the app');

  // from the button menu: user card -> "link" -> type the username -> confirm
  mkPanelUser('sara_v2');
  await signup('link5@example.com');
  const uid5 = await userId('link5@example.com');
  n = fakes.tg.calls.length;
  await admin('/find link5@example.com');
  ok(since(n).some((c) => kbData(c).includes(`m:w:link:${uid5}`)), 'the user card has a link button');
  await tap(`m:w:link:${uid5}`);
  n = fakes.tg.calls.length;
  await admin('sara_v2');
  const c5 = confirmOf(n);
  ok(c5 && c5.body.text.includes('sara_v2') && c5.body.text.includes('link5@example.com'), 'the typed username leads to the confirmation');
  await tap(kbData(c5).find((d) => d.startsWith('cx:')), c5.body.text);
  ok(!(await env.DB.prepare('SELECT 1 x FROM panel_accounts WHERE user_id = ?').bind(uid5).first()), '"cancel" links nothing');

  // a panel account on another panel, by its number
  pg2.users['nima_v2'] = { id: 77, username: 'nima_v2', status: 'active', expire: now + 5 * 86400, data_limit: 0, used_traffic: 0, token: 'tok_nima' };
  n = fakes.tg.calls.length;
  await admin('/link link5@example.com nima_v2 2');
  const c6 = confirmOf(n);
  if (c6) await tap(kbData(c6).find((d) => d.startsWith('lp:') && d.endsWith(':0')), c6.body.text);
  const p2state = (await env.DB.prepare('SELECT state FROM panels WHERE id = 2').first()).state;
  if (['active', 'rollout'].includes(p2state)) {
    const pa6 = await env.DB.prepare('SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = 2').bind(uid5).first();
    ok(pa6 && pa6.remote_username === 'nima_v2', 'linked on panel 2 by its number');
    ok((await env.DB.prepare('SELECT pg_username FROM subscriptions WHERE user_id = ?').bind(uid5).first()).pg_username === '', 'panel-1 username is not overwritten by another panel');
  } else ok(lastText().includes('فعال نیست'), 'a panel that is not serving cannot take a link');
}

section('link: hamid (30 days / 10 GB, 5 days gone, 2 GB used) gets every panel, one shared plan');
{
  const A = { chat: { id: 12345 } };
  const kbData = (c) => ((c.body && c.body.reply_markup && c.body.reply_markup.inline_keyboard) || []).flat().map((x) => x.callback_data).filter(Boolean);
  const kbText = (c) => ((c.body && c.body.reply_markup && c.body.reply_markup.inline_keyboard) || []).flat().map((x) => x.text);
  const tap = (data, text = 'x') => tgWebhook({ callback_query: { id: 'hm-' + data, data, message: { ...A, message_id: 901, text } } });
  const confirmOf = (n) => fakes.tg.calls.slice(n).find((c) => c.method === 'sendMessage' && c.body.text.includes('مطمئنی'));
  const now = Math.floor(Date.now() / 1000);
  const app = { 'x-app-version': '1.9.0 (Android 14)' };
  const plan30 = tenGb; // 30 days, 10 GB

  const h = (fakes.pg.users['hamid'] = { id: 9901, username: 'hamid', status: 'active', expire: now + 25 * 86400, data_limit: 10 * GB, used_traffic: 2 * GB, token: 'tok_hamid' });
  const tok = await signup('hamid@example.com', { device: 'hamid-phone' });
  let n = fakes.tg.calls.length;
  await admin('/link hamid@example.com hamid');
  const c = confirmOf(n);
  ok(c && kbText(c)[0].includes('پیشنهادی') && kbData(c)[0] === kbData(c).find((d) => d.endsWith(':' + plan30.id)), 'the plan that fits 10 GB / 25 days left is suggested first: ' + (c && kbText(c)[0]));
  await tap(kbData(c)[0], c.body.text);
  const me = (await call('GET', '/api/v1/me', { token: tok, headers: app })).data.subscription;
  ok(me.used_bytes === 2 * GB && me.data_limit_bytes === 10 * GB && me.days_left === 25 && me.plan_name, 'app: 2 of 10 GB, 25 days, with a plan name: ' + JSON.stringify({ u: me.used_bytes, d: me.days_left, p: me.plan_name }));
  await call('GET', '/api/v1/vpn/servers', { token: tok, headers: { ...app, 'x-device-id': 'hamid-phone' } });
  await syncRounds(3);
  const p2 = panelUser(pg2, 'hamid@example.com');
  ok(p2 && p2.data_limit === 8 * GB && Math.abs(p2.expire - h.expire) < 5, 'panel 2 gets an account with the 8 GB left and the same expiry');
  p2.used_traffic = 2 * GB;
  await call('GET', '/api/v1/me', { token: tok }); await syncRounds(3);
  const me2 = (await call('GET', '/api/v1/me', { token: tok })).data.subscription;
  ok(me2.used_bytes === 4 * GB && h.data_limit === 8 * GB && p2.data_limit === 8 * GB, '2 GB on panel 2: app shows 4 of 10, each panel = its own use + 6 GB left');
  h.used_traffic = 8 * GB;
  await call('GET', '/api/v1/me', { token: tok }); await syncRounds(3);
  ok(h.status === 'disabled' && p2.status === 'disabled', '10 GB in total switches both panels off');

  // the same person already has accounts on panel 1 AND panel 2: the second link adds up, it does not start over
  const hb = (fakes.pg.users['hamidb'] = { id: 9902, username: 'hamidb', status: 'active', expire: now + 25 * 86400, data_limit: 10 * GB, used_traffic: 2 * GB, token: 'tok_hb' });
  const hb2 = (pg2.users['hamidb2'] = { id: 9903, username: 'hamidb2', status: 'active', expire: now + 28 * 86400, data_limit: 10 * GB, used_traffic: 1 * GB, token: 'tok_hb2' });
  const tokb = await signup('hamidb@example.com', { device: 'hb-phone' });
  n = fakes.tg.calls.length; await admin('/link hamidb@example.com hamidb');
  let cb = confirmOf(n); await tap(kbData(cb)[0], cb.body.text);
  await call('GET', '/api/v1/vpn/servers', { token: tokb, headers: { ...app, 'x-device-id': 'hb-phone' } });
  const auto = panelUser(pg2, 'hamidb@example.com');
  if (auto) auto.used_traffic = 0.5 * GB;
  await call('GET', '/api/v1/me', { token: tokb });
  n = fakes.tg.calls.length; await admin('/link hamidb@example.com hamidb2 2');
  cb = confirmOf(n);
  ok(cb && cb.body.text.includes('جمع می‌شوند'), 'the question says the usage will be added up: ' + (cb && cb.body.text));
  await tap(kbData(cb)[0], cb.body.text);
  await call('GET', '/api/v1/me', { token: tokb }); await syncRounds(3);
  const mb = (await call('GET', '/api/v1/me', { token: tokb })).data.subscription;
  const want = 3 * GB + (auto ? 0.5 * GB : 0);
  ok(mb.used_bytes === want && mb.data_limit_bytes === 10 * GB && mb.days_left === 25, 'usage of both accounts (and the auto-made one) is summed, limit and time stay: ' + JSON.stringify({ u: mb.used_bytes / GB, d: mb.days_left }));
  const left = 10 * GB - want;
  ok(Math.abs(hb.data_limit - (2 * GB + left)) <= 64 * 1024 * 1024 && Math.abs(hb2.data_limit - (1 * GB + left)) <= 64 * 1024 * 1024, 'each panel is capped at its own use + what is left overall: ' + [hb.data_limit / GB, hb2.data_limit / GB]);
  ok(Math.abs(hb2.expire - hb.expire) < 5, 'the second account takes the same expiry as the first');
  ok(!auto || auto.status === 'disabled', 'the account the Worker had made on panel 2 is switched off');
  const periods = (await env.DB.prepare('SELECT COUNT(*) c FROM sub_periods WHERE user_id = ?').bind(await userId('hamidb@example.com')).first()).c;
  ok(periods === 1, 'still one period (no fresh start): ' + periods);
}

section('webhook is registered by the Worker, with no secret in the path');
{
  await env.DB.prepare("DELETE FROM settings WHERE key = 'tg_webhook_sig'").run();
  const before = fakes.tg.calls.filter((c) => c.method === 'setWebhook').length;
  await worker.scheduled({ cron: '* * * * *' }, env, ctx); await drain();
  const calls = fakes.tg.calls.filter((c) => c.method === 'setWebhook');
  ok(calls.length === before + 1 && calls[calls.length - 1].body.url === 'https://api.test/tg' && calls[calls.length - 1].body.secret_token === 'hook', 'setWebhook to /tg with secret_token');
  const cmds = fakes.tg.calls.filter((c) => c.method === 'setMyCommands').pop();
  ok(cmds && cmds.body.scope.chat_id === '12345' && cmds.body.commands.some((c) => c.command === 'menu'), 'menu command shown to the admin chat only');
  await worker.scheduled({ cron: '* * * * *' }, env, ctx); await drain();
  ok(fakes.tg.calls.filter((c) => c.method === 'setWebhook').length === before + 1, 'not repeated while nothing changed');
  ok((await call('POST', '/tg', { json: { message: { chat: { id: 12345 }, text: '/help' } }, headers: TG })).status === 200, '/tg with the header works');
  ok((await call('POST', '/tg', { json: { message: { chat: { id: 12345 }, text: '/help' } } })).status === 404, '/tg without the header is closed');
}

section('backup and errors never carry a panel address');
{
  const { backupJson } = await import('../src/telegram.js');
  const b = await backupJson(env);
  ok(!b.includes('//panel.test') && !b.includes('panel2.test') && !b.includes('/sub/'), 'backup has no panel links');
  const { PasarGuardError } = await import('../src/pasarguard.js');
  ok(!new PasarGuardError('cannot reach http://panel.test/api (timeout)').message.includes('panel.test'), 'panel errors drop URLs');
}

section('acceptance: an existing user keeps account, link and session through the migration');
{
  const { signJwt } = await import('../src/util.js');
  const DB2 = makeDB(new URL('../migrations/0001_init.sql', import.meta.url).pathname, { upto: '0010_indexes.sql' });
  const now = Math.floor(Date.now() / 1000);
  await DB2.prepare("INSERT INTO users (id, email, password_hash, referral_code, created_at) VALUES (1, 'old@example.com', 'x', 'OLD0001', ?)").bind(now - 86400 * 90).run();
  await DB2.prepare("INSERT INTO plans (id, name, duration_days, price_toman) VALUES (1, 'Monthly', 30, 1)").run();
  await DB2.prepare("INSERT INTO subscriptions (user_id, pg_username, plan_id, expires_at, data_limit_bytes, device_limit, sub_url, updated_at) VALUES (1, 'cg_1_abcd', 1, ?, ?, 2, 'http://panel.test/sub/oldtoken/', ?)")
    .bind(now + 86400 * 10, 50 * GB, now - 86400).run();
  fakes.pg.users['cg_1_abcd'] = { id: 999, username: 'cg_1_abcd', status: 'active', expire: now + 86400 * 12, data_limit: 50 * GB, used_traffic: 7 * GB, token: 'oldtoken' };
  { // then every later migration, like a deploy does
    const fs = await import('node:fs');
    const dir = new URL('../migrations/', import.meta.url);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql') && x > '0010_indexes.sql').sort()) DB2.exec(fs.readFileSync(new URL(f, dir), 'utf8'));
  }
  const env2 = { ...env, DB: DB2 };
  const oldToken = await signJwt({ sub: '1', ver: 0, typ: 'access' }, env.SECRET_KEY, 600);
  const req = new Request('https://api.test/api/v1/me', { headers: { authorization: 'Bearer ' + oldToken } });
  const me = await (await worker.fetch(req, env2, ctx)).json();
  ok(me.email === 'old@example.com', 'the old session still works (no new login)');
  ok(me.subscription.used_bytes === 7 * GB && me.subscription.days_left === 12 && me.subscription.data_limit_bytes === 50 * GB, 'same usage, expiry and limit as on the panel');
  ok(!!me.subscription.sub_url && me.subscription.sub_url.includes('oldtoken'), 'old app keeps the same link');
  const pa = await DB2.prepare('SELECT * FROM panel_accounts WHERE user_id = 1').first();
  ok(pa && pa.remote_username === 'cg_1_abcd' && pa.panel_id === 1, 'panel account is the same user (same UUID)');
  ok(fakes.pg.users['cg_1_abcd'].status === 'active' && fakes.pg.users['cg_1_abcd'].hwid_limit === undefined, 'nothing was changed on the panel');
}


section('security audit round 1: F1-F6 and N1 regressions');
{
  const { scanAll, checkOrder } = await import('../src/chainwatch.js');
  const XLM = 'G' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 55);
  const MEMO = '84021733';
  const nowIso = new Date().toISOString();
  const rial = (n) => n.toLocaleString('en-US');
  const getOrder = (id) => env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  const wallet = async (t) => (await call('GET', '/api/v1/me', { token: t })).data.wallet_balance;
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.price_toman === 189000);

  // ---- F1: a bank SMS number is rial; the same digits never pay an order of that many toman
  await botSet('card_number', '6037991234567893');
  await botSet('card_auto', 'auto');
  await botSet('sms_senders', '+989100');
  const key = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'sms_key'").bind().first()).value;
  const f1 = await signup('f1@example.com', { device: 'f1' });
  const o1 = (await call('POST', '/api/v1/orders', { token: f1, json: { topup_toman: 1000000, method: 'card' } })).data;
  const tenth = await call('POST', '/sms/' + key, { json: { from: '+989100', text: `بانک ملی\nواریز: ${rial(o1.amount_toman)}\nمانده: 3,000,000` } });
  ok(tenth.data.result !== 'paid' && (await getOrder(o1.id)).status !== 'paid' && (await wallet(f1)) === 0, 'F1: paying the order amount in rial (one tenth) does not confirm it: ' + tenth.data.result);
  const tenthRial = await call('POST', '/sms/' + key, { json: { from: '+989100', text: `واریز ${rial(o1.amount_toman)} ریال` } });
  ok(tenthRial.data.result !== 'paid' && (await getOrder(o1.id)).status !== 'paid', 'F1: an SMS that says ریال is never read as toman');
  const full = await call('POST', '/sms/' + key, { json: { from: '+989100', text: `بانک ملی\nواریز: ${rial(o1.amount_toman * 10)}\nمانده: 9,000,000` } });
  ok(full.data.result === 'paid' && (await wallet(f1)) === o1.amount_toman, 'F1: the full amount in rial still confirms it');
  const logRow = await env.DB.prepare('SELECT amount_rial FROM sms_log WHERE order_id = ?').bind(o1.id).first();
  ok(logRow && logRow.amount_rial === o1.amount_toman * 10, 'F1: sms_log records the real rial amount');

  // ---- F2: an attacker's order just under a plan price never takes another user's exact transfer
  await botSet('wallet_xlm', XLM); await botSet('wallet_xlm_memo', MEMO); await botSet('coin_auto', 'auto');
  const att = await signup('f2-attacker@example.com', { device: 'f2a' });
  const vic = await signup('f2-victim@example.com', { device: 'f2v' });
  const ao = (await call('POST', '/api/v1/orders', { token: att, json: { topup_toman: 187000, method: 'coin', coin: 'xlm' } })).data;
  const vo = (await call('POST', '/api/v1/orders', { token: vic, json: { plan_id: monthly.id, method: 'coin', coin: 'xlm' } })).data;
  const ratio = Number(vo.coin.amount) / Number(ao.coin.amount);
  ok(ratio > 1 && ratio < 1.02, `F2 setup: the victim's amount sits inside the attacker's +2% window (${ratio.toFixed(4)})`);
  globalThis.__chain.xlm = [{ type: 'payment', to: XLM, asset_type: 'native', amount: vo.coin.amount, transaction_hash: '7'.repeat(64), created_at: nowIso, transaction: { memo: MEMO } }];
  globalThis.__cgChk = {};
  await call('GET', `/api/v1/orders/${ao.id}`, { token: att }); // the attacker polls first
  await scanAll(env);
  ok((await getOrder(ao.id)).status !== 'paid' && !(await getOrder(ao.id)).txid && (await wallet(att)) === 0, 'F2: the attacker order did not get the victim transfer');
  ok((await getOrder(vo.id)).status === 'paid' && (await getOrder(vo.id)).txid === '7'.repeat(64), 'F2: the victim order is paid by its own transfer');
  // a transfer a little above an order's amount (owned by no other order) waits for the admin
  const oo = (await call('POST', '/api/v1/orders', { token: att, json: { topup_toman: 120000, method: 'coin', coin: 'xlm' } })).data;
  globalThis.__chain.xlm = [{ type: 'payment', to: XLM, asset_type: 'native', amount: (Number(oo.coin.amount) * 1.01).toFixed(7), transaction_hash: '8'.repeat(64), created_at: nowIso, transaction: { memo: MEMO } }];
  await scanAll(env);
  ok((await getOrder(oo.id)).status === 'review' && (await wallet(att)) === 0, 'F2: an inexact transfer goes to the admin, never auto-confirmed');
  // quotes: two open orders of the same amount never share an exact coin amount
  const q1 = (await call('POST', '/api/v1/orders', { token: att, json: { topup_toman: 150000, method: 'coin', coin: 'xlm' } })).data;
  await env.DB.prepare('UPDATE orders SET coin_amount = ? WHERE id = ?').bind('99.0000001', q1.id).run();
  const clashRows = await env.DB.prepare("SELECT coin_amount, COUNT(*) n FROM orders WHERE method = 'coin' AND status NOT IN ('paid','cancelled','rejected') GROUP BY coin, coin_address, coin_amount HAVING n > 1").bind().all();
  ok(clashRows.results.length === 0, 'F2: every open coin order has its own exact amount');

  // ---- F3: one transfer is tied to one order, also when two callers race
  await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE method = 'coin' AND status != 'paid'").bind().run();
  const r1 = (await call('POST', '/api/v1/orders', { token: att, json: { topup_toman: 1000000, method: 'coin', coin: 'xlm' } })).data;
  const r2 = (await call('POST', '/api/v1/orders', { token: att, json: { topup_toman: 1000000, method: 'coin', coin: 'xlm' } })).data;
  // a transfer just above both amounts (exact for neither): both orders' windows cover it
  const over = (Math.max(Number(r1.coin.amount), Number(r2.coin.amount)) * 1.005).toFixed(7);
  globalThis.__chain.xlm = [{ type: 'payment', to: XLM, asset_type: 'native', amount: over, transaction_hash: '9'.repeat(64), created_at: nowIso, transaction: { memo: MEMO } }];
  // D1 answers over the network: every query yields, so two requests interleave like in production
  const slow = (db) => ({ ...db, batch: db.batch.bind(db), exec: db.exec && db.exec.bind(db), prepare: (sql) => { const st = db.prepare(sql); return { bind: (...a) => { const b = st.bind(...a); const lag = (f) => new Promise((res) => setTimeout(res, 2)).then(f); return { first: () => lag(() => b.first()), all: () => lag(() => b.all()), run: () => lag(() => b.run()) }; } }; } });
  const envLat = { ...env, DB: slow(env.DB) };
  globalThis.__cgChk = {};
  await Promise.all([checkOrder(envLat, await getOrder(r1.id)), checkOrder(envLat, await getOrder(r2.id))]);
  const holders = (await env.DB.prepare("SELECT id FROM orders WHERE txid = ?").bind('9'.repeat(64)).all()).results;
  ok(holders.length === 1, 'F3: two racing checks tie the transfer to exactly one order (holders: ' + holders.length + ')');
  // a transfer held by an order that is still being settled is not given to another order
  await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE method = 'coin' AND status != 'paid'").bind().run();
  const s1 = (await call('POST', '/api/v1/orders', { token: att, json: { topup_toman: 200000, method: 'coin', coin: 'xlm' } })).data;
  const s2 = (await call('POST', '/api/v1/orders', { token: att, json: { topup_toman: 300000, method: 'coin', coin: 'xlm' } })).data;
  await env.DB.prepare("UPDATE orders SET txid = ?, status = 'settling', settling_at = ? WHERE id = ?").bind('6'.repeat(64), Math.floor(Date.now() / 1000), s1.id).run();
  globalThis.__chain.xlm = [{ type: 'payment', to: XLM, asset_type: 'native', amount: s2.coin.amount, transaction_hash: '6'.repeat(64), created_at: nowIso, transaction: { memo: MEMO } }];
  const walletBefore = await wallet(att);
  await scanAll(env);
  ok((await getOrder(s2.id)).status !== 'paid' && (await wallet(att)) === walletBefore, 'F3: a transfer held by an order in settlement pays nothing else');

  // ---- F4: a one-use code cannot be reused through an expired (or rejected) order
  await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE method = 'coin' AND status != 'paid'").bind().run();
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/coupon ONCEF4 50 1' } });
  const f4 = await signup('f4@example.com', { device: 'f4' });
  const c1 = await call('POST', '/api/v1/orders', { token: f4, json: { plan_id: monthly.id, method: 'coin', coin: 'xlm', coupon_code: 'ONCEF4' } });
  ok(c1.status === 201, 'F4 setup: first order takes the code');
  await env.DB.prepare('UPDATE orders SET coin_expires_at = 1 WHERE id = ?').bind(c1.data.id).run();
  ok((await call('GET', `/api/v1/orders/${c1.data.id}`, { token: f4 })).data.status === 'expired', 'F4 setup: quote expired');
  const c2 = await call('POST', '/api/v1/orders', { token: f4, json: { plan_id: monthly.id, method: 'coin', coin: 'xlm', coupon_code: 'ONCEF4' } });
  ok(c2.status === 400 && c2.data.detail.code === 'coupon_in_use', 'F4: an expired order still holds the code: ' + c2.status + ' ' + JSON.stringify(c2.data.detail));
  // the code is also redeemed at delivery: a second order of the same user carrying it is not delivered
  const cp = await env.DB.prepare("SELECT * FROM coupons WHERE code = 'ONCEF4'").bind().first();
  await call('POST', `/api/v1/orders/${c1.data.id}/paid`, { token: f4, json: { txid: '5'.repeat(64) } }); // late payment -> review
  await tgWebhook({ callback_query: { id: 'f4a', data: `ap:${c1.data.id}`, message: { chat: { id: 12345 }, message_id: 41 } } });
  ok((await getOrder(c1.data.id)).status === 'paid', 'F4 setup: the first order is delivered with the code');
  const sneak = await env.DB.prepare("INSERT INTO orders (user_id, kind, plan_id, amount_toman, method, status, coupon_id, list_price_toman, created_at) VALUES ((SELECT id FROM users WHERE email = 'f4@example.com'), 'plan', ?, 95000, 'coin', 'review', ?, 189000, ?) RETURNING id").bind(monthly.id, cp.id, Math.floor(Date.now() / 1000)).first();
  await tgWebhook({ callback_query: { id: 'f4b', data: `ap:${sneak.id}`, message: { chat: { id: 12345 }, message_id: 42 } } });
  const cpAfter = await env.DB.prepare('SELECT used FROM coupons WHERE id = ?').bind(cp.id).first();
  ok((await getOrder(sneak.id)).status !== 'paid' && cpAfter.used === 1, 'F4: a second order with the same one-use code is not delivered, used stays 1');

  // ---- F5: one account cannot flood the shared google map with invented servers
  const f5 = await signup('f5@example.com', { device: 'f5' });
  let lastG = null;
  for (let i = 0; i < 31; i++) {
    globalThis.__cgGoo = {};
    lastG = await call('POST', '/api/v1/net/google', { token: f5, json: { k: 'zz' + String(i).padStart(6, '0'), cc: 'DE', google_cc: 'DE', gemini: true } });
  }
  ok(lastG.data.skipped === 'too_many', 'F5: the 31st new server from one account in a day is refused');
  globalThis.__cgGoo = {};
  await call('POST', '/api/v1/net/google', { token: f5, json: { k: 'zz000000', cc: 'DE', google_cc: 'DE', gemini: true } });
  const zz = await env.DB.prepare("SELECT tests FROM google_probe WHERE skey = 'zz000000'").bind().first();
  ok(zz.tests === 1, 'F5: the same server counts once per account per day');
  const rank5 = (await call('GET', '/api/v1/net/rank', { token: f5 })).data;
  ok(Object.keys(rank5.google).filter((k) => k.startsWith('zz')).length <= 30, 'F5: /net/rank carries at most 30 of that account\'s servers');
  for (const [who, gcc] of [['f5c', 'DE'], ['f5d', 'DE'], ['f5b', 'IR']]) {
    globalThis.__cgGoo = {};
    await call('POST', '/api/v1/net/google', { token: await signup(who + '@example.com', { device: who }), json: { k: 'zy000001', cc: 'DE', google_cc: gcc, gemini: gcc !== 'IR' } });
  }
  ok((await call('GET', '/api/v1/net/rank', { token: f5 })).data.google.zy000001.status !== 'iran', 'F5: one latest Iran report among others does not flip a server to "iran"');

  // ---- F6: one report counts one vote per server
  const MTN = { asn: 44244, asOrganization: 'Iran Cell', region: 'Tehran', city: 'Tehran' };
  const f6 = await signup('f6@example.com', { device: 'f6' });
  globalThis.__cgNet = {};
  const dup = await call('POST', '/api/v1/net/report', { token: f6, cf: MTN, json: { results: Array.from({ length: 60 }, () => ({ k: 'f6f6f6f6', ok: true, ms: 20 })) } });
  ok(dup.data.stored === 1, 'F6: 60 copies of one server in one report count once: ' + dup.data.stored);
  globalThis.__cgNet = {};
  const again6 = await call('POST', '/api/v1/net/report', { token: f6, cf: MTN, json: { results: [{ k: 'f6f6f6f6', ok: true, ms: 20 }] } });
  ok(again6.data.stored === 0, 'F6: the same account votes once per server per 3 hours');
  const r6 = (await call('GET', '/api/v1/net/rank', { token: f6, cf: MTN })).data;
  ok(r6.servers.f6f6f6f6 && r6.servers.f6f6f6f6.n === 1, 'F6: the ranking shows one result, not 60');

  // ---- N1: the bot answers the admin only in their private chat
  const before = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'referral_percent'").bind().first() || {}).value;
  await tgWebhook({ message: { chat: { id: 12345, type: 'supergroup' }, from: { id: 999 }, text: '/set referral_percent 55' } });
  await tgWebhook({ message: { chat: { id: 12345, type: 'group' }, from: { id: 12345 }, text: '/set referral_percent 56' } });
  await tgWebhook({ message: { chat: { id: 12345, type: 'private' }, from: { id: 999 }, text: '/set referral_percent 57' } });
  const after = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'referral_percent'").bind().first() || {}).value;
  ok(after === before, 'N1: a group chat, or someone other than the admin, cannot run admin commands');
  const nOrder = (await call('POST', '/api/v1/orders', { token: f1, json: { plan_id: monthly.id, method: 'card' } })).data;
  const bA = fakes.tg.messages.length;
  await tgWebhook({ callback_query: { id: 'n1', data: `ap:${nOrder.id}`, from: { id: 999 }, message: { chat: { id: 12345, type: 'supergroup' }, message_id: 77 } } });
  ok((await getOrder(nOrder.id)).status !== 'paid', 'N1: an approve tap from a group member is refused');
  const bI = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: -100555, type: 'supergroup' }, from: { id: 999 }, text: '/id' } });
  ok(fakes.tg.messages.slice(bI).some((m) => m.text.includes('چت خصوصی')), 'N1: /id in a group says the bot works only in a private chat');
  await tgWebhook({ message: { chat: { id: 12345, type: 'private' }, from: { id: 12345 }, text: '/set referral_percent 12' } });
  ok((await env.DB.prepare("SELECT value FROM settings WHERE key = 'referral_percent'").bind().first()).value === '12', 'N1: the admin in their private chat still runs commands');
}

section('carriers: speed per network, own servers only, people count');
{
  const ns = await import('../src/netstats.js');
  ok(ns.serverKey('vless://uuid@de1.example.com:443?security=tls#x') === 'k53ca1f60', 'server key matches Pleat and the Cloud Gold app');
  const vm = 'vmess://' + btoa(JSON.stringify({ add: 'De1.Example.com', port: 443, ps: 'x' }));
  ok(ns.serverKey(vm) === ns.serverKey('vmess://' + btoa(JSON.stringify({ add: 'de1.example.com', port: '443' }))), 'vmess key from add/port, case-insensitive');
  const RTL = { asn: 57218, asOrganization: 'Rightel' };
  const toks = [], ids = [];
  for (let i = 0; i < 4; i++) {
    toks.push(await signup(`car${i}@example.com`, { device: 'car' + i }));
    ids.push((await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(`car${i}@example.com`).first()).id);
  }
  // three people have servers g1 and g2; g1 is fast, g2 slow
  for (let i = 0; i < 3; i++) {
    await ns.rememberKeys(env, { id: ids[i] }, [{ name: 'DE 1', link: 'vless://u@g1.example.com:443#a' }, { name: 'NL 1', link: 'vless://u@g2.example.com:443#b' }]);
  }
  const g1 = ns.serverKey('vless://u@g1.example.com:443'), g2 = ns.serverKey('vless://u@g2.example.com:443');
  for (let i = 0; i < 3; i++) {
    globalThis.__cgNet = {};
    const r = await call('POST', '/api/v1/net/report', { token: toks[i], cf: RTL, json: { results: [{ k: g1, ok: true, ms: 200 }, { k: g2, ok: true, ms: 200 }, { k: 'zzzz9999', ok: true, ms: 5 }] } });
    ok(r.data.stored === 2, 'a server the user does not have is not counted: ' + r.data.stored);
    globalThis.__cgNet = {};
    const sp = await call('POST', '/api/v1/net/report', { token: toks[i], cf: RTL, json: { results: [{ k: g1, kbps: 9000 }, { k: g2, kbps: 900 }] } });
    ok(sp.data.stored === 2, 'speed-only results stored');
  }
  globalThis.__cgNet = {};
  const again = await call('POST', '/api/v1/net/report', { token: toks[0], cf: RTL, json: { results: [{ k: g1, kbps: 999999999 }] } });
  ok(again.data.stored === 0, 'one speed vote per user per server per 3 hours');
  const r = (await call('GET', '/api/v1/net/rank', { token: toks[0], cf: RTL })).data;
  ok(r.isp_en === 'Rightel' && r.mobile === true, 'English carrier name for Pleat: ' + r.isp_en);
  ok(r.servers[g1].kbps === 9000 && r.servers[g2].kbps === 900, 'average speed per carrier: ' + JSON.stringify(r.servers[g1]));
  ok(r.servers[g1].users === 3 && r.servers[g1].n === 3, 'people counted once each');
  ok(r.servers[g1].score > r.servers[g2].score, 'faster server ranks higher when both connect');
  ok(r.servers[g1].ok === undefined && !JSON.stringify(r).includes('car0@'), 'no user data in the ranking');
  // a user who never loaded servers (older app) still reports, with the old limits
  globalThis.__cgNet = {};
  const old = await call('POST', '/api/v1/net/report', { token: toks[3], cf: RTL, json: { results: [{ k: g1, ok: false }] } });
  ok(old.data.stored === 1, 'older apps without a server list still count');
  const other = (await call('GET', '/api/v1/net/rank', { token: toks[0], cf: { asn: 12345, asOrganization: 'Some Net Ltd' } })).data;
  ok(other.isp_en === 'Some Net Ltd' && other.mobile === false && Object.keys(other.servers).length === 0, 'unknown network: its own name, no data from other carriers');
  const sum = await ns.carrierSummary(env);
  const rt = sum.find((x) => x.asn === 57218);
  ok(rt && rt.isp === 'رایتل' && rt.servers[0].name === 'DE 1', 'admin summary names the servers: ' + JSON.stringify(rt && rt.servers[0]));
  const bm = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: 12345, type: 'private' }, from: { id: 12345 }, text: '/carriers' } });
  ok(fakes.tg.messages.slice(bm).some((m) => m.text.includes('رایتل') && m.text.includes('DE 1')), '/carriers lists best servers per carrier');
}

section('per-user networks: operator + connection type, per-type ranking, admin view');
{
  const ns = await import('../src/netstats.js');
  const MTN = { asn: 44244, asOrganization: 'Iran Cell', region: 'Tehran' };
  const toks = [], ids = [];
  for (let i = 0; i < 3; i++) {
    toks.push(await signup(`un${i}@example.com`, { device: 'un' + i }));
    ids.push((await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(`un${i}@example.com`).first()).id);
  }
  // 40 servers each: the report must stay far below D1's 50 queries per request (free plan)
  const links = Array.from({ length: 40 }, (_, i) => ({ name: `X ${i}`, link: `vless://u@x${i}.example.com:443#x` }));
  const keys = links.map((l) => ns.serverKey(l.link));
  const [kx, ky] = [keys[0], keys[1]];
  for (const id of ids) await ns.rememberKeys(env, { id }, links);
  const prep = env.DB.prepare, batch = env.DB.batch;
  let queries = 0;
  env.DB.prepare = (sql) => { queries++; return prep(sql); };
  globalThis.__cgNet = {};
  const big = await call('POST', '/api/v1/net/report', { token: toks[0], cf: MTN, json: { kind: 'wifi', results: keys.map((k, i) => ({ k, ok: i !== 1, ms: 100 + i, kbps: i === 0 ? 8000 : undefined })) } });
  env.DB.prepare = prep; env.DB.batch = batch;
  ok(big.data.stored === 40, 'a 40-server report is stored whole: ' + big.data.stored);
  ok(queries <= 12, 'a 40-server report takes a fixed few queries, not one per server: ' + queries);
  // Irancell over Wi-Fi: X works, Y does not. Irancell mobile data: the other way round.
  for (let i = 0; i < 3; i++) {
    globalThis.__cgNet = {};
    if (i) await call('POST', '/api/v1/net/report', { token: toks[i], cf: MTN, json: { kind: 'wifi', results: [{ k: kx, ok: true, ms: 90 }, { k: ky, ok: false }] } });
    globalThis.__cgNet = {};
    await call('POST', '/api/v1/net/report', { token: toks[i], cf: MTN, json: { kind: 'cell', results: [{ k: kx, ok: false }, { k: ky, ok: true, ms: 90 }] } });
  }
  const nets = await env.DB.prepare('SELECT kind, isp FROM user_net WHERE user_id = ? ORDER BY kind').bind(ids[0]).all();
  ok(nets.results.length === 2 && nets.results[0].kind === 'cell' && nets.results[1].kind === 'wifi' && nets.results[0].isp === 'ایرانسل', 'one row per operator and connection type: ' + JSON.stringify(nets.results));
  const wifi = (await call('GET', '/api/v1/net/rank?kind=wifi', { token: toks[0], cf: MTN })).data;
  const cell = (await call('GET', '/api/v1/net/rank?kind=cell', { token: toks[0], cf: MTN })).data;
  ok(wifi.kind === 'wifi' && wifi.servers[kx].score > wifi.servers[ky].score && wifi.servers[kx].level === 'type', 'Irancell Wi-Fi ranks X first: ' + JSON.stringify(wifi.servers[kx]));
  ok(cell.kind === 'cell' && cell.servers[ky].score > cell.servers[kx].score, 'Irancell mobile data ranks Y first');
  const plain = (await call('GET', '/api/v1/net/rank?kind=bogus', { token: toks[0], cf: MTN })).data;
  ok(plain.kind === '' && plain.servers[kx].level !== 'type', 'an unknown kind falls back to the operator-wide ranking');
  // one account reporting over and over keeps a bounded weight
  for (let i = 0; i < 25; i++) { globalThis.__cgNet = {}; await call('POST', '/api/v1/net/report', { token: toks[0], cf: MTN, json: { kind: 'other', results: [{ k: kx, ok: false }] } }); }
  for (let i = 0; i < 25; i++) { globalThis.__cgNet = {}; await call('POST', '/api/v1/net/report', { token: toks[0], cf: MTN, json: { kind: 'other', results: [{ k: kx, ok: true, ms: 50 }] } }); }
  const row = await env.DB.prepare('SELECT ok, fail, tests FROM user_net_srv WHERE user_id = ? AND kind = ? AND skey = ?').bind(ids[0], 'other', kx).first();
  ok(row.ok <= 5 && row.ok > 4.5 && row.fail < 0.05 && row.tests === 50, 'a user\'s weight on a server stays at most 5 results and follows the latest: ' + JSON.stringify(row));
  const sp = await env.DB.prepare('SELECT kb_sum, kb_n, ok FROM user_net_srv WHERE user_id = ? AND kind = ? AND skey = ?').bind(ids[0], 'wifi', kx).first();
  ok(sp.kb_n === 1 && sp.kb_sum === 8000, 'speed kept per user and network');
  // admin view: the user card names the networks, the button opens the detail, the overview counts people
  const txt = await ns.userNetText(env, { id: ids[0], email: 'un0@example.com' });
  ok(txt.includes('ایرانسل · وای‌فای') && txt.includes('ایرانسل · دیتای موبایل') && txt.includes('X 0') && txt.includes('🔴'), 'user detail lists each network with best and weakest servers');
  ok(!/vless:|k[0-9a-f]{8}|example\.com:443/.test(txt.replace('un0@example.com', '')), 'no link or server key in the admin text');
  const card = await (await import('../src/telegram.js')).userInfo(env, (await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(ids[0]).first()));
  ok(card.includes('📶 اپراتورها: ایرانسل'), 'user card names the operators');
  const ov = await ns.networkUsers(env);
  ok(ov.text.includes('ایرانسل · دیتای موبایل — 3 کاربر'), 'overview counts users per operator and type: ' + ov.text);
  ok(ov.recent.some((r) => r.id === ids[0]), 'overview lists the users who reported last: ' + JSON.stringify(ov.recent));
  const none = await ns.userNetText(env, { id: 999999, email: 'x@example.com' });
  ok(none.includes('هنوز گزارشی'), 'a user with no reports says so');
  // old rows go after 30 days
  await env.DB.prepare('UPDATE user_net SET last_at = 1 WHERE user_id = ?').bind(ids[2]).run();
  await env.DB.prepare('UPDATE user_net_srv SET at = 1 WHERE user_id = ?').bind(ids[2]).run();
  await ns.prune(env);
  ok(!(await env.DB.prepare('SELECT 1 FROM user_net WHERE user_id = ?').bind(ids[2]).first()) && !(await env.DB.prepare('SELECT 1 FROM user_net_srv WHERE user_id = ?').bind(ids[2]).first()), 'per-user rows pruned after 30 days');
}

section('/me/ip: the exit address and place the app shows while connected');
{
  const tok = await signup('ip@example.com', { device: 'ipd' });
  const r = await call('GET', '/api/v1/me/ip', { token: tok, headers: { 'cf-connecting-ip': '185.220.101.42' }, cf: { country: 'DE', city: 'Frankfurt am Main', region: 'Hesse' } });
  ok(r.status === 200 && r.data.ip === '185.220.101.42' && r.data.cc === 'DE' && r.data.city === 'Frankfurt am Main', '/me/ip answers ip, country and city: ' + JSON.stringify(r.data));
  const no = await call('GET', '/api/v1/me/ip', {});
  ok(no.status === 401, '/me/ip needs a signed-in user');
}

section('any panel type: Rebecca, Marzban and PasarGuard are detected on /paneltest and each gets its own create call');
{
  const { getPanel, adapterFor, collectLinks, testPanel } = await import('../src/panels.js');
  const { ensureAccount } = await import('../src/sync.js');
  const lastId = async () => (await env.DB.prepare('SELECT MAX(id) id FROM panels').first()).id;
  const R = 'https://reb.test:8000', M = 'http://marz.test', H = 'http://hidd.test';
  const reb = fakes.addPanel(R, 'r.example.io', 'rebecca');
  const marz = fakes.addPanel(M, 'm.example.io', 'marzban');
  fakes.addPanel(H, 'h.example.io', 'none');
  ok(panelBases(R + '/dashboard/').join() === R, 'dashboard address with a port gives the API root with that port');

  await admin('/addpanel ربکا');
  const rid = await lastId();
  let p = await getPanel(env, rid);
  ok(p.kind === 'auto' && p.label === 'ربکا', 'add without a type: type left to the test');
  let threw = '';
  try { await adapterFor(env, p); } catch (e) { threw = e.message; }
  ok(threw.includes(`/panelcred ${rid}`), 'no login yet: says how to give it: ' + threw);
  env[`PANEL_${rid}_CRED`] = JSON.stringify({ url: R + '/dashboard/', username: 'ra', password: 'Reb3ccaSecret' });
  try { await adapterFor(env, p); threw = ''; } catch (e) { threw = e.message; }
  ok(threw.includes('/paneltest'), 'an auto panel cannot be used before its test: ' + threw);
  await admin(`/paneltest ${rid}`);
  p = await getPanel(env, rid);
  ok(p.kind === 'rebecca' && p.state === 'testing', 'Rebecca detected and stored: ' + p.kind + ' ' + p.state);
  ok(lastText().includes('rebecca') && lastText().includes('سالم است'), 'test reply names the type and passes: ' + lastText());
  const made = reb.createLog[reb.createLog.length - 1];
  ok(made.service_id === 4 && !('group_ids' in made) && !('hwid_limit' in made) && !('proxies' in made), 'Rebecca user made in a service: ' + JSON.stringify(made));
  ok(!JSON.stringify(fakes.tg.messages).includes('Reb3ccaSecret') && !JSON.stringify(fakes.tg.messages).includes('reb.test'), 'bot never shows the panel password or address');

  // a Rebecca admin with no usable service gets told how to set one
  reb.services = [];
  await admin(`/paneltest ${rid}`);
  const lastKb = () => JSON.stringify(fakes.tg.messages[fakes.tg.messages.length - 1].reply_markup || {});
  ok(lastKb().includes(`m:w:groups:${rid}`) && lastText().includes('سرویس') && !lastText().includes('/panelgroups'), 'no service: a button asks for the service: ' + lastText());
  await admin(`/panelgroups ${rid} 9`);
  await admin(`/paneltest ${rid}`);
  ok(lastText().includes('سالم است') && reb.createLog[reb.createLog.length - 1].service_id === 9, 'service set by hand is used');
  reb.services = [{ id: 4, name: 'main', has_hosts: true, broken: false }];

  // accounts and configs on Rebecca: its v2rayNG answer is Xray JSON, plain links come from <sub>/v2ray
  const tok = await signup('reb@example.com', { device: 'reb-phone' });
  const uid = await userId('reb@example.com');
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first();
  const pa = await ensureAccount(env, user, p, { expire: Math.floor(Date.now() / 1000) + 86400, limit: 5 * GB, hwid: 2 });
  ok(pa && pa.sub_path.startsWith(R + '/sub/'), 'Rebecca account has an absolute subscription link');
  reb.subJson = true;
  await env.DB.prepare("UPDATE panels SET state = 'active' WHERE id = ?").bind(rid).run();
  const got = await collectLinks(env, uid, {});
  ok(got.links.filter((l) => l.includes('r.example.io')).length === 3, 'configs read through <sub>/v2ray: ' + got.links.length);
  const pgR = await adapterFor(env, await getPanel(env, rid));
  await pgR.modifyUser(pa.remote_username, { status: 'active', data_limit: GB, hwid_limit: 3 });
  ok(!('hwid_limit' in reb.putBodies[reb.putBodies.length - 1]), 'PasarGuard-only fields are not sent to Rebecca');
  ok(await pgR.deleteHwid(pa.remote_username, 'x') === false, 'no device list on Rebecca: nothing to delete');
  ok(tok, 'user signed up');

  // a Marzban panel added under the wrong type is corrected while it has no users
  await admin('/addpanel pasarguard مرزبان');
  const mid = await lastId();
  env[`PANEL_${mid}_CRED`] = JSON.stringify({ url: M, username: 'ma', password: 'mp' });
  await admin(`/paneltest ${mid}`);
  p = await getPanel(env, mid);
  ok(p.kind === 'marzban' && lastText().includes('خودکار تشخیص'), 'wrong type corrected to marzban: ' + p.kind);
  const mm = marz.createLog[marz.createLog.length - 1];
  ok(mm.proxies && 'vless' in mm.proxies && 'trojan' in mm.proxies && !('shadowsocks' in mm.proxies) && !('group_ids' in mm), 'Marzban user gets the panel protocols: ' + JSON.stringify(mm.proxies));

  // a panel that already serves users keeps its type; the test says what it really is
  await env.DB.prepare("UPDATE panels SET kind = 'pasarguard', state = 'active' WHERE id = ?").bind(rid).run();
  const t = await testPanel(env, await getPanel(env, rid));
  ok(!t.healthy && t.kind === 'rebecca' && t.error.includes('already serves users') && (await getPanel(env, rid)).kind === 'pasarguard', 'serving panel is not retyped behind the admin');
  await env.DB.prepare("UPDATE panels SET kind = 'rebecca', state = 'disabled' WHERE id = ?").bind(rid).run();
  await env.DB.prepare("UPDATE panels SET state = 'disabled' WHERE id = ?").bind(mid).run();

  // something that is not in the family: a clear answer, not a crash
  await admin('/addpanel دیگر');
  const hid = await lastId();
  env[`PANEL_${hid}_CRED`] = JSON.stringify({ url: H, username: 'h', password: 'h' });
  await admin(`/paneltest ${hid}`);
  ok(lastText().includes('does not answer like PasarGuard, Marzban or Rebecca') && !lastText().includes('hidd.test'), 'unknown panel: clear message without the address: ' + lastText());
  env[`PANEL_${hid}_CRED`] = 'not json';
  await admin(`/paneltest ${hid}`);
  ok(JSON.stringify(fakes.tg.messages[fakes.tg.messages.length - 1].reply_markup || {}).includes(`m:w:panelcred:${hid}`), 'broken secret: a button asks for the login');
  await env.DB.prepare("UPDATE panels SET state = 'disabled' WHERE id = ?").bind(hid).run();

  // panel 1 (PasarGuard) is still recognised as PasarGuard
  const t1 = await testPanel(env, await getPanel(env, 1));
  ok(t1.kind === 'pasarguard' && !t1.kindChanged, 'PasarGuard still detected as PasarGuard');
}

section('panel login given to the bot: message deleted, stored sealed, panel tested at once');
{
  const { getPanel, adapterFor, credSource } = await import('../src/panels.js');
  const { seal, openSealed } = await import('../src/util.js');
  const R2 = 'https://reb2.test:8000';
  const reb2 = fakes.addPanel(R2, 'r2.example.io', 'rebecca');
  const PW = 'Sup3rS3cretPw';
  const adminMsg = (text, id) => tgWebhook({ message: { chat: { id: 12345 }, message_id: id, text } });
  const lastId = async () => (await env.DB.prepare('SELECT MAX(id) id FROM panels').first()).id;
  const deleted = (id) => fakes.tg.calls.some((c) => c.method === 'deleteMessage' && c.body.message_id === id);
  const sealedOf = async (id) => (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(`panel_cred_${id}`).first())?.value;

  await admin('/addpanel ربکا دو');
  const id = await lastId();
  ok(lastText().includes('یوزرنیم و رمز'), 'add asks for the login right away');
  await adminMsg(`${R2}/dashboard/\nadmin2\n${PW}`, 9001);
  ok(deleted(9001), 'the message with the password is deleted from the chat');
  const sealed = await sealedOf(id);
  ok(sealed && sealed.startsWith('s1.') && !sealed.includes(PW) && !sealed.includes('reb2'), 'stored sealed, no password or address in clear');
  const p = await getPanel(env, id);
  ok(p.kind === 'rebecca' && p.state === 'testing' && lastText().includes('سالم است'), 'tested and typed right after saving: ' + lastText());
  ok(reb2.createLog.length === 1, 'the test made its throw-away user on that panel');
  ok(!JSON.stringify(fakes.tg.messages).includes(PW) && !JSON.stringify(fakes.tg.messages).includes('reb2.test'), 'no reply repeats the password or address');
  ok(await credSource(env, p) === 'bot', 'login source is the bot');
  const log = await env.DB.prepare("SELECT summary AS detail FROM admin_audit WHERE action = 'panel.cred' ORDER BY id DESC").first();
  ok(log && !String(log.detail).includes(PW), 'audit row without the password');

  // the bot's login wins over an old Workers Secret; with another SECRET_KEY it cannot be read
  env[`PANEL_${id}_CRED`] = JSON.stringify({ url: 'http://other.test', username: 'x', password: 'y' });
  ok((await adapterFor(env, p)).bases[0] === R2, 'bot login is used before the Workers Secret');
  ok(await openSealed('another-key-entirely-0123456789', `panel-cred:${id}`, sealed) === null, 'another SECRET_KEY cannot open it');
  ok(await openSealed(env.SECRET_KEY, 'panel-cred:999', sealed) === null, 'a sealed login moved to another panel does not open');
  ok(await openSealed(env.SECRET_KEY, 'x', await seal(env.SECRET_KEY, 'x', 'hi')) === 'hi', 'seal round trip');
  delete env[`PANEL_${id}_CRED`];

  // direct command, with a mistake first
  await adminMsg(`/panelcred ${id} notaurl admin2`, 9002);
  ok(deleted(9002) && lastText().includes('دوباره بفرست') && (await sealedOf(id)) === sealed, 'bad input: deleted, asked again, nothing changed');
  await adminMsg(`${R2} admin2 ${PW}2`, 9003);
  ok(deleted(9003) && (await sealedOf(id)) !== sealed && lastText().includes('سالم است'), 'answer to the re-ask is saved and tested');
  await adminMsg(`/panelcred ${id} ${R2} admin2 ${PW}`, 9004);
  ok(deleted(9004) && lastText().includes('سالم است'), 'one-line /panelcred works and is deleted');
  await admin('/panelcred 1 http://x.test a b');
  ok(lastText().includes('PASARGUARD_'), 'panel 1 keeps its own secrets');

  // a login typed after its question expired is still removed from the chat
  await adminMsg(`${R2} admin2 ${PW}`, 9005);
  ok(deleted(9005) && lastText().includes('ذخیره نشد'), 'stray login message is deleted and not saved');

  const { backupJson } = await import('../src/telegram.js');
  ok(!(await backupJson(env)).includes('panel_cred_'), 'sealed logins are not in the backup');
  await env.DB.prepare("UPDATE panels SET state = 'disabled' WHERE id = ?").bind(id).run();
}

section('a new panel reaches existing users: at once when the app loads servers, in the background, with progress and errors in the bot');
{
  const { getPanel } = await import('../src/panels.js');
  const { panelProgress } = await import('../src/sync.js');
  const N = 'https://newp.test';
  const np = fakes.addPanel(N, 'nn.example.net', 'pasarguard');
  const lastId = async () => (await env.DB.prepare('SELECT MAX(id) id FROM panels').first()).id;
  const tokA = await signup('na@example.com', { device: 'na-phone' });
  await signup('nb@example.com', { device: 'nb-phone' });
  await admin(`/grant na@example.com ${tenGb.id}`);
  await admin(`/grant nb@example.com ${tenGb.id}`);
  await admin('/addpanel pasarguard تازه');
  const id = await lastId();
  await tgWebhook({ message: { chat: { id: 12345 }, message_id: 9100, text: `${N} admin9 pass9pass` } });
  const healthy = fakes.tg.messages[fakes.tg.messages.length - 1];
  ok(healthy.text.includes('سالم است') && JSON.stringify(healthy.reply_markup).includes(`/rollout ${id} 10`), 'healthy test offers rollout buttons');

  // a tapped "/rollout" arrives without the number
  await admin('/rollout');
  ok(lastText().includes('شماره‌ی پنل را هم بنویس') && lastText().includes(`#${id}`), 'command without a panel number explains and lists panels: ' + lastText());

  await admin(`/rollout ${id} 100`);
  ok(/0 از \d+ کاربر/.test(lastText()), 'rollout reply says how many users already have the panel: ' + lastText());
  const p = await getPanel(env, id);
  const before = await panelProgress(env, p);
  ok(before.want >= 2 && before.have === 0, 'progress counts users with a running plan: ' + JSON.stringify(before));
  await admin('/panels');
  ok(lastText().includes(`اکانت‌سازی: 0 از ${before.want}`), '/panels shows the progress');

  // the app loads servers: the user's account on the new panel is made now and its configs are in this answer
  const r = await call('GET', '/api/v1/vpn/servers', { token: tokA });
  ok(r.status === 200 && Object.values(np.users).some((u) => (u.note || '').endsWith('· na@example.com')), 'account made on the new panel at app load');
  ok(JSON.stringify(r.data).includes('nn.example.net'), 'new panel configs are in the same server list');
  const mid = await panelProgress(env, p);
  ok(mid.have === 1, 'progress moved: ' + JSON.stringify(mid));

  // the background job picks up the rest
  await syncRounds(4);
  const after = await panelProgress(env, p);
  ok(after.have === after.want, 'background job finished the rest: ' + JSON.stringify(after));

  // a panel that refuses: admin told once, the app does not wait on it, the bot shows the error
  const np2 = fakes.addPanel('https://newq.test', 'nq.example.net', 'pasarguard');
  await admin('/addpanel pasarguard خراب');
  const qid = await lastId();
  await tgWebhook({ message: { chat: { id: 12345 }, message_id: 9101, text: `https://newq.test admin8 pass8pass` } });
  await admin(`/rollout ${qid} 100`);
  np2.failCreate = 'Admin users limit reached';
  const msgs = fakes.tg.messages.length;
  const tries = np2.createLog.length;
  const r2 = await call('GET', '/api/v1/vpn/servers', { token: tokA });
  ok(r2.status === 200 && JSON.stringify(r2.data).includes('nn.example.net'), 'a refusing panel does not break the list');
  const warn = fakes.tg.messages.slice(msgs).filter((m) => m.text.includes(`پنل #${qid}`) && m.text.includes('Admin users limit reached'));
  ok(warn.length === 1, 'admin told once about the refusing panel: ' + warn.length);
  const tried = np2.createLog.length;
  ok(tried > tries, 'the app tried the new panel once');
  await call('GET', '/api/v1/vpn/servers', { token: tokA });
  ok(np2.createLog.length === tried, 'the app does not retry a refusing panel right away');
  await syncRounds(2);
  ok(fakes.tg.messages.slice(msgs).filter((m) => m.text.includes(`پنل #${qid}`) && m.text.includes('ساخته نمی‌شود')).length === 1, 'no repeated warnings within hours');
  await admin('/panels');
  ok(lastText().includes('ساخت اکانت رد شد') && lastText().includes('Admin users limit reached'), '/panels shows the refusal');
  np2.failCreate = null;
  await syncRounds(2);
  await admin('/panels');
  ok(!lastText().includes('ساخت اکانت رد شد'), 'error cleared once creates work again');
  for (const x of [id, qid]) await env.DB.prepare("UPDATE panels SET state = 'disabled' WHERE id = ?").bind(x).run();
}

section('no typing: commands in bot messages become buttons, a menu button stays under the chat');
{
  const { buttonize } = await import('../src/telegram.js');
  const b = buttonize('برای شروع: /rollout 2 10 یا /paneltest 2. شکل درست: /addpanel نام', undefined);
  ok(!/\/[a-z]/.test(b.text) && b.text.includes('«🚀 پنل #2 برای 10٪ کاربران»'), 'command text replaced by the button name: ' + b.text);
  const data = b.reply_markup.inline_keyboard.flat().map((x) => x.callback_data);
  ok(data.includes('m:x:home|/rollout 2 10') && data.includes('m:x:home|/paneltest 2') && data.includes('m:w:addpanel'), 'each command has its button: ' + data.join());
  const keep = buttonize('ok /panels', { inline_keyboard: [[{ text: 'a', callback_data: 'm:home' }]] });
  ok(keep.reply_markup.inline_keyboard[0][0].callback_data === 'm:home' && keep.reply_markup.inline_keyboard.length === 2, 'existing buttons kept, new ones added');
  ok(buttonize('https://p.example.com:8000/dashboard/ and /api/x').text.includes('/dashboard/'), 'addresses are left alone');
  const n = fakes.tg.calls.length;
  await admin('/start');
  ok(fakes.tg.calls.slice(n).some((c) => c.method === 'sendMessage' && c.body.reply_markup && c.body.reply_markup.keyboard && c.body.reply_markup.keyboard[0][0].text === '🏠 منو'), '/start puts the menu button under the chat');
  const m = fakes.tg.calls.length;
  await admin('🏠 منو');
  ok(fakes.tg.calls.slice(m).some((c) => c.method === 'sendMessage' && JSON.stringify(c.body.reply_markup || {}).includes('m:usr')), 'the menu button opens the menu');
  // every message the bot sent in this whole run: no "/command" the admin would have to type
  const left = fakes.tg.messages.map((x) => x.text || '').filter((t) => /(^|[\s(:،«])\/(panels?|paneltest|rollout|drainpanel|panelcred|panelgroups|addpanel|find|grant|set|plan|plans|newplan|coupons?|delcoupon|backup|google|carriers|rate|sms|wallets|stats|settings|menu|help)\b/.test(t));
  ok(left.length === 0, 'no bot message asks to type a command: ' + (left[0] || '').slice(0, 200));
}

section('panel test names the config types and flags ones the app cannot use');
{
  const { linkKinds } = await import('../src/panels.js');
  const vm = 'vmess://' + btoa(JSON.stringify({ v: '2', ps: 'x', add: 'a.example', port: '443', id: 'u', net: 'ws', tls: 'tls' }));
  const k = linkKinds(['vless://u@a.example:443?security=reality&type=tcp#a', 'vless://u@b.example:443?security=tls&type=xhttp#b', 'ss://YWVzOnB3@c.example:1#c', vm, 'hysteria2://p@d.example:443#d', 'wireguard://k@e.example:51820#e', 'tuic://u@f.example:443#f']);
  ok(k.counts['vless·reality·tcp'] === 1 && k.counts['vless·tls·xhttp'] === 1 && k.counts.shadowsocks === 1 && k.counts['vmess·tls·ws'] === 1, 'types counted: ' + JSON.stringify(k.counts));
  ok(k.unusable === 1, 'only tuic flagged as not usable; hysteria2 and wireguard run in the app');
  ok(k.counts['hysteria2'] === 1 && k.counts['wireguard'] === 1, 'hysteria2 and wireguard counted by name');
  await admin('/paneltest 1');
  ok(lastText().includes('نوع کانفیگ‌ها:') && lastText().includes('vless·reality·tcp') && !lastText().includes('پشتیبانی نمی‌کند'), 'paneltest shows the types: ' + lastText());
}

section('sign up and log in with Telegram (6-digit code from the bot)');
{
  env.TELEGRAM_BOT_USERNAME = 'PleatBot';
  const tgUser = (id, username, first_name = 'Sara') => ({ id, is_bot: false, username, first_name });
  const openLink = (nonce, from) => tgWebhook({ message: { chat: { id: from.id, type: 'private' }, from, text: '/start L' + nonce } });
  const lastCode = () => { const t = fakes.tg.messages[fakes.tg.messages.length - 1]; const m = /<code>(\d{6})<\/code>/.exec(t.text || ''); return m && m[1]; };
  const start = async () => (await call('POST', '/api/v1/auth/tg/start')).data;

  const s1 = await start();
  ok(/^[a-f0-9]{32}$/.test(s1.nonce) && s1.bot_url === `https://t.me/PleatBot?start=L${s1.nonce}`, 'start gives a nonce and the bot link');
  const early = await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: s1.nonce, code: '123456' } });
  ok(early.status === 409 && early.data.detail.code === 'code_not_sent', 'no code before the bot was opened');

  const sara = tgUser(777001, 'Sara_K');
  await openLink(s1.nonce, sara);
  const code1 = lastCode();
  ok(code1 && fakes.tg.messages[fakes.tg.messages.length - 1].chat_id === 777001 && fakes.tg.messages[fakes.tg.messages.length - 1].parse_mode === 'HTML', 'bot sends a 6-digit code to the Telegram user: ' + code1);
  const row = await env.DB.prepare('SELECT * FROM tg_logins').first();
  ok(row && !JSON.stringify(row).includes(s1.nonce) && !JSON.stringify(row).includes(code1), 'nonce and code are stored only as hashes');

  // someone else opening the same link gets nothing
  const n0 = fakes.tg.messages.length;
  await openLink(s1.nonce, tgUser(999, 'thief'));
  ok(fakes.tg.messages.length === n0 + 1 && !lastCode() && lastText().includes('another Telegram account'), 'second Telegram account cannot take the link');

  const wrongCode = code1 === '000000' ? '111111' : '000000';
  const w = await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: s1.nonce, code: wrongCode } });
  ok(w.status === 400 && w.data.detail.code === 'bad_code', 'wrong code rejected');
  const otherNonce = (await start()).nonce;
  ok((await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: otherNonce, code: code1 } })).status >= 400, 'code only works with its own nonce');

  const v = await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: s1.nonce, code: code1 } });
  ok(v.status === 200 && v.data.need_password === true && v.data.signup_token && v.data.login === '@sara_k', 'new Telegram user is asked for a password: ' + JSON.stringify(v.data));
  ok((await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: s1.nonce, code: code1 } })).status === 400, 'code cannot be used twice');
  const weak = await call('POST', '/api/v1/auth/tg/register', { json: { signup_token: v.data.signup_token, password: 'short' } });
  ok(weak.status === 422, 'weak password rejected');
  const reg = await call('POST', '/api/v1/auth/tg/register', { json: { signup_token: v.data.signup_token, password: 'tg-pass-123', device_id: 'tg-dev' } });
  ok(reg.status === 201 && reg.data.access_token, 'account created with Telegram');
  const again = await call('POST', '/api/v1/auth/tg/register', { json: { signup_token: v.data.signup_token, password: 'tg-pass-123' } });
  ok(again.status === 409 && again.data.detail.code === 'telegram_taken', 'one account per Telegram account');
  const me = (await call('GET', '/api/v1/me', { token: reg.data.access_token })).data;
  ok(me.login === '@sara_k' && me.telegram.id === '777001' && me.email === '', 'me shows the Telegram login: ' + JSON.stringify({ login: me.login, telegram: me.telegram }));

  // later logins: @username, username without @, numeric id, any case
  for (const l of ['@sara_k', 'Sara_K', '777001', '@SARA_K']) {
    const r = await call('POST', '/api/v1/auth/login', { json: { login: l, password: 'tg-pass-123' } });
    ok(r.status === 200 && r.data.access_token, 'login with ' + l);
  }
  ok((await call('POST', '/api/v1/auth/login', { json: { login: '@sara_k', password: 'wrong-pass' } })).status === 401, 'wrong password with username rejected');
  ok((await call('POST', '/api/v1/auth/register', { json: { email: 'tg777001@telegram.local', password: 'password123' } })).status === 422, 'nobody can take a Telegram address by email');

  // Telegram button again on an existing account logs straight in, and a renamed username follows the person
  const s2 = await start();
  await openLink(s2.nonce, tgUser(777001, 'sara_new'));
  const v2 = await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: s2.nonce, code: lastCode() } });
  ok(v2.status === 200 && v2.data.access_token && !v2.data.need_password && v2.data.login === '@sara_new', 'existing account logs in with the code alone');
  ok((await call('POST', '/api/v1/auth/login', { json: { login: '@sara_new', password: 'tg-pass-123' } })).status === 200, 'new username works');
  ok((await call('POST', '/api/v1/auth/login', { json: { login: '@sara_k', password: 'tg-pass-123' } })).status === 401, 'old username no longer works');

  // someone else now has the old username on Telegram: it moves to them
  const s3 = await start();
  await openLink(s3.nonce, tgUser(888002, 'sara_new', 'Other'));
  const v3 = await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: s3.nonce, code: lastCode() } });
  const reg3 = await call('POST', '/api/v1/auth/tg/register', { json: { signup_token: v3.data.signup_token, password: 'other-pass-1' } });
  ok(reg3.status === 201, 'second Telegram user signs up');
  const r3 = await call('POST', '/api/v1/auth/login', { json: { login: '@sara_new', password: 'other-pass-1' } });
  ok(r3.status === 200, 'username belongs to whoever has it now on Telegram');
  ok((await call('POST', '/api/v1/auth/login', { json: { login: '777001', password: 'tg-pass-123' } })).status === 200, 'first user still logs in with the numeric id');

  // no username: the numeric id is the login
  const s4 = await start();
  await openLink(s4.nonce, { id: 555003, is_bot: false, first_name: 'NoName' });
  const v4 = await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: s4.nonce, code: lastCode() } });
  ok(v4.data.login === '555003', 'no username -> numeric id is the login');

  // guessing: 5 wrong tries, then the code is dead even if the 6th is right
  const s5 = await start();
  await openLink(s5.nonce, tgUser(666004, 'guess_me'));
  const good5 = lastCode();
  const bad5 = good5 === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: s5.nonce, code: bad5 } });
  const sixth = await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: s5.nonce, code: good5 } });
  ok(sixth.status === 429 && sixth.data.detail.code === 'too_many_tries', 'after 5 wrong codes the right one is refused');
  // tapping Start again sends a fresh code (max 5 per link)
  await openLink(s5.nonce, tgUser(666004, 'guess_me'));
  ok((await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: s5.nonce, code: lastCode() } })).status === 200, 'a fresh code from the bot works');

  // expired link
  const s6 = await start();
  await env.DB.prepare('UPDATE tg_logins SET expires_at = 1').run();
  await openLink(s6.nonce, tgUser(666005, 'late_one'));
  ok(!lastCode() && lastText().includes('expired'), 'expired link gives no code');
  await env.DB.prepare('UPDATE tg_logins SET code_expires_at = 1').run();
  ok((await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: s4.nonce, code: '123456' } })).status === 400, 'expired code refused');

  // bot: a stranger opening the bot directly is told how to sign in; the admin's own sign-in link works too
  await tgWebhook({ message: { chat: { id: 4242, type: 'private' }, from: tgUser(4242, 'stranger'), text: '/start' } });
  ok(lastText().includes('Continue with Telegram'), 'stranger /start explains sign-in');
  const s7 = await start();
  await tgWebhook({ message: { chat: { id: 12345, type: 'private' }, from: { id: 12345, username: 'ali_admin' }, text: '/start L' + s7.nonce } });
  ok(!!lastCode(), 'admin can sign in to the app with Telegram too');
  // group chats never get codes
  const s8 = await start();
  const ng = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: -100, type: 'group' }, from: tgUser(31, 'grp'), text: '/start L' + s8.nonce } });
  ok(fakes.tg.messages.length === ng, 'no code in a group chat');

  // admin finds Telegram users by @username or id
  await admin('/find @sara_new');
  ok(lastText().includes('تلگرام: @sara_new') && lastText().includes('888002'), 'admin /find by @username');
  await admin('/find 777001');
  ok(lastText().includes('آیدی 777001'), 'admin /find by numeric id');
  delete env.TELEGRAM_BOT_USERNAME;
}

section('profile: verify Telegram on an email account, backup email, package history');
{
  env.TELEGRAM_BOT_USERNAME = 'PleatBot';
  const openLink = (nonce, from) => tgWebhook({ message: { chat: { id: from.id, type: 'private' }, from, text: '/start L' + nonce } });
  const lastCode = () => { const t = fakes.tg.messages[fakes.tg.messages.length - 1]; const m = /<code>(\d{6})<\/code>/.exec(t.text || ''); return m && m[1]; };
  const tok = await signup('profile@example.com', { device: 'prof-dev' });
  let me = (await call('GET', '/api/v1/me', { token: tok })).data;
  ok(me.telegram_verified === false && me.telegram === null && me.email === 'profile@example.com', 'email account starts without Telegram');

  const s = (await call('POST', '/api/v1/me/telegram/start', { token: tok })).data;
  ok(/^[a-f0-9]{32}$/.test(s.nonce) && s.bot_url.includes('start=L' + s.nonce), 'link start gives a bot link');
  // Telegram account already owned by someone else: no code is sent
  await openLink(s.nonce, { id: 777001, is_bot: false, username: 'whoever', first_name: 'X' });
  ok(!lastCode() && lastText().includes('another Pleat account'), 'a Telegram account of another user gets no code');
  const s2 = (await call('POST', '/api/v1/me/telegram/start', { token: tok })).data;
  await openLink(s2.nonce, { id: 555123, is_bot: false, username: 'Prof_User', first_name: 'Prof' });
  const code = lastCode();
  ok(code && lastText().includes('verification code'), 'bot sends a verification code');
  // a link code can never be used to sign in, and a sign-in code can never link
  const asLogin = await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: s2.nonce, code } });
  ok(asLogin.status === 400, 'a verification code cannot log in');
  const other = await signup('profile2@example.com');
  ok((await call('POST', '/api/v1/me/telegram/verify', { token: other, json: { nonce: s2.nonce, code } })).status === 400, 'another account cannot use this code');
  const v = await call('POST', '/api/v1/me/telegram/verify', { token: tok, json: { nonce: s2.nonce, code } });
  ok(v.status === 200 && v.data.telegram_verified && v.data.telegram.username === 'prof_user' && v.data.login === '@prof_user', 'Telegram verified: ' + JSON.stringify(v.data));
  ok((await call('POST', '/api/v1/me/telegram/start', { token: tok })).status === 409, 'cannot verify twice');
  const ph = await call('GET', '/api/v1/me/photo', { token: tok });
  ok(ph.status === 200 && ph.data.photo === btoa(String.fromCharCode(0xff, 0xd8, 0xff, 1, 2, 3)), 'Telegram photo comes through the Worker');
  ok(fakes.tg.calls.some((c) => c.method === 'getFile' && c.body.file_id === 's'), 'the small photo size is used');
  ok((await call('GET', '/api/v1/me/photo', { token: other })).data.photo === null, 'no Telegram, no photo');
  ok((await call('POST', '/api/v1/auth/login', { json: { login: '@prof_user', password: 'password123' } })).status === 200, 'logs in with the Telegram username now');
  ok((await call('POST', '/api/v1/auth/login', { json: { login: 'profile@example.com', password: 'password123' } })).status === 200, 'email still logs in');
  const sl = (await call('POST', '/api/v1/auth/tg/start')).data;
  await openLink(sl.nonce, { id: 555123, is_bot: false, username: 'Prof_User', first_name: 'Prof' });
  const lg = await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: sl.nonce, code: lastCode() } });
  ok(lg.status === 200 && lg.data.access_token, 'Continue with Telegram now opens the same account');
  // sign-in link (no account) cannot be used through the link endpoint
  const sl2 = (await call('POST', '/api/v1/auth/tg/start')).data;
  await openLink(sl2.nonce, { id: 600600, is_bot: false, username: 'newbie', first_name: 'N' });
  ok((await call('POST', '/api/v1/me/telegram/verify', { token: other, json: { nonce: sl2.nonce, code: lastCode() } })).status === 400, 'a sign-in code cannot link');

  // backup email on a Telegram account
  const s3 = (await call('POST', '/api/v1/auth/tg/start')).data;
  await openLink(s3.nonce, { id: 600700, is_bot: false, username: 'gmail_fan', first_name: 'G' });
  const v3 = await call('POST', '/api/v1/auth/tg/verify', { json: { nonce: s3.nonce, code: lastCode() } });
  const tgTok = (await call('POST', '/api/v1/auth/tg/register', { json: { signup_token: v3.data.signup_token, password: 'gmail-pass-1' } })).data.access_token;
  ok((await call('GET', '/api/v1/me', { token: tgTok })).data.email === '', 'no email shown before one is added');
  ok((await call('POST', '/api/v1/me/email', { token: tgTok, json: { email: 'fan@gmail.com', password: 'nope-nope' } })).status === 400, 'email needs the password');
  ok((await call('POST', '/api/v1/me/email', { token: tgTok, json: { email: 'not-an-email', password: 'gmail-pass-1' } })).status === 422, 'bad email rejected');
  ok((await call('POST', '/api/v1/me/email', { token: tgTok, json: { email: 'x@telegram.local', password: 'gmail-pass-1' } })).status === 422, 'made-up Telegram address rejected');
  ok((await call('POST', '/api/v1/me/email', { token: tgTok, json: { email: 'profile2@example.com', password: 'gmail-pass-1' } })).data.detail.code === 'email_taken', 'someone else\'s email rejected');
  const e1 = await call('POST', '/api/v1/me/email', { token: tgTok, json: { email: ' Fan@Gmail.com ', password: 'gmail-pass-1' } });
  ok(e1.status === 200 && e1.data.email === 'fan@gmail.com' && e1.data.login === '@gmail_fan', 'Gmail saved: ' + JSON.stringify(e1.data));
  ok((await call('POST', '/api/v1/auth/login', { json: { login: 'fan@gmail.com', password: 'gmail-pass-1' } })).status === 200, 'logs in with the Gmail too');
  const e2 = await call('POST', '/api/v1/me/email', { token: tgTok, json: { email: '', password: 'gmail-pass-1' } });
  ok(e2.status === 200 && e2.data.email === '', 'Gmail removed');
  ok((await call('POST', '/api/v1/auth/login', { json: { login: 'fan@gmail.com', password: 'gmail-pass-1' } })).status === 401, 'removed Gmail no longer logs in');
  ok((await call('POST', '/api/v1/me/email', { token: other, json: { email: '', password: 'password123' } })).status === 422, 'an account without Telegram keeps its email');

  // a Pleat character as the profile picture
  ok((await call('GET', '/api/v1/me', { token: tok })).data.avatar === null, 'no avatar picked yet');
  const av = await call('POST', '/api/v1/me/avatar', { token: tok, json: { avatar: 'Luna' } });
  ok(av.status === 200 && av.data.avatar === 'luna', 'avatar picked: ' + JSON.stringify(av.data));
  ok((await call('GET', '/api/v1/me', { token: tok })).data.avatar === 'luna', 'avatar kept on /me');
  ok((await call('POST', '/api/v1/me/avatar', { token: tok, json: { avatar: '../x.svg' } })).status === 422, 'unknown avatar rejected');
  ok((await call('GET', '/api/v1/me', { token: other })).data.avatar === null, 'only my avatar changed');
  ok((await call('POST', '/api/v1/me/avatar', { token: tok, json: { avatar: '' } })).data.avatar === null, 'avatar cleared');
  ok((await call('POST', '/api/v1/me/avatar', { json: { avatar: 'kai' } })).status === 401, 'avatar needs a login');

  // package history: a trial, then a purchase that stacks on it, and a gift from the admin
  const pk0 = await call('GET', '/api/v1/me/packages', { token: tok });
  ok(pk0.status === 200 && Array.isArray(pk0.data) && pk0.data.length === 0, 'no packages yet');
  const plans = (await call('GET', '/api/v1/plans')).data;
  const trialPlan = plans.find((p) => p.trial_days > 0);
  ok((await call('POST', '/api/v1/trial', { token: tok, json: { plan_id: trialPlan.id }, headers: { 'x-device-id': 'prof-dev' } })).status === 200, 'trial started');
  const meRow = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind('profile@example.com').first();
  await env.DB.prepare('UPDATE users SET wallet_balance = 5000000 WHERE id = ?').bind(meRow.id).run();
  const monthly = plans.find((p) => p.trial_days === 0);
  const buy = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'wallet' } });
  ok(buy.status === 201 && buy.data.status === 'paid', 'bought with wallet');
  const pk = (await call('GET', '/api/v1/me/packages', { token: tok })).data;
  ok(pk.length === 2 && pk[0].source === 'order' && pk[1].source === 'trial', 'trial and purchase listed, newest first: ' + pk.map((x) => x.source).join(','));
  ok(pk[0].current && !pk[1].current && pk[1].end_reason === 'renewed', 'the purchase is the running package');
  ok(pk[0].purchased_at && pk[0].activated_at && pk[0].order_id === buy.data.id && pk[0].amount_toman === buy.data.amount_toman && pk[0].method === 'wallet', 'purchase has its dates, order and price');
  ok(pk[1].purchased_at === null && pk[1].activated_at && pk[1].amount_toman === null, 'trial has an activation date only');
  ok(pk[0].days >= monthly.duration_days && typeof pk[0].used_bytes === 'number' && pk[0].name === monthly.name, 'the stacked package keeps the trial time left: ' + pk[0].days);
  // someone else's packages are never shown
  ok((await call('GET', '/api/v1/me/packages', { token: other })).data.length === 0, 'only my packages');
  delete env.TELEGRAM_BOT_USERNAME;
}

section('panel info rows dressed as configs are not servers');
{
  const { unify, isPlaceholder } = await import('../src/panels.js');
  const info = 'vless://00000000-0000-4000-8000-000000000000@127.0.0.1:1?security=tls&type=ws&sni=&fp=#0%20B%20%2F%20%E2%88%9E';
  const vmInfo = 'vmess://' + btoa(JSON.stringify({ v: '2', ps: 'expired', add: '0.0.0.0', port: '1', id: 'u' }));
  const real = 'vless://00000000-0000-4000-8000-000000000000@n.example.com:8451?security=tls&type=ws#%F0%9F%87%A6%F0%9F%87%B2%20Armenia';
  ok(isPlaceholder(info) && isPlaceholder(vmInfo) && isPlaceholder('trojan://p@[::1]:443#x'), 'loopback / port 1 rows are placeholders');
  ok(!isPlaceholder(real) && !isPlaceholder('wireguard://k@5.6.7.8:965?publickey=p#x') && !isPlaceholder('ss://YWVzOnB3@1.2.3.4:8388#x'), 'real exits are kept');
  const out = unify([info, vmInfo, real]);
  ok(out.length === 1 && decodeURIComponent(out[0].split('#')[1]).includes('AM 1'), 'only the real exit is listed: ' + out.map((l) => l.split('#')[1]).join(','));
}

const STAGE2_ACTIONS = ['user.add_days', 'user.add_gb', 'user.reset_usage', 'user.pause', 'user.end', 'user.plan_name', 'user.wallet', 'user.device_remove',
  'user.logout_all', 'user.block', 'user.unlink_tg', 'user.unlink_panel', 'user.avatar_reset', 'user.email', 'user.delete', 'user.create'];
const STAGE3_ACTIONS = ['order.approve', 'order.reject', 'order.cancel', 'order.refund', 'plan.move', 'plan.copy', 'plan.delete', 'plan.unarchive',
  'coupon.set', 'coupon.toggle'];
const STAGE4_ACTIONS = ['panel.rename', 'panel.enable', 'server.hide', 'server.rename', 'app.list', 'net.reset', 'app.release'];
const STAGE5_ACTIONS = ['broadcast.create', 'broadcast.start', 'broadcast.stop', 'admin.add', 'admin.remove'];
section('admin panel stage 1: routes, screens, undo, forms, audit, query budget');
{
  const menu = await import('../src/telegram-menu.js');
  const acts = await import('../src/admin-actions.js');
  const A = { chat: { id: 12345 } };
  const tap = (data, message = { ...A, message_id: 900, text: 'menu' }) => tgWebhook({ callback_query: { id: 's1-' + data, data, message } });
  const say = (text, extra = {}) => tgWebhook({ message: { ...A, text, ...extra } });
  const since = (n) => fakes.tg.calls.slice(n);
  const flat = (kb) => (kb || []).flat().map((x) => x.callback_data).filter(Boolean);
  const startCalls = fakes.tg.calls.length;

  // walk every screen reachable from home: every button resolves to a route and fits 64 bytes,
  // every screen starts with breadcrumbs and ends with back + home
  const homeKeys = flat((await menu.renderScreen(env, 'home')).kb).map((d) => d.slice(2));
  const seen = new Set();
  const queue = ['home'];
  let bad = [], noNav = [], noCrumb = [];
  while (queue.length && seen.size < 250) {
    const d = queue.shift();
    if (seen.has(d)) continue;
    seen.add(d);
    const s = await menu.renderScreen(env, d);
    for (const x of flat(s.kb)) {
      if (!menu.routeOf(x) || new TextEncoder().encode(x).length > 64) bad.push(`${d} -> ${x}`);
      const r = x.startsWith('m:') && menu.ROUTES[x.slice(2).split(':')[0]];
      if (r && r.kind === 'screen' && !seen.has(x.slice(2))) queue.push(x.slice(2));
    }
    if (d === 'home') continue;
    const last = flat([s.kb[s.kb.length - 1]]);
    const hasBack = last.some((x) => x !== 'm:home') || homeKeys.includes(d.split(':')[0]);
    if (!last.includes('m:home') || !hasBack) noNav.push(d);
    if (!String(s.text).startsWith('🏠 منو')) noCrumb.push(d);
  }
  ok(seen.size > 25, 'screen walk reached many screens: ' + seen.size);
  ok(!bad.length, 'every button on every screen resolves to a route within 64 bytes: ' + bad.slice(0, 5).join(' | '));
  ok(!noNav.length, 'every screen ends with back + home: ' + noNav.slice(0, 5).join(' | '));
  ok(!noCrumb.length, 'every screen starts with breadcrumbs: ' + noCrumb.slice(0, 5).join(' | '));
  ok(!menu.routeOf('m:nope') && !menu.routeOf('m:w:nope') && !menu.routeOf('m:f:nope') && !menu.routeOf('m:x:home|nocmd') && !menu.routeOf('m:' + 'p'.repeat(70)), 'unknown or oversized buttons resolve to nothing');
  ok(['or', 'bc', 'st', 'sys'].every((k) => seen.has(k)) && !(await menu.renderScreen(env, 'bc')).text.includes('به‌زودی'), 'every home section is built (none says «به‌زودی»)');

  // pagination: 8 per page with a next button, and the next page continues
  for (let i = 0; i < 10; i++) await signup(`page${i}@example.com`);
  const p1 = await menu.renderScreen(env, 'usr');
  const nextBtn = flat(p1.kb).find((x) => x.startsWith('m:usr:all:b'));
  const ids1 = flat(p1.kb).filter((x) => /^m:u:\d+$/.test(x));
  ok(ids1.length === 8 && !!nextBtn, 'users list pages 8 at a time with a next button');
  const p2 = await menu.renderScreen(env, nextBtn.slice(2));
  const ids2 = flat(p2.kb).filter((x) => /^m:u:\d+$/.test(x));
  ok(ids2.length > 0 && !ids2.some((x) => ids1.includes(x)) && flat(p2.kb).some((x) => x.startsWith('m:usr:all:a')), 'the next page has new rows and a previous button');

  // a non-admin reaches nothing, on any route
  const auditBefore = (await env.DB.prepare('SELECT COUNT(*) c FROM admin_audit').first()).c;
  const plan0 = await env.DB.prepare('SELECT * FROM plans ORDER BY id LIMIT 1').first();
  let n = fakes.tg.calls.length;
  for (const k of Object.keys(menu.ROUTES)) {
    await tgWebhook({ callback_query: { id: 'out-' + k, data: `m:${k}:${plan0.id}:1`, message: { chat: { id: 999 }, message_id: 1, text: 'x' } } });
  }
  await tgWebhook({ callback_query: { id: 'out-pt', data: `m:pt:${plan0.id}`, message: { chat: { id: 999 }, message_id: 1, text: 'x' } } });
  await tgWebhook({ message: { chat: { id: 999 }, text: '/coupon EVIL 50' } });
  const outCalls = since(n).filter((c) => c.method !== 'answerCallbackQuery');
  ok(!outCalls.length, 'non-admin taps and commands get no screen: ' + outCalls.map((c) => c.method).join(','));
  ok((await env.DB.prepare('SELECT COUNT(*) c FROM admin_audit').first()).c === auditBefore && (await env.DB.prepare('SELECT is_active FROM plans WHERE id = ?').bind(plan0.id).first()).is_active === plan0.is_active, 'non-admin changes nothing');
  ok(!(await env.DB.prepare("SELECT 1 x FROM coupons WHERE code = 'EVIL'").first()), 'non-admin /coupon makes nothing');

  // undo: once, and only within 10 minutes, and only by the admin who made the change
  const r1 = await acts.runAction(env, '12345', 'plan.set', { id: plan0.id, field: 'price', raw: '777' });
  ok(r1.ok && r1.undoable && (await env.DB.prepare('SELECT price_toman FROM plans WHERE id = ?').bind(plan0.id).first()).price_toman === 777, 'reversible change applied and undoable');
  ok(!(await acts.undoAction(env, '555', r1.auditId)).ok, 'another admin cannot undo it');
  n = fakes.tg.calls.length;
  await tap(`m:undo:${r1.auditId}`);
  ok((await env.DB.prepare('SELECT price_toman FROM plans WHERE id = ?').bind(plan0.id).first()).price_toman === plan0.price_toman, 'undo button restores the old price');
  ok(since(n).some((c) => c.method === 'editMessageText' && flat(c.body.reply_markup.inline_keyboard).includes(`m:hist:plan:${plan0.id}`)), 'undo shows the plan card again');
  ok(!(await acts.undoAction(env, '12345', r1.auditId)).ok, 'a second undo is refused');
  ok(!!(await env.DB.prepare("SELECT 1 x FROM admin_audit WHERE action = 'plan.set.undo' AND target_id = ?").bind(String(plan0.id)).first()), 'the undo itself is logged');
  const r2 = await acts.runAction(env, '12345', 'plan.set', { id: plan0.id, field: 'price', raw: '888' });
  await env.DB.prepare('UPDATE admin_audit SET created_at = created_at - 601 WHERE id = ?').bind(r2.auditId).run();
  ok(!(await acts.undoAction(env, '12345', r2.auditId)).ok && (await env.DB.prepare('SELECT price_toman FROM plans WHERE id = ?').bind(plan0.id).first()).price_toman === 888, 'undo after 10 minutes is refused');
  const logScr = await menu.renderScreen(env, 'sys.log');
  ok(!flat(logScr.kb).includes(`m:undo:${r2.auditId}`) && logScr.text.includes('plan.set'), 'the admin log lists changes; old ones have no undo button');
  await env.DB.prepare('UPDATE plans SET price_toman = ? WHERE id = ?').bind(plan0.price_toman, plan0.id).run();
  const r3 = await acts.runAction(env, '12345', 'plan.toggle', { id: plan0.id });
  ok(flat((await menu.renderScreen(env, 'sys.log')).kb).includes(`m:undo:${r3.auditId}`), 'a fresh change has its undo button in the log');
  ok(flat((await menu.renderScreen(env, `hist:plan:${plan0.id}`)).kb).includes(`m:undo:${r3.auditId}`), 'plan history lists it with undo');
  await acts.undoAction(env, '12345', r3.auditId);
  ok((await env.DB.prepare('SELECT is_active FROM plans WHERE id = ?').bind(plan0.id).first()).is_active === plan0.is_active, 'toggle undone');
  // coupon.create undo: only while nobody used it
  const rc = await acts.runAction(env, '12345', 'coupon.create', { code: 'UNDOME', percent: 5 });
  await env.DB.prepare("UPDATE coupons SET used = 1 WHERE code = 'UNDOME'").run();
  ok(!(await acts.undoAction(env, '12345', rc.auditId)).ok && !!(await env.DB.prepare("SELECT 1 x FROM coupons WHERE code = 'UNDOME'").first()), 'a used coupon is not removed by undo');

  // forms: a bad answer asks again, a duplicate message does not advance, cancel writes nothing
  const plansBefore = (await env.DB.prepare('SELECT COUNT(*) c FROM plans').first()).c;
  await tap('m:f:newplan');
  await say('Form Plan', { message_id: 3001 });
  await say('Form Plan', { message_id: 3001 }); // Telegram re-sent the same message
  const st = async () => (await env.DB.prepare("SELECT step FROM bot_session WHERE admin_id = '12345'").first())?.step;
  ok((await st()) === 1, 'the same message twice moves the form one step');
  n = fakes.tg.calls.length;
  await say('abc', { message_id: 3002 });
  ok((await st()) === 1 && since(n).some((c) => c.method === 'sendMessage' && c.body.text.includes('❌') && c.body.text.includes('مرحله 2 از 5')), 'a bad answer asks the same step again');
  await tap('m:fa:0:30'); // a stale button from step 1
  ok((await st()) === 1, 'a button from an old step is ignored');
  await tap('m:fa:1:30');
  ok((await st()) === 2, 'a suggestion button answers its step');
  await tap('m:cancel:pl');
  ok(!(await st()) && (await env.DB.prepare('SELECT COUNT(*) c FROM plans').first()).c === plansBefore, 'cancel writes nothing');
  // the full form makes the plan, then shows its card with undo
  await tap('m:f:newplan');
  await say('سه ماهه تست', { message_id: 3010 });
  await say('۹۰', { message_id: 3011 });
  await tap('m:fa:2:50');
  await tap('m:fa:3:2');
  await say('199,000', { message_id: 3012 });
  n = fakes.tg.calls.length;
  await tap('m:fok:newplan');
  const np = await env.DB.prepare("SELECT * FROM plans WHERE name = 'سه ماهه تست'").first();
  ok(np && np.duration_days === 90 && np.data_limit_gb === 50 && np.device_limit === 2 && np.price_toman === 199000, 'new plan form creates the plan');
  ok(since(n).some((c) => c.method === 'editMessageText' && flat(c.body.reply_markup.inline_keyboard).some((x) => x.startsWith('m:undo:'))), 'the new plan card offers undo');
  await tap('m:fok:newplan');
  ok((await env.DB.prepare("SELECT COUNT(*) c FROM plans WHERE name = 'سه ماهه تست'").first()).c === 1, 'a second tap on «ساخته شود» does not make it twice');
  // a coupon code already taken asks again
  await tap('m:f:coupon');
  n = fakes.tg.calls.length;
  await say('undome', { message_id: 3020 });
  ok((await st()) === 0 && since(n).some((c) => c.body && String(c.body.text).includes('قبلاً ساخته شده')), 'a taken code asks again');
  await tap('m:cancel:cp');

  // every action leaves an audit row (the ones not exercised above are run here)
  await acts.runAction(env, '12345', 'setting.set', { key: 'support_text', val: 'سلام' });
  const pnl = await env.DB.prepare("SELECT id FROM panels WHERE state IN ('testing','rollout','active') ORDER BY id LIMIT 1").first();
  if (pnl) {
    const g = await acts.runAction(env, '12345', 'panel.groups', { panelId: pnl.id, ids: [1] });
    await acts.undoAction(env, '12345', g.auditId);
  }
  await acts.runAction(env, '12345', 'coupon.delete', { code: 'UNDOME' });
  const logged = new Set((await env.DB.prepare('SELECT DISTINCT action FROM admin_audit').all()).results.map((r) => r.action));
  const missing = Object.keys(acts.ACTIONS).filter((a) => !logged.has(a) && !STAGE2_ACTIONS.includes(a) && !STAGE3_ACTIONS.includes(a) && !STAGE4_ACTIONS.includes(a) && !STAGE5_ACTIONS.includes(a));
  ok(!missing.length, 'every stage 1 admin action has written an audit row: missing ' + missing.join(','));
  ok(Object.values(acts.ACTIONS).every((a) => ['money', 'destructive', 'reversible'].includes(a.risk)), 'every action has a risk level');
  ok(Object.values(menu.ROUTES).every((r) => r.kind === 'screen' || r.risk), 'every action route has a risk level');
  const secretLeak = (await env.DB.prepare("SELECT COUNT(*) c FROM admin_audit WHERE summary LIKE '%menu-pass-123%' OR summary LIKE '%brandnewpass%' OR undo_json LIKE '%password%'").first()).c;
  ok(secretLeak === 0, 'no password in the admin log');

  // no admin text line asks to type a /command
  const slash = since(startCalls).concat(fakes.tg.calls.filter((c) => c.method === 'editMessageText'))
    .filter((c) => c.body && String(c.body.chat_id) === '12345')
    .map((c) => String(c.body.text || c.body.caption || ''))
    .filter((t) => /^\/[a-z]/m.test(t));
  ok(!slash.length, 'no menu text line starts with /command: ' + slash.slice(0, 2).join(' || ').slice(0, 300));

  // query budget: at most 6 D1 statements per screen, with about 1000 users
  await env.DB.prepare(`INSERT INTO users (email, password_hash, referral_code, created_at)
    WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000)
    SELECT 'bulk' || x || '@example.com', 'x', 'BULK' || x, ?1 - x FROM c`).bind(Math.floor(Date.now() / 1000)).run();
  const realPrepare = env.DB.prepare;
  let q = 0;
  env.DB.prepare = (sql) => { q++; return realPrepare(sql); };
  const over = [];
  let maxQ = 0;
  const lastUser = await realPrepare("SELECT MAX(id) m FROM users WHERE email LIKE 'bulk%'").first();
  const budgetScreens = [...seen].filter((d) => !/^un:|^u:\d+:live$/.test(d) && d !== 'un').concat([`usr:b${lastUser.m}`, `usr:act:b${lastUser.m}`, `usr:none`]);
  for (const d of budgetScreens) {
    q = 0;
    await menu.renderScreen(env, d);
    if (q > 6) over.push(`${d}=${q}`);
    maxQ = Math.max(maxQ, q);
  }
  env.DB.prepare = realPrepare;
  console.log('    most D1 statements on one screen: ' + maxQ);
  ok(maxQ > 0 && !over.length, `≤6 D1 statements on each of ${budgetScreens.length} screens with 1000 users: ` + over.join(' '));
  await env.DB.prepare("DELETE FROM users WHERE email LIKE 'bulk%@example.com'").run();
}

section('unlink a panel account from an app user (bot + Mini App action)');
{
  const menu = await import('../src/telegram-menu.js');
  const A = { chat: { id: 12345 } };
  let mid = 7000;
  const tap = (data, text = 'menu') => tgWebhook({ callback_query: { id: 'ux-' + (mid++), data, message: { ...A, message_id: 960, text } } });
  const since = (n) => fakes.tg.calls.slice(n);
  const flat = (kb) => (kb || []).flat().map((x) => x.callback_data).filter(Boolean);
  const kbOf = (c) => flat(c && c.body && c.body.reply_markup && c.body.reply_markup.inline_keyboard);
  const ask = (n) => since(n).filter((c) => c.method === 'sendMessage' && /مطمئنی/.test(c.body.text)).pop();

  // the user's panels screen opens (it used to share its route with the app-update announce button)
  ok(menu.routeOf('m:uac:5').kind === 'screen' && menu.routeOf('m:upa').kind === 'action', 'user panels and app announce are different routes');
  const relBefore = await env.DB.prepare("SELECT COUNT(*) c FROM admin_audit WHERE action = 'app.release'").first();

  await signup('unl@example.com');
  await admin(`/grant unl@example.com ${tenGb.id}`);
  const id = await userId('unl@example.com');
  const p1 = panelUser(fakes.pg, 'unl@example.com'), p2 = panelUser(pg2, 'unl@example.com');
  ok(p1 && p2, 'the user has an account on both panels');
  let n = fakes.tg.calls.length;
  await tap(`m:uac:${id}`);
  const scr = since(n).find((c) => c.method === 'editMessageText');
  ok(scr && scr.body.text.includes('پنل‌ها') && kbOf(scr).includes(`m:uux:${id}:1`) && kbOf(scr).includes(`m:uux:${id}:2`) && kbOf(scr).includes(`m:w:link:${id}`),
    'the panels screen has an unlink button per account and a link button');
  ok((await env.DB.prepare("SELECT COUNT(*) c FROM admin_audit WHERE action = 'app.release'").first()).c === relBefore.c, 'opening it announces nothing');

  // unlink + switch off on panel 2
  n = fakes.tg.calls.length;
  await tap(`m:uux:${id}:2`);
  let q = ask(n);
  ok(q && q.body.text.includes(p2.username) && kbOf(q).some((d) => /^lp:[0-9a-f]{18}:1$/.test(d)) && kbOf(q).some((d) => /^lp:[0-9a-f]{18}:0$/.test(d)), 'asks first, with switch-off and unlink-only');
  ok(!!(await env.DB.prepare('SELECT 1 x FROM panel_accounts WHERE user_id = ? AND panel_id = 2').bind(id).first()), 'nothing changes before the answer');
  n = fakes.tg.calls.length;
  await tap(kbOf(q).find((d) => d.endsWith(':1')), q.body.text);
  ok(!(await env.DB.prepare('SELECT 1 x FROM panel_accounts WHERE user_id = ? AND panel_id = 2').bind(id).first()), 'the link to panel 2 is gone');
  ok(p2.status === 'disabled' && pg2.users[p2.username], 'switched off on panel 2, not deleted');
  ok(since(n).some((c) => c.method === 'editMessageText' && c.body.text.includes('جدا شد') && c.body.text.includes('اکانت تازه')), 'the result says it is free and a fresh account may follow');
  ok(!!(await env.DB.prepare("SELECT 1 x FROM admin_audit WHERE action = 'user.unlink_panel' AND target_id = ?").bind(String(id)).first()), 'unlink is in the admin log');

  // unlink only on panel 1: the panel account is left as it was and the old panel-1 fields let go of it
  n = fakes.tg.calls.length;
  await tap(`m:uux:${id}:1`);
  q = ask(n);
  await tap(kbOf(q).find((d) => d.endsWith(':0')), q.body.text);
  ok(!(await env.DB.prepare('SELECT 1 x FROM panel_accounts WHERE user_id = ? AND panel_id = 1 AND remote_username = ?').bind(id, p1.username).first()), 'the link to panel 1 is gone');
  ok(p1.status === 'active', 'unlink-only leaves the panel account on');
  const s1 = await env.DB.prepare('SELECT pg_username FROM subscriptions WHERE user_id = ?').bind(id).first();
  ok(s1.pg_username !== p1.username, 'the subscription no longer points at it');
  n = fakes.tg.calls.length;
  await tap(`m:uux:${id}:1`);
  ok(!ask(n) || !(await env.DB.prepare('SELECT 1 x FROM panel_accounts WHERE user_id = ? AND panel_id = 1 AND remote_username = ?').bind(id, p1.username).first()), 'a gone link is not asked about again');

  // now it can go to someone else
  await signup('unl2@example.com');
  const id2 = await userId('unl2@example.com');
  n = fakes.tg.calls.length;
  await admin(`/link unl2@example.com ${p1.username}`);
  q = ask(n);
  ok(!!q, 'the unlinked account can be linked to another user: ' + lastText());

  // still owned by someone: the refusal leads to that user's panels
  n = fakes.tg.calls.length;
  await signup('unl3@example.com');
  const holder = await env.DB.prepare("SELECT a.remote_username FROM panel_accounts a JOIN users u ON u.id = a.user_id WHERE a.panel_id = 1 AND u.email NOT LIKE 'deleted+%' AND u.email != 'unl3@example.com' LIMIT 1").first();
  ok(!!holder, 'some live user holds a panel-1 account');
  {
    n = fakes.tg.calls.length;
    await admin(`/link unl3@example.com ${holder.remote_username}`);
    const r = since(n).filter((c) => c.method === 'sendMessage').pop();
    ok(r && r.body.text.includes('جدا') && kbOf(r).some((d) => /^m:uac:\d+$/.test(d)), 'a taken account is refused with a button to its owner');
  }

  // a user deleted before this change still held a 'removed' row: that row counts as free
  const ghost = (fakes.pg.users['ghost_old'] = { id: 7777, username: 'ghost_old', status: 'disabled', expire: 0, data_limit: 0, used_traffic: 0, token: 'tok_ghost', note: '' });
  const old = await env.DB.prepare("INSERT INTO users (email, password_hash, referral_code, created_at, is_active) VALUES ('deleted+99999@invalid', 'x', 'GHOST01', 1, 0) RETURNING id").first();
  await env.DB.prepare("INSERT INTO panel_accounts (user_id, panel_id, remote_username, sub_path, desired, applied, created_at) VALUES (?, 1, 'ghost_old', '/sub/tok_ghost/', 'removed', 'removed', 1)").bind(old.id).run();
  n = fakes.tg.calls.length;
  await admin('/link unl3@example.com ghost_old');
  q = ask(n);
  ok(!!q, 'an account held by an old deleted user is offered: ' + lastText());
  await tap(kbOf(q).find((d) => d.startsWith('lp:') && d.endsWith(':0')), q.body.text);
  const g = await env.DB.prepare("SELECT user_id FROM panel_accounts WHERE panel_id = 1 AND remote_username = 'ghost_old'").first();
  ok(g && g.user_id === (await userId('unl3@example.com')) && ghost.username === 'ghost_old', 'and linked to the new user');

  // the Mini App path: destructive, needs confirm
  const acts = await import('../src/admin-actions.js');
  ok(acts.ACTIONS['user.unlink_panel'].risk === 'destructive', 'unlink is destructive (Mini App asks, server refuses without confirm)');
  const none = await acts.runAction(env, 12345, 'user.unlink_panel', { userId: id2, panelId: 2 });
  ok(none.ok === false, 'unlinking an account the user does not have is refused');
}

section('admin panel stage 2: users (card, subscription, wallet, devices, security, delete)');
{
  const menu = await import('../src/telegram-menu.js');
  const acts = await import('../src/admin-actions.js');
  const A = { chat: { id: 12345 } };
  let mid = 3000;
  const tap = (data, text = 'menu') => tgWebhook({ callback_query: { id: 's2-' + (mid++), data, message: { ...A, message_id: 950, text } } });
  const say = (text, extra = {}) => tgWebhook({ message: { ...A, text, message_id: mid++, ...extra } });
  const since = (n) => fakes.tg.calls.slice(n);
  const flat = (kb) => (kb || []).flat().map((x) => x.callback_data).filter(Boolean);
  const kbOf = (c) => flat(c && c.body && c.body.reply_markup && c.body.reply_markup.inline_keyboard);
  const acks = (n) => since(n).filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text || '');
  const undoOf = (n) => { const e = since(n).filter((c) => c.method === 'editMessageText').pop(); return kbOf(e).find((d) => d.startsWith('m:undo:')); };
  const confirmTok = (n) => { const c = since(n).filter((x) => x.method === 'sendMessage' && /مطمئنی/.test(x.body.text)).pop(); const d = kbOf(c).find((x) => x.startsWith('cf:')); return c && d ? { text: c.body.text, yes: d } : null; };
  const sub = (id) => env.DB.prepare('SELECT * FROM subscriptions WHERE user_id = ?').bind(id).first();
  const urow = (id) => env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  const near = (a, b, tol = 64 * 1024 * 1024) => Math.abs(a - b) <= tol;

  const active = (await env.DB.prepare("SELECT id FROM panels WHERE state IN ('active','rollout') ORDER BY id").all()).results.map((r) => r.id);
  ok(active.includes(1) && active.includes(2), 'panels 1 and 2 take users: ' + active.join());
  const tok = await signup('s2@example.com', { device: 's2-phone' });
  await admin(`/grant s2@example.com ${tenGb.id}`);
  const id = await userId('s2@example.com');
  const a = panelUser(fakes.pg, 's2@example.com'), b2 = panelUser(pg2, 's2@example.com');
  ok(a && b2 && a.data_limit === 10 * GB && b2.data_limit === 10 * GB, 'the user has an account on both panels');

  // the card: facts only, no links, no panel ids
  const card = await menu.renderScreen(env, `u:${id}`);
  ok(card.text.includes('s2@example.com') && card.text.includes(tenGb.name) && card.text.includes('کیف پول') && card.text.includes('دستگاه') && card.text.startsWith('🏠 منو'), 'card: email, plan, wallet, devices, breadcrumbs');
  ok(!/:\/\/|tok_|[0-9a-f]{8}-[0-9a-f]{4}-/.test(card.text) && !card.text.includes(a.username), 'card shows no link, token, UUID or panel username');
  const subScr = await menu.renderScreen(env, `us:${id}`);
  ok(['m:ud:', 'm:ugb:', 'm:urs:', 'm:upz:', 'm:upl:', 'm:uend:', 'm:f:adddays:', 'm:f:addgb:'].every((p) => flat(subScr.kb).some((d) => d.startsWith(p))), 'subscription screen has days / GB / reset / pause / plan / end');

  // + days reaches both panels (same evaluate / pushPending path), undo puts it back once
  const exp0 = (await sub(id)).expires_at;
  let n = fakes.tg.calls.length;
  await tap(`m:ud:${id}:7`);
  const exp1 = (await sub(id)).expires_at;
  ok(exp1 === exp0 + 7 * 86400, '+7 days on the subscription');
  ok(near(a.expire, exp1, 5) && near(b2.expire, exp1, 5), '+7 days reaches both panels: ' + [a.expire - exp0, b2.expire - exp0]);
  const undo1 = undoOf(n);
  ok(!!undo1, 'the card comes back with an undo button');
  await tap(undo1);
  ok((await sub(id)).expires_at === exp0 && near(a.expire, exp0, 5) && near(b2.expire, exp0, 5), 'undo puts the old expiry back on both panels');
  n = fakes.tg.calls.length;
  await tap(undo1);
  ok(acks(n).some((t) => t.includes('دیگر برگشت‌پذیر نیست')) && (await sub(id)).expires_at === exp0, 'undo works once only');

  // + GB reaches both panels
  n = fakes.tg.calls.length;
  await tap(`m:ugb:${id}:5`);
  ok((await sub(id)).data_limit_bytes === 15 * GB && a.data_limit === 15 * GB && b2.data_limit === 15 * GB, '+5 GB on the subscription and both panels: ' + [a.data_limit / GB, b2.data_limit / GB]);
  await tap(undoOf(n));
  ok((await sub(id)).data_limit_bytes === 10 * GB && a.data_limit === 10 * GB && b2.data_limit === 10 * GB, 'undo +GB: 10 GB again everywhere');
  await tap(`m:ugb:${id}:5`); // keep 15 GB for the rest

  // custom days through the form
  await tap(`m:f:adddays:${id}`);
  await say('12');
  await tap('m:fok:adddays');
  ok((await sub(id)).expires_at === exp0 + 12 * 86400 && near(b2.expire, exp0 + 12 * 86400, 5), 'custom days from the form reach the panels');

  // reset usage: money, asks first; zeroes the ledger and every panel gets the full limit again
  a.used_traffic = 3 * GB; b2.used_traffic = 2 * GB;
  await syncRounds(3);
  ok((await sub(id)).used_bytes === 5 * GB, 'usage summed before the reset: ' + (await sub(id)).used_bytes / GB);
  n = fakes.tg.calls.length;
  await tap(`m:urs:${id}`);
  let cf = confirmTok(n);
  ok(cf && (await sub(id)).used_bytes === 5 * GB, 'reset asks "are you sure?" first and changes nothing yet');
  await tap(cf.yes, cf.text);
  const s0 = await sub(id);
  const ctr = (await env.DB.prepare('SELECT SUM(accounted_bytes) t FROM usage_counters WHERE period_id = ?').bind(s0.period_id).first()).t;
  ok(s0.used_bytes === 0 && ctr === 0, 'reset zeroes the subscription and the ledger');
  ok(near(a.data_limit, 3 * GB + 15 * GB) && near(b2.data_limit, 2 * GB + 15 * GB), 'panels follow: each = what it already counted + the full 15 GB: ' + [a.data_limit / GB, b2.data_limit / GB]);
  a.used_traffic = 4 * GB; await syncRounds(2);
  ok((await sub(id)).used_bytes === 1 * GB, 'new usage after the reset counts from zero: ' + (await sub(id)).used_bytes / GB);

  // pause / resume
  n = fakes.tg.calls.length;
  await tap(`m:upz:${id}:1`);
  ok((await sub(id)).state === 'stopped' && a.status === 'disabled' && b2.status === 'disabled', 'pause switches off both panels');
  await tap(undoOf(n));
  ok((await sub(id)).state === 'active' && a.status === 'active' && b2.status === 'active', 'undo pause: both panels on again');

  // plan name only
  const lim = (await sub(id)).data_limit_bytes;
  n = fakes.tg.calls.length;
  await tap(`m:upn:${id}:0`);
  ok((await sub(id)).plan_id === null && (await sub(id)).data_limit_bytes === lim, 'plan name removed, limit untouched');
  await tap(undoOf(n));
  ok((await sub(id)).plan_id === tenGb.id, 'undo: plan name back');

  // wallet: form -> summary -> confirm (one-time) -> walletApply
  const bal0 = (await urow(id)).wallet_balance;
  await tap(`m:f:wadd:${id}`);
  await tap('m:fa:0:50000');
  await tap('m:fa:1:هدیه');
  n = fakes.tg.calls.length;
  await tap('m:fok:wadd');
  cf = confirmTok(n);
  ok(cf && cf.text.includes('50,000') && (await urow(id)).wallet_balance === bal0, 'credit asks "are you sure?" with the amount, nothing changes yet');
  n = fakes.tg.calls.length;
  await tap('m:fok:wadd');
  ok(!confirmTok(n), 'a second tap on the form button asks nothing again');
  await tap(cf.yes, cf.text);
  await tap(cf.yes, cf.text);
  const tx = (await env.DB.prepare("SELECT COUNT(*) c FROM wallet_tx WHERE user_id = ? AND reason = 'admin_credit'").bind(id).first()).c;
  ok((await urow(id)).wallet_balance === bal0 + 50000 && tx === 1, 'double-tap credits once: ' + [(await urow(id)).wallet_balance, tx]);
  const note = (await env.DB.prepare("SELECT note FROM wallet_tx WHERE user_id = ? AND reason = 'admin_credit'").bind(id).first()).note;
  ok(note === 'هدیه', 'the reason is stored in the wallet history');
  await tap(`m:f:wsub:${id}`);
  await say('900000');
  ok(String(fakes.tg.calls.slice(-1)[0].body.text).includes('دلیل'), 'debit asks for a reason after the amount');
  await say('اصلاح اشتباه');
  n = fakes.tg.calls.length;
  await tap('m:fok:wsub');
  cf = confirmTok(n);
  n = fakes.tg.calls.length;
  await tap(cf.yes, cf.text);
  ok((await urow(id)).wallet_balance === bal0 + 50000 && since(n).some((c) => /موجودی کافی نیست/.test(c.body.text || '')), 'a debit below zero is refused, balance unchanged');
  await tap(`m:f:wsub:${id}`); await say('20000'); await say('اصلاح اشتباه');
  n = fakes.tg.calls.length; await tap('m:fok:wsub'); cf = confirmTok(n); await tap(cf.yes, cf.text);
  ok((await urow(id)).wallet_balance === bal0 + 30000, 'a debit within the balance works');
  const wscr = await menu.renderScreen(env, `uw:${id}`);
  ok(wscr.text.includes('شارژ مدیر') && wscr.text.includes('کسر مدیر') && wscr.text.includes('هدیه'), 'wallet screen lists the history');
  const walletTxt = await env.DB.prepare("SELECT summary FROM admin_audit WHERE action = 'user.wallet' ORDER BY id DESC LIMIT 1").first();
  ok(walletTxt && walletTxt.summary.includes('اصلاح اشتباه') && !(await env.DB.prepare("SELECT undo_json FROM admin_audit WHERE action = 'user.wallet' AND undo_json IS NOT NULL").first()), 'money changes are logged and have no undo');

  // devices
  const dscr = await menu.renderScreen(env, `udv:${id}`);
  const dbtn = flat(dscr.kb).find((d) => d.startsWith(`m:udd:${id}:`));
  ok(!!dbtn, 'devices screen lists the phone');
  await tap(dbtn);
  ok((await env.DB.prepare('SELECT COUNT(*) c FROM devices WHERE user_id = ?').bind(id).first()).c === 0, 'remove one device');

  // logout all
  const before = await call('GET', '/api/v1/me', { token: tok });
  await tap(`m:ulo:${id}`);
  ok(before.status === 200 && (await call('GET', '/api/v1/me', { token: tok })).status === 401, 'logout all ends the old session');

  // block: no login, no refresh, panels off; unblock through undo
  const login = await call('POST', '/api/v1/auth/login', { json: { email: 's2@example.com', password: 'password123', device_id: 's2-phone' } });
  n = fakes.tg.calls.length;
  await tap(`m:ublk:${id}:1`);
  ok((await urow(id)).is_active === 0 && a.status === 'disabled' && b2.status === 'disabled', 'block: account off and both panels off');
  ok((await call('POST', '/api/v1/auth/login', { json: { email: 's2@example.com', password: 'password123' } })).status === 403, 'a blocked user cannot log in');
  const rf = await call('POST', '/api/v1/auth/refresh', { json: { refresh_token: login.data.refresh_token } });
  ok(rf.status >= 400 && rf.status < 500, 'a blocked user cannot refresh: ' + rf.status);
  ok((await call('GET', '/api/v1/me', { token: login.data.access_token })).status >= 400, 'a blocked user\'s access token stops working');
  const blockUndo = undoOf(n);
  await syncRounds(2);
  ok(a.status === 'disabled' && b2.status === 'disabled', 'the sync job keeps a blocked user off');
  ok(flat((await menu.renderScreen(env, 'usr:blk')).kb).includes(`m:u:${id}`), 'the «مسدود» filter lists the user');
  await tap(blockUndo);
  ok((await urow(id)).is_active === 1 && a.status === 'active' && b2.status === 'active', 'unblock (undo): account and panels on again');
  ok((await call('POST', '/api/v1/auth/login', { json: { email: 's2@example.com', password: 'password123' } })).status === 200, 'login works again after unblock');
  ok(flat((await menu.renderScreen(env, 'usr:act')).kb).includes(`m:u:${id}`), 'the «فعال» filter lists the user');

  // email edit: checked and unique
  await tap(`m:f:email:${id}`);
  n = fakes.tg.calls.length;
  await say('ali@example.com');
  ok(since(n).some((c) => /حساب دیگری/.test(c.body.text || '')), 'a taken email is refused');
  await say('s2new@example.com');
  await tap('m:fok:email');
  ok((await urow(id)).email === 's2new@example.com', 'email changed');

  // avatar reset with undo
  await env.DB.prepare("UPDATE users SET avatar = 'fox' WHERE id = ?").bind(id).run();
  n = fakes.tg.calls.length;
  await tap(`m:uav:${id}`);
  ok((await urow(id)).avatar === null, 'avatar reset');
  await tap(undoOf(n));
  ok((await urow(id)).avatar === 'fox', 'undo: avatar back');

  // unlink Telegram: destructive, warns when no other login is left
  await env.DB.prepare("UPDATE users SET tg_id = 880077, tg_username = 's2tg' WHERE id = ?").bind(id).run();
  n = fakes.tg.calls.length;
  await tap(`m:utg:${id}`);
  cf = confirmTok(n);
  ok(cf && cf.text.includes('@s2tg') && !cf.text.includes('هیچ راهی'), 'unlink asks first (email login stays)');
  await tap(cf.yes, cf.text);
  ok((await urow(id)).tg_id === null, 'Telegram unlinked');
  const tgOnly = await env.DB.prepare("INSERT INTO users (email, password_hash, referral_code, created_at, tg_id, tg_username) VALUES ('tg880078@telegram.local', 'x', 'TGONLY1', 1, 880078, 'only_tg') RETURNING id").first();
  n = fakes.tg.calls.length;
  await tap(`m:utg:${tgOnly.id}`);
  ok(confirmTok(n) && confirmTok(n).text.includes('هیچ راهی برای ورود نمی‌ماند'), 'a Telegram-only account gets the "no login left" warning');

  // type to open: email, @username, user id, #order
  n = fakes.tg.calls.length;
  await say('s2new@example.com');
  ok(since(n).some((c) => c.method === 'sendMessage' && c.body.text.includes('s2new@example.com') && kbOf(c).includes(`m:us:${id}`)), 'typing an email opens the card');
  n = fakes.tg.calls.length;
  await say('@only_tg');
  ok(since(n).some((c) => c.method === 'sendMessage' && kbOf(c).includes(`m:us:${tgOnly.id}`)), 'typing @username opens the card');
  n = fakes.tg.calls.length;
  await say(String(id));
  ok(since(n).some((c) => c.method === 'sendMessage' && kbOf(c).includes(`m:us:${id}`)), 'typing a user id opens the card');
  const anyOrder = await env.DB.prepare('SELECT id, user_id FROM orders ORDER BY id LIMIT 1').first();
  n = fakes.tg.calls.length;
  await say('#' + anyOrder.id);
  ok(since(n).some((c) => c.method === 'sendMessage' && c.body.text.includes(`سفارش #${anyOrder.id}`) && kbOf(c).includes(`m:u:${anyOrder.user_id}`)), 'typing #order opens the order');
  n = fakes.tg.calls.length;
  await say('/find ' + id);
  ok(since(n).some((c) => c.method === 'sendMessage' && kbOf(c).includes(`m:us:${id}`)), '/find also takes a user id');
  const oscr = await menu.renderScreen(env, `uo:${anyOrder.user_id}`);
  ok(flat(oscr.kb).includes(`m:o:${anyOrder.id}`), 'per-user orders list');

  // end subscription: destructive, both panels off as expired
  n = fakes.tg.calls.length;
  await tap(`m:uend:${id}`);
  cf = confirmTok(n);
  ok(cf && (await sub(id)).state === 'active', 'end asks first');
  n = fakes.tg.calls.length;
  await tap(cf.yes, cf.text);
  const se = await sub(id);
  ok(se.state === 'stopped' && se.stop_reason === 'expired' && a.status === 'disabled' && b2.status === 'disabled', 'end: stopped as expired on both panels');
  ok(since(n).some((c) => c.method === 'editMessageText' && kbOf(c).includes(`m:u:${id}`)), 'the result has a way back to the card');
  await tap(`m:ud:${id}:30`);
  ok((await sub(id)).state === 'active' && a.status === 'active' && b2.status === 'active', '+30 days on an ended subscription switches it back on');

  // soft delete: panels off, email + Telegram freed, orders and wallet history kept
  const txBefore = (await env.DB.prepare('SELECT COUNT(*) c FROM wallet_tx WHERE user_id = ?').bind(id).first()).c;
  n = fakes.tg.calls.length;
  await tap(`m:udel:${id}`);
  cf = confirmTok(n);
  ok(cf && cf.text.includes('برگشت ندارد') && cf.text.includes('اکانت پنل') && cf.text.includes('حساب‌رسی'), 'delete asks with what it affects');
  await tap(cf.yes, cf.text);
  const del = await urow(id);
  ok(del.email === `deleted+${id}@invalid` && del.is_active === 0 && del.tg_id === null, 'deleted: email rewritten, account off');
  ok((await env.DB.prepare('SELECT COUNT(*) c FROM panel_accounts WHERE user_id = ?').bind(id).first()).c === 0, 'the deleted user holds no panel account any more');
  ok(a.status === 'disabled' && b2.status === 'disabled' && pg2.users[b2.username] && fakes.pg.users[a.username], 'its panel accounts are switched off, not deleted');
  ok(since(n).some((c) => c.method === 'editMessageText' && c.body.text.includes('آزاد') && c.body.text.includes(a.username)), 'the result names the freed accounts');
  // a freed account can be linked to another app user
  await signup('s2heir@example.com');
  const heir = await userId('s2heir@example.com');
  n = fakes.tg.calls.length;
  await admin(`/link s2heir@example.com ${a.username}`);
  const lc = since(n).find((c) => c.method === 'sendMessage' && c.body.text.includes('مطمئنی'));
  ok(!!lc, 'linking the freed account to another user asks, it is not refused: ' + lastText());
  await tap(kbOf(lc).find((d) => d.startsWith('lp:') && d.endsWith(':0')), lc.body.text);
  const moved = await env.DB.prepare('SELECT user_id FROM panel_accounts WHERE panel_id = 1 AND remote_username = ?').bind(a.username).first();
  ok(moved && moved.user_id === heir, 'the panel account now belongs to the new user');
  ok((await env.DB.prepare('SELECT COUNT(*) c FROM wallet_tx WHERE user_id = ?').bind(id).first()).c === txBefore, 'wallet history kept');
  const again = await call('POST', '/api/v1/auth/register', { json: { email: 's2new@example.com', password: 'password123', device_id: 'new-phone' } });
  ok(again.status === 200 || again.status === 201, 'the email is free for a new sign-up: ' + again.status);
  ok((await call('POST', '/api/v1/auth/login', { json: { email: `deleted+${id}@invalid`, password: 'password123' } })).status >= 400, 'the deleted account cannot log in');
  const delSec = await menu.renderScreen(env, `usec:${id}`);
  ok(!flat(delSec.kb).some((d) => /^m:(udel|ublk|w:reset):/.test(d)), 'a deleted user has no more account buttons');

  // manual user: email + password, the password message is deleted and never stored in clear
  await tap('m:f:newuser');
  await say('manual@example.com');
  ok((await env.DB.prepare('SELECT secret FROM bot_session').first()).secret === 1, 'the password step marks the next message secret');
  n = fakes.tg.calls.length;
  await say('manualpass1', { message_id: 4242 });
  ok(since(n).some((c) => c.method === 'deleteMessage' && c.body.message_id === 4242), 'the password message is deleted');
  ok(!since(n).some((c) => String(c.body.text || '').includes('manualpass1')), 'the password is never echoed');
  const sess = await env.DB.prepare('SELECT data_json FROM bot_session').first();
  ok(sess && !sess.data_json.includes('manualpass1') && sess.data_json.includes('pbkdf2$'), 'only the hash waits in the session');
  n = fakes.tg.calls.length;
  await tap('m:fok:newuser');
  const mu = await env.DB.prepare("SELECT id FROM users WHERE email = 'manual@example.com'").first();
  ok(mu && (await call('POST', '/api/v1/auth/login', { json: { email: 'manual@example.com', password: 'manualpass1' } })).status === 200, 'manual user created and can log in');
  ok(mu && since(n).some((c) => c.method === 'editMessageText' && kbOf(c).includes(`m:us:${mu.id}`)), 'the new user\'s card opens');
  ok(mu && flat((await menu.renderScreen(env, 'usr:none')).kb).includes(`m:u:${mu.id}`), 'the «بی‌پلن» filter lists the new user');
  ok(!(await env.DB.prepare("SELECT 1 x FROM admin_audit WHERE summary LIKE '%manualpass1%' OR undo_json LIKE '%manualpass1%' OR undo_json LIKE '%pbkdf2%'").first()), 'no password or hash in the admin log');

  // every button on every user screen is a known route within 64 bytes, and each screen has back + home
  const big = await env.DB.prepare("INSERT INTO users (id, email, password_hash, referral_code, created_at, avatar, tg_id) VALUES (999999999, 'big@example.com', 'x', 'BIGID1', 1, 'cat', 990001) RETURNING id").first();
  await env.DB.prepare('INSERT INTO devices (user_id, device_id, model, last_seen) VALUES (?, ?, ?, ?)').bind(big.id, 'd'.repeat(60), 'Very Long Phone Model Name Here', 1).run();
  const bad = [], noNav = [];
  for (const d of ['u', 'us', 'upl', 'uw', 'udv', 'usec', 'uo'].map((k) => `${k}:${big.id}`).concat([`u:${big.id}:live`, `us:${mu ? mu.id : 1}`])) {
    const scr = await menu.renderScreen(env, d);
    for (const x of flat(scr.kb)) if (!menu.routeOf(x) || new TextEncoder().encode(x).length > 64) bad.push(`${d} -> ${x}`);
    const last = flat([scr.kb[scr.kb.length - 1]]);
    if (!last.includes('m:home') || last.length < 2 || !scr.text.startsWith('🏠 منو')) noNav.push(d);
  }
  ok(!bad.length, 'user screen buttons resolve within 64 bytes: ' + bad.slice(0, 4).join(' | '));
  ok(!noNav.length, 'user screens have breadcrumbs, back and home: ' + noNav.join(' '));
  ok(['adddays', 'addgb', 'wadd', 'wsub', 'email'].every((f) => menu.routeOf(`m:f:${f}:${big.id}`)), 'every per-user form has a route');

  // query budget for the user screens (the live refresh excluded)
  const realPrepare = env.DB.prepare;
  let q = 0, maxQ = 0;
  const over = [];
  env.DB.prepare = (sql) => { q++; return realPrepare(sql); };
  for (const d of ['u', 'us', 'upl', 'uw', 'udv', 'usec', 'uo'].map((k) => `${k}:${big.id}`).concat([`o:${anyOrder.id}`, 'usr:exp', 'usr:blk'])) {
    q = 0; await menu.renderScreen(env, d); maxQ = Math.max(maxQ, q); if (q > 6) over.push(`${d}=${q}`);
  }
  env.DB.prepare = realPrepare;
  console.log('    most D1 statements on one user screen: ' + maxQ);
  ok(!over.length, 'user screens use ≤6 D1 statements: ' + over.join(' '));

  const logged = new Set((await env.DB.prepare('SELECT DISTINCT action FROM admin_audit').all()).results.map((r) => r.action));
  const missing = Object.keys(acts.ACTIONS).filter((x) => !logged.has(x) && !STAGE3_ACTIONS.includes(x) && !STAGE4_ACTIONS.includes(x) && !STAGE5_ACTIONS.includes(x));
  ok(!missing.length, 'every stage 2 admin action has written an audit row: missing ' + missing.join(','));
}

section('admin panel stage 3: sales (orders, plans, coupons and referral, payment methods)');
{
  const menu = await import('../src/telegram-menu.js');
  const acts = await import('../src/admin-actions.js');
  const A = { chat: { id: 12345 } };
  let tapN = 0;
  const tap = (data, message = { ...A, message_id: 902, text: 'menu' }) => tgWebhook({ callback_query: { id: 's3-' + (++tapN), data, message } });
  const say = (text, extra = {}) => tgWebhook({ message: { ...A, text, ...extra } });
  const since = (n) => fakes.tg.calls.slice(n);
  const flat = (kb) => (kb || []).flat().map((x) => x.callback_data).filter(Boolean);
  const row = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
  const startCalls = fakes.tg.calls.length;
  // the one-time "are you sure?" token the bot just sent, and its question
  const confirmOf = (n) => {
    const m = since(n).filter((c) => c.method === 'sendMessage' && c.body && c.body.reply_markup && flat(c.body.reply_markup.inline_keyboard).some((x) => x.startsWith('cf:'))).pop();
    return m ? { token: flat(m.body.reply_markup.inline_keyboard).find((x) => x.startsWith('cf:')).slice(3), text: m.body.text } : null;
  };
  const acks = (n) => since(n).filter((c) => c.method === 'answerCallbackQuery').map((c) => String(c.body.text || '')).join(' | ');
  const receipt = async (tok, id, b = 7) => {
    const f = new FormData(); f.set('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, b])], { type: 'image/jpeg' }), 'r.jpg');
    return call('POST', `/api/v1/orders/${id}/receipt`, { token: tok, form: f });
  };

  const tok = await signup('sales3@example.com', { device: 's3' });
  const buyer = await row('SELECT * FROM users WHERE email = ?', 'sales3@example.com');
  const appPlans = (await call('GET', '/api/v1/plans')).data;
  const monthly = appPlans.find((p) => p.price_toman > 0 && !p.name.includes('کپی')) || appPlans[0];

  // ---- orders: list, card, approve only through settle (no double delivery) ----
  const o1 = (await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card' } })).data;
  await receipt(tok, o1.id, 31);
  ok((await row('SELECT status FROM orders WHERE id = ?', o1.id)).status === 'review', 'order waits for review');
  ok(flat((await menu.renderScreen(env, 'or:rev')).kb).includes(`m:o:${o1.id}`) && !flat((await menu.renderScreen(env, 'or:paid')).kb).includes(`m:o:${o1.id}`), 'the review list shows it, the paid list does not');
  ok(flat((await menu.renderScreen(env, 'or:rev:card')).kb).includes(`m:o:${o1.id}`) && !flat((await menu.renderScreen(env, 'or:rev:coin')).kb).includes(`m:o:${o1.id}`), 'the method filter works');
  let card = await menu.renderScreen(env, `o:${o1.id}`);
  ok(['oap', 'orj', 'ocx', 'orc'].every((k) => flat(card.kb).includes(`m:${k}:${o1.id}`)) && !flat(card.kb).includes(`m:orf:${o1.id}`), 'an order in review has approve, reject, cancel and the receipt photo');
  ok(!/https?:\/\/|sub_url|vless:|seed/i.test(card.text), 'the order card shows no link or secret');
  let n = fakes.tg.calls.length;
  await tap(`m:orc:${o1.id}`);
  ok(since(n).some((c) => c.method === 'sendPhoto' && c.body.photo && flat(c.body.reply_markup.inline_keyboard).includes(`m:o:${o1.id}`)), 'the receipt photo is sent with a way back to the card');

  const accountsBefore = Object.keys(fakes.pg.users).length;
  n = fakes.tg.calls.length;
  await tap(`m:oap:${o1.id}`);
  const c1 = confirmOf(n);
  n = fakes.tg.calls.length;
  await tap(`m:oap:${o1.id}`); // a double tap asks twice ...
  const c2 = confirmOf(n);
  ok(c1 && c2 && c1.token !== c2.token && (await row('SELECT status FROM orders WHERE id = ?', o1.id)).status === 'review', 'approve asks first and changes nothing yet');
  await tap(`cf:${c1.token}`);
  await tap(`cf:${c1.token}`); // the same confirmation again
  n = fakes.tg.calls.length;
  await tap(`cf:${c2.token}`); // ... and both questions are confirmed
  const paid1 = await row('SELECT status, provisioned_at FROM orders WHERE id = ?', o1.id);
  ok(paid1.status === 'paid' && paid1.provisioned_at, 'approved through settle: paid and delivered');
  ok(Object.keys(fakes.pg.users).length === accountsBefore + 1, 'a double tap delivers once: one panel account');
  ok((await row("SELECT COUNT(*) c FROM sub_periods WHERE user_id = ?", buyer.id)).c === 1, 'one subscription period');
  ok(since(n).some((c) => c.body && String(c.body.text || '').includes('قبلاً تأیید')), 'the second confirmation says it was already approved');
  ok((await row("SELECT COUNT(*) c FROM admin_audit WHERE action = 'order.approve' AND target_id = ?", String(o1.id))).c === 1, 'one audit row for the approval');
  // two approvals at the same time
  const o2 = (await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card' } })).data;
  await receipt(tok, o2.id, 32);
  const both = await Promise.all([acts.runAction(env, '12345', 'order.approve', { orderId: o2.id }), acts.runAction(env, '12345', 'order.approve', { orderId: o2.id })]);
  ok(both.filter((r) => r.ok).length === 1 && (await row('SELECT status FROM orders WHERE id = ?', o2.id)).status === 'paid', 'two approvals at once: exactly one succeeds');

  // ---- a paid order cannot be rejected or cancelled ----
  n = fakes.tg.calls.length;
  await tap(`m:orj:${o1.id}`);
  ok((await row('SELECT status FROM orders WHERE id = ?', o1.id)).status === 'paid' && acks(n).includes('رد نمی‌شود'), 'rejecting a paid order is refused');
  ok(!(await acts.runAction(env, '12345', 'order.reject', { orderId: o1.id })).ok && !(await acts.runAction(env, '12345', 'order.cancel', { orderId: o1.id })).ok, 'reject and cancel refuse a paid order in the action layer too');

  // ---- refund to the wallet: asks first, only once ----
  card = await menu.renderScreen(env, `o:${o1.id}`);
  ok(flat(card.kb).includes(`m:orf:${o1.id}`) && !flat(card.kb).includes(`m:oap:${o1.id}`), 'a paid order offers refund, not approve');
  const bal0 = (await row('SELECT wallet_balance b FROM users WHERE id = ?', buyer.id)).b;
  n = fakes.tg.calls.length;
  await tap(`m:orf:${o1.id}`);
  const rf = confirmOf(n);
  ok(rf && rf.text.includes(Number(o1.amount_toman).toLocaleString('en-US')) && (await row('SELECT wallet_balance b FROM users WHERE id = ?', buyer.id)).b === bal0, 'refund asks first and says how much');
  await tap(`cf:${rf.token}`);
  const bal1 = (await row('SELECT wallet_balance b FROM users WHERE id = ?', buyer.id)).b;
  ok(bal1 === bal0 + o1.amount_toman, `refund credits the wallet once: ${bal0} -> ${bal1}`);
  const again = await acts.runAction(env, '12345', 'order.refund', { orderId: o1.id });
  ok(!again.ok && (await row('SELECT wallet_balance b FROM users WHERE id = ?', buyer.id)).b === bal1, 'a second refund is refused and moves nothing');
  ok((await row("SELECT COUNT(*) c FROM wallet_tx WHERE order_id = ? AND reason = 'admin_refund'", o1.id)).c === 1, 'one admin_refund row');
  const two = await Promise.all([acts.runAction(env, '12345', 'order.refund', { orderId: o2.id }), acts.runAction(env, '12345', 'order.refund', { orderId: o2.id })]);
  ok(two.filter((r) => r.ok).length === 1 && (await row('SELECT wallet_balance b FROM users WHERE id = ?', buyer.id)).b === bal1 + o2.amount_toman, 'two refunds at once: exactly one credits');
  card = await menu.renderScreen(env, `o:${o1.id}`);
  ok(!flat(card.kb).includes(`m:orf:${o1.id}`) && card.text.includes('برگشت داده شده'), 'the card shows it was refunded and drops the button');
  const top = (await call('POST', '/api/v1/orders', { token: tok, json: { topup_toman: 70000, method: 'card' } })).data;
  await receipt(tok, top.id, 33);
  await acts.runAction(env, '12345', 'order.approve', { orderId: top.id });
  ok(!(await acts.runAction(env, '12345', 'order.refund', { orderId: top.id })).ok, 'a wallet top-up is not refunded into the wallet again');

  // ---- reject / cancel an open order, with undo ----
  const o3 = (await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card' } })).data;
  n = fakes.tg.calls.length;
  await tap(`m:orj:${o3.id}`);
  const rj = await row('SELECT status, admin_note FROM orders WHERE id = ?', o3.id);
  ok(rj.status === 'rejected' && rj.admin_note, 'reject sets the order rejected with a note for the user');
  const rjUndo = since(n).find((c) => c.method === 'editMessageText' && flat(c.body.reply_markup.inline_keyboard).some((x) => x.startsWith('m:undo:')));
  ok(!!rjUndo, 'the order card comes back with undo');
  await tap(flat(rjUndo.body.reply_markup.inline_keyboard).find((x) => x.startsWith('m:undo:')));
  ok((await row('SELECT status FROM orders WHERE id = ?', o3.id)).status === 'pending', 'undo puts the order back to pending');
  const cx = await acts.runAction(env, '12345', 'order.cancel', { orderId: o3.id });
  ok(cx.ok && (await row('SELECT status FROM orders WHERE id = ?', o3.id)).status === 'cancelled', 'cancel closes an open order');
  ok(!(await acts.runAction(env, '12345', 'order.approve', { orderId: o3.id })).ok, 'a cancelled order is not approved');
  await acts.undoAction(env, '12345', cx.auditId);
  ok((await row('SELECT status FROM orders WHERE id = ?', o3.id)).status === 'pending', 'cancel can be undone');

  // ---- search by number or receipt code ----
  await env.DB.prepare("UPDATE orders SET receipt_ref = 'REF778899' WHERE id = ?").bind(o3.id).run();
  await tap('m:w:ofind');
  n = fakes.tg.calls.length;
  await say('REF778899', { message_id: 4001 });
  ok(since(n).some((c) => c.method === 'sendMessage' && String(c.body.text).includes(`سفارش #${o3.id}`)), 'search by receipt code opens the order');
  ok((await (await import('../src/telegram-screens.js')).orderSearch(env, '#' + o1.id)).text.includes(`سفارش #${o1.id}`), 'search by #number opens the order');

  // ---- plans: copy, move, description, delete = archive when used, hard delete when not ----
  n = fakes.tg.calls.length;
  await tap(`m:pcp:${monthly.id}`);
  const copy = await row("SELECT * FROM plans WHERE name = ?", monthly.name + ' (کپی)');
  ok(copy && copy.is_active === 0 && copy.price_toman === monthly.price_toman && copy.duration_days === monthly.duration_days, 'copy makes a hidden twin');
  ok(!(await call('GET', '/api/v1/plans')).data.some((p) => p.id === copy.id), 'the copy is not in the app until turned on');
  n = fakes.tg.calls.length;
  await tap(`m:pdl:${copy.id}`);
  const dc = confirmOf(n);
  ok(dc && dc.text.includes('برای همیشه پاک') && !!(await row('SELECT 1 x FROM plans WHERE id = ?', copy.id)), 'deleting an unused plan asks first and says it is permanent');
  await tap(`cf:${dc.token}`);
  ok(!(await row('SELECT 1 x FROM plans WHERE id = ?', copy.id)), 'an unused plan is deleted for real');
  n = fakes.tg.calls.length;
  await tap(`m:pdl:${monthly.id}`);
  const da = confirmOf(n);
  ok(da && da.text.includes('بایگانی'), 'deleting a plan with orders says it will be archived');
  await tap(`cf:${da.token}`);
  const arch = await row('SELECT * FROM plans WHERE id = ?', monthly.id);
  ok(arch && arch.archived === 1 && arch.is_active === 0, 'a used plan is archived, not deleted');
  ok(!(await call('GET', '/api/v1/plans')).data.some((p) => p.id === monthly.id), 'archived plans are hidden from the app');
  const tok2 = await signup('sales3b@example.com', { device: 's3b' });
  ok((await call('POST', '/api/v1/orders', { token: tok2, json: { plan_id: monthly.id, method: 'card' } })).status === 404, 'an archived plan cannot be bought');
  ok(!flat((await menu.renderScreen(env, 'pl')).kb).includes(`m:p:${monthly.id}`) && flat((await menu.renderScreen(env, 'pla')).kb).includes(`m:p:${monthly.id}`), 'it leaves the plan list and shows under 🗄 بایگانی');
  ok((await menu.renderScreen(env, `o:${o1.id}`)).text.includes(monthly.name), 'history still shows its name');
  n = fakes.tg.calls.length;
  await tap(`m:ug:${buyer.id}`);
  ok(!since(n).some((c) => c.body && c.body.reply_markup && flat(c.body.reply_markup.inline_keyboard).includes(`m:ugp:${buyer.id}:${monthly.id}`)), 'and from the grant list');
  ok(!(await acts.runAction(env, '12345', 'plan.toggle', { id: monthly.id })).ok, 'an archived plan cannot just be turned on');
  const ua = await acts.runAction(env, '12345', 'plan.unarchive', { id: monthly.id });
  ok(ua.ok && (await row('SELECT archived FROM plans WHERE id = ?', monthly.id)).archived === 0, 'unarchive brings it back (still off)');
  await acts.runAction(env, '12345', 'plan.toggle', { id: monthly.id });
  ok((await call('GET', '/api/v1/plans')).data.some((p) => p.id === monthly.id), 'turned on again, the app shows it');
  // order
  const order0 = (await call('GET', '/api/v1/plans')).data.map((p) => p.id);
  const mv = await acts.runAction(env, '12345', 'plan.move', { id: order0[1], dir: 'u' });
  const order1 = (await call('GET', '/api/v1/plans')).data.map((p) => p.id);
  ok(mv.ok && order1[0] === order0[1] && order1[1] === order0[0], 'move up swaps two plans in the app: ' + order0 + ' -> ' + order1);
  ok(!(await acts.runAction(env, '12345', 'plan.move', { id: order1[0], dir: 'u' })).ok, 'the first plan cannot move up');
  await acts.undoAction(env, '12345', mv.auditId);
  ok(JSON.stringify((await call('GET', '/api/v1/plans')).data.map((p) => p.id)) === JSON.stringify(order0), 'move can be undone');
  await tap(`m:pmv:${order0[0]}:d`);
  ok((await call('GET', '/api/v1/plans')).data.map((p) => p.id)[1] === order0[0], 'the ⬇️ button moves it down');
  await acts.runAction(env, '12345', 'plan.move', { id: order0[0], dir: 'u' });
  await acts.runAction(env, '12345', 'plan.set', { id: monthly.id, field: 'desc', raw: 'برای دو گوشی' });
  ok((await call('GET', '/api/v1/plans')).data.find((p) => p.id === monthly.id).description === 'برای دو گوشی', 'the description reaches the app');
  const pc = await menu.renderScreen(env, `p:${monthly.id}`);
  const sold = (await row("SELECT COUNT(*) c FROM orders WHERE status = 'paid' AND (plan_id = ?1 OR activate_plan_id = ?1)", monthly.id)).c;
  ok(sold >= 2 && pc.text.includes(`🛒 فروش: ${Number(sold).toLocaleString('en-US')} بار`) && pc.text.includes('برای دو گوشی') && flat(pc.kb).includes(`m:w:plan:${monthly.id}:desc`), 'the plan card shows sales and the description: ' + pc.text.split('\n').find((l) => l.includes('🛒')));

  // ---- coupons: edit and pause change what /coupons/check answers ----
  await acts.runAction(env, '12345', 'coupon.create', { code: 'S3OFF', percent: 10 });
  const cpn = await row("SELECT * FROM coupons WHERE code = 'S3OFF'");
  const check = () => call('POST', '/api/v1/coupons/check', { token: tok2, json: { code: 'S3OFF', plan_id: monthly.id } });
  ok((await check()).data.final_toman === Math.round(monthly.price_toman * 0.9 / 1000) * 1000, 'the new code gives 10%');
  await tap(`m:cs:${cpn.id}:p:50`);
  ok((await check()).data.final_toman === Math.round(monthly.price_toman * 0.5 / 1000) * 1000, 'a one-tap 50% changes the price the app gets');
  await tap(`m:ct:${cpn.id}`);
  const paused = await check();
  ok(paused.status === 400 && paused.data.detail.code === 'coupon_invalid', 'a paused code is refused');
  await tap(`m:ct:${cpn.id}`);
  ok((await check()).status === 200, 'resumed, it works again');
  const other = appPlans.find((p) => p.id !== monthly.id);
  await tap(`m:cs:${cpn.id}:l:${other.id}`);
  ok((await check()).data.detail.code === 'coupon_wrong_plan', 'limited to another plan, it is refused for this one');
  await tap(`m:cs:${cpn.id}:l:0`);
  await tap(`m:cs:${cpn.id}:d:7`);
  const exp = (await row('SELECT expires_at FROM coupons WHERE id = ?', cpn.id)).expires_at;
  ok(Math.abs(exp - (Math.floor(Date.now() / 1000) + 7 * 86400)) < 60 && (await check()).status === 200, '7 days from today');
  await env.DB.prepare('UPDATE coupons SET expires_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) - 10, cpn.id).run();
  ok((await check()).data.detail.code === 'coupon_expired', 'an expired code is refused');
  await tap(`m:cs:${cpn.id}:d:0`);
  ok((await row('SELECT expires_at FROM coupons WHERE id = ?', cpn.id)).expires_at === null && (await check()).status === 200, '«همیشه» clears the end date');
  await tap(`m:f:cpct:${cpn.id}`);
  await say('۳۵', { message_id: 4010 });
  await tap('m:fok:cpct');
  ok((await row('SELECT percent FROM coupons WHERE id = ?', cpn.id)).percent === 35, 'a typed percent through the form');
  const setU = await acts.runAction(env, '12345', 'coupon.set', { id: cpn.id, field: 'u', value: 3 });
  await acts.undoAction(env, '12345', setU.auditId);
  ok((await row('SELECT max_uses FROM coupons WHERE id = ?', cpn.id)).max_uses === 0, 'a coupon edit can be undone');
  ok(!(await acts.runAction(env, '12345', 'coupon.set', { id: cpn.id, field: 'p', value: 150 })).ok, 'a percent over 100 is refused');
  const gold = await row("SELECT id FROM coupons WHERE code = 'GOLD50'");
  const uses = await menu.renderScreen(env, `cu:${gold.id}`);
  ok(flat(uses.kb).some((x) => /^m:u:\d+$/.test(x)), 'the uses list links to who used it');
  const clist = await menu.renderScreen(env, 'cp');
  ok(flat(clist.kb).includes(`m:c:${cpn.id}`), 'the coupon list opens each card');

  // ---- referral ----
  const refCode = (await row('SELECT referral_code FROM users WHERE id = ?', buyer.id)).referral_code;
  await signup('sales3ref@example.com', { referral: refCode, device: 's3r' });
  await tap('m:ss:referral_percent:15');
  ok((await row("SELECT value FROM settings WHERE key = 'referral_percent'")).value === '15', 'referral percent from a suggestion button');
  await tap('m:ss:referral_percent:99');
  ok((await row("SELECT value FROM settings WHERE key = 'referral_percent'")).value === '15', 'a value that is not on the screen is refused');
  const ref = await menu.renderScreen(env, 'ref');
  ok(flat(ref.kb).includes(`m:u:${buyer.id}`) && ref.text.includes('15٪'), 'the referral screen shows the percent and the top referrer');

  // ---- payment methods: secrets masked, senders, SMS log, settings ----
  const key = 'k3y' + 'Z'.repeat(20);
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('sms_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key).run();
  const shown = [await menu.renderScreen(env, 'pay'), await menu.renderScreen(env, 'payset'), await menu.renderScreen(env, 'sk:sms_key')].map((x) => x.text + JSON.stringify(x.kb)).join('\n');
  ok(!shown.includes(key) && shown.includes('k3yZ••••'), 'the SMS key is only shown masked');
  const sk = await acts.runAction(env, '12345', 'setting.set', { key: 'sms_key', val: key + 'X' });
  ok(sk.ok && !sk.text.includes(key) && !(await row('SELECT summary FROM admin_audit WHERE id = ?', sk.auditId)).summary.includes(key), 'setting the SMS key never echoes it');
  await acts.undoAction(env, '12345', sk.auditId);
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('sms_senders', '09120000000,mybank') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  ok(flat((await menu.renderScreen(env, 'snd')).kb).includes('m:sdel:mybank'), 'senders are listed with a remove button');
  n = fakes.tg.calls.length;
  await tap('m:sdel:mybank');
  ok((await row("SELECT value FROM settings WHERE key = 'sms_senders'")).value === '09120000000', 'one tap removes a sender');
  const sdUndo = since(n).find((c) => c.method === 'editMessageText' && flat(c.body.reply_markup.inline_keyboard).some((x) => x.startsWith('m:undo:')));
  await tap(flat(sdUndo.body.reply_markup.inline_keyboard).find((x) => x.startsWith('m:undo:')));
  ok((await row("SELECT value FROM settings WHERE key = 'sms_senders'")).value === '09120000000,mybank', 'and undo puts it back');
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO sms_log (hash, sender, body, amount_rial, order_id, result, created_at) VALUES ('s3a', 'mybank', 'SECRET-BODY-ACCT 6037', 1230000, NULL, 'no_order', ?), ('s3b', 'mybank', 'SECRET-BODY-2', 990000, ?, 'paid', ?), ('s3c', 'mybank', 'old', 50000, NULL, 'no_order', ?)")
    .bind(now, o1.id, now, now - 30 * 86400).run();
  const smsAll = await menu.renderScreen(env, 'sms');
  const smsUn = await menu.renderScreen(env, 'sms:un');
  ok(smsAll.text.includes('123,000') && flat(smsAll.kb).includes(`m:o:${o1.id}`) && !smsAll.text.includes('SECRET-BODY'), 'the SMS log shows amount, result and order, never the SMS text');
  ok(smsUn.text.includes('123,000') && !smsUn.text.includes('99,000'), 'the unmatched filter shows only unmatched SMS');
  await tap('m:ss:coin_minutes:60');
  await tap('m:ss:coin_minutes:7');
  ok((await row("SELECT value FROM settings WHERE key = 'coin_minutes'")).value === '60', 'coin minutes from a button; a value not offered is refused');
  ok(!(await acts.runAction(env, '12345', 'setting.set', { key: 'wallet_trx', val: 'not-an-address' })).ok, 'a wrong wallet address is refused');
  const wl = await menu.renderScreen(env, 'wl');
  ok(flat(wl.kb).includes('m:sk:wallet_trx') && wl.kb.flat().some((x) => x.text.includes('TRX')), 'wallets are listed per coin');

  // ---- inbox counts: receipts, coin detections, unmatched SMS, panel errors ----
  await env.DB.prepare("INSERT INTO orders (user_id, kind, plan_id, amount_toman, method, status, txid, coin, created_at) VALUES (?, 'plan', ?, 100000, 'coin', 'review', 'tx-s3-detect', 'trx', ?)")
    .bind(buyer.id, monthly.id, now).run();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('panel_err_99', 'refused') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const c = await row(`SELECT (SELECT COUNT(*) FROM orders WHERE status = 'review') r, (SELECT COUNT(*) FROM orders WHERE status = 'review' AND method = 'coin' AND txid IS NOT NULL) coin,
    (SELECT COUNT(*) FROM sms_log WHERE result IN ('no_order', 'ambiguous', 'settle_failed') AND created_at > ?) sms,
    (SELECT COUNT(*) FROM settings WHERE key LIKE 'panel_err_%' AND value != '') perr`, now - 7 * 86400);
  const inb = await menu.renderScreen(env, 'in');
  const fmt = (x) => Number(x).toLocaleString('en-US');
  ok(c.coin >= 1 && c.sms >= 1 && inb.text.includes(`رسید منتظر بررسی: ${fmt(c.r)}`) && inb.text.includes(`پیداشده (منتظر تأیید تو): ${fmt(c.coin)}`)
    && inb.text.includes(`(7 روز): ${fmt(c.sms)}`) && inb.text.includes(`ساخت اکانت را رد کرده: ${fmt(c.perr)}`), 'the inbox counts each kind: ' + inb.text.split('\n').slice(2, 6).join(' / '));
  ok(['m:or:rev', 'm:or:rev:coin', 'm:sms:un', 'm:pa'].every((x) => flat(inb.kb).includes(x)), 'each count opens its list');
  const homeBtn = (await menu.renderScreen(env, 'home')).kb.flat().find((x) => x.callback_data === 'm:in');
  ok(homeBtn.text.includes(`(${c.r + c.sms + c.perr})`), 'the home button shows the total: ' + homeBtn.text);
  await env.DB.prepare("DELETE FROM settings WHERE key = 'panel_err_99'").run();

  // ---- every new screen: routes, breadcrumbs, back + home, ≤6 D1 statements ----
  const screens = ['or', 'or:rev', 'or:paid:card', 'or:all:coin', `o:${o1.id}`, `o:${o3.id}`, 'pl', 'pla', `p:${monthly.id}`, 'cp', `c:${cpn.id}`, `cpl:${cpn.id}`, `cu:${gold.id}`,
    'ref', 'pay', 'payset', 'snd', 'sms', 'sms:un', 'wl', 'in', `hist:order:${o1.id}`, 'hist:coupon:S3OFF'];
  const realPrepare = env.DB.prepare;
  let q = 0, maxQ = 0;
  const bad = [], noNav = [], over = [];
  env.DB.prepare = (sql) => { q++; return realPrepare(sql); };
  for (const d of screens) {
    q = 0;
    const scr = await menu.renderScreen(env, d);
    if (q > 6) over.push(`${d}=${q}`);
    maxQ = Math.max(maxQ, q);
    for (const x of flat(scr.kb)) if (!menu.routeOf(x) || new TextEncoder().encode(x).length > 64) bad.push(`${d} -> ${x}`);
    const last = flat([scr.kb[scr.kb.length - 1]]);
    if (!last.includes('m:home') || !String(scr.text).startsWith('🏠 منو')) noNav.push(d);
  }
  env.DB.prepare = realPrepare;
  console.log('    most D1 statements on one sales screen: ' + maxQ);
  ok(!bad.length, 'sales screen buttons resolve within 64 bytes: ' + bad.slice(0, 4).join(' | '));
  ok(!noNav.length, 'sales screens have breadcrumbs and end with home: ' + noNav.join(' '));
  ok(!over.length, 'sales screens use ≤6 D1 statements: ' + over.join(' '));
  ok(['cpct', 'cuses', 'cdays'].every((f) => menu.routeOf(`m:f:${f}:${cpn.id}`)) && !menu.routeOf('m:f:nope:1'), 'every coupon form has a route');

  const slash = since(startCalls).filter((x) => x.body && String(x.body.chat_id) === '12345').map((x) => String(x.body.text || x.body.caption || '')).filter((t) => /^\/[a-z]/m.test(t));
  ok(!slash.length, 'no sales text line starts with /command: ' + slash.slice(0, 2).join(' || ').slice(0, 200));

  const logged = new Set((await env.DB.prepare('SELECT DISTINCT action FROM admin_audit').all()).results.map((r) => r.action));
  const missing = Object.keys(acts.ACTIONS).filter((x) => !logged.has(x) && !STAGE4_ACTIONS.includes(x) && !STAGE5_ACTIONS.includes(x));
  ok(!missing.length, 'every admin action has written an audit row: missing ' + missing.join(','));
}

section('Pleat in-app update: build on the private release, announce in the bot, download through the Worker');
{
  const upd = await import('../src/appupdate.js');
  let tapN = 0;
  const tap = (data) => tgWebhook({ callback_query: { id: 'up-' + (++tapN), data, message: { chat: { id: 12345 }, message_id: 907, text: 'menu' } } });
  const since = (n) => fakes.tg.calls.slice(n);
  const lastScreen = (n) => since(n).filter((c) => c.method === 'editMessageText' || c.method === 'sendMessage').pop();
  const flat = (kb) => (kb || []).flat().map((x) => x.callback_data).filter(Boolean);
  const acks = (n) => since(n).filter((c) => c.method === 'answerCallbackQuery').map((c) => String(c.body.text || '')).join(' | ');
  const cfg = async () => (await call('GET', '/api/v1/app-config')).data.update;
  const userTok = await signup('updater@example.com');

  // no token yet: nothing is offered, the bot says what is missing
  ok((await cfg()) === null, 'app-config has no update before one is announced');
  let n = fakes.tg.calls.length;
  await tap('m:upd');
  ok(/PLEAT_DL_TOKEN/.test(lastScreen(n)?.body.text || ''), 'the update screen says the download token is missing');
  n = fakes.tg.calls.length;
  await tap('m:upa');
  ok(/PLEAT_DL_TOKEN/.test(acks(n)), 'announcing without the token is refused with the reason');

  // the private release: two builds' files, GitHub's signed address behind each asset
  const bytes = {};
  const asset = (id, name, size) => { bytes[id] = new Uint8Array(size).map((_, i) => (i * 7 + id) % 251); return { id, name, size, state: 'uploaded', digest: 'sha256:' + String(id % 10).repeat(64), updated_at: '2026-11-07T10:00:00Z' }; };
  const release = { name: 'Pleat 1.2.19+22 (latest build)', body: 'Pleat 1.2.19+22, built from abcdef1234 on 2026-11-07.', assets: [
    asset(11, 'pleat-1.2.18-21-arm64-v8a.apk', 50), asset(21, 'pleat-1.2.19-22-arm64-v8a.apk', 120), asset(22, 'pleat-1.2.19-22-armeabi-v7a.apk', 90),
    asset(23, 'pleat-1.2.19-22-x86_64.apk', 130), { id: 30, name: 'pleat.apk', size: 120, digest: 'sha256:' + '9'.repeat(64) },
  ] };
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const h = new Headers(init.headers || {});
    if (url.startsWith('https://api.github.com/')) {
      seen.push({ url, auth: h.get('authorization'), redirect: init.redirect });
      if (h.get('authorization') !== 'Bearer gh-test') return new Response('{}', { status: 401 });
      if (url.endsWith('/repos/litecoin1203-cell/cfworker/releases/tags/pleat-latest')) return Response.json(release);
      const m = /\/releases\/assets\/(\d+)$/.exec(url);
      if (m && bytes[m[1]]) return new Response(null, { status: 302, headers: { location: 'https://objects.gh.test/f/' + m[1] + '?sig=x' } });
      return new Response('{}', { status: 404 });
    }
    if (url.startsWith('https://objects.gh.test/')) {
      seen.push({ url, auth: h.get('authorization'), range: h.get('range') });
      const b = bytes[/\/f\/(\d+)/.exec(url)[1]];
      if (!b) return new Response('', { status: 404 });
      const r = /^bytes=(\d+)-$/.exec(h.get('range') || '');
      if (r) return new Response(b.slice(+r[1]), { status: 206, headers: { 'content-length': String(b.length - r[1]), 'content-range': `bytes ${r[1]}-${b.length - 1}/${b.length}` } });
      return new Response(b, { headers: { 'content-length': String(b.length) } });
    }
    return realFetch(input, init);
  };
  env.PLEAT_DL_TOKEN = 'gh-test';
  try {
    const latest = await upd.latestBuild(env);
    ok(latest && latest.version === '1.2.19' && latest.build === 22 && Object.keys(latest.abis).length === 3 && latest.commit === 'abcdef1', 'the newest build on the release is read with its three phone types');
    ok(latest && latest.abis['arm64-v8a'].size === 120 && latest.abis['arm64-v8a'].sha256 === '1'.repeat(64), 'size and SHA-256 come from GitHub');

    // the admin hears about the new build once
    const told = [];
    ok(await upd.checkNewBuild(env, async (t, kb) => told.push({ t, kb })), 'a new build is told to the admin');
    ok(told.length === 1 && /1\.2\.19/.test(told[0].t) && flat(told[0].kb.inline_keyboard).includes('m:upd'), 'the note names the version and has the update button');
    ok(!(await upd.checkNewBuild(env, async (t) => told.push({ t }))) && told.length === 1, 'the same build is told only once');

    n = fakes.tg.calls.length;
    await tap('m:upd');
    let scr = lastScreen(n);
    ok(/1\.2\.19/.test(scr?.body.text || '') && flat(scr.body.reply_markup.inline_keyboard).includes('m:upa'), 'the update screen shows the build and an announce button');
    ok(!/(^|\n)\s*\//.test(scr?.body.text || ''), 'the update screen asks for no typed command');
    ok((await cfg()) === null, 'nothing reaches the apps before the announcement');

    await tap('m:upa');
    let u = await cfg();
    ok(u && u.version === '1.2.19' && u.build === 22 && u.force === false && u.tag === latest.tag, 'after announce app-config carries the build');
    ok(u && u.abis['armeabi-v7a'].size === 90 && !('id' in u.abis['armeabi-v7a']), 'app-config gives size and hash per phone type, no GitHub ids');

    // the download: signed-in users only, the announced build only, passed through with a resumed range
    ok((await call('GET', `/api/v1/app/apk?tag=${u.tag}&abi=arm64-v8a`)).status === 401, 'the APK needs a signed-in user');
    ok((await call('GET', `/api/v1/app/apk?tag=21-x&abi=arm64-v8a`, { token: userTok })).status === 410, 'an old tag gets 410 (read app-config again)');
    ok((await call('GET', `/api/v1/app/apk?tag=${u.tag}&abi=mips`, { token: userTok })).status === 404, 'an unknown phone type gets 404');
    seen.length = 0;
    let r = await call('GET', `/api/v1/app/apk?tag=${u.tag}&abi=arm64-v8a`, { token: userTok });
    let got = new Uint8Array(await r.res.arrayBuffer());
    ok(r.status === 200 && got.length === 120 && got.every((x, i) => x === bytes[21][i]), 'the whole APK comes through');
    ok(r.res.headers.get('content-type') === 'application/vnd.android.package-archive' && r.res.headers.get('content-length') === '120', 'it is sent as an APK with its length');
    ok(seen[0].redirect === 'manual' && seen[1].auth === null, 'the token goes to GitHub only, never to the signed file address');
    r = await call('GET', `/api/v1/app/apk?tag=${u.tag}&abi=arm64-v8a`, { token: userTok, headers: { range: 'bytes=100-' } });
    got = new Uint8Array(await r.res.arrayBuffer());
    ok(r.status === 206 && got.length === 20 && got[0] === bytes[21][100] && /^bytes 100-119\/120$/.test(r.res.headers.get('content-range') || ''), 'a dropped download resumes from where it stopped');
    r = await call('GET', `/api/v1/app/apk?tag=${u.tag}&abi=arm64-v8a`, { token: userTok, headers: { range: 'bytes=0-5,7-9' } });
    ok(r.status === 200 && !seen.pop().range, 'an odd Range header is not passed on');

    // force on, undo it, withdraw
    n = fakes.tg.calls.length;
    await tap('m:upf');
    ok((await cfg()).force === true, 'the admin can make the update a must');
    const forced = await env.DB.prepare("SELECT id FROM admin_audit WHERE action = 'app.release' ORDER BY id DESC LIMIT 1").first();
    await tap(`m:undo:${forced.id}`);
    ok((await cfg()).force === false, 'making it a must can be undone');
    n = fakes.tg.calls.length;
    await tap('m:upa');
    ok(/همین بیلد/.test(acks(n)), 'announcing the same build twice is refused');

    // a rebuild that removed the announced file: the app is told it is gone
    const keep = bytes[21];
    delete bytes[21];
    ok((await call('GET', `/api/v1/app/apk?tag=${u.tag}&abi=arm64-v8a`, { token: userTok })).status === 410, 'a file gone from the release gets 410');
    bytes[21] = keep;

    await tap('m:upx');
    ok((await cfg()) === null, 'withdrawing stops the offer');
    ok((await call('GET', `/api/v1/app/apk?tag=${u.tag}&abi=arm64-v8a`, { token: userTok })).status === 410, 'and the download with it');
    ok(upd.cleanRelease({ version: '1.2', build: 3, abis: {} }) === null && upd.cleanRelease({ version: '1.2.3', build: 3, abis: { 'arm64-v8a': { size: 1, id: 1, sha256: 'zz' } } }) === null, 'a malformed build is ignored');
  } finally {
    globalThis.fetch = realFetch;
    delete env.PLEAT_DL_TOKEN;
    await env.DB.prepare("DELETE FROM settings WHERE key IN ('app_release', 'app_build_seen')").run();
  }
}

section('admin panel stage 4: panels and servers, the Pleat app, network');
{
  const menu = await import('../src/telegram-menu.js');
  const acts = await import('../src/admin-actions.js');
  const { serverKey } = await import('../src/netstats.js');
  const A = { chat: { id: 12345 } };
  let tapN = 0, msgN = 7000;
  const tap = (data, message = { ...A, message_id: 904, text: 'menu' }) => tgWebhook({ callback_query: { id: 's4-' + (++tapN), data, message } });
  const say = (text) => tgWebhook({ message: { ...A, text, message_id: ++msgN } });
  const since = (n) => fakes.tg.calls.slice(n);
  const flat = (kb) => (kb || []).flat().map((x) => x.callback_data).filter(Boolean);
  const row = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
  const rows = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
  const lastText = (n) => { const c = since(n).filter((x) => x.body && (x.method === 'editMessageText' || x.method === 'sendMessage')).pop(); return c ? String(c.body.text || '') : ''; };
  const allText = (n) => since(n).filter((x) => x.body).map((x) => JSON.stringify(x.body)).join('\n');
  const acks = (n) => since(n).filter((c) => c.method === 'answerCallbackQuery').map((c) => String(c.body.text || '')).join(' | ');
  const lastAudit = (action) => row('SELECT * FROM admin_audit WHERE action = ? ORDER BY id DESC LIMIT 1', action);
  const confirmOf = (n) => {
    const m = since(n).filter((c) => c.method === 'sendMessage' && c.body && c.body.reply_markup && flat(c.body.reply_markup.inline_keyboard).some((x) => x.startsWith('cf:'))).pop();
    return m ? { token: flat(m.body.reply_markup.inline_keyboard).find((x) => x.startsWith('cf:')).slice(3), text: m.body.text } : null;
  };

  // a user with a plan on panel 1: three servers (NL, DE, US)
  const tok = await signup('net4@example.com', { device: 's4' });
  const u4 = await row('SELECT * FROM users WHERE email = ?', 'net4@example.com');
  const plan = await row('SELECT id FROM plans WHERE is_active = 1 AND archived = 0 ORDER BY sort, id LIMIT 1');
  await acts.runAction(env, '12345', 'user.grant', { userId: u4.id, planId: plan.id });
  const H = { 'x-device-id': 's4', 'x-hwid': 's4' };
  const servers = async () => (await call('GET', '/api/v1/vpn/servers', { token: tok, headers: H })).data;
  const s0 = await servers();
  ok(Array.isArray(s0) && s0.length >= 3, 'the stage 4 user has servers: ' + s0.map((s) => s.name).join(','));
  const nl = s0.find((s) => s.country_code === 'NL'), de = s0.find((s) => s.country_code === 'DE');
  const kNl = serverKey(nl.link), kDe = serverKey(de.link);
  const pa1 = await row("SELECT panel_id FROM panel_accounts WHERE user_id = ? AND desired = 'active'", u4.id);
  const pid = pa1.panel_id;

  // ---- the server list: names, types and countries, never an address, port, id or link ----
  let n = fakes.tg.calls.length;
  const list = await menu.renderScreen(env, `srvs:${pid}`);
  const listAll = list.text + JSON.stringify(list.kb);
  ok(/NL/.test(list.text) && /vless·reality·tcp/.test(list.text) && /trojan/.test(list.text), 'the server list shows country and config type: ' + list.text.slice(0, 200));
  ok(!/example\.com|uuid|pass@|:443|vless:\/\//.test(listAll), 'the server list never shows an address, port, id or link');
  ok(flat(list.kb).includes(`m:srv:${pid}:${kNl}`), 'each server has its own card');
  const card = await menu.renderScreen(env, `srv:${pid}:${kNl}`);
  ok(!/example\.com|uuid|:443|vless:\/\//.test(card.text + JSON.stringify(card.kb)), 'the server card never shows an address, port, id or link');
  ok(String(card.text).startsWith('🏠 منو') && flat([card.kb[card.kb.length - 1]]).includes('m:home'), 'the server card has breadcrumbs, back and home');

  // ---- hide: gone from /vpn/servers and /vpn/sub; undo brings it back ----
  n = fakes.tg.calls.length;
  await tap(`m:sh:${pid}:${kNl}:1`);
  ok((await row('SELECT hidden FROM server_overrides WHERE panel_id = ? AND server_key = ?', pid, kNl))?.hidden === 1, 'hide writes server_overrides');
  const s1 = await servers();
  ok(s1.length === s0.length - 1 && !s1.some((s) => serverKey(s.link) === kNl), 'a hidden server disappears from /vpn/servers: ' + s0.map((s) => s.name + '=' + serverKey(s.link)).join(',') + ' -> ' + s1.length);
  const subR = await call('GET', '/api/v1/vpn/sub', { token: tok, headers: H });
  const subLinksNow = decodeSub(await subR.res.text());
  ok(subLinksNow.length === s0.length - 1 && !subLinksNow.some((l) => serverKey(l) === kNl), 'a hidden server disappears from /vpn/sub: ' + subLinksNow.length);
  const hideAudit = await lastAudit('server.hide');
  ok(hideAudit && hideAudit.undo_json && hideAudit.target_type === 'server', 'hide is in the admin log with an undo');
  ok(flat(since(n).filter((c) => c.body && c.body.reply_markup).pop()?.body.reply_markup.inline_keyboard).includes(`m:undo:${hideAudit.id}`), 'the card comes back with the undo button');
  await tap(`m:undo:${hideAudit.id}`);
  ok(!(await row('SELECT 1 x FROM server_overrides WHERE panel_id = ? AND server_key = ?', pid, kNl)), 'undo of a hide removes the override');
  ok((await servers()).length === s0.length, 'after undo the server is back in /vpn/servers');

  // ---- rename: English only, shows in the app, the ranking key does not move ----
  n = fakes.tg.calls.length;
  await tap(`m:f:srn:${pid}.${kDe}`);
  await say('سرور آلمان');
  ok(/حرف فارسی/.test(lastText(n)), 'a Persian server name is refused (the app is English only)');
  await say('🇩🇪 Germany Fast');
  await tap('m:fok:srn');
  ok((await row('SELECT label FROM server_overrides WHERE panel_id = ? AND server_key = ?', pid, kDe))?.label === '🇩🇪 Germany Fast', 'rename stores the label');
  const s2 = await servers();
  const deNow = s2.find((s) => serverKey(s.link) === kDe);
  ok(deNow && deNow.name === 'Germany Fast' && deNow.country_code === 'DE', 'the renamed server shows its new name in the app: ' + (deNow && deNow.name));
  ok(s2.filter((s) => s.name !== 'Germany Fast').every((s) => /^([A-Z]{2} \d+|Server \d+)$/.test(s.name)), 'other servers keep their automatic names');
  const MCI = { asn: 197207, asOrganization: 'Mobile Communication Company of Iran PLC' };
  const MTN = { asn: 44244, asOrganization: 'Iran Cell Service and Communication Company' };
  globalThis.__cgNet = {};
  await call('POST', '/api/v1/net/report', { token: tok, cf: MCI, json: { results: [{ k: kDe, ok: true, ms: 80 }, { k: kNl, ok: true, ms: 150 }] } });
  globalThis.__cgNet = {};
  await call('POST', '/api/v1/net/report', { token: tok, cf: MTN, json: { results: [{ k: kDe, ok: false }, { k: kNl, ok: true, ms: 60 }] } });
  const rank = (await call('GET', '/api/v1/net/rank', { token: tok, cf: MCI })).data;
  ok(rank.servers && rank.servers[kDe] && rank.servers[kDe].score > 0, 'ranking still works for the renamed server (same key)');
  ok(menu.routeOf(`m:f:srn:${pid}.${kDe}`) && !menu.routeOf('m:f:nope:1'), 'the rename form has a route');
  const r0 = await acts.runAction(env, '12345', 'server.rename', { panelId: pid, key: kDe, label: 'bad#name' });
  ok(!r0.ok, 'a server name with # is refused');

  // ---- panel: rename, last test, enable a disabled panel (and undo) ----
  await tap(`m:f:pnm:${pid}`);
  await say('Main panel');
  await tap('m:fok:pnm');
  ok((await row('SELECT label FROM panels WHERE id = ?', pid)).label === 'Main panel', 'the panel can be renamed from its card');
  await tgWebhook({ message: { ...A, text: `/paneltest ${pid}` } });
  const pc = await menu.renderScreen(env, `pp:${pid}`);
  ok(/آخرین تست/.test(pc.text) && /vless·reality·tcp/.test(pc.text), 'the panel card shows the last test and the config types');
  ok(!/example\.com|cgtest_/.test(pc.text), 'the panel card never shows the address or the test user');
  ok(flat(pc.kb).includes(`m:srvs:${pid}`), 'the panel card links to its servers');
  const { addPanel } = await import('../src/panels.js');
  const p2 = await addPanel(env, 'auto', 'old panel');
  await env.DB.prepare("UPDATE panels SET state = 'disabled' WHERE id = ?").bind(p2.id).run();
  ok(flat((await menu.renderScreen(env, `pp:${p2.id}`)).kb).includes(`m:pen:${p2.id}`), 'a disabled panel has a re-enable button');
  await tap(`m:pen:${p2.id}`);
  ok((await row('SELECT state FROM panels WHERE id = ?', p2.id)).state === 'testing', 'enable moves a disabled panel back to testing');
  await tap(`m:undo:${(await lastAudit('panel.enable')).id}`);
  ok((await row('SELECT state FROM panels WHERE id = ?', p2.id)).state === 'disabled', 'undo of enable disables it again');
  await env.DB.prepare('DELETE FROM panels WHERE id = ?').bind(p2.id).run();

  // ---- the app's domains: add (validated), remove, reorder, test ----
  n = fakes.tg.calls.length;
  await tap('m:f:appd');
  await say('http://plain.example.org');
  ok(/آدرس درست نیست/.test(lastText(n)), 'a non-https domain is refused');
  await say('https://x.example.org/path');
  ok(/آدرس درست نیست/.test(lastText(n)) && !(await row("SELECT value FROM settings WHERE key = 'app_api_bases'"))?.value, 'a domain with a path is refused');
  await say('https://API2.example.org/');
  await tap('m:fok:appd');
  ok((await row("SELECT value FROM settings WHERE key = 'app_api_bases'")).value === 'https://api2.example.org', 'a good domain is added (trailing slash dropped)');
  ok(!(await acts.runAction(env, '12345', 'app.list', { k: 'd', op: 'add', value: 'https://api2.example.org' })).ok, 'a duplicate domain is refused');
  await acts.runAction(env, '12345', 'app.list', { k: 'd', op: 'add', value: 'https://down.example.org' });
  let cfg = (await call('GET', '/api/v1/app-config')).data;
  ok(cfg.api_bases.join() === 'https://api2.example.org,https://down.example.org', 'app-config hands out the added domains in order');
  const dl = await menu.renderScreen(env, 'appl:d');
  const mv = flat(dl.kb).find((x) => x.startsWith('m:apm:d:1:'));
  ok(mv && flat(dl.kb).includes('m:apt'), 'the domain list has move and test buttons');
  await tap(mv);
  cfg = (await call('GET', '/api/v1/app-config')).data;
  ok(cfg.api_bases.join() === 'https://down.example.org,https://api2.example.org', 'reorder moves a domain up');
  n = fakes.tg.calls.length;
  await tap(mv); // drawn for the old order: names a different item now
  ok(/عوض شده/.test(acks(n)) && (await call('GET', '/api/v1/app-config')).data.api_bases[0] === 'https://down.example.org', 'a stale button does not move a different item');
  const realFetch = globalThis.fetch;
  const seenUrls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://api2.example.org/health') { seenUrls.push(url); return new Response('{"ok":true}', { status: 200 }); }
    if (url === 'https://down.example.org/health') { seenUrls.push(url); throw new TypeError('connect failed'); }
    return realFetch(input, init);
  };
  n = fakes.tg.calls.length;
  await tap('m:apt');
  globalThis.fetch = realFetch;
  const tested = lastText(n);
  ok(/✅ https:\/\/api2\.example\.org — \d+ms/.test(tested) && /❌ https:\/\/down\.example\.org/.test(tested), 'the domain test reports a down domain as failed: ' + tested.slice(0, 200));
  ok(seenUrls.length === 2, 'the domain test makes one fetch per domain');
  const rmBtn = flat((await menu.renderScreen(env, 'appl:d')).kb).find((x) => x.startsWith('m:apr:d:0:'));
  await tap(rmBtn);
  cfg = (await call('GET', '/api/v1/app-config')).data;
  ok(cfg.api_bases.join() === 'https://api2.example.org', 'remove takes one domain out');
  await tap(`m:undo:${(await lastAudit('app.list')).id}`);
  ok((await call('GET', '/api/v1/app-config')).data.api_bases.length === 2, 'undo of a remove puts the domain back');

  // ---- bridges: the full link is never echoed ----
  const BR = 'vless://secret-uuid-1234@bridge.hidden-host.net:8443?security=tls&type=ws#br';
  n = fakes.tg.calls.length;
  await tap('m:f:appb');
  await say('not a link');
  await say(BR);
  await tap('m:fok:appb');
  const brCalls = allText(n);
  ok((await call('GET', '/api/v1/app-config')).data.bridges[0] === BR, 'app-config hands out the bridge in full');
  ok(!brCalls.includes('secret-uuid') && !brCalls.includes('hidden-host') && !brCalls.includes('8443'), 'the bridge link is never echoed in bot text');
  ok(since(n).filter((c) => c.method === 'deleteMessage').length >= 1, 'the message with the bridge is deleted from the chat');
  const bl = await menu.renderScreen(env, 'appl:b');
  const sk = await menu.renderScreen(env, 'sk:app_bridges');
  ok(/vless:\/\/br•••net/.test(bl.text) && !/hidden-host|secret-uuid/.test(bl.text + sk.text), 'the bridge list and setting show only scheme + masked host: ' + bl.text.split('\n').find((l) => l.includes('vless')));
  ok(!/hidden-host|secret-uuid/.test((await lastAudit('app.list')).summary || ''), 'the admin log does not keep the bridge link');
  ok(acts.maskBridge('vmess://' + btoa(JSON.stringify({ add: 'vm.hidden-host.net', port: 443, id: 'x' }))) === 'vmess://vm•••net', 'vmess bridges are masked too');

  // ---- announcement, support link, trial: app-config reflects the edits ----
  await tap('m:w:set:announcement');
  await say('New servers tonight');
  cfg = (await call('GET', '/api/v1/app-config')).data;
  ok(cfg.announcement === 'New servers tonight', 'app-config shows the new announcement');
  const appScr = await menu.renderScreen(env, 'app');
  ok(appScr.text.includes('«New servers tonight»') && flat(appScr.kb).includes('m:apc:announcement'), 'the app screen previews the announcement with a clear button');
  await tap('m:apc:announcement');
  ok(!(await call('GET', '/api/v1/app-config')).data.announcement, 'clear removes the announcement from the app');
  ok(!(await acts.runAction(env, '12345', 'setting.set', { key: 'support_url', val: 'javascript:alert(1)' })).ok, 'a bad support link is refused');
  await tap('m:w:set:support_url');
  await say('https://t.me/cloudgold_support');
  ok((await call('GET', '/api/v1/app-config')).data.support_url === 'https://t.me/cloudgold_support', 'app-config shows the new support link');
  await tap('m:ss:trial_data_gb:2');
  ok((await row("SELECT value FROM settings WHERE key = 'trial_data_gb'")).value === '2', 'trial volume is one tap');
  ok(['m:pl', 'm:ref', 'm:pay', 'm:sk:min_topup_toman', 'm:appl:d', 'm:appl:b'].every((x) => flat(appScr.kb).includes(x)), 'every app-config field has a way to edit it from the app screen');
  await acts.runAction(env, '12345', 'setting.set', { key: 'trial_data_gb', val: '0' });
  await acts.runAction(env, '12345', 'setting.set', { key: 'support_url', val: '' });

  // ---- network: native screens, best servers per operator, reset with impact ----
  globalThis.__cgGoo = {};
  await call('POST', '/api/v1/net/google', { token: tok, json: { k: kNl, name: 'NL', cc: 'NL', google_cc: 'NL', gemini: true } });
  globalThis.__cgGoo = {};
  await call('POST', '/api/v1/net/google', { token: tok, json: { k: kDe, name: 'DE', cc: 'DE', google_cc: 'DE', gemini: true } });
  const nc = await menu.renderScreen(env, 'nc');
  ok(flat(nc.kb).includes('m:nca:197207') && flat(nc.kb).includes('m:nca:44244'), 'the operator screen lists both operators');
  const nca = await menu.renderScreen(env, 'nca:44244');
  ok(/بهترین سرورها/.test(nca.text) && flat(nca.kb).includes('m:nrs:a:44244'), 'one operator shows its best servers and a reset button');
  const nsv = await menu.renderScreen(env, `nsv:${kDe}`);
  ok(/Germany Fast/.test(nsv.text) && /رتبه/.test(nsv.text), 'one server shows its rank on each operator under its new name: ' + nsv.text.slice(0, 160));
  const count = async (col, val) => {
    let t = 0;
    for (const tb of ['net_stats', 'net_geo', 'net_votes', 'user_net_srv', 'google_probe']) {
      if (col === 'asn' && tb === 'google_probe') continue;
      t += (await row(`SELECT COUNT(*) c FROM ${tb} WHERE ${col} = ?`, val)).c;
    }
    return t;
  };
  const before = { de: await count('skey', kDe), nl: await count('skey', kNl), mtn: await count('asn', 44244), mci: await count('asn', 197207) };
  ok(before.de > 0 && before.nl > 0 && before.mtn > 0 && before.mci > 0, 'stats exist before the reset: ' + JSON.stringify(before));
  n = fakes.tg.calls.length;
  await tap(`m:nrs:s:${kDe}`);
  const q1 = confirmOf(n);
  ok(q1 && /ردیف/.test(q1.text) && /برگشت ندارد/.test(q1.text), 'a server reset asks first and says how many rows it removes');
  ok(await count('skey', kDe) === before.de, 'nothing is removed before the confirm');
  await tgWebhook({ callback_query: { id: 's4-cf1', data: `cf:${q1.token}`, message: { ...A, message_id: 905, text: 'q' } } });
  ok(await count('skey', kDe) === 0, 'a server reset removes that server\'s rows');
  ok(await count('skey', kNl) === before.nl, 'a server reset leaves the other servers alone');
  const nlMtn = (await row('SELECT COUNT(*) c FROM net_geo WHERE asn = 44244 AND skey = ?', kNl)).c;
  n = fakes.tg.calls.length;
  await tap('m:nrs:a:44244');
  const q2 = confirmOf(n);
  await tgWebhook({ callback_query: { id: 's4-cf2', data: `cf:${q2.token}`, message: { ...A, message_id: 906, text: 'q' } } });
  ok(nlMtn > 0 && await count('asn', 44244) === 0, 'an operator reset removes that operator\'s rows');
  ok(await count('asn', 197207) > 0 && (await row('SELECT COUNT(*) c FROM google_probe WHERE skey = ?', kNl)).c > 0, 'an operator reset leaves other operators and Google tests alone');
  ok((await lastAudit('net.reset')) && !(await lastAudit('net.reset')).undo_json, 'a reset is in the admin log (no undo: destructive)');
  ok(!(await acts.runAction(env, '12345', 'net.reset', { kind: 'a', id: '1 OR 1=1' })).ok && !(await acts.runAction(env, '12345', 'net.reset', { kind: 's', id: "x' --" })).ok, 'a reset refuses a bad target');

  // ---- every new screen: buttons resolve within 64 bytes, crumbs, back + home, ≤6 D1 statements ----
  const screens = [`pp:${pid}`, `srvs:${pid}`, `srv:${pid}:${kNl}`, `srv:${pid}:${kDe}`, 'app', 'appl:d', 'appl:b', 'sk:app_bridges', 'sk:app_api_bases', 'net', 'nc', 'nca:197207', 'nca:44244', `nsv:${kNl}`, 'ng',
    `hist:server:${pid}.${kDe}`];
  const realPrepare = env.DB.prepare;
  let q = 0, maxQ = 0;
  const bad = [], noNav = [], over = [];
  env.DB.prepare = (sql) => { q++; return realPrepare(sql); };
  for (const d of screens) {
    q = 0;
    const scr = await menu.renderScreen(env, d);
    if (q > 6) over.push(`${d}=${q}`);
    maxQ = Math.max(maxQ, q);
    for (const x of flat(scr.kb)) if (!menu.routeOf(x) || new TextEncoder().encode(x).length > 64) bad.push(`${d} -> ${x}`);
    const last = flat([scr.kb[scr.kb.length - 1]]);
    if (!last.includes('m:home') || (last.length < 2 && !['app', 'net'].includes(d)) || !String(scr.text).startsWith('🏠 منو')) noNav.push(d);
  }
  env.DB.prepare = realPrepare;
  console.log('    most D1 statements on one stage 4 screen: ' + maxQ);
  ok(!bad.length, 'stage 4 buttons resolve within 64 bytes: ' + bad.slice(0, 4).join(' | '));
  ok(!noNav.length, 'stage 4 screens have breadcrumbs and end with back + home: ' + noNav.join(' '));
  ok(!over.length, 'stage 4 screens use ≤6 D1 statements: ' + over.join(' '));
  const walked = new Set();
  const queue = ['pa', 'app', 'net']; // the stage 1 walk covers home; this one starts at the stage 4 sections
  while (queue.length && walked.size < 400) {
    const d = queue.shift();
    if (walked.has(d)) continue;
    walked.add(d);
    for (const x of flat((await menu.renderScreen(env, d)).kb)) {
      const r = x.startsWith('m:') && menu.ROUTES[x.slice(2).split(':')[0]];
      if (r && r.kind === 'screen' && !walked.has(x.slice(2))) queue.push(x.slice(2));
    }
  }
  const unreached = ['srvs', 'srv', 'appl', 'nc', 'nca', 'nsv', 'ng'].filter((k) => ![...walked].some((d) => d.split(':')[0] === k));
  ok(!unreached.length, 'the walk from home reaches every new screen: missing ' + unreached.join(',') + ' of ' + walked.size);
  const leak = [...walked].filter((d) => /^(srvs|srv|appl|sk|pp|nc|nca|nsv|ng|app)(:|$)/.test(d));
  let leaked = [];
  for (const d of leak) { const s = await menu.renderScreen(env, d); if (/hidden-host|secret-uuid|uuid@|example\.com:|nl1\.|de1\./.test(s.text + JSON.stringify(s.kb))) leaked.push(d); }
  ok(!leaked.length, 'no reachable screen shows a server address, id or bridge link: ' + leaked.join(' '));

  const logged = new Set((await env.DB.prepare('SELECT DISTINCT action FROM admin_audit').all()).results.map((r) => r.action));
  const missing = Object.keys(acts.ACTIONS).filter((x) => !logged.has(x) && !STAGE5_ACTIONS.includes(x));
  ok(!missing.length, 'every admin action, stage 4 included, has written an audit row: missing ' + missing.join(','));
  await acts.runAction(env, '12345', 'setting.set', { key: 'app_api_bases', val: '' });
  await acts.runAction(env, '12345', 'setting.set', { key: 'app_bridges', val: '' });
  await env.DB.prepare('DELETE FROM server_overrides').run();
}

section('admin panel stage 5: broadcast, stats, system, roles, security');
{
  const menu = await import('../src/telegram-menu.js');
  const acts = await import('../src/admin-actions.js');
  const tgm = await import('../src/telegram.js');
  let tapN = 0, msgN = 9000;
  const tapAs = (id, data) => tgWebhook({ callback_query: { id: 's5-' + (++tapN), data, message: { chat: { id }, message_id: 905, text: 'menu' } } });
  const tap = (data) => tapAs(12345, data);
  const sayAs = (id, text) => tgWebhook({ message: { chat: { id }, text, message_id: ++msgN } });
  const since = (n) => fakes.tg.calls.slice(n);
  const flat = (kb) => (kb || []).flat().map((x) => x.callback_data).filter(Boolean);
  const row = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
  const rows = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
  const exec = (sql, ...a) => env.DB.prepare(sql).bind(...a).run();
  const acks = (n) => since(n).filter((c) => c.method === 'answerCallbackQuery').map((c) => String(c.body.text || '')).join(' | ');
  const screensTo = (n, chat) => since(n).filter((c) => c.body && String(c.body.chat_id) === String(chat) && (c.method === 'editMessageText' || c.method === 'sendMessage'));
  const confirmOf = (n) => {
    const m = since(n).filter((c) => c.method === 'sendMessage' && c.body && c.body.reply_markup && flat(c.body.reply_markup.inline_keyboard).some((x) => x.startsWith('cf:'))).pop();
    return m ? { token: flat(m.body.reply_markup.inline_keyboard).find((x) => x.startsWith('cf:')).slice(3), text: m.body.text } : null;
  };
  const now = Math.floor(Date.now() / 1000);

  // ---- seed: 60 Telegram users (30 with an active plan, 10 expired, 20 with none) + 3 without Telegram ----
  await exec('UPDATE users SET tg_id = NULL'); // earlier sections' Telegram users stay out of the counts below
  await exec('UPDATE orders SET paid_at = paid_at - 400 * 86400, created_at = created_at - 400 * 86400');
  await exec('UPDATE users SET created_at = created_at - 400 * 86400');
  await exec('UPDATE sub_periods SET ended_at = ended_at - 400 * 86400 WHERE ended_at IS NOT NULL');
  const ids = { active: [], expired: [], none: [] };
  for (let i = 0; i < 63; i++) {
    const kind = i < 30 ? 'active' : i < 40 ? 'expired' : i < 60 ? 'none' : 'notg';
    const r = await exec(`INSERT INTO users (email, password_hash, referral_code, created_at, tg_id, is_active) VALUES (?, 'x', ?, ?, ?, 1)`,
      `bc${i}@example.com`, 'BC' + i, now - 3600, kind === 'notg' ? null : 700000 + i);
    const uid = r.meta.last_row_id;
    if (kind === 'active' || kind === 'expired') await exec('INSERT INTO subscriptions (user_id, pg_username, expires_at, data_limit_bytes, used_bytes) VALUES (?, ?, ?, 0, ?)', uid, 'bc' + i, kind === 'active' ? now + 86400 * 10 : now - 86400, kind === 'active' ? 1024 ** 3 : 0);
    if (ids[kind]) ids[kind].push(700000 + i);
  }
  ok(await acts.audienceCount(env, 'active') === 30 && await acts.audienceCount(env, 'expired') === 10 && await acts.audienceCount(env, 'none') === 20 && await acts.audienceCount(env, 'all') === 60,
    'audiences count only Telegram users: active 30, expired 10, no plan 20, all 60');

  // ---- broadcast: form -> preview to the admin only -> "are you sure?" with the count ----
  await exec('DELETE FROM broadcasts');
  let n = fakes.tg.calls.length;
  await tap('m:bc');
  ok(screensTo(n, 12345).some((c) => flat(c.body.reply_markup.inline_keyboard).includes('m:f:bcast')), 'broadcast screen has a "new message" button');
  await tap('m:f:bcast');
  await tap('m:fa:0:active');
  const evil = 'سلام! /grant evil@example.com 3 <b>bold</b> [x](https://t.me/x)';
  await sayAs(12345, evil);
  n = fakes.tg.calls.length;
  await tap('m:fok:bcast');
  const bc1 = await row('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1');
  const sends = since(n).filter((c) => c.method === 'sendMessage');
  const preview = sends.find((c) => c.body.text === evil);
  ok(bc1 && bc1.status === 'draft' && bc1.audience === 'active' && bc1.text === evil, 'the form saves a draft with the exact text');
  ok(preview && String(preview.body.chat_id) === '12345' && !preview.body.reply_markup && !preview.body.parse_mode, 'preview goes to the admin, as plain text with no buttons and no parse mode');
  ok(!sends.some((c) => String(c.body.chat_id) !== '12345'), 'nobody else gets anything before the confirmation');
  const c1 = confirmOf(n);
  ok(c1 && c1.text.includes('30 نفر'), 'the confirmation says how many people get it: ' + (c1 && c1.text));
  // a second broadcast cannot start while the first is sending
  await tap('cf:' + c1.token);
  ok((await row('SELECT status FROM broadcasts WHERE id = ?', bc1.id)).status === 'sending', 'confirmed -> sending');
  const d2 = await acts.runAction(env, '12345', 'broadcast.create', { audience: 'none', text: 'second' });
  const s2 = await acts.runAction(env, '12345', 'broadcast.start', { id: d2.targetId });
  ok(!s2.ok && (await row('SELECT status FROM broadcasts WHERE id = ?', d2.targetId)).status === 'draft', 'only one broadcast sends at a time');
  ok(!(await acts.runAction(env, '12345', 'broadcast.start', { id: bc1.id })).ok, 'a broadcast cannot be started twice');

  // ---- the cron sends 25 a run, resumes from the cursor, counts blocked people, finishes, tells the owner ----
  fakes.tg.failFor[ids.active[3]] = 403;
  n = fakes.tg.calls.length;
  await worker.scheduled({ cron: '* * * * *' }, env, ctx); await drain();
  ok(!since(n).some((c) => c.method === 'sendMessage' && c.body.text === evil), 'the every-minute cron does not send broadcasts');
  n = fakes.tg.calls.length;
  const t1 = await acts.broadcastTick(env, { now });
  const after1 = await row('SELECT * FROM broadcasts WHERE id = ?', bc1.id);
  ok(t1.sent === 24 && t1.blocked === 1 && after1.status === 'sending' && after1.sent === 24 && after1.blocked === 1, 'first run: 25 people, one blocked: ' + JSON.stringify(t1));
  ok(since(n).filter((c) => c.method === 'sendMessage').length === 25, 'a run makes at most 25 Telegram calls');
  // a run that is still going holds a lease: a second one at the same moment sends nothing
  await exec('UPDATE broadcasts SET updated_at = ? WHERE id = ?', now, bc1.id);
  ok((await acts.broadcastTick(env, { now })).busy === true, 'an overlapping run is skipped (lease)');
  await exec('UPDATE broadcasts SET updated_at = ? WHERE id = ?', now - 200, bc1.id);
  const t2 = await acts.broadcastTick(env, { now });
  const after2 = await row('SELECT * FROM broadcasts WHERE id = ?', bc1.id);
  ok(t2.sent === 5 && t2.done && after2.status === 'done' && after2.sent === 29 && after2.blocked === 1, 'second run resumes and finishes: ' + JSON.stringify(t2));
  const got = since(n).filter((c) => c.method === 'sendMessage' && c.body.text === evil).map((c) => Number(c.body.chat_id));
  ok(got.length === 30 && new Set(got).size === 30 && got.every((id) => ids.active.includes(id)), 'each active user got it exactly once, nobody else');
  ok(since(n).some((c) => c.method === 'sendMessage' && String(c.body.chat_id) === '12345' && /#\d+ تمام شد/.test(c.body.text)), 'the owner hears when it is done');
  ok(!since(n).some((c) => c.method === 'sendMessage' && c.body.text === evil && (c.body.reply_markup || c.body.parse_mode)), 'broadcast messages carry no buttons and no parse mode');
  delete fakes.tg.failFor[ids.active[3]];

  // 429: stop there, the same person is tried again on the next run
  await exec("UPDATE broadcasts SET status = 'sending', updated_at = ? WHERE id = ?", now - 200, d2.targetId);
  fakes.tg.failFor[ids.none[4]] = 429;
  const t3 = await acts.broadcastTick(env, { now });
  ok(t3.limited && t3.sent === 4 && (await row('SELECT status FROM broadcasts WHERE id = ?', d2.targetId)).status === 'sending', '429 stops the run without skipping anyone');
  delete fakes.tg.failFor[ids.none[4]];
  n = fakes.tg.calls.length;
  const t4 = await acts.broadcastTick(env, { now });
  const got2 = since(n).filter((c) => c.method === 'sendMessage' && c.body.text === 'second').map((c) => Number(c.body.chat_id));
  ok(t4.done && got2.length === 16 && got2[0] === ids.none[4] && (await row('SELECT sent FROM broadcasts WHERE id = ?', d2.targetId)).sent === 20, 'the next run starts with the rate-limited person and finishes');

  // stop, with progress on the screen, undo, then the 2-minute cron carries on
  const d3 = await acts.runAction(env, '12345', 'broadcast.create', { audience: 'all', text: 'third' });
  ok((await acts.runAction(env, '12345', 'broadcast.start', { id: d3.targetId })).ok, 'a new one starts once the others are done');
  await acts.broadcastTick(env, { now: Math.floor(Date.now() / 1000) });
  n = fakes.tg.calls.length;
  await tap(`m:bcv:${d3.targetId}`);
  const prog = screensTo(n, 12345).pop();
  ok(prog && prog.body.text.includes('25') && flat(prog.body.reply_markup.inline_keyboard).includes(`m:bcs:${d3.targetId}`), 'the progress screen shows the count and a stop button');
  await tap(`m:bcs:${d3.targetId}`);
  ok((await row('SELECT status FROM broadcasts WHERE id = ?', d3.targetId)).status === 'stopped', 'stop button stops it');
  ok((await acts.broadcastTick(env, { now: Math.floor(Date.now() / 1000) + 300 })) === null, 'a stopped broadcast sends nothing');
  const stopAudit = await row("SELECT id FROM admin_audit WHERE action = 'broadcast.stop' ORDER BY id DESC LIMIT 1");
  await tap(`m:undo:${stopAudit.id}`);
  ok((await row('SELECT status FROM broadcasts WHERE id = ?', d3.targetId)).status === 'sending', 'undo of a stop sends again');
  await exec('UPDATE broadcasts SET updated_at = ? WHERE id = ?', Math.floor(Date.now() / 1000) - 200, d3.targetId);
  await worker.scheduled({ cron: '*/2 * * * *' }, env, ctx); await drain();
  const b3 = await row('SELECT * FROM broadcasts WHERE id = ?', d3.targetId);
  ok(b3.sent === 50 && b3.status === 'sending', 'the 2-minute cron sends the next page: ' + b3.sent);
  await acts.runAction(env, '12345', 'broadcast.stop', { id: d3.targetId });

  // ---- stats on seeded data ----
  const [pa, pb] = await rows('SELECT id, name FROM plans WHERE is_active = 1 ORDER BY id LIMIT 2');
  const someUser = (await row("SELECT id FROM users WHERE email = 'bc0@example.com'")).id;
  const order = (kind, plan, amount, method, ago) => exec(`INSERT INTO orders (user_id, kind, plan_id, amount_toman, method, status, created_at, paid_at) VALUES (?, ?, ?, ?, ?, 'paid', ?, ?)`,
    someUser, kind, plan, amount, method, now - ago, now - ago);
  for (let i = 0; i < 3; i++) await order('plan', pa.id, 100000, 'card', 3600);
  await order('plan', pb.id, 50000, 'wallet', 7200);
  await order('plan', pb.id, 200000, 'coin', 3 * 86400);
  await order('plan', pb.id, 200000, 'coin', 3 * 86400);
  await order('topup', null, 70000, 'card', 20 * 86400);
  for (const ago of [3600, 7200, 10 * 86400]) await exec("INSERT INTO sub_periods (user_id, started_at, ended_at, end_reason) VALUES (?, ?, ?, 'renewed')", someUser, now - 40 * 86400, now - ago);
  const realPrepare = env.DB.prepare.bind(env.DB);
  let q = 0;
  env.DB.prepare = (sql) => { q++; return realPrepare(sql); };
  const s1 = await menu.renderScreen(env, 'st:1');
  const qStats = q;
  env.DB.prepare = realPrepare;
  const s7 = await menu.renderScreen(env, 'st:7');
  const s30 = await menu.renderScreen(env, 'st:30');
  const activeNow = (await row('SELECT COUNT(*) c, COALESCE(SUM(used_bytes), 0) u FROM subscriptions WHERE expires_at > ? OR expires_at IS NULL', now));
  ok(s1.text.includes('فروش: 4 سفارش · 300,000 تومان') && s1.text.includes('ثبت‌نام تازه: 63') && s1.text.includes('تمدید (خرید روی اشتراک باز): 2'), 'today: 4 sales, 300,000 received (wallet not counted), 63 sign-ups, 2 renewals');
  ok(s1.text.includes('کارت‌به‌کارت: 3 · 300,000') && s1.text.includes('کیف پول: 1 · 50,000'), 'today, per method');
  ok(s1.text.includes(`1. ${pa.name} — 3 فروش · 300,000`), 'today\'s top plan');
  ok(s1.text.includes(`اشتراک فعال الان: ${activeNow.c} · مصرف این دوره‌شان: ${(activeNow.u / 1024 ** 3).toFixed(activeNow.u >= 10 * 1024 ** 3 ? 1 : 2)} گیگ`), 'active subscriptions and their usage');
  ok(s7.text.includes('فروش: 6 سفارش · 700,000 تومان') && s7.text.includes('ارز دیجیتال: 2 · 400,000') && s7.text.includes(`1. ${pb.name} — 3 فروش · 450,000`), '7 days: 6 sales, 700,000, coin split, top plan');
  ok(s30.text.includes('فروش: 7 سفارش · 770,000 تومان') && s30.text.includes('تمدید (خرید روی اشتراک باز): 3'), '30 days: 7 sales, 770,000, 3 renewals');
  ok(qStats <= 6, 'stats use ≤6 D1 statements: ' + qStats);
  ok(flat(s1.kb).includes('m:st:7') && flat(s1.kb).includes('m:st:30'), 'period buttons');

  // ---- system: health, admins, settings never show a secret ----
  await exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('sms_key', 'supersecretkey123'), ('app_bridges', 'vless://secret-uuid@bridge.host:443#b'), ('panel_cred_9', 'sealed-cred')");
  fakes.tg.webhookInfo = { url: 'https://api.test/tg', pending_update_count: 2, last_error_date: now - 60, last_error_message: 'Wrong response from the webhook: https://api.test/tg 502 at api.test' };
  q = 0;
  env.DB.prepare = (sql) => { q++; return realPrepare(sql); };
  const hl = await menu.renderScreen(env, 'sys.hl');
  const qHl = q;
  env.DB.prepare = realPrepare;
  ok(hl.text.includes('✅ به همین ورکر وصل است') && hl.text.includes('پیام‌های در صف: 2') && hl.text.includes('آخرین خطا'), 'health: webhook state, queue and last error');
  ok(!/api\.test|https?:|\/tg/.test(hl.text) && qHl <= 6, 'health never shows the webhook address or secret, ≤6 statements: ' + qHl);
  ok(hl.text.includes('همگام‌سازی') && hl.text.includes('در صف تغییر روی پنل'), 'health: sync state');
  fakes.tg.webhookInfo = null;
  let leak = [];
  for (const d of ['sys', 'sys.hl', 'sys.adm', 'sys.log', 'set', 'sk:sms_key', 'sk:app_bridges', 'app', 'payset', 'bc', `bcv:${bc1.id}`]) {
    const s = await menu.renderScreen(env, d);
    if (/supersecretkey123|secret-uuid|bridge\.host|sealed-cred/.test(s.text + JSON.stringify(s.kb))) leak.push(d);
  }
  ok(!leak.length, 'no system or settings screen shows a secret: ' + leak.join(' '));
  n = fakes.tg.calls.length;
  await sayAs(12345, '/settings');
  ok(!/supersecretkey123|secret-uuid|bridge\.host/.test(JSON.stringify(since(n))), 'the old /settings answer masks the SMS key and bridges');
  const bk = await tgm.backupJson(env);
  ok(!/supersecretkey123|secret-uuid|bridge\.host|sealed-cred|panel_cred_|panel_err_/.test(bk), 'backup leaves out the SMS key, bridges, panel logins and panel errors');

  // ---- roles ----
  await tap('m:sys.adm');
  await tap('m:f:addadm');
  await sayAs(12345, '222222');
  await tap('m:fa:1:support');
  await tap('m:fok:addadm');
  ok((await row('SELECT role FROM admins WHERE tg_id = ?', '222222'))?.role === 'support', 'the owner adds a support admin from the buttons');
  ok((await acts.runAction(env, '12345', 'admin.add', { tgId: '333333', role: 'viewer' })).ok, 'and a viewer');
  ok(!(await acts.runAction(env, '12345', 'admin.add', { tgId: '12345', role: 'viewer' })).ok && !(await acts.runAction(env, '12345', 'admin.remove', { tgId: '12345' })).ok, 'the owner cannot be added or removed');
  await tap('m:adr:12345');
  ok((await row('SELECT COUNT(*) c FROM admins WHERE tg_id = ?', '12345')).c === 0, 'tapping remove on the owner id changes nothing');
  ok(!(await acts.runAction(env, '222222', 'admin.add', { tgId: '444444', role: 'support' })).ok && !(await row('SELECT 1 x FROM admins WHERE tg_id = ?', '444444')), 'a support admin cannot add admins (write layer)');

  // support: menu with only its buttons, approves a receipt, nothing else
  n = fakes.tg.calls.length;
  await sayAs(222222, '/start');
  const supHome = screensTo(n, 222222).filter((c) => c.body.reply_markup && c.body.reply_markup.inline_keyboard).pop();
  const supBtns = flat(supHome && supHome.body.reply_markup.inline_keyboard);
  ok(supBtns.includes('m:in') && supBtns.every((d) => menu.allowedTap('support', d)) && !supBtns.includes('m:usr') && !supBtns.includes('m:pl'), 'support gets a home with only its buttons: ' + supBtns.join(','));
  const stok = await signup('sup5@example.com', { device: 's5' });
  const supOrder = await call('POST', '/api/v1/orders', { token: stok, json: { plan_id: pa.id, method: 'card' } });
  await exec("UPDATE orders SET status = 'review' WHERE id = ?", supOrder.data.id);
  await tapAs(222222, `ap:${supOrder.data.id}`);
  ok((await row('SELECT status FROM orders WHERE id = ?', supOrder.data.id)).status === 'paid', 'support approves a receipt');
  ok((await row("SELECT admin_id FROM admin_audit WHERE action = 'order.approve' AND target_id = ? ORDER BY id DESC LIMIT 1", String(supOrder.data.id)))?.admin_id === '222222', 'the admin log records which admin approved it');
  const supUser = await row("SELECT id, wallet_balance FROM users WHERE email = 'sup5@example.com'");
  n = fakes.tg.calls.length;
  await tapAs(222222, `m:f:wadd:${supUser.id}`);
  await tapAs(222222, `m:uw:${supUser.id}`);
  ok(acks(n).includes('اجازه نداری') && !screensTo(n, 222222).length && !(await row('SELECT 1 x FROM bot_session WHERE admin_id = ?', '222222')), 'support cannot open the wallet or its form');
  await tgm.askConfirm(env, 222222, 'u_wallet', { userId: supUser.id, amount: 500000, note: 'x' }, 'test');
  const wTok = confirmOf(n);
  await tapAs(222222, 'cf:' + wTok.token);
  ok(!(await acts.runAction(env, '222222', 'user.wallet', { userId: supUser.id, amount: 500000, note: 'x' })).ok && (await row('SELECT wallet_balance FROM users WHERE id = ?', supUser.id)).wallet_balance === supUser.wallet_balance, 'support cannot credit a wallet, not even with a confirm token');
  const planBefore = await row('SELECT * FROM plans WHERE id = ?', pa.id);
  await tapAs(222222, `m:pt:${pa.id}`);
  await sayAs(222222, `/plan ${pa.id} price 1`);
  await tapAs(222222, `m:x:home|/plan ${pa.id} price 1`);
  const planAfter = await row('SELECT * FROM plans WHERE id = ?', pa.id);
  ok(planAfter.is_active === planBefore.is_active && planAfter.price_toman === planBefore.price_toman, 'support cannot edit a plan (button, typed command, command button)');

  // viewer: screens without write buttons, every write refused
  n = fakes.tg.calls.length;
  await tapAs(333333, `m:p:${pa.id}`);
  const vScr = screensTo(n, 333333).pop();
  const vBtns = flat(vScr && vScr.body.reply_markup.inline_keyboard);
  ok(vScr && vBtns.includes('m:home') && vBtns.every((d) => menu.allowedTap('viewer', d)) && !vBtns.some((d) => d.startsWith('m:pt:')), 'a viewer reads the plan card with no write buttons');
  n = fakes.tg.calls.length;
  for (const d of [`m:pt:${pa.id}`, 'm:f:newplan', `m:sk:card_number`, 'm:set', 'm:sys.adm', 'm:x:sys|/backup', `ap:${supOrder.data.id}`, `m:ss:card_unique:1`, 'm:ord']) await tapAs(333333, d);
  await sayAs(333333, '/set announcement hacked');
  ok(!screensTo(n, 333333).some((c) => c.method === 'editMessageText') && (await row("SELECT value FROM settings WHERE key = 'announcement'"))?.value !== 'hacked' && !since(n).some((c) => c.method === 'sendDocument'), 'a viewer cannot write, read settings or take a backup');
  ok((await row('SELECT is_active FROM plans WHERE id = ?', pa.id)).is_active === planBefore.is_active, 'viewer changed nothing');
  // a listed admin in a group is nobody
  n = fakes.tg.calls.length;
  await tgWebhook({ callback_query: { id: 'grp', data: 'm:home', from: { id: 333333 }, message: { chat: { id: 333333, type: 'group' }, message_id: 1, text: 'x' } } });
  ok(!since(n).some((c) => c.method !== 'answerCallbackQuery'), 'an admin id in a group chat gets nothing');

  // removed: nothing at all
  await tap('m:adr:222222');
  ok(!(await row('SELECT 1 x FROM admins WHERE tg_id = ?', '222222')), 'the owner removes the support admin');
  n = fakes.tg.calls.length;
  await tapAs(222222, 'm:home');
  await tapAs(222222, 'm:in');
  await sayAs(222222, '🏠 منو');
  ok(!since(n).some((c) => c.method === 'editMessageText' || (c.body && c.body.reply_markup && c.body.reply_markup.inline_keyboard)), 'a removed admin gets no screen and no buttons');
  ok(acks(n).includes('اجازه نداری'), 'a removed admin is told no');
  n = fakes.tg.calls.length;
  await tap('m:sys.adm');
  ok(screensTo(n, 12345).length > 0, 'the owner still has everything');
  const removedAudit = await row("SELECT id FROM admin_audit WHERE action = 'admin.remove' ORDER BY id DESC LIMIT 1");
  await tap(`m:undo:${removedAudit.id}`);
  ok((await row('SELECT role FROM admins WHERE tg_id = ?', '222222'))?.role === 'support', 'removing an admin can be undone');
  await acts.runAction(env, '12345', 'admin.remove', { tgId: '222222' });
  await acts.runAction(env, '12345', 'admin.remove', { tgId: '333333' });

  // ---- outside text never becomes a button ----
  ok(!tgm.buttonize('/grant evil@example.com 3').reply_markup.inline_keyboard.flat().some((x) => x.callback_data.startsWith('m:x:')), 'a /grant in bot text is never a one-tap grant');
  ok(!tgm.buttonize(tgm.untrusted('پیامک /set card_number 6037991234567893 و /drainpanel 1')).reply_markup, 'untrusted text gets no buttons at all');
  const sms = await import('../src/sms.js');
  n = fakes.tg.calls.length;
  await sms.handleBankSms(env, { sender: '/rollout 1 100', text: 'واریز: 7,777,771\n/drainpanel 1 /set card_number 6037991234567893' });
  const smsMsg = since(n).filter((c) => c.method === 'sendMessage').pop();
  ok(smsMsg && !/\/(drainpanel|set|rollout)/.test(smsMsg.body.text) && !flat(smsMsg.body.reply_markup && smsMsg.body.reply_markup.inline_keyboard).some((d) => /^m:(x|w|pp)/.test(d)), 'commands inside a bank SMS stay text');
  await exec("UPDATE users SET tg_id = 799999, tg_name = '/rollout 1 100' WHERE email = 'sup5@example.com'");
  n = fakes.tg.calls.length;
  await sayAs(12345, '/find sup5@example.com');
  const found = since(n).filter((c) => c.method === 'sendMessage').pop();
  ok(found && !flat(found.body.reply_markup.inline_keyboard).some((d) => d.includes('/rollout')), 'a Telegram name that looks like a command stays text on the user card');

  // every stage 5 action has written an audit row
  const logged = new Set((await rows('SELECT DISTINCT action FROM admin_audit')).map((r) => r.action));
  const missing = Object.keys(acts.ACTIONS).filter((x) => !logged.has(x));
  ok(!missing.length, 'every admin action, stage 5 included, has written an audit row: missing ' + missing.join(','));
  await exec("DELETE FROM settings WHERE key IN ('sms_key', 'app_bridges', 'panel_cred_9')");
}

section('the Free plan\'s 50 D1 queries: a long order list, cron with 200 users');
{
  const rows = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
  const lastQ = (label) => [...allInv].reverse().find((x) => x.label === label).q;
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const now = Math.floor(Date.now() / 1000);
  const plan = (await call('GET', '/api/v1/plans')).data[0];

  // 25 open card orders, a crypto quote that ran out, and a top-up that bought a plan
  const tok = await signup('many-orders@example.com');
  const uid = (await q('SELECT id FROM users WHERE email = ?', 'many-orders@example.com').first()).id;
  for (let i = 0; i < 25; i++) await q("INSERT INTO orders (user_id, kind, plan_id, amount_toman, method, status, created_at) VALUES (?, 'plan', ?, ?, 'card', 'pending', ?)", uid, plan.id, 100000 + i, now - i).run();
  const paidId = (await q("INSERT INTO orders (user_id, kind, plan_id, amount_toman, method, status, created_at) VALUES (?, 'plan', ?, 1, 'wallet', 'paid', ?)", uid, plan.id, now).run()).meta.last_row_id;
  await q("INSERT INTO orders (user_id, kind, amount_toman, method, status, created_at, activate_plan_id, result_order_id) VALUES (?, 'topup', 5, 'card', 'paid', ?, ?, ?)", uid, now, plan.id, paidId).run();
  const coinId = (await q("INSERT INTO orders (user_id, kind, plan_id, amount_toman, method, status, created_at, coin, coin_amount, coin_address, coin_expires_at) VALUES (?, 'plan', ?, 9, 'coin', 'pending', ?, 'xlm', '1.5', 'GADDR', ?)", uid, plan.id, now - 7200, now - 60).run()).meta.last_row_id;
  const list = await call('GET', '/api/v1/orders', { token: tok });
  ok(list.status === 200 && list.data.length === 28, `order list with 28 orders answers -> ${list.status} ${list.data && list.data.length}`);
  ok(lastQ('GET /api/v1/orders') <= 8, `the order list costs a handful of D1 queries, not one per order: ${lastQ('GET /api/v1/orders')}`);
  const cards = list.data.filter((o) => o.method === 'card' && o.status === 'pending');
  ok(cards.length === 25 && cards.every((o) => o.card && o.card.amount_rial === o.amount_toman * 10 && o.plan_name), 'every open card order still carries its card details and plan name');
  ok(list.data.find((o) => o.kind === 'topup').plan_activated === true && list.data.find((o) => o.kind === 'topup').activate_plan_name, 'a top-up shows the plan it bought');
  ok(list.data.find((o) => o.id === coinId).status === 'expired' && (await q('SELECT status FROM orders WHERE id = ?', coinId).first()).status === 'expired', 'a crypto quote that ran out is expired by the list');

  // 200 users on panel 1, made straight in D1 and on the fake panel; one of them ran out of days
  const seeded = [];
  for (let i = 0; i < 200; i++) {
    const id = 90000 + i, name = `cg_${id}_cap`;
    await q('INSERT INTO users (id, email, password_hash, referral_code, created_at) VALUES (?, ?, ?, ?, ?)', id, `cap${id}@x.io`, 'x', 'CAP' + id, now).run();
    const exp = i === 7 ? now - 10 : now + 30 * 86400;
    const per = (await q('INSERT INTO sub_periods (user_id, plan_id, started_at, expires_at, limit_bytes) VALUES (?, ?, ?, ?, ?)', id, plan.id, now, exp, 50 * GB).run()).meta.last_row_id;
    await q("INSERT INTO subscriptions (user_id, pg_username, plan_id, expires_at, data_limit_bytes, device_limit, period_id, state, baselined) VALUES (?, ?, ?, ?, ?, 2, ?, 'active', 1)", id, name, plan.id, exp, 50 * GB, per).run();
    await q('INSERT INTO panel_accounts (user_id, panel_id, remote_username, sub_path, created_at, desired_limit_bytes, applied_limit_bytes) VALUES (?, 1, ?, ?, ?, ?, ?)', id, name, PANEL + '/sub/cap' + id + '/', now, 50 * GB, 50 * GB).run();
    // last written 10 minutes ago, so the sweep writes the new reading now (sooner, small changes wait: LEDGER_EVERY)
    await q('INSERT INTO usage_counters (period_id, panel_id, last_remote_bytes, accounted_bytes, last_seen_at) VALUES (?, 1, 0, 0, ?)', per, now - 600).run();
    fakes.pg.users[name] = { id: 900000 + i, username: name, status: 'active', expire: exp, data_limit: 50 * GB, used_traffic: 5 * 1024 * 1024, token: 'cap' + id };
    seeded.push({ id, name, per });
  }
  const panelsBefore = await rows("SELECT id, state FROM panels WHERE id != 1 AND state != 'disabled'");
  await q("UPDATE panels SET state = 'disabled' WHERE id != 1").run(); // every run lands on panel 1
  await q('DELETE FROM sync_cursor').run();
  let writes = 0;
  const realBatch = env.DB.batch;
  env.DB.batch = (stmts) => { writes += stmts.length; return realBatch(stmts); };
  const putsBefore = fakes.pg.puts;
  const pages = Math.ceil(Object.keys(fakes.pg.users).length / 200);
  for (let i = 0; i < pages; i++) { await worker.scheduled({ cron: '* * * * *' }, env, ctx); await drain(); ok(lastQ('cron * * * * *') <= 50, `cron page ${i + 1} of ${pages} stays within 50 D1 queries: ${lastQ('cron * * * * *')}`); }
  const counted = await q('SELECT COUNT(*) c FROM usage_counters WHERE period_id IN (SELECT value FROM json_each(?)) AND accounted_bytes = ?', JSON.stringify(seeded.map((x) => x.per)), 5 * 1024 * 1024).first();
  ok(counted.c === 200, `every one of the 200 users is counted after one pass: ${counted.c}`);
  const late = await q('SELECT state, stop_reason FROM subscriptions WHERE user_id = ?', seeded[7].id).first();
  ok(late.state === 'stopped' && late.stop_reason === 'expired', 'the user out of days is stopped in the same run');
  ok(fakes.pg.users[seeded[7].name].status === 'disabled' && fakes.pg.puts > putsBefore, 'and switched off on the panel');
  // nothing changed on the panel: a second pass reads but writes only the cursor and the panel health
  await q("DELETE FROM sync_cursor WHERE job = 'usage'").run();
  writes = 0;
  for (let i = 0; i < pages; i++) { await worker.scheduled({ cron: '* * * * *' }, env, ctx); await drain(); }
  ok(writes <= 4 * pages + 2, `an idle pass writes almost nothing (was about 2 rows per user): ${writes} statements for ${pages} page(s)`);

  // VPN on all day: a few KB of background traffic move every counter every minute. The sweep spreads those
  // writes out (LEDGER_EVERY), but never for a big change, near the end of the data, a panel reset, a user who
  // just came online, or an account last written 10 minutes ago, and nothing is lost: the late write adds it all.
  const pass = async () => { await q("DELETE FROM sync_cursor WHERE job = 'usage'").run(); writes = 0; for (let i = 0; i < pages; i++) { await worker.scheduled({ cron: '* * * * *' }, env, ctx); await drain(); } return writes; };
  const acc = async (x) => (await q('SELECT accounted_bytes a FROM usage_counters WHERE period_id = ? AND panel_id = 1', x.per).first()).a;
  const KB = 1024, MB5 = 5 * 1024 * 1024;
  for (const x of seeded) fakes.pg.users[x.name].used_traffic += 20 * KB;
  ok((await pass()) <= 4 * pages + 2 && (await acc(seeded[50])) === MB5, `background traffic of 200 connected users is not written every minute: ${writes} statements`);
  const [big, near, old, back, reset] = seeded;
  fakes.pg.users[big.name].used_traffic += 300 * 1024 * 1024;
  await q('UPDATE subscriptions SET data_limit_bytes = ? WHERE user_id = ?', 100 * 1024 * 1024, near.id).run();
  await q('UPDATE usage_counters SET last_seen_at = last_seen_at - 600 WHERE period_id = ?', old.per).run();
  fakes.pg.users[back.name].online_at = new Date().toISOString();
  fakes.pg.users[reset.name].used_traffic = 1 * KB;
  for (const x of seeded) fakes.pg.users[x.name].used_traffic += 20 * KB;
  await pass();
  ok((await acc(big)) === MB5 + 40 * KB + 300 * 1024 * 1024, 'a big change is written at once, with the waiting KB: ' + (await acc(big)));
  ok((await acc(near)) === MB5 + 40 * KB, 'close to the end of the data every change is written: ' + (await acc(near)));
  ok((await acc(old)) === MB5 + 40 * KB, 'an account last written 10 minutes ago is written, nothing lost: ' + (await acc(old)));
  const backRow = await q('SELECT accounted_bytes a, online_at o FROM usage_counters WHERE period_id = ? AND panel_id = 1', back.per).first();
  ok(backRow.a === MB5 + 40 * KB && backRow.o > now - 120, 'a user coming online is written at once (the admin sees "online now")');
  ok((await acc(reset)) === MB5 + 21 * KB, 'a panel-side reset is written at once and counted on top: ' + (await acc(reset)));
  ok((await acc(seeded[50])) === MB5, 'the others still wait');
  await q('UPDATE usage_counters SET last_seen_at = last_seen_at - 600 WHERE period_id IN (SELECT value FROM json_each(?))', JSON.stringify(seeded.map((x) => x.per))).run();
  await pass();
  ok((await acc(seeded[50])) === MB5 + 40 * KB, 'ten minutes later the waiting traffic is all counted: ' + (await acc(seeded[50])));
  env.DB.batch = realBatch;
  for (const p of panelsBefore) await q('UPDATE panels SET state = ? WHERE id = ?', p.state, p.id).run();
  for (const x of seeded) delete fakes.pg.users[x.name];
  for (const t of ['usage_counters WHERE period_id IN (SELECT id FROM sub_periods WHERE user_id >= 90000)', 'panel_accounts WHERE user_id >= 90000', 'subscriptions WHERE user_id >= 90000', 'sub_periods WHERE user_id >= 90000', 'users WHERE id >= 90000']) await env.DB.exec('DELETE FROM ' + t);
}

section('phases 1-5 fixes: open-order cap, stale quote, bad token, cancel race, limits, email, http panels, SMS key, slow panel');
{
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const set = (k, v) => q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v).run();
  const plan = (await call('GET', '/api/v1/plans')).data.find((p) => p.price_toman > 0);
  await set('card_number', '6037991234567893');
  // S1: one account can keep at most 3 unpaid card orders; fresh ones are not closed for it
  const t1 = await signup('cap1@example.com', { device: 'cap1' });
  const made = [];
  for (let i = 0; i < 4; i++) made.push(await call('POST', '/api/v1/orders', { token: t1, json: { plan_id: plan.id, method: 'card' } }));
  ok(made.slice(0, 3).every((r) => r.status === 201) && made[3].status === 429 && made[3].data.detail.code === 'too_many_open_orders',
    'fourth fresh unpaid card order -> 429 too_many_open_orders: ' + made.map((r) => r.status).join(','));
  // an order idle for more than 30 minutes with no receipt is closed to make room
  await q('UPDATE orders SET created_at = created_at - 3600 WHERE id = ?', made[0].data.id).run();
  const r5 = await call('POST', '/api/v1/orders', { token: t1, json: { plan_id: plan.id, method: 'card' } });
  ok(r5.status === 201 && (await q('SELECT status FROM orders WHERE id = ?', made[0].data.id).first()).status === 'cancelled', 'an idle old order is closed and the new one is made');
  // an order waiting on the admin (receipt sent) is never closed by this
  await q("UPDATE orders SET status = 'review', created_at = created_at - 3600 WHERE id = ?", made[1].data.id).run();
  await q('UPDATE orders SET created_at = created_at - 3600 WHERE id IN (?, ?)', made[2].data.id, r5.data.id).run();
  const r6 = await call('POST', '/api/v1/orders', { token: t1, json: { plan_id: plan.id, method: 'card' } });
  ok(r6.status === 201 && (await q('SELECT status FROM orders WHERE id = ?', made[1].data.id).first()).status === 'review', 'an order in review stays open');
  const amounts = await q("SELECT amount_toman a, COUNT(*) c FROM orders WHERE method = 'card' AND status IN ('pending','review') GROUP BY amount_toman HAVING c > 1").all();
  ok(!amounts.results.length, 'no two open card orders share an amount');
  // S9: new orders are rate-limited per account
  const limiter = (n) => { const seen = new Map(); return { limit: async ({ key }) => { const c = (seen.get(key) || 0) + 1; seen.set(key, c); return { success: c <= n }; } }; };
  env.RL_IP = limiter(0);
  const lim = await call('POST', '/api/v1/orders', { token: t1, json: { plan_id: plan.id, method: 'card' } });
  const limRef = await call('POST', '/api/v1/auth/refresh', { json: { refresh_token: 'x' } });
  ok(lim.status === 429 && limRef.status === 429, 'orders and token refresh are rate-limited: ' + lim.status + ',' + limRef.status);
  delete env.RL_IP;
  // S12: email and @username of one account share one login limit
  const tg = await q("UPDATE users SET tg_username = 'capone' WHERE email = 'cap1@example.com'").run();
  env.RL_LOGIN = limiter(5);
  const tries = [];
  for (let i = 0; i < 3; i++) tries.push((await call('POST', '/api/v1/auth/login', { json: { login: 'cap1@example.com', password: 'wrong' + i } })).status);
  for (let i = 0; i < 3; i++) tries.push((await call('POST', '/api/v1/auth/login', { json: { login: '@capone', password: 'wrong' + i } })).status);
  ok(tg.meta.changes === 1 && tries[5] === 429, 'sixth wrong password for one account via two names -> 429: ' + tries.join(','));
  delete env.RL_LOGIN;

  // C4: cancel after the order was paid elsewhere does not undo it
  const t2 = await signup('cancel@example.com', { device: 'cancel1' });
  const o2 = await call('POST', '/api/v1/orders', { token: t2, json: { plan_id: plan.id, method: 'card' } });
  await q("UPDATE orders SET status = 'paid' WHERE id = ?", o2.data.id).run();
  const c2 = await call('POST', `/api/v1/orders/${o2.data.id}/cancel`, { token: t2 });
  ok(c2.status === 400 && (await q('SELECT status FROM orders WHERE id = ?', o2.data.id).first()).status === 'paid', 'cancel of a paid order is refused and changes nothing');

  // S3: a quote that ran out long ago is matched but not activated by itself
  const XLM = 'G' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 55);
  await set('wallet_xlm', XLM); await set('wallet_xlm_memo', ''); await set('usd_rate_toman', '100000'); await set('coin_auto', 'auto');
  const t3 = await signup('stale@example.com', { device: 'stale1' });
  const o3 = await call('POST', '/api/v1/orders', { token: t3, json: { plan_id: plan.id, method: 'coin', coin: 'xlm' } });
  ok(o3.status === 201, 'coin order made: ' + o3.status);
  await q('UPDATE orders SET coin_expires_at = ? WHERE id = ?', Math.floor(Date.now() / 1000) - 3 * 3600, o3.data.id).run();
  globalThis.__chain = globalThis.__chain || { xlm: [], xrp: [], trx: [], ton: [], algo: [] };
  globalThis.__chain.xlm.push({ type: 'payment', to: XLM, asset_type: 'native', amount: o3.data.coin.amount, transaction_hash: 'c'.repeat(64), transaction_successful: true, created_at: new Date().toISOString(), transaction: { memo: null } });
  const tgBefore = fakes.tg.messages.length;
  globalThis.__cgChk = {};
  const g3 = await call('GET', '/api/v1/orders/' + o3.data.id, { token: t3 });
  ok(g3.data.status === 'review', 'stale quote paid with the old amount -> review, not paid: ' + g3.data.status);
  ok(fakes.tg.messages.slice(tgBefore).some((m) => (m.text || '').includes('منقضی شده بود')), 'the admin is told the price ran out');
  // a payment within the grace time is still activated by itself
  const o4 = await call('POST', '/api/v1/orders', { token: t3, json: { plan_id: plan.id, method: 'coin', coin: 'xlm' } });
  await q('UPDATE orders SET coin_expires_at = ? WHERE id = ?', Math.floor(Date.now() / 1000) - 10 * 60, o4.data.id).run();
  globalThis.__chain.xlm.push({ type: 'payment', to: XLM, asset_type: 'native', amount: o4.data.coin.amount, transaction_hash: 'd'.repeat(64), transaction_successful: true, created_at: new Date().toISOString(), transaction: { memo: null } });
  globalThis.__cgChk = {};
  const g4 = await call('GET', '/api/v1/orders/' + o4.data.id, { token: t3 });
  ok(g4.data.status === 'paid', 'paid 10 minutes after the quote ran out -> still activated: ' + g4.data.status);
  globalThis.__chain.xlm.length = 0;

  // S4: a token with a broken signature part is a 401, not a 500
  ok((await call('GET', '/api/v1/me', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.%%%' })).status === 401, 'malformed token -> 401');

  // S13: a new address can't carry a bot command
  const bad = await call('POST', '/api/v1/auth/register', { json: { email: '/start@x.io', password: 'password123' } });
  ok(bad.status === 422, 'email with "/" refused at sign-up: ' + bad.status);

  // S14: a panel login over plain http is refused
  const { parseCred } = await import('../src/panels.js');
  ok(parseCred('http://p.example.com admin pw').error === 'http' && parseCred('https://p.example.com admin pw').cred, 'panel address must be https');

  // S5: the SMS key may come in a header (kept out of request logs); a wrong key is still 404
  await set('sms_key', 'k'.repeat(32));
  const sh = await call('POST', '/sms', { headers: { 'x-sms-key': 'k'.repeat(32) }, json: { from: 'x', text: 'hello' } });
  const sw = await call('POST', '/sms', { headers: { 'x-sms-key': 'wrong' }, json: { from: 'x', text: 'hello' } });
  ok(sh.status === 200 && sw.status === 404, 'SMS key in the header works, a wrong one is refused: ' + sh.status + ',' + sw.status);

  // AD7: deep health tells an outside monitor whether the cron runs
  await worker.scheduled({ cron: '* * * * *' }, env, ctx); await drain();
  const hd = await call('GET', '/health?deep=1');
  ok(hd.status === 200 && hd.data.ok === true && hd.data.cron_age_sec < 600, 'deep health ok after a cron run: ' + JSON.stringify(hd.data));
  await q('UPDATE sync_cursor SET run_at = run_at - 3600').run();
  const hs = await call('GET', '/health?deep=1');
  ok(hs.status === 503 && hs.data.ok === false, 'deep health 503 when the cron has been quiet: ' + JSON.stringify(hs.data));
  ok((await call('GET', '/health')).status === 200, 'plain health unchanged');

  // C10: the in-memory throttles stay bounded
  const { throttled } = await import('../src/util.js');
  for (let i = 0; i < 2500; i++) throttled('__testBag', i, 60000);
  ok(globalThis.__testBag.size <= 2000, 'throttle memory is bounded: ' + globalThis.__testBag.size);

  // S8: the free trial only for a verified Telegram account (Ali's choice), switched by a bot button
  await set('trial_needs_telegram', '1');
  const trialPlanX = (await q('SELECT * FROM plans WHERE trial_days > 0 AND is_active = 1 AND archived = 0 LIMIT 1').first());
  const te = await signup('trialmail@example.com', { device: 'tm1' });
  const r8 = await call('POST', '/api/v1/trial', { token: te, json: { plan_id: trialPlanX.id }, headers: { 'x-device-id': 'tm1' } });
  ok(r8.status === 403 && r8.data.detail.code === 'trial_needs_telegram', 'email-only account gets no trial: ' + r8.status);
  await q("UPDATE users SET tg_id = 778899001 WHERE email = 'trialmail@example.com'").run();
  const r8b = await call('POST', '/api/v1/trial', { token: te, json: { plan_id: trialPlanX.id }, headers: { 'x-device-id': 'tm1' } });
  ok(r8b.status === 200, 'the same account with a verified Telegram gets it: ' + r8b.status);
  await tgWebhook({ callback_query: { id: 'x', data: 'm:ss:trial_needs_telegram:0', from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' }, message_id: 1 } } });
  ok((await q("SELECT value FROM settings WHERE key = 'trial_needs_telegram'").first()).value === '0', 'the bot button switches it off');
  await set('trial_needs_telegram', '0');

  // AD2: a panel that never answers holds the app for at most the user-path deadline, not 15 s
  const tp = await signup('slow@example.com', { device: 'slow1' });
  await admin(`/grant slow@example.com ${tenGb.id}`);
  const keep = setInterval(() => {}, 500); // Node's AbortSignal.timeout timer alone doesn't keep the process alive
  fakes.pg.hang = true;
  let t0 = Date.now();
  const sv = await call('GET', '/api/v1/vpn/servers', { token: tp, headers: { 'x-device-id': 'slow1' } });
  const svMs = Date.now() - t0;
  t0 = Date.now();
  const me = await call('GET', '/api/v1/me', { token: tp });
  const meMs = Date.now() - t0;
  await drain(); // the live reading that missed the answer finishes after it (waitUntil)
  // this isolate saw the panel fail a moment ago: the next server list waits the short deadline only
  t0 = Date.now();
  await call('GET', '/api/v1/vpn/servers', { token: tp, headers: { 'x-device-id': 'slow1' } });
  const againMs = Date.now() - t0;
  await drain();
  ok(againMs < 2500, `right after a failure the same panel holds the next server list for ${againMs} ms only`);
  fakes.pg.hang = false;
  ok(svMs < 7000 && [200, 503].includes(sv.status), `server list with a hung panel answers in ${svMs} ms (${sv.status})`);
  ok(meMs < 2500 && me.status === 200 && me.data.subscription && me.data.subscription.live === false,
    `/me with a hung panel answers from the stored numbers within the live budget: ${meMs} ms (${me.status})`);
  // the sync job has seen the panel fail 3 times: its configs get only a short chance on the user path
  await q('UPDATE panels SET fail_streak = 3 WHERE id = 1').run();
  fakes.pg.hang = true;
  t0 = Date.now();
  await call('GET', '/api/v1/vpn/servers', { token: tp, headers: { 'x-device-id': 'slow1' } });
  const knownMs = Date.now() - t0;
  await drain();
  fakes.pg.hang = false;
  await q('UPDATE panels SET fail_streak = 0 WHERE id = 1').run();
  clearInterval(keep);
  ok(knownMs < 2500, `a panel known to be down holds the server list for ${knownMs} ms only`);
  const meOk = await call('GET', '/api/v1/me', { token: tp });
  ok(meOk.data.subscription.live === true, 'with the panel back, /me reads it live again');
  ok(!(globalThis.__cgSlowPanels && globalThis.__cgSlowPanels.get(1)), 'an answer clears the slow mark');

  // the cron's expiry check uses an index, not a scan of every subscription (D1 bills rows read)
  const expPlan = (await q("EXPLAIN QUERY PLAN SELECT user_id FROM subscriptions WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= ? LIMIT 50", 1).all()).results.map((r) => r.detail).join(' ');
  ok(/idx_subscriptions_expiry/.test(expPlan), 'expiry check uses idx_subscriptions_expiry: ' + expPlan);
  // a look for missing panel accounts that finds none is not repeated by the same isolate for 10 minutes
  globalThis.__keepIsolate = true; globalThis.__cgNoMissingUntil = 0;
  const r1 = await runSyncRaw(env), r2 = await runSyncRaw(env);
  globalThis.__keepIsolate = false; globalThis.__cgNoMissingUntil = 0;
  ok(!r1.createSkipped && r1.created === 0 && r2.createSkipped === true, 'an empty look for missing accounts is skipped for a while: ' + JSON.stringify([r1, r2]));
}

section('Mini App stage 0: initData check, probe page, report to the admin, bot buttons');
{
  const { verifyInitData } = await import('../src/auth.js');
  const { createHmac } = await import('node:crypto');
  // initData exactly as a Telegram client builds it, signed with the bot token (independent HMAC from node:crypto)
  const sign = (fields, token = env.TELEGRAM_BOT_TOKEN) => {
    const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    const hash = createHmac('sha256', secret).update(check).digest('hex');
    return new URLSearchParams({ ...fields, hash }).toString();
  };
  const now = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({ id: 777001, first_name: 'Sara/grant', username: 'sara_t' });
  const good = sign({ query_id: 'AAH', user, auth_date: String(now - 30) });
  const v = await verifyInitData(env.TELEGRAM_BOT_TOKEN, good, 3600, now);
  ok(v && v.user.id === 777001 && v.authDate === now - 30, 'valid initData is accepted and gives the Telegram user');
  ok((await verifyInitData('other:token', good, 3600, now)) === null, 'initData signed for another bot is refused');
  ok((await verifyInitData(env.TELEGRAM_BOT_TOKEN, good.replace('sara_t', 'sara_x'), 3600, now)) === null, 'a changed field is refused');
  ok((await verifyInitData(env.TELEGRAM_BOT_TOKEN, good + '&extra=1', 3600, now)) === null, 'an added field is refused');
  ok((await verifyInitData(env.TELEGRAM_BOT_TOKEN, sign({ user, auth_date: String(now - 7200) }), 3600, now)) === null, 'old initData is refused');
  ok((await verifyInitData(env.TELEGRAM_BOT_TOKEN, sign({ user, auth_date: String(now + 3600) }), 3600, now)) === null, 'initData from the future is refused');
  ok((await verifyInitData(env.TELEGRAM_BOT_TOKEN, sign({ auth_date: String(now) }), 3600, now)) === null, 'initData without a user is refused');
  ok((await verifyInitData(env.TELEGRAM_BOT_TOKEN, 'user=1&auth_date=1&hash=zz', 3600, now)) === null, 'a malformed hash is refused');
  ok((await verifyInitData(env.TELEGRAM_BOT_TOKEN, '', 3600, now)) === null && (await verifyInitData(env.TELEGRAM_BOT_TOKEN, { a: 1 }, 3600, now)) === null, 'empty or non-text initData is refused');
  ok((await verifyInitData('', good, 3600, now)) === null, 'no bot token = nothing is accepted');

  await botSet('app_api_bases', 'https://b.example.org');
  const page = await call('GET', '/mini/probe');
  const html = await page.res.text();
  const csp = page.res.headers.get('content-security-policy') || '';
  ok(page.status === 200 && /text\/html/.test(page.res.headers.get('content-type')) && /Connection test/.test(html), 'the probe page is served as HTML');
  ok(/default-src 'none'/.test(csp) && /frame-ancestors/.test(csp) && page.res.headers.get('cache-control') === 'no-store', 'the probe page has a strict CSP and is not cached');
  ok(html.includes('"others":["https://b.example.org"]') && !html.includes('"https://api.test"'), 'the page lists the other Worker addresses, not its own');
  ok(!/#[0-9a-f]{6}/i.test(html.replace(/#(E7F1FA|FFFFFF|F2F6FB|14284B|2F89F5|16181D|8B93A7|1E74DB|1F9D55|E5484D|04080F|060D18|081120|2C3E5D|F2F3F5|9CA2B0|4E9BF6)\b/gi, '')), 'the page uses only Pleat palette colours');
  ok(!/gold|cloud/i.test(html), 'no gold or clouds on the page');

  const rep = (j, cf) => call('POST', '/api/v1/mini/probe', { json: j, cf });
  ok((await rep({ steps: {} })).status === 401, 'a report without initData is refused');
  ok((await rep({ init_data: good.replace('sara_t', 'x') })).status === 401, 'a report with forged initData is refused');
  let n = fakes.tg.calls.length;
  const r = await rep({ init_data: good, origin: 'https://api.test', platform: 'android', steps: { page: { ok: true, ms: 120 }, telegram: { ok: true }, api: { ok: true, ms: 340 }, sdk: { ok: false } },
    others: [{ base: 'https://b.example.org', ok: false, ms: 10000 }, { base: 'https://evil.example', ok: true, ms: 1 }] }, { asn: 44244, country: 'IR' });
  await drain();
  const sent = fakes.tg.calls.slice(n).filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === '12345').map((c) => String(c.body.text));
  const t = sent.join('\n');
  ok(r.status === 200 && sent.length === 1 && /نتیجه‌ی تست Mini App/.test(t), 'a valid report reaches the admin chat once');
  ok(/777001/.test(t) && /@sara_t/.test(t) && /api\.test/.test(t) && /android/.test(t), 'the report names the user, the address and the platform');
  ok(/API همین دامنه: ✅ 340ms/.test(t) && /telegram\.org: ❌/.test(t) && /❌ b\.example\.org/.test(t), 'the report shows each step');
  ok(!/evil\.example/.test(t), 'addresses that are not the Worker\'s are dropped from the report');
  ok(!/\/grant/.test(t), 'a "/" in the Telegram name cannot become a bot command');

  const tap = (data) => tgWebhook({ callback_query: { id: 'mtp-' + data, data, message: { chat: { id: 12345 }, message_id: 991, text: 'menu' } } });
  n = fakes.tg.calls.length;
  await tap('m:app');
  const appScr = fakes.tg.calls.slice(n).filter((c) => c.method === 'editMessageText').pop();
  ok(appScr && appScr.body.reply_markup.inline_keyboard.flat().some((x) => x.callback_data === 'm:mtp'), 'the Pleat app screen has the Mini App test button');
  n = fakes.tg.calls.length;
  await tap('m:mtp');
  const scr = fakes.tg.calls.slice(n).filter((c) => c.method === 'editMessageText').pop();
  const urls = scr ? scr.body.reply_markup.inline_keyboard.flat().filter((x) => x.web_app).map((x) => x.web_app.url) : [];
  ok(urls.join(' ') === 'https://api.test/mini/probe https://b.example.org/mini/probe', 'one web_app button per Worker address: ' + urls.join(' '));
  ok(/VPN/.test(scr?.body.text || '') && scr.body.reply_markup.inline_keyboard.flat().some((x) => x.callback_data === 'm:home'), 'the test screen explains the steps and ends with home');
  await botSet('app_api_bases', '');
}

section('Mini App stage 1: sign in with initData, one-tap account, Mini App tokens, bot buttons');
{
  const { createHmac } = await import('node:crypto');
  const sign = (fields) => {
    const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest();
    return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
  };
  const now = () => String(Math.floor(Date.now() / 1000));
  const initFor = (id, extra = {}, user = {}) => sign({ query_id: 'AA', user: JSON.stringify({ id, first_name: 'Nima', username: 'Nima_Web', ...user }), auth_date: now(), ...extra });
  const row = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first());

  ok((await call('POST', '/api/v1/auth/tg/webapp', { json: {} })).status === 401, 'sign-in without initData is refused');
  const forged = initFor(880001).replace('Nima', 'Evil');
  ok((await call('POST', '/api/v1/auth/tg/webapp', { json: { init_data: forged } })).status === 401, 'forged initData is refused');
  const old = sign({ user: JSON.stringify({ id: 880001 }), auth_date: String(Math.floor(Date.now() / 1000) - 3700) });
  ok((await call('POST', '/api/v1/auth/tg/webapp', { json: { init_data: old } })).status === 401, 'initData older than an hour is refused');

  // a new Telegram user: asked to make an account, nothing written yet
  const first1 = await call('POST', '/api/v1/auth/tg/webapp', { json: { init_data: initFor(880001) } });
  ok(first1.status === 200 && first1.data.need_account === true && first1.data.name === 'Nima' && !first1.data.access_token, 'a new Telegram user is asked to create an account');
  ok(!(await row('SELECT id FROM users WHERE tg_id = 880001')), 'nothing is written before they tap Create account');

  // invite code from the start link (startapp=ref_<code>)
  const inviter = await signup('inviter-mini@example.com');
  const refCode = (await call('GET', '/api/v1/me', { token: inviter })).data.referral_code;
  const reg = await call('POST', '/api/v1/auth/tg/webapp/register', { json: { init_data: initFor(880001, { start_param: 'ref_' + refCode }) } });
  ok(reg.status === 200 && reg.data.access_token && !reg.data.refresh_token, 'Create account gives an access token only (no refresh token in a web view)');
  const u = await row('SELECT * FROM users WHERE tg_id = 880001');
  const inv = await row('SELECT id FROM users WHERE referral_code = ?', refCode);
  ok(u && u.tg_username === 'nima_web' && u.tg_name === 'Nima' && u.referred_by_id === inv.id, 'the account has the Telegram id, username, name and the inviter');
  ok((await row('SELECT COUNT(*) c FROM devices WHERE user_id = ?', u.id)).c === 0, 'the Mini App is not counted as a VPN device');
  const pw = await call('POST', '/api/v1/auth/login', { json: { login: '@nima_web', password: 'password123' } });
  ok(pw.status === 401, 'the account has no password that could match');
  const again = await call('POST', '/api/v1/auth/tg/webapp/register', { json: { init_data: initFor(880001) } });
  ok(again.status === 200 && again.data.access_token && (await row('SELECT COUNT(*) c FROM users WHERE tg_id = 880001')).c === 1, 'tapping Create account twice signs in, no second account');

  // sign-in later: same account; a changed username follows
  const li = await call('POST', '/api/v1/auth/tg/webapp', { json: { init_data: initFor(880001, {}, { username: 'nima2' }) } });
  ok(li.status === 200 && li.data.access_token, 'an existing Telegram user signs in');
  ok((await row('SELECT tg_username FROM users WHERE tg_id = 880001')).tg_username === 'nima2', 'a new @username is saved');
  const tok = li.data.access_token;
  const meR = await call('GET', '/api/v1/me', { token: tok });
  ok(meR.status === 200 && meR.data.telegram && meR.data.telegram.id === '880001', '/me works with a Mini App token');

  // an account made in Pleat with Telegram signs in to the Mini App too, and never sees the panel address
  const plan = await row('SELECT id FROM plans ORDER BY id LIMIT 1');
  await env.DB.prepare('UPDATE users SET wallet_balance = 0 WHERE id = ?').bind(u.id).run();
  for (const path of ['/vpn', '/vpn/servers', '/vpn/sub', '/devices']) {
    const r = await call('GET', '/api/v1' + path, { token: tok });
    ok(r.status === 403 && r.data.detail.code === 'use_pleat', `a Mini App token cannot read ${path}`);
  }
  ok(plan && !('sub_url' in (meR.data.subscription || {})), 'no subscription address in the Mini App');
  ok((await call('GET', '/api/v1/wallet', { token: tok })).status === 200, 'the wallet is readable from the Mini App');

  // a disabled account cannot sign in
  await env.DB.prepare('UPDATE users SET is_active = 0 WHERE tg_id = 880001').run();
  ok((await call('POST', '/api/v1/auth/tg/webapp', { json: { init_data: initFor(880001) } })).status === 403, 'a disabled account cannot sign in');
  await env.DB.prepare('UPDATE users SET is_active = 1 WHERE tg_id = 880001').run();

  // the bot: anyone who opens it gets the Open Pleat button; the menu button points at the Mini App
  let n = fakes.tg.calls.length;
  await tgWebhook({ message: { chat: { id: 880001, type: 'private' }, from: { id: 880001 }, text: '/start' } });
  const hi = fakes.tg.calls.slice(n).find((c) => c.method === 'sendMessage' && String(c.body.chat_id) === '880001');
  const wa = hi && hi.body.reply_markup ? hi.body.reply_markup.inline_keyboard.flat().find((x) => x.web_app) : null;
  ok(wa && wa.web_app.url === 'https://api.test/app/' && /Open Pleat/.test(hi.body.text), '/start shows an Open Pleat button for the Mini App');
  await env.DB.prepare("DELETE FROM settings WHERE key = 'tg_webhook_sig'").run();
  n = fakes.tg.calls.length;
  const { ensureWebhook } = await import('../src/telegram.js');
  await ensureWebhook(env);
  const mb = fakes.tg.calls.slice(n).find((c) => c.method === 'setChatMenuButton');
  ok(mb && mb.body.menu_button.type === 'web_app' && mb.body.menu_button.web_app.url === 'https://api.test/app/', 'the bot menu button opens the Mini App');
}

section('Mini App admin panel: admin sign-in, roles, reads, actions with confirm and undo, per-panel view');
{
  const { createHmac } = await import('node:crypto');
  const sign = (fields) => {
    const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest();
    return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
  };
  const initFor = (id, name = 'Ali') => sign({ user: JSON.stringify({ id, first_name: name }), auth_date: String(Math.floor(Date.now() / 1000)) });
  const row = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first());
  const A = (method, path, token, json) => call(method, '/api/v1/admin' + path, { token, json });

  // who gets in
  ok((await A('POST', '/auth', null, { init_data: initFor(777555) })).status === 403, 'a non-admin Telegram user cannot open the admin panel');
  ok((await A('POST', '/auth', null, { init_data: initFor(12345).replace('Ali', 'X') })).status === 401, 'forged initData cannot open the admin panel');
  const au = await A('POST', '/auth', null, { init_data: initFor(12345) });
  ok(au.status === 200 && au.data.role === 'owner' && au.data.access_token, 'the owner (TELEGRAM_CHAT_ID) signs in as owner');
  const T = au.data.access_token;
  ok((await A('GET', '/dashboard')).status === 401, 'admin routes need the admin token');
  const userTok = await signup('admin-mini-target@example.com');
  ok((await A('GET', '/dashboard', userTok)).status === 401, 'an app user token is not an admin token');
  const wl = await call('POST', '/api/v1/auth/tg/webapp', { json: { init_data: initFor(12345) } });
  ok(wl.status === 200 && wl.data.admin === 'owner', 'the Mini App sign-in tells the page this person is an admin');

  // reads
  const dash = await A('GET', '/dashboard', T);
  ok(dash.status === 200 && dash.data.users >= 1 && 'review' in dash.data && 'sales_week' in dash.data, 'dashboard numbers');
  const target = await row("SELECT id FROM users WHERE email = 'admin-mini-target@example.com'");
  const list = await A('GET', '/users?q=%23' + target.id, T);
  ok(list.status === 200 && list.data.users.length === 1 && list.data.users[0].id === target.id, 'find a user by #id');
  const byMail = await A('GET', '/users?q=admin-mini-tar', T);
  ok(byMail.data.users.some((u) => u.id === target.id), 'find a user by part of the email');
  ok((await A('GET', '/users?filter=nope', T)).data.filter === 'all', 'an unknown filter falls back to all');

  // actions: unknown, money without confirm, money with confirm, reversible with undo
  ok((await A('POST', '/action', T, { name: 'nope', args: {} })).status === 404, 'an unknown action is refused');
  ok((await A('POST', '/action', T, { name: 'constructor', args: {} })).status === 404, 'object built-ins are not actions');
  const plan = await row('SELECT id FROM plans WHERE is_active = 1 ORDER BY id LIMIT 1');
  const noConfirm = await A('POST', '/action', T, { name: 'user.grant', args: { userId: target.id, planId: plan.id } });
  ok(noConfirm.status === 409 && !(await row('SELECT id FROM subscriptions WHERE user_id = ?', target.id)), 'a money action without confirm does nothing');
  const g = await A('POST', '/action', T, { name: 'user.grant', args: { userId: target.id, planId: plan.id }, confirm: true });
  ok(g.status === 200 && g.data.ok === true && !!(await row('SELECT id FROM subscriptions WHERE user_id = ?', target.id)), 'giving a plan works after confirm: ' + JSON.stringify(g.data));
  ok(!!(await row("SELECT id FROM admin_audit WHERE action = 'user.grant' AND admin_id = '12345' AND target_id = ?", String(target.id))), 'the change is in the admin log under the admin');
  const before = (await row('SELECT expires_at FROM subscriptions WHERE user_id = ?', target.id)).expires_at;
  const d = await A('POST', '/action', T, { name: 'user.add_days', args: { userId: target.id, days: 5 } });
  const after = (await row('SELECT expires_at FROM subscriptions WHERE user_id = ?', target.id)).expires_at;
  ok(d.data.ok && d.data.undoable && d.data.audit_id && (after === null || after - before === 5 * 86400), 'add days works and can be undone');
  const un = await A('POST', '/undo', T, { audit_id: d.data.audit_id });
  ok(un.data.ok && (await row('SELECT expires_at FROM subscriptions WHERE user_id = ?', target.id)).expires_at === before, 'undo puts it back');
  const bad = await A('POST', '/action', T, { name: 'user.add_days', args: { userId: target.id, days: 0 } });
  ok(bad.status === 422 && bad.data.ok === false && /روز/.test(bad.data.error), 'the bot\'s own validation answers bad input');

  // the user card and the live per-panel view
  const card = await A('GET', '/users/' + target.id, T);
  ok(card.status === 200 && card.data.subscription && card.data.subscription.status === 'active' && !card.data.subscription.sub_url, 'user card: subscription, no subscription address');
  ok('last_seen' in card.data && 'online' in card.data && 'started_at' in card.data.subscription, 'user card: last connection, online, start date');
  const pv = await A('GET', `/users/${target.id}/panels`, T);
  ok(pv.status === 200 && pv.data.panels.length >= 1 && pv.data.panels[0].username && 'online' in pv.data.panels[0], 'per-panel view: account, usage, dates, last connection: ' + JSON.stringify(pv.data.panels[0]));
  ok(!JSON.stringify(pv.data).includes('panel.test'), 'no panel address in the per-panel view');
  ok((await A('GET', '/users?filter=act', T)).data.users.some((u) => u.id === target.id && u.sub && u.sub.active), 'the "active" filter lists the user with a plan');
  ok(!(await A('GET', '/users?filter=none', T)).data.users.some((u) => u.id === target.id), 'and the "no plan" filter does not');

  // inbox and the receipt photo
  const o = (await env.DB.prepare("INSERT INTO orders (user_id, kind, amount_toman, method, status, receipt_file_id, created_at) VALUES (?, 'topup', 50000, 'card', 'review', 'file-1', ?)").bind(target.id, Math.floor(Date.now() / 1000)).run()).meta.last_row_id;
  const ib = await A('GET', '/inbox', T);
  ok(ib.data.orders.some((x) => x.id === o && x.has_receipt), 'the receipt waits in the inbox');
  const rc = await A('GET', `/orders/${o}/receipt`, T);
  ok(rc.status === 200 && rc.res.headers.get('content-type') === 'image/jpeg' && rc.res.headers.get('cache-control').includes('no-store'), 'the receipt photo comes through the Worker');
  const rj = await A('POST', '/action', T, { name: 'order.reject', args: { orderId: o } });
  ok(rj.data.ok && (await row('SELECT status FROM orders WHERE id = ?', o)).status === 'rejected', 'reject from the inbox');

  // roles: a viewer reads but cannot change anything; a removed admin is out at once
  await env.DB.prepare("INSERT INTO admins (tg_id, role, added_at) VALUES ('900900', 'viewer', 1)").run();
  const vt = (await A('POST', '/auth', null, { init_data: initFor(900900) })).data.access_token;
  ok((await A('GET', '/dashboard', vt)).status === 200, 'a viewer can read');
  const vw = await A('POST', '/action', vt, { name: 'user.add_days', args: { userId: target.id, days: 1 } });
  ok(vw.status === 422 && vw.data.ok === false, 'a viewer cannot change anything');
  await env.DB.prepare("DELETE FROM admins WHERE tg_id = '900900'").run();
  ok((await A('GET', '/dashboard', vt)).status === 403, 'a removed admin is out with their next request');
}

section('Mini App admin panel, full control: every screen answers, each role sees only its part, secrets stay hidden');
{
  const { createHmac } = await import('node:crypto');
  const sign = (fields) => {
    const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest();
    return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
  };
  const initFor = (id) => sign({ user: JSON.stringify({ id, first_name: 'A' }), auth_date: String(Math.floor(Date.now() / 1000)) });
  const row = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first());
  const A = (method, path, token, json) => call(method, '/api/v1/admin' + path, { token, json });
  const tok = async (id) => (await A('POST', '/auth', null, { init_data: initFor(id) })).data.access_token;
  const T = await tok(12345);
  await env.DB.prepare("INSERT INTO admins (tg_id, role, added_at) VALUES ('910001', 'support', 1), ('910002', 'viewer', 1)").run();
  const S = await tok(910001), V = await tok(910002);
  const u = await row("SELECT id FROM users WHERE email = 'admin-mini-target@example.com'");
  const pl = await row('SELECT id FROM plans ORDER BY id LIMIT 1');
  const pn = await row('SELECT id FROM panels ORDER BY id LIMIT 1');

  const support = ['/dashboard', '/inbox', '/orders', '/orders?status=rej&method=card'];
  const viewer = [`/users`, `/users?filter=act`, `/users/${u.id}`, `/users/${u.id}/wallet`, `/users/${u.id}/orders`, `/users/${u.id}/nets`, '/plans', '/coupons', '/referral',
    '/payments', '/sms', '/sms?filter=un', '/panels', `/panels/${pn.id}`, '/app', '/net', '/net/users', '/stats?days=1', '/stats?days=30', '/broadcasts', '/health', '/audit',
    `/audit?type=user&id=${u.id}`];
  const owner = ['/settings', '/admins', '/sms/setup'];
  for (const p of [...support, ...viewer, ...owner]) {
    const r = await A('GET', p, T);
    ok(r.status === 200, `owner opens ${p}: ${r.status} ${r.status !== 200 ? JSON.stringify(r.data) : ''}`);
  }
  for (const p of support) ok((await A('GET', p, S)).status === 200, `support opens ${p}`);
  for (const p of [...viewer, ...owner]) ok((await A('GET', p, S)).status === 403, `support cannot open ${p}`);
  for (const p of viewer) ok((await A('GET', p, V)).status === 200, `viewer opens ${p}`);
  for (const p of owner) ok((await A('GET', p, V)).status === 403, `viewer cannot open ${p}`);
  ok((await A('GET', '/nope', T)).status === 404, 'an unknown admin path is a 404');

  // what the screens rely on
  const st = await A('GET', '/stats?days=7', T);
  ok(st.data.bars.length === 7 && 'signups' in st.data && Array.isArray(st.data.methods), 'stats: one bar per day, sign-ups, methods');
  const us = await A('GET', '/users', T);
  ok(us.data.counts && typeof us.data.counts.all === 'number', 'users: counts per filter for the chips');
  const od = await A('GET', '/orders', T);
  ok(typeof od.data.count === 'number' && typeof od.data.total === 'number', 'orders: count and total');
  const o1 = od.data.orders[0];
  if (o1) { const one = await A('GET', '/orders/' + o1.id, T); ok(one.data.can && 'approve' in one.data.can, 'one order says what can still be done with it'); }

  // secrets: masked for the owner, never shown to a viewer
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('sms_key', 'super-secret-sms-key') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const se = await A('GET', '/settings', T);
  ok(!JSON.stringify(se.data).includes('super-secret-sms-key') && se.data.settings.find((x) => x.key === 'sms_key').secret, 'settings: the SMS key is masked');
  ok(!JSON.stringify((await A('GET', '/payments', V)).data).includes('super-secret-sms-key'), 'payments for a viewer: no SMS key');
  const setup = await A('GET', '/sms/setup', T);
  ok(setup.status === 200 && setup.data.header['X-SMS-Key'] === 'super-secret-sms-key', 'the owner gets the SMS setup');

  // writes only the owner may do
  ok((await A('POST', '/users', V, { email: 'v-made@example.com', password: 'Passw0rd!x' })).status === 403, 'a viewer cannot create a user');
  const cu = await A('POST', '/users', T, { email: 'owner-made@example.com', password: 'Passw0rd!x' });
  const made = await row("SELECT id, password_hash FROM users WHERE email = 'owner-made@example.com'");
  ok(cu.status === 200 && made && made.password_hash && !made.password_hash.includes('Passw0rd'), 'the owner creates a user; the password is stored hashed: ' + JSON.stringify(cu.data));
  ok((await A('POST', '/backup', S)).status === 403, 'support cannot send a backup');

  // a broadcast drafted from the app, then the log shows it with undo
  const bc = await A('POST', '/action', T, { name: 'broadcast.create', args: { audience: 'all', text: 'Hello from the Mini App' } });
  ok(bc.data.ok && bc.data.target_id, 'broadcast drafted, its id comes back for the detail screen');
  const one = await A('GET', '/broadcasts/' + bc.data.target_id, T);
  ok(one.data.status === 'draft' && one.data.audience_now != null, 'the draft shows how many it will reach');
  const lg = await A('GET', '/audit', T);
  ok(lg.data.log.some((r) => r.action === 'broadcast.create' && r.can_undo), 'the admin log offers undo on it');
  ok((await A('POST', '/action', S, { name: 'broadcast.create', args: { audience: 'all', text: 'x' } })).data.ok === false, 'support cannot draft a broadcast');
  await env.DB.prepare("DELETE FROM admins WHERE tg_id IN ('910001', '910002')").run();
}

section('configs from a panel\'s "Tunnel" group are marked; the panel number is shown to admins only');
{
  const { isTunnelLink, unify, refreshHostRules } = await import('../src/panels.js');
  const acts = await import('../src/admin-actions.js');
  const row = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
  // matching a link to the host it was made from
  const rules = [
    { a: ['de1.x.net'], p: 443, r: '🇩🇪 Germany {USERNAME}', t: true },
    { a: ['nl1.x.net'], p: 443, r: '🇳🇱 Netherlands', t: false },
    { a: ['*.cdn.x.net'], p: null, r: 'CDN {DATA_LEFT}', t: true },
    { a: [], p: 2053, r: 'Plain {USERNAME}', t: false },
  ];
  ok(isTunnelLink(rules, 'vless://u@de1.x.net:443?type=ws#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20gold_ali'), 'a link from a tunnel host is a tunnel');
  ok(!isTunnelLink(rules, 'vless://u@nl1.x.net:443#%F0%9F%87%B3%F0%9F%87%B1%20Netherlands'), 'a link from another host is not');
  ok(!isTunnelLink(rules, 'vless://u@de1.x.net:8443#Germany'), 'same address on another port is not that host');
  ok(isTunnelLink(rules, 'trojan://p@a1b2c3.cdn.x.net:2096#CDN%2010%20GB'), 'a wildcard address with a random part matches');
  ok(!isTunnelLink(rules, 'vless://u@9.9.9.9:2053#Plain%20bob'), 'a host with no address is matched by its remark');
  ok(!isTunnelLink([], 'vless://u@de1.x.net:443#Germany'), 'no rules: nothing is a tunnel');
  ok(!isTunnelLink([{ a: ['de1.x.net'], p: 443, r: 'A', t: true }, { a: ['de1.x.net'], p: 443, r: 'B', t: false }], 'vless://u@de1.x.net:443#C'), 'a tie with a plain host is not a tunnel');
  const kept = [];
  const merged = unify(['vless://a@h1.x.net:443#x', 'vless://a@h1.x.net:443#y', 'vless://b@h2.x.net:443#z'], {}, kept);
  ok(merged.length === 2 && kept.join() === '0,2', 'unify says which links it kept: ' + kept.join());

  // end to end: the panel has a Tunnel group holding the inbound of the Germany host
  const tok = await signup('tunnel@example.com', { device: 'tn' });
  const u = await row('SELECT * FROM users WHERE email = ?', 'tunnel@example.com');
  const plan = await row('SELECT id FROM plans WHERE is_active = 1 AND archived = 0 ORDER BY sort, id LIMIT 1');
  await acts.runAction(env, '12345', 'user.grant', { userId: u.id, planId: plan.id });
  const saved = Object.values(fakes.panels).map((p) => [p, p.groupList, p.hosts]);
  for (const p of Object.values(fakes.panels)) {
    p.groupList = [{ id: 1, name: 'default', inbound_tags: ['vless-in', 'tr-in'] }, { id: 7, name: 'Tunnel', inbound_tags: ['tun-in'] }];
    p.hosts = [
      { remark: '🇳🇱 Netherlands', address: [`nl1.${p.host}`], port: 443, inbound_tag: 'vless-in', is_disabled: false },
      { remark: '🇩🇪 Germany {USERNAME}', address: [`de1.${p.host}`], port: 443, inbound_tag: 'tun-in', is_disabled: false },
      { remark: '🇺🇸 United States', address: [`us1.${p.host}`], port: 443, inbound_tag: 'tr-in', is_disabled: false },
    ];
  }
  const H = { 'x-device-id': 'tn', 'x-hwid': 'tn' };
  const before = (await call('GET', '/api/v1/vpn/servers', { token: tok, headers: H })).data;
  ok(Array.isArray(before) && before.length >= 3 && !before.some((s) => s.tunnel), 'before the hosts are read nothing is marked');
  ok(before.every((s) => s.panel > 0), 'every user gets the panel number');
  await counted('refreshHostRules', () => refreshHostRules(env));
  const stored = await row("SELECT value FROM settings WHERE key = 'panel_hosts_1'");
  ok(stored && JSON.parse(stored.value).rules.length === 3, 'hosts kept in settings: ' + (stored && stored.value.slice(0, 80)));
  const after = (await call('GET', '/api/v1/vpn/servers', { token: tok, headers: H })).data;
  const de = after.filter((s) => s.country_code === 'DE'), other = after.filter((s) => s.country_code !== 'DE');
  ok(de.length && de.every((s) => s.tunnel === true), 'the Germany config (Tunnel group) is marked tunnel');
  ok(other.length && other.every((s) => !s.tunnel), 'configs of other groups are not marked');
  ok(after.every((s) => Number.isInteger(s.panel) && s.panel > 0), 'every user sees the panel of every server: ' + after.map((s) => s.panel).join(','));
  // an unchanged panel is not written again; a panel that cannot be read keeps what it had
  const w0 = (await row("SELECT value FROM settings WHERE key = 'panel_hosts_1'")).value;
  await refreshHostRules(env);
  ok((await row("SELECT value FROM settings WHERE key = 'panel_hosts_1'")).value === w0, 'unchanged hosts: no new write');
  for (const p of Object.values(fakes.panels)) p.down = true;
  await refreshHostRules(env);
  for (const p of Object.values(fakes.panels)) p.down = false;
  ok((await row("SELECT value FROM settings WHERE key = 'panel_hosts_1'")).value === w0, 'an unreachable panel keeps its last hosts');
  // the bot's diagnostic says what the Worker can read on the panel
  const { panelTunnelDiag } = await import('../src/telegram-screens.js');
  const diag = await panelTunnelDiag(env, 1, true);
  ok(/Tunnel/.test(diag.text) && /۴\. هاست‌های تانل: 1/.test(diag.text) && /✅ ۲۰۰/.test(diag.text), 'tunnel diagnostic shows the group and the tunnel host: ' + diag.text.slice(0, 400));
  ok(!/\.[a-z]{2,}:\d|vless:|https?:/i.test(diag.text), 'tunnel diagnostic shows no address or link');
  // a reseller admin (403 on groups and hosts): a probe user that sits only in the Tunnel group finds the tunnel configs
  {
    const pg1 = fakes.panels[PANEL];
    pg1.groupsSudoOnly = true; pg1.hostsSudoOnly = true; pg1.tunnelGroupId = 7;
    await env.DB.prepare("DELETE FROM settings WHERE key = 'panel_hosts_1'").run();
    await refreshHostRules(env);
    const rules = JSON.parse((await row("SELECT value FROM settings WHERE key = 'panel_hosts_1'")).value).rules;
    ok(rules.length === 1 && rules[0].t === true && rules[0].a[0] === `de1.${pg1.host}`, 'without group/host access the probe user finds the tunnel host: ' + JSON.stringify(rules));
    const made = Object.keys(pg1.users).filter((n) => n.startsWith('cgtunnel_'));
    ok(made.length === 1 && pg1.users[made[0]].group_ids.join() === '7', 'one probe user, only in the Tunnel group');
    await refreshHostRules(env, 1, true);
    ok(Object.keys(pg1.users).filter((n) => n.startsWith('cgtunnel_')).length === 1, 'the probe user is reused, not made again');
    const after2 = (await call('GET', '/api/v1/vpn/servers', { token: tok, headers: H })).data;
    ok(after2.filter((s) => s.country_code === 'DE').every((s) => s.tunnel === true) && after2.filter((s) => s.country_code !== 'DE').every((s) => !s.tunnel), 'configs are marked through the probe');
    pg1.groupsSudoOnly = false; pg1.hostsSudoOnly = false; pg1.tunnelGroupId = 0;
  }
  // a panel without a Tunnel group: its hosts are not even read
  const p1 = fakes.panels[PANEL];
  p1.groupList = [{ id: 1, name: 'default', inbound_tags: ['vless-in'] }];
  const reads = p1.hostReads || 0;
  await refreshHostRules(env);
  ok((p1.hostReads || 0) === reads && JSON.parse((await row("SELECT value FROM settings WHERE key = 'panel_hosts_1'")).value).rules.length === 0, 'no Tunnel group: no host read, nothing marked');
  for (const [p, g, h] of saved) { p.groupList = g; p.hosts = h; }
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'panel_hosts_%'").run();
}

section('every request and cron run stays within the Free plan\'s 50 D1 queries');
{ const top = allInv.reduce((m, s) => (s.q > m.q ? s : m), { q: 0 }); console.log(`    most D1 queries in one invocation: ${top.q} (${top.label})`); }
ok(!overCap.length, 'invocations over 50 D1 queries: ' + overCap.map((s) => `${s.label} = ${s.q}`).join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
