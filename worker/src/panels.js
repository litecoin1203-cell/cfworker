// Panel registry and the one unified server list. Panels are interchangeable back ends behind an adapter;
// which panels a user is on, and what the app sees, is decided here. Nothing that leaves this file for the app
// carries a panel's name, address, id or count: configs are renamed and merged into one list.
import { first, all, run, insert } from './db.js';
import { nowSec, err, seal, openSealed } from './util.js';
import { PasarGuard, PasarGuardError, decodeSub } from './pasarguard.js';
import { Marzban, Rebecca, detectKind } from './marzban.js';
import { serverKey, linkEndpoint } from './netstats.js';

// states whose configs users get; draining/disabled panels are already out of the list
const SERVING = ['active', 'rollout'];
// One adapter class per panel type. Adding a type = one class with the PasarGuard methods (see marzban.js) and
// one line here; detectKind (marzban.js) learns to recognise it. 'auto' = not known yet: /paneltest finds out.
const ADAPTERS = { pasarguard: PasarGuard, marzban: Marzban, rebecca: Rebecca };
export const KINDS = ['auto', ...Object.keys(ADAPTERS)];

// Credentials of a panel. PASARGUARD = the original PASARGUARD_* secrets (panel 1). Other panels: what the
// admin gave the bot (/panelcred, sealed in D1 under settings key panel_cred_<id>), else the Workers Secret
// PANEL_<id>_CRED, JSON {"url", "username", "password"} or {"url", "api_key"}. null = not set or unreadable.
export const credKey = (id) => `panel_cred_${id}`;
const credPurpose = (id) => `panel-cred:${id}`;
const _opened = new Map(); // sealed text -> cred, per isolate (decrypting is cheap, this just skips it)

export async function credOf(env, panel) {
  if (panel.cred_ref === 'PASARGUARD') {
    if (!env.PASARGUARD_URL) return null;
    return { url: env.PASARGUARD_URL, username: env.PASARGUARD_USERNAME, password: env.PASARGUARD_PASSWORD, api_key: env.PASARGUARD_API_KEY };
  }
  const sealed = (await first(env, 'SELECT value FROM settings WHERE key = ?', credKey(panel.id)))?.value;
  if (sealed) {
    if (_opened.has(sealed)) return _opened.get(sealed);
    try {
      const c = JSON.parse((await openSealed(env.SECRET_KEY, credPurpose(panel.id), sealed)) || 'null');
      if (c && c.url) { _opened.set(sealed, c); return c; }
    } catch (e) { /* unreadable: fall back to the Workers Secret */ }
  }
  const raw = env[panel.cred_ref];
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    return c && c.url ? c : null;
  } catch (e) { return null; }
}

