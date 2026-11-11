import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'models.dart';

/// Comma-separated Worker addresses, e.g.
/// `--dart-define=PLEAT_API=https://api.example.com,https://b.example.com`.
/// The same list the Cloud Gold app takes as CG_API_BASE; the next address
/// is tried when one is unreachable.
const apiBases = String.fromEnvironment('PLEAT_API');

/// The Worker's error body is `{detail: {code, message}}`. [message] is
/// what the screen shows: English for the codes Pleat knows, otherwise the
/// server's own text.
/// How asking for new tokens went.
enum _Refresh { ok, refused, failed }

class ApiError implements Exception {
  ApiError(this.status, this.code, this.message);
  final int status;
  final String code;
  final String message;

  bool get unauthorized => status == 401;

  /// The Worker was never reached (no network, a filtered line, a
  /// timeout): nothing about the login or the code is known to be wrong.
  bool get offline => status == 0 && code != 'no_server';

  /// The Worker answered with a server-side failure (5xx).
  bool get serverSide => status >= 500;

  @override
  String toString() => 'ApiError($status, $code)';
}

/// Tokens and the device id, in Keystore-backed storage. Never logged.
class TokenStore {
  TokenStore([FlutterSecureStorage? storage])
    : _s = storage ?? const FlutterSecureStorage();
  final FlutterSecureStorage _s;

  String? access, refresh, deviceId;

  /// User and password ("user:pass", hex) of the local API proxy the
  /// tunnel and the bridge open for the app; made once per install and
  /// kept, because Android's always-on start reuses the last config.
  String? proxyLogin;

