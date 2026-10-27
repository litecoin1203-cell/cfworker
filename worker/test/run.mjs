// Drives the real Worker through many scenarios. Run: node --experimental-sqlite test/run.mjs
import { makeDB, installFakes } from './shim.mjs';
import { hmacSha512Hex } from '../src/util.js';
import { panelBases, decodeSub } from '../src/pasarguard.js';

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
  await botSet('card_number', '6037991234567890');
  await botSet('card_holder', 'Ali');
  const tok = await signup('buyer@example.com', { device: 'buyer-phone' });
  const plans = (await call('GET', '/api/v1/plans')).data;
  const monthly = plans.find((p) => p.name === 'یک ماهه');
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
  ok(report.includes('ورود با یوزر') && report.includes('ساخت اکانت آزمایشی موفق') && report.includes('3 کانفیگ'), 'panel report all green:\n' + report);
  ok(!Object.keys(fakes.pg.users).some((n) => n.startsWith('cgtest_')), 'test user cleaned up');
  const b2 = fakes.tg.messages.length;
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/find diff@example.com' } });
  ok(fakes.tg.messages.slice(b2).some((m) => m.text.includes('روز') && m.text.includes('حجم')), '/find shows live usage');
  await tgWebhook({ message: { chat: { id: 12345 }, text: '/plan 1 name اقتصادی یک ماهه' } });
  ok((await call('GET', '/api/v1/plans')).data.some((p) => p.name === 'اقتصادی یک ماهه'), '/plan renames');
  const r = await worker.scheduled({}, env, ctx); await drain();
  ok(true, 'scheduled ran');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
