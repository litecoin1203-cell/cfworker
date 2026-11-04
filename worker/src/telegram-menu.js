// Button menu for the admin bot: every admin job reachable from inline buttons, no command typing needed.
// Screens edit the menu message in place; actions reuse the text commands in telegram.js (one code path),
// so /find, /plan, /rollout... keep working exactly as before. Callback data: "m:<screen>[:args]" (max 64 bytes).
import { first, all, run, getSettings, setSetting, SETTING_DEFAULTS } from './db.js';
import { nowSec } from './util.js';
import { tg, runAdminCommand, askConfirm, statsText, userInfo, HELP, STATE_FA, PLAN_FIELDS } from './telegram.js';

const fa = (n) => Number(n || 0).toLocaleString('en-US');
const b = (text, data) => ({ text, callback_data: String(data).slice(0, 64) });
const HOME = b('🏠 منوی اصلی', 'm:home');
const WAIT_SECONDS = 600;

export const backKb = (back) => ({ inline_keyboard: [back && back !== 'home' ? [b('🔙 برگشت', 'm:' + back), HOME] : [HOME]] });

export const userKb = (uid) => ({ inline_keyboard: [
  [b('🎁 دادن پلن', `m:ug:${uid}`), b('🔑 تغییر رمز', `m:w:reset:${uid}`)],
  [b('🔗 وصل اکانت پنل', `m:w:link:${uid}`)],
  [b('🔄 به‌روزرسانی', `m:u:${uid}`), b('🔙 کاربران', 'm:usr'), HOME],
] });

// ---------------- "write your answer" state ----------------
// One question at a time (one admin chat): the next plain-text message becomes "<cmd> <text>".
async function setWait(env, cmd, back, secret) {
  await setSetting(env, 'bot_wait', JSON.stringify({ cmd, back, secret: !!secret, exp: nowSec() + WAIT_SECONDS }));
}

// Reads and clears the question in one statement, so an answer is never used twice.
export async function takeWait(env) {
  const row = await first(env, "DELETE FROM settings WHERE key = 'bot_wait' RETURNING value");
  if (!row) return null;
  try {
    const w = JSON.parse(row.value);
    return w && w.exp >= nowSec() && typeof w.cmd === 'string' ? w : null;
  } catch (e) { return null; }
}

// ---------------- screens ----------------
async function home(env) {
  const now = nowSec();
  const users = (await first(env, 'SELECT COUNT(*) c FROM users')).c;
  const active = (await first(env, 'SELECT COUNT(*) c FROM subscriptions WHERE expires_at > ? OR expires_at IS NULL', now)).c;
  const review = (await first(env, "SELECT COUNT(*) c FROM orders WHERE status = 'review'")).c;
  return {
    text: `🏠 مدیریت Cloud Gold\n\n👥 کاربران: ${fa(users)} · ✅ اشتراک فعال: ${fa(active)}\n🧾 رسید منتظر بررسی: ${fa(review)}\n\nیک گزینه را انتخاب کن:`,
    kb: [
      [b(`🧾 رسیدهای منتظر${review ? ` (${review})` : ''}`, 'm:ord'), b('📊 آمار', 'm:st')],
      [b('👤 کاربران', 'm:usr'), b('📦 پلن‌ها', 'm:pl')],
      [b('🗂 پنل‌ها', 'm:pa'), b('🏷 کدهای تخفیف', 'm:cp')],
      [b('💰 پرداخت‌ها', 'm:pay'), b('⚙️ تنظیمات', 'm:set')],
      [b('🔎 گوگل', 'm:x:home|/google'), b('📶 اپراتورها', 'm:x:home|/carriers')],
      [b('💾 پشتیبان', 'm:x:home|/backup'), b('❓ راهنما', 'm:help')],
    ],
  };
}

