// Orders (plan purchase & wallet top-up), receipts, crypto webhook, wallet and referral.
import { first, all, run, insert, getSettings, getSettingInt } from './db.js';
import { json, err, nowSec } from './util.js';
import { payWithWallet, settle, BillingError } from './billing.js';
import { cryptoEnabled, tomanToUsd, createInvoice, verifyIpn, PAID_STATES, FAILED_STATES } from './nowpayments.js';
import { sendReceipt, notifyAdmin } from './telegram.js';
import { planName } from './account.js';
import { bankOf, cardDigits } from './banks.js';
import { coinById, walletKey, memoKey, enabledCoins, usdRate, prices, quoteAmount, cleanTxid } from './coins.js';
import { sendCoinNotice } from './telegram.js';

const cardOpen = (o) => o.method === 'card' && ['pending', 'review', 'rejected'].includes(o.status);

// What showing these orders needs, read once for all of them (the order list must stay a handful of D1 queries
// however many orders the user has: an invocation may send at most 50).
async function outContext(env, rows) {
  const planIds = [...new Set(rows.flatMap((o) => [o.plan_id, o.activate_plan_id]).filter(Boolean))];
  const resultIds = [...new Set(rows.map((o) => o.result_order_id).filter(Boolean))];
  const plans = new Map(planIds.length
    ? (await all(env, 'SELECT * FROM plans WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(planIds))).map((p) => [p.id, p]) : []);
  const results = new Map(resultIds.length
    ? (await all(env, 'SELECT id, status FROM orders WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(resultIds))).map((r) => [r.id, r.status]) : []);
  const settings = rows.some(cardOpen) ? await getSettings(env) : null;
  return { plans, results, settings };
}

async function orderOut(env, o, ctx = null) {
  ctx = ctx || (await outContext(env, [o]));
  const plan = o.plan_id ? ctx.plans.get(o.plan_id) || null : null;
  const target = o.activate_plan_id ? ctx.plans.get(o.activate_plan_id) || null : null;
  let card = null;
  if (cardOpen(o)) {
    const s = ctx.settings;
    const b = bankOf(s.card_number);
    card = {
      number: cardDigits(s.card_number), holder: s.card_holder, bank: s.card_bank || b.name, color1: b.c1, color2: b.c2,
      amount_rial: o.amount_toman * 10,
      auto: s.card_auto !== 'off' && !!String(s.sms_senders || '').trim(), // a trusted bank SMS confirms it by itself
    };
  }
  let activated = null;
  if (o.result_order_id) {
    const r = ctx.results.get(o.result_order_id);
    activated = r ? r === 'paid' : false;
  }
  return {
    id: o.id, kind: o.kind, plan_id: o.plan_id, plan_name: plan ? planName(plan.name) : null,
    activate_plan_id: o.activate_plan_id || null, activate_plan_name: target ? planName(target.name) : null, plan_activated: activated,
    amount_toman: o.amount_toman, list_price_toman: o.list_price_toman || null, method: o.method, status: o.status === 'settling' ? 'review' : o.status, // 'settling' lasts a moment; the app knows it as review
    created_at: new Date(o.created_at * 1000).toISOString(),
    paid_at: o.paid_at ? new Date(o.paid_at * 1000).toISOString() : null,
    card, crypto_pay_url: o.crypto_pay_url, crypto_amount_usd: o.crypto_amount_usd, admin_note: o.admin_note,
    coin: coinInfo(o), txid: o.txid || null,
  };
}

const AUTO_COINS = ['xlm', 'xrp', 'trx', 'ton', 'algo']; // chains watched by chainwatch.js

function coinInfo(o) {
  if (o.method !== 'coin' || !o.coin) return null;
  const c = coinById(o.coin);
  if (!c) return null;
  return {
    id: c.id, symbol: c.symbol, name: c.name, fa: c.fa, network: c.network, color: c.color,
    amount: o.coin_amount, address: o.coin_address, price_usd: o.coin_price_usd, fee: c.fee,
    memo: o.coin_memo || null, memo_label: o.coin_memo ? c.memo : null,
    expires_at: o.coin_expires_at ? new Date(o.coin_expires_at * 1000).toISOString() : null,
    seconds_left: o.coin_expires_at ? Math.max(0, o.coin_expires_at - nowSec()) : 0,
    explorer: c.addr + o.coin_address,
    auto: AUTO_COINS.includes(c.id),
  };
}

// 1..99 toman, avoiding an amount that another open card order already uses
async function uniqueSuffix(env, order) {
  const since = nowSec() - 36 * 3600;
  for (let i = 0; i < 99; i++) {
    const sfx = ((order.id * 37 + i) % 99) + 1;
    const clash = await first(env, "SELECT id FROM orders WHERE method = 'card' AND id != ? AND amount_toman = ? AND status IN ('pending','review') AND created_at > ?", order.id, order.amount_toman + sfx, since);
    if (!clash) return sfx;
  }
  return (order.id % 99) + 1;
}

// a crypto quote that ran out without the user saying they paid is closed, so a stale price is never used
const quoteRanOut = (o, now) => o.method === 'coin' && o.status === 'pending' && o.coin_expires_at && o.coin_expires_at < now;
async function expireIfDue(env, o) {
  if (quoteRanOut(o, nowSec())) {
    await run(env, "UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'", o.id);
    o.status = 'expired';
  }
  return o;
}

// Lock a quote for this order: unique amount of the chosen coin, the admin's wallet, and an expiry.
async function attachCoinQuote(env, order, coinId) {
  const c = coinById(coinId);
  const enabled = await enabledCoins(env);
  if (!c || !enabled.some((x) => x.id === c.id)) throw err(400, 'coin_unavailable', 'این ارز الان برای پرداخت فعال نیست.', 'coin');
  const usd = await usdRate(env);
  const p = await prices(env);
  if (!usd || !p || !p[c.id]) throw err(503, 'price_unavailable', 'قیمت لحظه‌ای ارز در دسترس نیست. چند دقیقه دیگر امتحان کن.');
  const s = await getSettings(env);
  const minutes = Math.max(10, Math.min(180, parseInt(s.coin_minutes, 10) || 30));
  const address = String(s[walletKey(c)]).trim();
  // the exact amount must belong to this order alone among orders that could still be paid on this wallet
  // (chainwatch auto-confirms only an exact match, and gives an exact amount to its owner only)
  let amount;
  for (let bump = 0; bump < 500; bump++) {
    amount = quoteAmount(order.amount_toman, usd, p[c.id], c, order.id, bump);
    const clash = await first(env, "SELECT id FROM orders WHERE method = 'coin' AND coin = ? AND coin_address = ? AND coin_amount = ? AND id != ? AND status NOT IN ('paid','cancelled','rejected') AND created_at > ?",
      c.id, address, amount, order.id, nowSec() - 48 * 3600);
    if (!clash) break;
  }
  const memo = c.memo ? String(s[memoKey(c)] || '').trim() || null : null;
  await run(env, 'UPDATE orders SET coin = ?, coin_amount = ?, coin_address = ?, coin_memo = ?, coin_price_usd = ?, coin_expires_at = ? WHERE id = ?',
    c.id, amount, address, memo, p[c.id], nowSec() + minutes * 60, order.id);
}

// ---------------- discount codes ----------------
// how long an unpaid order keeps its discount code reserved: as long as it can still be paid (a coin transfer
// is matched for 48h, also on an expired quote; a rejected card order can get a new receipt or SMS)
const COUPON_HOLD_SEC = 48 * 3600;
const OPEN_STATUSES = "'pending','review','settling','expired','rejected'";

async function findCoupon(env, user, code, plan) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return null;
  const c = await first(env, 'SELECT * FROM coupons WHERE code = ?', code);
  if (!c || !c.is_active) throw err(400, 'coupon_invalid', 'این کد تخفیف معتبر نیست.', 'coupon');
  if (c.expires_at && c.expires_at < nowSec()) throw err(400, 'coupon_expired', 'مهلت این کد تخفیف تمام شده است.', 'coupon');
  if (c.plan_id && plan && c.plan_id !== plan.id) throw err(400, 'coupon_wrong_plan', 'این کد تخفیف برای این پلن نیست.', 'coupon');
  if (await first(env, 'SELECT 1 FROM coupon_uses WHERE coupon_id = ? AND user_id = ?', c.id, user.id)) {
    throw err(400, 'coupon_used', 'این کد تخفیف را قبلاً استفاده کرده‌ای.', 'coupon');
  }
  // a use is only recorded when an order is paid, so open orders that carry the code count too: otherwise one
  // user could open two orders with it and pay both, and a nearly used-up code could be oversold
  const since = nowSec() - COUPON_HOLD_SEC;
  const open = await all(env, `SELECT user_id FROM orders WHERE coupon_id = ? AND status IN (${OPEN_STATUSES}) AND created_at > ?`, c.id, since);
  if (open.some((o) => o.user_id === user.id)) {
    throw err(400, 'coupon_in_use', 'یک سفارش باز با این کد تخفیف داری. اول آن را پرداخت یا لغو کن.', 'coupon');
  }
  if (c.max_uses && c.used + open.length >= c.max_uses) throw err(400, 'coupon_used_up', 'ظرفیت این کد تخفیف پر شده است.', 'coupon');
  return c;
}
const discounted = (price, c) => (c ? Math.max(0, Math.round((price * (100 - c.percent)) / 100 / 1000) * 1000) : price);

export async function checkCoupon(env, user, body) {
  const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', body.plan_id);
  if (!plan || !plan.is_active || plan.archived) throw err(404, 'plan_not_found', 'این پلن در دسترس نیست.');
  const c = await findCoupon(env, user, body.code, plan);
  if (!c) throw err(400, 'coupon_invalid', 'کد تخفیف را وارد کن.', 'coupon');
  return json({ code: c.code, percent: c.percent, price_toman: plan.price_toman, final_toman: discounted(plan.price_toman, c) });
}

export async function createOrder(env, user, body) {
  const method = body.method;
  if (!['wallet', 'card', 'crypto', 'coin'].includes(method)) throw err(422, 'invalid_input', 'روش پرداخت را انتخاب کن.', 'method');
  if (method === 'coin' && !coinById(body.coin)) throw err(422, 'invalid_input', 'یک ارز دیجیتال انتخاب کن.', 'coin');
  let orderId;
  if (body.plan_id) {
    const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', body.plan_id);
    if (!plan || !plan.is_active || plan.archived) throw err(404, 'plan_not_found', 'این پلن در دسترس نیست.');
    const coupon = await findCoupon(env, user, body.coupon_code, plan);
    const price = discounted(plan.price_toman, coupon);
    const fresh = await first(env, 'SELECT wallet_balance FROM users WHERE id = ?', user.id);
    const bal = fresh.wallet_balance;
    if (body.use_wallet && method !== 'wallet' && bal > 0 && bal < price && price > 0) {
      // pay only the difference by card/crypto; when it lands the plan is bought from the wallet automatically
      orderId = await insert(env, 'orders', {
        user_id: user.id, kind: 'topup', amount_toman: price - bal, method, activate_plan_id: plan.id,
        activate_price_toman: price, coupon_id: coupon ? coupon.id : null, list_price_toman: plan.price_toman, created_at: nowSec(),
      });
    } else {
      const m = price === 0 || (body.use_wallet && bal >= price) ? 'wallet' : method;
      orderId = await insert(env, 'orders', {
        user_id: user.id, kind: 'plan', plan_id: plan.id, amount_toman: price, method: m,
        coupon_id: coupon ? coupon.id : null, list_price_toman: plan.price_toman, created_at: nowSec(),
      });
    }
  } else if (body.topup_toman) {
    if (method === 'wallet') throw err(400, 'bad_method', 'کیف پول را با کارت یا ارز دیجیتال شارژ کن.');
    const amount = Math.floor(Number(body.topup_toman) || 0);
    const min = await getSettingInt(env, 'min_topup_toman');
    if (amount < min) throw err(400, 'amount_too_small', `حداقل مبلغ شارژ ${min.toLocaleString('fa-IR')} تومان است.`);
    if (amount > 100000000) throw err(400, 'amount_too_large', 'مبلغ خیلی زیاد است.');
    orderId = await insert(env, 'orders', { user_id: user.id, kind: 'topup', amount_toman: amount, method, created_at: nowSec() });
  } else {
    throw err(400, 'bad_request', 'یک پلن یا مبلغ شارژ انتخاب کن.');
  }
  let order = await first(env, 'SELECT * FROM orders WHERE id = ?', orderId);

  if (order.method === 'card') {
    const s = await getSettings(env);
    if (!s.card_number) {
      await run(env, "UPDATE orders SET status = 'cancelled' WHERE id = ?", order.id);
      throw err(400, 'method_unavailable', 'کارت‌به‌کارت الان فعال نیست.');
    }
    // a unique amount (e.g. 189,037 instead of 189,000) lets the bank SMS point at exactly this order
    if (s.card_unique !== '0' && order.amount_toman > 0) {
      await run(env, 'UPDATE orders SET amount_toman = amount_toman + ? WHERE id = ?', await uniqueSuffix(env, order), order.id);
    }
  } else if (order.method === 'wallet') {
    try { await payWithWallet(env, user, order); }
    catch (e) { if (e instanceof BillingError) throw err(400, e.code, e.message); throw e; }
  } else if (order.method === 'coin') {
    try { await attachCoinQuote(env, order, body.coin); }
    catch (e) { await run(env, "UPDATE orders SET status = 'cancelled' WHERE id = ?", order.id); throw e; }
  } else if (order.method === 'crypto') {
    if (!cryptoEnabled(env)) {
      await run(env, "UPDATE orders SET status = 'cancelled' WHERE id = ?", order.id);
      throw err(400, 'method_unavailable', 'پرداخت کریپتو الان فعال نیست.');
    }
    try {
      const usd = tomanToUsd(order.amount_toman, await getSettingInt(env, 'usdt_rate_toman'));
      const inv = await createInvoice(env, order.id, usd, `Cloud Gold order #${order.id}`);
      await run(env, 'UPDATE orders SET crypto_invoice_id = ?, crypto_pay_url = ?, crypto_amount_usd = ? WHERE id = ?', inv.id, inv.url, String(usd), order.id);
    } catch (e) {
      await run(env, "UPDATE orders SET status = 'cancelled' WHERE id = ?", order.id);
      throw err(502, 'crypto_error', 'ساخت صورت‌حساب کریپتو ممکن نشد. دوباره امتحان کن.');
    }
  }
  order = await first(env, 'SELECT * FROM orders WHERE id = ?', orderId);
  return json(await orderOut(env, order), 201);
}

export async function listOrders(env, user) {
  const rows = await all(env, 'SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 50', user.id);
  const now = nowSec();
  const due = rows.filter((o) => quoteRanOut(o, now));
  if (due.length) {
    await run(env, "UPDATE orders SET status = 'expired' WHERE id IN (SELECT value FROM json_each(?)) AND status = 'pending'", JSON.stringify(due.map((o) => o.id)));
    for (const o of due) o.status = 'expired';
  }
  const ctx = await outContext(env, rows);
  return json(await Promise.all(rows.map((o) => orderOut(env, o, ctx))));
}

async function ownOrder(env, user, orderId) {
  const o = await first(env, 'SELECT * FROM orders WHERE id = ?', orderId);
  if (!o || o.user_id !== user.id) throw err(404, 'not_found', 'سفارش پیدا نشد.');
  return o;
}

export async function getOrder(env, user, orderId) {
  let o = await ownOrder(env, user, orderId);
  // the payment screen polls this: look on the blockchain right now so the user sees it within seconds
  if (o.method === 'coin') {
    try {
      const { checkOrder } = await import('./chainwatch.js');
      if (await checkOrder(env, o)) o = await first(env, 'SELECT * FROM orders WHERE id = ?', o.id);
    } catch (e) { /* the cron will try again */ }
  }
  return json(await orderOut(env, await expireIfDue(env, o)));
}

// "I paid": the user sent the crypto (optionally with the transaction hash). The admin gets a one-tap check.
export async function markCoinPaid(env, user, orderId, body) {
  const order = await ownOrder(env, user, orderId);
  if (order.method !== 'coin') throw err(400, 'bad_state', 'این سفارش پرداخت ارز دیجیتال نیست.');
  if (order.status === 'paid') return json(await orderOut(env, order));
  if (!['pending', 'expired', 'review', 'rejected'].includes(order.status)) throw err(400, 'bad_state', 'این سفارش بسته شده است.');
  const txid = cleanTxid(body.txid);
  if (txid === null) throw err(422, 'invalid_input', 'هش تراکنش درست به نظر نمی‌رسد. دوباره کپی کن.', 'txid');
  const same = txid && (await first(env, "SELECT id FROM orders WHERE txid = ? AND id != ? AND status IN ('review','paid')", txid, order.id));
  if (same) throw err(409, 'txid_used', 'این هش تراکنش قبلاً برای سفارش دیگری ثبت شده است.', 'txid');
  const wasReview = order.status === 'review';
  await run(env, "UPDATE orders SET status = 'review', txid = COALESCE(?, txid), admin_note = NULL WHERE id = ? AND status NOT IN ('paid', 'settling')", txid || null, order.id);
  const fresh = await first(env, 'SELECT * FROM orders WHERE id = ?', order.id);
  if (!wasReview || txid) await sendCoinNotice(env, fresh, user);
  return json(await orderOut(env, fresh));
}

const MAGIC = [
  [[0xff, 0xd8, 0xff], 'image/jpeg', '.jpg'],
  [[0x89, 0x50, 0x4e, 0x47], 'image/png', '.png'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif', '.gif'],
  [[0x52, 0x49, 0x46, 0x46], 'image/webp', '.webp'],
];
function sniff(bytes) {
  for (const [magic, type, ext] of MAGIC) {
    if (magic.every((b, i) => bytes[i] === b)) return { type, ext };
  }
  return null;
}

export async function uploadReceipt(env, user, orderId, request) {
  const order = await ownOrder(env, user, orderId);
  if (order.method !== 'card' || !['pending', 'review', 'rejected'].includes(order.status)) {
    throw err(400, 'bad_state', 'برای این سفارش نمی‌شود رسید فرستاد.');
  }
  // refuse an oversized upload before reading it into memory (the photo itself must stay under 8 MB)
  if (Number(request.headers.get('content-length') || 0) > 9 * 1024 * 1024) throw err(413, 'too_large', 'حجم عکس باید کمتر از ۸ مگابایت باشد.');
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw err(400, 'bad_file', 'عکس رسید را انتخاب کن.');
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw err(413, 'too_large', 'حجم عکس باید کمتر از ۸ مگابایت باشد.');
  const kind = sniff(buf);
  if (!kind) throw err(400, 'bad_file', 'عکس رسید را بفرست (JPG، PNG یا WEBP).');
  const ref = String(form.get('ref') || '').trim().slice(0, 64) || null;
  // the same upload sent again (its first answer was lost on a bad line): already with the admin, don't send it twice
  const uploadId = String(form.get('upload_id') || '').trim().slice(0, 64) || null;
  if (uploadId && order.receipt_upload === uploadId && order.status === 'review') return json(await orderOut(env, order));
  const fileId = await sendReceipt(env, order, user, buf, `receipt_${order.id}${kind.ext}`, kind.type);
  await run(env, "UPDATE orders SET status = 'review', receipt_ref = ?, receipt_file_id = ?, receipt_upload = ?, admin_note = NULL WHERE id = ? AND status NOT IN ('paid', 'settling')", ref, fileId, uploadId, order.id);
  if (!env.TELEGRAM_CHAT_ID) await notifyAdmin(env, `رسید جدید برای سفارش #${order.id} آمد ولی TELEGRAM_CHAT_ID تنظیم نشده.`);
  return json(await orderOut(env, await first(env, 'SELECT * FROM orders WHERE id = ?', order.id)));
}

export async function cancelOrder(env, user, orderId) {
  const order = await expireIfDue(env, await ownOrder(env, user, orderId));
  if (!['pending', 'expired'].includes(order.status)) throw err(400, 'bad_state', 'فقط سفارش پرداخت‌نشده لغو می‌شود.');
  await run(env, "UPDATE orders SET status = 'cancelled' WHERE id = ?", order.id);
  return json(await orderOut(env, await first(env, 'SELECT * FROM orders WHERE id = ?', order.id)));
}

export async function nowpaymentsIpn(env, request) {
  const raw = await request.text();
  let payload;
  try { payload = await verifyIpn(env, raw, request.headers.get('x-nowpayments-sig')); }
  catch (e) { throw err(401, 'bad_signature', 'Invalid signature'); }
  const orderId = parseInt(payload.order_id, 10);
  const order = Number.isFinite(orderId) ? await first(env, 'SELECT * FROM orders WHERE id = ?', orderId) : null;
  if (!order) return json({ ok: true, ignored: 'unknown order' });
  if (String(payload.invoice_id || order.crypto_invoice_id) !== String(order.crypto_invoice_id)) return json({ ok: true, ignored: 'invoice mismatch' });
  const state = String(payload.payment_status || '').toLowerCase();
  if (PAID_STATES.has(state)) {
    try { await settle(env, order); }
    catch (e) { throw err(500, e.code || 'settle_failed', e.message || 'settle failed'); } // NOWPayments retries
    const user = await first(env, 'SELECT * FROM users WHERE id = ?', order.user_id);
    await notifyAdmin(env, `✅ پرداخت کریپتو: سفارش #${order.id} (${user.email}) $${order.crypto_amount_usd}`);
  } else if (FAILED_STATES.has(state) && order.status === 'pending') {
    await run(env, "UPDATE orders SET status = 'expired' WHERE id = ?", order.id);
  }
  return json({ ok: true });
}

export async function wallet(env, user) {
  const rows = await all(env, 'SELECT * FROM wallet_tx WHERE user_id = ? ORDER BY id DESC LIMIT 50', user.id);
  return json({
    balance: user.wallet_balance,
    transactions: rows.map((t) => ({ id: t.id, amount: t.amount, balance_after: t.balance_after, reason: t.reason, note: t.note, created_at: new Date(t.created_at * 1000).toISOString() })),
  });
}

export async function referral(env, user) {
  const invited = (await first(env, 'SELECT COUNT(*) c FROM users WHERE referred_by_id = ?', user.id)).c;
  const earned = (await first(env, "SELECT COALESCE(SUM(amount),0) s FROM wallet_tx WHERE user_id = ? AND reason = 'referral'", user.id)).s;
  const pct = await getSettingInt(env, 'referral_percent');
  return json({ code: user.referral_code, percent: pct, invited, earned_toman: earned, share_text: `با کد دعوت من ${user.referral_code} در اپ Cloud Gold VPN ثبت‌نام کن` });
}
