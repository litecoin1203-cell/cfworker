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
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), bytesFromB64url(parts[2]), enc.encode(data));
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
