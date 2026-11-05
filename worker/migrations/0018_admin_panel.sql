-- Admin control panel, stage 1. Additive only: nothing is dropped or rewritten.

-- The bot's open question or multi-step form, one per admin chat (replaces settings.bot_wait).
CREATE TABLE IF NOT EXISTS bot_session (
  admin_id TEXT PRIMARY KEY,
  flow TEXT NOT NULL,                 -- ask (one answer -> a command) | a form name (newplan, coupon...)
  step INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL DEFAULT '{}',
  back TEXT,                          -- the screen to return to
  secret INTEGER NOT NULL DEFAULT 0,  -- 1 = the answer is deleted from the chat
  expires_at INTEGER NOT NULL
);
DELETE FROM settings WHERE key = 'bot_wait';

-- A plan with orders is archived instead of deleted (stage 3).
ALTER TABLE plans ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

-- Hide or rename one server of a panel in the app (stage 4).
CREATE TABLE IF NOT EXISTS server_overrides (
  panel_id INTEGER NOT NULL,
  server_key TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  PRIMARY KEY (panel_id, server_key)
);

-- A message to many users, sent a few at a time by the cron job (stage 5).
CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audience TEXT NOT NULL,             -- all | active | expired
  text TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,  -- last users.id done
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | sending | done | stopped
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Extra admins with a role. The owner (TELEGRAM_CHAT_ID) is never stored here.
CREATE TABLE IF NOT EXISTS admins (
  tg_id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'support', -- support | viewer
  added_at INTEGER NOT NULL
);

-- Undo for simple changes: what to put back, and when it was used (once, within 10 minutes).
ALTER TABLE admin_audit ADD COLUMN undo_json TEXT;
ALTER TABLE admin_audit ADD COLUMN undone_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_orders_status_time ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_time ON wallet_tx(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit(target_type, target_id);
