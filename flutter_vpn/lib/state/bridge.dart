import 'dart:async';

import '../api/client.dart';
import 'tunnel.dart';
import 'xray_config.dart';

/// Share links the build carries for the bridge, for a phone that has no
/// exits of its own yet (a new install, before sign-up). Space, comma or
/// newline separated: `--dart-define=PLEAT_BRIDGE=vless://... vless://...`.
const buildBridges = String.fromEnvironment('PLEAT_BRIDGE');

List<String> splitLinks(String text) => text
    .split(RegExp(r'[\s,]+'))
    .map((l) => l.trim())
    .where((l) => l.contains('://'))
    .toList();

/// The app's [Detours]: the tunnel's API port while the tunnel is up, and
/// the bridge, a core started only to carry the app's own calls while the
/// open line can't reach the Worker. The bridge tries [candidates] in
/// order and closes itself after [idleFor] without a call.
class AppDetours implements Detours {
  AppDetours({
    required this.native,
    required this.login,
    required this.tunnelUp,
    required this.candidates,
  });

  final Tunnel native;
  final ProxyLogin login;
  final bool Function() tunnelUp;

  /// Share links to try, best first.
  final List<String> Function() candidates;

  /// At most this many exits are started per try, so a dead line costs
  /// tens of seconds, not minutes.
  static const maxTries = 5;
  static const idleFor = Duration(minutes: 3);

  /// After a try where no exit got through, the next try waits this long,
  /// so every call of a screen doesn't start the cores again.
  static const coolDown = Duration(seconds: 45);

  bool _up = false;
  Timer? _idle;
  Future<String?>? _opening;
  DateTime? _failedAt;

  String _proxy(int port) => '${login.user}:${login.pass}@127.0.0.1:$port';

  @override
  String? get tunnel => tunnelUp() ? _proxy(tunnelApiPort) : null;

  @override
  String? get bridge => _up && !tunnelUp() ? _proxy(bridgePort) : null;

  /// True while the bridge carries the app's calls.
  bool get bridging => bridge != null;

  @override
  Future<String?> openBridge(
    List<String> hosts,
    Future<bool> Function(String proxy) works,
  ) => _opening ??= _open(hosts, works).whenComplete(() => _opening = null);

  Future<String?> _open(
    List<String> hosts,
    Future<bool> Function(String proxy) works,
  ) async {
    if (hosts.isEmpty || tunnelUp()) return null;
    final failed = _failedAt;
    if (failed != null && DateTime.now().difference(failed) < coolDown) {
      return null;
    }
    final proxy = _proxy(bridgePort);
    var tries = 0;
    for (final link in candidates()) {
      if (tries >= maxTries) break;
      final String config;
      try {
        config = bridgeConfig(link, hosts, login);
      } on FormatException {
        continue;
      }
      tries++;
      if (!await native.bridgeStart(config)) continue;
      if (await works(proxy)) {
        _up = true;
        _failedAt = null;
        used();
        return proxy;
      }
    }
    if (tries > 0) await native.bridgeStop();
    _failedAt = DateTime.now();
    return null;
  }

  @override
  void used() {
    _idle?.cancel();
    _idle = Timer(idleFor, close);
  }

  /// Stops the bridge (idle, or the tunnel is up and carries the calls).
  Future<void> close() async {
    _idle?.cancel();
    _idle = null;
    if (!_up) return;
    _up = false;
    await native.bridgeStop();
  }
}
