// Usage ledger, quota/expiry decisions and enforcement across panels, plus the chunked sync job.
//
// Usage of a user = sum over panels of usage_counters.accounted_bytes for the current period. A counter only
// grows: a panel-side reset is detected (reading below the last one) and added on top, and a panel that does
// not answer keeps its last value (stale) instead of counting as zero.
//
// Deciding and doing are separate: evaluate() only writes what each panel account should be (desired, dirty);
// applyAccount() pushes that to the panel and is safe to repeat, so a stop that failed on a broken panel is
// simply tried again on the next run until the panel confirms it.
//
// The Free plan gives a cron run 10 ms of CPU and 50 subrequests, so runSync() does a bounded slice per run:
// one page of one panel's users, a few pending pushes and a few missing accounts.
import { first, all, run } from './db.js';
import { nowSec, logError } from './util.js';
import { PasarGuardError, parseExpire } from './pasarguard.js';
import { adapterFor, getPanel, listPanels, panelsFor, recordHealth, accountsOf, groupIdsFor } from './panels.js';

export const PAGE = 200;            // users read per panel request
const PUSH_PER_RUN = 15;            // pending panel writes per cron run
const CREATE_PER_RUN = 8;           // missing panel accounts created per cron run (fewer when pushes used the budget)
const SUBREQ_BUDGET = 44;           // of the 50 a Free-plan run may make; a create costs up to about 4
const ERR_NOTIFY_EVERY = 6 * 3600;  // the admin hears about one panel refusing new accounts at most this often
const QUIET_AFTER_ERROR = 600;      // after a refused create, the app does not wait on that panel for 10 minutes
const MB = 1024 * 1024;

// how far a panel's own data_limit may drift from the ideal before it is rewritten (fewer panel writes)
export const tolerance = (limit) => Math.max(Math.floor(limit / 20), 64 * MB);

// ---------------- ledger ----------------
// One reading of an account on a panel. remote = {used, expire, data_limit} or null when the panel did not answer.
export async function observe(env, pa, remote) {
  const sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', pa.user_id);
  if (!sub || !sub.period_id) return;
  const now = nowSec();
  const c = await first(env, 'SELECT * FROM usage_counters WHERE period_id = ? AND panel_id = ?', sub.period_id, pa.panel_id);
  if (!remote) {
    if (c) await run(env, 'UPDATE usage_counters SET stale = 1 WHERE period_id = ? AND panel_id = ?', sub.period_id, pa.panel_id);
    return;
  }
  const used = Math.max(0, remote.used || 0);
  if (!c) {
    // first reading in this period: everything on this account belongs to it (new account, or the
    // subscription that existed before the control plane)
    await run(env, `INSERT OR IGNORE INTO usage_counters (period_id, panel_id, last_remote_bytes, accounted_bytes, last_seen_at)
      VALUES (?, ?, ?, ?, ?)`, sub.period_id, pa.panel_id, used, used, now);
  } else if (c.baseline_pending) {
    await run(env, 'UPDATE usage_counters SET last_remote_bytes = ?, baseline_pending = 0, stale = 0, last_seen_at = ? WHERE period_id = ? AND panel_id = ?',
      used, now, sub.period_id, pa.panel_id);
  } else {
    // below the last reading = the panel's counter was reset; what it shows now is all new
    const delta = used >= c.last_remote_bytes ? used - c.last_remote_bytes : used;
    await run(env, `UPDATE usage_counters SET accounted_bytes = accounted_bytes + ?, last_remote_bytes = ?, stale = 0, last_seen_at = ?
      WHERE period_id = ? AND panel_id = ?`, delta, used, now, sub.period_id, pa.panel_id);
  }
  // a subscription from before the control plane takes its expiry and limit from panel 1 once
  if (pa.panel_id === 1 && !sub.baselined) {
    const exp = remote.expire || null;
    await run(env, `UPDATE subscriptions SET expires_at = ?, data_limit_bytes = ?, baselined = 1 WHERE id = ? AND baselined = 0`, exp, remote.data_limit || 0, sub.id);
    await run(env, 'UPDATE sub_periods SET expires_at = ?, limit_bytes = ? WHERE id = ? AND legacy = 1', exp, remote.data_limit || 0, sub.period_id);
    await run(env, 'UPDATE panel_accounts SET desired_limit_bytes = ?, applied_limit_bytes = ?, desired_expire = ?, applied_expire = ? WHERE id = ?',
      remote.data_limit || 0, remote.data_limit || 0, exp, exp, pa.id);
  }
}

