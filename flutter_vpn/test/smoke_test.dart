import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/connect_control.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/screens/checkout.dart';
import 'package:pleat/screens/onboarding.dart';
import 'package:pleat/screens/shell.dart';
import 'package:pleat/state/app_state.dart';
import 'package:pleat/state/exits.dart';
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

  testWidgets('Locations: one entry per country, CONNECT goes Home', (
    tester,
  ) async {
    FakeApi.extraServers = [
      {
        'index': 3,
        'name': 'DE 2',
        'country_code': 'DE',
        'protocol': 'vless',
        'link': 'vless://u@de2.example.com:443?type=tcp#x',
      },
      {
        'index': 4,
        'name': 'FI 1',
        'country_code': 'FI',
        'protocol': 'vless',
        'link': 'vless://u@fi1.example.com:443?type=tcp#x',
      },
    ];
    addTearDown(() => FakeApi.extraServers = []);
    final (app, _) = await _boot(tester, {'onboarded': true});
    app.setTab(2);
    await tester.pump(const Duration(milliseconds: 800));
    // Germany has two exits: one row that opens into DE 1 and DE 2.
    expect(find.text('2 servers  ·  VLESS'), findsOneWidget);
    expect(find.text('DE 2'), findsNothing);
    await tester.tap(find.text('2 servers  ·  VLESS'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('DE 2'), findsOneWidget);
    expect(find.text('CONNECT'), findsWidgets);
    final connect = find.descendant(
      of: find
          .ancestor(of: find.text('DE 2'), matching: find.byType(Row))
          .first,
      matching: find.text('CONNECT'),
    );
    await tester.ensureVisible(connect);
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(connect);
    await tester.pump();
    expect(app.tab, 0);
    expect(app.exit?.label, 'DE 2');
    await tester.pump(const Duration(seconds: 2));
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

  testWidgets(
    'an old "down" replayed by the tunnel is not this attempt failing',
    (tester) async {
      final tunnel = FakeTunnel();
      final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
      await app.connect(app.exits[1].id);
      // Left over from before this attempt's "starting": ignored.
      expect(app.phase, Phase.handshaking);
      expect(app.exitId, app.exits[1].id);
      tunnel.emit(TunnelState.up);
      expect(app.phase, Phase.protected);
      await app.disconnect();
      await tester.pump(const Duration(seconds: 1));
    },
  );

  testWidgets(
    'Cancel while connecting goes idle at once and stops the tunnel',
    (tester) async {
      final tunnel = FakeTunnel();
      final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
      await app.connect(app.exits[1].id);
      expect(app.phase, Phase.handshaking);
      final done = app.cancel();
      expect(app.phase, Phase.idle);
      await done;
      expect(tunnel.stopped, isTrue);
      // A late answer from the cancelled attempt changes nothing.
      tunnel.emit(TunnelState.failed);
      expect(app.phase, Phase.idle);
      expect(app.tunnelMessage, isNull);
      await tester.pump(const Duration(seconds: 1));
    },
  );

  testWidgets(
    'next launch shows the last plan and exits before the Worker answers',
    (tester) async {
      final (first, api) = await _boot(tester, {'onboarded': true});
      expect(first.exits, isNotEmpty);
      final next = AppState(
        await SharedPreferences.getInstance(),
        api,
        tunnel: FakeTunnel(),
      );
      await next.warmStart();
      expect(next.exits.map((e) => e.id), first.exits.map((e) => e.id));
      expect(next.me.value?.email, first.me.value?.email);
      expect(next.serversStale, isTrue);
      await tester.pump(const Duration(seconds: 1));
    },
  );

  testWidgets('download speed: answering exits only, kept for a while', (
    tester,
  ) async {
    final tunnel = FakeTunnel()
      ..pings = {'nl1.example.com': 240, 'de1.example.com': 60}
      ..speeds = {'de1.example.com': 9000, 'nl1.example.com': 2000};
    final (app, api) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    await app.testSpeeds();
    // us1 never answered the ping, so it isn't download-tested.
    expect(tunnel.speedTested..sort(), ['de1.example.com', 'nl1.example.com']);
    Exit by(String host) =>
        app.exits.firstWhere((e) => e.server.link.contains(host));
    expect(by('de1').speed, Speed.fast);
    expect(by('nl1').speed, Speed.fair);
    expect(by('de1').meta, contains('Fast'));

    // Fresh results aren't measured again, and survive a new launch.
    tunnel.speedTested.clear();
    await app.testSpeeds();
    expect(tunnel.speedTested, isEmpty);
    final next = AppState(
      await SharedPreferences.getInstance(),
      api,
      tunnel: FakeTunnel(),
    );
    await next.loadServers();
    expect(
      next.exits.firstWhere((e) => e.server.link.contains('de1')).speed,
      Speed.fast,
    );
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('a metered network gets no download tests', (tester) async {
    final tunnel = FakeTunnel()
      ..pings = {'nl1.example.com': 240, 'de1.example.com': 60}
      ..speeds = {'de1.example.com': 9000, 'nl1.example.com': 2000}
      ..onMetered = true;
    final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    await app.testSpeeds();
    expect(tunnel.speedTested, isEmpty);
    expect(app.metered, isTrue);
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
    await tester.pump(AppState.planCheckEvery + const Duration(seconds: 1));
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

  testWidgets('checkout offers what the store has on and opens the card '
      'transfer', (tester) async {
    final (app, api) = await _boot(tester, {'onboarded': true});
    final nav = tester.state<NavigatorState>(find.byType(Navigator).first);
    nav.push(
      MaterialPageRoute<void>(
        builder: (_) => CheckoutScreen(plan: app.plans.value!.first),
      ),
    );
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('Card to card'), findsOneWidget);
    expect(find.text('Cryptocurrency'), findsOneWidget);
    // No Persian from the server reaches the screen.
    expect(find.textContaining('ترون'), findsNothing);
    await tester.tap(find.text('Card to card'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.ensureVisible(find.textContaining('PAY 459'));
    await tester.tap(find.textContaining('PAY 459'));
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(api.orderBodies.single['method'], 'card');
    expect(find.text('Bank Melli'), findsOneWidget);
    expect(find.text('Transfer exactly'), findsOneWidget);
    // Leave before the poll timer fires.
    nav.popUntil((r) => r.isFirst);
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
