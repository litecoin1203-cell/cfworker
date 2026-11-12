# Database (Cloudflare D1) — schema reference

> Part of the developer docs. Start at [`PROJECT_HANDBOOK.md`](PROJECT_HANDBOOK.md).
> Source of truth: `worker/migrations/*.sql` (the comments in each file explain the why). When this file and the
> migrations disagree, the migrations win; fix this file in the same PR. A Worker test fails when a migration file
> is not named here.

D1 is SQLite. Database name `cloudgold`, binding `DB` (`worker/wrangler.jsonc`; the id is filled in by the deploy
workflow). 33 tables, 1 trigger. All times are **unix seconds** unless a column says otherwise.

## Rules

- **Additive only.** Never drop, rename or rewrite an applied migration, table or column. Existing users must not
  be logged out or lose data.
- New migration = new file `worker/migrations/00NN_short_name.sql` with a header comment saying why. Use
  `IF NOT EXISTS` where SQLite allows it. Applied by the **Deploy Cloud Gold server** workflow (it prints a D1
  Time Travel bookmark first, so a bad migration can be rolled back with `wrangler d1 time-travel restore`).
- Two files share the number 0015 (`0015_profile.sql`, `0015_receipt_upload.sql`). Wrangler sorts by full name;
  it works. **Never renumber.**
- **No foreign keys.** Integrity lives in code (`billing.js`, `sync.js`, `admin-actions.js`).
- **Free plan budget:** ≤ 50 D1 queries per invocation (a `batch` counts as 1; the test suite fails any request or
  cron run above 50), ~100k rows written/day, ~5M rows read/day. Batch writes; write only on change; index any
  per-minute lookup (see 0021).
- Deleting a user is **soft**: email becomes `deleted+<id>@invalid`, panel accounts switched off and unlinked.

## Migration log

