import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/countries.dart';
import 'package:pleat/api/models.dart';

void main() {
  test('server key matches the Cloud Gold app and the Worker stats', () {
    // test/dev_server.mjs seeds net_geo with fnv('vless|de1.example.com|443').
    final e = endpointOf('vless://uuid@de1.example.com:443?security=tls#x')!;
    expect(serverKey(e), 'k53ca1f60');
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
}
