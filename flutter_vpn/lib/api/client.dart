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
class ApiError implements Exception {
  ApiError(this.status, this.code, this.message);
  final int status;
  final String code;
  final String message;

  bool get unauthorized => status == 401;

  @override
  String toString() => 'ApiError($status, $code)';
}

/// Tokens and the device id, in Keystore-backed storage. Never logged.
class TokenStore {
  TokenStore([FlutterSecureStorage? storage])
    : _s = storage ?? const FlutterSecureStorage();
  final FlutterSecureStorage _s;

  String? access, refresh, deviceId;

  Future<void> load() async {
    access = await _s.read(key: 'access');
    refresh = await _s.read(key: 'refresh');
    deviceId = await _s.read(key: 'device');
    if (deviceId == null) {
      final r = Random.secure();
      deviceId = List.generate(
        16,
        (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0'),
      ).join();
      await _s.write(key: 'device', value: deviceId);
    }
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
  }

  /// The last server list, kept in the Keystore too because its configs
  /// carry the account's credentials. Lets Pleat connect while the Worker
  /// can't be reached, as the Cloud Gold app does.
  Future<String?> cachedServers() => _s.read(key: 'servers');
  Future<void> cacheServers(String json) =>
      _s.write(key: 'servers', value: json);

  bool get signedIn => access != null && refresh != null;
}

/// The one HTTP client for the Cloud Gold Worker.
class ApiClient {
  ApiClient(this.tokens, {String bases = apiBases, HttpClient? http})
    : _bases = bases
          .split(',')
          .map((b) => b.trim().replaceAll(RegExp(r'/+$'), ''))
          .where((b) => b.startsWith('https://') || b.startsWith('http://'))
          .toList(),
      _http = http ?? (HttpClient()..connectionTimeout = _connect);

  /// Connecting must be quick so the next address is tried soon; an answer
  /// may take longer, because a trial or a purchase builds the account on
  /// the panel first (the Cloud Gold app waits 30 s as well).
  static const _connect = Duration(seconds: 12);

  /// The Worker reads every panel before it answers `/me` and `/vpn`, and
  /// a panel may take up to 15 s per call, so the answer gets 45 s.
  static const _timeout = Duration(seconds: 45);

  /// Contract version, not Pleat's own: 1.9 tells the Worker this client
  /// never wants a raw subscription address (see `centralApp`).
  static const appVersion = '1.9.0 (Pleat 1.2.0)';

  final TokenStore tokens;
  final List<String> _bases;
  final HttpClient _http;
  int _base = 0;

  /// "Maker Model" of this phone, for the device list; set once at launch.
  String deviceModel = 'Pleat';

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
    'x-device-os': Platform.operatingSystem,
    'x-ver-os': Platform.operatingSystemVersion,
    'x-app-version': appVersion,
  };

  Future<dynamic> get(String path) => _send('GET', path);
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

  Future<dynamic> _send(
    String method,
    String path, {
    Map<String, Object?>? body,
    (List<int>, String)? raw,
    bool retried = false,
  }) async {
    if (!configured) {
      throw ApiError(
        0,
        'no_server',
        'This build has no server address. Build it with PLEAT_API.',
      );
    }
    final authed = !path.startsWith('/auth/') && tokens.access != null;
    final (status, data) = await _roundTrip(method, path, body, authed, raw);
    if (status == 401 && authed && !retried && await _refresh()) {
      return _send(method, path, body: body, raw: raw, retried: true);
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

  Future<bool> _refresh() async {
    final r = tokens.refresh;
    if (r == null) return false;
    try {
      final (status, data) = await _roundTrip('POST', '/auth/refresh', {
        'refresh_token': r,
      }, false);
      if (status != 200 || data is! Map) return false;
      await tokens.save(
        data['access_token'] as String,
        data['refresh_token'] as String,
      );
      return true;
    } on ApiError {
      return false;
    }
  }

  Future<(int, dynamic)> _roundTrip(
    String method,
    String path,
    Map<String, Object?>? body,
    bool authed, [
    (List<int>, String)? raw,
  ]) async {
    Object? lastError;
    // A GET is safe to send twice: a dropped or reset connection gets one
    // fresh try per address, as OkHttp does for the Cloud Gold app. A POST is never repeated, so an order or a
    // trial can't happen twice.
    final attempts = method == 'GET' ? 2 : 1;
    for (var tries = 0; tries < _bases.length; tries++) {
      final base = _bases[(_base + tries) % _bases.length];
      for (var a = 0; a < attempts; a++) {
        final started = DateTime.now();
        try {
          final (status, text) = await _exchange(
            method,
            Uri.parse('$base/api/v1$path'),
            body,
            authed,
            raw,
          );
          _base = (_base + tries) % _bases.length;
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
    }
    throw ApiError(
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
  }

  /// One request on its own connection, with one deadline for all of it.
  /// On the deadline the request is aborted, so no half-dead connection is
  /// left behind or reused.
  Future<(int, String)> _exchange(
    String method,
    Uri url,
    Map<String, Object?>? body,
    bool authed,
    (List<int>, String)? raw,
  ) async {
    HttpClientRequest? req;
    try {
      return await () async {
        req = await _http.openUrl(method, url);
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
    'bad_credentials': 'Email or password is wrong.',
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
    'provision_failed': 'The trial couldn’t start right now. Try again soon.',
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
  };
}
