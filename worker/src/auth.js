// Accounts: register / login / refresh / change-password. Email + password, or Telegram (6-digit code from the
// bot, then a password; later logins with @username or numeric Telegram id + password).
import { first, run, insert, touchDevice } from './db.js';
import { json, err, hashPassword, verifyPassword, signJwt, verifyJwt, jwtSecret, cleanEmail, cleanNewEmail, randomCode, nowSec, hmacHex, safeEqual, rateLimit, spendBudget } from './util.js';

const ACCESS_MIN = 30;
const REFRESH_DAYS = 60;
// same shape as a real hash (pbkdf2$iterations$salt$hash); never matches anything
const DUMMY_HASH = `pbkdf2$5000$${'0'.repeat(32)}$${'0'.repeat(64)}`;

async function makeTokens(env, user) {
  const base = { sub: String(user.id), ver: user.token_version };
  return {
    access_token: await signJwt({ ...base, typ: 'access' }, jwtSecret(env), ACCESS_MIN * 60),
    refresh_token: await signJwt({ ...base, typ: 'refresh' }, jwtSecret(env), REFRESH_DAYS * 86400),
    token_type: 'bearer',
    expires_in: ACCESS_MIN * 60,
  };
}

export async function requireUser(env, request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = await verifyJwt(token, jwtSecret(env));
  if (!payload || payload.typ !== 'access') throw err(401, 'not_authenticated', 'اول وارد حساب شو.');
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', parseInt(payload.sub, 10));
  if (!user || user.token_version !== payload.ver) throw err(401, 'token_invalid', 'نشست تمام شده؛ دوباره وارد شو.');
  if (!user.is_active) throw err(403, 'account_disabled', 'این حساب غیرفعال شده است.');
  if (payload.src === 'mini') user._mini = true; // signed in from the Telegram Mini App (see webappLogin)
  return user;
}

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw err(422, 'invalid_input', 'رمز باید حداقل ۸ کاراکتر باشد.', 'password');
  if (pw.length > 128) throw err(422, 'invalid_input', 'رمز خیلی طولانی است.', 'password');
}

const dev = (body, headers) => ({
  id: body.device_id || headers.get('x-device-id') || null,
  model: body.device_model || headers.get('x-device-model') || '',
});

export async function register(env, body, headers) {
  const email = cleanNewEmail(body.email);
  // addresses of Telegram accounts are made up by the server; nobody may take one by email first
  if (email.endsWith('@' + TG_DOMAIN)) throw err(422, 'invalid_input', 'یک ایمیل درست وارد کن.', 'email');
  checkPassword(body.password);
  const existing = await first(env, 'SELECT id FROM users WHERE email = ?', email);
  if (existing) throw err(409, 'email_taken', 'با این ایمیل قبلاً حساب ساخته شده. وارد شو.');
  // the gate against sign-up floods: only a sign-up that is about to write counts, and a refused one writes nothing
  await spendBudget(env, 'signup');
  let id;
  try {
    id = await insert(env, 'users', {
      email, password_hash: await hashPassword(body.password, env.SECRET_KEY), ...(await newUserFields(env, body)),
    });
  } catch (e) {
    // two sign-ups with the same email at the same moment: the UNIQUE index stops the second one
    if (/UNIQUE/i.test(String(e && e.message)) && (await first(env, 'SELECT id FROM users WHERE email = ?', email))) {
      throw err(409, 'email_taken', 'با این ایمیل قبلاً حساب ساخته شده. وارد شو.');
    }
    throw e;
  }
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', id);
  const d = dev(body, headers);
  await touchDevice(env, id, d.id, d.model);
  return json(await makeTokens(env, user), 201);
}

export async function newUserFields(env, body) {
  let referredBy = null;
  if (body.referral_code) {
    const r = await first(env, 'SELECT id FROM users WHERE referral_code = ?', String(body.referral_code).trim().toUpperCase());
    if (r) referredBy = r.id;
  }
  let code;
  for (let i = 0; i < 5; i++) { code = randomCode(); if (!(await first(env, 'SELECT 1 FROM users WHERE referral_code = ?', code))) break; }
  return { referral_code: code, referred_by_id: referredBy, created_at: nowSec() };
}

