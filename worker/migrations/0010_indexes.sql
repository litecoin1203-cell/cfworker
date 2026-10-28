-- Indexes for the lookups that ran as full table scans: open orders by payment method (chain watcher every
-- minute, each bank SMS, the unique card amount), txid reuse checks, the free-trial phone check and referrals.
CREATE INDEX IF NOT EXISTS idx_orders_open ON orders(method, status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_txid ON orders(txid) WHERE txid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_coupon ON orders(coupon_id) WHERE coupon_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_device ON devices(device_id);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by_id) WHERE referred_by_id IS NOT NULL;
