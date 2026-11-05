// Read-only screens of the admin bot. A screen reads what it needs (a few D1 queries at most, free plan) and
// returns {text, kb}: the first line is where you are (🏠 منو › ...), the last row is back + home.
// Nothing here writes; every change goes through admin-actions.js from the router (telegram-menu.js).
import { first, all, getSettings, SETTING_DEFAULTS } from './db.js';
import { nowSec } from './util.js';
import { statsText, userInfo, HELP, STATE_FA } from './telegram.js';
import { canUndo } from './admin-actions.js';

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
    (SELECT COUNT(*) FROM subscriptions WHERE expires_at > ? OR expires_at IS NULL) active,
    (SELECT COUNT(*) FROM orders WHERE status = 'review') review`, now);
  return {
    text: `🏠 مدیریت Cloud Gold\n\n👥 کاربران: ${fa(c.users)} · ✅ اشتراک فعال: ${fa(c.active)}\n🧾 رسید منتظر بررسی: ${fa(c.review)}\n\nیک بخش را انتخاب کن:`,
    kb: [
      [b(c.review ? `📥 کارهای منتظر (${c.review})` : '📥 کارهای منتظر ✅', 'm:in'), b('👤 کاربران', 'm:usr')],
      [b('📦 پلن‌ها', 'm:pl'), b('🧾 سفارش‌ها و کیف پول', 'm:or')],
      [b('🗂 پنل‌ها و سرورها', 'm:pa'), b('🏷 تخفیف و دعوت', 'm:cp')],
      [b('💳 روش‌های پرداخت', 'm:pay'), b('📱 اپ Pleat', 'm:app')],
      [b('📶 شبکه و رتبه‌بندی', 'm:net'), b('📣 پیام همگانی', 'm:bc')],
      [b('📊 آمار', 'm:st'), b('🛡 سیستم', 'm:sys')],
    ],
  };
}

export async function inbox(env) {
  const c = await first(env, `SELECT (SELECT COUNT(*) FROM orders WHERE status = 'review') review,
    (SELECT COUNT(*) FROM orders WHERE status = 'review' AND method = 'coin') coin,
    (SELECT COUNT(*) FROM settings WHERE key LIKE 'panel_err_%' AND value != '') perr`);
  return {
    text: [crumb('📥 کارهای منتظر'), '', `🧾 رسید منتظر بررسی: ${fa(c.review)}${c.coin ? ` (ارز دیجیتال: ${fa(c.coin)})` : ''}`,
      `⚠️ پنلی که ساخت اکانت را رد کرده: ${fa(c.perr)}`, '', c.review ? 'رسیدها را با دکمه‌ی زیر ببین و تأیید یا رد کن.' : 'کاری منتظر تو نیست ✅'].join('\n'),
    kb: [...(c.review ? [[b(`🧾 دیدن ${fa(c.review)} رسید`, 'm:ord')]] : []), ...(c.perr ? [[b('🗂 پنل‌ها', 'm:pa')]] : []), nav('home')],
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

const TX_FA = { admin_credit: 'شارژ مدیر', admin_debit: 'کسر مدیر', referral: 'پاداش دعوت', topup: 'شارژ', purchase: 'خرید', refund: 'بازگشت' };
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

export async function order(env, id) {
  const o = await first(env, `SELECT o.*, u.email, u.tg_id, u.tg_username, p.name plan_name FROM orders o JOIN users u ON u.id = o.user_id
    LEFT JOIN plans p ON p.id = COALESCE(o.plan_id, o.activate_plan_id) WHERE o.id = ?`, id);
  if (!o) return { text: crumb('🧾 سفارش') + '\n\nسفارش پیدا نشد.', kb: [nav('usr')] };
  const what = o.kind === 'plan' ? `پلن ${o.plan_name || ''}` : o.activate_plan_id ? `شارژ + فعال‌سازی ${o.plan_name || ''}` : 'شارژ کیف پول';
  return {
    text: [crumb('🧾 سفارش', `#${o.id}`), '', `🧾 سفارش #${o.id} — ${what}`, `👤 ${who(o)}`, `مبلغ: ${fa(o.amount_toman)} تومان${o.coin_amount ? ` (${o.coin_amount} ${String(o.coin || '').toUpperCase()})` : ''}`,
      `روش: ${o.method || '-'} · وضعیت: ${ORDER_FA[o.status] || o.status}`, `ثبت: ${ymd(o.created_at)}`, `شماره پیگیری: ${o.receipt_ref || o.txid || '-'}`].join('\n'),
    kb: [[b('👤 کارت کاربر', `m:u:${o.user_id}`)], nav(`uo:${o.user_id}`)],
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
export async function plans(env) {
  const rows = await all(env, 'SELECT * FROM plans WHERE archived = 0 ORDER BY sort, id');
  return {
    text: `${crumb('📦 پلن‌ها')}\n\nروی هر پلن بزن تا قیمت، روز، حجم و بقیه را عوض کنی.\n🟢 = در اپ دیده می‌شود · 🔴 = خاموش`,
    kb: [...rows.map((p) => [b(`${p.is_active ? '🟢' : '🔴'} #${p.id} ${p.name} — ${fa(p.price_toman)} ت`, `m:p:${p.id}`)]),
      [b('➕ پلن جدید', 'm:f:newplan')], nav('home')],
  };
}

