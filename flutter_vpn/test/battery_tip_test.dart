// AND-02: with battery optimisation on, Android (and Xiaomi, Oppo, Huawei
// and others more so) may stop Pleat in the background. Protect says so
// once, with the pages to fix it, until it is fixed or hidden.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/screens/protect.dart';
import 'package:pleat/state/app_state.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

Future<AppState> _boot(
  WidgetTester tester,
  FakeTunnel tunnel, {
  Map<String, Object> prefs = const {},
}) async {
  PType.familyOverride = 'PleatTest';
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({'onboarded': true, ...prefs});
  final api = FakeApi(MemoryTokens(signedIn: true))..avatar = 'vesper';
  final app = AppState(
    await SharedPreferences.getInstance(),
    api,
    tunnel: tunnel,
  );
  await app.refreshAccount();
  await tester.pumpWidget(PleatApp(state: app));
  for (var i = 0; i < 30; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.tap(find.text('Protect'));
  await tester.pump(const Duration(milliseconds: 800));
  return app;
}

/// The card's lines sit low on the first screen, under the nav bar.
Future<void> _scrollDown(WidgetTester tester) async {
  await tester.drag(find.byType(ProtectScreen), const Offset(0, -300));
  await tester.pump(const Duration(milliseconds: 400));
}

Finder get _card => find.descendant(
  of: find.byType(ProtectScreen),
  matching: find.text('Keep Pleat running'),
);

void main() {
  testWidgets('optimised: Protect says so and opens the pages', (tester) async {
    final tunnel = FakeTunnel()..exempt = false;
    final app = await _boot(tester, tunnel);
    expect(app.batteryExempt, isFalse);
    expect(_card, findsOneWidget);
    await _scrollDown(tester);
    await tester.tap(find.text('Battery optimisation'));
    await tester.pump();
    await tester.tap(find.text('Autostart and app battery'));
    await tester.pump();
    expect(tunnel.batteryPages, ['battery', 'app']);
    // back from Settings with the exemption granted: the card goes
    tunnel.exempt = true;
    app.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await tester.pump(const Duration(milliseconds: 800));
    expect(app.batteryExempt, isTrue);
    expect(_card, findsNothing);
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('hidden stays hidden', (tester) async {
    final tunnel = FakeTunnel()..exempt = false;
    final app = await _boot(tester, tunnel);
    await _scrollDown(tester);
    await tester.tap(find.text('Hide'));
    await tester.pump(const Duration(milliseconds: 800));
    expect(_card, findsNothing);
    expect(app.batteryTipHidden, isTrue);
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('exempt, unknown, or hidden before: no card', (tester) async {
    for (final (exempt, prefs) in [
      (true, const <String, Object>{}),
      (null, const <String, Object>{}),
      (false, const <String, Object>{'battery_tip_hidden': true}),
    ]) {
      await _boot(tester, FakeTunnel()..exempt = exempt, prefs: prefs);
      expect(_card, findsNothing, reason: '$exempt $prefs');
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 3));
    }
  });
}
