import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/client.dart';
import '../api/countries.dart';
import '../api/models.dart';
import 'bridge.dart';
import 'diagnose.dart';
import 'exits.dart';
import 'net_cache.dart';
import 'tunnel.dart';
import 'updater.dart';
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

/// A card receipt kept on the phone until the Worker can be reached.
class PendingReceipt {
  PendingReceipt(this.order, this.ref, this.id, this.path);
  final int order;
  final String ref, id, path;

  Map<String, Object> toJson() => {'o': order, 'r': ref, 'i': id, 'p': path};

  static PendingReceipt fromJson(Map<String, dynamic> j) => PendingReceipt(
    j['o'] as int,
    j['r'] as String,
    j['i'] as String,
    j['p'] as String,
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
  const Notice(this.title, this.body, {this.alert = false, this.action});
  final String title, body;
  final bool alert;

  /// 'update': the notice carries an Update button.
  final String? action;
}

/// App state. Account, plans, servers, usage and devices come from the
/// Cloud Gold Worker through [api]; only display preferences, bookmarks
/// and the local session log live on the phone.
class AppState extends ChangeNotifier with WidgetsBindingObserver {
  AppState(this._prefs, this.api, {Tunnel? tunnel})
    : tunnel = tunnel ?? Tunnel() {
    _load();
    _loadReceipts();
    _armReceipts();
    api.onSignedOut = _forgetAccount;
    final login = api.tokens.proxyLogin?.split(':');
    if (login != null && login.length == 2) {
      api.detours = _detours = AppDetours(
        native: this.tunnel,
        login: (user: login[0], pass: login[1]),
        tunnelUp: () => phase == Phase.protected,
        candidates: _bridgeLinks,
      );
    }
    updater = Updater(api)
      ..onChange = notifyListeners
      ..onGone = () => unawaited(loadConfig());
    unawaited(updater.load().then((_) => _offerUpdate()));
    WidgetsBinding.instance.addObserver(this);
  }

  // ---- in-app update ----------------------------------------------------

  late final Updater updater;

  /// The installed Pleat for reports, e.g. "Pleat 1.2.20+23 (arm64-v8a)".
  /// ApiClient.appVersion is the Worker contract version, not this.
  String get appLabel => updater.known
      ? 'Pleat ${updater.version}+${updater.build} (${updater.abi})'
      : ApiClient.appVersion;

  /// The announced build when it is newer than this install and has a file
  /// for this phone; null otherwise.
  AppUpdate? get appUpdate =>
      updater.offers(config.update) ? config.update : null;

  /// The store made this update a must: the sheet can't be closed.
  bool get mustUpdate => appUpdate?.force ?? false;

  /// Asks the shell to open the update sheet (notification tap, a forced
  /// update, the Update buttons).
  final updateSheet = ValueNotifier<int>(0);
  void openUpdate() => updateSheet.value++;

  /// When app-config was read last; read again on return after a while, so
  /// an announcement reaches an app that stays open for days.
  DateTime? _configAt;
  static const configEvery = Duration(hours: 3);

  /// One system notification per announced build, and the sheet at once
  /// when the update is a must.
  void _offerUpdate() {
    final u = appUpdate;
    if (u == null) return;
    if (_prefs.getString('updateNoted') != u.tag) {
      _prefs.setString('updateNoted', u.tag);
      unawaited(updater.notify(u));
    }
    if (u.force) openUpdate();
    notifyListeners();
  }

  /// The tunnel's API port and the bridge; null where the install has no
  /// proxy login (tests).
  AppDetours? _detours;

  /// The bridge is carrying the app's calls right now.
  bool get bridging => _detours?.bridging ?? false;

  /// Bridge links the Worker named (app-config `bridges`), kept for the
  /// next launch, when the Worker may not be reachable at all.
  List<String> _edgeBridges = const [];

  /// What the bridge tries, best first: this account's own exits that
  /// answer here (they already work on this line), then the store's
  /// bridge links (for a phone with no account yet).
  List<String> _bridgeLinks() => {
    for (final e in ranked.where((e) => !e.unreachable).take(3)) e.server.link,
    ..._keptBridges,
    ..._edgeBridges,
    ...splitLinks(buildBridges),
  }.toList();