// What the person typed in the login box: an email, a Telegram @username (with or without "@") or a numeric
// Telegram id. Usernames start with a letter on Telegram, so an all-digit login is always an id.
export function loginKey(v) {
  const s = String(v || '').trim().toLowerCase();
  if (/^[^@\s]+@[^@\s]+$/.test(s)) return { kind: 'email', value: cleanEmail(s), key: s };
  const name = s.replace(/^@/, '');
  if (/^\d{1,20}$/.test(name)) return { kind: 'tg_id', value: name, key: 'tg:' + name };
  if (/^[a-z][a-z0-9_]{3,31}$/.test(name)) return { kind: 'tg_username', value: name, key: '@' + name };
  throw err(422, 'invalid_input', 'Enter your email, Telegram username or Telegram ID.', 'email');
}

export async function findUserByLogin(env, v) {
  const k = loginKey(v);
  if (k.kind === 'email') return first(env, 'SELECT * FROM users WHERE email = ?', k.value);
  if (k.kind === 'tg_id') return first(env, 'SELECT * FROM users WHERE tg_id = ?', Number(k.value));
  return first(env, 'SELECT * FROM users WHERE tg_username = ?', k.value);
}

export async function login(env, body, headers) {
  const user = await findUserByLogin(env, body.login ?? body.email);
  // also limited per account: email, @username and Telegram id each had their own 5 tries a minute
  if (user) await rateLimit(env, 'RL_LOGIN', 'uid:' + user.id);
  // an unknown email still costs one hash, so the response time doesn't tell which emails have accounts
  const stored = user ? user.password_hash : DUMMY_HASH;
  if (!(await verifyPassword(body.password || '', stored, env.SECRET_KEY)) || !user) {
    throw err(401, 'bad_credentials', 'ایمیل/یوزرنیم یا رمز اشتباه است.');
  }
  if (!user.is_active) throw err(403, 'account_disabled', 'این حساب غیرفعال شده است.');
  await run(env, 'UPDATE users SET last_login_at = ? WHERE id = ?', nowSec(), user.id);
  const d = dev(body, headers);
  await touchDevice(env, user.id, d.id, d.model);
  return json(await makeTokens(env, user));
}

export async function refresh(env, body) {
  const payload = await verifyJwt(body.refresh_token, jwtSecret(env));
  if (!payload || payload.typ !== 'refresh') throw err(401, 'token_invalid', 'لطفاً دوباره وارد شو.');
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', parseInt(payload.sub, 10));
  if (!user || user.token_version !== payload.ver || !user.is_active) throw err(401, 'token_invalid', 'لطفاً دوباره وارد شو.');
  return json(await makeTokens(env, user));
}

export async function changePassword(env, user, body) {
  if (!(await verifyPassword(body.current_password || '', user.password_hash, env.SECRET_KEY))) {
    throw err(400, 'wrong_password', 'رمز فعلی اشتباه است.', 'current_password');
  }
  checkPassword(body.new_password);
  await run(env, 'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', await hashPassword(body.new_password, env.SECRET_KEY), user.id);
  const fresh = await first(env, 'SELECT * FROM users WHERE id = ?', user.id);
  return json(await makeTokens(env, fresh));
}

export async function logoutAll(env, user) {
  await run(env, 'UPDATE users SET token_version = token_version + 1 WHERE id = ?', user.id);
  return new Response(null, { status: 204 });
}

