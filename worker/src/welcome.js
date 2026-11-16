// The bot's welcome for new people (design D, picked by the owner 2026-11-16). The first time someone who is not yet
// a Pleat user starts the bot, they get a banner card with three feature lines, the version and size, and four
// buttons: the APK as a Telegram file, our own download link, GitHub, and how to install. Later /starts get the
// short "Open Pleat" message with a "Get the app" button that brings the card back.
//
// The APK (~52 MB) is over the 50 MB a bot may upload, so the bot cannot send it by itself. The owner sends the file
// to the bot once per version (📱 اپ Pleat › 📲 نسخه‌ی اپ › 📎 فایل تلگرامی); Telegram then lets the bot send that
// same file to anyone by its file_id, at any size. It is kept in the setting `app_tg_file`, and offered only while it
// is the announced version, so nobody is handed an old build.
//
// User-facing text is English (like the rest of the user side); the owner's side is Persian.
// Free plan: a /start costs at most 3 D1 queries (admin check, bot_users insert, settings) and 1-2 Telegram calls.
import { first, getSettings, setSetting } from './db.js';
import { nowSec, rateLimit } from './util.js';
import { tg, audit } from './telegram.js';
import { cleanRelease, githubApkUrl } from './appupdate.js';

export const BANNER_PATH = '/welcome.jpg'; // built from miniapp/src/welcome.jpg into worker/public/
const ARM = 'arm64-v8a';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mb = (n) => `${Math.max(1, Math.round(n / 1048576))} MB`;
const baseOf = (env) => { const b = String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''); return /^https:\/\//.test(b) ? b : ''; };

// Remembers that this Telegram account opened the bot. True only the very first time, and only for someone who is
// not already a Pleat user with this Telegram id (they have the app). One statement, one write per person ever.
export async function firstVisit(env, from, { hasApp = false } = {}) {
  if (!from || !from.id || from.is_bot || !/^\d{1,20}$/.test(String(from.id))) return false;
  const row = await first(env, `INSERT INTO bot_users (tg_id, first_seen, had_account, welcomed_at)
      SELECT ?1, ?2, e, CASE WHEN e THEN NULL ELSE ?2 END FROM (SELECT (?3 OR EXISTS(SELECT 1 FROM users WHERE tg_id = ?1)) e)
      WHERE 1 ON CONFLICT(tg_id) DO NOTHING RETURNING had_account`, from.id, nowSec(), hasApp ? 1 : 0).catch(() => null);
  return !!row && !row.had_account;
}

// The Telegram copy of the APK, when it is the one users should get: the announced version, or any stored one while
// nothing is announced.
export function tgFile(settings) {
  let f = null;
  try { f = JSON.parse(settings.app_tg_file || 'null'); } catch (e) { return null; }
  if (!f || typeof f.file_id !== 'string' || !f.file_id) return null;
  const rel = releaseOf(settings);
  if (rel && f.version && f.version !== rel.version) return null;
  return f;
}
const releaseOf = (settings) => { try { return cleanRelease(JSON.parse(settings.app_release || 'null')); } catch (e) { return null; } };

// The card itself: { photo, caption, reply_markup } (sent with sendPhoto; sendMessage when the banner can't load).
export function welcomeCard(env, settings, from) {
  const rel = releaseOf(settings);
  const file = tgFile(settings);
  const name = String((from && from.first_name) || '').trim().slice(0, 32);
  const version = rel ? rel.version : file && file.version;
  const size = rel && rel.abis[ARM] ? rel.abis[ARM].size : file && file.size;
  const facts = [version ? `v${version}` : '', 'Android', size ? mb(size) : ''].filter(Boolean).join(' · ');
  const caption = [
    `<b>Welcome${name ? ', ' + esc(name) : ''} 👋</b>`,
    '<blockquote>⚡ One tap connects you to the fastest exit\n🌍 Servers in many countries\n🔒 Your traffic stays private</blockquote>',
    `<b>Get the app</b> · ${facts}`,
  ].join('\n');
  const base = baseOf(env);
  const btns = [];
  if (file) btns.push({ text: '📥 In Telegram', callback_data: 'pw:apk' });
  if (rel && rel.abis[ARM] && env.PLEAT_DL_TOKEN && base) btns.push({ text: '⚡ Fast link', url: `${base}/dl/pleat.apk` });
  btns.push({ text: 'GitHub', url: githubApkUrl(env, rel) });
  btns.push({ text: '❓ How to install', callback_data: 'pw:help' });
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  return { photo: base ? base + BANNER_PATH : '', caption, reply_markup: { inline_keyboard: rows } };
}

export async function sendWelcome(env, chatId, from, settings) {
  const card = welcomeCard(env, settings || await getSettings(env), from);
  const { photo, caption, reply_markup } = card;
  const r = photo ? await tg(env, 'sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', reply_markup }) : null;
  if (r && r.ok) return r;
  return tg(env, 'sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup, disable_web_page_preview: true });
}

export const HOW_TO = [
  '<b>How to install Pleat</b>', '',
  '1. Tap the file (or open the download) and choose <b>Install</b>.',
  '2. If Android asks, allow installs from Telegram or your browser, then go back.',
  '3. Play Protect warning? Tap <b>More details</b>, then <b>Install anyway</b>.',
  '4. Open Pleat and tap <b>Continue with Telegram</b>. This bot sends you a 6-digit code.',
].join('\n');
export const FILE_CAPTION = 'Tap to install. Then open Pleat and choose <b>Continue with Telegram</b>.';

