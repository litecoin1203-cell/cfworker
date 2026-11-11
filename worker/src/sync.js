// Usage ledger, quota/expiry decisions and enforcement across panels, plus the chunked sync job.
//
// Usage of a user = sum over panels of usage_counters.accounted_bytes for the current period. A counter only
// grows: a panel-side reset is detected (reading below the last one) and added on top, and a panel that does
// not answer keeps its last value (stale) instead of counting as zero.
//
// Deciding and doing are separate: evaluate() only writes what each panel account should be (desired, dirty);
// pushPending() pushes that to the panel and is safe to repeat, so a stop that failed on a broken panel is
// simply tried again on the next run until the panel confirms it.
//
// The Free plan gives a cron run 10 ms of CPU, 50 subrequests and 50 D1 queries, so runSync() does a bounded slice
// per run (one page of one panel's users, a few pending pushes and a few missing accounts) with a fixed number of
// queries however many users the page holds.
import { first, all, run } from './db.js';
import { nowSec, logError } from './util.js';
import { PasarGuardError, parseExpire } from './pasarguard.js';
import { adapterFor, listPanels, panelsFor, pickPanels, recordHealth, accountsOf, groupIdsFor, USER_PATH_MS, userPathMs } from './panels.js';

export const PAGE = 200;            // users read per panel request
const PUSH_PER_RUN = 15;            // pending panel writes per cron run
const CREATE_PER_RUN = 8;           // missing panel accounts created per cron run (fewer when pushes used the budget)
const SUBREQ_BUDGET = 44;           // of the 50 a Free-plan run may make; a create costs up to about 4
const ERR_NOTIFY_EVERY = 6 * 3600;  // the admin hears about one panel refusing new accounts at most this often
const QUIET_AFTER_ERROR = 600;      // after a refused create, the app does not wait on that panel for 10 minutes
const MB = 1024 * 1024;
// The cron's usage writes for an account that keeps moving (the phone keeps the VPN on all day, so a few KB of
// background traffic change the panel's counter every minute) are spread out: such an account is written when
// its last write is LEDGER_EVERY old, when LEDGER_BIG bytes piled up, when it comes close to the end of its data,
// or when it comes online after a break. Each panel still stops the account at its own data_limit, so a skipped
// minute is only counted a few minutes later, never lost: the next write adds everything since the stored reading.
export const LEDGER_EVERY = 600;
const LEDGER_BIG = 256 * MB;
const ONLINE_FRESH = 120;           // the panel's online_at this recent = the account is online now

// how far a panel's own data_limit may drift from the ideal before it is rewritten (fewer panel writes)
export const tolerance = (limit) => Math.max(Math.floor(limit / 20), 64 * MB);

// ---------------- ledger ----------------
// A Free-plan invocation may send D1 at most 50 queries (a batch counts as one), so the ledger works on sets:
// one read for all the accounts of a page, one batch for every write, and a row is only written when it changes
// (an idle user costs no write at all, which also keeps the daily write allowance for real work).
const st = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const LEDGER_SQL = `SELECT a.id, a.user_id, a.panel_id, a.remote_username, s.id AS sub_id, s.period_id, s.baselined,
    s.data_limit_bytes AS s_limit, s.used_bytes AS s_used,
    c.period_id AS c_period, c.last_remote_bytes, c.baseline_pending, c.stale, c.last_seen_at AS c_seen, c.online_at AS c_online
  FROM panel_accounts a JOIN subscriptions s ON s.user_id = a.user_id AND s.period_id IS NOT NULL
  LEFT JOIN usage_counters c ON c.period_id = s.period_id AND c.panel_id = a.panel_id`;

// The writes for readings of accounts (rows from LEDGER_SQL). readingOf(row) = {used, expire, data_limit}, null
// when the panel did not answer, or undefined to leave the row alone. Returns the statements to batch.
// spread = the cron's sweep: small changes of an account that was written recently wait (see LEDGER_EVERY).
// The app and the bot's live card read with spread off, so what they show is exact.
function ledgerWrites(env, rows, readingOf, now, { spread = false } = {}) {
  const out = [];
  for (const r of rows) {
    const remote = readingOf(r);
    if (remote === undefined) continue;
    if (!remote) {
      // the account stays counted at its last reading
      if (r.c_period != null && !r.stale) out.push(st(env, 'UPDATE usage_counters SET stale = 1 WHERE period_id = ? AND panel_id = ?', r.period_id, r.panel_id));
      continue;
    }
    const used = Math.max(0, remote.used || 0);
    // the panel's last-connection time rides along on a write that happens anyway (usage moved): no extra D1 writes
    const online = remote.online || null;
    if (r.c_period == null) {
      // first reading in this period: everything on this account belongs to it (new account, or the
      // subscription that existed before the control plane)
      out.push(st(env, `INSERT OR IGNORE INTO usage_counters (period_id, panel_id, last_remote_bytes, accounted_bytes, last_seen_at, online_at)
        VALUES (?, ?, ?, ?, ?, ?)`, r.period_id, r.panel_id, used, used, now, online));
    } else if (r.baseline_pending) {
      out.push(st(env, 'UPDATE usage_counters SET last_remote_bytes = ?, baseline_pending = 0, stale = 0, last_seen_at = ?, online_at = COALESCE(?, online_at) WHERE period_id = ? AND panel_id = ?',
        used, now, online, r.period_id, r.panel_id));
    } else if (used !== r.last_remote_bytes || r.stale) {
      // below the last reading = the panel's counter was reset; what it shows now is all new. The update is
      // relative to the stored reading, so a reading another invocation already counted is not counted twice.
      const delta = used >= r.last_remote_bytes ? used - r.last_remote_bytes : used;
      // (a panel-side reset is always written at once: it is detected against the stored reading)
      if (spread && !r.stale && used >= r.last_remote_bytes && canWait(r, delta, online, now)) continue;
      out.push(st(env, `UPDATE usage_counters SET accounted_bytes = accounted_bytes + ?, last_remote_bytes = ?, stale = 0, last_seen_at = ?, online_at = COALESCE(?, online_at)
        WHERE period_id = ? AND panel_id = ? AND last_remote_bytes = ? AND baseline_pending = 0`, delta, used, now, online, r.period_id, r.panel_id, r.last_remote_bytes));
    }
    // a subscription from before the control plane takes its expiry and limit from panel 1 once
    if (r.panel_id === 1 && !r.baselined) {
      const exp = remote.expire || null, lim = remote.data_limit || 0;
      out.push(st(env, 'UPDATE subscriptions SET expires_at = ?, data_limit_bytes = ?, baselined = 1 WHERE id = ? AND baselined = 0', exp, lim, r.sub_id));
      out.push(st(env, 'UPDATE sub_periods SET expires_at = ?, limit_bytes = ? WHERE id = ? AND legacy = 1', exp, lim, r.period_id));
      out.push(st(env, 'UPDATE panel_accounts SET desired_limit_bytes = ?, applied_limit_bytes = ?, desired_expire = ?, applied_expire = ? WHERE id = ?',
        lim, lim, exp, exp, r.id));
    }
  }
  return out;
}

