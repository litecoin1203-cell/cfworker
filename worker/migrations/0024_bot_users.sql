-- People who opened the bot (welcome.js). A row is written once, the first time a Telegram account starts the bot or
-- opens an app sign-in link, so the bot can tell a new person (gets the welcome card with the ways to get Pleat)
-- from someone who has been here before. Nothing personal beyond the Telegram id.
CREATE TABLE IF NOT EXISTS bot_users (
  tg_id INTEGER PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  had_account INTEGER NOT NULL DEFAULT 0, -- 1 = already a Pleat user (users.tg_id) or came from the app's sign-in link
  welcomed_at INTEGER                     -- when the welcome card was sent; NULL = not sent
);
