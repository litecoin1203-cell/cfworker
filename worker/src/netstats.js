// Network intelligence, anonymous (no user ids):
//
// 1) Per ISP *and province*: filtering in Iran differs city by city and hour by hour. Every phone reports how
//    each server behaved; we keep 3-hour buckets per (ISP, province) and weigh recent hours more (half-life
//    12h), so a sudden block in one city shows up within hours there without hurting other cities. When a
//    province has little data, its score is pulled toward the ISP-wide score (Bayesian blend).
// 2) Per server, globally: how Google sees its exit IP (country, Gemini availability, "unusual traffic"
//    wall), measured by phones through that exact config. Lets users pick configs that work with Gemini.
import { all, run, first } from './db.js';
import { json, nowSec } from './util.js';

const ISP_FA = {
  197207: 'همراه اول', 44244: 'ایرانسل', 57218: 'رایتل', 58224: 'مخابرات', 12880: 'زیرساخت', 48159: 'زیرساخت',
  31549: 'شاتل', 16322: 'پارس آنلاین', 43754: 'آسیاتک', 25184: 'افرانت', 44208: 'پیشگامان', 50810: 'مبین‌نت',
  56402: 'های‌وب', 42337: 'رسپینا', 39501: 'صبانت', 49100: 'پارس‌آنلاین', 41689: 'آسیاتک',
};
const PROVINCE_FA = {
  'tehran': 'تهران', 'razavi khorasan': 'خراسان رضوی', 'isfahan': 'اصفهان', 'fars': 'فارس', 'khuzestan': 'خوزستان',
  'east azerbaijan': 'آذربایجان شرقی', 'west azerbaijan': 'آذربایجان غربی', 'mazandaran': 'مازندران', 'kerman': 'کرمان',
  'alborz': 'البرز', 'gilan': 'گیلان', 'kermanshah': 'کرمانشاه', 'hamadan': 'همدان', 'yazd': 'یزد', 'ardabil': 'اردبیل',
  'hormozgan': 'هرمزگان', 'markazi': 'مرکزی', 'golestan': 'گلستان', 'qazvin': 'قزوین', 'qom': 'قم', 'lorestan': 'لرستان',
  'kurdistan': 'کردستان', 'zanjan': 'زنجان', 'semnan': 'سمنان', 'sistan and baluchestan': 'سیستان و بلوچستان',
  'bushehr': 'بوشهر', 'chaharmahal and bakhtiari': 'چهارمحال و بختیاری', 'north khorasan': 'خراسان شمالی',
  'south khorasan': 'خراسان جنوبی', 'kohgiluyeh and boyer-ahmad': 'کهگیلویه و بویراحمد', 'ilam': 'ایلام',
};
// countries where Gemini is not offered (used only when the page marker can't be read)
const GEMINI_BLOCKED = ['IR', 'CN', 'RU', 'KP', 'SY', 'CU', 'BY', 'HK', 'MO'];

export function ispOf(request) {
  const cf = request.cf || {};
  const asn = parseInt(cf.asn, 10) || 0;
  const org = String(cf.asOrganization || '').slice(0, 60);
  const geo = String(cf.region || cf.city || '').trim().toLowerCase().slice(0, 40);
  return { asn, isp: ISP_FA[asn] || org || 'نامشخص', geo, geoFa: PROVINCE_FA[geo] || (cf.region || cf.city || ''), country: cf.country || '' };
}
const bucketNow = () => Math.floor(nowSec() / 10800);
const day = () => Math.floor(nowSec() / 86400);
const KEY_RE = /^[a-z0-9]{6,16}$/;
const throttle = (bag, id, ms) => {
  const t = (globalThis[bag] = globalThis[bag] || {});
  if (t[id] && Date.now() - t[id] < ms) return true;
  t[id] = Date.now();
  return false;
};

