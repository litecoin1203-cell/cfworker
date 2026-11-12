/// Reads the core's own failure text and says, in plain words, what went
/// wrong, who can fix it, and what to try. Also sums up a whole test run:
/// what works on this network, what doesn't and why, and how to connect
/// better and faster. Nothing here names a server address or host; the
/// native side blanks them before the text reaches Dart.
library;

import 'dart:convert';

import '../api/models.dart';
import 'exits.dart';
import 'xray_config.dart';

enum Cause {
  timeout,
  reset,
  refused,
  dns,
  offline,
  tls,
  reality,
  account,
  path,
  config,
  unknown,
}

/// Who can fix it: the person on this phone, or the service.
enum Fixer { you, service }

class Diagnosis {
  const Diagnosis(this.cause, this.title, this.fix, this.fixer);
  final Cause cause;
  final String title;
  final String fix;
  final Fixer fixer;
}

const _timeout = Diagnosis(
  Cause.timeout,
  'No answer in time',
  'This network may be filtering the server, or the server is down. Use an exit that works here; if none do, switch between Wi-Fi and mobile data.',
  Fixer.you,
);
const _reset = Diagnosis(
  Cause.reset,
  'Cut off by the network',
  'The connection was dropped on the way, which is typical of filtering. REALITY exits, and exits behind a CDN (WS or XHTTP over TLS), get through more often.',
  Fixer.you,
);
const _refused = Diagnosis(
  Cause.refused,
  'The server refused the connection',
  'This server isn’t taking connections right now. Pick another exit; the report tells support which one.',
  Fixer.service,
);
const _dns = Diagnosis(
  Cause.dns,
  'Server name not found',
  'This network couldn’t look up the server. Try again in a moment, or switch between Wi-Fi and mobile data.',
  Fixer.you,
);
const _offline = Diagnosis(
  Cause.offline,
  'No route to the internet',
  'This phone isn’t online right now. Check Wi-Fi or mobile data, then try again.',
  Fixer.you,
);
const _tls = Diagnosis(
  Cause.tls,
  'Secure handshake failed',
  'The server’s certificate or name doesn’t match. Support needs to fix this server; use another exit meanwhile.',
  Fixer.service,
);
const _reality = Diagnosis(
  Cause.reality,
  'REALITY handshake rejected',
  'The server’s REALITY keys don’t match its link. Support needs to fix this server; use another exit meanwhile.',
  Fixer.service,
);
const _account = Diagnosis(
  Cause.account,
  'The server didn’t accept your account',
  'Your account may not have reached this server yet; that takes a few minutes after a plan starts. If it lasts, tell support.',
  Fixer.service,
);
const _path = Diagnosis(
  Cause.path,
  'The server rejected the request path',
  'This server’s transport settings are out of step with its link. Support needs to fix it; use another exit meanwhile.',
  Fixer.service,
);
const _closed = Diagnosis(
  Cause.path,
  'The server closed the request',
  'The exit reached its server, but the server turned the request down: its transport settings (path, host or XHTTP mode) or its core version don’t match the link. Support needs to check this server; use another exit meanwhile.',
  Fixer.service,
);
const _config = Diagnosis(
  Cause.config,
  'Pleat can’t run this server’s settings',
  'This server uses a setting Pleat doesn’t support yet. Use another exit; the report tells support which setting.',
  Fixer.service,
);

/// What [error] (the core's text, or null for a plain no-answer) means.
Diagnosis diagnose(String? error) {
  final e = (error ?? '').toLowerCase();
  bool has(String p) => RegExp(p).hasMatch(e);
  if (e.isEmpty) return _timeout;
  if (has(r'network is unreachable|no route to host|network.*down')) {
    return _offline;
  }
  if (has(r'no such host|lookup |server misbehaving')) return _dns;
  if (has(r'reality.*(verif|real certificate|invalid)')) return _reality;
  if (has(r'x509|certificate|tls: (bad|unknown|handshake failure)')) {
    return _tls;
  }
  if (has(r'invalid user|user not found|unknown user|invalid request user')) {
    return _account;
  }
  if (has(r'connection refused')) return _refused;
  if (has(r'bad status|unexpected status|status code 40\d|40[34] ')) {
    return _path;
  }
  if (has(
    r'failed to (build|parse|load)|unknown (cipher|method|transport|security)|unsupported|not supported',
  )) {
    return _config;
  }
  if (has(r'deadline exceeded|i/o timeout|timeout|timed out')) {
    return _timeout;
  }
  // XHTTP's way of saying the server turned the request down (wrong path,
  // host or mode, or a core version that doesn't match); not filtering.
  if (has(r'closed pipe')) return _closed;
  if (has(r'reset by peer|\beof\b|broken pipe|forcibly closed')) {
    return _reset;
  }
  return Diagnosis(
    Cause.unknown,
    'Didn’t connect',
    error ?? 'No answer through the core.',
    Fixer.you,
  );
}