// ---------------- Telegram sign-up / login ----------------
// 1. app: POST /auth/tg/start -> { nonce, bot_url }. The app keeps the nonce and opens the bot with it.
// 2. bot: "/start L<nonce>" -> the bot sends a 6-digit code to the Telegram user who opened the link. Telegram
//    itself says who that is (id, username, name), so nobody can claim someone else's Telegram account.
// 3. app: POST /auth/tg/verify { nonce, code } -> tokens (account exists) or { need_password, signup_token }.
// 4. app: POST /auth/tg/register { signup_token, password } -> account created, tokens.
// The code only works together with the nonce of the phone that asked for it, lives 5 minutes, and allows
// 5 wrong tries; the link lives 10 minutes and sends at most 5 codes. Nonce and code are stored as HMACs.
export const TG_DOMAIN = 'telegram.local';
export const tgEmail = (tgId) => `tg${tgId}@${TG_DOMAIN}`;
const LINK_SEC = 600;
const CODE_SEC = 300;
const MAX_TRIES = 5;
const MAX_CODES = 5;
const SIGNUP_MIN = 15;

const nonceHash = (env, nonce) => hmacHex(env.SECRET_KEY, 'tg-nonce|' + nonce);
const codeHash = (env, nonce, code) => hmacHex(env.SECRET_KEY, 'tg-code|' + nonce + '|' + code);
const NONCE_RE = /^[a-f0-9]{32}$/;

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// 6 digits, every value equally likely (rejects the few 32-bit values that would bias the remainder)
export function sixDigits() {
  const lim = 4294000000; // multiple of 1e6 below 2^32
  for (;;) {
    const v = crypto.getRandomValues(new Uint32Array(1))[0];
    if (v < lim) return String(v % 1000000).padStart(6, '0');
  }
}

let botName = null;
async function botUsername(env) {
  if (env.TELEGRAM_BOT_USERNAME) return String(env.TELEGRAM_BOT_USERNAME).replace(/^@/, '');
  if (botName) return botName;
  const { tg } = await import('./telegram.js');
  const r = await tg(env, 'getMe', {});
  if (r && r.ok && r.result && r.result.username) botName = r.result.username;
  return botName;
}

// linkUserId: a signed-in email account asking to verify its Telegram (profile screen); otherwise a sign-in
export async function tgStart(env, linkUserId = null) {
  const bot = await botUsername(env);
  if (!bot) throw err(503, 'telegram_unavailable', 'Telegram sign-in is not available right now. Try again later or use email.');
  // the gate against link floods (each link is a row): refused before anything is written
  await spendBudget(env, 'tgstart');
  const nonce = randomHex(16);
  const now = nowSec();
  await run(env, 'DELETE FROM tg_logins WHERE expires_at < ?', now - 3600);
  await insert(env, 'tg_logins', { nonce_hash: await nonceHash(env, nonce), created_at: now, expires_at: now + LINK_SEC, link_user_id: linkUserId });
  return json({
    nonce, bot_username: bot, expires_in: LINK_SEC,
    bot_url: `https://t.me/${bot}?start=L${nonce}`,
    app_url: `tg://resolve?domain=${bot}&start=L${nonce}`,
  });
}

