-- Security audit round 1 (F5, F6): one vote per user per server, and an index for the google map's day filter.

-- /net/report: a user's result counts once per server per network (asn + province) per 3-hour bucket
CREATE TABLE IF NOT EXISTS net_votes (
  user_id INTEGER NOT NULL,
  asn INTEGER NOT NULL,
  geo TEXT NOT NULL,
  skey TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  PRIMARY KEY (user_id, asn, geo, skey, bucket)
);

-- /net/google: one counted test per user per server per day, and a cap on servers per user per day
CREATE TABLE IF NOT EXISTS google_votes (
  user_id INTEGER NOT NULL,
  skey TEXT NOT NULL,
  day INTEGER NOT NULL,
  PRIMARY KEY (user_id, skey, day)
);
CREATE INDEX IF NOT EXISTS idx_google_votes_day ON google_votes(user_id, day);

-- googleMap reads only the last few days; without this every /net/rank scans the whole table
CREATE INDEX IF NOT EXISTS idx_google_probe_day ON google_probe(day);
