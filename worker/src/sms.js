// Card-to-card auto-confirmation from the bank's deposit SMS.
//
// The admin's phone forwards bank SMS here (the free "Incoming SMS to URL forwarder" app, or any app that
// POSTs JSON/text), or the admin pastes an SMS into the Telegram bot. We read the deposited amount, find the
// open card order with exactly that unique amount, and confirm it.
//
// Fake-SMS protection: only SMS from senders the admin marked as their bank (sms_senders) can confirm by
// themselves. Anything else is sent to the admin for a one-tap decision, with a button to trust that sender.
import { first, all, run, insert, getSettings, getSetting, setSetting } from './db.js';
import { json, err, nowSec, hmacHex, safeEqual } from './util.js';

const fa2en = (s) => String(s || '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
export const normSender = (s) => fa2en(s).toLowerCase().replace(/[\s\-()]/g, '').replace(/^(\+98|0098)/, '0');

const DEPOSIT_WORD = /(واريز|واریز|انتقال\s*به|دريافت|دریافت|افزايش|افزایش|بستانکار|نشست|deposit|credit)/i;
const WITHDRAW_WORD = /(برداشت|خريد|خرید|پرداخت\s*قبض|کسر|انتقال\s*از|بدهکار|withdraw|debit|purchase)/i;
// From the first of these words on, a line is about something else (the payer's description, a reference number,
// the balance), never the deposited amount: a payer can type any number into شرح/بابت, and a reference or the
// balance can equal another order's amount by chance (PAY-02).
const NOT_AMOUNT_WORD = /(شرح|بابت|توضيح|توضیح|پيگيري|پیگیری|رهگيري|رهگیری|مانده|موجودي|موجودی|شناسه|سند|مرجع|ارجاع|کد|كد|mande|\b(?:balance|ref|trace|desc))/i;
const AMOUNT_LABEL = /(مبلغ|\bamount\b|\bamt\b)/i; // "مبلغ: 1,890,370" under a "واریز ..." line (Saderat, Pasargad, Saman)
// account, card, sheba-like and date/time tokens written with separators (207.8000.12345678.1, 849-810-1234567-1,
// 603799******7893, 1405/08/06-10:22): never an amount
const SEPARATED_DIGITS = /(?<![\d,])\d+(?:[-./:*]+\d+)+/g;
// a whole number: 1,890,370 or 1890370 (5-12 digits), never a slice of a longer digit run (account numbers);
// a sign may stand before it (+1,890,370) or a plus right after it (1,890,370+)
const AMOUNT_RE = /([+-]?)\s*(?<![\d,])(\d{1,3}(?:,\d{3})+|\d{5,12})(?![\d,])(\+?)/g;

const TOMAN_WORD = /(تومان|تومن|toman)/i;
const RIAL_WORD = /(ريال|ریال|rial)/i;

// Returns { deposit: bool, amounts: [n, ...], toman: [n, ...] }.
// Only a deposit line gives an amount: a line that says واریز (or another deposit word) or مبلغ before the amount,
// or an amount marked +. A withdrawal line gives none, and the part of a line from شرح/بابت/پیگیری/مانده/... on is
// ignored. More than one amount means the SMS is unclear: the caller then never confirms by itself.
// Bank SMS amounts are rial. `toman` lists the amounts whose own line says تومان (and not ریال): only those
// may be read as toman, so a transfer of X rial can never pay an order of X toman.
export function parseBankSms(text) {
  const t = fa2en(text).replace(/[٬،]/g, ',');
  const hasDeposit = DEPOSIT_WORD.test(t) || /\+\s*\d/.test(t) || /\d\+/.test(t);
  const hasWithdraw = WITHDRAW_WORD.test(t) || /(^|\s)-\s*\d{1,3}(,\d{3})+/m.test(t);
  const deposit = hasDeposit && !(hasWithdraw && !/(واريز|واریز|\+\s*\d|\d\+)/.test(t));
  const found = [];
  for (const raw of t.split(/\r?\n/)) {
    if (WITHDRAW_WORD.test(raw)) continue; // money leaving the account (a combined SMS lists both)
    const cut = raw.search(NOT_AMOUNT_WORD);
    const line = (cut >= 0 ? raw.slice(0, cut) : raw).replace(SEPARATED_DIGITS, ' ');
    const depositLine = DEPOSIT_WORD.test(line) || AMOUNT_LABEL.test(line);
    let m;
    AMOUNT_RE.lastIndex = 0;
    while ((m = AMOUNT_RE.exec(line))) {
      const n = parseInt(m[2].replace(/,/g, ''), 10);
      if (!n) continue;
      if (m[1] === '-') continue;            // money leaving the account
      if (!depositLine && m[1] !== '+' && m[3] !== '+') continue; // a number that is not on a deposit line
      if (/(حساب|شبا|کارت|account|card)/i.test(line) && !/,/.test(m[2]) && m[2].length >= 10) continue; // an account number
      // F1: toman only when the whole line says تومان and not ریال
      found.push({ n, toman: TOMAN_WORD.test(raw) && !RIAL_WORD.test(raw) });
    }
  }
  return { deposit, amounts: [...new Set(found.map((x) => x.n))], toman: [...new Set(found.filter((x) => x.toman).map((x) => x.n))] };
}

async function trustedSenders(env) {
  return String(await getSetting(env, 'sms_senders') || '').split(',').map(normSender).filter(Boolean);
}

// open card orders an SMS could belong to (pending = no receipt yet, review = receipt sent)
async function openCardOrders(env) {
  return all(env, "SELECT * FROM orders WHERE method = 'card' AND status IN ('pending','review','rejected') AND created_at > ? ORDER BY id DESC", nowSec() - 36 * 3600);
}

// The same SMS reaches us more than once: the forwarder retries, a second forwarder app, or the admin pastes it
// into the bot. The dedup key is the SMS text alone (digits, Arabic letters and spaces made uniform), never the
// sender, so a forwarded copy and a pasted copy of one deposit are one deposit (PAY-03).
const smsKeyText = (body) => fa2en(body).replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, ' ').trim();

