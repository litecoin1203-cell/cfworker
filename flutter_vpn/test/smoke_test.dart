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
    expect(tunnel.started, contains('"protocol":"vless"'));
    expect(tunnel.started, contains('de1.example.com'));
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

  testWidgets('a trial whose answer was lost still shows as started', (
    tester,
  ) async {
    final (app, api) = await _boot(tester, {'onboarded': true});
    api.hasPlan = false;
    await app.loadMe();
    expect(app.subscription, isNull);
    api.loseTrialAnswer = true;
    final err = await app.startTrial(app.plans.value!.first);
    expect(err, isNull);
    expect(app.subscription!.active, isTrue);
    expect(app.exits, isNotEmpty);
  });

  testWidgets('smart connect takes the fastest exit and moves on when it '
      'fails', (tester) async {
    final tunnel = FakeTunnel()
      ..pings = {'nl1.example.com': 240, 'de1.example.com': 60};
    final (app, api) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    // Too few reports for a sure pick, so the exits are tested.
    api.rankReports = 4;
    await app.loadServers();
    await app.connect();
    expect(app.phase, Phase.handshaking);
    expect(tunnel.started, contains('de1.example.com'));
    // Every exit was measured; the silent one is marked, and the network
    // stats got what worked here.
    expect(
      app.exits.firstWhere((e) => e.label == 'Server 3').unreachable,
      isTrue,
    );
    await tester.pump(const Duration(seconds: 2));
    expect(api.reports.where((r) => r['ok'] == true), hasLength(2));

    // The fastest exit doesn't answer the handshake: the next best runs.
    tunnel.emit(TunnelState.failed);
    await tester.pump(const Duration(milliseconds: 50));
    expect(app.phase, Phase.handshaking);
    expect(tunnel.started, contains('nl1.example.com'));
    tunnel.emit(TunnelState.up);
    await tester.pump(PMotion.seal);
    expect(app.phase, Phase.protected);
    await app.disconnect();
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('a picked exit is kept; smart connect does not override it', (
    tester,
  ) async {
    final tunnel = FakeTunnel()
      ..pings = {'nl1.example.com': 240, 'de1.example.com': 60};
    final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    app.select(app.exits.first.id);
    await app.connect();
    expect(tunnel.started, contains('nl1.example.com'));
    expect(tunnel.pinged, isEmpty);
    await app.cancel();
  });

  testWidgets('local sites go direct only when the build has the geo files', (
    tester,
  ) async {
    final tunnel = FakeTunnel()..geo = false;
    final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    await app.connect(app.exits.first.id);
    expect(tunnel.started, isNot(contains('geoip:ir')));
    await app.cancel();
    tunnel.geo = true;
    await app.connect(app.exits.first.id);
    expect(tunnel.started, contains('geoip:ir'));
    await app.cancel();
  });

  testWidgets('an exit that works for nearly everyone here is taken '
      'without a test', (tester) async {
    final tunnel = FakeTunnel();
    final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    final sure = app.exits.firstWhere((e) => e.id == 'k53ca1f60');
    await app.connect();
    expect(tunnel.pinged, isEmpty);
    expect(app.exit!.id, sure.id);
    await app.cancel();
  });

  testWidgets('offline, the last server list still connects', (tester) async {
    final (app, api) = await _boot(tester, {'onboarded': true});
    final count = app.exits.length;
    api.serversOffline = true;
    await app.loadServers();
    expect(app.exits, hasLength(count));
    expect(app.serversStale, isTrue);
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