// The bot got "/start L<nonce>" from `from` (a private chat). Returns the text to send back.
export async function tgIssueCode(env, nonce, from) {
  const expired = 'This sign-in link has expired. Go back to the app and tap "Continue with Telegram" again.';
  if (!NONCE_RE.test(nonce || '') || !from || from.is_bot || !from.id) return { text: expired };
  try { await rateLimit(env, 'RL_LOGIN', 'tgcode:' + from.id); } catch (e) { return { text: 'Too many codes. Wait a minute and tap Start again.' }; }
  const h = await nonceHash(env, nonce);
  const row = await first(env, 'SELECT * FROM tg_logins WHERE nonce_hash = ?', h);
  const now = nowSec();
  if (!row || row.used || row.expires_at < now) return { text: expired };
  if (row.tg_id && String(row.tg_id) !== String(from.id)) return { text: 'This sign-in link was already opened by another Telegram account.' };
  if (row.codes_sent >= MAX_CODES) return { text: 'Too many codes for this link. Go back to the app and start again.' };
  if (row.link_user_id) {
    const owner = await first(env, 'SELECT id FROM users WHERE tg_id = ?', from.id);
    if (owner && owner.id !== row.link_user_id) return { text: 'This Telegram account already belongs to another Pleat account. Use a different Telegram account, or log in with this one.' };
  }
  const code = sixDigits();
  const username = /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(from.username || '') ? from.username.toLowerCase() : null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 64);
  // a new code also gives back the 5 tries (the person had to tap Start again in Telegram to get it)
  const r = await run(env, `UPDATE tg_logins SET tg_id = ?, tg_username = ?, tg_name = ?, code_hash = ?, code_expires_at = ?,
      codes_sent = codes_sent + 1, attempts = 0 WHERE nonce_hash = ? AND used = 0 AND codes_sent < ? AND (tg_id IS NULL OR tg_id = ?)`,
    from.id, username, name, await codeHash(env, nonce, code), now + CODE_SEC, h, MAX_CODES, from.id);
  if (!r.meta.changes) return { text: expired };
  // the code sits under a spoiler (hidden until tapped); Telegram does not allow <code> inside <tg-spoiler>
  if (row.link_user_id) return { text: `🛡 <b>Pleat verification code</b>\n\nTap to reveal:  <tg-spoiler>${code}</tg-spoiler>\n\nEnter it in the Pleat app within <b>5 minutes</b> to verify this Telegram account.\n\n<blockquote>Didn't ask for this? Ignore this message. Nothing changes without this code.</blockquote>`, html: true };
  return { text: `🛡 <b>Pleat security code</b>\n\nTap to reveal:  <tg-spoiler>${code}</tg-spoiler>\n\nEnter it in the Pleat app within <b>5 minutes</b>.\n\n<blockquote>Didn't try to sign in? Ignore this message. Nobody can get into your account without this code.</blockquote>`, html: true };
}

// Telegram username follows the person: whoever had it before (they renamed on Telegram) loses it here.
async function setTgUsername(env, userId, tgId, username, name) {
  if (username) await run(env, 'UPDATE users SET tg_username = NULL WHERE tg_username = ? AND id != ?', username, userId);
  await run(env, 'UPDATE users SET tg_username = ?, tg_name = ? WHERE id = ?', username, name || '', userId);
}

// Checks the code typed for a link and uses the link up. linkUserId null = a sign-in link, else the account that
// asked to verify its Telegram: a link of one kind never passes as the other.
async function useCode(env, body, linkUserId) {
  const nonce = String(body.nonce || '');
  const code = String(body.code || '').replace(/\D/g, '');
  const wrong = () => err(400, 'bad_code', 'The code is wrong or has expired.', 'code');
  if (!NONCE_RE.test(nonce) || code.length !== 6) throw wrong();
  const h = await nonceHash(env, nonce);
  const now = nowSec();
  const owner = linkUserId == null ? 'link_user_id IS NULL' : 'link_user_id = ?';
  const ownerArgs = linkUserId == null ? [] : [linkUserId];
  // count the try first (atomically), so parallel guesses can't get more than 5
  const c = await run(env, `UPDATE tg_logins SET attempts = attempts + 1 WHERE nonce_hash = ? AND ${owner} AND used = 0 AND code_hash IS NOT NULL
      AND code_expires_at >= ? AND attempts < ?`, h, ...ownerArgs, now, MAX_TRIES);
  if (!c.meta.changes) {
    const row = await first(env, `SELECT attempts, code_hash FROM tg_logins WHERE nonce_hash = ? AND ${owner}`, h, ...ownerArgs);
    if (row && !row.code_hash) throw err(409, 'code_not_sent', 'Open the bot in Telegram and tap Start to get your code.');
    if (row && row.attempts >= MAX_TRIES) throw err(429, 'too_many_tries', 'Too many wrong codes. Tap Start in the bot again for a new code.');
    throw wrong();
  }
  const row = await first(env, 'SELECT * FROM tg_logins WHERE nonce_hash = ?', h);
  if (!(await safeEqual(row.code_hash, await codeHash(env, nonce, code)))) throw wrong();
  const u = await run(env, 'UPDATE tg_logins SET used = 1 WHERE nonce_hash = ? AND used = 0', h);
  if (!u.meta.changes) throw wrong();
  return row;
}