  /// Exits that worked here before, kept through sign-out (see
  /// [TokenStore.keepBridges]).
  List<String> _keptBridges = const [];

  /// Gets the way to the Worker ready while the sign-in screen is open.
  Future<bool> prepareSignIn() async {
    if (_keptBridges.isEmpty) _keptBridges = await api.tokens.keptBridges();
    return api.warmUp();
  }

  /// Takes the Worker's extra addresses and bridge links from app-config,
  /// and keeps them for the next launch.
  void _learnEdge(Map<dynamic, dynamic> c, {bool save = true}) {
    List<String> strs(Object? v) => [
      for (final x in (v as List?) ?? const []) '$x',
    ];
    final bases = strs(c['api_bases']);
    final bridges = strs(c['bridges']).where((l) => l.contains('://'));
    api.learnBases(bases);
    _edgeBridges = bridges.toList();
    if (save) {
      api.tokens.cache('edge', {'api_bases': bases, 'bridges': _edgeBridges});
    }
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
    flushReceipts();
    if (phase == Phase.protected) {
      readGuard();
      // Back on screen: check the exit now instead of when the next,
      // longer-spaced ping is due.
      _beat();
    }
    if (signedIn && !me.loading) loadMe();
    unawaited(updater.resumed());
    final at = _configAt;
    if (at == null || DateTime.now().difference(at) > configEvery) {
      unawaited(loadConfig());
    } else if (mustUpdate) {
      openUpdate();
    }
    // Back on screen, maybe on another network (home Wi-Fi, mobile data).
    unawaited(measureIfDue());
  }

  /// The app is on screen (not paused or hidden).
  bool _foreground = true;

  final SharedPreferences _prefs;
  final ApiClient api;
  final Tunnel tunnel;

  // ---- on this phone --------------------------------------------------
  bool onboarded = false;
  bool reduceMotion = false;

  /// Day or Night look: 'auto' follows the phone, 'day' and 'night' stick.
  String theme = 'auto';

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
  final packages = Remote<List<Package>>();

  /// Set right after a pick, so the new character shows before /me is
  /// read again. '' means the pick was cleared.
  String? _pickedAvatar;

  /// The Pleat character to show for this person, or '' for none.
  String get avatarId => _pickedAvatar ?? me.value?.avatar ?? '';

  /// True once /me has been read from the server in this run (not only from
  /// the copy kept on the phone).
  bool meFresh = false;

  /// Signed in, account read from the server, and no character picked yet:
  /// the app asks for one before Home.
  bool get needsAvatar => signedIn && meFresh && avatarId.isEmpty;
  AppConfig config = const AppConfig.empty();
  Map<String, Rank> _ranks = const {};

  /// The operator the Worker last saw this phone on (MCI, Irancell, a
  /// home line ...); null until it said. Pleat sits outside its own
  /// tunnel, so this is the real network even while connected.
  NetInfo? network;
  DateTime? _rankAt;

  /// The public IP and place of the exit in use; null until known.
  ExitAddress? exitAddress;

  /// Asks the Worker where this phone's calls come from. Through the
  /// tunnel that is the exit: its public IP, country and city as
  /// Cloudflare places it. Tried twice, as the line may still be settling.
  Future<void> loadExitAddress() async {
    final at = connectedAt;
    for (var i = 0; i < 2; i++) {
      if (phase != Phase.protected || connectedAt != at) return;
      try {
        final r = await api.get('/me/ip', bridge: false);
        if (phase != Phase.protected || connectedAt != at) return;
        final a = ExitAddress.from(r);
        if (a != null) {
          exitAddress = a;
          _pushNote();
          notifyListeners();
          return;
        }
      } on ApiError {
        // try once more below
      }
      await Future<void>.delayed(const Duration(seconds: 3));
    }
  }

  /// Last ping and speed of every exit, per network, kept on the phone.
  NetCache _cache = NetCache({});

