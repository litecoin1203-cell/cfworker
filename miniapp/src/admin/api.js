// Admin calls: their own short token (15 min) from /admin/auth; signs in again once when it runs out.
import { initData } from '../tg.js';
import { request } from '../api.js';

let token = '';
let me = null;

async function auth() {
  const r = await request('/admin/auth', { method: 'POST', body: { init_data: initData() }, auth: false });
  token = r.access_token;
  me = { role: r.role, name: r.name };
  return me;
}

async function call(path, opts = {}) {
  const go = () => adminFetch(path, opts);
  try { return await go(); } catch (e) {
    if (e.status !== 401) throw e;
    await auth();
    return go();
  }
}

async function adminFetch(path, { method = 'GET', body, raw = false } = {}) {
  let res;
  try {
    res = await fetch('/api/v1' + path, {
      method, cache: 'no-store',
      headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { throw Object.assign(new Error('سرور در دسترس نیست. VPN را بررسی کن و دوباره امتحان کن.'), { status: 0 }); }
  if (raw && res.ok) return res;
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok && !(data && data.ok === false)) {
    const d = (data && data.detail) || {};
    throw Object.assign(new Error(d.message || 'خطا (' + res.status + ')'), { status: res.status, code: d.code });
  }
  return data;
}

export const admin = {
  auth, me: () => me,
  dashboard: () => call('/admin/dashboard'),
  inbox: () => call('/admin/inbox'),
  users: (q, filter, before) => call(`/admin/users?q=${encodeURIComponent(q || '')}&filter=${filter || 'all'}${before ? '&before=' + before : ''}`),
  user: (id) => call('/admin/users/' + id),
  panels: (id) => call(`/admin/users/${id}/panels`),
  plans: () => call('/admin/plans'),
  receipt: async (orderId) => URL.createObjectURL(await (await call(`/admin/orders/${orderId}/receipt`, { raw: true })).blob()),
  // {ok, text, audit_id, undoable} or {ok: false, error}
  action: (name, args, confirm = false) => call('/admin/action', { method: 'POST', body: { name, args, confirm } }),
  undo: (auditId) => call('/admin/undo', { method: 'POST', body: { audit_id: auditId } }),
};