// May this small change wait for a later sweep? Not when the account was last written LEDGER_EVERY ago, not for
// LEDGER_BIG bytes, not near the end of the plan's data (a stop must not wait), and not when the account has just
// come online after a break (the admin's "online now" follows the stored online_at).
function canWait(r, delta, online, now) {
  if (now - (r.c_seen || 0) >= LEDGER_EVERY) return false;
  if (delta >= LEDGER_BIG) return false;
  if (r.s_limit > 0 && r.s_limit - ((r.s_used || 0) + delta) < 2 * tolerance(r.s_limit)) return false;
  const onlineNow = online && now - online < ONLINE_FRESH;
  if (onlineNow && (!r.c_online || now - r.c_online > LEDGER_EVERY)) return false;
  return true;
}

async function batch(env, stmts) {
  if (stmts.length) await env.DB.batch(stmts);
}

export async function usedBytes(env, periodId) {
  if (!periodId) return 0;
  return (await first(env, 'SELECT COALESCE(SUM(accounted_bytes), 0) s FROM usage_counters WHERE period_id = ?', periodId)).s;
}

// ---------------- decisions ----------------
// Recompute these users' usage and state: two reads and one batch however many users. Stops on quota or expiry
// (once: conditional updates, tied to the period that was read, so a renewal in between is never stopped), and
// keeps each panel's own data_limit at (its reading + what is left overall), so no single panel can go past the
// total. Returns Map user_id -> the subscription as decided (with used_bytes), for users that have a period.
export async function evaluateMany(env, userIds) {
  const result = new Map();
  const ids = [...new Set(userIds.map(Number))];
  if (!ids.length) return result;
  const now = nowSec();
  const subs = await all(env, `SELECT s.*, (SELECT COALESCE(SUM(c.accounted_bytes), 0) FROM usage_counters c WHERE c.period_id = s.period_id) AS sum_used
    FROM subscriptions s WHERE s.user_id IN (SELECT value FROM json_each(?)) AND s.period_id IS NOT NULL`, JSON.stringify(ids));
  const stmts = [];
  const limited = [];
  for (const row of subs) {
    const { sum_used: used, ...sub } = row;
    if (used !== sub.used_bytes) stmts.push(st(env, 'UPDATE subscriptions SET used_bytes = ?, used_at = ? WHERE id = ?', used, now, sub.id));
    sub.used_bytes = used;
    result.set(sub.user_id, sub);
    if (sub.state !== 'active') continue;
    let reason = null;
    if (sub.expires_at && sub.expires_at <= now) reason = 'expired';
    else if (sub.data_limit_bytes > 0 && used >= sub.data_limit_bytes) reason = 'quota';
    if (reason) {
      const stopped = "EXISTS (SELECT 1 FROM subscriptions WHERE id = ? AND period_id = ? AND state = 'stopped')";
      stmts.push(st(env, "UPDATE subscriptions SET state = 'stopped', stop_reason = ? WHERE id = ? AND state = 'active' AND period_id = ?", reason, sub.id, sub.period_id));
      stmts.push(st(env, `UPDATE sub_periods SET ended_at = ?, end_reason = ?, final_used_bytes = ? WHERE id = ? AND ended_at IS NULL AND ${stopped}`,
        now, reason, used, sub.period_id, sub.id, sub.period_id));
      stmts.push(st(env, `UPDATE panel_accounts SET desired = 'stopped', dirty = 1, attempts = 0 WHERE user_id = ? AND desired = 'active' AND ${stopped}`,
        sub.user_id, sub.id, sub.period_id));
      result.set(sub.user_id, { ...sub, state: 'stopped', stop_reason: reason });
    } else if (sub.data_limit_bytes > 0) limited.push(sub);
  }
  if (limited.length) {
    const bySub = new Map(limited.map((s) => [s.user_id, s]));
    const rows = await all(env, `SELECT a.id, a.user_id, a.applied_limit_bytes, a.desired_limit_bytes, a.dirty, c.last_remote_bytes FROM panel_accounts a
      JOIN subscriptions s ON s.user_id = a.user_id JOIN usage_counters c ON c.panel_id = a.panel_id AND c.period_id = s.period_id
      WHERE a.user_id IN (SELECT value FROM json_each(?)) AND a.desired = 'active'`, JSON.stringify([...bySub.keys()]));
    for (const a of rows) {
      const sub = bySub.get(a.user_id);
      const left = sub.data_limit_bytes - sub.used_bytes;
      const tol = tolerance(sub.data_limit_bytes);
      const want = a.last_remote_bytes + left;
      const near = left < 2 * tol; // close to the end every change matters
      const drift = Math.abs(want - a.applied_limit_bytes) > tol || (near && want < a.applied_limit_bytes);
      if (drift && !(a.dirty && a.desired_limit_bytes === want)) {
        stmts.push(st(env, "UPDATE panel_accounts SET desired_limit_bytes = ?, dirty = 1 WHERE id = ? AND desired = 'active'", want, a.id));
      }
    }
  }
  await batch(env, stmts);
  return result;
}

