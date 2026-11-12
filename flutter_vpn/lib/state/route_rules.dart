/// The three Route features on Home and the one order they follow, so
/// they never pull against each other:
///
///  1. An exit picked by hand (Locations) wins over
///     everything below; picking a goal or a country on Home lets it go.
///  2. Stay in one country decides WHERE: only exits in the chosen country
///     are used, the IP stays the same while the exit answers, and another
///     country is used only after the person says yes in a popup.
///  3. Your networks decides HOW (the goal: Stealth, Speed, Classic,
///     Auto) per network. It never changes the country and never moves a
///     session that works; the new goal is used from the next connect or
///     when the exit in use stops.
///  4. Split route decides WHAT skips the VPN (Iranian sites, the
///     person's own sites, chosen apps). It changes no exit choice.
///
/// Protect's Google-clean exits only narrows the pool smart connect uses
/// inside whatever 2 and 3 chose (exits Google places in Iran are left
/// out), never the country; if nothing would be left it steps aside.
library;

import 'dart:convert';

import 'route_mode.dart';

/// What Pleat remembers about one network (an operator over Wi-Fi or
/// mobile data, the same key as the per-network results): the goal used
/// on it, whether the person picked it there, and how connecting went.
class NetRoute {
  NetRoute({
    required this.name,
    required this.mode,
    this.picked = false,
    this.ok = 0,
    this.tries = 0,
    DateTime? at,
  }) : at = at ?? DateTime.now();

  /// "Irancell mobile data", "Shatel Wi-Fi".
  String name;
  RouteMode mode;

  /// The person chose [mode] while on this network (else it is the goal
  /// that was in use when connecting worked).
  bool picked;

  /// Connects that came up, of [tries] on this network.
  int ok, tries;

  /// Last time this phone was on it.
  DateTime at;

  factory NetRoute.fromJson(Map<String, dynamic> j) => NetRoute(
    name: '${j['n'] ?? ''}',
    mode: RouteMode.parse(j['m'] as String?),
    picked: j['p'] == true,
    ok: (j['o'] as num?)?.toInt() ?? 0,
    tries: (j['t'] as num?)?.toInt() ?? 0,
    at: DateTime.fromMillisecondsSinceEpoch((j['a'] as num?)?.toInt() ?? 0),
  );

  Map<String, Object> toJson() => {
    'n': name,
    'm': mode.name,
    'p': picked,
    'o': ok,
    't': tries,
    'a': at.millisecondsSinceEpoch,
  };
}

/// Every network this phone used lately, newest first when listed.
/// Stored in prefs; nothing leaves the phone.
class NetRoutes {
  NetRoutes([Map<String, NetRoute>? data]) : _data = data ?? {};
  final Map<String, NetRoute> _data;

  /// Networks kept (home, work, two SIMs, a café ...).
  static const keep = 8;

  /// Counts are halved past this, so an old run of failures fades.
  static const cap = 40;

  factory NetRoutes.decode(String? raw) {
    if (raw == null || raw.isEmpty) return NetRoutes();
    try {
      final j = jsonDecode(raw) as Map<String, dynamic>;
      return NetRoutes({
        for (final e in j.entries)
          e.key: NetRoute.fromJson((e.value as Map).cast<String, dynamic>()),
      });
    } catch (_) {
      return NetRoutes();
    }
  }

  String encode() {
    if (_data.length > keep) {
      final old = list.skip(keep).map((e) => e.$1).toList();
      for (final k in old) {
        _data.remove(k);
      }
    }
    return jsonEncode({for (final e in _data.entries) e.key: e.value});
  }

  NetRoute? operator [](String key) => _data[key];

  bool get isEmpty => _data.isEmpty;

  /// (key, route), the network used last first.
  List<(String, NetRoute)> get list =>
      [for (final e in _data.entries) (e.key, e.value)]
        ..sort((a, b) => b.$2.at.compareTo(a.$2.at));

  /// The person chose [mode] on this network.
  void pick(String key, String name, RouteMode mode) {
    final r = _data[key] ??= NetRoute(name: name, mode: mode);
    r
      ..name = name
      ..mode = mode
      ..picked = true
      ..at = DateTime.now();
  }

  /// A connect on this network came up ([ok]) or found no exit. A goal the
  /// person never picked here is learned from the connect that worked.
  void note(String key, String name, RouteMode mode, {required bool ok}) {
    final r = _data[key] ??= NetRoute(name: name, mode: mode);
    r
      ..name = name
      ..at = DateTime.now();
    if (ok && !r.picked) r.mode = mode;
    r.tries++;
    if (ok) r.ok++;
    if (r.tries > cap) {
      r.tries = (r.tries / 2).ceil();
      r.ok = (r.ok / 2).ceil().clamp(0, r.tries);
    }
  }

  void forget(String key) => _data.remove(key);
}

/// One way out offered when nothing in the locked country answered.
class LockOption {
  const LockOption({
    required this.country,
    required this.mode,
    required this.title,
    required this.detail,
  });

  /// Country key (code, or title when the exit has no code).
  final String country;
  final RouteMode mode;
  final String title, detail;

  /// Still the person's own country, only another protocol.
  bool get sameCountry => detail.startsWith('Same country');
}

/// The popup: nothing in [country] (with [mode]) answered. Pleat does not
/// move on alone; the person picks one of [options] or stays.
class LockAsk {
  const LockAsk({
    required this.country,
    required this.mode,
    required this.options,
  });
  final String country;
  final RouteMode mode;
  final List<LockOption> options;
}

/// The person's yes to [LockAsk]: valid for one hour, then the first
/// country is tried first again. A session keeps it while it runs.
class LockConsent {
  LockConsent(this.option, this.until);
  final LockOption option;
  final DateTime until;
  bool get live => DateTime.now().isBefore(until);
  static const lasts = Duration(hours: 1);
}

/// A site the person sends past the VPN: lower-case host name, no scheme,
/// path or port, at least one dot. Null when [input] isn't one.
String? siteOf(String input) {
  var s = input.trim().toLowerCase();
  if (s.isEmpty) return null;
  s = s.replaceFirst(RegExp(r'^[a-z][a-z0-9+.-]*://'), '');
  s = s.split('/').first.split('?').first.split('#').first;
  if (s.contains('@')) s = s.split('@').last;
  s = s.replaceFirst(RegExp(r':\d+$'), '');
  if (s.startsWith('www.')) s = s.substring(4);
  if (s.startsWith('*.')) s = s.substring(2);
  if (s.endsWith('.')) s = s.substring(0, s.length - 1);
  final ok = RegExp(
    r'^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9]$',
  ).hasMatch(s);
  return ok ? s : null;
}

/// Apps worth offering first: Iranian package names (ir.*, *.ir, *.ir.*),
/// banks and shops that refuse foreign IPs. A hint only; nothing is
/// picked for the person.
bool looksIranian(String package) {
  final p = package.toLowerCase();
  return p.startsWith('ir.') || p.endsWith('.ir') || p.contains('.ir.');
}
