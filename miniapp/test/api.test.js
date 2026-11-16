// Smoke tests of the Mini App's network layer (release audit QA-05): the admin panel's 15-minute token, the
// user side's sign-in with initData, what is sent for a money action (confirm) and an undo, and that every
// failure reaches the screen as English. fetch, location and Telegram are fakes; no Worker, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = { hash: '' };
globalThis.window = { Telegram: { WebApp: { initData: 'query_id=TEST&user=%7B%22id%22%3A1%7D&hash=madeup' } } };

const calls = [];
let script = []; // queue of (call) => Response | throw
globalThis.fetch = async (url, init = {}) => {
  const c = { url, method: init.method || 'GET', auth: (init.headers || {}).authorization || '', body: init.body ? JSON.parse(init.body) : null };
  calls.push(c);
  const next = script.shift();
  if (!next) throw new Error('unexpected call ' + url);
  return next(c);
};
const res = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const reset = (...steps) => { calls.length = 0; script = steps; };

const { admin } = await import('../src/admin/api.js');
const user = await import('../src/api.js');

test('admin: signs in with initData, then sends its own bearer token', async () => {
  reset(res(200, { access_token: 'adm-1', role: 'owner', name: 'A' }), res(200, { ok: true }));
  const me = await admin.auth();
  assert.deepEqual(me, { role: 'owner', name: 'A' });
  assert.equal(calls[0].url, '/api/v1/admin/auth');
  assert.equal(calls[0].body.init_data, window.Telegram.WebApp.initData);
  assert.equal(calls[0].auth, '');
  await admin.dashboard();
  assert.equal(calls[1].auth, 'Bearer adm-1');
});

test('admin: an expired token signs in again once and retries; a second 401 is an error, not a loop', async () => {
  reset(res(401, { detail: { code: 'token_invalid', message: 'expired' } }), res(200, { access_token: 'adm-2', role: 'owner' }), res(200, { rows: [] }));
  assert.deepEqual(await admin.orders({ status: 'pending' }), { rows: [] });
  assert.deepEqual(calls.map((c) => c.url), ['/api/v1/admin/orders?status=pending', '/api/v1/admin/auth', '/api/v1/admin/orders?status=pending']);
  assert.equal(calls[2].auth, 'Bearer adm-2');
  reset(res(401, {}), res(200, { access_token: 'adm-3', role: 'owner' }), res(401, { detail: { code: 'token_invalid', message: 'expired' } }));
  await assert.rejects(admin.orders({}), (e) => e.status === 401);
  assert.equal(calls.length, 3);
});

test('admin: a money action carries its confirm flag; undo names the audit row', async () => {
  reset(res(200, { ok: true, text: 'done', audit_id: 9, undoable: true }), res(200, { ok: true, text: 'undone' }));
  const r = await admin.action('wallet.add', { userId: 5, amount: 1000 }, true);
  assert.equal(r.audit_id, 9);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/api/v1/admin/action');
  assert.deepEqual(calls[0].body, { name: 'wallet.add', args: { userId: 5, amount: 1000 }, confirm: true });
  await admin.undo(9);
  assert.deepEqual(calls[1].body, { audit_id: 9 });
  reset(res(200, {}));
  await admin.action('user.note', { userId: 5 });
  assert.equal(calls[0].body.confirm, false, 'no confirmation unless the screen asked for one');
});

test('admin: failures reach the screen in English', async () => {
  reset(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(admin.dashboard(), (e) => e.status === 0 && e.code === 'network' && /VPN/.test(e.message));
  reset(res(400, { detail: { code: 'bad_state', message: 'این سفارش قبلاً تأیید و فعال شده است.' } }));
  await assert.rejects(admin.dashboard(), (e) => e.status === 400 && e.code === 'bad_state' && e.message === 'This order was already approved and activated.');
  reset(res(429, { detail: { code: 'too_many_requests', message: 'تعداد درخواست‌ها زیاد است.' } }));
  await assert.rejects(admin.dashboard(), (e) => e.status === 429 && !/[؀-ۿ]/.test(e.message));
  reset(res(200, { ok: false, error: 'آیدی درست نیست.' }));
  const r = await admin.action('x', {});
  assert.equal(r.error, 'That id is not right.');
});

test('user: sign-in with initData, one retry on 401, a Persian message never shown', async () => {
  reset(res(200, { access_token: 'u-1' }), res(200, { email: 'a@example.com' }));
  assert.deepEqual(await user.signIn(), { ok: true, admin: null });
  await user.me();
  assert.equal(calls[1].auth, 'Bearer u-1');
  reset(res(401, {}), res(200, { access_token: 'u-2' }), res(200, { email: 'a@example.com' }));
  await user.me();
  assert.equal(calls[2].auth, 'Bearer u-2');
  // a Telegram account with no Pleat account yet: the original 401 is passed on, nothing is retried
  reset(res(401, {}), res(200, { need_account: true, name: 'A' }));
  await assert.rejects(user.me(), (e) => e.status === 401 && /session ended/.test(e.message));
  assert.equal(calls.length, 2);
  reset(res(403, { detail: { code: 'account_disabled', message: 'حساب شما غیرفعال است.' } }));
  await assert.rejects(user.request('/me'), (e) => e.code === 'account_disabled' && e.message === 'This account is disabled.');
});
