import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/connect_control.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/screens/onboarding.dart';
import 'package:pleat/screens/shell.dart';
import 'package:pleat/state/app_state.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<AppState> _boot(WidgetTester tester, Map<String, Object> prefs) async {
  PType.familyOverride = 'PleatTest';
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues(prefs);
  final state = AppState(await SharedPreferences.getInstance());
  await tester.pumpWidget(PleatApp(state: state));
  // Splash runs ~2s, then fades to the next route.
  for (var i = 0; i < 30; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  return state;
}

void main() {
  testWidgets('first launch goes from splash to onboarding', (tester) async {
    await _boot(tester, {});
    expect(find.byType(OnboardingScreen), findsOneWidget);
  });

  testWidgets('connect runs checking, handshaking, protected and can cancel', (
    tester,
  ) async {
    final app = await _boot(tester, {
      'onboarded': true,
      'signedIn': true,
      'email': 'ryan@example.com',
    });
    expect(find.byType(Shell), findsOneWidget);

    await tester.tap(find.byType(ConnectControl));
    await tester.pump();
    expect(app.phase, Phase.checking);
    await tester.pump(PMotion.checking);
    expect(app.phase, Phase.handshaking);

    // Tapping mid-handshake cancels.
    app.primaryAction();
    await tester.pump();
    expect(app.phase, Phase.idle);

    app.connect();
    await tester.pump(PMotion.checking);
    await tester.pump(PMotion.handshake);
    await tester.pump(PMotion.seal);
    expect(app.phase, Phase.protected);
    expect(find.textContaining('Protected.'), findsOneWidget);

    app.disconnect();
    await tester.pump(const Duration(milliseconds: 400));
    expect(app.phase, Phase.idle);
    expect(app.sessions.first.exitId, app.exitId);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('protect settings persist', (tester) async {
    final app = await _boot(tester, {
      'onboarded': true,
      'signedIn': true,
      'email': 'ryan@example.com',
    });
    app.setTab(1);
    await tester.pump(const Duration(milliseconds: 800));
    await tester.tap(find.text('Kill switch'));
    await tester.pump(const Duration(milliseconds: 800));
    expect(app.killSwitch, isFalse);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('killSwitch'), isFalse);
  });
}
