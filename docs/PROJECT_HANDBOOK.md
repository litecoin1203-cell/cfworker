# CloudGold / Pleat — Project Handbook

> **Who this is for:** an AI model (or a new developer) who is about to work on this repository and needs to
> understand the whole project quickly: what it is, how it is built, how it got here, what broke and how it
> was fixed, which rules the owner insists on, and what is still open.
>
> **Read this first, then read the code.** Every fact here was taken from the code, the git and PR history,
> the audit documents and the owner's decisions up to **2026-11-12** (main at `85e10bf`, PR #82, Pleat 1.2.46+49).
> When this file and the code disagree, the code wins; fix this file in the same PR.
>
> **The doc set** (all in `docs/` unless noted):
> | File | What it answers |
> |---|---|
> | `PROJECT_HANDBOOK.md` (this file) | what the project is, the rules, architecture, features, history, open items, how-tos |
> | [`API.md`](API.md) | every Worker route (app, admin, webhooks) and every cron job |
> | [`DATABASE.md`](DATABASE.md) | every D1 table and column, the migration log, settings keys, backups |
> | [`../AGENTS.md`](../AGENTS.md) | the short rule card an AI coding agent loads automatically (`CLAUDE.md` points to it) |
> | [`../flutter_vpn/docs/backend-map.md`](../flutter_vpn/docs/backend-map.md) | what each Pleat screen calls on the Worker |
>
> A Worker test (`developer docs name every migration and every API route`) fails when a new migration or route
> is not in `DATABASE.md` / `API.md`, so those two cannot silently go stale.
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
  - the **admin Telegram bot** (`/tg` webhook) and the **Telegram Mini App** (`/app/`, user side + a full admin
    panel, built from `miniapp/`),
  - the receiver of Pleat's **automatic health reports** (`/me/health`: crashes, failed exits, drops) that alert
    the admin in Telegram,
  - the **bank-SMS receiver** that auto-confirms card-to-card payments (`/sms`),
  - the **crypto payment watcher** (cron reads five blockchains) and the NOWPayments IPN receiver,
  - the **control plane** over several third-party **VPN panels** (PasarGuard, Marzban, Rebecca): it creates
    each user's account on every panel, sums usage across panels, and stops/starts accounts on quota or expiry.
- **Pleat** (`flutter_vpn/`, Flutter + Kotlin) is **the** product app for Android. It logs in to the Worker,
  shows plans, takes payments, downloads the user's configs, and runs the tunnel itself (Xray core +
  hev-socks5-tunnel inside an Android `VpnService`). It also has a home-screen widget, a Route chooser (goal +
  country), a Protect section (Shield DNS filtering, Privacy check, Google location per exit) and sends health
  reports.
- **VPN traffic never touches Cloudflare.** It goes from the phone to the panels' VPN nodes (VLESS
  Reality/TLS/WS/gRPC/XHTTP/HTTPUpgrade, VMess, Trojan, Shadowsocks, WireGuard, Hysteria2).

**The owner** is Ali (GitHub `litecoin1203-cell`). He writes in **Persian**, sends APKs to users by hand, is
the only admin, and as of 2026-11-12 had **about 2 users** and **2 panels** (panel 1 = PasarGuard, panel 2 =
Rebecca 1.8.0). The GitHub repo is **public** (since 2026-11-11, for free Actions minutes): anything committed is
readable by anyone, so secrets live only in GitHub/Worker secrets. Users are in **Iran**, behind heavy filtering; that fact drives many design choices.

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
- **The admin bot's text is Persian.** The **Telegram Mini App (user and admin) is English, LTR.**

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
- **Who does what (Ali, 2026-11-11):** architecture / engineering work runs on a strong model and opens PRs;
  operational work (merging, running Deploy, building the Pleat APK, version bumps) runs on a cheaper model in one
  "integration" thread. Keep merges and deploys off Ali's hands, and never let two threads merge or build the same
  PR (two Pleat builds both publish to `pleat-latest` and overwrite each other).
- **Deploy is manual.** Merging to `main` deploys nothing. Say so after every Worker change and tell Ali to run
  "Deploy Cloud Gold server" (and the Pleat workflow for an app change).

