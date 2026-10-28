-- Memo / Destination Tag for networks where exchange wallets need one (XLM, XRP, TON).
ALTER TABLE orders ADD COLUMN coin_memo TEXT;
