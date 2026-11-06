-- Admin control panel, stage 5: indexes for the stats screen (today / 7 / 30 days). Additive only.
CREATE INDEX IF NOT EXISTS idx_orders_status_paid ON orders(status, paid_at);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_sub_periods_end ON sub_periods(end_reason, ended_at);
-- the broadcast queue: the one that is sending
CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status);
