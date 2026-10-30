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

  /// Whether the tunnel engine loads. Asks the same question as
  /// [engineError], so the two never disagree; only a yes is remembered,
  /// so an early no (the engine still starting up) is asked again.
  Future<bool> available() async {
    if (_available == true) return true;
    _available = await engineError() == null;
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

  /// "Maker Model" of this phone, its Android version and the device id
  /// the Cloud Gold app uses for it; null off Android.
  Future<({String model, String release, String hwid})?> device() async {
    try {
      final m = await _method.invokeMapMethod<String, Object?>('device');
      if (m == null) return null;
      return (
        model: '${m['model'] ?? ''}',
        release: '${m['release'] ?? ''}',
        hwid: '${m['hwid'] ?? ''}',
      );
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  /// Why the engine doesn't load, as the platform says it; null when it
  /// loads or off Android.
  Future<String?> engineError() async {
    try {
      return await _method.invokeMethod<String>('engineError');
    } on MissingPluginException {
      return 'no native side';
    } on PlatformException catch (e) {
      return '${e.code}: ${e.message ?? ''}';
    }
  }

  /// Round trip in ms through a throw-away core running [config], the way
  /// v2rayNG tests a server; null when the server didn't answer.
  Future<int?> ping(String config) async {
    lastPingError = null;
    if (!await available()) return null;
    try {
      final r = await _method.invokeMethod<Object>('ping', {'config': config});
      if (r is int && r > 0) return r;
      if (r is String && r.isNotEmpty) lastPingError = r;
      return null;
    } on PlatformException catch (e) {
      lastPingError = e.code;
      return null;
    }
  }

  /// Why the last [ping] got no answer, as the core said it (server
  /// addresses blanked); null when it answered or gave no reason.
  String? lastPingError;

  /// Round trip in ms through the running tunnel; null when it didn't
  /// answer or no tunnel runs.
  Future<int?> delay() async {
    if (!await available()) return null;
    try {
      final ms = await _method.invokeMethod<int>('delay');
      return ms != null && ms > 0 ? ms : null;
    } on PlatformException {
      return null;
    }
  }

  /// True when this build ships geoip.dat and geosite.dat, which the
  /// "local sites go direct" rules need.
  Future<bool> hasGeo() async {
    if (!await available()) return false;
    try {
      return await _method.invokeMethod<bool>('geo') ?? false;
    } on PlatformException {
      return false;
    }
  }

  /// Android's always-on and "block connections without VPN" flags for
  /// Pleat. Android reports them only while the tunnel runs (Android 10+);
  /// null when unknown.
  Future<({bool alwaysOn, bool lockdown})?> policy() async {
    if (!await available()) return null;
    try {
      final m = await _method.invokeMapMethod<String, Object?>('policy');
      if (m == null || m['known'] != true) return null;
      return (alwaysOn: m['alwaysOn'] == true, lockdown: m['lockdown'] == true);
    } on PlatformException {
      return null;
    }
  }

  // The same channel also carries the few phone actions the store needs.

  /// Opens a web or Telegram link in its app; false when nothing opened.
  Future<bool> openUrl(String url) async {
    try {
      return await _method.invokeMethod<bool>('openUrl', {'url': url}) ?? false;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    }
  }

  Future<void> share(String text) async {
    try {
      await _method.invokeMethod<void>('share', {'text': text});
    } on MissingPluginException {
      // Nothing to share with off Android.
    } on PlatformException {
      // Same.
    }
  }

  /// A photo from the gallery or files, as bytes; null when none was
  /// picked.
  Future<Uint8List?> pickImage() async {
    try {
      return await _method.invokeMethod<Uint8List>('pickImage');
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
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
