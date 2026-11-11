// The admin panel inside the Telegram Mini App: JSON over /api/v1/admin/*. It is a second face of the admin bot,
// not a second set of rules: who may enter is the bot's own adminRole (owner = TELEGRAM_CHAT_ID, then the admins
// table, re-read on every request), and every change goes through admin-actions.runAction, so validation, roles,
// the audit log and undo are exactly the bot's. Money and destructive actions also need confirm: true, which the
// page sends only after the admin said yes in Telegram's own confirm dialog.
//
// Reads follow the bot's role rules too (telegram-menu.allowedTap): support sees the inbox and orders only,
// viewer sees every screen except setting values and the admin list, owner sees and does everything.
// The page is English, so the messages thrown here are English; action errors from admin-actions stay as the bot
// writes them and the page translates the ones it knows.
import { json, err, signJwt, verifyJwt, jwtSecret, nowSec } from './util.js';
import { first, all, getSettings, SETTING_DEFAULTS } from './db.js';

const ADMIN_MIN = 15; // an admin token lives 15 minutes; the page signs in again with initData after that
const GB = 1024 ** 3;
const PAGE = 30;
const LEVEL = { support: 1, viewer: 2, owner: 3 };

// ---------------- sign-in ----------------
// POST /admin/auth {init_data}: a Telegram user who is an admin gets a short admin token; anyone else gets 403.
export async function adminAuth(env, body) {
  const { verifyInitData } = await import('./auth.js');
  const v = await verifyInitData(env.TELEGRAM_BOT_TOKEN, body && body.init_data, 3600);
  if (!v) throw err(401, 'bad_init_data', 'Open the Mini App again from the bot.');
  const role = await roleOf(env, v.user.id);
  if (!role) throw err(403, 'not_admin', 'This part is for admins only.');
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
  if (!p || p.typ !== 'admin' || !/^\d{1,20}$/.test(String(p.sub || ''))) throw err(401, 'not_authenticated', 'Sign in again.');
  const role = await roleOf(env, p.sub);
  if (!role) throw err(403, 'not_admin', 'You are no longer an admin.');
  return { tgId: String(p.sub), role };
}

const need = (admin, level) => {
  if ((LEVEL[admin.role] || 0) < LEVEL[level]) throw err(403, 'role', 'Your admin role cannot open this.');
};

// ---------------- the router ----------------
// [method, path pattern, the lowest role that may call it, handler(env, ctx)]; ctx = {admin, url, m (match), body()}
const ROUTES = [
  ['GET', /^\/admin\/dashboard$/, 'support', (env, c) => dashboard(env, c.admin)],
  ['GET', /^\/admin\/inbox$/, 'support', (env) => inbox(env)],
  ['GET', /^\/admin\/orders$/, 'support', (env, c) => orders(env, c.url)],
  ['GET', /^\/admin\/orders\/(\d{1,12})$/, 'support', (env, c) => order(env, c.m[1])],
  ['GET', /^\/admin\/orders\/(\d{1,12})\/receipt$/, 'support', (env, c) => receipt(env, c.m[1])],
  ['GET', /^\/admin\/users$/, 'viewer', (env, c) => users(env, c.url)],
  ['GET', /^\/admin\/users\/(\d{1,12})$/, 'viewer', (env, c) => user(env, c.m[1])],
  ['GET', /^\/admin\/users\/(\d{1,12})\/panels$/, 'viewer', (env, c) => userPanels(env, c.m[1])],
  ['GET', /^\/admin\/users\/(\d{1,12})\/wallet$/, 'viewer', (env, c) => userWallet(env, c.m[1], c.url)],
  ['GET', /^\/admin\/users\/(\d{1,12})\/orders$/, 'viewer', (env, c) => userOrders(env, c.m[1], c.url)],
  ['GET', /^\/admin\/users\/(\d{1,12})\/nets$/, 'viewer', (env, c) => userNets(env, c.m[1])],
  ['GET', /^\/admin\/plans$/, 'viewer', (env) => plans(env)],
  ['GET', /^\/admin\/coupons$/, 'viewer', (env, c) => coupons(env, c.url)],
  ['GET', /^\/admin\/coupons\/(\d{1,12})\/uses$/, 'viewer', (env, c) => couponUses(env, c.m[1])],
  ['GET', /^\/admin\/referral$/, 'viewer', (env) => referral(env)],
  ['GET', /^\/admin\/payments$/, 'viewer', (env, c) => payments(env, c.admin)],
  ['GET', /^\/admin\/sms$/, 'viewer', (env, c) => smsLog(env, c.url)],
  ['GET', /^\/admin\/sms\/setup$/, 'owner', (env) => smsSetup(env)],
  ['GET', /^\/admin\/rate$/, 'owner', (env) => rate(env)],
  ['GET', /^\/admin\/panels$/, 'viewer', (env) => panels(env)],
  ['GET', /^\/admin\/panels\/(\d{1,12})$/, 'viewer', (env, c) => panel(env, c.m[1])],
  ['GET', /^\/admin\/panels\/(\d{1,12})\/servers$/, 'viewer', (env, c) => panelServerList(env, c.m[1])],
  ['GET', /^\/admin\/app$/, 'viewer', (env) => app(env)],
  ['GET', /^\/admin\/app\/domains\/test$/, 'viewer', (env) => domainTest(env)],
  ['GET', /^\/admin\/net$/, 'viewer', (env) => net(env)],
  ['GET', /^\/admin\/net\/users$/, 'viewer', (env) => netUsers(env)],
  ['GET', /^\/admin\/stats$/, 'viewer', (env, c) => stats(env, c.url)],
  ['GET', /^\/admin\/broadcasts$/, 'viewer', (env) => broadcasts(env)],
  ['GET', /^\/admin\/broadcasts\/(\d{1,12})$/, 'viewer', (env, c) => broadcast(env, c.m[1])],
  ['GET', /^\/admin\/health$/, 'viewer', (env) => health(env)],
  ['GET', /^\/admin\/audit$/, 'viewer', (env, c) => audit(env, c.url)],
  ['GET', /^\/admin\/settings$/, 'owner', (env) => settings(env)],
  ['GET', /^\/admin\/admins$/, 'owner', (env) => admins(env)],
  ['POST', /^\/admin\/action$/, 'support', async (env, c) => action(env, c.admin, await c.body())],
  ['POST', /^\/admin\/undo$/, 'support', async (env, c) => undo(env, c.admin, await c.body())],
  ['POST', /^\/admin\/users$/, 'owner', async (env, c) => createUser(env, c.admin, await c.body())],
  ['POST', /^\/admin\/users\/(\d{1,12})\/password$/, 'owner', async (env, c) => setPassword(env, c.admin, c.m[1], await c.body())],
  ['POST', /^\/admin\/panels$/, 'owner', async (env, c) => addPanel(env, c.admin, await c.body())],
  ['POST', /^\/admin\/panels\/(\d{1,12})\/cred$/, 'owner', async (env, c) => panelCred(env, c.admin, c.m[1], await c.body())],
  ['POST', /^\/admin\/panels\/(\d{1,12})\/test$/, 'owner', (env, c) => panelTest(env, c.admin, c.m[1])],
  ['POST', /^\/admin\/backup$/, 'owner', (env, c) => backup(env, c.admin)],
];