export async function usedBytes(env, periodId) {
  if (!periodId) return 0;
  return (await first(env, 'SELECT COALESCE(SUM(accounted_bytes), 0) s FROM usage_counters WHERE period_id = ?', periodId)).s;
}

// ---------------- decisions ----------------
// Recompute one user's usage and state. Stops on quota or expiry (once: conditional update), and keeps each
// panel's own data_limit at (its reading + what is left overall), so no single panel can go past the total.
export async function evaluate(env, userId) {
  const sub = await first(env, 'SELECT * FROM subscriptions WHERE user_id = ?', userId);
  if (!sub || !sub.period_id) return null;
  const now = nowSec();
  const used = await usedBytes(env, sub.period_id);
  await run(env, 'UPDATE subscriptions SET used_bytes = ?, used_at = ? WHERE id = ?', used, now, sub.id);
  sub.used_bytes = used;
  if (sub.state !== 'active') return sub;
  let reason = null;
  if (sub.expires_at && sub.expires_at <= now) reason = 'expired';
  else if (sub.data_limit_bytes > 0 && used >= sub.data_limit_bytes) reason = 'quota';
  if (reason) {
    const r = await run(env, "UPDATE subscriptions SET state = 'stopped', stop_reason = ? WHERE id = ? AND state = 'active'", reason, sub.id);
    if (r.meta.changes) {
      await run(env, 'UPDATE sub_periods SET ended_at = ?, end_reason = ?, final_used_bytes = ? WHERE id = ? AND ended_at IS NULL', now, reason, used, sub.period_id);
      await run(env, "UPDATE panel_accounts SET desired = 'stopped', dirty = 1, attempts = 0 WHERE user_id = ? AND desired = 'active'", userId);
    }
    return { ...sub, state: 'stopped', stop_reason: reason };
  }
  if (sub.data_limit_bytes > 0) {
    const left = sub.data_limit_bytes - used;
    const tol = tolerance(sub.data_limit_bytes);
    const rows = await all(env, `SELECT a.id, a.applied_limit_bytes, c.last_remote_bytes FROM panel_accounts a
      JOIN usage_counters c ON c.panel_id = a.panel_id AND c.period_id = ? WHERE a.user_id = ? AND a.desired = 'active'`, sub.period_id, userId);
    for (const a of rows) {
      const want = a.last_remote_bytes + left;
      const near = left < 2 * tol; // close to the end every change matters
      if (Math.abs(want - a.applied_limit_bytes) > tol || (near && want < a.applied_limit_bytes)) {
        await run(env, 'UPDATE panel_accounts SET desired_limit_bytes = ?, dirty = 1 WHERE id = ?', want, a.id);
      }
    }
  }
  return sub;
}

// ---------------- enforcement ----------------
// Push one account's desired state to its panel. Idempotent: disabling twice or rewriting the same limit is harmless.
export async function applyAccount(env, pa) {
  const panel = await getPanel(env, pa.panel_id);
  if (!panel) return false;
  try {
    const pg = await adapterFor(env, panel);
    if (pa.desired === 'active') {
      await pg.modifyUser(pa.remote_username, { status: 'active', data_limit: pa.desired_limit_bytes || 0, expire: pa.desired_expire || 0, data_limit_reset_strategy: 'no_reset' });
    } else {
      await pg.setStatus(pa.remote_username, 'disabled'); // stopped or removed: switched off, never deleted
    }
    await run(env, `UPDATE panel_accounts SET applied = desired, applied_limit_bytes = desired_limit_bytes, applied_expire = desired_expire,
      dirty = 0, attempts = 0, last_error = NULL, applied_at = ? WHERE id = ? AND desired = ? AND desired_limit_bytes = ?`,
      nowSec(), pa.id, pa.desired, pa.desired_limit_bytes);
    return true;
  } catch (e) {
    const code = e instanceof PasarGuardError ? `panel_${e.status || 'net'}` : 'error';
    await run(env, 'UPDATE panel_accounts SET attempts = attempts + 1, last_error = ? WHERE id = ?', code, pa.id);
    if (!(e instanceof PasarGuardError)) logError('panel push failed', e, { account: pa.id });
    return false;
  }
}

