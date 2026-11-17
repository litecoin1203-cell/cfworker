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
import { adapterFor, listPanels, panelsFor, pickPanels, recordHealth, accountsOf, groupIdsFor, USER_PATH_MS, userPathMs, noteUserPathFail, noteUserPathOk } from './panels.js';

export const PAGE = 200;            // users read per panel request
const PUSH_PER_RUN = 15;            // pending panel writes per cron run
const CREATE_PER_RUN = 8;           // missing panel accounts created per cron run (fewer when pushes used the budget)
const SUBREQ_BUDGET = 44;           // of the 50 a Free-plan run may make; a create costs up to about 4
const ERR_NOTIFY_EVERY = 6 * 3600;  // the admin hears about one panel refusing new accounts at most this often
const CREATE_QUIET_MS = 10 * 60 * 1000; // after a look that found no missing account, the next one is 10 minutes away
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
  FROM panel_accounts a JOIN subscriptions s ON s.user_id = a.user_id AND s.period_id IS NOT NULL AND a.applied != 'pending'
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
  FROM panel_accounts a JOIN panels p ON p.id = a.panel_id AND a.applied != 'pending'`; // PNL-02: a pending row is settled by ensureAccount / settlePending

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
      noteUserPathOk(a.panel_id);
      if (!u) { missing++; return; }
      reached++;
      readings.set(a.id, { used: parseInt(u.used_traffic || 0, 10) || 0, expire: parseExpire(u.expire), data_limit: parseInt(u.data_limit || 0, 10) || 0, online: parseExpire(u.online_at) });
    } catch (e) {
      if (!(e instanceof PasarGuardError) || !e.status) noteUserPathFail(a.panel_id); // no answer, not a refusal
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
//
// PNL-02: the panel is changed before D1 is written, and an invocation can end in between (the 50th query, the 30 s
// waitUntil cut, a D1 error). So the row is written FIRST, as an intent: applied = 'pending', the name about to be
// created, dirty = 1, no link. A pending row serves nothing, is read by nobody and is never pushed (LEDGER_SQL,
// PENDING_SQL, accountsOf skip it). The next try uses the same name; when the panel says it is taken (409) and the
// account there carries this user's note ("Pleat #<id>"), it is the one made before and is adopted (set to the
// wanted expiry and limit) instead of a second account being made. A pending row nobody finishes is settled by the
// sync job (settlePending): adopted when the account exists and is this user's, deleted otherwise.
export async function ensureAccount(env, user, panel, { expire, limit, hwid } = {}) {
  const pg = await adapterFor(env, panel);
  const pa = await first(env, 'SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = ?', user.id, panel.id);
  const now = nowSec();
  if (pa && pa.applied !== 'pending' && (await pg.getUser(pa.remote_username))) return pa;
  const groups = await groupIdsFor(env, panel, pg);
  let rowId = pa ? pa.id : null;
  let recorded = pa ? pa.remote_username : null;
  const intent = async (name) => {
    if (name === recorded) return;
    if (rowId) {
      // a later name (the earlier one was taken); a name another row holds is left as it was
      try { await run(env, "UPDATE panel_accounts SET remote_username = ? WHERE id = ? AND applied = 'pending'", name, rowId); recorded = name; } catch (e) { /* kept */ }
      return;
    }
    const r = await pendingRow(env, user.id, panel.id, name, { expire, limit, now }).run();
    if (r.meta.changes) { rowId = r.meta.last_row_id; recorded = name; }
  };
  user = await withTelegram(env, user);
  const names = (await freeNames(env, panel.id, [user], prefixOf(env))).get(user.id);
  const made = await createRemote(env, pg, user, { expire, limit, hwid, groups, name: pa ? pa.remote_username : null, names, intent });
  const done = rowId && (await run(env, `UPDATE panel_accounts SET remote_username = ?, remote_id = ?, sub_path = ?, desired = 'active', applied = 'active',
      desired_limit_bytes = ?, applied_limit_bytes = ?, desired_expire = ?, applied_expire = ?, dirty = 0, attempts = 0, last_error = NULL, applied_at = ? WHERE id = ?`,
  made.username, made.id, made.subPath, limit || 0, limit || 0, expire || null, expire || null, now, rowId)).meta.changes;
  // no row to finish (none was written, or the sync job dropped a stale intent meanwhile): the account gets a new one
  if (!done) await insertAccount(env, user.id, panel.id, made, { expire, limit, now }).run();
  return first(env, 'SELECT * FROM panel_accounts WHERE user_id = ? AND panel_id = ?', user.id, panel.id);
}

// the intent row written before an account is created on a panel (see ensureAccount)
const pendingRow = (env, userId, panelId, name, { expire, limit, now }) => st(env, `INSERT INTO panel_accounts (user_id, panel_id, remote_username, sub_path,
    desired, applied, desired_limit_bytes, applied_limit_bytes, desired_expire, dirty, attempts, created_at)
    VALUES (?, ?, ?, '', 'active', 'pending', ?, 0, ?, 1, 0, ?) ON CONFLICT DO NOTHING`, userId, panelId, name, limit || 0, expire || null, now);

// "Pleat #<id>" (and the older "Pleat · #<id> · ..."): the account on the panel was made by this Worker for this user
export const ownedBy = (remote, userId) => !!remote && new RegExp(`(^|[^0-9])#${Number(userId)}([^0-9]|$)`).test(String(remote.note || ''));

