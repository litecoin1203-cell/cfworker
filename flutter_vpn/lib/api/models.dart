/// Parsers for the Worker's JSON. One per shape; field names follow the
/// backend contract.
library;

import 'dart:convert';

import 'countries.dart';

int _int(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
int? _intOrNull(Object? v) => v == null ? null : _int(v);
String _str(Object? v) => v == null ? '' : '$v';
DateTime? _date(Object? v) => v == null ? null : DateTime.tryParse('$v');

class Subscription {
  Subscription.fromJson(Map<String, dynamic> j)
    : active = j['active'] == true,
      status = _str(j['status']),
      stopReason = j['stop_reason'] as String?,
      planName = _str(j['plan_name']),
      expiresAt = _date(j['expires_at']),
      daysLeft = _intOrNull(j['days_left']),
      unlimitedTime = j['unlimited_time'] == true,
      unlimitedData = j['unlimited_data'] == true,
      dataLimitBytes = _int(j['data_limit_bytes']),
      usedBytes = _int(j['used_bytes']),
      usedPercent = _intOrNull(j['used_percent']),
      deviceLimit = _int(j['device_limit']);

  final bool active;

  /// active | missing | limited | expired | disabled
  final String status;
  final String? stopReason;
  final String planName;
  final DateTime? expiresAt;
  final int? daysLeft;
  final bool unlimitedTime, unlimitedData;
  final int dataLimitBytes, usedBytes;
  final int? usedPercent;
  final int deviceLimit;

  String get statusLine => switch (status) {
    'active' => 'Active',
    'limited' => 'Data used up',
    'expired' => 'Expired',
    'disabled' => 'Paused by support',
    'missing' => 'Not found on the servers',
    _ => status,
  };
}

class Me {
  Me.fromJson(Map<String, dynamic> j)
    : id = _int(j['id']),
      email = _str(j['email']),
      wallet = _int(j['wallet_balance']),
      referralCode = _str(j['referral_code']),
      trialAvailable = j['trial_available'] == true,
      subscription = j['subscription'] is Map
          ? Subscription.fromJson(
              (j['subscription'] as Map).cast<String, dynamic>(),
            )
          : null;

  final int id;
  final String email;

  /// Toman.
  final int wallet;
  final String referralCode;
  final bool trialAvailable;
  final Subscription? subscription;
}

class PlanInfo {
  PlanInfo.fromJson(Map<String, dynamic> j)
    : id = _int(j['id']),
      name = _str(j['name']),
      durationDays = _int(j['duration_days']),
      dataLimitGb = _int(j['data_limit_gb']),
      deviceLimit = _int(j['device_limit']),
      priceToman = _int(j['price_toman']),
      oldPriceToman = _int(j['old_price_toman']),
      savePercent = _int(j['save_percent']),
      badge = _str(j['badge']),
      description = _str(j['description']),
      trialDays = _int(j['trial_days']);

  final int id;
  final String name, badge, description;
  final int durationDays, dataLimitGb, deviceLimit;
  final int priceToman, oldPriceToman, savePercent, trialDays;
}

/// One config from `/vpn/servers`. [link] stays in memory for the tunnel
/// and is never shown, logged or put in an accessibility label.
class Server {
  Server._(this.index, this.name, this.cc, this.protocol, this.link, this.key);

  factory Server.fromJson(Map<String, dynamic> j) {
    final link = _str(j['link']);
    final end = endpointOf(link);
    final name = _str(j['name']);
    var cc = _str(j['country_code']).toUpperCase();
    if (cc.isEmpty) cc = countryFromRemark(name);
    if (cc.isEmpty && end != null) cc = countryFromHost(end.host);
    return Server._(
      _int(j['index']),
      name,
      cc,
      _str(j['protocol']).toLowerCase(),
      link,
      end == null ? 'i${_int(j['index'])}' : serverKey(end),
    );
  }

  final int index;

  /// The Worker's label without its flag, e.g. "DE 2".
  final String name;

  /// ISO country code, '' when the remark names none.
  final String cc;
  final String protocol, link;

  /// Anonymous stable key, the same `k` the Cloud Gold app reports.
  final String key;

  String get country => cc.isEmpty ? 'Unknown country' : countryName(cc);
  String get flag => flagOf(cc);
  String get protocolLabel => switch (protocol) {
    'vless' => 'VLESS',
    'vmess' => 'VMess',
    'trojan' => 'Trojan',
    'ss' => 'Shadowsocks',
    'hy2' || 'hysteria2' => 'Hysteria2',
    'wireguard' => 'WireGuard',
    'tuic' => 'TUIC',
    _ => protocol.toUpperCase(),
  };
}

class Endpoint {
  const Endpoint(this.type, this.host, this.port);
  final String type, host, port;
}

/// Protocol, host and port of a share link, the way v2rayNG stores them.
Endpoint? endpointOf(String link) {
  final i = link.indexOf('://');
  if (i <= 0) return null;
  final scheme = link.substring(0, i).toLowerCase();
  final type = switch (scheme) {
    'ss' => 'shadowsocks',
    'hy2' => 'hysteria2',
    _ => scheme,
  };
  var rest = link.substring(i + 3);
  if (scheme == 'vmess') {
    try {
      var raw = rest.split('#').first;
      raw += '=' * ((4 - raw.length % 4) % 4);
      final j = jsonDecode(
        utf8.decode(
          base64.decode(raw.replaceAll('-', '+').replaceAll('_', '/')),
        ),
      );
      if (j is! Map) return null;
      return Endpoint(type, _str(j['add']), _str(j['port']));
    } on FormatException {
      return null;
    }
  }
  rest = rest.split('#').first.split('?').first.split('/').first;
  final at = rest.lastIndexOf('@');
  var hostPort = at >= 0 ? rest.substring(at + 1) : rest;
  if (at < 0 && scheme == 'ss') {
    // ss://base64(method:pass@host:port)
    try {
      var raw = rest;
      raw += '=' * ((4 - raw.length % 4) % 4);
      final dec = utf8.decode(base64.decode(raw));
      hostPort = dec.substring(dec.lastIndexOf('@') + 1);
    } on FormatException {
      return null;
    }
  }
  String host, port;
  if (hostPort.startsWith('[')) {
    final close = hostPort.indexOf(']');
    host = hostPort.substring(1, close);
    port = hostPort.substring(close + 1).replaceFirst(':', '');
  } else {
    final c = hostPort.lastIndexOf(':');
    host = c >= 0 ? hostPort.substring(0, c) : hostPort;
    port = c >= 0 ? hostPort.substring(c + 1) : '';
  }
  return Endpoint(type, host, port);
}

/// Keys the Worker accepts in `/net/report` (its KEY_RE).
final serverKeyPattern = RegExp(r'^[a-z0-9]{6,16}$');

/// FNV-1a of "type|host|port", identical to `CgVpn.serverKey`.
String serverKey(Endpoint e) {
  var h = 0x811c9dc5;
  for (final c in '${e.type}|${e.host}|${e.port}'.toLowerCase().codeUnits) {
    h ^= c;
    h = (h * 0x01000193) & 0xFFFFFFFF;
  }
  return 'k${h.toRadixString(16).padLeft(8, '0')}';
}

/// What other people on this network measured for one server.
class Rank {
  Rank.fromJson(Map<String, dynamic> j)
    : score = (j['score'] as num?)?.toDouble() ?? 0,
      ms = _int(j['ms']),
      reports = _int(j['n']);
  final double score;
  final int ms, reports;
}

Map<String, Rank> ranksFrom(dynamic data) {
  final s = data is Map ? data['servers'] : null;
  if (s is! Map) return const {};
  return {
    for (final e in s.entries)
      if (e.value is Map)
        '${e.key}': Rank.fromJson((e.value as Map).cast<String, dynamic>()),
  };
}

class Device {
  Device.fromJson(Map<String, dynamic> j, String thisDevice)
    : id = _int(j['id']),
      model = _str(j['model']),
      lastSeen = _date(j['last_seen']),
      current = _str(j['device_id']) == thisDevice;
  final int id;
  final String model;
  final DateTime? lastSeen;
  final bool current;
}

class AppConfig {
  AppConfig.fromJson(Map<String, dynamic> j)
    : supportUrl = _str(j['support_url']),
      announcement = _str(j['announcement']);
  const AppConfig.empty() : supportUrl = '', announcement = '';
  final String supportUrl, announcement;
}
