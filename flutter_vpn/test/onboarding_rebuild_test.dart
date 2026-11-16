// PERF-A-06: the onboarding bubbles swap every 900 ms without building the
// whole screen again; only the orbit scene follows the tick.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/screens/onboarding.dart';
import 'package:pleat/state/app_state.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

void main() {
  testWidgets('a bubble tick does not rebuild the onboarding screen', (
    tester,
  ) async {
    PType.familyOverride = 'PleatTest';
    SharedPreferences.setMockInitialValues({});
    final app = AppState(
      await SharedPreferences.getInstance(),
      FakeApi(MemoryTokens(signedIn: false)),
      tunnel: FakeTunnel(),
    );
    await tester.pumpWidget(
      AppScope(
        state: app,
        child: const MaterialApp(home: OnboardingScreen()),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    var screen = 0;
    debugOnRebuildDirtyWidget = (e, _) {
      if (e.widget is OnboardingScreen) screen++;
    };
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    debugOnRebuildDirtyWidget = null;
    // four ticks went by; the screen itself was not built again
    expect(screen, 0);
    await tester.pumpWidget(const SizedBox());
  });
}
