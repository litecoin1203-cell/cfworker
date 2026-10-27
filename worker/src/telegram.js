// Telegram admin bot: receipts with Approve/Reject buttons, panel diagnostics, discount codes, plans, backups.
// You run the whole shop from your Telegram chat.
import { first, run, all, insert, getSettings, setSetting, SETTING_DEFAULTS } from './db.js';
import { hashPassword, nowSec } from './util.js';

const API = (env, method) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
const fa = (n) => Number(n || 0).toLocaleString('en-US');
const GB = 1024 ** 3;

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
  await tg(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text: String(text).slice(0, 4000), reply_markup: replyMarkup, disable_web_page_preview: true });
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

const buttons = (orderId) => ({
  inline_keyboard: [[
    { text: '✅ تأیید', callback_data: `ap:${orderId}` },
    { text: '❌ رد', callback_data: `rj:${orderId}` },
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
  if (!isAdmin(env, chatId)) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'اجازه نداری' });
  const [action, idStr] = String(cq.data || '').split(':');
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
      return ack('⚠️ ' + (e instanceof BillingError ? 'ساخت اکانت روی پنل انجام نشد. پیام بعدی را ببین.' : e.message), true);
    }
    const done = `✅ تأیید و فعال شد — سفارش #${order.id} (${user.email})`;
    if (action === 'ap') await tg(env, 'editMessageCaption', { chat_id: chatId, message_id: cq.message.message_id, caption: done });
    else await tg(env, 'editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: done });
    return ack('فعال شد');
  }
  if (action === 'rj') {
    if (order.status === 'paid') return ack('پرداخت شده؛ رد نمی‌شود');
    await run(env, "UPDATE orders SET status = 'rejected', admin_note = ? WHERE id = ?", 'رسید تأیید نشد. اگر واریز کرده‌ای با پشتیبانی تماس بگیر.', orderId);
    await tg(env, 'editMessageCaption', { chat_id: chatId, message_id: cq.message.message_id, caption: `❌ رد شد — سفارش #${order.id} (${user.email})` });
    return ack('رد شد');
  }
  return ack('');
}

// ---------------- diagnostics ----------------
export async function panelReport(env) {
  const { PasarGuard, panelBases } = await import('./pasarguard.js');
  const lines = ['🔎 تست اتصال به پنل'];
  const bases = panelBases(env.PASARGUARD_URL);
  if (!bases.length) return lines.concat('❌ PASARGUARD_URL خالی است. در GitHub Secret بساز و Deploy را دوباره اجرا کن.').join('\n');
  lines.push(`آدرس واردشده: ${env.PASARGUARD_URL}`);
  lines.push(`آدرس API: ${bases[0]}${bases[1] ? ` (یا ${bases[1]})` : ''}`);
  const pg = new PasarGuard(env);
  pg._token = null;
  try {
    if (pg.apiKey) lines.push('روش ورود: API Key');
    else { await pg._login(); lines.push(`✅ ورود با یوزر «${pg.username}» موفق بود (${pg.base})`); }
  } catch (e) {
    lines.push(`❌ ورود ناموفق: ${e.message}`);
    lines.push('راه حل: آدرس پنل را فقط به شکل https://domain.com (بدون /hub و #/login) و یوزر/رمز نمایندگی را درست وارد کن.');
    return lines.join('\n');
  }
  const s = await getSettings(env);
  let groups = [];
  try {
    groups = await pg.listGroups();
    lines.push(`✅ گروه‌ها: ${groups.map((g) => `${g.id}=${g.name}`).join('، ') || 'هیچ'}`);
  } catch (e) {
    lines.push(`⚠️ خواندن گروه‌ها ممکن نشد: ${e.message}`);
  }
  lines.push(`pg_group_ids: ${s.pg_group_ids || '(خالی = همه‌ی گروه‌ها)'}`);
  const ids = (s.pg_group_ids || '').split(',').map((x) => parseInt(x, 10)).filter((n) => n > 0);
  const useIds = ids.length ? ids : groups.map((g) => g.id);
  if (!useIds.length) {
    lines.push('❌ هیچ گروهی برای ساخت اکانت نیست. شماره‌ی گروه را از پنل بردار و بزن: /set pg_group_ids 1');
    return lines.join('\n');
  }
  const name = `cgtest_${Math.floor(Math.random() * 1e6)}`;
  try {
    const u = await pg.createUser(name, { expire: nowSec() + 3600, dataLimit: 10 * 1024 * 1024, groupIds: useIds, note: 'Cloud Gold test, safe to delete' });
    lines.push(`✅ ساخت اکانت آزمایشی موفق بود (${name})`);
    if (u.subscription_url) {
      try {
        const links = await pg.subscriptionLinks(u.subscription_url);
        lines.push(links.length ? `✅ لینک ساب کار می‌کند: ${links.length} کانفیگ` : '⚠️ لینک ساب خالی است؛ در پنل برای این گروه Inbound/Host فعال کن.');
      } catch (e) { lines.push(`⚠️ خواندن لینک ساب ممکن نشد: ${e.message}`); }
    } else lines.push('⚠️ پنل لینک سابسکریپشن برنگرداند.');
    try { await pg.deleteUser(name); lines.push('🧹 اکانت آزمایشی پاک شد.'); } catch (e) { lines.push(`(اکانت ${name} را دستی از پنل پاک کن)`); }
    lines.push('\n🎉 همه‌چیز درست است؛ اپ می‌تواند اکانت بسازد.');
  } catch (e) {
    lines.push(`❌ ساخت اکانت ناموفق: ${e.message}`);
    if (e.status === 403) lines.push('راه حل: نمایندگی تو اجازه‌ی ساخت کاربر یا استفاده از این گروه را ندارد. گروه درست را با /set pg_group_ids بگذار یا از مدیر پنل دسترسی بگیر.');
    if (e.status === 400 || e.status === 422) lines.push('راه حل: معمولاً گروه اشتباه است یا سقف حجم/زمان نمایندگی پر شده. /set pg_group_ids را بررسی کن.');
  }
  return lines.join('\n');
}