export async function plan(env, id, extraRows = []) {
  const p = await first(env, 'SELECT * FROM plans WHERE id = ?', id);
  if (!p) return { text: crumb('📦 پلن‌ها') + '\n\nپلن پیدا نشد.', kb: [nav('pl')] };
  const f = (field, label) => b(label, `m:w:plan:${p.id}:${field}`);
  return {
    text: [crumb('📦 پلن‌ها', `#${p.id}`), '', `📦 پلن #${p.id} — ${p.name}`, '',
      `💰 قیمت: ${fa(p.price_toman)} تومان${p.old_price_toman ? ` (قبلی: ${fa(p.old_price_toman)})` : ''}`,
      `📅 مدت: ${p.duration_days} روز`, `📦 حجم: ${p.data_limit_gb || 'نامحدود'} گیگ`, `📱 دستگاه: ${p.device_limit || 'نامحدود'}`,
      `🎁 تست رایگان: ${p.trial_days ? p.trial_days + ' روز' : 'ندارد'}`, `⭐ نشان: ${p.badge || '—'}`,
      `وضعیت: ${p.is_active ? '🟢 روشن (در اپ دیده می‌شود)' : '🔴 خاموش'}`].join('\n'),
    kb: [
      ...extraRows,
      [f('price', '💰 قیمت'), f('old', '🏷 قیمت قبلی')],
      [f('days', '📅 روز'), f('gb', '📦 حجم')],
      [f('devices', '📱 دستگاه'), f('trial', '🎁 تست')],
      [f('name', '✏️ نام'), f('badge', '⭐ نشان')],
      [b(p.is_active ? '🔴 خاموش کن' : '🟢 روشن کن', `m:pt:${p.id}`), b('📜 تاریخچه', `m:hist:plan:${p.id}`)],
      nav('pl'),
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
  const back = `pp:${p.id}`;
  const x = (label, cmd) => b(label, `m:x:${back}|${cmd}`);
  return {
    text: [crumb('🗂 پنل‌ها', `#${p.id}`), '', `🗂 پنل #${p.id} — ${p.label} (${p.kind})`, '',
      `وضعیت: ${STATE_FA[p.state] || p.state}${p.state === 'rollout' ? ` ${p.rollout_percent}%` : ''}`,
      `سلامت: ${p.health} · ${n} کاربر فعال${p.version ? ` · نسخه ${p.version}` : ''}`, '',
      'ورود تدریجی = چند درصد کاربران روی این پنل هم اکانت بگیرند.'].join('\n'),
    kb: [
      ...extraRows,
      [x('🧪 تست پنل', `/paneltest ${p.id}`), b('👥 گروه‌ها / سرویس', `m:w:groups:${p.id}`)],
      [x('10%', `/rollout ${p.id} 10`), x('25%', `/rollout ${p.id} 25`), x('50%', `/rollout ${p.id} 50`), x('100%', `/rollout ${p.id} 100`)],
      [b('🔐 ورود پنل (آدرس، یوزر، رمز)', `m:w:panelcred:${p.id}`)],
      [x('🚪 خارج‌کردن پنل', `/drainpanel ${p.id}`), b('📜 تاریخچه', `m:hist:panel:${p.id}`)],
      nav('pa'),
    ],
  };
}

// ---------------- coupons ----------------
export async function coupons(env) {
  const rows = await all(env, 'SELECT * FROM coupons WHERE is_active = 1 ORDER BY id DESC LIMIT 20');
  const lines = rows.map((c) => `${c.code} — ${c.percent}% · ${c.used}${c.max_uses ? '/' + c.max_uses : ''} استفاده${c.expires_at ? ` · تا ${new Date(c.expires_at * 1000).toISOString().slice(0, 10)}` : ''}${c.plan_id ? ` · پلن #${c.plan_id}` : ''}`);
  return {
    text: `${crumb('🏷 تخفیف و دعوت')}\n\n${lines.join('\n') || 'کدی نیست.'}${rows.length ? '\n\nبرای پاک کردن، روی 🗑 کنار کد بزن.' : ''}`,
    kb: [...rows.filter((c) => c.code.length <= 50).map((c) => [b(`🗑 ${c.code}`, `m:cd:${c.code}`)]), [b('➕ کد جدید', 'm:f:coupon')],
      [b('🎁 درصد پاداش دعوت', 'm:sk:referral_percent')], nav('home')],
  };
}

// ---------------- payments + settings ----------------
export const AUTO_FA = { auto: 'خودکار', detect: 'فقط خبر بده', off: 'خاموش' };

export async function payments(env) {
  const s = await getSettings(env);
  const card = String(s.card_number || '');
  const mode = (key) => ['auto', 'detect', 'off'].map((v) => b(`${s[key] === v ? '✅ ' : ''}${AUTO_FA[v]}`, `m:sv:${key}:${v}`));
  return {
    text: [crumb('💳 روش‌های پرداخت'), '',
      `💳 کارت: ${card ? card.replace(/(\d{4})(?=\d)/g, '$1-') : 'ثبت نشده'}${s.card_holder ? ` · ${s.card_holder}` : ''}`,
      `🏦 تأیید کارت‌به‌کارت با پیامک: ${AUTO_FA[s.card_auto] || s.card_auto}`,
      `💎 تأیید ارز دیجیتال روی بلاک‌چین: ${AUTO_FA[s.coin_auto] || s.coin_auto}`, '',
      'خودکار = خودش فعال می‌کند · فقط خبر بده = تو تأیید کنی · خاموش = همه دستی'].join('\n'),
    kb: [
      [b('💳 شماره کارت', 'm:w:set:card_number'), b('👤 نام صاحب کارت', 'm:w:set:card_holder')],
      [b('— پیامک بانک —', 'm:pay')], mode('card_auto'),
      [b('— ارز دیجیتال —', 'm:pay')], mode('coin_auto'),
      [b('💎 ولت‌ها', 'm:wl'), b('💵 قیمت دلار', 'm:x:pay|/rate')],
      [b('📩 راه‌اندازی پیامک بانک', 'm:x:pay|/sms'), b('📋 ولت‌ها و قیمت‌ها', 'm:x:pay|/wallets')],
      nav('home'),
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
export const keyParent = (key) => (key.startsWith('wallet_') ? 'wl' : APP_KEYS.includes(key) ? 'app' : key === 'referral_percent' ? 'cp' : 'set');

const keyRows = (s, keys, label) => {
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) rows.push(keys.slice(i, i + 2).map((k) => b(`${s[k] ? '' : '⚪️ '}${label(k)}`, `m:sk:${k}`)));
  return rows;
};

export async function settings(env, wallets) {
  const s = await getSettings(env);
  const keys = Object.keys(SETTING_DEFAULTS).filter((k) => k.startsWith('wallet_') === !!wallets);
  return {
    text: wallets ? `${crumb('💳 روش‌های پرداخت', '💎 ولت‌ها')}\n\n⚪️ = خالی (آن ارز در اپ نشان داده نمی‌شود). روی هر کدام بزن.`
      : `${crumb('🛡 سیستم', '⚙️ همه‌ی تنظیمات')}\n\nروی هر مورد بزن تا مقدارش را ببینی یا عوض کنی. (⚪️ = خالی)`,
    kb: [...keyRows(s, keys, (k) => (wallets ? k.slice(7) : (KEY_FA[k] || k))), nav(wallets ? 'pay' : 'sys')],
  };
}

export async function settingKey(env, key, extraRows = []) {
  if (!(key in SETTING_DEFAULTS)) return { text: crumb('⚙️ تنظیمات') + '\n\nکلید ناشناخته.', kb: [nav('set')] };
  const s = await getSettings(env);
  const val = key === 'sms_key' && s[key] ? '••• (مخفی)' : s[key] || '(خالی)';
  return {
    text: `${crumb('⚙️', KEY_FA[key] || key)}\n\n⚙️ ${KEY_FA[key] || key}\n${key} = ${val}`,
    kb: [...extraRows, [b('✏️ تغییر', `m:w:set:${key}`), b('🧹 خالی کن', `m:x:sk:${key}|/set ${key}`)], [b('📜 تاریخچه', `m:hist:setting:${key}`)], nav(keyParent(key))],
  };
}

// ---------------- Pleat app, network ----------------
export async function app(env) {
  const s = await getSettings(env);
  const bases = String(s.app_api_bases || '').split(/[\s,]+/).filter(Boolean).length;
  const bridges = String(s.app_bridges || '').split(/\s+/).filter(Boolean).length;
  return {
    text: [crumb('📱 اپ Pleat'), '', `📢 اطلاعیه: ${s.announcement ? s.announcement.slice(0, 80) : '—'}`, `🛟 پشتیبانی: ${s.support_url || '—'}`,
      `🌐 دامنه‌های اضافه: ${fa(bases)} · 🌉 لینک پل: ${fa(bridges)}`, `🎁 حجم تست رایگان: ${s.trial_data_gb === '0' ? 'مثل پلن' : s.trial_data_gb + ' گیگ'}`, '',
      'روی هر مورد بزن تا عوضش کنی. ویرایش لیستی دامنه‌ها و پل‌ها با تست، در مرحله‌ی ۴ اضافه می‌شود.'].join('\n'),
    kb: [...keyRows(s, APP_KEYS, (k) => KEY_FA[k] || k), nav('home')],
  };
}

export async function net() {
  return {
    text: `${crumb('📶 شبکه و رتبه‌بندی')}\n\nکدام سرور روی کدام اپراتور بهتر است، وضعیت سرورها از دید گوگل، و تجربه‌ی هر کاربر.`,
    kb: [[b('📶 اپراتورها و بهترین سرورها', 'm:x:net|/carriers')], [b('🔎 وضعیت از دید گوگل', 'm:x:net|/google')],
      [b('👥 کاربران و اپراتورهایشان', 'm:un')], nav('home')],
  };
}

export const soon = (title) => ({ text: `${crumb(title)}\n\n${SOON}`, kb: [nav('home')] });

// ---------------- stats, system, admin log ----------------
export async function stats(env) {
  return { text: `${crumb('📊 آمار')}\n\n${await statsText(env)}`, kb: [[b('🔄 به‌روزرسانی', 'm:st')], nav('home')] };
}

export const help = () => ({ text: `${crumb('🛡 سیستم', '❓ راهنما')}\n\n${HELP}`, kb: [nav('sys')] });

export async function system() {
  return {
    text: `${crumb('🛡 سیستم')}\n\nلاگ همه‌ی تغییرات مدیر (با برگرداندن تا ۱۰ دقیقه)، پشتیبان، همه‌ی تنظیمات و راهنما.`,
    kb: [[b('📜 لاگ مدیر', 'm:sys.log'), b('💾 پشتیبان', 'm:x:sys|/backup')], [b('⚙️ همه‌ی تنظیمات', 'm:set'), b('❓ راهنما', 'm:help')], nav('home')],
  };
}

const TARGET_FA = { plan: '📦 پلن', panel: '🗂 پنل', setting: '⚙️', user: '👤 کاربر', coupon: '🏷 کد' };
const when = (t) => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');

function logScreen(pg, title, route, back) {
  const now = nowSec();
  const lines = pg.rows.map((r) => `#${r.id} · ${when(r.created_at)} · ${r.action}${r.target_type ? ` · ${TARGET_FA[r.target_type] || r.target_type} ${r.target_id || ''}` : ''}${r.summary ? `\n   ${r.summary}` : ''}${r.undone_at ? ' ↩️' : ''}`);
  const undo = pg.rows.filter((r) => canUndo(r, now)).slice(0, 4).map((r) => b(`↩️ برگردان #${r.id}`, `m:undo:${r.id}`));
  return {
    text: `${title}\n\n${lines.join('\n') || 'هنوز چیزی ثبت نشده.'}${undo.length ? '\n\n↩️ تغییرهای ساده تا ۱۰ دقیقه برمی‌گردند.' : ''}`,
    kb: [...(undo.length ? [undo.slice(0, 2), undo.slice(2)].filter((r) => r.length) : []), ...pageRow(route, pg), nav(back)],
  };
}

export async function auditLog(env, cursor) {
  const pg = await page(env, { from: 'admin_audit', cursor });
  return logScreen(pg, crumb('🛡 سیستم', '📜 لاگ مدیر'), 'sys.log', 'sys');
}

// one plan / panel / setting / user: its own changes ("history")
const HIST_BACK = { plan: (id) => `p:${id}`, panel: (id) => `pp:${id}`, setting: (id) => `sk:${id}`, user: (id) => `u:${id}` };
export async function history(env, type, id, cursor) {
  if (!HIST_BACK[type] || !/^[\w.-]{1,40}$/.test(String(id || ''))) return soon('📜 تاریخچه');
  const pg = await page(env, { from: 'admin_audit', where: 'target_type = ? AND target_id = ?', args: [type, String(id)], cursor });
  return logScreen(pg, crumb('📜 تاریخچه', `${TARGET_FA[type] || type} ${id}`), `hist:${type}:${id}`, HIST_BACK[type](id));
}
