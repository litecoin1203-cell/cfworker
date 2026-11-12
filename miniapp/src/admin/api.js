// Admin calls: their own short token (15 min) from /admin/auth; signs in again once when it runs out.
import { initData } from '../tg.js';
import { request } from '../api.js';
import { englishError } from './errors.js';

let token = '';
let me = null;

async function auth() {
  const r = await request('/admin/auth', { method: 'POST', body: { init_data: initData() }, auth: false });
  token = r.access_token;
  me = { role: r.role, name: r.name };
  return me;
}

export class AdminError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function call(path, opts = {}) {
  const go = () => adminFetch(path, opts);
  try { return await go(); } catch (e) {
    if (e.status !== 401) throw e;
    await auth();
    return go();
  }
}

async function adminFetch(path, { method = 'GET', body, raw = false, timeoutMs = 25000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch('/api/v1' + path, {
      method, cache: 'no-store', signal: ctl.signal,
      headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new AdminError(0, 'network', 'The server could not be reached. Check that your VPN is on, then try again.');
  } finally { clearTimeout(timer); }
  if (raw && res.ok) return res;
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok && !(data && data.ok === false)) {
    const d = (data && data.detail) || {};
    const msg = res.status === 429 ? 'Too many requests. Wait a minute and try again.' : englishError(d.message || `Error ${res.status}`);
    throw new AdminError(res.status, d.code, msg);
  }
  if (data && data.ok === false) data.error = englishError(data.error);
  return data;
}

const q = (o) => {
  const s = Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return s ? '?' + s : '';
};
const post = (path, body) => call(path, { method: 'POST', body: body || {} });

export const admin = {
  auth, me: () => me,
  dashboard: () => call('/admin/dashboard'),
  inbox: () => call('/admin/inbox'),
  orders: (o) => call('/admin/orders' + q(o)),
  order: (id) => call('/admin/orders/' + id),
  receipt: async (orderId) => URL.createObjectURL(await (await call(`/admin/orders/${orderId}/receipt`, { raw: true })).blob()),
  users: (o) => call('/admin/users' + q(o)),
  user: (id) => call('/admin/users/' + id),
  userPanels: (id) => call(`/admin/users/${id}/panels`, { timeoutMs: 30000 }),
  userWallet: (id, before) => call(`/admin/users/${id}/wallet` + q({ before })),
  userOrders: (id, before) => call(`/admin/users/${id}/orders` + q({ before })),
  userNets: (id) => call(`/admin/users/${id}/nets`),
  createUser: (email, password) => post('/admin/users', { email, password }),
  setPassword: (id, password) => post(`/admin/users/${id}/password`, { password, confirm: true }),
  plans: () => call('/admin/plans'),
  coupons: (before) => call('/admin/coupons' + q({ before })),
  couponUses: (id) => call(`/admin/coupons/${id}/uses`),
  referral: () => call('/admin/referral'),
  payments: () => call('/admin/payments'),
  sms: (filter, before) => call('/admin/sms' + q({ filter, before })),
  smsSetup: () => call('/admin/sms/setup'),
  rate: () => call('/admin/rate', { timeoutMs: 30000 }),
  panels: () => call('/admin/panels'),
  panel: (id) => call('/admin/panels/' + id),
  panelServers: (id) => call(`/admin/panels/${id}/servers`, { timeoutMs: 30000 }),
  addPanel: (label, kind) => post('/admin/panels', { label, kind }),
  panelCred: (id, cred) => call(`/admin/panels/${id}/cred`, { method: 'POST', body: cred, timeoutMs: 45000 }),
  panelTest: (id) => call(`/admin/panels/${id}/test`, { method: 'POST', body: {}, timeoutMs: 45000 }),
  app: () => call('/admin/app'),
  domainTest: () => call('/admin/app/domains/test', { timeoutMs: 30000 }),
  net: () => call('/admin/net'),
  netUsers: () => call('/admin/net/users'),
  stats: (days) => call('/admin/stats' + q({ days })),
  broadcasts: () => call('/admin/broadcasts'),
  broadcast: (id) => call('/admin/broadcasts/' + id),
  health: () => call('/admin/health'),
  audit: (o) => call('/admin/audit' + q(o || {})),
  settings: () => call('/admin/settings'),
  admins: () => call('/admin/admins'),
  backup: () => post('/admin/backup'),
  // Iran-tunnel diagnostic of one panel; reread (owner) reads the panel again and stores it
  tunnel: (id, reread) => (reread ? call(`/admin/panels/${id}/tunnel`, { method: 'POST', body: {}, timeoutMs: 45000 }) : call(`/admin/panels/${id}/tunnel`, { timeoutMs: 45000 })),
  netServer: (key) => call('/admin/net/server' + q({ key })),
  syncNow: () => call('/admin/sync', { method: 'POST', body: {}, timeoutMs: 45000 }),
  // Pleat health reports
  reports: () => call('/admin/reports'),
  reportProblems: (o) => call('/admin/reports/problems' + q(o)),
  reportProblem: (fp) => call('/admin/reports/problem' + q({ fp })),
  reportServers: () => call('/admin/reports/servers'),
  reportUsers: () => call('/admin/reports/users'),
  reportVersions: () => call('/admin/reports/versions'),
  // Cloudflare monitoring
  cf: (part = '') => call('/admin/cf' + (part ? '/' + part : ''), { timeoutMs: 30000 }),
  // {ok, text, audit_id, undoable} or {ok: false, error}
  action: (name, args, confirm = false) => post('/admin/action', { name, args, confirm }),
  undo: (auditId) => post('/admin/undo', { audit_id: auditId }),
};
