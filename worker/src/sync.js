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
const CREATE_PER_RUN = 3;           // missing panel accounts created per cron run
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
    const pg = adapterFor(env, panel);
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
      const u = await adapterFor(env, { id: a.panel_id, kind: a.kind, cred_ref: a.cred_ref }).getUser(a.remote_username);
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
  const pg = adapterFor(env, panel);
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
    const page = await adapterFor(env, panel).listUsage(offset, PAGE);
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

// Users with a running subscription who are missing an account on a panel they belong to (a new panel being
// rolled out, or users of a removed panel). A few per run.
async function createMissing(env) {
  const panels = (await listPanels(env)).filter((p) => ['active', 'rollout'].includes(p.state));
  let made = 0;
  for (const panel of panels) {
    if (made >= CREATE_PER_RUN) break;
    const rows = await all(env, `SELECT s.*, u.email FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.state = 'active' AND s.period_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM panel_accounts a WHERE a.user_id = s.user_id AND a.panel_id = ?)
      ORDER BY s.user_id LIMIT 50`, panel.id);
    for (const s of rows) {
      if (made >= CREATE_PER_RUN) break;
      const mine = await panelsFor(env, s.user_id);
      if (!mine.some((p) => p.id === panel.id)) continue;
      const left = s.data_limit_bytes > 0 ? Math.max(1, s.data_limit_bytes - s.used_bytes) : 0;
      try {
        await ensureAccount(env, { id: s.user_id, email: s.email }, panel, { expire: s.expires_at, limit: left });
        made++;
      } catch (e) {
        await recordHealth(env, panel.id, false);
        break; // this panel refuses now; try it again next run
      }
    }
  }
  return made;
}

// One cron slice. Returns what it did (for tests and logs).
export async function runSync(env) {
  const out = { page: null, expired: 0, pushed: 0, created: 0 };
  out.page = await syncPage(env);
  for (const uid of out.page ? out.page.touched : []) await evaluate(env, uid);
  // expiry needs no panel reading
  const due = await all(env, "SELECT user_id FROM subscriptions WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= ? LIMIT 50", nowSec());
  for (const r of due) { await evaluate(env, r.user_id); out.expired++; }
  out.pushed = (await pushPending(env)).done;
  out.created = await createMissing(env);
  return out;
}
