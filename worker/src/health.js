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
  alertGap: 6 * 3600, alertsPerDay: 20, keepDays: 14, resolvedDays: 3, detailBytes: 1000,
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
  sessions: 'جلسه', ok: 'موفق', fail: 'ناموفق', minutes: 'دقیقه‌ی وصل', moved: 'شبکه عوض شد', status: 'کد', what: 'توضیح اندروید',
  // a native crash (Pleat 1.2.38+): what the crash itself said, and what the tunnel was doing
  sig: 'سیگنال', go: 'panic هسته (Go)', abort: 'پیام abort', cause: 'علت', thread: 'رشته (thread)', lib: 'کتابخانه', frames: 'فریم‌ها',
  op: 'تانل در حال', up_s: 'ثانیه وصل بود', tomb: 'tombstone اندروید', stderr: 'stderr هسته', pss: 'حافظه‌ی اپ (MB)', earlier: 'کرش قبلی، دوباره خوانده شد',
};
// ApplicationExitInfo.REASON_* (Android 11+): why Android says the process ended
const EXIT_REASON_FA = {
  0: 'نامشخص', 1: 'خود اپ بست', 2: 'سیگنال سیستم', 3: 'کمبود حافظه (LMK)', 4: 'کرش اپ (Java/Kotlin)', 5: 'کرش native (هسته/کتابخانه‌ی C/Go)',
  6: 'هنگ (ANR)', 7: 'شروع ناموفق', 8: 'تغییر مجوز', 9: 'مصرف بیش از حد', 10: 'کاربر بست', 11: 'کاربر متوقف کرد', 12: 'وابستگی مرد',
  13: 'دیگر', 14: 'فریزر', 15: 'تغییر بسته', 16: 'به‌روزرسانی اپ',
};
const SIGNAL_FA = {
  6: 'SIGABRT — abort عمدی (panic هسته‌ی Go، یا fdsan/libc)', 11: 'SIGSEGV — دسترسی نامعتبر به حافظه', 7: 'SIGBUS — خطای حافظه',
  4: 'SIGILL — دستور نامعتبر', 5: 'SIGTRAP — توقف (assert/trap)', 8: 'SIGFPE — خطای محاسبه', 9: 'SIGKILL — کشته شد', 31: 'SIGSYS — syscall ممنوع',
};
const OP_FA = { starting: 'وصل‌شدن', up: 'وصل', stopping: 'قطع‌کردن', off: 'خاموش' };
// a value in words where the phone sends a number or a code word
function detailValue(k, v, d) {
  if (k === 'reason' && EXIT_REASON_FA[v] !== undefined) return `${v} = ${EXIT_REASON_FA[v]}`;
  if (k === 'status' && d.reason === 5 && SIGNAL_FA[v]) return `${v} = ${SIGNAL_FA[v]}`;
  if (k === 'status' && d.reason === 2 && SIGNAL_FA[v]) return `${v} = ${SIGNAL_FA[v].split(' — ')[0]}`;
  if (k === 'op' && OP_FA[v]) return OP_FA[v];
  if (k === 'stderr' && /^quiet/.test(String(v))) return `${v} = هسته‌ی Go چیزی ننوشت`;
  if (k === 'stderr' && /^not captured/.test(String(v))) return `${v} = ضبط نشده بود`;
  if (k === 'tomb' && v === 'none') return 'none = اندروید چیزی نگه نداشته';
  if (k === 'tomb' && /^error/.test(String(v))) return `${v} = خواندنش ناموفق بود`;
  if (k === 'tomb' && /unread/.test(String(v))) return `${v} = بود ولی Pleat نتوانست بخواند`;
  return v;
}
// A native crash in one line of plain words, from what the phone sent. Before 1.2.38 only the signal is known.
// A native crash in one line of plain words, from what the phone sent. Before 1.2.38 only the signal is known.
// crashKind gives the reading as a code (the Mini App words it in English); crashGuess words it for the bot.
export function crashKind(d) {
  const abort = String(d.abort || '');
  if (d.go) return 'go_panic';
  if (/^fdsan/i.test(abort)) return 'fdsan';
  if (/libhev/.test(d.lib || '')) return 'hev';
  if (/libgojni/.test(d.lib || '')) return 'xray_lib';
  if (/libflutter|libapp/.test(d.lib || '')) return 'flutter';
  if (abort) return 'c_abort';
  if (/^quiet/.test(String(d.stderr || ''))) return 'not_go';
  // re-read from Android's history: details only if Android still kept the crash's tombstone
  if (d.earlier) return 'earlier';
  if (d.tomb === 'none') return 'no_tombstone';
  if (d.reason === 5 && d.status === 6) return 'sigabrt';
  if (d.reason === 5 && d.status === 11) return 'sigsegv';
  return '';
}
const CRASH_FA = {
  go_panic: 'هسته‌ی Xray (کد Go) panic کرد؛ متنش در «panic هسته» است. ربطش به سرور/پروتکل را از «پروتکل» ببین.',
  fdsan: 'یک fd دوبار بسته شد (fdsan) — باگ سمت اپ در بستن tun/سوکت، نه سرور.',
  hev: 'کرش در لایه‌ی تانل (hev-socks5-tunnel)، نه هسته‌ی Xray.',
  xray_lib: 'کرش در هسته‌ی Xray (کتابخانه‌ی Go).',
  flutter: 'کرش در موتور نمایش اپ (Flutter)، نه هسته یا سرور.',
  c_abort: 'کتابخانه‌ی C خودش abort کرد؛ «پیام abort» علت را می‌گوید.',
  not_go: 'panic هسته‌ی Go نبوده: Go پیش از هر panic در stderr می‌نویسد و این بار چیزی ننوشت. منبع باید fdsan/libc، لایه‌ی تانل (hev)، یا موتور Flutter باشد.',
  earlier: 'کرش قدیمی (از قبل از به‌روزرسانی) که دوباره خوانده شد، ولی اندروید جزئیاتش را نگه نداشته بود. علتش از همین گزارش معلوم نمی‌شود؛ کرش بعدی روی 1.2.38+ متن panic، کتابخانه و سرور را می‌آورد.',
  no_tombstone: 'اندروید برای این کرش tombstone نگه نداشته؛ اگر panic هسته‌ی Go بود، «panic هسته» باید پر باشد و نیست.',
  sigabrt: 'abort عمدی: یا panic هسته‌ی Go (Xray)، یا fdsan/libc، یا موتور Flutter. این نسخه بیش از این نفرستاده؛ از Pleat 1.2.38 متن panic، کتابخانه و پروتکل هم می‌آید.',
  sigsegv: 'دسترسی نامعتبر به حافظه در کد native (C)؛ کد Go چنین خطایی را به panic و SIGABRT تبدیل می‌کند.',
};
export const crashGuess = (d) => CRASH_FA[crashKind(d)] || '';

