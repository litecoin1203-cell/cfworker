-- Phase 1 control plane: the Worker, not a panel, is the source of truth for a user's subscription.
-- Each user is one logical account; it may have an account on every panel. Usage is summed across panels and
-- is never forgotten (a broken or removed panel keeps its last counted usage). Only additions: nothing existing
-- is dropped or rewritten, so the previous Worker version still runs on this schema.

-- Panels. Address and credentials never live here: cred_ref names a Workers Secret (PASARGUARD = the original
-- PASARGUARD_* secrets, PANEL_<id>_CRED for panels added later). label is for the admin bot only.
CREATE TABLE IF NOT EXISTS panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                          -- pasarguard | marzban | hiddify
  label TEXT NOT NULL,
  cred_ref TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',     -- non-secret options, e.g. {"group_ids":[1]}
  state TEXT NOT NULL DEFAULT 'new',           -- new | testing | rollout | active | draining | disabled
  rollout_percent INTEGER NOT NULL DEFAULT 0,  -- share of users (by hash of user id) while state = rollout
  health INTEGER NOT NULL DEFAULT 100,         -- 0..100 from the last checks
  fail_streak INTEGER NOT NULL DEFAULT 0,
  last_ok_at INTEGER,
  last_check_at INTEGER,
  version TEXT,                                -- panel version, read during the health test
  drain_started_at INTEGER,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
INSERT OR IGNORE INTO panels (id, kind, label, cred_ref, state, rollout_percent, created_at)
VALUES (1, 'pasarguard', 'پنل ۱', 'PASARGUARD', 'active', 100, CAST(strftime('%s', 'now') AS INTEGER));

-- One row per user per panel. desired is what the control plane wants, applied is what the panel last
-- confirmed; dirty = 1 means the sync job still has to push desired to the panel (retried until it sticks).
CREATE TABLE IF NOT EXISTS panel_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  panel_id INTEGER NOT NULL,
  remote_username TEXT NOT NULL,
  remote_id INTEGER,
  sub_path TEXT NOT NULL DEFAULT '',           -- this account's subscription link on that panel (server side only)
  desired TEXT NOT NULL DEFAULT 'active',      -- active | stopped | removed
  applied TEXT NOT NULL DEFAULT 'active',
  desired_limit_bytes INTEGER NOT NULL DEFAULT 0,
  applied_limit_bytes INTEGER NOT NULL DEFAULT 0,
  desired_expire INTEGER,
  applied_expire INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  applied_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, panel_id),
  UNIQUE (panel_id, remote_username)
);
CREATE INDEX IF NOT EXISTS idx_panel_accounts_dirty ON panel_accounts(dirty, attempts) WHERE dirty = 1;

-- The logical subscription (one row per user, as before) gains its state and the reason it stopped.
ALTER TABLE subscriptions ADD COLUMN period_id INTEGER;
ALTER TABLE subscriptions ADD COLUMN state TEXT NOT NULL DEFAULT 'active';   -- active | stopped
ALTER TABLE subscriptions ADD COLUMN stop_reason TEXT;                       -- quota | expired | admin
ALTER TABLE subscriptions ADD COLUMN used_bytes INTEGER NOT NULL DEFAULT 0;  -- sum over panels, this period
ALTER TABLE subscriptions ADD COLUMN used_at INTEGER;
ALTER TABLE subscriptions ADD COLUMN baselined INTEGER NOT NULL DEFAULT 0;   -- 0 = take expiry/limit from panel 1 once

-- Every bought, renewed or trial period: the profile's history of used and expired packages.
CREATE TABLE IF NOT EXISTS sub_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan_id INTEGER,
  order_id INTEGER,
  started_at INTEGER NOT NULL,
  expires_at INTEGER,
  limit_bytes INTEGER NOT NULL DEFAULT 0,
  ended_at INTEGER,
  end_reason TEXT,                             -- renewed | quota | expired | admin
  final_used_bytes INTEGER,
  legacy INTEGER NOT NULL DEFAULT 0            -- 1 = opened by this migration for an existing subscription
);
CREATE INDEX IF NOT EXISTS idx_sub_periods_user ON sub_periods(user_id, started_at);

-- Usage of one period on one panel. accounted_bytes only grows; a panel-side reset is detected and added on top.
CREATE TABLE IF NOT EXISTS usage_counters (
  period_id INTEGER NOT NULL,
  panel_id INTEGER NOT NULL,
  last_remote_bytes INTEGER NOT NULL DEFAULT 0,
  accounted_bytes INTEGER NOT NULL DEFAULT 0,
  baseline_pending INTEGER NOT NULL DEFAULT 0, -- 1 = next reading only sets the baseline (panel unreachable at renewal)
  last_seen_at INTEGER,
  stale INTEGER NOT NULL DEFAULT 0,            -- 1 = panel did not answer the last read; last value still counts
  PRIMARY KEY (period_id, panel_id)
);

-- Where the chunked sync job continues on its next cron run.
CREATE TABLE IF NOT EXISTS sync_cursor (
  job TEXT NOT NULL,
  panel_id INTEGER NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0,
  run_at INTEGER,
  PRIMARY KEY (job, panel_id)
);

-- Admin log: who did what, when. summary never holds a password, address or token.
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  summary TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit(created_at);

-- One-time "are you sure?" tokens for dangerous bot actions.
CREATE TABLE IF NOT EXISTS bot_confirm (
  token TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- Existing users: their current panel account becomes their panel-1 account, unchanged (same username, UUID
-- and link), and their current subscription gets an open period. Usage is read from the panel on first sync.
INSERT OR IGNORE INTO panel_accounts (user_id, panel_id, remote_username, sub_path, desired, applied,
  desired_limit_bytes, applied_limit_bytes, desired_expire, applied_expire, created_at)
SELECT user_id, 1, pg_username, sub_url, 'active', 'active', data_limit_bytes, data_limit_bytes, expires_at, expires_at,
  CAST(strftime('%s', 'now') AS INTEGER)
FROM subscriptions WHERE pg_username != '';

INSERT INTO sub_periods (user_id, plan_id, started_at, expires_at, limit_bytes, legacy)
SELECT s.user_id, s.plan_id, COALESCE(s.updated_at, CAST(strftime('%s', 'now') AS INTEGER)), s.expires_at, s.data_limit_bytes, 1
FROM subscriptions s WHERE s.period_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM sub_periods p WHERE p.user_id = s.user_id AND p.legacy = 1);

UPDATE subscriptions SET period_id = (SELECT p.id FROM sub_periods p WHERE p.user_id = subscriptions.user_id AND p.legacy = 1)
WHERE period_id IS NULL;
