// Minimal PasarGuard API client for Workers (fetch-based). Mirrors the Python client:
// token login with retry, create/modify user, subscription links, free a device's HWID.
import { err } from './util.js';

export class PasarGuardError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export class PasarGuard {
  constructor(env) {
    this.base = (env.PASARGUARD_URL || '').replace(/\/$/, '');
    this.username = env.PASARGUARD_USERNAME || '';
    this.password = env.PASARGUARD_PASSWORD || '';
    this.apiKey = env.PASARGUARD_API_KEY || '';
    this.verifyTls = (env.PASARGUARD_VERIFY_TLS || 'true') !== 'false';
    this._token = null;
  }

  async _login() {
    const body = new URLSearchParams({ username: this.username, password: this.password, grant_type: 'password' });
    const r = await fetch(`${this.base}/api/admin/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) throw new PasarGuardError(`panel login failed (${r.status})`, r.status);
    this._token = (await r.json()).access_token;
  }

  async _headers() {
    if (this.apiKey) return { 'x-api-key': this.apiKey, 'content-type': 'application/json' };
    if (!this._token) await this._login();
    return { authorization: `Bearer ${this._token}`, 'content-type': 'application/json' };
  }

  async _req(method, path, body, retry = true) {
    let resp;
    try {
      resp = await fetch(`${this.base}${path}`, {
        method,
        headers: await this._headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PasarGuardError(`cannot reach panel: ${e.message}`, 0);
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
      const text = await r.text();
      throw new PasarGuardError(`panel ${method} ${path} -> ${r.status}: ${text.slice(0, 200)}`, r.status);
    }
    return r.status === 204 ? {} : r.json();
  }

  async getUser(username) {
    const r = await this._req('GET', `/api/user/${encodeURIComponent(username)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new PasarGuardError(`get_user ${r.status}`, r.status);
    return r.json();
  }

  // expire: unix seconds or 0; dataLimit: bytes (0 = unlimited)
  createUser(username, { expire, dataLimit, groupIds, hwidLimit, note }) {
    const body = {
      username,
      status: 'active',
      expire: expire || 0,
      data_limit: dataLimit || 0,
      data_limit_reset_strategy: 'no_reset',
      group_ids: groupIds,
      note: note || '',
      proxy_settings: {},
    };
    if (hwidLimit) body.hwid_limit = hwidLimit;
    return this._json('POST', '/api/user', body);
  }

  modifyUser(username, fields) {
    return this._json('PUT', `/api/user/${encodeURIComponent(username)}`, fields);
  }

  resetUsage(username) {
    return this._json('POST', `/api/user/${encodeURIComponent(username)}/reset`);
  }

  async listGroupIds() {
    const data = await this._json('GET', '/api/groups');
    return (data.groups || []).map((g) => g.id);
  }

  absoluteSubUrl(subUrl) {
    if (!subUrl) return '';
    if (/^https?:\/\//i.test(subUrl)) return subUrl;
    return `${this.base}${subUrl.startsWith('/') ? '' : '/'}${subUrl}`;
  }

  async subscriptionLinks(subUrl) {
    const url = this.absoluteSubUrl(subUrl).replace(/\/$/, '') + '/links';
    const r = await fetch(url, { headers: { 'user-agent': 'CloudGold/1.0' } });
    if (!r.ok) throw new PasarGuardError(`sub links ${r.status}`, r.status);
    const text = await r.text();
    return text.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async deleteHwid(username, hwid) {
    const user = await this.getUser(username);
    if (!user || user.id == null) return false;
    const r = await this._req('DELETE', `/api/user/${user.id}/hwids/${encodeURIComponent(hwid)}`);
    return r.status === 200 || r.status === 204;
  }
}

export function pgOrThrow(env) {
  if (!env.PASARGUARD_URL) throw err(503, 'panel_unconfigured', 'The panel is not configured yet');
  return new PasarGuard(env);
}
