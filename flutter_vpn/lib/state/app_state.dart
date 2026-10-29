import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../design/tokens.dart';
import 'seed.dart';

enum Phase { idle, checking, handshaking, protected, dropped }

class Session {
  Session({
    required this.exitId,
    required this.start,
    required this.minutes,
    required this.megabytes,
    required this.protocol,
  });

  final String exitId;
  final DateTime start;
  final int minutes;
  final int megabytes;
  final String protocol;

  Map<String, Object> toJson() => {
    'e': exitId,
    's': start.millisecondsSinceEpoch,
    'm': minutes,
    'mb': megabytes,
    'p': protocol,
  };

  static Session fromJson(Map<String, dynamic> j) => Session(
    exitId: j['e'] as String,
    start: DateTime.fromMillisecondsSinceEpoch(j['s'] as int),
    minutes: j['m'] as int,
    megabytes: j['mb'] as int,
    protocol: j['p'] as String,
  );
}

/// All app state, seeded locally and persisted with shared_preferences.
/// The connect sequence is a timed demo: Checking → Handshaking → Protected.
class AppState extends ChangeNotifier {
  AppState(this._prefs) {
    _load();
  }

  final SharedPreferences _prefs;

  // Account
  bool onboarded = false;
  bool signedIn = false;
  String email = '';
  String? planId;
  DateTime? trialEnds;

  // Protect
  bool killSwitch = true;
  Set<String> directApps = {'bank'};
  String dns = 'pleat';
  String protocol = 'WireGuard';
  bool autoConnect = true;
  bool autoOnlyUntrusted = true;
  bool threatFilter = true;
  bool lan = false;

  // Places
  String exitId = 'fra';
  Set<String> saved = {'zrh', 'tyo'};
  List<Session> sessions = [];

  bool noticesSeen = false;

  // Preferences
  bool reduceMotion = false;

  // UI and the live tunnel (not persisted)
  int tab = 0;
  Category category = Category.all;
  Phase phase = Phase.idle;
  DateTime? connectedAt;
  final List<Timer> _timers = [];

  Exit get exit => exitById(exitId);
  Plan? get plan => planId == null
      ? null
      : plans.firstWhere((p) => p.id == planId, orElse: () => plans.first);
  bool get busy => phase == Phase.checking || phase == Phase.handshaking;

  String get firstName {
    final local = email.split('@').first.split(RegExp(r'[._-]')).first;
    if (local.isEmpty) return 'there';
    return local[0].toUpperCase() + local.substring(1);
  }

  Duration get elapsed => connectedAt == null
      ? Duration.zero
      : DateTime.now().difference(connectedAt!);

  /// Simulated throughput: about 0.4 MB per second while protected.
  double get liveMegabytes => elapsed.inMilliseconds / 2500;

  int get weekMegabytes =>
      sessions
          .where((s) => DateTime.now().difference(s.start).inDays < 7)
          .fold(0, (a, s) => a + s.megabytes) +
      liveMegabytes.round();

  // ---- persistence ----------------------------------------------------

  void _load() {
    final p = _prefs;
    onboarded = p.getBool('onboarded') ?? false;
    signedIn = p.getBool('signedIn') ?? false;
    email = p.getString('email') ?? '';
    planId = p.getString('plan');
    final te = p.getInt('trialEnds');
    trialEnds = te == null ? null : DateTime.fromMillisecondsSinceEpoch(te);
    killSwitch = p.getBool('killSwitch') ?? true;
    directApps = (p.getStringList('directApps') ?? ['bank']).toSet();
    dns = p.getString('dns') ?? 'pleat';
    protocol = p.getString('protocol') ?? 'WireGuard';
    autoConnect = p.getBool('autoConnect') ?? true;
    autoOnlyUntrusted = p.getBool('autoOnlyUntrusted') ?? true;
    threatFilter = p.getBool('threatFilter') ?? true;
    lan = p.getBool('lan') ?? false;
    exitId = p.getString('exit') ?? 'fra';
    saved = (p.getStringList('saved') ?? ['zrh', 'tyo']).toSet();
    reduceMotion = p.getBool('reduceMotion') ?? false;
    final raw = p.getStringList('sessions');
    sessions = raw == null
        ? _seedSessions()
        : raw
              .map(
                (s) => Session.fromJson(jsonDecode(s) as Map<String, dynamic>),
              )
              .toList();
  }

  List<Session> _seedSessions() {
    final now = DateTime.now();
    Session s(String id, int hoursAgo, int min, int mb, String proto) =>
        Session(
          exitId: id,
          start: now.subtract(Duration(hours: hoursAgo)),
          minutes: min,
          megabytes: mb,
          protocol: proto,
        );
    return [
      s('fra', 3, 42, 318, 'WireGuard'),
      s('ams', 20, 96, 1240, 'WireGuard'),
      s('tyo', 27, 18, 64, 'WireGuard'),
      s('zrh', 49, 131, 870, 'IKEv2'),
      s('lon', 74, 55, 2210, 'WireGuard'),
      s('sto', 120, 12, 38, 'OpenVPN'),
    ];
  }

