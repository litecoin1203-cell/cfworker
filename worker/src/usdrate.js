// Live free-market dollar price in toman, read from several Iranian crypto exchanges (their USDT/toman
// market is the de-facto free-market dollar). Used only to price orders — nothing is paid in USDT.
//
// - every source is parsed defensively (APIs change) and sanity-checked
// - the median of the answers is used, after dropping any that sit far from the others
// - result cached 5 minutes in memory and saved in D1; if every source fails, the last saved price
//   (up to 24h old) is used, then the admin's manual usd_rate_toman as the very last resort
import { getSetting, setSetting } from './db.js';

const TTL_MS = 5 * 60 * 1000;
const STALE_OK_SEC = 24 * 3600;
const MIN_TOMAN = 20000;      // anything outside this band is a parsing error, not a price
const MAX_TOMAN = 5000000;
const TIMEOUT_MS = 6000;

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? n : 0; };
const sane = (t) => (t >= MIN_TOMAN && t <= MAX_TOMAN ? Math.round(t) : 0);

async function getJson(url, init) {
  const opts = { ...(init || {}), headers: { accept: 'application/json', 'user-agent': 'CloudGold/1.0', ...((init && init.headers) || {}) } };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(TIMEOUT_MS);
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// mid of best buy/sell when both exist, else the last trade
const mid = (buy, sell, last) => (num(buy) && num(sell) ? (num(buy) + num(sell)) / 2 : num(last) || num(sell) || num(buy));

// Checked 2026-11-11 from a server outside Iran (the Worker runs outside Iran too): api.nobitex.ir no longer
// resolves there (apiv2 does), Tabdeal's ticker path is gone (404, its depth works), Bitpin and Ramzinex answer
// 403 to foreign addresses, Wallex and Exir answer. Single-market endpoints only: Wallex's all-markets list is
// ~440 KB of JSON, too much parsing for the Free plan's 10 ms of CPU.
const best = (rows, pick) => num(rows && rows[0] && pick(rows[0]));
export const SOURCES = [
  {
    id: 'nobitex', name: 'نوبیتکس',
    async read() {
      const j = await getJson('https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls');
      const st = (j.stats || {})['usdt-rls'] || {};
      return sane(mid(st.bestBuy, st.bestSell, st.latest) / 10); // rial -> toman
    },
  },
  {
    id: 'wallex', name: 'والکس',
    async read() {
      const r = (await getJson('https://api.wallex.ir/v1/depth?symbol=USDTTMN')).result || {};
      return sane(mid(best(r.bid, (x) => x.price), best(r.ask, (x) => x.price), 0));
    },
  },
  {
    id: 'tabdeal', name: 'تبدیل',
    async read() {
      const j = await getJson('https://api1.tabdeal.org/r/api/v1/depth?symbol=USDTIRT&limit=5');
      const v = mid(best(j.bids, (x) => x[0]), best(j.asks, (x) => x[0]), 0);
      // Tabdeal quotes in toman; guard in case it is ever rials
      return sane(v > MAX_TOMAN ? v / 10 : v);
    },
  },
  {
    id: 'exir', name: 'اکسیر',
    async read() {
      const j = await getJson('https://api.exir.io/v2/ticker?symbol=usdt-irt');
      return sane(num(j.last || j.close));
    },
  },
];

function median(xs) {
  const a = xs.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

// Ask every exchange at once; returns { rate, sources: [{id, name, rate|0, error?}], used: [...] }
export async function fetchUsdRate() {
  const results = await Promise.all(SOURCES.map(async (s) => {
    try { return { id: s.id, name: s.name, rate: await s.read() }; }
    catch (e) { return { id: s.id, name: s.name, rate: 0, error: String(e.message || e).slice(0, 60) }; }
  }));
  let ok = results.filter((r) => r.rate > 0).map((r) => r.rate);
  if (!ok.length) return { rate: 0, sources: results, used: [] };
  // drop outliers (more than 6% away from the median) when there are enough answers to tell
  if (ok.length >= 3) {
    const m0 = median(ok);
    const kept = ok.filter((v) => Math.abs(v - m0) / m0 <= 0.06);
    if (kept.length >= 2) ok = kept;
  }
  const rate = median(ok);
  const used = results.filter((r) => r.rate > 0 && ok.includes(r.rate)).map((r) => r.id);
  return { rate, sources: results, used };
}

// The rate used for pricing. { rate, from: 'live'|'saved'|'manual'|'none', at, sources? }
export async function usdRateInfo(env, { force = false } = {}) {
  const hit = globalThis.__cgUsd;
  if (!force && hit && Date.now() - hit.at < TTL_MS && hit.rate > 0) return hit;
  const live = await fetchUsdRate();
  if (live.rate > 0) {
    const info = { rate: live.rate, from: 'live', at: Date.now(), sources: live.sources, used: live.used };
    globalThis.__cgUsd = info;
    try { await setSetting(env, 'usd_rate_cache', JSON.stringify({ at: Math.floor(Date.now() / 1000), rate: live.rate, used: live.used })); } catch (e) {}
    return info;
  }
  try {
    const saved = JSON.parse((await getSetting(env, 'usd_rate_cache')) || '{}');
    if (saved.rate > 0 && Date.now() / 1000 - saved.at < STALE_OK_SEC) {
      return { rate: saved.rate, from: 'saved', at: saved.at * 1000, sources: live.sources };
    }
  } catch (e) {}
  const manual = parseInt(await getSetting(env, 'usd_rate_toman'), 10) || parseInt(await getSetting(env, 'usdt_rate_toman'), 10) || 0;
  return { rate: manual, from: manual ? 'manual' : 'none', at: Date.now(), sources: live.sources };
}
