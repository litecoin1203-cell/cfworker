/// Builds the Xray core config for one share link. The core listens on a
/// local SOCKS port; the native tun (hev-socks5-tunnel) feeds it every
/// packet of the phone, so DNS and IPv6 travel through the exit too.
///
/// Throws [FormatException] for a link the core can't run.
library;

import 'dart:convert';

const socksPort = 10808;

/// Private and link-local ranges stay on the local network.
const _privateCidrs = [
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

/// [localDirect]: Iranian sites and IPs leave directly (faster, often
/// blocked from abroad, and they don't spend plan data), and QUIC is
/// refused so apps fall back to TCP, which runs steadier through the exit.
/// The same rules as the Cloud Gold app's default; they need the geo files.
///
/// [forTest]: no inbound, for a throw-away core that only measures delay.
String xrayConfig(
  String link, {
  bool localDirect = false,
  bool forTest = false,
}) {
  final proxy = outboundOf(link);
  return jsonEncode({
    'log': {'loglevel': 'warning'},
    'dns': {
      'servers': ['1.1.1.1', '8.8.8.8'],
      'queryStrategy': 'UseIP',
    },
    'inbounds': [
      if (!forTest)
        {
          'tag': 'socks',
          'listen': '127.0.0.1',
          'port': socksPort,
          'protocol': 'socks',
          'settings': {'auth': 'noauth', 'udp': true},
          'sniffing': {
            'enabled': true,
            'destOverride': ['http', 'tls', 'quic'],
            'routeOnly': true,
          },
        },
    ],
    'outbounds': [
      proxy,
      {'tag': 'direct', 'protocol': 'freedom'},
      {'tag': 'block', 'protocol': 'blackhole'},
    ],
    'routing': {
      'domainStrategy': 'AsIs',
      'rules': [
        {'type': 'field', 'ip': _privateCidrs, 'outboundTag': 'direct'},
        if (localDirect) ...[
          {
            'type': 'field',
            'network': 'udp',
            'port': '443',
            'outboundTag': 'block',
          },
          {
            'type': 'field',
            'domain': ['domain:ir', 'geosite:category-ir'],
            'outboundTag': 'direct',
          },
          {
            'type': 'field',
            'ip': ['geoip:ir'],
            'outboundTag': 'direct',
          },
        ],
      ],
    },
  });
}

Map<String, Object?> outboundOf(String link) {
  final i = link.indexOf('://');
  if (i <= 0) throw const FormatException('not a share link');
  final scheme = link.substring(0, i).toLowerCase();
  return switch (scheme) {
    'vless' => _vless(Uri.parse(link)),
    'trojan' => _trojan(Uri.parse(link)),
    'vmess' => _vmess(link.substring(i + 3)),
    'ss' => _shadowsocks(link),
    _ => throw FormatException('unsupported protocol $scheme'),
  };
}

int _port(Object? p) {
  final v = int.tryParse('${p ?? ''}');
  if (v == null || v <= 0 || v > 65535) {
    throw const FormatException('bad port');
  }
  return v;
}

String _host(Uri u) {
  if (u.host.isEmpty) throw const FormatException('no host');
  return u.host;
}

Map<String, Object?> _vless(Uri u) {
  final q = u.queryParameters;
  return {
    'tag': 'proxy',
    'protocol': 'vless',
    'settings': {
      'vnext': [
        {
          'address': _host(u),
          'port': _port(u.port),
          'users': [
            {
              'id': Uri.decodeComponent(u.userInfo),
              'encryption': q['encryption'] ?? 'none',
              'flow': ?q['flow'],
            },
          ],
        },
      ],
    },
    'streamSettings': _stream(q, _host(u)),
  };
}

Map<String, Object?> _trojan(Uri u) {
  final q = u.queryParameters;
  return {
    'tag': 'proxy',
    'protocol': 'trojan',
    'settings': {
      'servers': [
        {
          'address': _host(u),
          'port': _port(u.port),
          'password': Uri.decodeComponent(u.userInfo),
        },
      ],
    },
    'streamSettings': _stream({'security': 'tls', ...q}, _host(u)),
  };
}

Map<String, Object?> _vmess(String body) {
  var raw = body.split('#').first.trim();
  raw = raw.replaceAll('-', '+').replaceAll('_', '/');
  raw += '=' * ((4 - raw.length % 4) % 4);
  final j = jsonDecode(utf8.decode(base64.decode(raw)));
  if (j is! Map) throw const FormatException('bad vmess');
  String s(String k) => '${j[k] ?? ''}';
  final address = s('add');
  if (address.isEmpty) throw const FormatException('no host');
  final q = <String, String>{
    'type': s('net').isEmpty ? 'tcp' : s('net'),
    'security': s('tls'),
    if (s('host').isNotEmpty) 'host': s('host'),
    if (s('path').isNotEmpty) 'path': s('path'),
    if (s('sni').isNotEmpty) 'sni': s('sni'),
    if (s('alpn').isNotEmpty) 'alpn': s('alpn'),
    if (s('fp').isNotEmpty) 'fp': s('fp'),
    if (s('type').isNotEmpty) 'headerType': s('type'),
    if (s('net') == 'grpc' && s('path').isNotEmpty) 'serviceName': s('path'),
  };
  return {
    'tag': 'proxy',
    'protocol': 'vmess',
    'settings': {
      'vnext': [
        {
          'address': address,
          'port': _port(j['port']),
          'users': [
            {
              'id': s('id'),
              'alterId': int.tryParse(s('aid')) ?? 0,
              'security': s('scy').isEmpty ? 'auto' : s('scy'),
            },
          ],
        },
      ],
    },
    'streamSettings': _stream(q, address),
  };
}

Map<String, Object?> _shadowsocks(String link) {
  var body = link.substring(5).split('#').first;
  String userinfo, hostPort;
  final at = body.lastIndexOf('@');
  if (at >= 0) {
    userinfo = body.substring(0, at);
    hostPort = body.substring(at + 1).split('?').first.split('/').first;
    if (!userinfo.contains(':')) userinfo = _b64(Uri.decodeComponent(userinfo));
  } else {
    final dec = _b64(body.split('?').first);
    final a = dec.lastIndexOf('@');
    if (a < 0) throw const FormatException('bad ss');
    userinfo = dec.substring(0, a);
    hostPort = dec.substring(a + 1);
  }
  final colon = userinfo.indexOf(':');
  if (colon < 0) throw const FormatException('bad ss');
  final u = Uri.parse('ss://x@$hostPort');
  return {
    'tag': 'proxy',
    'protocol': 'shadowsocks',
    'settings': {
      'servers': [
        {
          'address': _host(u),
          'port': _port(u.port),
          'method': userinfo.substring(0, colon),
          'password': Uri.decodeComponent(userinfo.substring(colon + 1)),
        },
      ],
    },
  };
}

String _b64(String s) {
  var raw = s.replaceAll('-', '+').replaceAll('_', '/');
  raw += '=' * ((4 - raw.length % 4) % 4);
  return utf8.decode(base64.decode(raw));
}

/// Transport and security, from the share-link query (v2rayNG's names).
Map<String, Object?> _stream(Map<String, String> q, String address) {
  final net = (q['type'] ?? 'tcp').toLowerCase();
  final security = (q['security'] ?? 'none').toLowerCase();
  final sni = q['sni'] ?? q['peer'] ?? q['host'] ?? address;
  final alpn = q['alpn']?.split(',').where((a) => a.isNotEmpty).toList();
  final out = <String, Object?>{
    'network': net == 'h2' ? 'http' : net,
    'security': security == 'none' || security.isEmpty ? 'none' : security,
  };
  if (security == 'tls') {
    out['tlsSettings'] = {
      'serverName': sni,
      'fingerprint': ?q['fp'],
      if (alpn != null && alpn.isNotEmpty) 'alpn': alpn,
      if (q['allowInsecure'] == '1' || q['insecure'] == '1')
        'allowInsecure': true,
      // Encrypted Client Hello hides the SNI from filters; a host that
      // sets it often only answers with it.
      if ((q['ech'] ?? '').isNotEmpty) 'echConfigList': q['ech'],
    };
  } else if (security == 'reality') {
    out['realitySettings'] = {
      'serverName': sni,
      'fingerprint': q['fp'] ?? 'chrome',
      'publicKey': q['pbk'] ?? '',
      'shortId': q['sid'] ?? '',
      'spiderX': q['spx'] ?? '',
      if ((q['pqv'] ?? '').isNotEmpty) 'mldsa65Verify': q['pqv'],
    };
  }
  final path = q['path'];
  final host = q['host'];
  switch (out['network']) {
    case 'ws':
      out['wsSettings'] = {'path': ?path, 'host': ?host};
    case 'grpc':
      out['grpcSettings'] = {
        'serviceName': q['serviceName'] ?? path ?? '',
        'multiMode': q['mode'] == 'multi',
        if ((q['authority'] ?? '').isNotEmpty) 'authority': q['authority'],
      };
    case 'httpupgrade':
      out['httpupgradeSettings'] = {'path': ?path, 'host': ?host};
    case 'xhttp' || 'splithttp':
      out['network'] = 'xhttp';
      out['xhttpSettings'] = {
        'path': ?path,
        'host': ?host,
        'mode': q['mode'] ?? 'auto',
        // xmux, padding and the rest of the host's XHTTP settings, as JSON.
        'extra': ?_json(q['extra']),
      };
    case 'http':
      out['httpSettings'] = {
        'path': ?path,
        if (host != null) 'host': host.split(','),
      };
    case 'tcp' when q['headerType'] == 'http':
      out['tcpSettings'] = {
        'header': {
          'type': 'http',
          'request': {
            'path': [path ?? '/'],
            if (host != null)
              'headers': {
                'Host': [host],
              },
          },
        },
      };
  }
  return out;
}

Object? _json(String? s) {
  if (s == null || s.isEmpty) return null;
  try {
    final v = jsonDecode(s);
    return v is Map ? v : null;
  } on FormatException {
    return null;
  }
}
