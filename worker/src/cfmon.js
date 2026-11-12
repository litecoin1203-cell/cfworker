// ☁️ Cloudflare monitoring for the admin bot: how much of the Free plan's DAILY allowance is used (Worker
// requests, D1 rows read / written, database size), errors and CPU, the queries that cost the most, deploys,
// and an hourly alert before a limit is hit.
//
// Numbers come from three places, and each screen shows what it could reach and says what is missing:
//   1. Cloudflare's GraphQL Analytics API: needs the Worker secret CF_ANALYTICS_TOKEN (an API token with
//      Account › Account Analytics › Read; Account › Workers Scripts › Read adds the live version on the deploy
//      screen). The account id comes from CF_ACCOUNT_ID (the deploy workflow passes it) or from the token itself.
//   2. The Worker itself, with no token: database size (D1 reports it after every query), its own error log
//      (worker_errors, written by logError, throttled), the panel-sync cron's last run.
//   3. GitHub (public repo): the deploy and Pleat build runs, and what is merged but not deployed yet.
// Read-only except recordError (one throttled upsert per kind of error) and the alert state (only when it alerts).
import { first, all, run } from './db.js';
import { nowSec } from './util.js';

// the Free plan's daily allowance (resets 00:00 UTC = 03:30 Tehran)
export const LIMITS = { requests: 100000, rowsRead: 5000000, rowsWritten: 100000, dbBytes: 500 * 1024 ** 2, cpuMs: 10 };
const GQL = 'https://api.cloudflare.com/client/v4/graphql';
const CF_API = 'https://api.cloudflare.com/client/v4';
const UA = 'cloudgold-admin-monitor';
const scriptOf = (env) => (/^[\w-]{1,63}$/.test(env.CF_SCRIPT_NAME || '') ? env.CF_SCRIPT_NAME : 'cloudgold');
const repoOf = (env) => (/^[\w.-]+\/[\w.-]+$/.test(env.PLEAT_REPO || '') ? env.PLEAT_REPO : 'litecoin1203-cell/cfworker');
export const hasToken = (env) => !!String(env.CF_ANALYTICS_TOKEN || '').trim();

const fa = (n) => Number(n || 0).toLocaleString('en-US');
const b = (text, data) => ({ text, callback_data: String(data).slice(0, 64) });
const HOME = b('🏠 منوی اصلی', 'm:home');
const nav = (back) => (back && back !== 'home' ? [b('🔙 برگشت', 'm:' + back), HOME] : [HOME]);
const crumb = (...parts) => ['🏠 منو', '☁️ کلودفلر', ...parts].join(' › ');

// ---------------- small helpers ----------------
const DAY = 86400;
const dayStart = (t = nowSec()) => t - (t % DAY);
const ymd = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
// Tehran is UTC+3:30 all year (no daylight saving since 2022)
const tehran = (t) => new Date((t + 12600) * 1000).toISOString().slice(11, 16);
const ago = (t, now = nowSec()) => (!t ? 'هرگز' : now - t < 120 ? `${fa(now - t)} ثانیه پیش` : now - t < 7200 ? `${fa(Math.round((now - t) / 60))} دقیقه پیش`
  : now - t < 2 * DAY ? `${fa(Math.round((now - t) / 3600))} ساعت پیش` : `${fa(Math.round((now - t) / DAY))} روز پیش`);
