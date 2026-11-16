// What the Worker assumes about each panel's API, checked against the panel's own OpenAPI document and a real
// user record (release audit PNL-05, PNL-06). Pure functions: no network, no D1. Used by the panel test in the bot
// and by scripts/verify-panel-api.mjs, which the owner runs against a real panel. Every result is facts only:
// path names, field names and types, never an address, a user name, a link or a value.

// [method, path] the adapters call. A path parameter matches any name ({username} = {user_name} = {id}).
export const NEEDS = {
  common: [
    ['POST', '/api/admin/token'], ['POST', '/api/user'], ['GET', '/api/user/{}'], ['PUT', '/api/user/{}'],
    ['DELETE', '/api/user/{}'], ['POST', '/api/user/{}/reset'], ['GET', '/api/users'], ['GET', '/api/system'],
  ],
  pasarguard: [['GET', '/api/groups'], ['GET', '/api/hosts']],
  marzban: [['GET', '/api/inbounds']],
  rebecca: [['GET', '/api/v2/services']],
};
// device limit (HWID): the create field and the removal path the PasarGuard adapter uses (Remnawave-style headers)
export const HWID_PATH = ['DELETE', '/api/user/{}/hwids/{}'];

const norm = (p) => String(p || '').replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '') || '/';

function deref(doc, s, depth = 0) {
  if (!s || typeof s !== 'object' || depth > 6) return s || null;
  if (s.$ref) {
    const parts = String(s.$ref).replace(/^#\//, '').split('/');
    let t = doc;
    for (const k of parts) t = t && t[k];
    return deref(doc, t, depth + 1);
  }
  const merged = [...(s.allOf || [])].map((x) => deref(doc, x, depth + 1)).filter(Boolean);
  if (merged.length) return { ...s, properties: Object.assign({}, ...merged.map((m) => m.properties || {}), s.properties || {}) };
  return s;
}

// 'integer' | 'string' | 'date-time' | 'integer|date-time' ... for a property schema
function typeOf(doc, p) {
  p = deref(doc, p);
  if (!p) return null;
  const alts = (p.anyOf || p.oneOf || [p]).map((x) => deref(doc, x)).filter(Boolean);
  const names = alts.map((x) => (x.format === 'date-time' ? 'date-time' : x.type || (x.$ref ? 'object' : null))).filter((t) => t && t !== 'null');
  return [...new Set(names)].join('|') || null;
}

// {openapi, version, paths, missing: ['GET /api/...'], hwid: {path, field}, create: {field: type}, apiKeyHeader}
export function analyseOpenApi(doc, kind = 'pasarguard') {
  if (!doc || typeof doc !== 'object' || !doc.paths || typeof doc.paths !== 'object') return null;
  const have = new Set();
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const m of Object.keys(ops || {})) have.add(`${m.toUpperCase()} ${norm(path)}`);
  }
  const want = [...NEEDS.common, ...(NEEDS[kind] || [])];
  const missing = want.filter(([m, p]) => !have.has(`${m} ${norm(p)}`)).map(([m, p]) => `${m} ${p}`);
  const createOp = (doc.paths['/api/user'] || doc.paths['/api/user/'] || {}).post || {};
  const body = deref(doc, createOp.requestBody);
  const schema = deref(doc, body && body.content && (body.content['application/json'] || Object.values(body.content)[0] || {}).schema);
  const props = (schema && schema.properties) || {};
  const create = {};
  for (const f of ['expire', 'data_limit', 'hwid_limit', 'group_ids', 'service_id', 'proxies', 'inbounds', 'note', 'status', 'data_limit_reset_strategy']) {
    if (f in props) create[f] = typeOf(doc, props[f]) || 'any';
  }
  const schemes = Object.values((doc.components && doc.components.securitySchemes) || {});
  const apiKeyHeader = schemes.some((s) => s && s.type === 'apiKey' && s.in === 'header' && /^x-api-key$/i.test(s.name || ''));
  return {
    openapi: String(doc.openapi || doc.swagger || '').slice(0, 20) || null,
    version: doc.info && doc.info.version ? String(doc.info.version).slice(0, 40) : null,
    paths: have.size,
    missing,
    hwid: { path: have.has(`${HWID_PATH[0]} ${norm(HWID_PATH[1])}`), field: 'hwid_limit' in props },
    create,
    apiKeyHeader,
  };
}

// Field names and value kinds of one user record as the panel returns it (GET /api/user/<name>). No values.
export function userFacts(u) {
  if (!u || typeof u !== 'object') return null;
  const kindOf = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' ? 'number'
    : typeof v === 'string' ? (/^\d{4}-\d\d-\d\dT/.test(v) ? 'iso-date' : /^\d+$/.test(v) ? 'digits' : 'string') : Array.isArray(v) ? 'array' : typeof v);
  const out = {};
  for (const f of ['id', 'username', 'status', 'expire', 'data_limit', 'used_traffic', 'online_at', 'subscription_url', 'note',
    'hwid_limit', 'group_ids', 'service_id', 'proxies', 'data_limit_reset_strategy']) out[f] = f in u ? kindOf(u[f]) : 'absent';
  return out;
}

// What the adapters would get wrong on this panel, as short English lines (empty = nothing found).
export function problems(api, facts, kind = 'pasarguard') {
  const out = [];
  if (api) {
    for (const m of api.missing) out.push(`the panel's API document has no ${m}`);
    if (kind === 'pasarguard' && !api.hwid.field) out.push('create has no hwid_limit field: the device limit is dropped (lean retry)');
    if (kind === 'pasarguard' && !api.hwid.path) out.push('no DELETE /api/user/{id}/hwids/{hwid}: removing a device does nothing on this panel');
    if (kind === 'rebecca' && !('service_id' in api.create)) out.push('create has no service_id field');
    if (kind === 'pasarguard' && !('group_ids' in api.create)) out.push('create has no group_ids field');
    if (kind === 'marzban' && !('proxies' in api.create)) out.push('create has no proxies field');
  }
  if (facts) {
    for (const f of ['used_traffic', 'subscription_url', 'expire', 'status']) if (facts[f] === 'absent') out.push(`a user record has no ${f}`);
    if (facts.expire === 'string') out.push('expire is neither a number nor an ISO date');
  }
  return out;
}
