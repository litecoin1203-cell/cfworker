# Worker HTTP API and cron jobs — reference

> Part of the developer docs. Start at [`PROJECT_HANDBOOK.md`](PROJECT_HANDBOOK.md).
> Source of truth: `worker/src/index.js` (`fetch`, `route()`, `scheduled`) and `worker/src/admin-api.js` (`ROUTES`).
> A Worker test fails when a path in `index.js`'s `authed` list or in `admin-api.js`'s `ROUTES` is missing here.
> What each Pleat screen calls is in [`flutter_vpn/docs/backend-map.md`](../flutter_vpn/docs/backend-map.md).

Worker `cloudgold`. Production bases: the owner's custom domain first, then the `workers.dev` address (both are
in the `CG_API_BASE` repo variable / the Pleat workflow's `api_base` input). The API lives under `/api/v1`.

**Errors** are `{"detail": {"code": "<machine_code>", "message": "<text>"}}` with an HTTP status (`ApiError` in
`util.js`). Messages for the old app are Persian; Pleat maps `code` to English and never shows Persian.
**CORS** headers are added to every `/api/v1` answer.
**Rate limits** (`RL_IP` 20/min, `RL_LOGIN` 5/min in `wrangler.jsonc`) are per Cloudflare location and fail open:
they slow abuse, they are not a security boundary.

**Request headers Pleat sends:** `Authorization: Bearer <access>`, `X-Device-Id`, `X-Device-Model`,
`X-Device-OS`, `X-App-Version`, `X-HWID` (panel 1 has an HWID limit).

## Outside `/api/v1`

| Method + path | Auth | Handler | Purpose |
|---|---|---|---|
| `GET /health` | none | `index.js` | `{ok:true}`; `?deep=1` also checks D1 and the cron's last run |
| `GET /mini/probe` | none | `account.miniProbePage` | Mini App stage-0 probe page (strict CSP) |
| `GET /pay/done` | none | `index.js` | return page after a gateway payment (old app deep link) |
| `POST /sms` | `X-SMS-Key` header = settings `sms_key` | `sms.js` | bank SMS forwarded from the admin's phone → auto-confirm card orders |
| `POST /tg[/<secret>]` | `TELEGRAM_WEBHOOK_SECRET` in path + `X-Telegram-Bot-Api-Secret-Token`; admin role per update | `telegram.js` → `telegram-menu.js` | the admin Telegram bot webhook |
| `GET /app/*` | static | `worker/public/` (built from `miniapp/`) | Telegram Mini App (user + admin) |

## Public `/api/v1` (no login)

| Method + path | Limit | Handler | Purpose |
|---|---|---|---|
| `GET /app-config` | – | `account.appConfig` | announcement, support URL, extra API bases (`app_api_bases`), bridges (`app_bridges`) |
| `GET /plans` | – | `account.plans` | active plans |
| `GET /ip` | – | `account.myIp` | caller's IP/country (no login) |
| `POST /auth/register` | IP | `auth.register` | email sign-up → tokens |
| `POST /auth/login` | IP + login | `auth.login` | email **or** Telegram @username + password → tokens |
| `POST /auth/tg/start` | IP | `auth.tgStart` | start Telegram code sign-in (bot sends a 6-digit code) |
| `POST /auth/tg/verify` | IP + nonce | `auth.tgVerify` | check the code → tokens, or `need_password` for a new account |
| `POST /auth/tg/register` | IP | `auth.tgRegister` | finish Telegram sign-up with a password |
| `POST /auth/tg/webapp` | IP | `auth.webappLogin` | Mini App sign-in with Telegram `initData` (≤ 1 h) → 30-min access token marked `src: mini`; `{need_account}` if new |
| `POST /auth/tg/webapp/register` | IP | `auth.webappRegister` | one-tap account from the Mini App (no password), invite `startapp=ref_<CODE>` |
| `POST /mini/probe` | IP; `initData` HMAC | `account.miniProbeReport` | stage-0 probe result → admin chat |
| `POST /auth/refresh` | IP | `auth.refresh` | refresh token (60 days, not rotating) → new access token (30 min) |
| `POST /payments/nowpayments/ipn` | HMAC-SHA512 | `orders.nowpaymentsIpn` | optional crypto gateway → `settle` |

## Logged-in `/api/v1` (Bearer access JWT; `token_version` and `is_active` checked)

