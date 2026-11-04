-- The Pleat character a person picked as their profile picture (an id from AVATARS in auth.js). NULL: none
-- picked, the app shows the Telegram photo or the initial.
ALTER TABLE users ADD COLUMN avatar TEXT;
