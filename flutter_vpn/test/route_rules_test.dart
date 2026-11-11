import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/state/app_state.dart';
import 'package:pleat/state/route_mode.dart';
import 'package:pleat/state/route_rules.dart';
import 'package:pleat/state/stats_log.dart';
import 'package:pleat/state/tunnel.dart';
import 'package:pleat/state/xray_config.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

Future<(AppState, FakeApi)> _boot(
  WidgetTester tester, {
  Tunnel? tunnel,
  Map<String, Object> prefs = const {'onboarded': true},
}) async {
  PType.familyOverride = 'PleatTest';
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues(prefs);
  final api = FakeApi(MemoryTokens(signedIn: true))..avatar = 'vesper';
  final state = AppState(
    await SharedPreferences.getInstance(),
    api,
    tunnel: tunnel,
  );
  await state.refreshAccount();
  await tester.pumpWidget(PleatApp(state: state));
  for (var i = 0; i < 30; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  return (state, api);
}

/// Lets the reports the app sends wait out their spacing before the test ends.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.pump(const Duration(seconds: 10));
  }
}

void main() {
  group('Split route', () {
    test('a site is a host name, whatever was pasted', () {
      expect(siteOf('https://www.MyBank.com/login?x=1'), 'mybank.com');
      expect(siteOf('shop.example.ir:8443'), 'shop.example.ir');
      expect(siteOf('*.cdn.example.com'), 'cdn.example.com');
      expect(siteOf('user@mail.example.org'), 'mail.example.org');
      expect(siteOf('localhost'), isNull);
      expect(siteOf('not a site'), isNull);
      expect(siteOf(''), isNull);
      expect(siteOf('1.2.3'), isNull);
    });

    test('Iranian package names are offered first, nothing else', () {
      expect(looksIranian('ir.mci.ecare'), isTrue);
      expect(looksIranian('com.bank.mellat.ir'), isTrue);
      expect(looksIranian('com.digikala.ir.app'), isTrue);
      expect(looksIranian('org.telegram.messenger'), isFalse);
      expect(looksIranian('com.irisapp.music'), isFalse);
    });

    test('own sites go direct; chosen apps ride along for the service', () {
      final c = jsonDecode(
        xrayConfig(
          'vless://u@nl1.example.com:443?type=tcp#x',
          directSites: ['mybank.com'],
          bypassApps: ['ir.mci.ecare'],
        ),
      ) as Map<String, dynamic>;
      final rules = (c['routing'] as Map)['rules'] as List;
      final own = rules.firstWhere(
        (r) => (r['domain'] as List?)?.contains('domain:mybank.com') ?? false,
      );
      expect(own['outboundTag'], 'direct');
      expect((c[pleatKey] as Map)['bypass'], ['ir.mci.ecare']);
      // own sites work without the geo files (Iranian sites off)
      expect(
        rules.any(
          (r) =>
              (r['domain'] as List?)?.contains('geosite:category-ir') ?? false,
        ),
        isFalse,
      );
      // nothing of Pleat's own in a plain config or a test core
      final plain = jsonDecode(
        xrayConfig('vless://u@nl1.example.com:443?type=tcp#x'),
      );
      expect((plain as Map).containsKey(pleatKey), isFalse);
      final probe = jsonDecode(
        xrayConfig(
          'vless://u@nl1.example.com:443?type=tcp#x',
          forTest: true,
          bypassApps: ['ir.mci.ecare'],
        ),
      );
      expect((probe as Map).containsKey(pleatKey), isFalse);
    });
  });

  group('Your networks', () {
    test('a goal picked on a network beats one learned there', () {
      final n = NetRoutes();
      n.note('44244-cell', 'Irancell mobile data', RouteMode.auto, ok: true);
      expect(n['44244-cell']!.mode, RouteMode.auto);
      n.pick('44244-cell', 'Irancell mobile data', RouteMode.stealth);
      n.note('44244-cell', 'Irancell mobile data', RouteMode.speed, ok: true);
      expect(n['44244-cell']!.mode, RouteMode.stealth);
      expect(n['44244-cell']!.ok, 2);
      expect(n['44244-cell']!.tries, 2);
      n.note(
        '44244-cell',
        'Irancell mobile data',
        RouteMode.stealth,
        ok: false,
      );
      expect(n['44244-cell']!.tries, 3);
      final back = NetRoutes.decode(n.encode());
      expect(back['44244-cell']!.mode, RouteMode.stealth);
      expect(back['44244-cell']!.picked, isTrue);
      expect(back['44244-cell']!.ok, 2);
    });

    test('old counts fade and only the latest networks are kept', () {
      final n = NetRoutes();
      for (var i = 0; i < NetRoutes.cap + 1; i++) {
        n.note('a', 'A', RouteMode.auto, ok: i.isEven);
      }
      expect(n['a']!.tries, lessThanOrEqualTo(NetRoutes.cap));
      expect(n['a']!.ok, lessThanOrEqualTo(n['a']!.tries));
      for (var i = 0; i < NetRoutes.keep + 3; i++) {
        n.note('n$i', 'N$i', RouteMode.auto, ok: true);
      }
      final back = NetRoutes.decode(n.encode());
      expect(back.list, hasLength(NetRoutes.keep));
      expect(back['a'], isNull);
    });
  });

  group('Stats', () {
    test('Data pace: daily use from the last reading of each day', () {
      final u = UsageLog();
      final d0 = DateTime(2026, 11, 1, 9);
      u.note(10 * 1000, now: d0);
      u.note(12 * 1000, now: d0.add(const Duration(hours: 5)));
      u.note(15 * 1000, now: d0.add(const Duration(days: 1)));
      // the plan started again: used went down
      u.note(2 * 1000, now: d0.add(const Duration(days: 3)));
      final days = u.daily(4, now: d0.add(const Duration(days: 3)));
      expect([for (final d in days) d.$2], [null, 3000, null, 2000]);
      expect(u.pace(n: 4, now: d0.add(const Duration(days: 3))), 2500);
      final back = UsageLog.decode(u.encode());
      expect(back.daily(4, now: d0.add(const Duration(days: 3))).last.$2, 2000);
    });

    test('Data pace needs two days before it says a pace', () {
      final u = UsageLog()..note(5, now: DateTime(2026, 11, 1));
      expect(u.pace(now: DateTime(2026, 11, 1)), isNull);
    });

    test('Hardest hours and What works here, from connect tries', () {
      final log = ConnectLog();
      final now = DateTime(2026, 11, 11, 23);
      // evenings fail on Stealth less than on Classic; days are fine
      for (var day = 0; day < 6; day++) {
        final base = DateTime(2026, 11, 5 + day);
        for (final h in [10, 14]) {
          log.add(
            'k',
            Try(base.add(Duration(hours: h)), true, RouteMode.classic),
          );
        }
        log.add(
          'k',
          Try(base.add(const Duration(hours: 20)), false, RouteMode.classic),
        );
        log.add(
          'k',
          Try(base.add(const Duration(hours: 21)), true, RouteMode.stealth),
        );
        log.add(
          'k',
          Try(
            base.add(const Duration(hours: 21, minutes: 5)),
            false,
            RouteMode.classic,
          ),
        );
      }
      final w = log.hardestWindow('k', now: now)!;
      expect(w.$1, 20);
      expect(w.$3, greaterThan(0.5));
      final best = log.bestIn('k', w.$1, w.$2, now: now)!;
      expect(best.$1, RouteMode.stealth);
      final grid = log.hardness('k', now: now);
      expect(grid, hasLength(7));
      expect(grid.every((r) => r.length == 24), isTrue);
      // 2026-11-07 is a Saturday: the first row
      expect(grid[0][20], 1.0);
      expect(grid[0][10], 0.0);
      expect(grid[0][3], isNull);
      final fam = log.byFamily('k', now: now);
      expect(fam[RouteMode.stealth], (6, 6));
      final back = ConnectLog.decode(log.encode(now: now));
      expect(back.byFamily('k', now: now), fam);
    });
  });

  group('Stay in one country', () {
    testWidgets('nothing in the country answers: Pleat asks, then moves', (
      tester,
    ) async {
      final tunnel = FakeTunnel()..pings = {'nl1.example.com': 240};
      final (app, api) = await _boot(tester, tunnel: tunnel);
      api.rankReports = 4;
      app.setRoute(RouteMode.auto, country: 'DE');
      app.setStayInCountry(true);
      expect(app.lockActive, isTrue);
      await app.connect();
      // Germany's only exit is tried (again after a fresh list), and fails
      expect(tunnel.started, contains('de1.example.com'));
      tunnel.emit(TunnelState.failed);
      await tester.pump(const Duration(milliseconds: 300));
      expect(tunnel.started, contains('de1.example.com'));
      tunnel.emit(TunnelState.failed);
      await tester.pump(const Duration(milliseconds: 300));
      // no other country was tried on its own
      expect(tunnel.started, isNot(contains('nl1.example.com')));
      expect(app.phase, Phase.idle);
      final ask = app.lockAsk!;
      expect(ask.country, 'DE');
      expect(ask.options.map((o) => o.country), contains('NL'));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('No Germany exit answered'), findsOneWidget);
      await tester.tap(find.text('Netherlands').last);
      await tester.pump(const Duration(milliseconds: 500));
      expect(tunnel.started, contains('nl1.example.com'));
      expect(app.lockAsk, isNull);
      expect(app.consent?.country, 'NL');
      // one exit, one IP: the core gets no backups to hop to
      expect(tunnel.started, isNot(contains('balancers')));
      tunnel.emit(TunnelState.up);
      await tester.pump(PMotion.seal);
      expect(app.phase, Phase.protected);
      await app.disconnect();
      await _settle(tester);
    });

    testWidgets('a goal the country lacks asks too; staying keeps it off', (
      tester,
    ) async {
      final tunnel = FakeTunnel()
        ..pings = {'nl1.example.com': 240, 'de1.example.com': 90};
      final (app, api) = await _boot(tester, tunnel: tunnel);
      api.rankReports = 4;
      app.setRoute(RouteMode.auto, country: 'DE');
      app.setStayInCountry(true);
      // no Stealth exit in Germany: the country is kept, not dropped
      app.setRoute(RouteMode.stealth);
      expect(app.routeCountry, 'DE');
      await app.connect();
      await tester.pump(const Duration(milliseconds: 300));
      expect(tunnel.started, isNull);
      expect(app.lockAsk!.options.first.title, 'Germany, any protocol');
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(find.text('STAY WITH GERMANY'));
      await tester.pump(const Duration(milliseconds: 500));
      expect(app.lockAsk, isNull);
      expect(app.tunnelMessage, contains('Stayed with Germany'));
      expect(tunnel.started, isNull);
      await _settle(tester);
    });

    testWidgets('a hand-picked exit still wins, and Best location unlocks', (
      tester,
    ) async {
      final (app, _) = await _boot(tester, tunnel: FakeTunnel());
      app.setRoute(RouteMode.auto, country: 'DE');
      app.setStayInCountry(true);
      final nl = app.exits.firstWhere((e) => e.label == 'NL 1');
      app.select(nl.id);
      expect(app.lockActive, isFalse);
      app.setRoute(RouteMode.auto, country: '');
      expect(app.stayInCountry, isFalse);
    });
  });

  testWidgets('Your networks: the goal follows the network, the country '
      'stays', (tester) async {
    final tunnel = FakeTunnel()..kind = 'cell';
    final (app, api) = await _boot(tester, tunnel: tunnel);
    api
      ..asn = 44244
      ..ispEn = 'Irancell';
    await app.refreshNetwork(force: true);
    app.setRoute(RouteMode.classic);
    // home Wi-Fi: Auto there
    api
      ..asn = 58224
      ..ispEn = 'TCI';
    tunnel.kind = 'wifi';
    await app.refreshNetwork(force: true);
    app.setRoute(RouteMode.auto);
    expect(app.netRoutes.list, hasLength(2));
    // back on mobile data: Classic again, said on Route
    api
      ..asn = 44244
      ..ispEn = 'Irancell';
    tunnel.kind = 'cell';
    await app.refreshNetwork(force: true);
    expect(app.routeMode, RouteMode.classic);
    expect(app.netRouteNote, contains('Irancell'));
    // switched off: the goal stays put
    app.setRouteByNetwork(false);
    api
      ..asn = 58224
      ..ispEn = 'TCI';
    tunnel.kind = 'wifi';
    await app.refreshNetwork(force: true);
    expect(app.routeMode, RouteMode.classic);
  });

  testWidgets('Split route: own sites and apps reach the tunnel config', (
    tester,
  ) async {
    final tunnel = FakeTunnel()..pings = {'nl1.example.com': 60};
    final (app, _) = await _boot(tester, tunnel: tunnel);
    expect(app.addDirectSite('https://www.MyBank.com/login'), isTrue);
    expect(app.addDirectSite('nope'), isFalse);
    expect(app.directSites, ['mybank.com']);
    app.setBypassApps(['ir.mci.ecare', 'ir.mci.ecare']);
    expect(app.bypassApps, ['ir.mci.ecare']);
    final nl = app.exits.firstWhere((e) => e.label == 'NL 1');
    await app.connect(nl.id);
    expect(tunnel.started, contains('domain:mybank.com'));
    expect(tunnel.started, contains('"pleat":{"bypass":["ir.mci.ecare"]}'));
    // Android's kill switch would cut those apps off: Route says so
    tunnel.guard = (alwaysOn: true, lockdown: true);
    tunnel.emit(TunnelState.up);
    await tester.pump(PMotion.seal);
    await app.readGuard();
    expect(app.bypassBlocked, isTrue);
    await app.disconnect();
    await _settle(tester);
  });

  testWidgets('Route and Stats show the new cards', (tester) async {
    await _boot(tester, tunnel: FakeTunnel());
    await tester.tap(find.text('Route'));
    await tester.pump(const Duration(milliseconds: 800));
    expect(find.text('Stay in one country'), findsWidgets);
    await tester.scrollUntilVisible(
      find.text('Your networks'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Split route'), findsOneWidget);
    expect(find.text('Your networks'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Stats'),
      -300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Stats'));
    await tester.pump(const Duration(milliseconds: 800));
    await tester.scrollUntilVisible(
      find.textContaining('WHAT WORKS'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('DATA PACE'), findsOneWidget);
    expect(find.text('HARDEST HOURS'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
  });
}