// A tap on the card's buttons (pw:app | pw:apk | pw:help), from anyone in a private chat with the bot.
export async function onTap(env, cq) {
  const chatId = cq.message?.chat?.id;
  const ack = (text, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: !!alert } : {}) });
  if (!chatId || cq.message.chat.type !== 'private' || !cq.from || String(cq.from.id) !== String(chatId)) return ack('');
  const what = String(cq.data || '').slice(3);
  if (!['app', 'apk', 'help'].includes(what)) return ack('');
  // open when the limiter fails: every tap sends one message at most, and Telegram limits the bot too
  try { await rateLimit(env, 'RL_IP', 'pw:' + chatId, { open: true }); } catch (e) { return ack('Too many taps. Wait a minute and try again.', true); }
  if (what === 'help') { await ack(''); return tg(env, 'sendMessage', { chat_id: chatId, text: HOW_TO, parse_mode: 'HTML' }); }
  const settings = await getSettings(env);
  if (what === 'app') { await ack(''); return sendWelcome(env, chatId, cq.from, settings); }
  const file = tgFile(settings);
  if (!file) return ack('The file is not here yet. Use "Fast link" or "GitHub".', true);
  await ack('Sending the app…');
  const r = await tg(env, 'sendDocument', { chat_id: chatId, document: file.file_id, caption: FILE_CAPTION, parse_mode: 'HTML' });
  if (!r || !r.ok) return tg(env, 'sendMessage', { chat_id: chatId, text: 'Could not send the file right now. Use "Fast link" or "GitHub" above, or try again in a minute.' });
  return r;
}

// ---------------- the owner's side (Persian) ----------------
// The file the owner sent after tapping «📎 فایل تلگرامی». Returns the Persian answer.
export async function saveTgFile(env, adminId, doc) {
  if (!doc || typeof doc.file_id !== 'string') return '⚠️ فایلی دریافت نشد.';
  const name = String(doc.file_name || '');
  const size = parseInt(doc.file_size, 10) || 0;
  if (!/\.apk$/i.test(name)) return '⚠️ این فایل APK نیست (اسمش باید با .apk تمام شود). فایل pleat.apk را بفرست.';
  if (size < 1048576) return '⚠️ این فایل خیلی کوچک است و نمی‌تواند اپ Pleat باشد.';
  const settings = await getSettings(env);
  const rel = releaseOf(settings);
  const fromName = (/(\d+\.\d+\.\d+)/.exec(name) || [])[1];
  const version = fromName || (rel && rel.version) || '';
  if (!version) return '⚠️ نسخه‌ی این فایل معلوم نیست: هنوز نسخه‌ای اعلام نشده و اسم فایل هم شماره ندارد. اول نسخه را اعلام کن، یا فایلی با اسم مثل pleat-1.2.53-56-arm64-v8a.apk بفرست.';
  const arm = rel && rel.abis[ARM];
  const same = !!(arm && arm.size === size);
  await setSetting(env, 'app_tg_file', JSON.stringify({ file_id: doc.file_id, unique: String(doc.file_unique_id || ''), name: name.slice(0, 80), size, version, same, at: nowSec() }));
  await audit(env, adminId, 'app.tg_file', 'setting', 'app_tg_file', `${name.slice(0, 60)} ${version} ${mb(size)}`);
  const lines = [`✅ فایل تلگرامی ذخیره شد: ${version} · ${mb(size)}`, ''];
  if (same) lines.push('حجمش دقیقاً با فایل arm64 نسخه‌ی اعلام‌شده یکی است 👍');
  else if (arm) lines.push(`⚠️ حجمش (${fa(size)} بایت) با فایل arm64 نسخه‌ی اعلام‌شده (${fa(arm.size)} بایت) یکی نیست. اگر فایل دیگری فرستادی، دوباره بفرست.`);
  if (rel && version !== rel.version) lines.push(`⚠️ نسخه‌ی فایل (${version}) با نسخه‌ی اعلام‌شده (${rel.version}) یکی نیست؛ تا یکی نشوند دکمه‌ی «In Telegram» به کاربرها نشان داده نمی‌شود.`);
  lines.push('', 'از این به بعد کاربر جدید با دکمه‌ی «📥 In Telegram» همین فایل را در تلگرام می‌گیرد.');
  return lines.join('\n');
}
const fa = (n) => Number(n || 0).toLocaleString('en-US');

// Lines for the owner's 📲 screen.
export function ownerLines(settings) {
  let f = null;
  try { f = JSON.parse(settings.app_tg_file || 'null'); } catch (e) { f = null; }
  const rel = releaseOf(settings);
  if (!f || !f.file_id) return ['📎 فایل تلگرامی برای کاربرهای جدید: — (هنوز نفرستاده‌ای؛ کاربرها فقط لینک‌ها را می‌گیرند)'];
  const out = [`📎 فایل تلگرامی برای کاربرهای جدید: ${f.version} · ${mb(f.size)}`];
  if (rel && f.version !== rel.version) out.push(`   ⚠️ نسخه‌ی اعلام‌شده ${rel.version} است؛ فایل همین نسخه را بفرست (تا آن موقع دکمه‌ی In Telegram پنهان است).`);
  return out;
}
