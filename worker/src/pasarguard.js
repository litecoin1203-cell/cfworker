// PasarGuard API client for Workers (fetch-based).
// - accepts whatever panel address the admin pasted (".../hub/#/login", ".../dashboard/") and finds the API root
// - caches the admin token across requests in the same isolate, re-logs in on 401
// - works for reseller (non-sudo) admins: falls back to the lightweight group list
// - every error carries the panel's own message so the admin sees the real reason in Telegram, but never the
//   panel's address: messages go to the bot and to Workers Logs (redactUrls)
// - also the panel adapter of the control plane (listUsage, setStatus, version); the quota logic is not here
import { err, redactUrls } from './util.js';

export class PasarGuardError extends Error {
  constructor(message, status, detail) { super(redactUrls(message)); this.status = status; this.detail = redactUrls(detail || ''); }
}

// panel datetimes: unix seconds, digits, or an ISO string in UTC; 0 / '' / null = never
export function parseExpire(v) {
  if (v == null || v === 0 || v === '') return null;
  if (typeof v === 'number') return Math.floor(v);
  if (/^\d+$/.test(String(v))) return parseInt(v, 10);
  let s = String(v);
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z'; // panel datetimes are UTC
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

const TIMEOUT_MS = 15000;
const TOKEN_TTL_MS = 25 * 60 * 1000;
const CORE_UA = 'v2rayNG/2.2.6';

// "https://p.example.com/hub/#/login" -> ["https://p.example.com", "https://p.example.com/hub"]
export function panelBases(raw) {
  let s = String(raw || '').trim();
  if (!s) return [];
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.split('#')[0].split('?')[0];
  let u;
  try { u = new URL(s); } catch (e) { return [s.replace(/\/+$/, '')]; }
  const origin = u.origin;
  let path = u.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(login|dashboard|api.*)$/i, '');
  const out = [origin];
  if (path && path !== '/') out.push(origin + path);
  return [...new Set(out)];
}

function short(text) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  try {
    const j = JSON.parse(text);
    const d = j.detail ?? j.message ?? j;
    text = typeof d === 'string' ? d : JSON.stringify(d);
  } catch (e) { /* not json */ }
  return text.slice(0, 300);
}

// ms: an adapter made for the app's own request waits less (see userPath in panels.js) than the cron and the bot
async function timedFetch(url, init = {}, ms) {
  const opts = { ...init };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(ms || TIMEOUT_MS);
  return fetch(url, opts);
}

export class PasarGuard {
  // what other code may ask of any adapter: its kind, whether new users need a group (a "service" on Rebecca),
  // and the subscription sub-path that always answers plain share links
  get kind() { return 'pasarguard'; }
  get usesGroups() { return true; }
  get linksSuffix() { return 'links'; }

  // cred: {url, username, password, api_key} from a PANEL_<id>_CRED secret; without it the original
  // PASARGUARD_* secrets are used (panel 1)
  constructor(env, cred) {
    const c = cred || { url: env.PASARGUARD_URL, username: env.PASARGUARD_USERNAME, password: env.PASARGUARD_PASSWORD, api_key: env.PASARGUARD_API_KEY };
    this.bases = panelBases(c.url);
    this.username = c.username || '';
    this.password = c.password || '';
    this.apiKey = String(c.api_key || '').trim();
    const cache = (globalThis.__cgPg = globalThis.__cgPg || {});
    this.cacheKey = this.bases.join('|') + '|' + this.username + '|' + (this.apiKey ? 'k' : 'p');
    const hit = cache[this.cacheKey];
    this.base = (hit && hit.base) || this.bases[0] || '';
    this._token = hit && hit.token && hit.exp > Date.now() ? hit.token : null;
  }

  _remember() {
    globalThis.__cgPg[this.cacheKey] = { base: this.base, token: this._token, exp: Date.now() + TOKEN_TTL_MS };
  }

