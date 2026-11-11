// Pleat's automatic health reports. Each phone keeps what went wrong (a crash, an exit that would not connect,
// a drop, a location that is not where the server's name says, heavy battery use) in a small queue, folds the same
// problem into one entry with a count, and sends the queue here in batches: POST /me/health. The Worker also adds
// what only it can see: the exit's real country from /me/ip (location mismatch, exit in Iran).
//
// Priorities: 1 critical (the person is left without the VPN or the app died) → a Telegram alert at once;
// 2 high (one server or route is broken); 3 medium (quality, battery); 4 the phone's daily summary.
//
// The Free plan allows ~100k D1 writes a day, so: one row per problem per user per day (fp), a repeat only raises
// the count; at most LIMITS.newRows new rows and LIMITS.writes writes per user per day (P1 has its own room); one
// batch per user every ~10 minutes; the bot can turn reports down to P1/P2 or off. Rows go after 14 days.
//
// Privacy: no share link, UUID, key, server address, IP, e-mail or Wi-Fi name is kept. The app scrubs before it
// sends and scrub() here does it again; servers are named only by their anonymous key (serverKey).
import { all, first, run } from './db.js';
import { json, nowSec, throttled, logError } from './util.js';
import { b, nav, crumb, fa } from './telegram-screens.js';

export const TYPES = {
  crash: 1, killed: 1, no_exit: 1,
  connect_fail: 2, drop: 2, silent: 2, unsupported: 2, loc_mismatch: 2, exit_iran: 2,
  battery: 3, slow_connect: 3, api_down: 3, update_fail: 3, app_error: 3,
  daily: 4,
};
// seen by the Worker itself (/me/ip); a phone cannot send them
const SERVER_ONLY = new Set(['loc_mismatch', 'exit_iran']);
export const LIMITS = {
  batch: 20, newRows: 25, writes: 120, p1Rows: 15, gapMs: 9 * 60 * 1000, p1GapMs: 50 * 1000,
  alertGap: 6 * 3600, alertsPerDay: 20, keepDays: 14, resolvedDays: 3, detailBytes: 600,
};
export const MODES = ['all', 'p2', 'off'];
const KEY_RE = /^[a-z0-9]{6,16}$/;
export const FP_RE = /^f[0-9a-f]{8}$/;
const KINDS = new Set(['wifi', 'cell', 'other']);
const dayOf = (t) => Math.floor(t / 86400);

export const TYPE_FA = {
  crash: '💥 کرش اپ/هسته', killed: '🪓 اندروید VPN را بست', no_exit: '⛔️ هیچ سروری وصل نشد',
  connect_fail: '❌ اتصال ناموفق', drop: '📉 قطع وسط اتصال', silent: '🔇 سرور بی‌جواب', unsupported: '🧩 تنظیم پشتیبانی‌نشده',
  loc_mismatch: '📍 مغایرت لوکیشن', exit_iran: '🇮🇷 خروجی از ایران',
  battery: '🔋 مصرف باتری بالا', slow_connect: '🐢 اتصال کند', api_down: '📡 سرور اپ در دسترس نبود', update_fail: '📲 به‌روزرسانی ناموفق',
  app_error: '⚠️ خطای اپ', daily: '📋 خلاصه‌ی روزانه',
};
export const PRIO_FA = { 1: '🔴 بحرانی', 2: '🟠 مهم', 3: '🟡 متوسط', 4: '⚪ خلاصه‌ها' };
const CAUSE_FA = {
  timeout: 'بی‌جواب', reset: 'قطع توسط شبکه', refused: 'سرور رد کرد', dns: 'DNS', offline: 'بی‌اینترنت', tls: 'TLS',
  reality: 'REALITY', account: 'حساب روی سرور نیست', path: 'تنظیم مسیر', config: 'تنظیم ناشناخته', unknown: 'نامشخص',
  native: 'کرش native (هسته)', java: 'کرش اپ', dart: 'خطای Dart', anr: 'هنگ (ANR)', low_memory: 'کمبود حافظه', excessive: 'مصرف بیش از حد',
  signaled: 'سیگنال سیستم', unclean: 'بسته‌شدن ناگهانی', permission: 'مجوز VPN', other: 'دیگر',
  download: 'دانلود', verify: 'بررسی فایل', install: 'نصب',
};
const DETAIL_FA = {
  proto: 'پروتکل', ms: 'زمان (ms)', s: 'ثانیه', err: 'خطای هسته', kind: 'نوع', tunnel: 'تانل وصل بود', trace: 'trace', reason: 'دلیل',
  min: 'دقیقه', rate: '٪ باتری در ساعت', drop: '٪ افت باتری', off: '٪ صفحه خاموش', opt: 'بهینه‌سازی باتری روشن', route: 'مسیر',
  tried: 'امتحان‌شده', bridge: 'پل', stage: 'مرحله', expected: 'کشور مورد انتظار', actual: 'کشور واقعی', misses: 'پینگ از دست رفته',
  sessions: 'جلسه', ok: 'موفق', fail: 'ناموفق', minutes: 'دقیقه‌ی وصل', moved: 'شبکه عوض شد', status: 'کد', what: 'چه چیزی',
};

