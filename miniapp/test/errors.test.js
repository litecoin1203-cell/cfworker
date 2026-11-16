// UX-11: a refused call says why, by its code, in English. The Worker's message for the old app is Persian, and
// not every 403 means a disabled account (use_pleat, trial_needs_telegram, device_limit are 403s too).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = { hash: '' };
let reply = null;
globalThis.fetch = async () => new Response(JSON.stringify(reply), { status: reply.status });
const { request } = await import('../src/api.js');

async function messageFor(status, code, message) {
  reply = { status, detail: { code, message } };
  try { await request('/me', { auth: false }); } catch (e) { return e.message; }
  throw new Error('no error');
}

test('a 403 is named by its code, not always "disabled"', async () => {
  assert.equal(await messageFor(403, 'trial_needs_telegram', 'برای تست رایگان اول تلگرامت را در پروفایل تأیید کن.'),
    'Verify your Telegram in the Pleat app first, then start the free trial.');
  assert.equal(await messageFor(403, 'device_limit', 'این اشتراک روی حداکثر تعداد گوشی استفاده شده است.'),
    'Your plan is on as many phones as it allows. Remove an old phone in the Pleat app.');
  assert.equal(await messageFor(403, 'account_disabled', 'این حساب غیرفعال شده است.'), 'This account is disabled.');
  // English messages from the Worker are shown as they are
  assert.equal(await messageFor(403, 'use_pleat', 'Open the Pleat app for this.'), 'Open the Pleat app for this.');
  // an unknown Persian 403 is not called "disabled"
  assert.equal(await messageFor(403, 'something_new', 'پیام فارسی'), 'This isn’t allowed here. Try it in the Pleat app.');
});