export async function pushPending(env, { userId = null, limit = PUSH_PER_RUN } = {}) {
  const rows = userId
    ? await all(env, 'SELECT * FROM panel_accounts WHERE dirty = 1 AND user_id = ?', userId)
    : await all(env, 'SELECT * FROM panel_accounts WHERE dirty = 1 ORDER BY attempts, id LIMIT ?', limit);
  let done = 0;
  for (const pa of rows) if (await applyAccount(env, pa)) done++;
  return { tried: rows.length, done };
}

// Live reading of one user on all their panels (used by /me so the app shows fresh numbers), then decide and push.
export async function refreshUser(env, userId) {
  const accounts = await accountsOf(env, userId);
  let reached = 0, missing = 0;
  for (const a of accounts) {
    if (a.panel_state === 'disabled') continue;
    try {
      const u = await (await adapterFor(env, { id: a.panel_id, kind: a.kind, cred_ref: a.cred_ref })).getUser(a.remote_username);
      if (!u) { missing++; continue; }
      reached++;
      await observe(env, a, { used: parseInt(u.used_traffic || 0, 10) || 0, expire: parseExpire(u.expire), data_limit: parseInt(u.data_limit || 0, 10) || 0 });
    } catch (e) {
      await observe(env, a, null);
    }
  }
  const sub = await evaluate(env, userId);
  if (sub) await pushPending(env, { userId });
  return { reached, missing, accounts: accounts.length };
}

// ---------------- accounts on panels ----------------
// Create (or re-activate) this user's account on one panel with the logical subscription's expiry and remaining
// data. Returns the account row; throws PasarGuardError when the panel refuses.
export async function ensureAccount(env, user, panel, { expire, limit, hwid } = {}) {
  const pg = await adapterFor(env, panel);
  let pa = await first(env, 'SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = ?', user.id, panel.id);
  const now = nowSec();
  if (pa && (await pg.getUser(pa.remote_username))) return pa;
  const groups = await groupIdsFor(env, panel, pg);
  const prefix = String(env.PASARGUARD_USERNAME_PREFIX || 'cg').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'cg';
  let created = null, username = '';
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    username = pa && attempt === 0 ? pa.remote_username : `${prefix}_${user.id}_${randomHex(2)}`.slice(0, 32);
    try {
      created = await pg.createUser(username, { expire, dataLimit: limit, groupIds: groups, hwidLimit: hwid || null, note: `Cloud Gold · ${user.email}` });
    } catch (e) {
      if (e instanceof PasarGuardError && e.status === 409 && attempt < 2) continue; // name taken, try another
      throw e;
    }
  }
  const subPath = pg.absoluteSubUrl(created.subscription_url || '');
  if (!subPath) throw new PasarGuardError('panel created the user but returned no subscription link', 0);
  if (pa) {
    await run(env, `UPDATE panel_accounts SET remote_username = ?, remote_id = ?, sub_path = ?, desired = 'active', applied = 'active',
      desired_limit_bytes = ?, applied_limit_bytes = ?, desired_expire = ?, applied_expire = ?, dirty = 0, attempts = 0, applied_at = ? WHERE id = ?`,
      username, created.id ?? null, subPath, limit || 0, limit || 0, expire || null, expire || null, now, pa.id);
  } else {
    await run(env, `INSERT INTO panel_accounts (user_id, panel_id, remote_username, remote_id, sub_path, desired, applied,
      desired_limit_bytes, applied_limit_bytes, desired_expire, applied_expire, applied_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', 'active', ?, ?, ?, ?, ?, ?)`,
      user.id, panel.id, username, created.id ?? null, subPath, limit || 0, limit || 0, expire || null, expire || null, now, now);
  }
  return first(env, 'SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = ?', user.id, panel.id);
}

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
async function cursor(env, job, panelId) {
  return (await first(env, 'SELECT offset FROM sync_cursor WHERE job = ? AND panel_id = ?', job, panelId))?.offset || 0;
}
async function setCursor(env, job, panelId, offset) {
  await run(env, `INSERT INTO sync_cursor (job, panel_id, offset, run_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(job, panel_id) DO UPDATE SET offset = excluded.offset, run_at = excluded.run_at`, job, panelId, offset, nowSec());
}

