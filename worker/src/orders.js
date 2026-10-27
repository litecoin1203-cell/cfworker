// Orders (plan purchase & wallet top-up), receipts, crypto webhook, wallet and referral.
import { first, all, run, insert, getSettings, getSettingInt } from './db.js';
import { json, err, nowSec } from './util.js';
import { payWithWallet, settle, BillingError } from './billing.js';
import { cryptoEnabled, tomanToUsd, createInvoice, verifyIpn, PAID_STATES, FAILED_STATES } from './nowpayments.js';
import { sendReceipt, notifyAdmin } from './telegram.js';
import { planName } from './account.js';

async function orderOut(env, o) {
  const plan = o.plan_id ? await first(env, 'SELECT * FROM plans WHERE id = ?', o.plan_id) : null;
  const target = o.activate_plan_id ? await first(env, 'SELECT * FROM plans WHERE id = ?', o.activate_plan_id) : null;
  let card = null;
  if (o.method === 'card' && ['pending', 'review', 'rejected'].includes(o.status)) {
    const s = await getSettings(env);
    card = { number: s.card_number, holder: s.card_holder, bank: s.card_bank };
  }
  let activated = null;
  if (o.result_order_id) {
    const r = await first(env, 'SELECT status FROM orders WHERE id = ?', o.result_order_id);
    activated = r ? r.status === 'paid' : false;
  }
  return {
    id: o.id, kind: o.kind, plan_id: o.plan_id, plan_name: plan ? planName(plan.name) : null,
    activate_plan_id: o.activate_plan_id || null, activate_plan_name: target ? planName(target.name) : null, plan_activated: activated,
    amount_toman: o.amount_toman, list_price_toman: o.list_price_toman || null, method: o.method, status: o.status,
    created_at: new Date(o.created_at * 1000).toISOString(),
    paid_at: o.paid_at ? new Date(o.paid_at * 1000).toISOString() : null,
    card, crypto_pay_url: o.crypto_pay_url, crypto_amount_usd: o.crypto_amount_usd, admin_note: o.admin_note,
  };
}

// ---------------- discount codes ----------------
async function findCoupon(env, user, code, plan) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return null;
  const c = await first(env, 'SELECT * FROM coupons WHERE code = ?', code);
  if (!c || !c.is_active) throw err(400, 'coupon_invalid', 'این کد تخفیف معتبر نیست.', 'coupon');
  if (c.expires_at && c.expires_at < nowSec()) throw err(400, 'coupon_expired', 'مهلت این کد تخفیف تمام شده است.', 'coupon');
  if (c.max_uses && c.used >= c.max_uses) throw err(400, 'coupon_used_up', 'ظرفیت این کد تخفیف پر شده است.', 'coupon');
  if (c.plan_id && plan && c.plan_id !== plan.id) throw err(400, 'coupon_wrong_plan', 'این کد تخفیف برای این پلن نیست.', 'coupon');
  if (await first(env, 'SELECT 1 FROM coupon_uses WHERE coupon_id = ? AND user_id = ?', c.id, user.id)) {
    throw err(400, 'coupon_used', 'این کد تخفیف را قبلاً استفاده کرده‌ای.', 'coupon');
  }
  return c;
}
const discounted = (price, c) => (c ? Math.max(0, Math.round((price * (100 - c.percent)) / 100 / 1000) * 1000) : price);

export async function checkCoupon(env, user, body) {
  const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', body.plan_id);
  if (!plan || !plan.is_active) throw err(404, 'plan_not_found', 'این پلن در دسترس نیست.');
  const c = await findCoupon(env, user, body.code, plan);
  if (!c) throw err(400, 'coupon_invalid', 'کد تخفیف را وارد کن.', 'coupon');
  return json({ code: c.code, percent: c.percent, price_toman: plan.price_toman, final_toman: discounted(plan.price_toman, c) });
}

export async function createOrder(env, user, body) {
  const method = body.method;
  if (!['wallet', 'card', 'crypto'].includes(method)) throw err(422, 'invalid_input', 'روش پرداخت را انتخاب کن.', 'method');
  let orderId;
  if (body.plan_id) {
    const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', body.plan_id);
    if (!plan || !plan.is_active) throw err(404, 'plan_not_found', 'این پلن در دسترس نیست.');
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
    if (method === 'wallet') throw err(400, 'bad_method', 'کیف پول را با کارت یا کریپتو شارژ کن.');
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
  } else if (order.method === 'wallet') {
    try { await payWithWallet(env, user, order); }
    catch (e) { if (e instanceof BillingError) throw err(400, e.code, e.message); throw e; }
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
  return json(await Promise.all(rows.map((o) => orderOut(env, o))));
}

async function ownOrder(env, user, orderId) {
  const o = await first(env, 'SELECT * FROM orders WHERE id = ?', orderId);
  if (!o || o.user_id !== user.id) throw err(404, 'not_found', 'سفارش پیدا نشد.');
  return o;
}

export async function getOrder(env, user, orderId) {
  return json(await orderOut(env, await ownOrder(env, user, orderId)));
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
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw err(400, 'bad_file', 'عکس رسید را انتخاب کن.');
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw err(413, 'too_large', 'حجم عکس باید کمتر از ۸ مگابایت باشد.');
  const kind = sniff(buf);
  if (!kind) throw err(400, 'bad_file', 'عکس رسید را بفرست (JPG، PNG یا WEBP).');
  const ref = String(form.get('ref') || '').trim().slice(0, 64) || null;
  const fileId = await sendReceipt(env, order, user, buf, `receipt_${order.id}${kind.ext}`, kind.type);
  await run(env, "UPDATE orders SET status = 'review', receipt_ref = ?, receipt_file_id = ?, admin_note = NULL WHERE id = ?", ref, fileId, order.id);
  if (!env.TELEGRAM_CHAT_ID) await notifyAdmin(env, `رسید جدید برای سفارش #${order.id} آمد ولی TELEGRAM_CHAT_ID تنظیم نشده.`);
  return json(await orderOut(env, await first(env, 'SELECT * FROM orders WHERE id = ?', order.id)));
}

export async function cancelOrder(env, user, orderId) {
  const order = await ownOrder(env, user, orderId);
  if (order.status !== 'pending') throw err(400, 'bad_state', 'فقط سفارش پرداخت‌نشده لغو می‌شود.');
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
