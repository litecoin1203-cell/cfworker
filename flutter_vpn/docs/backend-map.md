# Pleat ↔ Cloud Gold backend map

Backend: the Cloud Gold Worker (`worker/src`), base `…/api/v1`. Reference
client contract: `app-web/core.js` and the native bridge in
`android/…/cloudgold/`. Pleat talks to the Worker directly over HTTPS with one
client (`lib/api/client.dart`) and one set of parsers (`lib/api/models.dart`).

Headers on every call: `X-Device-Id` (random 128-bit id kept in secure
storage), `X-Device-Model`, `X-Device-OS`, `X-App-Version: 1.9.0 (Pleat …)`
(contract 1.9 = the Worker leaves `sub_url` out), and `Authorization: Bearer`
when signed in. On a 401 the client refreshes once with `/auth/refresh`; a
second 401 signs the phone out.

## 1. Already wired (before this change)

Nothing. Pleat was a seeded demo with no network code.

## 2. In the UI but mocked → now wired to the real call

| Capability | Entrypoint | Request → response fields used | Screen · control |
| --- | --- | --- | --- |
| Sign in | `POST /auth/login` | `email, password, device_id, device_model` → `access_token, refresh_token, expires_in` | Login → Continue, Password → Sign in |
| Create account | `POST /auth/register` | same + `referral_code?` → tokens (201) | Password → Create account |
| Session refresh | `POST /auth/refresh` | `refresh_token` → new tokens | client, on 401 |
| Account | `GET /me` | `email, wallet_balance, referral_code, trial_available, subscription{status, active, plan_name, days_left, expires_at, used_bytes, data_limit_bytes, used_percent, unlimited_data, unlimited_time, device_limit, stop_reason}` | Home header + Stats, Activity usage card, Profile plan card, Plans |
| Plans | `GET /plans` (public) | `id, name, duration_days, data_limit_gb, device_limit, price_toman, old_price_toman, badge, trial_days` | Plans cards, Password trial slab |
| Trial | `POST /trial` | `plan_id` → 200 + new subscription (via `/me`) | Plans → Start trial |
| Buy a plan (wallet) | `POST /orders` | `plan_id, method:"wallet", use_wallet:true` → order `status` | Plans → Buy with wallet |
| Server list | `GET /vpn/servers` | `index, name, country_code, protocol, link` (link kept in memory only, never shown) | Locations, Home recommended, Location detail, Protect protocol |
| Server quality | `GET /net/rank` | `servers{k: score, ms, n}` keyed by FNV-1a of `type|host|port` (same key as `CgVpn.serverKey`) | Ping figures, Fastest category, recommended order |
| Connect pre-check | `GET /vpn` | `subscription{status, active}`, registers this device (403 `device_limit`, 402 `no_subscription`, 410 `sub_missing`) | Home connect control, Location detail Connect here |
| Session watch | `GET /me` every 60 s while a session is up | `subscription.active/status` | Home + Activity: drop to red when the plan stops |
| Notices | `GET /app-config` | `announcement, support_url` + warnings derived from `/me` (80/95/100 % usage, ≤3 days left, expired/limited/disabled) | Bell sheet |
| Sign out | local | clears both tokens from secure storage and all account state; every later call gets no `Authorization` | Profile → Sign out |

## 3. In the backend, missing from the UI → added with existing components

| Capability | Entrypoint | Where it lives now |
| --- | --- | --- |
| Devices + remove | `GET /devices`, `DELETE /devices/:id` (204) | Profile → Devices card (rows + remove pill) |
| Sign out everywhere | `POST /auth/logout-all` (204) | Profile → row |
| Change password | `POST /auth/change-password` `{current_password, new_password}` | Profile → row → bottom sheet |
| Wallet balance | `/me.wallet_balance` | Plans header line |
| Referral code | `/me.referral_code` | Profile → row (copy) |
| Support link | `/app-config.support_url` | Profile → row (copy) |

Not added (needs a payment flow the brief rules out): card-to-card receipts
(`/orders/:id/receipt`), crypto (`/orders/:id/paid`, NOWPayments), coupons
(`/coupons/check`), order history (`/orders`), referral stats (`/referral`),
wallet ledger (`/wallet`). Plans says these live in the Cloud Gold app.

## 4. In the UI, absent from the backend → honest unavailable state

| UI capability | Why | What Pleat shows |
| --- | --- | --- |
| The tunnel itself (handshake, Protected, disconnect, traffic) | The Worker hands out configs; the tunnel runs only in the native v2rayNG core of the Cloud Gold app. Pleat has no core. | Connect does the real `/vpn` check, then asks the platform tunnel (`pleat/tunnel` channel). This build has none, so the control returns to idle with “Tunnel engine isn’t in this build”. Protected is never shown without a running tunnel. |
| Kill switch | Android always-on + lockdown, needs the tunnel | Card with disabled toggle + reason |
| Split tunnel | native only, needs the tunnel | Card with reason, no fake app list |
| Private DNS | no backend field; native only | Card with reason |
| Protocol choice | no backend switch; each config has one protocol | Real: the segmented control lists the protocols in your server list and picks the best server of that protocol |
| Auto-connect, threat filter, local network | native only / not in backend | Cards with disabled toggles + reason |
| Session history | no backend endpoint | Activity logs only sessions that really ran on this phone; empty state otherwise |
| Bookmarks | no backend endpoint | Kept on this phone only (stated on screen) |
| Email code / resend | backend login is email + password, no code | Confirm step is the password step; no resend |
| Phone sign-in | no backend | “Use a phone number” explains it isn’t offered |
| Country from IP | no geo-IP lookup in the backend | Country comes from the remark (flag, ISO code, or country name); host labels like `de1.` are a last internal hint, never shown |

## Rules kept

No host, address, panel name or panel count on screen, in logs or in
accessibility labels. Tokens live in Android Keystore-backed secure storage and
are never logged. No backend, quota, disconnect or payment logic changed.
