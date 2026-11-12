import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/models.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/screens/protect.dart';
import 'package:pleat/state/app_state.dart';
import 'package:pleat/state/exits.dart';
import 'package:pleat/state/protect.dart';
import 'package:pleat/state/tunnel.dart';
import 'package:pleat/state/xray_config.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

Exit _exit(int i, String cc, String link) => Exit(
  Server.fromJson({
    'index': i,
    'name': '$cc $i',
    'country_code': cc,
    'protocol': 'vless',
    'link': link,
  }),
  null,
);

final _de1 = _exit(
  1,
  'DE',
  'vless://u@de1.example.com:443?security=tls&type=ws#x',
);
final _de2 = _exit(
  2,
  'DE',
  'vless://u@de2.example.com:443?security=tls&type=ws#x',
);
final _nl = _exit(
  3,
  'NL',
  'vless://u@nl1.example.com:443?security=tls&type=ws#x',
);

const _trojan = 'trojan://pass@us1.example.com:443#x';

Map<String, dynamic> _cfg(String text) =>
    jsonDecode(text) as Map<String, dynamic>;

List<Map<String, dynamic>> _rules(Map<String, dynamic> c) =>
    ((c['routing'] as Map)['rules'] as List).cast<Map<String, dynamic>>();

LeakRow row(LeakReport r, String title) =>
    r.rows.firstWhere((x) => x.title == title);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Shield', () {
    test('resolver by level: Cloudflare plain, security, family', () {
      expect(const Shield().dns, ['1.1.1.1', '1.0.0.1']);
      expect(const Shield(level: 1).dns, ['1.1.1.2', '1.0.0.2']);
      expect(const Shield(level: 2).dns, ['1.1.1.2', '1.0.0.2']);
      expect(const Shield(adult: true).dns, ['1.1.1.3', '1.0.0.3']);
      expect(const Shield().filtersDns, isFalse);
      expect(const Shield(level: 1).filtersDns, isTrue);
    });

    test('off: the config is what it always was', () {
      final c = _cfg(xrayConfig(_trojan, localDirect: true));
      expect(c.containsKey(pleatKey), isFalse);
      expect(
        _rules(c)
            .where((r) => r['outboundTag'] == 'block' && r['domain'] != null),
        isEmpty,
      );
    });

    test('clean + adult: names blocked for apps only, before Iran-direct', () {
      final c = _cfg(
        xrayConfig(
          _trojan,
          localDirect: true,
          shield: const Shield(level: 2, adult: true),
        ),
      );
      expect((c[pleatKey] as Map)['dns'], ['1.1.1.3', '1.0.0.3']);
      final rules = _rules(c);
      final block = rules.indexWhere(
        (r) =>
            (r['domain'] as List?)?.contains('geosite:category-ads-all') ==
            true,
      );
      final direct = rules.indexWhere(
        (r) => (r['domain'] as List?)?.contains('geosite:category-ir') == true,
      );
      expect(block, greaterThan(0));
      expect(block, lessThan(direct));
      expect(rules[block]['inboundTag'], ['socks']);
      expect(rules[block]['outboundTag'], 'block');
      expect(rules[block]['domain'], contains('geosite:category-porn'));
    });

    test('safe: resolver only, no name lists', () {
      final c = _cfg(xrayConfig(_trojan, shield: const Shield(level: 1)));
      expect((c[pleatKey] as Map)['dns'], ['1.1.1.2', '1.0.0.2']);
      expect(
        _rules(c).where(
          (r) =>
              (r['domain'] as List?)?.any(
                (d) => '$d'.startsWith('geosite:category-ads'),
              ) ==
              true,
        ),
        isEmpty,
      );
    });

    test('without the place lists the name rules are left out', () {
      final c = _cfg(
        xrayConfig(
          _trojan,
          shield: const Shield(level: 2, adult: true, lists: false),
        ),
      );
      expect(
        _rules(c).where((r) => '${r['domain']}'.contains('geosite:category')),
        isEmpty,
      );
      expect((c[pleatKey] as Map)['dns'], ['1.1.1.3', '1.0.0.3']);
    });

    test('a test config never carries the Shield', () {
      final c = _cfg(
        xrayConfig(
          _trojan,
          forTest: true,
          shield: const Shield(level: 2, adult: true),
        ),
      );
      expect(c.containsKey(pleatKey), isFalse);
      expect(
        _rules(c).where((r) => '${r['domain']}'.contains('geosite:category')),
        isEmpty,
      );
    });
  });

  group('Google view', () {
    test('from the probe: country, Gemini, the Search wall', () {
      final now = DateTime(2026, 11, 12);
      final de = GoogleView.fromProbe({
        'reached': true,
        'google_cc': 'DE',
        'gemini': true,
        'google_blocked': false,
      }, now)!;
      expect(de.iran, isFalse);
      expect(de.gemini, isTrue);
      final ir = GoogleView.fromProbe({
        'reached': true,
        'google_cc': 'IR',
      }, now)!;
      expect(ir.iran, isTrue);
      expect(ir.gemini, isFalse); // closed to Iran, so it says something
      final unclear = GoogleView.fromProbe({'reached': true}, now)!;
      expect(unclear.cc, isNull);
      expect(unclear.iran, isFalse);
      expect(GoogleView.fromProbe({}, now), isNull);
    });

    test('shared: the majority decides, as the Worker says', () {
      final v = GoogleView.fromShared({
        'status': 'iran',
        'tests': 5,
        'gemini': 0.2,
        'google_cc': 'DE',
        'at': 1762900000,
      })!;
      expect(v.iran, isTrue); // one latest report of DE doesn't win
      expect(v.people, 5);
      expect(GoogleView.fromShared({'status': 'google'}), isNull);
    });

    test('this phone’s fresh test wins, then the shared one', () {
      final now = DateTime(2026, 11, 12, 12);
      final log = GoogleLog();
      final shared = GoogleView(cc: 'DE', at: now, iranVotes: false);
      expect(log.pick('k', shared, now), same(shared));
      final mine = GoogleView(cc: 'IR', at: now, mine: true);
      log.put('k', mine);
      expect(log.pick('k', shared, now)!.iran, isTrue);
      final later = now.add(const Duration(hours: 30));
      expect(log.pick('k', shared, later), same(shared));
      final back = GoogleLog.decode(log.encode());
      expect(back['k']!.cc, 'IR');
    });

    test('Google-clean exits only leaves Iran out, never everything', () async {
      SharedPreferences.setMockInitialValues({});
      final s = AppState(
        await SharedPreferences.getInstance(),
        FakeApi(MemoryTokens(signedIn: true)),
        tunnel: FakeTunnel(),
      );
      s.servers.value = [_de1, _de2, _nl];
      final now = DateTime.now();
      s.googleLog.put(_de1.id, GoogleView(cc: 'IR', at: now, mine: true));
      s.googleLog.put(_nl.id, GoogleView(cc: 'NL', at: now, mine: true));
      expect(s.routePool.length, 3);
      s.setGoogleClean(true);
      expect(s.routePool.map((e) => e.label), ['DE 2', 'NL 3']);
      expect(s.googleCounts, (abroad: 1, iran: 1, unknown: 1));
      // every exit Iranian to Google: the pool stays, nothing to connect is worse
      s.googleLog.put(_de2.id, GoogleView(cc: 'IR', at: now, mine: true));
      s.googleLog.put(_nl.id, GoogleView(cc: 'IR', at: now, mine: true));
      expect(s.routePool.length, 3);
    });
  });

  group('Privacy check', () {
    const ctx = (
      lockdown: true,
      bypassApps: 0,
      dns: '1.1.1.2',
      exitLabel: 'DE 2',
      network: 'Irancell mobile data',
    );
    LeakReport report(Map<String, Object?> raw, [LeakContext c = ctx]) =>
        LeakReport(raw, c, DateTime(2026, 11, 12), const Duration(seconds: 6));

    final clean = <String, Object?>{
      'home_ip': '5.120.33.7',
      'home_cc': 'IR',
      'ip': '91.1.2.3',
      'cc': 'DE',
      'reached': true,
      'google_cc': 'DE',
      'gemini': true,
      'google_blocked': false,
      'ipinfo_cc': 'DE',
      'ipinfo_org': 'AS24940 Hetzner Online GmbH',
      'ipinfo_ip': '91.1.2.3',
      'ipwho_cc': 'DE',
      'dns_seen': '91.1.2.3',
      'dns_ok': true,
      'dns_egress': '172.70.1.1',
      'v6': 'blocked',
      'stun_ip': '91.1.2.3',
      'tz': 'Europe/Berlin',
      'location_on': false,
    };

    test('a clean exit: no warnings, every group there', () {
      final r = report(clean);
      expect(r.groups.map((g) => g.title), [
        'WHAT SITES SEE',
        'DNS',
        'AROUND THE TUNNEL',
        'YOUR PHONE TELLS GOOGLE TOO',
      ]);
      expect(r.warnings, 0);
      expect(r.tests, 16);
      expect(row(r, 'Exit network').value, 'Hetzner Online');
      expect(row(r, 'Your Iran IP').value, 'Hidden');
      expect(row(r, 'WebRTC · STUN (UDP)').value, 'Exit IP');
      expect(r.siteCc, 'DE');
    });

    test('Google sees Iran while sites see Germany', () {
      final r = report({...clean, 'google_cc': 'IR', 'gemini': null});
      expect(row(r, 'Cloudflare').verdict, Mark.ok);
      expect(row(r, 'Google · YouTube').verdict, Mark.warn);
      expect(row(r, 'Google · Gemini').value, 'Closed');
      expect(row(r, 'Google · Gemini').verdict, Mark.warn);
      expect(r.warnings, 2);
    });

    test('the phone’s own address showing anywhere is a leak', () {
      final r = report({
        ...clean,
        'stun_ip': '5.120.33.7',
        'dns_seen': '5.120.33.7',
      });
      expect(row(r, 'Your Iran IP').verdict, Mark.warn);
      expect(row(r, 'WebRTC · STUN (UDP)').value, 'Your IP');
      expect(row(r, 'Resolver that answered').verdict, Mark.warn);
      expect(row(r, 'Operator’s DNS').value, 'Used');
    });

    test('a client subnet of the phone’s own area is a warning', () {
      expect(
        row(
          report({...clean, 'dns_ecs': '5.120.33.0/24'}),
          'Client subnet (ECS)',
        ).verdict,
        Mark.warn,
      );
      expect(
        row(
          report({...clean, 'dns_ecs': '91.1.2.0/24'}),
          'Client subnet (ECS)',
        ).value,
        'Exit’s area',
      );
    });

    test('no answer is not a pass, and kill switch off is a warning', () {
      final r = report({}, (
        lockdown: false,
        bypassApps: 2,
        dns: '1.1.1.1',
        exitLabel: 'NL 1',
        network: '',
      ));
      expect(row(r, 'Cloudflare').verdict, Mark.none);
      expect(row(r, 'Your Iran IP').value, 'Not checked');
      expect(row(r, 'Kill switch').verdict, Mark.warn);
      expect(row(r, 'Apps skipping the VPN').value, '2 apps');
      expect(row(r, 'Apps skipping the VPN').verdict, Mark.note);
      expect(r.warnings, 1);
    });

    test('Tehran time and an Iranian SIM are notes, location on too', () {
      final r = report({
        ...clean,
        'tz': 'Asia/Tehran',
        'sim_cc': 'IR',
        'location_on': true,
      });
      expect(row(r, 'Time zone · SIM').value, 'Tehran · IR');
      expect(row(r, 'Time zone · SIM').verdict, Mark.note);
      expect(row(r, 'Location').verdict, Mark.note);
      expect(r.warnings, 0);
    });

    test('kept and read back', () {
      final r = report(clean);
      final back = LeakReport.fromJson(jsonEncode(r.toJson()))!;
      expect(back.warnings, 0);
      expect(back.ctx.exitLabel, 'DE 2');
      expect(back.took, const Duration(seconds: 6));
    });
  });

  group('on the phone', () {
    Future<(AppState, FakeApi)> boot(
      WidgetTester tester,
      FakeTunnel tunnel,
    ) async {
      PType.familyOverride = 'PleatTest';
      tester.view.physicalSize = const Size(1080, 2340);
      tester.view.devicePixelRatio = 2.75;
      addTearDown(tester.view.reset);
      SharedPreferences.setMockInitialValues({'onboarded': true});
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

    testWidgets('Shield reaches the tunnel; the check and Google tests run', (
      tester,
    ) async {
      final tunnel = FakeTunnel()
        ..pings = {'nl1.example.com': 60}
        ..googleViews['nl1.example.com'] = {
          'reached': true,
          'cc': 'NL',
          'google_cc': 'IR',
          'google_blocked': false,
        };
      final (app, api) = await boot(tester, tunnel);
      await app.setShield(2);
      await app.setBlockAdult(true);
      final nl = app.exits.firstWhere((e) => e.label == 'NL 1');
      await app.connect(nl.id);
      final started = jsonDecode(tunnel.started!) as Map;
      expect(started['pleat']['dns'], ['1.1.1.3', '1.0.0.3']);
      expect(tunnel.started, contains('geosite:category-ads-all'));
      tunnel.emit(TunnelState.up);
      await tester.pump(PMotion.seal);
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      // right after connecting (not metered): the exit's Google view, shared
      expect(tunnel.googleTested, ['nl1.example.com']);
      expect(app.googleOf(nl)!.iran, isTrue);
      expect(api.googleReports.single['k'], nl.id);
      expect(api.googleReports.single['google_cc'], 'IR');
      expect(api.googleReports.single.containsKey('ip'), isFalse);

      tunnel.leakResult = {
        'home_ip': '5.120.33.7',
        'ip': '91.1.2.3',
        'cc': 'NL',
        'reached': true,
        'google_cc': 'NL',
        'gemini': true,
        'google_blocked': false,
        'v6': 'blocked',
      };
      final r = await app.runLeakCheck();
      expect(r, isNotNull);
      expect(app.leakReport!.ctx.dns, '1.1.1.3');
      expect(tunnel.leakConfig, contains('geosite:category-porn'));
      expect(row(r!, 'Cloudflare').verdict, Mark.ok);
      // the check's own Google result now wins for this exit
      expect(app.googleOf(nl)!.iran, isFalse);

      await tester.tap(find.text('Protect'));
      await tester.pump(const Duration(milliseconds: 800));
      expect(find.text('Always protected'), findsOneWidget);
      expect(find.text('Shield'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('Google location'),
        300,
        scrollable: find
            .descendant(
              of: find.byType(ProtectScreen),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(find.text('Privacy check'), findsWidgets);
      expect(find.text('Split tunnel'), findsNothing);
      expect(find.text('Protocol'), findsNothing);
      await app.disconnect();
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(seconds: 10));
      }
    });
  });
}