/// How the exit reaches its server, e.g. "REALITY", "TLS · WS", "plain".
String transportOf(String link) {
  try {
    final out = outboundOf(link);
    if (out['protocol'] == 'wireguard') return 'UDP';
    final st = out['streamSettings'];
    if (st is! Map) return 'plain';
    if (st['network'] == 'hysteria') return 'QUIC';
    final security = '${st['security'] ?? 'none'}';
    final net = '${st['network'] ?? 'tcp'}'.toUpperCase();
    if (security == 'reality') return 'REALITY';
    if (security == 'tls') return net == 'TCP' ? 'TLS' : 'TLS · $net';
    return net == 'TCP' ? 'plain' : net;
  } on FormatException {
    return 'unsupported';
  }
}

/// One finding of a test run, shown as a card with its advice.
class Finding {
  const Finding(this.title, this.body, {this.good = false});
  final String title;
  final String body;
  final bool good;
}

/// What a whole test run says about this network, most useful first.
/// [smart] and [localDirect] are the person's current switches.
List<Finding> summarize(
  List<Exit> exits, {
  required bool smart,
  required bool localDirect,
}) {
  final tested = exits.where((e) => e.measured != null).toList();
  if (tested.isEmpty) return const [];
  final ok = tested.where((e) => (e.measured ?? 0) > 0).toList()
    ..sort((a, b) => a.measured!.compareTo(b.measured!));
  final bad = tested.where((e) => e.unreachable).toList();
  final out = <Finding>[];

  if (ok.isEmpty) {
    final causes = {for (final e in bad) diagnose(e.failure).cause};
    final local = causes.every(
      (c) => c == Cause.timeout || c == Cause.offline || c == Cause.dns,
    );
    out.add(
      Finding(
        'Nothing answers from this network',
        local
            ? 'Every exit timed out or couldn’t be found. Check that other apps are online, then switch between Wi-Fi and mobile data. If nothing changes, this network is blocking every exit right now.'
            : 'No exit got through. The reasons are listed below; send the report to support.',
      ),
    );
  } else {
    final best = ok.first;
    out.add(
      Finding(
        '${ok.length} of ${tested.length} exits work here',
        'Fastest now: ${best.label} (${best.title}) at ${best.measured} ms.'
            '${smart ? ' Smart connect picks it for you.' : ' Turn on Smart connect in Home › Route and Pleat picks the fastest working exit, and moves on if it stops answering.'}',
        good: true,
      ),
    );
  }

  // Which ways of reaching a server get through on this network.
  final byWay = <String, List<Exit>>{};
  for (final e in tested) {
    byWay.putIfAbsent(transportOf(e.server.link), () => []).add(e);
  }
  if (byWay.length > 1) {
    final works = <String>[], blocked = <String>[];
    byWay.forEach((way, list) {
      final n = list.where((e) => (e.measured ?? 0) > 0).length;
      (n > 0 ? works : blocked).add('$way $n/${list.length}');
    });
    if (works.isNotEmpty && blocked.isNotEmpty) {
      out.add(
        Finding(
          'What gets through on this network',
          'Working: ${works.join(', ')}. Not getting through: ${blocked.join(', ')}. Pick exits of the working kind.',
        ),
      );
    }
  }

  final service = bad
      .where((e) => diagnose(e.failure).fixer == Fixer.service)
      .toList();
  if (service.isNotEmpty) {
    out.add(
      Finding(
        '${service.length} exit${service.length == 1 ? ' has' : 's have'} a server-side problem',
        '${service.map((e) => e.label).join(', ')}. Nothing on this phone fixes these; copy the report below and send it to support.',
      ),
    );
  }

  if (ok.isNotEmpty) {
    final fast = ok.first.measured!;
    if (fast > 800) {
      out.add(
        Finding(
          'Every working exit is slow here',
          'The best answers in $fast ms. Try again later, or on the other network (Wi-Fi or mobile data).',
        ),
      );
    }
    if (!localDirect) {
      out.add(
        const Finding(
          'Faster local sites',
          'Turn on Iranian sites in Home › Route › Split route: they then skip the tunnel, so they load faster and don’t use your data.',
        ),
      );
    }
  }
  return out;
}

