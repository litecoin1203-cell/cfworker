-- Network quality per ISP + province, in 3-hour buckets (recent hours weigh more: filtering changes fast).
CREATE TABLE IF NOT EXISTS net_geo (
  asn INTEGER NOT NULL,
  geo TEXT NOT NULL,           -- province (Cloudflare region), '' when unknown
  skey TEXT NOT NULL,
  bucket INTEGER NOT NULL,     -- unix time / 10800
  ok INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  ms_sum INTEGER NOT NULL DEFAULT 0,
  ms_n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (asn, geo, skey, bucket)
);
CREATE INDEX IF NOT EXISTS idx_net_geo ON net_geo(asn, bucket);

-- How Google sees each server's exit IP (tested from phones through that exact config). Global, per day.
CREATE TABLE IF NOT EXISTS google_probe (
  skey TEXT NOT NULL,
  day INTEGER NOT NULL,
  tests INTEGER NOT NULL DEFAULT 0,
  gemini_ok INTEGER NOT NULL DEFAULT 0,
  google_ir INTEGER NOT NULL DEFAULT 0,   -- Google thinks the IP is in Iran
  google_wall INTEGER NOT NULL DEFAULT 0, -- Google search shows the "unusual traffic" page
  last_cc TEXT,                           -- exit country (Cloudflare)
  last_gcc TEXT,                          -- country according to Google
  last_ip TEXT,
  name TEXT,
  last_at INTEGER,
  PRIMARY KEY (skey, day)
);
