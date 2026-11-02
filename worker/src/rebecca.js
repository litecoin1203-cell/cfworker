// Rebecca panel adapter for the Cloud Gold Worker.
//
// Rebecca (Go backend, forked from Marzban) speaks a Marzban-like REST API for
// login, users and usage, but it has NO groups at all: there is no /api/groups
// route in its public source (routes.go / openapi.json), so asking it for groups
// always answers 404. This adapter therefore never calls a groups endpoint:
// listGroups/listGroupIds return [] without any fetch, and createUser never
// sends group_ids or proxy_settings (or manual inbounds).
//
// Rebecca user creation requires a service_id. The adapter resolves it in this
// order, and never guesses:
//   1. a service_id set by hand on the panel (panel options, /panelservice),
//   2. discovery via GET /api/v2/services: if exactly one non-default service
//      exists, that one is used,
//   3. otherwise it fails with a clear error naming /panelservice, so the
//      admin sets the service by hand instead of the adapter picking at random.
//
// The adapter plugs into the existing Control Plane exactly like PasarGuard:
// the same logical account, the same centrally summed quota/expiry, the same
// per-panel cap, the same rollout bucket logic and the same unified,
// renamed server list. It creates no separate account system, no separate
// subscription list and no panel-specific login. Panel 1 (Pasarguard) is
// untouched: this file is only constructed for panels whose kind is
// 'rebecca', and the PasarGuard class is not modified.
import { PasarGuardError, panelBases, parseExpire, decodeSub } from './pasarguard.js';

const TIMEOUT_MS = 15000;
const TOKEN_TTL_MS = 25 * 60 * 1000;
const CORE_UA = 'v2rayNG/2.2.6';

function short(text) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  try {
    const j = JSON.parse(text);
    const d = j.detail ?? j.message ?? j;
    text = typeof d === 'string' ? d : JSON.stringify(d);
  } catch (e) { /* not json */ }
  return text.slice(0, 300);
}

async function timedFetch(url, init = {}) {
  const opts = { ...init };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(TIMEOUT_MS);
  return fetch(url, opts);
}

// A service is "default" when Rebecca marks it so, or when it is literally
// named "default". Anything else is a candidate for user creation.
function isDefaultService(s) {
  if (!s || typeof s !== 'object') return true;
  if (s.is_default === true || s.default === true) return true;
  return String(s.name || '').trim().toLowerCase() === 'default';
}

export class Rebecca {
  // cred: {url, username, password, api_key} from a PANEL_<id>_CRED secret.
  // opts: {panelId, serviceId} — serviceId is the hand-set value from
  // /panelservice, when the admin has set one.
  constructor(env, cred, opts = {}) {
    const c = cred || {};
    this.bases = panelBases(c.url);
    this.username = c.username || '';
    this.password = c.password || '';
    this.apiKey = String(c.api_key || '').trim();
    this.panelId = opts.panelId != null ? opts.panelId : null;
    this.manualServiceId = opts.serviceId != null && opts.serviceId !== '' ? Number(opts.serviceId) : null;
    this._serviceId = null;
    // Separate token cache from PasarGuard's: panels must never share state.
    const cache = (globalThis.__cgRb = globalThis.__cgRb || {});
    this.cacheKey = this.bases.join('|') + '|' + this.username + '|' + (this.apiKey ? 'k' : 'p');
    const hit = cache[this.cacheKey];
    this.base = (hit && hit.base) || this.bases[0] || '';
    this._token = hit && hit.token && hit.exp > Date.now() ? hit.token : null;
  }

  _remember() {
    globalThis.__cgRb[this.cacheKey] = { base: this.base, token: this._token, exp: Date.now() + TOKEN_TTL_MS };
  }

