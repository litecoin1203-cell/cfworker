-- Anonymous connection quality per ISP (Cloudflare ASN) and server, bucketed per day. No user ids.
CREATE TABLE IF NOT EXISTS net_stats (
  asn INTEGER NOT NULL,
  skey TEXT NOT NULL,          -- hash of protocol|host|port, identical on every phone
  day INTEGER NOT NULL,        -- unix day
  ok INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  ms_sum INTEGER NOT NULL DEFAULT 0,
  ms_n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (asn, skey, day)
);
CREATE INDEX IF NOT EXISTS idx_net_asn_day ON net_stats(asn, day);
