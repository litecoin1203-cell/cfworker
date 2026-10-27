// Orders (plan purchase & wallet top-up), receipts, crypto webhook, wallet and referral.
import { first, all, run, insert, getSettings, getSettingInt } from './db.js';
import { json, err, nowSec } from './util.js';
import { payWithWallet, settle, BillingError } from './billing.js';
import { cryptoEnabled, tomanToUsd, createInvoice, verifyIpn, PAID_STATES, FAILED_STATES } from './nowpayments.js';
import { sendReceipt, notifyAdmin } from './telegram.js';

async function orderOut(env, o) {
  const plan = o.plan_id ? await first(env, 'SELECT * FROM plans WHERE id = ?', o.plan_id) : null;
  let card = null;
  if (o.method === 'card' && ['pending', 'review', 'rejected'].includes(o.status)) {
    const s = await getSettings(env);
    card = { number: s.card_number, holder: s.card_holder, bank: s.card_bank };
  }
  return {
    id: o.id, kind: o.kind, plan_id: o.plan_id, plan_name: plan ? plan.name : null,
    amount_toman: o.amount_toman, method: o.method, status: o.status,
    created_at: new Date(o.created_at * 1000).toISOString(),
    paid_at: o.paid_at ? new Date(o.paid_at * 1000).toISOString() : null,
    card, crypto_pay_url: o.crypto_pay_url, crypto_amount_usd: o.crypto_amount_usd, admin_note: o.admin_note,
  };
}

export async function createOrder(env, user, body) {
  const method = body.method;
  if (!['wallet', 'card', 'crypto'].includes(method)) throw err(422, 'invalid_input', 'Choose a payment method', 'method');
  let orderId;
  if (body.plan_id) {
    const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', body.plan_id);
    if (!plan || !plan.is_active) throw err(404, 'plan_not_found', 'This plan is not available');
    orderId = await insert(env, 'orders', { user_id: user.id, kind: 'plan', plan_id: plan.id, amount_toman: plan.price_toman, method, created_at: nowSec() });
  } else if (body.topup_toman) {
    if (method === 'wallet') throw err(400, 'bad_method', 'Top up with card or crypto');
    const min = await getSettingInt(env, 'min_topup_toman');
    if (body.topup_toman < min) throw err(400, 'amount_too_small', `Minimum top-up is ${min.toLocaleString('en-US')} toman`);
    orderId = await insert(env, 'orders', { user_id: user.id, kind: 'topup', amount_toman: body.topup_toman, method, created_at: nowSec() });
  } else {
    throw err(400, 'bad_request', 'Choose a plan or a top-up amount');
  }
  let order = await first(env, 'SELECT * FROM orders WHERE id = ?', orderId);

  if (method === 'card') {
    const s = await getSettings(env);
    if (!s.card_number) throw err(400, 'method_unavailable', 'Card-to-card is not available right now');
  } else if (method === 'wallet') {
    try { await payWithWallet(env, user, order); }
    catch (e) { if (e instanceof BillingError) throw err(400, e.code, e.message); throw e; }
  } else if (method === 'crypto') {
    if (!cryptoEnabled(env)) throw err(400, 'method_unavailable', 'Crypto payments are not available right now');
    try {
      const usd = tomanToUsd(order.amount_toman, await getSettingInt(env, 'usdt_rate_toman'));
      const inv = await createInvoice(env, order.id, usd, `Cloud Gold order #${order.id}`);
      await run(env, 'UPDATE orders SET crypto_invoice_id = ?, crypto_pay_url = ?, crypto_amount_usd = ? WHERE id = ?', inv.id, inv.url, String(usd), order.id);
    } catch (e) {
      await run(env, "UPDATE orders SET status = 'cancelled' WHERE id = ?", order.id);
      throw err(502, 'crypto_error', 'Could not start the crypto payment. Try again.');
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
  if (!o || o.user_id !== user.id) throw err(404, 'not_found', 'Order not found');
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
    throw err(400, 'bad_state', 'This order does not take a receipt');
  }
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw err(400, 'bad_file', 'Attach a photo of the receipt');
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw err(413, 'too_large', 'Image must be under 8 MB');
  const kind = sniff(buf);
  if (!kind) throw err(400, 'bad_file', 'Upload a photo of the receipt (JPG, PNG or WEBP)');
  const ref = String(form.get('ref') || '').trim().slice(0, 64) || null;
  const fileId = await sendReceipt(env, order, user, buf, `receipt_${order.id}${kind.ext}`, kind.type);
  await run(env, "UPDATE orders SET status = 'review', receipt_ref = ?, receipt_file_id = ?, admin_note = NULL WHERE id = ?", ref, fileId, order.id);
  if (!env.TELEGRAM_CHAT_ID) await notifyAdmin(env, `New receipt for order #${order.id} but TELEGRAM_CHAT_ID is not set.`);
  return json(await orderOut(env, await first(env, 'SELECT * FROM orders WHERE id = ?', order.id)));
}

export async function cancelOrder(env, user, orderId) {
  const order = await ownOrder(env, user, orderId);
  if (order.status !== 'pending') throw err(400, 'bad_state', 'Only unpaid orders can be cancelled');
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
    await notifyAdmin(env, `✅ Crypto paid: order #${order.id} (${user.email}) $${order.crypto_amount_usd}`);
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
  return json({ code: user.referral_code, percent: pct, invited, earned_toman: earned, share_text: `Join Cloud Gold VPN with my code ${user.referral_code}` });
}
