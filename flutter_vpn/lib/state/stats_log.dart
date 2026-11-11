/// What Home's Stats tab draws from. Everything here is counted and kept
/// on the phone (prefs): no new server writes. "All Pleat users" in
/// What works here reads the per-operator ranking the app already gets.
library;

import 'dart:convert';

import 'route_mode.dart';

/// The plan's used data, noted at most once per call to [note] and kept as
/// the last reading of each day, for the Data pace chart.
class UsageLog {
  UsageLog([Map<String, int>? days]) : _days = days ?? {};

  /// 'yyyy-mm-dd' (local day) -> used bytes on the plan at the last reading.
  final Map<String, int> _days;

  static const keepDays = 40;

  factory UsageLog.decode(String? raw) {
    if (raw == null || raw.isEmpty) return UsageLog();
    try {
      final j = jsonDecode(raw) as Map<String, dynamic>;
      return UsageLog({
        for (final e in j.entries) e.key: (e.value as num).toInt(),
      });
    } catch (_) {
      return UsageLog();
    }
  }

  String encode() => jsonEncode(_days);

  static String dayKey(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  static DateTime _day(DateTime d) => DateTime(d.year, d.month, d.day);

  /// A fresh reading of the plan's used bytes.
  void note(int usedBytes, {DateTime? now}) {
    if (usedBytes < 0) return;
    final t = now ?? DateTime.now();
    _days[dayKey(t)] = usedBytes;
    final cut = dayKey(_day(t).subtract(const Duration(days: keepDays)));
    _days.removeWhere((k, _) => k.compareTo(cut) < 0);
  }

  /// Data used on each of the last [n] days, oldest first, ending today.
  /// Null for a day with no reading before and after it (the app wasn't
  /// opened), so the chart shows a gap instead of a made-up zero. A plan
  /// that started again (used went down) counts from zero that day.
  List<(DateTime, int?)> daily(int n, {DateTime? now}) {
    final today = _day(now ?? DateTime.now());
    final out = <(DateTime, int?)>[];
    for (var i = n - 1; i >= 0; i--) {
      final d = today.subtract(Duration(days: i));
      final v = _days[dayKey(d)];
      if (v == null) {
        out.add((d, null));
        continue;
      }
      final prev = _before(d);
      if (prev == null) {
        out.add((d, null));
      } else {
        out.add((d, v >= prev ? v - prev : v));
      }
    }
    return out;
  }

  /// The last reading on a day before [d], or null.
  int? _before(DateTime d) {
    final k = dayKey(d);
    String? best;
    for (final key in _days.keys) {
      if (key.compareTo(k) < 0 && (best == null || key.compareTo(best) > 0)) {
        best = key;
      }
    }
    return best == null ? null : _days[best];
  }

  /// Average bytes per day over the last [n] days that have a value; null
  /// with fewer than two such days (too little to say a pace).
  int? pace({int n = 7, DateTime? now}) {
    final vals = [for (final (_, v) in daily(n, now: now)) ?v];
    if (vals.length < 2) return null;
    return vals.reduce((a, b) => a + b) ~/ vals.length;
  }

  bool get isEmpty => _days.isEmpty;
}

/// One connect attempt: when, whether it came up, and the goal family of
/// the exit tried (Stealth, Speed or Classic).
class Try {
  const Try(this.at, this.ok, this.family);
  final DateTime at;
  final bool ok;
  final RouteMode family;
}

/// Connect attempts per network (the same key as the per-network
/// results), for Hardest hours and What works here.
class ConnectLog {
  ConnectLog([Map<String, List<Try>>? data]) : _data = data ?? {};
  final Map<String, List<Try>> _data;

  static const keepPerNetwork = 400;
  static const keepNetworks = 6;
  static const keepFor = Duration(days: 30);

  factory ConnectLog.decode(String? raw) {
    if (raw == null || raw.isEmpty) return ConnectLog();
    try {
      final j = jsonDecode(raw) as Map<String, dynamic>;
      return ConnectLog({
        for (final e in j.entries)
          e.key: [
            for (final t in e.value as List)
              Try(
                DateTime.fromMillisecondsSinceEpoch(
                  ((t as List)[0] as num).toInt() * 60000,
                ),
                t[1] == 1,
                RouteMode.values[(t[2] as num).toInt().clamp(
                  0,
                  RouteMode.values.length - 1,
                )],
              ),
          ],
      });
    } catch (_) {
      return ConnectLog();
    }
  }

