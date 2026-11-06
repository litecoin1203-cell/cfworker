// Read-only screens of the admin bot. A screen reads what it needs (a few D1 queries at most, free plan) and
// returns {text, kb}: the first line is where you are (🏠 منو › ...), the last row is back + home.
// Nothing here writes; every change goes through admin-actions.js from the router (telegram-menu.js).
import { first, all, getSettings, SETTING_DEFAULTS } from './db.js';
import { nowSec } from './util.js';
import { statsText, userInfo, HELP, STATE_FA } from './telegram.js';
import { canUndo, APP_LISTS, splitAppList, maskBridge, itemTag } from './admin-actions.js';
import { COINS, walletKey, coinById } from './coins.js';

export const fa = (n) => Number(n || 0).toLocaleString('en-US');
export const b = (text, data) => ({ text, callback_data: String(data).slice(0, 64) });
export const HOME = b('🏠 منوی اصلی', 'm:home');
// last row of a screen: back to its parent and home (one button when the parent is home)
export const nav = (back) => (back && back !== 'home' ? [b('🔙 برگشت', 'm:' + back), HOME] : [HOME]);
export const crumb = (...parts) => ['🏠 منو', ...parts].join(' › ');
const SOON = '⏳ به‌زودی — این بخش در مرحله‌های بعدی ساخته می‌شود.';

// ---------------- cursor pages ----------------
// One query per page, by id (no OFFSET, so page 50 costs what page 1 costs). cursor "b<id>" = older than id,
// "a<id>" = newer than id, empty = newest. Returns rows newest first and the cursors of the pages around it.
export async function page(env, { select = '*', from, where = '1 = 1', args = [], cursor = '', size = 8 }) {
  const c = String(cursor || '');
  const id = parseInt(c.slice(1), 10);
  if (c[0] === 'a' && id > 0) {
    const rows = (await all(env, `SELECT ${select} FROM ${from} WHERE (${where}) AND id > ? ORDER BY id ASC LIMIT ?`, ...args, id, size + 1));
    const more = rows.length > size;
    const out = rows.slice(0, size).reverse();
    return { rows: out, prev: more && out.length ? 'a' + out[0].id : null, next: out.length ? 'b' + out[out.length - 1].id : null };
  }
  const older = c[0] === 'b' && id > 0;
  const rows = await all(env, `SELECT ${select} FROM ${from} WHERE (${where})${older ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT ?`, ...args, ...(older ? [id] : []), size + 1);
  const out = rows.slice(0, size);
  return { rows: out, prev: older && out.length ? 'a' + out[0].id : null, next: rows.length > size ? 'b' + out[out.length - 1].id : null };
}
export const pageRow = (route, pg) => {
  const row = [];
  if (pg.prev) row.push(b('⬅️ جدیدتر', `m:${route}:${pg.prev}`));
  if (pg.next) row.push(b('➡️ قدیمی‌تر', `m:${route}:${pg.next}`));
  return row.length ? [row] : [];
};

// ---------------- home ----------------
export async function home(env) {
  const now = nowSec();
  const c = await first(env, `SELECT (SELECT COUNT(*) FROM users) users,
    (SELECT COUNT(*) FROM subscriptions WHERE expires_at > ?1 OR expires_at IS NULL) active,
    (SELECT COUNT(*) FROM orders WHERE status = 'review') review,
    (SELECT COUNT(*) FROM sms_log WHERE ${SMS_UNMATCHED} AND created_at > ?2) sms,
    (SELECT COUNT(*) FROM settings WHERE key LIKE 'panel_err_%' AND value != '') perr`, now, now - SMS_DAYS * 86400);
  const todo = c.review + c.sms + c.perr;
  return {
    text: `🏠 مدیریت Cloud Gold\n\n👥 کاربران: ${fa(c.users)} · ✅ اشتراک فعال: ${fa(c.active)}\n🧾 رسید منتظر بررسی: ${fa(c.review)}${todo > c.review ? ` · کار دیگر: ${fa(todo - c.review)}` : ''}\n\nیک بخش را انتخاب کن:`,
    kb: [
      [b(todo ? `📥 کارهای منتظر (${todo})` : '📥 کارهای منتظر ✅', 'm:in'), b('👤 کاربران', 'm:usr')],
      [b('📦 پلن‌ها', 'm:pl'), b('🧾 سفارش‌ها و کیف پول', 'm:or')],
      [b('🗂 پنل‌ها و سرورها', 'm:pa'), b('🏷 تخفیف و دعوت', 'm:cp')],
      [b('💳 روش‌های پرداخت', 'm:pay'), b('📱 اپ Pleat', 'm:app')],
      [b('📶 شبکه و رتبه‌بندی', 'm:net'), b('📣 پیام همگانی', 'm:bc')],
      [b('📊 آمار', 'm:st'), b('🛡 سیستم', 'm:sys')],
    ],
  };
}

// bank SMS that paid nothing (no order, two orders, or the delivery failed) in the last week
const SMS_UNMATCHED = "result IN ('no_order', 'ambiguous', 'settle_failed')";
const SMS_DAYS = 7;

export async function inbox(env) {
  const c = await first(env, `SELECT (SELECT COUNT(*) FROM orders WHERE status = 'review') review,
    (SELECT COUNT(*) FROM orders WHERE status = 'review' AND method = 'coin' AND txid IS NOT NULL) coin,
    (SELECT COUNT(*) FROM sms_log WHERE ${SMS_UNMATCHED} AND created_at > ?) sms,
    (SELECT COUNT(*) FROM settings WHERE key LIKE 'panel_err_%' AND value != '') perr`, nowSec() - SMS_DAYS * 86400);
  const any = c.review + c.sms + c.perr;
  return {
    text: [crumb('📥 کارهای منتظر'), '', `🧾 رسید منتظر بررسی: ${fa(c.review)}`, `💎 واریز ارز پیداشده (منتظر تأیید تو): ${fa(c.coin)}`,
      `📨 پیامک بانکی بی‌سفارش یا ناموفق (${SMS_DAYS} روز): ${fa(c.sms)}`, `⚠️ پنلی که ساخت اکانت را رد کرده: ${fa(c.perr)}`, '',
      any ? 'هر مورد را با دکمه‌اش باز کن.' : 'کاری منتظر تو نیست ✅'].join('\n'),
    kb: [
      ...(c.review ? [[b(`🧾 فرستادن ${fa(c.review)} رسید با دکمه`, 'm:ord'), b('📋 لیست رسیدها', 'm:or:rev')]] : []),
      ...(c.coin ? [[b(`💎 ${fa(c.coin)} واریز ارز`, 'm:or:rev:coin')]] : []),
      ...(c.sms ? [[b(`📨 ${fa(c.sms)} پیامک بی‌سفارش`, 'm:sms:un')]] : []),
      ...(c.perr ? [[b('🗂 پنل‌ها', 'm:pa')]] : []),
      nav('home')],
  };
}

// ---------------- users ----------------
const who = (u) => (u.tg_id ? (u.tg_username ? '@' + u.tg_username : 'TG ' + u.tg_id) : u.email).slice(0, 40);

const GB = 1024 ** 3;
const DELETED = /^deleted\+\d+@invalid$/;
const TG_MAIL = /@telegram\.local$/;
const ymd = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const gb = (n) => (n / GB).toFixed(n >= 10 * GB ? 1 : 2);

// list filters: what each shows (deleted accounts only under "all", marked 🗑)
export const USER_FILTERS = {
  all: { label: 'همه', where: () => '1 = 1' },
  act: { label: 'فعال', where: (now) => `is_active = 1 AND id IN (SELECT user_id FROM subscriptions WHERE state = 'active' AND (expires_at IS NULL OR expires_at > ${now}))` },
  exp: { label: 'تمام‌شده', where: (now) => `email NOT LIKE 'deleted+%' AND id IN (SELECT user_id FROM subscriptions WHERE period_id IS NOT NULL AND (state = 'stopped' OR (expires_at IS NOT NULL AND expires_at <= ${now})))` },
  none: { label: 'بی‌پلن', where: () => "email NOT LIKE 'deleted+%' AND id NOT IN (SELECT user_id FROM subscriptions WHERE period_id IS NOT NULL)" },
  blk: { label: 'مسدود', where: () => "is_active = 0 AND email NOT LIKE 'deleted+%'" },
};

// usr[:filter][:cursor] (an old "usr:b123" button is the "all" list)
export async function users(env, a0, a1) {
  const filter = USER_FILTERS[a0] ? a0 : 'all';
  const cursor = USER_FILTERS[a0] ? a1 : a0;
  const where = USER_FILTERS[filter].where(nowSec());
  const count = (await first(env, `SELECT COUNT(*) c FROM users WHERE ${where}`)).c;
  const pg = await page(env, { select: 'id, email, tg_id, tg_username, is_active', from: 'users', where, cursor });
  const tabs = Object.entries(USER_FILTERS).map(([k, f]) => b(`${k === filter ? '✅ ' : ''}${f.label}`, `m:usr:${k}`));
  const mark = (u) => (DELETED.test(u.email) ? '🗑 ' : u.is_active ? '' : '⛔️ ');
  return {
    text: `${crumb('👤 کاربران')}\n\n${fa(count)} کاربر در «${USER_FILTERS[filter].label}» · جدیدترها اول.\nبرای پیدا کردن یک نفر «جستجو» را بزن، یا ایمیل، @یوزرنیم یا آیدی را همین‌جا بفرست.`,
    kb: [tabs.slice(0, 3), tabs.slice(3), [b('🔎 جستجوی کاربر', 'm:w:find'), b('➕ کاربر دستی', 'm:f:newuser')],
      ...pg.rows.map((u) => [b(`${mark(u)}${who(u)}`, `m:u:${u.id}`)]), ...pageRow(`usr:${filter}`, pg), nav('home')],
  };
}

export const userKb = (uid) => ({ inline_keyboard: [
  [b('📅 اشتراک', `m:us:${uid}`), b('💰 کیف پول', `m:uw:${uid}`)],
  [b('📱 دستگاه‌ها', `m:udv:${uid}`), b('🛡 امنیت و حساب', `m:usec:${uid}`)],
  [b('🎁 دادن پلن', `m:ug:${uid}`), b('🔗 وصل اکانت پنل', `m:w:link:${uid}`)],
  [b('🧾 سفارش‌ها', `m:uo:${uid}`), b('📶 تجربه اتصال', `m:un:${uid}`)],
  [b('🔄 زنده از پنل', `m:u:${uid}:live`), b('📜 تاریخچه', `m:hist:user:${uid}`)],
  [b('🔙 کاربران', 'm:usr'), HOME],
] });