// index.js has already signed the admin in; this picks the handler and checks the role
export async function route(env, request, path, url, admin, body) {
  for (const [method, re, level, fn] of ROUTES) {
    const m = path.match(re);
    if (!m || method !== request.method) continue;
    need(admin, level);
    return fn(env, { admin, url, m, body });
  }
  return null;
}

// ---------------- shared bits ----------------
const userLabel = (u) => (u.tg_id ? (u.tg_username ? '@' + u.tg_username : 'TG ' + u.tg_id) : String(u.email || '')).slice(0, 48);
const isDeleted = (u) => /^deleted\+\d+@invalid$/.test(String(u.email || ''));
const realEmail = (u) => (u.email && !/@telegram\.local$/.test(u.email) && !isDeleted(u) ? u.email : '');
const before = (url) => parseInt(url.searchParams.get('before') || '0', 10) || 0;
const pageOut = (rows, size = PAGE) => ({ more: rows.length > size, next: rows.length > size ? rows[size - 1].id : null, rows: rows.slice(0, size) });
const readJson = (v, dflt) => { try { return JSON.parse(v || 'null') ?? dflt; } catch (e) { return dflt; } };

// ---------------- home ----------------
// GET /admin/dashboard: the bot's home numbers, today's and this week's sales, and every panel's state for the pill
export async function dashboard(env, admin) {
  const now = nowSec();
  const c = await first(env, `SELECT (SELECT COUNT(*) FROM users WHERE email NOT LIKE 'deleted+%') users,
    (SELECT COUNT(*) FROM subscriptions WHERE state = 'active' AND (expires_at IS NULL OR expires_at > ?1)) active,
    (SELECT COUNT(*) FROM orders WHERE status = 'review') review,
    (SELECT COUNT(*) FROM orders WHERE status = 'review' AND method = 'coin' AND txid IS NOT NULL) coin,
    (SELECT COUNT(*) FROM sms_log WHERE result IN ('no_order', 'ambiguous', 'settle_failed') AND created_at > ?2) sms,
    (SELECT COUNT(*) FROM settings WHERE key LIKE 'panel_err_%' AND value != '') perr,
    (SELECT COUNT(*) FROM users WHERE created_at > ?2) new_week,
    (SELECT COALESCE(SUM(amount_toman), 0) FROM orders WHERE status = 'paid' AND paid_at > ?3 AND method != 'wallet') sales_today,
    (SELECT COALESCE(SUM(amount_toman), 0) FROM orders WHERE status = 'paid' AND paid_at > ?2 AND method != 'wallet') sales_week,
    (SELECT COUNT(*) FROM subscriptions WHERE state = 'active' AND expires_at > ?1 AND expires_at < ?4) ending`,
  now, now - 7 * 86400, now - 86400, now + 3 * 86400);
  const pans = admin.role === 'support' ? [] : await all(env, `SELECT p.id, p.label, p.state, p.rollout_percent, p.health,
    (SELECT value FROM settings WHERE key = 'panel_err_' || p.id) err FROM panels p ORDER BY p.id`);
  return json({ ...c, panels: pans.map((p) => ({ id: p.id, label: p.label, state: p.state, pct: p.rollout_percent, health: p.health, create_error: !!p.err })) });
}

// ---------------- orders ----------------
const ORDER_COLS = `o.id, o.user_id, o.kind, o.plan_id, o.activate_plan_id, o.amount_toman, o.list_price_toman, o.method, o.status, o.receipt_ref,
  o.coin, o.coin_amount, o.txid, o.created_at, o.paid_at, o.admin_note, (o.receipt_file_id IS NOT NULL) has_receipt,
  u.email, u.tg_id, u.tg_username, p.name plan_name, p.data_limit_gb, p.duration_days`;
const ORDER_FROM = 'orders o JOIN users u ON u.id = o.user_id LEFT JOIN plans p ON p.id = COALESCE(o.plan_id, o.activate_plan_id)';
const ORDER_OPEN = ['pending', 'review', 'expired', 'rejected'];
function orderOut(o) {
  return {
    id: o.id, user_id: o.user_id, user: userLabel(o), kind: o.activate_plan_id && o.kind !== 'plan' ? 'topup_plan' : o.kind, method: o.method, status: o.status,
    amount_toman: o.amount_toman, list_price_toman: o.list_price_toman || null,
    plan: o.plan_name ? { name: o.plan_name, gb: o.data_limit_gb, days: o.duration_days } : null,
    receipt_ref: o.receipt_ref || null, has_receipt: !!o.has_receipt, coin: o.coin || null, coin_amount: o.coin_amount || null,
    txid: o.txid || null, note: o.admin_note || null, created_at: o.created_at, paid_at: o.paid_at || null,
  };
}

// GET /admin/inbox: orders waiting for the admin (receipts, coin deposits found), oldest first
export async function inbox(env) {
  const rows = await all(env, `SELECT ${ORDER_COLS} FROM ${ORDER_FROM} WHERE o.status = 'review' ORDER BY o.created_at ASC LIMIT 50`);
  return json({ orders: rows.map(orderOut) });
}

const ORDER_ST = { rev: "o.status = 'review'", pend: "o.status = 'pending'", paid: "o.status = 'paid'", rej: "o.status IN ('rejected', 'cancelled')", all: '1 = 1' };
const METHODS = ['card', 'coin', 'wallet', 'crypto'];
// GET /admin/orders?status=&method=&q=&before=: newest first. q = #id, a number, or a receipt / transfer code.
export async function orders(env, url) {
  const st = ORDER_ST[url.searchParams.get('status')] ? url.searchParams.get('status') : 'all';
  const mt = METHODS.includes(url.searchParams.get('method')) ? url.searchParams.get('method') : '';
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
  const where = [ORDER_ST[st]];
  const args = [];
  if (mt) { where.push('o.method = ?'); args.push(mt); }
  if (q) {
    const id = /^#?\d{1,12}$/.test(q) ? parseInt(q.replace('#', ''), 10) : 0;
    where.push('(o.id = ? OR o.receipt_ref = ? OR o.txid = ?)'); args.push(id, q, q);
  }
  const sum = await first(env, `SELECT COUNT(*) n, COALESCE(SUM(o.amount_toman), 0) total FROM orders o WHERE ${where.join(' AND ')}`, ...args);
  const b = before(url);
  if (b) { where.push('o.id < ?'); args.push(b); }
  const rows = await all(env, `SELECT ${ORDER_COLS} FROM ${ORDER_FROM} WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT ${PAGE + 1}`, ...args);
  const pg = pageOut(rows);
  return json({ status: st, method: mt || 'all', count: sum.n, total: sum.total, more: pg.more, next: pg.next, orders: pg.rows.map(orderOut) });
}