// Account names (owner's rule, 2026-11-17; replaces PNL-07's random names): a new account is named after the person's
// Telegram identity so the owner can find it on the panel: the @username, else the Telegram display name (Persian
// letters spelled in Latin, emoji and other symbols dropped) when 3+ usable characters with a letter remain, else
// the numeric Telegram id. Without Telegram (email only) it is <prefix>_<random hex>. The note stays "Pleat #<user
// id>" (no Telegram id or email; the bot maps an account back to its user through panel_accounts). A name is fixed
// at creation: a later Telegram change does not rename it (Marzban's subscription token depends on the name, and
// every lookup goes by the stored remote_username). Rules of all three panels (Marzban/Rebecca USERNAME_REGEXP,
// PasarGuard): 3-32 characters; only [a-z0-9_] are used here, never a leading/trailing or doubled "_".
const FA_LATIN = {
  'ا': 'a', 'آ': 'a', 'أ': 'a', 'إ': 'e', 'ٱ': 'a', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ث': 's', 'ج': 'j', 'چ': 'ch', 'ح': 'h',
  'خ': 'kh', 'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z', 'ژ': 'zh', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'z', 'ط': 't', 'ظ': 'z',
  'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'gh', 'ک': 'k', 'ك': 'k', 'گ': 'g', 'ل': 'l', 'م': 'm', 'ن': 'n', 'و': 'v', 'ؤ': 'o',
  'ه': 'h', 'ة': 'h', 'ۀ': 'h', 'ی': 'i', 'ي': 'i', 'ى': 'a', 'ئ': 'i', 'ء': '',
};
const NAME_MAX = 32;
const tidy = (x) => String(x).replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, NAME_MAX).replace(/_+$/, '');
// Latin letters and digits of a free-text name: accents dropped, Persian/Arabic letters and digits spelled in Latin,
// zero-width joiners and tatweel removed, anything else (emoji, symbols, other scripts) becomes a separator.
export function latinName(text) {
  const s = String(text || '').normalize('NFKD').replace(/[\u0300-\u036f\u064b-\u065f\u0670\u200b-\u200f\u0640]/g, '')
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  return tidy([...s].map((ch) => (ch in FA_LATIN ? FA_LATIN[ch] : ch)).join('').toLowerCase());
}
// The readable base of a user's account names, or null (no Telegram): @username > display name > numeric id.
export function panelNameBase(user) {
  const un = tidy(String(user.tg_username || '').toLowerCase());
  if (un.length >= 3) return un;
  const dn = latinName(user.tg_name);
  if (dn.length >= 3 && /[a-z]/.test(dn)) return dn;
  if (user.tg_id) return String(user.tg_id).replace(/[^0-9]/g, '').slice(0, NAME_MAX) || null;
  return null;
}
const fit = (base, suffix) => `${base.slice(0, NAME_MAX - suffix.length).replace(/_+$/, '')}${suffix}`;
// The names tried in order: the base, then with the user id, then with a random tail (a name the panel or another
// row already has moves on to the next). Without Telegram: three random <prefix>_<hex> names.
export function panelNames(user, prefix = 'cg') {
  const base = panelNameBase(user);
  if (!base) return [`${prefix}_${randomHex(5)}`, `${prefix}_${randomHex(5)}`, `${prefix}_${randomHex(6)}`].map((n) => n.slice(0, NAME_MAX));
  return [...new Set([base, fit(base, `_${user.id}`), fit(base, `_${randomHex(2)}`), fit(base, `_${randomHex(3)}`)])];
}

