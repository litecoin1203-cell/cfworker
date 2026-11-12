-- The Worker's own error log for the admin bot's ☁️ Cloudflare section (cfmon.js). One row per kind of error
-- (its words with numbers taken out), counted; written by logError at most once a minute per kind, scrubbed of
-- addresses, emails, IPs and keys. Kept 14 days (pruned by the nightly cron).
CREATE TABLE IF NOT EXISTS worker_errors (
  fp TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_errors_last ON worker_errors (last_at);
CREATE INDEX IF NOT EXISTS idx_worker_errors_first ON worker_errors (first_at);
