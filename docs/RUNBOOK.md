# Incident runbook

What to do when something breaks in production. One page per incident type; each step names where it is done.
For restoring data or rolling back code, see [`RESTORE.md`](RESTORE.md). Release audit MISC-06.

Every alert today goes to one place: the owner's Telegram chat (`TELEGRAM_CHAT_ID`): health reports, the
nightly backup, receipts, the hourly Cloudflare alert. If that account or Telegram itself is lost, all of them
stop together. The second channel and the outside monitor below are **owner decisions, not set up yet**.

## 0. Is the Worker up?

- `GET https://<your custom domain>/health` answers `{"ok":true}` with no database work (Pleat races it).
- `GET https://<your custom domain>/health?deep=1` answers 503 when the per-minute cron has been quiet for 10
  minutes (it reads the panel sync's last run). Point a free outside uptime monitor at this URL on the **custom
  domain** (not `workers.dev`), checking every 5 minutes, alerting by e-mail. Not configured in the repo.
- Bot: ☁️ Cloudflare shows quota, errors and the Worker's own error log (`worker_errors`). Its hourly alert needs
  the Workers Secret `CF_ANALYTICS_TOKEN`; without it nobody is told when the Free-plan limits are hit (Deploy
  prints a warning).

## 1. The Worker's address is filtered in Iran

1. Add another custom domain (Cloudflare → Worker → Settings → Domains & Routes).
2. Bot: 📱 اپ Pleat › دامنه‌های اضافه‌ی اپ: add `https://<new domain>` to `app_api_bases`. Pleat learns it from app-config on its
   next launch while the old address still works, and keeps it for later launches.
3. If no address is reachable any more, only a Pleat build with the new address in `CG_API_BASE` (repository
   variable) or a bridge link (`app_bridges`, bot › لینک‌های پل اپ) reaches users.

## 2. A panel is down or must be switched off

1. Bot: 🗂 پنل‌ها و سرورها › the panel › 🚪 خارج‌کردن پنل (drain: no new accounts there); the others keep serving.
2. Users with configs on several panels keep working on the rest; quota and expiry are summed over all panels.
3. When it is back: panel test (bot), then roll it out again.

## 3. A secret leaked

Rotate in the Cloudflare dashboard (Worker → Settings → Variables and Secrets), then run nothing else: Workers
pick up a new secret at once.

| Secret | Rotate how | Side effect |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather › /revoke, set the new one | the next cron run re-registers the webhook |
| `TELEGRAM_WEBHOOK_SECRET` | set a new value (8+ chars, `A-Za-z0-9_-`) | the next cron run re-registers the webhook with it |
| `JWT_SECRET` | set a new value (or add it the first time) | **every user is signed out once**; passwords keep working |
| `SECRET_KEY` | **do not rotate** casually | it peppers every password hash and encrypts sealed panel logins: changing it breaks all passwords and stored panel logins |
| panel logins (`W_*` / `PASARGUARD_*`) | change on the panel, then bot › panels › login | none |
| SMS key | bot › payments › SMS setup | the phone's forwarder needs the new key |
| `CLOUDFLARE_API_TOKEN` (GitHub) | Cloudflare › API tokens › roll; update the GitHub secret | none |

One user's sessions: bot › the user's card › خروج از همه‌ی دستگاه‌ها (bumps that user's `token_version`).

## 4. The signing key leaked

The keystore (`APP_KEYSTORE_*` GitHub secrets) signs every Pleat APK; Android only installs updates signed with
the same key. A leak means someone can sign an APK that installs over Pleat. There is no in-place fix: a new key
means a new app for Android (users uninstall and install the new build by hand, after a Telegram message).
Remove the GitHub secrets at once so no workflow signs with the old key, and tell users to install only from you.

## 5. The owner's Telegram is lost

Bot admin access is tied to `TELEGRAM_CHAT_ID`. Set it to another account's chat id in the Worker's secrets; extra
admins (support / viewer roles) keep their access. The nightly backup goes to the new chat from then on.
Without any Telegram, the Cloudflare dashboard and `wrangler d1 execute` still reach the data (see `RESTORE.md`).

## 6. D1 is out of writes or a request is past 50 queries

Cloudflare Free plan: ~100k D1 writes per day, 50 queries per invocation. The Worker's own error log cannot always
record these (its write is a query too; a failed write is retried by the next invocation). The bot's ☁️ hourly
alert (with `CF_ANALYTICS_TOKEN`) shows the quota. Writes reset at 00:00 UTC; until then the store is read-mostly.