// One user, from the database only (a few queries); "live" first reads every panel for fresh usage.
async function userFacts(env, id) {
  return first(env, `SELECT u.*, s.state, s.stop_reason, s.expires_at, s.data_limit_bytes, s.used_bytes, s.period_id, s.plan_id, p.name plan_name,
      (SELECT COUNT(*) FROM devices WHERE user_id = u.id) devs, (SELECT COUNT(*) FROM orders WHERE user_id = u.id) ords
    FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id LEFT JOIN plans p ON p.id = s.plan_id WHERE u.id = ?`, id);
}
const STOP_FA = { quota: 'حجم تمام شد', expired: 'زمان تمام شد', admin: 'قطع به دست مدیر' };
function subLines(u, now = nowSec()) {
  if (!u.period_id) return ['📦 اشتراک: ندارد'];
  const live = u.state === 'active' && (!u.expires_at || u.expires_at > now);
  return [
    `📦 پلن: ${u.plan_name || '— (بدون پلن)'} · ${live ? '🟢 فعال' : `🔴 ${STOP_FA[u.stop_reason] || (u.expires_at && u.expires_at <= now ? 'زمان تمام شد' : 'متوقف')}`}`,
    `📅 زمان: ${u.expires_at ? (u.expires_at > now ? `${Math.ceil((u.expires_at - now) / 86400)} روز (تا ${ymd(u.expires_at)})` : `تمام شده (${ymd(u.expires_at)})`) : 'نامحدود'}`,
    `📊 حجم: ${gb(u.used_bytes || 0)} از ${u.data_limit_bytes ? gb(u.data_limit_bytes) + ' گیگ' : 'نامحدود'}`,
  ];
}
const accountLine = (u) => (DELETED.test(u.email) ? '🗑 حذف‌شده' : u.is_active ? '✅ فعال' : '⛔️ مسدود');

export async function userCard(env, id, mode) {
  if (mode === 'live') { try { const { refreshUser } = await import('./sync.js'); await refreshUser(env, id); } catch (e) { /* show what is stored */ } }
  const u = await userFacts(env, id);
  if (!u) return { text: crumb('👤 کاربران') + '\n\nکاربر پیدا نشد.', kb: [nav('usr')] };
  const pas = await all(env, 'SELECT a.desired, p.label FROM panel_accounts a JOIN panels p ON p.id = a.panel_id WHERE a.user_id = ? ORDER BY a.panel_id', u.id);
  const { userNetLine } = await import('./netstats.js');
  const nets = await userNetLine(env, u.id);
  const lines = [crumb('👤 کاربران', who(u)), '',
    `👤 ${TG_MAIL.test(u.email) ? 'ایمیل: ندارد (فقط تلگرام)' : u.email} · #${u.id}`,
    ...(u.tg_id ? [`📨 تلگرام: ${u.tg_username ? '@' + u.tg_username : '(بدون یوزرنیم)'} · آیدی ${u.tg_id}${u.tg_name ? ` · ${u.tg_name}` : ''}`] : []),
    `حساب: ${accountLine(u)}`, '',
    ...subLines(u),
    `💰 کیف پول: ${fa(u.wallet_balance)} تومان`,
    `📱 دستگاه: ${fa(u.devs)} · 🧾 سفارش: ${fa(u.ords)}`,
    `🗂 پنل‌ها: ${pas.map((a) => `${a.label}${a.desired === 'active' ? '' : ' (خاموش)'}`).join('، ') || '—'}`,
    `📶 اپراتورها: ${nets || 'هنوز گزارشی نیامده'}`,
    ...(mode === 'live' ? [] : ['', 'عددها از آخرین خواندن پنل‌هاست؛ برای عدد همین لحظه «🔄 زنده از پنل» را بزن.'])];
  return { text: lines.join('\n'), kb: userKb(u.id).inline_keyboard };
}

const missing = (title) => ({ text: crumb('👤 کاربران', title) + '\n\nکاربر پیدا نشد.', kb: [nav('usr')] });

// 📅 subscription: days, data, reset, pause, end, plan name
export async function userSub(env, id) {
  const u = await userFacts(env, id);
  if (!u) return missing('📅 اشتراک');
  const base = [crumb('👤 کاربران', who(u), '📅 اشتراک'), ''];
  if (!u.period_id) {
    return { text: [...base, 'این کاربر اشتراک ندارد. یک پلن بده یا اکانتی که روی پنل دارد را وصل کن.'].join('\n'),
      kb: [[b('🎁 دادن پلن', `m:ug:${id}`), b('🔗 وصل اکانت پنل', `m:w:link:${id}`)], nav(`u:${id}`)] };
  }
  const paused = u.state === 'stopped' && u.stop_reason === 'admin';
  return {
    text: [...base, ...subLines(u), '',
      'روز و حجم روی همه‌ی پنل‌ها با هم عوض می‌شود. «ریست مصرف» مصرف این دوره را صفر می‌کند. «تغییر نام پلن» فقط اسمی را که اپ نشان می‌دهد عوض می‌کند.'].join('\n'),
    kb: [
      ...(u.expires_at ? [[b('➕ 7 روز', `m:ud:${id}:7`), b('➕ 30 روز', `m:ud:${id}:30`), b('➕ 90 روز', `m:ud:${id}:90`), b('➕ دلخواه', `m:f:adddays:${id}`)]] : []),
      ...(u.data_limit_bytes ? [[b('➕ 5 گیگ', `m:ugb:${id}:5`), b('➕ 10 گیگ', `m:ugb:${id}:10`), b('➕ 50 گیگ', `m:ugb:${id}:50`), b('➕ دلخواه', `m:f:addgb:${id}`)]] : []),
      [b('🔄 ریست مصرف', `m:urs:${id}`), paused ? b('▶️ وصل دوباره', `m:upz:${id}:0`) : b('⏸ قطع موقت', `m:upz:${id}:1`)],
      [b('📦 تغییر نام پلن', `m:upl:${id}`), b('🎁 تمدید با پلن', `m:ug:${id}`)],
      [b('⏹ پایان اشتراک', `m:uend:${id}`)],
      nav(`u:${id}`),
    ],
  };
}

export async function userPlanPick(env, id) {
  const u = await first(env, 'SELECT id, email, tg_id, tg_username FROM users WHERE id = ?', id);
  if (!u) return missing('📦 پلن');
  const rows = await all(env, 'SELECT id, name, duration_days, data_limit_gb FROM plans WHERE archived = 0 ORDER BY sort, id LIMIT 12');
  return {
    text: `${crumb('👤 کاربران', who(u), '📦 نام پلن')}\n\nاپ این کاربر کدام پلن را نشان دهد؟ حجم و زمانش عوض نمی‌شود.`,
    kb: [...rows.map((p) => [b(`${p.name} (${p.duration_days} روز، ${p.data_limit_gb || 'نامحدود'} گیگ)`.slice(0, 60), `m:upn:${id}:${p.id}`)]),
      [b('— بدون پلن —', `m:upn:${id}:0`)], nav(`us:${id}`)],
  };
}

const TX_FA = { admin_credit: 'شارژ مدیر', admin_debit: 'کسر مدیر', referral: 'پاداش دعوت', topup: 'شارژ', purchase: 'خرید', refund: 'بازگشت', admin_refund: 'بازگشت وجه سفارش' };
// 💰 wallet: balance, credit / debit, history (8 per page)
export async function userWallet(env, id, cursor) {
  const u = await first(env, 'SELECT id, email, tg_id, tg_username, wallet_balance FROM users WHERE id = ?', id);
  if (!u) return missing('💰 کیف پول');
  const pg = await page(env, { from: 'wallet_tx', where: 'user_id = ?', args: [id], cursor });
  const lines = pg.rows.map((t) => `${ymd(t.created_at)} · ${t.amount > 0 ? '+' : ''}${fa(t.amount)} · ${TX_FA[t.reason] || t.reason}${t.note ? ` · ${String(t.note).slice(0, 40)}` : ''}`);
  return {
    text: [crumb('👤 کاربران', who(u), '💰 کیف پول'), '', `موجودی: ${fa(u.wallet_balance)} تومان`, '', ...(lines.length ? lines : ['تراکنشی نیست.'])].join('\n'),
    kb: [[b('➕ شارژ', `m:f:wadd:${id}`), b('➖ کسر', `m:f:wsub:${id}`)], ...pageRow(`uw:${id}`, pg), nav(`u:${id}`)],
  };
}

// 📱 devices
export async function userDevices(env, id) {
  const u = await first(env, 'SELECT id, email, tg_id, tg_username FROM users WHERE id = ?', id);
  if (!u) return missing('📱 دستگاه‌ها');
  const rows = await all(env, 'SELECT id, device_id, model, last_seen FROM devices WHERE user_id = ? ORDER BY last_seen DESC LIMIT 10', id);
  return {
    text: [crumb('👤 کاربران', who(u), '📱 دستگاه‌ها'), '', rows.length ? 'روی 🗑 بزن تا دستگاه حذف شود (دفعه‌ی بعد که وصل شود دوباره ثبت می‌شود).' : 'دستگاهی ثبت نشده.'].join('\n'),
    kb: [...rows.map((d) => [b(`🗑 ${String(d.model || d.device_id).slice(0, 28)} · ${ymd(d.last_seen)}`, `m:udd:${id}:${d.id}`)]), nav(`u:${id}`)],
  };
}

// 🛡 security and account
export async function userSecurity(env, id) {
  const u = await first(env, 'SELECT * FROM users WHERE id = ?', id);
  if (!u) return missing('🛡 امنیت');
  const deleted = DELETED.test(u.email);
  const rows = deleted ? [] : [
    [b('🔑 تغییر رمز', `m:w:reset:${id}`), b('🚪 خروج از همه‌ی دستگاه‌ها', `m:ulo:${id}`)],
    [u.is_active ? b('⛔️ مسدود کن', `m:ublk:${id}:1`) : b('✅ آزاد کن', `m:ublk:${id}:0`), b('✏️ تغییر ایمیل', `m:f:email:${id}`)],
    [...(u.avatar ? [b('🖼 برگرداندن آواتار', `m:uav:${id}`)] : []), ...(u.tg_id ? [b('📨 جداکردن تلگرام', `m:utg:${id}`)] : [])],
    [b('🗑 حذف کاربر', `m:udel:${id}`)],
  ].filter((r) => r.length);
  return {
    text: [crumb('👤 کاربران', who(u), '🛡 امنیت و حساب'), '', `حساب: ${accountLine(u)}`, `آواتار: ${u.avatar || 'پیش‌فرض / عکس تلگرام'}`,
      `ورود: ${TG_MAIL.test(u.email) ? 'فقط با تلگرام' : 'ایمیل + رمز'}${u.tg_id && !TG_MAIL.test(u.email) ? ' و تلگرام' : ''}`, '',
      'مسدود = نمی‌تواند وارد شود و همه‌ی پنل‌هایش خاموش می‌شود. حذف = مسدود + آزاد شدن ایمیل و تلگرام؛ سفارش‌ها و کیف پول برای حساب‌رسی می‌ماند.'].join('\n'),
    kb: [...rows, nav(`u:${id}`)],
  };
}

const ORDER_FA = { pending: '⏳ منتظر پرداخت', review: '🧾 منتظر بررسی', paid: '✅ پرداخت‌شده', rejected: '❌ رد شده', expired: '⌛️ منقضی', settling: '⚙️ در حال فعال‌سازی', cancelled: '🚫 لغو' };
// 🧾 one user's orders
export async function userOrders(env, id, cursor) {
  const u = await first(env, 'SELECT id, email, tg_id, tg_username FROM users WHERE id = ?', id);
  if (!u) return missing('🧾 سفارش‌ها');
  const pg = await page(env, { select: 'id, amount_toman, status, method, created_at', from: 'orders', where: 'user_id = ?', args: [id], cursor });
  return {
    text: [crumb('👤 کاربران', who(u), '🧾 سفارش‌ها'), '', pg.rows.length ? 'روی هر سفارش بزن تا جزئیاتش را ببینی.' : 'سفارشی نیست.'].join('\n'),
    kb: [...pg.rows.map((o) => [b(`#${o.id} · ${fa(o.amount_toman)} ت · ${ORDER_FA[o.status] || o.status} · ${ymd(o.created_at)}`, `m:o:${o.id}`)]), ...pageRow(`uo:${id}`, pg), nav(`u:${id}`)],
  };
}

