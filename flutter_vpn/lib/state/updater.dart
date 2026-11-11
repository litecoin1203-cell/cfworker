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

/// MB with one decimal, as every update surface shows sizes.
String updateMb(int bytes) => (bytes / (1024 * 1024)).toStringAsFixed(1);

/// The words for where an update is, shared by the Home card and the system
/// notification so both always say the same thing.
class UpdateCopy {
  UpdateCopy._(
    this.title,
    this.text,
    this.side,
    this.action, {
    String? short,
    String? shortText,
    String? button,
  }) : short = short ?? title,
       shortText = shortText ?? text,
       button = button ?? action;
  final String title, text;

  /// The same, short enough for the Home card beside its button.
  final String short, shortText, button;

  /// A short note at the right of the title: time left, or the size.
  final String side;

  /// The main button, or '' when there is nothing to press.
  final String action;

  factory UpdateCopy.of(Updater up, AppUpdate u) {
    final size = updateMb(u.files[up.abi]?.size ?? up.total);
    final eta = up.etaSeconds;
    final left = eta == null
        ? ''
        : (eta < 60 ? '$eta s left' : '${(eta / 60).ceil()} min left');
    return switch (up.step) {
      UpdateStep.downloading => UpdateCopy._(
        'Updating to ${u.version}',
        '${updateMb(up.received)} of ${updateMb(up.total)} MB',
        left,
        'Stop',
      ),
      UpdateStep.checking => UpdateCopy._(
        'Checking ${u.version}',
        'Making sure the file is Pleat’s own, byte for byte',
        '',
        '',
      ),
      UpdateStep.ready || UpdateStep.installing => UpdateCopy._(
        'Checked. Tap to install ${u.version}',
        'Your account, plan and settings stay',
        '',
        'Install',
        short: '${u.version} is checked',
        shortText: 'Your account and plan stay',
      ),
      UpdateStep.needsPermission => UpdateCopy._(
        'One step before ${u.version}',
        'Allow installs from Pleat, then come back',
        '',
        'Allow',
        short: 'One step left',
        shortText: 'Allow installs from Pleat',
      ),
      UpdateStep.failed => UpdateCopy._(
        'The update didn’t finish',
        up.error ?? 'Try again; it goes on from where it stopped.',
        '',
        'Try again',
        short: 'Update didn’t finish',
        button: 'Retry',
      ),
      UpdateStep.idle => UpdateCopy._(
        'Pleat ${u.version} is ready for you',
        '$size MB · your account and settings stay',
        u.force ? 'Needed' : '',
        up.received > 0 ? 'Go on' : 'Update now',
        short: 'Pleat ${u.version} is ready',
        shortText: '$size MB · settings stay',
        button: up.received > 0 ? 'Go on' : 'Update',
      ),
    };
  }
}

/// Where the three-part line stands: 0 download, 1 check, 2 install, and
/// how far the download is.
({int stage, double frac}) updateTrack(Updater up) => switch (up.step) {
  UpdateStep.downloading => (
    stage: 0,
    frac: up.total > 0 ? (up.received / up.total).clamp(0.0, 1.0) : 0.0,
  ),
  UpdateStep.checking => (stage: 1, frac: 1.0),
  UpdateStep.ready ||
  UpdateStep.installing ||
  UpdateStep.needsPermission => (stage: 2, frac: 1.0),
  _ => (
    stage: 0,
    frac: up.total > 0 ? (up.received / up.total).clamp(0.0, 1.0) : 0.0,
  ),
};

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

  /// The build the notification is about, once it has been shown.
  AppUpdate? _noted;
  String _noteKey = '';
  DateTime _noteAt = DateTime(0);

  /// Download speed, from when this download (or its resume) began.
  DateTime? _t0;
  int _b0 = 0;

  /// Seconds left at the speed so far; null until it has run a moment.
  int? get etaSeconds {
    final t0 = _t0;
    if (step != UpdateStep.downloading || t0 == null || total <= 0) return null;
    final ms = DateTime.now().difference(t0).inMilliseconds;
    final got = received - _b0;
    if (ms < 2000 || got <= 0) return null;
    return ((total - received) * ms / got / 1000).ceil();
  }

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
      // Stop on the notification reaches the download here.
      _ch.setMethodCallHandler((call) async {
        if (call.method == 'action' && call.arguments == 'stop') stop();
        return null;
      });
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
    _pushNote();
  }

  /// Keeps the system notification in step with the download: on each
  /// stage change, and every 2% or so while it runs (Android drops
  /// notification updates that come faster than a few a second).
  void _pushNote() {
    final u = _noted;
    if (u == null) return;
    final pct = total > 0 ? (100 * received / total).floor() : 0;
    final key = '${step.name}:${pct ~/ 2}';
    final t = DateTime.now();
    final sameStage = _noteKey.startsWith('${step.name}:');
    if (key == _noteKey) return;
    if (sameStage &&
        t.difference(_noteAt) < const Duration(milliseconds: 700)) {
      return;
    }
    _noteKey = key;
    _noteAt = t;
    unawaited(_note(u, alert: false));
  }

  Future<void> _note(AppUpdate u, {required bool alert}) async {
    final c = UpdateCopy.of(this, u);
    final tr = updateTrack(this);
    final stage = switch (step) {
      UpdateStep.downloading => 'download',
      UpdateStep.checking => 'check',
      UpdateStep.ready => 'ready',
      UpdateStep.needsPermission => 'permission',
      UpdateStep.failed => 'failed',
      UpdateStep.installing => 'cancel',
      UpdateStep.idle => 'offer',
    };
    try {
      await _ch.invokeMethod<void>('note', {
        'stage': stage,
        'alert': alert,
        'title': c.title,
        'text': c.text,
        'side': c.side,
        'action': c.action,
        'from': version,
        'to': u.version,
        'pct': (100 * tr.frac).floor(),
        'track': tr.stage,
        'force': u.force,
      });
    } on PlatformException {
      // The card on Home still shows it.
    } on MissingPluginException {
      // No native side.
    }
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
    follow(u);
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
        _t0 = DateTime.now();
        _b0 = received;
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

  /// The system notification about [u], the first time it is announced;
  /// from then on it follows the download.
  Future<void> notify(AppUpdate u) async {
    _noted = u;
    _noteKey = '${step.name}:0';
    _noteAt = DateTime.now();
    await _note(u, alert: true);
  }

  /// A download started in the app gets the notification too, so it can be
  /// followed from the shade.
  void follow(AppUpdate u) {
    if (_noted?.tag == u.tag) return;
    _noted = u;
    _noteKey = '';
  }
}
