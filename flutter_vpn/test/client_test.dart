import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/client.dart';

import 'fakes.dart';

void main() {
  late HttpServer server;
  late Map<String, String> seen;

  setUp(() async {
    seen = {};
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      req.headers.forEach((k, v) => seen[k] = v.join(','));
      req.response.headers.contentType = ContentType.json;
      if (req.uri.path.endsWith('/auth/login')) {
        req.response.statusCode = 401;
        req.response.write(
          jsonEncode({
            'detail': {'code': 'bad_credentials', 'message': 'رمز اشتباه'},
          }),
        );
      } else if (req.uri.path.endsWith('/fa')) {
        req.response.statusCode = 400;
        req.response.write(
          jsonEncode({
            'detail': {'code': 'new_code', 'message': 'خطای ناشناخته'},
          }),
        );
      } else {
        req.response.write('{}');
      }
      await req.response.close();
    });
  });
  tearDown(() => server.close(force: true));

  ApiClient client() =>
      ApiClient(MemoryTokens(), bases: 'http://127.0.0.1:${server.port}')
        ..deviceModel = 'Samsung SM-A546E';

  test('a wrong password and a dead line are different errors', () async {
    try {
      await client().post('/auth/login', {'login': 'a@b.co', 'password': 'x'});
      fail('expected an error');
    } on ApiError catch (e) {
      expect(e.code, 'bad_credentials');
      expect(e.offline, isFalse);
      expect(e.message, 'Login or password is wrong.');
    }
    // nothing listens on this port: the Worker is never reached
    final dead = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = dead.port;
    await dead.close();
    try {
      await ApiClient(
        MemoryTokens(),
        bases: 'http://127.0.0.1:$port',
      ).post('/auth/login', {'login': 'a@b.co', 'password': 'x'});
      fail('expected an error');
    } on ApiError catch (e) {
      expect(e.offline, isTrue);
      expect(e.code, isNot('bad_credentials'));
    }
  });

  test('every call carries the HWID the panel limits phones by', () async {
    await client().get('/plans');
    expect(seen['x-hwid'], 'd' * 32);
    expect(seen['x-device-id'], 'd' * 32);
    expect(seen['x-device-model'], 'Samsung SM-A546E');
    expect(seen['x-app-version'], startsWith('1.9.0'));
  });

  test('Persian server text never reaches the English app', () async {
    try {
      await client().get('/fa');
      fail('expected an error');
    } on ApiError catch (e) {
      expect(e.code, 'new_code');
      expect(e.message, isNot(matches(RegExp(r'[؀-ۿ]'))));
    }
  });

  test(
    'a dropped connection is tried once more for a GET, never a POST',
    () async {
      final raw = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      var hits = 0;
      raw.listen((sock) async {
        hits++;
        if (hits.isOdd) {
          // Drop it before any answer, as a cut mobile connection does.
          await sock.close();
          sock.destroy();
          return;
        }
        sock.listen((_) {
          sock.write(
            'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n'
            'content-length: 2\r\nconnection: close\r\n\r\n{}',
          );
          sock.close();
        });
      });
      addTearDown(raw.close);
      final c = ApiClient(
        MemoryTokens(),
        bases: 'http://127.0.0.1:${raw.port}',
      );
      expect(await c.get('/plans'), isA<Map>());
      expect(hits, 2);
      await expectLater(
        c.post('/orders', {}),
        throwsA(isA<ApiError>().having((e) => e.status, 'status', 0)),
      );
      expect(hits, 3);
    },
  );

  group('an expired session and a refresh that cannot get through', () {
    late HttpServer srv;
    late int refreshStatus;
    setUp(() async {
      srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      srv.listen((req) async {
        req.response.headers.contentType = ContentType.json;
        if (req.uri.path.endsWith('/auth/refresh') && refreshStatus == 0) {
          // The line drops the refresh call, as a filtered network does.
          (await req.response.detachSocket(writeHeaders: false)).destroy();
          return;
        }
        if (req.uri.path.endsWith('/auth/refresh')) {
          req.response.statusCode = refreshStatus;
          req.response.write(
            refreshStatus == 200
                ? jsonEncode({'access_token': 'A2', 'refresh_token': 'R2'})
                : '{}',
          );
        } else if (req.headers.value('authorization') == 'Bearer A2') {
          req.response.write('{}');
        } else {
          req.response.statusCode = 401;
          req.response.write('{}');
        }
        await req.response.close();
      });
    });
    tearDown(() => srv.close(force: true));

    (ApiClient, MemoryTokens, List<bool>) signedIn() {
      final tokens = MemoryTokens(signedIn: true);
      final out = <bool>[];
      final c = ApiClient(tokens, bases: 'http://127.0.0.1:${srv.port}')
        ..onSignedOut = () => out.add(true);
      return (c, tokens, out);
    }

    test('a server error on refresh keeps the user signed in', () async {
      refreshStatus = 503;
      final (c, tokens, signedOut) = signedIn();
      await expectLater(
        c.get('/me'),
        throwsA(isA<ApiError>().having((e) => e.status, 'status', 503)),
      );
      expect(tokens.access, 'a');
      expect(tokens.refresh, 'r');
      expect(signedOut, isEmpty);
    });

    test('no network on refresh keeps the user signed in', () async {
      refreshStatus = 0;
      final (c, tokens, signedOut) = signedIn();
      await expectLater(
        c.get('/me'),
        throwsA(isA<ApiError>().having((e) => e.status, 'status', 0)),
      );
      expect(tokens.refresh, 'r');
      expect(signedOut, isEmpty);
    });

    test('only a refused refresh token signs out', () async {
      refreshStatus = 401;
      final (c, tokens, signedOut) = signedIn();
      await expectLater(
        c.get('/me'),
        throwsA(isA<ApiError>().having((e) => e.status, 'status', 401)),
      );
      expect(tokens.refresh, isNull);
      expect(signedOut, [true]);
    });

    test('a working refresh retries the call with the new token', () async {
      refreshStatus = 200;
      final (c, tokens, signedOut) = signedIn();
      expect(await c.get('/me'), isA<Map>());
      expect(tokens.access, 'A2');
      expect(signedOut, isEmpty);
    });
  });
}