| File | What it added |
|---|---|
| 0001_init | `users`, `plans`, `subscriptions`, `orders`, `wallet_tx`, `devices`, `settings` |
| 0002_coupons_autobuy | `coupons`, `coupon_uses`; orders: coupon, list price, "top up and activate a plan"; `subscriptions.period_days` |
| 0003_coin_pay | crypto to the admin's own wallets: orders `coin*`, `txid` |
| 0004_coin_memo | `orders.coin_memo` (XLM/XRP/TON memo / destination tag) |
| 0005_card_sms | `sms_log` (each bank SMS seen once) |
| 0006_net_stats | `net_stats` (anonymous quality per ISP ASN + server, per day) |
| 0007_geo_google | `net_geo` (ISP + province, 3-hour buckets), `google_probe` |
| 0008_wallet_atomic | `wallet_tx.nonce` + trigger `users_wallet_nonnegative` (atomic wallet) |
| 0009_order_claim | `orders.settling_at`, `orders.provisioned_at` (atomic `settle` claim) |
| 0010_indexes | indexes for open orders per method, chain watcher, lookups |
| 0011_control_plane | multi-panel control plane: `panels`, `panel_accounts`, `sub_periods`, `usage_counters`, `sync_cursor`, `admin_audit`, `bot_confirm`; subscription state |
| 0012_security_fixes | `net_votes`, `google_votes` (one vote per user per server) |
| 0013_carrier_speed | `net_speed_votes`, `user_skeys`; `net_geo` speed columns |
| 0014_telegram_login | `tg_logins`; `users.tg_id/tg_username/tg_name` |
| 0015_profile | `tg_logins.link_user_id` (verify Telegram from an email account), `sub_periods.source` |
| 0015_receipt_upload | `orders.receipt_upload` (dedupe id of an offline-queued receipt) |
| 0016_avatar | `users.avatar` (one of the 14 Folk avatar ids, `AVATARS` in `auth.js`) |
| 0017_user_net | `user_net`, `user_net_srv` (each user's own per-network experience) |
| 0018_admin_panel | `bot_session`, `server_overrides`, `broadcasts`, `admins`; `plans.archived`; audit undo |
| 0019_admin_stats | indexes for the bot/Mini App stats screen |
| 0020_panel_online | `usage_counters.online_at` (last connection per panel account; written with the usage write, no extra writes) — PR #49 |
| 0021_expiry_index | index `subscriptions(state, expires_at)` — the per-minute expiry check was a full scan — PR #62 |
| 0022_health | `health_events` (Pleat's automatic health reports) — PR #73 |
| 0023_worker_errors | `worker_errors` (the Worker's own error log for the bot's ☁️ Cloudflare section) — PR #84 |

## Tables

### Accounts and devices
| Table | Purpose | Key columns |
|---|---|---|
| `users` | one app account | `email` (unique; soft-deleted = `deleted+<id>@invalid`), `password_hash` (PBKDF2, 5,000 it.), `is_active`, `wallet_balance` (toman, ≥ 0 by trigger), `referral_code`, `referred_by_id`, `token_version` (bump = log out everywhere), `trial_used`, `tg_id` (numeric Telegram id = identity), `tg_username` (alias), `tg_name`, `avatar` |
| `devices` | phones that used `/vpn` | `user_id`, `device_id` (X-Device-Id), `model`, `last_seen` |
| `tg_logins` | Telegram 6-digit code sign-in / sign-up / link | `nonce_hash`, `code_hash`, `code_expires_at` (5 min), `attempts` (5), `codes_sent`, `used`, `link_user_id` |
| `admins` | extra bot/Mini App admins | `tg_id`, `role` (owner / support / viewer). The owner is the `TELEGRAM_CHAT_ID` secret. |

### Plans, orders, money
| Table | Purpose | Key columns |
|---|---|---|
| `plans` | what is sold | `duration_days`, `data_limit_gb` (0 = unlimited), `device_limit`, `price_toman`, `old_price_toman`, `badge`, `trial_days`, `is_active`, `sort`, `archived` |
| `orders` | every purchase / top-up | `kind` (plan / topup), `method` (wallet / card / coin / gateway), `status` (pending / review / settling / paid / rejected / cancelled / expired), `amount_toman` (card: unique amount), coin fields (`coin`, `coin_amount`, `coin_address`, `coin_memo`, `coin_price_usd`, `coin_expires_at`, `txid`), `settling_at` (claim lease), `provisioned_at`, `receipt_file_id`, `receipt_upload`, coupon / activate-plan fields |
| `wallet_tx` | wallet ledger | `amount`, `balance_after`, `reason`, `order_id`, `nonce` (one-time; `UNIQUE(order_id, reason)`) |
| `coupons`, `coupon_uses` | discount codes and who used them | `percent`, `max_uses`, `used`, `expires_at`, `plan_id` |
| `sms_log` | every forwarded bank SMS, once | `hash`, `sender`, `amount_rial` (**rial**, prices are toman), `order_id`, `result` |

Trigger `users_wallet_nonnegative` aborts any update that would make `wallet_balance` negative.
A txid is bound to one order by a conditional UPDATE in `chainwatch.claimTxid` (not a constraint).

### Subscriptions and panels (control plane, since 0011)
| Table | Purpose | Key columns |
|---|---|---|
| `subscriptions` | **one row per user**: the Worker's truth about the package | `plan_id`, `expires_at`, `data_limit_bytes`, `device_limit`, `state` (active / stopped), `stop_reason`, `used_bytes` (sum over all panels), `period_id`, `pg_username`/`sub_url` (legacy panel-1 fields) |
| `sub_periods` | package history (one row per bought period) | `started_at`, `expires_at`, `limit_bytes`, `ended_at`, `end_reason`, `final_used_bytes`, `source` |
| `panels` | registered VPN panels | `kind` (pasarguard / marzban / rebecca / auto), `label`, `cred_ref`, `state` (new → testing → rollout → active → draining → disabled), `rollout_percent`, `health`, `fail_streak` |
| `panel_accounts` | the user's account on one panel | `UNIQUE(user_id, panel_id)` and `(panel_id, remote_username)`; `desired`/`applied` state, limit and expiry; `dirty` = still to push; `attempts`, `last_error` |
| `usage_counters` | per period per panel usage ledger | `last_remote_bytes`, `accounted_bytes`, `baseline_pending`, `last_seen_at`, `stale`, `online_at` |
| `sync_cursor` | round-robin position of the per-minute sync | `job`, `panel_id`, `offset`, `run_at` |
| `server_overrides` | admin hides or relabels one exit | `panel_id`, `server_key`, `hidden`, `label` |

Usage is written at most every 10 min per moving account (`LEDGER_EVERY` in `sync.js`), at once for big changes,
near the quota, panel resets or a user coming online. Stored "online now" = seen in the last 13 min
(`STORED_ONLINE_SEC`).

### Network quality (crowd ranking, anonymous)
| Table | Purpose |
|---|---|
| `net_stats` | ok / fail / ping per ISP (ASN) and server key, per day |
| `net_geo` | same per ISP + province in 3-hour buckets, plus speed (`kb_sum/kb_n`) |
| `net_votes`, `net_speed_votes`, `google_votes` | one vote per user per server per bucket/day (anti-stuffing) |
| `google_probe` | what Google sees per exit (country, Gemini open, Search wall); fed by Pleat's Protect › Google location (PR #82) through `/net/google` |
| `user_skeys` | which server keys each user really has (votes from other keys are ignored) |
| `user_net`, `user_net_srv` | one user's own networks and per-server results (bot "📶 تجربه اتصال") |

Server key = FNV-1a of `type|host|port` (`netstats.serverKey`, same in Pleat). It never contains an address.

### Admin bot and Mini App
| Table | Purpose |
|---|---|
| `bot_session` | the form the admin is filling in the bot (10 min) |
| `bot_confirm` | one-time confirm tokens for money / destructive taps (2 min) |
| `admin_audit` | every admin write, with `undo_json` (10-minute undo) and `undone_at` |
| `broadcasts` | messages being sent to users, 25 per `*/2` cron run |

### Health reports (0022, PR #73)
`health_events`: one row = one problem on one user's phone on one day. `fp` = `'f' + 8 hex` of type|exit|cause
(same for every user); a repeat only raises `count`. `prio` 1 critical (Telegram alert at once) … 4 daily summary.
`exit_key` is the anonymous server key, never an address. `detail` is scrubbed JSON (≤ 1000 bytes in code).
`state` open / resolved / muted. Rows kept 14 days (resolved: 3), pruned by the daily cron. Per-user daily caps are in
`health.js` `LIMITS`.

### Worker error log (0023, PR #84)
`worker_errors`: one row per kind of error (`fp` = message + error text with numbers taken out). `logError` feeds it
through `cfmon.recordError`: scrubbed (no host, IP, email, key), written at most once a minute per kind and 12 times a
minute per isolate; a repeat only raises `count`. Kept 14 days (daily cron). Shown in the bot › ☁️ › 🐞.

### `settings` (key / value)
Almost all runtime configuration. Defaults in `worker/src/db.js` `SETTING_DEFAULTS`; edited from the bot or the Mini App.

- Payments: `card_number`, `card_holder`, `card_bank`, `card_unique`, `card_auto` (auto / detect / off), `sms_senders`,
  `sms_key`, `coin_auto`, `coin_minutes`, `wallet_<coin>` / `wallet_<coin>_memo`, `usd_rate_toman`, `referral_percent`,
  `min_topup_toman`.
- App: `announcement`, `support_url`, `app_api_bases` (extra Worker domains), `app_bridges` (bridge links),
  `trial_data_gb`, `trial_needs_telegram`, `app_release` (in-app update announcement).
- Monitoring: `cf_alerts` (1/0, hourly Cloudflare alerts), `cf_alert_state` (what was already told today), `sync_manual_at` (last "sync now" tap).
- Panels: `panel_cred_<id>` (AES-GCM sealed login, never in backups), `panel_err_<id>` (refused creates),
  `panel_hosts_<id>` (Tunnel-group host rules, refreshed every 15 min), `tunnel_probe_<id>` (the `cgtunnel_…` probe
  user used when the panel admin gets 403 on groups/hosts — **do not delete that panel user**), `server_exit_cc`
  (exit country learned from Pleat's `/me/ip?k=`).
- Health: `health_mode` (all / p2 / off), `health_mute`.
- Internals: `tg_webhook_sig` (which webhook setup is registered), cached coin/USD prices and similar.

## Backups
The daily cron (20:30 UTC) sends a JSON backup of the main tables to the owner's Telegram. It excludes password
hashes, subscription URLs, panel credentials, the SMS key and bridges, but still holds PII (emails, Telegram ids) in
clear — open decision S10. There is no restore tool; real recovery is **D1 Time Travel** (7 days back on the Free plan).