### Secrets and privacy
- **The repo is public.** No secrets in code, logs, tests, docs or chat. Never echo panel logins, panel addresses or subscription links.
- No panel URL, name, count or credentials anywhere user-facing (app, logs, bot output to users).
- Tests use made-up config values, never Ali's real ones.
- Secret rotation (panel-1 logins, webhook secret, SMS key) is deferred to a **pre-release checklist**.
- Ali once pasted real panel-2 subscription links in chat; the advice to regenerate that panel account stands.
- Health reports and crash reports carry **no** share link, UUID, key, server address, IP, e-mail or Wi-Fi name;
  the app scrubs and the Worker scrubs again (`health.js` `scrub`). Exits are named only by the anonymous server key.

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
│   ├── src/                     ~10,800 lines, 27 files (see §5)
│   ├── migrations/              0001 … 0023 (two files share 0015 — harmless, never rename) → docs/DATABASE.md
│   ├── test/run.mjs             the whole test suite (hand-made harness, ~1,450 checks)
│   ├── test/shim.mjs            D1 on node:sqlite (batch is transactional like D1), fake panels
│   ├── test/dev_server.mjs      the Worker + a fake panel on http://127.0.0.1:8787 (for Pleat's live test)
│   ├── wrangler.jsonc           crons, rate limiters, D1 binding (id filled by the deploy workflow), static assets
│   ├── public/                  built Mini App (gitignored; built from miniapp/ by the deploy)
│   └── package.json             npm test / npm run coverage (Node 22, --experimental-sqlite)
├── flutter_vpn/                 PLEAT, THE APP (active)
│   ├── lib/api/                 client.dart (HTTP over dart:io, multi-base race), models.dart, countries.dart
│   ├── lib/state/               app_state.dart (the big ChangeNotifier, ~3,500 lines), tunnel.dart,
│   │                            xray_config.dart, bridge.dart, exits.dart, net_cache.dart, diagnose.dart,
│   │                            updater.dart, health.dart (health reports), protect.dart (Google/privacy rules),
│   │                            recommend.dart (why an exit is recommended), route_mode.dart (goal families),
│   │                            route_rules.dart (stay in country / split / networks), stats_log.dart
│   ├── lib/screens/             26 screens (home, locations, login, avatar_gate, route_chooser, route_extras,
│   │                            stats_view, protect, privacy_check, google_location, profile, plans, …)
│   ├── lib/design/              tokens.dart (palettes), shard_field, mark, nav, city_art, avatars, update_track, …
│   ├── android/app/src/main/kotlin/app/pleat/pleat/
│   │                            PleatVpnService, MainActivity, Engine, Bridge, Speed, Probe (Protect tests),
│   │                            TunnelHub, TunnelNote (notification), TProxyService (hev JNI), Updates (installer),
│   │                            Health + CrashNotes (exit reasons, tombstones), Apps (split-route app list),
│   │                            StatusWidget + WidgetConnect + WidgetTrail (home-screen widget)
│   ├── android/compile-hevtun.sh  builds hev-socks5-tunnel with PKGNAME=app/pleat/pleat
│   ├── android/crash-notes-check/ JVM check of CrashNotes against Android tombstone protos
│   ├── test/                    19 files: unit/widget tests, live backend test, real-Xray config test
│   └── docs/backend-map.md      what every Pleat control calls on the Worker
│                 parity.md      Pleat vs the old Cloud Gold app, feature by feature (Persian)
├── miniapp/                     TELEGRAM MINI APP (Preact 10 + esbuild, pinned + lockfile): src/ (user side),
│                                src/admin/ (admin panel), test/; `npm run build` → worker/public/
├── android/  app-web/           RETIRED old Cloud Gold app — do not extend
├── design-system/               the old app's "Vault & Hallmark" design docs (historical)
├── docs/                        PROJECT_HANDBOOK.md (this file), API.md, DATABASE.md
├── AGENTS.md, CLAUDE.md         short rule card for AI coding agents
├── README.md                    original Persian setup guide (partly outdated: old app); links to docs/
└── .github/workflows/
    ├── test-worker.yml          Worker tests + coverage + Mini App tests/build, on PRs touching worker/** or miniapp/**
    ├── flutter-vpn.yml          "Pleat Flutter app": on PRs: format, analyze, test, live test, Xray config test;
    │                            manual run (input api_base) also builds the APK and publishes to pleat-latest
    ├── deploy-worker.yml        "Deploy Cloud Gold server": manual only
    ├── android.yml              RETIRED: old app APK
    └── make-key.yml             one-time signing key generator (already used)
```

Outside the repo (only visible inside the Claude project, not on GitHub): `/mnt/project-files/` holds the
audit state file `engineering-audit/ENGINEERING_AUDIT.md` (phases, findings, measurements; partly Persian),
proof scripts in `engineering-audit/tools/`, the security audit report, battery study, design previews
(themes, avatars, notification, plan cards, profile, widgets, protect, home-exits), phone-test checklists
(`engineering-audit/phone-test-checklist.md`, `health-reports/phone-test.md`). If you have that folder, read the
audit file before any audit work. Its results are summarised in §19 here.

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

Also served by the same Worker (not drawn): the **Telegram Mini App** as static assets at `/app/` with its admin API
`/api/v1/admin/*` (`admin-api.js`), Pleat's **health reports** `/me/health` (`health.js`), and the 15-minute
**Tunnel-group host rules** refresh in the per-minute cron. Full route and cron list: [`API.md`](API.md).

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

The full list (every route, its auth, handler and limits, plus the admin API and the crons) is in
[`API.md`](API.md). The shape:

- `fetch`: `/health`, `/sms` (bank SMS, `X-SMS-Key`), `/tg` (bot webhook, secret in path + header),
  `/mini/probe`, `/pay/done`, static `/app/*` (Mini App), and `/api/v1/*` → `route()`.
- `route()`: public routes first (app-config, plans, auth incl. Telegram code and Mini App initData, NOWPayments
  IPN), then `/admin/*` (handed to `admin-api.js` after `requireAdmin`), then the `authed` list (Bearer access JWT,
  30 min, + `token_version` + `is_active`). Mini App user tokens are refused on `/vpn*` and `/devices*`.
- Routing is hand-written `if` / regex. Heavy modules are loaded with `await import()` (this also breaks import
  cycles and keeps cold-start CPU low).
- `scheduled`: three crons (every minute, every 2 minutes, daily 20:30 UTC), see `API.md`.

### Modules

| File | Responsibility |
|---|---|
| `index.js` | HTTP + cron entry, CORS, routing, default plan seed (`DEFAULT_PLANS`, only when `plans` is empty) |
| `util.js` | JSON/errors, PBKDF2 + pepper, JWT HS256, HMAC, AES-GCM `seal`, rate limit (fail-open on purpose), JSON logs that strip URLs |
| `db.js` | D1 helpers (`first`, `all`, `run`, `insert`), the `settings` key/value store with `SETTING_DEFAULTS`, `touchDevice` |
| `auth.js` | email sign-up/login, Telegram 6-digit code login/sign-up, refresh, change password, link Telegram, backup email, avatar (`AVATARS`) |
| `account.js` | app-config, plans, `/me`, subscription status, server list (`vpnServers`), devices, trial (`startTrial`) |
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
| `admin-actions.js` | **every bot and Mini App write**: validate → one D1 batch → audit → undo; broadcasts (`broadcastTick`) |
| `admin-api.js` | the Mini App admin API: `ROUTES` table `[method, regex, level, handler]`, 15-min admin token, role re-read per request |
| `health.js` | Pleat health reports: `TYPES` + priorities, `LIMITS` (per-user caps), `scrub`, P1 Telegram alert, location mismatch (`checkExitCountry`), bot screens (🩺 سلامت اپ), crash wording (`crashGuess`), daily line, prune |
| `cfmon.js` | Admin bot ☁️ Cloudflare monitoring: GraphQL Analytics (`CF_ANALYTICS_TOKEN`), Free-plan `LIMITS`, overview / 7-day / errors / costly queries / deploys / token screens, `alertTick` (hourly), `dailyLine`, `recordError` (the `worker_errors` log fed by `logError`) |
| `countries.js` | country of a config from its remark/host (`countryOfLink`): flag, English/Persian name, 2-letter token, host label |

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
`APP_KEY_PASSWORD` (the release signing key "Cloud Gold VPN" — Pleat is signed with it; never change it or installed
apps can't update), `PLEAT_BRIDGE`, `PLEAT_DL_TOKEN` (a PAT that can read the release). Optional Worker var:
`PLEAT_REPO` (defaults to this repo).
Variable: `CG_API_BASE` (API base list for builds).

Since PR #4 the deploy does **not** upload GitHub secrets to the Worker; it only checks that the names exist.
Changing a Worker secret = Cloudflare dashboard → Worker → Settings → Variables and Secrets.

### Runtime settings (`settings` table, edited from the bot or the Mini App)
Card, SMS, crypto wallets, USD rate, referral, announcement, extra API bases (`app_api_bases`), bridges
(`app_bridges`), trial, in-app update (`app_release`), sealed panel logins (`panel_cred_<id>`), Tunnel-group host
rules (`panel_hosts_<id>`), learned exit countries (`server_exit_cc`), health report mode (`health_mode`). Defaults
are in `db.js` `SETTING_DEFAULTS`. The full key list is in [`DATABASE.md`](DATABASE.md#settings-key--value).

---

## 6. Database (D1)

**Every table and column, the migration log and the settings keys are in [`DATABASE.md`](DATABASE.md).** 33 tables
in groups: accounts (`users`, `devices`, `tg_logins`, `admins`), money (`plans`, `orders`, `wallet_tx`, `coupons`,
`coupon_uses`, `sms_log`), control plane (`subscriptions`, `sub_periods`, `panels`, `panel_accounts`,
`usage_counters`, `sync_cursor`, `server_overrides`), network ranking (`net_*`, `google_*`, `user_net*`,
`user_skeys`), bot (`bot_session`, `bot_confirm`, `admin_audit`, `broadcasts`), health (`health_events`) and
`settings`.

Facts to remember:
- **No foreign keys** anywhere; integrity is in code. A user "delete" is soft (email becomes
  `deleted+<id>@invalid`; panel accounts are switched off and unlinked, never deleted on the panel).
- `txid` uniqueness is enforced by a single conditional UPDATE in `chainwatch.claimTxid`, not a constraint.
- Migrations are forward-only and **additive only**. Two files are numbered 0015; wrangler sorts by name and it
  works. **Never rename an applied migration.** Latest: **0022** (`health_events`).
- Backup = a daily JSON of 14 tables (no password hashes, sub URLs, panel creds, SMS key or bridges) sent to
  the admin's Telegram. There is no restore tool; real recovery is D1 Time Travel (the Deploy prints a bookmark
  before migrating).

---

## 7. Payments and `settle`

Every way of paying ends in `billing.settle(order)`:

| Method | How it is confirmed |
|---|---|
| **Wallet** | immediate; `walletApply` debits atomically (D1 batch + one-time nonce + non-negative trigger) |
| **Card-to-card** | the order gets a **unique amount** (base + 1…99 toman). The bank's deposit SMS, forwarded from the admin's phone to `/sms`, is parsed by `sms.js` and matched by amount → `settle`. Or the user uploads a **receipt photo** and the admin approves it with a bot button. `card_auto`: auto / detect (ask admin) / off. |
| **Crypto to the admin's own wallets** | priced from the USD/toman rate (`usdrate.js`: Nobitex, Wallex, Tabdeal, Exir, median) and coin prices (`coins.js`: CoinGecko, KuCoin, Coinbase); unique amount (+ memo where the chain needs one). `chainwatch.scanAll` (every minute) reads XLM, XRP, TRX, TON, ALGO explorers, `claimTxid` binds one txid to one order. Other coins (13 listed in settings) are confirmed by the admin. Inexact amounts go to admin review. |
| **NOWPayments** (optional) | signed IPN → `settle` |

`settle` claims the order atomically (status `settling`, 120 s lease) so two confirmations can never deliver
twice; `deliver` then `provision`s the plan on **all** of the user's panels and records `provisioned_at` in the
same batch as the new period (C5 fix). Remaining time and unused data both carry over on an early renewal (Ali, 2026-11-11): the new limit = new plan GB + what was left (read live from the panels first); an expired package starts fresh.

Guards added after audits: max **3 open orders per method** per account (idle card orders > 30 min and stale
quotes auto-closed; otherwise `429 too_many_open_orders`); an expired crypto quote goes to admin review
instead of auto-paid; rate limits on orders, receipts, "I paid" and refresh.

Later money fixes (engineering audit, PRs #63–#65, 2026-11-11):
- **BL-2**: a wallet purchase whose `settle` threw *after* `provision` committed used to refund the wallet too (plan
  and money both given). Now an order with `provisioned_at` set is marked paid and the error logged.
- A repeated NOWPayments IPN for a paid order no longer re-notifies the admin; tests cover repeated / foreign /
  failed / unknown IPNs and a top-up whose wallet no longer covers the plan.
- **Crypto pricing (#68)**: coin prices per coin from CoinGecko → KuCoin → Coinbase (+ last saved copy); USD/toman
  from Nobitex `apiv2`, Wallex, Tabdeal, Exir (median). The bot's "💵 قیمت دلار" shows each source's status.

**The SMS amount unit bug (F1)**: Iranian bank SMS show **rials**, prices are **toman** (×10). This was a real
HIGH bug (pay 1/10 of the price). Any SMS code change must keep rial/toman straight.

Release-audit payment fixes (PAY-01..PAY-04, approved by Ali 2026-11-14):
- **PAY-01 stuck settles**: a `settle` cut off half way (10 ms CPU, the 30 s `waitUntil` cap, a slow panel) used to
  leave the order in `settling` forever. `billing.recoverStuckTick` (first step of the per-minute cron) takes the
  oldest order whose `settling_at` is over **10 minutes** old (`STUCK_AFTER`) but **under 7 days** old
  (`AUTO_RECOVER_DAYS`), **one per run**, and settles it again; a run that tried one skips the chain scan and sync
  until the next minute (D1/subrequest budget) but still runs `ensureWebhook`; a "busy" result (another run holds it)
  skips nothing. Older stuck orders, and any with `settling_at` NULL, are **never settled by themselves** (the owner
  may have fixed them by hand): the owner gets **one** notice listing them (remembered in `settings.stuck_old_notice`)
  with a «🔁 تلاش دوباره» button each. It never delivers twice: `settle` claims the expired (or NULL) lease atomically
  and `provisioned_at` (same batch as the new period) turns a retry into "mark paid". A card/crypto order that fails
  again goes back to `review`; a **wallet** order is cancelled and refunded in **one D1 batch**, cancel first, and the
  refund only moves when the order is then `cancelled`, not provisioned and has its purchase debit (`wallet_tx`
  UNIQUE(order_id, reason) keeps it to once); if another run claimed it in between, nothing is refunded. The admin
  hears about each one. The bot's order card shows **«🔁 تلاش دوباره»** (`m:orr:`, asks first, owner only) on such an
  order; the confirm (`o_retry`) re-checks that the order is still stuck and otherwise only shows its state. The older
  `rp:`/`ap:` buttons and `order.approve` also accept a stuck order; support can therefore retry through `ap:`/`rp:`
  from old notifications (no escalation: support may approve receipts anyway). The Mini App has no retry button.
- **PAY-02 SMS amount**: `sms.parseBankSms` takes an amount **only from a deposit line**: a line with a deposit word
  (واریز…) or `مبلغ`, or an amount marked `+`. Withdrawal lines are skipped, and a line is cut at
  شرح/بابت/توضیحات/پیگیری/رهگیری/مانده/موجودی/شناسه/سند/مرجع/کد (payer text, references and the balance are never the
  amount). Account/card/date tokens with separators (`207.8000.…`, `849-810-…`, `1405/08/06-10:22`) are ignored.
  **More than one deposit amount = unclear → never auto-confirmed** (admin gets ✅ buttons); a deposit with no clear
  amount goes to the admin. F1 (rial unless the line says تومان and not ریال) is unchanged. Tests cover Mellat, Melli,
  Saderat, Tejarat, Pasargad, Saman, Blu and Resalat style SMS (made-up numbers).
- **PAY-03 SMS dedup**: the `sms_log.hash` is HMAC of the normalised SMS text only (digits, ي/ك, zero-width chars,
  spaces), **not the sender**, so a forwarded copy and the admin's pasted copy are one deposit (no schema change).
  A copy from another source is looked at again only when the first copy matched **no order** (`no_order` /
  `not_deposit` with no `order_id`; atomic claim on its row), so an SMS that arrived before its order can still be
  pasted later. An SMS tied to an order (paid, or review / ambiguous / settle_failed that the admin then approves
  with a button) is a duplicate, and the bot names that order. Rows written before this change keep the old
  sender-based hash: for ~36 h after deploy, do not paste an SMS that was forwarded before the deploy.
- **PAY-04 failed wallet purchase**: a wallet purchase that fails before the debit (insufficient balance) now
  cancels its order instead of leaving it `pending`. `deliver` refuses a wallet order (amount > 0) with no
  `purchase` debit or with a refund (`wallet_unpaid`), and the bot card, the `oap` button and the Mini App
  `can.approve` hide approve for such an order (`WALLET_PAID_SQL`).

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
  remark and the admin can give a label with a flag. Since Pleat 1.2.34 the app sends `/me/ip?k=<serverKey>` while
  connected; the Worker stores the exit's Cloudflare country in settings `server_exit_cc` (never IR; a change needs
  two reports in a row) and uses it when the remark names no country. Once confirmed (n>=2, nothing pending) the learned exit country
  also overrules a remark that names another country (TR 1/TR 7 left via Hetzner/dataforest in DE): confirmed exit >
  remark > unconfirmed exit > host label. The bot's server list marks such servers with 📍.
- PasarGuard may serve Xray JSON to a v2rayNG user agent; `collectLinks` falls back to `<sub>/links` (PR #9).
- **Account names (#49)**: new panel accounts are named after the Telegram @username (sanitised for all three
  panel types); a taken name (409) falls back to `<name>_<user id>`, then `<name>_<random>`; no @username →
  `tg<numeric id>`; email-only → `cg_<id>_<random>`. Existing accounts are never renamed (Marzban's sub token
  depends on the name). `usage_counters.online_at` keeps the panel's last-connection time (no extra writes).
- **Unlink (#55)**: bot › user › 🗂 پنل‌های کاربر › "✂️ جداکردن" removes the link row (optionally switching the
  account off) so the panel account can be linked to another user. Deleting a user switches every panel account
  off and frees all links.
- **Iran-tunnel configs (#56, #60, #61)**: configs from a panel's "Tunnel" group are sent with `tunnel: true` and
  Pleat shows an **IR TUNNEL** badge. Share links don't say their group, so every 15 min the cron reads PasarGuard
  groups + hosts into `panel_hosts_<id>` and matches links by address/port/remark. Panel 1's admin gets **403** on
  `/api/groups` and `/api/hosts` (not sudo), so the Worker instead creates a probe user **`cgtunnel_…` only in the
  Tunnel group** (`tunnel_probe_<id>`); its configs *are* the tunnel configs. **Never delete that panel user.**
  Bot diagnostic: 🗂 پنل‌ها › #1 › 🖥 سرورها › "🚇 عیب‌یابی تانل". Fixed and confirmed on Ali's phone 2026-11-11.
- **Panel tags (#56, #59)**: `/vpn/servers` sends `panel: <n>`; Pleat shows a grey P1/P2 tag to every user.
- **Dead panels (#58, #62)**: `/me` and `/vpn` wait at most 1.5 s for a live reading (stored numbers otherwise,
  finished in `waitUntil`); a panel that just failed is remembered by the isolate for 60 s so later requests wait
  1.5 s, not 5 s; the per-minute "missing accounts" look is skipped for 10 min after a look that found none.
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
- Screens added since PR #47: "🗂 پنل‌های کاربر" (live per-panel view of one user, with ✂️ unlink) and
  "🕒 آخرین اتصال" on the user card (#49, #55); 🖥 سرورها per panel with 🚇 tunnel marks, "🚇 عیب‌یابی تانل", ❓ for
  configs with no country and 📍 where the learned exit country overrules the remark (#60, #67, #76);
  "💵 قیمت دلار" with price-source status (#68); **"🩺 سلامت اپ"** (health reports: list by priority, one event,
  resolve / mute / report mode all / P2+ / off, crash details in words) (#73, #77, #79, #80); 📱 اپ Pleat ›
  🧪 تست Mini App (#50).
- **Callback routes must be unique**: two screens once shared the prefix `upa` (user panels vs app-update announce)
  and a tap ran the wrong action (#55). When adding a button, grep the menu for the route string first.
- Every bot screen also exists in the **Mini App admin panel** (§19 › Telegram Mini App), sharing
  `admin-actions.js`.
- Legacy text commands still work (hidden) via `runAdminCommand`.
- Known: default plan names come back Persian (the Worker translates them); rename plans in the bot.
- **☁️ Cloudflare monitoring** (`worker/src/cfmon.js`, home button "☁️ مانیتورینگ کلودفلر"): today's share of the
  Free plan (Worker requests for the whole account, D1 rows read / written, DB size vs 500 MB) with an end-of-day
  projection; 24 h errors by outcome, CPU p50/p99 vs 10 ms, CPU rejections, subrequests per request, a "users the
  Free plan carries" estimate; 7-day table; costliest D1 queries; deploy runs + merged-but-not-deployed PRs + Pleat
  build; hourly alert (from the `*/2` cron at minute 0, once per problem per UTC day, toggle `cf_alerts`); a line in
  the nightly report. Cloudflare numbers need the Worker secret **`CF_ANALYTICS_TOKEN`** (Account Analytics: Read;
  optional Workers Scripts: Read for the live version); `CF_ACCOUNT_ID` is passed by the deploy as a plain var.
  Without the token the section still shows DB size (D1 `meta.size_after`), the Worker's own error log and cron.
- **Worker error log**: `logError` also feeds `worker_errors` (migration 0023; one row per kind of error, scrubbed,
  at most once a minute per kind and 12 writes a minute per isolate, kept 14 days). Bot › ☁️ › 🐞.
- System › 🩺 health has "⚡ همگام‌سازی همین حالا" (`sync.manualSync`: one `runSync` in the tap's invocation, once a minute; shared with the Mini App's `POST /admin/sync`) and
  "🔁 تلاش دوباره" for panel accounts stuck after 3+ failed pushes.
- **Screens are drawn from data functions** (PR #85): `cfmon.js` `overviewData / historyData / errorsData /
  queriesData / deploysData / tokenState`, `health.js` `summaryData / problemsData / serversData / usersData /
  versionsData / problemData` (+ `crashKind`), `telegram-screens.js` `tunnelDiagData / netServerData`. The bot words
  them in Persian; `admin-api.js` hands the same data to the Mini App, which words the codes in English
  (`miniapp/src/admin/labels.js`). Add a field to the data function, not to the screen, so both faces get it.

---

## 10. Pleat, the Flutter app

Version on main: **1.2.49+52** (`flutter_vpn/pubspec.yaml`). PR #90 (open) is 1.2.50+53.
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
- Profile: mandatory verified Telegram username + optional backup Gmail, then the **Plans shelf** (1.2.48, Ali's
  pick B): the running plan in navy ("YOURS", or RENEW when stopped) and every plan on sale side by side, each with
  BUY / TRY; long emails always fit one line (`FitLine`).
- Activity (1.2.48, Ali's pick C "Account hub", `screens/activity.dart` + `screens/plan_usage.dart`): plan card
  with a data-left ring, end date, devices, used, PACKAGES (bottom sheet with pleats = data, day dots, package
  history; moved here from Profile) and RENEW (same plan at checkout if still on sale, else Plans); the last 3
  sessions + "See all"; "Your privacy": history only on this phone, **Keep history** (30 days, off = nothing
  logged, also stops the connect tries behind Stats) and Clear history now (sessions + connect tries). 14 "Folk" avatars (SVG) are the only profile picture (the Telegram photo is not used), picked on first sign-in, stored server-side.
- Locations (1.2.49, Ali's pick A "Country list", `screens/locations.dart`): navy **Fastest for you now** bar
  (best of `app.best` that answers; smart connect until anything is measured), filter chips All / Stealth /
  IR Tunnel / Saved / Recent (`Category`), countries grouped by region (`regionOf` in `api/countries.dart`), best
  first. A country row = its best server's badge, "N servers · best X ms", one pip per server (green answered,
  red slow/weak, grey untested), CONNECT = best server, chevron opens its servers (`ExitRow`). Countries where
  nothing answers on this network fold into "Not answering on <net>" with the core's reason per server.
- Home has three tabs: **Now** (country + city + exit IP from `/me/ip` through the tunnel, and Recommended exits),
  **Route** (how and where to connect) and **Stats**. See "Home tabs" below.
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
5. Smart connect, its backups and failover only use exits that match the **Route** choice (goal family and
   country, §Home tabs) and say so instead of silently switching protocol.
6. Iran split (now Home › Route › Split route): Iranian sites/IPs direct (geo files from Loyalsoldier, fetched in
   CI), plus the person's own sites and chosen Android apps (`addDisallowedApplication`). QUIC blocked.

**Routing rules that must hold (learned the hard way, PR #46 → #48):**
- `domainStrategy` stays **AsIs** (1.2.24 used IPIfNonMatch; the core then resolved every name, the start check's
  own address matched the IPv6 rule and **no exit connected at all**).
- Any rule meant for the phone's traffic (block `::/0`, Shield, split, ads) must carry **`inboundTag: ['socks']`**,
  or it also hits the core's own start check / connection check.
- The core's DNS uses `queryStrategy: UseIPv4`; the tun offers only IPv4 resolvers. "Google opens, Telegram
  doesn't" (or the reverse) on one exit = an IPv6 black hole on that exit.
- None of this can be run in the cloud container (no Xray on Android there); it is proven only on Ali's phone.

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
`versionCode % 1000`. The app only offers the version Ali **announces** in the bot, so a test APK on the release
does not reach users by itself.
- Update UI (#69, design "N2 Live track"): one notification from announcement to installer with a Download /
  Check / Install track (Android 16+: the system `ProgressStyle`; Android 7–15: a custom view), Stop / Later from
  the shade; the Home card and update sheet use the same track (`UpdateTrack`, `UpdateCopy`).

### Sign-in and profile (PRs #53, #54, #66, #70)
- One sheet with **Sign in / Create account** tabs; login = email or Telegram @username + password. Quick tiles:
  Telegram (6-digit bot code: six boxes, auto-verify, clipboard "Fill" chip, 30 s resend) and Gmail (only focuses
  the email field; one-tap Google needs an OAuth client that does not exist).
- `ApiError.offline` (Worker never reached) shows a neutral "No connection to Pleat" card; only a real
  `bad_credentials` marks fields red. The screen warms the route (address race, bridge) as it opens.
- A few working exits are kept through sign-out so the bridge can still open on a filtered line.
- **AvatarGate** (1.2.30): a new account must pick one of the 14 Folk characters before the app opens (no skip).
  The Telegram profile photo is not used anywhere.
- App version is a signature at the end of Profile (Pleat mark, "Up to date · checked …", Check for updates).
  Long-press the version to send a test health report. Night mode toggle placement: **leave it as it is** (Ali
  rejected three alternatives).

### Home tabs (PRs #71, #74, #75, #81)
- **Route** (design D): goal cards **Auto / Stealth / Speed / Classic** + a location bar with a country sheet. Each
  exit's family is read from its own link on the phone (`route_mode.dart`): REALITY / XHTTP = Stealth, WireGuard /
  Hysteria2 / QUIC = Speed, the rest Classic. Under it (`route_extras.dart`, order of precedence in
  `route_rules.dart`): **Stay in one country** (stable IP; asks in a popup before leaving the country; an accepted
  switch lasts 1 h), **Split route** (Iranian sites, own sites, chosen apps bypass; warns about Android's "Block
  connections without VPN"), **Your networks** (remembers the goal per network). Smart connect lives here too.
  An exit picked by hand in Locations wins over everything.
- **Stats** (phone-local, no server writes, `stats_log.dart`): Data pace, Hardest hours (failed connects by
  weekday/hour on this network), What works here (this phone vs all Pleat users on the operator).
- **Now › Recommended exits** (only under Now since #74): the same rows Locations draws (flag + speed ring, P1/P2,
  IR TUNNEL, protocol, ping, CONNECT) plus one blue line per exit saying **why** (`recommend.dart`: fastest here,
  strong for N people, worked for you before, …; never invented), and a "Tested on … · RE-TEST" footer.
- Locations rows show **P1/P2** tags and the slanted **IR TUNNEL** badge (#56, #59).

### Protect (PR #82, 1.2.46, layout B)
- **Always protected**: kill switch + start with the phone (both open Android's always-on VPN page).
- **Shield**: Off / Safe (malware + phishing via Cloudflare `1.1.1.2`) / Clean (+ ads and trackers via
  `geosite:category-ads-all`, incl. Iranian ad networks), plus an **Adult sites** toggle (`1.1.1.3` +
  `geosite:category-porn`). Rules carry `inboundTag socks` and sit before Iran-direct.
- **Privacy check**: 16 tests through a throw-away core of the session's own config (`Probe.kt`): Cloudflare,
  YouTube country, Gemini, Search wall, two IP databases, exit network, home IP, DNS resolver/operator/ECS, IPv6,
  WebRTC STUN, kill switch, bypass apps, location, time zone/SIM.
- **Google location**: what country Google sees per exit (YouTube `INNERTUBE_CONTEXT_GL`, Gemini, Search), shared
  between users through the existing `/net/google` + `/net/rank`; a **"Google-clean exits only"** filter narrows
  smart connect inside the Route country (never empties the pool).
- Split tunnel and Protocol cards were removed from Protect (Route covers them).
- **Not yet proven on a phone**: YouTube/Gemini indicators, STUN over SOCKS UDP, whoami via 1.1.1.2.

### Home-screen widget (PR #78, 1.2.39 → 1.2.44)
- 4×1 **Status strip** (`StatusWidget.kt`): flag, place, IP, session timer, one switch; connects or disconnects
  without opening the app. The app hands the service up to **three spare exits** (same Route choice) after each
  session; a widget start tries them natively and remembers the one that answers.
- A widget connect always goes through the invisible `WidgetConnect` activity (Android 12+/MIUI refuse a
  foreground-service start from the background); it shows only Android's VPN consent dialog when needed.
- `WidgetTrail.kt` writes every step (tap, consent, service, foreground, tun, engine, core, hev, probe) to disk; a
  start that never reached "up" is reported on the next launch as `crash · widget`.
- **Open**: with the app fully closed, starts failed between core and hev (`start_err`, no process crash). 1.2.44
  loads the core + tun library on the service's main thread in `onCreate`, as the app does. **Not yet confirmed on
  Ali's phone**; if it still fails, the trail names the error.

### Health reports and crash capture (PRs #73, #77, #79, #80)
- `lib/state/health.dart` queues problems on the phone (survive a crash), folds repeats with a count, and sends
  batches to `POST /me/health`: critical within ~1 min, high every ≤ 10 min, rest every 6 h. Profile has a
  **Send diagnostics** switch (off → also `&h=0` on `/me/ip`).
- Types and priority (`health.js` `TYPES`): P1 `crash`, `killed`, `no_exit` (instant Telegram alert); P2
  `connect_fail`, `drop`, `silent`, `unsupported`, `loc_mismatch`, `exit_iran` (last two seen only by the Worker);
  P3 `battery`, `slow_connect`, `api_down`, `update_fail`, `app_error`; P4 `daily`.
- Payload: app version, Android version, phone model, network kind, carrier, protocol, anonymous exit key — never
  a link, UUID, key, address or IP.
- Native crashes (`Health.kt`, `CrashNotes.kt`): Android's exit reason/status in words (e.g. reason 5 = native
  crash, 6 = SIGABRT), the tombstone (Android 12+ protobuf; signal, abort message, thread, library, top frames,
  Go panic line), `tomb` state (none / read / unread / error), Go's stderr captured to a file (quiet at the crash =
  not a Go panic), and the tunnel state *before* the crash (the service keeps its last 8 state changes).
  Since 1.2.50 also: who sent the signal (`from itself` = abort()/Go's own crash; another pid/uid = something killed
  it), whether the crashing thread was main, `addr` (offsets inside the crashing library: pc, lr, then Go's frame
  pointer chain from the stack copy, because Android cannot unwind Go code), `logs` (how many log lines the tombstone
  carried), and stderr is matched to the crashed process's own pid (before, a process that never captured stderr
  still read "quiet").
- Naming an `addr` offset: download `libv2ray.aar` of the same tag, take `jni/arm64-v8a/libgojni.so`, and look the
  offset up in its `.gopclntab` (Go's `debug/gosym`; it survives stripping). For v26.7.5 the Go text starts at
  `.text` + 0x60 (calibrated on `runtime.raise`, whose `tgkill` syscall sits at 0x10b30f4).
- Known blind spot: `Health.kt` `exitOf()` drops processes Android killed or force-stopped while showing nothing,
  so some failures send no report (the widget trail exists for that reason).

### Diagnostics
Profile → **Connection check**: tests every exit (own native 10 s budget per test since 1.2.21), shows cause /
fix / advice (`diagnose.dart`), "Copy report" (real app version), and **"Test alone + copy core log"** per exit
(debug log, hosts blanked). This is the tool that ends arguments — use it.

### State and code notes
- `AppState` (~3,500 lines, ChangeNotifier) is a god object; `login.dart` ~1,780 and `profile.dart` ~1,670 lines.
  Known, not refactored. New logic goes into a plain-Dart file under `lib/state/` (testable without Flutter), as
  `route_rules.dart`, `recommend.dart`, `protect.dart` and `health.dart` do.
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
| **Test Cloud Gold server** (`test-worker.yml`) | PR on `worker/**` or `miniapp/**` + manual | Worker tests with coverage gate (≥ 80 % lines), Mini App tests + build |
| **Pleat Flutter app** (`flutter-vpn.yml`) | PR on `flutter_vpn/**` + manual (`api_base` input) | PR: format, analyze, test, live test against the local Worker, `xray -test` of generated configs. **Manual run only**: NDK + hev + Xray core, configs checked with the **exact** app core (built from libv2ray buildinfo), APK build, APK check, publish to release `pleat-latest`. ~18 min. |
| **Deploy Cloud Gold server** (`deploy-worker.yml`) | **manual only** | tests → Cloudflare login check → secret names check → find/create D1 → **print the D1 Time Travel bookmark** → apply migrations → build the Mini App → deploy (wrangler pinned **4.158.0**) → copy `PLEAT_DL_TOKEN` |

Since #57 nothing runs twice (only the PR, not also the push) and a newer push cancels the running PR check. The
repo is public, so Actions minutes are effectively free; that ended the 2026-11-09 outage when the monthly free
minutes ran out.

- CI download hardening (PR #42): Actions cache of every download, Xray from `ghcr.io/xtls/xray-core` as a
  fallback, jsDelivr mirror for geo files, Gradle prefetched with retries, Google's Maven Central mirror via an
  init script. If a run still fails on a 504, just re-run it.
- `XRAY_LIB_TAG` (v26.7.5) is AndroidLibXrayLite's tag; Xray-core has no release by that name.
- Pleat APK download link for Ali: release `pleat-latest`, asset `pleat.apk`. Ali sends it to users by hand.
- After a merge that touches `worker/` or `miniapp/`: run **Deploy Cloud Gold server**. After a merge touching
  `flutter_vpn/`: run **Pleat Flutter app** from `main` (with `api_base`). Build one APK at a time.
- State on 2026-11-12: the last Worker change (#80) is deployed (Deploy run 62), so production = `main`; #81 and
  #82 were app-only and their APK (1.2.46) is built. Check the Actions tab before assuming this still holds.
- If a Pleat build fails on a 504 while downloading Xray/geo files, just re-run it.

---

## 12. Cloudflare Free plan limits (hard constraints)

Ali is on the **Free** plan (confirmed, no trial). Design every change around these:

| Limit | Consequence |
|---|---|
| **10 ms CPU** per invocation | no heavy crypto (PBKDF2 stays at 5,000), no big JSON loops |
| **50 subrequests** per invocation | panel calls, Telegram, explorers all count; budget the cron |
| **50 D1 queries per invocation** (a batch = 1) | the 51st fails. Batch reads and writes. Test suite enforces it. |
| **~100k D1 writes/day** | the old cron wrote 2 rows per user per minute even when idle → cap hit at ~35 users (PR #41: writes only on change). A phone that keeps the VPN on still changes its counter every minute, so the cap was still ~33 always-on users; the engineering-audit phase 6 PR spreads those writes (`LEDGER_EVERY` = 10 min in `sync.js`, never for big changes, near-quota, panel resets or a user coming online): 100 always-on users went from 295k to 33k rows/day (measured). Stored "online now" therefore means seen in the last 13 min (`STORED_ONLINE_SEC`); the bot's live card is exact. |
| **~5M D1 rows read/day** | every per-minute query must use an index (0021 fixed a full scan of `subscriptions`) |
| **100k Worker requests/day** | roughly 200–500 active users; Workers Paid ($5/month, 10M/day) for thousands |
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
- PR #46: 1.2.24, a site resolved to IPv6 is reached through the exit. It broke every exit (see §10 routing
  rules); PR #47 added this handbook; PR #48 (1.2.25) fixed the regression the same day.

**2026-11-09 — Telegram Mini App, new sign-in, panel housekeeping.**
- PR #49 panel accounts named after the Telegram @username; per-panel bot screen with last connection (0020).
- PR #50 Mini App stage 0 probe (it opens in Iran only with a VPN on); PR #51 stage 1 (sign in with Telegram, Home);
  PR #52 full **admin panel** in the Mini App, English, Pleat's design.
- PR #53 (1.2.26) new sign-in / sign-up / Telegram code screens; PR #54 (1.2.27) dead line ≠ wrong password.
- PR #55 unlink panel accounts; PR #56 IR TUNNEL badge and P1/P2 panel tags.
- The monthly free Actions minutes ran out → PR #57 (2026-11-11) halves CI usage; the repo was later made public.

**2026-11-11 — engineering audit phases 6–15, Ali's five tasks.**
- PR #58 spread usage writes (100 always-on users: 295k → 33k rows/day). PR #59 P1/P2 tags for everyone.
  PR #60/#61 Iran-tunnel diagnostic and the `cgtunnel_` probe user (panel 1's admin gets 403 on groups/hosts).
- PR #62 index 0021, dead-panel memory, pinned wrangler + restore point. PR #63 money-path tests, GitHub call
  deadlines. PR #64 early renewal carries unused data over. PR #65 BL-2, shared cron subrequest budget, no repeat
  IPN notices. **Audit complete** (scorecard in §19).
- Ali's five tasks: PR #66 (1.2.30) mandatory avatar; PR #69 (1.2.31) update "live track" + PR #70 (1.2.32)
  version signature; PR #68 crypto prices; PR #71 (1.2.33) Route goal cards; PR #67 + #72 (1.2.34) exit country
  from names/codes/hosts and learned from `/me/ip?k=`.
- PR #73 (1.2.35) automatic health reports (0022).

**2026-11-12 — Home, crash capture, widget, Protect.**
- PR #74 (1.2.36) Recommended exits only under Now; PR #75 (1.2.37) Route rules + Stats.
- PR #76 a confirmed exit country overrules the remark (TR 1 / TR 7 really exit in DE).
- PR #77 (1.2.38), #79 (1.2.40), #80 (1.2.42) native crash details for the DE 3 SIGABRT investigation.
- PR #78 (merged as 1.2.44) Status-strip widget. PR #81 (1.2.45) Recommended exits as Locations rows with a reason.
  PR #82 (1.2.46) Protect redesign.
- PR #84 admin bot ☁️ Cloudflare monitoring; PR #85 the admin Mini App catches up with every bot screen added since
  #52, with the Cloudflare part as a visual dashboard.
- PR #86 the Telegram sign-in / verify code message: "security code" card, code hidden under a spoiler, "didn't ask?" note.

**2026-11-13 — Activity and Plans.**
- PR #88 (1.2.48) Activity becomes the account hub (data and days moved there from Profile, recent sessions,
  keep/clear history); Profile gets the Plans shelf.
- PR #89 (1.2.49) Locations country list: Fastest-for-you bar, filter chips, regions, health pips, Not answering.
- PR #90 (1.2.50) native crash: the code offsets inside the core, the signal's sender, stderr per process.

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
| 46 | 11-08 | IPv6 sites through the exit (1.2.24) — broke every exit, fixed by #48 |
| 47 | 11-08 | Docs: this handbook |
| 48 | 11-08 | Fix: nothing connected in 1.2.24 (AsIs, rules scoped to `inboundTag socks`) (1.2.25) |
| 49 | 11-09 | Panel accounts named after @username; per-panel user screen, last connection (migration 0020) |
| 50 | 11-09 | Mini App stage 0 probe |
| 51 | 11-09 | Mini App stage 1: Telegram sign-in, Home |
| 52 | 11-09 | Mini App admin panel (English, every bot feature) |
| 53 | 11-09 | New sign-in / sign-up / Telegram code screens (1.2.26) |
| 54 | 11-09 | Dead line ≠ wrong password; route warmed on the sign-in screen (1.2.27) |
| 55 | 11-09 | Unlink panel accounts; delete frees every link; `upa` route collision fixed |
| 56 | 11-09 | IR TUNNEL badge + P1/P2 tags (1.2.27) |
| 57 | 11-11 | CI spends fewer Actions minutes; APK only on manual run (1.2.28) |
| 58 | 11-11 | Spread cron usage writes; `/me` waits ≤ 1.5 s on a dead panel |
| 59 | 11-11 | P1/P2 tag for every user (1.2.29) |
| 60 | 11-11 | Bot: Iran-tunnel diagnostic, 🚇 marks |
| 61 | 11-11 | Tunnel configs via the `cgtunnel_` probe user when groups/hosts give 403 |
| 62 | 11-11 | Audit 6/8/12/13: index 0021, dead-panel memory, pinned wrangler, restore point |
| 63 | 11-11 | Audit 7/11: money-path tests, GitHub call deadlines |
| 64 | 11-11 | Early renewal carries unused data over |
| 65 | 11-11 | Audit 14: BL-2, shared cron subrequest budget, no repeat IPN notices |
| 66 | 11-11 | Mandatory avatar on first sign-in; Telegram photo removed (1.2.30) |
| 67 | 11-11 | Country from names / codes / host when the remark has no flag |
| 68 | 11-11 | Crypto payment: working coin and USD price sources |
| 69 | 11-11 | Update notification + Home card as a live track (1.2.31) |
| 70 | 11-11 | App version as a signature at the end of Profile (1.2.32) |
| 71 | 11-11 | Home Route tab: goal cards + location bar (1.2.33) |
| 72 | 11-11 | Learn each exit's real country from the app (1.2.34) |
| 73 | 11-11 | Automatic health reports (1.2.35, migration 0022) |
| 74 | 11-12 | Recommended exits only under Now (1.2.36) |
| 75 | 11-12 | Route rules + Stats (1.2.37) |
| 76 | 11-12 | Confirmed exit country overrules the remark |
| 77 | 11-12 | Native crash details (1.2.38) |
| 78 | 11-12 | Status-strip home-screen widget (1.2.39 → 1.2.44) |
| 79 | 11-12 | Crash reports say whether Android kept a tombstone (1.2.40) |
| 80 | 11-12 | Crash reports: the crash's own tunnel state, Go stderr evidence (1.2.42) |
| 81 | 11-12 | Home Recommended exits as Locations rows with a reason (1.2.45) |
| 82 | 11-12 | Protect redesign: Shield, Privacy check, Google location (1.2.46) |
| 84 | 11-12 | Admin bot ☁️ Cloudflare monitoring (Free-plan meters, errors, costly queries, deploys, hourly alert), Worker error log (0023), sync now / retry stuck |
| 85 | 11-12 | Admin Mini App back to full bot parity: visual Cloudflare dashboard, app health reports, sync now / retry, tunnel diagnostic, server page, server on every carrier; bot screens drawn from shared data functions |
| 86 | 11-12 | Telegram code message redesign (Worker only): code under a spoiler, 5-minute line, "didn't ask?" quote |
| 88 | 11-13 | Activity account hub (data and days, sessions, keep/clear history) + Profile Plans shelf (1.2.48) |
| 89 | 11-13 | Locations country list: Fastest for you, chips, regions, health pips, Not answering (1.2.49) |
| 90 | 11-13 | Native crash: offsets inside the core (pc, lr, Go frame chain), signal sender, stderr matched per process (1.2.50) |

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
| **BL-2** (reproduced in a test) wallet order refunded although the plan was already on the panels | an order with `provisioned_at` is marked paid — #65 |
| Repeated NOWPayments IPN re-notified the admin | no repeat notice — #65 |
| **Crypto orders failed with `price_unavailable`** (proven 2026-11-11 from a non-Iran server): the coin-price fallback CryptoCompare answers 401 "API key required", so any CoinGecko rate-limit left no price; of the 5 USD/toman exchanges only Wallex still answered abroad (`api.nobitex.ir` no DNS, Tabdeal ticker 404, Bitpin/Ramzinex 403) | coin prices merged per coin from CoinGecko → KuCoin → Coinbase (+ saved copy per coin); USD rate from Nobitex `apiv2`, Wallex depth, Tabdeal depth, Exir (single-market endpoints, small JSON for the 10 ms CPU limit); bot "💵 قیمت دلار" also shows the coin price sources |

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
| (measured) always-on phones still wrote ~2 rows/user/min → 100 users = 295k rows/day (cap 100k) | `LEDGER_EVERY` 10 min → 33k/day — #58 |
| per-minute expiry check scanned all subscriptions (rows-read budget) | index 0021 — #62 |
| AD5 chain scan + sync shared 50 subrequests but sync budgeted 44 for itself | `scanAll` reports its spend, `runSync` shrinks — #65 |
| appupdate GitHub calls had no timeout | 10 s deadline, 503 `update_unavailable` — #63 |
| Panel 1 admin gets 403 on `/api/groups` and `/api/hosts` → no IR TUNNEL marks | `cgtunnel_` probe user in the Tunnel group — #61 |
| "Unknown country" for remarks without a flag emoji | names / codes / host labels (`countries.js`) — #67; learned exit country — #72, #76 |
| Bot: 🗂 پنل‌های کاربر ran the app-update announce (shared route `upa`) | route renamed `m:uac` — #55 |

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
| Google not opening while Telegram works on some exits | IPv6 black hole (tun routes `::/0`, exit has no IPv6) — #46 |
| **1.2.24: no exit connected at all** (proven) — IPIfNonMatch resolved the start check's host to IPv6, which the new block rule refused | AsIs, phone-only rules scoped to `inboundTag socks`, IPv4 DNS — #48 |
| A dead line showed as "wrong password / wrong code" | `ApiError.offline` → neutral connection card — #54 |
| Native crash (SIGABRT) reports carried only the signal | tombstone + Go stderr + tunnel state in the report — #77, #79, #80 (root cause still open, §19) |
| Widget: start from a fully closed app refused by Android 12+/MIUI | invisible `WidgetConnect` activity — #78 (1.2.42) |
| Widget: cold start fails between core and hev (`start_err`) | [guess] preload core + hev in `onCreate` — #78 (1.2.44), **unconfirmed** |

### CI
| Problem | Fix |
|---|---|
| Artifact storage full | APKs to release `pleat-latest` — #23 |
| GitHub release downloads 504 for hours (Xray, geo, Gradle, Maven) | cache + mirrors for every download in one go — #42 |
| Free Actions minutes ran out (2026-11-09) | no double runs, APK only on manual run — #57; repo made public |

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
- **TR 1 / TR 7** are named Turkey on the panel but leave through German hosting (Hetzner, dataforest); since #76
  the Worker lists them as DE. Ali may want to fix the remarks.
- The app forces WireGuard MTU 1280 (links say 1420); that is the proven fix for DE 7 / DE 10.

---

## 17. Wrong theories — do not revisit

- **WireGuard domain-endpoint DNS deadlock** (PR #28): the core's MeasureOutboundDelay keeps only
  outbound/dispatcher/log, so DNS changes were irrelevant to the check. The real fix was MTU 1280.
- **WebSocket h2 ALPN** causing closed pipes (PR #28): not the cause; closed pipes are server-side (§16).
- **The "No server connected · DE" alerts** from the DE 3 user are not crashes: DE exits fail on that Wi-Fi.
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
- Moving the Night mode toggle (Ali rejected all three placements) — leave it where it is.
- Recommended exits on Home's Route or Stats tabs (only under Now).

---

## 19. Open items and known gaps

- **Pleat 1.2.48 (PR #88) phone test**: Activity hub (ring, PACKAGES sheet, RENEW, Keep history off/on, Clear
  history), Profile Plans shelf (BUY opens checkout, stopped plan shows RENEW). **1.2.49 (PR #89)**: Locations
  country list (Fastest bar, chips, regions, pips, Not answering).

### Waiting on Ali (no code pending, as of 2026-11-12)
- **Phone test Pleat 1.2.33 → 1.2.46**: avatar gate, update live track on MIUI, version signature, Route cards and
  rules, Stats, a health report (long-press the version), detailed crash view in the bot, **widget cold start**
  (connect once in the app first to seed the spare exits; 1.2.44 fix unconfirmed), Recommended exits under Now,
  **Protect** (Shield, Privacy check while connected, Google location › Test). Checklists in the project files:
  `engineering-audit/phone-test-checklist.md`, `health-reports/phone-test.md`.
- Connect once to each exit with an unknown country so the Worker learns it (bot: 🖥 سرورها shows ❓ for those).
- Bot "💵 قیمت دلار": confirm the crypto price sources answer live.
- One day after a Deploy: check D1 rows written / rows read charts in the Cloudflare dashboard (the audit's
  measurements were on the test shim, not real D1).
- Fix the server-side exits in §16.
- The `/credit <email> <amount> <note>` manual wallet top-up idea (offered, awaiting a yes) — if built, it must be a
  bot button flow, not a typed command.
- PR #21 is most likely superseded by #22; check and close it.

### Open investigation: native crash on DE 3
One user (Xiaomi, Android 12) had 5 native SIGABRT crashes (reason 5 / status 6) in a week, each with the tunnel
connected. Root cause **unproven**: the old reports carried only the signal. #77/#79/#80 now capture tombstone,
Go stderr and the tunnel state; waiting for a **fresh** crash report from 1.2.42+. Suggested diagnostic: try a
non-DE country (e.g. NL) on that phone.

2026-11-13, first detailed one (1.2.49, TR 3, tunnel up): SIGABRT (SI_TKILL), thread `app.pleat.pleat`, one frame
`libgojni.so ?`, tombstone read, stderr "quiet". Proven: the signal was raised by code inside libgojni.so (the Xray
core): a libc `abort()` (fdsan, Flutter, ART) would put libc as frame 0. In this build of the library only Go's
`runtime.raise` sends SIGABRT that way, and Go's fatal paths print first, so "quiet" contradicts it. Not proven:
whether the stderr capture covered that process (before 1.2.50 it took any process's capture). Thread names do not
mean main: Go's threads inherit the name of the thread that loaded the core. 1.2.50 sends the offsets (`addr`)
and the sender, which name the Go function.

### Open investigation: "No server connected · DE" (2026-11-12)
17 reports in 12 h from the same phone model (two accounts), route Auto + country DE, 5 DE exits, sometimes
nothing in "tried". Proven from the code: "tried" was emptied by the resync retry (it cleared the list before trying
again), so an empty list did not mean nothing was tried. Earlier reports named two DE exits really tried and failed.
1.2.47 keeps every exit tried in the connect, adds `why` (each route exit's last test result on that network:
timeout / refused / tls / reality / ok / untested) and `age`, and the bot shows server names instead of keys. Which
DE server fails and why is known only from the next report.

### Telegram Mini App (user stage 1 + full admin panel built, PRs #50–#52)
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
- **Full parity again (PR #85, 2026-11-12)**: what the bot gained after #52 is now in the Mini App too —
  **Cloudflare monitoring** as a visual dashboard (`monitor.jsx` + hand-drawn SVG `charts.jsx`: quota rings with the
  end-of-day projection, requests per hour with errors stacked, CPU p99 line against the 10 ms cap, how requests
  ended, a capacity gauge, 7-day columns per cap, costliest queries as share bars, deploys + merged-not-deployed,
  token setup, the Worker error log with clear, hourly alerts toggle); **App health reports** (`reports.jsx`: per
  priority with a 7-day stacked chart, by server, by user, versions and phones, one problem with users/phones/last
  report/native-crash reading, handled / mute 7 days / what the app sends); **System health** sync now + retry stuck;
  panel servers with the tunnel mark, panel-name-vs-real-exit country and unknown-country remark, a server page
  (show/hide, name, network stats, health reports, history), the **Iran-tunnel diagnostic** (re-read = owner); one
  server on every carrier + Google's view; user card → that user's health reports. Not carried over on purpose: the
  bot's "🧪 تست Mini App" probe (it tests whether the Mini App opens, meaningless from inside it), "❓ راهنما" (bot
  help text), "send waiting receipts as photos" (the Mini App shows receipts inline), and hidden legacy text commands.
- **Design = Pleat's own language, not just its colours** (the first version copied only the colours and looked
  broken): Plus Jakarta Sans shipped with the page (`build.mjs` copies it from `@fontsource`; Google Fonts is filtered
  in Iran; CSP `font-src 'self'`), Vazirmatn only for Persian names, line icons (`miniapp/src/icons.jsx`), hero
  numeral with shards, uppercase pill actions, icon list rows, bottom nav with the blue circle, pleats + day dots,
  day/night direction A. Before sending UI, screenshot each screen next to the matching Pleat screen.
- The bot's refusals are Persian; `miniapp/src/admin/errors.js` translates them, and `englishSummary` in `fmt.js` the
  admin log. `miniapp/test/admin.test.js` fails when a new bot refusal, action or setting has no English text.

### Engineering audit (complete, 2026-11-11)
All 15 phases (discovery → architecture → code → security → VPN → DB → API → performance → UX → mobile →
testing → devops → business logic → repair → validation) are done; fixes landed in #41, #44, #45, #58, #62–#65.
The full state file is `engineering-audit/ENGINEERING_AUDIT.md` in the project files (partly Persian, 25 sections).

Scorecard (§25 of the audit, 10 = production-ready at scale): architecture 7 · code quality 7 · security 7.5 ·
database / Free-plan scale 8 · user-path performance 7.5 · money logic 8.5 · tests 8 · DevOps 6 · UX/mobile
unscored (phone-only).

**Decisions still open (Ali's call, no code until he decides):** S6 trust in the SMS sender · S10 backup
encryption / PII in backups · S11 refresh-token rotation (changes the app, needs a phone test) · S15 email
verification · AD3/P17 panel 1 still special (always in provision, HWID, device removal, buying needs
`PASARGUARD_URL`) · AD4 real device limit · AD6 staging (second Cloudflare account or separate D1) · P13 pin
actions to SHAs. Also open: N6 exit domain resolved by the operator's DNS · N7 `allowInsecure=1` from the panel is
honoured · P20 outdated README · Gmail one-tap sign-in (needs a Google OAuth client).

### Follow-ups (non-critical)
PBKDF2 iterations (only with a CPU budget), split `telegram.js`, a `confirmPayment` use case, a notify port,
compat-date bump (`2025-09-01`), delete `android/`,
`app-web/`, `android.yml` and the old-app compatibility paths (`centralApp`, `sub_url`, `/vpn/sub`,
`/pay/done` with `cloudgold://`). Not built: per-session byte usage, Cloudflare clean-IP/SNI tricks, a domestic relay for intranet-only periods, Hiddify adapter.
Payments (after PAY-01..04): a real sample of the owner's bank SMS is still wanted to confirm the deposit-line rule
on his exact format (unclear SMS go to the admin, never auto-paid); an order whose settle is killed every time is
retried every 10 minutes with no cap; a wallet order whose debit committed but whose run died before `settle`'s claim
stays `pending` with the money taken and nobody is told (pre-existing, review N5; it is approvable); SMS logged before PAY-03 keep their sender-based hash; the card suffix is still
predictable (`(id*37+i)%99`) and a just-paid amount can be reused at once (audit suggestions not in the approved scope).

---

## 20. How to do common jobs

**Add a Worker endpoint.** Add the route in `index.js` `route()` (authed paths go in the `authed` list), put
the logic in the module that owns the data, count D1 queries (batch!), add tests in `test/run.mjs` (the
50-query guard runs automatically), **add it to `docs/API.md`** (a test fails otherwise), update
`flutter_vpn/docs/backend-map.md` if the app uses it.

**Add an admin (Mini App) endpoint.** One row in `admin-api.js` `ROUTES` with the lowest role that may use it;
writes go through `POST /admin/action` → `admin-actions.runAction`, not a new route. Add the English label /
refusal text in `miniapp/src/admin/errors.js` / `fmt.js` (the Mini App test fails otherwise) and the row in
`docs/API.md`.

**Add a DB column/table.** New file `worker/migrations/00NN_name.sql`, additive only, explain it in a header
comment, **add it to `docs/DATABASE.md`** (a test fails otherwise). Run Deploy to apply it.

**Add a health-report type.** Add it to `TYPES` (priority) and `TYPE_FA` in `health.js`, emit it from
`lib/state/health.dart`, scrub any new detail field on both sides, add a test (the suite checks scrubbing and caps).

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
workflow(s) that must run.

**Keep these docs current.** Any PR that changes a fact here (new PR, migration, route, setting, rule from Ali,
version) updates this handbook, `API.md` or `DATABASE.md` in the same PR: add the PR to §13 and §14, bump the
version in §10, move finished items out of §19.

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
- Two Pleat builds that both publish to `pleat-latest` overwrite each other; build one at a time.
- Kotlin can't be compiled in the container (no Android SDK); a quick check is `kotlinc` against an
  `android.jar`, the real compiler is the manual Pleat workflow. A Kotlin error shows up only there.
- **Never delete the `cgtunnel_…` user on panel 1**: the IR TUNNEL marks depend on it.
- Bot callback routes are plain strings; a duplicate prefix runs the wrong screen (the `upa` bug).
- `Health.kt` drops exit records for processes Android killed or force-stopped silently; a missing report is not
  proof that nothing happened.
- Routing rules for phone traffic need `inboundTag: ['socks']` (§10), or the core's own checks are blocked too.
- Manual edits on a panel (limits, expiry, enable) are overwritten by the sync job; use the bot.

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
| **IR TUNNEL** | a config from a panel's "Tunnel" group (an Iran-side relay); Pleat shows a slanted badge |
| **P1 / P2** | which panel a config comes from |
| **Route goal** | Auto / Stealth / Speed / Classic on Home › Route; each exit's family is read from its link |
| **Shield** | Protect's DNS filtering: Off / Safe / Clean (+ adult sites) |
| **Health report** | an automatic problem report from Pleat to `/me/health`; P1 alerts the admin at once |
| **Status strip** | the 4×1 home-screen widget |
| **Server key** | anonymous FNV-1a hash of `type\|host\|port` that names an exit without its address |
| **Integration thread** | the cheaper-model thread that merges, deploys and builds |
| **toman / rial** | Iranian currency; 1 toman = 10 rial. Prices are toman, bank SMS are rial |
