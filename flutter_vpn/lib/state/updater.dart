import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';

/// Where an in-app update is.
enum UpdateStep {
  /// Nothing started (or stopped by the person).
  idle,
  downloading,

  /// The file is whole; its SHA-256 is being checked.
  checking,

  /// Checked and on the phone; Install opens Android's installer.
  ready,

  /// Android wants "Install unknown apps" turned on for Pleat first.
  needsPermission,

  /// Android's installer is open.
  installing,
  failed,
}

/// Pleat's in-app update. The store announces a build in app-config
/// (`update`); this downloads the APK for this phone's type through the
/// Worker (the open line, the tunnel or the bridge, whichever answers),
/// goes on from where a dropped download stopped, checks the SHA-256 the
/// Worker gave and opens Android's installer. Android itself refuses an APK
/// that isn't signed with Pleat's key. Native side: `Updates.kt`.
class Updater {
  Updater(this.api);
  final ApiClient api;
  static const _ch = MethodChannel('pleat/update');

  /// Called on every change the update sheet shows.
  void Function()? onChange;

  /// The Worker no longer offers the build being fetched: read app-config
  /// again.
  void Function()? onGone;

  /// The installed app: its version, pubspec build number and phone type
  /// ("arm64-v8a" ...). [known] is false off Android and in tests, and then
  /// no update is ever offered.
  String version = '';
  int build = 0;
  String abi = '';
  bool known = false;

  UpdateStep step = UpdateStep.idle;
  int received = 0, total = 0;
  String? error;

  bool _stop = false;
  String? _apk;
  String? _tag;
  DateTime _shown = DateTime(0);

  /// How many times a cut download is picked up again before giving up.
  static const _retries = 8;

  Future<void> load() async {
    try {
      final m = await _ch.invokeMapMethod<String, Object?>('info');
      if (m == null) return;
      version = '${m['version'] ?? ''}';
      build = (m['build'] as num?)?.toInt() ?? 0;
      abi = '${m['abi'] ?? ''}';
      known = build > 0 && abi.isNotEmpty;
    } on MissingPluginException {
      // No native side (tests, desktop).
    } on PlatformException {
      // An older native side.
    }
  }

  /// [u] is newer than what is installed and has a file for this phone.
  bool offers(AppUpdate? u) =>
      u != null && known && u.build > build && u.files.containsKey(abi);

  bool get busy =>
      step == UpdateStep.downloading || step == UpdateStep.checking;

  void _changed({bool now = true}) {
    // progress redraws at most five times a second
    final t = DateTime.now();
    if (!now && t.difference(_shown) < const Duration(milliseconds: 200)) {
      return;
    }
    _shown = t;
    onChange?.call();
  }

