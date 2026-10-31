import 'dart:convert';

/// What this phone last measured through each exit, kept per network
/// (the operator the Worker sees: MCI, Irancell, a home line ...), so
/// Locations shows the last results at once and a result from Wi-Fi is
/// never shown on mobile data. Stored in prefs; nothing leaves the phone.
class NetCache {
  NetCache(this._data);

  /// Network id (the Worker's `asn`) -> exit id -> result.
  final Map<String, Map<String, Measure>> _data;

  /// When every exit was last tested on each network.
  final Map<String, DateTime> _testedAt = {};

  /// Networks kept: the ones a phone moves between (home, work, SIM).
  static const keepNetworks = 6;

  /// Results older than this are dropped when saving.
  static const keepFor = Duration(days: 3);

  factory NetCache.decode(String? raw) {
    final c = NetCache({});
    if (raw == null) return c;
    try {
      final j = jsonDecode(raw) as Map<String, dynamic>;
      for (final n in (j['n'] as Map<String, dynamic>).entries) {
        c._data[n.key] = {
          for (final e in (n.value as Map<String, dynamic>).entries)
            e.key: Measure.fromJson(e.value as List),
        };
      }
      for (final t in (j['t'] as Map<String, dynamic>).entries) {
        c._testedAt[t.key] = DateTime.fromMillisecondsSinceEpoch(
          t.value as int,
        );
      }
    } catch (_) {
      return NetCache({});
    }
    return c;
  }

  String encode({DateTime? now}) {
    final cut = (now ?? DateTime.now()).subtract(keepFor);
    for (final m in _data.values) {
      m.removeWhere((_, v) => v.newest.isBefore(cut));
    }
    _data.removeWhere((_, m) => m.isEmpty);
    _testedAt.removeWhere((k, v) => v.isBefore(cut) || !_data.containsKey(k));
    if (_data.length > keepNetworks) {
      final order = _data.keys.toList()
        ..sort((a, b) => _newest(b).compareTo(_newest(a)));
      for (final k in order.skip(keepNetworks)) {
        _data.remove(k);
        _testedAt.remove(k);
      }
    }
    return jsonEncode({
      'n': {
        for (final n in _data.entries)
          n.key: {for (final e in n.value.entries) e.key: e.value.toJson()},
      },
      't': {
        for (final t in _testedAt.entries)
          t.key: t.value.millisecondsSinceEpoch,
      },
    });
  }

  DateTime _newest(String net) =>
      _data[net]!.values.fold(DateTime(2000), (a, m) {
        final n = m.newest;
        return n.isAfter(a) ? n : a;
      });

  Measure? get(String net, String exit) => _data[net]?[exit];

  bool has(String net) => _data[net]?.isNotEmpty ?? false;

  DateTime? testedAt(String net) => _testedAt[net];

  void markTested(String net, DateTime at) => _testedAt[net] = at;

  void putPing(String net, String exit, int ms, DateTime at) {
    final m = (_data[net] ??= {})[exit] ??= Measure();
    m.ms = ms;
    m.msAt = at;
  }

  void putSpeed(String net, String exit, int kbps, DateTime at) {
    final m = (_data[net] ??= {})[exit] ??= Measure();
    m.kbps = kbps;
    m.kbpsAt = at;
  }
}

/// One exit on one network: ping (ms, -1 for no answer) and download
/// speed (kbit/s, -1 for nothing came through), each with its time.
class Measure {
  Measure();

  int? ms;
  DateTime? msAt;
  int? kbps;
  DateTime? kbpsAt;

  DateTime get newest {
    final a = msAt, b = kbpsAt;
    if (a == null) return b ?? DateTime(2000);
    if (b == null) return a;
    return a.isAfter(b) ? a : b;
  }

  factory Measure.fromJson(List j) {
    DateTime? t(Object? v) =>
        v == null ? null : DateTime.fromMillisecondsSinceEpoch(v as int);
    return Measure()
      ..ms = j[0] as int?
      ..msAt = t(j[1])
      ..kbps = j[2] as int?
      ..kbpsAt = t(j[3]);
  }

  List<Object?> toJson() => [
    ms,
    msAt?.millisecondsSinceEpoch,
    kbps,
    kbpsAt?.millisecondsSinceEpoch,
  ];
}