  static String _hex(int bytes) {
    final r = Random.secure();
    return List.generate(
      bytes,
      (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
  }

  Future<void> load() async {
    access = await _s.read(key: 'access');
    refresh = await _s.read(key: 'refresh');
    deviceId = await _s.read(key: 'device');
    if (deviceId == null) {
      deviceId = _hex(16);
      await _s.write(key: 'device', value: deviceId);
    }
    try {
      proxyLogin = await _s.read(key: 'proxy');
      if (proxyLogin == null) {
        proxyLogin = '${_hex(8)}:${_hex(16)}';
        await _s.write(key: 'proxy', value: proxyLogin);
      }
    } catch (_) {
      // Without the Keystore this launch gets one of its own.
      proxyLogin ??= '${_hex(8)}:${_hex(16)}';
    }
  }

  /// Replaces the random id with the phone's own (see `loadDevice`).
  Future<void> useDeviceId(String id) async {
    if (id == deviceId) return;
    deviceId = id;
    await _s.write(key: 'device', value: id);
  }

  Future<void> save(String a, String r) async {
    access = a;
    refresh = r;
    await _s.write(key: 'access', value: a);
    await _s.write(key: 'refresh', value: r);
  }

  Future<void> clear() async {
    access = null;
    refresh = null;
    await _s.delete(key: 'access');
    await _s.delete(key: 'refresh');
    await _s.delete(key: 'servers');
    for (final k in cacheKeys) {
      await _s.delete(key: 'cache.$k');
    }
  }

  /// What the account screens showed last, so the next launch shows it at
  /// once and refreshes it in the background. Kept in the Keystore, like
  /// the tokens, because it is the account's own data.
  static const cacheKeys = ['me', 'plans', 'devices', 'ranks', 'photo']; // 'photo' is no longer written; it stays so an old copy is wiped on sign-out

  /// A cache is a convenience: when the Keystore can't be read or
  /// written, the app just loads from the Worker as before.
  Future<String?> cached(String key) async {
    try {
      return await _s.read(key: 'cache.$key');
    } catch (_) {
      return null;
    }
  }

  Future<void> cache(String key, Object? data) async {
    try {
      await _s.write(key: 'cache.$key', value: jsonEncode(data));
    } catch (_) {
      // Next launch loads from the Worker.
    }
  }

  /// The last server list, kept in the Keystore too because its configs
  /// carry the account's credentials. Lets Pleat connect while the Worker
  /// can't be reached, as the Cloud Gold app does.
  Future<String?> cachedServers() => _s.read(key: 'servers');
  Future<void> cacheServers(String json) =>
      _s.write(key: 'servers', value: json);

  /// A few exits that worked on this phone, kept after sign-out (unlike
  /// the server list) so that signing in again on a filtered line can
  /// reach the Worker over the bridge. They only ever carry the app's own
  /// calls to the Worker's hosts.
  Future<List<String>> keptBridges() async {
    try {
      final v = await _s.read(key: 'keep.bridges');
      if (v == null) return const [];
      return [for (final l in jsonDecode(v) as List) '$l'];
    } catch (_) {
      return const [];
    }
  }

  Future<void> keepBridges(List<String> links) async {
    try {
      await _s.write(key: 'keep.bridges', value: jsonEncode(links));
    } catch (_) {
      // Only a help for the next sign-in.
    }
  }

  bool get signedIn => access != null && refresh != null;
}

/// The other ways to the Worker than the open line, given by the app:
/// the tunnel's own API port while the tunnel is up, and the bridge (a core
/// started only for the app's calls) while it is off.
///
/// A proxy is given as `user:pass@127.0.0.1:port`.
abstract class Detours {
  /// The tunnel's API proxy while the tunnel is up, else null.
  String? get tunnel;

  /// The bridge's proxy while the bridge runs, else null.
  String? get bridge;

  /// Starts the bridge on the exits it knows, one after another, until
  /// [works] says the Worker answers through it; its proxy, or null when
  /// none did. Only the Worker's own [hosts] may cross the bridge.
  Future<String?> openBridge(
    List<String> hosts,
    Future<bool> Function(String proxy) works,
  );

  /// The bridge carried a call: keep it up a little longer.
  void used();
}

/// One way to the Worker: an address, straight or through a local proxy.
class _Way {
  const _Way(this.base, [this.proxy]);
  final String base;
  final String? proxy;
  String get key => '$base|${proxy ?? ''}';
}

List<String> _parseBases(String bases) => bases
    .split(',')
    .map((b) => b.trim().replaceAll(RegExp(r'/+$'), ''))
    .where((b) => b.startsWith('https://') || b.startsWith('http://'))
    .toList();

/// The one HTTP client for the Cloud Gold Worker.
///
/// In Iran the open line may not reach the Worker at all, or only one of
/// its addresses. So each call goes the way that answered last; when
/// that way stops answering, every way is asked at once (`/health`, a
/// few milliseconds apart in order of preference) and the first to answer
/// is used: the tunnel's own port while connected, every address on the
/// open line, then the bridge.
class ApiClient {
  ApiClient(this.tokens, {String bases = apiBases, HttpClient? http})
    : _bases = _parseBases(bases),
      _http = http ?? (HttpClient()..connectionTimeout = _connect);

  /// Connecting must be quick so the next address is tried soon; an answer
  /// may take longer, because a trial or a purchase builds the account on
  /// the panel first (the Cloud Gold app waits 30 s as well).
  static const _connect = Duration(seconds: 6);

  /// The Worker reads every panel before it answers `/me` and `/vpn`, and
  /// a panel may take up to 15 s per call, so the answer gets 45 s.
  static const _timeout = Duration(seconds: 45);

  /// Contract version, not Pleat's own: 1.9 tells the Worker this client
  /// never wants a raw subscription address (see `centralApp`).
  static const appVersion = '1.9.0 (Pleat 1.2.13)';

  final TokenStore tokens;
  final List<String> _bases;
  final HttpClient _http;
  final Map<String, HttpClient> _proxied = {};
  int _base = 0;

  /// The tunnel and the bridge, set by the app; null in tests and before
  /// the app is up.
  Detours? detours;

  /// The way that answered last, and when. Kept while it keeps answering.
  _Way? _good;
  DateTime? _goodAt;
  static const _goodFor = Duration(minutes: 10);

  /// How long `/health` may take on one way before another wins.
  static const _probeTimeout = Duration(seconds: 8);

  /// Head start each way gets over the next one in the race, so the
  /// preferred way wins a tie.
  static const _stagger = Duration(milliseconds: 300);

  /// Every Worker address this client knows, build ones first.
  List<String> get bases => List.unmodifiable(_bases);

  /// The host names of [bases], the only ones the bridge lets through.
  List<String> get hosts =>
      {for (final b in _bases) Uri.parse(b).host}
          .where((h) => h.isNotEmpty)
          .toList();

  /// Adds addresses the Worker named (app-config `api_bases`) after the
  /// build's own; a new domain then works without a new APK.
  void learnBases(Iterable<String> extra) {
    for (final b in _parseBases(extra.join(','))) {
      if (!_bases.contains(b)) _bases.add(b);
    }
  }

  /// "Maker Model" of this phone and its Android version ("14"), set once
  /// at launch. The Worker passes them to the panel with the HWID; they
  /// must look like what the Cloud Gold app sends.
  String deviceModel = 'Pleat';
  String osVersion = '';

  /// Called when the server rejects the session for good.
  void Function()? onSignedOut;

  /// Method, path and status of each exchange. Never bodies or headers, so
  /// no token or config can reach a log through it.
  void Function(String method, String path, int status)? trace;

  /// Same, with how long the exchange took; status 0 when it failed.
  void Function(String method, String path, int status, Duration took)? timing;

  bool get configured => _bases.isNotEmpty;

  Map<String, String> get _deviceHeaders => {
    'x-device-id': tokens.deviceId ?? '',
    'x-device-model': deviceModel,
    // The panel limits phones by HWID, as it does for the Cloud Gold app;
    // without it a plan with a device limit gets no configs.
    'x-hwid': tokens.deviceId ?? '',
    'x-device-os': Platform.isAndroid ? 'Android' : Platform.operatingSystem,
    // The Android version only, as the Cloud Gold app sends it. Dart's own
    // operatingSystemVersion is the long kernel string.
    'x-ver-os': osVersion,
    'x-app-version': appVersion,
  };

  /// Finds a way to the Worker ahead of the first call (the sign-in
  /// screen calls it as it opens), so the race and, on a filtered line,
  /// the bridge are done before the person taps Sign in. Never throws.
  Future<bool> warmUp() async {
    if (!configured) return false;
    try {
      await _pick(_ways(direct: false), direct: false);
      return true;
    } catch (_) {
      return false;
    }
  }

  /// [bridge]: false when starting the bridge isn't worth the wait (the
  /// connect button's plan check: the tunnel itself is about to start).
  Future<dynamic> get(String path, {bool bridge = true}) =>
      _send('GET', path, bridge: bridge);
  Future<dynamic> post(String path, [Map<String, Object?>? body]) =>
      _send('POST', path, body: body ?? const {});
  Future<dynamic> delete(String path) => _send('DELETE', path);

  /// Multipart form upload (the card receipt): text [fields] and one file.
  Future<dynamic> upload(
    String path,
    Map<String, String> fields, {
    required List<int> file,
    required String filename,
  }) {
    final boundary = 'pleat${DateTime.now().microsecondsSinceEpoch}';
    final out = BytesBuilder();
    void line(String s) => out.add(utf8.encode('$s\r\n'));
    fields.forEach((k, v) {
      line('--$boundary');
      line('Content-Disposition: form-data; name="$k"');
      line('');
      line(v);
    });
    line('--$boundary');
    line('Content-Disposition: form-data; name="file"; filename="$filename"');
    line('Content-Type: application/octet-stream');
    line('');
    out.add(file);
    line('');
    line('--$boundary--');
    return _send(
      'POST',
      path,
      raw: (out.takeBytes(), 'multipart/form-data; boundary=$boundary'),
    );
  }

  /// How long a download may go without a byte before the way is dropped.
  static const _idle = Duration(seconds: 40);

  /// Streams a Worker file (the update APK) into [out]. What [out] already
  /// holds is kept and the rest asked for with a Range request, so a
  /// dropped download goes on where it stopped, on whichever way answers
  /// now (open line, tunnel or bridge). [onProgress] gets the bytes in the
  /// file so far; [stop] returning true aborts with code `stopped`.
  Future<void> download(
    String path,
    File out, {
    void Function(int bytes)? onProgress,
    bool Function()? stop,
  }) async {
    if (!configured) {
      throw ApiError(0, 'no_server', 'This build has no server address.');
    }
    Object? lastError;
    var refreshed = false;
    for (var round = 0; round < 3; round++) {
      final _Way way;
      try {
        way = await _pick(_ways(direct: false), direct: false);
      } on ApiError {
        if (lastError == null) rethrow;
        break;
      }
      final have = await out.exists() ? await out.length() : 0;
      HttpClientRequest? req;
      try {
        req = await _client(way.proxy)
            .openUrl('GET', Uri.parse('${way.base}/api/v1$path'))
            .timeout(_timeout);
        final r = req;
        r.persistentConnection = false;
        _deviceHeaders.forEach(r.headers.set);
        if (tokens.access != null) {
          r.headers.set('authorization', 'Bearer ${tokens.access}');
        }
        if (have > 0) r.headers.set('range', 'bytes=$have-');
        final res = await r.close().timeout(_timeout);
        if (res.statusCode == 401 && !refreshed) {
          await res.drain<void>();
          refreshed = true;
          if (await _refresh() == _Refresh.ok) {
            round--;
            continue;
          }
          throw _error(401, null);
        }
        if (res.statusCode == 416) {
          // Nothing left to send: the file is already whole (or too long,
          // which the hash check then says).
          await res.drain<void>();
          return;
        }
        if (res.statusCode != 200 && res.statusCode != 206) {
          final text = await res.transform(utf8.decoder).join();
          dynamic data;
          try {
            data = jsonDecode(text);
          } on FormatException {
            data = null;
          }
          throw _error(res.statusCode, data);
        }
        _keep(way);
        trace?.call('GET', path.split('?').first, res.statusCode);
        var pos = res.statusCode == 206 ? have : 0;
        onProgress?.call(pos);
        final sink = out.openWrite(
          mode: res.statusCode == 206 ? FileMode.append : FileMode.write,
        );
        try {
          await for (final piece in res.timeout(_idle)) {
            if (stop?.call() ?? false) {
              r.abort();
              throw ApiError(0, 'stopped', 'Download stopped.');
            }
            sink.add(piece);
            pos += piece.length;
            onProgress?.call(pos);
            // the bridge carried a call: keep it up while the file flows
            if (way.proxy != null && way.proxy == detours?.bridge) {
              detours?.used();
            }
          }
        } finally {
          await sink.close();
        }
        return;
      } on SocketException catch (e) {
        lastError = e;
      } on TimeoutException catch (e) {
        lastError = e;
      } on HttpException catch (e) {
        lastError = e;
      } on HandshakeException catch (e) {
        req?.abort();
        throw _offline(e);
      }
      req?.abort();
      if (_good?.key == way.key) _good = null;
    }
    throw _offline(lastError);
  }

  Future<dynamic> _send(
    String method,
    String path, {
    Map<String, Object?>? body,
    (List<int>, String)? raw,
    bool retried = false,
    bool bridge = true,
  }) async {
    if (!configured) {
      throw ApiError(
        0,
        'no_server',
        'This build has no server address. Build it with PLEAT_API.',
      );
    }
    final authed = !path.startsWith('/auth/') && tokens.access != null;
    final (status, data) = await _roundTrip(
      method,
      path,
      body,
      authed,
      raw,
      bridge,
    );
    if (status == 401 && authed && !retried) {
      switch (await _refresh()) {
        case _Refresh.ok:
          return _send(
            method,
            path,
            body: body,
            raw: raw,
            retried: true,
            bridge: bridge,
          );
        case _Refresh.failed:
          // The server could not be asked (no network, a filtered line, a
          // server error): the session may well be fine, so the user stays
          // signed in and the call fails like any network error.
          throw _lastRefreshError ?? _offline(null);
        case _Refresh.refused:
          break;
      }
    }
    if (status >= 400) {
      final err = _error(status, data);
      if (status == 401 && authed) {
        await tokens.clear();
        onSignedOut?.call();
      }
      throw err;
    }
    return data;
  }

  ApiError? _lastRefreshError;

  /// New tokens for an expired access token. Only the server saying the
  /// refresh token is no good (401 or 403) signs the user out; anything
  /// else that stops the refresh is [_Refresh.failed] and keeps the tokens.
  Future<_Refresh> _refresh() async {
    final r = tokens.refresh;
    if (r == null) return _Refresh.refused;
    _lastRefreshError = null;
    try {
      final (status, data) = await _roundTrip('POST', '/auth/refresh', {
        'refresh_token': r,
      }, false);
      if (status == 401 || status == 403) return _Refresh.refused;
      if (status != 200 || data is! Map) {
        _lastRefreshError = _error(status, data);
        return _Refresh.failed;
      }
      await tokens.save(
        data['access_token'] as String,
        data['refresh_token'] as String,
      );
      return _Refresh.ok;
    } on ApiError catch (e) {
      _lastRefreshError = e;
      return _Refresh.failed;
    }
  }

  /// Calls on `/net/` say which network the phone is on (the Worker reads
  /// the carrier from the address it sees), so they never take the tunnel
  /// or the bridge: through an exit the Worker would see the exit's
  /// network instead.
  static bool _openLineOnly(String path) => path.startsWith('/net/');

  /// `/me/ip` shows where the tunnel comes out: asked on the open line it
  /// would show the phone's own address under "Through", so it only ever
  /// crosses the tunnel, and fails when the tunnel can't carry it.
  static bool _tunnelOnly(String path) => path == '/me/ip';

  Future<(int, dynamic)> _roundTrip(
    String method,
    String path,
    Map<String, Object?>? body,
    bool authed, [
    (List<int>, String)? raw,
    bool bridge = true,
  ]) async {
    Object? lastError;
    final direct = _openLineOnly(path);
    final tunnelOnly = _tunnelOnly(path);
    // A GET is safe to send twice: a dropped or reset connection gets one
    // fresh try, then (when there is another way) one on a newly picked
    // way. A POST is never repeated, so an order or a trial can't happen
    // twice.
    final isGet = method == 'GET';
    for (var round = 0; round < (isGet ? 2 : 1); round++) {
      final ways = _ways(direct: direct, tunnelOnly: tunnelOnly);
      final _Way way;
      try {
        way = await _pick(ways, direct: direct, bridge: bridge && !tunnelOnly);
      } on ApiError {
        if (lastError == null) rethrow;
        break;
      }
      final client = _client(way.proxy);
      for (var a = 0; a < (isGet ? 2 : 1); a++) {
        final started = DateTime.now();
        try {
          final (status, text) = await _exchange(
            client,
            method,
            Uri.parse('${way.base}/api/v1$path'),
            body,
            authed,
            raw,
          );
          _keep(way);
          trace?.call(method, path, status);
          timing?.call(
            method,
            path,
            status,
            DateTime.now().difference(started),
          );
          dynamic data;
          if (text.isNotEmpty) {
            try {
              data = jsonDecode(text);
            } on FormatException {
              data = null;
            }
          }
          return (status, data);
        } on SocketException catch (e) {
          lastError = e;
        } on TimeoutException catch (e) {
          lastError = e;
          // Already waited the full deadline; a second wait helps nobody.
          timing?.call(method, path, 0, DateTime.now().difference(started));
          break;
        } on HttpException catch (e) {
          lastError = e;
        } on HandshakeException catch (e) {
          lastError = e;
          break; // A certificate problem doesn't fix itself on a retry.
        }
        timing?.call(method, path, 0, DateTime.now().difference(started));
      }
      // This way failed: the next call races every way again.
      if (_good?.key == way.key) _good = null;
      if (ways.length <= 1 && detours == null) break;
    }
    throw _offline(lastError);
  }

  static ApiError _offline(Object? lastError) => ApiError(
    0,
    switch (lastError) {
      TimeoutException() => 'timeout',
      HandshakeException() => 'tls',
      _ => 'offline',
    },
    switch (lastError) {
      TimeoutException() =>
        'The server didn’t answer in time. Try again in a moment.',
      HandshakeException() => 'The server’s certificate was not trusted.',
      _ => 'Can’t reach the server. Check the connection and try again.',
    },
  );

  void _keep(_Way way) {
    _good = way;
    _goodAt = DateTime.now();
    final i = _bases.indexOf(way.base);
    if (i >= 0) _base = i;
    if (way.proxy != null && way.proxy == detours?.bridge) detours?.used();
  }

  /// Every way in order of preference: the tunnel's port (it already
  /// crossed an exit), the open line, then a running bridge. Each starts
  /// from the address that answered last.
  List<_Way> _ways({required bool direct, bool tunnelOnly = false}) {
    final order = [
      for (var i = 0; i < _bases.length; i++)
        _bases[(_base + i) % _bases.length],
    ];
    final tunnel = direct ? null : detours?.tunnel;
    final bridge = direct ? null : detours?.bridge;
    if (tunnelOnly) {
      return [
        if (tunnel != null)
          for (final b in order) _Way(b, tunnel),
      ];
    }
    return [
      if (tunnel != null)
        for (final b in order) _Way(b, tunnel),
      for (final b in order) _Way(b),
      if (bridge != null)
        for (final b in order) _Way(b, bridge),
    ];
  }

  /// The way to use now: the last good one while it is fresh and still on
  /// offer, otherwise the first to answer `/health`. When nothing answers
  /// and there's no tunnel, the bridge is started and asked too.
  Future<_Way> _pick(
    List<_Way> ways, {
    required bool direct,
    bool bridge = true,
  }) async {
    final good = _good;
    if (good != null &&
        _goodAt != null &&
        DateTime.now().difference(_goodAt!) < _goodFor &&
        ways.any((w) => w.key == good.key)) {
      // A tunnel that came up since is preferred over the open line.
      if (good.proxy != null || ways.first.proxy == null) return good;
    }
    // Nothing to try (a tunnel-only call while the tunnel is down).
    if (ways.isEmpty) throw _offline(null);
    // One way and nothing else to try: no need to ask first.
    if (ways.length == 1 && (direct || detours == null)) return ways.first;
    // The calls of a screen go out together; they share one race.
    final key = '$direct|$bridge|${ways.map((w) => w.key).join(',')}';
    final running = _picking[key];
    if (running != null) return running;
    final next = _pickNow(ways, direct: direct, bridge: bridge);
    _picking[key] = next;
    try {
      return await next;
    } finally {
      _picking.remove(key);
    }
  }

  final Map<String, Future<_Way>> _picking = {};

  Future<_Way> _pickNow(
    List<_Way> ways, {
    required bool direct,
    required bool bridge,
  }) async {
    // While the tunnel is up its port is asked on its own first. In one
    // race the open line, a few hundred milliseconds behind, often answered
    // before the exit did (it is farther away), and the calls then left
    // outside the tunnel: the Home screen showed the phone's own IP.
    // The open line is asked only when the tunnel's port doesn't answer.
    final tunnelWays = ways
        .where((w) => w.proxy != null && w.proxy == detours?.tunnel)
        .toList();
    final rest = ways.where((w) => !tunnelWays.contains(w)).toList();
    var (way, error) = await _race(tunnelWays.isEmpty ? ways : tunnelWays);
    if (way != null) return way;
    if (tunnelWays.isNotEmpty && rest.isNotEmpty) {
      final (w2, e2) = await _race(rest);
      if (w2 != null) return w2;
      error = e2 ?? error;
    }
    final d = detours;
    if (bridge && !direct && d != null && d.tunnel == null) {
      _Way? found;
      final proxy = await d.openBridge(hosts, (proxy) async {
        final (w, _) = await _race([for (final b in _bases) _Way(b, proxy)]);
        found = w;
        return w != null;
      });
      if (proxy != null && found != null) return found!;
    }
    throw _offline(error);
  }

  /// Asks `/health` on every way, the later ones a little later; the
  /// first to answer 200 wins and the rest are dropped.
  Future<(_Way?, Object?)> _race(List<_Way> ways) async {
    if (ways.isEmpty) return (null, null);
    final done = Completer<(_Way?, Object?)>();
    var left = ways.length;
    Object? lastError;
    final requests = <HttpClientRequest>[];
    for (var i = 0; i < ways.length; i++) {
      final way = ways[i];
      () async {
        await Future<void>.delayed(_stagger * i);
        if (done.isCompleted) return;
        HttpClientRequest? req;
        try {
          final ok = await () async {
            req = await _client(way.proxy)
                .openUrl('GET', Uri.parse('${way.base}/health'));
            requests.add(req!);
            req!.persistentConnection = false;
            final res = await req!.close();
            await res.drain<void>();
            return res.statusCode == 200;
          }().timeout(_probeTimeout);
          if (ok && !done.isCompleted) done.complete((way, null));
        } catch (e) {
          lastError = e is TimeoutException ? e : (lastError ?? e);
          req?.abort();
        } finally {
          left--;
          if (left == 0 && !done.isCompleted) done.complete((null, lastError));
        }
      }();
    }
    final result = await done.future;
    for (final r in requests) {
      r.abort();
    }
    if (result.$1 != null) _keep(result.$1!);
    return result;
  }

  HttpClient _client(String? proxy) {
    if (proxy == null) return _http;
    return _proxied[proxy] ??= HttpClient()
      ..connectionTimeout = _connect
      ..findProxy = (_) => 'PROXY $proxy';
  }

  /// One request on its own connection, with one deadline for all of it.
  /// On the deadline the request is aborted, so no half-dead connection is
  /// left behind or reused.
  Future<(int, String)> _exchange(
    HttpClient client,
    String method,
    Uri url,
    Map<String, Object?>? body,
    bool authed,
    (List<int>, String)? raw,
  ) async {
    HttpClientRequest? req;
    try {
      return await () async {
        req = await client.openUrl(method, url);
        final r = req!;
        r.persistentConnection = false;
        _deviceHeaders.forEach(r.headers.set);
        if (authed) r.headers.set('authorization', 'Bearer ${tokens.access}');
        if (raw != null) {
          r.headers.set('content-type', raw.$2);
          r.contentLength = raw.$1.length;
          r.add(raw.$1);
        } else if (body != null) {
          r.headers.contentType = ContentType.json;
          r.add(utf8.encode(jsonEncode(body)));
        }
        final res = await r.close();
        return (res.statusCode, await res.transform(utf8.decoder).join());
      }().timeout(_timeout);
    } on TimeoutException {
      req?.abort();
      rethrow;
    }
  }

  static ApiError _error(int status, dynamic data) {
    var code = 'http_$status', message = '';
    if (data is Map && data['detail'] is Map) {
      final d = data['detail'] as Map;
      code = (d['code'] as String?) ?? code;
      message = (d['message'] as String?) ?? '';
    }
    return ApiError(status, code, _english[code] ?? _englishOnly(message));
  }

  /// The app is English-only. The Worker writes its messages in Persian, so
  /// an unknown code gets a plain English line instead of that text.
  static String _englishOnly(String message) {
    if (message.isNotEmpty && !isPersian(message)) {
      return message;
    }
    return 'Something went wrong on the server. Try again.';
  }

  /// English copy for the Worker's error codes. Unknown codes keep the
  /// server's message, so nothing is hidden.
  static const _english = {
    'bad_credentials': 'Login or password is wrong.',
    'bad_code': 'The code is wrong or has expired.',
    'code_not_sent': 'Open the bot in Telegram and tap Start to get your code.',
    'too_many_tries':
        'Too many wrong codes. Tap Start in the bot again for a new one.',
    'signup_expired':
        'Sign-up took too long. Tap Continue with Telegram again.',
    'telegram_linked': 'Your Telegram account is already verified.',
    'telegram_taken':
        'This Telegram account already has an account. Sign in instead.',
    'telegram_unavailable':
        'Telegram sign-in isn’t available right now. Use email instead.',
    'email_taken': 'An account with this email exists. Sign in instead.',
    'invalid_input': 'Check the fields and try again.',
    'not_authenticated': 'Sign in first.',
    'token_invalid': 'Your session ended. Sign in again.',
    'account_disabled': 'This account is disabled.',
    'too_many_requests': 'Too many tries. Wait a minute and try again.',
    'settle_busy': 'This order is being activated right now.',
    'plan_missing': 'This plan no longer exists.',
    'no_subscription': 'No active plan. Start a trial or buy a plan.',
    'sub_missing': 'Your account wasn’t found on the servers. Contact support.',
    'no_servers': 'No servers are set up for your plan yet.',
    'device_limit':
        'This plan is on its device limit. Remove an old phone in Profile.',
    'panel_unavailable': 'Servers can’t be reached right now. Try again soon.',
    'no_trial': 'This plan has no free trial.',
    'trial_used': 'The free trial was already used.',
    'trial_needs_telegram':
        'Verify your Telegram in Profile first, then start the free trial.',
    'provision_failed': 'The trial couldn’t start right now. Try again soon.',
    'activation_failed': 'Your plan couldn’t be activated yet. Support was told and will fix it soon.',
    'too_many_open_orders': 'You have several unpaid orders. If you paid, wait for the check. Otherwise try again in 30 minutes.',
    'plan_not_found': 'This plan isn’t available.',
    'insufficient_balance': 'Your wallet balance isn’t enough for this plan.',
    'wrong_password': 'The current password is wrong.',
    'not_found': 'Not found.',
    'amount_too_large': 'That amount is above the limit.',
    'amount_too_small': 'That amount is below the minimum.',
    'bad_file': 'That file can’t be used as a receipt. Send a photo.',
    'too_large': 'The receipt photo is too large.',
    'bad_method': 'Top up the wallet with card or crypto.',
    'bad_state': 'This order can’t be changed now.',
    'bad_request': 'Check the fields and try again.',
    'method_unavailable': 'This payment method is off right now.',
    'coin_unavailable': 'This coin isn’t available right now.',
    'crypto_error': 'Crypto payment couldn’t start. Try again soon.',
    'price_unavailable': 'The price isn’t available right now. Try again soon.',
    'txid_used': 'This transaction was already used.',
    'coupon_invalid': 'This code isn’t valid.',
    'coupon_expired': 'This code has expired.',
    'coupon_used': 'You already used this code.',
    'coupon_used_up': 'This code is used up.',
    'coupon_in_use': 'This code is being used on another order.',
    'coupon_wrong_plan': 'This code isn’t for this plan.',
    'panel_unconfigured': 'Servers aren’t set up yet. Contact support.',
    'update_gone': 'This update was replaced by a newer one. Check again.',
    'update_unavailable':
        'The update can’t be downloaded right now. Try again soon.',
  };
}
