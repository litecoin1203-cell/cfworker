// The admin panel inside the Telegram Mini App: JSON over /api/v1/admin/*. It is a second face of the admin bot,
// not a second set of rules: who may enter is the bot's own adminRole (owner = TELEGRAM_CHAT_ID, then the admins
// table, re-read on every request), and every change goes through admin-actions.runAction, so validation, roles,
// the audit log and undo are exactly the bot's. Money and destructive actions also need confirm: true, which the
// page sends only after the admin said yes in Telegram's own confirm dialog.
import { json, err, signJwt, verifyJwt, jwtSecret, nowSec } from './util.js';
import { first, all } from './db.js';

const ADMIN_MIN = 15; // an admin token lives 15 minutes; the page signs in again with initData after that
const GB = 1024 ** 3;

// ---------------- sign-in ----------------
// POST /admin/auth {init_data}: a Telegram user who is an admin gets a short admin token; anyone else gets 403.
export async function adminAuth(env, body) {
  const { verifyInitData } = await import('./auth.js');
  const v = await verifyInitData(env.TELEGRAM_BOT_TOKEN, body && body.init_data, 3600);
  if (!v) throw err(401, 'bad_init_data', 'دوباره Mini App را از ربات باز کن.');
  const role = await roleOf(env, v.user.id);
  if (!role) throw err(403, 'not_admin', 'این بخش فقط برای مدیرهاست.');
  const token = await signJwt({ sub: String(v.user.id), typ: 'admin', role }, jwtSecret(env), ADMIN_MIN * 60);
  return json({ access_token: token, role, name: [v.user.first_name, v.user.last_name].filter(Boolean).join(' ').slice(0, 64), expires_in: ADMIN_MIN * 60 });
}

async function roleOf(env, tgId) {
  const { adminRole } = await import('./telegram.js');
  const id = String(tgId);
  return adminRole(env, { id, type: 'private' }, { id });
}

// Every admin request: a valid admin token AND the person is still an admin now (a removed admin is out at once).
export async function requireAdmin(env, request) {
  const auth = request.headers.get('authorization') || '';
  const p = await verifyJwt(auth.startsWith('Bearer ') ? auth.slice(7) : '', jwtSecret(env));
  if (!p || p.typ !== 'admin' || !/^\d{1,20}$/.test(String(p.sub || ''))) throw err(401, 'not_authenticated', 'دوباره وارد شو.');
  const role = await roleOf(env, p.sub);
  if (!role) throw err(403, 'not_admin', 'دیگر مدیر نیستی.');
  return { tgId: String(p.sub), role };
}

// ---------------- reads ----------------
const userLabel = (u) => (u.tg_id ? (u.tg_username ? '@' + u.tg_username : 'TG ' + u.tg_id) : String(u.email || '')).slice(0, 48);
const isDeleted = (u) => /^deleted\+\d+@invalid$/.test(String(u.email || ''));
const realEmail = (u) => (u.email && !/@telegram\.local$/.test(u.email) && !isDeleted(u) ? u.email : '');

// GET /admin/dashboard: the numbers on the bot's home screen plus the inbox counts
export async function dashboard(env) {
  const now = nowSec();
  const c = await first(env, `SELECT (SELECT COUNT(*) FROM users WHERE email NOT LIKE 'deleted+%') users,
    (SELECT COUNT(*) FROM subscriptions WHERE state = 'active' AND (expires_at IS NULL OR expires_at > ?1)) active,
    (SELECT COUNT(*) FROM orders WHERE status = 'review') review,
    (SELECT COUNT(*) FROM orders WHERE status = 'review' AND method = 'coin' AND txid IS NOT NULL) coin,
    (SELECT COUNT(*) FROM settings WHERE key LIKE 'panel_err_%' AND value != '') perr,
    (SELECT COUNT(*) FROM users WHERE created_at > ?2) new_week,
    (SELECT COALESCE(SUM(amount_toman), 0) FROM orders WHERE status = 'paid' AND paid_at > ?3) sales_today,
    (SELECT COALESCE(SUM(amount_toman), 0) FROM orders WHERE status = 'paid' AND paid_at > ?2) sales_week`,
  now, now - 7 * 86400, now - 86400);
  return json(c);
}