async function users(env) {
  const count = (await first(env, 'SELECT COUNT(*) c FROM users')).c;
  const rows = await all(env, 'SELECT id, email FROM users ORDER BY id DESC LIMIT 8');
  return {
    text: `👤 کاربران — ${fa(count)} نفر\n\nآخرین ثبت‌نام‌ها پایین هستند. برای بقیه «جستجو» را بزن.`,
    kb: [[b('🔎 جستجو با ایمیل', 'm:w:find')], ...rows.map((u) => [b(u.email.slice(0, 40), `m:u:${u.id}`)]), [HOME]],
  };
}

async function plans(env) {
  const rows = await all(env, 'SELECT * FROM plans ORDER BY sort, id');
  return {
    text: '📦 پلن‌ها\nروی هر پلن بزن تا قیمت، روز، حجم و بقیه را عوض کنی.',
    kb: [...rows.map((p) => [b(`${p.is_active ? '🟢' : '🔴'} #${p.id} ${p.name} — ${fa(p.price_toman)} ت`, `m:p:${p.id}`)]),
      [b('➕ پلن جدید', 'm:w:newplan')], [HOME]],
  };
}

async function plan(env, id) {
  const p = await first(env, 'SELECT * FROM plans WHERE id = ?', id);
  if (!p) return { text: 'پلن پیدا نشد.', kb: [[b('🔙 پلن‌ها', 'm:pl'), HOME]] };
  const f = (field, label) => b(label, `m:w:plan:${p.id}:${field}`);
  return {
    text: [`📦 پلن #${p.id} — ${p.name}`, '',
      `💰 قیمت: ${fa(p.price_toman)} تومان${p.old_price_toman ? ` (قبلی: ${fa(p.old_price_toman)})` : ''}`,
      `📅 مدت: ${p.duration_days} روز`, `📦 حجم: ${p.data_limit_gb || 'نامحدود'} گیگ`, `📱 دستگاه: ${p.device_limit || 'نامحدود'}`,
      `🎁 تست رایگان: ${p.trial_days ? p.trial_days + ' روز' : 'ندارد'}`, `⭐ نشان: ${p.badge || '—'}`,
      `وضعیت: ${p.is_active ? '🟢 روشن (در اپ دیده می‌شود)' : '🔴 خاموش'}`].join('\n'),
    kb: [
      [f('price', '💰 قیمت'), f('old', '🏷 قیمت قبلی')],
      [f('days', '📅 روز'), f('gb', '📦 حجم')],
      [f('devices', '📱 دستگاه'), f('trial', '🎁 تست')],
      [f('name', '✏️ نام'), f('badge', '⭐ نشان')],
      [b(p.is_active ? '🔴 خاموش کن' : '🟢 روشن کن', `m:pt:${p.id}`)],
      [b('🔙 پلن‌ها', 'm:pl'), HOME],
    ],
  };
}

async function panels(env) {
  const { listPanels } = await import('./panels.js');
  const rows = await listPanels(env);
  return {
    text: '🗂 پنل‌ها\nروی هر پنل بزن تا تست، ورود تدریجی یا خارج‌کردن را انجام دهی.',
    kb: [...rows.map((p) => [b(`#${p.id} ${p.label} — ${STATE_FA[p.state] || p.state}${p.state === 'rollout' ? ` ${p.rollout_percent}%` : ''}`, `m:pp:${p.id}`)]),
      [b('🔎 تست سلامت همه', 'm:x:pa|/panel'), b('➕ افزودن پنل', 'm:w:addpanel')], [HOME]],
  };
}

