// Accounts: register / login / refresh / change-password. Email + password, no verification code.
import { first, run, insert, touchDevice } from './db.js';
import { json, err, hashPassword, verifyPassword, signJwt, verifyJwt, cleanEmail, randomCode, nowSec } from './util.js';

const ACCESS_MIN = 30;
const REFRESH_DAYS = 60;

async function makeTokens(env, user) {
  const base = { sub: String(user.id), ver: user.token_version };
  return {
    access_token: await signJwt({ ...base, typ: 'access' }, env.SECRET_KEY, ACCESS_MIN * 60),
    refresh_token: await signJwt({ ...base, typ: 'refresh' }, env.SECRET_KEY, REFRESH_DAYS * 86400),
    token_type: 'bearer',
    expires_in: ACCESS_MIN * 60,
  };
}

export async function requireUser(env, request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = await verifyJwt(token, env.SECRET_KEY);
  if (!payload || payload.typ !== 'access') throw err(401, 'not_authenticated', 'Login required');
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', parseInt(payload.sub, 10));
  if (!user || user.token_version !== payload.ver) throw err(401, 'token_invalid', 'Session ended');
  if (!user.is_active) throw err(403, 'account_disabled', 'This account is disabled');
  return user;
}

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw err(422, 'invalid_input', 'Use at least 8 characters for your password', 'password');
  if (pw.length > 128) throw err(422, 'invalid_input', 'Password is too long', 'password');
}

const dev = (body, headers) => ({
  id: body.device_id || headers.get('x-device-id') || null,
  model: body.device_model || headers.get('x-device-model') || '',
});

export async function register(env, body, headers) {
  const email = cleanEmail(body.email);
  checkPassword(body.password);
  const existing = await first(env, 'SELECT id FROM users WHERE email = ?', email);
  if (existing) throw err(409, 'email_taken', 'An account with this email already exists. Sign in instead.');
  let referredBy = null;
  if (body.referral_code) {
    const r = await first(env, 'SELECT id FROM users WHERE referral_code = ?', String(body.referral_code).trim().toUpperCase());
    if (r) referredBy = r.id;
  }
  let code;
  for (let i = 0; i < 5; i++) { code = randomCode(); if (!(await first(env, 'SELECT 1 FROM users WHERE referral_code = ?', code))) break; }
  const id = await insert(env, 'users', {
    email, password_hash: await hashPassword(body.password, env.SECRET_KEY), referral_code: code,
    referred_by_id: referredBy, created_at: nowSec(),
  });
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', id);
  const d = dev(body, headers);
  await touchDevice(env, id, d.id, d.model);
  return json(await makeTokens(env, user), 201);
}

export async function login(env, body, headers) {
  const email = cleanEmail(body.email);
  const user = await first(env, 'SELECT * FROM users WHERE email = ?', email);
  if (!user || !(await verifyPassword(body.password || '', user.password_hash, env.SECRET_KEY))) {
    throw err(401, 'bad_credentials', 'Wrong email or password');
  }
  if (!user.is_active) throw err(403, 'account_disabled', 'This account is disabled');
  await run(env, 'UPDATE users SET last_login_at = ? WHERE id = ?', nowSec(), user.id);
  const d = dev(body, headers);
  await touchDevice(env, user.id, d.id, d.model);
  return json(await makeTokens(env, user));
}

export async function refresh(env, body) {
  const payload = await verifyJwt(body.refresh_token, env.SECRET_KEY);
  if (!payload || payload.typ !== 'refresh') throw err(401, 'token_invalid', 'Please sign in again');
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', parseInt(payload.sub, 10));
  if (!user || user.token_version !== payload.ver || !user.is_active) throw err(401, 'token_invalid', 'Please sign in again');
  return json(await makeTokens(env, user));
}

export async function changePassword(env, user, body) {
  if (!(await verifyPassword(body.current_password || '', user.password_hash, env.SECRET_KEY))) {
    throw err(400, 'wrong_password', 'Your current password is wrong', 'current_password');
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