// the same 8 hex for the same problem on every phone, so the bot can group them
export function fingerprint(type, k, c) {
  let h = 0x811c9dc5;
  for (const ch of `${type}|${k}|${c}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'f' + h.toString(16).padStart(8, '0');
}

// Package names that look like domains but are code (a trace frame), and file endings ("xray_config.dart").
const CODE_PREFIX = /^(java|javax|android|androidx|kotlin|kotlinx|dalvik|io\.flutter|app\.pleat|libv2ray|go|com\.android|com\.google\.android|dart|org\.json)\./i;
const FILE_EXT = /\.(dart|kt|java|so|go|c|cc|h|js)$/i;

// A native crash's library and function names: links, ids, e-mails and IPs go, but "runtime.raise" or a long C
// function name is neither a host nor a key and stays. Same rule as the app's scrubCode().
export function scrubCode(v, max = 400) {
  let s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  s = s
    .replace(/\b[a-z][a-z0-9+.-]{1,15}:\/\/\S+/gi, '<link>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>');
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

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
    else if (typeof v === 'string') {
      const t = k === 'frames' ? scrubCode(v, 400) : scrub(v, k === 'trace' ? 400 : k === 'go' ? 300 : 160);
      if (t) out[k] = t;
    }
    else if (Array.isArray(v)) out[k] = v.slice(0, 6).map((x) => (x && typeof x === 'object' ? cleanFlat(x) : scrub(x, 32)));
  }
  while (bytes(JSON.stringify(out)) > LIMITS.detailBytes) {
    if (typeof out.trace === 'string' && out.trace.length > 40) { out.trace = out.trace.slice(0, Math.floor(out.trace.length * 0.6)); continue; }
    if (typeof out.frames === 'string' && out.frames.length > 40) { out.frames = out.frames.slice(0, Math.floor(out.frames.length * 0.6)); continue; }
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

// ---------------- the reports as data: the bot screens below and the Mini App (admin-api.js) ----------------
const counts = (by, p) => ({ open24: (by[p] && by[p].p1) || 0, count24: (by[p] && by[p].c1) || 0, open7: (by[p] && by[p].p7) || 0, count7: (by[p] && by[p].c7) || 0 });

// open problems per priority (24 hours and 7 days), how many phones reported, the sending mode, and one row a day
export async function summaryData(env) {
  const now = nowSec(), from = since();
  const rows = await all(env, `SELECT prio, COUNT(DISTINCT fp) p7, SUM(count) c7, COUNT(DISTINCT CASE WHEN last_at >= ?2 THEN fp END) p1,
      SUM(CASE WHEN last_at >= ?2 THEN count ELSE 0 END) c1 FROM health_events WHERE day >= ?1 AND state = 'open' GROUP BY prio`, from, now - 86400);
  const phones = await first(env, 'SELECT COUNT(DISTINCT user_id) u FROM health_events WHERE day >= ?', from);
  const perDay = await all(env, 'SELECT day, prio, SUM(count) c FROM health_events WHERE day >= ? AND prio < 4 GROUP BY day, prio', from);
  const { mode } = await healthSettings(env);
  const by = Object.fromEntries(rows.map((r) => [r.prio, r]));
  const days = Array.from({ length: DAYS }, (_, i) => {
    const d = from + i;
    const c = (p) => perDay.filter((r) => r.day === d && r.prio === p).reduce((a, r) => a + r.c, 0);
    return { day: d * 86400, p1: c(1), p2: c(2), p3: c(3) };
  });
  return { days_back: DAYS, mode, modes: MODES, phones: phones ? phones.u : 0, prio: { 1: counts(by, 1), 2: counts(by, 2), 3: counts(by, 3), 4: counts(by, 4) }, days };
}

// problems (grouped by fp over 7 days) for a filter: one priority, one server or one user
async function problems(env, where, args) {
  return all(env, `SELECT fp, MIN(prio) prio, MAX(type) type, MAX(exit_key) exit_key, MAX(exit_name) exit_name, MAX(cause) cause,
      SUM(count) c, COUNT(DISTINCT user_id) u, MAX(last_at) last FROM health_events
    WHERE day >= ? AND state = 'open' AND ${where} GROUP BY fp ORDER BY prio, last DESC LIMIT 10`, since(), ...args);
}
const problemOut = (r) => ({ fp: r.fp, prio: r.prio, type: r.type, exit_key: r.exit_key || null, exit_name: r.exit_name || null, cause: r.cause || null, count: r.c, users: r.u, last: r.last });
// {prio} | {server: exit key} | {user: id}; null when the filter is not valid
export async function problemsData(env, { prio, server, user } = {}) {
  if (server) {
    if (!KEY_RE.test(String(server))) return null;
    const list = await problems(env, 'exit_key = ?', [server]);
    return { filter: 'server', server, name: (list[0] && list[0].exit_name) || null, problems: list.map(problemOut) };
  }
  if (user) {
    const uid = parseInt(user, 10);
    if (!(uid > 0)) return null;
    const u = await first(env, 'SELECT id, email, tg_username, tg_id FROM users WHERE id = ?', uid);
    return { filter: 'user', user: uid, name: u ? whoOf(u) : null, problems: (await problems(env, 'user_id = ?', [uid])).map(problemOut) };
  }
  const p = [1, 2, 3, 4].includes(parseInt(prio, 10)) ? parseInt(prio, 10) : 1;
  return { filter: 'prio', prio: p, problems: (await problems(env, 'prio = ?', [p])).map(problemOut) };
}

// servers with open problems (7 days), worst first
export async function serversData(env) {
  const rows = await all(env, `SELECT exit_key, MAX(exit_name) name, SUM(count) c, COUNT(DISTINCT user_id) u, COUNT(DISTINCT fp) n, MIN(prio) top
    FROM health_events WHERE day >= ? AND state = 'open' AND exit_key != '' AND prio < 4 GROUP BY exit_key ORDER BY top, c DESC LIMIT 10`, since());
  return rows.map((r) => ({ key: r.exit_key, name: r.name || r.exit_key, top: r.top, problems: r.n, count: r.c, users: r.u }));
}

// users with open problems (7 days), worst first
export async function usersData(env) {
  const rows = await all(env, `SELECT h.user_id, u.email, u.tg_username, u.tg_id, MIN(h.prio) top, SUM(h.count) c, COUNT(DISTINCT h.fp) n,
      MAX(h.app_ver) app, MAX(h.model) model FROM health_events h LEFT JOIN users u ON u.id = h.user_id
    WHERE h.day >= ? AND h.state = 'open' AND h.prio < 4 GROUP BY h.user_id ORDER BY top, c DESC LIMIT 10`, since());
  return rows.map((r) => ({ id: r.user_id, name: r.email || r.tg_id ? whoOf({ ...r, id: r.user_id }) : null, deleted: !(r.email || r.tg_id),
    top: r.top, problems: r.n, count: r.c, app: r.app || null, model: r.model || null }));
}

// app versions, Android versions and phone models that reported (7 days)
export async function versionsData(env) {
  const q = (col) => all(env, `SELECT ${col} v, COUNT(DISTINCT user_id) u, SUM(CASE WHEN prio = 1 THEN count ELSE 0 END) crit
    FROM health_events WHERE day >= ? AND ${col} != '' GROUP BY ${col} ORDER BY u DESC, v DESC LIMIT 8`, since());
  const [apps, oses, models] = [await q('app_ver'), await q('os'), await q('model')];
  const out = (r) => ({ name: r.v, users: r.u, critical: r.crit });
  return { apps: apps.map(out), os: oses.map(out), models: models.map(out) };
}

// one problem: who, which versions and phones, the last report's details and, for a native crash, its reading
export async function problemData(env, fp) {
  if (!FP_RE.test(String(fp || ''))) return null;
  const rows = await all(env, `SELECT h.*, u.email, u.tg_username, u.tg_id FROM health_events h LEFT JOIN users u ON u.id = h.user_id
    WHERE h.fp = ? AND h.day >= ? ORDER BY h.last_at DESC LIMIT 30`, fp, since());
  if (!rows.length) return { fp, gone: true };
  const top = rows[0];
  const set = (f) => [...new Set(rows.map(f).filter(Boolean))].slice(0, 6);
  const users = [...new Map(rows.map((r) => [r.user_id, r])).values()];
  let d = {};
  try { d = JSON.parse(top.detail || '{}'); } catch (e) { d = {}; }
  return {
    fp, gone: false, prio: top.prio, type: top.type, exit_key: top.exit_key || null, exit_name: top.exit_name || null, cause: top.cause || null,
    state: rows.some((r) => r.state === 'open') ? 'open' : rows.some((r) => r.state === 'muted') ? 'muted' : 'resolved',
    total: rows.reduce((a, r) => a + r.count, 0), first: Math.min(...rows.map((r) => r.first_at)), last: top.last_at,
    users: users.map((r) => ({ id: r.user_id, name: r.email || r.tg_id ? whoOf({ ...r, id: r.user_id }) : null })),
    apps: set((r) => r.app_ver), os: set((r) => r.os), models: set((r) => r.model), isps: set((r) => r.isp), nets: set((r) => r.net),
    detail: d, crash: top.type === 'crash' && top.cause === 'native' ? crashKind(d) || null : null,
  };
}

// ---------------- bot screens from the data ----------------
export async function screenHome(env) {
  const h = await summaryData(env);
  const g = (p, k) => fa(h.prio[p][k]);
  const mode = h.mode;
  const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
  return {
    text: [T(), '',
      'گزارش‌هایی که اپ Pleat خودکار از گوشی کاربرها می‌فرستد. عدد = مشکل‌های باز (بار تکرار).', '',
      `۲۴ ساعت: 🔴 ${g(1, 'open24')} (${g(1, 'count24')}) · 🟠 ${g(2, 'open24')} (${g(2, 'count24')}) · 🟡 ${g(3, 'open24')} (${g(3, 'count24')})`,
      `۷ روز: 🔴 ${g(1, 'open7')} (${g(1, 'count7')}) · 🟠 ${g(2, 'open7')} (${g(2, 'count7')}) · 🟡 ${g(3, 'open7')} (${g(3, 'count7')})`,
      `کاربرهای گزارش‌دهنده (۷ روز): ${fa(h.phones)}`, '',
      `ارسال از اپ: ${MODE_FA[mode]}`,
      '🔴 موارد بحرانی همان لحظه در همین چت خبر داده می‌شوند.'].join('\n'),
    kb: [
      [b(`🔴 بحرانی (${g(1, 'open7')})`, 'm:hlp:1'), b(`🟠 مهم (${g(2, 'open7')})`, 'm:hlp:2')],
      [b(`🟡 متوسط (${g(3, 'open7')})`, 'm:hlp:3'), b('⚪ خلاصه‌های روزانه', 'm:hlp:4')],
      [b('🖥 بر اساس سرور', 'm:hlk'), b('👥 بر اساس کاربر', 'm:hlu')],
      [b('📱 نسخه‌ها و گوشی‌ها', 'm:hlv')],
      [b(`⚙️ ارسال: ${MODE_FA[mode]} ← ${MODE_FA[next]}`, `m:hlm:${next}`)],
      nav('home'),
    ],
  };
}

function problemList(list, title, back, extra = []) {
  const lines = list.map((r, i) => `${i + 1}. ${problemLabel(r)}\n    ${fa(r.count)} بار · ${fa(r.users)} کاربر · آخرین: ${ago(r.last)}`);
  return {
    text: [title, '', ...(lines.length ? lines : ['✅ در ۷ روز اخیر مشکل بازی نیست.']), ...(lines.length ? ['', 'روی هر مورد بزن تا گوشی‌ها، نسخه‌ها و متن خطا را ببینی.'] : [])].join('\n'),
    kb: [...list.map((r, i) => [b(`${i + 1}. ${problemLabel(r)}`.slice(0, 60), `m:he:${r.fp}`)]), ...extra, nav(back)],
  };
}

export async function screenPrio(env, prio) {
  const d = await problemsData(env, { prio });
  return problemList(d.problems, T(PRIO_FA[d.prio]), 'hl');
}

export async function screenServers(env, key) {
  if (key) {
    const d = await problemsData(env, { server: key });
    if (!d) return { text: T('🖥 سرورها') + '\n\nپیدا نشد.', kb: [nav('hlk')] };
    return problemList(d.problems, T('🖥 سرورها', untrusted(d.name || key)), 'hlk', [[b('📊 این سرور روی اپراتورها', `m:nsv:${key}`)]]);
  }
  const rows = await serversData(env);
  const lines = rows.map((r) => `${PRIO_FA[r.top].split(' ')[0]} ${untrusted(r.name)} — ${fa(r.problems)} مشکل · ${fa(r.count)} بار · ${fa(r.users)} کاربر`);
  return {
    text: [T('🖥 بر اساس سرور'), '', ...(lines.length ? lines : ['در ۷ روز اخیر هیچ سروری مشکل باز ندارد.'])].join('\n'),
    kb: [...rows.map((r) => [b(untrusted(r.name).slice(0, 40), `m:hlk:${r.key}`)]), nav('hl')],
  };
}

export async function screenUsers(env, uid) {
  if (uid) {
    const d = await problemsData(env, { user: uid });
    return problemList(d.problems, T('👥 کاربران', untrusted(d.name || `#${uid}`)), 'hlu', d.name ? [[b('👤 کارت کاربر', `m:u:${uid}`)]] : []);
  }
  const rows = await usersData(env);
  const name = (r) => untrusted(r.deleted ? `#${r.id} (حذف‌شده)` : r.name);
  const lines = rows.map((r) => `${PRIO_FA[r.top].split(' ')[0]} ${name(r)} — ${fa(r.problems)} مشکل · ${fa(r.count)} بار${r.app ? ` · Pleat ${r.app}` : ''}${r.model ? ` · ${untrusted(r.model)}` : ''}`);
  return {
    text: [T('👥 بر اساس کاربر'), '', ...(lines.length ? lines : ['در ۷ روز اخیر از هیچ کاربری مشکل بازی نرسیده.'])].join('\n'),
    kb: [...rows.map((r) => [b(name(r).slice(0, 40), `m:hlu:${r.id}`)]), nav('hl')],
  };
}