async function panel(env, id) {
  const { getPanel } = await import('./panels.js');
  const p = await getPanel(env, id);
  if (!p) return { text: 'پنل پیدا نشد.', kb: [[b('🔙 پنل‌ها', 'm:pa'), HOME]] };
  const n = (await first(env, "SELECT COUNT(*) c FROM panel_accounts WHERE panel_id = ? AND desired = 'active'", p.id)).c;
  const back = `pp:${p.id}`;
  const x = (label, cmd) => b(label, `m:x:${back}|${cmd}`);
  return {
    text: [`🗂 پنل #${p.id} — ${p.label} (${p.kind})`, '',
      `وضعیت: ${STATE_FA[p.state] || p.state}${p.state === 'rollout' ? ` ${p.rollout_percent}%` : ''}`,
      `سلامت: ${p.health} · ${n} کاربر فعال${p.version ? ` · نسخه ${p.version}` : ''}`, '',
      'ورود تدریجی = چند درصد کاربران روی این پنل هم اکانت بگیرند.'].join('\n'),
    kb: [
      [x('🧪 تست پنل', `/paneltest ${p.id}`), b('👥 گروه‌ها / سرویس', `m:w:groups:${p.id}`)],
      [x('10%', `/rollout ${p.id} 10`), x('25%', `/rollout ${p.id} 25`), x('50%', `/rollout ${p.id} 50`), x('100%', `/rollout ${p.id} 100`)],
      [x('🚪 خارج‌کردن پنل', `/drainpanel ${p.id}`)],
      [b('🔙 پنل‌ها', 'm:pa'), HOME],
    ],
  };
}

async function coupons(env) {
  const rows = await all(env, 'SELECT * FROM coupons WHERE is_active = 1 ORDER BY id DESC LIMIT 20');
  const lines = rows.map((c) => `${c.code} — ${c.percent}% · ${c.used}${c.max_uses ? '/' + c.max_uses : ''} استفاده${c.expires_at ? ` · تا ${new Date(c.expires_at * 1000).toISOString().slice(0, 10)}` : ''}${c.plan_id ? ` · پلن #${c.plan_id}` : ''}`);
  return {
    text: `🏷 کدهای تخفیف\n\n${lines.join('\n') || 'کدی نیست.'}${rows.length ? '\n\nبرای پاک کردن، روی 🗑 کنار کد بزن.' : ''}`,
    kb: [...rows.filter((c) => c.code.length <= 50).map((c) => [b(`🗑 ${c.code}`, `m:cd:${c.code}`)]), [b('➕ کد جدید', 'm:w:coupon')], [HOME]],
  };
}

const AUTO_FA = { auto: 'خودکار', detect: 'فقط خبر بده', off: 'خاموش' };

async function payments(env) {
  const s = await getSettings(env);
  const card = String(s.card_number || '');
  const mode = (key) => ['auto', 'detect', 'off'].map((v) => b(`${s[key] === v ? '✅ ' : ''}${AUTO_FA[v]}`, `m:sv:${key}:${v}`));
  return {
    text: ['💰 پرداخت‌ها', '',
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
      [HOME],
    ],
  };
}

// short Persian hints for the settings screen
const KEY_FA = {
  card_number: 'شماره کارت', card_holder: 'نام صاحب کارت', card_bank: 'بانک', usdt_rate_toman: 'قیمت تتر (قدیمی)',
  referral_percent: 'درصد پاداش دعوت', pg_group_ids: 'گروه‌های پنل', support_url: 'لینک پشتیبانی', min_topup_toman: 'حداقل شارژ',
  announcement: 'اطلاعیه‌ی اپ', trial_data_gb: 'حجم تست رایگان (0 = مثل پلن)', usd_rate_toman: 'قیمت دستی دلار (0 = خودکار)',
  coin_minutes: 'مهلت پرداخت ارز (دقیقه)', card_unique: 'مبلغ یکتا (1 روشن، 0 خاموش)', card_auto: 'تأیید پیامکی کارت',
  sms_senders: 'فرستنده‌های بانکی', sms_key: 'کلید آدرس پیامک', coin_auto: 'تأیید ارز دیجیتال',
};

async function settings(env, wallets) {
  const s = await getSettings(env);
  const keys = Object.keys(SETTING_DEFAULTS).filter((k) => k.startsWith('wallet_') === !!wallets);
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) rows.push(keys.slice(i, i + 2).map((k) => b(`${s[k] ? '' : '⚪️ '}${wallets ? k.slice(7) : (KEY_FA[k] || k)}`, `m:sk:${k}`)));
  return {
    text: wallets ? '💎 ولت‌های ارز دیجیتال\n⚪️ = خالی (آن ارز در اپ نشان داده نمی‌شود). روی هر کدام بزن.'
      : '⚙️ تنظیمات\nروی هر مورد بزن تا مقدارش را ببینی یا عوض کنی. (⚪️ = خالی)',
    kb: [...rows, wallets ? [b('🔙 پرداخت‌ها', 'm:pay'), HOME] : [HOME]],
  };
}