// POST /net/report  { results: [{ k, ok, ms }] }
export async function report(env, user, request, body) {
  const { asn, geo } = ispOf(request);
  if (!asn) return json({ ok: true, skipped: 'no_asn' });
  if (throttle('__cgNet', user.id, 8000)) return json({ ok: true, skipped: 'throttled' });
  const list = Array.isArray(body.results) ? body.results.slice(0, 60) : [];
  const b = bucketNow();
  let n = 0;
  const seenNow = new Set();
  for (const r of list) {
    const k = String(r.k || '');
    if (!KEY_RE.test(k) || seenNow.has(k)) continue; // one result per server per report
    seenNow.add(k);
    // one vote per user per server per network per 3-hour bucket, so one account cannot outvote everyone else
    const vote = await run(env, 'INSERT OR IGNORE INTO net_votes (user_id, asn, geo, skey, bucket) VALUES (?,?,?,?,?)', user.id, asn, geo, k, b);
    if (!vote.meta.changes) continue;
    const ok = r.ok ? 1 : 0;
    const ms = ok ? Math.max(1, Math.min(10000, parseInt(r.ms, 10) || 0)) : 0;
    await run(env, `INSERT INTO net_geo (asn, geo, skey, bucket, ok, fail, ms_sum, ms_n) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(asn, geo, skey, bucket) DO UPDATE SET ok = ok + excluded.ok, fail = fail + excluded.fail, ms_sum = ms_sum + excluded.ms_sum, ms_n = ms_n + excluded.ms_n`,
      asn, geo, k, b, ok, 1 - ok, ms, ms ? 1 : 0);
    n++;
  }
  return json({ ok: true, stored: n });
}

// recency-weighted totals: weight halves every 12 hours, 3-day window
function decayed(rows) {
  const now = bucketNow(), out = {};
  for (const r of rows) {
    const w = Math.pow(0.5, ((now - r.bucket) * 3) / 12);
    const o = (out[r.skey] = out[r.skey] || { ok: 0, fail: 0, ms: 0, msw: 0, raw: 0 });
    o.ok += r.ok * w; o.fail += r.fail * w; o.ms += r.ms_sum * w; o.msw += r.ms_n * w; o.raw += r.ok + r.fail;
  }
  return out;
}

const GOOGLE_KEYS_PER_USER_DAY = 30; // a phone tests its own few servers; more than this is not a real app
const GOOGLE_MAP_MAX = 200;           // most-tested servers returned to the app

async function googleMap(env) {
  const rows = await all(env, `SELECT skey, SUM(tests) t, SUM(gemini_ok) g, SUM(google_ir) ir, SUM(google_wall) wall,
      MAX(last_at) at FROM google_probe WHERE day >= ? GROUP BY skey ORDER BY t DESC LIMIT ${GOOGLE_MAP_MAX}`, day() - 2);
  const latest = await all(env, `SELECT p.skey, p.last_cc, p.last_gcc, p.last_ip FROM google_probe p
      JOIN (SELECT skey, MAX(last_at) m FROM google_probe WHERE day >= ? GROUP BY skey) x ON x.skey = p.skey AND x.m = p.last_at`, day() - 2);
  const last = Object.fromEntries(latest.map((r) => [r.skey, r]));
  const out = {};
  for (const r of rows) {
    const L = last[r.skey] || {};
    const iranShare = r.ir / r.t, wallShare = r.wall / r.t, geminiShare = r.g / r.t;
    let status = 'google';
    if (iranShare >= 0.5) status = 'iran'; // the majority of tests decides, never a single latest report
    else if (wallShare >= 0.5) status = 'flagged';
    else if (geminiShare < 0.5) status = 'no_gemini';
    out[r.skey] = { status, tests: r.t, gemini: +geminiShare.toFixed(2), google_cc: L.last_gcc || null, cc: L.last_cc || null, at: r.at };
  }
  return out;
}

// GET /net/rank -> { asn, isp, geo, servers: { k: {score, n, ms, level} }, google: { k: {...} } }
export async function rank(env, request) {
  const { asn, isp, geo, geoFa } = ispOf(request);
  const google = await googleMap(env);
  if (!asn) return json({ asn: 0, isp, geo: geoFa, servers: {}, google });
  const since = bucketNow() - 24; // 72 hours
  const ispRows = await all(env, `SELECT skey, bucket, SUM(ok) ok, SUM(fail) fail, SUM(ms_sum) ms_sum, SUM(ms_n) ms_n
    FROM net_geo WHERE asn = ? AND bucket >= ? GROUP BY skey, bucket`, asn, since);
  const geoRows = geo ? await all(env, `SELECT skey, bucket, ok, fail, ms_sum, ms_n FROM net_geo WHERE asn = ? AND geo = ? AND bucket >= ?`, asn, geo, since) : [];
  const I = decayed(ispRows), G = decayed(geoRows);
  const servers = {};
  for (const k of Object.keys(I)) {
    const a = I[k], g = G[k];
    const pIsp = (a.ok + 1) / (a.ok + a.fail + 2);
    // province data counts fully once it has a few results; until then it leans on the ISP-wide number
    const PRIOR = 4;
    const p = g ? (g.ok + PRIOR * pIsp) / (g.ok + g.fail + PRIOR) : pIsp;
    const ms = g && g.msw >= 1 ? g.ms / g.msw : a.msw ? a.ms / a.msw : 0;
    const speed = ms ? Math.max(0, 1 - Math.min(ms, 2000) / 2000) : 0.5;
    const local = g && g.raw >= 3;
    servers[k] = { score: +(p * 0.75 + speed * 0.25).toFixed(3), n: local ? g.raw : a.raw, ms: Math.round(ms), level: local ? 'city' : 'isp' };
  }
  return json({ asn, isp, geo: geoFa, servers, google });
}

