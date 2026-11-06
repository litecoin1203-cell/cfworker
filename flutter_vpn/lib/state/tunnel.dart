import 'dart:async';

import 'package:flutter/services.dart';

/// [off]: the person tapped Disconnect on the notification. Not a drop.
enum TunnelState { down, starting, up, failed, off }

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

  /// What the VPN notification shows about the exit in use. English only.
  /// Cheap: the card is redrawn once per call, and the timer on it is
  /// counted by Android itself.
  Future<void> note({
    required String flag,
    required String place,
    String ip = '',
    String protocol = '',
    DateTime? since,
  }) async {
    try {
      await _method.invokeMethod<void>('note', {
        'flag': flag,
        'place': place,
        'ip': ip,
        'protocol': protocol,
        'since': since?.millisecondsSinceEpoch ?? 0,
      });
    } on MissingPluginException {
      // No native side (tests, desktop).
    } on PlatformException {
      // An older native side; the card keeps its last text.
    }
  }

  /// [onOpen] gets the screen a notification button asked for
  /// ("locations"), now or when the app was opened by it.
  Future<void> watchOpen(void Function(String) onOpen) async {
    try {
      _method.setMethodCallHandler((call) async {
        if (call.method == 'open' && call.arguments is String) {
          onOpen(call.arguments as String);
        }
      });
      final first = await _method.invokeMethod<String>('pendingOpen');
      if (first != null) onOpen(first);
    } on MissingPluginException {
      // No native side.
    } on PlatformException {
      // An older native side.
    }
  }

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
  Future<int?> ping(String config) async => (await probe(config)).ms;

  /// [ping] with the reason when it fails: the core's own text (server
  /// addresses blanked), or null for a plain no-answer.
  Future<({int? ms, String? error})> probe(String config) async {
    if (!await available()) return (ms: null, error: 'no tunnel engine');
    try {
      final r = await _method.invokeMethod<Object>('ping', {'config': config});
      if (r is int && r > 0) return (ms: r, error: null);
      return (ms: null, error: r is String && r.isNotEmpty ? r : null);
    } on PlatformException catch (e) {
      return (ms: null, error: e.code);
    }
  }

  /// One exit tested alone with the core logging everything: the delay or
  /// the core's reason, how long it took, and the log's last lines with
  /// addresses, keys and ids blanked on the phone. Null without an engine.
  Future<({int? ms, String? error, int took, String log})?> trace(
    String config,
  ) async {
    if (!await available()) return null;
    try {
      final r = await _method.invokeMethod<Map<Object?, Object?>>('trace', {
        'config': config,
      });
      if (r == null) return null;
      final ms = r['ms'];
      return (
        ms: ms is int && ms > 0 ? ms : null,
        error: r['error'] as String?,
        took: (r['took'] as int?) ?? 0,
        log: (r['log'] as String?) ?? '',
      );
    } on PlatformException catch (e) {
      return (ms: null, error: e.code, took: 0, log: '');
    }
  }

  /// Download speed in kbit/s through a throw-away core running [config]
  /// (about 1 MB on the phone's own network); -1 when nothing came
  /// through, null without an engine.
  Future<int?> speed(String config) async {
    if (!await available()) return null;
    try {
      return await _method.invokeMethod<int>('speed', {'config': config});
    } on PlatformException {
      return -1;
    }
  }

  /// How the phone reaches the internet under the tunnel: 'wifi', 'cell'
  /// (mobile data), 'other', or '' when unknown. The operator comes from
  /// the Worker; together they tell Irancell over Wi-Fi from Irancell
  /// mobile data.
  Future<String> netKind() async {
    // Only once the engine answered: a channel call before that waits on
    // a native side that may not be there.
    if (_available != true) return '';
    try {
      final k = await _method.invokeMethod<String>('netKind') ?? '';
      return const {'wifi', 'cell', 'other'}.contains(k) ? k : '';
    } on MissingPluginException {
      return '';
    } on PlatformException {
      return '';
    }
  }

  /// Whether the phone's own network (not the tunnel) is metered: mobile
  /// data, or Wi-Fi marked metered. False when unknown.
  Future<bool> metered() async {
    try {
      return await _method.invokeMethod<bool>('metered') ?? false;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    }
  }

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

  /// Starts the bridge core (see `bridgeConfig`); false when it didn't
  /// start or this build has no core.
  Future<bool> bridgeStart(String config) async {
    try {
      return await _method.invokeMethod<bool>('bridgeStart', {
            'config': config,
          }) ??
          false;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    }
  }

  Future<void> bridgeStop() async {
    try {
      await _method.invokeMethod<bool>('bridgeStop');
    } on MissingPluginException {
      // No core, no bridge.
    } on PlatformException {
      // Same.
    }
  }

  /// The app's private files folder (kept until the app is removed); null
  /// off Android.
  Future<String?> filesDir() async {
    try {
      return await _method.invokeMethod<String>('filesDir');
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  void Function(TunnelState)? _onState;

  /// Hands every state change to [onState]. The platform stream is opened
  /// once: opening it again replays the current state (often a "down" or
  /// "failed" left from before), which a new attempt would read as its
  /// own failure.
  void listen(void Function(TunnelState) onState) {
    _onState = onState;
    _sub ??= _events.receiveBroadcastStream().listen(
      (v) => _onState?.call(_parse(v)),
      onError: (_) => _onState?.call(TunnelState.down),
    );
  }

  static TunnelState _parse(Object? v) => switch (v) {
    'up' => TunnelState.up,
    'starting' => TunnelState.starting,
    'failed' => TunnelState.failed,
    'off' => TunnelState.off,
    _ => TunnelState.down,
  };

  void dispose() => _sub?.cancel();
}