export const pct = (used, limit) => (limit > 0 ? (100 * (used || 0)) / limit : 0);
const pctTxt = (p) => (p < 1 && p > 0 ? '<1٪' : `${fa(Math.round(p))}٪`);
export const dot = (p) => (p >= 85 ? '🔴' : p >= 60 ? '🟡' : '🟢');
export const bar = (p) => { const n = Math.max(0, Math.min(10, Math.round(p / 10))); return '▰'.repeat(n) + '▱'.repeat(10 - n); };
export const bytes = (n) => (n == null ? '-' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${fa(Math.round(n / 1024))} KB`);
const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : fa(n));

// per-isolate memory: the same numbers for a minute, so tapping around the section costs no new calls
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl * 1000) return hit.val;
  const val = await fn();
  if (!val || !val.error) cache.set(key, { at: Date.now(), val });
  return val;
}
export function clearCache() { cache.clear(); accountMemo = null; }

// Cloudflare's error text, without anything that looks like an address or a key
const clean = (s) => String(s || '').replace(/\S*:\/\/\S*/g, '[آدرس]').replace(/[A-Za-z0-9_-]{24,}/g, '[…]').slice(0, 140);

// ---------------- Cloudflare API ----------------
let accountMemo = null;
async function accountId(env) {
  const set = String(env.CF_ACCOUNT_ID || '').trim();
  if (/^[0-9a-f]{32}$/i.test(set)) return set;
  if (accountMemo) return accountMemo;
  // the token itself says which account it may read (an account-scoped token sees exactly one)
  try {
    const r = await fetch(`${CF_API}/accounts?per_page=5`, { headers: cfHeaders(env), signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null);
    const id = j && j.success && Array.isArray(j.result) && j.result[0] && j.result[0].id;
    if (/^[0-9a-f]{32}$/i.test(id || '')) accountMemo = id;
  } catch (e) { /* shown as "account unknown" */ }
  return accountMemo;
}
const cfHeaders = (env) => ({ authorization: 'Bearer ' + String(env.CF_ANALYTICS_TOKEN || '').trim(), 'content-type': 'application/json', 'user-agent': UA });

// One GraphQL call. Returns {acc} (viewer.accounts[0]) or {error: '<why, in Persian>'}.
async function gql(env, query, vars) {
  if (!hasToken(env)) return { error: 'no_token' };
  const acct = await accountId(env);
  if (!acct) return { error: 'شناسه‌ی حساب پیدا نشد (CF_ACCOUNT_ID را بگذار یا توکن را به یک حساب محدود کن).' };
  let r, j;
  try {
    r = await fetch(GQL, { method: 'POST', headers: cfHeaders(env), body: JSON.stringify({ query, variables: { a: acct, ...vars } }), signal: AbortSignal.timeout(9000) });
    j = await r.json().catch(() => null);
  } catch (e) {
    return { error: e && e.name === 'TimeoutError' ? 'Cloudflare بیش از ۹ ثانیه جواب نداد.' : 'به API کلودفلر وصل نشد.' };
  }
  if (r.status === 401 || r.status === 403) return { error: 'توکن رد شد (اشتباه است یا اجازه‌ی Account Analytics: Read ندارد).' };
  if (!j) return { error: `جواب نامفهوم از Cloudflare (HTTP ${r.status}).` };
  if (Array.isArray(j.errors) && j.errors.length) return { error: 'Cloudflare: ' + clean(j.errors[0].message) };
  const acc = j.data && j.data.viewer && j.data.viewer.accounts && j.data.viewer.accounts[0];
  if (!acc) return { error: 'حسابی با این شناسه در دسترس توکن نیست.' };
  return { acc };
}

// Worker invocations by hour, script and outcome (the whole account: the 100k/day limit is per account)
const Q_WORKERS = `query($a: string!, $s: string!, $e: string!) { viewer { accounts(filter: {accountTag: $a}) {
  workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $s, datetime_leq: $e}) {
    sum { requests errors subrequests }
    quantiles { cpuTimeP50 cpuTimeP99 }
    dimensions { datetimeHour scriptName status }
  } } } }`;
const Q_D1 = `query($a: string!, $s: string!, $e: string!) { viewer { accounts(filter: {accountTag: $a}) {
  d1AnalyticsAdaptiveGroups(limit: 10000, filter: {date_geq: $s, date_leq: $e}, orderBy: [date_DESC]) {
    sum { readQueries writeQueries rowsRead rowsWritten }
    dimensions { date databaseId }
  }
  d1StorageAdaptiveGroups(limit: 10000, filter: {date_geq: $s, date_leq: $e}, orderBy: [date_DESC]) {
    max { databaseSizeBytes }
    dimensions { date databaseId }
  } } } }`;
const Q_QUERIES = `query($a: string!, $s: string!, $e: string!) { viewer { accounts(filter: {accountTag: $a}) {
  d1QueriesAdaptiveGroups(limit: 2000, filter: {date_geq: $s, date_leq: $e}) {
    sum { rowsRead rowsWritten queryDurationMs }
    avg { queryDurationMs }
    dimensions { query }
  } } } }`;

// rows: [{hour (unix), script, status, requests, errors, subrequests, p50, p99}]
export async function workerRows(env, since, until = nowSec()) {
  return cached(`w:${since}`, 60, async () => {
    const r = await gql(env, Q_WORKERS, { s: iso(since), e: iso(until) });
    if (r.error) return r;
    const rows = (r.acc.workersInvocationsAdaptive || []).map((g) => ({
      hour: Math.floor(Date.parse(g.dimensions.datetimeHour) / 1000) || 0, script: g.dimensions.scriptName || '', status: g.dimensions.status || '',
      requests: Number(g.sum.requests) || 0, errors: Number(g.sum.errors) || 0, subrequests: Number(g.sum.subrequests) || 0,
      p50: Number(g.quantiles && g.quantiles.cpuTimeP50) || 0, p99: Number(g.quantiles && g.quantiles.cpuTimeP99) || 0,
    }));
    return { rows };
  });
}
// days: {'YYYY-MM-DD': {rowsRead, rowsWritten, readQueries, writeQueries, size (largest db), sizeTotal, dbs}}
export async function d1Days(env, days = 7) {
  const s = ymd(dayStart() - (days - 1) * DAY), e = ymd(nowSec());
  return cached(`d:${s}`, 60, async () => {
    const r = await gql(env, Q_D1, { s, e });
    if (r.error) return r;
    const out = {};
    const day = (d) => (out[d] = out[d] || { rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0, size: 0, sizeTotal: 0, dbs: 0 });
    for (const g of r.acc.d1AnalyticsAdaptiveGroups || []) {
      const d = day(g.dimensions.date);
      d.rowsRead += Number(g.sum.rowsRead) || 0; d.rowsWritten += Number(g.sum.rowsWritten) || 0;
      d.readQueries += Number(g.sum.readQueries) || 0; d.writeQueries += Number(g.sum.writeQueries) || 0;
    }
    for (const g of r.acc.d1StorageAdaptiveGroups || []) {
      const d = day(g.dimensions.date), n = Number(g.max && g.max.databaseSizeBytes) || 0;
      d.size = Math.max(d.size, n); d.sizeTotal += n; d.dbs += 1;
    }
    return { days: out };
  });
}

// ---------------- what the Worker knows by itself ----------------
// D1 tells the database size after every statement (meta.size_after); null when it does not (local tests)
export async function dbSize(env) {
  try {
    const r = await env.DB.prepare('SELECT 1').run();
    const n = r && r.meta && Number(r.meta.size_after);
    return n > 0 ? n : null;
  } catch (e) { return null; }
}

// ---------------- the Worker's own error log ----------------
// logError (util.js) hands each error here. One row per kind of error (its words with numbers taken out),
// counted; written at most once a minute per kind and 12 times a minute per isolate, so an error storm can never
// eat the D1 write allowance or push one request over its 50 queries. Never throws, never logs.
const recent = new Map(); // fp -> {at, n}
let minute = 0, writes = 0;
export function errorFp(message, error) {
  const norm = (s) => String(s || '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return (norm(message).slice(0, 60) + '|' + norm(error).slice(0, 60)).slice(0, 124);
}
export function recordError(env, message, error) {
  try {
    if (!env || !env.DB) return;
    const fp = errorFp(message, error);
    const nowMs = Date.now(), m = Math.floor(nowMs / 60000);
    if (m !== minute) { minute = m; writes = 0; }
    const r = recent.get(fp) || { at: 0, n: 0 };
    r.n += 1;
    recent.set(fp, r);
    if (nowMs - r.at < 60000 || writes >= 12) return; // counted here, written with the next one
    if (recent.size > 200) for (const k of recent.keys()) { if (k !== fp) recent.delete(k); if (recent.size <= 100) break; }
    writes += 1;
    const n = r.n; r.n = 0; r.at = nowMs;
    const now = Math.floor(nowMs / 1000);
    // scrubbed: no address, email, ip or long token ever reaches the table (the health module's rules)
    import('./health.js').then(({ scrub }) => env.DB.prepare(`INSERT INTO worker_errors (fp, message, detail, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(fp) DO UPDATE SET count = count + excluded.count, detail = excluded.detail, last_at = excluded.last_at`)
      .bind(fp, scrub(message, 80), scrub(error, 200), n, now, now).run()).catch(() => {});
  } catch (e) { /* never let the error log make a new error */ }
}
export async function pruneErrors(env) {
  await run(env, 'DELETE FROM worker_errors WHERE last_at < ?', nowSec() - 14 * DAY);
}

// ---------------- numbers for the overview, the alerts and the nightly line ----------------
// One object with what could be reached; quota fields are null without the token.
export async function snapshot(env) {
  const now = nowSec(), t0 = dayStart(now), script = scriptOf(env);
  const elapsed = Math.max(1, now - t0);
  const out = { now, t0, elapsed, script, token: hasToken(env), wErr: null, dErr: null };
  const [w, d] = out.token ? await Promise.all([workerRows(env, t0 - DAY, now), d1Days(env, 7)]) : [{ error: 'no_token' }, { error: 'no_token' }];
  if (w.error) out.wErr = w.error;
  else {
    const today = w.rows.filter((r) => r.hour >= t0), last24 = w.rows.filter((r) => r.hour >= now - DAY), lastHour = w.rows.filter((r) => r.hour >= now - (now % 3600) - 3600); // the last full hour and this one
    const sum = (rows, k, mine) => rows.filter((r) => !mine || r.script === script).reduce((a, r) => a + r[k], 0);
    out.reqToday = sum(today, 'requests');
    out.reqTodayMine = sum(today, 'requests', true);
    out.req24 = sum(last24, 'requests', true);
    out.err24 = sum(last24, 'errors', true);
    out.errToday = sum(today, 'errors', true);
    out.reqYesterday = sum(w.rows.filter((r) => r.hour < t0), 'requests');
    out.lastHourReq = sum(lastHour, 'requests', true);
    out.lastHourErr = sum(lastHour, 'errors', true);
    const status = {};
    for (const r of last24) if (r.script === script) status[r.status] = (status[r.status] || 0) + r.requests;
    out.status24 = status;
    out.cpuOver = (status.exceededCpu || 0) + (status.exceededResources || 0);
    const mine = last24.filter((r) => r.script === script && r.requests > 0);
    const wsum = mine.reduce((a, r) => a + r.requests, 0) || 1;
    out.cpuP50 = mine.reduce((a, r) => a + r.p50 * r.requests, 0) / wsum;
    out.cpuP99 = mine.reduce((a, r) => Math.max(a, r.p99), 0);
    out.subPerReq = sum(last24, 'subrequests', true) / Math.max(1, out.req24);
    out.scripts = [...new Set(today.map((r) => r.script))].length;
  }
  if (d.error) out.dErr = d.error;
  else {
    const today = d.days[ymd(now)] || { rowsRead: 0, rowsWritten: 0, size: 0 };
    out.rowsRead = today.rowsRead; out.rowsWritten = today.rowsWritten;
    const sizes = Object.keys(d.days).sort().map((k) => d.days[k].size).filter((n) => n > 0);
    out.cfSize = sizes.length ? sizes[sizes.length - 1] : null;
    out.sizeWeekAgo = sizes.length > 1 ? sizes[0] : null;
    out.dbs = today.dbs || 0;
  }
  out.size = (await dbSize(env)) || out.cfSize || null;
  out.proj = (used) => (out.elapsed >= 2 * 3600 ? (used * DAY) / out.elapsed : null); // end-of-day at today's pace
  return out;
}

// how many active users the Free plan carries at today's pace (the tightest of requests and D1 writes)
async function capacity(env, s) {
  const act = (await first(env, 'SELECT COUNT(DISTINCT user_id) n FROM devices WHERE last_seen > ?', s.now - DAY)) || { n: 0 };
  if (!act.n || s.req24 == null) return null;
  const perUserReq = s.req24 / act.n;
  const perUserW = s.rowsWritten != null && s.elapsed >= 2 * 3600 ? (s.rowsWritten * DAY) / s.elapsed / act.n : null;
  const byReq = perUserReq > 0 ? LIMITS.requests / perUserReq : Infinity;
  const byW = perUserW > 0 ? LIMITS.rowsWritten / perUserW : Infinity;
  const n = Math.min(byReq, byW);
  return isFinite(n) ? { active: act.n, users: Math.floor(n), by: byW < byReq ? 'نوشتن D1' : 'درخواست ورکر' } : null;
}

const meter = (label, used, limit, proj) => {
  const p = pct(used, limit);
  const pp = proj != null ? pct(proj, limit) : null;
  return [`${dot(Math.max(p, pp || 0))} ${label}: ${short(used)} از ${short(limit)} (${pctTxt(p)})`,
    `    ${bar(p)}${pp != null ? ` · تا آخر روز ≈ ${pctTxt(pp)}${pp >= 100 ? ' ⚠️' : ''}` : ''}`];
};
const STATUS_FA = { success: '✅ موفق', clientDisconnected: '🔌 قطع از سمت کاربر', scriptThrewException: '💥 خطای کد', exceededCpu: '⏱ بیش از ۱۰ms CPU',
  exceededResources: '⏱ بیش از سقف منابع', exceededMemory: '🧠 بیش از حافظه', internalError: '☁️ خطای داخلی کلودفلر', responseStreamDisconnected: '🔌 قطع جواب',
  loadSheddingErrored: '☁️ بار زیاد کلودفلر', unknown: '❔ نامعلوم' };
export const statusFa = (s) => STATUS_FA[s] || s;

// ---------------- screens ----------------
export async function overview(env) {
  const s = await snapshot(env);
  const resetH = (s.t0 + DAY - s.now) / 3600;
  const L = [crumb(), '', `📅 سهم امروز از پلن رایگان (روز UTC؛ صفر شدن: ${fa(Math.floor(resetH))} ساعت و ${fa(Math.round((resetH % 1) * 60))} دقیقه دیگر، ساعت ۰۳:۳۰ تهران)`, ''];
  if (s.token && !s.wErr) {
    L.push(...meter('درخواست ورکر', s.reqToday, LIMITS.requests, s.proj(s.reqToday)));
    if (s.scripts > 1) L.push(`    (کل حساب؛ سهم ${s.script}: ${fa(s.reqTodayMine)})`);
  } else L.push(`⚪️ درخواست ورکر: ${s.token ? '❌ ' + s.wErr : 'توکن ندارد'}`);
  if (s.token && !s.dErr) {
    L.push(...meter('خواندن D1 (ردیف)', s.rowsRead, LIMITS.rowsRead, s.proj(s.rowsRead)));
    L.push(...meter('نوشتن D1 (ردیف)', s.rowsWritten, LIMITS.rowsWritten, s.proj(s.rowsWritten)));
  } else L.push(`⚪️ خواندن / نوشتن D1: ${s.token ? '❌ ' + s.dErr : 'توکن ندارد'}`);
  if (s.size) {
    const p = pct(s.size, LIMITS.dbBytes);
    const grow = s.sizeWeekAgo && s.cfSize ? s.cfSize - s.sizeWeekAgo : null;
    L.push(`${dot(p)} حجم دیتابیس: ${bytes(s.size)} از ${bytes(LIMITS.dbBytes)} (${pctTxt(p)})${grow != null ? ` · ۷ روز: ${grow >= 0 ? '+' : '−'}${bytes(Math.abs(grow))}` : ''}`);
  } else L.push('⚪️ حجم دیتابیس: نامعلوم');
  if (s.token && !s.wErr) {
    const er = s.req24 ? pct(s.err24, s.req24) : 0;
    L.push('', '⚡️ ۲۴ ساعت گذشته (ورکر خودمان)',
      `درخواست: ${fa(s.req24)} · خطا: ${fa(s.err24)} (${er.toFixed(er < 1 ? 2 : 1)}٪) ${er >= 5 ? '🔴' : er >= 1 ? '🟡' : '🟢'}`,
      `CPU: میانه ${s.cpuP50.toFixed(1)}ms · بدترین ساعت p99 ${s.cpuP99.toFixed(1)}ms از سقف ۱۰ms ${s.cpuP99 >= 10 ? '🔴' : s.cpuP99 >= 7 ? '🟡' : '🟢'}`,
      `ردشده به‌خاطر CPU/منابع: ${fa(s.cpuOver)}${s.cpuOver ? ' ⚠️' : ''} · ساب‌ریکوئست برای هر درخواست: ${s.subPerReq.toFixed(1)}`);
    const cap = await capacity(env, s);
    if (cap) L.push(`👥 کاربر فعال امروز: ${fa(cap.active)} · با همین الگو پلن رایگان حدود ${fa(cap.users)} کاربر فعال را جواب می‌دهد (گلوگاه: ${cap.by})`);
  }
  const own = await first(env, 'SELECT COUNT(*) kinds, COALESCE(SUM(count), 0) n FROM worker_errors WHERE last_at > ?', s.now - DAY);
  const cron = await first(env, 'SELECT MAX(run_at) t FROM sync_cursor');
  const alerts = (await first(env, "SELECT value FROM settings WHERE key = 'cf_alerts'"))?.value !== '0';
  L.push('', `🐞 خطاهای ثبت‌شده در ورکر (۲۴ ساعت): ${fa(own.kinds)} نوع${own.kinds ? ` (${fa(own.n)} بار از اولین ثبت)` : ' ✅'}`,
    `⏱ کرون هر دقیقه: ${cron && cron.t ? `${ago(cron.t, s.now)}${s.now - cron.t > 300 ? ' ⚠️ عقب افتاده' : ' ✅'}` : 'هنوز اجرا نشده'}`,
    `🔔 هشدار خودکار: ${alerts ? 'روشن (ساعتی بررسی می‌شود)' : 'خاموش'}`);
  if (!s.token) L.push('', '🔑 برای دیدن مصرف روزانه، خطاها و CPU از خود کلودفلر، یک توکن فقط‌خواندنی لازم است → «🔑 راه‌اندازی توکن».');
  L.push('', `به‌روز: ${tehran(s.now)} تهران`);
  return {
    text: L.join('\n'),
    kb: [
      [b('🔄 به‌روزرسانی', 'm:cf'), b('📈 ۷ روز گذشته', 'm:cfh')],
      [b('🐞 خطاها', 'm:cfe'), b('🔥 پرهزینه‌ترین کوئری‌ها', 'm:cfq')],
      [b('🚀 دیپلوی و بیلد', 'm:cfd'), b(alerts ? '🔕 خاموش کردن هشدار' : '🔔 روشن کردن هشدار', `m:ss:cf_alerts:${alerts ? '0' : '1'}`)],
      [b(s.token ? '🔑 توکن و دسترسی‌ها' : '🔑 راه‌اندازی توکن', 'm:cfk'), b('🩺 سلامت سیستم', 'm:sys.hl')],
      [HOME],
    ],
  };
}

export async function history(env) {
  const now = nowSec(), t0 = dayStart(now), script = scriptOf(env);
  const L = [crumb('📈 ۷ روز'), ''];
  if (!hasToken(env)) return { text: [...L, 'این صفحه از آمار خود کلودفلر است و توکن لازم دارد.'].join('\n'), kb: [[b('🔑 راه‌اندازی توکن', 'm:cfk')], nav('cf')] };
  const [w, d] = await Promise.all([workerRows(env, t0 - 6 * DAY, now), d1Days(env, 7)]);
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(ymd(t0 - i * DAY));
  const by = {};
  if (!w.error) for (const r of w.rows) { const k = ymd(r.hour); const x = (by[k] = by[k] || { req: 0, err: 0 }); x.req += r.requests; if (r.script === script) x.err += r.errors; }
  L.push('روز · درخواست · خطا · خواندن D1 · نوشتن D1 · حجم');
  for (const k of days.slice().reverse()) {
    const x = by[k], y = d.days && d.days[k];
    const pr = x ? pct(x.req, LIMITS.requests) : 0, pw = y ? pct(y.rowsWritten, LIMITS.rowsWritten) : 0, prd = y ? pct(y.rowsRead, LIMITS.rowsRead) : 0;
    L.push(`${dot(Math.max(pr, pw, prd))} ${k.slice(5)}${k === ymd(now) ? ' (امروز)' : ''} · ${x ? short(x.req) : '-'} · ${x ? fa(x.err) : '-'} · ${y ? short(y.rowsRead) : '-'} · ${y ? short(y.rowsWritten) : '-'} · ${y && y.size ? bytes(y.size) : '-'}`);
  }
  const full = days.slice(0, 6).map((k) => by[k] && by[k].req).filter((n) => n != null);
  if (full.length) {
    const avg = full.reduce((a, n) => a + n, 0) / full.length;
    L.push('', `میانگین درخواست روزهای کامل: ${short(Math.round(avg))} (${pctTxt(pct(avg, LIMITS.requests))} سقف روزانه)`);
  }
  if (w.error) L.push('', '❌ درخواست‌ها: ' + w.error);
  if (d.error) L.push('', '❌ D1: ' + d.error);
  L.push('', '🟢 زیر ۶۰٪ · 🟡 ۶۰ تا ۸۵٪ · 🔴 بالای ۸۵٪ سقف روزانه (بیشترینِ سه سقف)');
  return { text: L.join('\n'), kb: [[b('🔄 به‌روزرسانی', 'm:cfh')], nav('cf')] };
}

export async function errors(env) {
  const now = nowSec(), script = scriptOf(env);
  const L = [crumb('🐞 خطاها'), ''];
  if (hasToken(env)) {
    const w = await workerRows(env, dayStart(now) - DAY, now);
    if (w.error) L.push('❌ آمار کلودفلر: ' + w.error);
    else {
      const st = {};
      for (const r of w.rows) if (r.script === script && r.hour >= now - DAY) st[r.status] = (st[r.status] || 0) + r.requests;
      const tot = Object.values(st).reduce((a, n) => a + n, 0) || 1;
      L.push('☁️ نتیجه‌ی درخواست‌ها در ۲۴ ساعت (از کلودفلر):', ...Object.entries(st).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${statusFa(k)}: ${fa(n)} (${pct(n, tot).toFixed(1)}٪)`));
      if ((st.exceededCpu || 0) + (st.exceededResources || 0)) L.push('⚠️ درخواست‌هایی که از ۱۰ms CPU پلن رایگان رد شده‌اند، برای کاربر خطا برمی‌گردانند.');
    }
    L.push('');
  }
  const rows = await all(env, 'SELECT message, detail, count, first_at, last_at FROM worker_errors ORDER BY last_at DESC LIMIT 8');
  L.push('🧾 خطاهایی که خود ورکر ثبت کرده (تازه‌ترین اول):');
  if (!rows.length) L.push('چیزی ثبت نشده ✅');
  for (const r of rows) {
    L.push(`${now - r.first_at < DAY ? '🆕' : '•'} ${r.message} — ${fa(r.count)} بار · آخرین: ${ago(r.last_at, now)}`);
    if (r.detail) L.push(`    ${String(r.detail).slice(0, 140)}`);
  }
  L.push('', 'آدرس‌ها، ایمیل‌ها، IP و کلیدها قبل از ذخیره حذف می‌شوند. ردیف‌های قدیمی‌تر از ۱۴ روز خودکار پاک می‌شوند.');
  return { text: L.join('\n'), kb: [[b('🔄 به‌روزرسانی', 'm:cfe'), ...(rows.length ? [b('🧹 پاک کردن لیست', 'm:cfx')] : [])], nav('cf')] };
}