// Read one page of one panel (round robin over panels that still have accounts to count).
async function syncPage(env) {
  const panels = (await listPanels(env)).filter((p) => ['active', 'rollout', 'draining'].includes(p.state));
  if (!panels.length) return null;
  const turn = (await cursor(env, 'rr', 0)) % panels.length;
  const panel = panels[turn];
  const offset = await cursor(env, 'usage', panel.id);
  const touched = new Set();
  let wrapped = false;
  try {
    const page = await (await adapterFor(env, panel)).listUsage(offset, PAGE);
    const names = page.users.map((u) => u.username);
    const byName = Object.fromEntries(page.users.map((u) => [u.username, u]));
    for (let i = 0; i < names.length; i += 90) { // D1 caps bound parameters per query
      const chunk = names.slice(i, i + 90);
      const rows = await all(env, `SELECT * FROM panel_accounts WHERE panel_id = ? AND remote_username IN (${chunk.map(() => '?').join(',')})`, panel.id, ...chunk);
      for (const pa of rows) { await observe(env, pa, byName[pa.remote_username]); touched.add(pa.user_id); }
    }
    await recordHealth(env, panel.id, true);
    const next = offset + page.users.length;
    wrapped = !page.users.length || next >= page.total;
    await setCursor(env, 'usage', panel.id, wrapped ? 0 : next);
  } catch (e) {
    await recordHealth(env, panel.id, false);
    // this page's accounts stay counted at their last reading; mark them stale
    await run(env, 'UPDATE usage_counters SET stale = 1 WHERE panel_id = ? AND period_id IN (SELECT period_id FROM subscriptions)', panel.id);
    wrapped = true; // do not stay stuck on a broken panel
  }
  if (wrapped) {
    await setCursor(env, 'rr', 0, turn + 1);
    if (panel.state === 'draining') await finishDrain(env, panel);
  }
  return { panel: panel.id, touched: [...touched] };
}

// A draining panel has been read one last time: switch its accounts off (kept in the database) and disable it.
async function finishDrain(env, panel) {
  await run(env, "UPDATE panel_accounts SET desired = 'removed', dirty = 1, attempts = 0 WHERE panel_id = ? AND desired != 'removed'", panel.id);
  await run(env, "UPDATE panels SET state = 'disabled', disabled_at = ? WHERE id = ? AND state = 'draining'", nowSec(), panel.id);
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
    await ensureAccount(env, { id: s.user_id, email: s.email }, panel, { expire: s.expires_at, limit: left });
  } catch (e) {
    await recordHealth(env, panel.id, false);
    await noteCreateError(env, panel, e);
    return false;
  }
  await clearCreateError(env, panel);
  return true;
}

// Users with a running subscription who are missing an account on a panel they belong to (a new panel being
// rolled out, or users of a removed panel). A few per run.
async function createMissing(env, max = CREATE_PER_RUN) {
  const panels = (await listPanels(env)).filter((p) => ['active', 'rollout'].includes(p.state));
  let made = 0;
  for (const panel of panels) {
    if (made >= max) break;
    const rows = await all(env, `SELECT s.*, u.email FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.state = 'active' AND u.is_active = 1 AND s.period_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM panel_accounts a WHERE a.user_id = s.user_id AND a.panel_id = ?)
      ORDER BY s.user_id LIMIT 50`, panel.id);
    for (const s of rows) {
      if (made >= max) break;
      const mine = await panelsFor(env, s.user_id);
      if (!mine.some((p) => p.id === panel.id)) continue;
      if (await createFor(env, s, panel)) made++;
      else break; // this panel refuses now; try it again next run
    }
  }
  return made;
}

// The app is asking for this user's servers: make the user's missing account on a new panel now, so its
// configs are in this very answer. At most one panel per request, and never a panel that is unhealthy or
// refused a create in the last minutes (the app must not wait on a broken panel).
export async function ensureMissingFor(env, userId) {
  const s = await first(env, `SELECT s.*, u.email FROM subscriptions s JOIN users u ON u.id = s.user_id
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

// One cron slice. Returns what it did (for tests and logs).
export async function runSync(env) {
  const out = { page: null, expired: 0, pushed: 0, created: 0 };
  out.page = await syncPage(env);
  for (const uid of out.page ? out.page.touched : []) await evaluate(env, uid);
  // expiry needs no panel reading
  const due = await all(env, "SELECT user_id FROM subscriptions WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= ? LIMIT 50", nowSec());
  for (const r of due) { await evaluate(env, r.user_id); out.expired++; }
  const push = await pushPending(env);
  out.pushed = push.done;
  out.created = await createMissing(env, Math.max(2, Math.min(CREATE_PER_RUN, Math.floor((SUBREQ_BUDGET - push.tried) / 4))));
  return out;
}