  void _save() {
    final p = _prefs;
    p.setBool('onboarded', onboarded);
    p.setBool('signedIn', signedIn);
    p.setString('email', email);
    planId == null ? p.remove('plan') : p.setString('plan', planId!);
    trialEnds == null
        ? p.remove('trialEnds')
        : p.setInt('trialEnds', trialEnds!.millisecondsSinceEpoch);
    p.setBool('killSwitch', killSwitch);
    p.setStringList('directApps', directApps.toList());
    p.setString('dns', dns);
    p.setString('protocol', protocol);
    p.setBool('autoConnect', autoConnect);
    p.setBool('autoOnlyUntrusted', autoOnlyUntrusted);
    p.setBool('threatFilter', threatFilter);
    p.setBool('lan', lan);
    p.setString('exit', exitId);
    p.setStringList('saved', saved.toList());
    p.setBool('reduceMotion', reduceMotion);
    p.setStringList(
      'sessions',
      sessions.map((s) => jsonEncode(s.toJson())).toList(),
    );
  }

  void update(void Function(AppState s) change) {
    change(this);
    _save();
    notifyListeners();
  }

  // ---- account --------------------------------------------------------

  void finishOnboarding() => update((s) => s.onboarded = true);

  void signIn(String address) => update((s) {
    s.email = address;
    s.signedIn = true;
    s.tab = 0;
  });

  void signOut() {
    _stopTimers();
    if (phase == Phase.protected) _logSession();
    phase = Phase.idle;
    connectedAt = null;
    update((s) => s.signedIn = false);
  }

  void startTrial(Plan p) => update((s) {
    s.planId = p.id;
    s.trialEnds = DateTime.now().add(Duration(days: int.parse(p.big)));
  });

  // ---- places ---------------------------------------------------------

  void select(String id) => update((s) => s.exitId = id);

  void toggleSaved(String id) => update(
    (s) => s.saved.contains(id) ? s.saved.remove(id) : s.saved.add(id),
  );

  void setCategory(Category c) {
    category = c;
    notifyListeners();
  }

  void setTab(int i) {
    tab = i;
    notifyListeners();
  }

  // ---- tunnel ---------------------------------------------------------

  void _stopTimers() {
    for (final t in _timers) {
      t.cancel();
    }
    _timers.clear();
  }

  /// Starts (or restarts) the demo handshake toward [id] or the current exit.
  void connect([String? id]) {
    if (id != null && id != exitId) {
      if (phase == Phase.protected) _logSession();
      exitId = id;
      _save();
    }
    _stopTimers();
    phase = Phase.checking;
    connectedAt = null;
    notifyListeners();
    _timers.add(
      Timer(PMotion.checking, () {
        phase = Phase.handshaking;
        notifyListeners();
        _timers.add(
          Timer(PMotion.handshake, () {
            phase = Phase.protected;
            connectedAt = DateTime.now();
            notifyListeners();
          }),
        );
      }),
    );
  }

  void cancel() {
    _stopTimers();
    phase = Phase.idle;
    notifyListeners();
  }

  void disconnect() {
    _stopTimers();
    if (phase == Phase.protected) _logSession();
    phase = Phase.idle;
    connectedAt = null;
    _save();
    notifyListeners();
  }

  /// Demo only: lets the dropped-tunnel state be seen and recovered from.
  void simulateDrop() {
    if (phase != Phase.protected) return;
    _logSession();
    phase = Phase.dropped;
    connectedAt = null;
    _save();
    notifyListeners();
  }

  /// The one control: idle → connect, busy → cancel, protected → off.
  void primaryAction() {
    switch (phase) {
      case Phase.idle:
      case Phase.dropped:
        connect();
      case Phase.checking:
      case Phase.handshaking:
        cancel();
      case Phase.protected:
        disconnect();
    }
  }

  void _logSession() {
    if (connectedAt == null) return;
    sessions.insert(
      0,
      Session(
        exitId: exitId,
        start: connectedAt!,
        minutes: (elapsed.inSeconds / 60).ceil().clamp(1, 9999),
        megabytes: liveMegabytes.ceil().clamp(1, 1 << 30),
        protocol: protocol,
      ),
    );
  }

  @override
  void dispose() {
    _stopTimers();
    super.dispose();
  }
}

/// Makes [AppState] available below the app root.
class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child})
    : super(notifier: state);

  static AppState of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;

  static AppState read(BuildContext context) =>
      context.getInheritedWidgetOfExactType<AppScope>()!.notifier!;
}
