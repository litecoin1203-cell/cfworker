// Drives the real Worker through many scenarios. Run: node --experimental-sqlite test/run.mjs
import { makeDB, installFakes } from './shim.mjs';
import { hmacSha512Hex } from '../src/util.js';
import { panelBases, decodeSub } from '../src/pasarguard.js';
import { fetchUsdRate, usdRateInfo } from '../src/usdrate.js';

const PANEL = 'http://panel.test';
const fakes = installFakes({ panelBase: PANEL });
const worker = (await import('../src/index.js')).default;

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
  // admin approves via inline button
  const ap = await tgWebhook({ callback_query: { id: 'c1', data: `ap:${order.data.id}`, message: { chat: { id: 12345 }, message_id: 1 } } });
  ok(ap.status === 200, 'approve callback handled');
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
  ok(buy.status === 400 && buy.data.detail.code === 'provision_failed', 'purchase fails when panel down');
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
  ok(f && f.code === 'provision_failed' && (await get(o3.data.id)).status === 'pending', 'failed settle releases the claim');
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
  ok(homeMsg && homeMsg.body.text.includes('مدیریت Cloud Gold') && ['m:ord', 'm:usr', 'm:pl', 'm:pa', 'm:cp', 'm:pay', 'm:set'].every((d) => kbData(homeMsg).includes(d)), '/menu opens the button menu');
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
  ok(card && kbData(card).some((d) => d.startsWith('m:ug:')) && kbData(card).some((d) => d.startsWith('m:w:reset:')), 'search answer shows the user card with grant / password buttons');
  n = fakes.tg.calls.length;
  await say('ali@example.com');
  ok(!sent(n).some((m) => m.text.includes('👤')), 'an answer is used once; the next text is not a search');

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
  n = fakes.tg.calls.length;
  await say('ali@example.com');
  ok(!sent(n).some((m) => m.text.includes('👤')), 'cancel clears the question');

  // an old question expires
  await tap('m:w:find');
  await env.DB.prepare("UPDATE settings SET value = json_set(value, '$.exp', 1) WHERE key = 'bot_wait'").run();
  n = fakes.tg.calls.length;
  await say('ali@example.com');
  ok(!sent(n).some((m) => m.text.includes('👤')), 'an expired question is ignored');

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
  await tap('m:w:coupon');
  await say('MENU10 10 5');
  ok(!!(await env.DB.prepare("SELECT 1 x FROM coupons WHERE code = 'MENU10'").first()), 'coupon made from the menu');
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
  for (const d of ['m:home', 'm:st', 'm:usr', 'm:pl', `m:p:${p.id}`, 'm:pa', 'm:pp:1', 'm:cp', 'm:pay', 'm:set', 'm:wl', 'm:sk:wallet_xlm_memo', 'm:help', `m:u:${mg.id}`]) {
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
const { runSync } = await import('../src/sync.js');
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
  const all = bodies.join('\n');
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
  await tap(kbData(c1).find((d) => d.startsWith('cf:')), c1.body.text);

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
  await tap(kbData(c1).find((d) => d.startsWith('cf:')), c1.body.text);
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
  await tap(kbData(c3).find((d) => d.startsWith('cf:')), c3.body.text);
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
  await tap(kbData(c4).find((d) => d.startsWith('cf:')), c4.body.text);
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
  if (c6) await tap(kbData(c6).find((d) => d.startsWith('cf:')), c6.body.text);
  const p2state = (await env.DB.prepare('SELECT state FROM panels WHERE id = 2').first()).state;
  if (['active', 'rollout'].includes(p2state)) {
    const pa6 = await env.DB.prepare('SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = 2').bind(uid5).first();
    ok(pa6 && pa6.remote_username === 'nima_v2', 'linked on panel 2 by its number');
    ok((await env.DB.prepare('SELECT pg_username FROM subscriptions WHERE user_id = ?').bind(uid5).first()).pg_username === '', 'panel-1 username is not overwritten by another panel');
  } else ok(lastText().includes('فعال نیست'), 'a panel that is not serving cannot take a link');
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
  DB2.exec((await import('node:fs')).readFileSync(new URL('../migrations/0011_control_plane.sql', import.meta.url), 'utf8'));
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
  const N = 'http://newp.test';
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
  const np2 = fakes.addPanel('http://newq.test', 'nq.example.net', 'pasarguard');
  await admin('/addpanel pasarguard خراب');
  const qid = await lastId();
  await tgWebhook({ message: { chat: { id: 12345 }, message_id: 9101, text: `http://newq.test admin8 pass8pass` } });
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
