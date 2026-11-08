-- Last connection time per panel account, as the panel reports it (online_at). Stored only on the usage write
-- that happens anyway when the account's traffic moved, so it adds no D1 writes. Additive only.
ALTER TABLE usage_counters ADD COLUMN online_at INTEGER;