// GET /admin/orders/:id: one order with what can be done to it now
export async function order(env, id) {
  const o = await first(env, `SELECT ${ORDER_COLS}, c.code coupon_code,
      (SELECT COUNT(*) FROM wallet_tx WHERE order_id = o.id AND reason = 'admin_refund') refunded
    FROM ${ORDER_FROM} LEFT JOIN coupons c ON c.id = o.coupon_id WHERE o.id = ?`, parseInt(id, 10));
  if (!o) throw err(404, 'not_found', 'Order not found.');
  const open = ORDER_OPEN.includes(o.status);
  return json({
    ...orderOut(o), coupon: o.coupon_code || null, refunded: !!o.refunded,
    can: {
      approve: open, reject: ['pending', 'review', 'expired'].includes(o.status), cancel: open,
      refund: o.status === 'paid' && o.kind !== 'topup' && o.amount_toman > 0 && !o.refunded,
    },
  });
}

// GET /admin/orders/:id/receipt: the receipt photo, fetched from Telegram (the bot stored only its file_id)
export async function receipt(env, orderId) {
  const o = await first(env, 'SELECT receipt_file_id FROM orders WHERE id = ?', parseInt(orderId, 10));
  if (!o || !o.receipt_file_id) throw err(404, 'no_receipt', 'This order has no receipt photo.');
  const { tg } = await import('./telegram.js');
  const f = await tg(env, 'getFile', { file_id: o.receipt_file_id });
  const path = f && f.ok && f.result && f.result.file_path;
  if (!path || !/^[\w./-]{1,200}$/.test(path)) throw err(502, 'telegram', 'Telegram did not return the photo.');
  const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`).catch(() => null);
  if (!r || !r.ok) throw err(502, 'telegram', 'Telegram did not return the photo.');
  const ext = path.split('.').pop().toLowerCase();
  const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' }[ext] || 'application/octet-stream';
  return new Response(r.body, { headers: { 'content-type': type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}

// ---------------- users ----------------
// GET /admin/users?q=&filter=&before=: newest first, 30 a page. q = #id, numeric Telegram id, @username or email part.
export async function users(env, url) {
  const { USER_FILTERS } = await import('./telegram-screens.js');
  const now = nowSec();
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 64);
  const filter = USER_FILTERS[url.searchParams.get('filter')] ? url.searchParams.get('filter') : 'all';
  const where = [USER_FILTERS[filter].where(now)];
  const args = [];
  if (q) {
    if (/^#?\d{1,20}$/.test(q)) { where.push('(id = ? OR tg_id = ?)'); args.push(parseInt(q.replace('#', ''), 10), q.replace('#', '')); }
    else if (q.startsWith('@')) { where.push('tg_username LIKE ?'); args.push(q.slice(1).toLowerCase().replace(/[%_]/g, '') + '%'); }
    else { where.push('(email LIKE ? OR tg_name LIKE ? OR tg_username LIKE ?)'); const like = '%' + q.toLowerCase().replace(/[%_]/g, '') + '%'; args.push(like, like, like); }
  }
  const counts = q ? null : await first(env, `SELECT ${Object.entries(USER_FILTERS).map(([k, f]) => `(SELECT COUNT(*) FROM users WHERE ${f.where(now)}) "${k}"`).join(', ')}`);
  const b = before(url);
  if (b > 0) { where.push('id < ?'); args.push(b); }
  const rows = await all(env, `SELECT u.id, u.email, u.tg_id, u.tg_username, u.tg_name, u.is_active, u.wallet_balance, u.created_at,
      s.state, s.expires_at, s.data_limit_bytes, s.used_bytes, s.period_id, (SELECT MAX(online_at) FROM usage_counters c WHERE c.period_id = s.period_id) seen
    FROM (SELECT * FROM users WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${PAGE + 1}) u
    LEFT JOIN subscriptions s ON s.user_id = u.id ORDER BY u.id DESC`, ...args);
  const pg = pageOut(rows);
  const { STORED_ONLINE_SEC } = await import('./telegram-screens.js');
  return json({
    filter, counts, more: pg.more, next: pg.next,
    users: pg.rows.map((u) => ({
      id: u.id, label: userLabel(u), name: u.tg_name || '', email: realEmail(u), blocked: !u.is_active && !isDeleted(u), deleted: isDeleted(u),
      wallet: u.wallet_balance, created_at: u.created_at, online: !!(u.seen && now - u.seen < STORED_ONLINE_SEC), last_seen: u.seen || null,
      sub: u.period_id ? {
        state: u.state, expires_at: u.expires_at, active: u.state === 'active' && (!u.expires_at || u.expires_at > now),
        limit_bytes: u.data_limit_bytes || 0, used_bytes: u.used_bytes || 0, days_left: u.expires_at ? Math.max(0, Math.ceil((u.expires_at - now) / 86400)) : null,
      } : null,
    })),
  });
}

// GET /admin/users/:id: everything the bot's user card shows
export async function user(env, id) {
  const uid = parseInt(id, 10);
  const u = await first(env, 'SELECT * FROM users WHERE id = ?', uid);
  if (!u) throw err(404, 'not_found', 'User not found.');
  const { subscriptionOut } = await import('./account.js');
  const [sub, devices, orders, tx, row] = await Promise.all([
    subscriptionOut(env, u, false),
    all(env, 'SELECT id, device_id, model, last_seen FROM devices WHERE user_id = ? ORDER BY last_seen DESC LIMIT 10', uid),
    all(env, `SELECT ${ORDER_COLS} FROM ${ORDER_FROM} WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 5`, uid),
    all(env, 'SELECT id, amount, balance_after, reason, note, created_at FROM wallet_tx WHERE user_id = ? ORDER BY id DESC LIMIT 5', uid),
    first(env, `SELECT s.state, s.stop_reason, s.plan_id, s.period_id, s.expires_at, s.data_limit_bytes, s.used_bytes, p.started_at,
        (SELECT MAX(online_at) FROM usage_counters c WHERE c.period_id = s.period_id) seen,
        (SELECT COUNT(*) FROM orders WHERE user_id = s.user_id) ords
      FROM subscriptions s LEFT JOIN sub_periods p ON p.id = s.period_id WHERE s.user_id = ?`, uid),
  ]);
  const { STORED_ONLINE_SEC } = await import('./telegram-screens.js');
  const now = nowSec();
  const seen = row && row.seen ? row.seen : null;
  const tgOnly = /@telegram\.local$/.test(String(u.email || ''));
  return json({
    id: u.id, label: userLabel(u), name: u.tg_name || '', email: realEmail(u), avatar: u.avatar || null,
    telegram: u.tg_id ? { id: String(u.tg_id), username: u.tg_username || null } : null,
    login: tgOnly ? 'telegram' : u.tg_id ? 'both' : 'email',
    blocked: !u.is_active && !isDeleted(u), deleted: isDeleted(u), wallet: u.wallet_balance, referral_code: u.referral_code,
    created_at: u.created_at, last_login_at: u.last_login_at || null,
    subscription: row && row.period_id ? {
      ...(sub || {}), sub_url: undefined, started_at: row.started_at || null, plan_id: row.plan_id || null,
      state: row.state, stop_reason: row.stop_reason || null, paused: row.state === 'stopped' && row.stop_reason === 'admin',
      expires_at: row.expires_at, limit_bytes: row.data_limit_bytes || 0, used_bytes: row.used_bytes || 0,
      active: row.state === 'active' && (!row.expires_at || row.expires_at > now),
    } : null,
    last_seen: seen, online: !!(seen && now - seen < STORED_ONLINE_SEC),
    devices: devices.map((d) => ({ id: d.id, device: String(d.device_id || '').slice(0, 64), model: d.model || '', last_seen: d.last_seen })),
    orders: orders.map(orderOut), order_count: row ? row.ords : orders.length,
    wallet_tx: tx,
  });
}

// GET /admin/users/:id/wallet?before=
export async function userWallet(env, id, url) {
  const uid = parseInt(id, 10);
  const u = await first(env, 'SELECT wallet_balance FROM users WHERE id = ?', uid);
  if (!u) throw err(404, 'not_found', 'User not found.');
  const b = before(url);
  const rows = await all(env, `SELECT id, amount, balance_after, reason, note, order_id, created_at FROM wallet_tx WHERE user_id = ?${b ? ' AND id < ?' : ''}
    ORDER BY id DESC LIMIT ${PAGE + 1}`, uid, ...(b ? [b] : []));
  const pg = pageOut(rows);
  return json({ balance: u.wallet_balance, more: pg.more, next: pg.next, tx: pg.rows });
}

// GET /admin/users/:id/orders?before=
export async function userOrders(env, id, url) {
  const uid = parseInt(id, 10);
  const b = before(url);
  const rows = await all(env, `SELECT ${ORDER_COLS} FROM ${ORDER_FROM} WHERE o.user_id = ?${b ? ' AND o.id < ?' : ''} ORDER BY o.id DESC LIMIT ${PAGE + 1}`, uid, ...(b ? [b] : []));
  const pg = pageOut(rows);
  return json({ more: pg.more, next: pg.next, orders: pg.rows.map(orderOut) });
}

// GET /admin/users/:id/nets: the networks this user connected from (30 days) and how each of their servers did there
export async function userNets(env, id) {
  const uid = parseInt(id, 10);
  const since = nowSec() - 30 * 86400;
  const nets = await all(env, 'SELECT asn, kind, isp, geo, first_at, last_at, reports FROM user_net WHERE user_id = ? AND last_at >= ? ORDER BY last_at DESC LIMIT 6', uid, since);
  if (!nets.length) return json({ nets: [] });
  const srv = await all(env, 'SELECT asn, kind, skey, ok, fail, ms_sum, ms_n, kb_sum, kb_n, tests FROM user_net_srv WHERE user_id = ? AND at >= ?', uid, since);
  const kr = await first(env, 'SELECT keys FROM user_skeys WHERE user_id = ?', uid);
  const names = readJson(kr && kr.keys, {});
  return json({
    nets: nets.map((n) => {
      const list = srv.filter((s) => s.asn === n.asn && s.kind === n.kind).map((s) => ({
        name: names[s.skey] || 'Removed server', tests: s.tests,
        ok_pct: s.ok + s.fail > 0 ? Math.round((s.ok / (s.ok + s.fail)) * 100) : null,
        ms: s.ms_n ? Math.round(s.ms_sum / s.ms_n) : null, mbps: s.kb_n ? Math.round(s.kb_sum / s.kb_n / 100) / 10 : null,
      })).sort((a, z) => (z.ok_pct ?? 50) - (a.ok_pct ?? 50) || (a.ms || 9e9) - (z.ms || 9e9));
      return { isp: n.isp || `AS${n.asn}`, asn: n.asn, kind: n.kind || '', first_at: n.first_at, last_at: n.last_at, reports: n.reports, servers: list.slice(0, 12) };
    }),
  });
}

// ---------------- plans ----------------
// GET /admin/plans: every plan in the app's order, the archived ones last, with sales
export async function plans(env) {
  const rows = await all(env, `SELECT p.*, (SELECT COUNT(*) FROM orders WHERE status = 'paid' AND (plan_id = p.id OR activate_plan_id = p.id)) sold,
      (SELECT COALESCE(SUM(amount_toman), 0) FROM orders WHERE status = 'paid' AND kind = 'plan' AND plan_id = p.id) income
    FROM plans p ORDER BY COALESCE(p.archived, 0), p.sort, p.id`);
  return json({
    plans: rows.map((p) => ({
      id: p.id, name: p.name, price: p.price_toman, old_price: p.old_price_toman || 0, days: p.duration_days, gb: p.data_limit_gb || 0,
      devices: p.device_limit || 0, trial_days: p.trial_days || 0, badge: p.badge || '', description: p.description || '',
      sort: p.sort, on: !!p.is_active, archived: !!p.archived, sold: p.sold, income: p.income,
      // the names stay as the plan has them; the page also keeps the old shape (duration_days, ...) for the grant list
      duration_days: p.duration_days, data_limit_gb: p.data_limit_gb || 0, price_toman: p.price_toman, is_active: p.is_active,
    })),
  });
}

// ---------------- coupons, referral ----------------
export async function coupons(env, url) {
  const b = before(url);
  const rows = await all(env, `SELECT c.*, p.name plan_name, (SELECT COUNT(*) FROM orders WHERE coupon_id = c.id AND status = 'paid') paid
    FROM coupons c LEFT JOIN plans p ON p.id = c.plan_id${b ? ' WHERE c.id < ?' : ''} ORDER BY c.id DESC LIMIT ${PAGE + 1}`, ...(b ? [b] : []));
  const pg = pageOut(rows);
  return json({
    more: pg.more, next: pg.next,
    coupons: pg.rows.map((c) => ({ id: c.id, code: c.code, percent: c.percent, used: c.used, max_uses: c.max_uses || 0, expires_at: c.expires_at || null,
      plan_id: c.plan_id || null, plan: c.plan_name || null, on: !!c.is_active, paid: c.paid, created_at: c.created_at })),
  });
}

export async function couponUses(env, id) {
  const rows = await all(env, `SELECT cu.id, cu.user_id, cu.order_id, cu.created_at, u.email, u.tg_id, u.tg_username FROM coupon_uses cu
    LEFT JOIN users u ON u.id = cu.user_id WHERE cu.coupon_id = ? ORDER BY cu.id DESC LIMIT 50`, parseInt(id, 10));
  return json({ uses: rows.map((r) => ({ id: r.id, user_id: r.user_id, user: r.email ? userLabel(r) : '#' + r.user_id, order_id: r.order_id, created_at: r.created_at })) });
}

export async function referral(env) {
  const s = await getSettings(env);
  const top = await all(env, `SELECT r.referred_by_id id, COUNT(*) n, u.email, u.tg_id, u.tg_username,
      (SELECT COALESCE(SUM(amount), 0) FROM wallet_tx WHERE user_id = r.referred_by_id AND reason = 'referral') earned
    FROM users r JOIN users u ON u.id = r.referred_by_id WHERE r.referred_by_id IS NOT NULL GROUP BY r.referred_by_id ORDER BY n DESC LIMIT 10`);
  return json({ percent: parseInt(s.referral_percent || '0', 10) || 0, top: top.map((t) => ({ user_id: t.id, user: userLabel(t), invited: t.n, earned: t.earned })) });
}

// ---------------- payments ----------------
// GET /admin/payments: card, SMS auto-confirm, coins and the payment settings. Addresses and the card number are
// shown in full to the owner only (the bot shows the viewer the same summary, never the setting values).
export async function payments(env, admin) {
  const s = await getSettings(env);
  const owner = admin.role === 'owner';
  const { COINS, walletKey, memoKey } = await import('./coins.js');
  const card = String(s.card_number || '');
  const { usdRateInfo } = await import('./usdrate.js');
  let ri = null;
  try { ri = await usdRateInfo(env); } catch (e) { ri = null; }
  return json({
    card: { number: owner ? card : card ? '•••• ' + card.slice(-4) : '', holder: s.card_holder || '', bank: s.card_bank || '' },
    card_auto: s.card_auto, coin_auto: s.coin_auto,
    senders: owner ? String(s.sms_senders || '').split(',').filter(Boolean) : [],
    sender_count: String(s.sms_senders || '').split(',').filter(Boolean).length,
    sms_ready: !!s.sms_key,
    coins: COINS.map((c) => {
      const addr = String(s[walletKey(c)] || '').trim();
      return { id: c.id, symbol: c.symbol, name: c.name, network: c.network, memo_label: c.memo || null, on: !!addr,
        address: owner ? addr : '', memo: owner && c.memo ? String(s[memoKey(c)] || '') : '' };
    }),
    settings: { usd_rate_toman: parseInt(s.usd_rate_toman || '0', 10) || 0, coin_minutes: parseInt(s.coin_minutes || '30', 10), min_topup_toman: parseInt(s.min_topup_toman || '0', 10),
      card_unique: s.card_unique !== '0' },
    rate: ri && ri.rate ? { toman: ri.rate, from: ri.from } : null,
  });
}

// GET /admin/sms/setup (owner): what the SMS forwarder app needs. The key is made the first time, like /sms.
export async function smsSetup(env) {
  const { smsKey } = await import('./sms.js');
  const k = await smsKey(env);
  const base = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return json({ url: `${base}/sms`, header: { 'X-SMS-Key': k }, url_with_key: `${base}/sms/${k}` });
}

// GET /admin/rate (owner): the dollar price from every exchange, asked again now
export async function rate(env) {
  const { usdRateInfo } = await import('./usdrate.js');
  const ri = await usdRateInfo(env, { force: true });
  return json({ toman: ri.rate || 0, from: ri.from, sources: (ri.sources || []).map((x) => ({ name: x.name, toman: x.rate || 0, used: (ri.used || []).includes(x.id), error: x.error || null })) });
}

const SMS_UNMATCHED = "result IN ('no_order', 'ambiguous', 'settle_failed')";
// GET /admin/sms?filter=un&before=: what was read from each bank SMS (never the SMS text itself)
export async function smsLog(env, url) {
  const un = url.searchParams.get('filter') === 'un';
  const b = before(url);
  const where = [un ? SMS_UNMATCHED : '1 = 1', ...(b ? ['id < ?'] : [])];
  const rows = await all(env, `SELECT id, sender, amount_rial, order_id, result, created_at FROM sms_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${PAGE + 1}`, ...(b ? [b] : []));
  const pg = pageOut(rows);
  return json({ more: pg.more, next: pg.next, sms: pg.rows.map((r) => ({ id: r.id, sender: String(r.sender || '').slice(0, 24), toman: r.amount_rial ? Math.round(r.amount_rial / 10) : 0, order_id: r.order_id, result: r.result, created_at: r.created_at })) });
}

// ---------------- settings (owner) ----------------
export async function settings(env) {
  const s = await getSettings(env);
  const { SECRET_SETTINGS } = await import('./telegram.js');
  const { splitAppList, maskBridge } = await import('./admin-actions.js');
  return json({
    settings: Object.keys(SETTING_DEFAULTS).map((k) => {
      const v = String(s[k] ?? '');
      const value = k === 'app_bridges' ? splitAppList(v).map(maskBridge).join('\n') : SECRET_SETTINGS.has(k) && v ? '•••' : v;
      return { key: k, value, secret: SECRET_SETTINGS.has(k), list: k === 'app_api_bases' || k === 'app_bridges' };
    }),
  });
}

// ---------------- panels ----------------
async function panelTestOf(env, id) {
  return readJson((await first(env, 'SELECT value FROM settings WHERE key = ?', `panel_test_${id}`))?.value, null);
}
export async function panels(env) {
  const rows = await all(env, `SELECT p.*, (SELECT COUNT(*) FROM panel_accounts a WHERE a.panel_id = p.id AND a.desired = 'active') accounts,
    (SELECT value FROM settings WHERE key = 'panel_err_' || p.id) err FROM panels p ORDER BY p.id`);
  return json({ panels: rows.map((p) => ({ id: p.id, label: p.label, kind: p.kind, state: p.state, pct: p.rollout_percent, health: p.health,
    version: p.version || null, accounts: p.accounts, create_error: readJson(p.err, null) && readJson(p.err, null).msg ? String(readJson(p.err, null).msg).slice(0, 160) : null })) });
}

export async function panel(env, id) {
  const { getPanel, credSource, options } = await import('./panels.js');
  const p = await getPanel(env, parseInt(id, 10));
  if (!p) throw err(404, 'not_found', 'Panel not found.');
  const { panelProgress, createError } = await import('./sync.js');
  const [accounts, test, progress, ce, cred] = await Promise.all([
    first(env, "SELECT COUNT(*) c FROM panel_accounts WHERE panel_id = ? AND desired = 'active'", p.id),
    panelTestOf(env, p.id),
    ['active', 'rollout'].includes(p.state) ? panelProgress(env, p) : Promise.resolve(null),
    createError(env, p.id),
    credSource(env, p),
  ]);
  return json({
    id: p.id, label: p.label, kind: p.kind, state: p.state, pct: p.rollout_percent, health: p.health, version: p.version || null,
    accounts: accounts.c, test, progress, create_error: ce && ce.msg ? String(ce.msg).slice(0, 200) : null,
    cred: cred || null, cred_fixed: p.cred_ref === 'PASARGUARD', groups: (options(p).group_ids || []),
  });
}

// GET /admin/panels/:id/servers: names, types and countries only; never an address, a port or a link
export async function panelServerList(env, id) {
  const { getPanel, panelServers, overridesFor } = await import('./panels.js');
  const p = await getPanel(env, parseInt(id, 10));
  if (!p) throw err(404, 'not_found', 'Panel not found.');
  const ov = await overridesFor(env, [p.id]);
  const labels = ov.labels[p.id] || {};
  const { servers, source } = await panelServers(env, p);
  const known = new Set(servers.map((s) => s.key));
  const extra = [...new Set([...Object.keys(labels), ...[...ov.hidden].filter((h) => h.startsWith(p.id + ':')).map((h) => h.split(':')[1])])].filter((k) => !known.has(k));
  const out = (key, name, type, cc, gone) => ({ key, name, type: type || null, cc: cc || null, label: labels[key] || null, hidden: ov.hidden.has(p.id + ':' + key), gone: !!gone });
  return json({ source, servers: [...servers.slice(0, 60).map((s) => out(s.key, s.name, s.type, s.cc)), ...extra.slice(0, 20).map((k) => out(k, 'Old server', null, null, true))] });
}

// POST /admin/panels {label, kind?}: a new panel; it takes nobody until it is tested and rolled out
export async function addPanel(env, admin, body) {
  const { KINDS, addPanel: add } = await import('./panels.js');
  const label = String((body && body.label) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const kind = KINDS.includes(String(body && body.kind)) ? String(body.kind) : 'auto';
  if (!label) throw err(400, 'label', 'Give the panel a name.');
  const p = await add(env, kind, label);
  await auditRow(env, admin, 'panel.add', 'panel', p.id, `${kind} ${label}`);
  return json({ ok: true, id: p.id });
}

// POST /admin/panels/:id/cred {url, username, password}: stored encrypted, never echoed back, then tested
export async function panelCred(env, admin, id, body) {
  const { getPanel, parseCred, savePanelCred, testPanel } = await import('./panels.js');
  const p = await getPanel(env, parseInt(id, 10));
  if (!p) throw err(404, 'not_found', 'Panel not found.');
  if (p.cred_ref === 'PASARGUARD') throw err(400, 'fixed', "Panel 1's login comes from the PASARGUARD_* secrets and is not changed here.");
  const url = String((body && body.url) || '').trim(), username = String((body && body.username) || '').trim(), password = String((body && body.password) || '');
  if (!url || !username || !password || /\s/.test(url) || /\s/.test(username) || password.length > 200) throw err(400, 'parts', 'Give the panel address, the admin username and the password.');
  const { cred, error } = parseCred(`${url} ${username} ${password}`);
  if (error) throw err(400, error, { url: 'The panel address is not right.', http: 'The panel address must be https (with http the password crosses the network in clear text).' }[error] || 'Give the panel address, the admin username and the password.');
  await savePanelCred(env, p, cred);
  await auditRow(env, admin, 'panel.cred', 'panel', p.id, 'panel login changed');
  const t = await testPanel(env, p);
  await auditRow(env, admin, 'panel.test', 'panel', p.id, t.healthy ? 'healthy' : 'unhealthy');
  return json({ ok: true, test: testOut(t) });
}

// POST /admin/panels/:id/test: log in, create and delete a throw-away user, read its configs
export async function panelTest(env, admin, id) {
  const { getPanel, testPanel } = await import('./panels.js');
  const p = await getPanel(env, parseInt(id, 10));
  if (!p) throw err(404, 'not_found', 'Panel not found.');
  const t = await testPanel(env, p);
  await auditRow(env, admin, 'panel.test', 'panel', p.id, t.healthy ? 'healthy' : 'unhealthy');
  return json({ ok: true, test: testOut(t) });
}
const testOut = (t) => ({ healthy: !!t.healthy, configs: t.configs || 0, version: t.version || null, kind: t.kind || null, kind_changed: !!t.kindChanged,
  same_host: t.sameHost ?? null, kinds: t.kinds ? t.kinds.counts : null, unusable: t.kinds ? t.kinds.unusable || 0 : 0,
  error: t.error ? String(t.error).slice(0, 200) : null, needs_service: t.kind === 'rebecca' && !t.create });

async function auditRow(env, admin, action, type, id, summary) {
  const { insert } = await import('./db.js');
  await insert(env, 'admin_audit', { admin_id: admin.tgId, action, target_type: type, target_id: String(id), summary: String(summary).slice(0, 300), undo_json: null, created_at: nowSec() });
}

// ---------------- Pleat app ----------------
export async function app(env) {
  const s = await getSettings(env);
  const { splitAppList, maskBridge, itemTag } = await import('./admin-actions.js');
  const trials = await all(env, 'SELECT id, name, trial_days FROM plans WHERE trial_days > 0 AND is_active = 1 AND archived = 0 ORDER BY sort, id LIMIT 6');
  const u = await import('./appupdate.js');
  const [latest, cur] = await Promise.all([u.latestBuild(env).catch(() => null), u.announced(env, s)]);
  const brief = (r) => (r ? { version: r.version, build: r.build, tag: r.tag, force: !!r.force, at: r.at || r.built_at || null } : null);
  return json({
    announcement: s.announcement || '', support_url: s.support_url || '',
    domains: splitAppList(s.app_api_bases).map((v) => ({ value: v, tag: itemTag(v) })),
    bridges: splitAppList(s.app_bridges).map((v) => ({ value: maskBridge(v), tag: itemTag(v) })),
    trial: { gb: parseInt(s.trial_data_gb || '0', 10) || 0, telegram_only: String(s.trial_needs_telegram ?? '1') !== '0', plans: trials },
    min_topup_toman: parseInt(s.min_topup_toman || '0', 10), referral_percent: parseInt(s.referral_percent || '0', 10) || 0,
    release: { token: !!env.PLEAT_DL_TOKEN, latest: brief(latest), announced: brief(cur), fresh: !!(latest && (!cur || latest.tag !== cur.tag)) },
  });
}

// GET /admin/app/domains/test: each extra domain's /health from Cloudflare (not from Iran), in parallel
export async function domainTest(env) {
  const { splitAppList } = await import('./admin-actions.js');
  const { checkHealth } = await import('./telegram-menu.js');
  const list = splitAppList((await getSettings(env)).app_api_bases).slice(0, 8);
  const res = await Promise.all(list.map((base) => checkHealth(base)));
  const why = (w) => ({ 'جواب ورکر نیست': 'not this Worker', 'بیش از ۵ ثانیه': 'over 5 seconds', 'وصل نشد': 'no connection' }[w] || w);
  return json({ results: res.map((r, i) => ({ domain: list[i], ok: r.ok, ms: r.ms || null, why: r.ok ? null : why(r.why) })) });
}

// ---------------- network ----------------
export async function net(env) {
  const { carrierSummary, googleSummary } = await import('./netstats.js');
  const [nets, g] = await Promise.all([carrierSummary(env), googleSummary(env)]);
  const srv = (s) => ({ key: s.k, name: s.name, ok_pct: s.ok, ms: s.ms || null, mbps: s.kbps ? Math.round(s.kbps / 100) / 10 : null, users: s.users });
  return json({
    carriers: nets.slice(0, 12).map((n) => ({ asn: n.asn, isp: n.isp, tests: n.tests, servers: n.servers.slice(0, 20).map(srv) })),
    google: g.slice(0, 40).map((r) => ({ key: r.k, name: r.name, status: r.status, cc: r.google_cc || null, tests: r.tests })),
  });
}

export async function netUsers(env) {
  const since = nowSec() - 7 * 86400;
  const groups = await all(env, `SELECT asn, kind, MAX(isp) isp, COUNT(DISTINCT user_id) u FROM user_net WHERE last_at >= ?
    GROUP BY asn, kind ORDER BY u DESC LIMIT 12`, since);
  const recent = await all(env, `SELECT n.user_id id, u.email, u.tg_id, u.tg_username, MAX(n.last_at) at FROM user_net n JOIN users u ON u.id = n.user_id
    WHERE n.last_at >= ? GROUP BY n.user_id ORDER BY at DESC, n.user_id DESC LIMIT 12`, since);
  return json({ groups: groups.map((g) => ({ asn: g.asn, kind: g.kind || '', isp: g.isp || `AS${g.asn}`, users: g.u })),
    recent: recent.map((r) => ({ id: r.id, user: userLabel(r), at: r.at })) });
}

// ---------------- stats ----------------
export async function stats(env, url) {
  const days = [1, 7, 30].includes(parseInt(url.searchParams.get('days'), 10)) ? parseInt(url.searchParams.get('days'), 10) : 7;
  const now = nowSec(), since = now - days * 86400;
  const c = await first(env, `SELECT
    (SELECT COUNT(*) FROM orders WHERE status = 'paid' AND paid_at > ?1) sales,
    (SELECT COALESCE(SUM(amount_toman), 0) FROM orders WHERE status = 'paid' AND paid_at > ?1 AND method != 'wallet') toman,
    (SELECT COUNT(*) FROM users WHERE created_at > ?1) signups,
    (SELECT COUNT(*) FROM sub_periods WHERE end_reason = 'renewed' AND ended_at > ?1) renewals,
    (SELECT COUNT(*) FROM subscriptions WHERE expires_at > ?2 OR expires_at IS NULL) active,
    (SELECT COALESCE(SUM(used_bytes), 0) FROM subscriptions WHERE expires_at > ?2 OR expires_at IS NULL) used`, since, now);
  const methods = await all(env, `SELECT method, COUNT(*) n, COALESCE(SUM(amount_toman), 0) t FROM orders WHERE status = 'paid' AND paid_at > ?
    GROUP BY method ORDER BY t DESC`, since);
  const top = await all(env, `SELECT o.plan_id, p.name, COUNT(*) n, COALESCE(SUM(o.amount_toman), 0) t FROM orders o LEFT JOIN plans p ON p.id = o.plan_id
    WHERE o.status = 'paid' AND o.paid_at > ? AND o.kind = 'plan' GROUP BY o.plan_id ORDER BY n DESC, t DESC LIMIT 5`, since);
  // one bar per day: money received (wallet purchases left out; that money came in at the top-up)
  const daily = await all(env, `SELECT CAST((paid_at - ?1) / 86400 AS INTEGER) d, COALESCE(SUM(amount_toman), 0) t, COUNT(*) n FROM orders
    WHERE status = 'paid' AND paid_at > ?1 AND method != 'wallet' GROUP BY d`, since);
  const bars = Array.from({ length: days }, (_, i) => { const r = daily.find((x) => x.d === i); return { day: since + i * 86400, toman: r ? r.t : 0, orders: r ? r.n : 0 }; });
  return json({ days, ...c, methods: methods.map((m) => ({ method: m.method, orders: m.n, toman: m.t })), top: top.map((p) => ({ plan_id: p.plan_id, name: p.name || '#' + p.plan_id, orders: p.n, toman: p.t })), bars });
}

// ---------------- broadcasts ----------------
export async function broadcasts(env) {
  const { AUDIENCES, audienceCount } = await import('./admin-actions.js');
  const rows = await all(env, 'SELECT id, audience, status, sent, failed, blocked, created_at, substr(text, 1, 120) preview FROM broadcasts ORDER BY id DESC LIMIT 20');
  const audiences = {};
  for (const k of Object.keys(AUDIENCES)) audiences[k] = await audienceCount(env, k);
  return json({ audiences, broadcasts: rows });
}

export async function broadcast(env, id) {
  const { audienceCount } = await import('./admin-actions.js');
  const r = await first(env, 'SELECT * FROM broadcasts WHERE id = ?', parseInt(id, 10));
  if (!r) throw err(404, 'not_found', 'Broadcast not found.');
  const total = r.status === 'draft' || r.status === 'sending' ? await audienceCount(env, r.audience) : null;
  return json({ id: r.id, audience: r.audience, status: r.status, text: r.text, sent: r.sent, failed: r.failed, blocked: r.blocked, created_at: r.created_at, audience_now: total });
}

// ---------------- system ----------------
export async function health(env) {
  const { tg } = await import('./telegram.js');
  const now = nowSec();
  const w = (await tg(env, 'getWebhookInfo', {})) || null;
  const info = w && w.ok ? w.result || {} : null;
  const base = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const c = await first(env, `SELECT (SELECT COUNT(*) FROM panel_accounts WHERE dirty = 1) dirty,
    (SELECT COUNT(*) FROM panel_accounts WHERE dirty = 1 AND attempts >= 3) stuck,
    (SELECT COUNT(*) FROM panel_accounts WHERE last_error IS NOT NULL AND last_error != '') errs,
    (SELECT COUNT(*) FROM settings WHERE key LIKE 'panel_err_%' AND value != '') perr,
    (SELECT COUNT(*) FROM broadcasts WHERE status = 'sending') bc`);
  const jobs = await all(env, 'SELECT job, panel_id, run_at FROM sync_cursor ORDER BY run_at DESC LIMIT 6');
  // Telegram's error text can carry the webhook address: anything that looks like a link is cut out
  const errMsg = info && info.last_error_message ? String(info.last_error_message).replace(/\S*:\/\/\S*/g, '[address]').replace(/\b[\w-]+(\.[\w-]+)+(:\d+)?\S*/g, '[address]').slice(0, 150) : null;
  return json({
    webhook: !info ? { state: 'no_answer' } : { state: !info.url ? 'missing' : info.url === base + '/tg' ? 'ok' : 'other', pending: info.pending_update_count || 0,
      last_error_at: info.last_error_date || null, last_error: errMsg },
    sync: { last_run: jobs.length ? jobs[0].run_at : null, late: !!(jobs.length && now - jobs[0].run_at > 300), jobs },
    queue: { dirty: c.dirty, stuck: c.stuck, account_errors: c.errs, panel_errors: c.perr }, broadcasts_sending: c.bc,
  });
}

export async function admins(env) {
  const rows = await all(env, 'SELECT tg_id, role, added_at FROM admins ORDER BY added_at, tg_id LIMIT 20');
  return json({ owner: String(env.TELEGRAM_CHAT_ID || ''), admins: rows.map((r) => ({ tg_id: String(r.tg_id), role: r.role, added_at: r.added_at })) });
}

// GET /admin/audit?before=&type=&id=: the admin log, newest first; undo is offered on what may still be undone
export async function audit(env, url) {
  const { canUndo } = await import('./admin-actions.js');
  const type = String(url.searchParams.get('type') || '');
  const id = String(url.searchParams.get('id') || '');
  const where = [], args = [];
  if (type && /^[a-z]{2,12}$/.test(type) && /^[\w.@-]{1,60}$/.test(id)) { where.push('target_type = ? AND target_id = ?'); args.push(type, id); }
  const b = before(url);
  if (b) { where.push('id < ?'); args.push(b); }
  const rows = await all(env, `SELECT * FROM admin_audit${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${PAGE + 1}`, ...args);
  const pg = pageOut(rows);
  const now = nowSec();
  return json({ owner: String(env.TELEGRAM_CHAT_ID || ''), more: pg.more, next: pg.next,
    log: pg.rows.map((r) => ({ id: r.id, at: r.created_at, admin: String(r.admin_id || ''), action: r.action, target_type: r.target_type, target_id: r.target_id,
      summary: r.summary, undone: !!r.undone_at, can_undo: canUndo(r, now) })) });
}

// POST /admin/backup (owner): the same file the daily backup sends, to the owner's Telegram chat
export async function backup(env, admin) {
  const { sendBackup } = await import('./telegram.js');
  await sendBackup(env, admin.tgId);
  await auditRow(env, admin, 'system.backup', 'setting', 'backup', 'backup sent to Telegram');
  return json({ ok: true });
}

// ---------------- writes ----------------
// POST /admin/action {name, args, confirm}: one admin action, exactly as the bot runs it
export async function action(env, admin, body) {
  const { ACTIONS, runAction } = await import('./admin-actions.js');
  const name = String((body && body.name) || '');
  const def = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
  if (!def) throw err(404, 'unknown_action', 'There is no such action.');
  if ((def.risk === 'money' || def.risk === 'destructive') && body.confirm !== true) throw err(409, 'confirm', 'This action needs a confirmation.');
  const args = body && body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
  let r;
  try { r = await runAction(env, admin.tgId, name, args); } catch (e) {
    // a panel that refused (grant, link) throws; the bot shows the panel's own words, so does the page
    return json({ ok: false, error: String((e && e.message) || 'failed').slice(0, 300) }, 422);
  }
  if (r.ok === false) return json({ ok: false, error: String(r.error || 'انجام نشد.') }, 422);
  return json({ ok: true, text: stripMarkup(r.text || r.summary || ''), audit_id: r.auditId || null, undoable: !!r.undoable, target_id: r.targetId ?? null });
}

// POST /admin/undo {audit_id}
export async function undo(env, admin, body) {
  const { undoAction } = await import('./admin-actions.js');
  const r = await undoAction(env, admin.tgId, parseInt(body && body.audit_id, 10));
  if (r.ok === false) return json({ ok: false, error: String(r.error || 'برگشت ممکن نشد.') }, 422);
  return json({ ok: true, text: stripMarkup(r.text) });
}

// POST /admin/users {email, password} (owner): a manual account; the password is hashed here and never stored plain
export async function createUser(env, admin, body) {
  const pass = String((body && body.password) || '');
  if (pass.length < 8 || pass.length > 128) throw err(400, 'password', 'The password must be 8 to 128 characters.');
  const { hashPassword } = await import('./util.js');
  return action(env, admin, { name: 'user.create', args: { email: String((body && body.email) || ''), hash: await hashPassword(pass, env.SECRET_KEY) } });
}

// POST /admin/users/:id/password {password, confirm} (owner): a new password; the user's other phones are signed out
export async function setPassword(env, admin, id, body) {
  const u = await first(env, 'SELECT email FROM users WHERE id = ?', parseInt(id, 10));
  if (!u || !realEmail(u)) throw err(400, 'no_email', 'This account signs in with Telegram only; it has no password to change.');
  return action(env, admin, { name: 'user.reset_password', args: { email: u.email, pass: String((body && body.password) || '') }, confirm: body && body.confirm === true });
}

// bot texts may carry «button» marks and /commands; the page shows plain text
const stripMarkup = (t) => String(t || '').replace(/<[^>]+>/g, '').slice(0, 600);

// GET /admin/users/:id/panels: the user's account on every panel, read live (same as the bot's "🗂 پنل‌های کاربر").
// Nothing is written; per panel: state, usage, its cap, created/expiry, last connection and "online now".
export async function userPanels(env, id) {
  const uid = parseInt(id, 10);
  const { accountsOf, adapterFor, userPathMs } = await import('./panels.js');
  const { parseExpire } = await import('./pasarguard.js');
  const { ONLINE_SEC, STORED_ONLINE_SEC } = await import('./telegram-screens.js');
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
      return { ...base, state: 'no_answer', last_seen: (c && c.online_at) || null, online: !!(c && c.online_at && now - c.online_at < STORED_ONLINE_SEC) };
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

export { GB };
