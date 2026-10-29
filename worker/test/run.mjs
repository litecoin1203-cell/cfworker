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

async function call(method, path, { token, json: j, headers = {}, form, cf } = {}) {
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
  ok(lastText().includes('PANEL_2_CRED') && !lastText().includes('pass2'), 'add panel names the secret to create, never asks for the password in chat');
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

section('webhook is registered by the Worker, with no secret in the path');
{
  await env.DB.prepare("DELETE FROM settings WHERE key = 'tg_webhook_sig'").run();
  const before = fakes.tg.calls.filter((c) => c.method === 'setWebhook').length;
  await worker.scheduled({ cron: '* * * * *' }, env, ctx); await drain();
  const calls = fakes.tg.calls.filter((c) => c.method === 'setWebhook');
  ok(calls.length === before + 1 && calls[calls.length - 1].body.url === 'https://api.test/tg' && calls[calls.length - 1].body.secret_token === 'hook', 'setWebhook to /tg with secret_token');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
