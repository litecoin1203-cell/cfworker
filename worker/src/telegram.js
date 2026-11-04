// Telegram admin bot: receipts with Approve/Reject buttons, panel diagnostics, discount codes, plans, backups.
// You run the whole shop from your Telegram chat.
import { first, run, all, insert, getSettings, setSetting, SETTING_DEFAULTS } from './db.js';
import { hashPassword, nowSec } from './util.js';

const API = (env, method) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

// ---------------- no typing: commands in bot text become buttons ----------------
// Every admin message goes through buttonize(): a "/command args" in its text is replaced by the button's
// name in «», and the button itself is added under the message. A tapped command inside a Telegram message
// would send only its first word, and the admin should never have to type one anyway. Commands that still
// need an answer (a number, an email, a password) open the menu's "write your answer" question instead.
const MENU_BTN = '🏠 منو';
const x = (cmd) => `m:x:home|${cmd}`;
const one = (label, cmd) => () => [label, x(cmd)];
const PA = ['🗂 پنل‌ها', 'm:pa'];
const CMD_BTN = {
  '/menu': () => ['🏠 منوی اصلی', 'm:home'],
  '/start': () => ['🏠 منوی اصلی', 'm:home'],
  '/help': () => ['❓ راهنما', 'm:help'],
  '/panels': () => PA,
  '/panel': one('🔎 تست همه‌ی پنل‌ها', '/panel'),
  '/backup': one('💾 پشتیبان', '/backup'),
  '/google': one('🔎 گوگل', '/google'),
  '/carriers': one('📶 اپراتورها', '/carriers'),
  '/rate': one('💵 قیمت دلار', '/rate'),
  '/sms': one('📩 پیامک بانک', '/sms'),
  '/wallets': one('💎 ولت‌ها', '/wallets'),
  '/stats': one('📊 آمار', '/stats'),
  '/settings': () => ['⚙️ تنظیمات', 'm:set'],
  '/plans': () => ['📦 پلن‌ها', 'm:pl'],
  '/coupons': () => ['🏷 کدهای تخفیف', 'm:cp'],
  '/addpanel': () => ['➕ افزودن پنل', 'm:w:addpanel'],
  '/newplan': () => ['➕ پلن جدید', 'm:w:newplan'],
  '/coupon': () => ['🏷 کد تخفیف جدید', 'm:w:coupon'],
  '/paneltest': (a) => (a[0] ? [`🧪 تست پنل #${a[0]}`, x(`/paneltest ${a[0]}`)] : PA),
  '/rollout': (a) => (a[0] && a[1] ? [`🚀 پنل #${a[0]} برای ${a[1]}٪ کاربران`, x(`/rollout ${a[0]} ${a[1]}`)] : a[0] ? [`🗂 پنل #${a[0]}`, `m:pp:${a[0]}`] : PA),
  '/drainpanel': (a) => (a[0] ? [`🚪 خارج‌کردن پنل #${a[0]}`, x(`/drainpanel ${a[0]}`)] : PA),
  '/panelcred': (a) => (a[0] ? [`🔐 ورود پنل #${a[0]}`, `m:w:panelcred:${a[0]}`] : PA),
  '/panelgroups': (a) => (a[0] && a[1] ? [`👥 پنل #${a[0]}: ${a[1]}`, x(`/panelgroups ${a[0]} ${a[1]}`)] : a[0] ? [`👥 گروه/سرویس پنل #${a[0]}`, `m:w:groups:${a[0]}`] : PA),
  '/find': (a) => (a[0] ? [`👤 ${a[0]}`, x(`/find ${a[0]}`)] : ['🔎 جستجوی کاربر', 'm:w:find']),
  '/user': (a) => (a[0] ? [`👤 ${a[0]}`, x(`/find ${a[0]}`)] : ['🔎 جستجوی کاربر', 'm:w:find']),
  '/grant': (a) => (a[0] && a[1] ? [`🎁 پلن ${a[1]} به ${a[0]}`, x(`/grant ${a[0]} ${a[1]}`)] : ['👤 کاربران', 'm:usr']),
  '/reset': () => ['👤 کاربران', 'm:usr'],
  '/link': () => ['👤 کاربران', 'm:usr'],
  '/plan': (a) => (a[0] ? [`📦 پلن #${a[0]}`, `m:p:${a[0]}`] : ['📦 پلن‌ها', 'm:pl']),
  '/delcoupon': () => ['🏷 کدهای تخفیف', 'm:cp'],
  '/set': (a) => (a[0] && a[1] ? [`⚙️ ${a[0]} = ${a[1]}`, x(`/set ${a[0]} ${a[1]}`)] : a[0] ? [`✏️ ${a[0]}`, `m:w:set:${a[0]}`] : ['⚙️ تنظیمات', 'm:set']),
};
const CMD_RE = /(^|[\s(:،«])(\/[a-z]+)((?:[ \t]+[A-Za-z0-9@_%+-]+(?:[.,][A-Za-z0-9@_%+-]+)*)*)/g;

// {text, reply_markup}: commands replaced by «button name», their buttons appended to any inline keyboard.
export function buttonize(text, replyMarkup) {
  const found = [];
  const out = String(text).replace(CMD_RE, (m, pre, cmd, rest) => {
    const fn = CMD_BTN[cmd];
    if (!fn) return m;
    const args = rest.trim() ? rest.trim().split(/[ \t]+/) : [];
    const [label, data] = fn(args);
    if (new TextEncoder().encode(data).length <= 64 && !found.some((f) => f.callback_data === data)) found.push({ text: label, callback_data: data });
    return `${pre}«${label}»`;
  });
  if (!found.length) return { text: out, reply_markup: replyMarkup };
  if (replyMarkup && !replyMarkup.inline_keyboard) return { text: out, reply_markup: replyMarkup }; // a reply keyboard stays as it is
  const rows = [...(replyMarkup?.inline_keyboard || [])];
  const have = new Set(rows.flat().map((b) => b.callback_data));
  const extra = found.filter((f) => !have.has(f.callback_data)).slice(0, 8);
  for (let i = 0; i < extra.length; i += 2) rows.push(extra.slice(i, i + 2));
  return { text: out, reply_markup: rows.length ? { inline_keyboard: rows } : replyMarkup };
}

const fa = (n) => Number(n || 0).toLocaleString('en-US');
const GB = 1024 ** 3;

export async function tg(env, method, body) {
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
  const b = buttonize(text, replyMarkup);
  await tg(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text: b.text.slice(0, 4000), reply_markup: b.reply_markup, disable_web_page_preview: true });
}

async function sendDocument(env, chatId, filename, content, caption) {
  const form = new FormData();
  form.set('chat_id', String(chatId));
  if (caption) form.set('caption', caption);
  form.set('document', new Blob([content], { type: 'application/json' }), filename);
  try { const r = await fetch(API(env, 'sendDocument'), { method: 'POST', body: form }); return r.json(); } catch (e) { return null; }
}