// the same 8 hex for the same problem on every phone, so the bot can group them
export function fingerprint(type, k, c) {
  let h = 0x811c9dc5;
  for (const ch of `${type}|${k}|${c}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'f' + h.toString(16).padStart(8, '0');
}

// Package names that look like domains but are code (a trace frame), and file endings ("xray_config.dart").
const CODE_PREFIX = /^(java|javax|android|androidx|kotlin|kotlinx|dalvik|io\.flutter|app\.pleat|libv2ray|go|com\.android|com\.google\.android|dart|org\.json)\./i;
const FILE_EXT = /\.(dart|kt|java|so|go|c|cc|h|js)$/i;

// Takes out anything that could name a server, an account or a person. Kept: words, numbers, code names.
export function scrub(v, max = 160) {
  let s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  s = s
    .replace(/\b[a-z][a-z0-9+.-]{1,15}:\/\/\S+/gi, '<link>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\[?\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b\]?|\[?(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?\]?/gi, '<ip>')
    .replace(/\b(?:[a-z0-9-]{1,63}\.)+[a-z][a-z0-9-]{1,23}\b/gi, (m) => (CODE_PREFIX.test(m) || FILE_EXT.test(m) ? m : '<host>'))
    .replace(/[A-Za-z0-9+/_-]{24,}={0,2}/g, '<blob>');
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

const bytes = (s) => new TextEncoder().encode(s).length;
function cleanFlat(o) {
  const out = {};
  for (const [k0, v] of Object.entries(o || {}).slice(0, 6)) {
    const k = String(k0).replace(/[^a-z0-9_]/gi, '').slice(0, 12);
    if (!k) continue;
    if (k === 'k') { if (KEY_RE.test(String(v))) out.k = String(v); continue; }
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = scrub(v, 32);
  }
  return out;
}
// the event's extra facts: flat values only, every string scrubbed, LIMITS.detailBytes at most
export function cleanDetail(d) {
  const out = {};
  if (!d || typeof d !== 'object' || Array.isArray(d)) return out;
  for (const [k0, v] of Object.entries(d).slice(0, 16)) {
    const k = String(k0).replace(/[^a-z0-9_]/gi, '').slice(0, 16);
    if (!k) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') { const t = scrub(v, k === 'trace' ? 400 : 160); if (t) out[k] = t; }
    else if (Array.isArray(v)) out[k] = v.slice(0, 6).map((x) => (x && typeof x === 'object' ? cleanFlat(x) : scrub(x, 32)));
  }
  while (bytes(JSON.stringify(out)) > LIMITS.detailBytes) {
    if (typeof out.trace === 'string' && out.trace.length > 40) { out.trace = out.trace.slice(0, Math.floor(out.trace.length * 0.6)); continue; }
    const keys = Object.keys(out);
    if (!keys.length) break;
    delete out[keys[keys.length - 1]];
  }
  return out;
}

// One event from the phone, checked; null when it is not one we keep.
export function cleanEvent(e, now = nowSec()) {
  if (!e || typeof e !== 'object') return null;
  const type = String(e.t || '');
  const prio = TYPES[type];
  if (!prio || SERVER_ONLY.has(type)) return null;
  const k = KEY_RE.test(String(e.k || '')) ? String(e.k) : '';
  const c = String(e.c || '').toLowerCase().replace(/[^a-z0-9_.:>-]/g, '').slice(0, 32);
  const n = Math.max(1, Math.min(1000, parseInt(e.n, 10) || 1));
  const clamp = (t) => Math.max(now - 7 * 86400, Math.min(now, parseInt(t, 10) || now));
  const at = clamp(e.at), last = Math.max(at, clamp(e.last || e.at));
  return { type, prio, k, c, n, at, last, d: cleanDetail(e.d), fp: fingerprint(type, k, c) };
}

async function healthSettings(env) {
  const rows = await all(env, "SELECT key, value FROM settings WHERE key IN ('health_mode', 'health_mute')");
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let mute = {};
  try { mute = JSON.parse(m.health_mute || '{}') || {}; } catch (e) { mute = {}; }
  return { mode: MODES.includes(m.health_mode) ? m.health_mode : 'all', mute };
}
const muted = (mute, fp, now) => (mute[fp] || 0) > now;

const UPSERT = `INSERT INTO health_events (user_id, day, fp, prio, type, exit_key, exit_name, cause, count, first_at, last_at,
    app_ver, os, model, net, asn, isp, detail, state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(user_id, day, fp) DO UPDATE SET count = MIN(1000000, health_events.count + excluded.count),
    first_at = MIN(health_events.first_at, excluded.first_at), last_at = MAX(health_events.last_at, excluded.last_at),
    exit_name = excluded.exit_name, app_ver = excluded.app_ver, os = excluded.os, model = excluded.model, net = excluded.net,
    asn = excluded.asn, isp = excluded.isp, detail = excluded.detail, writes = health_events.writes + 1,
    state = CASE WHEN health_events.state = 'resolved' THEN excluded.state ELSE health_events.state END`;

function phoneFacts(body, request) {
  const cf = (request && request.cf) || {};
  const asn = parseInt(cf.asn, 10) || 0;
  return {
    app: /^\d{1,3}(\.\d{1,3}){1,3}(\+\d{1,6})?$/.test(String(body.app || '')) ? String(body.app) : '',
    os: scrub(body.os, 24),
    model: scrub(body.model, 40),
    net: KINDS.has(body.net) ? body.net : '',
    asn,
    isp: scrub(String(cf.asOrganization || ''), 40),
  };
}

// POST /me/health  { app, os, model, net, events: [{ t, k?, c?, n?, at?, last?, d? }] }
// → { ok: true, stored, dropped, mode } (the phone forgets what it sent) or { ok: false, retry } (it keeps them).
export async function report(env, user, request, body, ctx) {
  const now = nowSec(), day = dayOf(now);
  const raw = Array.isArray(body && body.events) ? body.events.slice(0, LIMITS.batch) : [];
  const merged = new Map();
  for (const e of raw) {
    const ev = cleanEvent(e, now);
    if (!ev) continue;
    const had = merged.get(ev.fp);
    if (had) { had.n = Math.min(1000, had.n + ev.n); had.at = Math.min(had.at, ev.at); if (ev.last >= had.last) { had.last = ev.last; had.d = ev.d; } }
    else merged.set(ev.fp, ev);
  }
  const events = [...merged.values()].sort((a, b2) => a.prio - b2.prio);
  if (!events.length) return json({ ok: true, stored: 0, dropped: raw.length, mode: (await healthSettings(env)).mode });
  const onlyP1 = events.every((e) => e.prio === 1);
  if (throttled(onlyP1 ? '__cgHealthP1' : '__cgHealth', user.id, onlyP1 ? LIMITS.p1GapMs : LIMITS.gapMs)) {
    return json({ ok: false, retry: Math.ceil((onlyP1 ? LIMITS.p1GapMs : LIMITS.gapMs) / 1000) });
  }
  const { mode, mute } = await healthSettings(env);
  const wanted = events.filter((e) => mode === 'all' || (mode === 'p2' && e.prio <= 2));
  if (!wanted.length) return json({ ok: true, stored: 0, dropped: events.length, mode });

  // this user's rows today: the daily caps, read once (a handful of rows)
  const today = new Map((await all(env, 'SELECT fp, prio, writes FROM health_events WHERE user_id = ? AND day = ?', user.id, day)).map((r) => [r.fp, r]));
  let rows = 0, writes = 0, p1Rows = 0;
  for (const r of today.values()) { writes += r.writes; if (r.prio === 1) p1Rows++; else rows++; }
  const keep = [];
  for (const e of wanted) {
    const had = today.has(e.fp);
    if (e.prio === 1) {
      if ((!had && p1Rows >= LIMITS.p1Rows) || writes >= LIMITS.writes * 2) continue;
      if (!had) p1Rows++;
    } else {
      if (writes >= LIMITS.writes || (!had && rows >= LIMITS.newRows)) continue;
      if (!had) rows++;
    }
    writes++;
    today.set(e.fp, { fp: e.fp, prio: e.prio, writes: 1 });
    keep.push(e);
  }
  if (!keep.length) return json({ ok: true, stored: 0, dropped: events.length, mode });

  // names of this user's servers (the key is anonymous; the name is what the app shows)
  let names = {};
  if (keep.some((e) => e.k)) {
    try { names = JSON.parse((await first(env, 'SELECT keys FROM user_skeys WHERE user_id = ?', user.id))?.keys || '{}') || {}; } catch (e) { names = {}; }
  }
  const p = phoneFacts(body, request);
  const stmts = keep.map((e) => env.DB.prepare(UPSERT + ' RETURNING id, fp, prio, alerted_at, state').bind(
    user.id, day, e.fp, e.prio, e.type, e.k, String(names[e.k] || '').slice(0, 40), e.c, e.n, e.at, e.last,
    p.app, p.os, p.model, p.net, p.asn, p.isp, JSON.stringify(e.d), muted(mute, e.fp, now) ? 'muted' : 'open'));
  const res = await env.DB.batch(stmts);
  const written = res.map((r) => (r.results || [])[0]).filter(Boolean);

  const urgent = written.filter((r) => r.prio === 1 && r.state === 'open' && r.alerted_at < now - LIMITS.alertGap);
  if (urgent.length) {
    const job = alert(env, user, p, urgent, keep, names).catch((e) => logError('health alert failed', e));
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  }
  return json({ ok: true, stored: keep.length, dropped: events.length - keep.length, mode });
}

const whoOf = (u) => String(u.tg_username ? '@' + u.tg_username : u.tg_id ? 'TG ' + u.tg_id : u.email || '#' + u.id).slice(0, 40);
const untrusted = (s) => String(s ?? '').replace(/\//g, '∕');
export function problemLabel(r) {
  const cause = r.cause ? (r.type === 'loc_mismatch' && r.cause.includes('>') ? r.cause.replace('>', ' → ') : CAUSE_FA[r.cause] || r.cause) : '';
  return [TYPE_FA[r.type] || r.type, r.exit_name || (r.exit_key ? r.exit_key : ''), cause].filter(Boolean).map(untrusted).join(' · ');
}

// P1: one Telegram message for the batch. The same problem (any user) is told at most once in LIMITS.alertGap,
// and at most LIMITS.alertsPerDay problems are told a day; the rest wait in the bot.
async function alert(env, user, p, urgent, events, names) {
  const now = nowSec();
  const recent = await all(env, 'SELECT fp, alerted_at FROM health_events WHERE day >= ? AND alerted_at > ?', dayOf(now) - 1, now - 86400);
  const sentFps = new Set(recent.filter((r) => r.alerted_at > now - LIMITS.alertGap).map((r) => r.fp));
  let room = LIMITS.alertsPerDay - new Set(recent.map((r) => r.fp)).size;
  const pick = [];
  for (const r of urgent) { if (room <= 0) break; if (sentFps.has(r.fp)) continue; sentFps.add(r.fp); pick.push(r); room--; }
  if (!pick.length) return;
  await run(env, `UPDATE health_events SET alerted_at = ? WHERE id IN (${pick.map(() => '?').join(',')})`, now, ...pick.map((r) => r.id));
  const byFp = new Map(events.map((e) => [e.fp, e]));
  const lines = pick.map((r) => { const e = byFp.get(r.fp) || {}; return `• ${problemLabel({ type: e.type, exit_name: names[e.k] || '', exit_key: e.k, cause: e.c })}${e.n > 1 ? ` (${fa(e.n)} بار)` : ''}`; });
  const text = ['🚨 گزارش بحرانی از اپ Pleat', `👤 ${untrusted(whoOf(user))} · Pleat ${p.app || '?'} · ${untrusted(p.os || 'Android ?')}${p.model ? ' · ' + untrusted(p.model) : ''}`, '', ...lines].join('\n');
  const kb = { inline_keyboard: [...pick.slice(0, 3).map((r) => [b(`🩺 جزئیات ${TYPE_FA[byFp.get(r.fp)?.type] || ''}`.slice(0, 40), `m:he:${r.fp}`)]), [b('🩺 سلامت اپ', 'm:hl')]] };
  const { notifyAdmin } = await import('./telegram.js');
  await notifyAdmin(env, text, kb);
}

// What the Worker sees itself on /me/ip?k=: the exit's real country against the country its name gives.
// Iran means the request did not go out through a foreign exit at all. One upsert, at most once per connect.
export async function checkExitCountry(env, user, request, key, cc) {
  if (!KEY_RE.test(String(key || '')) || !/^[A-Z]{2}$/.test(String(cc || ''))) return false;
  const row = await first(env, 'SELECT keys FROM user_skeys WHERE user_id = ?', user.id);
  let name = '';
  try { name = String(JSON.parse(row?.keys || '{}')[key] || ''); } catch (e) { name = ''; }
  if (!name) return false;
  const { countryFromRemark } = await import('./countries.js');
  const expected = countryFromRemark(name);
  let type, cause;
  if (cc === 'IR') { type = 'exit_iran'; cause = 'ir'; }
  else if (expected && expected !== cc) { type = 'loc_mismatch'; cause = `${expected}>${cc}`.toLowerCase(); }
  else return false;
  const now = nowSec();
  const fp = fingerprint(type, key, cause);
  const { mode, mute } = await healthSettings(env);
  if (mode === 'off') return false;
  const p = phoneFacts({}, request);
  const d = { expected: expected || '?', actual: cc };
  await run(env, UPSERT + ` WHERE health_events.writes < ${LIMITS.writes}`, user.id, dayOf(now), fp, TYPES[type], type, key, name.slice(0, 40), cause, 1, now, now,
    '', '', '', '', p.asn, p.isp, JSON.stringify(d), muted(mute, fp, now) ? 'muted' : 'open');
  return true;
}

// daily cron: rows older than LIMITS.keepDays, and resolved / muted ones after LIMITS.resolvedDays
export async function prune(env) {
  const now = nowSec();
  await run(env, "DELETE FROM health_events WHERE day < ? OR (state != 'open' AND last_at < ?)", dayOf(now) - LIMITS.keepDays, now - LIMITS.resolvedDays * 86400);
}

// one line for the daily report
export async function dailyLine(env) {
  const now = nowSec();
  const rows = await all(env, "SELECT prio, COUNT(DISTINCT fp) n FROM health_events WHERE day >= ? AND last_at >= ? AND state = 'open' AND prio < 4 GROUP BY prio", dayOf(now) - 1, now - 86400);
  const n = Object.fromEntries(rows.map((r) => [r.prio, r.n]));
  return `🩺 سلامت اپ (۲۴ ساعت): 🔴 ${fa(n[1] || 0)} · 🟠 ${fa(n[2] || 0)} · 🟡 ${fa(n[3] || 0)}`;
}

// ---------------- admin actions (admin-actions.js calls these) ----------------
export async function resolve(env, fp) {
  if (!FP_RE.test(String(fp))) return 0;
  return (await run(env, "UPDATE health_events SET state = 'resolved' WHERE fp = ? AND state = 'open'", fp)).meta.changes || 0;
}
export async function reopen(env, fp, ids) {
  if (!FP_RE.test(String(fp)) || !Array.isArray(ids) || !ids.length) return false;
  await run(env, `UPDATE health_events SET state = 'open' WHERE fp = ? AND state = 'resolved' AND id IN (${ids.map(() => '?').join(',')})`, fp, ...ids.map((x) => parseInt(x, 10) || 0));
  return true;
}
export async function setMute(env, fp, on, days = 7) {
  if (!FP_RE.test(String(fp))) return null;
  const now = nowSec();
  const { mute } = await healthSettings(env);
  const before = mute[fp] || 0;
  for (const [k, t] of Object.entries(mute)) if (t <= now) delete mute[k];
  if (on) mute[fp] = now + days * 86400; else delete mute[fp];
  const keys = Object.keys(mute);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete mute[k];
  await run(env, "INSERT INTO settings (key, value) VALUES ('health_mute', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(mute));
  await run(env, `UPDATE health_events SET state = ? WHERE fp = ? AND state = ?`, on ? 'muted' : 'open', fp, on ? 'open' : 'muted');
  return { before };
}
export async function setMode(env, mode) {
  if (!MODES.includes(mode)) return null;
  const before = (await healthSettings(env)).mode;
  await run(env, "INSERT INTO settings (key, value) VALUES ('health_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", mode);
  return { before };
}

// ---------------- bot screens (read only) ----------------
export const MODE_FA = { all: 'همه', p2: 'فقط بحرانی و مهم', off: 'خاموش' };
const DAYS = 7;
const since = () => dayOf(nowSec()) - DAYS + 1;
const ago = (t, now = nowSec()) => (!t ? '—' : now - t < 3600 ? `${fa(Math.max(1, Math.round((now - t) / 60)))} دقیقه پیش` : now - t < 172800 ? `${fa(Math.round((now - t) / 3600))} ساعت پیش` : `${fa(Math.round((now - t) / 86400))} روز پیش`);
const T = (...p) => crumb('🩺 سلامت اپ', ...p);

export async function screenHome(env) {
  const now = nowSec();
  const rows = await all(env, `SELECT prio, COUNT(DISTINCT fp) p7, SUM(count) c7, COUNT(DISTINCT CASE WHEN last_at >= ?2 THEN fp END) p1,
      SUM(CASE WHEN last_at >= ?2 THEN count ELSE 0 END) c1 FROM health_events WHERE day >= ?1 AND state = 'open' GROUP BY prio`, since(), now - 86400);
  const phones = await first(env, 'SELECT COUNT(DISTINCT user_id) u FROM health_events WHERE day >= ?', since());
  const by = Object.fromEntries(rows.map((r) => [r.prio, r]));
  const g = (p, k) => fa((by[p] && by[p][k]) || 0);
  const { mode } = await healthSettings(env);
  const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
  return {
    text: [T(), '',
      'گزارش‌هایی که اپ Pleat خودکار از گوشی کاربرها می‌فرستد. عدد = مشکل‌های باز (بار تکرار).', '',
      `۲۴ ساعت: 🔴 ${g(1, 'p1')} (${g(1, 'c1')}) · 🟠 ${g(2, 'p1')} (${g(2, 'c1')}) · 🟡 ${g(3, 'p1')} (${g(3, 'c1')})`,
      `۷ روز: 🔴 ${g(1, 'p7')} (${g(1, 'c7')}) · 🟠 ${g(2, 'p7')} (${g(2, 'c7')}) · 🟡 ${g(3, 'p7')} (${g(3, 'c7')})`,
      `کاربرهای گزارش‌دهنده (۷ روز): ${fa(phones ? phones.u : 0)}`, '',
      `ارسال از اپ: ${MODE_FA[mode]}`,
      '🔴 موارد بحرانی همان لحظه در همین چت خبر داده می‌شوند.'].join('\n'),
    kb: [
      [b(`🔴 بحرانی (${g(1, 'p7')})`, 'm:hlp:1'), b(`🟠 مهم (${g(2, 'p7')})`, 'm:hlp:2')],
      [b(`🟡 متوسط (${g(3, 'p7')})`, 'm:hlp:3'), b('⚪ خلاصه‌های روزانه', 'm:hlp:4')],
      [b('🖥 بر اساس سرور', 'm:hlk'), b('👥 بر اساس کاربر', 'm:hlu')],
      [b('📱 نسخه‌ها و گوشی‌ها', 'm:hlv')],
      [b(`⚙️ ارسال: ${MODE_FA[mode]} ← ${MODE_FA[next]}`, `m:hlm:${next}`)],
      nav('home'),
    ],
  };
}

// problems (grouped by fp over 7 days) for a filter: one priority, one server or one user
async function problems(env, where, args) {
  return all(env, `SELECT fp, MIN(prio) prio, MAX(type) type, MAX(exit_key) exit_key, MAX(exit_name) exit_name, MAX(cause) cause,
      SUM(count) c, COUNT(DISTINCT user_id) u, MAX(last_at) last FROM health_events
    WHERE day >= ? AND state = 'open' AND ${where} GROUP BY fp ORDER BY prio, last DESC LIMIT 10`, since(), ...args);
}
function problemList(list, title, back, extra = []) {
  const lines = list.map((r, i) => `${i + 1}. ${problemLabel(r)}\n    ${fa(r.c)} بار · ${fa(r.u)} کاربر · آخرین: ${ago(r.last)}`);
  return {
    text: [title, '', ...(lines.length ? lines : ['✅ در ۷ روز اخیر مشکل بازی نیست.']), ...(lines.length ? ['', 'روی هر مورد بزن تا گوشی‌ها، نسخه‌ها و متن خطا را ببینی.'] : [])].join('\n'),
    kb: [...list.map((r, i) => [b(`${i + 1}. ${problemLabel(r)}`.slice(0, 60), `m:he:${r.fp}`)]), ...extra, nav(back)],
  };
}

export async function screenPrio(env, prio) {
  const p = [1, 2, 3, 4].includes(prio) ? prio : 1;
  return problemList(await problems(env, 'prio = ?', [p]), T(PRIO_FA[p]), 'hl');
}

export async function screenServers(env, key) {
  if (key) {
    if (!KEY_RE.test(key)) return { text: T('🖥 سرورها') + '\n\nپیدا نشد.', kb: [nav('hlk')] };
    const list = await problems(env, 'exit_key = ?', [key]);
    return problemList(list, T('🖥 سرورها', untrusted((list[0] && list[0].exit_name) || key)), 'hlk', [[b('📊 این سرور روی اپراتورها', `m:nsv:${key}`)]]);
  }
  const rows = await all(env, `SELECT exit_key, MAX(exit_name) name, SUM(count) c, COUNT(DISTINCT user_id) u, COUNT(DISTINCT fp) n, MIN(prio) top
    FROM health_events WHERE day >= ? AND state = 'open' AND exit_key != '' AND prio < 4 GROUP BY exit_key ORDER BY top, c DESC LIMIT 10`, since());
  const lines = rows.map((r) => `${PRIO_FA[r.top].split(' ')[0]} ${untrusted(r.name || r.exit_key)} — ${fa(r.n)} مشکل · ${fa(r.c)} بار · ${fa(r.u)} کاربر`);
  return {
    text: [T('🖥 بر اساس سرور'), '', ...(lines.length ? lines : ['در ۷ روز اخیر هیچ سروری مشکل باز ندارد.'])].join('\n'),
    kb: [...rows.map((r) => [b(untrusted(r.name || r.exit_key).slice(0, 40), `m:hlk:${r.exit_key}`)]), nav('hl')],
  };
}

export async function screenUsers(env, uid) {
  if (uid) {
    const u = await first(env, 'SELECT id, email, tg_username, tg_id FROM users WHERE id = ?', uid);
    const name = u ? whoOf(u) : `#${uid}`;
    return problemList(await problems(env, 'user_id = ?', [uid]), T('👥 کاربران', untrusted(name)), 'hlu', u ? [[b('👤 کارت کاربر', `m:u:${uid}`)]] : []);
  }
  const rows = await all(env, `SELECT h.user_id, u.email, u.tg_username, u.tg_id, MIN(h.prio) top, SUM(h.count) c, COUNT(DISTINCT h.fp) n,
      MAX(h.app_ver) app, MAX(h.model) model FROM health_events h LEFT JOIN users u ON u.id = h.user_id
    WHERE h.day >= ? AND h.state = 'open' AND h.prio < 4 GROUP BY h.user_id ORDER BY top, c DESC LIMIT 10`, since());
  const name = (r) => untrusted(r.email || r.tg_id ? whoOf({ ...r, id: r.user_id }) : `#${r.user_id} (حذف‌شده)`);
  const lines = rows.map((r) => `${PRIO_FA[r.top].split(' ')[0]} ${name(r)} — ${fa(r.n)} مشکل · ${fa(r.c)} بار${r.app ? ` · Pleat ${r.app}` : ''}${r.model ? ` · ${untrusted(r.model)}` : ''}`);
  return {
    text: [T('👥 بر اساس کاربر'), '', ...(lines.length ? lines : ['در ۷ روز اخیر از هیچ کاربری مشکل بازی نرسیده.'])].join('\n'),
    kb: [...rows.map((r) => [b(name(r).slice(0, 40), `m:hlu:${r.user_id}`)]), nav('hl')],
  };
}

export async function screenVersions(env) {
  const q = (col) => all(env, `SELECT ${col} v, COUNT(DISTINCT user_id) u, SUM(CASE WHEN prio = 1 THEN count ELSE 0 END) crit
    FROM health_events WHERE day >= ? AND ${col} != '' GROUP BY ${col} ORDER BY u DESC, v DESC LIMIT 8`, since());
  const [apps, oses, models] = [await q('app_ver'), await q('os'), await q('model')];
  const line = (r) => `▪️ ${untrusted(r.v)} — ${fa(r.u)} کاربر${r.crit ? ` · 🔴 ${fa(r.crit)}` : ''}`;
  return {
    text: [T('📱 نسخه‌ها و گوشی‌ها'), '', 'نسخه‌ی اپ:', ...(apps.length ? apps.map(line) : ['—']), '', 'اندروید:', ...(oses.length ? oses.map(line) : ['—']), '',
      'مدل گوشی:', ...(models.length ? models.map(line) : ['—']), '', '🔴 = تعداد رویدادهای بحرانی در ۷ روز.'].join('\n'),
    kb: [nav('hl')],
  };
}

export async function screenEvent(env, fp) {
  if (!FP_RE.test(String(fp || ''))) return { text: T() + '\n\nپیدا نشد.', kb: [nav('hl')] };
  const rows = await all(env, `SELECT h.*, u.email, u.tg_username, u.tg_id FROM health_events h LEFT JOIN users u ON u.id = h.user_id
    WHERE h.fp = ? AND h.day >= ? ORDER BY h.last_at DESC LIMIT 30`, fp, since());
  if (!rows.length) return { text: T() + '\n\nاین مورد در ۷ روز اخیر دیگر نیست (پاک شده).', kb: [nav('hl')] };
  const top = rows[0];
  const set = (f) => [...new Set(rows.map(f).filter(Boolean))].slice(0, 6).map(untrusted).join('، ') || '—';
  const total = rows.reduce((s, r) => s + r.count, 0);
  const users = [...new Map(rows.map((r) => [r.user_id, r])).values()];
  let d = {};
  try { d = JSON.parse(top.detail || '{}'); } catch (e) { d = {}; }
  const val = (v) => (Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? Object.entries(x).map(([k, y]) => `${k}=${y}`).join(' ') : x)).join(' | ') : typeof v === 'boolean' ? (v ? 'بله' : 'نه') : v);
  const detail = Object.entries(d).map(([k, v]) => `• ${DETAIL_FA[k] || k}: ${untrusted(val(v))}`);
  const state = rows.some((r) => r.state === 'open') ? 'open' : rows.some((r) => r.state === 'muted') ? 'muted' : 'resolved';
  const lines = [T(PRIO_FA[top.prio], problemLabel(top)), '',
    `${PRIO_FA[top.prio]} — ${problemLabel(top)}`,
    `وضعیت: ${state === 'open' ? '🟢 باز' : state === 'muted' ? '🔇 بی‌صدا' : '✅ رسیدگی‌شده'}`,
    `تکرار: ${fa(total)} بار · ${fa(users.length)} کاربر · اولین: ${ago(Math.min(...rows.map((r) => r.first_at)))} · آخرین: ${ago(top.last_at)}`, '',
    `👥 کاربرها: ${users.slice(0, 5).map((r) => untrusted(r.email || r.tg_id ? whoOf({ ...r, id: r.user_id }) : '#' + r.user_id)).join('، ')}${users.length > 5 ? ' …' : ''}`,
    `📲 نسخه: ${set((r) => r.app_ver)}`, `🤖 اندروید: ${set((r) => r.os)}`, `📱 گوشی: ${set((r) => r.model)}`,
    `📶 شبکه: ${set((r) => r.isp)}${rows.some((r) => r.net) ? ` (${set((r) => ({ wifi: 'وای‌فای', cell: 'دیتا', other: 'دیگر' })[r.net])})` : ''}`,
    ...(detail.length ? ['', 'آخرین گزارش:', ...detail] : [])];
  const kb = [];
  if (state === 'open') kb.push([b('✅ رسیدگی شد', `m:her:${fp}`), b('🔇 بی‌صدا ۷ روز', `m:hem:${fp}:1`)]);
  else if (state === 'muted') kb.push([b('🔔 دوباره نشان بده', `m:hem:${fp}:0`)]);
  if (top.exit_key) kb.push([b('🖥 همه‌ی مشکل‌های این سرور', `m:hlk:${top.exit_key}`)]);
  if (users.length === 1) kb.push([b('👤 کارت کاربر', `m:u:${users[0].user_id}`)]);
  kb.push(nav(`hlp:${top.prio}`));
  return { text: lines.join('\n'), kb };
}