  async _login() {
    if (!this.username || !this.password) throw new PasarGuardError('panel username/password are not set in its secret', 0);
    let last = null;
    // try the plain origin first, then the pasted path (in case the panel lives under a sub-path)
    const order = [this.base, ...this.bases.filter((b) => b !== this.base)];
    for (const base of order) {
      const body = new URLSearchParams({ username: this.username, password: this.password, grant_type: 'password' });
      let r;
      try {
        r = await timedFetch(`${base}/api/admin/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body }, this.timeoutMs);
      } catch (e) {
        last = new PasarGuardError(`cannot reach panel (${e.name === 'TimeoutError' ? 'timeout' : e.message})`, 0);
        continue;
      }
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (!j.access_token) { last = new PasarGuardError('panel did not return a token', r.status); continue; }
        this.base = base;
        this._token = j.access_token;
        this._remember();
        return;
      }
      const text = short(await r.text().catch(() => ''));
      if (r.status === 401 || r.status === 403 || r.status === 422) {
        throw new PasarGuardError(`panel login rejected (${r.status}): ${text || 'wrong username or password'}`, r.status, text);
      }
      last = new PasarGuardError(`panel login failed (${r.status}): ${text}`, r.status, text);
    }
    throw last || new PasarGuardError('panel address is not set (PASARGUARD_URL)', 0);
  }

  async _headers() {
    const h = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.apiKey) { h['x-api-key'] = this.apiKey; return h; }
    if (!this._token) await this._login();
    h.authorization = `Bearer ${this._token}`;
    return h;
  }

  async _req(method, path, body, retry = true) {
    if (!this.base) throw new PasarGuardError('panel address is not set (PASARGUARD_URL)', 0);
    let resp;
    try {
      resp = await timedFetch(`${this.base}${path}`, {
        method,
        headers: await this._headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      }, this.timeoutMs);
    } catch (e) {
      if (e instanceof PasarGuardError) throw e;
      throw new PasarGuardError(`cannot reach panel (${e.name === 'TimeoutError' ? 'timeout' : e.message})`, 0);
    }
    if (resp.status === 401 && retry && !this.apiKey) {
      this._token = null;
      return this._req(method, path, body, false);
    }
    return resp;
  }

  async _json(method, path, body, ok = [200, 201]) {
    const r = await this._req(method, path, body);
    if (!ok.includes(r.status)) {
      const text = short(await r.text().catch(() => ''));
      throw new PasarGuardError(`panel ${method} ${path} -> ${r.status}: ${text}`, r.status, text);
    }
    if (r.status === 204) return {};
    return r.json().catch(() => ({}));
  }

  async getUser(username) {
    const r = await this._req('GET', `/api/user/${encodeURIComponent(username)}`);
    if (r.status === 404) return null;
    if (!r.ok) {
      const text = short(await r.text().catch(() => ''));
      throw new PasarGuardError(`get user ${username} -> ${r.status}: ${text}`, r.status, text);
    }
    return r.json();
  }

  // expire: unix seconds or 0; dataLimit: bytes (0 = unlimited)
  async createUser(username, { expire, dataLimit, groupIds, hwidLimit, note }) {
    const body = {
      username,
      status: 'active',
      expire: expire || 0,
      data_limit: dataLimit || 0,
      data_limit_reset_strategy: 'no_reset',
      group_ids: groupIds,
      note: (note || '').slice(0, 450),
      proxy_settings: {},
    };
    if (hwidLimit) body.hwid_limit = hwidLimit;
    try {
      return await this._json('POST', '/api/user', body);
    } catch (e) {
      // some panel versions are strict about optional fields; retry once with the bare minimum
      if (e instanceof PasarGuardError && (e.status === 422 || e.status === 400)) {
        const lean = { username, status: 'active', expire: body.expire, data_limit: body.data_limit, data_limit_reset_strategy: 'no_reset', group_ids: groupIds };
        return this._json('POST', '/api/user', lean);
      }
      throw e;
    }
  }

  modifyUser(username, fields) {
    return this._json('PUT', `/api/user/${encodeURIComponent(username)}`, fields);
  }

  deleteUser(username) {
    return this._json('DELETE', `/api/user/${encodeURIComponent(username)}`, undefined, [200, 204]);
  }

  resetUsage(username) {
    return this._json('POST', `/api/user/${encodeURIComponent(username)}/reset`);
  }

  // [{id, name}] of enabled groups. Reseller admins often may only read the "simple" list.
  async listGroups() {
    let data;
    try {
      data = await this._json('GET', '/api/groups');
    } catch (e) {
      if (!(e instanceof PasarGuardError) || ![403, 404, 405].includes(e.status)) throw e;
      data = await this._json('GET', '/api/groups/simple?all=true');
    }
    return (data.groups || []).filter((g) => !g.is_disabled).map((g) => ({ id: g.id, name: g.name }));
  }

  async listGroupIds() {
    return (await this.listGroups()).map((g) => g.id);
  }

  // the same subscription, asked for plain share links
  linksUrl(subUrl) {
    return this.absoluteSubUrl(subUrl).replace(/\/+$/, '') + '/' + this.linksSuffix;
  }

  absoluteSubUrl(subUrl) {
    if (!subUrl) return '';
    if (/^https?:\/\//i.test(subUrl)) return subUrl;
    return `${this.base}${subUrl.startsWith('/') ? '' : '/'}${subUrl}`;
  }

  // Raw subscription as the app's core would download it. Forwards the phone's HWID headers.
  async subscriptionRaw(subUrl, fwd = {}) {
    const url = this.absoluteSubUrl(subUrl);
    if (!url) throw new PasarGuardError('no subscription url', 0);
    const headers = { 'user-agent': CORE_UA, accept: '*/*' };
    for (const [k, v] of Object.entries(fwd)) if (v) headers[k] = v;
    let r;
    try { r = await timedFetch(url, { headers }, this.timeoutMs); } catch (e) { throw new PasarGuardError(`cannot reach subscription (${e.name === 'TimeoutError' ? 'timeout' : e.message})`, 0); }
    const text = await r.text().catch(() => '');
    return { status: r.status, text, userinfo: r.headers.get('subscription-userinfo') || '' };
  }

  // Share links (vless://, vmess://...) for the user, one per line.
  async subscriptionLinks(subUrl) {
    try {
      const r = await timedFetch(this.linksUrl(subUrl), { headers: { 'user-agent': CORE_UA } }, this.timeoutMs);
      if (r.ok) {
        const lines = decodeSub(await r.text());
        if (lines.length) return lines;
      }
    } catch (e) { /* fall back below */ }
    const raw = await this.subscriptionRaw(subUrl);
    if (raw.status < 200 || raw.status >= 300) throw new PasarGuardError(`sub links ${raw.status}`, raw.status, short(raw.text));
    return decodeSub(raw.text);
  }

  // ---- control plane adapter contract ----

  // One page of users with their counted traffic: {users: [{username, id, used, status, expire, data_limit, online}], total}.
  // online = the panel's online_at (last time the user's traffic was seen), unix seconds or null.
  // One request covers a whole page, so the chunked sync stays inside the Worker's subrequest limit.
  async listUsage(offset = 0, limit = 200) {
    const data = await this._json('GET', `/api/users?offset=${offset}&limit=${limit}`);
    const users = (data.users || []).map((u) => ({
      username: u.username, id: u.id ?? null, used: parseInt(u.used_traffic || 0, 10) || 0, status: u.status || '',
      expire: parseExpire(u.expire), data_limit: parseInt(u.data_limit || 0, 10) || 0, online: parseExpire(u.online_at),
    }));
    return { users, total: Number.isFinite(data.total) ? data.total : offset + users.length };
  }

  // active | disabled (stop without deleting: the account and its usage stay on the panel)
  setStatus(username, status) {
    return this._json('PUT', `/api/user/${encodeURIComponent(username)}`, { status });
  }

  // panel version for the health test; null when the panel does not say
  async version() {
    try {
      const r = await this._req('GET', '/api/system');
      if (!r.ok) return null;
      const j = await r.json().catch(() => ({}));
      return j.version ? String(j.version).slice(0, 40) : null;
    } catch (e) { return null; }
  }

  // host names of the panel (to compare with the node hosts in its configs; never shown)
  panelHosts() {
    return this.bases.map((b) => { try { return new URL(b).hostname.toLowerCase(); } catch (e) { return ''; } }).filter(Boolean);
  }

  async deleteHwid(username, hwid) {
    const user = await this.getUser(username);
    if (!user || user.id == null) return false;
    const r = await this._req('DELETE', `/api/user/${user.id}/hwids/${encodeURIComponent(hwid)}`);
    return r.status === 200 || r.status === 204;
  }
}

// Subscription bodies are plain lines or base64 of lines.
export function decodeSub(text) {
  text = String(text || '').trim();
  if (!text) return [];
  if (!text.includes('://')) {
    try {
      let b = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      b += '='.repeat((4 - (b.length % 4)) % 4);
      const bin = atob(b);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      text = new TextDecoder().decode(bytes);
    } catch (e) { return []; }
  }
  return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[a-z0-9+.-]+:\/\//i.test(s));
}

export function pgOrThrow(env) {
  if (!env.PASARGUARD_URL) throw err(503, 'panel_unconfigured', 'اتصال به پنل هنوز تنظیم نشده است.');
  return new PasarGuard(env);
}