// Forward an uploaded receipt photo (raw bytes) to the admin with Approve/Reject buttons.
export async function sendReceipt(env, order, user, bytes, filename, contentType) {
  if (!env.TELEGRAM_CHAT_ID) return null;
  let what = 'شارژ کیف پول';
  if (order.kind === 'plan' || order.activate_plan_id) {
    const p = await first(env, 'SELECT name FROM plans WHERE id = ?', order.plan_id || order.activate_plan_id);
    what = order.kind === 'plan' ? `پلن ${p ? p.name : '#' + order.plan_id}` : `شارژ + فعال‌سازی خودکار پلن ${p ? p.name : ''}`;
  }
  const caption = `🧾 رسید سفارش #${order.id}\n${what}\nمبلغ: ${fa(order.amount_toman)} تومان\n${user.email}\nشماره پیگیری: ${order.receipt_ref || '-'}`;
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

// The user says they sent crypto: amount, network, wallet and one-tap links to check it on the blockchain.
export async function sendCoinNotice(env, order, user, note) {
  if (!env.TELEGRAM_CHAT_ID) return;
  const { coinById } = await import('./coins.js');
  const c = coinById(order.coin);
  if (!c) return;
  let what = 'شارژ کیف پول';
  if (order.kind === 'plan' || order.activate_plan_id) {
    const p = await first(env, 'SELECT name FROM plans WHERE id = ?', order.plan_id || order.activate_plan_id);
    what = order.kind === 'plan' ? `پلن ${p ? p.name : ''}` : `شارژ + فعال‌سازی پلن ${p ? p.name : ''}`;
  }
  const lines = [
    `💎 پرداخت ارز دیجیتال — سفارش #${order.id}`,
    what,
    `مبلغ دقیق: ${order.coin_amount} ${c.symbol}  (${fa(order.amount_toman)} تومان)`,
    `شبکه: ${c.network}`,
    `به ولت: ${order.coin_address}`,
    ...(order.coin_memo ? [`${c.memo}: ${order.coin_memo}`] : []),
    `کاربر: ${user.email}`,
    `هش: ${order.txid || '— (وارد نکرده؛ با مبلغ دقیق در ولت پیدا کن)'}`,
    '',
    note || 'بعد از دیدن واریز روی بلاک‌چین، تأیید را بزن.',
  ];
  const kb = [];
  if (order.txid) kb.push([{ text: '🔍 دیدن تراکنش', url: c.tx + encodeURIComponent(order.txid) }]);
  kb.push([{ text: '👛 ورودی‌های ولت', url: c.addr + order.coin_address }]);
  kb.push([{ text: '✅ تأیید', callback_data: `ap:${order.id}` }, { text: '❌ رد', callback_data: `rj:${order.id}` }]);
  await tg(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text: lines.join('\n'), reply_markup: { inline_keyboard: kb }, disable_web_page_preview: true });
}

const buttons = (orderId) => ({
  inline_keyboard: [[
    { text: '✅ تأیید', callback_data: `ap:${orderId}` },
    { text: '❌ رد', callback_data: `rj:${orderId}` },
  ]],
});

// The admin is one person in their own private chat with the bot: the chat must be private and the sender must
// be that same account. A group (or anyone else in a chat whose id matched) is never the admin.
function isAdmin(env, chat, from) {
  const id = String(env.TELEGRAM_CHAT_ID || '');
  return !!id && !!chat && !!from && chat.type === 'private' && String(chat.id) === id && String(from.id) === id;
}

// ---------------- webhook ----------------
export async function handleWebhook(env, update) {
  // secret check is done by the caller (path contains the webhook secret)
  if (update.callback_query) return onCallback(env, update.callback_query);
  if (update.message) return onMessage(env, update.message);
}

async function onCallback(env, cq) {
  const chatId = cq.message?.chat?.id;
  if (!isAdmin(env, cq.message?.chat, cq.from)) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'اجازه نداری' });
  if (String(cq.data || '').startsWith('m:')) return (await import('./telegram-menu.js')).onMenu(env, cq);
  const [action, idStr] = String(cq.data || '').split(':');
  if (action === 'cf' || action === 'cx') return onConfirm(env, cq, action === 'cf');
  if (action === 'ts') {
    const { normSender } = await import('./sms.js');
    const list = String((await getSettings(env)).sms_senders || '').split(',').map(normSender).filter(Boolean);
    const snd = normSender(String(cq.data).slice(3));
    if (snd && !list.includes(snd)) list.push(snd);
    await setSetting(env, 'sms_senders', list.join(','));
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'از این به بعد پیامک‌های این فرستنده خودکار تأیید می‌شوند', show_alert: true });
    return;
  }
  const orderId = parseInt(idStr, 10);
  const order = await first(env, 'SELECT * FROM orders WHERE id = ?', orderId);
  const ack = (text, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: String(text || '').slice(0, 190), show_alert: !!alert });
  if (!order) return ack('سفارش پیدا نشد');
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', order.user_id);

  if (action === 'ap' || action === 'rp') {
    if (order.status === 'paid') return ack('قبلاً تأیید و فعال شده');
    if (!['review', 'pending', 'rejected'].includes(order.status)) return ack(`وضعیت سفارش: ${order.status}`);
    const { settle, BillingError } = await import('./billing.js');
    try {
      await settle(env, order);
    } catch (e) {
      // settle already sent the panel's exact error with a retry button
      if (e instanceof BillingError && (e.code === 'settle_busy' || e.code.startsWith('coupon'))) return ack(e.message, true);
      return ack('⚠️ ' + (e instanceof BillingError ? 'ساخت اکانت روی پنل انجام نشد. پیام بعدی را ببین.' : e.message), true);
    }
    await editStatus(env, cq, `✅ تأیید و فعال شد — سفارش #${order.id} (${user.email})`);
    return ack('فعال شد');
  }
  if (action === 'rj') {
    if (order.status === 'paid') return ack('پرداخت شده؛ رد نمی‌شود');
    const note = order.method === 'coin' ? 'واریز ارز دیجیتال پیدا نشد. اگر واریز کرده‌ای، هش تراکنش را دوباره بفرست یا با پشتیبانی تماس بگیر.' : 'رسید تأیید نشد. اگر واریز کرده‌ای با پشتیبانی تماس بگیر.';
    const r = await run(env, "UPDATE orders SET status = 'rejected', admin_note = ? WHERE id = ? AND status NOT IN ('paid', 'settling')", note, orderId);
    if (!r.meta.changes) return ack('همین الان پرداخت یا فعال شد؛ رد نمی‌شود', true);
    await editStatus(env, cq, `❌ رد شد — سفارش #${order.id} (${user.email})`);
    return ack('رد شد');
  }
  return ack('');
}

// photo receipts are edited through their caption, text notices (crypto, retry) through their text
async function editStatus(env, cq, text) {
  const m = cq.message || {};
  if (m.photo) return tg(env, 'editMessageCaption', { chat_id: m.chat.id, message_id: m.message_id, caption: text });
  return tg(env, 'editMessageText', { chat_id: m.chat.id, message_id: m.message_id, text: (m.text ? m.text + '\n\n' : '') + text, disable_web_page_preview: true });
}

// ---------------- webhook registration ----------------
// The Worker points the bot at itself (no secret in the deploy workflow). Runs every minute but only calls
// Telegram when the address or the secret changed since the last successful registration.
export async function ensureWebhook(env) {
  const base = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!env.TELEGRAM_BOT_TOKEN || !secret || !base) return false;
  const { hmacHex } = await import('./util.js');
  // the "v2" bump re-registers once so the bot's command list (menu button) is set too
  const want = await hmacHex(secret, base + '|' + env.TELEGRAM_BOT_TOKEN.slice(-6) + '|v2');
  const have = (await first(env, "SELECT value FROM settings WHERE key = 'tg_webhook_sig'"))?.value;
  if (have === want) return false;
  const r = await tg(env, 'setWebhook', { url: base + '/tg', secret_token: secret, allowed_updates: ['message', 'callback_query'] });
  if (!r || !r.ok) return false;
  if (env.TELEGRAM_CHAT_ID) {
    await tg(env, 'setMyCommands', { scope: { type: 'chat', chat_id: env.TELEGRAM_CHAT_ID }, commands: [
      { command: 'menu', description: 'منوی مدیریت' }, { command: 'stats', description: 'آمار فروش' },
      { command: 'find', description: 'جستجوی کاربر با ایمیل' }, { command: 'panel', description: 'تست سلامت پنل‌ها' },
      { command: 'help', description: 'همه‌ی دستورها' },
    ] });
  }
  await setSetting(env, 'tg_webhook_sig', want);
  return true;
}

// ---------------- admin log and "are you sure?" ----------------
export async function audit(env, adminId, action, targetType, targetId, summary) {
  await insert(env, 'admin_audit', { admin_id: String(adminId), action, target_type: targetType || null, target_id: targetId == null ? null : String(targetId),
    summary: summary ? String(summary).slice(0, 300) : null, created_at: nowSec() });
}

