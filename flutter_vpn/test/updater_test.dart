import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/client.dart';
import 'package:pleat/api/models.dart';
import 'package:pleat/state/updater.dart';

import 'fakes.dart';

/// The in-app update: a cut download goes on with a Range request, the
/// file is checked, "Install unknown apps" is asked once, then the
/// installer opens. The native side is faked on `pleat/update`.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const ch = MethodChannel('pleat/update');
  final apk = List<int>.generate(300000, (i) => (i * 31) % 251);
  const goodSha =
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

  late HttpServer server;
  late Directory dir;
  late List<String?> ranges;
  late List<String> calls;
  late List<Map<Object?, Object?>> notes;
  late bool allowed;
  var cutFirst = true;

  /// 'stall': send a little, then go silent (a line that stops answering).
  /// 'chop': cut every connection after 30 KB. '': the default.
  var mode = '';
  late List<Socket> held;

  AppUpdate update({String sha = goodSha, int build = 22}) =>
      AppUpdate.fromJson({
        'version': '1.2.19',
        'build': build,
        'tag': '22-abc',
        'force': false,
        'abis': {
          'arm64-v8a': {'size': apk.length, 'sha256': sha},
        },
      });

  setUp(() async {
    // the test binding answers every HTTP call with 400; this test talks to
    // a real local server
    HttpOverrides.global = null;
    dir = await Directory.systemTemp.createTemp('pleat-upd');
    ranges = [];
    calls = [];
    notes = [];
    allowed = false;
    cutFirst = true;
    mode = '';
    held = [];
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      if (req.uri.path == '/health') {
        await req.response.close();
        return;
      }
      expect(req.uri.path, '/api/v1/app/apk');
      expect(req.uri.queryParameters['abi'], 'arm64-v8a');
      expect(req.headers.value('authorization'), startsWith('Bearer '));
      final range = req.headers.value('range');
      ranges.add(range);
      final from = range == null
          ? 0
          : int.parse(RegExp(r'bytes=(\d+)-').firstMatch(range)!.group(1)!);
      final res = req.response;
      res.statusCode = from > 0 ? 206 : 200;
      res.contentLength = apk.length - from;
      if (mode == 'stall') {
        final s = await res.detachSocket();
        s.add(apk.sublist(from, from + 20000));
        await s.flush();
        held.add(s); // and nothing more, until the test ends
        return;
      }
      if (mode == 'chop') {
        final s = await res.detachSocket();
        s.add(apk.sublist(from, (from + 30000).clamp(0, apk.length)));
        await s.flush();
        s.destroy();
        return;
      }
      if (cutFirst && from == 0) {
        // the line drops halfway
        cutFirst = false;
        final s = await res.detachSocket();
        s.add(apk.sublist(0, 120000));
        await s.flush();
        s.destroy();
        return;
      }
      res.add(apk.sublist(from));
      await res.close();
    });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(ch, (call) async {
          calls.add(call.method);
          switch (call.method) {
            case 'info':
              return {'version': '1.2.18', 'build': 21, 'abi': 'arm64-v8a'};
            case 'dir':
              return dir.path;
            case 'sha256':
              final bytes = File(call.arguments['path'] as String)
                  .readAsBytesSync();
              var same = bytes.length == apk.length;
              for (var i = 0; same && i < bytes.length; i++) {
                same = bytes[i] == apk[i];
              }
              return same ? goodSha : 'f' * 64;
            case 'canInstall':
              return allowed;
            case 'install':
              return true;
            case 'note':
              notes.add(call.arguments as Map<Object?, Object?>);
          }
          return null;
        });
  });
  tearDown(() async {
    for (final s in held) {
      s.destroy();
    }
    await server.close(force: true);
    await dir.delete(recursive: true);
  });

  Future<Updater> updater() async {
    final api = ApiClient(
      MemoryTokens(),
      bases: 'http://127.0.0.1:${server.port}',
    );
    await api.tokens.save('access', 'refresh');
    final u = Updater(api);
    await u.load();
    return u;
  }

  test('only a newer build with a file for this phone is offered', () async {
    final u = await updater();
    expect(u.known, isTrue);
    expect(u.offers(update()), isTrue);
    expect(u.offers(update(build: 21)), isFalse);
    expect(u.offers(null), isFalse);
    final other = AppUpdate.fromJson({
      'version': '1.2.19',
      'build': 22,
      'tag': 't',
      'abis': {
        'x86_64': {'size': 5, 'sha256': goodSha},
      },
    });
    expect(u.offers(other), isFalse);
  });

  test('a cut download goes on from where it stopped, is checked, and asks for installs once', () async {
    final u = await updater();
    await u.start(update());
    expect(ranges.first, isNull);
    expect(ranges.last, startsWith('bytes=12'));
    expect(u.received, apk.length);
    expect(u.step, UpdateStep.needsPermission);
    expect(calls, isNot(contains('install')));
    expect(
      File('${dir.path}/pleat-22-abc-arm64-v8a.apk').lengthSync(),
      apk.length,
    );

    allowed = true;
    await u.resumed();
    expect(calls, contains('install'));
    expect(u.step, UpdateStep.installing);
    // back from the installer without installing: Install is offered again
    await u.resumed();
    expect(u.step, UpdateStep.ready);
  });

  test('a damaged file is thrown away and never installed', () async {
    final u = await updater();
    allowed = true;
    await u.start(update(sha: 'e' * 64));
    expect(u.step, UpdateStep.failed);
    expect(u.error, contains('damaged'));
    expect(calls, isNot(contains('install')));
    expect(
      dir.listSync().whereType<File>().where((f) => f.path.endsWith('.apk')),
      isEmpty,
    );
  });

  test('the notification follows the download: download, check, then gone at the installer', () async {
    final u = await updater();
    allowed = true;
    final up = update();
    await u.notify(up);
    expect(notes.single['stage'], 'offer');
    expect(notes.single['alert'], isTrue);
    expect(notes.single['title'], 'Pleat 1.2.19 is ready for you');
    expect(notes.single['action'], 'Update now');
    expect(notes.single['from'], '1.2.18');
    expect(notes.single['to'], '1.2.19');
    await u.start(up);
    final stages = [for (final n in notes) n['stage']];
    expect(
      stages,
      containsAllInOrder(['offer', 'download', 'check', 'cancel']),
    );
    // progress updates are quiet; only the announcement may alert
    expect(notes.skip(1).every((n) => n['alert'] == false), isTrue);
    final dl = notes.lastWhere((n) => n['stage'] == 'download');
    expect(dl['title'], 'Updating to 1.2.19');
    expect(dl['action'], 'Stop');
    expect(dl['track'], 0);
    expect(notes.firstWhere((n) => n['stage'] == 'check')['track'], 1);
  });

  test('Stop on the notification stops the download', () async {
    final u = await updater();
    u.step = UpdateStep.downloading;
    const codec = StandardMethodCodec();
    await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .handlePlatformMessage(
          'pleat/update',
          codec.encodeMethodCall(const MethodCall('action', 'stop')),
          (_) {},
        );
    // the card and the notification go back to "Go on" at once
    expect(u.step, UpdateStep.idle);
  });

  test(
    'Stop works at once on a line that went silent, and Go on resumes',
    () async {
      final u = await updater();
      mode = 'stall';
      final run = u.start(update());
      // wait until the first bytes are in and the line is silent
      for (var i = 0; i < 100 && u.received < 20000; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
      expect(u.received, 20000);
      expect(u.step, UpdateStep.downloading);
      final t = Stopwatch()..start();
      u.stop();
      expect(u.step, UpdateStep.idle);
      expect(UpdateCopy.of(u, update()).action, 'Go on');
      // the running download lets go without waiting for the 30 s idle limit
      await run.timeout(const Duration(seconds: 2));
      expect(t.elapsed, lessThan(const Duration(seconds: 2)));
      expect(u.step, UpdateStep.idle);
      final part = File('${dir.path}/pleat-22-abc-arm64-v8a.apk.part');
      expect(part.lengthSync(), 20000);

      // Go on picks up from the 20 KB already on the phone
      mode = '';
      allowed = true;
      await u.start(update());
      expect(ranges.last, 'bytes=20000-');
      expect(u.step, UpdateStep.installing);
    },
  );

  test(
    'Stop then Go on at once: the stopped run never takes the card back',
    () async {
      final u = await updater();
      mode = 'stall';
      final first = u.start(update());
      for (var i = 0; i < 100 && u.received < 20000; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
      u.stop();
      mode = '';
      allowed = true;
      final second = u.start(update());
      await first;
      await second;
      expect(u.step, UpdateStep.installing);
      expect(u.received, apk.length);
    },
  );

  test('a line that cuts every 30 KB still gets there: tries that bring bytes start the count over', () async {
    final u = await updater();
    u.retryPause = Duration.zero;
    mode = 'chop';
    allowed = true;
    await u.start(update());
    // 300 KB in 30 KB pieces is 10 cuts, more than the 8 tries in a row
    expect(ranges.length, greaterThan(8));
    expect(u.step, UpdateStep.installing);
  });

  test('an address that breaks on the file is left for the next one', () async {
    // a second address that answers /health but drops every file
    final bad = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    bad.listen((req) async {
      if (req.uri.path == '/health') {
        await req.response.close();
        return;
      }
      final s = await req.response.detachSocket();
      s.destroy();
    });
    addTearDown(() => bad.close(force: true));
    final api = ApiClient(
      MemoryTokens(),
      bases: 'http://127.0.0.1:${bad.port},http://127.0.0.1:${server.port}',
    );
    await api.tokens.save('access', 'refresh');
    final u = Updater(api);
    await u.load();
    cutFirst = false;
    allowed = true;
    await u.start(update());
    expect(u.step, UpdateStep.installing);
    expect(u.trail, startsWith('o0 '));
    expect(u.trail, contains('o1 ok'));
    // one call, not one per retry: the bad address was skipped
    expect(ranges.length, 1);
  });

  test('the words for each step', () {
    final u = Updater(ApiClient(MemoryTokens(), bases: 'http://x'))
      ..version = '1.2.18'
      ..abi = 'arm64-v8a';
    final up = update();
    u.step = UpdateStep.ready;
    expect(UpdateCopy.of(u, up).title, 'Checked. Tap to install 1.2.19');
    expect(updateTrack(u).stage, 2);
    u
      ..step = UpdateStep.failed
      ..error = 'The download was damaged.';
    expect(UpdateCopy.of(u, up).text, 'The download was damaged.');
    expect(UpdateCopy.of(u, up).action, 'Try again');
  });
}
