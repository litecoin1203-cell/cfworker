import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

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
  }

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
      _http = http ?? (HttpClient()..connectionTimeout = _timeout);

  static const _timeout = Duration(seconds: 12);

  /// Contract version, not Pleat's own: 1.9 tells the Worker this client
  /// never wants a raw subscription address (see `centralApp`).
  static const appVersion = '1.9.0 (Pleat 1.1.0)';

  final TokenStore tokens;
  final List<String> _bases;
  final HttpClient _http;
  int _base = 0;

  /// Called when the server rejects the session for good.
  void Function()? onSignedOut;

  /// Method, path and status of each exchange. Never bodies or headers, so
  /// no token or config can reach a log through it.
  void Function(String method, String path, int status)? trace;

  bool get configured => _bases.isNotEmpty;

  Map<String, String> get _deviceHeaders => {
    'x-device-id': tokens.deviceId ?? '',
    'x-device-model': 'Pleat ${Platform.operatingSystem}',
    'x-device-os': Platform.operatingSystem,
    'x-ver-os': Platform.operatingSystemVersion,
    'x-app-version': appVersion,
  };

  Future<dynamic> get(String path) => _send('GET', path);
  Future<dynamic> post(String path, [Map<String, Object?>? body]) =>
      _send('POST', path, body: body ?? const {});
  Future<dynamic> delete(String path) => _send('DELETE', path);

  Future<dynamic> _send(
    String method,
    String path, {
    Map<String, Object?>? body,
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
    final (status, data) = await _roundTrip(method, path, body, authed);
    if (status == 401 && authed && !retried && await _refresh()) {
      return _send(method, path, body: body, retried: true);
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
    bool authed,
  ) async {
    Object? lastError;
    for (var tries = 0; tries < _bases.length; tries++) {
      final base = _bases[(_base + tries) % _bases.length];
      try {
        final req = await _http
            .openUrl(method, Uri.parse('$base/api/v1$path'))
            .timeout(_timeout);
        _deviceHeaders.forEach(req.headers.set);
        if (authed) {
          req.headers.set('authorization', 'Bearer ${tokens.access}');
        }
        if (body != null) {
          req.headers.contentType = ContentType.json;
          req.add(utf8.encode(jsonEncode(body)));
        }
        final res = await req.close().timeout(_timeout);
        final text = await res.transform(utf8.decoder).join().timeout(_timeout);
        _base = (_base + tries) % _bases.length;
        trace?.call(method, path, res.statusCode);
        dynamic data;
        if (text.isNotEmpty) {
          try {
            data = jsonDecode(text);
          } on FormatException {
            data = null;
          }
        }
        return (res.statusCode, data);
      } on SocketException catch (e) {
        lastError = e;
      } on TimeoutException catch (e) {
        lastError = e;
      } on HttpException catch (e) {
        lastError = e;
      } on HandshakeException catch (e) {
        lastError = e;
      }
    }
    throw ApiError(
      0,
      'offline',
      lastError is HandshakeException
          ? 'The server’s certificate was not trusted.'
          : 'Can’t reach the server. Check the connection and try again.',
    );
  }

  static ApiError _error(int status, dynamic data) {
    var code = 'http_$status', message = '';
    if (data is Map && data['detail'] is Map) {
      final d = data['detail'] as Map;
      code = (d['code'] as String?) ?? code;
      message = (d['message'] as String?) ?? '';
    }
    return ApiError(status, code, _english[code] ?? message);
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
  };
}