// Dangerous actions wait for a second tap on a one-time button (2 minutes).
export async function askConfirm(env, chatId, action, payload, question) {
  const token = [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await insert(env, 'bot_confirm', { token, admin_id: String(chatId), action, payload_json: JSON.stringify(payload || {}), expires_at: nowSec() + 120 });
  return tg(env, 'sendMessage', { chat_id: chatId, text: `⚠️ مطمئنی؟\n${question}`, reply_markup: { inline_keyboard: [[
    { text: '✅ بله، انجام بده', callback_data: `cf:${token}` }, { text: '❌ انصراف', callback_data: `cx:${token}` },
  ]] } });
}

async function onConfirm(env, cq, yes) {
  const chatId = cq.message?.chat?.id;
  const token = String(cq.data || '').slice(3);
  const ack = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
  const row = await first(env, 'SELECT * FROM bot_confirm WHERE token = ?', token);
  if (!row || row.admin_id !== String(chatId)) return ack('پیدا نشد');
  const claim = await run(env, 'UPDATE bot_confirm SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at >= ?', nowSec(), token, nowSec());
  if (!claim.meta.changes) return ack('این تأیید منقضی یا قبلاً استفاده شده است');
  if (!yes) { await editStatus(env, cq, '❌ لغو شد.'); return ack('لغو شد'); }
  const payload = JSON.parse(row.payload_json || '{}');
  let result = 'انجام شد';
  if (row.action === 'drain_panel') {
    const { getPanel, drainPanel } = await import('./panels.js');
    const panel = await getPanel(env, payload.panel_id);
    if (!panel) result = 'پنل پیدا نشد';
    else {
      await drainPanel(env, panel);
      await audit(env, chatId, 'panel.drain', 'panel', panel.id, `خارج‌سازی ${panel.label}`);
      result = `پنل #${panel.id} (${panel.label}) از لیست خارج شد. مصرفش یک بار دیگر خوانده می‌شود، بعد اکانت‌هایش خاموش و پنل غیرفعال می‌شود. تاریخچه‌ی مصرف پاک نمی‌شود.`;
    }
  }
  if (row.action === 'grant') {
    const u = await first(env, 'SELECT * FROM users WHERE id = ?', payload.user_id);
    const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', payload.plan_id);
    if (!u || !plan) result = 'کاربر یا پلن پیدا نشد';
    else {
      const { provision } = await import('./billing.js');
      try {
        await provision(env, u, plan);
        await audit(env, chatId, 'user.grant', 'user', u.id, `پلن #${plan.id}`);
        result = `پلن ${plan.name} به ${u.email} داده شد.`;
      } catch (e) {
        await editStatus(env, cq, '⚠️ ساخت اکانت روی پنل انجام نشد:\n' + e.message + '\n\nبرای عیب‌یابی /panel را بزن.');
        return ack('انجام نشد');
      }
    }
  }
  if (row.action === 'link') {
    const u = await first(env, 'SELECT * FROM users WHERE id = ?', payload.user_id);
    const { getPanel } = await import('./panels.js');
    const panel = await getPanel(env, payload.panel_id);
    const check = u && panel ? await linkCheck(env, u, panel, payload.username) : { error: 'کاربر یا پنل پیدا نشد' };
    if (check.error) { await editStatus(env, cq, '❌ ' + check.error); return ack('انجام نشد'); }
    const { linkAccount } = await import('./sync.js');
    try {
      const r = await linkAccount(env, u, panel, check.remote);
      await audit(env, chatId, 'user.link', 'user', u.id, `پنل #${panel.id} ← ${payload.username}${r.replaced ? ` (به جای ${r.replaced})` : ''}`);
      result = `اکانت ${payload.username} از پنل #${panel.id} به ${u.email} وصل شد. روی پنل چیزی ساخته نشد؛ همان لینک و همان کانفیگ‌ها در اپ می‌آید.`;
      if (r.replaced) result += r.disabled ? `\nاکانت قبلی‌اش (${r.replaced}) روی پنل خاموش شد.` : `\n⚠️ اکانت قبلی‌اش (${r.replaced}) خاموش نشد؛ آن را در پنل دستی خاموش کن.`;
    } catch (e) {
      const msg = /UNIQUE/i.test(String(e && e.message)) ? 'این اکانت پنل همین الان به کاربر دیگری وصل شد.' : (e && e.message) || 'خطای ناشناخته';
      await editStatus(env, cq, '⚠️ وصل نشد:\n' + msg);
      return ack('انجام نشد');
    }
  }
  if (row.action === 'del_coupon') {
    const r = await run(env, 'DELETE FROM coupons WHERE code = ?', String(payload.code || ''));
    if (r.meta && r.meta.changes) await audit(env, chatId, 'coupon.delete', 'coupon', payload.code, null);
    result = r.meta && r.meta.changes ? `کد ${payload.code} پاک شد.` : 'این کد پیدا نشد.';
  }
  await editStatus(env, cq, '✅ ' + result);
  return ack('انجام شد');
}

// ---------------- linking an existing panel account ----------------
// Reads the panel user live and checks it can become this app user's account. {remote, summary} or {error}.
export async function linkCheck(env, u, panel, username) {
  if (!['active', 'rollout'].includes(panel.state)) return { error: `پنل #${panel.id} فعال نیست. لیست: /panels` };
  const owner = await first(env, `SELECT a.user_id, u.email FROM panel_accounts a JOIN users u ON u.id = a.user_id
    WHERE a.panel_id = ? AND a.remote_username = ?`, panel.id, username);
  if (owner && owner.user_id === u.id) return { error: `این اکانت از قبل به ${u.email} وصل است.` };
  if (owner) return { error: `این اکانت پنل به کاربر دیگری وصل است: ${owner.email}` };
  const { adapterFor } = await import('./panels.js');
  const { parseExpire } = await import('./pasarguard.js');
  let remote;
  try { remote = await (await adapterFor(env, panel)).getUser(username); }
  catch (e) { return { error: `پنل #${panel.id} جواب نداد: ${e.message}` }; }
  if (!remote) return { error: `کاربری با یوزرنیم ${username} روی پنل #${panel.id} (${panel.label}) پیدا نشد.` };
  if (!remote.subscription_url) return { error: 'پنل برای این کاربر لینک ساب نداد.' };
  remote.username = remote.username || username;
  const exp = parseExpire(remote.expire);
  const now = nowSec();
  const limit = parseInt(remote.data_limit || 0, 10) || 0, used = parseInt(remote.used_traffic || 0, 10) || 0;
  const lines = [`🔗 اکانت ${username} روی پنل #${panel.id} (${panel.label}) به ${u.email} وصل شود؟`, '',
    `وضعیت روی پنل: ${remote.status || '-'}`,
    `زمان: ${exp ? (exp > now ? `${Math.ceil((exp - now) / 86400)} روز (تا ${new Date(exp * 1000).toISOString().slice(0, 10)})` : 'تمام شده') : 'نامحدود'}`,
    `حجم: ${(used / GB).toFixed(2)} از ${limit ? (limit / GB).toFixed(1) + ' گیگ' : 'نامحدود'}`, '',
    'روی پنل اکانت جدیدی ساخته نمی‌شود؛ همین اکانت (همان UUID و لینک) در اپ استفاده می‌شود و v2rayNG هم کار می‌کند.'];
  const sub = await first(env, 'SELECT s.*, p.name FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ?', u.id);
  if (sub) lines.push(`⚠️ اشتراک فعلی این کاربر در اپ${sub.name ? ` (${sub.name})` : ''} با این اکانت جایگزین می‌شود.`);
  const mine = await first(env, 'SELECT remote_username FROM panel_accounts WHERE user_id = ? AND panel_id = ?', u.id, panel.id);
  if (mine) lines.push(`اکانت قبلی‌اش روی این پنل (${mine.remote_username}) خاموش می‌شود (پاک نمی‌شود).`);
  return { remote, summary: lines.join('\n') };
}

// ---------------- diagnostics ----------------
export const STATE_FA = { new: 'تازه', testing: 'تست‌شده', rollout: 'ورود تدریجی', active: 'فعال', draining: 'در حال خارج‌شدن', disabled: 'غیرفعال' };

// Health of every panel, by its label. Never prints a panel address, user name or password.
export async function panelReport(env) {
  const { listPanels, testPanel } = await import('./panels.js');
  const lines = ['🔎 تست سلامت پنل‌ها'];
  for (const p of await listPanels(env)) {
    if (p.state === 'disabled') { lines.push('', `#${p.id} ${p.label}: غیرفعال`); continue; }
    const t = await testPanel(env, p);
    lines.push('', `#${p.id} ${p.label} (${t.kind || p.kind}) — ${STATE_FA[p.state] || p.state}`);
    lines.push(t.login ? '✅ ورود به API موفق بود' : `❌ ورود ناموفق: ${t.error || ''}`);
    if (t.login) lines.push(t.create ? '✅ ساخت اکانت آزمایشی موفق بود' : `❌ ساخت اکانت ناموفق: ${t.error || ''}`);
    if (t.create) lines.push(t.configs ? `✅ لینک ساب کار می‌کند: ${t.configs} کانفیگ` : '⚠️ لینک ساب خالی است؛ در پنل برای این گروه Inbound/Host فعال کن.');
    if (t.version) lines.push(`نسخه‌ی پنل: ${t.version}`);
    if (t.sameHost === true) lines.push('⚠️ دامنه‌ی نودها همان دامنه‌ی پنل است؛ آدرس پنل داخل کانفیگ‌ها دیده می‌شود. برای نودها دامنه‌ی جدا بگذار.');
    if (t.sameHost === false) lines.push('✅ دامنه‌ی نودها با دامنه‌ی پنل فرق دارد.');
    if (!t.login && p.cred_ref !== 'PASARGUARD') lines.push(`راه حل: آدرس/یوزر/رمز را دوباره بده: /panelcred ${p.id}`);
  }
  return lines.join('\n');
}

export async function backupJson(env) {
  const tables = ['users', 'plans', 'subscriptions', 'orders', 'wallet_tx', 'devices', 'settings', 'coupons', 'coupon_uses',
    'panels', 'panel_accounts', 'sub_periods', 'usage_counters', 'admin_audit'];
  const out = { created_at: new Date().toISOString(), tables: {} };
  for (const t of tables) {
    try { out.tables[t] = await all(env, `SELECT * FROM ${t}`); } catch (e) { out.tables[t] = []; }
  }
  // password hashes never leave the database: a leaked chat must not leak them (D1 Time Travel restores everything)
  out.tables.users = out.tables.users.map(({ password_hash, ...u }) => u);
  // subscription links contain the panel address, which never goes into a chat
  out.tables.subscriptions = out.tables.subscriptions.map(({ sub_url, ...x }) => x);
  out.tables.panel_accounts = out.tables.panel_accounts.map(({ sub_path, ...x }) => x);
  out.tables.settings = out.tables.settings.filter((x) => x.key !== 'tg_webhook_sig' && x.key !== 'bot_wait' && !x.key.startsWith('panel_cred_'));
  return JSON.stringify(out);
}

export async function sendBackup(env, chatId) {
  const data = await backupJson(env);
  const day = new Date().toISOString().slice(0, 10);
  const users = (await first(env, 'SELECT COUNT(*) c FROM users')).c;
  return sendDocument(env, chatId || env.TELEGRAM_CHAT_ID, `cloudgold-backup-${day}.json`, data, `💾 پشتیبان ${day} — ${users} کاربر\nاین فایل را جایی امن نگه دار.`);
}

export const HELP = `راهنمای ربات Cloud Gold

همه‌ی کارها با دکمه است؛ لازم نیست چیزی با / تایپ کنی. دکمه‌ی «🏠 منو» همیشه پایین صفحه است.

🧾 رسیدهای منتظر — تأیید یا رد پرداخت‌ها
👤 کاربران — جستجو با ایمیل؛ در کارت کاربر: دادن پلن، تغییر رمز، وصل اکانت پنل
📦 پلن‌ها — ویرایش هر پلن و ساخت پلن جدید
🗂 پنل‌ها — افزودن پنل (نوعش خودکار تشخیص داده می‌شود)، ورود پنل، تست، ورود تدریجی، خارج‌کردن
🏷 کدهای تخفیف — ساخت و حذف
💰 پرداخت‌ها — کارت، ولت‌ها، قیمت دلار، پیامک بانک
⚙️ تنظیمات — هر مقدار با دکمه‌ی تغییر
📊 آمار، 🔎 گوگل، 📶 اپراتورها، 💾 پشتیبان

وقتی ربات سؤالی می‌پرسد (ایمیل، عدد، رمز…) فقط جواب را بنویس و بفرست.
پیامک واریز بانک را هم می‌توانی کپی کنی و همین‌جا بفرستی.`;

export const PLAN_FIELDS = { name: 'name', price: 'price_toman', old: 'old_price_toman', days: 'duration_days', gb: 'data_limit_gb', devices: 'device_limit', trial: 'trial_days', badge: 'badge', sort: 'sort', on: 'is_active', desc: 'description' };

// A command started from the button menu: its answers carry a "back" button to the screen it came from.
// Only reached from onMenu, after onCallback checked that the tap came from the admin in their private chat.
export function runAdminCommand(env, chatId, text, kb) {
  return onMessage(env, { chat: { id: chatId, type: 'private' }, from: { id: chatId }, text }, { kb });
}

async function onMessage(env, msg, opts = {}) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  // "⏳ working..." notes never get the back button; the real answer that follows does
  const say = (t, extra) => {
    const markup = (extra && extra.reply_markup) || (opts.kb && !String(t).startsWith('⏳') ? opts.kb : undefined);
    const b = buttonize(t, markup);
    return tg(env, 'sendMessage', { chat_id: chatId, disable_web_page_preview: true, ...(extra || {}),
      text: b.text.slice(0, 4000), ...(b.reply_markup ? { reply_markup: b.reply_markup } : {}) });
  };
  const cmd = text.split(/\s+/)[0].replace(/@\w+$/, '').toLowerCase();
  const admin = isAdmin(env, msg.chat, msg.from);
  if (cmd === '/id' || (cmd === '/start' && !admin)) {
    if (msg.chat?.type !== 'private') return say('ربات مدیریت فقط در چت خصوصی کار می‌کند. /id را در چت خصوصی با ربات بفرست.');
    return say(`Chat id شما: ${chatId}\nاین عدد را در GitHub به اسم TELEGRAM_CHAT_ID بگذار.`);
  }
  if (!admin) return;

  if (text === MENU_BTN || cmd === '/start' || cmd === '/menu' || cmd === '/help') {
    const menu = await import('./telegram-menu.js');
    if (text === MENU_BTN) await menu.takeWait(env); // the menu button also cancels an open question
    // a button that stays under the chat's text box, so the menu is always one tap away
    if (cmd === '/start') await tg(env, 'sendMessage', { chat_id: chatId, text: 'همه‌ی کارها با دکمه است؛ لازم نیست دستوری تایپ کنی. دکمه‌ی «🏠 منو» همیشه پایین صفحه است.',
      reply_markup: { keyboard: [[{ text: MENU_BTN }]], resize_keyboard: true, is_persistent: true } });
    return menu.sendHome(env, chatId);
  }

  // the menu asked a question ("write the email", "new price"...): this message is the answer
  if (text && !opts.kb) {
    const menu = await import('./telegram-menu.js');
    const w = await menu.takeWait(env);
    if (w && !text.startsWith('/')) {
      if (w.secret && msg.message_id) await tg(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id });
      return onMessage(env, { chat: msg.chat, from: msg.from, text: `${w.cmd} ${text}` }, { kb: menu.backKb(w.back) });
    }
  }
  // a panel login typed after its question expired: it must not stay in the chat
  if (text && !text.startsWith('/') && /https?:\/\/\S+\s+\S+\s+\S+/i.test(text) && text.split(/\s+/).length <= 6) {
    if (msg.message_id) await tg(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    return say('این پیام شبیه آدرس و رمز پنل بود و پاک شد، ولی ذخیره نشد (سؤالش منقضی شده بود). از دکمه‌ی «🔐 ورود پنل» یا /panelcred شماره‌پنل دوباره شروع کن.');
  }

  // the admin pasted a bank SMS: find the card order and confirm it
  if (text && !text.startsWith('/')) {
    const { parseBankSms, handleBankSms } = await import('./sms.js');
    const p = parseBankSms(text);
    if (p.deposit && p.amounts.length) {
      const r = await handleBankSms(env, { sender: 'admin-paste', text, trusted: true, source: 'paste' });
      if (r.result === 'paid') return say(`✅ سفارش #${r.orderId} تأیید و فعال شد.`);
      if (r.result === 'duplicate') return say('این پیامک قبلاً بررسی شده است.');
      if (r.result === 'settle_failed') return say(`⚠️ سفارش #${r.orderId} پیدا شد ولی فعال‌سازی انجام نشد: ${r.message}`);
      if (r.result === 'no_order' || r.result === 'ambiguous') return; // handleBankSms already explained it
      return say('سفارش برای تأیید تو فرستاده شد.');
    }
  }

  if (cmd === '/panel') {
    await say('⏳ در حال تست پنل...');
    return say(await panelReport(env));
  }

  if (cmd === '/backup') return sendBackup(env, chatId);

  if (cmd === '/panels') {
    const { listPanels } = await import('./panels.js');
    const rows = await listPanels(env);
    const lines = ['🗂 پنل‌ها'];
    for (const p of rows) {
      const n = (await first(env, "SELECT COUNT(*) c FROM panel_accounts WHERE panel_id = ? AND desired = 'active'", p.id)).c;
      lines.push(`#${p.id} ${p.label} (${p.kind}) — ${STATE_FA[p.state] || p.state}${p.state === 'rollout' ? ` ${p.rollout_percent}%` : ''} · سلامت ${p.health} · ${n} کاربر فعال${p.version ? ` · نسخه ${p.version}` : ''}`);
      if (['active', 'rollout'].includes(p.state)) {
        const { panelProgress, createError } = await import('./sync.js');
        const g = await panelProgress(env, p);
        if (g.want > g.have) lines.push(`   ⏳ اکانت‌سازی: ${g.have} از ${g.want} کاربر`);
        const ce = await createError(env, p.id);
        if (ce) lines.push(`   ⚠️ ساخت اکانت رد شد: ${ce.msg.slice(0, 120)}`);
      }
    }
    lines.push('', 'افزودن: /addpanel نام (نوع خودکار) · ورود پنل: /panelcred شماره', 'تست: /paneltest شماره · ورود تدریجی: /rollout شماره درصد', 'گروه‌ها: /panelgroups شماره 1,2 · خارج‌کردن: /drainpanel شماره');
    return say(lines.join('\n'));
  }
  if (cmd === '/addpanel') {
    // /addpanel نام  (type found by /paneltest)  or  /addpanel rebecca|marzban|pasarguard نام
    const { KINDS } = await import('./panels.js');
    const [, word, ...rest] = text.split(/\s+/);
    const given = String(first || '').toLowerCase();
    const k = KINDS.includes(given) ? given : 'auto';
    const label = (k === given ? rest : [word, ...rest]).join(' ').trim();
    if (!label) return say('شکل درست: /addpanel نام‌دلخواه\nنوع پنل (PasarGuard، Marzban یا Rebecca) موقع /paneltest خودکار تشخیص داده می‌شود.\nاگر خواستی نوع را خودت بگو: /addpanel rebecca نام');
    const { addPanel } = await import('./panels.js');
    const p = await addPanel(env, k, label);
    await audit(env, chatId, 'panel.add', 'panel', p.id, `${k} ${label}`);
    const menu = await import('./telegram-menu.js');
    await menu.setWait(env, `/panelcred ${p.id}`, `pp:${p.id}`, true);
    return say([`✅ پنل #${p.id} (${p.label}) ثبت شد؛ هنوز به هیچ کاربری داده نمی‌شود.`, '', menu.CRED_PROMPT, '',
      'بعد از ذخیره، پنل خودکار تست می‌شود.'].join('\n'));
  }
  if (cmd === '/panelcred') {
    // the message carries a password: it leaves the chat before anything else happens
    if (msg.message_id && text.split(/\s+/).length > 2) await tg(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    const parts = text.split(/\s+/);
    const { getPanel, parseCred, savePanelCred, testPanel } = await import('./panels.js');
    const panel = await getPanel(env, parseInt(parts[1], 10));
    if (!panel) return say('شکل درست: /panelcred شماره‌پنل (لیست: /panels)');
    if (panel.cred_ref === 'PASARGUARD') return say('ورود پنل ۱ از Secretهای PASARGUARD_* خوانده می‌شود و از اینجا عوض نمی‌شود.');
    const body = text.replace(/^\/panelcred(@\w+)?\s+\S+\s*/i, '');
    const menu = await import('./telegram-menu.js');
    if (!body) {
      await menu.setWait(env, `/panelcred ${panel.id}`, `pp:${panel.id}`, true);
      return say(menu.CRED_PROMPT);
    }
    const { cred, error } = parseCred(body);
    if (error) {
      await menu.setWait(env, `/panelcred ${panel.id}`, `pp:${panel.id}`, true);
      return say(`❌ ${{ url: 'آدرس پنل درست نیست.', json: 'JSON درست نیست.' }[error] || 'باید سه چیز باشد: آدرس، یوزرنیم، رمز.'} دوباره بفرست:\n\n${menu.CRED_PROMPT}`);
    }
    await savePanelCred(env, panel, cred);
    await audit(env, chatId, 'panel.cred', 'panel', panel.id, 'ورود پنل عوض شد');
    await say(`🔐 ورود پنل #${panel.id} ذخیره شد (رمزنگاری‌شده). پیامت پاک شد.\n⏳ در حال تست پنل...`);
    return onMessage(env, { chat: msg.chat, from: msg.from, text: `/paneltest ${panel.id} silent` }, opts);
  }
  if (cmd === '/paneltest' || cmd === '/rollout' || cmd === '/drainpanel' || cmd === '/panelgroups') {
    const parts = text.split(/\s+/);
    const { getPanel, testPanel, setRollout, listPanels } = await import('./panels.js');
    const panel = await getPanel(env, parseInt(parts[1], 10));
    if (!panel) {
      // tapping a command inside a bot message sends only the command word, without the panel number
      const rows = (await listPanels(env)).map((p) => `#${p.id} ${p.label} (${p.kind})`).join('\n');
      const how = { '/paneltest': 'شماره', '/rollout': 'شماره درصد', '/drainpanel': 'شماره', '/panelgroups': 'شماره 1,2' }[cmd];
      return say(`شماره‌ی پنل را هم بنویس: ${cmd} ${how}\nمثلاً: ${cmd} 2${cmd === '/rollout' ? ' 10' : ''}\n\n${rows}\n\nیا از منوی /menu ← پنل‌ها دکمه‌ها را بزن.`);
    }
    if (cmd === '/paneltest') {
      if (parts[2] !== 'silent') await say('⏳ در حال تست پنل...');
      const t = await testPanel(env, panel);
      await audit(env, chatId, 'panel.test', 'panel', panel.id, t.healthy ? 'سالم' : 'ناسالم');
      const kindLine = t.kind ? `نوع پنل: ${t.kind}${t.kindChanged ? ' (خودکار تشخیص داده و ثبت شد)' : ''}\n` : '';
      const go = t.healthy ? { reply_markup: { inline_keyboard: [
        [{ text: '🚀 ۱۰٪ کاربران', callback_data: `m:x:pp:${panel.id}|/rollout ${panel.id} 10` }, { text: '🚀 همه‌ی کاربران', callback_data: `m:x:pp:${panel.id}|/rollout ${panel.id} 100` }],
        [{ text: '🗂 صفحه‌ی پنل', callback_data: `m:pp:${panel.id}` }]] } } : undefined;
      return say(kindLine + (t.healthy ? `✅ پنل #${panel.id} سالم است (${t.configs} کانفیگ${t.version ? `، نسخه ${t.version}` : ''}).${t.sameHost ? '\n⚠️ دامنه‌ی نودها همان دامنه‌ی پنل است.' : ''}\nبرای شروع یکی از دکمه‌ها را بزن (یا بنویس: /rollout ${panel.id} 10)`
        : `❌ پنل #${panel.id} سالم نیست: ${t.error || 'لینک ساب کانفیگی ندارد'}${t.kind === 'rebecca' && !t.create ? `\nدر Rebecca هر کاربر باید یک سرویس (Service) داشته باشد. شماره‌ی سرویس را بده: /panelgroups ${panel.id} شماره` : ''}`), go);
    }
    if (cmd === '/panelgroups') {
      const ids = String(parts[2] || '').split(',').map((x) => parseInt(x, 10)).filter((n) => n > 0);
      const { options } = await import('./panels.js');
      await run(env, 'UPDATE panels SET options_json = ? WHERE id = ?', JSON.stringify({ ...options(panel), group_ids: ids }), panel.id);
      await audit(env, chatId, 'panel.groups', 'panel', panel.id, ids.join(',') || 'همه');
      return say(`✅ گروه‌های پنل #${panel.id}: ${ids.join(',') || 'همه‌ی گروه‌های مجاز'}`);
    }
    if (cmd === '/rollout') {
      const pct = parseInt(parts[2], 10);
      if (!(pct >= 0 && pct <= 100)) return say('شکل درست: /rollout شماره درصد (0 تا 100)');
      if (!['testing', 'rollout', 'active'].includes(panel.state)) return say('اول پنل را تست کن: /paneltest ' + panel.id);
      const p = await setRollout(env, panel, pct);
      await audit(env, chatId, 'panel.rollout', 'panel', panel.id, `${pct}%`);
      const { panelProgress } = await import('./sync.js');
      const g = await panelProgress(env, p);
      return say(`✅ پنل #${p.id}: ${STATE_FA[p.state]} ${p.rollout_percent}%.\n${g.want ? `${g.have} از ${g.want} کاربر الان روی این پنل اکانت دارند. بقیه با باز کردن اپ فوراً، یا در پس‌زمینه هر دقیقه چند نفر، اکانت می‌گیرند و کانفیگ‌های این پنل به لیستشان اضافه می‌شود. پیشرفت: /panels` : 'فعلاً کاربری با اشتراک فعال در این سهم نیست.'}`);
    }
    if (cmd === '/drainpanel') {
      if (['draining', 'disabled'].includes(panel.state)) return say('این پنل قبلاً خارج شده است.');
      const others = (await listPanels(env)).filter((p) => p.id !== panel.id && ['active', 'rollout'].includes(p.state));
      if (!others.length) return say('❌ این تنها پنل فعال است؛ اول یک پنل دیگر اضافه و فعال کن.');
      return askConfirm(env, chatId, 'drain_panel', { panel_id: panel.id },
        `پنل #${panel.id} (${panel.label}) از لیست سرورها خارج و بعد غیرفعال شود؟ کاربرانش روی پنل‌های دیگر می‌مانند و مصرفشان حفظ می‌شود.`);
    }
  }

  if (cmd === '/find' || cmd === '/user') {
    const email = text.split(/\s+/)[1]?.toLowerCase() || '';
    const u = await first(env, 'SELECT * FROM users WHERE email = ?', email);
    if (!u) return say('کاربری با این ایمیل نیست.');
    const { userKb } = await import('./telegram-menu.js');
    return say(await userInfo(env, u), { reply_markup: userKb(u.id) });
  }
  if (cmd === '/reset') {
    const [, email, pass] = text.split(/\s+/);
    if (!email || !pass || pass.length < 8) return say('شکل درست: /reset email@example.com رمزجدید (حداقل ۸ کاراکتر)');
    const u = await first(env, 'SELECT * FROM users WHERE email = ?', email.toLowerCase());
    if (!u) return say('کاربری با این ایمیل نیست.');
    await run(env, 'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', await hashPassword(pass, env.SECRET_KEY), u.id);
    await audit(env, chatId, 'user.reset_password', 'user', u.id, null);
    return say(`رمز ${email} عوض شد. گوشی‌های دیگر از حساب خارج شدند.`);
  }
  if (cmd === '/link') {
    const [, email, username, panelStr] = text.split(/\s+/);
    const u = await first(env, 'SELECT * FROM users WHERE email = ?', (email || '').toLowerCase());
    if (!u || !username) return say('شکل درست: /link ایمیل‌کاربر یوزرنیم‌پنل [شماره‌پنل]\nمثال: /link ali@gmail.com ali_v2ray\n(شماره‌ی پنل را فقط وقتی بنویس که پنل ۱ نیست؛ لیست: /panels)');
    if (!/^[\w.@-]{1,64}$/.test(username)) return say('یوزرنیم پنل فقط حرف انگلیسی، عدد و _ . - @ دارد.');
    const { getPanel } = await import('./panels.js');
    const panel = await getPanel(env, panelStr ? parseInt(panelStr, 10) : 1);
    if (!panel) return say('پنل پیدا نشد. لیست: /panels');
    const check = await linkCheck(env, u, panel, username);
    if (check.error) return say('❌ ' + check.error);
    return askConfirm(env, chatId, 'link', { user_id: u.id, panel_id: panel.id, username }, check.summary);
  }
  if (cmd === '/grant') {
    const [, email, planIdStr] = text.split(/\s+/);
    const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', parseInt(planIdStr, 10));
    const u = await first(env, 'SELECT * FROM users WHERE email = ?', (email || '').toLowerCase());
    if (!u || !plan) return say('شکل درست: /grant email@example.com شماره‌پلن  (شماره‌ها در /plans)');
    const { provision } = await import('./billing.js');
    try { await provision(env, u, plan); } catch (e) { return say('⚠️ ساخت اکانت روی پنل انجام نشد:\n' + e.message + '\n\nبرای عیب‌یابی /panel را بزن.'); }
    await audit(env, chatId, 'user.grant', 'user', u.id, `پلن #${plan.id}`);
    return say(`✅ پلن ${plan.name} به ${email} داده شد.`);
  }
  if (cmd === '/plans') {
    const plans = await all(env, 'SELECT * FROM plans ORDER BY sort, id');
    const lines = plans.map((p) => `#${p.id} ${p.name} — ${fa(p.price_toman)} ت، ${p.duration_days} روز، ${p.data_limit_gb || 'نامحدود'} گیگ، ${p.device_limit || 'نامحدود'} دستگاه${p.trial_days ? `، تست ${p.trial_days} روز` : ''}${p.is_active ? '' : ' (خاموش)'}`);
    return say((lines.join('\n') || 'پلنی نیست.') + '\n\nتغییر: /plan شماره فیلد مقدار');
  }
  if (cmd === '/plan') {
    const m = text.match(/^\/plan(?:@\w+)?\s+(\d+)\s+(\w+)\s*([\s\S]*)$/i);
    if (!m) return say('شکل درست: /plan شماره فیلد مقدار\nمثال: /plan 1 price 199000\nفیلدها: ' + Object.keys(PLAN_FIELDS).join(' '));
    const [, id, f, raw] = m;
    const col = PLAN_FIELDS[f.toLowerCase()];
    if (!col) return say('فیلد ناشناخته. فیلدها: ' + Object.keys(PLAN_FIELDS).join(' '));
    const p = await first(env, 'SELECT * FROM plans WHERE id = ?', parseInt(id, 10));
    if (!p) return say('پلن پیدا نشد.');
    const textual = ['name', 'badge', 'description'].includes(col);
    const val = textual ? raw.trim() : parseInt(raw.replace(/[^\d]/g, '') || '0', 10);
    await run(env, `UPDATE plans SET ${col} = ? WHERE id = ?`, val, p.id);
    return say(`✅ پلن #${p.id}: ${f} = ${val === '' ? '(خالی)' : val}`);
  }
  if (cmd === '/newplan') {
    const parts = text.replace(/^\/newplan(@\w+)?\s*/i, '').split('|').map((s) => s.trim());
    const [name, days, gb, devices, price] = parts;
    if (!name || !(parseInt(days, 10) > 0) || !(parseInt(price, 10) >= 0)) return say('شکل درست: /newplan نام|روز|گیگ|دستگاه|قیمت\nمثال: /newplan سه ماهه|90|0|2|399000');
    const id = await insert(env, 'plans', { name, duration_days: parseInt(days, 10), data_limit_gb: parseInt(gb, 10) || 0, device_limit: parseInt(devices, 10) || 0,
      price_toman: parseInt(price, 10), old_price_toman: 0, badge: '', description: '', trial_days: 0, is_active: 1, sort: 10 });
    return say(`✅ پلن #${id} ساخته شد.`);
  }
  if (cmd === '/coupon') {
    const [, code, pct, uses, days, planId] = text.split(/\s+/);
    const percent = parseInt(pct, 10);
    if (!code || !(percent >= 1 && percent <= 100)) return say('شکل درست: /coupon کد درصد [تعداد] [روز] [شماره‌پلن]\nمثال: /coupon YALDA 20 100 7');
    const c = String(code).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    try {
      await insert(env, 'coupons', { code: c, percent, max_uses: parseInt(uses, 10) || 0, expires_at: parseInt(days, 10) > 0 ? nowSec() + parseInt(days, 10) * 86400 : null,
        plan_id: parseInt(planId, 10) || null, is_active: 1, created_at: nowSec() });
    } catch (e) { return say('این کد قبلاً ساخته شده. اول /delcoupon ' + c); }
    return say(`🏷 کد ${c} ساخته شد: ${percent}% تخفیف${parseInt(uses, 10) ? `، ${uses} بار` : ''}${parseInt(days, 10) ? `، ${days} روز` : ''}${parseInt(planId, 10) ? `، فقط پلن #${planId}` : ''}`);
  }
  if (cmd === '/coupons') {
    const rows = await all(env, 'SELECT * FROM coupons WHERE is_active = 1 ORDER BY id DESC LIMIT 30');
    if (!rows.length) return say('کد تخفیفی نیست. بساز: /coupon CODE 20');
    return say(rows.map((c) => `${c.code} — ${c.percent}% · ${c.used}${c.max_uses ? '/' + c.max_uses : ''} استفاده${c.expires_at ? ` · تا ${new Date(c.expires_at * 1000).toISOString().slice(0, 10)}` : ''}${c.plan_id ? ` · پلن #${c.plan_id}` : ''}`).join('\n'));
  }
  if (cmd === '/delcoupon') {
    const code = (text.split(/\s+/)[1] || '').toUpperCase();
    const r = await run(env, 'DELETE FROM coupons WHERE code = ?', code);
    return say(r.meta && r.meta.changes ? `🗑 کد ${code} پاک شد.` : 'این کد پیدا نشد.');
  }
  if (cmd === '/wallets') {
    const { COINS, walletKey, memoKey, prices } = await import('./coins.js');
    const { usdRateInfo } = await import('./usdrate.js');
    const s = await getSettings(env);
    const ri = await usdRateInfo(env);
    const p = await prices(env);
    const lines = ['💎 درگاه ارز دیجیتال Cloud Gold Pay', `قیمت دلار: ${ri.rate ? fa(ri.rate) + ' تومان · ' + RATE_FROM[ri.from] : '❌ از هیچ صرافی دریافت نشد → /rate'}`, ''];
    for (const c of COINS) {
      const w = String(s[walletKey(c)] || '').trim();
      const price = p && p[c.id] ? `$${p[c.id]}` : 'قیمت نامعلوم';
      const memo = c.memo ? String(s[memoKey(c)] || '').trim() : '';
      lines.push(`${w ? '✅' : '⚪️'} ${c.symbol} (${c.network}) · ${price} · کارمزد ${c.fee}\n   ${w || `خالی → /set ${walletKey(c)} آدرس`}${c.memo ? `\n   ${c.memo}: ${memo || `ندارد (اگر ولت صرافی است حتماً بگذار → /set ${memoKey(c)} ...)`}` : ''}`);
    }
    lines.push('', 'ارزی که آدرس ندارد در اپ نشان داده نمی‌شود.');
    return say(lines.join('\n'));
  }
  if (cmd === '/sms') {
    const { smsKey } = await import('./sms.js');
    const k = await smsKey(env);
    const s = await getSettings(env);
    const base = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const senders = String(s.sms_senders || '').split(',').filter(Boolean);
    return say([
      '💳 تأیید خودکار کارت‌به‌کارت با پیامک بانک',
      '',
      '۱) روی گوشی‌ای که پیامک بانک می‌آید، اپ رایگان «Incoming SMS to URL forwarder» را نصب کن (از F-Droid یا صفحه‌ی Releases گیت‌هاب).',
      '۲) در اپ یک قانون بساز:',
      '   Sender: *  (یا شماره‌ی بانک)',
      `   URL: ${base}/sms/${k}`,
      '   بقیه را دست نزن (JSON پیش‌فرض درست است) → Test → Save',
      '۳) اولین پیامک واریز که آمد، در تلگرام دکمه‌ی «🏦 این فرستنده بانک من است» را بزن. از آن به بعد خودکار تأیید می‌شود.',
      '',
      `فرستنده‌های بانکی مورد اعتماد: ${senders.length ? senders.join('، ') : 'هنوز هیچ'}`,
      `حالت: card_auto = ${s.card_auto} · مبلغ یکتا: ${s.card_unique === '0' ? 'خاموش' : 'روشن'}`,
      '',
      'بدون نصب اپ: پیامک واریز را کپی کن و همین‌جا برای ربات بفرست.',
      'این آدرس را به کسی نده؛ اگر لو رفت: /set sms_key  (خالی) و دوباره /sms',
    ].join('\n'));
  }
  if (cmd === '/google') {
    const { googleSummary } = await import('./netstats.js');
    const rows = await googleSummary(env);
    if (!rows.length) return say('هنوز تست گوگلی ثبت نشده. هر کاربر بعد از اتصال، سرورش را خودکار تست می‌کند؛ کمی بعد دوباره بزن.');
    const ico = { google: '🟢', no_gemini: '🟡', iran: '🔴', flagged: '🟠' };
    const txt = { google: 'گوگل و Gemini سالم', no_gemini: 'گوگل سالم، Gemini نه', iran: 'گوگل آن را «ایران» می‌بیند', flagged: 'گوگل IP را مشکوک می‌داند (کپچا)' };
    const lines = ['🔎 وضعیت سرورها از دید گوگل (۳ روز اخیر)', ''];
    for (const r of rows.sort((a, b) => (a.status === 'google') - (b.status === 'google'))) {
      lines.push(`${ico[r.status]} ${r.name} — ${txt[r.status]} · کشور از دید گوگل: ${r.google_cc || '?'} · ${r.tests} تست`);
    }
    lines.push('', 'برای 🔴 و 🟠: روی همان نود، خروجی را از IP دیگری بده (مثلاً WARP یا یک IP تمیز) تا گوگل آن را کشور دیگری ببیند.');
    return say(lines.join('\n'));
  }
  if (cmd === '/carriers') {
    const { carrierSummary } = await import('./netstats.js');
    const nets = (await carrierSummary(env)).slice(0, 6);
    if (!nets.length) return say('هنوز نتیجه‌ای از گوشی‌ها نرسیده. بعد از چند تست در اپ دوباره بزن.');
    const line = (s) => `${s.name} — وصل ${fa(s.ok)}٪${s.ms ? ` · پینگ ${fa(s.ms)}ms` : ''}${s.kbps ? ` · سرعت ${fa((s.kbps / 1000).toFixed(1))} مگابیت` : ''} · ${fa(s.users)} نفر`;
    const lines = ['📶 کدام سرور روی کدام اپراتور بهتر است (۳ روز اخیر)'];
    for (const n of nets) {
      lines.push('', `▪️ ${n.isp} — ${fa(n.tests)} تست`);
      const best = n.servers.slice(0, 3), weak = n.servers.length > 3 ? n.servers.slice(-3).reverse() : [];
      for (const s of best) lines.push('🟢 ' + line(s));
      for (const s of weak) lines.push('🔴 ' + line(s));
    }
    lines.push('', '🔴 یعنی روی آن اپراتور کمتر وصل می‌شود یا کندتر است؛ می‌توانی آن سرور را برای آن اپراتور عوض کنی.');
    return say(lines.join('\n'));
  }
  if (cmd === '/rate') {
    const { usdRateInfo } = await import('./usdrate.js');
    const ri = await usdRateInfo(env, { force: true });
    const lines = ['💵 قیمت لحظه‌ای دلار (تتر/تومان صرافی‌ها)', ''];
    for (const x of ri.sources || []) lines.push(`${x.rate ? ((ri.used || []).includes(x.id) ? '✅' : '⚠️') : '❌'} ${x.name}: ${x.rate ? fa(x.rate) + ' تومان' : 'جواب نداد' + (x.error ? ` (${x.error})` : '')}`);
    lines.push('', ri.rate ? `قیمت استفاده‌شده: ${fa(ri.rate)} تومان · ${RATE_FROM[ri.from]}` : '❌ قیمتی در دسترس نیست. موقتاً می‌توانی دستی بگذاری: /set usd_rate_toman 100000');
    lines.push('میانه‌ی قیمت صرافی‌ها استفاده می‌شود؛ قیمت‌های خیلی دور از بقیه (⚠️) کنار گذاشته می‌شوند.');
    return say(lines.join('\n'));
  }
  if (cmd === '/set') {
    const rest = text.replace(/^\/set(@\w+)?\s*/i, '');
    const i = rest.indexOf(' ');
    const key = i < 0 ? rest : rest.slice(0, i);
    const val = i < 0 ? '' : rest.slice(i + 1).trim();
    if (!(key in SETTING_DEFAULTS)) return say(`کلید ناشناخته. کلیدها:\n${Object.keys(SETTING_DEFAULTS).join('\n')}`);
    if (key === 'card_number' && val) {
      const { luhnOk, bankOf, cardDigits } = await import('./banks.js');
      if (!luhnOk(val)) return say('❌ این شماره کارت درست نیست (۱۶ رقم و معتبر). دوباره از روی کارت بنویس.');
      const b = bankOf(val);
      await setSetting(env, key, cardDigits(val));
      return say(`✅ شماره کارت ثبت شد${b.name ? ` — بانک ${b.name}` : ''}.`);
    }
    if (key.startsWith('wallet_') && val) {
      const { validAddress, coinById } = await import('./coins.js');
      const c = coinById(key.slice(7));
      if (key.endsWith('_memo')) {
        const { validMemo } = await import('./coins.js');
        const cid = key.slice(7, -5);
        if (!validMemo(cid, val)) return say(cid === 'xrp' ? '❌ Destination Tag ریپل فقط عدد است (حداکثر ۱۰ رقم).' : '❌ این Memo طولانی‌تر از حد مجاز است.');
        await setSetting(env, key, val);
        return say(`✅ ${key} = ${val}`);
      }
      if (!validAddress(key.slice(7), val)) return say(`❌ این آدرس برای ${c ? c.symbol + ' (' + c.network + ')' : key} درست به نظر نمی‌رسد. دوباره از ولتت کپی کن.\nبرای خاموش کردن این ارز: /set ${key}`);
    }
    await setSetting(env, key, val);
    return say(`✅ ${key} = ${val || '(خالی)'}`);
  }
  if (cmd === '/settings') {
    const s = await getSettings(env);
    return say(Object.entries(s).filter(([k]) => k in SETTING_DEFAULTS).map(([k, v]) => `${k} = ${v || '—'}`).join('\n'));
  }
  if (cmd === '/stats') {
    return say(await statsText(env));
  }
}

// What /find and the user card show: wallet, plan, time and data left, read live from the panels.
export async function userInfo(env, u) {
  const { subscriptionOut } = await import('./account.js');
  const sub = await subscriptionOut(env, u);
  const sRow = await first(env, 'SELECT pg_username FROM subscriptions WHERE user_id = ?', u.id);
  const lines = [`👤 ${u.email}`, `کیف پول: ${fa(u.wallet_balance)} تومان`, `کد دعوت: ${u.referral_code}`];
  if (sub) {
    lines.push(`پلن: ${sub.plan_name || '-'} · وضعیت: ${sub.status}${sub.live ? '' : ' (پنل جواب نداد)'}`);
    lines.push(`زمان: ${sub.unlimited_time ? 'نامحدود' : `${sub.days_left} روز (تا ${sub.expires_at.slice(0, 10)})`}`);
    lines.push(`حجم: ${(sub.used_bytes / GB).toFixed(2)} از ${sub.unlimited_data ? 'نامحدود' : (sub.data_limit_bytes / GB).toFixed(1) + ' گیگ'}`);
    if (sub.stop_reason) lines.push(`دلیل توقف: ${{ quota: 'حجم تمام شد', expired: 'زمان تمام شد', admin: 'ادمین' }[sub.stop_reason] || sub.stop_reason}`);
    const pas = await all(env, 'SELECT a.desired, p.label FROM panel_accounts a JOIN panels p ON p.id = a.panel_id WHERE a.user_id = ?', u.id);
    lines.push(`پنل‌ها: ${pas.map((a) => `${a.label}${a.desired === 'active' ? '' : ' (خاموش)'}`).join('، ') || '-'}`);
    lines.push(`یوزر پنل ۱: ${sRow ? sRow.pg_username : '-'}`);
  } else lines.push('اشتراک: ندارد');
  return lines.join('\n');
}

const RATE_FROM = { live: 'زنده از صرافی‌ها', saved: 'آخرین قیمت ذخیره‌شده', manual: 'دستی (usd_rate_toman)', none: 'نامشخص' };

export async function statsText(env) {
  const now = nowSec();
  const users = (await first(env, 'SELECT COUNT(*) c FROM users')).c;
  const newUsers = (await first(env, 'SELECT COUNT(*) c FROM users WHERE created_at > ?', now - 86400)).c;
  const active = (await first(env, 'SELECT COUNT(*) c FROM subscriptions WHERE expires_at > ? OR expires_at IS NULL', now)).c;
  const soon = (await first(env, 'SELECT COUNT(*) c FROM subscriptions WHERE expires_at > ? AND expires_at < ?', now, now + 3 * 86400)).c;
  const review = (await first(env, "SELECT COUNT(*) c FROM orders WHERE status = 'review'")).c;
  const paidToday = (await first(env, "SELECT COALESCE(SUM(amount_toman),0) s FROM orders WHERE status='paid' AND method != 'wallet' AND paid_at > ?", now - 86400)).s;
  const paidMonth = (await first(env, "SELECT COALESCE(SUM(amount_toman),0) s FROM orders WHERE status='paid' AND method != 'wallet' AND paid_at > ?", now - 30 * 86400)).s;
  return `👥 کاربران: ${users} (۲۴ ساعت اخیر: ${newUsers})\n✅ اشتراک فعال: ${active}\n⏳ تمام می‌شود تا ۳ روز: ${soon}\n🧾 رسید منتظر بررسی: ${review}\n💰 دریافتی ۲۴ ساعت: ${fa(paidToday)} تومان\n💰 دریافتی ۳۰ روز: ${fa(paidMonth)} تومان`;
}