export async function queries(env) {
  const L = [crumb('🔥 کوئری‌ها'), ''];
  if (!hasToken(env)) return { text: [...L, 'این صفحه از آمار خود کلودفلر است و توکن لازم دارد.'].join('\n'), kb: [[b('🔑 راه‌اندازی توکن', 'm:cfk')], nav('cf')] };
  const now = nowSec(), s = ymd(now - DAY), e = ymd(now);
  const r = await cached(`q:${s}`, 120, () => gql(env, Q_QUERIES, { s, e }));
  if (r.error) return { text: [...L, '❌ ' + r.error].join('\n'), kb: [[b('🔄 دوباره', 'm:cfq')], nav('cf')] };
  const rows = (r.acc.d1QueriesAdaptiveGroups || []).map((g) => {
    const dur = Number(g.sum.queryDurationMs) || 0, avg = Number(g.avg && g.avg.queryDurationMs) || 0;
    return { q: String(g.dimensions.query || '').replace(/\s+/g, ' ').trim(), read: Number(g.sum.rowsRead) || 0, written: Number(g.sum.rowsWritten) || 0, n: avg > 0 ? Math.round(dur / avg) : 0 };
  });
  const totR = rows.reduce((a, x) => a + x.read, 0) || 1, totW = rows.reduce((a, x) => a + x.written, 0) || 1;
  const line = (x, k, tot) => `${pctTxt(pct(x[k], tot))} · ${short(x[k])} ردیف · ≈${short(x.n)} بار\n    ${x.q.slice(0, 110)}`;
  L.push('دیروز و امروز (UTC)، کل دیتابیس‌ها:', '', '📖 بیشترین خواندن:');
  rows.slice().sort((x, y) => y.read - x.read).slice(0, 5).filter((x) => x.read > 0).forEach((x) => L.push(line(x, 'read', totR)));
  L.push('', '✍️ بیشترین نوشتن:');
  rows.slice().sort((x, y) => y.written - x.written).slice(0, 5).filter((x) => x.written > 0).forEach((x) => L.push(line(x, 'written', totW)));
  if (!rows.length) L.push('کوئری‌ای ثبت نشده.');
  L.push('', 'اگر یک کوئری بیشتر سهم را می‌خورد، همان‌جا بهترین جای بهینه‌سازی است (ایندکس یا کش).');
  return { text: L.join('\n'), kb: [[b('🔄 به‌روزرسانی', 'm:cfq')], nav('cf')] };
}

