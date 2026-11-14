// Small helpers shared across the Worker: JSON responses, password hashing, JWTs, HMAC — all on Web Crypto
// so the exact same code runs on Cloudflare Workers and (for tests) on Node 22.

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

// An error shaped { detail: { code, message, field? } } — the app reads detail.code / detail.message.
export class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.body = { detail: { code, message, ...(field ? { field } : {}) } };
  }
}
export const err = (status, code, message, field) => new ApiError(status, code, message, field);

export const nowSec = () => Math.floor(Date.now() / 1000);

function b64urlFromBytes(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesFromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlFromStr = (s) => b64urlFromBytes(enc.encode(s));
export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------------- passwords (PBKDF2-HMAC-SHA256; scrypt isn't available on Workers) ----------------
const PBKDF2_ITERS = 5000; // low, because a server-side pepper (HMAC with SECRET_KEY) does the heavy lifting

// The password is first peppered with the deployment secret (HMAC-SHA256), so a leaked database alone
// cannot be brute-forced without also stealing the Worker's SECRET_KEY. PBKDF2 then adds defence in depth
// while staying inside the Workers free-tier CPU budget.
export async function hashPassword(password, pepper) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERS, pepper);
  return `pbkdf2$${PBKDF2_ITERS}$${hex(salt)}$${hex(bits)}`;
}
export async function verifyPassword(password, stored, pepper) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iters = parseInt(parts[1], 10);
  const salt = bytesFromHex(parts[2]);
  const bits = await pbkdf2(password, salt, iters, pepper);
  return timingSafeEqual(hex(bits), parts[3]);
}
async function pbkdf2(password, salt, iters, pepper) {
  const peppered = await hmacHex(pepper || '', password);
  const key = await crypto.subtle.importKey('raw', enc.encode(peppered), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, key, 256);
}
function bytesFromHex(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Compare two secrets without leaking their content or length through timing: hash both to a fixed size first.
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.digest('SHA-256', enc.encode(String(v ?? '')))));
  return timingSafeEqual(hex(x), hex(y));
}

// A deadline for an outside call, so one slow service can't hold a request or the cron until the Worker is killed.
export const deadline = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

// "Done this in the last ms?" kept in the isolate's memory. Old entries are dropped once the bag grows, so a
// long-lived isolate doesn't keep one entry per user and order forever.
export function throttled(bag, id, ms) {
  const m = (globalThis[bag] instanceof Map ? globalThis[bag] : (globalThis[bag] = new Map()));
  const now = Date.now();
  const t = m.get(id);
  if (t && now - t < ms) return true;
  if (m.size >= 2000) for (const [k, v] of m) if (now - v >= ms) m.delete(k);
  if (m.size >= 2000) m.delete(m.keys().next().value);
  m.set(id, now);
  return false;
}

// Per-key request limits from the Workers Rate Limiting bindings in wrangler.jsonc. A missing binding (local runs)
// lets the request through. When the limiter itself fails, a route that writes, sends a code or checks a password
// is refused (fail closed, 429): otherwise a limiter outage would leave sign-ups and password guessing unlimited.
// Read-only routes pass { open: true } and keep working (fail open): a refusal there saves nothing (the invocation
// is already counted, the reads are cheap) and would only hide plans or the store's settings from people.
// The bindings count per Cloudflare location and only roughly, so they stop one client's burst; the hard cap on
// what all clients together may write is the global budget below (spendBudget).
export async function rateLimit(env, binding, key, { open = false } = {}) {
  const limiter = env[binding];
  if (!limiter || !key) return;
  let outcome;
  try { outcome = await limiter.limit({ key }); } catch (e) {
    logError('rate limiter failed', e, { binding, open });
    if (open) return;
    throw err(429, 'too_many_requests', 'Too many requests right now. Wait a minute and try again.');
  }
  if (outcome && outcome.success === false) throw err(429, 'too_many_requests', 'تعداد درخواست‌ها زیاد است. یک دقیقه صبر کن و دوباره امتحان کن.');
}

// "May this optional costly step run now?" (not a whole request): false once the limit is spent. A failing
// limiter says yes: the step always ran before, and the request around it has its own limit.
export async function allowed(env, binding, key) {
  const limiter = env[binding];
  if (!limiter || !key) return true;
  try { const o = await limiter.limit({ key }); return !(o && o.success === false); } catch (e) { logError('rate limiter failed', e, { binding }); return true; }
}