// Core: one SMS text -> result. trusted=true when the sender is the bank (or the admin pasted it).
export async function handleBankSms(env, { sender = '', text = '', trusted = false, source = 'sms' }) {
  const { notifyAdmin, untrusted } = await import('./telegram.js');
  const body = String(text || '').slice(0, 1000);
  const hash = await hmacHex('sms', smsKeyText(body));
  try { await insert(env, 'sms_log', { hash, sender: String(sender).slice(0, 60), body, created_at: nowSec() }); }
  catch (e) {
    // Seen before. A copy from another source (the admin pastes what the forwarder already sent) is looked at again
    // only while that SMS has paid nothing: claimed atomically, so it can never pay a second order.
    const seen = await first(env, 'SELECT sender, result, order_id FROM sms_log WHERE hash = ?', hash);
    const again = seen && normSender(seen.sender) !== normSender(sender) && seen.result && seen.result !== 'paid'
      && (await run(env, "UPDATE sms_log SET result = NULL, sender = ? WHERE hash = ? AND result IS NOT NULL AND result != 'paid'", String(sender).slice(0, 60), hash)).meta.changes;
    if (!again) return { result: 'duplicate', orderId: seen && seen.result === 'paid' ? seen.order_id : undefined };
  }

  const p = parseBankSms(body);
  if (!p.deposit) {
    await run(env, 'UPDATE sms_log SET result = ? WHERE hash = ?', 'not_deposit', hash);
    return { result: 'not_deposit' };
  }
  if (!p.amounts.length) {
    await run(env, 'UPDATE sms_log SET result = ? WHERE hash = ?', 'no_order', hash);
    await notifyAdmin(env, `💳 پیامک واریز رسید ولی مبلغ واریز در آن روشن نبود؛ خودت بررسی کن.\nفرستنده: ${untrusted(sender) || "—"}\n\n${untrusted(body)}`);
    return { result: 'no_order' };
  }
  const orders = await openCardOrders(env);
  // amounts in SMS are rial; a number is read as toman only when its line says تومان
  let matches = [], rial = 0;
  for (const n of p.amounts) {
    const asToman = p.toman.includes(n);
    const m = orders.filter((o) => (asToman ? o.amount_toman === n : o.amount_toman * 10 === n));
    if (m.length) { matches = m; rial = asToman ? n * 10 : n; break; }
  }
  const first_ = p.amounts[0];
  if (!matches.length) {
    await run(env, 'UPDATE sms_log SET result = ?, amount_rial = ? WHERE hash = ?', 'no_order', first_, hash);
    await notifyAdmin(env, `💳 پیامک واریز رسید (${(first_).toLocaleString('en-US')}) ولی سفارش کارت‌به‌کارتی با این مبلغ باز نیست.\nفرستنده: ${untrusted(sender) || "—"}\n\n${untrusted(body)}`);
    return { result: 'no_order', amount: first_ };
  }
  // more than one order, or more than one deposit amount in the SMS (PAY-02): never by itself, the admin decides
  if (matches.length > 1 || p.amounts.length > 1) {
    await run(env, 'UPDATE sms_log SET result = ?, amount_rial = ? WHERE hash = ?', 'ambiguous', rial, hash);
    const why = matches.length > 1 ? `با ${matches.length} سفارش جور است (${matches.map((o) => '#' + o.id).join('، ')})` : `چند مبلغ دارد (${p.amounts.map((x) => x.toLocaleString('en-US')).join('، ')}) و یکی با سفارش #${matches[0].id} جور است`;
    await notifyAdmin(env, `💳 پیامک واریز ${rial.toLocaleString('en-US')} ریال ${why}. خودت تأیید کن.\n\n${untrusted(body)}`,
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
      await notifyAdmin(env, `⚡ کارت‌به‌کارت خودکار تأیید شد — سفارش #${order.id}\n${order.amount_toman.toLocaleString('en-US')} تومان از ${user.email}\nمبلغ واریز در پیامک: ${rial.toLocaleString('en-US')} ریال\n(از ${source === 'paste' ? 'پیامکی که در ربات گذاشتی' : 'پیامک بانک'})`);
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
  await notifyAdmin(env, `💳 پیامک واریز با سفارش #${order.id} جور است\n${order.amount_toman.toLocaleString('en-US')} تومان · ${user.email}\nفرستنده: ${untrusted(sender) || "—"}${senderTrusted ? '' : ' (هنوز در لیست بانک‌های تو نیست)'}\n\n${untrusted(body)}`, { inline_keyboard: kb });
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
  if (!real || !(await safeEqual(key, real))) throw err(404, 'not_found', 'Not found');
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
