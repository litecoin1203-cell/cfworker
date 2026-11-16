import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/countries.dart';
import 'package:pleat/api/models.dart';

void main() {
  test('server key matches the Worker stats', () {
    // test/dev_server.mjs seeds net_geo with fnv('vless|de1.example.com|443').
    final e = endpointOf('vless://uuid@de1.example.com:443?security=tls#x')!;
    expect(serverKey(e), 'k53ca1f60');
  });

  test('ARC-02: share links read as the Worker reads them '
      '(test/links_golden.json, also checked by worker/test/run.mjs)', () {
    final golden =
        (jsonDecode(File('test/links_golden.json').readAsStringSync())
                as Map)['links']
            as List;
    expect(golden, isNotEmpty);
    for (final g in golden.cast<Map>()) {
      final link = g['link'] as String;
      final e = endpointOf(link);
      expect(e, isNotNull, reason: link);
      expect([e!.type, e.host, e.port], [g['type'], g['host'], g['port']]);
      expect(serverKey(e), g['key'], reason: link);
      if (g['type'] == 'vmess') {
        // UTF-8 remarks ("🇩🇪", Persian names) come out whole
        expect(vmessJson(link)?['ps'], g['remark'], reason: link);
      } else {
        expect(vmessJson(link), isNull);
      }
    }
    expect(vmessJson('vmess://not-base64!'), isNull);
    expect(vmessJson('vmess://${base64.encode(utf8.encode('[1]'))}'), isNull);
  });

  test('country comes from the remark first', () {
    expect(countryFromRemark('🇩🇪 DE 2'), 'DE');
    expect(countryFromRemark('Germany MyPanel'), 'DE');
    expect(countryFromRemark('NL-1'), 'NL');
    expect(countryFromRemark('USA fast'), 'US');
    expect(countryFromRemark('Server 3'), '');
    expect(countryFromHost('us1.example.com'), 'US');
    expect(countryFromHost('203.0.113.9'), '');
    expect(flagOf('JP'), '🇯🇵');
  });

  test('a server never exposes its host through display fields', () {
    final s = Server.fromJson({
      'index': 0,
      'name': 'Server 1',
      'country_code': '',
      'protocol': 'trojan',
      'link': 'trojan://p@fr2.secret-host.net:8443#x',
    });
    expect(s.cc, 'FR');
    for (final shown in [s.name, s.country, s.protocolLabel, s.key]) {
      expect(shown.contains('secret-host'), isFalse);
    }
  });

  test('vmess and shadowsocks endpoints parse', () {
    expect(
      endpointOf(
        'vmess://eyJhZGQiOiJhLmIuYyIsInBvcnQiOiI0NDMiLCJwcyI6IlgifQ==',
      )!.host,
      'a.b.c',
    );
    final ss = endpointOf('ss://YWVzLTI1Ni1nY206cHdA@1.2.3.4:8388#x')!;
    expect((ss.type, ss.host, ss.port), ('shadowsocks', '1.2.3.4', '8388'));
  });

  // UX-03: Pleat is English only; a Persian plan name, badge or description
  // from the server never reaches the screen.
  test('UX-03: plans show the English name, badge and description', () {
    final fa = RegExp(r'[\u0600-\u06FF]');
    final p = PlanInfo.fromJson({
      'id': 1,
      'name': '\u06cc\u06a9 \u0645\u0627\u0647\u0647',
      'name_en': 'Gold',
      'badge': '\u0645\u062d\u0628\u0648\u0628',
      'badge_en': 'Popular',
      'description': '\u0628\u0631\u0627\u06cc \u0647\u0645\u0647',
      'description_en': '',
      'duration_days': 30,
      'data_limit_gb': 50,
    });
    expect((p.name, p.badge, p.description), ('Gold', 'Popular', ''));
    // an older Worker without the English fields
    final old = PlanInfo.fromJson({
      'id': 2,
      'name': '\u06cc\u06a9 \u0633\u0627\u0644\u0647',
      'badge': '\u0645\u062d\u0628\u0648\u0628',
      'description': '\u0628\u0631\u0627\u06cc \u0647\u0645\u0647',
      'duration_days': 365,
      'data_limit_gb': 0,
    });
    expect(
      (old.name, old.badge, old.description),
      ('1 year \u00b7 Unlimited', '', ''),
    );
    final latin = PlanInfo.fromJson({
      'id': 3,
      'name': 'Monthly',
      'badge': 'Best value',
      'duration_days': 30,
    });
    expect((latin.name, latin.badge), ('Monthly', 'Best value'));
    final sub = Subscription.fromJson({
      'plan_name': '\u06cc\u06a9 \u0645\u0627\u0647\u0647',
      'plan_name_en': 'Gold',
    });
    expect(sub.planName, 'Gold');
    expect(
      Subscription.fromJson({
        'plan_name': '\u06cc\u06a9 \u0645\u0627\u0647\u0647',
      }).planName,
      '',
    );
    final pk = Package.fromJson({
      'name': '\u06cc\u06a9 \u0645\u0627\u0647\u0647',
      'source': 'order',
    });
    expect(pk.name, 'Package');
    final o = Order.fromJson({
      'plan_name': '\u06cc\u06a9 \u0645\u0627\u0647\u0647',
      'plan_name_en': 'Gold',
      'activate_plan_name': '\u06cc\u06a9 \u0633\u0627\u0644\u0647',
    });
    expect((o.planName, o.activatePlanName), ('Gold', 'Your plan'));
    // the admin's own Persian announcement is laid out right to left
    expect(
      rtlText('\u0633\u0644\u0627\u0645 \u062f\u0648\u0633\u062a\u0627\u0646'),
      isTrue,
    );
    expect(rtlText('Maintenance tonight'), isFalse);
    for (final s in [p.name, old.name, sub.planName, pk.name, o.planName]) {
      expect(fa.hasMatch(s), isFalse, reason: s);
    }
  });
}