// ---------------- global write budgets ----------------
// Anyone may sign up or ask for a Telegram sign-in link without an account, and each one writes D1 rows (a sign-up
// about 12 counting index rows: user, device, this counter). The per-IP limits count per Cloudflare location and
// reset every minute, so many IPs, or one IP over a day, could still spend the Free plan's ~100k rows/day and stop
// the whole service. A budget caps how many of these all clients together may do per UTC hour. It is one settings
// row per budget, value "<hour>:<count>", moved on by ONE conditional upsert: under the cap it counts this one (or
// starts the new hour at 1); at the cap the upsert changes nothing, so a refused request writes no row at all (it
// only logs to Workers Logs). A cap can be raised for a launch day with the Worker variable named in `env`
// (dashboard or wrangler vars), no code change. Worst case at the defaults, counted generously (every index row):
// 30 x ~12 + 60 x ~10 rows (a link row is deleted again later) = under 1k rows/hour, ~23k rows/day of the ~100k.
export const BUDGETS = {
  signup: { env: 'SIGNUP_PER_HOUR', def: 30, message: 'Too many new accounts right now. Try again later, or continue with Telegram.' },
  tgstart: { env: 'TG_START_PER_HOUR', def: 60, message: 'Telegram sign-in is busy right now. Try again in a few minutes, or log in with your password.' },
};
export const budgetCap = (env, name) => { const v = parseInt(env[BUDGETS[name].env], 10); return v > 0 ? v : BUDGETS[name].def; };
const BUDGET_SQL = `INSERT INTO settings (key, value) VALUES (?1, ?2 || ':1')
  ON CONFLICT(key) DO UPDATE SET value = CASE WHEN substr(value, 1, instr(value, ':') - 1) = ?2
      THEN ?2 || ':' || (CAST(substr(value, instr(value, ':') + 1) AS INTEGER) + 1) ELSE ?2 || ':1' END
  WHERE substr(value, 1, instr(value, ':') - 1) != ?2 OR CAST(substr(value, instr(value, ':') + 1) AS INTEGER) < ?3`;
export async function spendBudget(env, name) {
  const hour = String(Math.floor(Date.now() / 3600000));
  const r = await env.DB.prepare(BUDGET_SQL).bind('budget_' + name, hour, budgetCap(env, name)).run();
  if (r && r.meta && r.meta.changes) return;
  // a warning line in Workers Logs only: logError would also write the error log row, and a refusal writes nothing
  console.warn(JSON.stringify({ message: 'write budget spent', budget: name, hour }));
  throw err(429, 'busy', BUDGETS[name].message);
}

// JWTs get their own key when JWT_SECRET is set, so SECRET_KEY stays only the password pepper.
// Setting JWT_SECRET signs everyone out once (old tokens no longer verify).
export const jwtSecret = (env) => env.JWT_SECRET || env.SECRET_KEY;

// Panel addresses must never reach the bot, the logs or the app: every URL in a panel message becomes [url].
export function redactUrls(text) {
  return String(text ?? '').replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, '[url]');
}

// One JSON line per error, at error level, so Workers Logs can search and filter it.
// It is also handed to the error sink (index.js points it at the Worker's own error log, cfmon.js), which never throws.
let errorSink = null;
export function setErrorSink(fn) { errorSink = typeof fn === 'function' ? fn : null; }
export function logError(message, e, extra = {}) {
  const error = redactUrls(e instanceof Error ? e.message : String(e));
  console.error(JSON.stringify({ message, error, stack: redactUrls(e && e.stack), ...extra }));
  if (errorSink) { try { errorSink(String(message), error); } catch (x) { /* the log must not fail the caller */ } }
}

// ---------------- HMAC-SHA256 ----------------
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function hmacHex(secret, message) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message));
  return hex(sig);
}
export async function hmacSha512Hex(secret, message) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return hex(sig);
}

// ---------------- JWT (HS256) ----------------
export async function signJwt(payload, secret, lifetimeSec) {
  const now = nowSec();
  const body = { ...payload, iat: now, exp: now + lifetimeSec };
  const head = b64urlFromStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64urlFromStr(JSON.stringify(body))}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return `${data}.${b64urlFromBytes(new Uint8Array(sig))}`;
}
export async function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  let sig;
  try { sig = bytesFromB64url(parts[2]); } catch (e) { return null; } // not base64url: a broken token, not a server error
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(data));
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(dec.decode(bytesFromB64url(parts[1]))); } catch (e) { return null; }
  if (payload.exp && payload.exp < nowSec()) return null;
  return payload;
}

export function randomCode(len = 7) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
export function cleanEmail(v) {
  v = String(v || '').trim().toLowerCase();
  if (v.length > 254 || !EMAIL_RE.test(v)) throw err(422, 'invalid_input', 'یک ایمیل درست وارد کن.', 'email');
  return v;
}
// A new address may not hold characters that mean something in the admin's Telegram messages: "/start@x.io"
// became a tappable command there. Existing addresses still log in through cleanEmail.
export function cleanNewEmail(v) {
  v = cleanEmail(v);
  if (/[/\\<>"'`]/.test(v)) throw err(422, 'invalid_input', 'یک ایمیل درست وارد کن.', 'email');
  return v;
}

// ---------------- sealed values (secrets kept in D1) ----------------
// AES-GCM with a key derived (HKDF) from SECRET_KEY for one purpose. What is stored ("s1.<iv>.<data>") is useless
// without the Worker's SECRET_KEY: a database export or backup does not reveal it. Changing SECRET_KEY makes
// sealed values unreadable (openSealed gives null), so they must then be entered again.
async function sealKey(secret, purpose) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(secret || '')), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('cloudgold-seal-v1'), info: enc.encode(purpose) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function seal(secret, purpose, text) {
  if (!secret) throw new Error('SECRET_KEY is not set');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(purpose) }, await sealKey(secret, purpose), enc.encode(text));
  return `s1.${b64urlFromBytes(iv)}.${b64urlFromBytes(new Uint8Array(data))}`;
}
export async function openSealed(secret, purpose, sealed) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 3 || parts[0] !== 's1' || !secret) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytesFromB64url(parts[1]), additionalData: enc.encode(purpose) },
      await sealKey(secret, purpose), bytesFromB64url(parts[2]));
    return dec.decode(plain);
  } catch (e) { return null; }
}