// ---------------- deploys (GitHub Actions + the live version on Cloudflare) ----------------
async function gh(env, path) {
  const get = (auth) => fetch(`https://api.github.com/repos/${repoOf(env)}${path}`, { signal: AbortSignal.timeout(8000), headers: {
    accept: 'application/vnd.github+json', 'user-agent': UA, 'x-github-api-version': '2022-11-28', ...(auth ? { authorization: 'Bearer ' + env.PLEAT_DL_TOKEN } : {}) } });
  try {
    let r = await get(!!env.PLEAT_DL_TOKEN);
    if (!r.ok && env.PLEAT_DL_TOKEN) r = await get(false); // the repo is public: a token without Actions read is not needed
    if (!r.ok) return { error: `GitHub HTTP ${r.status}` };
    return { data: await r.json() };
  } catch (e) { return { error: 'GitHub جواب نداد' }; }
}
const RUN_ICON = (r) => (r.status !== 'completed' ? '⏳' : r.conclusion === 'success' ? '✅' : r.conclusion === 'cancelled' ? '⏹' : '❌');
const ts = (s) => Math.floor(Date.parse(s || '') / 1000) || 0;

export async function deploys(env) {
  const now = nowSec();
  const L = [crumb('🚀 دیپلوی و بیلد'), ''];
  const [dep, apk] = await cached('gh:runs', 120, async () => Promise.all([gh(env, '/actions/workflows/deploy-worker.yml/runs?per_page=5'), gh(env, '/actions/workflows/flutter-vpn.yml/runs?per_page=2')]));
  L.push('☁️ دیپلوی سرور (Deploy Cloud Gold server):');
  let lastOk = null;
  if (dep.error) L.push('❌ ' + dep.error);
  else {
    const runs = dep.data.workflow_runs || [];
    if (!runs.length) L.push('هنوز اجرا نشده.');
    for (const r of runs) {
      if (!lastOk && r.conclusion === 'success') lastOk = r;
      L.push(`${RUN_ICON(r)} #${r.run_number} · ${ago(ts(r.created_at), now)} · ${String(r.head_sha || '').slice(0, 7)}`);
    }
  }
  // merged but not deployed: main compared with the last good deploy
  if (lastOk) {
    const c = await cached(`gh:cmp:${lastOk.head_sha}`, 120, () => gh(env, `/compare/${lastOk.head_sha}...main`));
    if (!c.error) {
      const ahead = Number(c.data.ahead_by) || 0;
      const prs = [...new Set((c.data.commits || []).map((x) => (/^Merge pull request #(\d+)/.exec(String(x.commit && x.commit.message)) || [])[1]).filter(Boolean))];
      L.push(ahead ? `⚠️ ${fa(ahead)} کامیت روی main هنوز دیپلوی نشده${prs.length ? ` (PR ${prs.map((n) => '#' + n).join(' ')})` : ''}` : '✅ آخرین دیپلوی موفق همان main فعلی است.');
    }
  }
  // the version Cloudflare is serving now (only with Workers Scripts: Read on the token)
  if (hasToken(env)) {
    const live = await cached('cf:dep', 120, async () => {
      const acct = await accountId(env);
      if (!acct) return { error: 'no_account' };
      try {
        const r = await fetch(`${CF_API}/accounts/${acct}/workers/scripts/${scriptOf(env)}/deployments`, { headers: cfHeaders(env), signal: AbortSignal.timeout(8000) });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.success) return { error: r.status === 403 || r.status === 401 ? 'perm' : `HTTP ${r.status}` };
        return { d: (j.result && j.result.deployments && j.result.deployments[0]) || null };
      } catch (e) { return { error: 'net' }; }
    });
    if (live.d) L.push(`🟢 نسخه‌ی در حال اجرا روی کلودفلر: از ${ago(ts(live.d.created_on), now)} (${tehran(ts(live.d.created_on))} تهران)`);
    else if (live.error === 'perm') L.push('ℹ️ برای دیدن نسخه‌ی در حال اجرا، به توکن اجازه‌ی Workers Scripts: Read هم بده.');
  }
  L.push('', '📱 بیلد اپ Pleat:');
  if (apk.error) L.push('❌ ' + apk.error);
  else for (const r of (apk.data.workflow_runs || [])) L.push(`${RUN_ICON(r)} #${r.run_number} · ${ago(ts(r.created_at), now)}`);
  L.push('', 'دیپلوی و بیلد را برنامه‌ی ادغام انجام می‌دهد؛ این صفحه فقط وضعیت را نشان می‌دهد.');
  return {
    text: L.join('\n'),
    kb: [[{ text: '🔗 GitHub Actions', url: `https://github.com/${repoOf(env)}/actions` }], [b('🔄 به‌روزرسانی', 'm:cfd')], nav('cf')],
  };
}

export async function tokenHelp(env) {
  const have = hasToken(env);
  let state = '';
  if (have) {
    const acct = await accountId(env);
    const w = acct ? await workerRows(env, dayStart(), nowSec()) : { error: 'شناسه‌ی حساب پیدا نشد' };
    state = w.error ? `❌ توکن هست ولی کار نمی‌کند: ${w.error}` : '✅ توکن کار می‌کند و آمار کلودفلر خوانده می‌شود.';
  }
  return {
    text: [crumb('🔑 توکن'), '', have ? state : '⚪️ هنوز توکنی گذاشته نشده.', '',
      'ساختن توکن (یک بار):',
      '۱. dash.cloudflare.com › My Profile › API Tokens › Create Token › Create Custom Token',
      '۲. Permissions: Account › Account Analytics › Read',
      '   (اختیاری) Account › Workers Scripts › Read — برای دیدن نسخه‌ی در حال اجرا',
      '۳. Account Resources: فقط همین حساب. بقیه را دست نزن و توکن را بساز.',
      '۴. Workers & Pages › cloudgold › Settings › Variables and Secrets › Add',
      '   نوع Secret، نام: CF_ANALYTICS_TOKEN، مقدار: توکنی که ساختی.',
      '',
      'شناسه‌ی حساب را دیپلوی بعدی خودش به ورکر می‌دهد (CF_ACCOUNT_ID)؛ تا آن موقع از خود توکن پیدا می‌شود.',
      'این توکن فقط خواندنی است: نه چیزی را عوض می‌کند، نه به پنل‌ها و پول دسترسی دارد. توکن هیچ‌جا در ربات نشان داده نمی‌شود.',
    ].join('\n'),
    kb: [[b('🔄 بررسی دوباره', 'm:cfk')], nav('cf')],
  };
}

// ---------------- alerts (hourly, from the */2 cron) and the nightly line ----------------
// Each problem is told once per UTC day (an error spike once per 6 hours); nothing is written unless it alerts.
export async function alertTick(env, notify) {
  if ((await first(env, "SELECT value FROM settings WHERE key = 'cf_alerts'"))?.value === '0') return { sent: 0 };
  const s = await snapshot(env);
  const found = [];
  const quota = (key, label, used, limit) => {
    if (used == null) return;
    const p = pct(used, limit), pp = s.proj(used) != null ? pct(s.proj(used), limit) : 0;
    if (p >= 80) found.push([key, `🔴 ${label}: ${pctTxt(p)} سقف امروز مصرف شده (${short(used)} از ${short(limit)}).`]);
    else if (pp >= 100 && s.elapsed >= 4 * 3600) found.push([key, `🟡 ${label}: با این سرعت تا آخر روز به ≈${pctTxt(pp)} سقف می‌رسد (الان ${pctTxt(p)}).`]);
  };
  if (!s.wErr && s.token) quota('req', 'درخواست ورکر', s.reqToday, LIMITS.requests);
  if (!s.dErr && s.token) { quota('rw', 'نوشتن D1', s.rowsWritten, LIMITS.rowsWritten); quota('rr', 'خواندن D1', s.rowsRead, LIMITS.rowsRead); }
  if (s.size && pct(s.size, LIMITS.dbBytes) >= 80) found.push(['size', `🔴 حجم دیتابیس ${bytes(s.size)} شده (${pctTxt(pct(s.size, LIMITS.dbBytes))} سقف ۵۰۰MB).`]);
  const block = Math.floor((s.now - s.t0) / (6 * 3600));
  if (!s.wErr && s.token && s.lastHourErr >= 30 && pct(s.lastHourErr, s.lastHourReq) >= 5) found.push([`err${block}`, `🔴 از ساعت پیش تا الان ${fa(s.lastHourErr)} درخواست خطا داده (${pctTxt(pct(s.lastHourErr, s.lastHourReq))}).`]);
  if (!s.wErr && s.token && s.cpuOver >= 20) found.push(['cpu', `🟡 ${fa(s.cpuOver)} درخواست در ۲۴ ساعت از سقف CPU پلن رایگان رد شده.`]);
  const fresh = await all(env, 'SELECT fp, message FROM worker_errors WHERE first_at > ? ORDER BY first_at DESC LIMIT 3', s.now - 3600);
  for (const f of fresh) found.push([`new:${f.fp}`.slice(0, 80), `🆕 خطای تازه در ورکر: ${f.message}`]);
  if (!found.length) return { sent: 0 };
  const day = ymd(s.now);
  let st = {};
  try { st = JSON.parse((await first(env, "SELECT value FROM settings WHERE key = 'cf_alert_state'"))?.value || '{}'); } catch (e) { st = {}; }
  const told = new Set(st.day === day ? st.keys || [] : []);
  const news = found.filter(([k]) => !told.has(k));
  if (!news.length) return { sent: 0 };
  news.forEach(([k]) => told.add(k));
  await run(env, `INSERT INTO settings (key, value) VALUES ('cf_alert_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify({ day, keys: [...told].slice(-60) }));
  await notify(['☁️ هشدار کلودفلر', '', ...news.map(([, t]) => t), '', 'جزئیات در «☁️ کلودفلر». هر مورد روزی یک بار گفته می‌شود.'].join('\n'),
    { inline_keyboard: [[b('☁️ مانیتورینگ کلودفلر', 'm:cf')]] });
  return { sent: news.length };
}

export async function dailyLine(env) {
  const s = await snapshot(env);
  if (!s.token) return `☁️ کلودفلر: حجم دیتابیس ${bytes(s.size)} (برای آمار مصرف، توکن CF_ANALYTICS_TOKEN را بگذار)`;
  const parts = [];
  if (!s.wErr) parts.push(`درخواست ${pctTxt(pct(s.reqToday, LIMITS.requests))}`, `خطا ${fa(s.errToday)}`);
  if (!s.dErr) parts.push(`نوشتن D1 ${pctTxt(pct(s.rowsWritten, LIMITS.rowsWritten))}`, `خواندن ${pctTxt(pct(s.rowsRead, LIMITS.rowsRead))}`);
  parts.push(`حجم ${bytes(s.size)}`);
  return `☁️ کلودفلر امروز: ${parts.join(' · ')}${s.wErr || s.dErr ? ' (بخشی خوانده نشد)' : ''}`;
}