export async function tgVerify(env, body, headers) {
  const row = await useCode(env, body, null);
  const now = nowSec();
  const user = await first(env, 'SELECT * FROM users WHERE tg_id = ?', row.tg_id);
  if (user) {
    if (!user.is_active) throw err(403, 'account_disabled', 'این حساب غیرفعال شده است.');
    await setTgUsername(env, user.id, row.tg_id, row.tg_username, row.tg_name);
    await run(env, 'UPDATE users SET last_login_at = ? WHERE id = ?', now, user.id);
    const d = dev(body, headers);
    await touchDevice(env, user.id, d.id, d.model);
    return json({ ...(await makeTokens(env, user)), login: row.tg_username ? '@' + row.tg_username : String(row.tg_id) });
  }
  const signup_token = await signJwt({ typ: 'tgsignup', tg: String(row.tg_id), un: row.tg_username || '', nm: row.tg_name || '' },
    jwtSecret(env), SIGNUP_MIN * 60);
  return json({ need_password: true, signup_token, login: row.tg_username ? '@' + row.tg_username : String(row.tg_id),
    tg_name: row.tg_name || '', expires_in: SIGNUP_MIN * 60 });
}

export async function tgRegister(env, body, headers) {
  const p = await verifyJwt(body.signup_token, jwtSecret(env));
  if (!p || p.typ !== 'tgsignup' || !/^\d{1,20}$/.test(p.tg || '')) throw err(401, 'signup_expired', 'Sign-up took too long. Tap "Continue with Telegram" again.');
  checkPassword(body.password);
  const tgId = Number(p.tg);
  if (await first(env, 'SELECT id FROM users WHERE tg_id = ?', tgId)) throw err(409, 'telegram_taken', 'This Telegram account already has an account. Log in instead.');
  let id;
  try {
    id = await insert(env, 'users', {
      email: tgEmail(tgId), password_hash: await hashPassword(body.password, env.SECRET_KEY), tg_id: tgId,
      ...(await newUserFields(env, body)),
    });
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) throw err(409, 'telegram_taken', 'This Telegram account already has an account. Log in instead.');
    throw e;
  }
  await setTgUsername(env, id, tgId, p.un || null, p.nm || '');
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', id);
  const d = dev(body, headers);
  await touchDevice(env, id, d.id, d.model);
  return json({ ...(await makeTokens(env, user)), login: p.un ? '@' + p.un : String(tgId) }, 201);
}

// how a person is shown to the admin: Telegram name when they signed up with Telegram, else email
export function userLabel(u) {
  if (u && u.tg_id) return u.tg_username ? '@' + u.tg_username : 'TG ' + u.tg_id;
  return u ? u.email : '';
}

// ---------------- Profile: verify Telegram, backup email ----------------
// An account made with email verifies a Telegram account from the profile: POST /me/telegram/start gives a link
// like a sign-in (it opens the same bot, which sends a 6-digit code), POST /me/telegram/verify attaches it. That
// Telegram account then logs in to this account too (with the code, or @username + the same password).
export async function tgLinkStart(env, user) {
  if (user.tg_id) throw err(409, 'telegram_linked', 'Your Telegram account is already verified.');
  return tgStart(env, user.id);
}

export async function tgLinkVerify(env, user, body) {
  if (user.tg_id) throw err(409, 'telegram_linked', 'Your Telegram account is already verified.');
  const row = await useCode(env, body, user.id);
  const taken = () => err(409, 'telegram_taken', 'This Telegram account already belongs to another Pleat account.');
  const other = await first(env, 'SELECT id FROM users WHERE tg_id = ?', row.tg_id);
  if (other && other.id !== user.id) throw taken();
  try {
    const r = await run(env, 'UPDATE users SET tg_id = ? WHERE id = ? AND tg_id IS NULL', row.tg_id, user.id);
    if (!r.meta.changes) throw err(409, 'telegram_linked', 'Your Telegram account is already verified.');
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) throw taken(); // the same Telegram linked elsewhere at the same moment
    throw e;
  }
  await setTgUsername(env, user.id, row.tg_id, row.tg_username, row.tg_name);
  const fresh = await first(env, 'SELECT * FROM users WHERE id = ?', user.id);
  return json(profileOut(fresh));
}