  /// Downloads (or goes on downloading) [u], checks it and opens the
  /// installer. Safe to call again after a failure: what is on the phone
  /// is kept.
  Future<void> start(AppUpdate u) async {
    if (busy) return;
    final f = u.files[abi];
    if (f == null) return;
    if (_tag != u.tag) _apk = null;
    _tag = u.tag;
    if (_apk != null && step != UpdateStep.failed) return install();
    _stop = false;
    error = null;
    total = f.size;
    step = UpdateStep.downloading;
    _changed();
    try {
      final dir = await _ch.invokeMethod<String>('dir');
      if (dir == null) throw const FileSystemException('no dir');
      final name =
          'pleat-${u.tag.replaceAll(RegExp(r'[^\w.-]'), '_')}-$abi.apk';
      // other builds' files go; this build's part stays to be continued
      for (final e in Directory(dir).listSync()) {
        if (e is File &&
            !e.path.endsWith('/$name') &&
            !e.path.endsWith('/$name.part')) {
          e.deleteSync();
        }
      }
      final apk = File('$dir/$name');
      if (!apk.existsSync() || apk.lengthSync() != f.size) {
        if (apk.existsSync()) apk.deleteSync();
        final part = File('$dir/$name.part');
        if (part.existsSync() && part.lengthSync() > f.size) part.deleteSync();
        received = part.existsSync() ? part.lengthSync() : 0;
        _changed();
        for (var tries = 0; ; tries++) {
          try {
            await api.download(
              '/app/apk?tag=${Uri.encodeQueryComponent(u.tag)}&abi=$abi',
              part,
              onProgress: (b) {
                received = b;
                _changed(now: false);
              },
              stop: () => _stop,
            );
            if (part.lengthSync() >= f.size) break;
            // The line closed early: go on from here.
          } on ApiError catch (e) {
            if (e.code == 'stopped' || e.status >= 400) rethrow;
            if (tries + 1 >= _retries) rethrow;
          }
          if (tries + 1 >= _retries) {
            throw ApiError(
              0,
              'offline',
              'The download keeps dropping. Tap Update to go on from here.',
            );
          }
          if (_stop) throw ApiError(0, 'stopped', 'Download stopped.');
          await Future<void>.delayed(const Duration(seconds: 3));
        }
        part.renameSync(apk.path);
      }
      received = total;
      step = UpdateStep.checking;
      _changed();
      final sha = await _ch.invokeMethod<String>('sha256', {'path': apk.path});
      if (apk.lengthSync() != f.size || sha != f.sha256) {
        apk.deleteSync();
        throw ApiError(
          0,
          'damaged',
          'The download was damaged. Tap Update to get it again.',
        );
      }
      _apk = apk.path;
      step = UpdateStep.ready;
      _changed();
      await install();
    } on ApiError catch (e) {
      if (e.code == 'stopped') {
        step = UpdateStep.idle;
      } else {
        if (e.code == 'update_gone') onGone?.call();
        step = UpdateStep.failed;
        error = e.message;
      }
      _changed();
    } on FileSystemException {
      step = UpdateStep.failed;
      error = 'There isn’t room for the update. Free some space and try again.';
      _changed();
    } on PlatformException {
      step = UpdateStep.failed;
      error = 'The update couldn’t be checked. Try again.';
      _changed();
    } on MissingPluginException {
      step = UpdateStep.failed;
      error = 'Updates work in the Android app only.';
      _changed();
    }
  }

  /// Opens Android's installer on the checked file, or asks for "Install
  /// unknown apps" first.
  Future<void> install() async {
    final p = _apk;
    if (p == null || !File(p).existsSync()) {
      _apk = null;
      step = UpdateStep.idle;
      _changed();
      return;
    }
    try {
      if (!(await _ch.invokeMethod<bool>('canInstall') ?? false)) {
        step = UpdateStep.needsPermission;
        _changed();
        return;
      }
      final ok = await _ch.invokeMethod<bool>('install', {'path': p}) ?? false;
      step = ok ? UpdateStep.installing : UpdateStep.failed;
      if (!ok) error = 'Android’s installer didn’t open. Try again.';
    } on PlatformException {
      step = UpdateStep.failed;
      error = 'Android’s installer didn’t open. Try again.';
    } on MissingPluginException {
      step = UpdateStep.failed;
      error = 'Updates work in the Android app only.';
    }
    _changed();
  }

  /// Pleat's "Install unknown apps" page in Android's settings.
  Future<void> allowInstalls() async {
    try {
      await _ch.invokeMethod<bool>('allowInstalls');
    } on PlatformException {
      // Nothing to open.
    } on MissingPluginException {
      // No native side.
    }
  }

  /// Back on screen: from the settings page (installs may be allowed now)
  /// or from the installer (the person backed out of it).
  Future<void> resumed() async {
    if (step == UpdateStep.needsPermission) {
      try {
        if (await _ch.invokeMethod<bool>('canInstall') ?? false) {
          await install();
        }
      } on PlatformException {
        // Stays on the permission step.
      } on MissingPluginException {
        // No native side.
      }
    } else if (step == UpdateStep.installing) {
      step = UpdateStep.ready;
      _changed();
    }
  }

  void stop() => _stop = true;

  /// One system notification about [u].
  Future<void> notify(AppUpdate u) async {
    try {
      await _ch.invokeMethod<void>('notify', {
        'title': 'Pleat ${u.version} is ready',
        'text': 'Tap to update. Your account and settings stay as they are.',
      });
    } on PlatformException {
      // The badge in the app still shows it.
    } on MissingPluginException {
      // No native side.
    }
  }
}