const ORDER_COLS = `o.id, o.user_id, o.kind, o.plan_id, o.amount_toman, o.method, o.status, o.receipt_ref, o.coin, o.coin_amount, o.txid,
  o.created_at, o.paid_at, o.admin_note, (o.receipt_file_id IS NOT NULL) has_receipt,
  u.email, u.tg_id, u.tg_username, p.name plan_name, p.data_limit_gb, p.duration_days`;
function orderOut(o) {
  return {
    id: o.id, user_id: o.user_id, user: userLabel(o), kind: o.kind, method: o.method, status: o.status, amount_toman: o.amount_toman,
    plan: o.plan_name ? { name: o.plan_name, gb: o.data_limit_gb, days: o.duration_days } : null,
    receipt_ref: o.receipt_ref || null, has_receipt: !!o.has_receipt, coin: o.coin || null, coin_amount: o.coin_amount || null,
    txid: o.txid || null, note: o.admin_note || null, created_at: o.created_at, paid_at: o.paid_at || null,
  };
}

// GET /admin/inbox: orders waiting for the admin (receipts, coin deposits found), oldest first
export async function inbox(env) {
  const rows = await all(env, `SELECT ${ORDER_COLS} FROM orders o JOIN users u ON u.id = o.user_id LEFT JOIN plans p ON p.id = o.plan_id
    WHERE o.status = 'review' ORDER BY o.created_at ASC LIMIT 50`);
  return json({ orders: rows.map(orderOut) });
}

