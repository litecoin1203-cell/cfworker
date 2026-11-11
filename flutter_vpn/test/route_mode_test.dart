import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/models.dart';
import 'package:pleat/state/app_state.dart';
import 'package:pleat/state/exits.dart';
import 'package:pleat/state/route_mode.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

Exit _exit(int i, String cc, String protocol, String link) => Exit(
  Server.fromJson({
    'index': i,
    'name': '$cc $i',
    'country_code': cc,
    'protocol': protocol,
    'link': link,
  }),
  null,
);

final _list = [
  _exit(
    1,
    'NL',
    'vless',
    'vless://u@nl1.example.com:443?security=reality&pbk=k&sid=1&sni=a.example.com#x',
  ),
  _exit(
    2,
    'DE',
    'vless',
    'vless://u@de1.example.com:443?security=tls&type=xhttp&path=%2Fx#x',
  ),
  _exit(
    3,
    'DE',
    'wireguard',
    'wireguard://k@de2.example.com:51820?publickey=p&address=10.0.0.2%2F32#x',
  ),
  _exit(
    4,
    'TR',
    'hysteria2',
    'hysteria2://p@tr1.example.com:443/?sni=a.example.com#x',
  ),
  _exit(5, 'FI', 'ss', 'ss://YWVzLTI1Ni1nY206cGFzcw@fi1.example.com:8388#x'),
  _exit(6, 'DE', 'trojan', 'trojan://p@de3.example.com:443?security=tls#x'),
  _exit(
    7,
    'NL',
    'vless',
    'vless://u@nl2.example.com:443?security=tls&type=ws#x',
  ),
];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('each exit lands in one family, read from its own link', () {
    expect(
      [for (final e in _list) e.family],
      [
        RouteMode.stealth, // REALITY
        RouteMode.stealth, // XHTTP
        RouteMode.speed, // WireGuard
        RouteMode.speed, // Hysteria2
        RouteMode.classic, // Shadowsocks
        RouteMode.classic, // Trojan TLS
        RouteMode.classic, // VLESS WS
      ],
    );
    expect(wrappingOf(_list[0]), 'VLESS REALITY');
    expect(wrappingOf(_list[1]), 'VLESS XHTTP');
    expect(wrappingOf(_list[2]), 'WireGuard');
    expect(wrappingOf(_list[6]), 'VLESS WS');
  });

  Future<AppState> app() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final s = AppState(
      prefs,
      FakeApi(MemoryTokens(signedIn: true)),
      tunnel: FakeTunnel(),
    );
    s.servers.value = [..._list];
    return s;
  }

  test(
    'smart connect only uses exits of the chosen goal and country',
    () async {
      final s = await app();
      expect(s.routePool.length, _list.length);

      s.setRoute(RouteMode.speed);
      expect(s.routePool.map((e) => e.label), ['DE 3', 'TR 4']);
      expect(s.exit!.family, RouteMode.speed);
      expect(s.pinned, isFalse);

      s.setRoute(RouteMode.speed, country: 'DE');
      expect(s.routePool.map((e) => e.label), ['DE 3']);
      expect(s.exit!.label, 'DE 3');

      // Stealth has no Turkish exit: the country falls back to best anywhere.
      s.setRoute(RouteMode.stealth, country: 'TR');
      expect(s.routeCountry, '');
      expect(s.routePool.map((e) => e.label), ['NL 1', 'DE 2']);
    },
  );

  test('the choice survives a restart', () async {
    final s = await app();
    s.setRoute(RouteMode.classic, country: 'FI');
    final prefs = await SharedPreferences.getInstance();
    final next = AppState(
      prefs,
      FakeApi(MemoryTokens(signedIn: true)),
      tunnel: FakeTunnel(),
    );
    expect(next.routeMode, RouteMode.classic);
    expect(next.routeCountry, 'FI');
  });

  test(
    'only goals on the plan are offered; protocols named per goal',
    () async {
      final s = await app();
      s.servers.value = [_list[0], _list[4]];
      expect(s.routeModes, [
        RouteMode.auto,
        RouteMode.stealth,
        RouteMode.classic,
      ]);
      expect(s.protocolsOf(RouteMode.stealth), 'REALITY');
      expect(s.protocolsOf(RouteMode.auto), 'Any protocol');
    },
  );

  test('a plan without the chosen goal still connects, and says so', () async {
    final s = await app();
    s.setRoute(RouteMode.speed);
    s.servers.value = [_list[0], _list[4]];
    expect(s.routeAvailable, isFalse);
    expect(s.routePool.length, 2);
  });
}
