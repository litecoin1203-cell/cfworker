import 'dart:async';

import 'package:flutter/services.dart';

enum TunnelState { down, starting, up, failed }

/// The platform tunnel behind `pleat/tunnel`. On Android it is
/// `PleatVpnService`: the Xray core plus hev-socks5-tunnel on a VpnService.
/// It reports `up` only after a probe request has gone through the exit.
/// Where no native side exists, [available] is false and the app never
/// claims a protected session.
class Tunnel {
  static const _method = MethodChannel('pleat/tunnel');
  static const _events = EventChannel('pleat/tunnel/state');

  bool? _available;
  StreamSubscription<dynamic>? _sub;

  /// Asks the platform once whether a tunnel engine is present.
  Future<bool> available() async {
    if (_available != null) return _available!;
    try {
      _available = await _method.invokeMethod<bool>('available') ?? false;
    } on MissingPluginException {
      _available = false;
    } on PlatformException {
      _available = false;
    }
    return _available!;
  }

  /// Starts the core with [config] (see `xray_config.dart`). Asks for the
  /// VPN permission first; throws a [PlatformException] with code `denied`
  /// when the person refuses it.
  Future<void> start(String config) =>
      _method.invokeMethod<void>('start', {'config': config});

  Future<void> stop() async {
    if (await available()) await _method.invokeMethod<void>('stop');
  }

  /// Current state, for when the app opens while a tunnel already runs.
  Future<TunnelState> current() async {
    if (!await available()) return TunnelState.down;
    try {
      return _parse(await _method.invokeMethod<String>('state'));
    } on PlatformException {
      return TunnelState.down;
    }
  }

  /// Android's own VPN page, where always-on and "Block connections
  /// without VPN" (the system kill switch) live.
  Future<void> openSystemSettings() async {
    if (await available()) await _method.invokeMethod<void>('systemSettings');
  }

  void listen(void Function(TunnelState) onState) {
    _sub?.cancel();
    _sub = _events.receiveBroadcastStream().listen(
      (v) => onState(_parse(v)),
      onError: (_) => onState(TunnelState.down),
    );
  }

  static TunnelState _parse(Object? v) => switch (v) {
    'up' => TunnelState.up,
    'starting' => TunnelState.starting,
    'failed' => TunnelState.failed,
    _ => TunnelState.down,
  };

  void dispose() => _sub?.cancel();
}
