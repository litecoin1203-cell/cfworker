# CloudGold / Pleat — Project Handbook

> **Who this is for:** an AI model (or a new developer) who is about to work on this repository and needs to
> understand the whole project quickly: what it is, how it is built, how it got here, what broke and how it
> was fixed, which rules the owner insists on, and what is still open.
>
> **Read this first, then read the code.** Every fact here was taken from the code, the git and PR history,
> the audit documents and the owner's decisions up to **2026-11-08** (main at `9d04f0e`, PR #45). When this
> file and the code disagree, the code wins; fix this file in the same PR.
>
> **No secrets live in this file and none may ever be added**: no panel addresses, panel logins, subscription
> links, UUIDs, keys, tokens, card numbers or wallet addresses.

---

## Contents

1. [The project in one page](#1-the-project-in-one-page)
2. [Working rules (the owner's standing orders)](#2-working-rules-the-owners-standing-orders)
3. [Repository map](#3-repository-map)
4. [Architecture](#4-architecture)
5. [The Worker (backend) in detail](#5-the-worker-backend-in-detail)
6. [Database (D1)](#6-database-d1)
7. [Payments and `settle`](#7-payments-and-settle)
8. [Panels and the control plane](#8-panels-and-the-control-plane)
9. [The admin Telegram bot](#9-the-admin-telegram-bot)
10. [Pleat, the Flutter app](#10-pleat-the-flutter-app)
11. [Build, test, deploy](#11-build-test-deploy)
12. [Cloudflare Free plan limits (hard constraints)](#12-cloudflare-free-plan-limits-hard-constraints)
13. [History: from the first commit to today](#13-history-from-the-first-commit-to-today)
14. [PR index](#14-pr-index)
15. [Problems found and how they were fixed](#15-problems-found-and-how-they-were-fixed)
16. [Server-side faults (not fixable in the app)](#16-server-side-faults-not-fixable-in-the-app)
17. [Wrong theories — do not revisit](#17-wrong-theories--do-not-revisit)
18. [Rejected design directions — do not offer again](#18-rejected-design-directions--do-not-offer-again)
19. [Open items and known gaps](#19-open-items-and-known-gaps)
20. [How to do common jobs](#20-how-to-do-common-jobs)
21. [Gotchas](#21-gotchas)
22. [Glossary](#22-glossary)

---

## 1. The project in one page

**CloudGold is a VPN store with no servers of its own.** Everything that is "the business" runs on
Cloudflare's Free plan:

- **A Cloudflare Worker** (`worker/`, plain JavaScript ESM, zero runtime dependencies) with a **D1** (SQLite)
  database. It is at once:
  - the **API** of the app (`/api/v1/*`),
  - the **admin Telegram bot** (`/tg` webhook),
  - the **bank-SMS receiver** that auto-confirms card-to-card payments (`/sms`),
  - the **crypto payment watcher** (cron reads five blockchains) and the NOWPayments IPN receiver,
  - the **control plane** over several third-party **VPN panels** (PasarGuard, Marzban, Rebecca): it creates
    each user's account on every panel, sums usage across panels, and stops/starts accounts on quota or expiry.
- **Pleat** (`flutter_vpn/`, Flutter + Kotlin) is **the** product app for Android. It logs in to the Worker,
  shows plans, takes payments, downloads the user's configs, and runs the tunnel itself (Xray core +
  hev-socks5-tunnel inside an Android `VpnService`).
- **VPN traffic never touches Cloudflare.** It goes from the phone to the panels' VPN nodes (VLESS
  Reality/TLS/WS/gRPC/XHTTP/HTTPUpgrade, VMess, Trojan, Shadowsocks, WireGuard, Hysteria2).

**The owner** is Ali (GitHub `litecoin1203-cell`). He writes in **Persian**, sends APKs to users by hand, is
the only admin, and as of 2026-11-07 had **2 users** and **2 panels** (panel 1 = PasarGuard, panel 2 =
Rebecca 1.8.0). Users are in **Iran**, behind heavy filtering; that fact drives many design choices.

**The old app is retired.** `android/` (v2rayNG 2.2.6 fork + a WebView bridge) and `app-web/` (its Persian
web UI) are the former "Cloud Gold" app. Nobody uses it (Ali, 2026-11-07). They are still in the repo and are
candidates for deletion in the audit's repair phase. **Do not build new features there.**

---

## 2. Working rules (the owner's standing orders)

These are not suggestions. Each one exists because something went wrong or Ali said so explicitly.

### Language
- **Talk to Ali in Persian.** Docs and code comments are English.
- **Pleat's UI is English only.** No Persian strings, no RTL, no language picker. Persian text that comes from
  the server is either shown verbatim (plan names, card holder) or mapped to generic English.
- **The admin bot's text is Persian.**

### The admin bot is buttons only
- Never ask Ali to type a `/command`. Telegram drops the arguments of a tapped command anyway
  (tapping "/rollout 2 10" in a message sends only "/rollout"). `buttonize()` in `telegram.js` turns any
  `/command` in bot text into a button, and **a test enforces "no typed commands"; keep it green.**
- Questions the bot asks are answered in chat ("bot asks, you answer"), with state in `bot_session`.

### Evidence before "fixed"
- **Get evidence before calling anything fixed, and say which findings are proven and which are guesses.**
  Two Pleat releases (1.2.9 and earlier) shipped theory-driven fixes that did nothing; a per-exit core log
  then settled the question in minutes. The audit uses the tags **[run]**, **[code]**, **[CI]**, **[guess]**;
  keep using them in reports.
- For a failing VPN exit, use the app's **"Test alone + copy core log"** first (Profile → Connection check).

### Scope and approval
- **Never create a new repo or a new project.** Develop only `litecoin1203-cell/cfworker`. Extend existing files.
- **A new backend file needs Ali's okay** (justify it first). Phase work does not move to the next stage
  without his explicit **«برو»** ("go").
- Work on a branch, open a PR, let Ali merge. Ali (or Claude on his explicit word) merges.
- **Deploy is manual.** Merging to `main` deploys nothing. Say so after every Worker change and tell Ali to run
  "Deploy Cloud Gold server" (and the Pleat workflow for an app change).

### Secrets and privacy
- No secrets in code, logs, tests, docs or chat. Never echo panel logins, panel addresses or subscription links.
- No panel URL, name, count or credentials anywhere user-facing (app, logs, bot output to users).
- Tests use made-up config values, never Ali's real ones.
- Secret rotation (panel-1 logins, webhook secret, SMS key) is deferred to a **pre-release checklist**.
- Ali once pasted real panel-2 subscription links in chat; the advice to regenerate that panel account stands.

### Users must not be disturbed
- Existing users must not be forced to log in again or get a new UUID.
- Migrations are **additive only** (never drop/rename an applied migration or column).

### CI
- When CI fails on network downloads, **enumerate every external download in the workflow and fix them all in
  one push.** On 2026-11-08 a one-file-at-a-time approach cost 1.5 hours and Ali was unhappy.
- Ali refuses committing large binaries; cache downloads instead.
- Ali's GitHub **artifact storage is full**: plain `upload-artifact` fails. Releases are unaffected, so APKs go
  to the `pleat-latest` release.

### Skills
- Ali cares that named skills are actually used and that reports say which skill drove which part. If a skill
  he names cannot be installed, **stop and report; do not substitute.** `supercent-io/skills-template` is
  private — never retry it. Approved security skills: `review-owasp-security`
  (javiercamarenatriguero/android-skills) and `appsec` (defi0x1/app-security-skills). Skills are installed into
  the ephemeral container each session and are gitignored.

---

## 3. Repository map

```
cfworker/
├── worker/                      THE BACKEND (active)
│   ├── src/                     ~8,600 lines, 23 files (see §5)
│   ├── migrations/              0001 … 0019 (two files share 0015 — harmless, never rename)
│   ├── test/run.mjs             the whole test suite (hand-made harness, ~1,070 checks)
│   ├── test/shim.mjs            D1 on node:sqlite (batch is transactional like D1), fake panels
│   ├── test/dev_server.mjs      the Worker + a fake panel on http://127.0.0.1:8787 (for Pleat's live test)
│   ├── wrangler.jsonc           crons, rate limiters, D1 binding (id filled by the deploy workflow)
│   └── package.json             npm test / npm run coverage (Node 22, --experimental-sqlite)
├── flutter_vpn/                 PLEAT, THE APP (active)
│   ├── lib/api/                 client.dart (HTTP over dart:io, multi-base race), models.dart, countries.dart
│   ├── lib/state/               app_state.dart (the big ChangeNotifier), tunnel.dart, xray_config.dart,
│   │                            bridge.dart, exits.dart, net_cache.dart, diagnose.dart, updater.dart
│   ├── lib/screens/             20 screens (home, locations, profile, plans, checkout, pay_card, pay_coin, …)
│   ├── lib/design/              tokens.dart (palettes), shard_field, mark, nav, city_art, avatars, …
│   ├── android/app/src/main/kotlin/app/pleat/pleat/
│   │                            PleatVpnService, MainActivity, Engine, Bridge, Speed, TunnelHub,
│   │                            TunnelNote (notification), TProxyService (hev JNI), Updates (installer)
│   ├── android/compile-hevtun.sh  builds hev-socks5-tunnel with PKGNAME=app/pleat/pleat
│   ├── test/                    unit/widget tests, live backend test, real-Xray config test
│   └── docs/backend-map.md      what every Pleat control calls on the Worker
│                 parity.md      Pleat vs the old Cloud Gold app, feature by feature (Persian)
├── android/  app-web/           RETIRED old Cloud Gold app — do not extend
├── design-system/               the old app's "Vault & Hallmark" design docs (historical)
├── docs/PROJECT_HANDBOOK.md     this file
├── README.md                    original Persian setup guide (partly outdated: old app, "53 tests")
└── .github/workflows/
    ├── test-worker.yml          Worker tests + coverage on push/PR touching worker/**
    ├── flutter-vpn.yml          "Pleat Flutter app": format, analyze, test, live test, Xray config test,
    │                            APK build; manual run publishes to release pleat-latest
    ├── deploy-worker.yml        "Deploy Cloud Gold server": manual only
    ├── android.yml              RETIRED: old app APK
    └── make-key.yml             one-time signing key generator (already used)
```

Outside the repo (only visible inside the Claude project, not on GitHub): `/mnt/project-files/` holds the
audit state file `engineering-audit/ENGINEERING_AUDIT.md` (phases, findings, measurements; partly Persian),
proof scripts in `engineering-audit/tools/`, the security audit report, battery study, design previews
(themes, avatars, notification, plan cards, profile). If you have that folder, read the audit file before
any audit work.

---

## 4. Architecture

```
                       ┌──────────────────────── Cloudflare (Free plan) ──────────────────────────┐
 Pleat (Android)       │ Worker "cloudgold" (one script, src/index.js)                            │
 ┌──────────────┐ HTTPS│  /api/v1/*      /tg             /sms             /payments/nowpayments/ipn│
 │ Flutter UI   │─────►│  app API        admin bot       bank SMS         crypto gateway           │
 │ AppState     │ race │     │ auth/account/orders │ telegram*.js │ sms.js       │ orders.js         │
 │ ApiClient    │ of N │     └───────────────┬─────┴──────────────┴──────────────┘                   │
 │  ├ direct    │ bases│                     ▼                                                     │
 │  ├ tunnel's  │      │      billing.js: settle() → deliver() → provision() ; walletApply()       │
 │  │ local port│      │                                                                           │
 │  └ bridge    │      │  cron * * * * *  → chainwatch.scanAll → sync.runSync → ensureWebhook      │
 │ Kotlin:      │      │  cron */2 * * * *→ broadcastTick (+ new-build check every 10 min)         │
 │ VpnService   │      │  cron 30 20 * * *→ daily report + backup JSON to Telegram + netstats prune│
 │ Xray core    │      │                                                                           │
 │ hev-tun      │      │  panels.js (registry, adapters, unify)   sync.js (ledger, evaluate, apply)│
 └──────┬───────┘      │  D1 "cloudgold": users, plans, orders, wallet_tx, subscriptions, ...      │
        │              └──────────────────────────────┬────────────────────────────────────────────┘
        │                                             │ HTTPS (panel admin API + subscription)
        │                              ┌──────────────┼──────────────┐
        │                              ▼              ▼              ▼
        │                        PasarGuard #1   Rebecca #2     Marzban #n    (third-party panels)
        └── VLESS/VMess/Trojan/SS/WG/Hy2 ─────► VPN nodes (outside Cloudflare)

 External: api.telegram.org · chain explorers (XLM, XRP, TRX, TON, ALGO) · price/USD-rate sources
           · NOWPayments (optional) · the admin's phone (SMS forwarder app) · GitHub Releases (APKs)
```

Key ideas:

1. **The Worker, not a panel, is the source of truth** for a user's subscription (since PR #4, migration
   0011). Panels are just places where accounts exist; the Worker decides "desired state" and applies it.
2. **All money goes through `settle()`** (wallet, card, crypto, gateway). One function, one atomic claim.
3. **No panel address ever leaves the Worker.** The app gets configs (share links) with unified names like
   `🇩🇪 DE 2`, never panel names or URLs.
4. **The app must reach the Worker from filtered Iranian internet**: several API bases raced in parallel,
   app traffic carried by the tunnel when connected, and a hidden "bridge" core when it is not.

---

## 5. The Worker (backend) in detail

### Entry points (`src/index.js`)

| Path | Auth | Handler |
|---|---|---|
| `GET /health` | none | `{ok:true}`; `?deep=1` also checks D1 and cron age (PR #45) |
| `GET /mini/probe` | none | Mini App stage 0 probe page (HTML, strict CSP): tests whether a Mini App opens on Iranian networks |
| `GET /pay/done` | none | return page after gateway payment (old `cloudgold://` deep link) |
| `POST /sms` | key in `X-SMS-Key` header (was in the URL path until PR #45) | `sms.js` → `settle` |
| `POST /tg` | `TELEGRAM_WEBHOOK_SECRET` (path + `X-Telegram-Bot-Api-Secret-Token`) + admin role per update | `telegram*.js` |
| `GET /api/v1/app-config, /plans, /ip` | none | public settings: extra API bases, bridges, announcement |
| `POST /api/v1/auth/register, login, tg/start, tg/verify, tg/register, refresh` | none; rate limited (IP/login/uid) | `auth.js` |
| `POST /api/v1/mini/probe` | Telegram `initData` (HMAC with the bot token, ≤ 24 h); rate limited per IP | probe result → admin chat (`account.miniProbeReport`) |
| `POST /api/v1/payments/nowpayments/ipn` | HMAC-SHA512 | `orders.js` → `settle` |
| everything else under `/api/v1/` | Bearer access JWT (30 min) + `token_version` + `is_active` | account/orders/netstats/auth |

Authed app routes: `/me`, `/me/ip`, `/me/packages`, `/me/photo`, `/me/email`, `/me/avatar`,
`/me/telegram/start|verify`, `/trial`, `/vpn`, `/vpn/servers`, `/vpn/sub` (old-app format), `/net/report`,
`/net/rank`, `/net/google`, `/coupons/check`, `/devices`, `/devices/:id`, `/wallet`, `/referral`, `/orders`
(GET/POST), `/orders/:id/...` (receipt, paid, cancel), `/app/apk` (APK proxy), `/auth/change-password`,
`/auth/logout-all`.

Routing is hand-written `if` / regex in `route()`. Heavy modules are loaded with `await import()` (this also
breaks import cycles).

### Modules

| File | Responsibility |
|---|---|
| `index.js` | HTTP + cron entry, CORS, routing, default plan seed (`DEFAULT_PLANS`, only when `plans` is empty) |
| `util.js` | JSON/errors, PBKDF2 + pepper, JWT HS256, HMAC, AES-GCM `seal`, rate limit (fail-open on purpose), JSON logs that strip URLs |
| `db.js` | D1 helpers (`first`, `all`, `run`, `insert`), the `settings` key/value store with `SETTING_DEFAULTS`, `touchDevice` |
| `auth.js` | email sign-up/login, Telegram 6-digit code login/sign-up, refresh, change password, link Telegram, backup email, avatar (`AVATARS`) |
| `account.js` | app-config, plans, `/me`, subscription status, server list (`vpnServers`), devices, trial (`startTrial`), Telegram photo |
| `orders.js` | create order (wallet/card/coin/gateway), coupons, receipts, "I paid", IPN, wallet, referral; open-order cap (`too_many_open_orders`) |
| `billing.js` | `settle` (atomic claim), `deliver`, `provision` on all of the user's panels, `walletApply` (atomic), coupons, commission |
| `panels.js` | panel registry, encrypted credentials, `adapterFor`, rollout buckets, `unify` (merge + rename configs, drop placeholders), `testPanel`, drain |
| `sync.js` | usage ledger (`observe`), `evaluate` (quota/expiry over ALL panels), idempotent apply, create missing accounts, `linkAccount`, `runSync` (cron slice) |
| `pasarguard.js` | PasarGuard API client (login, token cache in isolate, timeouts), subscription decode, `/links` fallback |
| `marzban.js` | Marzban + Rebecca adapters, `detectKind` |
| `chainwatch.js` | reads five chains, matches deposits to orders, `claimTxid` (one txid = one order, atomic) |
| `coins.js`, `usdrate.js`, `nowpayments.js`, `banks.js` | coin prices, USD→toman rate, gateway invoices, bank name from card number |
| `sms.js` | parses bank SMS (rial vs toman!), auto-confirms card-to-card orders |
| `netstats.js` | crowd ranking of exits per operator (Cloudflare ASN), province, network kind; per-user experience |
| `appupdate.js` | reads the private `pleat-latest` release with `PLEAT_DL_TOKEN`, serves version info, proxies the APK, `checkNewBuild` |
| `telegram.js` | Telegram client, admin roles, order callbacks, `ensureWebhook`, `sendBackup`, legacy text commands, `buttonize` |
| `telegram-menu.js` | button menu router, forms (`bot_session`), confirms |
| `telegram-screens.js` | read-only bot screens |
| `admin-actions.js` | **every bot write**: validate → one D1 batch → audit → undo; broadcasts (`broadcastTick`) |

### Auth facts
- Passwords: PBKDF2-SHA256, **5,000 iterations** over HMAC(SECRET_KEY, password). **Do not raise the
  iterations** — on the Free plan's 10 ms CPU it breaks login.
- JWT HS256, access 30 min, refresh 60 days (not rotating; `logout-all` bumps `token_version`).
  Key = `JWT_SECRET`, or `SECRET_KEY` if unset.
- Telegram login: the bot sends a 6-digit code (5 min, 5 tries, rate-limited per Telegram id + IP). The
  numeric Telegram id is the identity; @username is an alias. The user then sets an app password. Email login
  is kept as a backup. **Google login never existed.**
- Free trial: only for accounts with a verified Telegram (`trial_needs_telegram=1`, Ali's choice 2026-11-08;
  bot toggle exists). Currently no plan has trial days anyway.

### Secrets (Workers Secrets; names checked by the deploy, values never in GitHub)
`SECRET_KEY` (pepper, JWT fallback, HKDF for panel creds — **rotating it means re-entering all panel logins**),
`JWT_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (owner admin), `TELEGRAM_WEBHOOK_SECRET`
(**deploy halts without it**), `TELEGRAM_BOT_USERNAME`, `PUBLIC_BASE_URL`, `PASARGUARD_URL/USERNAME/PASSWORD/
API_KEY/USERNAME_PREFIX` (panel 1), `PANEL_<id>_CRED` (optional), `NOWPAYMENTS_*`, `PLEAT_DL_TOKEN` (copied by
the deploy from the GitHub secret of the same name).

GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `APP_KEYSTORE_BASE64/PASSWORD/ALIAS`,
`APP_KEY_PASSWORD` (the release signing key — Pleat is signed with it), `PLEAT_BRIDGE`, `PLEAT_DL_TOKEN`.
Variable: `CG_API_BASE` (API base list for builds).

Since PR #4 the deploy does **not** upload GitHub secrets to the Worker; it only checks that the names exist.
Changing a Worker secret = Cloudflare dashboard → Worker → Settings → Variables and Secrets.

### Runtime settings (`settings` table, edited from the bot)
Card number/holder/bank, `card_unique`, `card_auto` (auto/detect/off), `sms_senders`, `sms_key`, coin wallets
and memos, `coin_auto`, `usd_rate_toman`, `referral_percent`, `min_topup_toman`, `announcement`,
`app_api_bases` (extra Worker domains pushed to installed apps), `app_bridges` (bridge share links),
`trial_data_gb`, `trial_needs_telegram`, `app_release` (in-app update announcement), encrypted
`panel_cred_<id>`, `panel_err_<id>` and more. Defaults are in `db.js` `SETTING_DEFAULTS`.

---

## 6. Database (D1)

About 31 tables. Main ones:

- `users`, `devices`, `tg_logins`, `user_skeys`
- `plans` (with `archived`), `subscriptions` (one per user), `sub_periods` (package history)
- `orders` (statuses incl. `settling` claim with a lease, `provisioned_at`, `receipt_upload`), `wallet_tx`
  (nonce + `UNIQUE(order_id, reason)`; a trigger keeps the wallet ≥ 0), `coupons`, `coupon_uses`
- `panels` (state machine), `panel_accounts` (`UNIQUE(user_id, panel_id)` and `(panel_id, remote_username)`),
  `usage_counters`, `sync_cursor`
- `settings` (key/value for almost everything)
- bot: `bot_session` (form state, 10 min), `bot_confirm`, `admin_audit` (+ undo), `admins` (roles
  owner/support/viewer), `broadcasts`, `server_overrides` (hide/rename an exit)
- network stats: `net_stats`, `net_geo`, `google_probe`, `net_votes`, `google_votes`, `net_speed_votes`,
  `user_net`, `user_net_srv`
- `sms_log`

Facts to remember:
- **No foreign keys** anywhere; integrity is in code. A user "delete" is soft (email becomes
  `deleted+<id>@invalid`).
- `txid` uniqueness is enforced by a single conditional UPDATE in `chainwatch.claimTxid`, not a constraint.
- Migrations are forward-only, no rollback. Two files are numbered 0015; wrangler sorts by name and it works.
  **Never rename an applied migration.**
- Backup = a daily JSON of 14 tables (no password hashes, sub URLs, panel creds, SMS key or bridges) sent to
  the admin's Telegram. There is no restore tool; real recovery is D1 Time Travel.

Migration history: 0001 init · 0002 coupons/autobuy · 0003 crypto (own wallets) · 0004 memos · 0005 card SMS ·
0006 net stats · 0007 geo/Google · 0008 atomic wallet · 0009 order claim · 0010 indexes · 0011 control plane
(multi-panel) · 0012 security fixes (votes) · 0013 carrier speed · 0014 Telegram login · 0015 profile ·
0015 receipt upload · 0016 avatar · 0017 per-user network · 0018 admin panel · 0019 admin stats indexes.

---

## 7. Payments and `settle`

Every way of paying ends in `billing.settle(order)`:

| Method | How it is confirmed |
|---|---|
| **Wallet** | immediate; `walletApply` debits atomically (D1 batch + one-time nonce + non-negative trigger) |
| **Card-to-card** | the order gets a **unique amount** (base + 1…99 toman). The bank's deposit SMS, forwarded from the admin's phone to `/sms`, is parsed by `sms.js` and matched by amount → `settle`. Or the user uploads a **receipt photo** and the admin approves it with a bot button. `card_auto`: auto / detect (ask admin) / off. |
| **Crypto to the admin's own wallets** | unique amount (+ memo where the chain needs one). `chainwatch.scanAll` (every minute) reads XLM, XRP, TRX, TON, ALGO explorers, `claimTxid` binds one txid to one order. Other coins (13 listed in settings) are confirmed by the admin. Inexact amounts go to admin review. |
| **NOWPayments** (optional) | signed IPN → `settle` |

`settle` claims the order atomically (status `settling`, 120 s lease) so two confirmations can never deliver
twice; `deliver` then `provision`s the plan on **all** of the user's panels and records `provisioned_at` in the
same batch as the new period (C5 fix). Remaining time and unused data both carry over on an early renewal (Ali, 2026-11-11): the new limit = new plan GB + what was left (read live from the panels first); an expired package starts fresh.

Guards added after audits: max **3 open orders per method** per account (idle card orders > 30 min and stale
quotes auto-closed; otherwise `429 too_many_open_orders`); an expired crypto quote goes to admin review
instead of auto-paid; rate limits on orders, receipts, "I paid" and refresh.

**The SMS amount unit bug (F1)**: Iranian bank SMS show **rials**, prices are **toman** (×10). This was a real
HIGH bug (pay 1/10 of the price). Any SMS code change must keep rial/toman straight.

---

## 8. Panels and the control plane

- Panel types: **PasarGuard**, **Marzban**, **Rebecca** (a Go rewrite of Marzban; users must belong to exactly
  one service; plain links at `<sub>/v2ray`). Adapters in `pasarguard.js` and `marzban.js`, registry `ADAPTERS`
  in `panels.js`. Kind `auto` is detected on the panel test (Rebecca = `/api/v2/services`, PasarGuard = groups,
  Marzban = `/api/inbounds`). **Hiddify is not supported** (different API).
- Panel lifecycle: `new → testing → rollout → active → draining → disabled`. Rollout is a percentage with a
  stable hash bucket per user. Drain moves users off.
- Panel login is entered **in the bot chat** (address, user, pass). The message is deleted, the creds are sealed
  with AES-GCM (HKDF from `SECRET_KEY`, bound to the panel id) in `settings.panel_cred_<id>`, excluded from
  backups. Change with "🔐 ورود پنل". Panel 1 still reads `PASARGUARD_*` secrets.
- **Accounts on a new panel**: created on demand when the app opens (`/vpn/servers`), plus up to 8 per cron run
  in the background; refused creates are kept in `panel_err_<id>` and Ali is alerted (at most every 6 h).
- **Usage**: the cron reads one page of one panel per run (round-robin), adds deltas to `usage_counters`,
  `evaluate` decides over the **sum of all panels**, and the desired state (active/limited/expired) is applied
  idempotently to each panel. **Manual edits on a panel don't stick** — the Worker re-applies its state. Use the
  bot's grant/reset instead.
- **Linking an existing panel account** to an app user: bot user card → "🔗 وصل اکانت پنل" (`linkAccount`).
  A second linked account joins the same period (it used to restart it — fixed in PR #37). Ali chose
  **bot-only linking**; do not build in-app self-linking by sub link.
- **Server list** (`/vpn/servers`): subscriptions of all panels are fetched (in parallel, 5 s deadline per
  panel on the user path since PR #45), placeholders dropped (Rebecca emits a `0 B / ∞` row at `127.0.0.1:1`),
  duplicates merged, names unified to `🇩🇪 DE 2`, `server_overrides` applied.
  The country comes from `worker/src/countries.js` (`countryOfLink`): flag emoji, English/Persian country or
  city name, a two-letter code token, then a host label like `de1.`. Before that only a flag counted, so remarks
  without a flag showed as "Unknown country". No country → `Server N`; the bot's server card shows the panel's
  remark and the admin can give a label with a flag.
- PasarGuard may serve Xray JSON to a v2rayNG user agent; `collectLinks` falls back to `<sub>/links` (PR #9).
- Panel 1 is still special in a few places (always in provision, HWID only for panel 1, device removal only on
  panel 1, buying needs `PASARGUARD_URL`). Audit items AD3/P17, not yet fixed.
- Ali's panels are **https**. Since PR #45 only https panel logins are accepted.

---

## 9. The admin Telegram bot

- Webhook `/tg`, secret in path **and** header; `ensureWebhook` (every minute) re-registers if needed. A manual
  `wrangler deploy` (outside the workflow) needs the webhook re-registered with `secret_token`.
- Admin only from a **private chat** with the right `from.id` (N1 fix). Owner = `TELEGRAM_CHAT_ID`; extra admins
  in `admins` with roles owner/support/viewer.
- **Full control panel** (PR #37, 5 stages): 12 sections — inbox, users, plans, orders + wallet, panels +
  servers, coupons + referral, payment methods, Pleat app (domains, bridges, announcement, trial, app version),
  network ranking, broadcast, stats, system (audit log, backup, health).
- Risk levels: read / reversible (applied + 10-minute undo) / money or access (confirm, 2 min) / destructive
  (confirm with an impact summary). Every write goes through `admin-actions.js` with an audit row.
- Notable screens: user card (subscription, wallet, devices, security, soft delete, "🔗 وصل اکانت پنل",
  "📶 تجربه اتصال"), "👥 کاربران و اپراتورهایشان", "📱 اپ Pleat › 📲 نسخه‌ی اپ" (announce / mandatory /
  withdraw an update), panel list with rollout progress.
- Broadcasts are sent 25 messages per `*/2` cron run (own invocation, own subrequest budget).
- Legacy text commands still work (hidden) via `runAdminCommand`.
- Known: default plan names come back Persian (the Worker translates them); rename plans in the bot.

---

## 10. Pleat, the Flutter app

Version on main: **1.2.23+26** (`flutter_vpn/pubspec.yaml`). PR #46 (open) = 1.2.24.
**Every release must bump the build number** (the `+N`), or the in-app updater won't see it as newer.
Flutter 3.47.8, Java 17, NDK 29, minSdk 24. Core: `libv2ray.aar` from AndroidLibXrayLite tag **v26.7.5**
(Xray 26.6.27 inside), hev-socks5-tunnel commit `67dfba56`.

### Look and feel
- Design DNA: pale-blue ground, white radius-30 cards, navy/blue/ice/mist diagonal "shards", Plus Jakarta Sans,
  pill controls. Name and mark (two offset folded planes) are original.
- **Day/Night**: day = original sky blue (`PPalette.sky`), night = same blue on dark navy (`PPalette.skyNight`).
  ONE "Night mode" toggle in Profile, follows the phone until the user touches it. WCAG AA contrast test in
  `test/theme_test.dart`. Every colour comes from `PColors` (palette-driven) — never hardcode colours.
- Plans: Ali sells **monthly data-volume plans**; the **big number is the GB** (∞ for no cap), days on a small
  line (`planBig`/`planUnit` in `screens/store_kit.dart`). Bot lists also lead with GB.
- Profile: mandatory verified Telegram username + optional backup Gmail; one line "Data and days · X GB left · N
  days left" that opens a bottom sheet with pleats (data), day dots and package history; long emails always fit
  one line (`FitLine`). 14 "Folk" avatars (SVG) override the Telegram photo, stored server-side.
- Home "Now" shows country + city + exit IP (from `/me/ip`, through the tunnel) instead of a timer.
- Notification "Pleat card" (`TunnelNote.kt`): flag tile, Protected dot, place · timer (system Chronometer),
  Disconnect + Change location. Colours follow the phone's night mode.

### How connecting works
1. `GET /vpn` checks the plan; configs come from `/vpn/servers` (cached in secure storage for offline use).
2. `xray_config.dart` builds an Xray JSON from the share link, matching v2rayNG's behaviour (SNI fallback,
   CDN-fronted XHTTP pins, empty query = absent, finalmask, ws host, gRPC authority, ECH, Hysteria2, WireGuard …).
   **WireGuard MTU is forced to 1280** (links say 1420 → no traffic).
3. `PleatVpnService` routes all IPv4 + IPv6 + DNS into a tun → hev-socks5-tunnel → core SOCKS (127.0.0.1:10808,
   **with a random per-install login** since 1.2.23) → exit. "Protected" is shown only after a probe has
   crossed the exit.
4. **Smart connect**: rank by the current network's ping + speed, start with the best; when smart connect is
   on and the exit is not pinned, the core runs a `leastPing` balancer with 2 backups (failover inside the
   core, 1.2.22). Switching exits hands over the tun without tearing it down (no leak), a failed try keeps the
   tun 20 s.
5. Split tunnel option: Iranian sites/IPs direct (geo files from Loyalsoldier, fetched in CI), QUIC blocked.

### Reaching the Worker from filtered Iran (PR #30, 1.2.12 — the key resilience design)
- **Root cause found**: Pleat excluded itself from its own tunnel (as v2rayNG does), so signup/login/receipts/
  configs went over the filtered line even while connected.
- Now: while connected, the app's API calls go through the tunnel core's **local HTTP port** (127.0.0.1:10809,
  per-install user:pass). Only `/net/*` goes direct (carrier ranking needs the real ASN).
- When the VPN is off and the API is unreachable, a hidden **bridge** (second core, no tun, port 10810, only the
  Worker's hosts allowed) starts from the user's own working exits, then bot-set `app_bridges`, then the build
  secret `PLEAT_BRIDGE`. Auto-off after 3 min idle.
- All API bases (build list + `app_api_bases` from the Worker) are raced in parallel; the winner is kept 10 min.
  POSTs are never resent.
- Receipts are downscaled natively (1600 px JPEG) and queued offline; `upload_id` dedupes.
- API base = Ali's custom domain first, then the `workers.dev` address (both in `CG_API_BASE` / workflow input).

### Network ranking (PR #19, #36)
Network kind (Wi-Fi/mobile) detected on device, operator resolved by the Worker (Cloudflare ASN). Results kept
per network ("On Irancell Wi-Fi"). Ping hourly on app open, speed for the top 3 every 6 h (also on mobile data,
capped). "Best" = this network's ping + speed; Recommended = first 4 working Best exits. Speed is ~1 MB through
a throw-away core (`Speed.kt`), shown as a badge tint (fast ≥ 6000 kbps, fair ≥ 1500).

### Battery (PR #18, 1.2.3)
Measured with fake time: screen-off pings/h 180 → 20, `/me`/h 60 → 6, shard paints 625 → 80 per 10 s; metered
networks: no auto speed tests, rarer pings. Never mix metered and unmetered results in a report.

### In-app update (PR #40, 1.2.19)
The workflow uploads per-ABI APKs `pleat-<ver>-<build>-<abi>.apk` to the private release `pleat-latest`
(keeps the last 3; `pleat.apk` = arm64). The Worker reads the release with `PLEAT_DL_TOKEN` and proxies a
resumable download; the app checks SHA-256 and hands it to Android's installer (`Updates.kt`). Ali announces /
forces / withdraws from the bot. **No chunking** (Ali refused KV/R2 splitting). Installed build =
`versionCode % 1000`. The install step was **not tested on a real phone** at the time of writing.

### Diagnostics
Profile → **Connection check**: tests every exit (own native 10 s budget per test since 1.2.21), shows cause /
fix / advice (`diagnose.dart`), "Copy report" (real app version), and **"Test alone + copy core log"** per exit
(debug log, hosts blanked). This is the tool that ends arguments — use it.

### State and code notes
- `AppState` (~2,260 lines, ChangeNotifier) is a god object; `profile.dart` ~1,640 lines. Known, not refactored.
- `ApiClient` signs out only on refresh 401/403 (not on any error; fixed 1.2.20).
- Tokens, device id, account cache and configs live in `flutter_secure_storage` (Keystore). `allowBackup=false`.
- X-HWID / device headers identical to the old app (panel 1 has an hwid limit).

---

## 11. Build, test, deploy

### Worker
```sh
cd worker
npm test            # node --experimental-sqlite test/run.mjs  (Node 22)
npm run coverage    # c8, ≥ 80% lines/functions/statements (actual ~97% lines)
```
- `test/run.mjs` is one large file with a hand-made harness. The shim runs real Worker code on node:sqlite with
  fake panels and counts queries.
- **The suite fails any single invocation (request or cron run) that issues more than 50 D1 queries** (a batch
  counts as 1). This guards the Free plan cap. Keep it.
- `test/dev_server.mjs` starts the Worker + fake panel on `127.0.0.1:8787` for Pleat's live test.

### Pleat
```sh
cd flutter_vpn
flutter pub get
flutter analyze
flutter test
node --experimental-sqlite ../worker/test/dev_server.mjs &
flutter test test/live_backend_test.dart --dart-define=LIVE_API=http://127.0.0.1:8787
```
- Flutter SDK 3.47.8 can be downloaded in the cloud container (storage.googleapis.com + pub.dev reachable),
  but **there is no Android SDK**: APKs are built only by the workflow. github.com downloads may be blocked
  from the container (use proxy.golang.org for Go sources such as Xray or Rebecca).
- Screenshots for Ali: local-only golden tests with Plus Jakarta Sans TTFs and Noto Color Emoji fetched from
  Google Fonts. **Never commit those screenshot tests or images.**

### Workflows
| Workflow | Trigger | Notes |
|---|---|---|
| **Test Cloud Gold server** (`test-worker.yml`) | push/PR on `worker/**` | coverage gate |
| **Pleat Flutter app** (`flutter-vpn.yml`) | push/PR + manual (`api_base` input) | format, analyze, test, live test, `xray -test` of generated configs with the **exact** app core (built from libv2ray buildinfo), APK build, APK check. Manual run → publishes to release `pleat-latest`. ~18 min. |
| **Deploy Cloud Gold server** (`deploy-worker.yml`) | **manual only** | tests → secret names check → find/create D1 → apply migrations → deploy → copy `PLEAT_DL_TOKEN` |

- CI download hardening (PR #42): Actions cache of every download, Xray from `ghcr.io/xtls/xray-core` as a
  fallback, jsDelivr mirror for geo files, Gradle prefetched with retries, Google's Maven Central mirror via an
  init script. If a run still fails on a 504, just re-run it.
- `XRAY_LIB_TAG` (v26.7.5) is AndroidLibXrayLite's tag; Xray-core has no release by that name.
- Pleat APK download link for Ali: release `pleat-latest`, asset `pleat.apk`. Ali sends it to users by hand.
- After a merge that touches `worker/`: tell Ali to run **Deploy Cloud Gold server**. After a merge touching
  `flutter_vpn/`: run **Pleat Flutter app** from `main` (with `api_base`). Last known deploy: run #37
  (2026-11-08, after PR #41); check whether #44/#45 were deployed before assuming.

---

## 12. Cloudflare Free plan limits (hard constraints)

Ali is on the **Free** plan (confirmed, no trial). Design every change around these:

| Limit | Consequence |
|---|---|
| **10 ms CPU** per invocation | no heavy crypto (PBKDF2 stays at 5,000), no big JSON loops |
| **50 subrequests** per invocation | panel calls, Telegram, explorers all count; budget the cron |
| **50 D1 queries per invocation** (a batch = 1) | the 51st fails. Batch reads and writes. Test suite enforces it. |
| **~100k D1 writes/day** | the old cron wrote 2 rows per user per minute even when idle → cap hit at ~35 users (PR #41: writes only on change). A phone that keeps the VPN on still changes its counter every minute, so the cap was still ~33 always-on users; the engineering-audit phase 6 PR spreads those writes (`LEDGER_EVERY` = 10 min in `sync.js`, never for big changes, near-quota, panel resets or a user coming online): 100 always-on users went from 295k to 33k rows/day (measured). Stored "online now" therefore means seen in the last 13 min (`STORED_ONLINE_SEC`); the bot's live card is exact. |
| Rate limiting is per Cloudflare location and fail-open | do not rely on it as a security boundary |

---

## 13. History: from the first commit to today

**2026-10-27 — import.** Ali uploads his CloudGold v1.7.1 project (Worker + old v2rayNG-based app + web UI).

**2026-10-28 — hardening and the old app's UI.**
- PR #1: atomic wallet, atomic order claim in `settle`, locked Telegram webhook.
- PR #2: rate limits, optional `JWT_SECRET`, no hashes in backups, coupon/trial races, indexes, CI tests on push.
- PR #3: old app UI phase 2 (WebView `app-web/`), `used_percent` on `/me` (Ali: usage % must come from the server).
- Reviews (architecture, Cloudflare, Android/OWASP, DB, testing) delivered as documents.

**2026-10-29 — multi-panel and the birth of Pleat.**
- PR #4 (Phase 1 stage 3): multi-panel control plane; the Worker owns subscriptions; no panel address leaves it.
- PR #5: old app redesign "Vault & Hallmark", English only.
- PR #6: **Pleat** created as a Flutter demo in `flutter_vpn/`, then bound to the Worker and given a native
  tunnel (VpnService + libv2ray + hev). **Decision the same day: retire Cloud Gold app, Pleat becomes THE
  product app with full parity.**
- PR #7–#9: real panel connection, smart connect, stable signing with the release key, X-HWID, 30 s timeout,
  OkHttp-like connections, Connection check, proguard keep rules (R8 broke the engine), `/links` fallback.

**2026-10-30 — making the tunnel actually work.**
- PR #10: engine check didn't cache an early "no". PR #11: bot inline button menu.
- PR #12: Locations grouped by country, host settings reach the core, connection diagnosis.
- PR #13: configs built exactly like v2rayNG; per-test deadlines. PR #14: the tunnel really connects (EventChannel
  replay caused a failover storm), Cancel doesn't freeze, cached launch. Ali confirmed connect works.

**2026-10-31 — speed, battery, security round 1, carrier ranking.**
- PR #15 speed badge per exit; PR #16 link existing panel account; PR #17 security fixes F1–F6 + N1;
  PR #18 battery/CPU (1.2.3); PR #19 results per network + ranking by operator (1.2.4, migration 0013).

**2026-11-04 — panels of any type, Telegram login, protocol fixes.**
- PR #20 tap a flag to test now; PR #22 Rebecca/Marzban adapters + auto-detect + login in bot; PR #23 APK to the
  `pleat-latest` release (artifact storage full); PR #24 new panels reach existing users at once, bot buttons
  only; PR #25 Hysteria2 + WireGuard; PR #26 Connection check tests every exit; PR #27 Telegram sign-up/login;
  PR #28 (wrong theories, see §17); PR #29 per-exit core log, placeholder rows dropped, **WireGuard MTU 1280**
  (proven fix for DE 7 / DE 10).

**2026-11-05 — resilience, profile, themes, ranking v2.**
- PR #30 reach the Worker on filtered lines (1.2.12); PR #31/#33 profile; PR #32 avatars; PR #34 gold theme
  (rejected afterwards) → PR #35 blue/navy + one Night mode switch; PR #36 per-user network ranking + Home IP.

**2026-11-06 — admin control panel and notification.**
- PR #37 full bot control panel (5 stages) + cross-panel link fix; deployed (0018/0019 applied).
- PR #38 plan cards lead with GB; PR #39 "Pleat card" notification (1.2.18).

**2026-11-07 — in-app update and the engineering audit begins.**
- PR #40 in-app update (1.2.19). Engineering audit (15-phase master prompt) phases 1–3; PR #41 fixes the
  50-query cap (C1), `GET /orders` 500 (C2), sign-out on any refresh error (C3), double renewal (C5) — 1.2.20.

**2026-11-08 — CI outage, network phase, audit fixes.**
- PR #42 CI survives GitHub release 504s. PR #43 no false timeouts in Connection check (1.2.21).
- Audit phase 4 (security) and phase 5 (VPN network). PR #44 exit IP through tunnel, no leak while switching,
  core failover (1.2.22). PR #45 fixes all open phase 1–5 findings, SOCKS login, trial needs Telegram (1.2.23).
  Ali's 1.2.23 report: 17/30 exits OK on device; the SOCKS login works.
- PR #46 (open): 1.2.24, Google opens on an exit without IPv6.

---

## 14. PR index

| # | Merged | What |
|---|---|---|
| 1 | 10-28 | Atomic wallet and order settlement, locked-down Telegram webhook |
| 2 | 10-28 | Rate limits, JWT key, coupon/trial races, CI, Android backup/TLS (old app) |
| 3 | 10-28 | Old app UI phase 2 |
| 4 | 10-29 | Multi-panel control plane (migration 0011) |
| 5 | 10-29 | Old app redesign, English only |
| 6 | 10-29 | Pleat created, bound to the Worker, native tunnel |
| 7 | 10-29 | Pleat: real panel connection, smart connect, live switches, stable signing |
| 8 | 10-29 | Pleat: reach the Worker like OkHttp, Connection check, network handover |
| 9 | 10-29 | Engine through R8, device headers, Worker `/links` fallback |
| 10 | 10-30 | One engine check; don't remember an early "no" |
| 11 | 10-30 | Bot inline button menu |
| 12 | 10-30 | Locations by country, host settings, diagnosis |
| 13 | 10-30 | Configs like v2rayNG, per-test deadlines |
| 14 | 10-30 | Tunnel really connects, Cancel doesn't freeze (1.2.1) |
| 15 | 10-31 | Download speed per exit (1.2.2) |
| 16 | 10-31 | Bot: link an existing panel account |
| 17 | 10-31 | Security fixes F1–F6, N1 (migration 0012) |
| 18 | 10-31 | Battery and CPU (1.2.3) |
| 19 | 10-31 | Results per network, rank by operator (1.2.4, migration 0013) |
| 20 | 11-04 | Tap a flag to test now (1.2.5) |
| 21 | open | Early Rebecca adapter draft, untested live — most likely superseded by #22; check, then close |
| 22 | 11-04 | Rebecca + Marzban adapters, auto-detect, login in bot |
| 23 | 11-04 | Manual Pleat build → release `pleat-latest` |
| 24 | 11-04 | New panels reach existing users; bot buttons only |
| 25 | 11-04 | Hysteria2 + WireGuard (1.2.6) |
| 26 | 11-04 | Connection check tests every exit (1.2.7) |
| 27 | 11-04 | Telegram sign-up/login (migration 0014, 1.2.8) |
| 28 | 11-04 | WG-by-name DNS + no h2 on WS (1.2.9) — theories that did not fix the failures |
| 29 | 11-04 | Per-exit core log, placeholder rows dropped, WG MTU 1280 (1.2.11) |
| 30 | 11-05 | Reach the Worker on filtered lines (1.2.12, migration 0015 receipt) |
| 31 | 11-05 | Profile: Telegram verify, backup Gmail, pleats and dots (migration 0015 profile) |
| 32 | 11-05 | 14 avatars (migration 0016) |
| 33 | 11-05 | Profile sheet, emails fit (1.2.13) |
| 34 | 11-05 | Gold theme (1.2.14) — rejected by Ali afterwards |
| 35 | 11-05 | Blue by day, navy by night, one switch (1.2.15) |
| 36 | 11-05 | Per-user network ranking, Home IP (1.2.16, migration 0017) |
| 37 | 11-06 | Admin bot full control panel + link fix (migrations 0018, 0019) |
| 38 | 11-06 | Plans: data big, duration small (1.2.17) |
| 39 | 11-06 | Pleat card notification (1.2.18) |
| 40 | 11-07 | In-app update (1.2.19) |
| 41 | 11-07 | 50-query cap, C1/C2/C3/C5 (1.2.20) |
| 42 | 11-08 | CI survives GitHub 504s |
| 43 | 11-08 | No false timeouts in Connection check (1.2.21) |
| 44 | 11-08 | No leak while switching exits, core failover (1.2.22) |
| 45 | 11-08 | All open audit findings of phases 1–5, SOCKS login, trial needs Telegram (1.2.23) |
| 46 | open | Google on an exit without IPv6 (1.2.24) |

---

## 15. Problems found and how they were fixed

Grouped by area. "Proven" means reproduced or measured.

### Money and orders
| Problem | Fix |
|---|---|
| Concurrent purchases could overspend the wallet | atomic `walletApply` (batch + nonce + trigger) — #1 |
| Two confirmations at once delivered an order twice | `settle` claims with status `settling` + lease — #1 |
| **F1** bank SMS in rials read as toman → pay 1/10 | unit handling in `sms.js` — #17 |
| **F2** crypto: 2% band + shared memo let one user's tx pay another's order | exact match, inexact → admin — #17 |
| **F3** one txid could pay many orders (race) | atomic `claimTxid` — #17 |
| **F4** coupon reuse via expired/rejected orders | coupon use rules — #17 |
| C2 `GET /orders` with 25 card orders → 500 (query cap) | preload in one query — #41 |
| C5 crash between `provision` and `provisioned_at` → double renewal | same batch — #41 |
| **S1** (proven) 99 open card orders by one account broke card buying for everyone for 36 h | 3 open orders per method, auto-close stale — #45 |
| S2 40 open coin orders starved cron auto-confirm; S3 expired quote auto-paid | same cap; stale quote → admin — #45 |

### Backend robustness
| Problem | Fix |
|---|---|
| Telegram webhook open without a secret | secret in path + header — #1 |
| **C1** (proven) cron used 14 + 7N queries → silently broke from 6 users/panel on the 50-query cap | one read per page, one batch of writes, write only on change; suite fails any invocation > 50 — #41 |
| AD1 (measured) 2 D1 writes per user per minute even idle → daily write cap at ~35 users | same — #41 |
| AD2 (measured) one dead panel made `/me` and server list wait 15 s for everyone | panels in parallel, 5 s user-path deadline — #45 |
| S4 malformed JWT → 500 | 401 — #45 |
| S5 SMS key in URL path ended up in logs | `X-SMS-Key` header — #45 |
| PasarGuard served Xray JSON to v2rayNG UA → 0 links → 503 | `/links` fallback — #9 |
| Rebecca added as PasarGuard failed (needs `service_id`) | real adapters + auto-detect — #22 |
| New panel had no accounts for existing users | on-demand + background create — #24 |
| Linking a second panel account restarted the period (lost usage) | merge into same period — #37 |
| Rebecca `0 B / ∞` placeholder row shown as a server | dropped in `unify` — #29 |

### App and tunnel
| Problem | Fix |
|---|---|
| APK wouldn't install/update (per-runner debug key) | sign with the release key — #7 |
| R8 stripped the Go engine → "no engine" | proguard keep rules — #9 |
| First "engine unavailable" was cached forever | cache only success — #10 |
| EventChannel re-opened each attempt replayed old states → failover storm, heat; Cancel froze | listen once; native ops executor — #14 |
| Configs failed where v2rayNG worked | config builder made identical to v2rayNG — #13 |
| WireGuard exits with MTU 1420 timed out (**proven by core logs**) | MTU forced to 1280 — #29 |
| **Pleat excluded itself from its tunnel → API on the filtered line** | app traffic via tunnel's local port; bridge core; base racing — #30 |
| C3 any non-200 refresh signed the user out | sign out only on 401/403 — #41 |
| Connection check: dead exits held the 6 native threads ~24 s (core test = 2 tries × 12 s), so later exits "timed out" untried (**proven from AndroidLibXrayLite source**) | native 10 s budget from real start — #43 |
| Report showed a hard-coded version | real version — #43 |
| N1 tun closed during switch/failover → traffic leaked direct | tun handover, keep tun 20 s on a failed try — #44 |
| N2 failover only in Dart timers | core balancer (leastPing + observatory) — #44 |
| N3 CI checked configs with latest Xray, app ships 26.6.27 | CI builds the exact app core — #44 |
| Exit IP on Home showed the local IP (raced tunnel vs open line) | tunnel first, `/me/ip` tunnel-only — #44 |
| S7 core SOCKS 127.0.0.1:10808 had no auth (any app could use it) | random login per install (Kotlin + hev) — #45, **proven on Ali's phone** |
| P11 `allowBackup` default true | false — #45 |
| Google not opening while Telegram works on some exits | [guess] IPv6 black hole (tun routes `::/0`, exit has no IPv6) — #46 open; Ali was asked to compare ipv4.google.com vs ipv6.google.com |

### CI
| Problem | Fix |
|---|---|
| Artifact storage full | APKs to release `pleat-latest` — #23 |
| GitHub release downloads 504 for hours (Xray, geo, Gradle, Maven) | cache + mirrors for every download in one go — #42 |

---

## 16. Server-side faults (not fixable in the app)

Proven with the per-exit core log. Ali must fix these on the panels/nodes; do not try app-side fixes.
(Names are the unified exit names; they can shift when panels change.)

- **WS exits (AM 1, MX 1, NO 1, RU 1, RU 2, earlier CH 1)**: TLS + WS upgrade OK, then the server closes the
  WebSocket (code 1000) right after the VLESS request → the node rejects the user/inbound (account not on that
  node, or the path maps to a wrong inbound). "closed pipe" = this.
- **TR (WS :8125)**: connection refused — nothing listening on that port.
- **TR (XHTTP behind CDN)**: CDN answers 504.
- **TR (WireGuard :12606)**: no handshake reply (UDP filtered or server down).
- **FI 2 (Shadowsocks :111)**: port 111 blocked — change the port.
- **DE 1 / NL 1 (REALITY)**: TCP timeout / no server hello.
- **GB 1 / TR 1 / US 1 (REALITY + Vision)**: auth and inner TLS succeed, the HTTP answer never comes after
  Vision switches to direct → server side ([guess]: old node core, or egress problem).

---

## 17. Wrong theories — do not revisit

- **WireGuard domain-endpoint DNS deadlock** (PR #28): the core's MeasureOutboundDelay keeps only
  outbound/dispatcher/log, so DNS changes were irrelevant to the check. The real fix was MTU 1280.
- **WebSocket h2 ALPN** causing closed pipes (PR #28): not the cause; closed pipes are server-side (§16).
- In general: **no more theory patches** for failing exits. Ask Ali for "Test alone + copy core log" traces
  and fix only on evidence.

---

## 18. Rejected design directions — do not offer again

- **Gold** look (both all-gold and gold-and-white themes) — rejected after shipping 1.2.14.
- **Background clouds** of any style (soft, Japanese, swirl …) — Ali said no clouds at all.
- Day/Night/Auto three-way picker — replaced by one Night mode switch.
- Neon/glow/rainbow/"2026 trendy" visuals — designs must use Pleat's own language (white rows, slanted shards,
  blues).
- APK **chunking/splitting** into KV/R2 parts for updates.
- In-app self-linking of panel accounts by subscription link (bot-only).
- Committing large binaries to the repo to dodge CI downloads.
- Persian text, RTL or a language picker in Pleat.

---

## 19. Open items and known gaps

### Waiting on Ali
- PR #46 (1.2.24, IPv6) — result of the ipv4/ipv6 Google test, merge, build.
- Deploy the Worker if #44/#45 were not deployed yet; confirm with `/health?deep=1`.
- Fix the server-side exits in §16.
- In-app update install step: first real-phone test.
- The old `/credit <email> <amount> <note>` manual wallet top-up idea (offered, awaiting a yes) — if built, it
  must be a bot button flow, not a typed command.
- PR #21 is most likely superseded by #22; check and close it.

### Telegram Mini App (stage 1 built)
- Stage 0 result (Ali's phone, 2026-11-08): with only Telegram's proxy the Mini App did **not** open; it opens with a
  VPN on. Ali chose to build it anyway, for users who have a VPN on (e.g. Pleat connected). The probe stays at
  `/mini/probe` (bot: 📱 اپ Pleat › 🧪 تست Mini App).
- Code: `miniapp/` (Preact 10 + esbuild, pinned, lockfile; `npm test`, `npm run build` → `worker/public/`, gitignored).
  Served by the same Worker as static assets (`wrangler.jsonc` `"assets": {"directory": "public"}`) at `/app/`;
  headers/CSP in `miniapp/src/_headers`. The deploy workflow builds it before `wrangler deploy`.
- Sign-in: `POST /api/v1/auth/tg/webapp` (`auth.webappLogin`, initData ≤ 1 h) → access token only, `src: "mini"`;
  `{need_account}` for a new Telegram user; `POST /api/v1/auth/tg/webapp/register` makes the account in one tap
  (no password: `DUMMY_HASH`; Pleat signs in with the Telegram code), invite via `startapp=ref_<CODE>`.
  Mini App tokens are refused on `/vpn*` and `/devices` (`use_pleat`) and never get `sub_url`. No device row.
- Bot: `/start` from a non-admin shows an "Open Pleat" web_app button; `ensureWebhook` (sig v3) sets the menu button.
- Screens: Welcome (create account), Home (data left with pleats, days left with dots, wallet), Loading/Error/Empty.
  English, Pleat day/night colours follow Telegram's theme. Stage 2 = plans and payments (needs «برو»).
- **Admin panel in the Mini App (Ali's priority, 2026-11-08; redesigned in English 2026-11-09)**: an admin who opens
  `/app/` lands on the admin panel (`miniapp/src/admin/`). **English only, LTR** (Ali: the main language is English).
  Server: `worker/src/admin-api.js`, a ROUTES table `[method, regex, level, handler]` under `/api/v1/admin/*`.
  Sign-in `POST /admin/auth` (initData → 15-min token `typ: admin`; role re-read on every request). Levels mirror the
  bot's `allowedTap`: support = dashboard/inbox/orders/receipt; viewer = every read except settings/admins/sms setup;
  owner = all. Writes: `POST /admin/action {name, args, confirm}` runs `admin-actions.runAction` (same validation,
  roles, audit, 10-min undo); money/destructive need `confirm: true`; `POST /admin/undo`. Owner-only extra writes the
  bot did with text commands: create user, set password, add panel, panel login (+test), panel test, backup.
  Every bot screen has a Mini App screen: home, receipts/orders, users (+card, wallet, orders, networks, per-panel
  view), plans, coupons, referral, payments (card, SMS, crypto wallets, dollar price), SMS log, panels (+servers,
  rollout, drain, groups, login), Pleat app (announcement, domains, bridges, trial, releases), network/carriers,
  broadcast, stats, system (backup, health, admin log with undo, admins, every setting).
- **Design = Pleat's own language, not just its colours** (the first version copied only the colours and looked
  broken): Plus Jakarta Sans shipped with the page (`build.mjs` copies it from `@fontsource`; Google Fonts is filtered
  in Iran; CSP `font-src 'self'`), Vazirmatn only for Persian names, line icons (`miniapp/src/icons.jsx`), hero
  numeral with shards, uppercase pill actions, icon list rows, bottom nav with the blue circle, pleats + day dots,
  day/night direction A. Before sending UI, screenshot each screen next to the matching Pleat screen.
- The bot's refusals are Persian; `miniapp/src/admin/errors.js` translates them, and `englishSummary` in `fmt.js` the
  admin log. `miniapp/test/admin.test.js` fails when a new bot refusal, action or setting has no English text.

### Engineering audit
15 phases (discovery → architecture → code → security → VPN → DB → API → performance → UX → mobile → testing →
devops → business logic → repair → validation). **Phases 1–5 done**, their findings fixed in #41/#44/#45.
**Phase 6 (database) needs Ali's «برو».** The state file lives in the project files
(`engineering-audit/ENGINEERING_AUDIT.md`); update it every phase.

Still open from phases 1–5 (need a decision or can't be done in code now):
S6 SMS sender trust (needs the bank's real SMS format) · S10 backup has PII in clear · S11 refresh rotation ·
S15 email not verified · AD3/P17 panel 1 still special · AD4/P3 real device limit · AD5 split the cron ·
AD6 no staging · P8 migration numbering (never rename) · P13 supply chain pinning (no lockfile, `wrangler@4`
floating, actions by tag, geo from `latest`) · P15 backup/restore · P18 very large files · P20 outdated README ·
N6 exit domain resolved by the operator's DNS · N7 `allowInsecure=1` from the panel is honoured.

### Follow-ups (non-critical)
Split `telegram.js`, a `confirmPayment` use case, a notify port, compat-date bump, delete `android/`,
`app-web/`, `android.yml` and the old-app compatibility paths (`centralApp`, `sub_url`, `/vpn/sub`,
`/pay/done` with `cloudgold://`). Not built: per-session byte usage, Google/Gemini probe in Pleat, Cloudflare
clean-IP/SNI tricks, a domestic relay for intranet-only periods, Hiddify adapter.

---

## 20. How to do common jobs

**Add a Worker endpoint.** Add the route in `index.js` `route()` (authed paths go in the `authed` list), put
the logic in the module that owns the data, count D1 queries (batch!), add tests in `test/run.mjs` (the
50-query guard runs automatically), update `flutter_vpn/docs/backend-map.md` if the app uses it.

**Add a DB column/table.** New file `worker/migrations/00NN_name.sql`, additive only, explain it in a header
comment. Tell Ali the Deploy will apply it.

**Add a bot feature.** Read screen in `telegram-screens.js`, writes in `admin-actions.js` (validate → one batch
→ audit → undo), wire buttons in `telegram-menu.js`. Persian text, buttons only, pick the right risk level.

**Add a panel type.** Implement the adapter interface (see `marzban.js`), register in `ADAPTERS`, extend
`detectKind`, test with the fake panel in the shim.

**Change Pleat.** English text, colours from `PColors`, bump `version` **and** the build number in
`pubspec.yaml`, run analyze + tests, then the "Pleat Flutter app" workflow builds the APK (no local Android SDK).
Native changes in Kotlin cannot be compiled in the container; CI is the compiler.

**Change a VPN protocol mapping.** Edit `lib/state/xray_config.dart`, mirror v2rayNG/Xray semantics, add a test
in `test/xray_config_test.dart` with made-up values; CI runs `xray -test` on generated configs with the app's
own core version.

**Diagnose a failing exit.** Ask Ali for Connection check → "Test alone + copy core log" for that exit. Read the
core log. Classify as app-side or server-side (§16) before writing code.

**Report to Ali.** Persian, short, lead with the result, say proven vs guessed, give the PR link and the exact
workflow(s) he must run.

---

## 21. Gotchas

- Merging deploys nothing. Deploy and APK builds are manual.
- A manual `wrangler deploy` outside the workflow needs the webhook re-registered with `secret_token`.
- `deploy-worker.yml` fails without `TELEGRAM_WEBHOOK_SECRET` (by design).
- Rotating `SECRET_KEY` invalidates stored panel logins (and sessions if `JWT_SECRET` is unset).
- The app's build list `PLEAT_API` comes from the workflow input or `CG_API_BASE`; an APK built without it has
  no server address.
- Bridge links baked into the APK (`PLEAT_BRIDGE`) can be extracted from the APK; prefer bot-set `app_bridges`.
- The core's log handler is global: a previous probe's line can leak into the next trace.
- Calling a MethodChannel during `AppState.refreshAccount` before `pumpWidget` deadlocks widget tests;
  `Tunnel.netKind` returns '' until `available()` answered.
- Plan names arrive Persian from defaults; the app shows them verbatim; Ali renames them in the bot.
- The Connection check tests several exits in parallel, so single latencies are not reliable numbers.
- `/vpn/servers` 503 `panel_unavailable` = the user has a panel account row but the subscription fetch gave no
  links (panel unreachable, creds, non-2xx or empty sub). The bot's panel test shows login / create / config count.
- The cloud container's proxy blocks non-443 ports and often github.com; you cannot test panels directly.
- Shim query counts are not real D1; confirm on Cloudflare logs after deploy when it matters.

---

## 22. Glossary

| Term | Meaning |
|---|---|
| **Worker** | the Cloudflare Worker `cloudgold` in `worker/` |
| **Panel** | a third-party VPN management server (PasarGuard / Marzban / Rebecca) where user accounts live |
| **Exit** / config | one share link (vless://, vmess://, …) = one server the app can connect through |
| **settle** | the one function every payment ends in |
| **Rollout / drain** | gradually move users onto / off a panel |
| **Bridge** | Pleat's hidden second core used only to reach the Worker when the open line is filtered |
| **Smart connect** | auto-pick + failover between the best exits for the current network |
| **Pleats and dots** | the profile's usage visual: slanted pleats = data, dots = days |
| **Pleat card** | the designed VPN notification |
| **«برو»** | "go" — Ali's explicit approval to start the next stage |
| **toman / rial** | Iranian currency; 1 toman = 10 rial. Prices are toman, bank SMS are rial |
