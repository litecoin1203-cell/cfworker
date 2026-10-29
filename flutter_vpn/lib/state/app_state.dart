import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/client.dart';
import '../api/models.dart';
import 'exits.dart';
import 'tunnel.dart';

enum Phase { idle, checking, handshaking, protected, dropped }

/// A tunnel session that really ran on this phone. The backend keeps no
/// session history, so this log is local and starts empty.
class Session {
  Session({
    required this.exitId,
    required this.title,
    required this.start,
    required this.minutes,
    required this.protocol,
  });

  final String exitId, title, protocol;
  final DateTime start;
  final int minutes;

  Map<String, Object> toJson() => {
    'e': exitId,
    't': title,
    's': start.millisecondsSinceEpoch,
    'm': minutes,
    'p': protocol,
  };

  static Session fromJson(Map<String, dynamic> j) => Session(
    exitId: j['e'] as String,
    title: j['t'] as String,
    start: DateTime.fromMillisecondsSinceEpoch(j['s'] as int),
    minutes: j['m'] as int,
    protocol: j['p'] as String,
  );
}

/// A value fetched from the backend, with its loading and error state.
class Remote<T> {
  T? value;
  bool loading = false;
  String? error;
  bool get ready => value != null;
}

/// One notice in the bell sheet, derived from `/app-config` and `/me`.
class Notice {
  const Notice(this.title, this.body, {this.alert = false});
  final String title, body;
  final bool alert;
}

/// App state. Account, plans, servers, usage and devices come from the
/// Cloud Gold Worker through [api]; only display preferences, bookmarks
/// and the local session log live on the phone.
class AppState extends ChangeNotifier {
  AppState(this._prefs, this.api, {Tunnel? tunnel})
    : tunnel = tunnel ?? Tunnel() {
    _load();
    api.onSignedOut = _forgetAccount;
  }

  final SharedPreferences _prefs;
  final ApiClient api;
  final Tunnel tunnel;

  // ---- on this phone --------------------------------------------------
  bool onboarded = false;
  bool reduceMotion = false;
  String? exitId;
  Set<String> saved = {};
  List<Session> sessions = [];
  String noticesSeen = '';

  // ---- from the backend -----------------------------------------------
  final me = Remote<Me>();
  final plans = Remote<List<PlanInfo>>();
  final servers = Remote<List<Exit>>();
  final devices = Remote<List<Device>>();
  AppConfig config = const AppConfig.empty();
  Map<String, Rank> _ranks = const {};

  // ---- UI and the live tunnel (not persisted) ---------------------------
  int tab = 0;
  Category category = Category.all;
  Phase phase = Phase.idle;
  DateTime? connectedAt;

  /// Why the last connect attempt or session ended; shown in the stage line.
  String? tunnelMessage;
  bool? tunnelAvailable;
  int _attempt = 0;
  Timer? _watch;

  bool get signedIn => api.tokens.signedIn;
  bool get busy => phase == Phase.checking || phase == Phase.handshaking;
  String get email => me.value?.email ?? '';
  Subscription? get subscription => me.value?.subscription;

  List<Exit> get exits => servers.value ?? const [];

  Exit? get exit {
    if (exits.isEmpty) return null;
    return exits.firstWhere((e) => e.id == exitId, orElse: () => exits.first);
  }

  Exit? exitById(String id) {
    for (final e in exits) {
      if (e.id == id) return e;
    }
    return null;
  }

  /// Best first: network score, then reported ping, then the Worker's order.
  List<Exit> get ranked => [...exits]
    ..sort((a, b) {
      final s = (b.score ?? -1).compareTo(a.score ?? -1);
      if (s != 0) return s;
      return (a.ping ?? 99999).compareTo(b.ping ?? 99999);
    });

  /// Protocols present in the server list, in first-seen order.
  List<String> get protocols => {for (final e in exits) e.protocol}.toList();

  String get firstName {
    final local = email.split('@').first.split(RegExp(r'[._\-+]')).first;
    if (local.isEmpty) return 'there';
    return local[0].toUpperCase() + local.substring(1);
  }

