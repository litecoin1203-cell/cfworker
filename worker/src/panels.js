// Panel registry and the one unified server list. Panels are interchangeable back ends behind an adapter;
// which panels a user is on, and what the app sees, is decided here. Nothing that leaves this file for the app
// carries a panel's name, address, id or count: configs are renamed and merged into one list.
import { first, all, run, insert } from './db.js';
import { nowSec, err } from './util.js';
import { PasarGuard, PasarGuardError, decodeSub } from './pasarguard.js';
import { Rebecca } from './rebecca.js';

// states whose configs users get; draining/disabled panels are already out of the list
const SERVING = ['active', 'rollout'];
export const KINDS = ['pasarguard', 'marzban', 'hiddify', 'rebecca'];

// Credentials of a panel, from its Workers Secret. PASARGUARD = the original PASARGUARD_* secrets (panel 1);
// PANEL_<id>_CRED holds JSON {"url", "username", "password"} or {"url", "api_key"}. null = not set or unreadable.
export function credOf(env, panel) {
  if (panel.cred_ref === 'PASARGUARD') {
    if (!env.PASARGUARD_URL) return null;
    return { url: env.PASARGUARD_URL, username: env.PASARGUARD_USERNAME, password: env.PASARGUARD_PASSWORD, api_key: env.PASARGUARD_API_KEY };
  }
  const raw = env[panel.cred_ref];
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    return c && c.url ? c : null;
  } catch (e) { return null; }
}

export function options(panel) {
  try { return JSON.parse(panel.options_json || '{}') || {}; } catch (e) { return {}; }
}

// The adapter for a panel. Marzban and Hiddify adapters arrive in stage 5; until then such a panel cannot be used.
// Rebecca has its own adapter (worker/src/rebecca.js); panel 1's Pasarguard path below is unchanged.
export function adapterFor(env, panel) {
  const cred = credOf(env, panel);
  if (!cred) throw new PasarGuardError(`secret ${panel.cred_ref} is not set`, 0);
  if (panel.kind === 'pasarguard') return new PasarGuard(env, cred);
  if (panel.kind === 'rebecca') return new Rebecca(env, cred, { panelId: panel.id, serviceId: options(panel).service_id });
  throw new PasarGuardError(`no adapter for panel type ${panel.kind} yet`, 0);
}

export const getPanel = (env, id) => first(env, 'SELECT * FROM panels WHERE id = ?', id);
export const listPanels = (env) => all(env, 'SELECT * FROM panels ORDER BY id');

