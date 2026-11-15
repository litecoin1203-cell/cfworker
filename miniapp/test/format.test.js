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

// UX-03: the Mini App is English only; a Persian plan name from the server never shows
test('UX-03: plan label prefers the English name and never shows Persian', async () => {
  const { planLabel } = await import('../src/format.js');
  assert.equal(planLabel({ plan_name: 'یک ماهه', plan_name_en: 'Gold' }), 'Gold');
  assert.equal(planLabel({ plan_name: 'یک ماهه' }), 'Your plan');
  assert.equal(planLabel({ plan_name: 'Monthly' }), 'Monthly');
  assert.equal(planLabel({ plan_name: 'Monthly', plan_name_en: '' }), 'Monthly');
  assert.equal(planLabel({}), 'Your plan');
  assert.equal(planLabel(null), 'Your plan');
});
test('UX-03: the Home plan card uses planLabel', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /\{planLabel\(sub\)\}/);
  assert.doesNotMatch(main, /sub\.plan_name/);
});
test('UX-03: the admin plan page edits the English name and badge', async () => {
  const { readFileSync } = await import('node:fs');
  const sales = readFileSync(new URL('../src/admin/sales.jsx', import.meta.url), 'utf8');
  assert.match(sales, /f: 'name_en'/);
  assert.match(sales, /f: 'badge_en'/);
});