  async _login() {
    if (!this.username || !this.password) throw new PasarGuardError('panel username/password are not set for this panel', 0);
    let last = null;
    const order = [this.base, ...this.bases.filter((b) => b !== this.base)];
    for (const base of order) {
      const body = new URLSearchParams({ username: this.username, password: this.password, grant_type: 'password' });
      let r;
      try {
        r = await timedFetch(`${base}/api/admin/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
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
    throw last || new PasarGuardError('panel address is not set for this panel', 0);
  }

  async _headers() {
    const h = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.apiKey) { h['x-api-key'] = this.apiKey; return h; }
    if (!this._token) await this._login();
    h.authorization = `Bearer ${this._token}`;
    return h;
  }

  async _req(method, path, body, retry = true) {
    if (!this.base) throw new PasarGuardError('panel address is not set for this panel', 0);
    let resp;
    try {
      resp = await timedFetch(`${this.base}${path}`, {
        method,
        headers: await this._headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
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

  // Rebecca has no groups: this returns [] without touching the network, so
  // the health test and account creation never die on a groups 404.
  async listGroups() { return []; }
  async listGroupIds() { return []; }

  // Resolve the service_id for user creation. A hand-set value wins; otherwise
  // discovery must find exactly one non-default service, or the admin must
  // set one by hand — the adapter never picks a random service.
  async _resolveServiceId() {
    if (this.manualServiceId) return this.manualServiceId;
    if (this._serviceId) return this._serviceId;
    const data = await this._json('GET', '/api/v2/services');
    const list = Array.isArray(data) ? data : (Array.isArray(data.services) ? data.services : []);
    const candidates = list.filter((s) => !isDefaultService(s));
    if (candidates.length !== 1) {
      const id = this.panelId != null ? this.panelId : '<id>';
      throw new PasarGuardError(
        `Rebecca service is ambiguous (${candidates.length} non-default services). Set it by hand: /panelservice ${id} <service_id>`, 0);
    }
    const sid = Number(candidates[0].id ?? candidates[0].service_id);
    if (!Number.isFinite(sid) || sid <= 0) {
      const id = this.panelId != null ? this.panelId : '<id>';
      throw new PasarGuardError(`Rebecca service has no usable id. Set it by hand: /panelservice ${id} <service_id>`, 0);
    }
    this._serviceId = sid;
    return sid;
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

  // expire: unix seconds or 0; dataLimit: bytes (0 = unlimited).
  // groupIds and hwidLimit are accepted (the Control Plane passes them for
  // every panel) and deliberately NOT sent: Rebecca has no groups, and its
  // user creation rejects manual inbounds/proxies payloads.
  async createUser(username, { expire, dataLimit, note }) {
    const serviceId = await this._resolveServiceId();
    const body = {
      username,
      status: 'active',
      expire: expire || 0,
      data_limit: dataLimit || 0,
      data_limit_reset_strategy: 'no_reset',
      note: (note || '').slice(0, 450),
      service_id: serviceId,
    };
    return this._json('POST', '/api/user', body);
  }

  modifyUser(username, fields) {
    // Strip any panel-1-only fields the Control Plane may pass along, so a
    // Rebecca user is never updated with a groups/proxy payload it rejects.
    const { group_ids: _g, proxy_settings: _p, hwid_limit: _h, ...rest } = fields || {};
    return this._json('PUT', `/api/user/${encodeURIComponent(username)}`, rest);
  }

  deleteUser(username) {
    return this._json('DELETE', `/api/user/${encodeURIComponent(username)}`, undefined, [200, 204]);
  }

  resetUsage(username) {
    return this._json('POST', `/api/user/${encodeURIComponent(username)}/reset`);
  }

  absoluteSubUrl(subUrl) {
    if (!subUrl) return '';
    if (/^https?:\/\//i.test(subUrl)) return subUrl;
    return `${this.base}${subUrl.startsWith('/') ? '' : '/'}${subUrl}`;
  }

  async subscriptionRaw(subUrl, fwd = {}) {
    const url = this.absoluteSubUrl(subUrl);
    if (!url) throw new PasarGuardError('no subscription url', 0);
    const headers = { 'user-agent': CORE_UA, accept: '*/*' };
    for (const [k, v] of Object.entries(fwd)) if (v) headers[k] = v;
    let r;
    try { r = await timedFetch(url, { headers }); } catch (e) { throw new PasarGuardError(`cannot reach subscription (${e.name === 'TimeoutError' ? 'timeout' : e.message})`, 0); }
    const text = await r.text().catch(() => '');
    return { status: r.status, text, userinfo: r.headers.get('subscription-userinfo') || '' };
  }

  async subscriptionLinks(subUrl) {
    const base = this.absoluteSubUrl(subUrl).replace(/\/$/, '');
    try {
      const r = await timedFetch(base + '/links', { headers: { 'user-agent': CORE_UA } });
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

  async listUsage(offset = 0, limit = 200) {
    const data = await this._json('GET', `/api/users?offset=${offset}&limit=${limit}`);
    const arr = Array.isArray(data) ? data : (data.users || []);
    const users = arr.map((u) => ({
      username: u.username, id: u.id ?? null, used: parseInt(u.used_traffic || 0, 10) || 0, status: u.status || '',
      expire: parseExpire(u.expire), data_limit: parseInt(u.data_limit || 0, 10) || 0,
    }));
    return { users, total: Number.isFinite(data.total) ? data.total : offset + users.length };
  }

  setStatus(username, status) {
    return this._json('PUT', `/api/user/${encodeURIComponent(username)}`, { status });
  }

  async version() {
    try {
      const r = await this._req('GET', '/api/system');
      if (!r.ok) return null;
      const j = await r.json().catch(() => ({}));
      return j.version ? String(j.version).slice(0, 40) : null;
    } catch (e) { return null; }
  }

  panelHosts() {
    return this.bases.map((b) => { try { return new URL(b).hostname.toLowerCase(); } catch (e) { return ''; } }).filter(Boolean);
  }

  // Kept for interface parity with PasarGuard; Rebecca's device control is
  // not used by the Control Plane for non-panel-1 panels.
  async deleteHwid() { return false; }
}
