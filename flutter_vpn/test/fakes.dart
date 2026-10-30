import 'dart:async';
import 'dart:typed_data';

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
    servers = null;
  }

  String? servers;
  @override
  Future<String?> cachedServers() async => servers;
  @override
  Future<void> cacheServers(String json) async => servers = json;
}

/// Records every call and answers with Worker-shaped bodies.
class FakeApi extends ApiClient {
  FakeApi(MemoryTokens super.tokens) : super(bases: 'https://api.test');

  final calls = <String>[];
  final authedCalls = <String>[];
  bool active = true;
  String? trialError;

  /// No plan until a trial starts.
  bool hasPlan = true;

  /// The trial is built, but its answer is lost on the way back.
  bool loseTrialAnswer = false;

  /// The Worker can't be reached for the server list.
  bool serversOffline = false;

  /// More exits after the usual three, for every FakeApi made after it is set.
  static List<Map<String, Object>> extraServers = [];
  final reports = <Map<String, Object?>>[];
  final orderBodies = <Map<String, Object?>>[];

  Map<String, Object?> order(String method) => {
    'id': 7,
    'kind': 'plan',
    'plan_name': 'Annual',
    'amount_toman': 459037,
    'method': method,
    'status': 'pending',
    'card': method == 'card'
        ? {
            'number': '6037991234567893',
            'holder': 'علی',
            'color1': '#0B3B8C',
            'color2': '#1E6FD9',
            'amount_rial': 4590370,
            'auto': false,
          }
        : null,
    'coin': method == 'coin'
        ? {
            'symbol': 'TRX',
            'name': 'TRON',
            'network': 'TRON (TRC20)',
            'color': '#EB0029',
            'amount': '1450.123',
            'address': 'TXYZexampleaddress000000000000000',
            'seconds_left': 1800,
            'auto': true,
          }
        : null,
  };

  /// Reports behind the one ranked exit; 8 or more makes it a sure pick.
  int rankReports = 41;

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
        return {
          'support_url': '',
          'announcement': '',
          'card_enabled': true,
          'card_auto': false,
          'crypto_enabled': false,
          'coins': [
            {
              'id': 'trx',
              'symbol': 'TRX',
              'name': 'TRON',
              'fa': 'ترون',
              'network': 'TRON (TRC20)',
              'color': '#EB0029',
              'auto': true,
            },
          ],
          'min_topup_toman': 50000,
          'referral_percent': 10,
        };
      case 'POST /orders':
        orderBodies.add(body ?? const {});
        return order(body?['method'] as String? ?? 'card');
      case 'GET /me':
        return {
          'id': 1,
          'email': 'ali@example.com',
          'wallet_balance': 0,
          'referral_code': 'X1',
          'trial_available': !hasPlan,
          'subscription': hasPlan ? sub : null,
        };
      case 'GET /devices':
        return [
          {'id': 1, 'device_id': 'd' * 32, 'model': 'Pleat', 'last_seen': null},
        ];
      case 'GET /vpn/servers':
        if (serversOffline) {
          throw ApiError(0, 'offline', 'Can’t reach the server.');
        }
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
          ...extraServers,
        ];
      case 'GET /net/rank':
        return {
          'servers': {
            'k53ca1f60': {'score': 0.968, 'n': rankReports, 'ms': 95},
          },
        };
      case 'GET /vpn':
        return {'subscription': sub};
      case 'POST /trial':
        if (trialError != null) throw ApiError(400, 'trial_used', trialError!);
        hasPlan = true;
        if (loseTrialAnswer) {
          throw ApiError(0, 'offline', 'Can’t reach the server.');
        }
        return {};
      case 'POST /net/report':
        reports.addAll(
          ((body?['results'] as List?) ?? const [])
              .cast<Map<String, Object?>>(),
        );
        return {'ok': true};
    }
    if (m == 'GET' && path == '/orders/7') return order('card');
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
  Future<void> start(String config) async => started = config;
  @override
  Future<TunnelState> current() async => TunnelState.down;
  @override
  Future<void> stop() async => stopped = true;

  /// Ping per outbound address; a missing entry means no answer.
  Map<String, int> pings = {};
  int? live = 80;
  bool geo = true;
  final List<String> pinged = [];

  @override
  Future<int?> ping(String config) async {
    for (final e in pings.entries) {
      if (config.contains('"${e.key}"')) {
        pinged.add(e.key);
        return e.value;
      }
    }
    return null;
  }

  @override
  Future<int?> delay() async => live;
  @override
  Future<bool> hasGeo() async => geo;
  ({bool alwaysOn, bool lockdown})? guard;
  @override
  Future<({bool alwaysOn, bool lockdown})?> policy() async => guard;
  @override
  Future<({String model, String release, String hwid})?> device() async =>
      (model: 'Test Phone', release: '14', hwid: '');
  @override
  Future<String?> engineError() async => null;
  final opened = <String>[];
  final shared = <String>[];
  Uint8List? photo;
  @override
  Future<bool> openUrl(String url) async {
    opened.add(url);
    return true;
  }

  @override
  Future<void> share(String text) async => shared.add(text);
  @override
  Future<Uint8List?> pickImage() async => photo;
  @override
  void listen(void Function(TunnelState) onState) => _on = onState;
  void emit(TunnelState s) => _on?.call(s);
  @override
  void dispose() {}
}
