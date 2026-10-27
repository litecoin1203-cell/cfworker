// Telegram admin bot: receipt notifications with Approve/Reject buttons, plus a few admin commands.
// This replaces the separate web admin panel — you run the whole shop from your Telegram chat.
import { first, run, all, getSettings, setSetting, SETTING_DEFAULTS, getSettingInt } from './db.js';
import { hashPassword, nowSec } from './util.js';

const API = (env, method) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

async function tg(env, method, body) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const r = await fetch(API(env, method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  } catch (e) { return null; }
}

export async function notifyAdmin(env, text, replyMarkup) {
  if (!env.TELEGRAM_CHAT_ID) return;
  await tg(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text, reply_markup: replyMarkup, disable_web_page_preview: true });
}

// Forward an uploaded receipt photo (raw bytes) to the admin with Approve/Reject buttons.
export async function sendReceipt(env, order, user, bytes, filename, contentType) {
  if (!env.TELEGRAM_CHAT_ID) return null;
  const what = order.kind === 'plan' ? `Plan #${order.plan_id}` : 'Wallet top-up';
  const caption = `🧾 Receipt for order #${order.id}\n${what} · ${order.amount_toman.toLocaleString('en-US')} T\n${user.email}\nRef: ${order.receipt_ref || '-'}`;
  const form = new FormData();
  form.set('chat_id', String(env.TELEGRAM_CHAT_ID));
  form.set('caption', caption);
  form.set('reply_markup', JSON.stringify(buttons(order.id)));
  form.set('photo', new Blob([bytes], { type: contentType || 'image/jpeg' }), filename || 'receipt.jpg');
  try {
    const r = await fetch(API(env, 'sendPhoto'), { method: 'POST', body: form });
    const data = await r.json();
    return data?.result?.photo?.slice(-1)[0]?.file_id || null;
  } catch (e) { return null; }
}

const buttons = (orderId) => ({
  inline_keyboard: [[
    { text: '✅ Approve', callback_data: `ap:${orderId}` },
    { text: '❌ Reject', callback_data: `rj:${orderId}` },
  ]],
});

function isAdmin(env, chatId) {
  return env.TELEGRAM_CHAT_ID && String(chatId) === String(env.TELEGRAM_CHAT_ID);
}

// ---------------- webhook ----------------
export async function handleWebhook(env, update) {
  // secret check is done by the caller (path contains the webhook secret)
  if (update.callback_query) return onCallback(env, update.callback_query);
  if (update.message) return onMessage(env, update.message);
}

async function onCallback(env, cq) {
  const chatId = cq.message?.chat?.id;
  if (!isAdmin(env, chatId)) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Not allowed' });
  const [action, idStr] = String(cq.data || '').split(':');
  const orderId = parseInt(idStr, 10);
  const order = await first(env, 'SELECT * FROM orders WHERE id = ?', orderId);
  const ack = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
  if (!order) return ack('Order not found');
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', order.user_id);

  if (action === 'ap') {
    if (order.status === 'paid') return ack('Already approved');
    if (!['review', 'pending', 'rejected'].includes(order.status)) return ack(`Order is ${order.status}`);
    const { settle, BillingError } = await import('./billing.js');
    try {
      await settle(env, order);
    } catch (e) {
      const msg = e instanceof BillingError ? e.message : 'Error activating';
      return ack('⚠️ ' + msg);
    }
    await editCaption(env, cq, `✅ Approved — order #${order.id} (${user.email})`);
    await notifyUser(env, user, order);
    return ack('Approved and activated');
  }
  if (action === 'rj') {
    if (order.status === 'paid') return ack('Already paid, cannot reject');
    await run(env, "UPDATE orders SET status = 'rejected', admin_note = ? WHERE id = ?", 'Receipt not accepted. Please contact support.', orderId);
    await editCaption(env, cq, `❌ Rejected — order #${order.id} (${user.email})`);
    return ack('Rejected');
  }
  return ack('');
}

async function editCaption(env, cq, caption) {
  await tg(env, 'editMessageCaption', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, caption });
}

async function notifyUser(env, user, order) {
  // the app polls order status, so this is just a bonus log line for the admin
  await notifyAdmin(env, `Delivered order #${order.id} to ${user.email}.`);
}

