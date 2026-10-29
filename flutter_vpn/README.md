# Pleat — Flutter VPN demo

A private tunnel for this phone. Pleat is a standalone Flutter demo: local
seeded state, no real tunnel, no real payment. Every control works and its
state persists with `shared_preferences`.

It keeps the reference's material (studio ground `#E7F1FA`, white radius-30
surfaces, navy/blue/ice/mist diagonal shards, Plus Jakarta Sans, pill
controls, corner tabs, the travelling blue nav circle) and breaks its
layouts. The name and the mark (two offset folded planes) are original.

## Run

```sh
cd flutter_vpn
flutter pub get
flutter run          # first route is Splash
flutter analyze      # clean
flutter test
```

CI: `.github/workflows/flutter-vpn.yml` formats, analyzes, tests and builds
an APK artifact (`pleat-apk`) whenever `flutter_vpn/` changes.

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

`lib/screens/` has Splash, Onboarding, Login, Confirm, the tab shell (Home,
Protect, Locations, Activity), Location detail, Plans and Profile.
`lib/state/` holds the seeded data and the app state.

## The ten moves, in the running app

1. Shard field always on stage, drifting; leans toward the selected exit,
   pulls in during the handshake, rests when protected, parallaxes on scroll.
2. Connect lives in the field on Home: idle pill, circular handshake with the
   mark split and turning, then the sealed mark with the green ring. About
   1.6s, tap again to cancel.
3. Opening a city flies through the shards (500ms) and lands on the photo.
4. Onboarding keeps one circular scene; orbit bubbles swap icons every 900ms,
   the metric disk trades "28 ms" and "AES-256", beats change by shard shift
   and headline wipe.
5. Home's display-size number (ping, session timer, hops, GB) is cut by a
   navy shard that re-sets the figure in white.
6. Locations: the first city is oversized, bleeds past the gutter and the
   second card rides 16px over it; the rest is a dense list. Categories
   reshape the shard colour mix.
7. Protect: the kill switch is the big card and flips the shard mood; split
   tunnel and DNS are spatial cards.
8. Activity is a log: city headline, then duration, data and protocol.
   Reconnect re-runs the handshake.
9. Press scale 0.985 with a tightening shadow; spring nav; 40ms stagger.
10. Reduced motion (system setting or Profile → Reduce motion): no travel,
    no orbit, no drift; every state still changes.

Profile → "Simulate a dropped tunnel" shows the red dropped state on demand.
