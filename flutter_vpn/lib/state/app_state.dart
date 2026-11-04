import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/client.dart';
import '../api/models.dart';
import 'diagnose.dart';
import 'exits.dart';
import 'net_cache.dart';
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
    if (s == AppLifecycleState.paused || s == AppLifecycleState.hidden) {
      // Off screen: live pings space out further and the download tests,
      // which only Locations shows, stop.
      _foreground = false;
      stopSpeeds();
      return;
    }
    if (s != AppLifecycleState.resumed) return;
    _foreground = true;
    if (phase == Phase.protected) {
      readGuard();
      // Back on screen: check the exit now instead of when the next,
      // longer-spaced ping is due.
      _beat();
    }
    if (signedIn && !me.loading) loadMe();
  }

  /// The app is on screen (not paused or hidden).
  bool _foreground = true;

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

  /// The operator the Worker last saw this phone on (MCI, Irancell, a
  /// home line ...); null until it said. Pleat sits outside its own
  /// tunnel, so this is the real network even while connected.
  NetInfo? network;
  DateTime? _rankAt;

  /// Last ping and speed of every exit, per network, kept on the phone.
  NetCache _cache = NetCache({});

  /// Cache key of the current network; '0' while it isn't known.
  String get _net => network?.id ?? '0';

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

  /// Live pings answered in a row since the session came up.
  int _okStreak = 0;
  bool _beating = false;
  bool _reported = false;
  Future<void>? _testRun;

  bool get signedIn => api.tokens.signedIn;
  bool get busy => phase == Phase.checking || phase == Phase.handshaking;
  String get email => me.value?.email ?? '';

  /// Email, @username or Telegram id: what this account signs in with.
  String get login => me.value?.login ?? email;
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
    final tgName = (me.value?.telegramName ?? '').trim().split(' ').first;
    final local = tgName.isNotEmpty
        ? tgName
        : email.isNotEmpty
        ? email.split('@').first.split(RegExp(r'[._\-+]')).first
        : login.replaceFirst('@', '').split('_').first;
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
    _cache = NetCache.decode(_prefs.getString('netcache'));
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

  /// The last values from this phone's cache, shown at once on launch;
  /// the loaders then refresh them in the background. A cache that no
  /// longer parses is skipped.
  Future<void> warmStart() async {
    final t = api.tokens;
    T? read<T>(String? raw, T Function(Object?) parse) {
      if (raw == null) return null;
      try {
        return parse(jsonDecode(raw));
      } catch (_) {
        return null;
      }
    }

    plans.value ??= read(await t.cached('plans'), _plansFrom);
    if (signedIn) {
      me.value ??= read(await t.cached('me'), _meFrom);
      devices.value ??= read(await t.cached('devices'), _devicesFrom);
      final ranks = await t.cached('ranks');
      _ranks = read(ranks, ranksFrom) ?? _ranks;
      network ??= read<NetInfo?>(ranks, NetInfo.from);
      testedAt ??= _cache.testedAt(_net);
      if (servers.value == null) {
        final list = read(await t.cachedServers(), _exitsFrom);
        if (list != null && list.isNotEmpty) {
          servers.value = list;
          serversStale = true;
        }
      }
    }
    notifyListeners();
  }

  static List<PlanInfo> _plansFrom(Object? data) => [
    for (final p in data as List)
      PlanInfo.fromJson((p as Map).cast<String, dynamic>()),
  ];

  static Me _meFrom(Object? data) =>
      Me.fromJson((data as Map).cast<String, dynamic>());

  List<Device> _devicesFrom(Object? data) => [
    for (final d in data as List)
      Device.fromJson(
        (d as Map).cast<String, dynamic>(),
        api.tokens.deviceId ?? '',
      ),
  ];

  List<Exit> _exitsFrom(Object? data, [Map<String, Exit> before = const {}]) =>
      [
        for (final s in data as List)
          _carry(
            Exit(Server.fromJson((s as Map).cast<String, dynamic>()), null),
            before,
          ),
      ];

  /// Public data, before sign-in.
  Future<void> loadPublic() async {
    await _fetch(plans, () async {
      final data = await api.get('/plans');
      final list = _plansFrom(data);
      api.tokens.cache('plans', data);
      return list;
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
    final value = _meFrom(data);
    api.tokens.cache('me', data);
    return value;
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
      await _loadRank();
      return _exitsFrom(data, before);
    });
    // The Worker said no (not just unreachable, which the cache covers).
    if (servers.error != null) servers.value = null;
  }

  /// The ranking for the network the Worker sees now. A new network
  /// shows that network's own last results (or none), never the old one's.
  Future<bool> _loadRank() async {
    try {
      final r = await api.get('/net/rank');
      _ranks = ranksFrom(r);
      _rankAt = DateTime.now();
      api.tokens.cache('ranks', r);
      final before = _net;
      network = NetInfo.from(r) ?? network;
      if (_net != before) {
        testedAt = _cache.testedAt(_net);
        return true;
      }
      testedAt ??= _cache.testedAt(_net);
    } on ApiError {
      // Keep the last ranking and network.
    }
    return false;
  }

  /// Asks the Worker which network this is, at most every 2 minutes (or
  /// now with [force]), and puts that network's results and ranking on
  /// the exits.
  Future<void> refreshNetwork({bool force = false}) async {
    if (!signedIn || exits.isEmpty) return;
    final at = _rankAt;
    if (!force &&
        at != null &&
        DateTime.now().difference(at) < const Duration(minutes: 2)) {
      return;
    }
    await _loadRank();
    final before = {for (final e in exits) e.id: e};
    servers.value = [for (final e in exits) _carry(e, before)];
    notifyListeners();
  }

  /// Same exit with this list's ranking and the last results on this
  /// network.
  Exit _carry(Exit fresh, Map<String, Exit> before) {
    final e = Exit(fresh.server, _ranks[fresh.id]);
    final m = _cache.get(_net, fresh.id);
    if (m != null) {
      e.measured = m.ms;
      e.measuredAt = m.msAt;
      e.kbps = m.kbps;
      e.kbpsAt = m.kbpsAt;
    }
    // The core's reason for no answer isn't kept; same test, same reason.
    final old = before[fresh.id];
    if (old != null && old.measuredAt == e.measuredAt) e.failure = old.failure;
    return e;
  }

  void _saveCache() => _prefs.setString('netcache', _cache.encode());

  Future<void> loadDevices() => _fetch(devices, () async {
    final data = await api.get('/devices');
    final list = _devicesFrom(data);
    api.tokens.cache('devices', data);
    return list;
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
        create ? 'email' : 'login': address,
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

  /// Telegram step 1: a sign-in link for the bot. The app keeps the nonce;
  /// the bot sends a 6-digit code to whoever opens the link.
  Future<TelegramStart> telegramStart() async {
    final data = await api.post('/auth/tg/start');
    return TelegramStart(
      nonce: data['nonce'] as String,
      botUrl: data['bot_url'] as String,
      appUrl: (data['app_url'] as String?) ?? '',
    );
  }

  /// Telegram step 2: the code from the bot. Signs in when the Telegram
  /// account already has an account; otherwise returns the sign-up ticket
  /// for [telegramRegister]. Errors come back as [ApiError].
  Future<TelegramSignup?> telegramVerify(String nonce, String code) async {
    final data = await api.post('/auth/tg/verify', {
      'nonce': nonce,
      'code': code,
      'device_id': api.tokens.deviceId,
      'device_model': api.deviceModel,
    });
    if (data['need_password'] == true) {
      return TelegramSignup(
        token: data['signup_token'] as String,
        login: (data['login'] as String?) ?? '',
        name: (data['tg_name'] as String?) ?? '',
      );
    }
    await _signedIn(data);
    return null;
  }

  /// Telegram step 3 (new accounts): the app password. Returns the error to
  /// show, or null.
  Future<String?> telegramRegister(
    TelegramSignup s,
    String password, {
    String invite = '',
  }) async {
    try {
      final data = await api.post('/auth/tg/register', {
        'signup_token': s.token,
        'password': password,
        'device_id': api.tokens.deviceId,
        'device_model': api.deviceModel,
        if (invite.isNotEmpty) 'referral_code': invite,
      });
      await _signedIn(data);
      return null;
    } on ApiError catch (e) {
      return e.message;
    }
  }

  Future<void> _signedIn(dynamic data) async {
    await api.tokens.save(
      data['access_token'] as String,
      data['refresh_token'] as String,
    );
    tab = 0;
    await refreshAccount();
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
  /// Exits tested at once; the native test pool has as many threads.
  static const _probeLanes = 6;

  /// A working exit answers in a second or two; 10 s covers a slow one.
  static const _probeDeadline = Duration(seconds: 10);

  /// Bumped by Cancel: running exit tests start no new ones.
  int _testGen = 0;

  /// [enough]: stop starting new tests once that many exits answered
  /// (smart connect needs a good exit soon, not every exit measured).
  Future<void> testAll({int? enough}) =>
      _testRun ??= _testAll(enough).whenComplete(() {
        _testRun = null;
      });

  Future<void> _testAll(int? enough) async {
    final list = exits;
    if (list.isEmpty || !await tunnel.available()) return;
    final net = _net;
    testing = true;
    notifyListeners();
    final results = <Map<String, Object>>[];
    var answered = 0;

    Future<void> probeOne(Exit e) async {
      String config;
      try {
        config = xrayConfig(e.server.link, forTest: true);
      } on FormatException catch (x) {
        e.measured = -1;
        e.failure = 'unsupported: ${x.message}';
        e.measuredAt = DateTime.now();
        return;
      }
      final r = await tunnel
          .probe(config)
          .timeout(
            _probeDeadline,
            onTimeout: () => (
              ms: null,
              error: 'no answer in ${_probeDeadline.inSeconds} s (timeout)',
            ),
          );
      final ms = r.ms;
      if (ms != null) answered++;
      e.measured = ms ?? -1;
      e.failure = ms == null ? r.error : null;
      e.measuredAt = DateTime.now();
      _cache.putPing(net, e.id, e.measured!, e.measuredAt!);
      results.add({'k': e.id, 'ok': ms != null, 'ms': ms ?? 0});
      notifyListeners();
    }

    // The native side tests [_probeLanes] exits at a time, and each test
    // gets its own deadline from when it really starts: one deadline for
    // all of them ran out for those still waiting their turn, so they
    // showed as timeouts without ever being tried. Exits that worked
    // before go first.
    final queue = [...list]
      ..sort((a, b) => b.smartScore.compareTo(a.smartScore));
    final run = _testGen;
    Future<void> lane() async {
      while (queue.isNotEmpty &&
          run == _testGen &&
          (enough == null || answered < enough)) {
        await probeOne(queue.removeAt(0));
      }
    }

    await Future.wait([for (var i = 0; i < _probeLanes; i++) lane()]);
    testing = false;
    testedAt = DateTime.now();
    if (enough == null) _cache.markTested(net, testedAt!);
    _saveCache();
    notifyListeners();
    _report(results);
  }

  DateTime? _reportedAt;

  /// The Worker takes one report per phone every 8 s; a second one
  /// sooner (speeds right after pings) waits its turn.
  void _report(List<Map<String, Object>> results) {
    final valid = results
        .where((r) => serverKeyPattern.hasMatch('${r['k']}'))
        .take(60)
        .toList();
    if (valid.isEmpty) return;
    final now = DateTime.now();
    final last = _reportedAt;
    var wait = Duration.zero;
    if (last != null) {
      final next = last.add(const Duration(seconds: 9));
      if (next.isAfter(now)) wait = next.difference(now);
    }
    _reportedAt = now.add(wait);
    void send() => api
        .post('/net/report', {'results': valid})
        .then((_) {}, onError: (_) {});
    wait == Duration.zero ? send() : Timer(wait, send);
  }

  // ---- download speed --------------------------------------------------

  /// A measured speed is shown, and not measured again, for this long.
  static const speedFresh = Duration(hours: 6);

  /// Locations tests the pings again by itself after this long on the
  /// same network (pull to refresh tests now).
  static const pingFresh = Duration(hours: 1);

  Future<void>? _speedRun;

  /// Only the best few answering exits get a download test: each one is
  /// about 1 MB and a throw-away core.
  static const speedTop = 3;

  /// Bumped when Locations closes or the app leaves the screen: running
  /// download tests start no new ones.
  int _speedGen = 0;

  void stopSpeeds() => _speedGen++;

  /// Measures the download speed of the [speedTop] best exits that
  /// answer, one at a time, skipping ones measured in the last
  /// [speedFresh]. Not run on a metered network. Stops when a connect
  /// starts (it needs the line), on Cancel, and on [stopSpeeds].
  Future<void> testSpeeds({bool force = false}) =>
      _speedRun ??= _testSpeeds(force).whenComplete(() {
        _speedRun = null;
      });

  /// Locations opened: the last results show at once; pings are tested
  /// again only when this network has none or they are over [pingFresh]
  /// old, speeds when over [speedFresh].
  Future<void> openLocations() async {
    await refreshNetwork();
    await testSpeeds();
  }

  /// Pull to refresh on Locations: every exit's ping now; then the best
  /// few speeds go on in the background (not on a metered network).
  Future<void> retestNow() async {
    await refreshNetwork(force: true);
    testedAt = null;
    await testAll();
    unawaited(testSpeeds(force: true));
  }

  bool get _connecting => phase == Phase.checking || phase == Phase.handshaking;

  Future<void> _testSpeeds(bool force) async {
    if (exits.isEmpty || !await tunnel.available()) return;
    // About 1 MB per exit: never on a metered network. Speeds measured
    // earlier still show.
    metered = await tunnel.metered();
    if (metered) return;
    final speedRun = _speedGen;
    if (!_pingsWithin(pingFresh)) await testAll();
    if (speedRun != _speedGen) return;
    final run = _testGen;
    final now = DateTime.now();
    final queue =
        exits
            .where(
              (e) =>
                  (e.measured ?? 0) > 0 &&
                  (force ||
                      e.kbpsAt == null ||
                      now.difference(e.kbpsAt!) > speedFresh),
            )
            .toList()
          ..sort((a, b) => b.smartScore.compareTo(a.smartScore));
    final net = _net;
    final results = <Map<String, Object>>[];
    for (final e in queue.take(speedTop)) {
      if (run != _testGen || speedRun != _speedGen || _connecting) break;
      final String config;
      try {
        config = xrayConfig(e.server.link, forTest: true);
      } on FormatException {
        continue;
      }
      e.speedTesting = true;
      notifyListeners();
      final k = await tunnel
          .speed(config)
          .timeout(const Duration(seconds: 20), onTimeout: () => -1);
      e.speedTesting = false;
      if (k != null) {
        e.kbps = k;
        e.kbpsAt = DateTime.now();
        _cache.putSpeed(net, e.id, k, e.kbpsAt!);
        _saveCache();
        if (k > 0) results.add({'k': e.id, 'kbps': k});
      }
      notifyListeners();
    }
    // Shared with people on the same operator, like the pings.
    _report(results);
  }

  /// Tap on an exit's flag: its ping and download speed now, kept on the
  /// phone for this network and shared with people on the same operator.
  /// The person asked, so the download runs on a metered network too.
  Future<void> testOne(String id) async {
    final e = exitById(id);
    if (e == null || e.busy || _connecting || !await tunnel.available()) {
      return;
    }
    final String config;
    try {
      config = xrayConfig(e.server.link, forTest: true);
    } on FormatException catch (x) {
      e.measured = -1;
      e.failure = 'unsupported: ${x.message}';
      e.measuredAt = DateTime.now();
      notifyListeners();
      return;
    }
    final net = _net;
    e.pingTesting = true;
    notifyListeners();
    final r = await tunnel
        .probe(config)
        .timeout(
          _probeDeadline,
          onTimeout: () => (
            ms: null,
            error: 'no answer in ${_probeDeadline.inSeconds} s (timeout)',
          ),
        );
    final ms = r.ms;
    e.pingTesting = false;
    e.measured = ms ?? -1;
    e.failure = ms == null ? r.error : null;
    e.measuredAt = DateTime.now();
    _cache.putPing(net, e.id, e.measured!, e.measuredAt!);
    final result = <String, Object>{'k': e.id, 'ok': ms != null, 'ms': ms ?? 0};
    if (ms != null && !_connecting) {
      e.speedTesting = true;
      notifyListeners();
      final k = await tunnel
          .speed(config)
          .timeout(const Duration(seconds: 20), onTimeout: () => -1);
      e.speedTesting = false;
      if (k != null) {
        e.kbps = k;
        e.kbpsAt = DateTime.now();
        _cache.putSpeed(net, e.id, k, e.kbpsAt!);
        if (k > 0) result['kbps'] = k;
      }
    }
    _saveCache();
    notifyListeners();
    _report([result]);
  }

  /// Smart connect tests again after 10 minutes: it needs an exit that
  /// answers now.
  bool get _pingsFresh => _pingsWithin(const Duration(minutes: 10));

  bool _pingsWithin(Duration d) =>
      testedAt != null &&
      DateTime.now().difference(testedAt!) < d &&
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
    if (!_pingsFresh) await testAll(enough: 3);
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
      _started = false;
      _handshake?.cancel();
      // The service tries the exit for up to ~30 s; past that, say so
      // instead of spinning.
      _handshake = Timer(const Duration(seconds: 45), () {
        if (stale() || phase != Phase.handshaking) return;
        tunnel.stop();
        _fail('The exit didn’t answer. Try another one.');
      });
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

  /// The service said "starting" for this attempt; until then a "down" or
  /// "failed" is left over from before and means nothing.
  bool _started = false;
  Timer? _handshake;

  void _onTunnel(TunnelState s) {
    if (s == TunnelState.starting) {
      _started = true;
      return;
    }
    if (s != TunnelState.up && phase == Phase.handshaking && !_started) {
      return;
    }
    if (s != TunnelState.starting) _handshake?.cancel();
    if (s == TunnelState.up && phase == Phase.handshaking) {
      phase = Phase.protected;
      connectedAt = DateTime.now();
      _misses = 0;
      _reported = false;
      _okStreak = 0;
      _watch?.cancel();
      _watch = Timer.periodic(planCheckEvery, (_) => _check());
      _pulse?.cancel();
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
      final why = exit?.failure;
      _fail(
        why == null
            ? 'The exit didn’t answer. Try another one.'
            : '${diagnose(why).title}. ${diagnose(why).fix}',
      );
    }
  }

  /// While a session is up, how often the plan is read again (it can stop
  /// on quota or expiry). Coming back to the app also reads it.
  static const planCheckEvery = Duration(minutes: 10);

  /// Live-ping spacing. Every ping is an HTTPS request through the exit,
  /// and on mobile data each one keeps the radio awake for several
  /// seconds, so pings space out while the exit keeps answering: 20 s for
  /// the first six (about two minutes) and after any miss, then 60 s,
  /// 120 s and at most 300 s. On screen the spacing stays at most 60 s.
  static const pulseSteps = [
    Duration(seconds: 20),
    Duration(seconds: 60),
    Duration(seconds: 120),
    Duration(seconds: 300),
  ];

  /// On a metered network (mobile data, or Wi-Fi marked metered) pings
  /// space out sooner and further: 20 s for the first three and after any
  /// miss, then 120 s, 300 s and at most 600 s; at most 120 s on screen.
  static const pulseStepsMetered = [
    Duration(seconds: 20),
    Duration(seconds: 120),
    Duration(seconds: 300),
    Duration(seconds: 600),
  ];

  /// Answered pings in a row that move the spacing one step up.
  static const _pulseFirst = 6, _pulseFirstMetered = 3, _pulsePer = 3;

  /// The phone's own network is metered (Pleat sits outside its tunnel, so
  /// Android answers for the real network). Read before every live ping.
  bool metered = false;

  Duration get pulseGap {
    final steps = metered ? pulseStepsMetered : pulseSteps;
    final first = metered ? _pulseFirstMetered : _pulseFirst;
    if (_misses > 0 || _okStreak < first) return steps.first;
    var i = 1 + (_okStreak - first) ~/ _pulsePer;
    i = i.clamp(1, _foreground ? 1 : steps.length - 1);
    return steps[i];
  }

  void _schedulePulse() {
    _pulse?.cancel();
    if (phase != Phase.protected) return;
    _pulse = Timer(pulseGap, _beat);
  }

  /// Live ping through the running tunnel. Two misses in a row with smart
  /// connect on move the session to the next best exit; the ping after a
  /// miss comes after 20 s, as before.
  Future<void> _beat() async {
    if (phase != Phase.protected || _beating) return;
    _pulse?.cancel();
    _beating = true;
    try {
      await _beatOnce();
    } finally {
      _beating = false;
      _schedulePulse();
    }
  }

  Future<void> _beatOnce() async {
    metered = await tunnel.metered();
    final ms = await tunnel.delay();
    final e = exit;
    if (phase != Phase.protected || e == null) return;
    if (ms != null) {
      _misses = 0;
      _okStreak++;
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
    _okStreak = 0;
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
    _handshake?.cancel();
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

  /// Stops at once: the screen goes idle first, then the tunnel and any
  /// exit tests still running are told to stop.
  Future<void> cancel() async {
    _attempt++;
    _testGen++;
    _handshake?.cancel();
    progressNote = null;
    phase = Phase.idle;
    notifyListeners();
    await tunnel.stop();
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

class TelegramStart {
  const TelegramStart({
    required this.nonce,
    required this.botUrl,
    required this.appUrl,
  });
  final String nonce;

  /// https://t.me/... link; [appUrl] is the tg:// one that opens the app.
  final String botUrl;
  final String appUrl;
}

class TelegramSignup {
  const TelegramSignup({
    required this.token,
    required this.login,
    required this.name,
  });
  final String token;

  /// @username, or the numeric Telegram id.
  final String login;
  final String name;
}