async function onMessage(env, msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  if (text === '/id' || text === '/start') {
    return tg(env, 'sendMessage', { chat_id: chatId, text: `Your Telegram chat id is: ${chatId}\nSet it as TELEGRAM_CHAT_ID so Cloud Gold can reach you here.` });
  }
  if (!isAdmin(env, chatId)) return;

  if (text.startsWith('/find ')) {
    const email = text.slice(6).trim().toLowerCase();
    const u = await first(env, 'SELECT * FROM users WHERE email = ?', email);
    if (!u) return tg(env, 'sendMessage', { chat_id: chatId, text: 'No user with that email.' });
    const sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', u.id);
    const exp = sub?.expires_at ? new Date(sub.expires_at * 1000).toISOString().slice(0, 10) : '—';
    return tg(env, 'sendMessage', { chat_id: chatId, text: `👤 ${u.email}\nWallet: ${u.wallet_balance.toLocaleString('en-US')} T\nReferral: ${u.referral_code}\nPlan until: ${exp}\nPanel user: ${sub?.pg_username || '—'}` });
  }
  if (text.startsWith('/reset ')) {
    const [, email, pass] = text.split(/\s+/);
    if (!email || !pass || pass.length < 8) return tg(env, 'sendMessage', { chat_id: chatId, text: 'Usage: /reset email@example.com newpassword (8+ chars)' });
    const u = await first(env, 'SELECT * FROM users WHERE email = ?', email.toLowerCase());
    if (!u) return tg(env, 'sendMessage', { chat_id: chatId, text: 'No user with that email.' });
    await run(env, 'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', await hashPassword(pass, env.SECRET_KEY), u.id);
    return tg(env, 'sendMessage', { chat_id: chatId, text: `Password reset for ${email}. Other devices are signed out.` });
  }
  if (text.startsWith('/grant ')) {
    const [, email, planIdStr] = text.split(/\s+/);
    const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', parseInt(planIdStr, 10));
    const u = await first(env, 'SELECT * FROM users WHERE email = ?', (email || '').toLowerCase());
    if (!u || !plan) return tg(env, 'sendMessage', { chat_id: chatId, text: 'Usage: /grant email@example.com <planId>  (see /plans)' });
    const { provision, BillingError } = await import('./billing.js');
    try { await provision(env, u, plan); } catch (e) { return tg(env, 'sendMessage', { chat_id: chatId, text: '⚠️ ' + e.message }); }
    return tg(env, 'sendMessage', { chat_id: chatId, text: `Granted ${plan.name} to ${email}.` });
  }
  if (text === '/plans') {
    const plans = await all(env, 'SELECT * FROM plans ORDER BY sort, id');
    const lines = plans.map((p) => `#${p.id} ${p.name} — ${p.price_toman.toLocaleString('en-US')} T, ${p.duration_days}d${p.is_active ? '' : ' (off)'}`);
    return tg(env, 'sendMessage', { chat_id: chatId, text: lines.join('\n') || 'No plans.' });
  }
  if (text.startsWith('/set ')) {
    const rest = text.slice(5);
    const i = rest.indexOf(' ');
    const key = i < 0 ? rest : rest.slice(0, i);
    const val = i < 0 ? '' : rest.slice(i + 1);
    if (!(key in SETTING_DEFAULTS)) return tg(env, 'sendMessage', { chat_id: chatId, text: `Unknown setting. Keys:\n${Object.keys(SETTING_DEFAULTS).join('\n')}` });
    await setSetting(env, key, val);
    return tg(env, 'sendMessage', { chat_id: chatId, text: `Set ${key} = ${val || '(empty)'}` });
  }
  if (text === '/settings') {
    const s = await getSettings(env);
    return tg(env, 'sendMessage', { chat_id: chatId, text: Object.entries(s).map(([k, v]) => `${k} = ${v || '—'}`).join('\n') });
  }
  if (text === '/help') {
    return tg(env, 'sendMessage', { chat_id: chatId, text: '/find email\n/reset email newpass\n/grant email planId\n/plans\n/settings\n/set key value\n/stats' });
  }
  if (text === '/stats') {
    const users = (await first(env, 'SELECT COUNT(*) c FROM users')).c;
    const active = (await first(env, "SELECT COUNT(*) c FROM subscriptions WHERE expires_at > ?", nowSec())).c;
    const review = (await first(env, "SELECT COUNT(*) c FROM orders WHERE status = 'review'")).c;
    const paidToday = (await first(env, "SELECT COALESCE(SUM(amount_toman),0) s FROM orders WHERE status='paid' AND paid_at > ?", nowSec() - 86400)).s;
    return tg(env, 'sendMessage', { chat_id: chatId, text: `👥 Users: ${users}\n✅ Active plans: ${active}\n🧾 Awaiting review: ${review}\n💰 Paid (24h): ${paidToday.toLocaleString('en-US')} T` });
  }
}