export async function screenVersions(env) {
  const v = await versionsData(env);
  const line = (r) => `▪️ ${untrusted(r.name)} — ${fa(r.users)} کاربر${r.critical ? ` · 🔴 ${fa(r.critical)}` : ''}`;
  return {
    text: [T('📱 نسخه‌ها و گوشی‌ها'), '', 'نسخه‌ی اپ:', ...(v.apps.length ? v.apps.map(line) : ['—']), '', 'اندروید:', ...(v.os.length ? v.os.map(line) : ['—']), '',
      'مدل گوشی:', ...(v.models.length ? v.models.map(line) : ['—']), '', '🔴 = تعداد رویدادهای بحرانی در ۷ روز.'].join('\n'),
    kb: [nav('hl')],
  };
}

export async function screenEvent(env, fp) {
  const e = await problemData(env, fp);
  if (!e) return { text: T() + '\n\nپیدا نشد.', kb: [nav('hl')] };
  if (e.gone) return { text: T() + '\n\nاین مورد در ۷ روز اخیر دیگر نیست (پاک شده).', kb: [nav('hl')] };
  const list = (a) => a.map(untrusted).join('، ') || '—';
  const d = e.detail;
  const val = (v) => (Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? Object.entries(x).map(([k, y]) => `${k}=${y}`).join(' ') : x)).join(' | ') : typeof v === 'boolean' ? (v ? 'بله' : 'نه') : v);
  const detail = Object.entries(d).map(([k, v]) => `• ${DETAIL_FA[k] || k}: ${untrusted(val(detailValue(k, v, d)))}`);
  const guess = e.crash ? CRASH_FA[e.crash] : '';
  const label = problemLabel(e);
  const lines = [T(PRIO_FA[e.prio], label), '',
    `${PRIO_FA[e.prio]} — ${label}`,
    `وضعیت: ${e.state === 'open' ? '🟢 باز' : e.state === 'muted' ? '🔇 بی‌صدا' : '✅ رسیدگی‌شده'}`,
    `تکرار: ${fa(e.total)} بار · ${fa(e.users.length)} کاربر · اولین: ${ago(e.first)} · آخرین: ${ago(e.last)}`, '',
    `👥 کاربرها: ${e.users.slice(0, 5).map((u) => untrusted(u.name || '#' + u.id)).join('، ')}${e.users.length > 5 ? ' …' : ''}`,
    `📲 نسخه: ${list(e.apps)}`, `🤖 اندروید: ${list(e.os)}`, `📱 گوشی: ${list(e.models)}`,
    `📶 شبکه: ${list(e.isps)}${e.nets.length ? ` (${list(e.nets.map((n) => ({ wifi: 'وای‌فای', cell: 'دیتا', other: 'دیگر' })[n]))})` : ''}`,
    ...(detail.length ? ['', 'آخرین گزارش:', ...detail] : []),
    ...(guess ? ['', `🧭 برداشت: ${untrusted(guess)}`] : [])];
  const kb = [];
  if (e.state === 'open') kb.push([b('✅ رسیدگی شد', `m:her:${fp}`), b('🔇 بی‌صدا ۷ روز', `m:hem:${fp}:1`)]);
  else if (e.state === 'muted') kb.push([b('🔔 دوباره نشان بده', `m:hem:${fp}:0`)]);
  if (e.exit_key) kb.push([b('🖥 همه‌ی مشکل‌های این سرور', `m:hlk:${e.exit_key}`)]);
  if (e.users.length === 1) kb.push([b('👤 کارت کاربر', `m:u:${e.users[0].id}`)]);
  kb.push(nav(`hlp:${e.prio}`));
  return { text: lines.join('\n'), kb };
}