const prefixOf = (env) => String(env.PASARGUARD_USERNAME_PREFIX || 'cg').toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/_+$/, '') || 'cg';

// Candidate names for several users on one panel, without a name another account row on that panel already holds
// (UNIQUE (panel_id, remote_username) would silently drop the new row) or one given to an earlier user of this
// round. One D1 read for all of them. -> Map(user id -> names)
async function freeNames(env, panelId, users, prefix) {
  const cands = new Map(users.map((u) => [u.id, panelNames(u, prefix)]));
  const all_ = [...new Set([...cands.values()].flat())];
  const taken = new Set(all_.length ? (await all(env, 'SELECT remote_username FROM panel_accounts WHERE panel_id = ? AND remote_username IN (SELECT value FROM json_each(?))',
    panelId, JSON.stringify(all_))).map((r) => r.remote_username) : []);
  for (const [id, names] of cands) {
    let left = names.filter((n) => !taken.has(n));
    if (!left.length) left = [`${prefix}_${randomHex(5)}`, `${prefix}_${randomHex(6)}`];
    for (const n of left) taken.add(n);
    cands.set(id, left);
  }
  return cands;
}

// a user object from a query may lack the Telegram fields (older callers): read them once
async function withTelegram(env, user) {
  if (user.tg_id !== undefined && user.tg_name !== undefined) return user;
  const row = await first(env, 'SELECT tg_id, tg_username, tg_name FROM users WHERE id = ?', user.id);
  return { ...user, tg_id: row ? row.tg_id : null, tg_username: row ? row.tg_username : null, tg_name: row ? row.tg_name : null };
}

// Make the account on the panel; a name the panel says is taken (409) moves on to the next one. {username, id, subPath}
// intent(name) runs before each try (PNL-02: the name is recorded before the panel is asked). A taken name whose
// account carries this user's note was made by an earlier try that never reached D1: it is adopted, not doubled.
async function createRemote(env, pg, user, { expire, limit, hwid, groups, name, names: given, intent }) {
  const base = given || panelNames(user, prefixOf(env));
  const names = name ? [name, ...base.filter((n) => n !== name)] : [...base];
  let created = null, username = '';
  for (let attempt = 0; attempt < names.length && !created; attempt++) {
    username = names[attempt];
    if (intent) await intent(username);
    try {
      created = await pg.createUser(username, { expire, dataLimit: limit, groupIds: groups, hwidLimit: hwid || null, note: noteFor(user) });
    } catch (e) {
      if (e instanceof PasarGuardError && e.status === 409) {
        const there = await pg.getUser(username).catch(() => null);
        if (ownedBy(there, user.id)) {
          const fields = { status: 'active', expire: expire || 0, data_limit: limit || 0, data_limit_reset_strategy: 'no_reset' };
          if (hwid) fields.hwid_limit = hwid;
          const out = await pg.modifyUser(username, fields);
          created = out && out.subscription_url ? out : there;
          break;
        }
        if (attempt < names.length - 1) continue; // name taken by someone else, try the next
      }
      throw e;
    }
  }
  const subPath = pg.absoluteSubUrl(created.subscription_url || '');
  if (!subPath) throw new PasarGuardError('panel created the user but returned no subscription link', 0);
  return { username, id: created.id ?? null, subPath };
}
const noteFor = (user) => `Pleat #${user.id}`; // PNL-07: no Telegram id, @username or email on a panel