export async function evaluate(env, userId) {
  return (await evaluateMany(env, [userId])).get(Number(userId)) ?? null;
}

// ---------------- enforcement ----------------
const panelOf = (a) => ({ id: a.panel_id, kind: a.kind, state: a.panel_state, cred_ref: a.cred_ref, options_json: a.options_json, label: a.panel_label });
const PENDING_SQL = `SELECT a.*, p.kind, p.state AS panel_state, p.cred_ref, p.options_json, p.label AS panel_label
  FROM panel_accounts a JOIN panels p ON p.id = a.panel_id`;

// One adapter per panel for a whole invocation: opening a panel's login costs a D1 read, so it is done once.
function adapterCache(env, timeoutMs = 0) {
  const seen = new Map();
  return (panel) => {
    if (!seen.has(panel.id)) seen.set(panel.id, adapterFor(env, panel, { timeoutMs }));
    return seen.get(panel.id);
  };
}

// Push accounts' desired state to their panels, then record every result in one batch. Idempotent: disabling
// twice or rewriting the same limit is harmless. The applied row is written only if nothing changed the desired
// state meanwhile, so a newer decision is pushed again on the next run.
async function pushRows(env, rows, adapter = adapterCache(env)) {
  const stmts = [];
  let done = 0;
  for (const pa of rows) {
    try {
      const pg = await adapter(panelOf(pa));
      if (pa.desired === 'active') {
        await pg.modifyUser(pa.remote_username, { status: 'active', data_limit: pa.desired_limit_bytes || 0, expire: pa.desired_expire || 0, data_limit_reset_strategy: 'no_reset' });
      } else {
        await pg.setStatus(pa.remote_username, 'disabled'); // stopped or removed: switched off, never deleted
      }
      stmts.push(st(env, `UPDATE panel_accounts SET applied = desired, applied_limit_bytes = desired_limit_bytes, applied_expire = desired_expire,
        dirty = 0, attempts = 0, last_error = NULL, applied_at = ? WHERE id = ? AND desired = ? AND desired_limit_bytes = ?`,
      nowSec(), pa.id, pa.desired, pa.desired_limit_bytes));
      done++;
    } catch (e) {
      const code = e instanceof PasarGuardError ? `panel_${e.status || 'net'}` : 'error';
      stmts.push(st(env, 'UPDATE panel_accounts SET attempts = attempts + 1, last_error = ? WHERE id = ?', code, pa.id));
      if (!(e instanceof PasarGuardError)) logError('panel push failed', e, { account: pa.id });
    }
  }
  await batch(env, stmts);
  return done;
}

export async function pushPending(env, { userId = null, limit = PUSH_PER_RUN, adapter } = {}) {
  const rows = userId
    ? await all(env, `${PENDING_SQL} WHERE a.dirty = 1 AND a.user_id = ?`, userId)
    : await all(env, `${PENDING_SQL} WHERE a.dirty = 1 ORDER BY a.attempts, a.id LIMIT ?`, limit);
  const done = await pushRows(env, rows, adapter);
  return { tried: rows.length, done };
}

// Live reading of one user on all their panels (used by /me so the app shows fresh numbers), then decide and push.
export async function refreshUser(env, userId) {
  const accounts = await accountsOf(env, userId);
  // the app is waiting: panels are read at the same time, each with the short user-path deadline
  const adapter = adapterCache(env, USER_PATH_MS);
  const readings = new Map();
  let reached = 0, missing = 0;
  await Promise.all(accounts.filter((a) => a.panel_state !== 'disabled').map(async (a) => {
    try {
      const pg = await adapter({ id: a.panel_id, kind: a.kind, cred_ref: a.cred_ref, options_json: a.options_json });
      pg.timeoutMs = userPathMs(a);
      const u = await pg.getUser(a.remote_username);
      if (!u) { missing++; return; }
      reached++;
      readings.set(a.id, { used: parseInt(u.used_traffic || 0, 10) || 0, expire: parseExpire(u.expire), data_limit: parseInt(u.data_limit || 0, 10) || 0, online: parseExpire(u.online_at) });
    } catch (e) {
      readings.set(a.id, null);
    }
  }));
  if (readings.size) {
    const rows = await all(env, `${LEDGER_SQL} WHERE a.user_id = ?`, userId);
    await batch(env, ledgerWrites(env, rows, (r) => readings.get(r.id), nowSec()));
  }
  const sub = await evaluate(env, userId);
  if (sub) await pushPending(env, { userId, adapter });
  return { reached, missing, accounts: accounts.length };
}