// What the admin typed: "address username password" (space or new line between) or the JSON form.
// {cred} or {error}. The values are never repeated in a reply.
export function parseCred(text) {
  const t = String(text || '').trim();
  let c = null;
  if (t.startsWith('{')) {
    try { c = JSON.parse(t); } catch (e) { return { error: 'json' }; }
  } else {
    const [url, username, ...rest] = t.split(/\s+/);
    c = rest.length ? { url, username, password: rest.join(' ') } : null;
  }
  if (!c || !c.url || !(c.api_key || (c.username && c.password))) return { error: 'parts' };
  let u;
  try { u = new URL(/^https?:\/\//i.test(c.url) ? c.url : 'https://' + c.url); } catch (e) { return { error: 'url' }; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return { error: 'url' };
  // the panel login and every user's link would cross the network in clear text
  if (u.protocol !== 'https:') return { error: 'http' };
  const out = { url: u.href };
  if (c.api_key) out.api_key = String(c.api_key);
  else { out.username = String(c.username); out.password = String(c.password); }
  return { cred: out };
}

export async function savePanelCred(env, panel, cred) {
  const sealed = await seal(env.SECRET_KEY, credPurpose(panel.id), JSON.stringify(cred));
  await run(env, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', credKey(panel.id), sealed);
}

// where a panel's login comes from, for the bot: 'bot' | 'secret' | 'env' | null
export async function credSource(env, panel) {
  if (panel.cred_ref === 'PASARGUARD') return env.PASARGUARD_URL ? 'env' : null;
  if (await first(env, 'SELECT 1 x FROM settings WHERE key = ?', credKey(panel.id))) return 'bot';
  return env[panel.cred_ref] ? 'secret' : null;
}

export function options(panel) {
  try { return JSON.parse(panel.options_json || '{}') || {}; } catch (e) { return {}; }
}

// The adapter for a panel. kind 'auto' (and any unknown kind) gives the shared API client, enough to log in
// and detect the real type; such a panel cannot take users until /paneltest has set its kind.
export async function adapterFor(env, panel, { probe = false, timeoutMs = 0 } = {}) {
  const cred = await credOf(env, panel);
  if (!cred) throw new PasarGuardError(`login for this panel is not set: send it with /panelcred ${panel.id} (or Workers Secret ${panel.cred_ref}, JSON with a "url")`, 0);
  const Cls = ADAPTERS[panel.kind];
  if (Cls) { const a = new Cls(env, cred); if (timeoutMs) a.timeoutMs = timeoutMs; return a; }
  if (probe) return new PasarGuard(env, cred);
  if (panel.kind === 'auto') throw new PasarGuardError(`panel type not known yet: run /paneltest ${panel.id}`, 0);
  throw new PasarGuardError(`no adapter for panel type ${panel.kind}`, 0);
}

// The panel's real type, learnt from the panel itself. A panel that has no users yet is corrected on the spot
// (e.g. a Rebecca panel added as pasarguard); a panel already serving users keeps its type and only reports.
// {kind, changed, error}
export async function detectPanelKind(env, panel) {
  let found;
  try { found = await detectKind(await adapterFor(env, panel, { probe: true })); }
  catch (e) {
    if (!(e instanceof PasarGuardError)) throw e;
    const notFamily = e.status === 404 || e.status === 405;
    return { kind: null, changed: false, error: notFamily ? `${e.message}. This address does not answer like PasarGuard, Marzban or Rebecca (no /api/admin/token); check the url in the secret (Hiddify is not supported yet)` : e.message };
  }
  if (!found.kind) return { kind: null, changed: false, error: `logged in, but could not tell the panel type (${found.detail})` };
  if (found.kind === panel.kind) return { kind: found.kind, changed: false, error: null };
  if (panel.kind === 'auto' || ['new', 'testing'].includes(panel.state)) {
    await run(env, 'UPDATE panels SET kind = ? WHERE id = ?', found.kind, panel.id);
    return { kind: found.kind, changed: true, error: null };
  }
  return { kind: found.kind, changed: false, error: null };
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
  return pickPanels(await listPanels(env), userId);
}
// The same choice from a panel list already read (the cron job reads it once for every user).
export function pickPanels(allPanels, userId) {
  const panels = allPanels.filter((p) => SERVING.includes(p.state));
  const picked = panels.filter((p) => p.state === 'active' || bucketOf(userId, p.id) < p.rollout_percent);
  return picked.length ? picked : panels;
}

// While the app waits, a panel gets 5 seconds, and one that failed its last checks gets 2.5 (the cron, which has
// time, keeps 15). One dead panel used to hold /me and the server list for 15 seconds per panel, one after another.
export const USER_PATH_MS = 5000;
export const userPathMs = (a) => ((a.fail_streak || 0) >= 3 ? USER_PATH_MS / 2 : USER_PATH_MS);

export async function accountsOf(env, userId) {
  return all(env, `SELECT a.*, p.kind, p.state AS panel_state, p.cred_ref, p.options_json, p.fail_streak FROM panel_accounts a
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

// What kinds of configs a panel serves, for the admin ("vless·reality·tcp ×6"). Pleat's core takes vless,
// vmess, trojan and shadowsocks; anything else (hysteria2, wireguard, tuic...) is counted as unusable.
export const APP_SCHEMES = ['vless', 'vmess', 'trojan', 'ss', 'hysteria2', 'hy2', 'wireguard', 'wg'];
export function linkKinds(links) {
  const counts = {};
  let unusable = 0;
  for (const link of links) {
    const scheme = link.split('://', 1)[0].toLowerCase();
    let net = '', sec = '';
    if (scheme === 'vmess') {
      try {
        let raw = link.split('://')[1];
        raw += '='.repeat((4 - (raw.length % 4)) % 4);
        const j = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
        net = j.net || 'tcp'; sec = j.tls || 'none';
      } catch (e) { /* counted as plain vmess */ }
    } else if (!['ss', 'hysteria2', 'hy2', 'wireguard', 'wg'].includes(scheme)) {
      const q = new URLSearchParams((link.split('?')[1] || '').split('#')[0]);
      net = q.get('type') || 'tcp'; sec = q.get('security') || 'none';
    }
    if (!APP_SCHEMES.includes(scheme)) unusable++;
    const key = [scheme === 'ss' ? 'shadowsocks' : scheme, sec && sec !== 'none' ? sec : '', net].filter(Boolean).join('·');
    counts[key] = (counts[key] || 0) + 1;
  }
  return { counts, unusable };
}

// Panel remarks can name the panel or the provider, so every config is renamed to its country and a number
// ("🇩🇪 DE 2"); identical configs from two panels appear once.
// Panels add info rows dressed as configs ("0 B / ∞ | ∞ روز" at 127.0.0.1:1, an expired-plan notice, ...):
// they go nowhere, so the app would list them as servers that always fail.
export function isPlaceholder(link) {
  let host = '', port = '';
  try {
    if (/^vmess:\/\//i.test(link)) {
      let raw = link.slice(8).split('#')[0].trim().replace(/-/g, '+').replace(/_/g, '/');
      raw += '='.repeat((4 - (raw.length % 4)) % 4);
      const j = JSON.parse(atob(raw));
      host = String(j.add || ''); port = String(j.port || '');
    } else {
      const rest = link.replace(/^[a-z0-9+.-]+:\/\//i, '').split('#')[0].split('?')[0].split('/')[0];
      const hp = rest.slice(rest.lastIndexOf('@') + 1);
      const m = hp.match(/^\[(.*)\]:(\d*)$/) || hp.match(/^(.*):(\d*)$/);
      if (m) { host = m[1]; port = m[2]; } else host = hp;
    }
  } catch (e) { return false; }
  host = host.toLowerCase();
  return /^127\./.test(host) || host === '0.0.0.0' || host === 'localhost' || host === '::1' || host === '::' || (port !== '' && Number(port) <= 1);
}

// labels = {serverKey: name} the admin gave a server (server_overrides): used as is, takes no number.
// Ranking does not move: it is keyed by serverKey (type|host|port), never by the name.
// kept (optional array) gets the index in `links` of every link that stays, in the same order as the result.
export function unify(links, labels = {}, kept = null) {
  const hasLabels = Object.keys(labels).length > 0;
  const seen = new Set();
  const perCc = {};
  const out = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (isPlaceholder(link)) continue;
    const key = link.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    if (kept) kept.push(i);
    const label = hasLabels ? labels[serverKey(link)] : null;
    if (label) { out.push(withRemark(link, label)); continue; }
    const cc = flagToCc(remarkOf(link));
    const n = (perCc[cc || '?'] = (perCc[cc || '?'] || 0) + 1);
    out.push(withRemark(link, cc ? `${ccToFlag(cc)} ${cc} ${n}` : `Server ${n}`));
  }
  return out;
}

// What the app may show as a server name. The app is English only, so no Persian/Arabic letters; emoji flags,
// Latin letters, digits and a little punctuation are fine. null = not allowed.
export function cleanServerLabel(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t || [...t].length > 40) return null;
  if (/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.test(t)) return null;
  if (/[<>"'`\\#%]/.test(t) || /[\u0000-\u001F\u007F]/.test(t)) return null;
  return t;
}

// Admin overrides (hide / rename) of these panels: {hidden: Set("pid:key"), labels: {pid: {key: label}}}. One query.
export async function overridesFor(env, panelIds) {
  const out = { hidden: new Set(), labels: {} };
  const ids = [...new Set(panelIds.map(Number).filter((n) => n > 0))];
  if (!ids.length) return out;
  const rows = await all(env, `SELECT panel_id, server_key, hidden, label FROM server_overrides
    WHERE panel_id IN (${ids.map(() => '?').join(',')})`, ...ids);
  for (const r of rows) {
    if (r.hidden) out.hidden.add(r.panel_id + ':' + r.server_key);
    if (r.label) (out.labels[r.panel_id] = out.labels[r.panel_id] || {})[r.server_key] = r.label;
  }
  return out;
}

// One panel's servers for the admin bot: a name numbered as if this panel were alone, the config type and the
// country. Read from one active account's subscription on that panel (1-2 fetches). Never returns an address,
// port, id or link. {servers: [{key, name, type, cc}], source: 'account' | 'none' | 'error'}
export async function panelServers(env, panel) {
  const a = await first(env, `SELECT a.*, p.kind, p.state AS panel_state, p.cred_ref, p.options_json FROM panel_accounts a
    JOIN panels p ON p.id = a.panel_id WHERE a.panel_id = ? AND a.desired = 'active' AND a.sub_path != ''
    ORDER BY a.id DESC LIMIT 1`, panel.id);
  if (!a) return { servers: [], source: 'none' };
  let found = [];
  try {
    const pg = await adapterFor(env, panelOfAccount(a));
    let raw = await pg.subscriptionRaw(a.sub_path, {});
    found = raw.status >= 200 && raw.status < 300 ? decodeSub(raw.text) : [];
    if (!found.length && ![403, 404, 429].includes(raw.status)) {
      raw = await pg.subscriptionRaw(pg.linksUrl(a.sub_path), {});
      found = raw.status >= 200 && raw.status < 300 ? decodeSub(raw.text) : [];
    }
  } catch (e) { return { servers: [], source: 'error' }; }
  const seen = new Set(), perCc = {}, servers = [];
  for (const link of found) {
    if (isPlaceholder(link)) continue;
    const key = serverKey(link);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const cc = flagToCc(remarkOf(link));
    const n = (perCc[cc || '?'] = (perCc[cc || '?'] || 0) + 1);
    const type = Object.keys(linkKinds([link]).counts)[0] || '?';
    servers.push({ key, name: cc ? `${ccToFlag(cc)} ${cc} ${n}` : `Server ${n}`, type, cc });
  }
  return { servers: servers.slice(0, 60), source: 'account' };
}

// The user's configs from every panel they are served by, merged. fwd = the phone's HWID headers (panel 1
// limits devices with them). {links, deviceLimit, missing}: deviceLimit = a panel refused this phone.
export async function collectLinks(env, userId, fwd = {}) {
  const accounts = (await accountsOf(env, userId)).filter((a) => SERVING.includes(a.panel_state) && a.desired === 'active' && a.sub_path);
  const links = [], labels = {}, from = [];
  const ov = await overridesFor(env, accounts.map((a) => a.panel_id));
  const rules = await hostRulesFor(env, accounts.map((a) => a.panel_id));
  let reached = 0, deviceLimit = false, missing = 0;
  // every panel is asked at the same time; the answers are then read in panel order, so the list stays stable
  const fetchOne = async (a) => {
    const pg = await adapterFor(env, panelOfAccount(a), { timeoutMs: userPathMs(a) }).catch(() => null);
    if (!pg) return null;
    let raw;
    try { raw = await pg.subscriptionRaw(a.sub_path, fwd); }
    catch (e) { return null; } // an unreachable panel only removes its own configs
    let found = raw.status >= 200 && raw.status < 300 ? decodeSub(raw.text) : [];
    // A panel whose rules answer the v2rayNG agent with Xray JSON (or refuse it, 406) gives no share links
    // here; its explicit /links format does, with the same device check.
    if (!found.length && ![403, 404, 429].includes(raw.status)) {
      try {
        const alt = await pg.subscriptionRaw(pg.linksUrl(a.sub_path), fwd);
        if (alt.status === 403 || alt.status === 429 || (alt.status >= 200 && alt.status < 300)) raw = alt;
        found = raw.status >= 200 && raw.status < 300 ? decodeSub(raw.text) : [];
      } catch (e) { /* keep the first answer */ }
    }
    return { raw, found };
  };
  const answers = await Promise.all(accounts.map(fetchOne));
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    if (!answers[i]) continue;
    const { raw, found } = answers[i];
    if (raw.status === 403 || raw.status === 429) { deviceLimit = true; continue; }
    if (raw.status === 404) { missing++; continue; }
    if (raw.status < 200 || raw.status >= 300) continue;
    reached++;
    for (const l of found) {
      const k = serverKey(l);
      if (ov.hidden.has(a.panel_id + ':' + k)) continue; // the admin hid it (server_overrides)
      links.push(l);
      from.push({ panel: a.panel_id, tunnel: isTunnelLink(rules[a.panel_id], l) });
      const lab = ov.labels[a.panel_id]?.[k];
      if (lab && !labels[k]) labels[k] = lab;
    }
  }
  const kept = [];
  const merged = unify(links, labels, kept);
  // meta[i] = where merged link i came from: {panel: panel id, tunnel: it is in that panel's "Tunnel" group}
  return { links: merged, meta: kept.map((i) => from[i]), reached, deviceLimit, missing, accounts: accounts.length };
}

// ---------------- which configs are tunnelled through Iran ----------------
// A panel's group named "Tunnel" holds configs that enter through Iran. Share links do not say which group they
// came from, so the panel's hosts are read (every 15 minutes, by the cron job) and kept in settings
// panel_hosts_<id>; a link is matched to the host it was made from by address, port and remark.

export async function hostRulesFor(env, panelIds) {
  const ids = [...new Set(panelIds.map(Number).filter((n) => n > 0))];
  const out = {};
  if (!ids.length) return out;
  const rows = await all(env, `SELECT key, value FROM settings WHERE key IN (${ids.map(() => '?').join(',')})`, ...ids.map((id) => `panel_hosts_${id}`));
  for (const r of rows) {
    try { const j = JSON.parse(r.value); if (Array.isArray(j.rules)) out[Number(r.key.slice(12))] = j.rules; } catch (e) { /* ignore a broken row */ }
  }
  return out;
}

const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "🇩🇪 {USERNAME} Tunnel" -> a pattern where every {VARIABLE} matches anything
function remarkPattern(tpl) {
  const parts = String(tpl || '').split(/\{[^{}]*\}/);
  try { return new RegExp('^' + parts.map(escRe).join('.*') + '$', 'su'); } catch (e) { return null; }
}
// "*.cdn.example" -> the panel puts random letters where the * is
function addressMatches(pattern, host) {
  if (!pattern.includes('*')) return pattern === host;
  try { return new RegExp('^' + pattern.split('*').map(escRe).join('[a-z0-9-]*') + '$').test(host); } catch (e) { return false; }
}

// true when the host this link best matches is in a tunnel group. A tie with a host outside it is not a tunnel.
export function isTunnelLink(rules, link) {
  if (!rules || !rules.length || !rules.some((r) => r.t)) return false;
  const ep = linkEndpoint(link);
  if (!ep) return false;
  const host = ep.host.toLowerCase(), port = parseInt(ep.port, 10);
  const remark = remarkOf(link).trim();
  let best = 0, tunnel = false, plain = false;
  for (const r of rules) {
    if (r.p != null && r.p !== port) continue;
    const addr = r.a.length ? r.a.some((a) => addressMatches(a, host)) : null;
    if (addr === false) continue;
    const re = remarkPattern(r.r);
    const rem = !!(re && remark && re.test(remark));
    if (!addr && !rem) continue; // a host with neither its address nor its name in the link is not this one
    const score = (addr ? 2 : 0) + (rem ? 3 : 0) + (r.p != null ? 1 : 0);
    if (score > best) { best = score; tunnel = !!r.t; plain = !r.t; }
    else if (score === best) { if (r.t) tunnel = true; else plain = true; }
  }
  return tunnel && !plain;
}

// Cron (every 15 minutes): re-read each serving panel's hosts. Settings are written only when they changed, or
// once a day so the age stays honest. A panel that cannot be reached keeps what was read last time.
export async function refreshHostRules(env) {
  const panels = (await listPanels(env)).filter((p) => SERVING.includes(p.state));
  const stored = await hostRulesStamps(env, panels.map((p) => p.id));
  const now = nowSec();
  for (const p of panels) {
    const old = stored[p.id];
    let rules;
    try {
      const pg = await adapterFor(env, p);
      if (typeof pg.hostRules !== 'function') continue;
      rules = await pg.hostRules();
    } catch (e) { continue; }
    if (rules === null) rules = [];
    const body = JSON.stringify(rules);
    if (old && old.body === body && now - (old.at || 0) < 86400) continue;
    await run(env, `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      `panel_hosts_${p.id}`, JSON.stringify({ at: now, rules }));
  }
}
async function hostRulesStamps(env, ids) {
  const out = {};
  if (!ids.length) return out;
  const rows = await all(env, `SELECT key, value FROM settings WHERE key IN (${ids.map(() => '?').join(',')})`, ...ids.map((id) => `panel_hosts_${id}`));
  for (const r of rows) {
    try { const j = JSON.parse(r.value); out[Number(r.key.slice(12))] = { at: j.at, body: JSON.stringify(j.rules || []) }; } catch (e) { /* re-read */ }
  }
  return out;
}

// Groups new accounts go into: panel 1 keeps the pg_group_ids setting, other panels use options.group_ids;
// empty = every group this admin may use.
// Panels without groups (Marzban) get []. Rebecca calls them services and takes exactly one.
export async function groupIdsFor(env, panel, pg) {
  if (!pg.usesGroups) return [];
  const word = pg.kind === 'rebecca' ? 'services' : 'groups';
  const howTo = panel.id === 1 ? '/set pg_group_ids 1' : `/panelgroups ${panel.id} 1`;
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
    throw new PasarGuardError(`could not read panel ${word} (${e.message}). Set them by hand: ${howTo}`, e.status || 0, e.detail);
  }
  if (!ids.length) throw new PasarGuardError(`panel has no usable ${word} for this admin. Create one (with hosts), then ${howTo}`, 0);
  return pg.kind === 'rebecca' ? ids.slice(0, 1) : ids;
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
// The panel's type is detected first; kind = what was found, kindChanged = the stored type was corrected.
export async function testPanel(env, panel) {
  const out = { login: false, create: false, configs: 0, version: null, sameHost: null, error: null, kind: null, kindChanged: false, kinds: null };
  let pg;
  try {
    const det = await detectPanelKind(env, panel);
    out.kind = det.kind;
    if (det.error) throw new PasarGuardError(det.error, 0);
    if (det.kind !== panel.kind) {
      if (!det.changed) throw new PasarGuardError(`this panel answers like ${det.kind}, but it is registered as ${panel.kind} and already serves users`, 0);
      out.kindChanged = true;
      panel = { ...panel, kind: det.kind };
    }
    pg = await adapterFor(env, panel);
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
      out.kinds = linkKinds(links);
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
  // the last result, for the panel card in the admin bot (facts only: no address, user name or link)
  const last = { at: nowSec(), healthy, configs: out.configs, kinds: out.kinds?.counts || null, unusable: out.kinds?.unusable || 0,
    error: out.error ? String(out.error).slice(0, 160) : null };
  await run(env, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    `panel_test_${panel.id}`, JSON.stringify(last));
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
