// Cloud Gold Pay: crypto paid straight to the admin's own wallets (no third-party gateway, no fees).
// Each order gets a live quote with a unique amount (so every transfer maps to exactly one order), a
// 30-minute price lock, and the admin confirms the transfer from Telegram with one tap.
import { getSettings, getSetting, setSetting } from './db.js';
import { usdRateInfo } from './usdrate.js';
import { deadline } from './util.js';

// Only networks where sending costs almost nothing (no Tether, no high-fee chains like BTC/ETH).
// `decimals` = how precisely the amount is shown and matched. `memo` = networks where exchange wallets need a
// Memo/Tag (without it the deposit is lost), set with wallet_<id>_memo.
export const COINS = [
  { id: 'xlm', symbol: 'XLM', name: 'Stellar', fa: 'استلار', network: 'Stellar', color: '#14B6E7', decimals: 5, gecko: 'stellar', fee: 'تقریباً رایگان', memo: 'Memo', tx: 'https://stellar.expert/explorer/public/tx/', addr: 'https://stellar.expert/explorer/public/account/' },
  { id: 'xrp', symbol: 'XRP', name: 'XRP', fa: 'ریپل', network: 'XRP Ledger', color: '#3A4B5E', decimals: 5, gecko: 'ripple', fee: 'تقریباً رایگان', memo: 'Destination Tag', tx: 'https://xrpscan.com/tx/', addr: 'https://xrpscan.com/account/' },
  { id: 'trx', symbol: 'TRX', name: 'TRON', fa: 'ترون', network: 'TRON (TRC20)', color: '#EB0029', decimals: 3, gecko: 'tron', fee: 'تقریباً رایگان', tx: 'https://tronscan.org/#/transaction/', addr: 'https://tronscan.org/#/address/' },
  { id: 'sol', symbol: 'SOL', name: 'Solana', fa: 'سولانا', network: 'Solana', color: '#9945FF', decimals: 5, gecko: 'solana', fee: 'کمتر از ۱ سنت', tx: 'https://solscan.io/tx/', addr: 'https://solscan.io/account/' },
  { id: 'ton', symbol: 'TON', name: 'Toncoin', fa: 'تون‌کوین', network: 'TON', color: '#0098EA', decimals: 4, gecko: 'the-open-network', fee: 'حدود ۱ سنت', memo: 'Memo / Comment', tx: 'https://tonviewer.com/transaction/', addr: 'https://tonviewer.com/' },
  { id: 'ltc', symbol: 'LTC', name: 'Litecoin', fa: 'لایت‌کوین', network: 'Litecoin', color: '#345D9D', decimals: 5, gecko: 'litecoin', fee: 'کمتر از ۱ سنت', tx: 'https://blockchair.com/litecoin/transaction/', addr: 'https://blockchair.com/litecoin/address/' },
  { id: 'doge', symbol: 'DOGE', name: 'Dogecoin', fa: 'دوج‌کوین', network: 'Dogecoin', color: '#C2A633', decimals: 3, gecko: 'dogecoin', fee: 'حدود ۱ سنت', tx: 'https://blockchair.com/dogecoin/transaction/', addr: 'https://blockchair.com/dogecoin/address/' },
  { id: 'bch', symbol: 'BCH', name: 'Bitcoin Cash', fa: 'بیت‌کوین کش', network: 'Bitcoin Cash', color: '#0AC18E', decimals: 7, gecko: 'bitcoin-cash', fee: 'کمتر از ۱ سنت', tx: 'https://blockchair.com/bitcoin-cash/transaction/', addr: 'https://blockchair.com/bitcoin-cash/address/' },
  { id: 'bnb', symbol: 'BNB', name: 'BNB', fa: 'بی‌ان‌بی', network: 'BNB Smart Chain (BEP20)', color: '#F3BA2F', decimals: 6, gecko: 'binancecoin', fee: 'حدود ۱ سنت', tx: 'https://bscscan.com/tx/', addr: 'https://bscscan.com/address/' },
  { id: 'pol', symbol: 'POL', name: 'Polygon', fa: 'پالیگان', network: 'Polygon PoS', color: '#8247E5', decimals: 4, gecko: 'polygon-ecosystem-token', fee: 'کمتر از ۱ سنت', tx: 'https://polygonscan.com/tx/', addr: 'https://polygonscan.com/address/' },
  { id: 'algo', symbol: 'ALGO', name: 'Algorand', fa: 'الگوراند', network: 'Algorand', color: '#4A4A55', decimals: 4, gecko: 'algorand', fee: 'تقریباً رایگان', tx: 'https://allo.info/tx/', addr: 'https://allo.info/account/' },
];
// address formats, checked when the admin saves a wallet (a wrong address means lost money)
const ADDR = {
  xlm: /^G[A-Z2-7]{55}$/,
  xrp: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  trx: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  ton: /^((EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}|-?[01]:[a-fA-F0-9]{64})$/,
  ltc: /^(ltc1[a-z0-9]{25,90}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,33})$/,
  doge: /^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$/,
  bch: /^((bitcoincash:)?[qp][a-z0-9]{41}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
  bnb: /^0x[a-fA-F0-9]{40}$/,
  pol: /^0x[a-fA-F0-9]{40}$/,
  algo: /^[A-Z2-7]{58}$/,
};
// memo formats: XRP tags are numbers, Stellar text memos are at most 28 bytes
const MEMO = { xlm: /^.{1,28}$/, xrp: /^\d{1,10}$/, ton: /^.{1,120}$/ };
export const memoKey = (c) => `wallet_${c.id}_memo`;
export const validMemo = (coinId, memo) => !!(MEMO[coinId] && MEMO[coinId].test(String(memo || '').trim()));
export const validAddress = (coinId, addr) => !!(ADDR[coinId] && ADDR[coinId].test(String(addr || '').trim()));

