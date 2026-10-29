import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/client.dart';
import '../api/models.dart';
import 'exits.dart';
import 'tunnel.dart';
import 'xray_config.dart';

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
class AppState extends ChangeNotifier with WidgetsBindingObserver {
  AppState(this._prefs, this.api, {Tunnel? tunnel})
    : tunnel = tunnel ?? Tunnel() {
    _load();
    api.onSignedOut = _forgetAccount;
    WidgetsBinding.instance.addObserver(this);
  }

  /// Back from Android's VPN page or from the background: read what may
  /// have changed there (always-on, lockdown) and on the server (plan).
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s != AppLifecycleState.resumed) return;
    if (phase == Phase.protected) readGuard();
    if (signedIn && !me.loading) loadMe();
  }

  final SharedPreferences _prefs;
  final ApiClient api;
  final Tunnel tunnel;

  // ---- on this phone --------------------------------------------------
  bool onboarded = false;
  bool reduceMotion = false;

  /// Test the exits and take the best one; move on when one stops
  /// answering. On by default, as in the Cloud Gold app.
  bool smartConnect = true;

  /// Iranian sites and IPs go direct, QUIC is refused (see `xrayConfig`).
  bool localDirect = true;

  /// The person picked an exit by hand; the big button then uses it
  /// instead of the smart choice.
  bool pinned = false;
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

  /// What a connect attempt is doing right now, for the stage line.
  String? progressNote;
  bool? tunnelAvailable;

  /// The build ships the geo files the local-direct rules need.
  bool geoAvailable = false;

  /// The list shown came from this phone's cache, not from the Worker.
  bool serversStale = false;

  /// Android's always-on / lockdown flags, read while the tunnel runs.
  ({bool alwaysOn, bool lockdown})? guard;
  bool testing = false;
  DateTime? testedAt;
  int _attempt = 0;
  Timer? _watch, _pulse;
  final List<String> _tried = [];
  bool _resynced = false;
  int _misses = 0;
  bool _reported = false;
  Future<void>? _testRun;

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

  /// Best first: answering exits before silent ones, then what this phone
  /// measured (weighted by the network score), then the network score and
  /// reported ping, then the Worker's order.
  List<Exit> get ranked => [...exits]
    ..sort((a, b) {
      if (a.unreachable != b.unreachable) return a.unreachable ? 1 : -1;
      if ((a.measured ?? 0) > 0 || (b.measured ?? 0) > 0) {
        final m = b.smartScore.compareTo(a.smartScore);
        if (m != 0) return m;
      }
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
    smartConnect = p.getBool('smartConnect') ?? true;
    localDirect = p.getBool('localDirect') ?? true;
    pinned = p.getBool('pinned') ?? false;
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
    p.setBool('smartConnect', smartConnect);
    p.setBool('localDirect', localDirect);
    p.setBool('pinned', pinned);
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
    final before = {for (final e in exits) e.id: e};
    await _fetch(servers, () async {
      dynamic data;
      try {
        data = await api.get('/vpn/servers');
        serversStale = false;
        await api.tokens.cacheServers(jsonEncode(data));
      } on ApiError catch (e) {
        // Offline: the last list still connects, as in the Cloud Gold app.
        final cached = e.status == 0 ? await api.tokens.cachedServers() : null;
        if (cached == null) rethrow;
        data = jsonDecode(cached);
        serversStale = true;
      }
      try {
        _ranks = ranksFrom(await api.get('/net/rank'));
      } on ApiError {
        // Keep the last ranking.
      }
      return [
        for (final s in data as List)
          _carry(
            Exit(Server.fromJson((s as Map).cast<String, dynamic>()), null),
            before,
          ),
      ];
    });
    if (servers.error != null) servers.value = null;
  }

  /// Same exit with this list's ranking and the earlier measurement.
  Exit _carry(Exit fresh, Map<String, Exit> before) {
    final e = Exit(fresh.server, _ranks[fresh.id]);
    final old = before[fresh.id];
    if (old != null) {
      e.measured = old.measured;
      e.measuredAt = old.measuredAt;
    }
    return e;
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
    // In parallel: the Worker may take a while on each, waiting on panels.
    await Future.wait([loadPublic(), loadMe(), loadDevices(), loadServers()]);
  }

  // ---- account --------------------------------------------------------

  void finishOnboarding() => update((s) => s.onboarded = true);

  /// Sign in or create the account. Returns the error to show, or null.
  Future<String?> signIn(
    String address,
    String password, {
    bool create = false,
    String invite = '',
  }) async {
    try {
      final data = await api.post(create ? '/auth/register' : '/auth/login', {
        'email': address,
        'password': password,
        'device_id': api.tokens.deviceId,
        'device_model': api.deviceModel,
        if (create && invite.isNotEmpty) 'referral_code': invite,
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
    _stopTimers();
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
    final before = subscription;
    try {
      final data = await api.post('/trial', {'plan_id': p.id});
      if (data is Map) {
        me.value = Me.fromJson(data.cast<String, dynamic>());
        notifyListeners();
      }
    } on ApiError catch (e) {
      // The trial may be built although the answer was lost on the way.
      if (!await _activeAfter(e, before)) return e.message;
    }
    await Future.wait([loadMe(), loadDevices()]);
    await loadServers();
    return null;
  }

  /// After a lost answer (timeout, network): true when the server now shows
  /// an active plan that ends later than [before] did, so the action went
  /// through.
  Future<bool> _activeAfter(ApiError e, Subscription? before) async {
    if (e.status != 0) return false;
    await loadMe();
    final s = subscription;
    if (s == null || !s.active) return false;
    if (before == null) return true;
    final was = before.expiresAt, now = s.expiresAt;
    return was != null && now != null && now.isAfter(was);
  }

  /// Buys [p] from the wallet.
  Future<String?> buyWithWallet(PlanInfo p) async {
    final before = subscription;
    try {
      final order = await api.post('/orders', {
        'plan_id': p.id,
        'method': 'wallet',
        'use_wallet': true,
      });
      final status = order is Map ? order['status'] : null;
      if (status != 'paid') {
        await loadMe();
        return 'The order is $status.';
      }
    } on ApiError catch (e) {
      if (!await _activeAfter(e, before)) return e.message;
    }
    await loadMe();
    await loadServers();
    return null;
  }

  // ---- store ----------------------------------------------------------
  // Same Worker calls as the Cloud Gold app. The Worker decides prices,
  // matches payments and activates plans; Pleat only shows and asks.

  Future<Coupon> checkCoupon(PlanInfo p, String code) async => Coupon.fromJson(
    ((await api.post('/coupons/check', {'code': code, 'plan_id': p.id})) as Map)
        .cast<String, dynamic>(),
  );

  /// Places an order for [plan] or a wallet [topup]. [method] is wallet,
  /// card, crypto or coin; [useWallet] spends the balance first.
  Future<Order> placeOrder({
    PlanInfo? plan,
    int? topup,
    required String method,
    bool useWallet = false,
    String? coupon,
    String? coin,
  }) async {
    final body = <String, Object?>{
      'method': method,
      if (plan != null) ...{
        'plan_id': plan.id,
        'use_wallet': useWallet,
        'coupon_code': ?coupon,
      } else
        'topup_toman': topup,
      'coin': ?coin,
    };
    final o = Order.fromJson(
      ((await api.post('/orders', body)) as Map).cast<String, dynamic>(),
    );
    if (o.status == 'paid') await afterPaid(o);
    return o;
  }

  Future<Order> order(int id) async => Order.fromJson(
    ((await api.get('/orders/$id')) as Map).cast<String, dynamic>(),
  );

  Future<List<Order>> orders() async => [
    for (final o in (await api.get('/orders')) as List)
      Order.fromJson((o as Map).cast<String, dynamic>()),
  ];

  Future<Order> cancelOrder(Order o) async => Order.fromJson(
    ((await api.post('/orders/${o.id}/cancel')) as Map).cast<String, dynamic>(),
  );

  Future<Order> sendReceipt(Order o, List<int> photo, String ref) async =>
      Order.fromJson(
        ((await api.upload(
          '/orders/${o.id}/receipt',
          {'ref': ref},
          file: photo,
          filename: 'receipt.jpg',
        )) as Map).cast<String, dynamic>(),
      );

  /// "I have paid" for a coin order, with the transaction hash if given.
  Future<Order> coinPaid(Order o, String txid) async => Order.fromJson(
    ((await api.post('/orders/${o.id}/paid', {'txid': txid})) as Map)
        .cast<String, dynamic>(),
  );

  Future<WalletInfo> wallet() async {
    final w = WalletInfo.fromJson(
      ((await api.get('/wallet')) as Map).cast<String, dynamic>(),
    );
    return w;
  }

  Future<Referral> referral() async => Referral.fromJson(
    ((await api.get('/referral')) as Map).cast<String, dynamic>(),
  );

  /// After a paid order: the plan and exits as the server now has them.
  Future<void> afterPaid(Order o) async {
    await loadMe();
    if (o.kind == 'plan' || o.planActivated == true) await loadServers();
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

  void select(String id) => update((s) {
    s.exitId = id;
    s.pinned = true;
  });

  void setSmartConnect(bool on) => update((s) {
    s.smartConnect = on;
    if (on) s.pinned = false;
  });

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

  /// Measures every exit through a throw-away core (a few at a time on the
  /// native side), then tells the Worker what worked on this network so
  /// other phones on the same operator rank better.
  Future<void> testAll() => _testRun ??= _testAll().whenComplete(() {
    _testRun = null;
  });

  Future<void> _testAll() async {
    final list = exits;
    if (list.isEmpty || !await tunnel.available()) return;
    testing = true;
    notifyListeners();
    final results = <Map<String, Object>>[];
    await Future.wait(
      list.map((e) async {
        String config;
        try {
          config = xrayConfig(e.server.link, forTest: true);
        } on FormatException {
          return;
        }
        final ms = await tunnel
            .ping(config)
            .timeout(const Duration(seconds: 12), onTimeout: () => null);
        e.measured = ms ?? -1;
        e.measuredAt = DateTime.now();
        results.add({'k': e.id, 'ok': ms != null, 'ms': ms ?? 0});
        notifyListeners();
      }),
    );
    testing = false;
    testedAt = DateTime.now();
    notifyListeners();
    _report(results);
  }

  void _report(List<Map<String, Object>> results) {
    final valid = results.where((r) => serverKeyPattern.hasMatch('${r['k']}'));
    if (valid.isEmpty) return;
    api
        .post('/net/report', {'results': valid.take(60).toList()})
        .then((_) {}, onError: (_) {});
  }

  bool get _pingsFresh =>
      testedAt != null &&
      DateTime.now().difference(testedAt!) < const Duration(minutes: 10) &&
      exits.any((e) => (e.measured ?? 0) > 0);

  /// Best exit not yet tried: one that works for nearly everyone on this
  /// operator, else the best measured here (the Cloud Gold app's rule).
  Future<Exit?> _best() async {
    if (_tried.isEmpty) {
      final strong =
          exits
              .where(
                (e) =>
                    (e.rank?.reports ?? 0) >= 8 && (e.rank?.score ?? 0) >= 0.8,
              )
              .toList()
            ..sort((a, b) => b.rank!.score.compareTo(a.rank!.score));
      if (strong.isNotEmpty) return strong.first;
    }
    if (!_pingsFresh) await testAll();
    final ok =
        exits
            .where((e) => (e.measured ?? 0) > 0 && !_tried.contains(e.id))
            .toList()
          ..sort((a, b) => b.smartScore.compareTo(a.smartScore));
    return ok.isEmpty ? null : ok.first;
  }

  /// Real connect: re-checks the plan and registers this phone with
  /// `GET /vpn`, then asks the platform tunnel for the exit. With smart
  /// connect and no exit picked, the exits are tested first and the best
  /// one is used. Protected is shown only once the tunnel reports up.
  Future<void> connect([String? id]) => _connect(id, failover: false);

  Future<void> _connect(String? id, {required bool failover}) async {
    if (id != null && !failover) pinned = true;
    if (id != null && id != exitId) {
      if (phase == Phase.protected) await _endTunnel(log: true);
      exitId = id;
      _save();
    }
    if (!failover) {
      _tried.clear();
      _resynced = false;
    }
    final attempt = ++_attempt;
    phase = Phase.checking;
    tunnelMessage = null;
    progressNote = null;
    connectedAt = null;
    notifyListeners();
    bool stale() => attempt != _attempt;
    try {
      // The list loads alongside the plan check, not after it.
      final list = servers.ready ? null : loadServers();
      if (!failover) {
        try {
          final v = await api.get('/vpn');
          if (stale()) return;
          final sub = v is Map && v['subscription'] is Map
              ? Subscription.fromJson(
                  (v['subscription'] as Map).cast<String, dynamic>(),
                )
              : null;
          if (sub == null || !sub.active) {
            return _fail(
              sub == null ? 'No active plan.' : '${sub.statusLine}.',
            );
          }
        } on ApiError catch (e) {
          // Like the Cloud Gold app: when the server can't be reached but
          // exits are known, connect anyway. The panels still enforce the
          // plan, so a stopped plan simply won't connect.
          await list;
          if (e.status != 0 || exits.isEmpty) rethrow;
        }
      }
      await list;
      if (stale()) return;
      tunnelAvailable = await tunnel.available();
      if (stale()) return;
      if (!tunnelAvailable!) {
        return _fail(
          'Plan and exit checked. The tunnel engine isn’t in this build, so Pleat can’t protect traffic yet.',
        );
      }
      if (id == null && smartConnect && !pinned && exits.length > 1) {
        progressNote = _pingsFresh ? null : 'Testing exits for the fastest.';
        notifyListeners();
        final best = await _best();
        if (stale()) return;
        progressNote = null;
        if (best != null) {
          exitId = best.id;
          _save();
        } else if (exits.every((e) => e.unreachable)) {
          return _fail('No exit answered. Check the connection and try again.');
        }
      }
      final target = exit;
      if (target == null) {
        return _fail(servers.error ?? 'No exits on your plan yet.');
      }
      _tried.add(target.id);
      geoAvailable = await tunnel.hasGeo();
      final String config;
      try {
        config = xrayConfig(
          target.server.link,
          localDirect: localDirect && geoAvailable,
        );
      } on FormatException {
        if (smartConnect && _failover()) return;
        return _fail(
          'This exit’s protocol (${target.protocol}) can’t run in Pleat yet. Pick another exit.',
        );
      }
      phase = Phase.handshaking;
      notifyListeners();
      tunnel.listen(_onTunnel);
      await tunnel.start(config);
    } on ApiError catch (e) {
      if (!stale()) _fail(e.message);
    } on PlatformException catch (e) {
      if (!stale()) {
        _fail(
          e.code == 'denied'
              ? 'Pleat needs Android’s VPN permission to connect.'
              : 'The tunnel didn’t start.',
        );
      }
    } catch (_) {
      if (!stale()) _fail('The tunnel didn’t start.');
    }
  }

  /// Smart connect: the exit that failed is reported, the next best is
  /// tried (three in all), then the list is fetched again once.
  bool _failover() {
    final cur = exit;
    if (cur != null) {
      cur.measured = -1;
      _report([
        {'k': cur.id, 'ok': false, 'ms': 0},
      ]);
    }
    if (!smartConnect) return false;
    if (_tried.length < 3) {
      final next =
          exits.where((e) => !_tried.contains(e.id) && !e.unreachable).toList()
            ..sort((a, b) => b.smartScore.compareTo(a.smartScore));
      if (next.isNotEmpty) {
        tunnelMessage = null;
        _connect(next.first.id, failover: true);
        return true;
      }
    }
    if (!_resynced) {
      _resynced = true;
      testedAt = null;
      loadServers().then((_) {
        _tried.clear();
        _connect(null, failover: true);
      });
      return true;
    }
    return false;
  }

  void _fail(String message) {
    phase = Phase.idle;
    tunnelMessage = message;
    progressNote = null;
    notifyListeners();
  }

  void _onTunnel(TunnelState s) {
    if (s == TunnelState.up && phase == Phase.handshaking) {
      phase = Phase.protected;
      connectedAt = DateTime.now();
      _misses = 0;
      _reported = false;
      _watch?.cancel();
      _watch = Timer.periodic(const Duration(seconds: 60), (_) => _check());
      _pulse?.cancel();
      _pulse = Timer.periodic(const Duration(seconds: 20), (_) => _beat());
      _beat();
      readGuard();
      notifyListeners();
    } else if (s == TunnelState.down && phase == Phase.protected) {
      _logSession();
      _stopTimers();
      phase = Phase.dropped;
      connectedAt = null;
      tunnelMessage = 'The tunnel dropped.';
      _save();
      notifyListeners();
    } else if ((s == TunnelState.down || s == TunnelState.failed) &&
        phase == Phase.handshaking) {
      if (_failover()) return;
      _fail('The exit didn’t answer. Try another one.');
    }
  }

  /// Live ping through the running tunnel. Two misses in a row with smart
  /// connect on move the session to the next best exit.
  Future<void> _beat() async {
    if (phase != Phase.protected) return;
    final ms = await tunnel.delay();
    final e = exit;
    if (phase != Phase.protected || e == null) return;
    if (ms != null) {
      _misses = 0;
      e.measured = ms;
      e.measuredAt = DateTime.now();
      if (!_reported) {
        _reported = true;
        _report([
          {'k': e.id, 'ok': true, 'ms': ms},
        ]);
      }
      notifyListeners();
      return;
    }
    if (++_misses < 2 || !smartConnect) return;
    _misses = 0;
    _logSession();
    _stopTimers();
    phase = Phase.handshaking;
    connectedAt = null;
    tunnelMessage = null;
    notifyListeners();
    if (!_failover()) {
      await tunnel.stop();
      phase = Phase.dropped;
      tunnelMessage = '${e.title} stopped answering.';
      _save();
      notifyListeners();
    }
  }

  Future<void> readGuard() async {
    guard = await tunnel.policy();
    notifyListeners();
  }

  /// Applies a routing change to a running session by reconnecting to the
  /// same exit.
  Future<void> setLocalDirect(bool on) async {
    update((s) => s.localDirect = on);
    if (phase != Phase.protected || exitId == null) return;
    // The service swaps cores in place, so traffic never leaves bare.
    _logSession();
    final wasPinned = pinned;
    await connect(exitId);
    pinned = wasPinned;
    _save();
  }

  void _stopTimers() {
    _watch?.cancel();
    _pulse?.cancel();
  }

  /// Before the first request: the phone's model and Android version, for
  /// the headers the panel checks with the HWID.
  Future<void> loadDevice() async {
    final d = await tunnel.device();
    if (d == null) return;
    if (d.model.isNotEmpty) api.deviceModel = d.model;
    api.osVersion = d.release;
    // Same phone, same id as the Cloud Gold app: one device on the plan.
    if (d.hwid.length == 32) await api.tokens.useDeviceId(d.hwid);
  }

  /// On launch: a tunnel started earlier may still be running.
  Future<void> resumeTunnel() async {
    tunnelAvailable = await tunnel.available();
    if (tunnelAvailable!) geoAvailable = await tunnel.hasGeo();
    notifyListeners();
    if (await tunnel.current() != TunnelState.up) return;
    tunnel.listen(_onTunnel);
    phase = Phase.handshaking;
    _onTunnel(TunnelState.up);
  }

  /// While a session is up, the plan can stop (quota, expiry). Then the
  /// Worker closes the exits and Home must stop saying Protected.
  Future<void> _check() async {
    await loadMe();
    final s = subscription;
    if (phase == Phase.protected && (s == null || !s.active)) {
      await tunnel.stop();
      _logSession();
      _stopTimers();
      phase = Phase.dropped;
      connectedAt = null;
      tunnelMessage = s == null ? 'Your plan ended.' : '${s.statusLine}.';
      _save();
      notifyListeners();
    }
  }

  Future<void> cancel() async {
    _attempt++;
    progressNote = null;
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
    _stopTimers();
    final running = phase == Phase.protected || phase == Phase.handshaking;
    if (log && phase == Phase.protected) _logSession();
    // Idle first, so the tunnel's own "down" is not read as a drop.
    phase = Phase.idle;
    connectedAt = null;
    _save();
    if (running) await tunnel.stop();
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
    WidgetsBinding.instance.removeObserver(this);
    _stopTimers();
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