  /// Cache key of the current network (operator and Wi-Fi or mobile
  /// data); '0' while it isn't known.
  String get _net => network?.key ?? '0';

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

  /// The running test stops after a few answers (smart connect's quick run).
  bool _testRunPartial = false;

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

  /// Locations' Best: [ranked], keeping only exits this phone measured
  /// on this network or people on it reported, so nothing unknown sits
  /// among them.
  List<Exit> get best => [
    for (final e in ranked)
      if ((e.measured ?? 0) > 0 || e.score != null) e,
  ];

  /// Home's Recommended exits: the strongest few of [best] that answer,
  /// not the one in use. Until anything is measured, the Worker's order.
  static const recommendCount = 4;
  List<Exit> get recommended {
    final current = exit?.id;
    final picked = [
      for (final e in best)
        if (e.id != current && !e.unreachable) e,
    ].take(recommendCount).toList();
    if (picked.isNotEmpty) return picked;
    return ranked.where((e) => e.id != current).take(recommendCount).toList();
  }

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
    theme = switch (p.getString('theme')) {
      'day' => 'day',
      'night' => 'night',
      _ => 'auto',
    };
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
    p.setString('theme', theme);
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

    final edge = read(await t.cached('edge'), (v) => v as Map);
    if (edge != null) _learnEdge(edge, save: false);
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
    await loadConfig();
  }

  /// The store's switches, announcement, extra addresses and update.
  Future<void> loadConfig() async {
    try {
      final c = await api.get('/app-config');
      if (c is Map) {
        config = AppConfig.fromJson(c.cast<String, dynamic>());
        _configAt = DateTime.now();
        _learnEdge(c);
        _offerUpdate();
      }
      notifyListeners();
    } on ApiError {
      // Notices fall back to what /me says.
    }
  }

  Future<void> loadMe() => _fetch(me, () async {
    final data = await api.get('/me');
    final value = _meFrom(data);
    api.tokens.cache('me', data);
    meFresh = true;
    return value;
  });

  Future<void> loadPackages() => _fetch(packages, () async {
    final data = await api.get('/me/packages');
    return [
      for (final p in data as List)
        Package.fromJson((p as Map).cast<String, dynamic>()),
    ];
  });

  /// Verify Telegram on an email account: the same bot and 6-digit code as
  /// a Telegram sign-in, attached to this account.
  Future<TelegramStart> telegramLinkStart() async {
    final data = await api.post('/me/telegram/start');
    return TelegramStart(
      nonce: data['nonce'] as String,
      botUrl: data['bot_url'] as String,
      appUrl: (data['app_url'] as String?) ?? '',
    );
  }

  /// Errors come back as [ApiError].
  Future<void> telegramLinkVerify(String nonce, String code) async {
    await api.post('/me/telegram/verify', {'nonce': nonce, 'code': code});
    await loadMe();
  }

  /// Adds, changes or (with '') removes the backup email. Returns the error
  /// to show, or null.
  /// Pick a Pleat character as the profile picture. The characters are the
  /// only picture (the Telegram photo is not used). Returns an error to
  /// show, or null.
  Future<String?> setAvatar(String id) async {
    try {
      final data = await api.post('/me/avatar', {'avatar': id});
      _pickedAvatar = data is Map ? (data['avatar'] as String? ?? '') : id;
      notifyListeners();
      return null;
    } on ApiError catch (e) {
      return e.message;
    }
  }