// ---------------- accounts on panels ----------------
// Create (or re-activate) this user's account on one panel with the logical subscription's expiry and remaining
// data. Returns the account row; throws PasarGuardError when the panel refuses.
export async function ensureAccount(env, user, panel, { expire, limit, hwid } = {}) {
  const pg = await adapterFor(env, panel);
  const pa = await first(env, 'SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = ?', user.id, panel.id);
  const now = nowSec();
  if (pa && (await pg.getUser(pa.remote_username))) return pa;
  const groups = await groupIdsFor(env, panel, pg);
  const made = await createRemote(env, pg, user, { expire, limit, hwid, groups, name: pa ? pa.remote_username : null });
  if (pa) {
    await run(env, `UPDATE panel_accounts SET remote_username = ?, remote_id = ?, sub_path = ?, desired = 'active', applied = 'active',
      desired_limit_bytes = ?, applied_limit_bytes = ?, desired_expire = ?, applied_expire = ?, dirty = 0, attempts = 0, applied_at = ? WHERE id = ?`,
      made.username, made.id, made.subPath, limit || 0, limit || 0, expire || null, expire || null, now, pa.id);
  } else {
    await insertAccount(env, user.id, panel.id, made, { expire, limit, now }).run();
  }
  return first(env, 'SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = ?', user.id, panel.id);
}

// The account's name on the panel follows the user's Telegram @username (what the admin sees in the panel), so
// it is readable there; the numeric Telegram id / user id in the database stays the identity. The name is
// fixed at creation: a later @username change does not rename it (Marzban's subscription token depends on it).
// Rules of all three panels: 3-32 characters of [a-zA-Z0-9_@.-] (Marzban, Rebecca), no two specials in a row
// (PasarGuard). Telegram usernames are [a-z0-9_]{5,32}, so a sanitized one fits as it is.
export function panelNameBase(user) {
  const tg = String(user.tg_username || '').toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32).replace(/_+$/, '');
  if (tg.length >= 3) return tg;
  if (user.tg_id) return `tg${user.tg_id}`.slice(0, 32);
  return null;
}
const fit = (base, suffix) => `${base.slice(0, 32 - suffix.length).replace(/_+$/, '')}${suffix}`;
// The names tried in order: the @username, then with the user id, then with a random tail. Without Telegram
// the old cg_<id>_<random> name is used.
export function panelNames(user, prefix = 'cg') {
  const base = panelNameBase(user);
  if (!base) return [`${prefix}_${user.id}_${randomHex(2)}`.slice(0, 32), `${prefix}_${user.id}_${randomHex(2)}`.slice(0, 32), `${prefix}_${user.id}_${randomHex(3)}`.slice(0, 32)];
  return [base, fit(base, `_${user.id}`), fit(base, `_${randomHex(2)}`)];
}

// Make the account on the panel; a name the panel says is taken (409) moves on to the next one. {username, id, subPath}
async function createRemote(env, pg, user, { expire, limit, hwid, groups, name }) {
  const prefix = String(env.PASARGUARD_USERNAME_PREFIX || 'cg').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'cg';
  if (user.tg_id === undefined) {
    const row = await first(env, 'SELECT tg_id, tg_username FROM users WHERE id = ?', user.id);
    user = { ...user, tg_id: row ? row.tg_id : null, tg_username: row ? row.tg_username : null };
  }
  const names = panelNames(user, prefix);
  if (name) names.unshift(name);
  let created = null, username = '';
  for (let attempt = 0; attempt < names.length && !created; attempt++) {
    username = names[attempt];
    try {
      created = await pg.createUser(username, { expire, dataLimit: limit, groupIds: groups, hwidLimit: hwid || null, note: noteFor(user) });
    } catch (e) {
      if (e instanceof PasarGuardError && e.status === 409 && attempt < names.length - 1) continue; // name taken, try the next
      throw e;
    }
  }
  const subPath = pg.absoluteSubUrl(created.subscription_url || '');
  if (!subPath) throw new PasarGuardError('panel created the user but returned no subscription link', 0);
  return { username, id: created.id ?? null, subPath };
}
const noteFor = (user) => ['Pleat', `#${user.id}`, user.tg_id ? `tg ${user.tg_id}` : '', user.email && !/@telegram\./.test(user.email) ? user.email : ''].filter(Boolean).join(' · ');

