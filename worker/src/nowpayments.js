// NOWPayments crypto invoices + IPN signature check (HMAC-SHA512 over sorted-key JSON).
import { hmacSha512Hex, timingSafeEqual } from './util.js';

export const PAID_STATES = new Set(['finished', 'confirmed']);
export const FAILED_STATES = new Set(['failed', 'expired', 'refunded']);

export const cryptoEnabled = (env) => !!env.NOWPAYMENTS_API_KEY;

export function tomanToUsd(amountToman, rateToman) {
  if (!rateToman) return 0;
  return Math.max(1, Math.ceil(amountToman / rateToman));
}

export async function createInvoice(env, orderId, usd, description) {
  const base = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const body = {
    price_amount: usd,
    price_currency: 'usd',
    order_id: String(orderId),
    order_description: description,
    ipn_callback_url: `${base}/api/v1/payments/nowpayments/ipn`,
    success_url: `${base}/pay/done?order=${orderId}`,
    cancel_url: `${base}/pay/done?order=${orderId}&cancelled=1`,
  };
  if (env.NOWPAYMENTS_PAY_CURRENCY) body.pay_currency = env.NOWPAYMENTS_PAY_CURRENCY;
  const r = await fetch('https://api.nowpayments.io/v1/invoice', {
    method: 'POST',
    headers: { 'x-api-key': env.NOWPAYMENTS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`NOWPayments error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  return { id: String(data.id), url: data.invoice_url };
}

// NOWPayments signs the HMAC over JSON with keys sorted recursively and no extra whitespace.
function sortedStringify(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(sortedStringify).join(',') + ']';
  if (obj && typeof obj === 'object') {
    return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + sortedStringify(obj[k])).join(',') + '}';
  }
  return JSON.stringify(obj);
}

export async function verifyIpn(env, rawBody, signature) {
  let payload;
  try { payload = JSON.parse(rawBody); } catch (e) { throw new Error('bad json'); }
  const expected = await hmacSha512Hex(env.NOWPAYMENTS_IPN_SECRET, sortedStringify(payload));
  if (!signature || !timingSafeEqual(expected, String(signature))) throw new Error('bad signature');
  return payload;
}
