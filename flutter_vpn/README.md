# Pleat — Flutter client for Cloud Gold

Pleat is a Flutter client of the Cloud Gold Worker (`worker/`). Account,
plans, trial, server list, usage and devices are the backend's; nothing on a
primary screen is seeded. What each control calls, and what the backend does
not offer, is in [docs/backend-map.md](docs/backend-map.md).

The tunnel is native: `android/app/src/main/kotlin/app/pleat/pleat/`
runs a VpnService that feeds hev-socks5-tunnel into the Xray core
(`libv2ray.aar`), the same engine and versions as the Cloud Gold app. CI
fetches the core and builds hev (`android/compile-hevtun.sh`). Connect checks
the plan with `GET /vpn`, builds the Xray config for the chosen exit, and
starts the service through `pleat/tunnel`. Protected shows only after a probe
request has crossed the exit. A build without those libraries says the
engine isn't there and never shows Protected.

It keeps the reference's material (studio ground `#E7F1FA`, white radius-30
surfaces, navy/blue/ice/mist diagonal shards, Plus Jakarta Sans, pill
controls, corner tabs, the travelling blue nav circle) and breaks its
layouts. The name and the mark (two offset folded planes) are original.

## Run

```sh
cd flutter_vpn
flutter pub get
flutter run --dart-define=PLEAT_API=https://api.yourdomain.com   # comma list allowed
flutter analyze      # clean
flutter test

# the client against the real Worker, locally
node --experimental-sqlite ../worker/test/dev_server.mjs &
flutter test test/live_backend_test.dart --dart-define=LIVE_API=http://127.0.0.1:8787
```

CI: `.github/workflows/flutter-vpn.yml` formats, analyzes, tests, runs the
client against the local Worker, and builds an APK (`pleat-apk`) with
`PLEAT_API` from the run input or the `CG_API_BASE` repository variable.

Countries: each config's flag comes from its remark (flag emoji, a code
like `DE 2`, or a country name). The host is only a last internal hint and is
never shown.

## Where things live

`lib/design/` holds the system:

| File | What |
| --- | --- |
| `tokens.dart` | Colour, radius, shadow, motion and type tokens |
| `shard_field.dart` | The shard field: drift loop, lean, handshake pull, protected rest, kill-switch mood, scroll parallax |
| `scenes.dart` | Shard layouts per stage, category colour mixes, the live scene |
| `mark.dart` | Mark painter: draw-on, split, rotate, rejoin |
| `connect_control.dart` | Pill → handshake circle → protected seal, cancellable |
| `nav.dart` | Four-item nav, blue circle on a 0.72 damping spring |
| `tunnel_route.dart` | 500ms flight through the shards into a city, and back out |
| `city_art.dart` | Painted city "photos", media card with corner tab, offer card |
| `widgets.dart` | Press feedback (0.985), pill button, pill search, frosted slab, toggle, 40ms stagger |
| `icons.dart` | Outline icon set at a 1.75 stroke |

`lib/api/` is the one client (`client.dart`), the parsers (`models.dart`)
and the country lookup (`countries.dart`). `lib/state/` holds the app state,
the exit model and the tunnel channel. `lib/screens/` has Splash,
Onboarding, Login, the password step, the tab shell (Home, Protect,
Locations, Activity), Location detail, Plans and Profile.

## The ten moves, in the running app

1. Shard field always on stage, drifting; leans toward the selected exit,
   pulls in during the handshake, rests when protected, parallaxes on scroll.
2. Connect lives in the field on Home: idle pill, circular handshake with the
   mark split and turning, then the sealed mark with the green ring once the
   tunnel reports up. Tap again to cancel.
3. Opening an exit flies through the shards (500ms) and lands on its photo.
4. Onboarding keeps one circular scene; orbit bubbles swap icons every 900ms,
   the disk trades "Exits / Flags" and "Usage / Live", beats change by shard shift
   and headline wipe.
5. Home's display-size number (reported ping or days left, protocol, GB used,
   session timer) is cut by a
   navy shard that re-sets the figure in white.
6. Locations: the first exit is oversized, bleeds past the gutter and the
   second card rides 16px over it; the rest is a dense list. Categories
   reshape the shard colour mix.
7. Protect: the kill switch is the big card; split tunnel and DNS are
   spatial cards. Each says it needs the tunnel engine; protocol is live.
8. Activity: plan usage from `/me`, then a log of real sessions (country
   headline, duration, protocol).
   Reconnect re-runs the handshake.
9. Press scale 0.985 with a tightening shadow; spring nav; 40ms stagger.
10. Reduced motion (system setting or Profile → Reduce motion): no travel,
    no orbit, no drift; every state still changes.

The red dropped state appears only when the tunnel reports down or the plan
stops while a session is up (checked every 60 s with `GET /me`).