// POST /net/google  { k, name, ip, cc, google_cc, gemini, google_blocked }  — one test through one config
export async function googleReport(env, user, body) {
  const k = String(body.k || '');
  if (!KEY_RE.test(k)) return json({ ok: false, skipped: 'bad_key' });
  if (throttle('__cgGoo', user.id + ':' + k, 60000)) return json({ ok: true, skipped: 'throttled' });
  // one test per user per server per day counts, and only for a handful of servers: new keys cost every
  // /net/rank caller a bigger answer, so one account cannot invent them without limit
  const d = day();
  const already = await first(env, 'SELECT 1 FROM google_votes WHERE user_id = ? AND skey = ? AND day = ?', user.id, k, d);
  if (already) return json({ ok: true, skipped: 'already_counted', ...((await googleMap(env))[k] || {}) });
  const mine = await first(env, 'SELECT COUNT(*) n FROM google_votes WHERE user_id = ? AND day = ?', user.id, d);
  if (mine && mine.n >= GOOGLE_KEYS_PER_USER_DAY) return json({ ok: false, skipped: 'too_many' });
  const cc = /^[A-Z]{2}$/.test(body.cc || '') ? body.cc : null;
  const gcc = /^[A-Z]{2}$/.test(body.google_cc || '') ? body.google_cc : null;
  if (!cc && !gcc && body.gemini == null) return json({ ok: false, skipped: 'empty' });
  // if the Gemini marker was unreadable, fall back to Google's country
  const gemini = body.gemini === true || (body.gemini == null && gcc && !GEMINI_BLOCKED.includes(gcc)) ? 1 : 0;
  const ir = gcc === 'IR' ? 1 : 0;
  const wall = body.google_blocked ? 1 : 0;
  const ip = /^[0-9a-fA-F:.]{3,45}$/.test(body.ip || '') ? body.ip : null;
  const name = String(body.name || '').slice(0, 60);
  await run(env, `INSERT INTO google_probe (skey, day, tests, gemini_ok, google_ir, google_wall, last_cc, last_gcc, last_ip, name, last_at)
    VALUES (?,?,1,?,?,?,?,?,?,?,?) ON CONFLICT(skey, day) DO UPDATE SET tests = tests + 1, gemini_ok = gemini_ok + excluded.gemini_ok,
    google_ir = google_ir + excluded.google_ir, google_wall = google_wall + excluded.google_wall, last_cc = excluded.last_cc,
    last_gcc = excluded.last_gcc, last_ip = COALESCE(excluded.last_ip, last_ip), name = COALESCE(NULLIF(excluded.name, ''), name), last_at = excluded.last_at`,
    k, d, gemini, ir, wall, cc, gcc, ip, name, nowSec());
  await run(env, 'INSERT OR IGNORE INTO google_votes (user_id, skey, day) VALUES (?,?,?)', user.id, k, d);
  return json({ ok: true, ...((await googleMap(env))[k] || {}) });
}

// for the admin's /google command
export async function googleSummary(env) {
  const g = await googleMap(env);
  const names = Object.fromEntries((await all(env, 'SELECT skey, name FROM google_probe WHERE day >= ? ORDER BY last_at', day() - 2)).map((r) => [r.skey, r.name]));
  return Object.entries(g).map(([k, v]) => ({ k, name: names[k] || k, ...v }));
}

// housekeeping
export async function prune(env) {
  await run(env, 'DELETE FROM net_stats WHERE day < ?', day() - 14);
  await run(env, 'DELETE FROM net_geo WHERE bucket < ?', bucketNow() - 32);
  await run(env, 'DELETE FROM google_probe WHERE day < ?', day() - 14);
  await run(env, 'DELETE FROM net_votes WHERE bucket < ?', bucketNow() - 32);
  await run(env, 'DELETE FROM google_votes WHERE day < ?', day() - 3);
}
