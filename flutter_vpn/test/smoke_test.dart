import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/avatars.dart';
import 'package:pleat/design/connect_control.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/design/widgets.dart';
import 'package:pleat/main.dart';
import 'package:pleat/screens/avatar_gate.dart';
import 'package:pleat/screens/checkout.dart';
import 'package:pleat/screens/home.dart';
import 'package:pleat/screens/login.dart';
import 'package:pleat/screens/onboarding.dart';
import 'package:pleat/screens/profile.dart';
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
  String? avatar = 'vesper',
}) async {
  PType.familyOverride = 'PleatTest';
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues(prefs);
  final api = FakeApi(MemoryTokens(signedIn: signedIn))..avatar = avatar;
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

  testWidgets('Home Route: a goal card sets how smart connect picks', (
    tester,
  ) async {
    final (app, _) = await _boot(tester, {'onboarded': true});
    await tester.tap(find.text('Route'));
    await tester.pump(const Duration(milliseconds: 800));
    expect(find.text('How do you want to connect?'), findsOneWidget);
    // the plain fake exits are all Classic; no Stealth or Speed card
    expect(find.text('Stealth'), findsNothing);
    await tester.tap(find.text('Classic').last);
    await tester.pump(const Duration(milliseconds: 800));
    expect(app.routeMode.name, 'classic');
    expect(app.pinned, isFalse);
    expect(find.text('Classic mode, best location'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('Recommended exits sit under Now only, not Route or Stats', (
    tester,
  ) async {
    await _boot(tester, {'onboarded': true});
    expect(find.text('Recommended exits'), findsOneWidget);
    await tester.tap(find.text('Route'));
    await tester.pump(const Duration(milliseconds: 800));
    expect(find.text('Recommended exits'), findsNothing);
    await tester.tap(find.text('Stats'));
    await tester.pump(const Duration(milliseconds: 800));
    expect(find.text('Recommended exits'), findsNothing);
    await tester.tap(find.text('Now'));
    await tester.pump(const Duration(milliseconds: 800));
    expect(find.text('Recommended exits'), findsOneWidget);
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

  testWidgets('Locations marks Iran-tunnel configs, and the panel for admins', (
    tester,
  ) async {
    FakeApi.extraServers = [
      {
        'index': 3,
        'name': 'DE 2',
        'country_code': 'DE',
        'protocol': 'vless',
        'link': 'vless://u@de2.example.com:443?type=tcp#x',
        'panel': 2,
        'tunnel': true,
      },
    ];
    addTearDown(() => FakeApi.extraServers = []);
    final (app, _) = await _boot(tester, {'onboarded': true});
    final de2 = app.exits.firstWhere((e) => e.label == 'DE 2');
    expect(de2.server.panel, 2);
    expect(de2.server.tunnel, isTrue);
    final de1 = app.exits.firstWhere((e) => e.label == 'DE 1');
    expect(de1.server.panel, 0);
    expect(de1.server.tunnel, isFalse);
    app.setTab(2);
    await tester.pump(const Duration(milliseconds: 800));
    await tester.tap(find.text('2 servers  ·  VLESS'));
    await tester.pump(const Duration(milliseconds: 400));
    // one tunnel badge and one panel tag: DE 1 has neither
    expect(find.text('IR TUNNEL'), findsOneWidget);
    expect(find.text('P2'), findsOneWidget);
    expect(find.text('P0'), findsNothing);
    final labels = find
        .byType(Semantics)
        .evaluate()
        .map((e) => (e.widget as Semantics).properties.label ?? '')
        .where((l) => l.contains('DE 2'));
    expect(labels, contains('Open Germany, DE 2, Iran tunnel, panel 2'));
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
    'another exit while connected: the tunnel is handed over, never stopped',
    (tester) async {
      final tunnel = FakeTunnel();
      final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
      await app.connect(app.exits[1].id);
      tunnel.emit(TunnelState.up);
      expect(app.phase, Phase.protected);
      final first = tunnel.started;
      await app.connect(app.exits[0].id);
      // stopping would close the tun and let apps out with the real IP
      expect(tunnel.stopped, isFalse);
      expect(tunnel.started, isNot(first));
      expect(app.phase, Phase.handshaking);
      tunnel.emit(TunnelState.up);
      expect(app.phase, Phase.protected);
      await app.disconnect();
      expect(tunnel.stopped, isTrue);
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
    // Speeds go to the network stats once the 8 s between reports passed.
    await tester.pump(const Duration(seconds: 10));
    expect(
      api.reports.where((r) => r['kbps'] != null).map((r) => r['kbps']),
      unorderedEquals([9000, 2000]),
    );
  });

  testWidgets('Locations keeps the last results; a new network has its own', (
    tester,
  ) async {
    final tunnel = FakeTunnel()
      ..pings = {'nl1.example.com': 240, 'de1.example.com': 60}
      ..speeds = {'de1.example.com': 9000, 'nl1.example.com': 2000};
    final (app, api) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    api
      ..asn = 44244
      ..ispEn = 'Irancell';
    await app.refreshNetwork(force: true);
    expect(app.network?.name, 'Irancell');
    await app.openLocations();
    expect(tunnel.pinged, isNotEmpty);
    Exit de() => app.exits.firstWhere((e) => e.server.link.contains('de1'));
    expect(de().measured, 60);

    // Opened again later: nothing is tested, the results stay.
    tunnel
      ..pinged.clear()
      ..speedTested.clear();
    await app.openLocations();
    expect(tunnel.pinged, isEmpty);
    expect(tunnel.speedTested, isEmpty);
    expect(de().measured, 60);
    expect(de().speed, Speed.fast);

    // A new launch on the same network shows them at once.
    final next = AppState(
      await SharedPreferences.getInstance(),
      api,
      tunnel: FakeTunnel(),
    );
    await next.loadServers();
    expect(next.network?.name, 'Irancell');
    expect(
      next.exits.firstWhere((e) => e.server.link.contains('de1')).measured,
      60,
    );

    // On MCI the Irancell results are not shown; MCI gets its own test.
    api
      ..asn = 197207
      ..ispEn = 'MCI';
    tunnel.pings = {'nl1.example.com': 90};
    await app.refreshNetwork(force: true);
    expect(de().measured, isNull);
    await app.openLocations();
    expect(de().unreachable, isTrue);
    expect(
      app.exits.firstWhere((e) => e.server.link.contains('nl1')).measured,
      90,
    );

    // Back on Irancell: its results again, no new test.
    api
      ..asn = 44244
      ..ispEn = 'Irancell';
    tunnel.pinged.clear();
    await app.refreshNetwork(force: true);
    await app.openLocations();
    expect(de().measured, 60);
    expect(tunnel.pinged, isEmpty);

    // Pull to refresh tests now.
    tunnel.pings = {'de1.example.com': 70};
    await app.retestNow();
    await app.testSpeeds();
    expect(tunnel.pinged, isNotEmpty);
    expect(de().measured, 70);
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(seconds: 10));
    }
  });

  testWidgets('pings are tested again by themselves after an hour', (
    tester,
  ) async {
    final tunnel = FakeTunnel()..pings = {'de1.example.com': 60};
    final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    await app.openLocations();
    tunnel.pinged.clear();
    app.testedAt = DateTime.now().subtract(const Duration(minutes: 59));
    await app.openLocations();
    expect(tunnel.pinged, isEmpty);
    app.testedAt = DateTime.now().subtract(const Duration(minutes: 61));
    await app.openLocations();
    expect(tunnel.pinged, isNotEmpty);
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(seconds: 10));
    }
  });

  testWidgets('Strong and Weak on the operator need three people', (
    tester,
  ) async {
    final (app, api) = await _boot(tester, {'onboarded': true});
    api
      ..asn = 44244
      ..ispEn = 'Irancell'
      ..rankPeople = 2
      ..rankKbps = 8000;
    await app.refreshNetwork(force: true);
    Exit de() => app.exits.firstWhere((e) => e.server.link.contains('de1'));
    expect(de().verdict, isNull);
    expect(de().speed, isNull);
    api.rankPeople = 3;
    await app.refreshNetwork(force: true);
    expect(de().verdict, Verdict.strong);
    expect(de().speed, Speed.fast, reason: 'others measured it on Irancell');
    api.rankScore = 0.3;
    await app.refreshNetwork(force: true);
    expect(de().verdict, Verdict.weak);

    app.setTab(2);
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.textContaining('On Irancell'), findsOneWidget);
    expect(find.text('Weak on Irancell'), findsWidgets);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets(
    'a tap on a flag tests that exit now, and it is kept and shared',
    (tester) async {
      final tunnel = FakeTunnel()
        ..pings = {'de1.example.com': 60}
        ..speeds = {'de1.example.com': 9000}
        ..onMetered = true;
      final (app, api) = await _boot(tester, {
        'onboarded': true,
      }, tunnel: tunnel);
      app.setTab(2);
      await tester.pump(const Duration(seconds: 40));
      tunnel
        ..pinged.clear()
        ..speedTested.clear();
      api.reports.clear();
      await tester.tap(
        find.byWidgetPredicate(
          (w) => w is Pressable && w.label == 'Test DE 1 now',
        ),
      );
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      Exit de() => app.exits.firstWhere((e) => e.server.link.contains('de1'));
      expect(tunnel.pinged, ['de1.example.com']);
      expect(tunnel.speedTested, [
        'de1.example.com',
      ], reason: 'asked for, so it runs on a metered network too');
      expect(de().measured, 60);
      expect(de().speed, Speed.fast);
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(seconds: 10));
      }
      expect(
        api.reports.where((r) => r['k'] == de().id && r['kbps'] == 9000),
        hasLength(1),
      );
      final next = AppState(
        await SharedPreferences.getInstance(),
        api,
        tunnel: FakeTunnel(),
      );
      await next.loadServers();
      expect(
        next.exits.firstWhere((e) => e.server.link.contains('de1')).measured,
        60,
      );
    },
  );

  testWidgets('a metered network gets at most three download tests per '
      'six hours', (tester) async {
    final tunnel = FakeTunnel()
      ..pings = {'nl1.example.com': 240, 'de1.example.com': 60}
      ..speeds = {'de1.example.com': 9000, 'nl1.example.com': 2000}
      ..onMetered = true;
    final (app, api) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    await app.testSpeeds();
    await tester.pump(const Duration(seconds: 40));
    expect(app.metered, isTrue);
    expect(tunnel.speedTested.toSet(), {'de1.example.com', 'nl1.example.com'});
    expect(
      tunnel.speedTested.length,
      lessThanOrEqualTo(AppState.speedTopMetered),
    );
    final before = tunnel.speedTested.length;
    await app.testSpeeds();
    expect(tunnel.speedTested, hasLength(before), reason: 'budget spent');
    expect(api.reportKinds, isEmpty, reason: 'the fake phone says no kind');
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('results are kept per operator AND Wi-Fi or mobile data', (
    tester,
  ) async {
    final tunnel = FakeTunnel()
      ..kind = 'wifi'
      ..pings = {'nl1.example.com': 240, 'de1.example.com': 60};
    final (app, api) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    api
      ..asn = 44244
      ..ispEn = 'Irancell';
    await app.measureIfDue();
    await tester.pump(const Duration(seconds: 40));
    expect(app.network?.label, 'Irancell Wi-Fi');
    expect(api.rankKinds, contains('wifi'));
    expect(api.reportKinds, contains('wifi'));
    final de = app.exits.firstWhere((e) => e.server.link.contains('de1'));
    expect(de.measured, 60);
    // Same operator on mobile data: its own results, none yet.
    tunnel.kind = 'cell';
    await app.measureIfDue();
    expect(app.network?.label, 'Irancell mobile data');
    expect(api.rankKinds.last, 'cell');
    await tester.pump(const Duration(seconds: 40));
    // Best and Recommended come from the measured exits, best first.
    expect(app.best.first.label, 'DE 1');
    expect(app.recommended.map((e) => e.label), contains('DE 1'));
  });

  testWidgets('the widget gets spare exits; its start is followed', (
    tester,
  ) async {
    final tunnel = FakeTunnel();
    final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    final chosen = app.exits[1];
    await app.connect(chosen.id);
    tunnel.emit(TunnelState.up);
    await tester.pump(PMotion.seal);
    await tester.pump(const Duration(milliseconds: 400));
    expect(app.phase, Phase.protected);
    // Spares for a widget start: other exits, never the one in use.
    expect(tunnel.spareList, isNotEmpty);
    expect(tunnel.spareList.length, lessThanOrEqualTo(3));
    for (final s in tunnel.spareList) {
      expect(s.config, isNot(contains('de1.example.com')));
    }
    // Disconnect from the widget (or the notification).
    tunnel.emit(TunnelState.off);
    await tester.pump(const Duration(milliseconds: 400));
    expect(app.phase, Phase.idle);
    // The widget starts the tunnel with the app in the background.
    final before = tunnel.started;
    tunnel.emit(TunnelState.starting);
    await tester.pump();
    expect(app.phase, Phase.handshaking);
    // Its exits all failed: back to idle; the app doesn't start others.
    tunnel.emit(TunnelState.failed);
    await tester.pump();
    expect(app.phase, Phase.idle);
    expect(tunnel.started, before);
    await tester.pump(const Duration(seconds: 10));
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
    // Home's Now: the exit's address in place of a session clock.
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('IP 185.220.101.42'), findsOneWidget);
    expect(find.text('Through Frankfurt, Germany'), findsOneWidget);
    expect(find.text('DE'), findsWidgets);

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

  testWidgets('the notification shows the exit; its Disconnect is not a drop', (
    tester,
  ) async {
    final tunnel = FakeTunnel();
    final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    final chosen = app.exits[1];
    await app.connect(chosen.id);
    // While connecting: the exit's own country, no IP yet.
    expect(
      tunnel.notes.last,
      '${chosen.flag}|${chosen.title}||${chosen.protocol}',
    );
    tunnel.emit(TunnelState.up);
    await tester.pump(PMotion.seal);
    await tester.pump(const Duration(milliseconds: 400));
    // Once the Worker placed the exit: the same city and IP as Home's Now.
    expect(tunnel.notes.last, contains('|Frankfurt, Germany|185.220.101.42|'));

    tunnel.emit(TunnelState.off);
    await tester.pump(const Duration(milliseconds: 400));
    expect(app.phase, Phase.idle);
    expect(app.tunnelMessage, isNull);
    expect(app.sessions.first.exitId, chosen.id);
    await tester.pump(const Duration(seconds: 10));
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
    // Reports sent close together wait out the Worker's 8 s between them.
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(seconds: 10));
    }
  });

  testWidgets('a picked exit is kept; smart connect does not override it', (
    tester,
  ) async {
    final tunnel = FakeTunnel()
      ..pings = {'nl1.example.com': 240, 'de1.example.com': 60};
    final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    await tester.pump(const Duration(seconds: 40));
    tunnel.pinged.clear(); // the measuring the app does when it opens
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

  testWidgets('sign out makes the home-screen widget forget the last exit', (
    tester,
  ) async {
    final tunnel = FakeTunnel();
    final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    await app.signOut();
    expect(tunnel.forgot, isTrue);
  });

  testWidgets('a full check during a quick run still tests every exit', (
    tester,
  ) async {
    // more exits than the six tested at once, so a quick run leaves some
    FakeApi.extraServers = [
      for (var i = 3; i < 15; i++)
        {
          'index': i,
          'name': 'FI $i',
          'country_code': 'FI',
          'protocol': 'vless',
          'link': 'vless://u@fi$i.example.com:443?type=tcp#x',
        },
    ];
    addTearDown(() => FakeApi.extraServers = []);
    final tunnel = FakeTunnel()
      ..pings = {
        for (var i = 3; i < 15; i++) 'fi$i.example.com': 100,
        'nl1.example.com': 240,
        'de1.example.com': 60,
      };
    final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    for (final e in app.exits) {
      e.measured = null;
    }
    // smart connect's quick run is going when the Connection check starts
    final quick = app.testAll(enough: 1);
    final full = app.testAll();
    await Future.wait([quick, full]);
    expect(app.exits, isNotEmpty);
    expect(app.exits.where((e) => e.measured == null), isEmpty);
    await tester.pump(const Duration(seconds: 40));
  });

  testWidgets('one exit alone with its core log, for support', (tester) async {
    final tunnel = FakeTunnel()..pings = {'de1.example.com': 60};
    final (app, _) = await _boot(tester, {'onboarded': true}, tunnel: tunnel);
    final de = app.exits.firstWhere((e) => e.server.link.contains('de1'));
    final us = app.exits.firstWhere((e) => e.server.link.contains('us1'));
    final ok = (await app.traceExit(de.id))!;
    expect(ok, contains('Result: OK 60 ms'));
    expect(ok, contains('[Info] core log line'));
    final fail = (await app.traceExit(us.id))!;
    expect(fail, contains('Result: FAIL'));
    expect(fail, contains('Link: trojan name:443'));
    expect(fail, isNot(contains('example.com')));
    await tester.pump(const Duration(seconds: 10));
  });

  testWidgets('Profile: the version is a footer, not a card at the top', (
    tester,
  ) async {
    await _boot(tester, {'onboarded': true}, tunnel: FakeTunnel());
    await tester.tap(find.textContaining(', Ali'));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('App version'), findsNothing);
    await tester.scrollUntilVisible(
      find.text('CHECK FOR UPDATES'),
      300,
      scrollable: find
          .descendant(
            of: find.byType(ProfileScreen),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(find.text('CHECK FOR UPDATES'), findsOneWidget);
  });

  testWidgets('Profile: the name opens it; Telegram, Gmail, rings, packages', (
    tester,
  ) async {
    final (app, api) = await _boot(tester, {
      'onboarded': true,
    }, tunnel: FakeTunnel());
    // the greeting (name) opens Profile, like the picture
    await tester.tap(find.textContaining(', Ali'));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.byType(ProfileScreen), findsOneWidget);
    expect(api.calls, contains('GET /me/packages'));
    expect(find.text('Verify your Telegram'), findsOneWidget);
    expect(find.text('ali@example.com'), findsWidgets);
    expect(find.text('Packages'), findsNothing); // not on the profile any more
    // one compact line on the profile: 50 GB in the fake = 46.6 GiB,
    // 41 GB used -> 8.4 GiB left
    expect(find.text('8.4 GB left  ·  12 days left'), findsOneWidget);
    expect(find.text('12 of 30'), findsNothing);
    // tapping it slides the pleats and dots up in a sheet
    await tester.tap(find.text('Data and days'));
    for (var i = 0; i < 25; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('8.4 GB'), findsOneWidget);
    expect(find.text('12 of 30'), findsOneWidget);
    // packages live in the sheet too, under data and days
    await tester.dragUntilVisible(
      find.text('Free trial  ·  5.0 GB'),
      find.byType(SingleChildScrollView).last,
      const Offset(0, -200),
    );
    expect(find.text('Free trial  ·  5.0 GB'), findsOneWidget);
    expect(
      find.textContaining('Bought Nov 22  ·  Activated Nov 22, 2026'),
      findsOneWidget,
    );
    expect(find.text('RUNNING'), findsOneWidget);
    await tester.tapAt(const Offset(20, 20)); // outside the sheet closes it
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('12 of 30'), findsNothing);

    // verify Telegram with the bot's code
    await tester.scrollUntilVisible(find.text('VERIFY'), -200);
    await tester.tap(find.text('VERIFY'));
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('Verify your Telegram'), findsOneWidget);
    // six digits verify on their own; the boxes turn green, then Continue
    await tester.enterText(find.byType(TextField), '123456');
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('Verified'), findsOneWidget);
    await tester.tap(find.text('CONTINUE'));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(app.me.value!.telegramVerified, isTrue);
    expect(find.byType(ProfileScreen), findsOneWidget);
    await tester.scrollUntilVisible(find.text('VERIFIED'), -200);
    expect(find.text('VERIFIED'), findsOneWidget);
    expect(find.text('Telegram  @ali_vpn'), findsOneWidget);
    expect(find.text('Backup login · optional'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('Sign in: login and password on one sheet; Create account tab', (
    tester,
  ) async {
    await _boot(tester, {'onboarded': true}, signedIn: false);
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.text('Welcome back'), findsOneWidget);
    expect(find.text('Telegram'), findsOneWidget);
    expect(find.text('Gmail'), findsOneWidget);
    // Create account: the two passwords must match
    await tester.tap(find.text('Create account'));
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('Join Pleat'), findsOneWidget);
    await tester.enterText(find.byType(TextField).at(0), 'ali@example.com');
    await tester.enterText(find.byType(TextField).at(1), 'password1');
    await tester.enterText(find.byType(TextField).at(2), 'password2');
    await tester.tap(find.text('CREATE ACCOUNT'));
    await tester.pump();
    expect(find.text('The two passwords don’t match.'), findsOneWidget);
    // back to Sign in: wrong password, then the right one
    await tester.tap(find.text('Sign in'));
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    await tester.enterText(find.byType(TextField).at(0), 'ali@example.com');
    await tester.enterText(find.byType(TextField).at(1), 'password0');
    await tester.tap(find.text('SIGN IN'));
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('Email or password is wrong.'), findsOneWidget);
    await tester.enterText(find.byType(TextField).at(1), 'password1');
    await tester.tap(find.text('SIGN IN'));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.byType(Shell), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('Sign in: no connection is not a wrong password', (tester) async {
    final (_, api) = await _boot(tester, {'onboarded': true}, signedIn: false);
    api.loginOffline = true;
    await tester.enterText(find.byType(TextField).at(0), 'ali@example.com');
    await tester.enterText(find.byType(TextField).at(1), 'password1');
    await tester.tap(find.text('SIGN IN'));
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('No connection to Pleat'), findsOneWidget);
    expect(find.textContaining('wasn’t checked'), findsOneWidget);
    expect(find.text('Email or password is wrong.'), findsNothing);
    // the line is back: Try again signs in with what was typed
    api.loginOffline = false;
    await tester.tap(find.text('TRY AGAIN'));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.byType(Shell), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('Profile: change the Pleat character', (tester) async {
    final (app, api) = await _boot(tester, {
      'onboarded': true,
    }, tunnel: FakeTunnel());
    await tester.tap(find.textContaining(', Ali'));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    await tester.tap(
      find.descendant(
        of: find.byType(ProfileScreen),
        matching: find.byType(Avatar),
      ),
    );
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    final inGrid = find.descendant(
      of: find.byType(AvatarGrid),
      matching: find.byType(AvatarArt),
    );
    expect(inGrid, findsNWidgets(pleatAvatars.length));
    // no way back to a Telegram photo or the initial
    expect(find.text('USE MY TELEGRAM PHOTO'), findsNothing);
    expect(find.text('USE MY INITIAL'), findsNothing);
    await tester.tap(
      find.descendant(
        of: find.byType(AvatarGrid),
        matching: find.byWidgetPredicate(
          (w) => w is AvatarArt && w.avatar.id == 'luna',
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('USE LUNA'));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(api.calls, contains('POST /me/avatar'));
    expect(app.avatarId, 'luna');
    expect(find.text('Avatar saved.'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('first sign-in: an avatar must be picked before Home', (
    tester,
  ) async {
    final (app, api) = await _boot(tester, {'onboarded': true}, avatar: null);
    // the gate stands in for the app: no tabs, no way past it
    expect(find.byType(AvatarGate), findsOneWidget);
    expect(find.byType(HomeScreen), findsNothing);
    expect(find.text('CHOOSE AN AVATAR'), findsOneWidget);
    expect(find.text('Pick your avatar'), findsOneWidget);
    await tester.tap(find.text('CHOOSE AN AVATAR'));
    await tester.pump(const Duration(milliseconds: 200));
    expect(api.calls, isNot(contains('POST /me/avatar')));
    await tester.tap(
      find.byWidgetPredicate((w) => w is AvatarArt && w.avatar.id == 'kai'),
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('CONTINUE AS KAI'));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(api.calls, contains('POST /me/avatar'));
    expect(app.avatarId, 'kai');
    expect(find.byType(AvatarGate), findsNothing);
    expect(find.byType(HomeScreen), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('a long email fits one line on a small phone, domain kept', (
    tester,
  ) async {
    PType.familyOverride = 'PleatTest';
    const long = 'mohammadreza.hosseini.tehran1990@gmail.com';
    Widget at(double w, String text) => MaterialApp(
      home: Center(
        child: SizedBox(
          width: w,
          child: FitLine(text, style: PType.h3()),
        ),
      ),
    );
    await tester.pumpWidget(at(160, long));
    final shown = tester.widget<Text>(find.byType(Text)).data!;
    expect(shown, contains('…'));
    expect(shown, endsWith('@gmail.com'));
    expect(shown, startsWith('mo'));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(at(360, 'ali@gmail.com'));
    expect(find.text('ali@gmail.com'), findsOneWidget);
  });
}