// ---------------- orders (stage 3) ----------------
export const ORDER_ST = {
  rev: { label: 'بررسی', where: "status = 'review'" },
  pend: { label: 'منتظر پرداخت', where: "status = 'pending'" },
  paid: { label: 'پرداخت‌شده', where: "status = 'paid'" },
  rej: { label: 'رد شده', where: "status = 'rejected'" },
  all: { label: 'همه', where: '1 = 1' },
};
export const ORDER_MT = { all: 'همه', card: 'کارت', coin: 'ارز', wallet: 'کیف پول', crypto: 'درگاه' };
const METHOD_FA = { card: '💳 کارت‌به‌کارت', coin: '💎 ارز دیجیتال', wallet: '👛 کیف پول', crypto: '🌐 درگاه ارزی' };

// or[:status][:method][:cursor]
export async function orders(env, a0, a1, a2) {
  const st = ORDER_ST[a0] ? a0 : 'rev';
  const mt = ORDER_MT[a1] ? a1 : 'all';
  const cursor = ORDER_ST[a0] ? (ORDER_MT[a1] ? a2 : a1) : a0;
  const where = ORDER_ST[st].where + (mt === 'all' ? '' : ' AND method = ?');
  const args = mt === 'all' ? [] : [mt];
  const c = await first(env, `SELECT COUNT(*) n, COALESCE(SUM(amount_toman), 0) sum FROM orders WHERE ${where}`, ...args);
  const pg = await page(env, { select: 'id, amount_toman, status, method, created_at, kind', from: 'orders', where, args, cursor });
  const sTabs = Object.entries(ORDER_ST).map(([k, f]) => b(`${k === st ? '✅ ' : ''}${f.label}`, `m:or:${k}:${mt}`));
  const mTabs = Object.entries(ORDER_MT).map(([k, l]) => b(`${k === mt ? '✅ ' : ''}${l}`, `m:or:${st}:${k}`));
  return {
    text: [crumb('🧾 سفارش‌ها و کیف پول'), '', `«${ORDER_ST[st].label}» · روش: ${ORDER_MT[mt]}`, `${fa(c.n)} سفارش · جمع ${fa(c.sum)} تومان`, '',
      pg.rows.length ? 'روی هر سفارش بزن تا ببینی، تأیید یا رد کنی. برای پیدا کردن با شماره یا کد پیگیری «🔎 جستجو» را بزن.' : 'سفارشی در این فیلتر نیست.'].join('\n'),
    kb: [sTabs.slice(0, 3), sTabs.slice(3), mTabs, [b('🔎 جستجوی سفارش', 'm:w:ofind')],
      ...pg.rows.map((o) => [b(`#${o.id} · ${fa(o.amount_toman)} ت · ${ORDER_FA[o.status] || o.status} · ${ymd(o.created_at)}`, `m:o:${o.id}`)]),
      ...pageRow(`or:${st}:${mt}`, pg), nav('home')],
  };
}

// what the 🔎 question finds: #id or a number = the order id, anything else = its exact receipt/transfer code
export async function orderSearch(env, raw) {
  const q = String(raw || '').trim().slice(0, 120);
  const id = /^#?\d{1,12}$/.test(q) ? parseInt(q.replace('#', ''), 10) : 0;
  const rows = q ? await all(env, `SELECT id, amount_toman, status, created_at FROM orders WHERE id = ? OR receipt_ref = ? OR txid = ? ORDER BY id DESC LIMIT 8`, id, q, q) : [];
  if (rows.length === 1) return order(env, rows[0].id);
  return {
    text: [crumb('🧾 سفارش‌ها', '🔎 جستجو'), '', rows.length ? `${rows.length} سفارش پیدا شد:` : 'سفارشی با این شماره یا کد پیگیری پیدا نشد.'].join('\n'),
    kb: [...rows.map((o) => [b(`#${o.id} · ${fa(o.amount_toman)} ت · ${ORDER_FA[o.status] || o.status} · ${ymd(o.created_at)}`, `m:o:${o.id}`)]),
      [b('🔎 جستجوی دوباره', 'm:w:ofind')], nav('or')],
  };
}

export const ORDER_OPEN = ['pending', 'review', 'expired', 'rejected'];
export async function order(env, id) {
  const o = await first(env, `SELECT o.*, u.email, u.tg_id, u.tg_username, p.name plan_name, c.code coupon_code,
      (SELECT COUNT(*) FROM wallet_tx WHERE order_id = o.id AND reason = 'admin_refund') refunded
    FROM orders o JOIN users u ON u.id = o.user_id LEFT JOIN plans p ON p.id = COALESCE(o.plan_id, o.activate_plan_id)
    LEFT JOIN coupons c ON c.id = o.coupon_id WHERE o.id = ?`, id);
  if (!o) return { text: crumb('🧾 سفارش') + '\n\nسفارش پیدا نشد.', kb: [nav('or')] };
  const what = o.kind === 'plan' ? `پلن ${o.plan_name || ''}` : o.activate_plan_id ? `شارژ + فعال‌سازی ${o.plan_name || ''}` : 'شارژ کیف پول';
  const open = ORDER_OPEN.includes(o.status);
  const canRefund = o.status === 'paid' && o.kind !== 'topup' && o.amount_toman > 0 && !o.refunded;
  const acts = [
    ...(open ? [b('✅ تأیید و فعال‌سازی', `m:oap:${o.id}`)] : []),
    ...(['pending', 'review', 'expired'].includes(o.status) ? [b('❌ رد', `m:orj:${o.id}`)] : []),
    ...(open ? [b('🚫 لغو', `m:ocx:${o.id}`)] : []),
  ];
  return {
    text: [crumb('🧾 سفارش‌ها', `#${o.id}`), '', `🧾 سفارش #${o.id} — ${what}`, `👤 ${who(o)}`,
      `مبلغ: ${fa(o.amount_toman)} تومان${o.list_price_toman && o.list_price_toman !== o.amount_toman ? ` (قیمت اصلی ${fa(o.list_price_toman)})` : ''}${o.coin_amount ? ` (${o.coin_amount} ${String(o.coin || '').toUpperCase()})` : ''}`,
      `روش: ${METHOD_FA[o.method] || o.method || '-'} · وضعیت: ${ORDER_FA[o.status] || o.status}`,
      ...(o.coupon_code ? [`🏷 کد تخفیف: ${o.coupon_code}`] : []),
      `ثبت: ${ymd(o.created_at)}${o.paid_at ? ` · پرداخت: ${ymd(o.paid_at)}` : ''}`, `شماره پیگیری: ${o.receipt_ref || o.txid || '-'}`,
      ...(o.admin_note ? [`📝 یادداشت برای کاربر: ${String(o.admin_note).slice(0, 120)}`] : []),
      ...(o.refunded ? ['↩️ مبلغش به کیف پول برگشت داده شده.'] : [])].join('\n'),
    kb: [
      ...(acts.length ? [acts] : []),
      ...(canRefund ? [[b('↩️ بازگشت پول به کیف پول', `m:orf:${o.id}`)]] : []),
      ...(o.receipt_file_id ? [[b('🖼 عکس رسید', `m:orc:${o.id}`)]] : []),
      [b('👤 کارت کاربر', `m:u:${o.user_id}`), b('🧾 سفارش‌های کاربر', `m:uo:${o.user_id}`), b('📜 تاریخچه', `m:hist:order:${o.id}`)],
      nav('or'),
    ],
  };
}

// who connects through which operator: the overview (no id) or one user's networks and servers
export async function userNets(env, id) {
  const ns = await import('./netstats.js');
  if (!id) {
    const { text, recent } = await ns.networkUsers(env);
    return { text: `${crumb('📶 شبکه', '👥 کاربران و اپراتورها')}\n\n${text}`,
      kb: [...recent.map((u) => [b((u.tg_username ? '@' + u.tg_username : u.email).slice(0, 40), `m:un:${u.id}`)]), [b('🔄 به‌روزرسانی', 'm:un')], nav('net')] };
  }
  const u = await first(env, 'SELECT id, email, tg_username FROM users WHERE id = ?', id);
  if (!u) return { text: crumb('📶 شبکه') + '\n\nکاربر پیدا نشد.', kb: [nav('un')] };
  return { text: `${crumb('👤 کاربران', who(u), '📶 تجربه اتصال')}\n\n${await ns.userNetText(env, u)}`,
    kb: [[b('🔄 به‌روزرسانی', `m:un:${u.id}`), b('👤 کارت کاربر', `m:u:${u.id}`)], [b('🔙 همه‌ی کاربران', 'm:un'), HOME]] };
}

// ---------------- plans ----------------
// the app shows plans in this order (sort, then id); archived plans are out of the app and of every list
export async function plans(env) {
  const rows = await all(env, 'SELECT id, name, price_toman, is_active, archived FROM plans ORDER BY sort, id');
  const live = rows.filter((p) => !p.archived);
  const arch = rows.length - live.length;
  return {
    text: `${crumb('📦 پلن‌ها')}\n\nبه همین ترتیب در اپ دیده می‌شوند. روی هر پلن بزن تا قیمت، روز، حجم، ترتیب و بقیه را عوض کنی.\n🟢 = در اپ دیده می‌شود · 🔴 = خاموش`,
    kb: [...live.map((p) => [b(`${p.is_active ? '🟢' : '🔴'} #${p.id} ${p.name} — ${fa(p.price_toman)} ت`, `m:p:${p.id}`)]),
      [b('➕ پلن جدید', 'm:f:newplan'), ...(arch ? [b(`🗄 بایگانی (${fa(arch)})`, 'm:pla')] : [])], nav('home')],
  };
}

export async function plansArchived(env) {
  const rows = await all(env, 'SELECT id, name, price_toman FROM plans WHERE archived = 1 ORDER BY id DESC LIMIT 30');
  return {
    text: `${crumb('📦 پلن‌ها', '🗄 بایگانی')}\n\nپلن‌هایی که حذف شدند ولی سفارش یا اشتراک داشتند. در اپ دیده نمی‌شوند؛ اسمشان در تاریخچه می‌ماند.`,
    kb: [...rows.map((p) => [b(`🗄 #${p.id} ${p.name} — ${fa(p.price_toman)} ت`, `m:p:${p.id}`)]), nav('pl')],
  };
}