  Future<String?> setEmail(String email, String password) async {
    try {
      await api.post('/me/email', {'email': email, 'password': password});
      await loadMe();
      return null;
    } on ApiError catch (e) {
      return e.code == 'wrong_password' ? 'The password is wrong.' : e.message;
    }
  }

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
    final keep = [
      for (final e in ranked.where((e) => !e.unreachable).take(3))
        e.server.link,
    ];
    if (keep.isNotEmpty && keep.join('\n') != _keptBridges.join('\n')) {
      _keptBridges = keep;
      unawaited(api.tokens.keepBridges(keep));
    }
  }

  /// The ranking for the network the Worker sees now. A new network
  /// shows that network's own last results (or none), never the old one's.
  Future<bool> _loadRank() async {
    try {
      final kind = await tunnel.netKind();
      final r = await api.get(
        kind.isEmpty ? '/net/rank' : '/net/rank?kind=$kind',
      );
      _ranks = ranksFrom(r);
      _rankAt = DateTime.now();
      api.tokens.cache('ranks', r);
      final before = _net;
      // The connection type is the phone's own reading; an older Worker
      // does not echo it back.
      final n = NetInfo.from(r);
      if (n != null) {
        network = NetInfo(n.id, n.name, mobile: n.mobile, kind: kind);
      }
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
    unawaited(measureIfDue());
  }

  // ---- account --------------------------------------------------------

  void finishOnboarding() => update((s) => s.onboarded = true);

  /// Sign in or create the account. Returns the error, or null. Its
  /// [ApiError.offline] tells a line that didn't reach the Worker from a
  /// wrong login or password.
  Future<ApiError?> signIn(
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
      return e;
    } catch (_) {
      return ApiError(-1, 'client', 'Something went wrong. Try again.');
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

  /// Telegram step 3 (new accounts): the app password. Returns the error,
  /// or null.
  Future<ApiError?> telegramRegister(
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
      return e;
    } catch (_) {
      return ApiError(-1, 'client', 'Something went wrong. Try again.');
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
    // Receipts belong to the account that signed out.
    for (final r in _pendingReceipts.values) {
      try {
        File(r.path).deleteSync();
      } catch (_) {
        // Already gone.
      }
    }
    _pendingReceipts = {};
    _saveReceipts();
    _armReceipts();
    me.value = null;
    servers.value = null;
    devices.value = null;
    packages.value = null;
    _pickedAvatar = null;
    meFresh = false;
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

  /// Sends the card receipt. Null when the Worker can't be reached: the
  /// photo is then kept on the phone and sent by itself once the line is
  /// back (see [flushReceipts]). Every try carries the same upload id, so
  /// a try that did arrive (its answer lost on the way) isn't sent to the
  /// admin twice.
  Future<Order?> sendReceipt(Order o, List<int> photo, String ref) async {
    final id = _uploadId();
    try {
      return await _upload(o.id, photo, ref, id);
    } on ApiError catch (e) {
      if (e.status != 0) rethrow;
      await _queueReceipt(o.id, photo, ref, id);
      return null;
    }
  }

  Future<Order> _upload(
    int order,
    List<int> photo,
    String ref,
    String id,
  ) async => Order.fromJson(
    ((await api.upload(
      '/orders/$order/receipt',
      {'ref': ref, 'upload_id': id},
      file: photo,
      filename: 'receipt.jpg',
    )) as Map).cast<String, dynamic>(),
  );

  static String _uploadId() {
    final r = Random.secure();
    return List.generate(
      12,
      (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
  }

  /// Receipts waiting for the line, by order id.
  Map<int, PendingReceipt> get pendingReceipts =>
      Map.unmodifiable(_pendingReceipts);
  Map<int, PendingReceipt> _pendingReceipts = {};
  Timer? _receiptTimer;
  bool _flushing = false;

  /// How often a waiting receipt is tried again while the app is open.
  static const receiptRetry = Duration(seconds: 45);

  Future<String> _receiptDir() async {
    final base = await tunnel.filesDir() ?? Directory.systemTemp.path;
    final dir = Directory('$base/receipts');
    await dir.create(recursive: true);
    return dir.path;
  }

  Future<void> _queueReceipt(
    int order,
    List<int> photo,
    String ref,
    String id,
  ) async {
    final path = '${await _receiptDir()}/$order.jpg';
    await File(path).writeAsBytes(photo, flush: true);
    _pendingReceipts[order] = PendingReceipt(order, ref, id, path);
    _saveReceipts();
    _armReceipts();
    notifyListeners();
  }

  void _saveReceipts() => _prefs.setStringList('receipts', [
    for (final r in _pendingReceipts.values) jsonEncode(r.toJson()),
  ]);

  void _loadReceipts() {
    final list = _prefs.getStringList('receipts') ?? const [];
    _pendingReceipts = {};
    for (final raw in list) {
      try {
        final r = PendingReceipt.fromJson(
          (jsonDecode(raw) as Map).cast<String, dynamic>(),
        );
        _pendingReceipts[r.order] = r;
      } catch (_) {
        // A record that no longer parses is dropped.
      }
    }
  }

  void _armReceipts() {
    if (_pendingReceipts.isEmpty) {
      _receiptTimer?.cancel();
      _receiptTimer = null;
      return;
    }
    _receiptTimer ??= Timer.periodic(receiptRetry, (_) {
      if (_foreground) flushReceipts();
    });
  }

  /// Sends every waiting receipt. Called on a timer, when the app comes
  /// back on screen and when the tunnel comes up. A receipt the Worker
  /// refuses for good (the order was paid or cancelled meanwhile) is
  /// dropped; one it can't be reached for stays.
  Future<void> flushReceipts() async {
    if (_flushing || _pendingReceipts.isEmpty || !signedIn) return;
    _flushing = true;
    try {
      for (final r in _pendingReceipts.values.toList()) {
        try {
          final file = File(r.path);
          if (await file.exists()) {
            await _upload(r.order, await file.readAsBytes(), r.ref, r.id);
          }
        } on ApiError catch (e) {
          if (e.status == 0) break; // Still no line; next time.
        }
        _pendingReceipts.remove(r.order);
        try {
          await File(r.path).delete();
        } catch (_) {
          // Already gone.
        }
        _saveReceipts();
        notifyListeners();
      }
    } finally {
      _flushing = false;
      _armReceipts();
    }
  }

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
    final u = appUpdate;
    if (u != null) {
      out.add(
        Notice(
          'Update available',
          'Pleat ${u.version} is ready. Your account and settings stay as they are.',
          action: 'update',
        ),
      );
    }
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

  /// A working exit answers in a second or two. The native side gives
  /// each test 10 s from when it really starts and answers "no answer in
  /// 10 s"; this is only a safety net, above the core's own worst case
  /// (2 tries of 12 s), so a test still queued is never counted as dead.
  static const _probeDeadline = Duration(seconds: 25);

  /// Bumped by Cancel: running exit tests start no new ones.
  int _testGen = 0;

  /// [enough]: stop starting new tests once that many exits answered
  /// (smart connect needs a good exit soon, not every exit measured).
  ///
  /// A full run asked for while a quick one is going waits for it and then
  /// tests every exit: joining it left most exits untested, so the
  /// Connection check showed them as "not tested".
  Future<void> testAll({int? enough}) async {
    while (_testRun != null) {
      final partial = _testRunPartial;
      if (enough != null && !partial) {
        // A full run (the app just opened) tests the likely-best exits
        // first: smart connect goes on as soon as enough of them answered
        // instead of waiting for every exit.
        await Future.any([_testRun!, _answered(enough)]);
        return;
      }
      await _testRun;
      if (enough != null || !partial) return;
    }
    _testRunPartial = enough != null;
    final run = _testAll(enough);
    _testRun = run;
    try {
      await run;
    } finally {
      if (identical(_testRun, run)) _testRun = null;
    }
  }

  /// Exits that answered in the run going now.
  int _runAnswered = 0;
  final List<(int, Completer<void>)> _answerWaits = [];

  /// Done once [n] exits answered in the run going now (or it ended).
  Future<void> _answered(int n) {
    if (_runAnswered >= n) return Future.value();
    final c = Completer<void>();
    _answerWaits.add((n, c));
    return c.future;
  }

  Future<void> _testAll(int? enough) async {
    final list = exits;
    if (list.isEmpty || !await tunnel.available()) return;
    final net = _net;
    testing = true;
    notifyListeners();
    final results = <Map<String, Object>>[];
    var answered = 0;
    _runAnswered = 0;

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
      if (ms != null) {
        answered++;
        _runAnswered = answered;
        for (final w in [..._answerWaits]) {
          if (answered >= w.$1) {
            _answerWaits.remove(w);
            w.$2.complete();
          }
        }
      }
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
    for (final w in _answerWaits) {
      w.$2.complete();
    }
    _answerWaits.clear();
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
    final kind = network?.kind ?? '';
    void send() => api
        .post('/net/report', {
          if (kind.isNotEmpty) 'kind': kind,
          'results': valid,
        })
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

  /// On mobile data (or metered Wi-Fi) as many: about 3 MB every
  /// [speedFresh], at most 12 MB a day, so Best on MCI or Irancell knows
  /// speeds too. 0 would keep metered networks to pings only.
  static const speedTopMetered = 3;

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

  /// The app opened or came back on screen: this network's pings when
  /// they are over [pingFresh] old, then the best few speeds when over
  /// [speedFresh], the same rule as Locations. Nothing while a connect is
  /// coming up (it tests what it needs itself).
  Future<void> measureIfDue() async {
    if (!signedIn || exits.isEmpty || _connecting) return;
    if (!await tunnel.available()) return;
    // Moved between Wi-Fi and mobile data: that network's ranking now.
    final kind = await tunnel.netKind();
    await refreshNetwork(force: kind != (network?.kind ?? ''));
    if (_connecting) return;
    await testSpeeds();
  }

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
    // About 1 MB per exit: fewer (or none) on a metered network. Speeds
    // measured earlier still show.
    metered = await tunnel.metered();
    final top = metered ? speedTopMetered : speedTop;
    if (top == 0) return;
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
    // On a metered network the budget is [speedTopMetered] downloads per
    // [speedFresh] in all, not that many more each time Locations opens.
    final spent = metered && !force
        ? exits
              .where(
                (e) =>
                    e.kbpsAt != null && now.difference(e.kbpsAt!) <= speedFresh,
              )
              .length
        : 0;
    for (final e in queue.take(max(0, top - spent))) {
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

  /// One exit tested alone (nothing else running beside it) with the core's
  /// full log: plain text for the person to send us, with no server
  /// address, key or id in it. Null when a test run is going or there is
  /// no engine.
  Future<String?> traceExit(String id) async {
    final e = exitById(id);
    if (e == null || testing || _testRun != null) return null;
    final String config;
    try {
      config = xrayConfig(e.server.link, forTest: true);
    } on FormatException catch (x) {
      return '${e.label} · ${linkShape(e.server.link)}\nunsupported: ${x.message}';
    }
    final r = await tunnel.trace(config);
    if (r == null) return null;
    final b = StringBuffer()
      ..writeln('Pleat exit trace · $appLabel')
      ..writeln('${e.label} · ${e.protocol} · ${transportOf(e.server.link)}')
      ..writeln('Link: ${linkShape(e.server.link)}')
      ..writeln(
        r.ms != null
            ? 'Result: OK ${r.ms} ms (alone, ${r.took} ms in all)'
            : 'Result: FAIL after ${r.took} ms: ${r.error ?? 'no answer'}',
      )
      ..writeln()
      ..writeln('Core log:')
      ..write(r.log.isEmpty ? '(the core wrote nothing)' : r.log);
    return b.toString();
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
      // Another exit while connected: the running tunnel is kept and the
      // new exit takes it over (the service swaps them without closing the
      // tun), so no app leaves outside the VPN in between.
      if (phase == Phase.protected) {
        _attempt++;
        _stopTimers();
        _logSession();
      }
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
          final v = await api.get('/vpn', bridge: false);
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
          api: _detours?.login,
          backups: _backupsFor(target),
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
        unawaited(_stopTunnel());
        _fail('The exit didn’t answer. Try another one.');
      });
      _pushNote(target);
      _tunnelHeld = true;
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

  /// Smart connect without a pinned exit: the next two best exits go into
  /// the core with the picked one, and the core moves to whichever answers
  /// while the app can't watch (screen off, app asleep).
  List<String> _backupsFor(Exit target) {
    if (!smartConnect || pinned) return const [];
    final next =
        exits
            .where(
              (e) =>
                  e.id != target.id && !e.unreachable && !_tried.contains(e.id),
            )
            .toList()
          ..sort((a, b) => b.smartScore.compareTo(a.smartScore));
    return [for (final e in next.take(2)) e.server.link];
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

  /// A tunnel was started and not stopped since: a failed or abandoned try
  /// must stop it, because the service keeps a failed tun (blocking) for
  /// the next exit instead of opening a gap.
  bool _tunnelHeld = false;

  /// Connected, but the exit stopped answering the live pings (smart
  /// connect off, so it isn't swapped). Home says so.
  bool exitSilent = false;

  Future<void> _stopTunnel() {
    _tunnelHeld = false;
    return tunnel.stop();
  }

  void _fail(String message) {
    if (_tunnelHeld) unawaited(_stopTunnel());
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
      // The tunnel's own port carries the app's calls from now on.
      _detours?.close();
      flushReceipts();
      connectedAt = DateTime.now();
      exitAddress = null;
      _pushNote();
      unawaited(loadExitAddress());
      _misses = 0;
      _reported = false;
      _okStreak = 0;
      _watch?.cancel();
      _watch = Timer.periodic(planCheckEvery, (_) => _check());
      _pulse?.cancel();
      _beat();
      readGuard();
      notifyListeners();
    } else if (s == TunnelState.off &&
        (phase == Phase.protected || phase == Phase.handshaking)) {
      _tunnelHeld = false;
      // Disconnect on the notification: the person's own stop, as the
      // Home control's, so no "dropped" and no failover.
      _attempt++;
      if (phase == Phase.protected) _logSession();
      _stopTimers();
      phase = Phase.idle;
      connectedAt = null;
      tunnelMessage = null;
      _save();
      notifyListeners();
    } else if (s == TunnelState.down && phase == Phase.protected) {
      _tunnelHeld = false;
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
      exitSilent = false;
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
    if (++_misses < 2) return;
    if (!smartConnect) {
      // The person picked this exit and turned smart connect off: it isn't
      // swapped, but Home must stop saying everything is fine.
      if (!exitSilent) {
        exitSilent = true;
        notifyListeners();
      }
      return;
    }
    _misses = 0;
    _logSession();
    _stopTimers();
    phase = Phase.handshaking;
    connectedAt = null;
    tunnelMessage = null;
    notifyListeners();
    if (!_failover()) {
      await _stopTunnel();
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
    exitSilent = false;
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

  /// What the VPN notification says about the exit: the same place and IP
  /// as Home's "Now", once the Worker told them; until then the exit's own
  /// country. Sent on a change only, never on a timer.
  /// [connecting]: the exit being tried, before anything is known of it.
  void _pushNote([Exit? connecting]) {
    final e = connecting ?? exit;
    if (e == null) return;
    final a = connecting == null ? exitAddress : null;
    unawaited(
      tunnel.note(
        flag: a != null && a.cc.isNotEmpty ? flagOf(a.cc) : e.flag,
        place: a != null && a.place.isNotEmpty ? a.place : e.title,
        ip: a?.ip ?? '',
        protocol: e.protocol,
        since: connectedAt,
      ),
    );
  }

  /// On launch: a tunnel started earlier may still be running.
  Future<void> resumeTunnel() async {
    // "Change location" on the notification opens Locations.
    unawaited(
      tunnel.watchOpen((screen) {
        if (screen == 'locations') setTab(2);
        if (screen == 'update') openUpdate();
      }),
    );
    tunnelAvailable = await tunnel.available();
    if (tunnelAvailable!) geoAvailable = await tunnel.hasGeo();
    notifyListeners();
    if (await tunnel.current() != TunnelState.up) return;
    tunnel.listen(_onTunnel);
    _tunnelHeld = true;
    phase = Phase.handshaking;
    _onTunnel(TunnelState.up);
  }

  /// While a session is up, the plan can stop (quota, expiry). Then the
  /// Worker closes the exits and Home must stop saying Protected.
  Future<void> _check() async {
    await loadMe();
    final s = subscription;
    if (phase == Phase.protected && (s == null || !s.active)) {
      await _stopTunnel();
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
    await _stopTunnel();
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
    if (running || _tunnelHeld) await _stopTunnel();
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
