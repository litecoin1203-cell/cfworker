-- Cloud Gold Pay: crypto paid straight to the admin's wallets, confirmed from Telegram.
ALTER TABLE orders ADD COLUMN coin TEXT;              -- btc, eth, bnb, trx, ton, sol, ltc, doge
ALTER TABLE orders ADD COLUMN coin_amount TEXT;       -- exact unique amount the user must send
ALTER TABLE orders ADD COLUMN coin_address TEXT;      -- wallet address shown to the user (frozen per order)
ALTER TABLE orders ADD COLUMN coin_price_usd REAL;    -- locked price used for the quote
ALTER TABLE orders ADD COLUMN coin_expires_at INTEGER;-- quote lock end (unix seconds)
ALTER TABLE orders ADD COLUMN txid TEXT;              -- transaction hash the user submitted
