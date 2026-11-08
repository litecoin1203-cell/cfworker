// Talks to the Worker that serves this page (same origin, so no CORS and no address to configure).
// The access token lives only in memory: when it runs out (30 min) the app signs in again with initData.
import { initData } from './tg.js';

let token = '';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function request(path, { method = 'GET', body, auth = true, timeoutMs = 15000 } = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch('/api/v1' + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth && token ? { authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl ? ctl.signal : undefined,
      cache: 'no-store',
    });
  } catch (e) {
    throw new ApiError(0, 'network', 'Pleat could not be reached. Check that your VPN is on, then try again.');
  } finally { if (timer) clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const d = (data && data.detail) || {};
    throw new ApiError(res.status, d.code || 'error', englishOr(d.message, res.status));
  }
  return data;
}

// The Worker's messages for the old app are Persian; Pleat is English, so those become a plain English line.
function englishOr(msg, status) {
  if (msg && !/[؀-ۿ]/.test(msg)) return msg;
  if (status === 429) return 'Too many tries. Wait a minute and try again.';
  if (status === 401) return 'Your session ended. Close Pleat and open it again from the bot.';
  if (status === 403) return 'This account is disabled.';
  return 'Something went wrong. Try again in a moment.';
}

// {need_account, name} or {ok: true}
export async function signIn() {
  const data = initData();
  if (!data) throw new ApiError(0, 'no_telegram', 'Open Pleat from the Telegram bot.');
  const r = await request('/auth/tg/webapp', { method: 'POST', body: { init_data: data }, auth: false });
  if (r.need_account) return { need_account: true, name: r.name || '' };
  token = r.access_token;
  return { ok: true };
}

export async function createAccount() {
  const r = await request('/auth/tg/webapp/register', { method: 'POST', body: { init_data: initData() }, auth: false });
  token = r.access_token;
}

// an authed call; one fresh sign-in and retry when the token has run out
export async function authed(path, opts) {
  try { return await request(path, opts); } catch (e) {
    if (e.status !== 401) throw e;
    const s = await signIn();
    if (s.need_account) throw e;
    return request(path, opts);
  }
}

export const me = () => authed('/me', { timeoutMs: 20000 });
