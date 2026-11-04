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
  // WireGuard looks its server's name up with the core's own DNS, whose
  // queries leave through the first outbound: WireGuard itself, which can't
  // send anything before it knows where its server is. That name is asked
  // of the phone's own resolver instead (Pleat is outside its tunnel), so
  // an exit given by name no longer times out while one given by IP works.
  final wgHost = _wireguardHost(proxy);
  return jsonEncode({
    'log': {'loglevel': 'warning'},
    'dns': {
      'servers': [
        if (wgHost != null)
          {
            'address': 'localhost',
            'domains': ['full:$wgHost'],
            'skipFallback': true,
          },
        '1.1.1.1',
        '8.8.8.8',
      ],
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

/// The WireGuard server's name, when the link gives a name and not an IP.
String? _wireguardHost(Map<String, Object?> proxy) {
  if (proxy['protocol'] != 'wireguard') return null;
  final peers = (proxy['settings'] as Map)['peers'] as List;
  final endpoint = '${(peers.first as Map)['endpoint']}';
  if (endpoint.startsWith('[')) return null;
  final host = endpoint.substring(0, endpoint.lastIndexOf(':'));
  return RegExp(r'^\d{1,3}(\.\d{1,3}){3}$').hasMatch(host) ? null : host;
}

Map<String, Object?> outboundOf(String link) {
  final i = link.indexOf('://');
  if (i <= 0) throw const FormatException('not a share link');
  final scheme = link.substring(0, i).toLowerCase();
  return switch (scheme) {
    'vless' => _vless(Uri.parse(link), _query(link)),
    'trojan' => _trojan(Uri.parse(link), _query(link)),
    'vmess' => _vmess(link.substring(i + 3)),
    'ss' => _shadowsocks(link),
    'hysteria2' || 'hy2' => _hysteria2(link),
    'wireguard' || 'wg' => _wireguard(link),
    _ => throw FormatException('unsupported protocol $scheme'),
  };
}

/// `scheme://userinfo@host:port/?query#remark` split by hand: Hysteria 2
/// links may carry a port range in place of the port ("443,20000-30000"),
/// which [Uri.parse] refuses.
({String user, String host, String ports}) _authority(String link) {
  var rest = link.substring(link.indexOf('://') + 3).split('#').first;
  rest = rest.split('?').first;
  final slash = rest.indexOf('/');
  if (slash >= 0) rest = rest.substring(0, slash);
  final at = rest.lastIndexOf('@');
  final user = at >= 0 ? Uri.decodeComponent(rest.substring(0, at)) : '';
  final hostPort = rest.substring(at + 1);
  String host, ports;
  if (hostPort.startsWith('[')) {
    final close = hostPort.indexOf(']');
    if (close < 0) throw const FormatException('bad host');
    host = hostPort.substring(1, close);
    ports = hostPort.substring(close + 1).replaceFirst(':', '');
  } else {
    final c = hostPort.lastIndexOf(':');
    if (c < 0) throw const FormatException('bad port');
    host = hostPort.substring(0, c);
    ports = hostPort.substring(c + 1);
  }
  if (host.isEmpty) throw const FormatException('no host');
  return (user: user, host: host, ports: ports);
}

/// Hysteria 2 over QUIC, the way Rebecca's own Xray subscription and
/// v2rayNG build it: TLS on the hysteria transport, Salamander obfuscation
/// and port hopping as the core's UDP masks.
Map<String, Object?> _hysteria2(String link) {
  final a = _authority(link);
  final q = _query(link);
  // "443,20000-30000": the first port is the server's, all of them hop.
  final first = RegExp(r'^\d+').firstMatch(a.ports)?.group(0);
  final hop = a.ports.contains(RegExp(r'[,-]')) ? a.ports : q['mport'];
  // pinSHA256 and insecure are read by [_stream] like on any TLS link.
  final stream = _stream({...q, 'type': 'tcp', 'security': 'tls'}, a.host);
  stream['network'] = 'hysteria';
  stream['hysteriaSettings'] = {
    'version': 2,
    if (a.user.isNotEmpty) 'auth': a.user,
    'udpIdleTimeout': 60,
  };
  final mask = <String, Object?>{
    ...?(stream['finalmask'] as Map<String, Object?>?),
  };
  final obfs = q['obfs'];
  if (obfs != null && obfs != 'none') {
    mask['udp'] = [
      {
        'type': obfs == 'gecko' ? 'salamander' : obfs,
        'settings': {
          'password': q['obfs-password'] ?? '',
          if (obfs == 'gecko') 'packetSize': '512-1200',
        },
      },
    ];
  }
  if (hop != null) {
    mask['quicParams'] = {
      'udpHop': {'ports': hop},
    };
  }
  if (mask.isNotEmpty) stream['finalmask'] = mask;
  return {
    'tag': 'proxy',
    'protocol': 'hysteria',
    'settings': {'version': 2, 'address': a.host, 'port': _port(first)},
    'streamSettings': stream,
  };
}

/// WireGuard as the core runs it in user space (no kernel tun on a phone),
/// from the `wireguard://privatekey@host:port?publickey=&address=` link
/// Rebecca and v2rayNG share.
Map<String, Object?> _wireguard(String link) {
  final a = _authority(link);
  final q = _query(link);
  final port = _port(a.ports);
  if (a.user.isEmpty) throw const FormatException('no private key');
  final peerKey = q['publickey'] ?? q['publicKey'] ?? q['peer_public_key'];
  if (peerKey == null) throw const FormatException('no public key');
  List<String> list(String? s) => (s ?? '')
      .split(',')
      .map((e) => e.trim())
      .where((e) => e.isNotEmpty)
      .toList();
  final reserved = list(q['reserved']).map(int.tryParse).toList();
  final keepAlive = int.tryParse(q['keepalive'] ?? '');
  final address = list(q['address'] ?? q['ip']);
  return {
    'tag': 'proxy',
    'protocol': 'wireguard',
    'settings': {
      'secretKey': a.user,
      'noKernelTun': true,
      // Most Iranian networks have no IPv6: try the server's IPv4 first.
      'domainStrategy': 'ForceIPv4v6',
      // the tunnel's own address on the server's network; the core picks
      // a placeholder when the link names none
      if (address.isNotEmpty) 'address': address,
      'mtu': int.tryParse(q['mtu'] ?? '') ?? 1420,
      if (reserved.length == 3 && reserved.every((b) => b != null && b < 256))
        'reserved': reserved,
      'peers': [
        {
          'publicKey': peerKey,
          'preSharedKey': ?(q['presharedkey'] ?? q['preSharedKey']),
          'endpoint': a.host.contains(':')
              ? '[${a.host}]:$port'
              : '${a.host}:$port',
          if (keepAlive != null && keepAlive > 0) 'keepAlive': keepAlive,
          // Everything goes through the exit, IPv6 included, whatever the
          // panel's peer list says: the phone has no other route out.
          'allowedIPs': ['0.0.0.0/0', '::/0'],
        },
      ],
    },
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

/// The link's query the way v2rayNG reads it: a '+' stays a '+' (Dart's
/// own parser turns it into a space, which breaks base64 and JSON values),
/// and an empty value counts as absent, since the panel sends `sni=`,
/// `host=` and the like even when they aren't set.
Map<String, String> _query(String link) {
  var raw = link.split('#').first;
  final i = raw.indexOf('?');
  if (i < 0) return const {};
  raw = raw.substring(i + 1);
  final out = <String, String>{};
  for (final pair in raw.split('&')) {
    final eq = pair.indexOf('=');
    if (eq <= 0) continue;
    String dec(String v) {
      try {
        return Uri.decodeComponent(v.replaceAll('+', '%2B'));
      } on ArgumentError {
        return v;
      }
    }

    final v = dec(pair.substring(eq + 1)).trim();
    if (v.isNotEmpty) out[dec(pair.substring(0, eq))] = v;
  }
  return out;
}

Map<String, Object?> _vless(Uri u, Map<String, String> q) {
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

Map<String, Object?> _trojan(Uri u, Map<String, String> q) {
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
  final net = s('net').isEmpty ? 'tcp' : s('net');
  // vmess carries the gRPC and XHTTP mode in "type", as v2rayNG reads it.
  final modeInType = net == 'grpc' || net == 'xhttp' || net == 'splithttp';
  final q = <String, String>{
    'type': net,
    'security': s('tls'),
    for (final k in [
      'host',
      'path',
      'sni',
      'alpn',
      'fp',
      'pcs',
      'vcn',
      'ech',
      'insecure',
      'allowInsecure',
      'extra',
      'fm',
    ])
      if (s(k).isNotEmpty) k: s(k),
    if (s('type').isNotEmpty) modeInType ? 'mode' : 'headerType': s('type'),
    if (net == 'grpc' && s('path').isNotEmpty) 'serviceName': s('path'),
    if (net == 'grpc' && s('host').isNotEmpty) 'authority': s('host'),
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
  // The name the transport itself presents, which v2rayNG falls back to
  // when the link has no sni: gRPC's authority, else the host header.
  final hostName = net == 'grpc'
      ? q['authority']
      : q['host']?.split(',').first.trim();
  final sni =
      q['sni'] ??
      q['peer'] ??
      (_isDomain(hostName)
          ? hostName
          : _isDomain(address)
          ? address
          : hostName);
  // WebSocket and HTTPUpgrade only work over HTTP/1.1: offered h2, a CDN
  // picks it and the upgrade dies ("closed pipe"), so h2/h3 are dropped.
  final http1Only = net == 'ws' || net == 'httpupgrade';
  final alpn = q['alpn']
      ?.split(',')
      .map((a) => a.trim())
      .where((a) => a.isNotEmpty)
      .where((a) => !http1Only || a == 'http/1.1')
      .toList();
  final pinned = q['pcs'] ?? q['pinSHA256'];
  final out = <String, Object?>{
    'network': net == 'h2' ? 'http' : net,
    'security': security == 'tls' || security == 'reality' ? security : 'none',
  };
  if (security == 'tls') {
    out['tlsSettings'] = {
      'serverName': ?sni,
      'fingerprint': ?q['fp'],
      if (alpn != null && alpn.isNotEmpty) 'alpn': alpn,
      // A pinned certificate replaces the usual checks, so a host behind a
      // CDN can present another site's name (domain fronting); without it
      // such an exit fails the handshake.
      'pinnedPeerCertSha256': ?pinned,
      'verifyPeerCertByName': ?q['vcn'],
      if (pinned == null &&
          [
            'insecure',
            'allowInsecure',
            'allow_insecure',
          ].any((k) => q[k] == '1' || q[k] == 'true'))
        'allowInsecure': true,
      // Encrypted Client Hello hides the SNI from filters; a host that
      // sets it often only answers with it.
      'echConfigList': ?q['ech'],
    };
  } else if (security == 'reality') {
    out['realitySettings'] = {
      'serverName': ?sni,
      'fingerprint': q['fp'] ?? 'chrome',
      'publicKey': q['pbk'] ?? '',
      'shortId': q['sid'] ?? '',
      'spiderX': q['spx'] ?? '',
      'mldsa65Verify': ?q['pqv'],
    };
  }
  // The host's own masks for this inbound (e.g. its fragment or noise
  // settings); they must match the server, so they win over ours.
  final mask = _json(q['fm']);
  if (mask != null) out['finalmask'] = mask;
  final path = q['path'];
  final host = q['host'];
  switch (out['network']) {
    case 'ws':
      out['wsSettings'] = {'path': path ?? '/', 'host': ?host};
    case 'grpc':
      out['grpcSettings'] = {
        'serviceName': q['serviceName'] ?? path ?? '',
        'multiMode': q['mode'] == 'multi',
        'authority': ?q['authority'],
      };
    case 'httpupgrade':
      out['httpupgradeSettings'] = {'path': path ?? '/', 'host': ?host};
    case 'xhttp' || 'splithttp':
      out['network'] = 'xhttp';
      out['xhttpSettings'] = {
        'path': path ?? '/',
        'host': ?host,
        'mode': ?q['mode'],
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

bool _isDomain(String? s) =>
    s != null &&
    s.isNotEmpty &&
    !s.contains(':') &&
    !RegExp(r'^\d{1,3}(\.\d{1,3}){3}$').hasMatch(s) &&
    s.contains('.');

Object? _json(String? s) {
  if (s == null || s.isEmpty) return null;
  try {
    final v = jsonDecode(s);
    return v is Map ? v : null;
  } on FormatException {
    return null;
  }
}