// The new account's row. Another path (the app opening at the same moment) may have made one first: then that
// one stays, and this statement changes nothing instead of failing the batch it is in.
const insertAccount = (env, userId, panelId, made, { expire, limit, now }) => st(env, `INSERT INTO panel_accounts (user_id, panel_id, remote_username, remote_id, sub_path, desired, applied,
    desired_limit_bytes, applied_limit_bytes, desired_expire, applied_expire, applied_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', 'active', ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
userId, panelId, made.username, made.id, made.subPath, limit || 0, limit || 0, expire || null, expire || null, now, now);

// An account that already exists on a panel (made there by hand and used with v2rayNG) becomes this user's
// account on that panel: same username, UUID and link, nothing is created on the panel. The logical subscription
// starts a new period that mirrors that account (its expiry, its limit and what it has used so far). Every
// database change is one batch, so a link is either fully made or not at all; the UNIQUE (panel_id,
// remote_username) index refuses the batch if the account already belongs to another user.
// remote = the panel's user record, read just before. Returns {replaced, disabled}: the user's previous account
// on that panel (if any) is switched off on the panel, never deleted.
// Which way a link goes: "merge" when the user's current period already came from a linked panel account (the
// same person had accounts on several panels), so usage adds up inside that one period; otherwise "replace".
export async function linkMode(env, userId) {
  const row = await first(env, `SELECT p.source FROM subscriptions s JOIN sub_periods p ON p.id = s.period_id
    WHERE s.user_id = ? AND s.state = 'active' AND p.ended_at IS NULL`, userId);
  return row && row.source === 'panel' ? 'merge' : 'replace';
}

// A plan the linked numbers fit: same data, and the shortest duration that still holds the days left.
export async function suggestPlan(env, limitBytes, expire) {
  const gb = limitBytes > 0 ? Math.round(limitBytes / 1024 ** 3) : 0;
  const days = expire ? Math.max(1, Math.ceil((expire - nowSec()) / 86400)) : 0;
  const rows = await all(env, 'SELECT * FROM plans WHERE is_active = 1 AND data_limit_gb = ? ORDER BY duration_days, sort, id', gb);
  return rows.find((p) => !days || p.duration_days >= days) || rows[rows.length - 1] || null;
}

export async function linkAccount(env, user, panel, remote, { planId = null } = {}) {
  if ((await linkMode(env, user.id)) === 'merge') return mergeAccount(env, user, panel, remote, { planId });
  const pg = await adapterFor(env, panel);
  const subPath = pg.absoluteSubUrl(remote.subscription_url || '');
  if (!subPath) throw new PasarGuardError('panel returned no subscription link for this user', 0);
  const now = nowSec();
  const expire = parseExpire(remote.expire) || null;
  const limit = parseInt(remote.data_limit || 0, 10) || 0;
  const used = Math.max(0, parseInt(remote.used_traffic || 0, 10) || 0);
  const devices = parseInt(remote.hwid_limit || 0, 10) || 0;
  const applied = String(remote.status || 'active') === 'active' ? 'active' : 'stopped';
  const left = limit > 0 ? Math.max(1, limit - used) : 0;
  const sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);
  const old = await first(env, 'SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = ?', user.id, panel.id);
  const st = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const period = '(SELECT MAX(id) FROM sub_periods WHERE user_id = ?)'; // the period opened in this batch
  const p1 = panel.id === 1;
  const stmts = [];
  if (sub && sub.period_id) {
    stmts.push(st(`UPDATE sub_periods SET ended_at = ?, end_reason = 'admin',
      final_used_bytes = (SELECT COALESCE(SUM(accounted_bytes), 0) FROM usage_counters WHERE period_id = ?) WHERE id = ? AND ended_at IS NULL`,
    now, sub.period_id, sub.period_id));
  }
  stmts.push(st("INSERT INTO sub_periods (user_id, plan_id, source, started_at, expires_at, limit_bytes) VALUES (?, ?, 'panel', ?, ?, ?)", user.id, planId, now, expire, limit));
  // a panel account that is switched off but still has time and data is switched on again by the sync job
  if (old) {
    stmts.push(st(`UPDATE panel_accounts SET remote_username = ?, remote_id = ?, sub_path = ?, desired = 'active', applied = ?,
      desired_limit_bytes = ?, applied_limit_bytes = ?, desired_expire = ?, applied_expire = ?, dirty = ?, attempts = 0, last_error = NULL, applied_at = ?
      WHERE id = ?`, remote.username, remote.id ?? null, subPath, applied, limit, limit, expire, expire, applied === 'active' ? 0 : 1, now, old.id));
  } else {
    stmts.push(st(`INSERT INTO panel_accounts (user_id, panel_id, remote_username, remote_id, sub_path, desired, applied,
      desired_limit_bytes, applied_limit_bytes, desired_expire, applied_expire, dirty, applied_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
    user.id, panel.id, remote.username, remote.id ?? null, subPath, applied, limit, limit, expire, expire, applied === 'active' ? 0 : 1, now, now));
  }
  // what the account used before the link counts against its own limit, as it does on the panel
  stmts.push(st(`INSERT INTO usage_counters (period_id, panel_id, last_remote_bytes, accounted_bytes, last_seen_at) VALUES (${period}, ?, ?, ?, ?)`,
    user.id, panel.id, used, used, now));
  // the user's accounts on other panels follow the new expiry and what is left; their next reading is their start
  stmts.push(st(`INSERT OR IGNORE INTO usage_counters (period_id, panel_id, baseline_pending, last_seen_at)
    SELECT ${period}, panel_id, 1, ? FROM panel_accounts WHERE user_id = ? AND panel_id != ?`, user.id, now, user.id, panel.id));
  stmts.push(st(`UPDATE panel_accounts SET desired = 'active', desired_limit_bytes = ?, desired_expire = ?, dirty = 1, attempts = 0
    WHERE user_id = ? AND panel_id != ? AND desired != 'removed'`, left, expire, user.id, panel.id));
  stmts.push(st(`INSERT INTO subscriptions (user_id, pg_username, plan_id, expires_at, data_limit_bytes, device_limit, sub_url, period_days, updated_at,
      period_id, state, stop_reason, used_bytes, used_at, baselined)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${period}, 'active', NULL, ?, ?, 1)
    ON CONFLICT(user_id) DO UPDATE SET plan_id = excluded.plan_id, expires_at = excluded.expires_at, data_limit_bytes = excluded.data_limit_bytes,
      device_limit = excluded.device_limit, period_days = excluded.period_days, updated_at = excluded.updated_at, period_id = excluded.period_id,
      state = 'active', stop_reason = NULL, used_bytes = excluded.used_bytes, used_at = excluded.used_at, baselined = 1,
      pg_username = CASE WHEN ? THEN excluded.pg_username ELSE subscriptions.pg_username END,
      sub_url = CASE WHEN ? THEN excluded.sub_url ELSE subscriptions.sub_url END`,
  user.id, p1 ? remote.username : '', planId, expire, limit, devices, p1 ? subPath : '', expire ? Math.max(1, Math.ceil((expire - now) / 86400)) : null, now,
  user.id, used, now, p1 ? 1 : 0, p1 ? 1 : 0));
  stmts.push(st('UPDATE users SET trial_used = 1 WHERE id = ?', user.id)); // the linked account replaces a free trial
  await env.DB.batch(stmts);

  let replaced = null, disabled = false;
  if (old && old.remote_username !== remote.username) {
    replaced = old.remote_username;
    try { await pg.setStatus(replaced, 'disabled'); disabled = true; } catch (e) { /* the admin is told to switch it off by hand */ }
  }
  await evaluate(env, user.id); // stops at once if the account is already out of time or data
  await pushPending(env, { userId: user.id });
  return { replaced, disabled };
}

