import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/client.dart';
import 'package:pleat/state/bridge.dart';

import 'fakes.dart';

/// A Worker stand-in; [hits] counts paths, [auth] the proxy logins seen
/// when it is asked as a proxy (absolute request targets).
class FakeEnd {
  late HttpServer server;
  final hits = <String>[];
  final auth = <String?>[];
  final String name;
  FakeEnd(this.name);

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      hits.add(req.uri.path);
      auth.add(req.headers.value('proxy-authorization'));
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode({'via': name}));
      await req.response.close();
    });
  }

  String get url => 'http://127.0.0.1:${server.port}';
  int get port => server.port;
  Future<void> stop() => server.close(force: true);
}

/// A port nothing listens on: connections are refused at once.
Future<String> deadUrl() async {
  final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = s.port;
  await s.close();
  return 'http://127.0.0.1:$port';
}

class FakeDetours implements Detours {
  @override
  String? tunnel;
  @override
  String? bridge;
  String? bridgeOffer;
  int opened = 0, usedCount = 0;

  @override
  Future<String?> openBridge(
    List<String> hosts,
    Future<bool> Function(String proxy) works,
  ) async {
    opened++;
    final p = bridgeOffer;
    if (p == null || !await works(p)) return null;
    bridge = p;
    return p;
  }

  @override
  void used() => usedCount++;
}

void main() {
  late FakeEnd a, b, proxy;
  setUp(() async {
    a = FakeEnd('a');
    b = FakeEnd('b');
    proxy = FakeEnd('proxy');
    await a.start();
    await b.start();
    await proxy.start();
  });
  tearDown(() async {
    await a.stop();
    await b.stop();
    await proxy.stop();
  });

  test('a dead first address: the next one answers and is kept', () async {
    final dead = await deadUrl();
    final c = ApiClient(MemoryTokens(), bases: '$dead,${a.url}');
    expect(await c.get('/plans'), {'via': 'a'});
    expect(await c.get('/me'), {'via': 'a'});
    // One race, then the kept way: /health once.
    expect(a.hits.where((p) => p == '/health'), hasLength(1));
    expect(a.hits.where((p) => p.startsWith('/api/v1/')), hasLength(2));
  });

  test('a POST goes only the way that answered /health', () async {
    final dead = await deadUrl();
    final c = ApiClient(MemoryTokens(), bases: '$dead,${a.url}');
    await c.post('/orders', {});
    expect(a.hits, ['/health', '/api/v1/orders']);
  });

  test(
    'while the tunnel is up, calls cross its API port with the login',
    () async {
      final c = ApiClient(MemoryTokens(), bases: a.url)
        ..detours = (FakeDetours()..tunnel = 'u1:p1@127.0.0.1:${proxy.port}');
      expect(await c.get('/me'), {'via': 'proxy'});
      expect(a.hits, isEmpty);
      final basic = 'Basic ${base64Encode(utf8.encode('u1:p1'))}';
      expect(proxy.auth, everyElement(basic));
    },
  );

  test('/net/ calls never take the tunnel: the carrier must be real', () async {
    final c = ApiClient(MemoryTokens(), bases: a.url)
      ..detours = (FakeDetours()..tunnel = 'u1:p1@127.0.0.1:${proxy.port}');
    expect(await c.get('/net/rank'), {'via': 'a'});
    expect(proxy.hits, isEmpty);
  });

  test('a dead tunnel port falls back to the open line', () async {
    final dead = Uri.parse(await deadUrl()).port;
    final c = ApiClient(MemoryTokens(), bases: a.url)
      ..detours = (FakeDetours()..tunnel = 'u:p@127.0.0.1:$dead');
    expect(await c.get('/me'), {'via': 'a'});
  });

  test('nothing answers on the open line: the bridge is opened', () async {
    final dead = await deadUrl();
    final d = FakeDetours()..bridgeOffer = 'u:p@127.0.0.1:${proxy.port}';
    final c = ApiClient(MemoryTokens(), bases: dead)..detours = d;
    expect(await c.get('/plans'), {'via': 'proxy'});
    expect(d.opened, 1);
    // Kept: the next call goes the bridge way without a new race.
    expect(await c.get('/me'), {'via': 'proxy'});
    expect(d.opened, 1);
    expect(d.usedCount, greaterThan(0));
  });

  test('the plan check before connecting never waits on the bridge', () async {
    final dead = await deadUrl();
    final d = FakeDetours()..bridgeOffer = 'u:p@127.0.0.1:${proxy.port}';
    final c = ApiClient(MemoryTokens(), bases: dead)..detours = d;
    await expectLater(
      c.get('/vpn', bridge: false),
      throwsA(isA<ApiError>().having((e) => e.status, 'status', 0)),
    );
    expect(d.opened, 0);
  });

  test('no way at all: one plain offline error', () async {
    final dead = await deadUrl();
    final c = ApiClient(MemoryTokens(), bases: '$dead,$dead/x')
      ..detours = FakeDetours();
    await expectLater(
      c.get('/plans'),
      throwsA(isA<ApiError>().having((e) => e.code, 'code', 'offline')),
    );
  });

  test('addresses the Worker names are learned, build ones first', () {
    final c = ApiClient(MemoryTokens(), bases: 'https://a.org')
      ..learnBases(['https://b.org/', 'https://a.org', 'ftp://c.org']);
    expect(c.bases, ['https://a.org', 'https://b.org']);
    expect(c.hosts, ['a.org', 'b.org']);
  });

  group('AppDetours', () {
    test('tries links in order and keeps the first that works', () async {
      final t = BridgeTunnel();
      final d = AppDetours(
        native: t,
        login: (user: 'u', pass: 'p'),
        tunnelUp: () => false,
        candidates: () => [
          'not a link',
          'trojan://p@one.example.com:443#1',
          'trojan://p@two.example.com:443#2',
        ],
      );
      var asked = 0;
      final proxy = await d.openBridge(['api.example.org'], (_) async {
        asked++;
        return asked == 2;
      });
      expect(proxy, 'u:p@127.0.0.1:10810');
      expect(t.bridged, hasLength(2));
      expect(t.bridged.last, contains('two.example.com'));
      expect(d.bridge, proxy);
      await d.close();
      expect(d.bridge, isNull);
      expect(t.stops, 1);
    });

    test('none works: stopped, and not retried for a while', () async {
      final t = BridgeTunnel();
      final d = AppDetours(
        native: t,
        login: (user: 'u', pass: 'p'),
        tunnelUp: () => false,
        candidates: () => [
          for (var i = 0; i < 9; i++) 'trojan://p@h$i.example.com:443#x',
        ],
      );
      expect(await d.openBridge(['a.org'], (_) async => false), isNull);
      expect(t.bridged, hasLength(AppDetours.maxTries));
      expect(t.stops, 1);
      expect(await d.openBridge(['a.org'], (_) async => true), isNull);
      expect(t.bridged, hasLength(AppDetours.maxTries));
    });

    test('the tunnel up: its port, never the bridge', () async {
      final t = BridgeTunnel();
      final d = AppDetours(
        native: t,
        login: (user: 'u', pass: 'p'),
        tunnelUp: () => true,
        candidates: () => ['trojan://p@one.example.com:443#1'],
      );
      expect(d.tunnel, 'u:p@127.0.0.1:10809');
      expect(await d.openBridge(['a.org'], (_) async => true), isNull);
      expect(t.bridged, isEmpty);
    });
  });
}
