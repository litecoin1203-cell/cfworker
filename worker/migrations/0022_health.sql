-- Pleat's automatic health reports (health.js): crashes, failed connections, drops, location mismatches, battery.
-- One row = one problem on one user's phone on one day (fp = type + exit + cause); the same problem again only
-- raises its count, so a phone that fails the same exit fifty times costs one row. Kept 14 days (resolved: 3).
CREATE TABLE IF NOT EXISTS health_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  day INTEGER NOT NULL,                 -- unix day (UTC)
  fp TEXT NOT NULL,                     -- 'f' + 8 hex of type|exit|cause, the same for every user
  prio INTEGER NOT NULL,                -- 1 critical, 2 high, 3 medium, 4 daily summary
  type TEXT NOT NULL,
  exit_key TEXT NOT NULL DEFAULT '',    -- the anonymous server key (serverKey), never an address
  exit_name TEXT NOT NULL DEFAULT '',
  cause TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  app_ver TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  net TEXT NOT NULL DEFAULT '',         -- wifi / cell / other
  asn INTEGER NOT NULL DEFAULT 0,
  isp TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',    -- scrubbed JSON, at most 600 bytes
  writes INTEGER NOT NULL DEFAULT 1,    -- how many times this row was written (the per-user daily cap)
  state TEXT NOT NULL DEFAULT 'open',   -- open / resolved / muted
  alerted_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_health_user_day_fp ON health_events(user_id, day, fp);
CREATE INDEX IF NOT EXISTS idx_health_day ON health_events(day, prio);