/// Plain-text report for support: no addresses, hosts or account details.
String report(
  List<Exit> exits, {
  required String app,
  required String device,
  required DateTime at,
}) {
  final b = StringBuffer()
    ..writeln('Pleat connection report')
    ..writeln('App $app · $device')
    ..writeln('Time ${at.toUtc().toIso8601String()}')
    ..writeln();
  for (final e in exits) {
    final m = e.measured;
    final way = transportOf(e.server.link);
    final line = m == null
        ? 'not tested'
        : m > 0
        ? 'OK $m ms'
        : 'FAIL ${diagnose(e.failure).cause.name}: ${e.failure ?? 'no answer'}';
    b.writeln('${e.label} · ${e.protocol} · $way · $line');
  }
  return b.toString();
}

/// Query keys whose values say how an exit is set up without naming the
/// server or holding a secret; every other value shows only as "set".
const _shapeKeys = {
  'type',
  'security',
  'encryption',
  'flow',
  'fp',
  'alpn',
  'mode',
  'headerType',
  'mtu',
  'reserved',
  'allowedips',
  'keepalive',
  'insecure',
  'allowInsecure',
  'obfs',
  'packetEncoding',
};

/// A share link with nothing that names the server or opens it: scheme,
/// whether the host is a name or an IP, the port, and each setting (secrets
/// and names only as "set"), so two exits can be compared field by field.
String linkShape(String link) {
  final i = link.indexOf('://');
  if (i <= 0) return 'not a link';
  final scheme = link.substring(0, i).toLowerCase();
  if (scheme == 'vmess') {
    try {
      var raw = link.substring(i + 3).split('#').first.trim();
      raw = raw.replaceAll('-', '+').replaceAll('_', '/');
      raw += '=' * ((4 - raw.length % 4) % 4);
      final j = jsonDecode(utf8.decode(base64.decode(raw)));
      if (j is! Map) return 'vmess (unreadable)';
      final ep = endpointOf(link);
      final parts = <String>[
        'vmess',
        if (ep != null) '${_hostKind(ep.host)}:${ep.port}',
        for (final k in ['net', 'tls', 'type', 'fp', 'alpn', 'scy', 'aid'])
          if ('${j[k] ?? ''}'.isNotEmpty) '$k=${j[k]}',
        for (final k in ['host', 'path', 'sni'])
          if ('${j[k] ?? ''}'.isNotEmpty) '$k=set',
      ];
      return parts.join(' ');
    } on FormatException {
      return 'vmess (unreadable)';
    }
  }
  final ep = endpointOf(link);
  final body = link.split('#').first;
  final q = body.contains('?') ? body.substring(body.indexOf('?') + 1) : '';
  final parts = <String>[
    scheme,
    if (ep != null) '${_hostKind(ep.host)}:${ep.port}',
  ];
  for (final pair in q.split('&')) {
    final eq = pair.indexOf('=');
    if (eq <= 0) continue;
    final k = pair.substring(0, eq);
    var v = pair.substring(eq + 1);
    try {
      v = Uri.decodeComponent(v.replaceAll('+', '%2B'));
    } on ArgumentError {
      // shown as sent
    }
    if (v.isEmpty) {
      parts.add('$k=');
    } else if (_shapeKeys.contains(k)) {
      parts.add('$k=$v');
    } else if (k == 'address' || k == 'ip') {
      // the tunnel's own address: only its family and prefix
      parts.add(
        '$k=${v.split(',').map((a) => '${a.contains(':') ? 'v6' : 'v4'}/${a.contains('/') ? a.split('/').last : '?'}').join(',')}',
      );
    } else {
      parts.add('$k=set');
    }
  }
  return parts.join(' ');
}

String _hostKind(String host) => host.contains(':')
    ? 'ipv6'
    : RegExp(r'^\d{1,3}(\.\d{1,3}){3}$').hasMatch(host)
    ? 'ipv4'
    : 'name';
