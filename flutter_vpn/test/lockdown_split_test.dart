// AND-05: Android's "Block connections without VPN" (lockdown) cuts off
// every app that is kept outside the VPN, so apps picked in Split route have
// no internet at all. Pleat cannot change that setting; it says so where the
// apps are picked, in Route and in the privacy check.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/screens/route_extras.dart';
import 'package:pleat/state/app_state.dart';
import 'package:pleat/state/protect.dart';
import 'package:pleat/state/route_rules.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

void main() {
  group('lockdownBypassNote', () {
    test('lockdown on with picked apps: a firm warning', () {
      final n = lockdownBypassNote(lockdown: true, apps: 2);
      expect(n, isNotNull);
      expect(n, contains('no internet'));
      expect(n, contains('Block connections without VPN'));
    });

    test('lockdown on and nothing picked: only the picker warns', () {
      expect(lockdownBypassNote(lockdown: true, apps: 0), isNull);
      expect(
        lockdownBypassNote(lockdown: true, apps: 0, picking: true),
        contains('no internet'),
      );
    });

    test(
      'unknown (Android 9, or Pleat not connected): a hint in the picker',
      () {
        expect(lockdownBypassNote(lockdown: null, apps: 1), isNull);
        final hint = lockdownBypassNote(lockdown: null, apps: 0, picking: true);
        expect(hint, startsWith('If '));
        expect(hint, contains('no internet'));
      },
    );

    test('lockdown known off: nothing to say', () {
      expect(lockdownBypassNote(lockdown: false, apps: 3), isNull);
      expect(
        lockdownBypassNote(lockdown: false, apps: 3, picking: true),
        isNull,
      );
    });

    test('English only', () {
      for (final n in [
        lockdownBypassNote(lockdown: true, apps: 1),
        lockdownBypassNote(lockdown: true, apps: 0, picking: true),
        lockdownBypassNote(lockdown: null, apps: 0, picking: true),
      ]) {
        expect(RegExp(r'[؀-ۿ]').hasMatch(n!), isFalse);
      }
    });
  });

  test(
    'privacy check: kill switch on plus apps skipping the VPN is a warning',
    () {
      final r = LeakReport(
        const {},
        (
          lockdown: true,
          bypassApps: 2,
          dns: '1.1.1.2',
          exitLabel: 'DE 2',
          network: '',
        ),
        DateTime(2026, 11, 16),
        const Duration(seconds: 5),
      );
      final row = r.rows.firstWhere((x) => x.title == 'Apps skipping the VPN');
      expect(row.verdict, Mark.warn);
      expect(row.sub, contains('no internet'));
      // the kill switch itself is still right to have on
      expect(
        r.rows.firstWhere((x) => x.title == 'Kill switch').verdict,
        Mark.ok,
      );
    },
  );

  group('Apps that skip the VPN screen', () {
    Future<AppState> pumpApps(
      WidgetTester tester, {
      ({bool alwaysOn, bool lockdown})? guard,
      List<String> picked = const [],
    }) async {
      PType.familyOverride = 'PleatTest';
      SharedPreferences.setMockInitialValues({'onboarded': true});
      final s = AppState(
        await SharedPreferences.getInstance(),
        FakeApi(MemoryTokens(signedIn: true)),
        tunnel: FakeTunnel(),
      );
      s.setBypassApps(picked);
      s.guard = guard;
      await tester.pumpWidget(MaterialApp(home: AppsScreen(app: s)));
      await tester.pump(const Duration(milliseconds: 300));
      return s;
    }

    testWidgets('lockdown on: says picked apps get no internet', (
      tester,
    ) async {
      await pumpApps(
        tester,
        guard: (alwaysOn: true, lockdown: true),
        picked: ['ir.mci.ecare'],
      );
      expect(find.textContaining('get no internet'), findsOneWidget);
      expect(
        find.textContaining('Block connections without VPN'),
        findsWidgets,
      );
    });

    testWidgets('lockdown unknown: a hint before anything is picked', (
      tester,
    ) async {
      await pumpApps(tester);
      expect(find.textContaining('If Android'), findsOneWidget);
    });

    testWidgets('lockdown known off: no warning', (tester) async {
      await pumpApps(
        tester,
        guard: (alwaysOn: true, lockdown: false),
        picked: ['ir.mci.ecare'],
      );
      expect(
        find.textContaining('Block connections without VPN'),
        findsNothing,
      );
    });
  });
}