export async function backupJson(env) {
  const tables = ['users', 'plans', 'subscriptions', 'orders', 'wallet_tx', 'devices', 'settings', 'coupons', 'coupon_uses'];
  const out = { created_at: new Date().toISOString(), tables: {} };
  for (const t of tables) {
    try { out.tables[t] = await all(env, `SELECT * FROM ${t}`); } catch (e) { out.tables[t] = []; }
  }
  return JSON.stringify(out);
}

export async function sendBackup(env, chatId) {
  const data = await backupJson(env);
  const day = new Date().toISOString().slice(0, 10);
  const users = (await first(env, 'SELECT COUNT(*) c FROM users')).c;
  return sendDocument(env, chatId || env.TELEGRAM_CHAT_ID, `cloudgold-backup-${day}.json`, data, `💾 پشتیبان ${day} — ${users} کاربر\nاین فایل را جایی امن نگه دار.`);
}

const HELP = `دستورهای ربات Cloud Gold:

🔎 /panel — تست کامل اتصال به پنل
📊 /stats — آمار فروش
👤 /find ایمیل — اطلاعات زنده‌ی کاربر از پنل
🎁 /grant ایمیل شماره‌پلن — دادن پلن به کاربر
🔑 /reset ایمیل رمزجدید — تغییر رمز کاربر
💾 /backup — فایل پشتیبان

📦 /plans — لیست پلن‌ها
✏️ /plan شماره فیلد مقدار — تغییر پلن
   فیلدها: name price old days gb devices trial badge sort on
   مثال: /plan 1 name یک ماهه
➕ /newplan نام|روز|گیگ|دستگاه|قیمت — پلن جدید
   مثال: /newplan سه ماهه|90|0|2|399000

🏷 /coupon کد درصد [تعداد] [روز] [شماره‌پلن] — کد تخفیف
   مثال: /coupon YALDA 20 100 7
📋 /coupons — لیست کدها    🗑 /delcoupon کد

⚙️ /settings — تنظیمات    /set کلید مقدار — تغییر
   trial_data_gb = حجم تست رایگان (0 = مثل پلن)`;

const PLAN_FIELDS = { name: 'name', price: 'price_toman', old: 'old_price_toman', days: 'duration_days', gb: 'data_limit_gb', devices: 'device_limit', trial: 'trial_days', badge: 'badge', sort: 'sort', on: 'is_active', desc: 'description' };

