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
| Server quality | `GET /net/rank` | `asn`, `isp_en`, `mobile`, `servers{k: score, ms, kbps, n, users}` keyed by FNV-1a of `type|host|port` (same key as `CgVpn.serverKey`) | "On Irancell" line, Strong/Weak on the operator (3+ people), others' speed until this phone measured, Best category, recommended order |
| Results shared | `POST /net/report` | `{results:[{k, ok, ms}]}` after pings, `{results:[{k, kbps}]}` after speed tests, 9 s apart | Per-operator ranking for everyone |
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

## 4. In the UI, absent from the backend

| UI capability | Where it comes from now |
| --- | --- |
| The tunnel itself | Native, not backend: `PleatVpnService` (Android VpnService) + the Xray core (`libv2ray.aar`, same tag as the Cloud Gold app) + hev-socks5-tunnel, behind the `pleat/tunnel` channel. Dart builds the Xray config from the chosen config's link (`lib/state/xray_config.dart`). Protected appears only after a probe request has crossed the exit; a revoked or failed tunnel turns Home red. |
| Kill switch, auto-connect | Android's own Always-on VPN + "Block connections without VPN". The cards open that settings page; Pleat can't read or set it itself. |
| Private DNS | Fixed: every lookup goes through the exit to 1.1.1.1. The backend offers no resolver to choose. |
| Local network | Fixed: private ranges stay local (core routing rule). |
| Split tunnel, threat filter | No backend and no engine support yet: shown unavailable. |
| Protocol choice | Each config has one protocol; the control picks the best exit with that protocol. hy2/tuic links are refused with a message, not guessed. |
| Session history | Logged on this phone only for sessions that really ran. |
| Bookmarks | On this phone only. |
| Email code / resend, phone sign-in | Not offered by the backend; not shown as working. |
| Country from IP | No geo-IP lookup in the backend; country comes from the remark, host label only as a hidden hint. |

Builds without the engine libraries (local `flutter run`) answer `available: false` and keep the honest "not in this build" state.

## Rules kept

No host, address, panel name or panel count on screen, in logs or in
accessibility labels. Tokens live in Android Keystore-backed secure storage and
are never logged. No backend, quota, disconnect or payment logic changed.