async function settingKey(env, key) {
  if (!(key in SETTING_DEFAULTS)) return { text: 'کلید ناشناخته.', kb: [[b('🔙 تنظیمات', 'm:set'), HOME]] };
  const s = await getSettings(env);
  const parent = key.startsWith('wallet_') ? 'wl' : 'set';
  return {
    text: `⚙️ ${KEY_FA[key] || key}\n${key} = ${s[key] || '(خالی)'}`,
    kb: [[b('✏️ تغییر', `m:w:set:${key}`), b('🧹 خالی کن', `m:x:sk:${key}|/set ${key}`)], [b('🔙 برگشت', 'm:' + parent), HOME]],
  };
}

// ---------------- questions the bot asks ----------------
const PLAN_HINT = { price: 'قیمت به تومان', old: 'قیمت قبلی (خط‌خورده) به تومان، 0 = ندارد', days: 'تعداد روز', gb: 'حجم به گیگ، 0 = نامحدود',
  devices: 'تعداد دستگاه، 0 = نامحدود', trial: 'روزهای تست رایگان، 0 = ندارد', name: 'نام پلن', badge: 'نشان (مثلاً پیشنهاد ویژه)' };

async function ask(env, kind, args) {
  if (kind === 'find') return ['/find', 'usr', '📧 ایمیل کاربر را بنویس:'];
  if (kind === 'reset') {
    const u = await first(env, 'SELECT email FROM users WHERE id = ?', parseInt(args[0], 10));
    if (!u) return null;
    return [`/reset ${u.email}`, `u:${args[0]}`, `🔑 رمز جدید ${u.email} را بنویس (حداقل ۸ کاراکتر).\nپیامت بعد از خواندن پاک می‌شود.`, true];
  }
  if (kind === 'link') {
    const u = await first(env, 'SELECT email FROM users WHERE id = ?', parseInt(args[0], 10));
    if (!u) return null;
    return [`/link ${u.email}`, `u:${args[0]}`, `🔗 یوزرنیم اکانتی که ${u.email} روی پنل پاسارگاد دارد (همان که با v2rayNG استفاده می‌کند) را بنویس.\nاگر روی پنل ۱ نیست، بعد از یوزرنیم شماره‌ی پنل را هم بنویس، مثلاً: ali_v2 2\n\nروی پنل اکانت جدیدی ساخته نمی‌شود.`];
  }
  if (kind === 'plan') {
    const id = parseInt(args[0], 10);
    if (!(args[1] in PLAN_FIELDS)) return null;
    return [`/plan ${id} ${args[1]}`, `p:${id}`, `✏️ پلن #${id}: ${PLAN_HINT[args[1]] || args[1]} را بنویس:`];
  }
  if (kind === 'newplan') return ['/newplan', 'pl', '➕ پلن جدید را این‌طوری بنویس:\nنام|روز|گیگ|دستگاه|قیمت\n\nمثال:\nسه ماهه|90|0|2|399000\n(گیگ یا دستگاه 0 = نامحدود)'];
  if (kind === 'addpanel') return ['/addpanel auto', 'pa', '➕ یک نام برای پنل جدید بنویس، مثلاً: آلمان ۲\nنوع پنل (PasarGuard، Marzban یا Rebecca) موقع تست خودکار تشخیص داده می‌شود.'];
  if (kind === 'groups') return [`/panelgroups ${parseInt(args[0], 10)}`, `pp:${parseInt(args[0], 10)}`, '👥 شماره‌ی گروه‌های پنل را با کاما بنویس (مثلاً 1,2).\nبرای Rebecca فقط شماره‌ی یک سرویس (Service) را بنویس:'];
  if (kind === 'coupon') return ['/coupon', 'cp', '🏷 کد جدید را این‌طوری بنویس:\nکد درصد [تعداد] [روز] [شماره‌پلن]\n\nمثال: YALDA 20 100 7\n(یعنی ۲۰٪، ۱۰۰ بار، ۷ روز)'];
  if (kind === 'set' && args[0] in SETTING_DEFAULTS) {
    const back = ['card_number', 'card_holder'].includes(args[0]) ? 'pay' : `sk:${args[0]}`;
    return [`/set ${args[0]}`, back, `✏️ مقدار جدید «${KEY_FA[args[0]] || args[0]}» را بنویس:`];
  }
  return null;
}