// Stable spread of users over a panel being rolled out: the same user is always in or out at a given percent.
export function bucketOf(userId, panelId) {
  let h = 0x811c9dc5;
  for (const ch of `${userId}:${panelId}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % 100;
}

// Panels this user should have an account on. A user is never left without a panel: if the only panels
// that would take them are being rolled out to others, they get those (this is how users of a removed panel move).
export async function panelsFor(env, userId) {
  const panels = (await listPanels(env)).filter((p) => SERVING.includes(p.state));
  const picked = panels.filter((p) => p.state === 'active' || bucketOf(userId, p.id) < p.rollout_percent);
  return picked.length ? picked : panels;
}

export async function accountsOf(env, userId) {
  return all(env, `SELECT a.*, p.kind, p.state AS panel_state, p.cred_ref, p.options_json FROM panel_accounts a
    JOIN panels p ON p.id = a.panel_id WHERE a.user_id = ? ORDER BY a.panel_id`, userId);
}

const panelOfAccount = (a) => ({ id: a.panel_id, kind: a.kind, state: a.panel_state, cred_ref: a.cred_ref, options_json: a.options_json });

export async function recordHealth(env, panelId, okNow) {
  const now = nowSec();
  if (okNow) await run(env, 'UPDATE panels SET fail_streak = 0, health = MIN(100, health + 20), last_ok_at = ?, last_check_at = ? WHERE id = ?', now, now, panelId);
  else await run(env, 'UPDATE panels SET fail_streak = fail_streak + 1, health = MAX(0, health - 34), last_check_at = ? WHERE id = ?', now, panelId);
}

// ---------------- unified list ----------------
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;
export function flagToCc(text) {
  const m = (text || '').match(FLAG_RE);
  if (!m) return '';
  return Array.from(m[0]).map((ch) => String.fromCharCode(ch.codePointAt(0) - 0x1f1e6 + 65)).join('');
}
const ccToFlag = (cc) => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');

function remarkOf(link) {
  const scheme = link.split('://', 1)[0].toLowerCase();
  if (scheme === 'vmess') {
    try {
      let raw = link.split('://')[1];
      raw += '='.repeat((4 - (raw.length % 4)) % 4);
      return JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))).ps || '';
    } catch (e) { return ''; }
  }
  const frag = link.split('#')[1] || '';
  try { return decodeURIComponent(frag); } catch (e) { return frag; }
}

function withRemark(link, name) {
  const scheme = link.split('://', 1)[0].toLowerCase();
  if (scheme === 'vmess') {
    try {
      let raw = link.split('://')[1];
      raw += '='.repeat((4 - (raw.length % 4)) % 4);
      const j = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
      j.ps = name;
      return 'vmess://' + btoa(unescape(encodeURIComponent(JSON.stringify(j))));
    } catch (e) { return link; }
  }
  return link.split('#')[0] + '#' + encodeURIComponent(name);
}

// Panel remarks can name the panel or the provider, so every config is renamed to its country and a number
// ("🇩🇪 DE 2"); identical configs from two panels appear once.
export function unify(links) {
  const seen = new Set();
  const perCc = {};
  const out = [];
  for (const link of links) {
    const key = link.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    const cc = flagToCc(remarkOf(link));
    const n = (perCc[cc || '?'] = (perCc[cc || '?'] || 0) + 1);
    out.push(withRemark(link, cc ? `${ccToFlag(cc)} ${cc} ${n}` : `Server ${n}`));
  }
  return out;
}

// The user's configs from every panel they are served by, merged. fwd = the phone's HWID headers (panel 1
// limits devices with them). {links, deviceLimit, missing}: deviceLimit = a panel refused this phone.
export async function collectLinks(env, userId, fwd = {}) {
  const accounts = (await accountsOf(env, userId)).filter((a) => SERVING.includes(a.panel_state) && a.desired === 'active' && a.sub_path);
  const links = [];
  let reached = 0, deviceLimit = false, missing = 0;
  for (const a of accounts) {
    let raw;
    const pg = (() => { try { return adapterFor(env, panelOfAccount(a)); } catch (e) { return null; } })();
    if (!pg) continue;
    try { raw = await pg.subscriptionRaw(a.sub_path, fwd); }
    catch (e) { continue; } // an unreachable panel only removes its own configs
    let found = raw.status >= 200 && raw.status < 300 ? decodeSub(raw.text) : [];
    // A panel whose rules answer the v2rayNG agent with Xray JSON (or refuse it, 406) gives no share links
    // here; its explicit /links format does, with the same device check.
    if (!found.length && ![403, 404, 429].includes(raw.status)) {
      try {
        const alt = await pg.subscriptionRaw(a.sub_path.replace(/\/+$/, '') + '/links', fwd);
        if (alt.status === 403 || alt.status === 429 || (alt.status >= 200 && alt.status < 300)) raw = alt;
        found = raw.status >= 200 && raw.status < 300 ? decodeSub(raw.text) : [];
      } catch (e) { /* keep the first answer */ }
    }
    if (raw.status === 403 || raw.status === 429) { deviceLimit = true; continue; }
    if (raw.status === 404) { missing++; continue; }
    if (raw.status < 200 || raw.status >= 300) continue;
    reached++;
    links.push(...found);
  }
  return { links: unify(links), reached, deviceLimit, missing, accounts: accounts.length };
}

// Groups new accounts go into: panel 1 keeps the pg_group_ids setting, other panels use options.group_ids;
// empty = every group this admin may use. Rebecca has no groups at all, so it
// returns [] immediately and never calls a groups endpoint (which 404s there).
// Panel 1's path below is exactly as before.
export async function groupIdsFor(env, panel, pg) {
  if (panel.kind === 'rebecca') return [];
  let ids = [];
  if (panel.id === 1) {
    const raw = String((await first(env, "SELECT value FROM settings WHERE key = 'pg_group_ids'"))?.value || '').trim();
    ids = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
  } else {
    const g = options(panel).group_ids;
    if (Array.isArray(g)) ids = g.map((n) => parseInt(n, 10)).filter((n) => n > 0);
  }
  if (ids.length) return ids;
  try { ids = await pg.listGroupIds(); }
  catch (e) {
    throw new PasarGuardError(`could not read panel groups (${e.message}). Set them by hand: /set pg_group_ids 1`, e.status || 0, e.detail);
  }
  if (!ids.length) throw new PasarGuardError('panel has no enabled groups for this admin. Create one, then /set pg_group_ids <id>', 0);
  return ids;
}

// ---------------- registry changes (admin bot) ----------------
export async function addPanel(env, kind, label) {
  if (!KINDS.includes(kind)) throw err(400, 'bad_kind', 'unknown panel type');
  const id = await insert(env, 'panels', { kind, label: String(label).slice(0, 40), cred_ref: 'PENDING', state: 'new', rollout_percent: 0, created_at: nowSec() });
  await run(env, 'UPDATE panels SET cred_ref = ? WHERE id = ?', `PANEL_${id}_CRED`, id);
  return getPanel(env, id);
}

// Health test before a panel takes users: log in, create and delete a throw-away user, read its configs.
// Reports facts only (never the address or the user name). sameHost = the node hosts in the configs are the
// panel's own host, which the app then cannot avoid seeing inside the configs.
export async function testPanel(env, panel) {
  const out = { login: false, create: false, configs: 0, version: null, sameHost: null, error: null };
  let pg;
  try {
    pg = adapterFor(env, panel);
    if (!pg.apiKey) await pg._login();
    out.login = true;
    out.version = await pg.version();
    const ids = await groupIdsFor(env, panel, pg);
    const name = `cgtest_${Math.floor(Math.random() * 1e6)}`;
    const u = await pg.createUser(name, { expire: nowSec() + 3600, dataLimit: 10 * 1024 * 1024, groupIds: ids, note: 'Cloud Gold test, safe to delete' });
    out.create = true;
    try {
      const links = u.subscription_url ? await pg.subscriptionLinks(u.subscription_url) : [];
      out.configs = links.length;
      const hosts = pg.panelHosts();
      const nodeHosts = links.map((l) => { try { return new URL(l.replace(/^[a-z0-9+.-]+:\/\//i, 'http://')).hostname.toLowerCase(); } catch (e) { return ''; } }).filter(Boolean);
      if (nodeHosts.length) out.sameHost = nodeHosts.some((h) => hosts.includes(h));
    } finally {
      try { await pg.deleteUser(name); } catch (e) { /* left behind; named cgtest_ */ }
    }
  } catch (e) {
    out.error = e instanceof PasarGuardError ? e.message : 'unexpected error';
  }
  const healthy = out.login && out.create && out.configs > 0;
  await recordHealth(env, panel.id, healthy);
  await run(env, 'UPDATE panels SET version = COALESCE(?, version) WHERE id = ?', out.version, panel.id);
  if (healthy && panel.state === 'new') await run(env, "UPDATE panels SET state = 'testing' WHERE id = ?", panel.id);
  return { ...out, healthy };
}

// 0..100. 100 = every user; at 0 the panel is tested but takes nobody yet.
export async function setRollout(env, panel, percent) {
  const pct = Math.max(0, Math.min(100, Math.floor(percent)));
  const state = pct >= 100 ? 'active' : 'rollout';
  await run(env, 'UPDATE panels SET rollout_percent = ?, state = ? WHERE id = ?', pct, state, panel.id);
  return getPanel(env, panel.id);
}

// Soft removal: out of the list at once; the sync job reads its usage one last time, then switches its
// accounts off and marks it disabled. Its usage and accounts stay in the database for good.
export async function drainPanel(env, panel) {
  await run(env, "UPDATE panels SET state = 'draining', drain_started_at = ? WHERE id = ? AND state NOT IN ('draining', 'disabled')", nowSec(), panel.id);
  await run(env, 'DELETE FROM sync_cursor WHERE panel_id = ?', panel.id);
  return getPanel(env, panel.id);
}
