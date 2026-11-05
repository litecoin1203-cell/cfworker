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
import { nowSec } from './util.js';
import { tg, runAdminCommand, askConfirm } from './telegram.js';
import * as S from './telegram-screens.js';
import { runAction, undoAction } from './admin-actions.js';

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
};

async function formScreen(env, name, s, note) {
  const f = FORMS[name];
  const cancel = [b('❌ انصراف', `m:cancel:${f.back}`)];
  if (s.step >= f.steps.length) {
    return { text: [`${f.title} — بازبینی`, '', ...f.summary(s.data), '', 'درست است؟'].join('\n'),
      kb: [[b('✅ ساخته شود', `m:fok:${name}`)], cancel] };
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
  if (v === null || v === undefined) {
    await putBack(env, adminId, s);
    return formScreen(env, s.flow, s, '❌ ' + (v === undefined && st.taken ? st.taken : st.hint));
  }
  s.data[st.key] = v;
  s.step += 1;
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
  usr: (env, a) => S.users(env, a[0]),
  u: (env, a) => S.userCard(env, parseInt(a[0], 10)),
  un: (env, a) => S.userNets(env, parseInt(a[0], 10) || 0),
  pl: (env) => S.plans(env),
  p: (env, a) => S.plan(env, parseInt(a[0], 10)),
  pa: (env) => S.panels(env),
  pp: (env, a) => S.panel(env, parseInt(a[0], 10)),
  cp: (env) => S.coupons(env),
  pay: (env) => S.payments(env),
  set: (env) => S.settings(env, false),
  wl: (env) => S.settings(env, true),
  sk: (env, a) => S.settingKey(env, a[0]),
  app: (env) => S.app(env),
  net: () => S.net(),
  st: (env) => S.stats(env),
  sys: () => S.system(),
  'sys.log': (env, a) => S.auditLog(env, a[0]),
  help: () => S.help(),
  hist: (env, a) => S.history(env, a[0], a[1], a[2]),
  or: () => S.soon('🧾 سفارش‌ها و کیف پول'),
  bc: () => S.soon('📣 پیام همگانی'),
};
// action routes and how risky they are (see the top of this file)
const ACTION_RISK = {
  x: 'command', w: 'ask', f: 'form', fa: 'form', fok: 'form', cancel: 'read', ord: 'read',
  ug: 'read', ugp: 'money', pt: 'reversible', cd: 'destructive', sv: 'reversible', undo: 'reversible',
};
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
  devices: 'تعداد دستگاه، 0 = نامحدود', trial: 'روزهای تست رایگان، 0 = ندارد', name: 'نام پلن', badge: 'نشان (مثلاً پیشنهاد ویژه)' };

const ASK = {
  find: async () => ['/find', 'usr', '🔎 ایمیل، یوزرنیم تلگرام (@...) یا آیدی عددی تلگرام کاربر را بنویس:'],
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
    const back = ['card_number', 'card_holder'].includes(args[0]) ? 'pay' : `sk:${args[0]}`;
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
export async function sendHome(env, chatId) {
  const s = await S.home(env);
  return tg(env, 'sendMessage', { chat_id: chatId, text: s.text, reply_markup: { inline_keyboard: s.kb } });
}

// Menu messages are edited in place; a photo (receipt) cannot become a menu, so it gets a new message.
async function show(env, cq, s) {
  const m = cq.message || {};
  const body = { text: String(s.text).slice(0, 4000), reply_markup: { inline_keyboard: s.kb }, disable_web_page_preview: true };
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
const UNDO_BACK = { plan: (id) => `p:${id}`, panel: (id) => `pp:${id}`, setting: (id) => `sk:${id}`, coupon: () => 'cp' };

// onCallback in telegram.js has already checked that the tap came from the admin in their private chat.
export async function onMenu(env, cq) {
  const chatId = cq.message?.chat?.id;
  const ack = (text, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: text ? String(text).slice(0, 190) : undefined, show_alert: !!alert });
  const data = String(cq.data || '').slice(2);
  const [route, ...args] = data.split(':');
  const int = (i) => parseInt(args[i], 10);
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
      if (FORMS[args[0]]) return startForm(env, cq, args[0], ack); // old "new plan / new code" buttons open the form
      return ack('پیدا نشد');
    }
    const [cmd, back, prompt, secret] = q;
    await setWait(env, cmd, back, secret, chatId);
    await show(env, cq, { text: prompt + '\n\n(تا ۱۰ دقیقه منتظر جوابت هستم)', kb: [[b('❌ انصراف', `m:cancel:${back}`)]] });
    return ack('');
  }
  if (route === 'f') return startForm(env, cq, args[0], ack);
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
      return showScreen(env, cq, f ? f.back : 'home');
    }
    const { _msg, ...d } = s.data;
    const r = await runAction(env, chatId, f.action, d);
    if (!r.ok) { await ack(r.error, true); return showScreen(env, cq, f.back); }
    await ack(r.text.slice(0, 190));
    return cardWithUndo(env, cq, f.done(r), r);
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
    const rows = await all(env, 'SELECT id, name, duration_days FROM plans WHERE is_active = 1 AND archived = 0 ORDER BY sort, id');
    await show(env, cq, { text: `${S.crumb('👤 کاربران', u.email, '🎁 دادن پلن')}\n\n🎁 کدام پلن به ${u.email} داده شود؟`,
      kb: [...rows.map((p) => [b(`${p.name} (${p.duration_days} روز)`, `m:ugp:${u.id}:${p.id}`)]), [b('🔙 برگشت', `m:u:${u.id}`), HOME]] });
    return ack('');
  }
  if (route === 'ugp') { // money: asks first
    const u = await first(env, 'SELECT id, email FROM users WHERE id = ?', int(0));
    const p = await first(env, 'SELECT id, name, duration_days, data_limit_gb FROM plans WHERE id = ?', int(1));
    if (!u || !p) return ack('پیدا نشد');
    await askConfirm(env, chatId, 'grant', { user_id: u.id, plan_id: p.id }, `پلن «${p.name}» (${p.duration_days} روز، ${p.data_limit_gb || 'نامحدود'} گیگ) به ${u.email} داده شود؟`);
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

async function startForm(env, cq, name, ack) {
  const f = FORMS[name];
  if (!f) return ack('پیدا نشد');
  const s = { flow: name, step: 0, data: {}, back: f.back };
  await setSession(env, cq.message?.chat?.id, s);
  await show(env, cq, await formScreen(env, name, s));
  return ack('');
}