// The new account's row; it finishes this user's pending intent row on that panel (PNL-02). Another path (the app
// opening at the same moment) may have made a real one first: then that one stays, and this statement changes
// nothing instead of failing the batch it is in.
const insertAccount = (env, userId, panelId, made, { expire, limit, now }) => st(env, `INSERT INTO panel_accounts (user_id, panel_id, remote_username, remote_id, sub_path, desired, applied,
    desired_limit_bytes, applied_limit_bytes, desired_expire, applied_expire, applied_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', 'active', ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, panel_id) DO UPDATE SET remote_username = excluded.remote_username, remote_id = excluded.remote_id, sub_path = excluded.sub_path,
      desired = 'active', applied = 'active', desired_limit_bytes = excluded.desired_limit_bytes, applied_limit_bytes = excluded.applied_limit_bytes,
      desired_expire = excluded.desired_expire, applied_expire = excluded.applied_expire, dirty = 0, attempts = 0, last_error = NULL, applied_at = excluded.applied_at
      WHERE panel_accounts.applied = 'pending'
    ON CONFLICT DO NOTHING`,
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
  if (old && old.remote_username !== remote.username && (old.applied !== 'pending' || ownedBy(await pg.getUser(old.remote_username).catch(() => null), user.id))) {
    replaced = old.remote_username; // a pending intent's name is switched off only when that account is this user's (PNL-02)
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
  if (old && old.remote_username !== remote.username && (old.applied !== 'pending' || ownedBy(await pg.getUser(old.remote_username).catch(() => null), user.id))) {
    replaced = old.remote_username; // a pending intent's name is switched off only when that account is this user's (PNL-02)
    try { await pg.setStatus(replaced, 'disabled'); disabled = true; } catch (e) { /* the admin is told to switch it off by hand */ }
  }
  // evaluate() only rewrites limits that drifted, so make every account's limit be recomputed now
  await run(env, 'UPDATE panel_accounts SET applied_limit_bytes = -1 WHERE user_id = ? AND panel_id = ?', user.id, panel.id);
  await evaluate(env, user.id);
  await pushPending(env, { userId: user.id });
  return { replaced, disabled, merged: true };
}

// ---------------- remake a user's accounts under the Telegram name (owner's ask, 2026-11-17) ----------------
// No panel can rename an account (Marzban / PasarGuard / Rebecca UserModify have no username), so an account with
// an older name (random cg_<hex>, or a Telegram name that changed) is made again: a new account named per
// panelNames with the old one's expiry, what is left of its data and its device limit; the link row and the usage
// counter move to it in one batch (what the old account used since the last reading is counted first), then the old
// account is deleted on the panel (switched off when the delete is refused). The app reads configs live through
// sub_path, so its next server list has the new account's configs. Panels one after another; one panel failing
// leaves that account as it was. Accounts already named after the Telegram base are skipped; a cgtunnel_ account is
// never touched. -> {done: [{panel, from, to, deleted}], skipped: [{panel, name, why}], failed: [{panel, name, error}]}
export async function remakeAccounts(env, userId) {
  const user = await first(env, 'SELECT id, email, tg_id, tg_username, tg_name FROM users WHERE id = ?', userId);
  const out = { done: [], skipped: [], failed: [] };
  if (!user) return out;
  const base = panelNameBase(user);
  const rows = await all(env, `SELECT a.*, p.kind, p.state AS panel_state, p.cred_ref, p.options_json, p.label AS panel_label FROM panel_accounts a
    JOIN panels p ON p.id = a.panel_id WHERE a.user_id = ? AND a.applied != 'pending' AND a.desired != 'removed' ORDER BY a.panel_id`, user.id);
  const sub = await first(env, 'SELECT period_id FROM subscriptions WHERE user_id = ?', user.id);
  for (const pa of rows) {
    const name = pa.remote_username;
    if (/^cgtunnel_/.test(name)) { out.skipped.push({ panel: pa.panel_id, name, why: 'tunnel' }); continue; }
    if (pa.panel_state === 'disabled') { out.skipped.push({ panel: pa.panel_id, name, why: 'panel_off' }); continue; }
    if (base && (name === base || new RegExp(`^${base}_[0-9a-f]+$`).test(name))) { out.skipped.push({ panel: pa.panel_id, name, why: 'named' }); continue; }
    if (!base && name.startsWith(`${prefixOf(env)}_`)) { out.skipped.push({ panel: pa.panel_id, name, why: 'no_telegram' }); continue; }
    try {
      const pg = await adapterFor(env, panelOf(pa));
      const old = await pg.getUser(name);
      if (!old) { out.failed.push({ panel: pa.panel_id, name, error: 'not_found' }); continue; }
      const used = Math.max(0, parseInt(old.used_traffic || 0, 10) || 0);
      const lim = parseInt(old.data_limit || 0, 10) || 0;
      const limit = lim > 0 ? Math.max(1, lim - used) : 0;
      const expire = parseExpire(old.expire) || null;
      const hwid = parseInt(old.hwid_limit || 0, 10) || null;
      const on = String(old.status || 'active') === 'active';
      const names = (await freeNames(env, pa.panel_id, [user], prefixOf(env))).get(user.id);
      const groups = await groupIdsFor(env, panelOf(pa), pg);
      const made = await createRemote(env, pg, user, { expire, limit, hwid, groups, names });
      if (!on) { try { await pg.setStatus(made.username, 'disabled'); } catch (e) { /* the push below switches it off */ } }
      const now = nowSec();
      const stmts = [
        // the new account already has the wanted numbers; one made for a switched-off account is pushed again
        st(env, `UPDATE panel_accounts SET remote_username = ?, remote_id = ?, sub_path = ?, applied = ?, applied_limit_bytes = ?, desired_limit_bytes = ?,
          applied_expire = ?, dirty = ?, attempts = 0, last_error = NULL, applied_at = ? WHERE id = ? AND remote_username = ?`,
        made.username, made.id, made.subPath, on ? 'active' : 'stopped', limit, limit, expire, on ? 0 : 1, now, pa.id, name),
        st(env, "UPDATE subscriptions SET pg_username = ?, sub_url = '' WHERE user_id = ? AND ? = 1 AND pg_username = ?", made.username, user.id, pa.panel_id, name),
      ];
      // the old account's last bit of usage counts, and the new account's counter starts at 0
      if (sub && sub.period_id) {
        stmts.push(st(env, `UPDATE usage_counters SET accounted_bytes = accounted_bytes + CASE WHEN ?1 >= last_remote_bytes THEN ?1 - last_remote_bytes ELSE ?1 END,
          last_remote_bytes = 0, baseline_pending = 0, stale = 0, last_seen_at = ?2 WHERE period_id = ?3 AND panel_id = ?4`, used, now, sub.period_id, pa.panel_id));
      }
      const res = await env.DB.batch(stmts);
      if (!Number((res[0].meta && res[0].meta.changes) || 0)) {
        // the row changed meanwhile (unlinked, linked again): the new account is not used, so it goes
        try { await pg.deleteUser(made.username); } catch (e) { /* left on the panel; it carries this user's note */ }
        out.failed.push({ panel: pa.panel_id, name, error: 'changed' });
        continue;
      }
      let deleted = true;
      try { await pg.deleteUser(name); } catch (e) {
        deleted = false;
        try { await pg.setStatus(name, 'disabled'); } catch (x) { /* reported: the admin can remove it by hand */ }
      }
      out.done.push({ panel: pa.panel_id, from: name, to: made.username, deleted });
    } catch (e) {
      out.failed.push({ panel: pa.panel_id, name, error: String(e && e.message ? e.message : e).slice(0, 120) });
    }
  }
  if (out.done.length) {
    // the per-panel caps are worked out again (own reading is 0 now) and pushed
    await evaluate(env, user.id);
    await pushPending(env, { userId: user.id });
  }
  return out;
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

// the user of a subscriptions-join-users row, as the account-naming code wants it
const whoOf = (s) => ({ id: s.user_id, email: s.email, tg_id: s.tg_id, tg_username: s.tg_username, tg_name: s.tg_name ?? null });

// One missing account for this subscription on this panel, with what is left of the plan. true = made.
async function createFor(env, s, panel) {
  const left = s.data_limit_bytes > 0 ? Math.max(1, s.data_limit_bytes - s.used_bytes) : 0;
  try {
    await ensureAccount(env, whoOf(s), panel, { expire: s.expires_at, limit: left });
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
    // a user whose only row here is a pending intent (PNL-02) is still missing: it is tried again under that name
    const rows = await all(env, `SELECT s.*, u.email, u.tg_id, u.tg_username, u.tg_name,
        (SELECT a.remote_username FROM panel_accounts a WHERE a.user_id = s.user_id AND a.panel_id = ? AND a.applied = 'pending') AS pending_name
      FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.state = 'active' AND u.is_active = 1 AND s.period_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM panel_accounts a WHERE a.user_id = s.user_id AND a.panel_id = ? AND a.applied != 'pending')
      ORDER BY s.user_id LIMIT 50`, panel.id, panel.id);
    const want = rows.filter((s) => pickPanels(allPanels, s.user_id).some((p) => p.id === panel.id)).slice(0, max - made);
    if (!want.length) continue;
    const now = nowSec();
    const stmts = [];
    let failed = null, inserted = 0;
    const leftOf = (s) => (s.data_limit_bytes > 0 ? Math.max(1, s.data_limit_bytes - s.used_bytes) : 0);
    // PNL-02: the intents of this round in one batch, before any of them is created on the panel
    const fresh = want.filter((s) => !s.pending_name);
    if (fresh.length) {
      const names = await freeNames(env, panel.id, fresh.map(whoOf), prefixOf(env));
      for (const s of fresh) { s.names = names.get(s.user_id); s.pending_name = s.names[0]; }
      await batch(env, fresh.map((s) => pendingRow(env, s.user_id, panel.id, s.pending_name, { expire: s.expires_at, limit: leftOf(s), now })));
    }
    try {
      const pg = await adapter(panel);
      const groups = await groupIdsFor(env, panel, pg);
      for (const s of want) {
        const limit = leftOf(s);
        const intent = async (name) => {
          if (name === s.pending_name) return;
          try { await run(env, "UPDATE panel_accounts SET remote_username = ? WHERE user_id = ? AND panel_id = ? AND applied = 'pending'", name, s.user_id, panel.id); s.pending_name = name; } catch (e) { /* kept */ }
        };
        const acct = await createRemote(env, pg, whoOf(s), { expire: s.expires_at, limit, groups, name: s.pending_name, names: s.names, intent });
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
  const s = await first(env, `SELECT s.*, u.email, u.tg_id, u.tg_username, u.tg_name FROM subscriptions s JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ? AND s.state = 'active' AND s.period_id IS NOT NULL`, userId);
  if (!s || (s.expires_at && s.expires_at <= nowSec())) return false;
  const have = new Set((await all(env, "SELECT panel_id FROM panel_accounts WHERE user_id = ? AND applied != 'pending'", userId)).map((r) => r.panel_id));
  for (const panel of await panelsFor(env, userId)) {
    if (have.has(panel.id) || panel.fail_streak >= 3) continue;
    const e = await createError(env, panel.id);
    if (e && nowSec() - e.at < QUIET_AFTER_ERROR) continue;
    return createFor(env, s, panel);
  }
  return false;
}

// PNL-02: intent rows nobody finished (the invocation ended between the panel and D1, and the user is not retried
// by createMissing: plan over, panel no longer theirs). After PENDING_STALE seconds each is looked up on its panel:
// an account with this user's note is adopted as a real row (dirty, so the push gives it the wanted state: switched
// off when the plan is over); no account, or someone else's, and the row is deleted (a later create starts afresh).
// A few per run; pending rows are dirty = 1, so this read uses the small dirty index.
const PENDING_STALE = 1800;
async function settlePending(env, adapter, max = 2) {
  const rows = await all(env, `SELECT a.*, p.kind, p.state AS panel_state, p.cred_ref, p.options_json FROM panel_accounts a JOIN panels p ON p.id = a.panel_id
    WHERE a.dirty = 1 AND a.applied = 'pending' AND a.created_at < ? ORDER BY a.attempts, a.id LIMIT ?`, nowSec() - PENDING_STALE, max);
  const stmts = [];
  for (const pa of rows) {
    try {
      const pg = await adapter(panelOf(pa));
      const u = await pg.getUser(pa.remote_username);
      if (ownedBy(u, pa.user_id)) {
        // kept running only for a user whose plan is running now; otherwise (a refunded purchase, a plan that ended)
        // it is taken over switched off
        stmts.push(st(env, `UPDATE panel_accounts SET remote_id = ?, sub_path = ?, applied = ?, applied_limit_bytes = -1, applied_expire = ?, dirty = 1, attempts = 0,
          last_error = NULL, applied_at = ?, desired = CASE WHEN EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = panel_accounts.user_id AND s.state = 'active'
            AND (s.expires_at IS NULL OR s.expires_at > ?)) THEN desired ELSE 'stopped' END
          WHERE id = ? AND applied = 'pending'`, u.id ?? null, pg.absoluteSubUrl(u.subscription_url || ''),
        String(u.status || 'active') === 'active' ? 'active' : 'stopped', parseExpire(u.expire), nowSec(), nowSec(), pa.id));
      } else {
        // only the intent as it was read: one a purchase is finishing right now has moved on (and re-inserts if not)
        stmts.push(st(env, "DELETE FROM panel_accounts WHERE id = ? AND applied = 'pending' AND remote_username = ? AND attempts = ?", pa.id, pa.remote_username, pa.attempts));
      }
    } catch (e) {
      // panel not answering: tried again later, after the others (a dead panel must not hold up the rest)
      stmts.push(st(env, "UPDATE panel_accounts SET attempts = attempts + 1, last_error = ? WHERE id = ? AND applied = 'pending'",
        e instanceof PasarGuardError ? `panel_${e.status || 'net'}` : 'error', pa.id));
    }
  }
  await batch(env, stmts);
  return stmts.length;
}

// For the bot: how many of the users this panel should serve already have their account on it.
export async function panelProgress(env, panel) {
  const subs = await all(env, `SELECT user_id FROM subscriptions WHERE state = 'active' AND period_id IS NOT NULL`);
  const { bucketOf } = await import('./panels.js');
  const want = panel.state === 'active' ? subs : panel.state === 'rollout' ? subs.filter((r) => bucketOf(r.user_id, panel.id) < panel.rollout_percent) : [];
  if (!want.length) return { want: 0, have: 0 };
  const has = new Set((await all(env, "SELECT user_id FROM panel_accounts WHERE panel_id = ? AND desired = 'active' AND applied != 'pending'", panel.id)).map((r) => r.user_id));
  return { want: want.length, have: want.filter((r) => has.has(r.user_id)).length };
}

// One cron slice. Returns what it did (for tests and logs). Each part runs even when an earlier one failed, so
// a broken panel or one bad row never stops expiry, pushes or new accounts.
// spent = subrequests this cron run already made elsewhere (the chain scan); the pushes and creates shrink to fit.
export async function runSync(env, { spent = 0 } = {}) {
  const out = { page: null, expired: 0, pushed: 0, created: 0 };
  const budget = Math.max(8, SUBREQ_BUDGET - spent);
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
  await part('pending', async () => { out.settled = await settlePending(env, adapter); });
  await part('push', async () => { const push = await pushPending(env, { adapter, limit: Math.max(2, Math.min(PUSH_PER_RUN, budget - 8)) }); out.pushed = push.done; tried = push.tried; });
  await part('create', async () => {
    // Looking for missing accounts reads every running subscription once per panel (D1 bills rows read; the Free
    // plan allows 5 million a day). When a look finds nothing, this isolate skips the next ones for a while: the
    // app makes a missing account itself when it opens (ensureMissingFor), so this is only the backstop.
    const quiet = globalThis.__cgNoMissingUntil || 0;
    if (Date.now() < quiet) { out.createSkipped = true; return; }
    out.created = await createMissing(env, panels, adapter, Math.max(0, Math.min(CREATE_PER_RUN, Math.floor((budget - tried) / 4))));
    globalThis.__cgNoMissingUntil = out.created ? 0 : Date.now() + CREATE_QUIET_MS;
  });
  return out;
}

// "Sync now" from the bot or the Mini App: one runSync in the admin's own request (its own subrequest budget),
// at most once a minute. Returns {wait: true}, {ok: true, pushed, created, expired} or {ok: false} (logged).
export async function manualSync(env) {
  const t = await first(env, "SELECT value FROM settings WHERE key = 'sync_manual_at'");
  if (t && nowSec() - parseInt(t.value, 10) < 60) return { wait: true };
  await run(env, `INSERT INTO settings (key, value) VALUES ('sync_manual_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, String(nowSec()));
  try {
    const out = await runSync(env, { spent: 6 });
    return { ok: true, pushed: out.pushed || 0, created: out.created || 0, expired: out.expired || 0 };
  } catch (e) { logError('manual sync failed', e); return { ok: false }; }
}
