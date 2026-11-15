// Read-only check of a REAL panel's API against what the Worker's adapters assume (release audit PNL-05, PNL-06).
// The owner runs it on his own computer; nothing is changed on the panel and nothing secret is printed.
//
//   PANEL_URL=https://panel.example.com PANEL_USERNAME=admin PANEL_PASSWORD='...' node scripts/verify-panel-api.mjs
//   (or PANEL_API_KEY=... instead of username/password; PANEL_KIND=pasarguard|marzban|rebecca to skip detection)
//
// What it does: logs in (POST /api/admin/token, the only non-GET call), reads /openapi.json, /api/system, the kind
// probes, ONE user record (the first of /api/users) and, for Rebecca, the services list and that user's /v2ray
// subscription (only counted). It prints field names, types, status codes and counts: no address, admin name,
// password, key, token, user name or link. Every printed line is checked for those values before it is shown.
import { analyseOpenApi, userFacts, problems } from '../src/panelapi.js';

const TIMEOUT_MS = 15000;

export async function verifyPanel({ url, username, password, apiKey, kind } = {}, fetchImpl = globalThis.fetch) {
  if (!url) throw new Error('PANEL_URL is not set');
  const base = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).origin;
  const secrets = new Set([url, base, new URL(base).host, username, password, apiKey].filter((s) => s && String(s).length >= 3));
  const report = { kind: kind || null, login: null, apiKeyHeader: null, system: null, openapi: null, user: null, services: null, v2ray: null, problems: [] };
  const call = async (method, path, { headers = {}, body } = {}) => {
    try {
      const r = await fetchImpl(base + path, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      let j = null, text = '';
      try { text = await r.text(); j = JSON.parse(text); } catch (e) { /* not JSON */ }
      return { status: r.status, json: j, text };
    } catch (e) { return { status: 0, json: null, text: '' }; }
  };
  let auth = {};
  if (apiKey) {
    auth = { 'x-api-key': apiKey };
    const r = await call('GET', '/api/system', { headers: auth });
    report.login = r.status === 200 ? 'api-key accepted' : `api-key refused (${r.status})`;
    report.apiKeyHeader = r.status === 200;
  } else {
    const r = await call('POST', '/api/admin/token', { headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: username || '', password: password || '', grant_type: 'password' }).toString() });
    const tok = r.json && r.json.access_token;
    report.login = tok ? 'ok' : `refused (${r.status})`;
    if (tok) { secrets.add(tok); auth = { authorization: `Bearer ${tok}` }; }
  }
  const get = (path) => call('GET', path, { headers: { accept: 'application/json', ...auth } });
  const sys = await get('/api/system');
  report.system = { status: sys.status, version: sys.json && sys.json.version ? String(sys.json.version).slice(0, 40) : null };

  if (!report.kind) {
    const probe = async (path, test) => { const r = await get(path); return r.status === 200 && test(r.json); };
    if (await probe('/api/v2/services?offset=0&limit=1', (j) => j && Array.isArray(j.services))) report.kind = 'rebecca';
    else if (await probe('/api/groups/simple?all=true', (j) => j && Array.isArray(j.groups)) || await probe('/api/groups', (j) => j && Array.isArray(j.groups))) report.kind = 'pasarguard';
    else if (await probe('/api/inbounds', (j) => j && typeof j === 'object' && !Array.isArray(j))) report.kind = 'marzban';
    else report.kind = 'unknown';
  }

  let doc = null;
  for (const path of ['/openapi.json', '/api/openapi.json', '/docs/openapi.json']) {
    const r = await get(path);
    if (r.status === 200 && r.json && r.json.paths) { doc = r.json; break; }
  }
  report.openapi = doc ? analyseOpenApi(doc, report.kind) : 'not readable (no /openapi.json for this admin)';

  const list = await get('/api/users?offset=0&limit=1');
  const first = list.json && Array.isArray(list.json.users) ? list.json.users[0] : null;
  let facts = null, user = null;
  if (first && first.username) {
    secrets.add(String(first.username));
    const r = await get(`/api/user/${encodeURIComponent(first.username)}`);
    user = r.status === 200 ? r.json : null;
    facts = userFacts(user);
    if (user && user.subscription_url) secrets.add(String(user.subscription_url));
  }
  report.user = facts || (list.status === 200 ? 'no users on this panel to look at' : `user list refused (${list.status})`);

  if (report.kind === 'rebecca') {
    const s = await get('/api/v2/services?offset=0&limit=100');
    const svc = s.json && Array.isArray(s.json.services) ? s.json.services : null;
    report.services = svc ? { count: svc.length, fields: [...new Set(svc.flatMap((x) => Object.keys(x || {})))].sort(), has_hosts: svc.some((x) => 'has_hosts' in (x || {})), broken: svc.some((x) => 'broken' in (x || {})) } : `refused (${s.status})`;
    if (user && user.subscription_url) {
      const subBase = new URL(String(user.subscription_url), base + '/').href.replace(/\/+$/, '');
      const r = await call('GET', new URL(subBase + '/v2ray').pathname);
      let lines = 0;
      try { lines = (r.text.includes('://') ? r.text : atob(r.text.replace(/\s+/g, ''))).split('\n').filter((l) => l.includes('://')).length; } catch (e) { lines = 0; }
      report.v2ray = { status: r.status, links: lines };
    }
  }
  report.problems = problems(typeof report.openapi === 'object' ? report.openapi : null, facts, report.kind);
  if (report.kind === 'rebecca' && report.services && typeof report.services === 'object' && !(report.services.has_hosts && report.services.broken)) report.problems.push('services have no has_hosts/broken fields (the adapter filters on them)');
  if (report.v2ray && !report.v2ray.links) report.problems.push('<sub>/v2ray gave no share links');

  // nothing secret may leave: any value we know is replaced before printing
  let out = JSON.stringify(report, null, 2);
  for (const s of secrets) out = out.split(String(s)).join('***');
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const e = process.env;
  verifyPanel({ url: e.PANEL_URL, username: e.PANEL_USERNAME, password: e.PANEL_PASSWORD, apiKey: e.PANEL_API_KEY, kind: e.PANEL_KIND })
    .then((out) => console.log(out))
    .catch((x) => { console.error('verify failed: ' + x.message); process.exit(1); });
}
