// The admin bot's router and UI kit. Every admin job is reachable from inline buttons; nothing needs typing
// except the answer to a question the bot asks (a name, a number, an email).
//
// Callback data: "m:<route>[:args]", at most 64 bytes. <route> is a screen ("pl", "p", "sys.log"...) or an
// action ("pt", "sv", "undo"...); ROUTES says which, and for actions how risky they are:
//   reversible  -> done at once, the card comes back with an ↩️ undo button (10 minutes, once)
//   money       -> a one-time "are you sure?" first (bot_confirm, 2 minutes)
//   destructive -> the same, and the question says what it affects
// Screens live in telegram-screens.js (read only); writes go through admin-actions.js.
//
// Questions and multi-step forms keep their state in bot_session (one row per admin chat, 10 minutes).
// Taking it is one DELETE ... RETURNING, so an answer is never used twice, and a form remembers the last
// message id it consumed so a message Telegram delivers twice does not move the form two steps.
import { first, all, run } from './db.js';
import { nowSec, hashPassword } from './util.js';
import { tg, runAdminCommand, askConfirm, askUnlinkConfirm } from './telegram.js';
import * as S from './telegram-screens.js';
import { runAction, undoAction, checkEmail, maskBridge, AUDIENCES, BROADCAST_MAX, ROLE_FA, audienceCount } from './admin-actions.js';

const { b, HOME, nav } = S;
const fa = S.fa;
const SESSION_SECONDS = 600;
export const CRED_PROMPT = ['🔐 آدرس پنل، یوزرنیم و رمز ادمین را در یک پیام بفرست، با فاصله یا هر کدام در یک خط:',
  'https://panel.example.com:8000/dashboard/', 'admin', 'رمز', '',
  'پیامت بلافاصله از چت پاک می‌شود و رمز به‌صورت رمزنگاری‌شده ذخیره می‌شود.'].join('\n');

export const backKb = (back) => ({ inline_keyboard: [back && back !== 'home' ? [b('🔙 برگشت', 'm:' + back), HOME] : [HOME]] });
export const userKb = S.userKb;
export const undoRows = (r) => (r && r.undoable ? [[b('↩️ برگردان', `m:undo:${r.auditId}`)]] : []);

// ---------------- session (question / form state) ----------------
const owner = (env, adminId) => String(adminId || env.TELEGRAM_CHAT_ID || '');

export async function setSession(env, adminId, { flow, step = 0, data = {}, back = 'home', secret = false }) {
  await run(env, `INSERT INTO bot_session (admin_id, flow, step, data_json, back, secret, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(admin_id) DO UPDATE SET flow = excluded.flow, step = excluded.step, data_json = excluded.data_json, back = excluded.back,
      secret = excluded.secret, expires_at = excluded.expires_at`,
  owner(env, adminId), flow, step, JSON.stringify(data), back, secret ? 1 : 0, nowSec() + SESSION_SECONDS);
}

// Reads and clears the session in one statement; an expired one counts as none.
export async function takeSession(env, adminId) {
  const row = await first(env, 'DELETE FROM bot_session WHERE admin_id = ? RETURNING *', owner(env, adminId));
  if (!row || row.expires_at < nowSec()) return null;
  let data = {};
  try { data = JSON.parse(row.data_json || '{}'); } catch (e) { return null; }
  return { flow: row.flow, step: row.step, data, back: row.back, secret: !!row.secret };
}
const putBack = (env, adminId, s) => setSession(env, adminId, s);

// "write your answer": the next plain message becomes "<cmd> <text>" (the old text commands keep their checks)
export const setWait = (env, cmd, back, secret, adminId) => setSession(env, adminId, { flow: 'ask', data: { cmd }, back, secret });
export async function takeWait(env, adminId) {
  const s = await takeSession(env, adminId);
  return s && s.flow === 'ask' ? { cmd: s.data.cmd, back: s.back, secret: s.secret } : null;
}

