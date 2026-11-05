import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/screens/profile.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/state/app_state.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

double contrast(Color a, Color b) {
  final x = a.computeLuminance(), y = b.computeLuminance();
  final hi = x > y ? x : y, lo = x > y ? y : x;
  return (hi + 0.05) / (lo + 0.05);
}

Future<void> pumpFor(WidgetTester t, int n) async {
  for (var i = 0; i < n; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  tearDown(() => PColors.current = PPalette.sky);

  for (final p in [PThemes.day, PThemes.night]) {
    group('${p.name} palette keeps text readable', () {
      test('body text on ground and surface (4.5:1)', () {
        expect(contrast(p.ink, p.ground), greaterThanOrEqualTo(4.5));
        expect(contrast(p.ink, p.surface), greaterThanOrEqualTo(4.5));
      });
      test('secondary text on surface (3:1)', () {
        expect(contrast(p.muted, p.surface), greaterThanOrEqualTo(3));
      });
      test('gold used as text on surface (4.5:1)', () {
        expect(contrast(p.accentInk, p.surface), greaterThanOrEqualTo(4.5));
      });
      test('button labels on the gold fill (4.5:1)', () {
        expect(contrast(p.onAccent, p.blue), greaterThanOrEqualTo(4.5));
      });
      test('text on the big planes (4.5:1)', () {
        expect(contrast(p.onDeep, p.navy), greaterThanOrEqualTo(4.5));
      });
    });
  }

  test('every tint comes from the one gold', () {
    for (final p in [PThemes.day, PThemes.night]) {
      for (final c in [p.ground, p.field, p.navy, p.blue, p.ice, p.mist]) {
        final h = HSLColor.fromColor(c);
        if (h.saturation < 0.05) continue;
        expect(
          (h.hue - HSLColor.fromColor(PThemes.gold).hue).abs(),
          lessThan(3),
        );
      }
    }
  });

  test('Auto follows the phone, a pick sticks', () {
    expect(PThemes.resolve('auto', Brightness.dark), same(PThemes.night));
    expect(PThemes.resolve('auto', Brightness.light), same(PThemes.day));
    expect(PThemes.resolve('day', Brightness.dark), same(PThemes.day));
    expect(PThemes.resolve('night', Brightness.light), same(PThemes.night));
  });

  testWidgets('Night from Profile changes the app in place and is saved', (
    tester,
  ) async {
    PType.familyOverride = 'PleatTest';
    tester.view.physicalSize = const Size(1080, 2340);
    tester.view.devicePixelRatio = 2.75;
    addTearDown(tester.view.reset);
    SharedPreferences.setMockInitialValues({'onboarded': true, 'theme': 'day'});
    final prefs = await SharedPreferences.getInstance();
    final api = FakeApi(MemoryTokens(signedIn: true));
    final state = AppState(prefs, api, tunnel: FakeTunnel());
    await state.refreshAccount();
    await tester.pumpWidget(PleatApp(state: state));
    await pumpFor(tester, 30);
    expect(PColors.current, same(PThemes.day));

    await tester.tap(find.byType(Avatar).first);
    await pumpFor(tester, 20);
    final night = find.text('Night');
    await tester.scrollUntilVisible(
      night,
      200,
      scrollable: find.byType(Scrollable).last,
    );
    await pumpFor(tester, 5);
    await tester.tap(night);
    await pumpFor(tester, 5);

    expect(PColors.current, same(PThemes.night));
    expect(prefs.getString('theme'), 'night');
    // Still on Profile: the switch rebuilt the screen, it did not reset it.
    expect(find.text('Appearance'), findsOneWidget);
    final bg = tester.widget<Scaffold>(find.byType(Scaffold).last);
    expect(bg.backgroundColor, PThemes.night.ground);
  });
}
