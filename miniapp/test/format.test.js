import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gb, money, statusOf, pleatsLeft, dayDots, firstName } from '../src/format.js';

const G = 1024 ** 3;
test('gb rounds to one decimal under 100 GB', () => {
  assert.equal(gb(12.44 * G), '12.4');
  assert.equal(gb(0), '0');
  assert.equal(gb(-5), '0');
  assert.equal(gb(250.6 * G), '251');
});
test('money groups thousands and never goes negative', () => {
  assert.equal(money(1890000), '1,890,000');
  assert.equal(money(-3), '0');
});
test('status chip', () => {
  assert.deepEqual(statusOf(null), { label: 'No plan', tone: 'muted' });
  assert.equal(statusOf({ status: 'active' }).tone, 'safe');
  assert.equal(statusOf({ status: 'limited' }).label, 'Data used up');
  assert.equal(statusOf({ status: 'disabled' }).label, 'Paused');
});
test('pleats left', () => {
  assert.equal(pleatsLeft({ data_limit_bytes: 10 * G, used_bytes: 0 }), 10);
  assert.equal(pleatsLeft({ data_limit_bytes: 10 * G, used_bytes: 9.99 * G }), 1, 'any data left shows one pleat');
  assert.equal(pleatsLeft({ data_limit_bytes: 10 * G, used_bytes: 11 * G }), 0);
  assert.equal(pleatsLeft({ unlimited_data: true }), 10);
});
test('day dots', () => {
  assert.deepEqual(dayDots({ period_days: 30, days_left: 12 }), { total: 30, left: 12 });
  assert.deepEqual(dayDots({ period_days: 365, days_left: 200 }), { total: 31, left: 31 });
  assert.equal(dayDots({ unlimited_time: true }), null);
});
test('first name', () => {
  assert.equal(firstName('  Sara Ahmadi '), 'Sara');
  assert.equal(firstName(''), '');
});
