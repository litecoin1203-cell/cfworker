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
      if (req.uri.path.endsWith('/fa')) {
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
}
