-- Profile screen. Email accounts verify a Telegram account the same way Telegram sign-ups do (6-digit code from
-- the bot); link_user_id marks such a link request, so its code can only attach Telegram to that one account and
-- can never be used to log in. sub_periods.source tells the package list how each period came (older rows: NULL).
ALTER TABLE tg_logins ADD COLUMN link_user_id INTEGER;
ALTER TABLE sub_periods ADD COLUMN source TEXT;   -- order | trial | gift (admin grant) | panel (linked/imported)
