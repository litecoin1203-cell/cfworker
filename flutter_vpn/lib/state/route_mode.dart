/// How the person wants to connect, picked on Home's Route tab: a goal,
/// not a protocol name. Each exit belongs to exactly one family, read from
/// its own share link on this phone (protocol, transport and security), so
/// the Worker needs nothing new and nothing is guessed.
library;

import 'exits.dart';
import 'xray_config.dart';

enum RouteMode {
  auto('Auto', 'Pleat chooses for your network'),
  stealth('Stealth', 'Hardest to detect when filtering is heavy'),
  speed('Speed', 'Video and big downloads'),
  classic('Classic', 'Familiar protocols for steady networks');

  const RouteMode(this.title, this.blurb);
  final String title, blurb;

  /// Stored in preferences by name; anything unknown is Auto.
  static RouteMode parse(String? s) => RouteMode.values.firstWhere(
    (m) => m.name == s,
    orElse: () => RouteMode.auto,
  );

  bool matches(Exit e) => this == RouteMode.auto || e.family == this;
}

/// The family of one config link: [RouteMode.speed] for WireGuard and the
/// QUIC protocols, [RouteMode.stealth] for REALITY and XHTTP, else
/// [RouteMode.classic]. Never [RouteMode.auto].
RouteMode familyOf(String protocol, String link) {
  switch (protocol) {
    case 'wireguard' || 'hy2' || 'hysteria2' || 'hysteria' || 'tuic':
      return RouteMode.speed;
  }
  try {
    final st = outboundOf(link)['streamSettings'];
    if (st is Map) {
      if (st['security'] == 'reality') return RouteMode.stealth;
      final net = '${st['network'] ?? ''}';
      if (net == 'xhttp' || net == 'splithttp') return RouteMode.stealth;
      if (net == 'hysteria') return RouteMode.speed;
    }
  } on FormatException {
    // A link the core can't run; it fails on connect either way.
  }
  return RouteMode.classic;
}

/// Short technical name of one exit's wrapping, e.g. "VLESS REALITY",
/// "VLESS XHTTP", "Trojan TLS", "WireGuard". No host, no address.
String wrappingOf(Exit e) {
  final p = e.protocol;
  if (e.server.protocol == 'wireguard' ||
      e.server.protocol == 'hy2' ||
      e.server.protocol == 'hysteria2' ||
      e.server.protocol == 'ss') {
    return p;
  }
  try {
    final st = outboundOf(e.server.link)['streamSettings'];
    if (st is! Map) return p;
    final sec = '${st['security'] ?? 'none'}';
    final net = '${st['network'] ?? 'tcp'}';
    if (sec == 'reality') return '$p REALITY';
    if (net == 'xhttp' || net == 'splithttp') return '$p XHTTP';
    if (net == 'grpc') return '$p gRPC';
    if (net == 'ws') return '$p WS';
    if (net == 'httpupgrade') return '$p HTTPUpgrade';
    if (sec == 'tls') return '$p TLS';
    return p;
  } on FormatException {
    return p;
  }
}