// The Gmail (or any email) a person adds as a backup way to log in. The password is asked again, because this
// changes how the account can be entered. "" removes it (only for accounts that have Telegram to log in with).
export async function setEmail(env, user, body) {
  if (!(await verifyPassword(body.password || '', user.password_hash, env.SECRET_KEY))) {
    throw err(400, 'wrong_password', 'The password is wrong.', 'password');
  }
  const raw = String(body.email ?? '').trim();
  let email;
  if (!raw) {
    if (!user.tg_id) throw err(422, 'invalid_input', 'Verify your Telegram account before removing your email.', 'email');
    email = tgEmail(user.tg_id);
  } else {
    try { email = cleanNewEmail(raw); } catch (e) { throw err(422, 'invalid_input', 'Enter a real email address.', 'email'); }
    if (email.endsWith('@' + TG_DOMAIN)) throw err(422, 'invalid_input', 'Enter a real email address.', 'email');
  }
  if (email !== user.email) {
    const taken = () => err(409, 'email_taken', 'This email is already used by another account.', 'email');
    if (await first(env, 'SELECT id FROM users WHERE email = ? AND id != ?', email, user.id)) throw taken();
    try {
      await run(env, 'UPDATE users SET email = ? WHERE id = ?', email, user.id);
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) throw taken();
      throw e;
    }
  }
  const fresh = await first(env, 'SELECT * FROM users WHERE id = ?', user.id);
  return json(profileOut(fresh));
}

// The identity part of GET /me. A Telegram account's made-up address is never shown: email is '' until the
// person adds a real one.
export function profileOut(u) {
  const realEmail = u.email && !u.email.endsWith('@' + TG_DOMAIN) ? u.email : '';
  return {
    id: u.id, email: realEmail,
    login: u.tg_id ? (u.tg_username ? '@' + u.tg_username : String(u.tg_id)) : u.email,
    telegram: u.tg_id ? { id: String(u.tg_id), username: u.tg_username || null, name: u.tg_name || '' } : null,
    telegram_verified: !!u.tg_id,
    avatar: AVATARS.includes(u.avatar) ? u.avatar : null,
  };
}

// The characters drawn in the app (flutter_vpn/assets/avatars). The server only keeps which one was picked.
export const AVATARS = ['vesper', 'kite', 'miso', 'hoot', 'bruno', 'relay', 'orbit', 'drift', 'hop', 'nimbus', 'rex', 'luna', 'mina', 'kai'];

// Pick a character as the profile picture. The characters are the only source of a picture (no Telegram photo),
// so an empty pick is refused; only an admin reset clears it, and the app then asks the person to choose again.
export async function setAvatar(env, user, body) {
  const raw = body.avatar == null ? '' : String(body.avatar).trim().toLowerCase();
  if (!AVATARS.includes(raw)) throw err(422, 'invalid_input', 'Choose one of the avatars.', 'avatar');
  await run(env, 'UPDATE users SET avatar = ? WHERE id = ?', raw, user.id);
  const fresh = await first(env, 'SELECT * FROM users WHERE id = ?', user.id);
  return json(profileOut(fresh));
}

// ---------------- Telegram Mini App: initData ----------------
// A Mini App gets "initData" from Telegram (a query string with user, auth_date and hash). Only someone holding
// the bot token can produce a valid hash, so the server checks it before trusting anything inside:
//   secret = HMAC_SHA256(key "WebAppData", bot token); hash = hex(HMAC_SHA256(secret, data_check_string))
// data_check_string = every field except hash, "key=value", sorted by key, joined with "\n".
// Returns { user, authDate, startParam } or null. maxAgeSec bounds how long a captured initData stays usable.
export async function verifyInitData(botToken, initData, maxAgeSec, now = nowSec()) {
  if (!botToken || typeof initData !== 'string' || !initData || initData.length > 4096) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch (e) { return null; }
  const hash = params.get('hash') || '';
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const pairs = [];
  for (const [k, v] of params) if (k !== 'hash') pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const check = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const te = new TextEncoder();
  const k1 = await crypto.subtle.importKey('raw', te.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', k1, te.encode(botToken));
  const k2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = [...new Uint8Array(await crypto.subtle.sign('HMAC', k2, te.encode(check)))].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (!(await safeEqual(want, hash))) return null;
  const authDate = parseInt(params.get('auth_date') || '', 10);
  if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > maxAgeSec) return null;
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) { return null; }
  if (!user || !/^\d{1,20}$/.test(String(user.id ?? ''))) return null;
  return { user, authDate, startParam: params.get('start_param') || '' };
}