  Duration get elapsed => connectedAt == null
      ? Duration.zero
      : DateTime.now().difference(connectedAt!);

  // ---- persistence ----------------------------------------------------

  void _load() {
    final p = _prefs;
    onboarded = p.getBool('onboarded') ?? false;
    reduceMotion = p.getBool('reduceMotion') ?? false;
    exitId = p.getString('exit');
    saved = (p.getStringList('saved') ?? const []).toSet();
    noticesSeen = p.getString('noticesSeen') ?? '';
    sessions = (p.getStringList('sessions') ?? const [])
        .map((s) => Session.fromJson(jsonDecode(s) as Map<String, dynamic>))
        .toList();
  }

  void _save() {
    final p = _prefs;
    p.setBool('onboarded', onboarded);
    p.setBool('reduceMotion', reduceMotion);
    exitId == null ? p.remove('exit') : p.setString('exit', exitId!);
    p.setStringList('saved', saved.toList());
    p.setString('noticesSeen', noticesSeen);
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

  // ---- loading --------------------------------------------------------

  Future<void> _fetch<T>(Remote<T> r, Future<T> Function() get) async {
    r.loading = true;
    r.error = null;
    notifyListeners();
    try {
      r.value = await get();
    } on ApiError catch (e) {
      r.error = e.message;
    } finally {
      r.loading = false;
      notifyListeners();
    }
  }

  /// Public data, before sign-in.
  Future<void> loadPublic() async {
    await _fetch(plans, () async {
      final data = await api.get('/plans');
      return [
        for (final p in data as List)
          PlanInfo.fromJson((p as Map).cast<String, dynamic>()),
      ];
    });
    try {
      final c = await api.get('/app-config');
      if (c is Map) config = AppConfig.fromJson(c.cast<String, dynamic>());
      notifyListeners();
    } on ApiError {
      // Notices fall back to what /me says.
    }
  }

  Future<void> loadMe() => _fetch(me, () async {
    final data = await api.get('/me');
    return Me.fromJson((data as Map).cast<String, dynamic>());
  });

  Future<void> loadServers() async {
    await _fetch(servers, () async {
      final data = await api.get('/vpn/servers');
      try {
        _ranks = ranksFrom(await api.get('/net/rank'));
      } on ApiError {
        _ranks = const {};
      }
      return [
        for (final s in data as List)
          Exit(Server.fromJson((s as Map).cast<String, dynamic>()), null),
      ].map((e) => Exit(e.server, _ranks[e.id])).toList();
    });
    if (servers.error != null) servers.value = null;
  }

  Future<void> loadDevices() => _fetch(devices, () async {
    final data = await api.get('/devices');
    return [
      for (final d in data as List)
        Device.fromJson(
          (d as Map).cast<String, dynamic>(),
          api.tokens.deviceId ?? '',
        ),
    ];
  });

  /// Everything a signed-in screen shows.
  Future<void> refreshAccount() async {
    await Future.wait([loadPublic(), loadMe(), loadDevices()]);
    await loadServers();
  }

  // ---- account --------------------------------------------------------

  void finishOnboarding() => update((s) => s.onboarded = true);

  /// Sign in or create the account. Returns the error to show, or null.
  Future<String?> signIn(
    String address,
    String password, {
    bool create = false,
  }) async {
    try {
      final data = await api.post(create ? '/auth/register' : '/auth/login', {
        'email': address,
        'password': password,
        'device_id': api.tokens.deviceId,
        'device_model': 'Pleat',
      });
      await api.tokens.save(
        data['access_token'] as String,
        data['refresh_token'] as String,
      );
      tab = 0;
      await refreshAccount();
      return null;
    } on ApiError catch (e) {
      return e.message;
    }
  }

  /// Clears both tokens and every account value; nothing authenticated is
  /// called after this.
  Future<void> signOut() async {
    await _endTunnel(log: true);
    await api.tokens.clear();
    _forgetAccount();
  }

  /// Ends every session of this account on every phone, then this one.
  Future<String?> signOutEverywhere() async {
    try {
      await api.post('/auth/logout-all');
    } on ApiError catch (e) {
      return e.message;
    }
    await signOut();
    return null;
  }

  void _forgetAccount() {
    _watch?.cancel();
    me.value = null;
    servers.value = null;
    devices.value = null;
    phase = Phase.idle;
    connectedAt = null;
    notifyListeners();
  }

  Future<String?> changePassword(String current, String next) async {
    try {
      final data = await api.post('/auth/change-password', {
        'current_password': current,
        'new_password': next,
      });
      // The Worker ends older sessions and hands this one new tokens.
      await api.tokens.save(
        data['access_token'] as String,
        data['refresh_token'] as String,
      );
      return null;
    } on ApiError catch (e) {
      return e.message;
    }
  }

  Future<String?> startTrial(PlanInfo p) async {
    try {
      await api.post('/trial', {'plan_id': p.id});
    } on ApiError catch (e) {
      return e.message;
    }
    await loadMe();
    await loadServers();
    return null;
  }

  /// Buys [p] from the wallet. Card and crypto stay in the Cloud Gold app.
  Future<String?> buyWithWallet(PlanInfo p) async {
    try {
      final order = await api.post('/orders', {
        'plan_id': p.id,
        'method': 'wallet',
        'use_wallet': true,
      });
      final status = order is Map ? order['status'] : null;
      if (status != 'paid') {
        await loadMe();
        return 'The order is $status. Finish it in the Cloud Gold app.';
      }
    } on ApiError catch (e) {
      return e.message;
    }
    await loadMe();
    await loadServers();
    return null;
  }

  Future<String?> removeDevice(Device d) async {
    try {
      await api.delete('/devices/${d.id}');
    } on ApiError catch (e) {
      return e.message;
    }
    await loadDevices();
    return null;
  }

  // ---- notices --------------------------------------------------------

  List<Notice> get notices {
    final out = <Notice>[];
    if (config.announcement.trim().isNotEmpty) {
      out.add(Notice('From Cloud Gold', config.announcement.trim()));
    }
    final s = subscription;
    if (me.ready && s == null) {
      out.add(
        Notice(
          'No plan yet',
          me.value!.trialAvailable
              ? 'Start the free trial in Plans to get exits.'
              : 'Buy a plan to get exits.',
        ),
      );
    } else if (s != null) {
      if (!s.active) {
        out.add(
          Notice(
            s.statusLine,
            'Exits are closed until the plan is renewed.',
            alert: true,
          ),
        );
      } else {
        final pct = s.usedPercent;
        if (pct != null && pct >= 80) {
          out.add(
            Notice(
              pct >= 100 ? 'Data used up' : '$pct% of data used',
              pct >= 100
                  ? 'The tunnel stops until you renew.'
                  : 'Plan ahead before it runs out.',
              alert: pct >= 95,
            ),
          );
        }
        final d = s.daysLeft;
        if (!s.unlimitedTime && d != null && d <= 3) {
          out.add(
            Notice(
              d <= 0
                  ? 'Plan ends today'
                  : 'Plan ends in $d day${d == 1 ? '' : 's'}',
              'Renew in Plans to keep your exits.',
            ),
          );
        }
      }
    }
    return out;
  }

  String get _noticeKey => notices.map((n) => n.title).join('|');
  bool get hasUnseenNotices => notices.isNotEmpty && _noticeKey != noticesSeen;
  void markNoticesSeen() => update((s) => s.noticesSeen = _noticeKey);

  // ---- places ---------------------------------------------------------

  void select(String id) => update((s) => s.exitId = id);

  /// Bookmarks are stored on this phone; the backend has none.
  void toggleSaved(String id) => update(
    (s) => s.saved.contains(id) ? s.saved.remove(id) : s.saved.add(id),
  );

  /// Picks the best-ranked exit that speaks [protocol].
  void chooseProtocol(String protocol) {
    for (final e in ranked) {
      if (e.protocol == protocol) return select(e.id);
    }
  }

  void setCategory(Category c) {
    category = c;
    notifyListeners();
  }

  void setTab(int i) {
    tab = i;
    notifyListeners();
  }

  // ---- tunnel ---------------------------------------------------------

  /// Real connect: re-checks the plan and registers this phone with
  /// `GET /vpn`, refreshes the list, then asks the platform tunnel for the
  /// chosen config. Protected is shown only once the tunnel reports up.
  Future<void> connect([String? id]) async {
    if (id != null && id != exitId) {
      if (phase == Phase.protected) await _endTunnel(log: true);
      exitId = id;
      _save();
    }
    final attempt = ++_attempt;
    phase = Phase.checking;
    tunnelMessage = null;
    connectedAt = null;
    notifyListeners();
    bool stale() => attempt != _attempt;
    try {
      final v = await api.get('/vpn');
      if (stale()) return;
      final sub = v is Map && v['subscription'] is Map
          ? Subscription.fromJson(
              (v['subscription'] as Map).cast<String, dynamic>(),
            )
          : null;
      if (sub == null || !sub.active) {
        return _fail(sub == null ? 'No active plan.' : '${sub.statusLine}.');
      }
      if (!servers.ready) await loadServers();
      if (stale()) return;
      final target = exit;
      if (target == null) {
        return _fail(servers.error ?? 'No exits on your plan yet.');
      }
      tunnelAvailable = await tunnel.available();
      if (stale()) return;
      if (!tunnelAvailable!) {
        return _fail(
          'Plan and exit checked. The tunnel engine isn’t in this build, so Pleat can’t protect traffic yet.',
        );
      }
      phase = Phase.handshaking;
      notifyListeners();
      tunnel.listen(_onTunnel);
      await tunnel.start(target.server.link);
    } on ApiError catch (e) {
      if (!stale()) _fail(e.message);
    } catch (_) {
      if (!stale()) _fail('The tunnel didn’t start.');
    }
  }

  void _fail(String message) {
    phase = Phase.idle;
    tunnelMessage = message;
    notifyListeners();
  }

  void _onTunnel(TunnelState s) {
    if (s == TunnelState.up && phase == Phase.handshaking) {
      phase = Phase.protected;
      connectedAt = DateTime.now();
      _watch?.cancel();
      _watch = Timer.periodic(const Duration(seconds: 60), (_) => _check());
      notifyListeners();
    } else if (s == TunnelState.down && phase == Phase.protected) {
      _logSession();
      _watch?.cancel();
      phase = Phase.dropped;
      connectedAt = null;
      tunnelMessage = 'The tunnel dropped.';
      _save();
      notifyListeners();
    } else if (s == TunnelState.down && phase == Phase.handshaking) {
      _fail('The exit didn’t answer. Try another one.');
    }
  }

  /// While a session is up, the plan can stop (quota, expiry). Then the
  /// Worker closes the exits and Home must stop saying Protected.
  Future<void> _check() async {
    await loadMe();
    final s = subscription;
    if (phase == Phase.protected && (s == null || !s.active)) {
      await tunnel.stop();
      _logSession();
      _watch?.cancel();
      phase = Phase.dropped;
      connectedAt = null;
      tunnelMessage = s == null ? 'Your plan ended.' : '${s.statusLine}.';
      _save();
      notifyListeners();
    }
  }

  Future<void> cancel() async {
    _attempt++;
    await tunnel.stop();
    phase = Phase.idle;
    notifyListeners();
  }

  Future<void> disconnect() async {
    await _endTunnel(log: true);
    notifyListeners();
  }

  Future<void> _endTunnel({required bool log}) async {
    _attempt++;
    _watch?.cancel();
    if (phase == Phase.protected || phase == Phase.handshaking) {
      await tunnel.stop();
    }
    if (log && phase == Phase.protected) _logSession();
    phase = Phase.idle;
    connectedAt = null;
    _save();
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
    final e = exit;
    if (connectedAt == null || e == null) return;
    sessions.insert(
      0,
      Session(
        exitId: e.id,
        title: e.title,
        start: connectedAt!,
        minutes: (elapsed.inSeconds / 60).ceil().clamp(1, 9999),
        protocol: e.protocol,
      ),
    );
    if (sessions.length > 200) sessions.removeRange(200, sessions.length);
  }

  @override
  void dispose() {
    _watch?.cancel();
    tunnel.dispose();
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
