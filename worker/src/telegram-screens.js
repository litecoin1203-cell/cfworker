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

export async function users(env, cursor) {
  const count = (await first(env, 'SELECT COUNT(*) c FROM users')).c;
  const pg = await page(env, { select: 'id, email, tg_id, tg_username, is_active', from: 'users', cursor });
  return {
    text: `${crumb('👤 کاربران')}\n\n${fa(count)} کاربر · جدیدترها اول. برای پیدا کردن یک نفر «جستجو» را بزن.`,
    kb: [[b('🔎 جستجوی کاربر', 'm:w:find')], ...pg.rows.map((u) => [b(`${u.is_active ? '' : '⛔️ '}${who(u)}`, `m:u:${u.id}`)]), ...pageRow('usr', pg), nav('home')],
  };
}

export const userKb = (uid) => ({ inline_keyboard: [
  [b('🎁 دادن پلن', `m:ug:${uid}`), b('🔑 تغییر رمز', `m:w:reset:${uid}`)],
  [b('🔗 وصل اکانت پنل', `m:w:link:${uid}`), b('📶 تجربه اتصال', `m:un:${uid}`)],
  [b('🔄 به‌روزرسانی', `m:u:${uid}`), b('📜 تاریخچه', `m:hist:user:${uid}`)],
  [b('🔙 کاربران', 'm:usr'), HOME],
] });

export async function userCard(env, id) {
  const u = await first(env, 'SELECT * FROM users WHERE id = ?', id);
  if (!u) return { text: crumb('👤 کاربران') + '\n\nکاربر پیدا نشد.', kb: [nav('usr')] };
  return { text: `${crumb('👤 کاربران', who(u))}\n\n${await userInfo(env, u)}`, kb: userKb(u.id).inline_keyboard };
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