export const coinById = (id) => COINS.find((c) => c.id === String(id || '').toLowerCase()) || null;
export const walletKey = (c) => `wallet_${c.id}`;

// live from Iranian exchanges (see usdrate.js); the manual setting is only a last-resort fallback
export async function usdRate(env) {
  return (await usdRateInfo(env)).rate;
}

// coins the admin has given a wallet address for
export async function enabledCoins(env) {
  const s = await getSettings(env);
  return COINS.filter((c) => validAddress(c.id, s[walletKey(c)]));
}

export const coinOut = (c) => ({ id: c.id, symbol: c.symbol, name: c.name, fa: c.fa, network: c.network, color: c.color, fee: c.fee, memo: c.memo || null });

// ---------------- live prices (USD): several free sources merged coin by coin, a saved copy as a last resort ----
// CryptoCompare used to be the second source; since 2026 it answers 401 "API key required" to every keyless call,
// so a CoinGecko hiccup (it rate-limits shared server addresses) left no price at all and every crypto order
// failed with price_unavailable. Now each coin takes the first source that knows it, and the others fill gaps.
const PRICE_TTL_MS = 60 * 1000;
const STALE_OK_SEC = 6 * 3600;

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'CloudGold/1.0' }, signal: deadline(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const pos = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : 0; };

export const PRICE_SOURCES = [
  {
    id: 'coingecko', name: 'CoinGecko',
    async read() {
      const j = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${COINS.map((c) => c.gecko).join(',')}&vs_currencies=usd`);
      const out = {};
      for (const c of COINS) { const v = pos(j[c.gecko] && j[c.gecko].usd); if (v) out[c.id] = v; }
      return out;
    },
  },
  {
    // KuCoin: no key, one call for every coin (it has no TON; Coinbase has)
    id: 'kucoin', name: 'KuCoin',
    async read() {
      const j = await getJson(`https://api.kucoin.com/api/v1/prices?base=USD&currencies=${COINS.map((c) => c.symbol).join(',')}`);
      const d = j.data || {};
      const out = {};
      for (const c of COINS) { const v = pos(d[c.symbol]); if (v) out[c.id] = v; }
      return out;
    },
  },
  {
    // Coinbase: how much of each coin one dollar buys (no TRX; KuCoin has)
    id: 'coinbase', name: 'Coinbase',
    async read() {
      const j = await getJson('https://api.coinbase.com/v2/exchange-rates?currency=USD');
      const d = (j.data && j.data.rates) || {};
      const out = {};
      for (const c of COINS) { const per = pos(d[c.symbol]); if (per) out[c.id] = 1 / per; }
      return out;
    },
  },
];

// Every coin from the first source that has it. Returns { p, sources: [{id, name, coins, error?}] }
export async function fetchPrices() {
  const p = {};
  const sources = [];
  for (const s of PRICE_SOURCES) {
    if (COINS.every((c) => p[c.id])) break; // nothing left to fill
    try {
      const got = await s.read();
      for (const [k, v] of Object.entries(got)) if (!p[k]) p[k] = v;
      sources.push({ id: s.id, name: s.name, coins: Object.keys(got).length });
    } catch (e) { sources.push({ id: s.id, name: s.name, coins: 0, error: String(e.message || e).slice(0, 60) }); }
  }
  return { p, sources };
}

export async function prices(env) {
  const hit = globalThis.__cgPrices;
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.p;
  let saved = {};
  try { saved = JSON.parse(await getSetting(env, 'coin_prices_cache') || '{}'); } catch (e) {}
  const { p } = await fetchPrices();
  if (Object.keys(p).length) {
    // a coin no source answered for this time keeps its saved price while that is recent enough
    const old = saved.p && Date.now() / 1000 - saved.at < STALE_OK_SEC ? saved.p : {};
    const merged = { ...old, ...p };
    globalThis.__cgPrices = { at: Date.now(), p: merged };
    try { await setSetting(env, 'coin_prices_cache', JSON.stringify({ at: Math.floor(Date.now() / 1000), p })); } catch (e) {}
    return merged;
  }
  if (saved.p && Date.now() / 1000 - saved.at < STALE_OK_SEC) return saved.p;
  return null;
}

// Amount of `coin` for `toman`, rounded up and made unique per order (a few smallest units added, ~cents).
// `bump` moves past an amount another open order already has (orders.js attachCoinQuote).
export function quoteAmount(toman, usdToman, priceUsd, coin, orderId, bump = 0) {
  const step = 10 ** -coin.decimals;
  const raw = toman / usdToman / priceUsd;
  const base = Math.ceil(raw / step) * step;
  const unique = base + ((orderId % 89) + 1 + bump) * step;
  return unique.toFixed(coin.decimals);
}

// loose sanity check: hex hashes (XRP/TRX/LTC/DOGE/BCH/BNB/POL), base58 (SOL), base32 (ALGO), base64/hex (TON)
export function cleanTxid(txid) {
  const t = String(txid || '').trim();
  if (!t) return '';
  if (t.length < 20 || t.length > 120 || !/^[A-Za-z0-9+/=_:-]+$/.test(t)) return null;
  return t;
}