// A second (third...) existing panel account of the same person joins the current period instead of starting a
// new one: what it has used is added to the period's usage, and it takes the period's expiry and what is left,
// so the user can never get more than the plan. An account this user already had on that panel (one the Worker
// created) keeps the bytes it used and is switched off.
async function mergeAccount(env, user, panel, remote, { planId }) {
  const pg = await adapterFor(env, panel);
  const subPath = pg.absoluteSubUrl(remote.subscription_url || '');
  if (!subPath) throw new PasarGuardError('panel returned no subscription link for this user', 0);
  const now = nowSec();
  const sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', user.id);
  const used = Math.max(0, parseInt(remote.used_traffic || 0, 10) || 0);
  const old = await first(env, 'SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = ?', user.id, panel.id);
  const remoteLimit = parseInt(remote.data_limit || 0, 10) || 0;
  const st = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const stmts = [];
  // its limit is rewritten by evaluate() to (its own reading + what is left overall); expiry = the period's
  if (old) {
    stmts.push(st(`UPDATE panel_accounts SET remote_username = ?, remote_id = ?, sub_path = ?, desired = 'active', applied = 'active',
      desired_limit_bytes = ?, applied_limit_bytes = ?, desired_expire = ?, applied_expire = ?, dirty = 1, attempts = 0, last_error = NULL, applied_at = ?
      WHERE id = ?`, remote.username, remote.id ?? null, subPath, remoteLimit, remoteLimit, sub.expires_at, parseExpire(remote.expire) || null, now, old.id));
  } else {
    stmts.push(st(`INSERT INTO panel_accounts (user_id, panel_id, remote_username, remote_id, sub_path, desired, applied,
      desired_limit_bytes, applied_limit_bytes, desired_expire, applied_expire, dirty, applied_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', 'active', ?, ?, ?, ?, 1, ?, ?)`,
    user.id, panel.id, remote.username, remote.id ?? null, subPath, remoteLimit, remoteLimit, sub.expires_at, parseExpire(remote.expire) || null, now, now));
  }
  // the old account's bytes stay counted; the linked account's usage so far is added, and its counter starts from it
  stmts.push(st(`INSERT INTO usage_counters (period_id, panel_id, last_remote_bytes, accounted_bytes, last_seen_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(period_id, panel_id) DO UPDATE SET accounted_bytes = accounted_bytes + excluded.accounted_bytes,
      last_remote_bytes = excluded.last_remote_bytes, baseline_pending = 0, stale = 0, last_seen_at = excluded.last_seen_at`,
  sub.period_id, panel.id, used, used, now));
  if (planId) {
    stmts.push(st('UPDATE subscriptions SET plan_id = ? WHERE id = ?', planId, sub.id));
    stmts.push(st('UPDATE sub_periods SET plan_id = ? WHERE id = ?', planId, sub.period_id));
  }
  await env.DB.batch(stmts);
  let replaced = null, disabled = false;
  if (old && old.remote_username !== remote.username) {
    replaced = old.remote_username;
    try { await pg.setStatus(replaced, 'disabled'); disabled = true; } catch (e) { /* the admin is told to switch it off by hand */ }
  }
  // evaluate() only rewrites limits that drifted, so make every account's limit be recomputed now
  await run(env, 'UPDATE panel_accounts SET applied_limit_bytes = -1 WHERE user_id = ? AND panel_id = ?', user.id, panel.id);
  await evaluate(env, user.id);
  await pushPending(env, { userId: user.id });
  return { replaced, disabled, merged: true };
}