// ---------------- forms ----------------
const digits = (v) => String(v || '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[,،٬\s]/g, '');
const int = (min, max = Infinity) => (v) => { const s = digits(v); if (!/^\d{1,12}$/.test(s)) return null; const n = parseInt(s, 10); return n >= min && n <= max ? n : null; };
const opt = (label, value) => [label, String(value)];
const unlimited = (n) => (n ? fa(n) : 'نامحدود');

export const FORMS = {
  newplan: {
    title: '➕ پلن جدید', back: 'pl', action: 'plan.create',
    steps: [
      { key: 'name', ask: 'نام پلن را بنویس (مثلاً: سه ماهه):', hint: 'نام باید ۱ تا ۶۰ حرف باشد.', parse: (v) => { const t = String(v || '').trim(); return t && t.length <= 60 ? t : null; } },
      { key: 'days', ask: 'چند روزه است؟', hint: 'یک عدد بزرگ‌تر از صفر بنویس.', parse: int(1, 3650), suggest: [opt('30', 30), opt('90', 90), opt('180', 180), opt('365', 365)] },
      { key: 'gb', ask: 'حجم چند گیگ است؟', hint: 'یک عدد بنویس (0 = نامحدود).', parse: int(0, 100000), suggest: [opt('نامحدود', 0), opt('10', 10), opt('50', 50), opt('100', 100)] },
      { key: 'devices', ask: 'چند دستگاه هم‌زمان؟', hint: 'یک عدد بنویس (0 = نامحدود).', parse: int(0, 100), suggest: [opt('نامحدود', 0), opt('1', 1), opt('2', 2), opt('3', 3)] },
      { key: 'price', ask: 'قیمت به تومان را بنویس (مثلاً 199000):', hint: 'فقط عدد بنویس، به تومان.', parse: int(0, 1e10) },
    ],
    summary: (d) => [`نام: ${d.name}`, `مدت: ${fa(d.days)} روز`, `حجم: ${unlimited(d.gb)} گیگ`, `دستگاه: ${unlimited(d.devices)}`, `قیمت: ${fa(d.price)} تومان`],
    done: (r) => `p:${r.targetId}`,
  },
  coupon: {
    title: '➕ کد تخفیف جدید', back: 'cp', action: 'coupon.create',
    steps: [
      { key: 'code', ask: 'خود کد را بنویس (حروف انگلیسی، عدد، _ یا -؛ مثلاً YALDA):', hint: 'کد باید ۲ تا ۳۲ حرف انگلیسی یا عدد باشد.',
        parse: async (v, env) => { const c = String(v || '').trim().toUpperCase(); if (!/^[A-Z0-9_-]{2,32}$/.test(c)) return null; return (await first(env, 'SELECT 1 x FROM coupons WHERE code = ?', c)) ? undefined : c; },
        taken: 'این کد قبلاً ساخته شده؛ یک کد دیگر بنویس.' },
      { key: 'percent', ask: 'چند درصد تخفیف؟', hint: 'عددی از 1 تا 100 بنویس.', parse: int(1, 100), suggest: [opt('10٪', 10), opt('20٪', 20), opt('30٪', 30), opt('50٪', 50)] },
      { key: 'uses', ask: 'چند بار قابل استفاده است؟', hint: 'یک عدد بنویس (0 = نامحدود).', parse: int(0, 1e6), suggest: [opt('نامحدود', 0), opt('10', 10), opt('100', 100), opt('1000', 1000)] },
      { key: 'days', ask: 'تا چند روز معتبر است؟', hint: 'یک عدد بنویس (0 = همیشه).', parse: int(0, 3650), suggest: [opt('همیشه', 0), opt('7 روز', 7), opt('30 روز', 30)] },
      { key: 'planId', ask: 'برای کدام پلن؟', hint: 'یکی از دکمه‌ها را بزن.',
        parse: async (v, env) => { const n = int(0)(v); if (n === 0) return 0; return n && (await first(env, 'SELECT 1 x FROM plans WHERE id = ?', n)) ? n : null; },
        suggest: async (env) => [opt('همه‌ی پلن‌ها', 0), ...(await all(env, 'SELECT id, name FROM plans WHERE is_active = 1 AND archived = 0 ORDER BY sort, id LIMIT 7')).map((p) => opt(p.name.slice(0, 24), p.id))] },
    ],
    summary: (d) => [`کد: ${d.code}`, `تخفیف: ${d.percent}٪`, `تعداد: ${unlimited(d.uses)}`, `اعتبار: ${d.days ? fa(d.days) + ' روز' : 'همیشه'}`, `پلن: ${d.planId ? '#' + d.planId : 'همه'}`],
    done: () => 'cp',
  },

  // ---- one coupon (m:f:<form>:<couponId>): a typed value for one field ----
  cpct: couponForm('p', '٪ درصد تخفیف', 'چند درصد تخفیف؟', 'عددی از 1 تا 100 بنویس.', int(1, 100), (v) => `${v}٪`),
  cuses: couponForm('u', '🔢 تعداد استفاده', 'چند بار قابل استفاده باشد؟ (0 = نامحدود)', 'یک عدد بنویس (0 = نامحدود).', int(0, 1e6), unlimited),
  cdays: couponForm('d', '⏳ مهلت', 'از امروز چند روز معتبر باشد؟ (0 = همیشه)', 'یک عدد از 0 تا 3650 بنویس.', int(0, 3650), (v) => (v ? `${fa(v)} روز` : 'همیشه')),

  // ---- one user (the user id comes from the button: m:f:<form>:<uid>) ----
  adddays: {
    title: '➕ روز دلخواه', ok: '✅ انجام شود', back: (d) => `us:${d.userId}`, action: 'user.add_days',
    steps: [{ key: 'days', ask: 'چند روز به این اشتراک اضافه شود؟', hint: 'یک عدد از 1 تا 3650 بنویس.', parse: int(1, 3650), suggest: [opt('15', 15), opt('60', 60), opt('180', 180), opt('365', 365)] }],
    summary: (d) => [`کاربر: #${d.userId}`, `روز اضافه: ${fa(d.days)}`],
    done: (r, d) => `us:${d.userId}`,
  },
  addgb: {
    title: '➕ حجم دلخواه', ok: '✅ انجام شود', back: (d) => `us:${d.userId}`, action: 'user.add_gb',
    steps: [{ key: 'gb', ask: 'چند گیگ به این اشتراک اضافه شود؟', hint: 'یک عدد از 1 تا 100000 بنویس.', parse: int(1, 100000), suggest: [opt('20', 20), opt('100', 100), opt('200', 200)] }],
    summary: (d) => [`کاربر: #${d.userId}`, `حجم اضافه: ${fa(d.gb)} گیگ`],
    done: (r, d) => `us:${d.userId}`,
  },
  wadd: walletForm(1),
  wsub: walletForm(-1),
  email: {
    title: '✏️ تغییر ایمیل', ok: '✅ انجام شود', back: (d) => `usec:${d.userId}`, action: 'user.email',
    steps: [{ key: 'email', ask: 'ایمیل جدید این کاربر را بنویس:', hint: 'این ایمیل درست نیست.', parse: emailParse }],
    summary: (d) => [`کاربر: #${d.userId}`, `ایمیل جدید: ${d.email}`],
    done: (r, d) => `usec:${d.userId}`,
  },
  // ---- panels, servers, the app's lists (stage 4) ----
  pnm: {
    title: '✏️ نام پنل', ok: '✅ انجام شود', back: (d) => `pp:${d.panelId}`, action: 'panel.rename',
    init: async (env, raw) => { const id = parseInt(raw, 10); return id > 0 && (await first(env, 'SELECT 1 x FROM panels WHERE id = ?', id)) ? { panelId: id } : null; },
    steps: [{ key: 'label', ask: 'نام تازه‌ی پنل را بنویس (فقط برای تو در ربات است، کاربر نمی‌بیند):', hint: 'نام باید ۱ تا ۴۰ حرف باشد.',
      parse: (v) => { const t = String(v || '').trim().replace(/\s+/g, ' '); return t && t.length <= 40 ? t : null; } }],
    summary: (d) => [`پنل: #${d.panelId}`, `نام تازه: ${d.label}`],
    done: (r, d) => `pp:${d.panelId}`,
  },
  srn: {
    title: '✏️ نام سرور در اپ', ok: '✅ انجام شود', back: (d) => `srv:${d.panelId}:${d.key}`, action: 'server.rename',
    init: async (env, raw) => {
      const [pid, key] = String(raw || '').split('.');
      const id = parseInt(pid, 10);
      return id > 0 && /^[a-z0-9]{6,16}$/.test(key || '') && (await first(env, 'SELECT 1 x FROM panels WHERE id = ?', id)) ? { panelId: id, key } : null;
    },
    steps: [{ key: 'label', ask: 'نامی که کاربرها در اپ می‌بینند را بنویس. اپ انگلیسی است: حروف انگلیسی، عدد و ایموجی پرچم (مثلاً 🇩🇪 Germany Fast):',
      hint: 'نام باید ۱ تا ۴۰ حرف انگلیسی، عدد یا ایموجی باشد؛ حرف فارسی و # " < > قبول نمی‌شود.',
      parse: async (v) => { const { cleanServerLabel } = await import('./panels.js'); return cleanServerLabel(v); } }],
    summary: (d) => [`پنل: #${d.panelId}`, `نام در اپ: ${d.label}`],
    done: (r, d) => `srv:${d.panelId}:${d.key}`,
  },
  appd: {
    title: '➕ دامنه‌ی اضافه برای اپ', ok: '✅ اضافه شود', back: 'appl:d', action: 'app.list',
    steps: [{ key: 'v', ask: 'آدرس دامنه را بنویس، فقط https و بدون مسیر (مثلاً https://api2.example.com):', hint: 'آدرس درست نیست: فقط https:// و نام دامنه، بدون مسیر یا فاصله.',
      parse: async (v) => (await import('./admin-actions.js')).cleanBase(v) }],
    summary: (d) => [`دامنه: ${d.v}`],
    args: (d) => ({ k: 'd', op: 'add', value: d.v }),
    done: () => 'appl:d',
  },
  appb: {
    title: '➕ پل برای اپ', ok: '✅ اضافه شود', back: 'appl:b', action: 'app.list',
    steps: [{ key: 'v', secret: true, ask: 'کانفیگ پل را بفرست (vless:// یا vmess:// یا trojan:// یا ss:// یا hysteria2:// یا wireguard://).\nپیامت بلافاصله از چت پاک می‌شود و لینک کامل جایی نشان داده نمی‌شود.',
      hint: 'کانفیگ درست نیست؛ باید یک لینک کامل با یکی از این شروع‌ها باشد: vless:// vmess:// trojan:// ss:// hysteria2:// wireguard://',
      parse: async (v) => (await import('./admin-actions.js')).cleanBridge(v) }],
    summary: (d) => [`پل: ${maskBridge(d.v)}`],
    args: (d) => ({ k: 'b', op: 'add', value: d.v }),
    done: () => 'appl:b',
  },
  newuser: {
    title: '➕ کاربر دستی', back: 'usr', action: 'user.create', ok: '✅ ساخته شود',
    steps: [
      { key: 'email', ask: 'ایمیل کاربر جدید را بنویس:', hint: 'این ایمیل درست نیست.', parse: emailParse },
      { key: 'hash', secret: true, ask: 'یک رمز برای او بنویس (حداقل ۸ کاراکتر).\nپیامت بلافاصله از چت پاک می‌شود و فقط به‌صورت هش ذخیره می‌شود.', hint: 'رمز باید ۸ تا ۱۲۸ کاراکتر باشد.',
        parse: async (v, env) => { const t = String(v || ''); return t.length >= 8 && t.length <= 128 ? hashPassword(t, env.SECRET_KEY) : null; } },
    ],
    summary: (d) => [`ایمیل: ${d.email}`, 'رمز: ••••••••'],
    done: (r) => `u:${r.targetId}`,
  },
  // ---- broadcast, admins (stage 5) ----
  // fok saves a draft, sends the text to this admin alone as a preview, then asks "are you sure?" with the count
  bcast: {
    title: '📣 پیام همگانی جدید', back: 'bc', action: 'broadcast.create', ok: '👁 پیش‌نمایش و ادامه', broadcast: true,
    steps: [
      { key: 'audience', ask: 'این پیام به چه کسانی برود؟ (فقط کسانی که با تلگرام وارد اپ شده‌اند پیام را می‌گیرند)', hint: 'یکی از دکمه‌ها را بزن.',
        parse: (v) => (AUDIENCES[v] ? v : null),
        suggest: async (env) => { const out = []; for (const [k, a] of Object.entries(AUDIENCES)) out.push(opt(`${a.fa} (${fa(await audienceCount(env, k))})`, k)); return out; } },
      { key: 'text', ask: `متن پیام را بنویس (حداکثر ${fa(BROADCAST_MAX)} حرف). همان‌طور که نوشتی، بدون قالب‌بندی و بدون دکمه فرستاده می‌شود.`,
        hint: `متن باید ۱ تا ${fa(BROADCAST_MAX)} حرف باشد.`, parse: (v) => { const t = String(v ?? '').trim(); return t && t.length <= BROADCAST_MAX ? t : null; } },
    ],
    summary: (d) => [`گیرنده‌ها: ${AUDIENCES[d.audience] ? AUDIENCES[d.audience].fa : '-'}`, `متن: ${fa(String(d.text || '').length)} حرف`, '', 'بعد از این دکمه، پیش‌نمایش فقط برای خودت فرستاده می‌شود.'],
    done: (r) => `bcv:${r.targetId}`,
  },
  addadm: {
    title: '➕ مدیر جدید', back: 'sys.adm', action: 'admin.add', ok: '✅ اضافه شود',
    steps: [
      { key: 'tgId', ask: 'آیدی عددی تلگرام آن شخص را بنویس (خودش با فرستادن /id به همین ربات آن را می‌بیند):', hint: 'آیدی باید ۵ تا ۱۵ رقم باشد و آیدی خود مالک نباشد.',
        parse: (v, env) => { const s = digits(v); return /^\d{5,15}$/.test(s) && s !== String(env.TELEGRAM_CHAT_ID || '') ? s : null; } },
      { key: 'role', ask: 'چه دسترسی داشته باشد؟\n🧾 پشتیبان: فقط کارهای منتظر و تأیید / رد رسیدها\n👁 فقط دیدن: همه‌ی صفحه‌ها را می‌بیند، چیزی را عوض نمی‌کند', hint: 'یکی از دکمه‌ها را بزن.',
        parse: (v) => (['support', 'viewer'].includes(v) ? v : null), suggest: [opt('🧾 پشتیبان', 'support'), opt('👁 فقط دیدن', 'viewer')] },
    ],
    summary: (d) => [`آیدی: ${d.tgId}`, `نقش: ${ROLE_FA[d.role] || '-'}`],
    done: () => 'sys.adm',
  },
};

// ---------------- roles ----------------
// owner: everything. support: the inbox, orders (read) and approving / rejecting receipts. viewer: screens only.
// Checked on every tap in telegram.js (allowedTap) and again in the write layer; buttons a role may not press are
// also taken off its screens (forRole).
const SUPPORT_ROUTES = new Set(['home', 'in', 'ord', 'o', 'or', 'oap', 'orj', 'orc', 'cancel', 'help']);
const VIEWER_HIDDEN = new Set(['sk', 'set', 'wl', 'sys.adm']); // setting values and the admin list stay with the owner
export function allowedTap(role, data) {
  const d = String(data || '');
  if (role === 'owner') return true;
  if (role !== 'support' && role !== 'viewer') return false;
  if (/^(cf|cx):[0-9a-f]{18}$/.test(d)) return true; // onConfirm checks what is being confirmed
  if (role === 'support' && /^(ap|rj|rp):\d{1,12}$/.test(d)) return true;
  if (!d.startsWith('m:') || !routeOf(d)) return false;
  const route = d.slice(2).split(':')[0];
  if (role === 'support') return SUPPORT_ROUTES.has(route);
  return route === 'cancel' || (ROUTES[route].kind === 'screen' && !VIEWER_HIDDEN.has(route));
}
export function forRole(role, kb) {
  if (!role || role === 'owner') return kb;
  const rows = (kb || []).map((row) => row.filter((x) => x.url || x.web_app || allowedTap(role, x.callback_data))).filter((row) => row.length);
  return rows.length ? rows : [[HOME]];
}

function couponForm(field, title, ask, hint, parse, show) {
  return {
    title, ok: '✅ انجام شود', param: 'couponId', back: (d) => `c:${d.couponId}`, action: 'coupon.set',
    steps: [{ key: 'v', ask, hint, parse }],
    summary: (d) => [`کد: #${d.couponId}`, `${title}: ${show(d.v)}`],
    args: (d) => ({ id: d.couponId, field, value: d.v }),
    done: (r, d) => `c:${d.couponId}`,
  };
}

// a real, free email; a taken or invalid one gets its own message
async function emailParse(v, env) {
  const e = await checkEmail(env, v);
  return e.error ? { error: e.error } : e.email;
}

// credit (+1) or debit (-1): amount, then a reason that goes into the wallet history; money -> asks once more
function walletForm(sign) {
  return {
    title: sign > 0 ? '➕ شارژ کیف پول' : '➖ کسر از کیف پول', back: (d) => `uw:${d.userId}`, action: 'user.wallet', confirm: 'u_wallet', ok: '✅ ادامه',
    steps: [
      { key: 'amount', ask: `چند تومان ${sign > 0 ? 'شارژ' : 'کسر'} شود؟`, hint: 'فقط عدد بنویس، به تومان (مثلاً 50000).', parse: int(1, 1e10),
        suggest: [opt('10,000', 10000), opt('50,000', 50000), opt('100,000', 100000), opt('200,000', 200000)] },
      { key: 'note', ask: 'دلیلش را بنویس (در تاریخچه‌ی کیف پول می‌ماند):', hint: 'دلیل باید ۲ تا ۲۰۰ حرف باشد.',
        parse: (v) => { const t = String(v || '').trim(); return t.length >= 2 && t.length <= 200 ? t : null; },
        suggest: sign > 0 ? [opt('جبران قطعی', 'جبران قطعی'), opt('هدیه', 'هدیه'), opt('اصلاح اشتباه', 'اصلاح اشتباه')] : [opt('اصلاح اشتباه', 'اصلاح اشتباه'), opt('بازگشت وجه', 'بازگشت وجه')] },
    ],
    summary: (d) => [`کاربر: #${d.userId}`, `${sign > 0 ? 'شارژ' : 'کسر'}: ${fa(d.amount)} تومان`, `دلیل: ${d.note}`],
    args: (d) => ({ userId: d.userId, amount: sign * d.amount, note: d.note }),
    done: (r, d) => `uw:${d.userId}`,
  };
}
const backOf = (f, d) => (typeof f.back === 'function' ? f.back(d || {}) : f.back);
const secretAt = (f, step) => !!(f.steps[step] && f.steps[step].secret);

async function formScreen(env, name, s, note) {
  const f = FORMS[name];
  const cancel = [b('❌ انصراف', `m:cancel:${backOf(f, s.data)}`)];
  if (s.step >= f.steps.length) {
    return { text: [`${f.title} — بازبینی`, '', ...f.summary(s.data), '', 'درست است؟'].join('\n'),
      kb: [[b(f.ok || '✅ ساخته شود', `m:fok:${name}`)], cancel] };
  }
  const st = f.steps[s.step];
  const sug = typeof st.suggest === 'function' ? await st.suggest(env) : st.suggest || [];
  const rows = [];
  for (let i = 0; i < sug.length; i += 4) rows.push(sug.slice(i, i + 4).map(([label, v]) => b(label, `m:fa:${s.step}:${v}`)));
  return { text: [`${f.title} — مرحله ${s.step + 1} از ${f.steps.length}`, ...(note ? ['', note] : []), '', st.ask, '', '(تا ۱۰ دقیقه منتظر جوابت هستم)'].join('\n'),
    kb: [...rows, cancel] };
}

// One answer (typed or a suggestion button) for the open form. Returns the screen to show next.
async function formAnswer(env, adminId, s, value, msgId) {
  const f = FORMS[s.flow];
  if (msgId && s.data._msg === msgId) { await putBack(env, adminId, s); return null; } // the same message again
  if (msgId) s.data._msg = msgId;
  if (s.step >= f.steps.length) { await putBack(env, adminId, s); return formScreen(env, s.flow, s); }
  const st = f.steps[s.step];
  const v = await st.parse(value, env);
  if (v === null || v === undefined || (typeof v === 'object' && v.error)) {
    await putBack(env, adminId, s);
    return formScreen(env, s.flow, s, '❌ ' + (v && v.error ? v.error : v === undefined && st.taken ? st.taken : st.hint));
  }
  s.data[st.key] = v;
  s.step += 1;
  s.secret = secretAt(f, s.step); // the next answer is a password: telegram.js deletes it from the chat
  await putBack(env, adminId, s);
  return formScreen(env, s.flow, s);
}

// a typed answer for a form (telegram.js already took the session)
export async function formText(env, chatId, s, text, msg) {
  if (!FORMS[s.flow]) return;
  const scr = await formAnswer(env, chatId, s, text, msg && msg.message_id);
  if (scr) return tg(env, 'sendMessage', { chat_id: chatId, text: scr.text, reply_markup: { inline_keyboard: scr.kb } });
}

// ---------------- route table ----------------
// screen routes: (env, args) -> {text, kb}
const SCREENS = {
  home: (env) => S.home(env),
  in: (env) => S.inbox(env),
  usr: (env, a) => S.users(env, a[0], a[1]),
  u: (env, a) => S.userCard(env, parseInt(a[0], 10), a[1]),
  us: (env, a) => S.userSub(env, parseInt(a[0], 10)),
  upl: (env, a) => S.userPlanPick(env, parseInt(a[0], 10)),
  uw: (env, a) => S.userWallet(env, parseInt(a[0], 10), a[1]),
  udv: (env, a) => S.userDevices(env, parseInt(a[0], 10)),
  usec: (env, a) => S.userSecurity(env, parseInt(a[0], 10)),
  uo: (env, a) => S.userOrders(env, parseInt(a[0], 10), a[1]),
  o: (env, a) => S.order(env, parseInt(a[0], 10)),
  or: (env, a) => S.orders(env, a[0], a[1], a[2]),
  un: (env, a) => S.userNets(env, parseInt(a[0], 10) || 0),
  uac: (env, a) => S.userPanels(env, parseInt(a[0], 10)), // not upa: that is the app-update announce button
  pl: (env) => S.plans(env),
  p: (env, a) => S.plan(env, parseInt(a[0], 10)),
  pla: (env) => S.plansArchived(env),
  pa: (env) => S.panels(env),
  pp: (env, a) => S.panel(env, parseInt(a[0], 10)),
  cp: (env, a) => S.coupons(env, a[0]),
  c: (env, a) => S.coupon(env, parseInt(a[0], 10)),
  cpl: (env, a) => S.couponPlanPick(env, parseInt(a[0], 10)),
  cu: (env, a) => S.couponUses(env, parseInt(a[0], 10), a[1]),
  ref: (env) => S.referral(env),
  pay: (env) => S.payments(env),
  payset: (env) => S.paySettings(env),
  snd: (env) => S.senders(env),
  sms: (env, a) => S.smsLog(env, a[0], a[1]),
  set: (env) => S.settings(env, false),
  wl: (env) => S.settings(env, true),
  sk: (env, a) => S.settingKey(env, a[0]),
  app: (env) => S.app(env),
  net: () => S.net(),
  srvs: (env, a) => S.panelServerList(env, parseInt(a[0], 10)),
  ptn: (env, a) => S.panelTunnelDiag(env, parseInt(a[0], 10), a[1] === '1'),
  srv: (env, a) => S.panelServer(env, parseInt(a[0], 10), a[1]),
  appl: (env, a) => S.appList(env, a[0]),
  upd: (env) => S.appUpdate(env),
  mtp: (env) => S.miniProbe(env),
  nc: (env) => S.carriers(env),
  nca: (env, a) => S.carrier(env, parseInt(a[0], 10)),
  nsv: (env, a) => S.netServer(env, a[0]),
  ng: (env) => S.google(env),
  st: (env, a) => S.stats(env, a[0]),
  sys: () => S.system(),
  'sys.adm': (env) => S.admins(env),
  'sys.hl': (env) => S.health(env),
  'sys.log': (env, a) => S.auditLog(env, a[0]),
  help: () => S.help(),
  hist: (env, a) => S.history(env, a[0], a[1], a[2]),
  bc: (env, a) => S.broadcasts(env, a[0]),
  bcv: (env, a) => S.broadcast(env, parseInt(a[0], 10)),
  // Pleat's automatic health reports (health.js)
  hl: async (env) => (await import('./health.js')).screenHome(env),
  hlp: async (env, a) => (await import('./health.js')).screenPrio(env, parseInt(a[0], 10)),
  hlk: async (env, a) => (await import('./health.js')).screenServers(env, a[0] || ''),
  hlu: async (env, a) => (await import('./health.js')).screenUsers(env, parseInt(a[0], 10) || 0),
  hlv: async (env) => (await import('./health.js')).screenVersions(env),
  he: async (env, a) => (await import('./health.js')).screenEvent(env, a[0]),
  // ☁️ Cloudflare monitoring (cfmon.js)
  cf: async (env) => (await import('./cfmon.js')).overview(env),
  cfh: async (env) => (await import('./cfmon.js')).history(env),
  cfe: async (env) => (await import('./cfmon.js')).errors(env),
  cfq: async (env) => (await import('./cfmon.js')).queries(env),
  cfd: async (env) => (await import('./cfmon.js')).deploys(env),
  cfk: async (env) => (await import('./cfmon.js')).tokenHelp(env),
};
// action routes and how risky they are (see the top of this file)
const ACTION_RISK = {
  x: 'command', w: 'ask', f: 'form', fa: 'form', fok: 'form', cancel: 'read', ord: 'read',
  ug: 'read', ugp: 'money', pt: 'reversible', cd: 'destructive', sv: 'reversible', undo: 'reversible',
  // one user (stage 2)
  ud: 'reversible', ugb: 'reversible', upz: 'reversible', upn: 'reversible', ulo: 'reversible', ublk: 'reversible', uav: 'reversible',
  udd: 'reversible', urs: 'money', uend: 'destructive', utg: 'destructive', udel: 'destructive', uux: 'destructive',
  // sales (stage 3)
  oap: 'money', orf: 'money', orj: 'reversible', ocx: 'reversible', orc: 'read',
  pmv: 'reversible', pcp: 'reversible', pua: 'reversible', pdl: 'destructive',
  cs: 'reversible', ct: 'reversible', ss: 'reversible', sdel: 'reversible',
  // panels, servers, the app, network (stage 4)
  pen: 'reversible', sh: 'reversible', sl: 'reversible', apm: 'reversible', apr: 'reversible', apc: 'reversible', apt: 'read', nrs: 'destructive',
  upa: 'reversible', upf: 'reversible', upx: 'reversible',
  // broadcast, admins (stage 5)
  bcs: 'reversible', bcgo: 'destructive', adr: 'reversible',
  // Pleat health reports
  her: 'reversible', hem: 'reversible', hlm: 'reversible',
  // Cloudflare monitoring, panel sync by hand
  cfx: 'reversible', syr: 'reversible', syn: 'reversible',
};
// reversible user buttons: route -> [action, args from the button, the screen the card comes back on]
const USER_TAPS = {
  ud: (a) => ['user.add_days', { userId: a[0], days: a[1] }, `us:${a[0]}`],
  ugb: (a) => ['user.add_gb', { userId: a[0], gb: a[1] }, `us:${a[0]}`],
  upz: (a) => ['user.pause', { userId: a[0], on: a[1] }, `us:${a[0]}`],
  upn: (a) => ['user.plan_name', { userId: a[0], planId: a[1] }, `us:${a[0]}`],
  ulo: (a) => ['user.logout_all', { userId: a[0] }, `usec:${a[0]}`],
  ublk: (a) => ['user.block', { userId: a[0], on: a[1] }, `usec:${a[0]}`],
  uav: (a) => ['user.avatar_reset', { userId: a[0] }, `usec:${a[0]}`],
  udd: (a) => ['user.device_remove', { userId: a[0], deviceId: a[1] }, `udv:${a[0]}`],
  // sales (stage 3)
  orj: (a) => ['order.reject', { orderId: a[0] }, `o:${a[0]}`],
  ocx: (a) => ['order.cancel', { orderId: a[0] }, `o:${a[0]}`],
  pmv: (a) => ['plan.move', { id: a[0], dir: a[1] === 'u' ? 'u' : 'd' }, `p:${a[0]}`],
  pua: (a) => ['plan.unarchive', { id: a[0] }, `p:${a[0]}`],
  cs: (a) => ['coupon.set', { id: a[0], field: a[1], value: a[2] }, `c:${a[0]}`],
  ct: (a) => ['coupon.toggle', { id: a[0] }, `c:${a[0]}`],
  // panels, servers, the app's lists (stage 4)
  pen: (a) => ['panel.enable', { panelId: a[0] }, `pp:${a[0]}`],
  sh: (a) => ['server.hide', { panelId: a[0], key: a[1], on: a[2] === '1' }, `srv:${a[0]}:${a[1]}`],
  sl: (a) => ['server.rename', { panelId: a[0], key: a[1], label: '' }, `srv:${a[0]}:${a[1]}`],
  apm: (a) => ['app.list', { k: a[0], op: 'move', index: a[1], dir: 'u', tag: a[2] || '' }, `appl:${a[0]}`],
  apr: (a) => ['app.list', { k: a[0], op: 'remove', index: a[1], tag: a[2] || '' }, `appl:${a[0]}`],
  apc: (a) => ['setting.set', { key: ['announcement', 'support_url'].includes(a[0]) ? a[0] : '-', val: '' }, 'app'],
  // Pleat's in-app update
  upa: () => ['app.release', { op: 'announce' }, 'upd'],
  upf: () => ['app.release', { op: 'force' }, 'upd'],
  upx: () => ['app.release', { op: 'withdraw' }, 'upd'],
  // broadcast, admins (stage 5)
  bcs: (a) => ['broadcast.stop', { id: a[0] }, `bcv:${a[0]}`],
  adr: (a) => ['admin.remove', { tgId: a[0] }, 'sys.adm'],
  // Pleat health reports
  her: (a) => ['health.resolve', { fp: a[0] }, `he:${a[0]}`],
  hem: (a) => ['health.mute', { fp: a[0], on: a[1] === '1' }, `he:${a[0]}`],
  hlm: (a) => ['health.mode', { mode: a[0] }, 'hl'],
  // Cloudflare monitoring, panel sync
  cfx: () => ['cf.errors_clear', {}, 'cfe'],
  syr: () => ['sync.retry', {}, 'sys.hl'],
};
const GiB = 1024 ** 3;
// money / destructive user buttons: the "are you sure?" question, with what it affects
async function userQuestion(env, route, id) {
  const u = await first(env, `SELECT u.*, s.used_bytes, s.period_id, s.expires_at,
      (SELECT COUNT(*) FROM panel_accounts WHERE user_id = u.id AND desired != 'removed') pas, (SELECT COUNT(*) FROM orders WHERE user_id = u.id) ords
    FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id WHERE u.id = ?`, id);
  if (!u) return null;
  const name = u.tg_username ? `${u.email} (@${u.tg_username})` : u.email;
  if (route === 'urs') return ['u_reset', `مصرف این دوره‌ی ${name} (${((u.used_bytes || 0) / GiB).toFixed(2)} گیگ) صفر شود؟ همه‌ی پنل‌ها دوباره سقف کامل حجم را می‌گیرند. این کار برگشت ندارد.`];
  if (route === 'uend') return ['u_end', `اشتراک ${name} همین الان تمام شود؟ هر ${fa(u.pas)} اکانت پنلش خاموش می‌شود. برای برگرداندن باید دوباره روز اضافه کنی یا پلن بدهی.`];
  if (route === 'utg') {
    const tgOnly = /@telegram\.local$/.test(u.email);
    return ['u_tg', `تلگرام ${u.tg_username ? '@' + u.tg_username : u.tg_id} از حساب ${name} جدا شود؟${tgOnly ? '\n⚠️ این حساب ایمیل و رمز ندارد؛ بعد از جداکردن هیچ راهی برای ورود نمی‌ماند (مگر با «✏️ تغییر ایمیل» و «🔑 تغییر رمز»).' : ' بعد از آن فقط با ایمیل و رمز وارد می‌شود.'}`];
  }
  if (route === 'udel') {
    return ['u_del', [`کاربر ${name} حذف شود؟ این کار برگشت ندارد:`, `• ${fa(u.pas)} اکانت پنلش روی پنل خاموش می‌شود (پاک نمی‌شود) و از این کاربر جدا می‌شود؛ بعداً می‌توانی آن‌ها را به کاربر دیگری وصل کنی`, '• از همه‌ی دستگاه‌ها خارج می‌شود و دیگر نمی‌تواند وارد شود',
      '• ایمیل و تلگرامش آزاد می‌شود (می‌تواند دوباره ثبت‌نام کند)', `• ${fa(u.ords)} سفارش و تاریخچه‌ی کیف پول (موجودی ${fa(u.wallet_balance)} تومان) برای حساب‌رسی می‌ماند`].join('\n')];
  }
  return null;
}
export const ROUTES = Object.fromEntries([
  ...Object.keys(SCREENS).map((k) => [k, { kind: 'screen' }]),
  ...Object.entries(ACTION_RISK).map(([k, risk]) => [k, { kind: 'action', risk }]),
]);
// buttons that are not menu routes: receipts (ap/rj/rp), confirmations (cf/cx/lp), bank sender (ts)
const OTHER = /^(ap|rj|rp):\d+$|^(cf|cx):[0-9a-f]{18}$|^lp:[0-9a-f]{18}:\d+$|^ts:/;

// What a button's data leads to, or null when nothing would answer it.
export function routeOf(data) {
  const d = String(data || '');
  if (new TextEncoder().encode(d).length > 64) return null;
  if (OTHER.test(d)) return { kind: 'callback' };
  if (!d.startsWith('m:')) return null;
  const key = d.slice(2).split(':')[0];
  if (!ROUTES[key]) return null;
  if (key === 'x' && !/^m:x:[\w.:]+\|\/[a-z]+/.test(d)) return null;
  if (key === 'w' && !ASK[d.slice(4).split(':')[0]]) return null;
  if ((key === 'f' || key === 'fok') && !FORMS[d.split(':')[2]]) return null;
  return ROUTES[key];
}

// ---------------- questions the bot asks (one answer -> an old text command) ----------------
const PLAN_HINT = { price: 'قیمت به تومان', old: 'قیمت قبلی (خط‌خورده) به تومان، 0 = ندارد', days: 'تعداد روز', gb: 'حجم به گیگ، 0 = نامحدود',
  devices: 'تعداد دستگاه، 0 = نامحدود', trial: 'روزهای تست رایگان، 0 = ندارد', name: 'نام پلن', badge: 'نشان (مثلاً پیشنهاد ویژه)',
  desc: 'توضیح کوتاه پلن که در اپ زیر اسمش می‌آید' };

const ASK = {
  find: async () => ['/find', 'usr', '🔎 ایمیل، یوزرنیم تلگرام (@...) یا آیدی عددی تلگرام کاربر را بنویس:'],
  ofind: async () => ['/order', 'or', '🔎 شماره‌ی سفارش (مثلاً 125) یا کد پیگیری رسید / هش تراکنش را بنویس:'],
  reset: async (env, args) => {
    const u = await first(env, 'SELECT email FROM users WHERE id = ?', parseInt(args[0], 10));
    return u && [`/reset ${u.email}`, `u:${args[0]}`, `🔑 رمز جدید ${u.email} را بنویس (حداقل ۸ کاراکتر).\nپیامت بعد از خواندن پاک می‌شود.`, true];
  },
  link: async (env, args) => {
    const u = await first(env, 'SELECT email FROM users WHERE id = ?', parseInt(args[0], 10));
    return u && [`/link ${u.email}`, `u:${args[0]}`, `🔗 یوزرنیم اکانتی که ${u.email} روی پنل پاسارگاد دارد (همان که با v2rayNG استفاده می‌کند) را بنویس.\nاگر روی پنل ۱ نیست، بعد از یوزرنیم شماره‌ی پنل را هم بنویس، مثلاً: ali_v2 2\n\nروی پنل اکانت جدیدی ساخته نمی‌شود.`];
  },
  plan: async (env, args) => {
    const { PLAN_FIELDS } = await import('./admin-actions.js');
    const id = parseInt(args[0], 10);
    return args[1] in PLAN_FIELDS && [`/plan ${id} ${args[1]}`, `p:${id}`, `✏️ پلن #${id}: ${PLAN_HINT[args[1]] || args[1]} را بنویس:`];
  },
  newplan: async () => null, // replaced by the step-by-step form (m:f:newplan)
  coupon: async () => null,  // replaced by the step-by-step form (m:f:coupon)
  addpanel: async () => ['/addpanel auto', 'pa', '➕ یک نام برای پنل جدید بنویس، مثلاً: آلمان ۲\nنوع پنل (PasarGuard، Marzban یا Rebecca) موقع تست خودکار تشخیص داده می‌شود.'],
  panelcred: async (env, args) => { const id = parseInt(args[0], 10); return [`/panelcred ${id}`, `pp:${id}`, CRED_PROMPT, true]; },
  groups: async (env, args) => { const id = parseInt(args[0], 10); return [`/panelgroups ${id}`, `pp:${id}`, '👥 شماره‌ی گروه‌های پنل را با کاما بنویس (مثلاً 1,2).\nبرای Rebecca فقط شماره‌ی یک سرویس (Service) را بنویس:']; },
  set: async (env, args) => {
    const { SETTING_DEFAULTS } = await import('./db.js');
    if (!(args[0] in SETTING_DEFAULTS)) return null;
    const back = ['card_number', 'card_holder'].includes(args[0]) ? 'pay' : args[0] === 'referral_percent' ? 'ref' : args[0] === 'sms_senders' ? 'snd' : `sk:${args[0]}`;
    return [`/set ${args[0]}`, back, `✏️ مقدار جدید «${S.KEY_FA[args[0]] || args[0]}» را بنویس:`];
  },
};

// ---------------- pending receipts ----------------
// Sends each receipt waiting for review again, with its Approve/Reject buttons (the ap:/rj: handlers in telegram.js).
async function sendPending(env, chatId) {
  const rows = await all(env, "SELECT o.*, u.email, p.name plan_name FROM orders o JOIN users u ON u.id = o.user_id LEFT JOIN plans p ON p.id = COALESCE(o.plan_id, o.activate_plan_id) WHERE o.status = 'review' ORDER BY o.id LIMIT 6");
  for (const o of rows.slice(0, 5)) {
    let what = 'شارژ کیف پول';
    if (o.kind === 'plan' || o.activate_plan_id) what = o.kind === 'plan' ? `پلن ${o.plan_name || ''}` : `شارژ + فعال‌سازی پلن ${o.plan_name || ''}`;
    const text = [`🧾 سفارش #${o.id} — ${what}`, `مبلغ: ${fa(o.amount_toman)} تومان${o.coin_amount ? ` (${o.coin_amount} ${String(o.coin || '').toUpperCase()})` : ''}`,
      o.email, `شماره پیگیری: ${o.receipt_ref || o.txid || '-'}`].join('\n');
    const kb = { inline_keyboard: [[b('✅ تأیید', `ap:${o.id}`), b('❌ رد', `rj:${o.id}`)]] };
    if (o.receipt_file_id) await tg(env, 'sendPhoto', { chat_id: chatId, photo: o.receipt_file_id, caption: text, reply_markup: kb });
    else await tg(env, 'sendMessage', { chat_id: chatId, text, reply_markup: kb });
  }
  const total = (await first(env, "SELECT COUNT(*) c FROM orders WHERE status = 'review'")).c;
  return total > 5 ? `${total - 5} رسید دیگر هم هست؛ بعد از بررسی این‌ها دوباره دکمه را بزن.` : '';
}

// ---------------- entry points ----------------
export async function sendHome(env, chatId, role = 'owner') {
  const s = await S.home(env);
  return tg(env, 'sendMessage', { chat_id: chatId, text: s.text, reply_markup: { inline_keyboard: forRole(role, s.kb) } });
}

// Menu messages are edited in place; a photo (receipt) cannot become a menu, so it gets a new message.
// A support or viewer admin sees only the buttons their role may press.
async function show(env, cq, s) {
  const m = cq.message || {};
  const body = { text: String(s.text).slice(0, 4000), reply_markup: { inline_keyboard: forRole(cq._role, s.kb) }, disable_web_page_preview: true };
  if (m.text && m.message_id) return tg(env, 'editMessageText', { chat_id: m.chat.id, message_id: m.message_id, ...body });
  return tg(env, 'sendMessage', { chat_id: m.chat.id, ...body });
}

export async function renderScreen(env, data) {
  const [key, ...args] = String(data || 'home').split(':');
  const fn = SCREENS[key] || SCREENS.home;
  return fn(env, args);
}
const showScreen = async (env, cq, data) => show(env, cq, await renderScreen(env, data));

// the card a change came from, with its undo button on top
async function cardWithUndo(env, cq, data, r) {
  const scr = await renderScreen(env, data);
  return show(env, cq, { text: scr.text, kb: [...undoRows(r), ...scr.kb] });
}
const UNDO_BACK = { user: (id) => `u:${id}`, plan: (id) => `p:${id}`, panel: (id) => `pp:${id}`, setting: (id) => `sk:${id}`, coupon: () => 'cp', order: (id) => `o:${id}`,
  server: (id) => `srv:${String(id).replace('.', ':')}`, health: (id) => (id === 'mode' ? 'hl' : `he:${id}`), broadcast: (id) => `bcv:${id}`, admin: () => 'sys.adm' };
// one extra app domain: GET <base>/health within 5 s; ok only when it answers like this worker ({"ok":true})
export async function checkHealth(base) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'cloudgold-admin-check' } });
    const body = await r.text().catch(() => '');
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
    let j = null;
    try { j = JSON.parse(body); } catch (e) { j = null; }
    if (!j || j.ok !== true) return { ok: false, why: 'جواب ورکر نیست' };
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, why: e && e.name === 'TimeoutError' ? 'بیش از ۵ ثانیه' : 'وصل نشد' };
  }
}
const NET_TABLE_FA = { net_stats: 'آمار روزانه', net_geo: 'آمار استانی', net_votes: 'رأی کاربران', net_speed_votes: 'رأی سرعت',
  user_net_srv: 'تجربه‌ی هر کاربر', user_net: 'شبکه‌های کاربران', google_probe: 'تست گوگل', google_votes: 'رأی تست گوگل' };