// GET /admin/orders/:id/receipt: the receipt photo, fetched from Telegram (the bot stored only its file_id)
export async function receipt(env, orderId) {
  const o = await first(env, 'SELECT receipt_file_id FROM orders WHERE id = ?', parseInt(orderId, 10));
  if (!o || !o.receipt_file_id) throw err(404, 'no_receipt', 'این سفارش عکس رسید ندارد.');
  const { tg } = await import('./telegram.js');
  const f = await tg(env, 'getFile', { file_id: o.receipt_file_id });
  const path = f && f.ok && f.result && f.result.file_path;
  if (!path || !/^[\w./-]{1,200}$/.test(path)) throw err(502, 'telegram', 'عکس از تلگرام گرفته نشد.');
  const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`).catch(() => null);
  if (!r || !r.ok) throw err(502, 'telegram', 'عکس از تلگرام گرفته نشد.');
  const ext = path.split('.').pop().toLowerCase();
  const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' }[ext] || 'application/octet-stream';
  return new Response(r.body, { headers: { 'content-type': type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}

// GET /admin/users?q=&filter=&before=: newest first, 30 a page. q = #id, numeric Telegram id, @username or email part.
export async function users(env, url) {
  const { USER_FILTERS } = await import('./telegram-screens.js');
  const now = nowSec();
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 64);
  const filter = USER_FILTERS[url.searchParams.get('filter')] ? url.searchParams.get('filter') : 'all';
  const before = parseInt(url.searchParams.get('before') || '0', 10) || 0;
  const where = [USER_FILTERS[filter].where(now)];
  const args = [];
  if (q) {
    if (/^#?\d{1,20}$/.test(q)) { where.push('(id = ? OR tg_id = ?)'); args.push(parseInt(q.replace('#', ''), 10), q.replace('#', '')); }
    else if (q.startsWith('@')) { where.push('tg_username LIKE ?'); args.push(q.slice(1).toLowerCase().replace(/[%_]/g, '') + '%'); }
    else { where.push('(email LIKE ? OR tg_name LIKE ?)'); const like = '%' + q.toLowerCase().replace(/[%_]/g, '') + '%'; args.push(like, like); }
  }
  if (before > 0) { where.push('id < ?'); args.push(before); }
  const rows = await all(env, `SELECT u.id, u.email, u.tg_id, u.tg_username, u.tg_name, u.is_active, u.wallet_balance, u.created_at,
      s.state, s.expires_at, s.data_limit_bytes
    FROM (SELECT * FROM users WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 31) u
    LEFT JOIN subscriptions s ON s.user_id = u.id ORDER BY u.id DESC`, ...args);
  const more = rows.length > 30;
  return json({
    filter, more, next: more ? rows[29].id : null,
    users: rows.slice(0, 30).map((u) => ({
      id: u.id, label: userLabel(u), name: u.tg_name || '', email: realEmail(u), blocked: !u.is_active && !isDeleted(u), deleted: isDeleted(u),
      wallet: u.wallet_balance,
      sub: u.state ? { state: u.state, expires_at: u.expires_at, active: u.state === 'active' && (!u.expires_at || u.expires_at > now), gb: u.data_limit_bytes ? Math.round(u.data_limit_bytes / GB) : 0 } : null,
    })),
  });
}

// GET /admin/users/:id: everything the bot's user card shows
export async function user(env, id) {
  const uid = parseInt(id, 10);
  const u = await first(env, 'SELECT * FROM users WHERE id = ?', uid);
  if (!u) throw err(404, 'not_found', 'کاربر پیدا نشد.');
  const { subscriptionOut } = await import('./account.js');
  const [sub, devices, orders, tx] = await Promise.all([
    subscriptionOut(env, u, false),
    all(env, 'SELECT device_id, model, last_seen FROM devices WHERE user_id = ? ORDER BY last_seen DESC LIMIT 10', uid),
    all(env, `SELECT ${ORDER_COLS} FROM orders o JOIN users u ON u.id = o.user_id LEFT JOIN plans p ON p.id = o.plan_id
      WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 10`, uid),
    all(env, 'SELECT id, amount, balance_after, reason, note, created_at FROM wallet_tx WHERE user_id = ? ORDER BY id DESC LIMIT 10', uid),
  ]);
  // last connection on any panel this period (written by the sync job), and the period's start
  const per = await first(env, `SELECT p.started_at, (SELECT MAX(online_at) FROM usage_counters c WHERE c.period_id = p.id) seen
    FROM subscriptions s JOIN sub_periods p ON p.id = s.period_id WHERE s.user_id = ?`, uid);
  const { ONLINE_SEC } = await import('./telegram-screens.js');
  const seen = per && per.seen ? per.seen : null;
  return json({
    id: u.id, label: userLabel(u), name: u.tg_name || '', email: realEmail(u),
    telegram: u.tg_id ? { id: String(u.tg_id), username: u.tg_username || null } : null,
    blocked: !u.is_active && !isDeleted(u), deleted: isDeleted(u), wallet: u.wallet_balance, referral_code: u.referral_code,
    created_at: u.created_at, last_login_at: u.last_login_at || null,
    subscription: sub && { ...sub, sub_url: undefined, started_at: per ? per.started_at : null },
    last_seen: seen, online: !!(seen && nowSec() - seen < ONLINE_SEC),
    devices: devices.map((d) => ({ id: d.device_id.slice(0, 64), model: d.model || '', last_seen: d.last_seen })),
    orders: orders.map(orderOut),
    wallet_tx: tx,
  });
}

// GET /admin/plans: the plans an admin can give (not archived), cheapest first
export async function plans(env) {
  const rows = await all(env, `SELECT id, name, duration_days, data_limit_gb, price_toman, is_active FROM plans
    WHERE COALESCE(archived, 0) = 0 ORDER BY is_active DESC, sort, price_toman`);
  return json({ plans: rows });
}

// ---------------- writes ----------------
// POST /admin/action {name, args, confirm}: one admin action, exactly as the bot runs it
export async function action(env, admin, body) {
  const { ACTIONS, runAction } = await import('./admin-actions.js');
  const name = String((body && body.name) || '');
  const def = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
  if (!def) throw err(404, 'unknown_action', 'این کار وجود ندارد.');
  if ((def.risk === 'money' || def.risk === 'destructive') && body.confirm !== true) throw err(409, 'confirm', 'این کار تأیید می‌خواهد.');
  const args = body && body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
  const r = await runAction(env, admin.tgId, name, args);
  if (r.ok === false) return json({ ok: false, error: String(r.error || 'انجام نشد.') }, 422);
  return json({ ok: true, text: stripMarkup(r.text || r.summary || 'انجام شد.'), audit_id: r.auditId || null, undoable: !!r.undoable });
}

// POST /admin/undo {audit_id}
export async function undo(env, admin, body) {
  const { undoAction } = await import('./admin-actions.js');
  const r = await undoAction(env, admin.tgId, parseInt(body && body.audit_id, 10));
  if (r.ok === false) return json({ ok: false, error: String(r.error || 'برگشت ممکن نشد.') }, 422);
  return json({ ok: true, text: stripMarkup(r.text) });
}

// bot texts may carry «button» marks and /commands; the page shows plain text
const stripMarkup = (t) => String(t || '').replace(/<[^>]+>/g, '').slice(0, 600);

// GET /admin/users/:id/panels: the user's account on every panel, read live (same as the bot's "🗂 پنل‌های کاربر").
// Nothing is written; per panel: state, usage, its cap, created/expiry, last connection and "online now".
export async function userPanels(env, id) {
  const uid = parseInt(id, 10);
  const { accountsOf, adapterFor, userPathMs } = await import('./panels.js');
  const { parseExpire } = await import('./pasarguard.js');
  const { ONLINE_SEC } = await import('./telegram-screens.js');
  const sub = await first(env, 'SELECT period_id FROM subscriptions WHERE user_id = ?', uid);
  const accounts = await accountsOf(env, uid);
  const counted = new Map(sub && sub.period_id
    ? (await all(env, 'SELECT panel_id, accounted_bytes, online_at FROM usage_counters WHERE period_id = ?', sub.period_id)).map((c) => [c.panel_id, c]) : []);
  const labels = new Map((await all(env, 'SELECT id, label FROM panels')).map((p) => [p.id, p.label]));
  const now = nowSec();
  const out = await Promise.all(accounts.map(async (a) => {
    const c = counted.get(a.panel_id);
    const base = { panel_id: a.panel_id, panel: labels.get(a.panel_id) || '', username: a.remote_username, counted_bytes: c ? c.accounted_bytes || 0 : null };
    if (a.panel_state === 'disabled') return { ...base, state: 'panel_off' };
    let r = null;
    try {
      const pg = await adapterFor(env, { id: a.panel_id, kind: a.kind, cred_ref: a.cred_ref, options_json: a.options_json }, { timeoutMs: userPathMs(a) });
      r = await pg.getUser(a.remote_username);
    } catch (e) {
      return { ...base, state: 'no_answer', last_seen: (c && c.online_at) || null, online: !!(c && c.online_at && now - c.online_at < ONLINE_SEC) };
    }
    if (!r) return { ...base, state: 'missing' };
    const seen = parseExpire(r.online_at);
    return {
      ...base, state: String(r.status || 'unknown'),
      used_bytes: parseInt(r.used_traffic || 0, 10) || 0, limit_bytes: parseInt(r.data_limit || 0, 10) || 0,
      created_at: parseExpire(r.created_at) || null, expires_at: parseExpire(r.expire) || null,
      last_seen: seen || (c && c.online_at) || null, online: r.is_online === true || !!(seen && now - seen < ONLINE_SEC),
    };
  }));
  return json({ panels: out });
}