Mini App tokens (`src: mini`) are refused on `/vpn*` and `/devices*` with `403 use_pleat`.

| Method + path | Handler | Purpose |
|---|---|---|
| `GET /me` | `account.me` | account + subscription (`status, days_left, used_bytes, data_limit_bytes, used_percent, …`). Live panel reading waits ≤ 1.5 s, else stored numbers. |
| `GET /me/ip` | `index.js` | the request's IP, country, city (through the tunnel = the exit). `?k=<serverKey>` teaches the Worker that exit's real country (`panels.learnExitCountry`, settings `server_exit_cc`; never IR; 2 reports in a row to change) and feeds a location-mismatch health check unless `&h=0`. |
| `GET /me/packages` | `account.packages` | package history (`sub_periods`) |
| `POST /me/email` | `auth.setEmail` | backup Gmail |
| `POST /me/avatar` | `auth.setAvatar` | pick one of 14 Folk avatars (empty pick refused since PR #66) |
| `POST /me/telegram/start`, `/me/telegram/verify` | `auth` | link / verify Telegram on an email account |
| `POST /me/health` | `health.report` | Pleat's batched health reports (PR #73). Limited per user; capped per day in `health.js` `LIMITS`. |
| `POST /trial` | `account.startTrial` | free trial (needs verified Telegram when `trial_needs_telegram=1`) |
| `GET /vpn` | `account.vpn` | connect pre-check; registers the device (`403 device_limit`, `402 no_subscription`, `410 sub_missing`) |
| `GET /vpn/servers` | `account.vpnServers` | the user's exits from every panel, unified names (`🇩🇪 DE 2`), `tunnel: true` for Iran-tunnel configs, `panel: <n>` (P1/P2 tag). Creates missing panel accounts on demand. `503 panel_unavailable` = account rows exist but no links came back. |
| `GET /vpn/sub` | `account.vpnSub` | old-app subscription format (retired app) |
| `POST /net/report` | `netstats.report` | ping / speed results per server key (crowd ranking) |
| `GET /net/rank` | `netstats.rank` | ranking for the caller's operator (ASN), plus the Google map |
| `POST /net/google` | `netstats.googleReport` | what Google sees through an exit (Protect › Google location) |
| `POST /coupons/check` | `orders.checkCoupon` | validate a coupon |
| `GET /devices`, `DELETE /devices/:id` | `account` | the user's phones |
| `GET /wallet` | `orders.wallet` | balance + ledger |
| `GET /referral` | `orders.referral` | invite code and earnings |
| `GET /orders`, `POST /orders` | `orders` | list / create (wallet, card, coin, gateway). ≤ 3 open orders per method (`429 too_many_open_orders`). |
| `GET /orders/:id` | `orders.getOrder` | one order |
| `POST /orders/:id/receipt` | `orders.uploadReceipt` | card receipt photo (`upload_id` dedupes offline retries) |
| `POST /orders/:id/cancel` | `orders.cancelOrder` | cancel an open order |
| `POST /orders/:id/paid` | `orders.markCoinPaid` | "I paid" for a crypto order |
| `GET /app/apk` | `appupdate.apkDownload` | proxies the announced APK from the private `pleat-latest` release (resumable) |
| `POST /auth/change-password` | `auth.changePassword` | |
| `POST /auth/logout-all` | `auth.logoutAll` | bumps `token_version` |

## Admin API (Telegram Mini App admin panel) — `admin-api.js`

`POST /api/v1/admin/auth` with Telegram `initData` → 15-minute token `typ: admin`. The role (owner = `TELEGRAM_CHAT_ID`,
else the `admins` table) is **re-read on every request**. Levels: `support` < `viewer` < `owner`. Writes that reach
other servers (panel test/cred, backup, add panel) are rate-limited per admin.

| Method + path | Level | Purpose |
|---|---|---|
| `GET /admin/dashboard` | support | today's numbers, inbox count |
| `GET /admin/inbox` | support | receipts waiting |
| `GET /admin/orders`, `/admin/orders/:id`, `/admin/orders/:id/receipt` | support | orders; receipt photo proxied from Telegram |
| `GET /admin/users`, `/admin/users/:id` | viewer | search/filter; user card |
| `GET /admin/users/:id/panels` | viewer | live per-panel view (no address) |
| `GET /admin/users/:id/wallet`, `/admin/users/:id/orders`, `/admin/users/:id/nets` | viewer | wallet ledger, orders, networks |
| `GET /admin/plans`, `/admin/coupons`, `/admin/coupons/:id/uses`, `/admin/referral` | viewer | sales setup |
| `GET /admin/payments`, `/admin/sms` | viewer | payment methods, SMS log |
| `GET /admin/sms/setup`, `/admin/rate` | owner | SMS key setup, USD rate + source status |
| `GET /admin/panels`, `/admin/panels/:id`, `/admin/panels/:id/servers` | viewer | panels, rollout, exits (with tunnel mark, panel-name vs real-exit country, unknown-country remark) |
| `GET /admin/panels/:id/tunnel` | viewer | Iran-tunnel diagnostic (`telegram-screens.tunnelDiagData`, same as the bot's 🚇) |
| `GET /admin/app`, `/admin/app/domains/test` | viewer | Pleat settings, domain reachability |
| `GET /admin/net`, `/admin/net/users` | viewer | operator ranking, users' networks |
| `GET /admin/net/server` | viewer | `?key=` one server on every carrier + Google's view (`telegram-screens.netServerData`) |
| `GET /admin/stats`, `/admin/broadcasts`, `/admin/broadcasts/:id` | viewer | stats, broadcasts |
| `GET /admin/health`, `/admin/audit` | viewer | system health, admin log |
| `GET /admin/settings`, `/admin/admins` | owner | every setting (secrets masked), admins |
| `GET /admin/reports`, `/admin/reports/servers`, `/admin/reports/users`, `/admin/reports/versions` | viewer | Pleat health reports: summary (per priority, 7-day chart, mode), by server, by user, versions (`health.js` *Data) |
| `GET /admin/reports/problems`, `/admin/reports/problem` | viewer | `?prio=`/`?server=`/`?user=` problem list; `?fp=` one problem (users, versions, last report, native-crash reading code) |
| `GET /admin/cf`, `/admin/cf/history`, `/admin/cf/errors`, `/admin/cf/queries`, `/admin/cf/deploys`, `/admin/cf/token` | viewer | ☁️ Cloudflare monitoring as data (`cfmon.js` *Data): quota, 24 h by hour, capacity, 7 days, errors, costly queries, deploys, token state (never the token) |
| `POST /admin/action` | support (per-action roles) | `{name, args, confirm}` → `admin-actions.runAction` (same validation, audit, 10-min undo as the bot; money/destructive need `confirm: true`) |
| `POST /admin/undo` | support | undo an audit row |
| `POST /admin/users`, `/admin/users/:id/password` | owner | create user, set password |
| `POST /admin/panels`, `/admin/panels/:id/cred`, `/admin/panels/:id/test` | owner | add panel, panel login, test |
| `POST /admin/panels/:id/tunnel` | owner | read the panel's tunnel groups/hosts again and store them |
| `POST /admin/sync` | owner | one panel sync now (`sync.manualSync`, shared with the bot's ⚡; once a minute, else 429) |
| `POST /admin/backup` | owner | send the backup to the admin's Telegram |

The Mini App's English labels for every action / refusal / setting live in `miniapp/src/admin/errors.js` and
`fmt.js`; `miniapp/test/admin.test.js` fails when a new one has no English text.

## Cron jobs (`scheduled` in `index.js`, schedules in `wrangler.jsonc`)

Each invocation has its own **50 subrequests** and **50 D1 queries** (Free plan).

| Schedule | Work |
|---|---|
| `* * * * *` | `billing.recoverStuckTick` (one order stuck in `settling` > 10 min is settled again; a run that did one stops here) → `chainwatch.scanAll` (XLM, XRP, TRX, TON, ALGO deposits) → `sync.runSync` (usage ledger, quota/expiry, push desired state, create missing accounts; gets the subrequests the chain scan left) → `telegram.ensureWebhook`; every 15 min (minute % 15 = 7) `panels.refreshHostRules` (which configs are in a panel's Tunnel group) |
| `*/2 * * * *` | `admin-actions.broadcastTick` (25 messages); every 10 min `appupdate.checkNewBuild` (tells the admin about a new APK on the release); at minute 0 `cfmon.alertTick` (Cloudflare quota / error alerts, needs `CF_ANALYTICS_TOKEN` for the quota part) |
| `30 20 * * *` | daily report to the owner (stats, USD rate, health line, ☁️ Cloudflare line) → backup JSON to Telegram → prune `net_*`, `health_events` and `worker_errors` |
