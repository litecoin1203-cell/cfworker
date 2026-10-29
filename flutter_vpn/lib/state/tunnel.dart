import 'dart:async';

import 'package:flutter/services.dart';

enum TunnelState { down, starting, up }

/// The platform tunnel behind `pleat/tunnel`. A native side would run the
/// config and report `down | starting | up` on `pleat/tunnel/state`.
/// This build ships no native tunnel, so [available] stays false and the
/// app never claims a protected session.
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

  /// Starts the config. The link goes to the platform and nowhere else.
  Future<void> start(String link) =>
      _method.invokeMethod<void>('start', {'link': link});

  Future<void> stop() async {
    if (await available()) await _method.invokeMethod<void>('stop');
  }

  void listen(void Function(TunnelState) onState) {
    _sub?.cancel();
    _sub = _events.receiveBroadcastStream().listen(
      (v) => onState(switch (v) {
        'up' => TunnelState.up,
        'starting' => TunnelState.starting,
        _ => TunnelState.down,
      }),
      onError: (_) => onState(TunnelState.down),
    );
  }

  void dispose() => _sub?.cancel();
}