export async function plan(env, id, extraRows = []) {
  const p = await first(env, `SELECT p.*, (SELECT COUNT(*) FROM orders WHERE status = 'paid' AND (plan_id = p.id OR activate_plan_id = p.id)) sold,
      (SELECT COALESCE(SUM(amount_toman), 0) FROM orders WHERE status = 'paid' AND kind = 'plan' AND plan_id = p.id) income,
      (SELECT COUNT(*) FROM plans q WHERE q.archived = 0 AND (q.sort < p.sort OR (q.sort = p.sort AND q.id < p.id))) pos,
      (SELECT COUNT(*) FROM plans WHERE archived = 0) total
    FROM plans p WHERE p.id = ?`, id);
  if (!p) return { text: crumb('📦 پلن‌ها') + '\n\nپلن پیدا نشد.', kb: [nav('pl')] };
  const f = (field, label) => b(label, `m:w:plan:${p.id}:${field}`);
  return {
    text: [crumb('📦 پلن‌ها', `#${p.id}`), '', `📦 پلن #${p.id} — ${p.name}`, '',
      `💰 قیمت: ${fa(p.price_toman)} تومان${p.old_price_toman ? ` (قبلی: ${fa(p.old_price_toman)})` : ''}`,
      `📅 مدت: ${p.duration_days} روز`, `📦 حجم: ${p.data_limit_gb || 'نامحدود'} گیگ`, `📱 دستگاه: ${p.device_limit || 'نامحدود'}`,
      `🎁 تست رایگان: ${p.trial_days ? p.trial_days + ' روز' : 'ندارد'}`, `⭐ نشان: ${p.badge || '—'}`,
      `📝 توضیح: ${p.description ? String(p.description).slice(0, 200) : '—'}`,
      `🛒 فروش: ${fa(p.sold)} بار · ${fa(p.income)} تومان`,
      `وضعیت: ${p.archived ? '🗄 بایگانی (در اپ نیست)' : p.is_active ? `🟢 روشن (در اپ دیده می‌شود) · جایگاه ${fa(p.pos + 1)} از ${fa(p.total)}` : '🔴 خاموش'}`].join('\n'),
    kb: [
      ...extraRows,
      [f('price', '💰 قیمت'), f('old', '🏷 قیمت قبلی')],
      [f('days', '📅 روز'), f('gb', '📦 حجم')],
      [f('devices', '📱 دستگاه'), f('trial', '🎁 تست')],
      [f('name', '✏️ نام'), f('badge', '⭐ نشان'), f('desc', '📝 توضیح')],
      ...(p.archived ? [] : [[b('⬆️ بالاتر', `m:pmv:${p.id}:u`), b('⬇️ پایین‌تر', `m:pmv:${p.id}:d`)]]),
      p.archived ? [b('📤 برگرداندن از بایگانی', `m:pua:${p.id}`), b('📋 کپی', `m:pcp:${p.id}`)]
        : [b(p.is_active ? '🔴 خاموش کن' : '🟢 روشن کن', `m:pt:${p.id}`), b('📋 کپی', `m:pcp:${p.id}`), b('🗑 حذف', `m:pdl:${p.id}`)],
      [b('📜 تاریخچه', `m:hist:plan:${p.id}`)],
      nav(p.archived ? 'pla' : 'pl'),
    ],
  };
}

// ---------------- panels ----------------
export async function panels(env) {
  const { listPanels } = await import('./panels.js');
  const rows = await listPanels(env);
  return {
    text: `${crumb('🗂 پنل‌ها و سرورها')}\n\nروی هر پنل بزن تا تست، ورود تدریجی یا خارج‌کردن را انجام دهی.`,
    kb: [...rows.map((p) => [b(`#${p.id} ${p.label} — ${STATE_FA[p.state] || p.state}${p.state === 'rollout' ? ` ${p.rollout_percent}%` : ''}`, `m:pp:${p.id}`)]),
      [b('🔎 تست سلامت همه', 'm:x:pa|/panel'), b('➕ افزودن پنل', 'm:w:addpanel')], nav('home')],
  };
}

export async function panel(env, id, extraRows = []) {
  const { getPanel } = await import('./panels.js');
  const p = await getPanel(env, id);
  if (!p) return { text: crumb('🗂 پنل‌ها') + '\n\nپنل پیدا نشد.', kb: [nav('pa')] };
  const n = (await first(env, "SELECT COUNT(*) c FROM panel_accounts WHERE panel_id = ? AND desired = 'active'", p.id)).c;
  let t = null;
  try { t = JSON.parse((await first(env, 'SELECT value FROM settings WHERE key = ?', `panel_test_${p.id}`))?.value || 'null'); } catch (e) { t = null; }
  const back = `pp:${p.id}`;
  const x = (label, cmd) => b(label, `m:x:${back}|${cmd}`);
  const kinds = t && t.kinds ? Object.entries(t.kinds).map(([k, c]) => `${k} ×${fa(c)}`).join('، ') : '';
  const testLines = t ? [`🧪 آخرین تست: ${when(t.at)} · ${t.healthy ? '✅ سالم' : '❌ ناموفق'} · ${fa(t.configs)} کانفیگ`,
    ...(kinds ? [`نوع کانفیگ‌ها: ${kinds}${t.unusable ? ` (${fa(t.unusable)} تا در اپ کار نمی‌کند)` : ''}`] : []),
    ...(t.error ? [`خطا: ${t.error}`] : [])] : ['🧪 هنوز با ربات تست نشده.'];
  return {
    text: [crumb('🗂 پنل‌ها', `#${p.id}`), '', `🗂 پنل #${p.id} — ${p.label} (${p.kind})`, '',
      `وضعیت: ${STATE_FA[p.state] || p.state}${p.state === 'rollout' ? ` ${p.rollout_percent}%` : ''}`,
      `سلامت: ${p.health} · ${n} کاربر فعال${p.version ? ` · نسخه ${p.version}` : ''}`, ...testLines, '',
      'ورود تدریجی = چند درصد کاربران روی این پنل هم اکانت بگیرند.'].join('\n'),
    kb: [
      ...extraRows,
      [b('🖥 سرورها', `m:srvs:${p.id}`), b('✏️ تغییر نام', `m:f:pnm:${p.id}`)],
      ...(p.state === 'disabled' ? [[b('🔄 فعال‌سازی دوباره (برگشت به تست)', `m:pen:${p.id}`)]] : []),
      [x('🧪 تست پنل', `/paneltest ${p.id}`), b('👥 گروه‌ها / سرویس', `m:w:groups:${p.id}`)],
      [x('10%', `/rollout ${p.id} 10`), x('25%', `/rollout ${p.id} 25`), x('50%', `/rollout ${p.id} 50`), x('100%', `/rollout ${p.id} 100`)],
      [b('🔐 ورود پنل (آدرس، یوزر، رمز)', `m:w:panelcred:${p.id}`)],
      [x('🚪 خارج‌کردن پنل', `/drainpanel ${p.id}`), b('📜 تاریخچه', `m:hist:panel:${p.id}`)],
      nav('pa'),
    ],
  };
}

// ---------------- coupons and referral ----------------
const couponLine = (c) => `${c.is_active ? '🟢' : '⏸'} ${c.code} — ${c.percent}٪ · ${fa(c.used)}${c.max_uses ? '/' + fa(c.max_uses) : ''} بار`;
// cp[:cursor]
export async function coupons(env, cursor) {
  const c = await first(env, 'SELECT COUNT(*) n, COALESCE(SUM(is_active), 0) on_ FROM coupons');
  const pg = await page(env, { select: 'id, code, percent, used, max_uses, is_active', from: 'coupons', cursor });
  return {
    text: `${crumb('🏷 تخفیف و دعوت')}\n\n${fa(c.n)} کد (${fa(c.on_)} فعال) · 🟢 فعال · ⏸ متوقف\nروی هر کد بزن تا درصد، تعداد، مهلت و پلنش را عوض کنی یا متوقفش کنی.`,
    kb: [...pg.rows.map((x) => [b(couponLine(x).slice(0, 60), `m:c:${x.id}`)]), ...pageRow('cp', pg),
      [b('➕ کد جدید', 'm:f:coupon'), b('🎁 دعوت و پاداش', 'm:ref')], nav('home')],
  };
}

export async function coupon(env, id) {
  const c = await first(env, `SELECT c.*, p.name plan_name, (SELECT COUNT(*) FROM orders WHERE coupon_id = c.id AND status = 'paid') paid
    FROM coupons c LEFT JOIN plans p ON p.id = c.plan_id WHERE c.id = ?`, id);
  if (!c) return { text: crumb('🏷 تخفیف و دعوت') + '\n\nاین کد پیدا نشد.', kb: [nav('cp')] };
  const now = nowSec();
  const set = (f, label, v) => b(label, `m:cs:${c.id}:${f}:${v}`);
  return {
    text: [crumb('🏷 تخفیف و دعوت', c.code), '', `🏷 کد ${c.code}`, '',
      `٪ تخفیف: ${c.percent}٪`, `🔢 استفاده: ${fa(c.used)} از ${c.max_uses ? fa(c.max_uses) : 'نامحدود'}`,
      `⏳ مهلت: ${c.expires_at ? (c.expires_at > now ? `تا ${ymd(c.expires_at)}` : `تمام شده (${ymd(c.expires_at)})`) : 'همیشه'}`,
      `📦 پلن: ${c.plan_id ? (c.plan_name || `#${c.plan_id}`) : 'همه‌ی پلن‌ها'}`, `🛒 سفارش پرداخت‌شده با این کد: ${fa(c.paid)}`,
      `وضعیت: ${c.is_active ? '🟢 فعال' : '⏸ متوقف (در اپ قبول نمی‌شود)'}`, '',
      'ردیف اول درصد، دوم تعداد، سوم مهلت (از امروز).'].join('\n'),
    kb: [
      [set('p', '10٪', 10), set('p', '20٪', 20), set('p', '30٪', 30), set('p', '50٪', 50), b('✏️', `m:f:cpct:${c.id}`)],
      [set('u', '∞ بار', 0), set('u', '10 بار', 10), set('u', '100 بار', 100), b('✏️', `m:f:cuses:${c.id}`)],
      [set('d', '♾ همیشه', 0), set('d', '7 روز', 7), set('d', '30 روز', 30), b('✏️', `m:f:cdays:${c.id}`)],
      [b('📦 پلن', `m:cpl:${c.id}`), b(`👥 استفاده‌ها (${fa(c.used)})`, `m:cu:${c.id}`)],
      [b(c.is_active ? '⏸ توقف' : '▶️ فعال کن', `m:ct:${c.id}`), ...(c.code.length <= 50 ? [b('🗑 حذف', `m:cd:${c.code}`)] : []),
        ...(c.code.length <= 40 ? [b('📜 تاریخچه', `m:hist:coupon:${c.code}`)] : [])],
      nav('cp'),
    ],
  };
}

export async function couponPlanPick(env, id) {
  const c = await first(env, 'SELECT id, code, plan_id FROM coupons WHERE id = ?', id);
  if (!c) return { text: crumb('🏷 تخفیف و دعوت') + '\n\nاین کد پیدا نشد.', kb: [nav('cp')] };
  const rows = await all(env, 'SELECT id, name FROM plans WHERE archived = 0 ORDER BY sort, id LIMIT 12');
  return {
    text: `${crumb('🏷 تخفیف و دعوت', c.code, '📦 پلن')}\n\nکد ${c.code} برای کدام پلن قبول شود؟`,
    kb: [[b(`${c.plan_id ? '' : '✅ '}همه‌ی پلن‌ها`, `m:cs:${c.id}:l:0`)],
      ...rows.map((p) => [b(`${p.id === c.plan_id ? '✅ ' : ''}${p.name}`.slice(0, 60), `m:cs:${c.id}:l:${p.id}`)]), nav(`c:${c.id}`)],
  };
}

