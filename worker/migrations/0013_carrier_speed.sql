-- Download speed per server per network (same 3-hour buckets as ping), and which servers each user really has.

ALTER TABLE net_geo ADD COLUMN kb_sum INTEGER NOT NULL DEFAULT 0;
ALTER TABLE net_geo ADD COLUMN kb_n INTEGER NOT NULL DEFAULT 0;

-- a user's speed result counts once per server per network per 3-hour bucket (like net_votes for pings)
CREATE TABLE IF NOT EXISTS net_speed_votes (
  user_id INTEGER NOT NULL,
  asn INTEGER NOT NULL,
  geo TEXT NOT NULL,
  skey TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  PRIMARY KEY (user_id, asn, geo, skey, bucket)
);

-- distinct people per server per network for /net/rank
CREATE INDEX IF NOT EXISTS idx_net_votes_asn ON net_votes(asn, bucket);

-- server keys (and names) from the user's last /vpn/servers: /net/report only counts these
CREATE TABLE IF NOT EXISTS user_skeys (
  user_id INTEGER PRIMARY KEY,
  keys TEXT NOT NULL,          -- JSON {skey: name}
  at INTEGER NOT NULL
);
