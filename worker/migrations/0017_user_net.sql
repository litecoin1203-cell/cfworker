-- Each user's own connection experience, per network they use: operator (ASN) and connection type from the
-- phone (wifi | cell | other; '' = an older app that does not say). For the admin bot ("which operators does
-- this user connect through, how well does each server work for them") and for ranking servers per operator
-- AND connection type. Aggregated rows only, never a raw log; no link, UUID or key. Pruned after 30 days.

CREATE TABLE IF NOT EXISTS user_net (
  user_id INTEGER NOT NULL,
  asn INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  isp TEXT NOT NULL DEFAULT '',   -- the operator's name when last seen
  geo TEXT NOT NULL DEFAULT '',   -- province when last seen
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, asn, kind)
);
CREATE INDEX IF NOT EXISTS idx_user_net_last ON user_net(last_at);

-- One row per user, network and server. ok/fail/ms/kb are weighted: every new result counts 1 and the ones
-- before it 0.8 as much, so a row follows what the server does now, and one account's weight on the shared
-- per-type ranking stays bounded (at most 5 results' worth) however often it reports.
CREATE TABLE IF NOT EXISTS user_net_srv (
  user_id INTEGER NOT NULL,
  asn INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  skey TEXT NOT NULL,
  ok REAL NOT NULL DEFAULT 0,
  fail REAL NOT NULL DEFAULT 0,
  ms_sum REAL NOT NULL DEFAULT 0,
  ms_n REAL NOT NULL DEFAULT 0,
  kb_sum REAL NOT NULL DEFAULT 0,
  kb_n REAL NOT NULL DEFAULT 0,
  tests INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, asn, kind, skey)
);
CREATE INDEX IF NOT EXISTS idx_user_net_srv_net ON user_net_srv(asn, kind, at);