async function onMessage(env, msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  const say = (t, extra) => tg(env, 'sendMessage', { chat_id: chatId, text: String(t).slice(0, 4000), disable_web_page_preview: true, ...(extra || {}) });
  const cmd = text.split(/\s+/)[0].replace(/@\w+$/, '').toLowerCase();
  if (cmd === '/id' || (cmd === '/start' && !isAdmin(env, chatId))) {
    return say(`Chat id شما: ${chatId}\nاین عدد را در GitHub به اسم TELEGRAM_CHAT_ID بگذار.`);
  }
  if (!isAdmin(env, chatId)) return;

  if (cmd === '/start' || cmd === '/help') return say(HELP);

  if (cmd === '/panel') {
    await say('⏳ در حال تست پنل...');
    return say(await panelReport(env));
  }

  if (cmd === '/backup') return sendBackup(env, chatId);

  if (cmd === '/find' || cmd === '/user') {
    const email = text.split(/\s+/)[1]?.toLowerCase() || '';
    const u = await first(env, 'SELECT * FROM users WHERE email = ?', email);
    if (!u) return say('کاربری با این ایمیل نیست.');
    const { subscriptionOut } = await import('./account.js');
    const sub = await subscriptionOut(env, u);
    const sRow = await first(env, 'SELECT pg_username FROM subscriptions WHERE user_id = ?', u.id);
    const lines = [`👤 ${u.email}`, `کیف پول: ${fa(u.wallet_balance)} تومان`, `کد دعوت: ${u.referral_code}`];
    if (sub) {
      lines.push(`پلن: ${sub.plan_name || '-'} · وضعیت: ${sub.status}${sub.live ? '' : ' (پنل جواب نداد)'}`);
      lines.push(`زمان: ${sub.unlimited_time ? 'نامحدود' : `${sub.days_left} روز (تا ${sub.expires_at.slice(0, 10)})`}`);
      lines.push(`حجم: ${(sub.used_bytes / GB).toFixed(2)} از ${sub.unlimited_data ? 'نامحدود' : (sub.data_limit_bytes / GB).toFixed(1) + ' گیگ'}`);
      lines.push(`یوزر پنل: ${sRow ? sRow.pg_username : '-'}`);
    } else lines.push('اشتراک: ندارد');
    return say(lines.join('\n'));
  }
  if (cmd === '/reset') {
    const [, email, pass] = text.split(/\s+/);
    if (!email || !pass || pass.length < 8) return say('شکل درست: /reset email@example.com رمزجدید (حداقل ۸ کاراکتر)');
    const u = await first(env, 'SELECT * FROM users WHERE email = ?', email.toLowerCase());
    if (!u) return say('کاربری با این ایمیل نیست.');
    await run(env, 'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', await hashPassword(pass, env.SECRET_KEY), u.id);
    return say(`رمز ${email} عوض شد. گوشی‌های دیگر از حساب خارج شدند.`);
  }
  if (cmd === '/grant') {
    const [, email, planIdStr] = text.split(/\s+/);
    const plan = await first(env, 'SELECT * FROM plans WHERE id = ?', parseInt(planIdStr, 10));
    const u = await first(env, 'SELECT * FROM users WHERE email = ?', (email || '').toLowerCase());
    if (!u || !plan) return say('شکل درست: /grant email@example.com شماره‌پلن  (شماره‌ها در /plans)');
    const { provision } = await import('./billing.js');
    try { await provision(env, u, plan); } catch (e) { return say('⚠️ ساخت اکانت روی پنل انجام نشد:\n' + e.message + '\n\nبرای عیب‌یابی /panel را بزن.'); }
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
  if (cmd === '/set') {
    const rest = text.replace(/^\/set(@\w+)?\s*/i, '');
    const i = rest.indexOf(' ');
    const key = i < 0 ? rest : rest.slice(0, i);
    const val = i < 0 ? '' : rest.slice(i + 1).trim();
    if (!(key in SETTING_DEFAULTS)) return say(`کلید ناشناخته. کلیدها:\n${Object.keys(SETTING_DEFAULTS).join('\n')}`);
    await setSetting(env, key, val);
    return say(`✅ ${key} = ${val || '(خالی)'}`);
  }
  if (cmd === '/settings') {
    const s = await getSettings(env);
    return say(Object.entries(s).map(([k, v]) => `${k} = ${v || '—'}`).join('\n'));
  }
  if (cmd === '/stats') {
    return say(await statsText(env));
  }
}

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
