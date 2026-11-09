// The admin panel's pure parts: number and date formats, labels, and that every reason the shared bot code can give
// for a refused action reaches the admin in English (the bot's text is Persian; the Mini App is English only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { n, gb, short, day, ago, plural, subState, pleatsLeft, actionLabel, SETTING, settingLabel } from '../src/admin/fmt.js';
import { englishError } from '../src/admin/errors.js';

const worker = (f) => readFileSync(new URL('../../worker/src/' + f, import.meta.url), 'utf8');

test('numbers', () => {
  assert.equal(n(1890000), '1,890,000');
  assert.equal(n(null), '0');
  assert.equal(short(1890000), '1.89M');
  assert.equal(short(250000), '250K');
  assert.equal(short(9500), '9,500');
  assert.equal(gb(1.5 * 1024 ** 3), '1.5');
  assert.equal(gb(150 * 1024 ** 3), '150');
  assert.equal(gb(null), '—');
  assert.equal(plural(1, 'order'), '1 order');
  assert.equal(plural(3, 'order'), '3 orders');
  assert.equal(plural(2, 'person', 'people'), '2 people');
});

test('dates', () => {
  assert.equal(day(Date.UTC(2026, 10, 8) / 1000), 'Nov 8, 2026');
  assert.equal(day(null), '—');
  const now = 1_800_000_000;
  assert.equal(ago(now - 30, now), 'just now');
  assert.equal(ago(now - 600, now), '10 min ago');
  assert.equal(ago(now - 7200, now), '2 h ago');
  assert.equal(ago(now - 3 * 86400, now), '3 d ago');
  assert.equal(ago(null, now), 'never');
});

test('subscription state and pleats', () => {
  const now = 1_800_000_000;
  assert.equal(subState(null).label, 'No plan');
  assert.equal(subState({ paused: true }, now).label, 'Paused');
  assert.equal(subState({ active: true }, now).tone, 'ok');
  assert.equal(subState({ active: false, expires_at: now - 1 }, now).label, 'Ended');
  assert.equal(subState({ active: false, expires_at: now + 99, stop_reason: 'quota' }, now).label, 'Data used up');
  assert.equal(pleatsLeft(0, 0), 12);
  assert.equal(pleatsLeft(100, 100), 0);
  assert.equal(pleatsLeft(99.9, 100), 1);
  assert.equal(pleatsLeft(50, 100), 6);
});

test('every admin action has an English name in the log', () => {
  const names = [...worker('admin-actions.js').matchAll(/^ {2}'([a-z]+\.[a-z_]+)': \{/gm)].map((m) => m[1]);
  assert.ok(names.length > 40, 'found the actions');
  for (const a of names) assert.notEqual(actionLabel(a), a, `no label for ${a}`);
  assert.equal(actionLabel('plan.set.undo'), 'Undone: Plan edited');
});

test('every setting has an English label', () => {
  const src = worker('db.js');
  const block = src.slice(src.indexOf('SETTING_DEFAULTS'), src.indexOf('};', src.indexOf('SETTING_DEFAULTS')));
  const keys = [...block.matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]);
  assert.ok(keys.length > 10, 'found the settings');
  for (const k of keys) assert.notEqual(settingLabel(k), k, `no label for ${k}`);
  assert.equal(settingLabel('wallet_xlm_memo'), 'XLM wallet memo / tag');
});

test('every refusal the bot code gives is translated', () => {
  const src = ['admin-actions.js', 'admin-api.js', 'sync.js', 'telegram-menu.js'].map(worker).join('\n');
  const miss = new Set();
  for (const m of src.matchAll(/fail\(\s*(['`])((?:\\.|(?!\1).)*)\1/g)) {
    if (m[2].includes('${')) continue;
    const text = m[2].replace(/\\n/g, '\n');
    if (englishError(text).startsWith('It did not work')) miss.add(text);
  }
  assert.deepEqual([...miss], []);
});

test('refusals with numbers and nested reasons', () => {
  assert.equal(englishError('متن باید ۱ تا 3,500 حرف باشد.'), 'The text must be 1 to 3,500 characters.');
  assert.equal(englishError('حداکثر 8 مورد. اول یکی را حذف کن.'), 'At most 8 items. Remove one first.');
  assert.equal(englishError('⚠️ وصل نشد:\nخطای ناشناخته'), 'Could not link: unknown error.');
  assert.equal(englishError('Panel said no'), 'Panel said no');
  assert.equal(englishError(''), 'It did not work.');
  assert.match(englishError('چیزی تازه'), /^It did not work: /);
});

test('admin log summaries come out in English', async () => {
  const { englishSummary } = await import('../src/admin/fmt.js');
  assert.equal(englishSummary('اشتراک فعال · 62 حرف (پیش‌نویس)'), 'active plan · 62 chars (draft)');
  assert.equal(englishSummary('+5 روز · انقضا 2026-12-09 → 2026-12-14'), '+5 days · ends 2026-12-09 → 2026-12-14');
  assert.equal(englishSummary('+50,000 ت · 0 → 50,000 · یادداشت'), '+50,000 toman · 0 → 50,000');
  assert.equal(englishSummary('sending → stopped'), 'sending → stopped');
});
