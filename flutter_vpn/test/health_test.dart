import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/state/app_state.dart';
import 'package:pleat/state/health.dart';
import 'package:pleat/state/tunnel.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

const _uuid = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';

void main() {
  group('scrub', () {
    test('takes out links, UUIDs, addresses, hosts, e-mails and keys', () {
      final s = scrubText(
        'dial tcp 203.0.113.9:443: i/o timeout via de1.secret-host.example.net '
        'vless://$_uuid@de1.secret-host.example.net:443?pbk=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 '
        'uuid $_uuid ip [2001:db8::1] mail a@b.co key AbCdEfGhIjKlMnOpQrStUvWxYz012345',
        400,
      );
      for (final secret in [
        _uuid,
        'secret-host',
        '203.0.113.9',
        '2001:db8',
        'vless:',
        'AbCdEfGhIjKl',
        'a@b.co',
      ]) {
        expect(s, isNot(contains(secret)), reason: s);
      }
      expect(s, contains('i/o timeout'));
      expect(s, contains('<host>'));
      expect(s, contains('<ip>'));
    });

    test('keeps words, times, code and file names', () {
      expect(
        scrubText(
          'at 12:30:45 app.pleat.pleat.PleatVpnService.begin xray_config.dart',
        ),
        'at 12:30:45 app.pleat.pleat.PleatVpnService.begin xray_config.dart',
      );
      expect(
        scrubText('lookup de1.example.com on 8.8.8.8:53: no such host'),
        'lookup <host> on <ip>:53: no such host',
      );
    });

    test('protocol of a link without its address', () {
      expect(
        protoOf(
          'vless://$_uuid@h.example.com:443?security=reality&type=tcp#DE',
        ),
        'vless/reality/tcp',
      );
      expect(protoOf('trojan://pass@h.example.com:443#US'), 'trojan');
      expect(protoOf('nonsense'), '');
    });

    test('an exit and its backups: protocols only', () {
      expect(
        exitProtos(
          'vless://$_uuid@h.example.com:443?security=reality&type=tcp#DE',
          ['vmess://abc', 'trojan://pass@t.example.com:443?type=ws#US'],
        ),
        'vless/reality/tcp + vmess, trojan/ws',
      );
      expect(exitProtos('trojan://p@h.example.com:443#US', []), 'trojan');
    });

    test('a native crash keeps its library and function names readable, '
        'never an address', () {
      final d = cleanDetail({
        'frames':
            'libc.so abort | libgojni.so runtime.raise.abi0 | '
            'libhev-socks5-tunnel.so hev_socks5_session_tcp_splice_long_name',
        'go':
            'panic: dial tcp 1.2.3.4:443 de3.example.com @ '
            'transport/pipe·(*pipe)·WriteMultiBuffer',
        'abort': 'fdsan: attempted to close file descriptor 87',
      });
      expect(
        d['frames'],
        'libc.so abort | libgojni.so runtime.raise.abi0 | '
        'libhev-socks5-tunnel.so hev_socks5_session_tcp_splice_long_name',
      );
      expect(
        d['go'],
        'panic: dial tcp <ip>:443 <host> @ '
        'transport/pipe·(*pipe)·WriteMultiBuffer',
      );
      expect(d['abort'], 'fdsan: attempted to close file descriptor 87');
      expect(
        scrubCode('libgojni.so x via vless://$_uuid@h.example.com 9.9.9.9'),
        'libgojni.so x via <link> <ip>',
      );
    });

    test('the phone knows the same types and priorities as the Worker', () {
      final js = File('../worker/src/health.js').readAsStringSync();
      final block = RegExp(r'export const TYPES = \{([^}]*)\}')
          .firstMatch(js)![1]!;
      final worker = {
        for (final m in RegExp(r'(\w+): (\d)').allMatches(block))
          m[1]!: int.parse(m[2]!),
      }..removeWhere((k, _) => k == 'loc_mismatch' || k == 'exit_iran');
      expect(healthTypes, worker);
    });
  });

  group('queue', () {
    late DateTime now;
    late HealthLog log;
    late List<Map<String, Object>> sent;
    Map<String, dynamic>? answer;

    Future<Map<String, dynamic>?> send(Map<String, Object> body) async {
      sent.add(body);
      return answer;
    }

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      now = DateTime(2026, 11, 11, 12);
      log = HealthLog(await SharedPreferences.getInstance(), clock: () => now);
      sent = [];
      answer = {'ok': true, 'stored': 1, 'mode': 'all'};
    });

    test('the same problem folds into one entry with a count', () {
      for (var i = 0; i < 3; i++) {
        log.record('connect_fail', k: 'k1a2b3c4d', c: 'timeout', d: {'ms': i});
      }
      log.record('connect_fail', k: 'k1a2b3c4d', c: 'reset');
      log.record('connect_fail', k: 'not a key!', c: 'timeout');
      log.record('made_up');
      expect(log.queued, hasLength(3));
      final first = log.queued.first;
      expect(first.n, 3);
      expect(first.d['ms'], 2);
      expect(log.queued.last.k, '', reason: 'a malformed key is left out');
    });

    test(
      'critical goes at once; high waits 10 minutes; the rest 6 hours',
      () async {
        log.record('battery', c: 'high');
        expect(await log.flush(send), isTrue, reason: 'never sent: due now');
        log.record('battery', c: 'high');
        expect(await log.flush(send), isFalse);
        log.record('connect_fail', k: 'k1a2b3c4d', c: 'timeout');
        now = now.add(const Duration(minutes: 9));
        expect(await log.flush(send), isFalse);
        now = now.add(const Duration(minutes: 2));
        expect(await log.flush(send), isTrue);
        log.record('crash', c: 'native');
        now = now.add(const Duration(seconds: 61));
        expect(await log.flush(send), isTrue);
        expect(sent, hasLength(3));
        expect(log.queued, isEmpty);
        final events = sent.last['events']! as List;
        expect((events.first as Map)['t'], 'crash');
      },
    );

    test(
      'a batch that did not go is kept, and a retry time is respected',
      () async {
        log.meta['app'] = '1.2.35';
        log.record('crash', c: 'native');
        answer = null; // the Worker could not be reached
        expect(await log.flush(send), isFalse);
        expect(log.queued, hasLength(1));
        answer = {'ok': false, 'retry': 600};
        now = now.add(const Duration(minutes: 3));
        expect(await log.flush(send), isFalse);
        log.record('crash', c: 'native');
        expect(log.queued.single.n, 2, reason: 'kept and merged');
        now = now.add(const Duration(minutes: 5));
        expect(
          await log.flush(send),
          isFalse,
          reason: 'retry time not reached',
        );
        answer = {'ok': true, 'mode': 'all'};
        now = now.add(const Duration(minutes: 6));
        expect(await log.flush(send), isTrue);
        expect(sent.last['app'], '1.2.35');
        expect(log.queued, isEmpty);
      },
    );

    test(
      'the Worker can turn reports down; the daily summary still goes',
      () async {
        log.record('crash', c: 'java');
        answer = {'ok': true, 'mode': 'p2'};
        await log.flush(send);
        expect(log.mode, 'p2');
        log.record('battery', c: 'high');
        log.record('drop', k: 'k1a2b3c4d', c: 'tunnel');
        expect(log.queued.map((e) => e.t), ['drop']);
        answer = {'ok': true, 'mode': 'off'};
        now = now.add(const Duration(minutes: 11));
        await log.flush(send);
        log.record('crash', c: 'java');
        expect(log.queued, isEmpty);
        log.count(proto: 'vless/reality/tcp', ok: true, minutes: 30);
        now = now.add(const Duration(days: 1));
        expect(log.dueIn, isNotNull);
        expect(log.queued.single.t, 'daily');
      },
    );

    test('a day of connects becomes one daily summary', () {
      log.count(proto: 'vless/reality/tcp', ok: true);
      log.count(proto: 'vless/reality/tcp', ok: true, minutes: 40);
      log.count(proto: 'trojan', ok: false);
      log.count(drain: 4.5);
      expect(log.dueIn, isNull);
      now = now.add(const Duration(days: 1));
      log.dueIn;
      final d = log.queued.single;
      expect(d.t, 'daily');
      expect(d.d['sessions'], 2);
      expect(d.d['minutes'], 40);
      expect(d.d['ok'], 'vless/reality/tcp 2');
      expect(d.d['fail'], 'trojan 1');
      expect(d.d['rate'], 4.5);
    });

    test('off in Profile: nothing kept, the queue is emptied', () {
      log.record('crash', c: 'java');
      log.setEnabled(false);
      expect(log.queued, isEmpty);
      log.record('crash', c: 'java');
      log.count(ok: true);
      expect(log.queued, isEmpty);
      expect(log.dueIn, isNull);
    });

    test('at most 200 waiting; the least important go first', () {
      log.record('crash', c: 'native');
      for (var i = 0; i < 210; i++) {
        log.record('app_error', c: 'e$i');
      }
      expect(log.queued, hasLength(HealthLog.maxEvents));
      expect(log.queued.any((e) => e.t == 'crash'), isTrue);
    });

    test('a batch carries at most 20, critical first', () async {
      for (var i = 0; i < 25; i++) {
        log.record('app_error', c: 'e$i');
      }
      log.record('no_exit', c: 'auto');
      await log.flush(send);
      final events = sent.single['events']! as List;
      expect(events, hasLength(20));
      expect((events.first as Map)['t'], 'no_exit');
      expect(log.queued, hasLength(6));
    });

    test('the queue survives a restart', () async {
      log.record('crash', c: 'native', d: {'trace': 'x'});
      final again = HealthLog(
        await SharedPreferences.getInstance(),
        clock: () => now,
      );
      expect(again.queued.single.t, 'crash');
      expect(again.queued.single.d['trace'], 'x');
    });

    test('nothing secret is ever queued', () {
      log.record(
        'connect_fail',
        k: 'k1a2b3c4d',
        c: 'timeout',
        d: {
          'err': 'vless://$_uuid@h.example.com:443 203.0.113.9',
          'tried': [
            {'k': 'k1a2b3c4d', 'c': 'h.example.com'},
          ],
        },
      );
      final j = jsonEncode(log.queued.single.toJson());
      expect(j, isNot(contains(_uuid)));
      expect(j, isNot(contains('h.example.com')));
      expect(j, isNot(contains('203.0.113.9')));
    });
  });

  group('the app', () {
    Future<(AppState, FakeApi, FakeTunnel)> boot(
      WidgetTester tester, {
      Map<String, Object> prefs = const {'onboarded': true},
    }) async {
      SharedPreferences.setMockInitialValues(prefs);
      final api = FakeApi(MemoryTokens(signedIn: true));
      final tunnel = FakeTunnel()
        ..pings = {'nl1.example.com': 240, 'de1.example.com': 60};
      final app = AppState(
        await SharedPreferences.getInstance(),
        api,
        tunnel: tunnel,
      );
      await app.refreshAccount();
      return (app, api, tunnel);
    }

    List<Map> events(FakeApi api) => [
      for (final b in api.healthBodies)
        for (final e in (b['events'] as List? ?? const [])) e as Map,
    ];

    testWidgets('a failed exit is reported with its cause, then the one '
        'that worked counts', (tester) async {
      final (app, api, tunnel) = await boot(tester);
      api.rankReports = 4;
      tunnel.startReason = 'context deadline exceeded via <host>';
      await app.connect();
      expect(app.phase, Phase.handshaking);
      tunnel.emit(TunnelState.failed);
      await tester.pump(const Duration(milliseconds: 50));
      tunnel.emit(TunnelState.up);
      await tester.pump(const Duration(seconds: 1));
      final queued = app.health.queued.map((e) => e.toJson()).toList();
      final all = [...events(api), ...queued];
      final fail = all.firstWhere((e) => e['t'] == 'connect_fail');
      expect(fail['k'], isNotEmpty);
      expect((fail['d'] as Map)['err'], 'context deadline exceeded via <host>');
      expect((fail['d'] as Map)['proto'], isNotEmpty);
      expect(jsonEncode(all), isNot(contains('example.com')));
      expect(app.phase, Phase.protected);
      await app.disconnect();
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(seconds: 10));
      }
    });

    testWidgets('a crash Android noted reaches the Worker on the next launch', (
      tester,
    ) async {
      final (app, api, tunnel) = await boot(tester);
      tunnel.native = {
        'exits': [
          {
            't': 'crash',
            'c': 'native',
            'd': {'tunnel': true, 'reason': 5, 'what': 'signal 6'},
          },
        ],
        'battery': [
          {'rate': 9.5, 'drop': 10, 'min': 63, 'off': 90, 'opt': true},
          {'rate': 2.0, 'drop': 2, 'min': 60, 'off': 95, 'opt': false},
        ],
      };
      await app.resumeTunnel();
      await tester.pump(const Duration(seconds: 1));
      final all = events(api);
      expect(all.map((e) => e['t']), containsAll(['crash', 'battery']));
      expect(
        all.where((e) => e['t'] == 'battery'),
        hasLength(1),
        reason: 'only the heavy session',
      );
      expect(api.healthBodies.first['model'], isNotNull);
    });

    testWidgets('a native crash is filed under the exit the tunnel noted, '
        'with what the crash said', (tester) async {
      final (app, api, tunnel) = await boot(tester);
      // the tunnel tells the service which exit it carries, by its key only
      await app.connect();
      final pleat = (jsonDecode(tunnel.started!) as Map)['pleat'] as Map;
      final exit = pleat['exit'] as Map;
      expect(exit['k'], app.exitId);
      expect(exit['p'], isNotEmpty);
      expect(jsonEncode(pleat), isNot(contains('example.com')));
      tunnel.emit(TunnelState.up);
      await tester.pump(const Duration(seconds: 1));
      tunnel.native = {
        'exits': [
          {
            't': 'crash',
            'c': 'native',
            'd': {
              'reason': 5,
              'status': 6,
              'sig': 'SIGABRT',
              'go': 'panic: send on closed channel @ transport/pipe·Write',
              'lib': 'libgojni.so',
              'frames': 'libc.so abort | libgojni.so runtime.raise.abi0',
              'tunnel': true,
              'op': 'up',
              'up_s': 812,
              'proto': 'vless/reality/tcp',
              'k': 'abc123def4',
            },
          },
          {
            't': 'crash',
            'c': 'native',
            'd': {'reason': 5, 'status': 6, 'tunnel': true, 'earlier': true},
          },
        ],
      };
      await app.resumeTunnel();
      await tester.pump(const Duration(seconds: 1));
      final crashes = [
        ...events(api),
        ...app.health.queued.map((e) => e.toJson()),
      ].where((e) => e['t'] == 'crash').toList();
      final now = crashes.firstWhere((e) => e['k'] == 'abc123def4');
      final d = now['d'] as Map;
      expect(d.containsKey('k'), isFalse, reason: 'the key is the event key');
      expect(d['frames'], 'libc.so abort | libgojni.so runtime.raise.abi0');
      expect(d['go'], startsWith('panic: send on closed channel'));
      expect(d['up_s'], 812);
      // an older crash read again names no exit: the one picked now may not be it
      final earlier = crashes.firstWhere(
        (e) => (e['d'] as Map)['earlier'] == true,
      );
      expect(earlier['k'], isNull);
      await app.disconnect();
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(seconds: 10));
      }
    });

    testWidgets('Send diagnostics off: nothing is sent and the exit country '
        'is not reported', (tester) async {
      final (app, api, tunnel) = await boot(tester);
      app.setSendDiagnostics(false);
      tunnel.native = {
        'exits': [
          {'t': 'crash', 'c': 'java', 'd': <String, Object>{}},
        ],
      };
      await app.resumeTunnel();
      await tester.pump(const Duration(seconds: 1));
      expect(api.healthBodies, isEmpty);
      expect(await app.sendTestReport(), isFalse);
      expect(api.healthBodies, isEmpty);
    });
  });
}
