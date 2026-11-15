// PRV-04: the user deletes their own account from the Mini App. Nothing is sent until DELETE is typed; the call is
// POST /me/delete with confirm: "DELETE" (a Mini App token needs no password: Telegram proved who it is).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.location = { hash: '#tgWebAppData=' + encodeURIComponent('user=%7B%7D&hash=x') };
const sent = [];
globalThis.fetch = async (url, opts) => {
  sent.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
  if (url.endsWith('/auth/tg/webapp')) return new Response(JSON.stringify({ access_token: 'T' }), { status: 200 });
  return new Response(JSON.stringify({ deleted: true }), { status: 200 });
};
const { confirmsDelete } = await import('../src/format.js');
const api = await import('../src/api.js');

test('PRV-04: only the typed word DELETE confirms', () => {
  assert.equal(confirmsDelete('DELETE'), true);
  assert.equal(confirmsDelete(' delete '), true);
  assert.equal(confirmsDelete('DELET'), false);
  assert.equal(confirmsDelete(''), false);
  assert.equal(confirmsDelete(undefined), false);
});

test('PRV-04: deleteAccount refuses without the word and posts /me/delete with it', async () => {
  await api.signIn();
  sent.length = 0;
  await assert.rejects(api.deleteAccount('nope'), /Type DELETE/);
  assert.equal(sent.length, 0);
  assert.deepEqual(await api.deleteAccount('delete'), { deleted: true });
  assert.deepEqual(sent.map((s) => [s.url, s.method, s.body]), [['/api/v1/me/delete', 'POST', { confirm: 'DELETE' }]]);
});

test('PRV-04: the account screen offers Delete account and the admin log names the self-delete', async () => {
  const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /title="Delete account"/);
  assert.match(main, /can’t be undone/);
  const { actionLabel } = await import('../src/admin/fmt.js');
  assert.equal(actionLabel('user.self_delete'), 'Account deleted by the user');
});