// ---------------- Telegram Mini App: sign in with initData ----------------
// The Mini App opens inside Telegram, which hands it initData signed with the bot token. That signature is the
// whole login: the numeric Telegram id is the identity, exactly as with the 6-digit code. The Mini App gets only a
// 30-minute access token marked src=mini (no refresh token in a web view); when it runs out the page signs in
// again with the initData it still has. No device row is written: the Mini App is not a VPN device.
const WEBAPP_MAX_AGE = 3600; // initData older than an hour is refused (a captured one stops working)

async function webappUser(env, body) {
  const v = await verifyInitData(env.TELEGRAM_BOT_TOKEN, body && body.init_data, WEBAPP_MAX_AGE);
  if (!v) throw err(401, 'bad_init_data', 'Close Pleat and open it again from the Telegram bot.');
  const u = v.user;
  return {
    v, tgId: Number(u.id),
    username: /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(String(u.username || '')) ? String(u.username).toLowerCase() : null,
    name: [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 64),
  };
}

async function webappTokens(env, user, id) {
  if (id.username !== (user.tg_username || null) || id.name !== (user.tg_name || '')) await setTgUsername(env, user.id, id.tgId, id.username, id.name);
  return json({
    access_token: await signJwt({ sub: String(user.id), ver: user.token_version, typ: 'access', src: 'mini' }, jwtSecret(env), ACCESS_MIN * 60),
    token_type: 'bearer', expires_in: ACCESS_MIN * 60,
  });
}

// POST /auth/tg/webapp {init_data}: the account of this Telegram user, or {need_account: true} when there is none.
// An admin also gets admin: <role>, so the page opens the admin panel (which signs in on its own, /admin/auth).
export async function webappLogin(env, body) {
  const id = await webappUser(env, body);
  const { adminRole } = await import('./telegram.js');
  const sid = String(id.tgId);
  const admin = (await adminRole(env, { id: sid, type: 'private' }, { id: sid })) || null;
  const user = await first(env, 'SELECT * FROM users WHERE tg_id = ?', id.tgId);
  if (!user) return json({ need_account: true, name: id.name, admin });
  if (!user.is_active) throw err(403, 'account_disabled', 'This account is disabled.');
  const res = await webappTokens(env, user, id);
  return json({ ...(await res.json()), admin });
}

// POST /auth/tg/webapp/register {init_data}: one tap makes the account. It has no password (a hash that never
// matches); the person signs in to Pleat later with "Continue with Telegram", which needs none. A start link like
// t.me/<bot>?startapp=ref_<CODE> carries an invite code. Asking twice just signs in.
export async function webappRegister(env, body) {
  const id = await webappUser(env, body);
  let user = await first(env, 'SELECT * FROM users WHERE tg_id = ?', id.tgId);
  if (!user) {
    const ref = /^ref_([A-Za-z0-9]{4,16})$/.exec(id.v.startParam || '');
    try {
      await insert(env, 'users', { email: tgEmail(id.tgId), password_hash: DUMMY_HASH, tg_id: id.tgId,
        ...(await newUserFields(env, { referral_code: ref ? ref[1] : '' })) });
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message))) throw e; // made at the same moment by a second tap
    }
    user = await first(env, 'SELECT * FROM users WHERE tg_id = ?', id.tgId);
  }
  if (!user.is_active) throw err(403, 'account_disabled', 'This account is disabled.');
  return webappTokens(env, user, id);
}