// ---------------- pending receipts ----------------
// Sends each receipt waiting for review again, with its Approve/Reject buttons (the ap:/rj: handlers in telegram.js).
async function sendPending(env, chatId) {
  const rows = await all(env, "SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = 'review' ORDER BY o.id LIMIT 6");
  for (const o of rows.slice(0, 5)) {
    let what = 'شارژ کیف پول';
    if (o.kind === 'plan' || o.activate_plan_id) {
      const p = await first(env, 'SELECT name FROM plans WHERE id = ?', o.plan_id || o.activate_plan_id);
      what = o.kind === 'plan' ? `پلن ${p ? p.name : ''}` : `شارژ + فعال‌سازی پلن ${p ? p.name : ''}`;
    }
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
  const s = await home(env);
  return tg(env, 'sendMessage', { chat_id: chatId, text: s.text, reply_markup: { inline_keyboard: s.kb } });
}

// Menu messages are edited in place; a photo (receipt) cannot become a menu, so it gets a new message.
async function show(env, cq, s) {
  const m = cq.message || {};
  const body = { text: String(s.text).slice(0, 4000), reply_markup: { inline_keyboard: s.kb }, disable_web_page_preview: true };
  if (m.text && m.message_id) return tg(env, 'editMessageText', { chat_id: m.chat.id, message_id: m.message_id, ...body });
  return tg(env, 'sendMessage', { chat_id: m.chat.id, ...body });
}

export async function onMenu(env, cq) {
  const chatId = cq.message?.chat?.id;
  const ack = (text, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: text ? String(text).slice(0, 190) : undefined, show_alert: !!alert });
  const data = String(cq.data || '').slice(2);
  const [screen, ...args] = data.split(':');
  const int = (i) => parseInt(args[i], 10);

  // run a text command; its answer comes as a new message with a "back" button
  if (screen === 'x') {
    const rest = data.slice(2);
    const i = rest.indexOf('|');
    if (i < 0) return ack('');
    await ack('⏳');
    return runAdminCommand(env, chatId, rest.slice(i + 1), backKb(rest.slice(0, i)));
  }
  if (screen === 'w') {
    const q = await ask(env, args[0], args.slice(1));
    if (!q) return ack('پیدا نشد');
    const [cmd, back, prompt, secret] = q;
    await setWait(env, cmd, back, secret);
    await show(env, cq, { text: prompt + '\n\n(تا ۱۰ دقیقه منتظر جوابت هستم)', kb: [[b('❌ انصراف', `m:cancel:${back}`)]] });
    return ack('');
  }
  if (screen === 'cancel') {
    await takeWait(env);
    await ack('لغو شد');
    return showScreen(env, cq, args.join(':') || 'home');
  }
  if (screen === 'ord') {
    const review = (await first(env, "SELECT COUNT(*) c FROM orders WHERE status = 'review'")).c;
    if (!review) { await ack('رسیدی منتظر نیست ✅'); return showScreen(env, cq, 'home'); }
    await ack('⏳');
    const more = await sendPending(env, chatId);
    return tg(env, 'sendMessage', { chat_id: chatId, text: `🧾 ${review} رسید منتظر بررسی بالا فرستاده شد. ${more}`.trim(), reply_markup: backKb('home') });
  }
  if (screen === 'ug') {
    const u = await first(env, 'SELECT id, email FROM users WHERE id = ?', int(0));
    const rows = await all(env, 'SELECT id, name, duration_days FROM plans WHERE is_active = 1 ORDER BY sort, id');
    if (!u) return ack('کاربر پیدا نشد');
    await show(env, cq, { text: `🎁 کدام پلن به ${u.email} داده شود؟`,
      kb: [...rows.map((p) => [b(`${p.name} (${p.duration_days} روز)`, `m:ugp:${u.id}:${p.id}`)]), [b('🔙 برگشت', `m:u:${u.id}`), HOME]] });
    return ack('');
  }
  if (screen === 'ugp') {
    const u = await first(env, 'SELECT id, email FROM users WHERE id = ?', int(0));
    const p = await first(env, 'SELECT id, name FROM plans WHERE id = ?', int(1));
    if (!u || !p) return ack('پیدا نشد');
    await askConfirm(env, chatId, 'grant', { user_id: u.id, plan_id: p.id }, `پلن «${p.name}» به ${u.email} داده شود؟`);
    return ack('');
  }
  if (screen === 'pt') {
    await run(env, 'UPDATE plans SET is_active = 1 - is_active WHERE id = ?', int(0));
    await ack('انجام شد');
    return showScreen(env, cq, `p:${int(0)}`);
  }
  if (screen === 'cd') {
    const code = args.join(':');
    await askConfirm(env, chatId, 'del_coupon', { code }, `کد تخفیف ${code} پاک شود؟`);
    return ack('');
  }
  if (screen === 'sv') {
    const [key, val] = args;
    if (!['card_auto', 'coin_auto'].includes(key) || !(val in AUTO_FA)) return ack('');
    await setSetting(env, key, val);
    await ack('✅ ' + AUTO_FA[val]);
    return showScreen(env, cq, 'pay');
  }
  if (screen === 'u') {
    const u = await first(env, 'SELECT * FROM users WHERE id = ?', int(0));
    if (!u) return ack('کاربر پیدا نشد');
    await ack('⏳');
    return show(env, cq, { text: await userInfo(env, u), kb: userKb(u.id).inline_keyboard });
  }
  await ack('');
  return showScreen(env, cq, data);
}

async function showScreen(env, cq, data) {
  const [screen, arg] = data.split(':');
  const id = parseInt(arg, 10);
  let s;
  if (screen === 'st') s = { text: await statsText(env), kb: [[b('🔄 به‌روزرسانی', 'm:st'), HOME]] };
  else if (screen === 'help') s = { text: HELP, kb: [[HOME]] };
  else if (screen === 'usr') s = await users(env);
  else if (screen === 'pl') s = await plans(env);
  else if (screen === 'p') s = await plan(env, id);
  else if (screen === 'pa') s = await panels(env);
  else if (screen === 'pp') s = await panel(env, id);
  else if (screen === 'cp') s = await coupons(env);
  else if (screen === 'pay') s = await payments(env);
  else if (screen === 'set') s = await settings(env, false);
  else if (screen === 'wl') s = await settings(env, true);
  else if (screen === 'sk') s = await settingKey(env, arg);
  else if (screen === 'u') {
    const u = await first(env, 'SELECT * FROM users WHERE id = ?', id);
    s = u ? { text: await userInfo(env, u), kb: userKb(u.id).inline_keyboard } : await users(env);
  } else s = await home(env);
  return show(env, cq, s);
}
