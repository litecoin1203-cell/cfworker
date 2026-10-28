// Accounts: register / login / refresh / change-password. Email + password, no verification code.
import { first, run, insert, touchDevice } from './db.js';
import { json, err, hashPassword, verifyPassword, signJwt, verifyJwt, jwtSecret, cleanEmail, randomCode, nowSec } from './util.js';

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
  const email = cleanEmail(body.email);
  checkPassword(body.password);
  const existing = await first(env, 'SELECT id FROM users WHERE email = ?', email);
  if (existing) throw err(409, 'email_taken', 'با این ایمیل قبلاً حساب ساخته شده. وارد شو.');
  let referredBy = null;
  if (body.referral_code) {
    const r = await first(env, 'SELECT id FROM users WHERE referral_code = ?', String(body.referral_code).trim().toUpperCase());
    if (r) referredBy = r.id;
  }
  let code;
  for (let i = 0; i < 5; i++) { code = randomCode(); if (!(await first(env, 'SELECT 1 FROM users WHERE referral_code = ?', code))) break; }
  let id;
  try {
    id = await insert(env, 'users', {
      email, password_hash: await hashPassword(body.password, env.SECRET_KEY), referral_code: code,
      referred_by_id: referredBy, created_at: nowSec(),
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

export async function login(env, body, headers) {
  const email = cleanEmail(body.email);
  const user = await first(env, 'SELECT * FROM users WHERE email = ?', email);
  // an unknown email still costs one hash, so the response time doesn't tell which emails have accounts
  const stored = user ? user.password_hash : DUMMY_HASH;
  if (!(await verifyPassword(body.password || '', stored, env.SECRET_KEY)) || !user) {
    throw err(401, 'bad_credentials', 'ایمیل یا رمز اشتباه است.');
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
