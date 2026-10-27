-- Discount codes, "top up and activate a plan" and a few order details.

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  percent INTEGER NOT NULL,                 -- 1..100
  max_uses INTEGER NOT NULL DEFAULT 0,      -- 0 = no limit
  used INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,                       -- unix seconds, NULL = never
  plan_id INTEGER,                          -- NULL = every plan
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coupon_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  order_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(coupon_id, user_id)
);

ALTER TABLE orders ADD COLUMN coupon_id INTEGER;
ALTER TABLE orders ADD COLUMN list_price_toman INTEGER;
ALTER TABLE orders ADD COLUMN activate_plan_id INTEGER;
ALTER TABLE orders ADD COLUMN activate_price_toman INTEGER;
ALTER TABLE orders ADD COLUMN result_order_id INTEGER;
ALTER TABLE subscriptions ADD COLUMN period_days INTEGER;
