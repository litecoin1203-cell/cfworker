-- Bank SMS auto-confirmation for card-to-card: every SMS seen once (forwarders retry), with what it matched.
CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE NOT NULL,
  sender TEXT,
  body TEXT,
  amount_rial INTEGER,
  order_id INTEGER,
  result TEXT,
  created_at INTEGER NOT NULL
);
