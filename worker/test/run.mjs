// Drives the real Worker through many scenarios. Run: node --experimental-sqlite test/run.mjs
import { makeDB, installFakes } from './shim.mjs';
import { hmacSha512Hex } from '../src/util.js';

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

async function call(method, path, { token, json: j, headers = {}, form } = {}) {
  const h = { ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  let bodyInit;
  if (form) bodyInit = form;
  else if (j !== undefined) { h['content-type'] = 'application/json'; bodyInit = JSON.stringify(j); }
  const req = new Request('https://api.test' + path, { method, headers: h, body: bodyInit });
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
async function botSet(key, value) {
  await call('POST', '/tg/hook', { json: { message: { chat: { id: 12345 }, text: `/set ${key} ${value}` } } });
}
async function tgWebhook(update) { const r = await call('POST', '/tg/hook', { json: update }); await drain(); return r; }

// ---------------- tests ----------------
section('health');
ok((await call('GET', '/health')).data.ok === true, 'health ok');

section('plans seeded');
{
  const r = await call('GET', '/api/v1/plans');
  ok(r.data.length === 3, 'three default plans');
  ok(r.data.some((p) => p.badge === 'Recommended' && p.trial_days === 7), 'annual has trial + badge');
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
  await botSet('card_number', '6037991234567890');
  await botSet('card_holder', 'Ali');
  const tok = await signup('buyer@example.com', { device: 'buyer-phone' });
  const plans = (await call('GET', '/api/v1/plans')).data;
  const monthly = plans.find((p) => p.name === 'Monthly');
  const order = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: monthly.id, method: 'card' } });
  ok(order.status === 201 && order.data.card.number === '6037991234567890', 'card order returns card details');
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
  const annual = (await call('GET', '/api/v1/plans')).data.find((p) => p.name === 'Annual');
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
  const annual = (await call('GET', '/api/v1/plans')).data.find((p) => p.name === 'Annual');
  const savedUrl = env.PASARGUARD_URL;
  env.PASARGUARD_URL = 'http://panel.down';   // make provisioning fail
  const buy = await call('POST', '/api/v1/orders', { token: tok, json: { plan_id: annual.id, method: 'wallet' } });
  env.PASARGUARD_URL = savedUrl;
  ok(buy.status === 400 && buy.data.detail.code === 'provision_failed', 'purchase fails when panel down');
  const w = await call('GET', '/api/v1/wallet', { token: tok });
  ok(w.data.balance === 500000, 'wallet refunded in full');
}

section('crypto invoice + IPN');
{
  await botSet('usdt_rate_toman', '70000');
  const tok = await signup('crypto@example.com');
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.name === 'Monthly');
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
  const monthly = (await call('GET', '/api/v1/plans')).data.find((p) => p.name === 'Monthly'); // device_limit = 2
  // grant via bot so we do not need wallet
  await tgWebhook({ message: { chat: { id: 12345 }, text: `/grant dev@example.com ${monthly.id}` } });
  ok((await call('GET', '/api/v1/vpn', { token: tok, headers: { 'x-device-id': 'phone-a' } })).status === 200, 'device a ok');
  ok((await call('GET', '/api/v1/vpn', { token: tok, headers: { 'x-device-id': 'phone-b' } })).status === 200, 'device b ok');
  ok((await call('GET', '/api/v1/vpn', { token: tok, headers: { 'x-device-id': 'phone-c' } })).data.detail.code === 'device_limit', 'device c blocked (limit 2)');
  const devs = (await call('GET', '/api/v1/devices', { token: tok })).data;
  await call('DELETE', `/api/v1/devices/${devs[devs.length - 1].id}`, { token: tok });
  ok(fakes.pg.deletedHwids.length >= 1, 'panel HWID freed on device removal');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