// where a one-tap setting comes back to
const SET_BACK = { referral_percent: 'ref', trial_data_gb: 'app', trial_needs_telegram: 'app', cf_alerts: 'cf' };

// onCallback in telegram.js has already checked that the tap came from the admin in their private chat.
export async function onMenu(env, cq) {
  const chatId = cq.message?.chat?.id;
  const ack = (text, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: text ? String(text).slice(0, 190) : undefined, show_alert: !!alert });
  const data = String(cq.data || '').slice(2);
  const [route, ...args] = data.split(':');
  const int = (i) => parseInt(args[i], 10);
  if (!cq._role || !allowedTap(cq._role, cq.data)) return ack('اجازه نداری'); // set by onCallback; nothing else may get here
  if (!routeOf(cq.data)) { await ack('این دکمه قدیمی است'); return showScreen(env, cq, 'home'); }

  if (ROUTES[route].kind === 'screen') { await ack(''); return showScreen(env, cq, data); }

  // run an old text command; its answer comes as a new message with a "back" button
  if (route === 'x') {
    const rest = data.slice(2);
    const i = rest.indexOf('|');
    await ack('⏳');
    return runAdminCommand(env, chatId, rest.slice(i + 1), backKb(rest.slice(0, i)));
  }
  if (route === 'w') {
    const q = await ASK[args[0]](env, args.slice(1));
    if (!q) {
      if (FORMS[args[0]]) return startForm(env, cq, args[0], ack, args[1]); // old "new plan / new code" buttons open the form
      return ack('پیدا نشد');
    }
    const [cmd, back, prompt, secret] = q;
    await setWait(env, cmd, back, secret, chatId);
    await show(env, cq, { text: prompt + '\n\n(تا ۱۰ دقیقه منتظر جوابت هستم)', kb: [[b('❌ انصراف', `m:cancel:${back}`)]] });
    return ack('');
  }
  if (route === 'f') return startForm(env, cq, args[0], ack, args[1]);
  if (route === 'fa') {
    const s = await takeSession(env, chatId);
    if (!s || !FORMS[s.flow]) { await ack('این فرم منقضی شده', true); return showScreen(env, cq, 'home'); }
    if (s.step !== int(0)) { await putBack(env, chatId, s); return ack(''); } // a second tap on an old step
    await ack('');
    const scr = await formAnswer(env, chatId, s, args.slice(1).join(':'), null);
    return scr && show(env, cq, scr);
  }
  if (route === 'fok') {
    const s = await takeSession(env, chatId);
    const f = s && FORMS[s.flow];
    if (!f || s.flow !== args[0] || s.step < f.steps.length) {
      if (s) await putBack(env, chatId, s);
      await ack('این فرم منقضی یا ناقص است', true);
      return showScreen(env, cq, f ? backOf(f, s.data) : 'home');
    }
    const { _msg, ...d } = s.data;
    const a = f.args ? f.args(d) : d;
    if (f.confirm) { // money: one more "are you sure?" (one-time token), then the action runs from telegram.js
      await askConfirm(env, chatId, f.confirm, a, [`${f.title}`, ...f.summary(d)].join('\n'));
      await ack('');
      return showScreen(env, cq, backOf(f, d));
    }
    const r = await runAction(env, chatId, f.action, a);
    if (!r.ok) { await ack(r.error, true); return showScreen(env, cq, backOf(f, d)); }
    if (f.broadcast) { // the preview goes to this admin only, exactly as people will get it; then "are you sure?"
      await tg(env, 'sendMessage', { chat_id: chatId, text: d.text, disable_web_page_preview: true });
      await askBroadcast(env, chatId, r.targetId, d.audience);
      await ack('');
      return showScreen(env, cq, f.done(r, d));
    }
    await ack(r.text.slice(0, 190));
    return cardWithUndo(env, cq, f.done(r, d), r);
  }
  if (route === 'cancel') {
    await takeSession(env, chatId);
    await ack('لغو شد');
    return showScreen(env, cq, args.join(':') || 'home');
  }
  if (route === 'ord') {
    const review = (await first(env, "SELECT COUNT(*) c FROM orders WHERE status = 'review'")).c;
    if (!review) { await ack('رسیدی منتظر نیست ✅'); return showScreen(env, cq, 'in'); }
    await ack('⏳');
    const more = await sendPending(env, chatId);
    return tg(env, 'sendMessage', { chat_id: chatId, text: `🧾 ${review} رسید منتظر بررسی بالا فرستاده شد. ${more}`.trim(), reply_markup: backKb('in') });
  }
  if (route === 'ug') {
    const u = await first(env, 'SELECT id, email FROM users WHERE id = ?', int(0));
    if (!u) return ack('کاربر پیدا نشد');
    const rows = await all(env, 'SELECT id, name, duration_days, data_limit_gb FROM plans WHERE is_active = 1 AND archived = 0 ORDER BY sort, id');
    await show(env, cq, { text: `${S.crumb('👤 کاربران', u.email, '🎁 دادن پلن')}\n\n🎁 کدام پلن به ${u.email} داده شود؟`,
      kb: [...rows.map((p) => [b(`${p.name} (${p.data_limit_gb || 'نامحدود'} گیگ، ${p.duration_days} روز)`.slice(0, 60), `m:ugp:${u.id}:${p.id}`)]), [b('🔙 برگشت', `m:u:${u.id}`), HOME]] });
    return ack('');
  }
  if (route === 'ugp') { // money: asks first
    const u = await first(env, 'SELECT id, email FROM users WHERE id = ?', int(0));
    const p = await first(env, 'SELECT id, name, duration_days, data_limit_gb FROM plans WHERE id = ?', int(1));
    if (!u || !p) return ack('پیدا نشد');
    await askConfirm(env, chatId, 'grant', { user_id: u.id, plan_id: p.id }, `پلن «${p.name}» (${p.data_limit_gb || 'نامحدود'} گیگ، ${p.duration_days} روز) به ${u.email} داده شود؟`);
    return ack('');
  }
  if (route === 'pt') {
    const r = await runAction(env, chatId, 'plan.toggle', { id: int(0) });
    if (!r.ok) return ack(r.error);
    await ack(r.text);
    return cardWithUndo(env, cq, `p:${int(0)}`, r);
  }
  if (route === 'cd') { // destructive: asks first and says what it affects
    const code = args.join(':');
    const c = await first(env, 'SELECT code, percent, used, max_uses FROM coupons WHERE code = ?', code);
    if (!c) { await ack('این کد پیدا نشد'); return showScreen(env, cq, 'cp'); }
    await askConfirm(env, chatId, 'del_coupon', { code }, `کد تخفیف ${code} (${c.percent}٪، ${fa(c.used)}${c.max_uses ? ' از ' + fa(c.max_uses) : ''} بار استفاده‌شده) پاک شود؟\nکسانی که هنوز سفارش باز با این کد دارند، دیگر نمی‌توانند از آن استفاده کنند. این کار برگشت ندارد.`);
    return ack('');
  }
  if (route === 'sv') {
    const [key, val] = args;
    if (!['card_auto', 'coin_auto'].includes(key) || !(val in S.AUTO_FA)) return ack('');
    const r = await runAction(env, chatId, 'setting.set', { key, val });
    await ack('✅ ' + S.AUTO_FA[val]);
    return cardWithUndo(env, cq, 'pay', r);
  }
  if (USER_TAPS[route]) {
    const [action, a, back] = USER_TAPS[route](args);
    const r = await runAction(env, chatId, action, a);
    if (!r.ok) { await ack(r.error, true); return showScreen(env, cq, back); }
    await ack(r.text);
    return cardWithUndo(env, cq, back, r);
  }
  if (route === 'uux') { // one panel account stops being this user's
    const a = await first(env, `SELECT a.remote_username, a.panel_id, p.label, u.email, u.tg_username FROM panel_accounts a JOIN panels p ON p.id = a.panel_id
      JOIN users u ON u.id = a.user_id WHERE a.user_id = ? AND a.panel_id = ?`, int(0), int(1));
    if (!a) { await ack('این اکانت دیگر وصل نیست', true); return showScreen(env, cq, `uac:${int(0)}`); }
    const name = a.tg_username ? `${a.email} (@${a.tg_username})` : a.email;
    await askUnlinkConfirm(env, chatId, { user_id: int(0), panel_id: a.panel_id }, [
      `اکانت ${a.remote_username} روی پنل #${a.panel_id} (${a.label}) از ${name} جدا شود؟`,
      '• از این به بعد مصرفش برای این کاربر حساب نمی‌شود و کانفیگ‌هایش در اپ او نمی‌آید',
      '• مصرفی که تا الان حساب شده در دوره‌ی فعلی می‌ماند',
      '• بعدش می‌توانی همین اکانت را به کاربر دیگری وصل کنی'].join('\n'));
    return ack('');
  }
  if (['urs', 'uend', 'utg', 'udel'].includes(route)) {
    const q = await userQuestion(env, route, int(0));
    if (!q) return ack('کاربر پیدا نشد');
    await askConfirm(env, chatId, q[0], { user_id: int(0) }, q[1]);
    return ack('');
  }
  // ---- sales (stage 3) ----
  if (route === 'oap' || route === 'orf') { // money: asks first; the action itself refuses a second delivery or refund
    const o = await first(env, `SELECT o.id, o.status, o.kind, o.amount_toman, o.method, u.email, p.name plan_name,
        (SELECT COUNT(*) FROM wallet_tx WHERE order_id = o.id AND reason = 'admin_refund') refunded
      FROM orders o JOIN users u ON u.id = o.user_id LEFT JOIN plans p ON p.id = COALESCE(o.plan_id, o.activate_plan_id) WHERE o.id = ?`, int(0));
    if (!o) return ack('سفارش پیدا نشد');
    const what = o.kind === 'plan' ? `پلن ${o.plan_name || ''}` : 'شارژ کیف پول';
    if (route === 'oap') {
      if (!S.ORDER_OPEN.includes(o.status)) { await ack(o.status === 'paid' ? 'قبلاً تأیید و فعال شده' : 'این سفارش تأییدشدنی نیست', true); return showScreen(env, cq, `o:${o.id}`); }
      await askConfirm(env, chatId, 'o_approve', { order_id: o.id }, `سفارش #${o.id} (${what}، ${fa(o.amount_toman)} تومان، ${o.email}) تأیید و همین الان فعال شود؟\nفقط وقتی بزن که پول را واقعاً گرفته‌ای.`);
      return ack('');
    }
    if (o.status !== 'paid' || o.kind === 'topup' || o.refunded) { await ack(o.refunded ? 'قبلاً برگردانده شده' : 'این سفارش برگشت‌پذیر نیست', true); return showScreen(env, cq, `o:${o.id}`); }
    await askConfirm(env, chatId, 'o_refund', { order_id: o.id }, `${fa(o.amount_toman)} تومانِ سفارش #${o.id} (${what}) به کیف پول ${o.email} برگردد؟\nاشتراکش قطع نمی‌شود؛ اگر لازم است، از کارت کاربر «⏹ پایان اشتراک» را بزن. این کار فقط یک بار انجام می‌شود.`);
    return ack('');
  }
  if (route === 'orc') { // the receipt photo, as a new message under the card
    const o = await first(env, 'SELECT id, receipt_file_id, receipt_ref, amount_toman FROM orders WHERE id = ?', int(0));
    if (!o || !o.receipt_file_id) return ack('این سفارش عکس رسید ندارد');
    await ack('');
    return tg(env, 'sendPhoto', { chat_id: chatId, photo: o.receipt_file_id, caption: `🖼 رسید سفارش #${o.id} · ${fa(o.amount_toman)} تومان${o.receipt_ref ? ` · پیگیری ${o.receipt_ref}` : ''}`,
      reply_markup: backKb(`o:${o.id}`) });
  }
  if (route === 'pcp') {
    const r = await runAction(env, chatId, 'plan.copy', { id: int(0) });
    if (!r.ok) return ack(r.error, true);
    await ack(r.text);
    return cardWithUndo(env, cq, `p:${r.targetId}`, r);
  }
  if (route === 'pdl') { // destructive: asks first and says whether it is deleted or archived
    const p = await first(env, 'SELECT id, name, archived FROM plans WHERE id = ?', int(0));
    if (!p) return ack('پلن پیدا نشد');
    if (p.archived) return ack('این پلن قبلاً بایگانی شده', true);
    const { planUses } = await import('./admin-actions.js');
    const used = await planUses(env, p.id);
    await askConfirm(env, chatId, 'del_plan', { plan_id: p.id }, used
      ? `پلن «${p.name}» ${fa(used)} سفارش، اشتراک یا کد تخفیف دارد، پس پاک نمی‌شود و بایگانی می‌شود:\n• از اپ و از لیست «دادن پلن» برمی‌دارد\n• اسمش در سفارش‌ها و اشتراک‌های قبلی می‌ماند\n• اشتراک فعلی کسی قطع نمی‌شود\nبعداً از «🗄 بایگانی» برمی‌گردد.`
      : `پلن «${p.name}» هیچ سفارش و اشتراکی ندارد و برای همیشه پاک می‌شود. این کار برگشت ندارد.`);
    return ack('');
  }
  if (route === 'ss') { // a one-tap setting: only the choices on the screen are accepted
    const [key, val] = args;
    if (!S.SET_CHOICES[key] || !S.SET_CHOICES[key].includes(val)) return ack('');
    const r = await runAction(env, chatId, 'setting.set', { key, val });
    if (!r.ok) return ack(r.error, true);
    await ack('✅ ' + (S.KEY_FA[key] || key) + ' = ' + val);
    return cardWithUndo(env, cq, SET_BACK[key] || 'payset', r);
  }
  if (route === 'sdel') {
    const { normSender } = await import('./sms.js');
    const { getSettings } = await import('./db.js');
    const snd = args.join(':');
    const list = String((await getSettings(env)).sms_senders || '').split(',').filter(Boolean);
    if (!list.includes(snd)) { await ack('این فرستنده در لیست نیست'); return showScreen(env, cq, 'snd'); }
    const r = await runAction(env, chatId, 'setting.set', { key: 'sms_senders', val: list.filter((x) => x !== snd).map(normSender).join(',') });
    if (!r.ok) return ack(r.error, true);
    await ack('🗑 حذف شد؛ پیامک‌های این شماره دیگر خودکار تأیید نمی‌شوند');
    return cardWithUndo(env, cq, 'snd', r);
  }
  // ---- the app's domains, network stats (stage 4) ----
  if (route === 'apt') { // each extra domain's /health, in parallel (at most 8 fetches)
    await ack('⏳ در حال تست…');
    const { getSettings } = await import('./db.js');
    const { splitAppList } = await import('./admin-actions.js');
    const list = splitAppList((await getSettings(env)).app_api_bases).slice(0, 8);
    const res = await Promise.all(list.map((base) => checkHealth(base)));
    const lines = res.map((r, i) => `${r.ok ? '✅' : '❌'} ${list[i]} — ${r.ok ? `${fa(r.ms)}ms` : r.why}`);
    return show(env, cq, { text: [S.crumb('📱 اپ Pleat', '🌐 دامنه‌ها', '🔎 تست'), '', ...(lines.length ? lines : ['دامنه‌ای در لیست نیست.']), '',
      'تست از سرور Cloudflare است، نه از ایران؛ «✅» یعنی دامنه درست به ورکر می‌رسد، نه اینکه در ایران فیلتر نیست.'].join('\n'),
    kb: [[b('🔄 تست دوباره', 'm:apt')], nav('appl:d')] });
  }
  if (route === 'nrs') { // destructive: asks first, with how many rows it removes
    const { netResetImpact } = await import('./admin-actions.js');
    const kind = args[0], id = args[1];
    const imp = await netResetImpact(env, kind, id);
    if (!imp) return ack('پیدا نشد');
    if (!imp.total) return ack('برای این مورد آماری ثبت نشده', true);
    const parts = Object.entries(imp.counts).filter(([, n]) => n > 0).map(([t, n]) => `• ${NET_TABLE_FA[t] || t}: ${fa(n)} ردیف`);
    await askConfirm(env, chatId, 'net_reset', { kind, id }, [`آمار ${kind === 's' ? 'این سرور' : `اپراتور AS${id}`} پاک شود؟ این کار برگشت ندارد:`, ...parts,
      kind === 's' ? 'آمار بقیه‌ی سرورها دست نمی‌خورد.' : 'آمار بقیه‌ی اپراتورها دست نمی‌خورد.', 'رتبه‌بندی از گزارش‌های بعدی اپ دوباره ساخته می‌شود.'].join('\n'));
    return ack('');
  }
  if (route === 'bcgo') { // a draft whose question expired: ask again
    const bc = await first(env, "SELECT id, audience FROM broadcasts WHERE id = ? AND status = 'draft'", int(0));
    if (!bc) { await ack('این پیام دیگر پیش‌نویس نیست', true); return showScreen(env, cq, 'bc'); }
    await askBroadcast(env, chatId, bc.id, bc.audience);
    return ack('');
  }
  if (route === 'syn') { // one panel-sync run now, in this tap's own invocation (its own subrequest budget)
    const t = await first(env, "SELECT value FROM settings WHERE key = 'sync_manual_at'");
    if (t && nowSec() - parseInt(t.value, 10) < 60) return ack('یک دقیقه صبر کن؛ همین الان اجرا شد', true);
    await run(env, `INSERT INTO settings (key, value) VALUES ('sync_manual_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, String(nowSec()));
    await ack('⏳ همگام‌سازی…');
    let out = null;
    try { const { runSync } = await import('./sync.js'); out = await runSync(env, { spent: 6 }); } catch (e) { out = null; }
    const scr = await renderScreen(env, 'sys.hl');
    const head = out ? `⚡ همگام‌سازی اجرا شد: ${fa(out.pushed || 0)} تغییر روی پنل، ${fa(out.created || 0)} اکانت ساخته شد، ${fa(out.expired || 0)} اشتراک تمام‌شده بسته شد.`
      : '❌ همگام‌سازی کامل نشد؛ خطا در «☁️ کلودفلر › 🐞 خطاها» ثبت شد.';
    return show(env, cq, { text: head + '\n\n' + scr.text, kb: scr.kb });
  }
  if (route === 'undo') {
    const r = await undoAction(env, chatId, int(0));
    if (!r.ok) { await ack(r.error, true); return showScreen(env, cq, 'sys.log'); }
    await ack(r.text);
    const back = UNDO_BACK[r.row.target_type];
    return showScreen(env, cq, back ? back(r.row.target_id) : 'sys.log');
  }
  await ack('');
  return showScreen(env, cq, 'home');
}

// destructive: sending cannot be taken back, so the question says how many people get it
async function askBroadcast(env, chatId, id, audience) {
  const n = await audienceCount(env, audience);
  return askConfirm(env, chatId, 'bc_start', { id }, [`پیام همگانی #${id} برای «${AUDIENCES[audience].fa}» فرستاده شود؟`,
    `${fa(n)} نفر آن را می‌گیرند (فقط کسانی که با تلگرام وارد اپ شده‌اند).`, 'پیام بالا پیش‌نمایش آن است. ارسال برگشت ندارد؛ فقط می‌شود وسطش متوقفش کرد.'].join('\n'));
}

async function startForm(env, cq, name, ack, uid) {
  const f = FORMS[name];
  if (!f) return ack('پیدا نشد');
  let data = {};
  if (f.init) { // a form about one panel or one server reads (and checks) its target from the button
    data = await f.init(env, uid);
    if (!data) return ack('پیدا نشد');
  } else if (typeof f.back === 'function') { // a per-user (or per-coupon) form needs one that exists
    const id = parseInt(uid, 10);
    const coupon = f.param === 'couponId';
    if (!(id > 0) || !(await first(env, `SELECT 1 x FROM ${coupon ? 'coupons' : 'users'} WHERE id = ?`, id))) return ack(coupon ? 'این کد پیدا نشد' : 'کاربر پیدا نشد');
    data[coupon ? 'couponId' : 'userId'] = id;
  }
  const s = { flow: name, step: 0, data, back: backOf(f, data), secret: secretAt(f, 0) };
  await setSession(env, cq.message?.chat?.id, s);
  await show(env, cq, await formScreen(env, name, s));
  return ack('');
}