function randomHex(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------------- the cron job ----------------
const setCursor = (env, job, panelId, offset) => st(env, `INSERT INTO sync_cursor (job, panel_id, offset, run_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(job, panel_id) DO UPDATE SET offset = excluded.offset, run_at = excluded.run_at`, job, panelId, offset, nowSec());
const healthWrite = (env, panelId, okNow, now = nowSec()) => okNow
  ? st(env, 'UPDATE panels SET fail_streak = 0, health = MIN(100, health + 20), last_ok_at = ?, last_check_at = ? WHERE id = ?', now, now, panelId)
  : st(env, 'UPDATE panels SET fail_streak = fail_streak + 1, health = MAX(0, health - 34), last_check_at = ? WHERE id = ?', now, panelId);

// Read one page of one panel (round robin over panels that still have accounts to count): one read for the
// cursors, one for every account on the page, and one batch for all the writes. Returns the page's users.
async function syncPage(env, allPanels, adapter) {
  const panels = allPanels.filter((p) => ['active', 'rollout', 'draining'].includes(p.state));
  if (!panels.length) return null;
  const cur = await all(env, "SELECT job, panel_id, offset FROM sync_cursor WHERE job IN ('rr', 'usage')");
  const at = (job, id) => cur.find((c) => c.job === job && c.panel_id === id)?.offset || 0;
  const turn = at('rr', 0) % panels.length;
  const panel = panels[turn];
  const offset = at('usage', panel.id);
  const now = nowSec();
  const stmts = [];
  let users = [], wrapped = false;
  try {
    const page = await (await adapter(panel)).listUsage(offset, PAGE);
    const byName = new Map(page.users.map((u) => [u.username, u]));
    if (byName.size) {
      const rows = await all(env, `${LEDGER_SQL} WHERE a.panel_id = ? AND a.remote_username IN (SELECT value FROM json_each(?))`,
        panel.id, JSON.stringify([...byName.keys()]));
      stmts.push(...ledgerWrites(env, rows, (r) => byName.get(r.remote_username), now, { spread: true }));
      users = rows.map((r) => r.user_id);
    }
    stmts.push(healthWrite(env, panel.id, true, now));
    const next = offset + page.users.length;
    wrapped = !page.users.length || next >= page.total;
    stmts.push(setCursor(env, 'usage', panel.id, wrapped ? 0 : next));
  } catch (e) {
    stmts.push(healthWrite(env, panel.id, false, now));
    // this panel's accounts stay counted at their last reading; mark them stale
    stmts.push(st(env, 'UPDATE usage_counters SET stale = 1 WHERE panel_id = ? AND stale = 0 AND period_id IN (SELECT period_id FROM subscriptions)', panel.id));
    wrapped = true; // do not stay stuck on a broken panel
  }
  if (wrapped) {
    stmts.push(setCursor(env, 'rr', 0, turn + 1));
    // a draining panel has been read one last time: switch its accounts off (kept in the database) and disable it
    if (panel.state === 'draining') {
      stmts.push(st(env, "UPDATE panel_accounts SET desired = 'removed', dirty = 1, attempts = 0 WHERE panel_id = ? AND desired != 'removed'", panel.id));
      stmts.push(st(env, "UPDATE panels SET state = 'disabled', disabled_at = ? WHERE id = ? AND state = 'draining'", now, panel.id));
    }
  }
  await batch(env, stmts);
  return { panel: panel.id, touched: [...new Set(users)] };
}

// A panel that refused to create an account: remembered (settings panel_err_<id>) for the bot and for the app
// path, and told to the admin once every few hours. A success clears it.
export async function noteCreateError(env, panel, e) {
  const key = `panel_err_${panel.id}`;
  const now = nowSec();
  let prev = null;
  try { prev = JSON.parse((await first(env, 'SELECT value FROM settings WHERE key = ?', key))?.value || 'null'); } catch (x) { /* rewritten below */ }
  const msg = String(e && e.message ? e.message : e).slice(0, 300);
  const notify = !prev || !prev.notified_at || now - prev.notified_at >= ERR_NOTIFY_EVERY;
  await run(env, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key,
    JSON.stringify({ msg, at: now, notified_at: notify ? now : prev.notified_at }));
  if (notify) {
    try {
      const { notifyAdmin, untrusted } = await import('./telegram.js');
      await notifyAdmin(env, `⚠️ روی پنل #${panel.id} (${panel.label || ''}) برای کاربران اکانت ساخته نمی‌شود، پس کانفیگ‌هایش به آن‌ها نمی‌رسد.

خطای پنل:
${untrusted(msg)}

بعد از رفع مشکل خودکار ادامه پیدا می‌کند. تست: /paneltest ${panel.id}`);
    } catch (x) { /* the error stays visible in /panels */ }
  }
}
async function clearCreateError(env, panel) {
  await run(env, 'DELETE FROM settings WHERE key = ?', `panel_err_${panel.id}`);
}
export async function createError(env, panelId) {
  try { return JSON.parse((await first(env, 'SELECT value FROM settings WHERE key = ?', `panel_err_${panelId}`))?.value || 'null'); }
  catch (e) { return null; }
}

// One missing account for this subscription on this panel, with what is left of the plan. true = made.
async function createFor(env, s, panel) {
  const left = s.data_limit_bytes > 0 ? Math.max(1, s.data_limit_bytes - s.used_bytes) : 0;
  try {
    await ensureAccount(env, { id: s.user_id, email: s.email, tg_id: s.tg_id, tg_username: s.tg_username }, panel, { expire: s.expires_at, limit: left });
  } catch (e) {
    await recordHealth(env, panel.id, false);
    await noteCreateError(env, panel, e);
    return false;
  }
  await clearCreateError(env, panel);
  return true;
}

// Users with a running subscription who are missing an account on a panel they belong to (a new panel being
// rolled out, or users of a removed panel). A few per run: per panel one read and the panel's groups, then the
// accounts are made on the panel and all their rows written in one batch.
async function createMissing(env, allPanels, adapter, max = CREATE_PER_RUN) {
  const panels = allPanels.filter((p) => ['active', 'rollout'].includes(p.state));
  let made = 0;
  for (const panel of panels) {
    if (made >= max) break;
    const rows = await all(env, `SELECT s.*, u.email, u.tg_id, u.tg_username FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.state = 'active' AND u.is_active = 1 AND s.period_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM panel_accounts a WHERE a.user_id = s.user_id AND a.panel_id = ?)
      ORDER BY s.user_id LIMIT 50`, panel.id);
    const want = rows.filter((s) => pickPanels(allPanels, s.user_id).some((p) => p.id === panel.id)).slice(0, max - made);
    if (!want.length) continue;
    const now = nowSec();
    const stmts = [];
    let failed = null, inserted = 0;
    try {
      const pg = await adapter(panel);
      const groups = await groupIdsFor(env, panel, pg);
      for (const s of want) {
        const limit = s.data_limit_bytes > 0 ? Math.max(1, s.data_limit_bytes - s.used_bytes) : 0;
        const acct = await createRemote(env, pg, { id: s.user_id, email: s.email, tg_id: s.tg_id, tg_username: s.tg_username }, { expire: s.expires_at, limit, groups });
        stmts.push(insertAccount(env, s.user_id, panel.id, acct, { expire: s.expires_at, limit, now }));
        inserted++;
      }
    } catch (e) {
      failed = e; // this panel refuses now; what was made is kept, the rest is tried again next run
    }
    if (inserted && !failed) stmts.push(st(env, 'DELETE FROM settings WHERE key = ?', `panel_err_${panel.id}`));
    if (failed) stmts.push(healthWrite(env, panel.id, false, now));
    await batch(env, stmts);
    made += inserted;
    if (failed) await noteCreateError(env, panel, failed);
  }
  return made;
}

// The app is asking for this user's servers: make the user's missing account on a new panel now, so its
// configs are in this very answer. At most one panel per request, and never a panel that is unhealthy or
// refused a create in the last minutes (the app must not wait on a broken panel).
export async function ensureMissingFor(env, userId) {
  const s = await first(env, `SELECT s.*, u.email, u.tg_id, u.tg_username FROM subscriptions s JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ? AND s.state = 'active' AND s.period_id IS NOT NULL`, userId);
  if (!s || (s.expires_at && s.expires_at <= nowSec())) return false;
  const have = new Set((await all(env, 'SELECT panel_id FROM panel_accounts WHERE user_id = ?', userId)).map((r) => r.panel_id));
  for (const panel of await panelsFor(env, userId)) {
    if (have.has(panel.id) || panel.fail_streak >= 3) continue;
    const e = await createError(env, panel.id);
    if (e && nowSec() - e.at < QUIET_AFTER_ERROR) continue;
    return createFor(env, s, panel);
  }
  return false;
}

// For the bot: how many of the users this panel should serve already have their account on it.
export async function panelProgress(env, panel) {
  const subs = await all(env, `SELECT user_id FROM subscriptions WHERE state = 'active' AND period_id IS NOT NULL`);
  const { bucketOf } = await import('./panels.js');
  const want = panel.state === 'active' ? subs : panel.state === 'rollout' ? subs.filter((r) => bucketOf(r.user_id, panel.id) < panel.rollout_percent) : [];
  if (!want.length) return { want: 0, have: 0 };
  const has = new Set((await all(env, "SELECT user_id FROM panel_accounts WHERE panel_id = ? AND desired = 'active'", panel.id)).map((r) => r.user_id));
  return { want: want.length, have: want.filter((r) => has.has(r.user_id)).length };
}

// One cron slice. Returns what it did (for tests and logs). Each part runs even when an earlier one failed, so
// a broken panel or one bad row never stops expiry, pushes or new accounts.
export async function runSync(env) {
  const out = { page: null, expired: 0, pushed: 0, created: 0 };
  const panels = await listPanels(env);
  const adapter = adapterCache(env);
  const part = async (name, fn) => { try { await fn(); } catch (e) { logError(`sync ${name} failed`, e); } };
  let due = [];
  await part('page', async () => { out.page = await syncPage(env, panels, adapter); });
  await part('evaluate', async () => {
    // expiry needs no panel reading
    due = await all(env, "SELECT user_id FROM subscriptions WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= ? LIMIT 50", nowSec());
    await evaluateMany(env, [...(out.page ? out.page.touched : []), ...due.map((r) => r.user_id)]);
    out.expired = due.length;
  });
  let tried = 0;
  await part('push', async () => { const push = await pushPending(env, { adapter }); out.pushed = push.done; tried = push.tried; });
  await part('create', async () => {
    out.created = await createMissing(env, panels, adapter, Math.max(2, Math.min(CREATE_PER_RUN, Math.floor((SUBREQ_BUDGET - tried) / 4))));
  });
  return out;
}
