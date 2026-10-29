import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/connect_control.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/screens/onboarding.dart';
import 'package:pleat/screens/shell.dart';
import 'package:pleat/state/app_state.dart';
import 'package:pleat/state/tunnel.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

Future<(AppState, FakeApi)> _boot(
  WidgetTester tester,
  Map<String, Object> prefs, {
  bool signedIn = true,
  Tunnel? tunnel,
}) async {
  PType.familyOverride = 'PleatTest';
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues(prefs);
  final api = FakeApi(MemoryTokens(signedIn: signedIn));
  final state = AppState(
    await SharedPreferences.getInstance(),
    api,
    tunnel: tunnel,
  );
  if (signedIn) await state.refreshAccount();
  await tester.pumpWidget(PleatApp(state: state));
  // Splash runs ~2s, then fades to the next route.
  for (var i = 0; i < 30; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  return (state, api);
}

void main() {
  testWidgets('first launch goes from splash to onboarding', (tester) async {
    await _boot(tester, {}, signedIn: false);
    expect(find.byType(OnboardingScreen), findsOneWidget);
  });

  testWidgets('the exits on screen are the backend list, with countries', (
    tester,
  ) async {
    final (app, _) = await _boot(tester, {'onboarded': true});
    expect(find.byType(Shell), findsOneWidget);
    expect(app.exits.map((e) => e.label), ['NL 1', 'DE 1', 'Server 3']);
    expect(app.exits.map((e) => e.code), ['NL', 'DE', 'US']);
    // DE 1 has the network report, so it ranks first.
    expect(app.ranked.first.label, 'DE 1');
    expect(app.ranked.first.ping, 95);
    app.setTab(2);
    await tester.pump(const Duration(milliseconds: 800));
    expect(find.text('Netherlands'), findsWidgets);
    expect(find.textContaining('example.com'), findsNothing);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('without a tunnel engine connect never reaches Protected', (
    tester,
  ) async {
    final (app, api) = await _boot(tester, {'onboarded': true});
    await tester.tap(find.byType(ConnectControl));
    await tester.pump();
    expect(app.phase, Phase.checking);
    // The real channel: no native tunnel is registered in this build.
    await tester.runAsync(() => app.connect());
    await tester.pump();
    expect(api.calls, contains('GET /vpn'));
    expect(app.phase, Phase.idle);
    expect(app.tunnelMessage, contains('tunnel engine'));
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('Protected only after the tunnel is up; a stopped plan drops', (
    tester,
  ) async {
    final tunnel = FakeTunnel();
    final (app, api) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    final chosen = app.exits[1];
    await app.connect(chosen.id);
    expect(app.phase, Phase.handshaking);
    expect(tunnel.started, chosen.server.link);
    tunnel.emit(TunnelState.up);
    await tester.pump(PMotion.seal);
    expect(app.phase, Phase.protected);
    expect(find.textContaining('Protected.'), findsOneWidget);

    tunnel.emit(TunnelState.down);
    await tester.pump(const Duration(milliseconds: 400));
    expect(app.phase, Phase.dropped);
    expect(app.sessions.first.exitId, chosen.id);

    // Reconnect, then the plan runs out while the tunnel is up.
    await app.connect();
    tunnel.emit(TunnelState.up);
    api.active = false;
    await tester.pump(const Duration(seconds: 61));
    await tester.pump(const Duration(milliseconds: 50));
    expect(app.phase, Phase.dropped);
    expect(tunnel.stopped, isTrue);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('a rejected trial does not stay on', (tester) async {
    final (app, api) = await _boot(tester, {'onboarded': true});
    api.trialError = 'The free trial was already used.';
    final err = await app.startTrial(app.plans.value!.first);
    expect(err, 'The free trial was already used.');
    expect(app.subscription!.planName, 'Monthly test');
  });

  testWidgets('sign out stops authenticated calls', (tester) async {
    final (app, api) = await _boot(tester, {'onboarded': true});
    await app.signOut();
    api.authedCalls.clear();
    await app.loadPublic();
    expect(app.signedIn, isFalse);
    expect(app.me.value, isNull);
    expect(api.authedCalls, isEmpty);
  });
}
