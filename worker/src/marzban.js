// Adapters for the Marzban family. PasarGuard, Marzban and Rebecca share the admin API shape (token from
// /api/admin/token, /api/user, /api/users, /api/system), so these adapters only override what differs:
//
//              new user is placed by        groups list            plain-links subscription path
// PasarGuard   group_ids                    /api/groups            <sub>/links
// Marzban      proxies (protocols)          (none)                 <sub>/v2ray
// Rebecca      service_id (exactly one)     /api/v2/services       <sub>/v2ray
//
// Rebecca (github.com/rebeccapanel/Rebecca) is a Go rewrite of Marzban: manual inbound selection is gone and
// every user must belong to a service, so a create without service_id is refused with 400.
import { PasarGuard, PasarGuardError } from './pasarguard.js';

// fields only PasarGuard knows; the others are given just what they understand
function withoutPgFields(fields) {
  const out = { ...fields };
  delete out.hwid_limit;
  delete out.group_ids;
  return out;
}

export class Marzban extends PasarGuard {
  get kind() { return 'marzban'; }
  get usesGroups() { return false; }
  get linksSuffix() { return 'v2ray'; }

  // protocols this admin may give users ({"vless": [...], "vmess": [...]}) -> {"vless": {}, "vmess": {}}
  async proxies() {
    const data = await this._json('GET', '/api/inbounds');
    const out = {};
    for (const [proto, list] of Object.entries(data || {})) if (Array.isArray(list) && list.length) out[proto] = {};
    if (!Object.keys(out).length) throw new PasarGuardError('panel has no inbounds to give users. Add one in the panel first', 0);
    return out;
  }

  async createUser(username, { expire, dataLimit, note }) {
    const body = {
      username, status: 'active', expire: expire || 0, data_limit: dataLimit || 0, data_limit_reset_strategy: 'no_reset',
      proxies: await this.proxies(), note: (note || '').slice(0, 450),
    };
    let u;
    try { u = await this._json('POST', '/api/user', body); }
    catch (e) {
      if (!(e instanceof PasarGuardError) || ![400, 422].includes(e.status)) throw e;
      delete body.note;
      u = await this._json('POST', '/api/user', body);
    }
    return this._complete(username, u);
  }

  // A create answer without the subscription link (some versions only return the basics): read the user.
  async _complete(username, u) {
    if (u && u.subscription_url) return u;
    return (await this.getUser(username)) || u || {};
  }

  modifyUser(username, fields) {
    return this._json('PUT', `/api/user/${encodeURIComponent(username)}`, withoutPgFields(fields));
  }

  async listGroups() { return []; }

  async deleteHwid() { return false; } // no device list on this panel
}

export class Rebecca extends Marzban {
  get kind() { return 'rebecca'; }
  get usesGroups() { return true; }

  // services this admin may put users in; a service without hosts would give users no configs
  async listGroups() {
    const data = await this._json('GET', '/api/v2/services?offset=0&limit=100');
    const list = Array.isArray(data.services) ? data.services : [];
    const usable = list.filter((s) => !s.broken && s.has_hosts !== false);
    return (usable.length ? usable : list.filter((s) => !s.broken)).map((s) => ({ id: s.id, name: s.name }));
  }

  async createUser(username, { expire, dataLimit, groupIds, note }) {
    const serviceId = (groupIds || [])[0];
    if (!serviceId) throw new PasarGuardError('Rebecca needs a service for new users. Set it: /panelgroups <panel> <service id>', 0);
    const body = {
      username, service_id: serviceId, status: 'active', expire: expire || 0, data_limit: dataLimit || 0,
      data_limit_reset_strategy: 'no_reset', note: (note || '').slice(0, 450),
    };
    let u;
    try { u = await this._json('POST', '/api/user', body); }
    catch (e) {
      if (!(e instanceof PasarGuardError) || ![400, 422].includes(e.status) || /service/i.test(e.detail)) throw e;
      delete body.note;
      u = await this._json('POST', '/api/user', body);
    }
    return this._complete(username, u);
  }
}

// Which of the family a panel is, from what it answers once logged in. Order matters: Rebecca and PasarGuard
// each have an endpoint the others lack; Marzban is what is left when the shared API works.
// Returns {kind, detail}: kind null = could not tell (detail says what was seen).
export async function detectKind(pg) {
  if (!pg.apiKey) await pg._login(); // throws with the panel's own message when the address or password is wrong
  const seen = [];
  const probe = async (path, test) => {
    try {
      const r = await pg._req('GET', path);
      seen.push(`${path.split('?')[0]} ${r.status}`);
      if (!r.ok) return false;
      return test(await r.json().catch(() => null));
    } catch (e) { seen.push(`${path.split('?')[0]} ${e.status || 'net'}`); return false; }
  };
  if (await probe('/api/v2/services?offset=0&limit=1', (j) => j && Array.isArray(j.services))) return { kind: 'rebecca', detail: '' };
  if (await probe('/api/groups/simple?all=true', (j) => j && Array.isArray(j.groups))) return { kind: 'pasarguard', detail: '' };
  if (await probe('/api/groups', (j) => j && Array.isArray(j.groups))) return { kind: 'pasarguard', detail: '' };
  if (await probe('/api/inbounds', (j) => j && typeof j === 'object' && !Array.isArray(j))) return { kind: 'marzban', detail: '' };
  return { kind: null, detail: seen.join(', ') };
}