// cu:<couponId>[:cursor] — who used it (a use is written when the order is paid)
export async function couponUses(env, id, cursor) {
  const c = await first(env, 'SELECT id, code FROM coupons WHERE id = ?', id);
  if (!c) return { text: crumb('🏷 تخفیف و دعوت') + '\n\nاین کد پیدا نشد.', kb: [nav('cp')] };
  const pg = await page(env, { select: 'id, user_id, order_id, created_at, (SELECT email FROM users WHERE users.id = coupon_uses.user_id) email',
    from: 'coupon_uses', where: 'coupon_id = ?', args: [c.id], cursor });
  return {
    text: `${crumb('🏷 تخفیف و دعوت', c.code, '👥 استفاده‌ها')}\n\n${pg.rows.length ? 'روی هر نفر بزن تا کارتش باز شود.' : 'هنوز کسی با این کد خرید نکرده.'}`,
    kb: [...pg.rows.map((r) => [b(`${ymd(r.created_at)} · ${String(r.email || '#' + r.user_id).slice(0, 34)}${r.order_id ? ` · #${r.order_id}` : ''}`, `m:u:${r.user_id}`)]),
      ...pageRow(`cu:${c.id}`, pg), nav(`c:${c.id}`)],
  };
}

export const REF_CHOICES = ['0', '5', '10', '15', '20'];
export async function referral(env) {
  const s = await getSettings(env);
  const top = await all(env, `SELECT r.referred_by_id id, COUNT(*) n, u.email, u.tg_username,
      (SELECT COALESCE(SUM(amount), 0) FROM wallet_tx WHERE user_id = r.referred_by_id AND reason = 'referral') earned
    FROM users r JOIN users u ON u.id = r.referred_by_id WHERE r.referred_by_id IS NOT NULL GROUP BY r.referred_by_id ORDER BY n DESC LIMIT 5`);
  const pct = String(s.referral_percent || '0');
  return {
    text: [crumb('🏷 تخفیف و دعوت', '🎁 دعوت و پاداش'), '',
      pct === '0' ? '🎁 پاداش دعوت: خاموش' : `🎁 پاداش دعوت: ${pct}٪ از هر خرید دوستِ دعوت‌شده به کیف پول دعوت‌کننده`, '',
      top.length ? '🏆 بیشترین دعوت:' : 'هنوز کسی دعوت نکرده.',
      ...top.map((t, i) => `${i + 1}. ${t.tg_username ? '@' + t.tg_username : t.email} — ${fa(t.n)} نفر · ${fa(t.earned)} تومان پاداش`)].join('\n'),
    kb: [REF_CHOICES.map((v) => b(`${v === pct ? '✅ ' : ''}${v}٪`, `m:ss:referral_percent:${v}`)),
      [b('✏️ درصد دلخواه', 'm:w:set:referral_percent'), b('📜 تاریخچه', 'm:hist:setting:referral_percent')],
      ...top.map((t) => [b(`👤 ${(t.tg_username ? '@' + t.tg_username : t.email).slice(0, 40)}`, `m:u:${t.id}`)]), nav('cp')],
  };
}

// ---------------- payments + settings ----------------
export const AUTO_FA = { auto: 'خودکار', detect: 'فقط خبر بده', off: 'خاموش' };

// the SMS address is a secret: only its first characters are ever shown (the setup command gives it in full)
export const maskKey = (k) => (k ? `${String(k).slice(0, 4)}••••` : '');

export async function payments(env) {
  const s = await getSettings(env);
  const card = String(s.card_number || '');
  const mode = (key) => ['auto', 'detect', 'off'].map((v) => b(`${s[key] === v ? '✅ ' : ''}${AUTO_FA[v]}`, `m:sv:${key}:${v}`));
  const coins = COINS.filter((c) => s[walletKey(c)]).length;
  const senders = String(s.sms_senders || '').split(',').filter(Boolean).length;
  return {
    text: [crumb('💳 روش‌های پرداخت'), '',
      `💳 کارت: ${card ? card.replace(/(\d{4})(?=\d)/g, '$1-') : 'ثبت نشده'}${s.card_holder ? ` · ${s.card_holder}` : ''}`,
      `🏦 تأیید کارت‌به‌کارت با پیامک: ${AUTO_FA[s.card_auto] || s.card_auto} · فرستنده‌ی بانکی: ${fa(senders)}`,
      `📩 آدرس پیامک: ${s.sms_key ? '…/sms/' + maskKey(s.sms_key) : 'هنوز ساخته نشده'}`,
      `💎 ارز دیجیتال: ${fa(coins)} ولت · تأیید روی بلاک‌چین: ${AUTO_FA[s.coin_auto] || s.coin_auto}`, '',
      'خودکار = خودش فعال می‌کند · فقط خبر بده = تو تأیید کنی · خاموش = همه دستی'].join('\n'),
    kb: [
      [b('💳 شماره کارت', 'm:w:set:card_number'), b('👤 نام صاحب کارت', 'm:w:set:card_holder')],
      [b('— پیامک بانک —', 'm:pay')], mode('card_auto'),
      [b('🏦 فرستنده‌های بانک', 'm:snd'), b('📨 پیامک‌های رسیده', 'm:sms')],
      [b('— ارز دیجیتال —', 'm:pay')], mode('coin_auto'),
      [b('💎 ولت‌ها', 'm:wl'), b('💵 قیمت دلار', 'm:x:pay|/rate')],
      [b('⚙️ تنظیمات پرداخت', 'm:payset'), b('📩 راه‌اندازی پیامک بانک', 'm:x:pay|/sms')],
      nav('home'),
    ],
  };
}

// the bank numbers whose SMS confirm card payments by themselves
export async function senders(env) {
  const s = await getSettings(env);
  const list = String(s.sms_senders || '').split(',').filter(Boolean);
  return {
    text: [crumb('💳 روش‌های پرداخت', '🏦 فرستنده‌های بانک'), '',
      list.length ? 'پیامک واریز از این شماره‌ها خودکار تأیید می‌شود. برای حذف، روی 🗑 بزن.' : 'هنوز هیچ فرستنده‌ای مورد اعتماد نیست.',
      '', 'برای افزودن: وقتی پیامک واریز رسید، زیرش دکمه‌ی «🏦 این فرستنده بانک من است» را بزن.'].join('\n'),
    kb: [...list.map((x) => [x.length <= 50 ? b(`🗑 ${x}`, `m:sdel:${x}`) : b(x.slice(0, 40), 'm:snd')]),
      [b('✏️ ویرایش کل لیست', 'm:w:set:sms_senders')], nav('pay')],
  };
}

const SMS_FA = { paid: '✅ تأیید شد', review: '🧾 برای تو فرستاده شد', no_order: '❓ سفارشی با این مبلغ نبود', ambiguous: '⚠️ چند سفارش با این مبلغ',
  settle_failed: '⚠️ پیدا شد ولی فعال نشد', not_deposit: '— واریز نبود', duplicate: '— تکراری', untrusted: '🔒 فرستنده ناشناس' };
export const SMS_FILTERS = { all: 'همه', un: 'بی‌سفارش / ناموفق' };
// sms[:filter][:cursor] — never the SMS text itself (it can hold account numbers), only what was read from it
export async function smsLog(env, a0, a1) {
  const f = SMS_FILTERS[a0] ? a0 : 'all';
  const cursor = SMS_FILTERS[a0] ? a1 : a0;
  const pg = await page(env, { select: 'id, sender, amount_rial, order_id, result, created_at', from: 'sms_log', where: f === 'un' ? SMS_UNMATCHED : '1 = 1', cursor });
  const lines = pg.rows.map((r) => `${when(r.created_at)} · ${String(r.sender || '?').slice(0, 16)} · ${r.amount_rial ? fa(Math.round(r.amount_rial / 10)) + ' ت' : '-'} · ${SMS_FA[r.result] || r.result || '-'}${r.order_id ? ` · #${r.order_id}` : ''}`);
  const tabs = Object.entries(SMS_FILTERS).map(([k, l]) => b(`${k === f ? '✅ ' : ''}${l}`, `m:sms:${k}`));
  const ords = [...new Set(pg.rows.filter((r) => r.order_id).map((r) => r.order_id))].slice(0, 6).map((id) => b(`🧾 #${id}`, `m:o:${id}`));
  return {
    text: [crumb('💳 روش‌های پرداخت', '📨 پیامک‌های رسیده'), '', ...(lines.length ? lines : ['پیامکی نیست.'])].join('\n'),
    kb: [tabs, ...(ords.length ? [ords.slice(0, 3), ords.slice(3)].filter((r) => r.length) : []), ...pageRow(`sms:${f}`, pg), nav('pay')],
  };
}

// one-tap choices for the payment settings (the router only accepts these, or a typed value through the question)
export const SET_CHOICES = {
  referral_percent: REF_CHOICES,
  coin_minutes: ['15', '30', '60'],
  min_topup_toman: ['20000', '50000', '100000'],
  card_unique: ['0', '1'],
  usd_rate_toman: ['0'],
  trial_data_gb: ['0', '1', '2', '5'],
};
export async function paySettings(env) {
  const s = await getSettings(env);
  const pick = (key, label) => SET_CHOICES[key].map((v) => b(`${String(s[key]) === v ? '✅ ' : ''}${label(v)}`, `m:ss:${key}:${v}`));
  const rate = parseInt(s.usd_rate_toman || '0', 10);
  return {
    text: [crumb('💳 روش‌های پرداخت', '⚙️ تنظیمات پرداخت'), '',
      `💵 قیمت دلار: ${rate ? `دستی ${fa(rate)} تومان` : 'خودکار (از صرافی‌ها)'}`,
      `⏱ مهلت پرداخت ارز: ${s.coin_minutes} دقیقه`, `👛 حداقل شارژ کیف پول: ${fa(s.min_topup_toman)} تومان`,
      `🔢 مبلغ یکتا برای کارت‌به‌کارت: ${s.card_unique === '0' ? 'خاموش' : 'روشن'}`,
      `🔑 کلید آدرس پیامک: ${s.sms_key ? maskKey(s.sms_key) + ' (مخفی)' : 'ندارد'}`, '',
      'مبلغ یکتا = چند تومان به هر سفارش کارتی اضافه می‌شود تا پیامک بانک دقیقاً به همان سفارش بخورد.'].join('\n'),
    kb: [
      [...pick('usd_rate_toman', () => '💵 خودکار'), b('✏️ قیمت دستی دلار', 'm:w:set:usd_rate_toman')],
      pick('coin_minutes', (v) => `⏱ ${v} دقیقه`),
      [...pick('min_topup_toman', (v) => `${fa(v)}`), b('✏️', 'm:w:set:min_topup_toman')],
      pick('card_unique', (v) => (v === '1' ? '🔢 یکتا روشن' : 'یکتا خاموش')),
      [b('🔑 کلید پیامک', 'm:sk:sms_key')],
      nav('pay'),
    ],
  };
}

// short Persian names for settings
export const KEY_FA = {
  card_number: 'شماره کارت', card_holder: 'نام صاحب کارت', card_bank: 'بانک', usdt_rate_toman: 'قیمت تتر (قدیمی)',
  referral_percent: 'درصد پاداش دعوت', pg_group_ids: 'گروه‌های پنل', support_url: 'لینک پشتیبانی', min_topup_toman: 'حداقل شارژ',
  announcement: 'اطلاعیه‌ی اپ', trial_data_gb: 'حجم تست رایگان (0 = مثل پلن)', usd_rate_toman: 'قیمت دستی دلار (0 = خودکار)',
  coin_minutes: 'مهلت پرداخت ارز (دقیقه)', card_unique: 'مبلغ یکتا (1 روشن، 0 خاموش)', card_auto: 'تأیید پیامکی کارت',
  sms_senders: 'فرستنده‌های بانکی', sms_key: 'کلید آدرس پیامک', coin_auto: 'تأیید ارز دیجیتال',
  app_api_bases: 'دامنه‌های اضافه‌ی اپ (ضد فیلتر)', app_bridges: 'لینک‌های پل اپ (ضد فیلتر)',
};
const APP_KEYS = ['announcement', 'support_url', 'app_api_bases', 'app_bridges', 'trial_data_gb', 'min_topup_toman'];
// which screen a setting belongs to (its back button)
const PAY_KEYS = ['usd_rate_toman', 'coin_minutes', 'min_topup_toman', 'card_unique', 'sms_key'];
export const keyParent = (key) => (key.startsWith('wallet_') ? 'wl' : key === 'referral_percent' ? 'ref' : key === 'sms_senders' ? 'snd'
  : PAY_KEYS.includes(key) ? 'payset' : APP_KEYS.includes(key) ? 'app' : 'set');

const keyRows = (s, keys, label) => {
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) rows.push(keys.slice(i, i + 2).map((k) => b(`${s[k] ? '' : '⚪️ '}${label(k)}`, `m:sk:${k}`)));
  return rows;
};

// wallet_trx -> "TRX (TRON (TRC20))", wallet_xrp_memo -> "XRP Destination Tag"
const walletLabel = (k) => { const c = coinById(k.slice(7).replace(/_memo$/, '')); return k.endsWith('_memo') ? `${c ? c.symbol : k.slice(7)} · ${c && c.memo ? c.memo : 'Memo'}` : c ? `${c.symbol} (${c.network})` : k.slice(7); };

export async function settings(env, wallets) {
  const s = await getSettings(env);
  const keys = Object.keys(SETTING_DEFAULTS).filter((k) => k.startsWith('wallet_') === !!wallets);
  return {
    text: wallets ? `${crumb('💳 روش‌های پرداخت', '💎 ولت‌ها')}\n\n⚪️ = خالی (آن ارز در اپ نشان داده نمی‌شود). روی هر ارز بزن تا آدرسش را بگذاری یا پاکش کنی؛ آدرس اشتباه قبول نمی‌شود.`
      : `${crumb('🛡 سیستم', '⚙️ همه‌ی تنظیمات')}\n\nروی هر مورد بزن تا مقدارش را ببینی یا عوض کنی. (⚪️ = خالی)`,
    kb: [...keyRows(s, keys, (k) => (wallets ? walletLabel(k) : (KEY_FA[k] || k))), ...(wallets ? [[b('📋 ولت‌ها و قیمت‌ها', 'm:x:wl|/wallets')]] : []), nav(wallets ? 'pay' : 'sys')],
  };
}

export async function settingKey(env, key, extraRows = []) {
  if (!(key in SETTING_DEFAULTS)) return { text: crumb('⚙️ تنظیمات') + '\n\nکلید ناشناخته.', kb: [nav('set')] };
  const s = await getSettings(env);
  const val = key === 'sms_key' && s[key] ? '••• (مخفی)'
    : key === 'app_bridges' && s[key] ? splitAppList(s[key]).map(maskBridge).join('\n') : s[key] || '(خالی)';
  const list = { app_api_bases: 'd', app_bridges: 'b' }[key];
  // the two app lists are edited item by item (validated); a free-text edit would skip the checks
  const edit = list ? [b('📝 ویرایش لیست', `m:appl:${list}`)] : [b('✏️ تغییر', `m:w:set:${key}`), b('🧹 خالی کن', `m:x:sk:${key}|/set ${key}`)];
  return {
    text: `${crumb('⚙️', KEY_FA[key] || key)}\n\n⚙️ ${KEY_FA[key] || key}\n${key} = ${val}`,
    kb: [...extraRows, edit, [b('📜 تاریخچه', `m:hist:setting:${key}`)], nav(keyParent(key))],
  };
}

// ---------------- Pleat app, network ----------------
// Everything GET /app-config gives the app has a way to change it from here: announcement, support link,
// the emergency domain / bridge lists, the trial, the minimum top-up, referral %, and payment methods.
export const TRIAL_GB_CHOICES = SET_CHOICES.trial_data_gb;
export async function app(env) {
  const s = await getSettings(env);
  const bases = splitAppList(s.app_api_bases).length, bridges = splitAppList(s.app_bridges).length;
  const trials = await all(env, 'SELECT name, trial_days FROM plans WHERE trial_days > 0 AND is_active = 1 AND archived = 0 ORDER BY sort, id LIMIT 4');
  const ann = String(s.announcement || '');
  const trialGb = String(s.trial_data_gb || '0');
  return {
    text: [crumb('📱 اپ Pleat'), '',
      `📢 اطلاعیه:${ann ? `\n«${ann.slice(0, 300)}${ann.length > 300 ? '…' : ''}»` : ' — (چیزی در اپ نشان داده نمی‌شود)'}`,
      `🛟 پشتیبانی: ${s.support_url || '—'}`,
      `🌐 دامنه‌های اضافه: ${fa(bases)} · 🌉 پل‌ها: ${fa(bridges)}`,
      `🎁 تست رایگان: ${trials.length ? trials.map((p) => `${p.name} ${fa(p.trial_days)} روز`).join('، ') : 'هیچ پلنی تست ندارد'} · حجم: ${trialGb === '0' ? 'مثل پلن' : trialGb + ' گیگ'}`,
      `💰 حداقل شارژ: ${fa(s.min_topup_toman)} تومان · 🎁 پاداش دعوت: ${fa(s.referral_percent)}٪`, '',
      'روزهای تست رایگان روی هر پلن تنظیم می‌شود (📦 پلن‌ها › پلن › روز تست).'].join('\n'),
    kb: [
      [b('📢 ✏️ اطلاعیه', 'm:w:set:announcement'), ...(ann ? [b('🧹 پاک کردن اطلاعیه', 'm:apc:announcement')] : [])],
      [b('🛟 ✏️ لینک پشتیبانی', 'm:w:set:support_url'), ...(s.support_url ? [b('🧹 پاک کردن', 'm:apc:support_url')] : [])],
      [b(`🌐 دامنه‌ها (${fa(bases)})`, 'm:appl:d'), b(`🌉 پل‌ها (${fa(bridges)})`, 'm:appl:b')],
      [...TRIAL_GB_CHOICES.map((v) => b(`${v === trialGb ? '✅ ' : ''}${v === '0' ? 'تست: مثل پلن' : v + ' گیگ'}`, `m:ss:trial_data_gb:${v}`)), b('✏️', 'm:w:set:trial_data_gb')],
      [b('⏳ روزهای تست (پلن‌ها)', 'm:pl'), b('💰 حداقل شارژ', 'm:sk:min_topup_toman')],
      [b('🎁 دعوت و پاداش', 'm:ref'), b('💳 روش‌های پرداخت', 'm:pay')],
      nav('home'),
    ],
  };
}

// the app's emergency lists, item by item: k = d (API domains) or b (bridge configs, always masked here)
export async function appList(env, k) {
  const key = APP_LISTS[k];
  if (!key) return { text: crumb('📱 اپ Pleat') + '\n\nلیست ناشناخته.', kb: [nav('app')] };
  const list = splitAppList((await getSettings(env))[key]);
  const dom = k === 'd';
  const rows = list.map((v, i) => [...(i ? [b(`⬆️ ${i + 1}`, `m:apm:${k}:${i}:${itemTag(v)}`)] : []), b(`🗑 ${i + 1}`, `m:apr:${k}:${i}:${itemTag(v)}`)]);
  return {
    text: [crumb('📱 اپ Pleat', dom ? '🌐 دامنه‌ها' : '🌉 پل‌ها'), '',
      dom ? 'اگر دامنه‌ی اصلی فیلتر شد، اپ به ترتیب این دامنه‌ها را امتحان می‌کند (فقط https، بدون مسیر).'
        : 'اگر هیچ دامنه‌ای باز نشد، اپ از این کانفیگ‌ها برای رسیدن به سرور استفاده می‌کند. لینک کامل هیچ‌وقت اینجا نشان داده نمی‌شود.', '',
      ...(list.length ? list.map((v, i) => `${i + 1}. ${dom ? v : maskBridge(v)}`) : ['(خالی)']), '',
      `حداکثر ۸ مورد. ترتیب = ترتیبی که اپ امتحان می‌کند.`].join('\n'),
    kb: [...rows, [b(dom ? '➕ افزودن دامنه' : '➕ افزودن پل', `m:f:${dom ? 'appd' : 'appb'}`), ...(dom && list.length ? [b('🔎 تست', 'm:apt')] : [])], nav('app')],
  };
}

// ---------------- panel servers (names, types, countries only; never an address, port or link) ----------------
export async function panelServerList(env, id) {
  const { getPanel, panelServers, overridesFor } = await import('./panels.js');
  const p = await getPanel(env, id);
  if (!p) return { text: crumb('🗂 پنل‌ها', '🖥 سرورها') + '\n\nپنل پیدا نشد.', kb: [nav('pa')] };
  const ov = await overridesFor(env, [p.id]);
  const labels = ov.labels[p.id] || {};
  const { servers, source } = await panelServers(env, p);
  const known = new Set(servers.map((s) => s.key));
  const extra = [...new Set([...Object.keys(labels), ...[...ov.hidden].map((h) => h.split(':')[1])])].filter((k) => !known.has(k));
  const mark = (k) => `${ov.hidden.has(p.id + ':' + k) ? '🙈 ' : ''}${labels[k] ? '✏️ ' : ''}`;
  const lines = servers.map((s) => `${mark(s.key)}${labels[s.key] || s.name} — ${s.type}${s.cc ? ` · ${s.cc}` : ''}`);
  const why = source === 'none' ? 'هنوز هیچ کاربر فعالی روی این پنل نیست، پس لیست سرورهایش خوانده نمی‌شود.'
    : source === 'error' ? 'پنل جواب نداد؛ لیست سرورها خوانده نشد.' : servers.length ? '' : 'این پنل کانفیگی نداد.';
  return {
    text: [crumb('🗂 پنل‌ها', `#${p.id}`, '🖥 سرورها'), '', `🖥 سرورهای پنل #${p.id} — ${p.label}`, '',
      ...lines, ...(why ? [why] : []), ...(extra.length ? ['', `${fa(extra.length)} سرور تنظیم‌شده الان در پنل نیست.`] : []), '',
      '🙈 = از اپ برداشته شده · ✏️ = نام دلخواه. روی هر سرور بزن.'].join('\n'),
    kb: [...servers.slice(0, 30).map((s) => [b(`${mark(s.key)}${labels[s.key] || s.name} · ${s.type}`.slice(0, 60), `m:srv:${p.id}:${s.key}`)]),
      ...extra.slice(0, 10).map((k) => [b(`${mark(k)}${labels[k] || 'سرور قدیمی'}`, `m:srv:${p.id}:${k}`)]),
      [b('🔄 به‌روزرسانی', `m:srvs:${p.id}`)], nav(`pp:${p.id}`)],
  };
}

export async function panelServer(env, id, key) {
  const { getPanel, panelServers } = await import('./panels.js');
  const { SKEY_RE } = await import('./admin-actions.js');
  const p = await getPanel(env, id);
  if (!p || !SKEY_RE.test(String(key || ''))) return { text: crumb('🗂 پنل‌ها', '🖥 سرور') + '\n\nپیدا نشد.', kb: [nav(p ? `srvs:${p.id}` : 'pa')] };
  const o = (await first(env, 'SELECT hidden, label FROM server_overrides WHERE panel_id = ? AND server_key = ?', p.id, key)) || { hidden: 0, label: null };
  const s = (await panelServers(env, p)).servers.find((x) => x.key === key);
  return {
    text: [crumb('🗂 پنل‌ها', `#${p.id}`, '🖥 سرور'), '', `🖥 ${o.label || (s ? s.name : 'سرور قدیمی')}`,
      s ? `نوع: ${s.type}${s.cc ? ` · کشور: ${s.cc}` : ''}` : 'این سرور الان در لیست پنل نیست.',
      `در اپ: ${o.hidden ? '🙈 مخفی (کاربرها نمی‌بینندش)' : '👁 نمایش داده می‌شود'}`,
      `نام در اپ: ${o.label ? o.label : `خودکار${s ? ` (${s.name})` : ''}`}`, '',
      'رتبه‌بندی و آمار با کلید ثابت سرور حساب می‌شود؛ با تغییر نام از بین نمی‌رود.'].join('\n'),
    kb: [
      [b(o.hidden ? '👁 نمایش دوباره در اپ' : '🙈 مخفی کردن از اپ', `m:sh:${p.id}:${key}:${o.hidden ? 0 : 1}`)],
      [b('✏️ نام در اپ', `m:f:srn:${p.id}.${key}`), ...(o.label ? [b('↺ نام خودکار', `m:sl:${p.id}:${key}`)] : [])],
      [b('📶 آمار شبکه‌ی این سرور', `m:nsv:${key}`), b('📜 تاریخچه', `m:hist:server:${p.id}.${key}`)],
      nav(`srvs:${p.id}`),
    ],
  };
}

// ---------------- network ----------------
export async function net() {
  return {
    text: `${crumb('📶 شبکه و رتبه‌بندی')}\n\nکدام سرور روی کدام اپراتور بهتر است، وضعیت سرورها از دید گوگل، و تجربه‌ی هر کاربر.`,
    kb: [[b('📶 اپراتورها و بهترین سرورها', 'm:nc')], [b('🔎 وضعیت از دید گوگل', 'm:ng')],
      [b('👥 کاربران و اپراتورهایشان', 'm:un')], nav('home')],
  };
}

const srvLine = (s) => `${s.name} — وصل ${fa(s.ok)}٪${s.ms ? ` · پینگ ${fa(s.ms)}ms` : ''}${s.kbps ? ` · ${(s.kbps / 1000).toFixed(1)} مگابیت` : ''} · ${fa(s.users)} نفر`;

export async function carriers(env) {
  const { carrierSummary } = await import('./netstats.js');
  const nets = (await carrierSummary(env)).slice(0, 12);
  const lines = nets.map((n) => `▪️ ${n.isp} — ${fa(n.tests)} تست · بهترین: ${n.servers[0] ? srvLine(n.servers[0]) : '—'}`);
  return {
    text: [crumb('📶 شبکه', 'اپراتورها'), '', ...(lines.length ? lines : ['هنوز نتیجه‌ای از گوشی‌ها نرسیده. بعد از چند تست در اپ دوباره بزن.']), '',
      'روی هر اپراتور بزن تا بهترین و ضعیف‌ترین سرورهایش را ببینی (۳ روز اخیر).'].join('\n'),
    kb: [...nets.map((n) => [b(`${n.isp} (${fa(n.servers.length)} سرور)`, `m:nca:${n.asn}`)]), nav('net')],
  };
}

export async function carrier(env, asn) {
  const { carrierSummary } = await import('./netstats.js');
  const n = (await carrierSummary(env)).find((x) => x.asn === asn);
  if (!n) return { text: crumb('📶 شبکه', 'اپراتور') + '\n\nبرای این اپراتور در ۳ روز اخیر نتیجه‌ای نیست.', kb: [[b('🧹 پاک کردن آمار این اپراتور', `m:nrs:a:${asn}`)], nav('nc')] };
  const best = n.servers.slice(0, 5), weak = n.servers.length > 5 ? n.servers.slice(-3).reverse() : [];
  return {
    text: [crumb('📶 شبکه', n.isp), '', `▪️ ${n.isp} (AS${n.asn}) — ${fa(n.tests)} تست`, '', 'بهترین سرورها:', ...best.map((s, i) => `${i + 1}. 🟢 ${srvLine(s)}`),
      ...(weak.length ? ['', 'ضعیف‌ترین:', ...weak.map((s) => `🔴 ${srvLine(s)}`)] : []), '',
      '🔴 یعنی روی این اپراتور کمتر وصل می‌شود یا کندتر است.'].join('\n'),
    kb: [...best.concat(weak).slice(0, 8).map((s) => [b(`📊 ${s.name}`.slice(0, 50), `m:nsv:${s.k}`)]),
      [b('🧹 پاک کردن آمار این اپراتور', `m:nrs:a:${n.asn}`)], nav('nc')],
  };
}

// one server on every operator, and how Google sees it
export async function netServer(env, key) {
  const { SKEY_RE } = await import('./admin-actions.js');
  if (!SKEY_RE.test(String(key || ''))) return { text: crumb('📶 شبکه', 'سرور') + '\n\nپیدا نشد.', kb: [nav('nc')] };
  const { carrierSummary } = await import('./netstats.js');
  const rows = [];
  let name = '';
  for (const n of await carrierSummary(env)) {
    const i = n.servers.findIndex((s) => s.k === key);
    if (i >= 0) { rows.push({ isp: n.isp, rank: i + 1, of: n.servers.length, s: n.servers[i] }); name = name || n.servers[i].name; }
  }
  const g = await first(env, `SELECT SUM(tests) t, SUM(gemini_ok) g, SUM(google_ir) ir, SUM(google_wall) w, MAX(name) name
    FROM google_probe WHERE skey = ? AND day >= ?`, key, Math.floor(nowSec() / 86400) - 2);
  name = name || (g && g.name) || 'سرور';
  const gl = g && g.t ? (g.ir / g.t >= 0.5 ? '🔴 گوگل آن را «ایران» می‌بیند' : g.w / g.t >= 0.5 ? '🟠 گوگل IP را مشکوک می‌داند' : g.g / g.t < 0.5 ? '🟡 گوگل سالم، Gemini نه' : '🟢 گوگل و Gemini سالم') + ` · ${fa(g.t)} تست` : 'هنوز تست گوگل ندارد.';
  return {
    text: [crumb('📶 شبکه', name), '', `📊 ${name}`, '', ...(rows.length ? rows.map((r) => `▪️ ${r.isp}: رتبه ${fa(r.rank)} از ${fa(r.of)} — ${srvLine(r.s).split(' — ')[1]}`) : ['در ۳ روز اخیر روی هیچ اپراتوری تست نشده.']),
      '', `🔎 ${gl}`].join('\n'),
    kb: [[b('🧹 پاک کردن آمار این سرور', `m:nrs:s:${key}`)], nav('nc')],
  };
}

export async function google(env) {
  const { googleSummary } = await import('./netstats.js');
  const rows = (await googleSummary(env)).sort((a, z) => (a.status === 'google') - (z.status === 'google'));
  const ico = { google: '🟢', no_gemini: '🟡', iran: '🔴', flagged: '🟠' };
  const txt = { google: 'گوگل و Gemini سالم', no_gemini: 'گوگل سالم، Gemini نه', iran: 'گوگل آن را «ایران» می‌بیند', flagged: 'گوگل IP را مشکوک می‌داند (کپچا)' };
  return {
    text: [crumb('📶 شبکه', '🔎 گوگل'), '', ...(rows.length ? rows.slice(0, 25).map((r) => `${ico[r.status]} ${r.name} — ${txt[r.status]} · ${r.google_cc || '?'} · ${fa(r.tests)} تست`)
      : ['هنوز تست گوگلی ثبت نشده. هر کاربر بعد از اتصال، سرورش را خودکار تست می‌کند.']), '',
      'برای 🔴 و 🟠: روی همان نود، خروجی را از IP دیگری بده (مثلاً WARP) تا گوگل آن را کشور دیگری ببیند.'].join('\n'),
    kb: [...rows.slice(0, 8).map((r) => [b(`${ico[r.status]} ${r.name}`.slice(0, 50), `m:nsv:${r.k}`)]), nav('net')],
  };
}

export const soon = (title) => ({ text: `${crumb(title)}\n\n${SOON}`, kb: [nav('home')] });

// ---------------- stats, system, admin log ----------------
// today / 7 / 30 days, in three queries (one row of counts, one per payment method, one top-plans list), all on
// indexed columns: orders(status, paid_at), users(created_at), sub_periods(end_reason, ended_at)
export const STAT_PERIODS = { 1: 'امروز (۲۴ ساعت)', 7: '۷ روز', 30: '۳۰ روز' };
export async function stats(env, period) {
  const days = STAT_PERIODS[period] ? parseInt(period, 10) : 1;
  const now = nowSec(), since = now - days * 86400;
  const c = await first(env, `SELECT
    (SELECT COUNT(*) FROM orders WHERE status = 'paid' AND paid_at > ?1) sales,
    (SELECT COALESCE(SUM(amount_toman), 0) FROM orders WHERE status = 'paid' AND paid_at > ?1 AND method != 'wallet') toman,
    (SELECT COUNT(*) FROM users WHERE created_at > ?1) signups,
    (SELECT COUNT(*) FROM sub_periods WHERE end_reason = 'renewed' AND ended_at > ?1) renewals,
    (SELECT COUNT(*) FROM subscriptions WHERE expires_at > ?2 OR expires_at IS NULL) active,
    (SELECT COALESCE(SUM(used_bytes), 0) FROM subscriptions WHERE expires_at > ?2 OR expires_at IS NULL) used`, since, now);
  const methods = await all(env, `SELECT method, COUNT(*) n, COALESCE(SUM(amount_toman), 0) t FROM orders WHERE status = 'paid' AND paid_at > ?
    GROUP BY method ORDER BY t DESC`, since);
  const top = await all(env, `SELECT o.plan_id, p.name, COUNT(*) n, COALESCE(SUM(o.amount_toman), 0) t FROM orders o LEFT JOIN plans p ON p.id = o.plan_id
    WHERE o.status = 'paid' AND o.paid_at > ? AND o.kind = 'plan' GROUP BY o.plan_id ORDER BY n DESC, t DESC LIMIT 5`, since);
  const lines = [crumb('📊 آمار', STAT_PERIODS[days]), '',
    `💰 فروش: ${fa(c.sales)} سفارش · ${fa(c.toman)} تومان دریافتی`,
    ...methods.map((m) => `   ${METHOD_FA[m.method] || m.method}: ${fa(m.n)} · ${fa(m.t)} تومان`),
    ...(methods.some((m) => m.method === 'wallet') ? ['   (خرید با کیف پول در «دریافتی» حساب نشده؛ پولش موقع شارژ آمده)'] : []),
    `🆕 ثبت‌نام تازه: ${fa(c.signups)}`, `🔁 تمدید (خرید روی اشتراک باز): ${fa(c.renewals)}`, '',
    `✅ اشتراک فعال الان: ${fa(c.active)} · مصرف این دوره‌شان: ${gb(c.used)} گیگ`, '',
    '🏆 پرفروش‌ترین پلن‌ها:', ...(top.length ? top.map((p, i) => `${i + 1}. ${p.name || '#' + p.plan_id} — ${fa(p.n)} فروش · ${fa(p.t)} تومان`) : ['   فروشی نبوده.'])];
  return {
    text: lines.join('\n'),
    kb: [Object.entries(STAT_PERIODS).map(([k, label]) => b(`${String(days) === k ? '✅ ' : ''}${label}`, `m:st:${k}`)), [b('🔄 به‌روزرسانی', `m:st:${days}`)], nav('home')],
  };
}

export const help = () => ({ text: `${crumb('🛡 سیستم', '❓ راهنما')}\n\n${HELP}`, kb: [nav('sys')] });

export async function system() {
  return {
    text: `${crumb('🛡 سیستم')}\n\nلاگ همه‌ی تغییرات مدیر (با برگرداندن تا ۱۰ دقیقه)، پشتیبان، سلامت ربات و همگام‌سازی، همه‌ی تنظیمات، مدیرها و راهنما.`,
    kb: [[b('📜 لاگ مدیر', 'm:sys.log'), b('💾 پشتیبان', 'm:x:sys|/backup')], [b('🩺 سلامت', 'm:sys.hl'), b('👥 مدیرها', 'm:sys.adm')],
      [b('⚙️ همه‌ی تنظیمات', 'm:set'), b('❓ راهنما', 'm:help')], nav('home')],
  };
}

// ---------------- broadcasts ----------------
const BC_FA = { draft: '📝 پیش‌نویس', sending: '📤 در حال ارسال', done: '✅ تمام شد', stopped: '⏹ متوقف' };
export async function broadcasts(env, cursor) {
  const { AUDIENCES } = await import('./admin-actions.js');
  const pg = await page(env, { select: 'id, audience, status, sent, failed, blocked, created_at', from: 'broadcasts', cursor, size: 6 });
  const lines = pg.rows.map((r) => `#${r.id} · ${ymd(r.created_at)} · ${BC_FA[r.status] || r.status} · ${(AUDIENCES[r.audience] || {}).fa || r.audience} · ${fa(r.sent)} رسید`);
  return {
    text: [crumb('📣 پیام همگانی'), '', 'یک پیام متنی برای کاربرانی که با تلگرام وارد اپ شده‌اند. هر ۲ دقیقه چند نفر؛ هر وقت خواستی متوقفش کن.', '',
      ...(lines.length ? lines : ['هنوز پیامی فرستاده نشده.'])].join('\n'),
    kb: [[b('➕ پیام تازه', 'm:f:bcast')], ...pg.rows.map((r) => [b(`#${r.id} ${BC_FA[r.status] || r.status}`, `m:bcv:${r.id}`)]), ...pageRow('bc', pg), nav('home')],
  };
}

export async function broadcast(env, id) {
  const { AUDIENCES, audienceCount } = await import('./admin-actions.js');
  const r = id > 0 ? await first(env, 'SELECT * FROM broadcasts WHERE id = ?', id) : null;
  if (!r) return { text: crumb('📣 پیام همگانی') + '\n\nپیدا نشد.', kb: [nav('bc')] };
  const total = r.status === 'draft' || r.status === 'sending' ? await audienceCount(env, r.audience) : null;
  const done = r.sent + r.failed + r.blocked;
  const preview = r.text.length > 300 ? r.text.slice(0, 300) + '…' : r.text;
  return {
    text: [crumb('📣 پیام همگانی', `#${r.id}`), '', `وضعیت: ${BC_FA[r.status] || r.status}`, `گیرنده‌ها: ${(AUDIENCES[r.audience] || {}).fa || r.audience}${total != null ? ` (الان ${fa(total)} نفر)` : ''}`,
      `✅ رسید: ${fa(r.sent)} · 🚫 بلاک کرده: ${fa(r.blocked)} · ⚠️ ناموفق: ${fa(r.failed)}${r.status === 'sending' && total ? ` · پیشرفت حدود ${Math.min(100, Math.round((done / total) * 100))}٪` : ''}`,
      `ساخته شده: ${ymd(r.created_at)}`, '', '— متن —', preview].join('\n'),
    kb: [
      ...(r.status === 'sending' ? [[b('⏹ توقف ارسال', `m:bcs:${r.id}`), b('🔄 به‌روزرسانی', `m:bcv:${r.id}`)]] : []),
      ...(r.status === 'draft' ? [[b('📤 شروع ارسال', `m:bcgo:${r.id}`)]] : []),
      nav('bc')],
  };
}

// ---------------- system: health, admins ----------------
const ago = (t, now = nowSec()) => (!t ? 'هرگز' : now - t < 120 ? `${fa(now - t)} ثانیه پیش` : now - t < 7200 ? `${fa(Math.round((now - t) / 60))} دقیقه پیش` : `${fa(Math.round((now - t) / 3600))} ساعت پیش`);
// The webhook as Telegram sees it (never its address or secret), the background sync, and the broadcast queue.
export async function health(env) {
  const { tg, untrusted } = await import('./telegram.js');
  const now = nowSec();
  const w = (await tg(env, 'getWebhookInfo', {})) || null;
  const info = w && w.ok ? w.result || {} : null;
  const base = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const c = await first(env, `SELECT (SELECT COUNT(*) FROM panel_accounts WHERE dirty = 1) dirty,
    (SELECT COUNT(*) FROM panel_accounts WHERE dirty = 1 AND attempts >= 3) stuck,
    (SELECT COUNT(*) FROM panel_accounts WHERE last_error IS NOT NULL AND last_error != '') errs,
    (SELECT COUNT(*) FROM settings WHERE key LIKE 'panel_err_%' AND value != '') perr,
    (SELECT COUNT(*) FROM broadcasts WHERE status = 'sending') bc`);
  const jobs = await all(env, 'SELECT job, panel_id, run_at FROM sync_cursor ORDER BY run_at DESC LIMIT 6');
  // Telegram's error text can carry the webhook address: anything that looks like a link is cut out
  const errMsg = info && info.last_error_message ? untrusted(String(info.last_error_message).replace(/\S*:\/\/\S*/g, '[آدرس]').replace(/\b[\w-]+(\.[\w-]+)+(:\d+)?\S*/g, '[آدرس]')).slice(0, 150) : '';
  const lines = [crumb('🛡 سیستم', '🩺 سلامت'), '', '🤖 وبهوک تلگرام',
    !info ? '❌ جواب Telegram نیامد.' : !info.url ? '❌ ثبت نشده (هر دقیقه دوباره امتحان می‌شود).' : info.url === base + '/tg' ? '✅ به همین ورکر وصل است.' : '⚠️ به آدرس دیگری وصل است؛ هر دقیقه درست می‌شود.',
    ...(info ? [`پیام‌های در صف: ${fa(info.pending_update_count || 0)}`, info.last_error_date ? `آخرین خطا: ${ago(info.last_error_date, now)}${errMsg ? ` — ${errMsg}` : ''}` : 'خطای اخیر: ندارد'] : []),
    '', '🔄 همگام‌سازی پنل‌ها',
    ...(jobs.length ? jobs.map((j) => `${j.job} · پنل #${j.panel_id} · ${ago(j.run_at, now)}`) : ['هنوز اجرا نشده.']),
    `در صف تغییر روی پنل: ${fa(c.dirty)}${c.stuck ? ` (⚠️ ${fa(c.stuck)} تا بعد از ۳ تلاش هنوز نشده)` : ''}`,
    `اکانت با خطای آخر: ${fa(c.errs)} · پنلی که ساخت اکانت را رد می‌کند: ${fa(c.perr)}`,
    '', `📣 پیام همگانی در حال ارسال: ${fa(c.bc)}`];
  return { text: lines.join('\n'), kb: [[b('🔄 به‌روزرسانی', 'm:sys.hl'), ...(c.perr || c.errs ? [b('🗂 پنل‌ها', 'm:pa')] : [])], nav('sys')] };
}

export async function admins(env) {
  const { ROLE_FA } = await import('./admin-actions.js');
  const rows = await all(env, 'SELECT tg_id, role, added_at FROM admins ORDER BY added_at, tg_id LIMIT 20');
  return {
    text: [crumb('🛡 سیستم', '👥 مدیرها'), '', `👑 مالک: ${env.TELEGRAM_CHAT_ID || '-'} (همه‌ی دسترسی‌ها؛ حذف نمی‌شود)`,
      ...rows.map((r) => `${r.role === 'support' ? '🧾' : '👁'} ${r.tg_id} · ${ROLE_FA[r.role] || r.role} · از ${ymd(r.added_at)}`), '',
      '🧾 پشتیبان: فقط کارهای منتظر و تأیید / رد رسیدها.', '👁 فقط دیدن: صفحه‌ها را می‌بیند (بدون تنظیمات)، چیزی را عوض نمی‌کند.',
      'هر کار هر مدیر با آیدی‌اش در لاگ مدیر می‌ماند.'].join('\n'),
    kb: [[b('➕ افزودن مدیر', 'm:f:addadm')], ...rows.map((r) => [b(`🗑 حذف ${r.tg_id} (${ROLE_FA[r.role] || r.role})`, `m:adr:${r.tg_id}`)]), nav('sys')],
  };
}

const TARGET_FA = { plan: '📦 پلن', panel: '🗂 پنل', setting: '⚙️', user: '👤 کاربر', coupon: '🏷 کد', order: '🧾 سفارش', server: '🖥 سرور', net: '📶 آمار شبکه', broadcast: '📣 پیام همگانی', admin: '👥 مدیر' };
const when = (t) => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');

function logScreen(pg, title, route, back, owner = '') {
  const now = nowSec();
  const lines = pg.rows.map((r) => `#${r.id} · ${when(r.created_at)} · ${r.action}${r.admin_id && String(r.admin_id) !== String(owner) ? ` · 👤 ${r.admin_id}` : ''}${r.target_type ? ` · ${TARGET_FA[r.target_type] || r.target_type} ${r.target_id || ''}` : ''}${r.summary ? `\n   ${r.summary}` : ''}${r.undone_at ? ' ↩️' : ''}`);
  const undo = pg.rows.filter((r) => canUndo(r, now)).slice(0, 4).map((r) => b(`↩️ برگردان #${r.id}`, `m:undo:${r.id}`));
  return {
    text: `${title}\n\n${lines.join('\n') || 'هنوز چیزی ثبت نشده.'}${undo.length ? '\n\n↩️ تغییرهای ساده تا ۱۰ دقیقه برمی‌گردند.' : ''}`,
    kb: [...(undo.length ? [undo.slice(0, 2), undo.slice(2)].filter((r) => r.length) : []), ...pageRow(route, pg), nav(back)],
  };
}

export async function auditLog(env, cursor) {
  const pg = await page(env, { from: 'admin_audit', cursor });
  return logScreen(pg, crumb('🛡 سیستم', '📜 لاگ مدیر'), 'sys.log', 'sys', env.TELEGRAM_CHAT_ID);
}

// one plan / panel / setting / user: its own changes ("history")
const HIST_BACK = { plan: (id) => `p:${id}`, panel: (id) => `pp:${id}`, setting: (id) => `sk:${id}`, user: (id) => `u:${id}`, order: (id) => `o:${id}`, coupon: () => 'cp',
  server: (id) => `srv:${String(id).replace('.', ':')}` };
export async function history(env, type, id, cursor) {
  if (!HIST_BACK[type] || !/^[\w.-]{1,40}$/.test(String(id || ''))) return soon('📜 تاریخچه');
  const pg = await page(env, { from: 'admin_audit', where: 'target_type = ? AND target_id = ?', args: [type, String(id)], cursor });
  return logScreen(pg, crumb('📜 تاریخچه', `${TARGET_FA[type] || type} ${id}`), `hist:${type}:${id}`, HIST_BACK[type](id), env.TELEGRAM_CHAT_ID);
}
