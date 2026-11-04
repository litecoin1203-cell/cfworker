-- Sign up / log in with Telegram. The numeric Telegram id is the identity (it never changes); the @username is
-- only a login alias that follows the user's current Telegram username. Email accounts are untouched.
ALTER TABLE users ADD COLUMN tg_id INTEGER;
ALTER TABLE users ADD COLUMN tg_username TEXT;   -- lower case, without "@"; NULL when the user has none
ALTER TABLE users ADD COLUMN tg_name TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tg_id ON users(tg_id) WHERE tg_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tg_username ON users(tg_username) WHERE tg_username IS NOT NULL;

-- One row per "Continue with Telegram" tap. The app keeps the nonce (only its hash is stored); the bot fills in
-- who opened the link and a 6-digit code (hashed). Logging in needs both the nonce and the code.
CREATE TABLE IF NOT EXISTS tg_logins (
  nonce_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,          -- the link itself (10 min)
  tg_id INTEGER,
  tg_username TEXT,
  tg_name TEXT NOT NULL DEFAULT '',
  code_hash TEXT,
  code_expires_at INTEGER,              -- the code (5 min)
  codes_sent INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,  -- wrong codes typed (max 5)
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tg_logins_expires ON tg_logins(expires_at);
