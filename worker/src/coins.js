// Cloud Gold Pay: crypto paid straight to the admin's own wallets (no third-party gateway, no fees).
// Each order gets a live quote with a unique amount (so every transfer maps to exactly one order), a
// 30-minute price lock, and the admin confirms the transfer from Telegram with one tap.
import { getSettings, getSetting, setSetting } from './db.js';
import { usdRateInfo } from './usdrate.js';

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

// ---------------- live prices (USD), two free sources + a saved copy as a last resort ----------------
const PRICE_TTL_MS = 60 * 1000;
const STALE_OK_SEC = 6 * 3600;

async function fromCoinGecko() {
  const ids = COINS.map((c) => c.gecko).join(',');
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('coingecko ' + r.status);
  const j = await r.json();
  const out = {};
  for (const c of COINS) { const v = j[c.gecko] && j[c.gecko].usd; if (v > 0) out[c.id] = v; }
  return out;
}
async function fromCryptoCompare() {
  const syms = COINS.map((c) => c.symbol).join(',');
  const r = await fetch(`https://min-api.cryptocompare.com/data/pricemulti?fsyms=${syms}&tsyms=USD`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('cryptocompare ' + r.status);
  const j = await r.json();
  const out = {};
  for (const c of COINS) { const v = j[c.symbol] && j[c.symbol].USD; if (v > 0) out[c.id] = v; }
  return out;
}

export async function prices(env) {
  const hit = globalThis.__cgPrices;
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.p;
  for (const src of [fromCoinGecko, fromCryptoCompare]) {
    try {
      const p = await src();
      if (Object.keys(p).length >= COINS.length - 2) {
        globalThis.__cgPrices = { at: Date.now(), p };
        try { await setSetting(env, 'coin_prices_cache', JSON.stringify({ at: Math.floor(Date.now() / 1000), p })); } catch (e) {}
        return p;
      }
    } catch (e) { /* try the next source */ }
  }
  try {
    const saved = JSON.parse(await getSetting(env, 'coin_prices_cache') || '{}');
    if (saved.p && Date.now() / 1000 - saved.at < STALE_OK_SEC) return saved.p;
  } catch (e) {}
  return null;
}

// Amount of `coin` for `toman`, rounded up and made unique per order (a few smallest units added, ~cents).
export function quoteAmount(toman, usdToman, priceUsd, coin, orderId) {
  const step = 10 ** -coin.decimals;
  const raw = toman / usdToman / priceUsd;
  const base = Math.ceil(raw / step) * step;
  const unique = base + ((orderId % 89) + 1) * step;
  return unique.toFixed(coin.decimals);
}

// loose sanity check: hex hashes (XRP/TRX/LTC/DOGE/BCH/BNB/POL), base58 (SOL), base32 (ALGO), base64/hex (TON)
export function cleanTxid(txid) {
  const t = String(txid || '').trim();
  if (!t) return '';
  if (t.length < 20 || t.length > 120 || !/^[A-Za-z0-9+/=_:-]+$/.test(t)) return null;
  return t;
}
