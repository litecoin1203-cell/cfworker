// On-chain auto-confirmation for Cloud Gold Pay. Reads the admin's wallet history from free public APIs
// (no keys), finds the transfer whose amount equals an order's unique amount (and memo, if the wallet has
// one), and confirms the order: automatically ('auto'), or by flagging it for a one-tap approval ('detect').
//
// Safety:
// - only the native coin counts (no tokens / IOUs / jettons that could fake an amount)
// - XRP uses delivered_amount (defeats the "partial payment" trick)
// - only confirmed / validated / successful transactions
// - a transaction hash can pay one order only
// - received must be >= the quote (and at most 2% more); a slightly smaller amount goes to manual review
import { first, all, run, getSetting } from './db.js';
import { coinById } from './coins.js';
import { nowSec } from './util.js';

const TIMEOUT_MS = 8000;
const LOOKBACK_SEC = 48 * 3600;

async function getJson(url, init) {
  const opts = { ...(init || {}), headers: { accept: 'application/json', ...((init && init.headers) || {}) } };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(TIMEOUT_MS);
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// "4.72502" with chain precision 7 -> 47250200n (exact integer maths, no float rounding)
export function toUnits(amount, decimals) {
  const [i, f = ''] = String(amount).trim().split('.');
  return BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
const b64ToHex = (b64) => { try { return [...atob(b64.replace(/-/g, '+').replace(/_/g, '/'))].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''); } catch (e) { return b64; } };
const b64ToText = (b64) => { try { return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch (e) { return ''; } };

// Each watcher returns incoming native transfers: [{ txid, units (BigInt, chain precision), memo, time }]
export const WATCHERS = {
  xlm: {
    precision: 7,
    async incoming(address) {
      const j = await getJson(`https://horizon.stellar.org/accounts/${address}/payments?order=desc&limit=50&join=transactions`);
      const recs = (j._embedded && j._embedded.records) || [];
      return recs
        .filter((r) => ['payment', 'path_payment_strict_receive', 'path_payment_strict_send'].includes(r.type) && r.to === address && r.asset_type === 'native' && r.transaction_successful !== false)
        .map((r) => ({ txid: r.transaction_hash, units: toUnits(r.amount, 7), memo: r.transaction && r.transaction.memo != null ? String(r.transaction.memo) : '', time: Math.floor(Date.parse(r.created_at) / 1000) }));
    },
  },
  xrp: {
    precision: 6,
    async incoming(address) {
      const j = await getJson('https://xrplcluster.com/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'account_tx', params: [{ account: address, limit: 50, forward: false, api_version: 1 }] }),
      });
      const txs = (j.result && j.result.transactions) || [];
      const out = [];
      for (const t of txs) {
        const tx = t.tx || t.tx_json || {}, meta = t.meta || {};
        if (!t.validated || tx.TransactionType !== 'Payment' || tx.Destination !== address) continue;
        if (meta.TransactionResult !== 'tesSUCCESS') continue;
        const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
        if (typeof delivered !== 'string') continue; // an object = IOU token, not XRP
        out.push({ txid: tx.hash || t.hash, units: BigInt(delivered), memo: tx.DestinationTag != null ? String(tx.DestinationTag) : '', time: (tx.date || 0) + 946684800 });
      }
      return out;
    },
  },
  trx: {
    precision: 6,
    async incoming(address) {
      const j = await getJson(`https://api.trongrid.io/v1/accounts/${address}/transactions?only_to=true&only_confirmed=true&limit=50`);
      return (j.data || [])
        .filter((t) => t.ret && t.ret[0] && t.ret[0].contractRet === 'SUCCESS' && t.raw_data && t.raw_data.contract && t.raw_data.contract[0] && t.raw_data.contract[0].type === 'TransferContract')
        .map((t) => ({ txid: t.txID, units: BigInt(t.raw_data.contract[0].parameter.value.amount), memo: '', time: Math.floor((t.block_timestamp || 0) / 1000) }));
    },
  },
  ton: {
    precision: 9,
    async incoming(address) {
      const j = await getJson(`https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(address)}&limit=50`);
      const out = [];
      for (const t of j.result || []) {
        const m = t.in_msg || {};
        if (!m.source || !(BigInt(m.value || '0') > 0n)) continue; // external or empty message
        // a bounced transfer sends the coins straight back: ignore it
        if ((t.out_msgs || []).some((o) => o.destination === m.source && BigInt(o.value || '0') > 0n)) continue;
        let memo = m.message || '';
        if (!memo && m.msg_data && m.msg_data.text) memo = b64ToText(m.msg_data.text);
        out.push({ txid: b64ToHex((t.transaction_id && t.transaction_id.hash) || ''), units: BigInt(m.value), memo: String(memo).trim(), time: t.utime || 0 });
      }
      return out;
    },
  },
  algo: {
    precision: 6,
    async incoming(address) {
      const j = await getJson(`https://mainnet-idx.algonode.cloud/v2/accounts/${address}/transactions?tx-type=pay&limit=50`);
      return (j.transactions || [])
        .filter((t) => t['confirmed-round'] && t['payment-transaction'] && t['payment-transaction'].receiver === address)
        .map((t) => ({ txid: t.id, units: BigInt(t['payment-transaction'].amount), memo: t.note ? b64ToText(t.note).trim() : '', time: t['round-time'] || 0 }));
    },
  },
};
export const autoCoins = () => Object.keys(WATCHERS);

// 'auto' = activate by itself, 'detect' = flag for one-tap approval, 'off' = manual only
export async function autoMode(env) {
  const v = String(await getSetting(env, 'coin_auto') || 'auto').trim().toLowerCase();
  return ['auto', 'detect', 'off'].includes(v) ? v : 'auto';
}

// open crypto orders that could still be paid
async function candidates(env, onlyId) {
  const since = nowSec() - LOOKBACK_SEC;
  const coins = autoCoins().map((c) => `'${c}'`).join(',');
  const sql = `SELECT * FROM orders WHERE method = 'coin' AND coin IN (${coins}) AND status IN ('pending','review','expired') AND created_at > ?` + (onlyId ? ' AND id = ?' : ' ORDER BY id LIMIT 40');
  return onlyId ? all(env, sql, since, onlyId) : all(env, sql, since);
}

// a transfer already tied to another live order (also while that order is still being settled)
const TXID_HELD = "status NOT IN ('rejected','cancelled')";
async function txidTaken(env, txid, orderId) {
  return !!(await first(env, `SELECT id FROM orders WHERE txid = ? AND id != ? AND ${TXID_HELD}`, txid, orderId));
}

// Every open coin order's exact amount on its wallet. A transfer of exactly that amount belongs to that order
// only, so it is never handed to another order whose tolerance window happens to cover it.
async function exactOwners(env) {
  const rows = await all(env, "SELECT id, coin, coin_address, coin_amount FROM orders WHERE method = 'coin' AND coin_amount IS NOT NULL AND status IN ('pending','review','expired','settling') AND created_at > ?", nowSec() - LOOKBACK_SEC);
  const map = new Map();
  for (const r of rows) {
    const w = WATCHERS[r.coin];
    if (w) map.set(r.coin + '|' + r.coin_address + '|' + toUnits(r.coin_amount, w.precision), r.id);
  }
  return map;
}

// Tie a transfer to one order atomically: one SQL statement, so two callers racing on the same txid can never
// both win (the check and the write are not separate round trips).
async function claimTxid(env, orderId, txid, setReview) {
  const r = await run(env,
    `UPDATE orders SET txid = ?, status = ${setReview ? "'review', admin_note = NULL" : "CASE WHEN status = 'expired' THEN 'review' ELSE status END"}
     WHERE id = ? AND NOT EXISTS (SELECT 1 FROM orders WHERE txid = ? AND id != ? AND ${TXID_HELD})`,
    txid, orderId, txid, orderId);
  return !!(r && r.meta && r.meta.changes);
}

// Match fetched transfers to orders and confirm them. Returns [{orderId, result}]
async function matchAndConfirm(env, orders, txsByKey, mode) {
  const { settle } = await import('./billing.js');
  const { notifyAdmin, sendCoinNotice } = await import('./telegram.js');
  const done = [];
  const claimed = new Set();
  const owners = await exactOwners(env);
  for (const o of orders) {
    const txs = txsByKey.get(o.coin + '|' + o.coin_address);
    if (!txs) continue;
    const w = WATCHERS[o.coin];
    const want = toUnits(o.coin_amount, w.precision);
    const upper = (want * 102n) / 100n, lower = (want * 95n) / 100n;
    const memoOk = (t) => !o.coin_memo || t.memo === String(o.coin_memo).trim();
    const fresh = (t) => !t.time || t.time >= o.created_at - 120;
    const ownerOf = (t) => owners.get(o.coin + '|' + o.coin_address + '|' + t.units);
    const pool = txs.filter((t) => t.txid && fresh(t) && memoOk(t) && !claimed.has(t.txid) && (ownerOf(t) === undefined || ownerOf(t) === o.id));
    // exact amount first; a little more or a little less only goes to manual review (it could be someone else's
    // payment). A transfer that already paid another order is skipped and the next one is tried.
    const ranked = [
      ...pool.filter((t) => t.units === want).map((t) => [t, 'exact']),
      ...pool.filter((t) => t.units > want && t.units <= upper).map((t) => [t, 'over']),
      ...pool.filter((t) => t.units >= lower && t.units < want).map((t) => [t, 'under']),
    ];
    let hit = null, fit = 'exact';
    for (const [t, f] of ranked) {
      if (!(await txidTaken(env, t.txid, o.id))) { hit = t; fit = f; break; }
    }
    if (!hit) continue;
    claimed.add(hit.txid);
    const auto = mode === 'auto' && fit === 'exact';
    if (!(await claimTxid(env, o.id, hit.txid, !auto))) continue; // another caller tied this transfer to another order first
    const user = await first(env, 'SELECT * FROM users WHERE id = ?', o.user_id);
    if (auto) {
      const fresh2 = await first(env, 'SELECT * FROM orders WHERE id = ?', o.id);
      try {
        await settle(env, fresh2);
        await notifyAdmin(env, `⚡ تأیید خودکار روی بلاک‌چین — سفارش #${o.id}\n${o.coin_amount} ${o.coin.toUpperCase()} از ${user.email}\nهش: ${hit.txid}`);
        done.push({ orderId: o.id, result: 'paid' });
      } catch (e) {
        // settle() already put it back; a busy order is being settled by another caller right now
        await run(env, "UPDATE orders SET status = 'review' WHERE id = ? AND status NOT IN ('paid', 'settling')", o.id);
        done.push({ orderId: o.id, result: 'review' }); // settle() already told the admin why (with a retry button)
      }
    } else {
      const fresh2 = await first(env, 'SELECT * FROM orders WHERE id = ?', o.id);
      const diff = (n) => (Number(n) / 10 ** w.precision).toFixed(w.precision);
      await sendCoinNotice(env, fresh2, user, fit === 'under'
        ? `⚠️ واریز روی بلاک‌چین پیدا شد ولی ${diff(want - hit.units)} کمتر از مبلغ سفارش است (احتمالاً کارمزد صرافی). خودت تصمیم بگیر.`
        : fit === 'over'
          ? `⚠️ واریز روی بلاک‌چین پیدا شد ولی ${diff(hit.units - want)} بیشتر از مبلغ دقیق سفارش است. مطمئن شو مال همین کاربر است، بعد تأیید کن.`
          : '✅ این واریز روی بلاک‌چین پیدا و با مبلغ سفارش تطبیق داده شد.');
      done.push({ orderId: o.id, result: 'review' });
    }
  }
  return done;
}

async function fetchFor(orders) {
  const keys = [...new Set(orders.map((o) => o.coin + '|' + o.coin_address))];
  const map = new Map();
  await Promise.all(keys.map(async (k) => {
    const [coin, addr] = k.split('|');
    try { map.set(k, await WATCHERS[coin].incoming(addr)); } catch (e) { /* this chain's API is down: try next minute */ }
  }));
  return map;
}

// Cron: every open order, one API call per wallet.
export async function scanAll(env) {
  const mode = await autoMode(env);
  if (mode === 'off') return [];
  const orders = await candidates(env);
  if (!orders.length) return [];
  return matchAndConfirm(env, orders, await fetchFor(orders), mode);
}

// While the user watches the payment screen: check this order now (at most every 12 seconds).
export async function checkOrder(env, order) {
  if (!order || order.method !== 'coin' || !WATCHERS[order.coin] || !['pending', 'review', 'expired'].includes(order.status)) return null;
  const mode = await autoMode(env);
  if (mode === 'off' || (order.status === 'review' && order.txid && mode !== 'auto')) return null;
  const seen = (globalThis.__cgChk = globalThis.__cgChk || {});
  if (seen[order.id] && Date.now() - seen[order.id] < 12000) return null;
  seen[order.id] = Date.now();
  const orders = await candidates(env, order.id);
  if (!orders.length) return null;
  const r = await matchAndConfirm(env, orders, await fetchFor(orders), mode);
  return r[0] || null;
}
