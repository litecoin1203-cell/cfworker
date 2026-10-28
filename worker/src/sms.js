// Card-to-card auto-confirmation from the bank's deposit SMS.
//
// The admin's phone forwards bank SMS here (the free "Incoming SMS to URL forwarder" app, or any app that
// POSTs JSON/text), or the admin pastes an SMS into the Telegram bot. We read the deposited amount, find the
// open card order with exactly that unique amount, and confirm it.
//
// Fake-SMS protection: only SMS from senders the admin marked as their bank (sms_senders) can confirm by
// themselves. Anything else is sent to the admin for a one-tap decision, with a button to trust that sender.
import { first, all, run, insert, getSettings, getSetting, setSetting } from './db.js';
import { json, err, nowSec, hmacHex } from './util.js';

const fa2en = (s) => String(s || '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
export const normSender = (s) => fa2en(s).toLowerCase().replace(/[\s\-()]/g, '').replace(/^(\+98|0098)/, '0');

const DEPOSIT_WORD = /(واريز|واریز|انتقال\s*به|دريافت|دریافت|افزايش|افزایش|بستانکار|نشست|deposit|credit)/i;
const WITHDRAW_WORD = /(برداشت|خريد|خرید|پرداخت\s*قبض|کسر|انتقال\s*از|بدهکار|withdraw|debit|purchase)/i;
const BALANCE_WORD = /(مانده|موجودي|موجودی|balance|mande)/i;
// a whole number: 1,890,370 or 1890370 (5-12 digits), never a slice of a longer digit run (account numbers)
const AMOUNT_RE = /([+-]?)\s*(?<![\d,])(\d{1,3}(?:,\d{3})+|\d{5,12})(?![\d,])/g;

// Returns { deposit: bool, amounts: [n, ...] } — likeliest deposited amount first
export function parseBankSms(text) {
  const t = fa2en(text).replace(/[٬،]/g, ',');
  const hasDeposit = DEPOSIT_WORD.test(t) || /\+\s*\d/.test(t);
  const hasWithdraw = WITHDRAW_WORD.test(t) || /(^|\s)-\s*\d{1,3}(,\d{3})+/m.test(t);
  const deposit = hasDeposit && !(hasWithdraw && !/(واريز|واریز|\+\s*\d)/.test(t));
  const found = [];
  for (const line of t.split(/\r?\n/)) {
    const d = DEPOSIT_WORD.test(line);
    const bal = BALANCE_WORD.test(line);
    let m;
    AMOUNT_RE.lastIndex = 0;
    while ((m = AMOUNT_RE.exec(line))) {
      const n = parseInt(m[2].replace(/,/g, ''), 10);
      if (!n) continue;
      if (m[1] === '-') continue;            // money leaving the account
      if (bal && !d && m[1] !== '+') continue; // the balance, not the deposit
      if (/(حساب|شبا|کارت|account|card)/i.test(line) && !/,/.test(m[2]) && m[2].length >= 10) continue; // an account number
      found.push({ n, score: (d ? 2 : 0) + (m[1] === '+' ? 1 : 0) });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return { deposit, amounts: [...new Set(found.map((x) => x.n))] };
}

async function trustedSenders(env) {
  return String(await getSetting(env, 'sms_senders') || '').split(',').map(normSender).filter(Boolean);
}

// open card orders an SMS could belong to (pending = no receipt yet, review = receipt sent)
async function openCardOrders(env) {
  return all(env, "SELECT * FROM orders WHERE method = 'card' AND status IN ('pending','review','rejected') AND created_at > ? ORDER BY id DESC", nowSec() - 36 * 3600);
}

// Core: one SMS text -> result. trusted=true when the sender is the bank (or the admin pasted it).
export async function handleBankSms(env, { sender = '', text = '', trusted = false, source = 'sms' }) {
  const { notifyAdmin } = await import('./telegram.js');
  const body = String(text || '').slice(0, 1000);
  const hash = await hmacHex('sms', normSender(sender) + '|' + body.replace(/\s+/g, ' ').trim());
  try { await insert(env, 'sms_log', { hash, sender: String(sender).slice(0, 60), body, created_at: nowSec() }); }
  catch (e) { return { result: 'duplicate' }; } // the forwarder retried, or the admin pasted it twice

  const p = parseBankSms(body);
  if (!p.deposit || !p.amounts.length) {
    await run(env, 'UPDATE sms_log SET result = ? WHERE hash = ?', 'not_deposit', hash);
    return { result: 'not_deposit' };
  }
  const orders = await openCardOrders(env);
  // amounts in SMS are usually rial; accept toman too
  let matches = [], rial = 0;
  for (const n of p.amounts) {
    const m = orders.filter((o) => o.amount_toman * 10 === n || o.amount_toman === n);
    if (m.length) { matches = m; rial = m[0].amount_toman * 10 === n ? n : n * 10; break; }
  }
  const first_ = p.amounts[0];
  if (!matches.length) {
    await run(env, 'UPDATE sms_log SET result = ?, amount_rial = ? WHERE hash = ?', 'no_order', first_, hash);
    await notifyAdmin(env, `💳 پیامک واریز رسید (${(first_).toLocaleString('en-US')}) ولی سفارش کارت‌به‌کارتی با این مبلغ باز نیست.\nفرستنده: ${sender || '—'}\n\n${body}`);
    return { result: 'no_order', amount: first_ };
  }
  if (matches.length > 1) {
    await run(env, 'UPDATE sms_log SET result = ?, amount_rial = ? WHERE hash = ?', 'ambiguous', rial, hash);
    await notifyAdmin(env, `💳 پیامک واریز ${rial.toLocaleString('en-US')} ریال با ${matches.length} سفارش جور است (${matches.map((o) => '#' + o.id).join('، ')}). خودت تأیید کن.\n\n${body}`,
      { inline_keyboard: matches.slice(0, 4).map((o) => [{ text: `✅ تأیید #${o.id}`, callback_data: `ap:${o.id}` }]) });
    return { result: 'ambiguous' };
  }
  const order = matches[0];
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', order.user_id);
  await run(env, 'UPDATE sms_log SET amount_rial = ?, order_id = ? WHERE hash = ?', rial, order.id, hash);
  const mode = String(await getSetting(env, 'card_auto') || 'auto');
  const senderTrusted = trusted || (await trustedSenders(env)).includes(normSender(sender));

  if (mode === 'auto' && senderTrusted) {
    const { settle, BillingError } = await import('./billing.js');
    try {
      await run(env, "UPDATE orders SET receipt_ref = COALESCE(receipt_ref, ?) WHERE id = ?", source === 'paste' ? 'پیامک (تلگرام)' : 'پیامک بانک', order.id);
      await settle(env, await first(env, 'SELECT * FROM orders WHERE id = ?', order.id));
      await run(env, 'UPDATE sms_log SET result = ? WHERE hash = ?', 'paid', hash);
      await notifyAdmin(env, `⚡ کارت‌به‌کارت خودکار تأیید شد — سفارش #${order.id}\n${order.amount_toman.toLocaleString('en-US')} تومان از ${user.email}\n(از ${source === 'paste' ? 'پیامکی که در ربات گذاشتی' : 'پیامک بانک'})`);
      return { result: 'paid', orderId: order.id };
    } catch (e) {
      await run(env, 'UPDATE sms_log SET result = ? WHERE hash = ?', 'settle_failed', hash);
      return { result: 'settle_failed', orderId: order.id, message: e instanceof BillingError ? e.message : String(e.message || e) };
    }
  }
  // not allowed to confirm by itself: hand it to the admin with one-tap buttons
  if (order.status === 'pending') await run(env, "UPDATE orders SET status = 'review', receipt_ref = COALESCE(receipt_ref, 'پیامک بانک') WHERE id = ?", order.id);
  await run(env, 'UPDATE sms_log SET result = ? WHERE hash = ?', 'review', hash);
  const kb = [[{ text: `✅ تأیید #${order.id}`, callback_data: `ap:${order.id}` }, { text: '❌ رد', callback_data: `rj:${order.id}` }]];
  if (!senderTrusted && sender) kb.push([{ text: '🏦 این فرستنده بانک من است (تأیید خودکار از این به بعد)', callback_data: `ts:${normSender(sender).slice(0, 50)}` }]);
  await notifyAdmin(env, `💳 پیامک واریز با سفارش #${order.id} جور است\n${order.amount_toman.toLocaleString('en-US')} تومان · ${user.email}\nفرستنده: ${sender || '—'}${senderTrusted ? '' : ' (هنوز در لیست بانک‌های تو نیست)'}\n\n${body}`, { inline_keyboard: kb });
  return { result: 'review', orderId: order.id };
}

// ---------------- HTTP entry: POST /sms/<key> ----------------
export async function smsKey(env) {
  let k = await getSetting(env, 'sms_key');
  if (!k) {
    k = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await setSetting(env, 'sms_key', k);
  }
  return k;
}

export async function smsWebhook(env, request, key) {
  const real = await getSetting(env, 'sms_key');
  if (!real || key !== real) throw err(404, 'not_found', 'Not found');
  const raw = await request.text();
  let sender = '', text = '';
  try {
    const j = JSON.parse(raw);
    sender = j.from || j.sender || j.number || j.address || j.phone || '';
    text = j.text || j.message || j.body || j.msg || j.content || '';
  } catch (e) {
    const f = new URLSearchParams(raw);
    sender = f.get('from') || f.get('sender') || '';
    text = f.get('text') || f.get('message') || f.get('body') || raw;
  }
  if (!text) return json({ ok: true, result: 'empty' });
  const r = await handleBankSms(env, { sender: String(sender), text: String(text) });
  return json({ ok: true, ...r });
}
