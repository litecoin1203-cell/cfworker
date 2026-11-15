# Restore and rollback runbook

What to do when production is broken, from the cheapest fix to the last resort. Every command runs on the owner's
computer (or in the Deploy workflow). Nothing here is run by the Worker. `cloudgold` is the D1 database name the
Deploy workflow uses.

| What broke | First choice | Section |
|---|---|---|
| A Worker deploy (bad code, data still fine) | redeploy the last good code | 1 |
| Data, found within the Time Travel window | D1 Time Travel | 2 |
| Data, found later, or the Cloudflare account is gone | the daily Telegram backup | 3 |
| A Pleat build | a new build from good code | 4 |

## 1. Worker code: roll back

- **Preferred:** revert the bad pull request on GitHub (it opens a revert PR), merge it, then run
  **Actions › Deploy Cloud Gold server** from `main`. Deploy refuses any other branch (OPS-02).
- **Faster, by hand:** `npx wrangler@4.158.0 deployments list`, then `npx wrangler@4.158.0 rollback <version-id>`
  puts an earlier Worker version back at once. It needs a Cloudflare API token on that computer. It does **not**
  undo database migrations. Revert the code on `main` too, or the next Deploy brings the bad code back.
- Migrations are additive only (AGENTS.md rule 2), so old code keeps working on the newer schema.

## 2. Data: D1 Time Travel (first choice for data)

D1 keeps every minute of the database for the last **7 days on the Workers Free plan** (30 days on Workers Paid).

1. Find the moment before the damage. Each Deploy log prints a bookmark from just before its migrations (step
   "Note the database restore point").
2. `npx wrangler@4.158.0 d1 time-travel restore cloudgold --bookmark=<bookmark>`
   or `... --timestamp=<unix seconds or RFC 3339>`.
3. Everything written after that moment is lost (orders, payments, sign-ups). Before you restore, note the
   orders paid after it from the bot, and enter them again afterwards.

This brings back everything, including password hashes, panel logins and subscription links. Sections 3 and 4
cannot.

## 3. Data: from the daily Telegram backup (last resort)

The bot sends `cloudgold-backup-YYYY-MM-DD.json` every day at 20:30 UTC (also on demand: bot › 🛡 سیستم › 💾 پشتیبان). It holds
users, plans, subscriptions, orders, the wallet ledger, devices, settings, coupons, panels, panel accounts, plan
periods, usage counters and the admin log. To keep a leaked chat harmless, it leaves out:

- **password hashes**: after a restore no email password works. People sign in with Telegram, or the owner sets
  a new password for each one (bot › the user › 🔑).
- **subscription links** (`subscriptions.sub_url`, `panel_accounts.sub_path`): the Worker gives a phone configs
  only for an account with a link. As the code reads, a sync does not fill the link again for an account that
  still exists on the panel. So each user's panel account must be linked again (bot › the user › 🔗 وصل اکانت پنل;
  whether it accepts an account row that is already there was not tried). Not tried on real panels.
- **panel logins, the SMS key, bridges and other secret settings**: enter them again in the bot.
- the undo data of the admin log.

Steps:

1. Download the newest backup file from the Telegram chat.
2. Make a fresh database with the current schema. In a new or empty Cloudflare account, the Deploy workflow does
   this: it creates `cloudgold` and applies every migration. Otherwise run
   `npx wrangler@4.158.0 d1 create <name>`, then `npx wrangler@4.158.0 d1 migrations apply <name> --remote`.
   **Never load a backup into a database that holds newer data.** The SQL first empties every table in the
   backup.
3. `cd worker && node scripts/restore-backup.mjs ~/Downloads/cloudgold-backup-YYYY-MM-DD.json > restore.sql`
   (it prints the row count of each table).
4. `npx wrangler@4.158.0 d1 execute <name> --remote --file restore.sql`
5. Re-enter the secret settings and panel logins in the bot. Run the bot's panel test, then link the panel
   accounts (see above). Tell users to sign in with Telegram or ask for a new password.
6. Delete `restore.sql` and the downloaded backup. Both hold users' emails and Telegram ids.

**Proven:** the Worker test suite runs a restore on every pull request (section "OPS-06" in
`worker/test/run.mjs`). It takes the backup of the whole test database and runs the SQL on a fresh database with
every migration. It then checks that every table comes back row for row, that the Worker opens a restored account
with its wallet, and that an old password is refused cleanly.
**Not proven:** running `wrangler d1 execute --file` on real D1 with a real backup. Try it once on a throw-away
database: `npx wrangler@4.158.0 d1 create cloudgold-drill`, then steps 2–4 on it, then
`npx wrangler@4.158.0 d1 delete cloudgold-drill`.

## 4. Pleat: roll back a bad build

Android never installs a lower version code over a higher one. So rolling back means a **new** build of the last
good code with a **higher** build number:

1. On a branch from `main`, revert the bad change. Raise `version` and the `+build` in `flutter_vpn/pubspec.yaml`
   above the bad build. Open a PR and merge it.
2. Run **Pleat Flutter app** from `main`. It refuses other branches.
3. Announce the new build in the bot (📱 اپ Pleat › 📲 نسخه‌ی اپ). The bad build stays on `pleat-latest` until two
   newer builds push it out.

## 5. Things that need the owner (not code)

- **The signing keystore** (`APP_KEYSTORE_BASE64` and its password) cannot be restored from GitHub. If it is lost,
  no installed Pleat can ever be updated again. Keep two offline copies, write down where they are, and keep
  that note somewhere other than this public repo.
- **A full, encrypted weekly export** (`wrangler d1 export`, then age/GPG, then a private place) would also cover
  password hashes and links for longer than Time Travel. Where it would live is the owner's decision (open
  item in the handbook §19).
