-- Atomic wallet: each wallet_tx row carries a one-time nonce, so the balance UPDATE in the same D1 batch
-- can tell "my row was just inserted" from "this order+reason was already applied" (INSERT OR IGNORE).
ALTER TABLE wallet_tx ADD COLUMN nonce TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_nonce ON wallet_tx(nonce);

-- Safety net in the database itself: no code path can ever push a wallet below zero.
CREATE TRIGGER IF NOT EXISTS users_wallet_nonnegative
BEFORE UPDATE OF wallet_balance ON users
WHEN NEW.wallet_balance < 0
BEGIN
  SELECT RAISE(ABORT, 'insufficient_balance');
END;
