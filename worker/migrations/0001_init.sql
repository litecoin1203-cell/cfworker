-- Cloud Gold store schema for Cloudflare D1 (SQLite).

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  wallet_balance INTEGER NOT NULL DEFAULT 0,          -- toman
  referral_code TEXT UNIQUE NOT NULL,
  referred_by_id INTEGER,
  token_version INTEGER NOT NULL DEFAULT 0,
  trial_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  duration_days INTEGER NOT NULL,
  data_limit_gb INTEGER NOT NULL DEFAULT 0,
  device_limit INTEGER NOT NULL DEFAULT 0,
  price_toman INTEGER NOT NULL,
  old_price_toman INTEGER NOT NULL DEFAULT 0,
  badge TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  trial_days INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  pg_username TEXT NOT NULL,
  plan_id INTEGER,
  expires_at INTEGER,
  data_limit_bytes INTEGER NOT NULL DEFAULT 0,
  device_limit INTEGER NOT NULL DEFAULT 0,
  sub_url TEXT NOT NULL DEFAULT '',
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                                  -- plan | topup
  plan_id INTEGER,
  amount_toman INTEGER NOT NULL,
  method TEXT NOT NULL,                                -- wallet | card | crypto
  status TEXT NOT NULL DEFAULT 'pending',             -- pending|review|paid|rejected|cancelled|expired
  receipt_ref TEXT,
  receipt_file_id TEXT,                               -- Telegram file_id of the uploaded receipt photo
  crypto_invoice_id TEXT,
  crypto_pay_url TEXT,
  crypto_amount_usd TEXT,
  admin_note TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

CREATE TABLE IF NOT EXISTS wallet_tx (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  order_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(order_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_tx(user_id);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  last_seen INTEGER NOT NULL,
  UNIQUE(user_id, device_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