  String encode({DateTime? now}) {
    final cut = (now ?? DateTime.now()).subtract(keepFor);
    for (final l in _data.values) {
      l.removeWhere((t) => t.at.isBefore(cut));
      if (l.length > keepPerNetwork) {
        l.removeRange(0, l.length - keepPerNetwork);
      }
    }
    _data.removeWhere((_, l) => l.isEmpty);
    if (_data.length > keepNetworks) {
      final order = _data.keys.toList()
        ..sort((a, b) => _data[b]!.last.at.compareTo(_data[a]!.last.at));
      for (final k in order.skip(keepNetworks)) {
        _data.remove(k);
      }
    }
    return jsonEncode({
      for (final e in _data.entries)
        e.key: [
          for (final t in e.value)
            [
              t.at.millisecondsSinceEpoch ~/ 60000,
              t.ok ? 1 : 0,
              t.family.index,
            ],
        ],
    });
  }

  void add(String net, Try t) => (_data[net] ??= []).add(t);

  List<Try> of(String net, {Duration within = keepFor, DateTime? now}) {
    final cut = (now ?? DateTime.now()).subtract(within);
    return [
      for (final t in _data[net] ?? const <Try>[])
        if (!t.at.isBefore(cut)) t,
    ];
  }

  /// Failed share of tries by weekday (rows, Saturday first, the Iranian
  /// week) and hour (columns): null where nothing was tried.
  List<List<double?>> hardness(String net, {DateTime? now}) {
    final tries = List.generate(7, (_) => List.filled(24, 0));
    final fails = List.generate(7, (_) => List.filled(24, 0));
    for (final t in of(net, now: now)) {
      final row = t.at.weekday % 7 == 6 ? 0 : (t.at.weekday % 7) + 1;
      tries[row][t.at.hour]++;
      if (!t.ok) fails[row][t.at.hour]++;
    }
    return [
      for (var r = 0; r < 7; r++)
        [
          for (var h = 0; h < 24; h++)
            tries[r][h] == 0 ? null : fails[r][h] / tries[r][h],
        ],
    ];
  }

  /// The hours (start, end exclusive) where most tries failed, with that
  /// window's fail share; null with too few tries to say.
  (int, int, double)? hardestWindow(String net, {DateTime? now}) {
    final tries = List.filled(24, 0), fails = List.filled(24, 0);
    final all = of(net, now: now);
    if (all.length < 10) return null;
    for (final t in all) {
      tries[t.at.hour]++;
      if (!t.ok) fails[t.at.hour]++;
    }
    (int, int, double)? best;
    var bestFails = 0;
    for (var s = 0; s < 24; s++) {
      for (final len in const [1, 2, 3, 4]) {
        // a window starts and ends on hours that had tries
        if (tries[s] == 0 || tries[(s + len - 1) % 24] == 0) continue;
        var n = 0, f = 0;
        for (var i = 0; i < len; i++) {
          n += tries[(s + i) % 24];
          f += fails[(s + i) % 24];
        }
        if (n < 4 || f == 0) continue;
        final share = f / n;
        // the highest failed share; on a tie, the window with more failures
        if (best == null ||
            share > best.$3 + 0.001 ||
            (share > best.$3 - 0.001 && f > bestFails)) {
          best = (s, (s + len) % 24, share);
          bestFails = f;
        }
      }
    }
    return best;
  }

  /// (connected, tried) per goal family on [net] over [within].
  Map<RouteMode, (int, int)> byFamily(
    String net, {
    Duration within = const Duration(days: 7),
    DateTime? now,
  }) {
    final out = <RouteMode, (int, int)>{};
    for (final t in of(net, within: within, now: now)) {
      final (ok, n) = out[t.family] ?? (0, 0);
      out[t.family] = (ok + (t.ok ? 1 : 0), n + 1);
    }
    return out;
  }

  /// Of tries around the hours ([from], [to]) on [net] (an hour either
  /// side), which family got through most: (family, connected, tried).
  /// Null when none got through.
  (RouteMode, int, int)? bestIn(String net, int from, int to, {DateTime? now}) {
    final by = <RouteMode, (int, int)>{};
    final a = (from + 23) % 24, b = (to + 1) % 24;
    for (final t in of(net, now: now)) {
      final h = t.at.hour;
      final inside = a < b ? h >= a && h < b : h >= a || h < b;
      if (!inside) continue;
      final (ok, n) = by[t.family] ?? (0, 0);
      by[t.family] = (ok + (t.ok ? 1 : 0), n + 1);
    }
    (RouteMode, int, int)? best;
    for (final e in by.entries) {
      final (ok, n) = e.value;
      if (n < 3) continue;
      if (best == null || ok / n > best.$2 / best.$3) best = (e.key, ok, n);
    }
    return best == null || best.$2 == 0 ? null : best;
  }
}
