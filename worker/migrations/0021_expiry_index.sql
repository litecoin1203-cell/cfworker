-- The sync job asks every minute which running subscriptions ran out of days. Without an index that was a scan of
-- the whole subscriptions table each minute (D1 bills every row read; the Free plan allows 5 million a day).
CREATE INDEX IF NOT EXISTS idx_subscriptions_expiry ON subscriptions(state, expires_at) WHERE expires_at IS NOT NULL;
