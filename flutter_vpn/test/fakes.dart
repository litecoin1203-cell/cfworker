import 'dart:async';

import 'package:pleat/api/client.dart';
import 'package:pleat/state/tunnel.dart';

/// Tokens in memory instead of the Keystore.
class MemoryTokens extends TokenStore {
  MemoryTokens({bool signedIn = false}) {
    deviceId = 'd' * 32;
    if (signedIn) {
      access = 'a';
      refresh = 'r';
    }
  }
  @override
  Future<void> load() async {}
  @override
  Future<void> save(String a, String r) async {
    access = a;
    refresh = r;
  }

  @override
  Future<void> clear() async {
    access = null;
    refresh = null;
  }
}

/// Records every call and answers with Worker-shaped bodies.
class FakeApi extends ApiClient {
  FakeApi(MemoryTokens super.tokens) : super(bases: 'https://api.test');

  final calls = <String>[];
  final authedCalls = <String>[];
  bool active = true;
  String? trialError;

  Map<String, Object?> get sub => {
    'active': active,
    'status': active ? 'active' : 'limited',
    'plan_name': 'Monthly test',
    'days_left': 12,
    'unlimited_time': false,
    'unlimited_data': false,
    'data_limit_bytes': 50000000000,
    'used_bytes': 41000000000,
    'used_percent': 82,
    'device_limit': 2,
  };

  dynamic _answer(String m, String path, Map<String, Object?>? body) {
    calls.add('$m $path');
    if (tokens.access != null && !path.startsWith('/auth/')) {
      authedCalls.add('$m $path');
    }
    switch ('$m $path') {
      case 'POST /auth/login':
        if (body?['password'] != 'password1') {
          throw ApiError(401, 'bad_credentials', 'Email or password is wrong.');
        }
        return {'access_token': 'A', 'refresh_token': 'R'};
      case 'GET /plans':
        return [
          {
            'id': 2,
            'name': 'Annual',
            'duration_days': 365,
            'device_limit': 3,
            'price_toman': 459000,
            'trial_days': 7,
          },
        ];
      case 'GET /app-config':
        return {'support_url': '', 'announcement': ''};
      case 'GET /me':
        return {
          'id': 1,
          'email': 'ali@example.com',
          'wallet_balance': 0,
          'referral_code': 'X1',
          'trial_available': true,
          'subscription': sub,
        };
      case 'GET /devices':
        return [
          {'id': 1, 'device_id': 'd' * 32, 'model': 'Pleat', 'last_seen': null},
        ];
      case 'GET /vpn/servers':
        return [
          {
            'index': 0,
            'name': 'NL 1',
            'country_code': 'NL',
            'protocol': 'vless',
            'link': 'vless://u@nl1.example.com:443?type=tcp#x',
          },
          {
            'index': 1,
            'name': 'DE 1',
            'country_code': 'DE',
            'protocol': 'vless',
            'link': 'vless://u@de1.example.com:443?type=ws#x',
          },
          {
            'index': 2,
            'name': 'Server 3',
            'country_code': '',
            'protocol': 'trojan',
            'link': 'trojan://p@us1.example.com:443#x',
          },
        ];
      case 'GET /net/rank':
        return {
          'servers': {
            'k53ca1f60': {'score': 0.968, 'n': 41, 'ms': 95},
          },
        };
      case 'GET /vpn':
        return {'subscription': sub};
      case 'POST /trial':
        if (trialError != null) throw ApiError(400, 'trial_used', trialError!);
        return {};
    }
    throw ApiError(404, 'not_found', 'Not found.');
  }

  @override
  Future<dynamic> get(String path) async => _answer('GET', path, null);
  @override
  Future<dynamic> post(String path, [Map<String, Object?>? body]) async =>
      _answer('POST', path, body);
  @override
  Future<dynamic> delete(String path) async => _answer('DELETE', path, null);
}

/// A platform tunnel the test drives by hand.
class FakeTunnel extends Tunnel {
  void Function(TunnelState)? _on;
  String? started;
  bool stopped = false;

  @override
  Future<bool> available() async => true;
  @override
  Future<void> start(String link) async => started = link;
  @override
  Future<void> stop() async => stopped = true;
  @override
  void listen(void Function(TunnelState) onState) => _on = onState;
  void emit(TunnelState s) => _on?.call(s);
  @override
  void dispose() {}
}
