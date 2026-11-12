# AGENTS.md — rules for AI coding agents in this repo

Read **[`docs/PROJECT_HANDBOOK.md`](docs/PROJECT_HANDBOOK.md)** before changing anything. Routes:
[`docs/API.md`](docs/API.md). Tables and migrations: [`docs/DATABASE.md`](docs/DATABASE.md).

## What this is
- `worker/` — Cloudflare Worker (plain JS ESM, no runtime deps) + D1. App API, admin Telegram bot, bank-SMS and
  crypto payment confirmation, control plane over third-party VPN panels (PasarGuard, Marzban, Rebecca). Every
  payment ends in `billing.settle()`.
- `flutter_vpn/` — **Pleat**, the product Android app (Flutter + Kotlin, Xray core + hev-socks5-tunnel).
- `miniapp/` — Telegram Mini App (Preact), user side + admin panel; built into `worker/public/`.
- `android/`, `app-web/` — the retired old app. Do not extend.

## Hard rules
1. **Cloudflare Free plan**: 10 ms CPU, 50 subrequests and **50 D1 queries per invocation** (batch = 1),
   ~100k D1 writes/day. The Worker test suite fails any request or cron run over 50 queries. Don't raise PBKDF2
   iterations.
2. **Migrations are additive only.** Never drop/rename tables, columns or applied migration files. New file
   `worker/migrations/00NN_name.sql` + a row in `docs/DATABASE.md`.
3. **The repo is public. No secrets anywhere**: no panel addresses, logins, subscription links, UUIDs, keys,
   tokens, card numbers or wallet addresses in code, tests, docs, logs or commit messages. Tests use made-up values.
4. **Languages**: Pleat UI and the Mini App are **English only** (no Persian, no RTL). The admin bot is Persian.
   Code comments and docs are English. Talk to the owner (Ali) in Persian.
5. **The admin bot is buttons only** — never make the owner type a `/command` (a test enforces it).
6. **Evidence before "fixed"**: say what is proven (run / test / log) and what is a guess. VPN routing and the
   Android tunnel can only be proven on the owner's phone.
7. Pleat: colours only from `PColors`; bump `version` **and** the `+build` in `flutter_vpn/pubspec.yaml` for every
   release. Routing rules for phone traffic must carry `inboundTag: ['socks']`.
8. Work on a branch, open a PR; merging deploys nothing. Deploy (`Deploy Cloud Gold server`) and the APK
   (`Pleat Flutter app`, manual run) are manual workflows.
9. **Keep the docs current in the same PR**: new route → `docs/API.md`, new migration → `docs/DATABASE.md` (both
   checked by a test), new feature / PR / rule / version → `docs/PROJECT_HANDBOOK.md` (§10, §13, §14, §19).

## Checks
```sh
cd worker && npm test                 # Node 22; ~1,450 checks incl. the 50-query guard and the docs check
cd miniapp && npm ci && npm test && npm run build
cd flutter_vpn && flutter analyze && flutter test   # no Android SDK in cloud containers; CI builds the APK
```
