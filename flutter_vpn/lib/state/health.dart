/// Pleat's automatic health reports: what went wrong on this phone (a crash,
/// an exit that wouldn't connect, a drop, heavy battery use) goes to the
/// Worker so support can see it and fix it, without the person writing in.
///
/// Events wait on the phone (they survive a crash or a dead line), the same
/// problem is folded into one entry with a count, and they leave in batches:
/// critical ones within a minute, high ones every ten minutes at most, the
/// rest every six hours. The Worker caps and dedupes again on its side.
///
/// Nothing that could name a server or a person leaves: no share link, UUID,
/// key, address, IP or e-mail. Servers are named by their anonymous key, the
/// same one the network ranking already uses. The person can turn it off in
/// Profile ("Send diagnostics").
library;

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// Priority by type: 1 critical, 2 high, 3 medium, 4 the daily summary.
/// Mirrors worker/src/health.js TYPES.
const healthTypes = <String, int>{
  'crash': 1,
  'killed': 1,
  'no_exit': 1,
  'connect_fail': 2,
  'drop': 2,
  'silent': 2,
  'unsupported': 2,
  'battery': 3,
  'slow_connect': 3,
  'api_down': 3,
  'update_fail': 3,
  'app_error': 3,
  'daily': 4,
};

final _key = RegExp(r'^[a-z0-9]{6,16}$');
final _codePrefix = RegExp(
  r'^(java|javax|android|androidx|kotlin|kotlinx|dalvik|io\.flutter|app\.pleat|libv2ray|go|com\.android|com\.google\.android|dart|org\.json)\.',
  caseSensitive: false,
);
final _fileExt = RegExp(
  r'\.(dart|kt|java|so|go|c|cc|h|js)$',
  caseSensitive: false,
);

/// Takes out anything that could name a server, an account or a person;
/// the same rules as the Worker's scrub(). Words, numbers, times and code
/// names (a stack frame, a file name) stay.
String scrubText(Object? v, [int max = 160]) {
  var s = '${v ?? ''}'.replaceAll(RegExp(r'[\x00-\x1f\x7f]'), ' ');
  s = s
      .replaceAll(
        RegExp(r'\b[a-z][a-z0-9+.-]{1,15}://\S+', caseSensitive: false),
        '<link>',
      )
      .replaceAll(
        RegExp(
          r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
          caseSensitive: false,
        ),
        '<id>',
      )
      .replaceAll(RegExp(r'[\w.+-]+@[\w-]+(\.[\w-]+)+'), '<email>')
      .replaceAll(RegExp(r'\b\d{1,3}(\.\d{1,3}){3}\b'), '<ip>')
      .replaceAll(
        RegExp(
          r'\[?\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b\]?|\[?(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?\]?',
          caseSensitive: false,
        ),
        '<ip>',
      )
      .replaceAllMapped(
        RegExp(
          r'\b(?:[a-z0-9-]{1,63}\.)+[a-z][a-z0-9-]{1,23}\b',
          caseSensitive: false,
        ),
        (m) => _codePrefix.hasMatch(m[0]!) || _fileExt.hasMatch(m[0]!)
            ? m[0]!
            : '<host>',
      )
      .replaceAll(RegExp(r'[A-Za-z0-9+/_-]{24,}={0,2}'), '<blob>');
  s = s.replaceAll(RegExp(r'\s+'), ' ').trim();
  return s.length > max ? s.substring(0, max) : s;
}

/// A native crash's library and function names ("libc.so abort |
/// libgojni.so runtime.raise"): links, ids, e-mails and IPs still go, but a
/// function name is neither a host nor a key, so it stays readable. The
/// same rule as the Worker's scrubCode().
String scrubCode(Object? v, [int max = 400]) {
  var s = '${v ?? ''}'.replaceAll(RegExp(r'[\x00-\x1f\x7f]'), ' ');
  s = s
      .replaceAll(
        RegExp(r'\b[a-z][a-z0-9+.-]{1,15}://\S+', caseSensitive: false),
        '<link>',
      )
      .replaceAll(
        RegExp(
          r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
          caseSensitive: false,
        ),
        '<id>',
      )
      .replaceAll(RegExp(r'[\w.+-]+@[\w-]+(\.[\w-]+)+'), '<email>')
      .replaceAll(RegExp(r'\b\d{1,3}(\.\d{1,3}){3}\b'), '<ip>');
  s = s.replaceAll(RegExp(r'\s+'), ' ').trim();
  return s.length > max ? s.substring(0, max) : s;
}

/// Flat facts only (numbers, yes/no, short text), every text scrubbed.
Map<String, Object> cleanDetail(Map<String, Object?> d) {
  final out = <String, Object>{};
  for (final e in d.entries.take(16)) {
    final k = e.key.replaceAll(RegExp(r'[^A-Za-z0-9_]'), '');
    final v = e.value;
    if (k.isEmpty || v == null) continue;
    if (v is num && v.isFinite) {
      out[k] = v is int ? v : (v * 100).round() / 100;
    } else if (v is bool) {
      out[k] = v;
    } else if (v is String) {
      final t = k == 'frames'
          ? scrubCode(v, 400)
          : scrubText(v, k == 'trace' ? 400 : (k == 'go' ? 300 : 160));
      if (t.isNotEmpty) out[k] = t;
    } else if (v is List) {
      out[k] = [
        for (final x in v.take(6))
          if (x is Map)
            {
              for (final f in x.entries.take(6))
                if (f.value is num || f.value is bool)
                  '${f.key}': f.value!
                else if (f.key == 'k' && _key.hasMatch('${f.value}'))
                  'k': '${f.value}'
                else
                  '${f.key}': scrubText(f.value, 32),
            }
          else
            scrubText(x, 32),
      ];
    }
  }
  return out;
}

/// The protocols a tunnel carries: the picked exit's, then its backups'
/// (the core may move to one), e.g. "vless/reality/tcp + vmess/none/ws".
String exitProtos(String link, List<String> backups) {
  final first = protoOf(link);
  final rest = [for (final b in backups) protoOf(b)].where((p) => p.isNotEmpty);
  final all = [first, if (rest.isNotEmpty) rest.join(', ')];
  final s = all.where((p) => p.isNotEmpty).join(' + ');
  return s.length > 80 ? s.substring(0, 80) : s;
}

/// Protocol, security and transport of a share link, e.g.
/// "vless/reality/tcp": what support needs, nothing that names the server.
String protoOf(String link) {
  final i = link.indexOf('://');
  if (i <= 0) return '';
  final scheme = link.substring(0, i).toLowerCase();
  final q = Uri.tryParse(link.split('#').first)?.queryParameters ?? const {};
  String word(String? v) {
    final w = (v ?? '').toLowerCase();
    return RegExp(r'^[a-z0-9-]{1,12}$').hasMatch(w) ? w : '';
  }

  return [
    word(scheme),
    word(q['security']),
    word(q['type']),
  ].where((p) => p.isNotEmpty).join('/');
}

class HealthEvent {
  HealthEvent(this.t, this.k, this.c, this.n, this.at, this.last, this.d);

  final String t, k, c;
  int n;
  final int at;
  int last;
  Map<String, Object> d;

  int get p => healthTypes[t] ?? 3;
  String get fp => '$t|$k|$c';

  Map<String, Object> toJson() => {
    't': t,
    if (k.isNotEmpty) 'k': k,
    if (c.isNotEmpty) 'c': c,
    'n': n,
    'at': at,
    'last': last,
    if (d.isNotEmpty) 'd': d,
  };

  static HealthEvent? fromJson(Object? j) {
    if (j is! Map) return null;
    final t = '${j['t'] ?? ''}';
    if (!healthTypes.containsKey(t)) return null;
    final d = j['d'];
    return HealthEvent(
      t,
      '${j['k'] ?? ''}',
      '${j['c'] ?? ''}',
      (j['n'] as num?)?.toInt() ?? 1,
      (j['at'] as num?)?.toInt() ?? 0,
      (j['last'] as num?)?.toInt() ?? 0,
      d is Map ? cleanDetail(d.cast<String, Object?>()) : {},
    );
  }
}

/// What the Worker answered: the decoded JSON, or null when it couldn't be
/// reached (the batch is kept for later).
typedef HealthSend = Future<Map<String, dynamic>?> Function(
  Map<String, Object> body,
);

class HealthLog {
  HealthLog(this._prefs, {DateTime Function()? clock})
    : _clock = clock ?? DateTime.now {
    _load();
  }

  final SharedPreferences _prefs;
  final DateTime Function() _clock;

  static const maxEvents = 200;
  static const maxBatch = 20;
  static const p1Gap = Duration(seconds: 60);
  static const p2Gap = Duration(minutes: 10);
  static const lowGap = Duration(hours: 6);

  /// The person's switch in Profile.
  bool enabled = true;

  /// What the Worker takes now: 'all', 'p2' (critical and high only) or
  /// 'off'. Set from each answer, so the admin can turn reports down.
  String mode = 'all';

  /// The phone's model, Android and Pleat version, Wi-Fi or mobile data.
  final Map<String, String> meta = {};

  /// Something was queued; the app schedules a send.
  void Function()? onQueued;

  List<HealthEvent> _q = [];
  DateTime? _sentAt, _retryAt;
  bool _sending = false;

  List<HealthEvent> get queued => List.unmodifiable(_q);

  int get _now => _clock().millisecondsSinceEpoch ~/ 1000;

  void _load() {
    enabled = _prefs.getBool('health_on') ?? true;
    mode = _prefs.getString('health_mode') ?? 'all';
    final sent = _prefs.getInt('health_sent');
    _sentAt = sent == null ? null : DateTime.fromMillisecondsSinceEpoch(sent);
    try {
      final raw = jsonDecode(_prefs.getString('health_q') ?? '[]');
      _q = [
        for (final j in raw is List ? raw : const []) ?HealthEvent.fromJson(j),
      ];
    } catch (_) {
      _q = [];
    }
  }

  void _save() {
    _prefs.setString('health_q', jsonEncode([for (final e in _q) e.toJson()]));
    _prefs.setString('health_mode', mode);
    final s = _sentAt;
    if (s != null) _prefs.setInt('health_sent', s.millisecondsSinceEpoch);
  }

  void setEnabled(bool on) {
    enabled = on;
    _prefs.setBool('health_on', on);
    if (!on) {
      _q.clear();
      _prefs.remove('health_day');
      _save();
    }
  }

  /// Notes one event. The same type, server and cause again only counts.
  void record(
    String t, {
    String k = '',
    String c = '',
    Map<String, Object?> d = const {},
    int n = 1,
  }) {
    final p = healthTypes[t];
    if (!enabled || p == null) return;
    if (p < 4 && (mode == 'off' || (mode == 'p2' && p > 2))) return;
    final key = _key.hasMatch(k) ? k : '';
    final cause = c.toLowerCase().replaceAll(RegExp(r'[^a-z0-9_.:>-]'), '');
    final e = HealthEvent(
      t,
      key,
      cause.length > 32 ? cause.substring(0, 32) : cause,
      n.clamp(1, 1000),
      _now,
      _now,
      cleanDetail(d),
    );
    final had = _q.where((x) => x.fp == e.fp).firstOrNull;
    if (had != null) {
      had
        ..n = (had.n + e.n).clamp(1, 1000)
        ..last = e.last
        ..d = e.d;
    } else {
      _q.add(e);
      if (_q.length > maxEvents) {
        // the least important, oldest first
        final drop = [..._q]
          ..sort((a, b) => b.p != a.p ? b.p - a.p : a.last - b.last);
        _q.remove(drop.first);
      }
    }
    _save();
    onQueued?.call();
  }

  // ---- the daily summary --------------------------------------------------

  String get _today {
    final d = _clock();
    return '${d.year}-${d.month}-${d.day}';
  }

  Map<String, dynamic> _day() {
    try {
      final j = jsonDecode(_prefs.getString('health_day') ?? '{}');
      if (j is Map<String, dynamic> && j['day'] == _today) return j;
      if (j is Map<String, dynamic> && j['day'] != null) _closeDay(j);
    } catch (_) {}
    return {'day': _today};
  }

  /// Yesterday's counts become one 'daily' event.
  void _closeDay(Map<String, dynamic> j) {
    _prefs.remove('health_day');
    if ((j['sessions'] ?? 0) == 0 && (j['fails'] ?? 0) == 0) return;
    String list(Object? m) => m is Map
        ? (m.entries.toList()..sort((a, b) => '${a.key}'.compareTo('${b.key}')))
              .map((e) => '${e.key} ${e.value}')
              .join(', ')
        : '';
    record(
      'daily',
      d: {
        'sessions': j['sessions'] ?? 0,
        'minutes': j['minutes'] ?? 0,
        'ok': list(j['ok']),
        'fail': list(j['fail']),
        if (j['drain'] != null) 'rate': j['drain'],
      },
    );
  }

  /// A connect (ok) or a failed try on [proto]; [minutes] for a session that
  /// ended.
  void count({String proto = '', bool? ok, int minutes = 0, double? drain}) {
    if (!enabled) return;
    final j = _day();
    final p = proto.isEmpty ? '?' : proto;
    if (ok == true) {
      j['sessions'] = (j['sessions'] ?? 0) + 1;
      final m = Map<String, dynamic>.from(j['ok'] ?? {});
      m[p] = (m[p] ?? 0) + 1;
      j['ok'] = m;
    } else if (ok == false) {
      j['fails'] = (j['fails'] ?? 0) + 1;
      final m = Map<String, dynamic>.from(j['fail'] ?? {});
      m[p] = (m[p] ?? 0) + 1;
      j['fail'] = m;
    }
    if (minutes > 0) j['minutes'] = (j['minutes'] ?? 0) + minutes;
    if (drain != null) j['drain'] = drain;
    _prefs.setString('health_day', jsonEncode(j));
  }

  // ---- sending ------------------------------------------------------------

  Duration get _gap {
    if (_q.any((e) => e.p == 1)) return p1Gap;
    if (_q.any((e) => e.p == 2)) return p2Gap;
    return lowGap;
  }

  /// How long until a send is due; null when nothing waits.
  Duration? get dueIn {
    _day(); // closes yesterday into a 'daily' event
    if (!enabled || _q.isEmpty) return null;
    final now = _clock();
    var at = _sentAt == null ? now : _sentAt!.add(_gap);
    final r = _retryAt;
    if (r != null && r.isAfter(at)) at = r;
    return at.isAfter(now) ? at.difference(now) : Duration.zero;
  }

  /// Sends one batch when one is due (or [force]). True when the Worker took
  /// it; the sent events are then forgotten. A failed send keeps them.
  Future<bool> flush(HealthSend send, {bool force = false}) async {
    final due = dueIn;
    if (_sending || due == null || (!force && due > Duration.zero)) {
      return false;
    }
    _sending = true;
    final batch =
        ([..._q]..sort((a, b) => a.p != b.p ? a.p - b.p : a.at - b.at))
            .take(maxBatch)
            .toList();
    _q.removeWhere(batch.contains);
    try {
      final r = await send({
        ...meta,
        'events': [for (final e in batch) e.toJson()],
      });
      if (r == null || r['ok'] != true) {
        _putBack(batch);
        final retry = (r?['retry'] as num?)?.toInt();
        _retryAt = _clock().add(Duration(seconds: retry ?? 120));
        _save();
        return false;
      }
      final m = '${r['mode'] ?? ''}';
      if (m == 'all' || m == 'p2' || m == 'off') mode = m;
      _sentAt = _clock();
      _retryAt = null;
      _save();
      return true;
    } catch (_) {
      _putBack(batch);
      _retryAt = _clock().add(const Duration(minutes: 2));
      _save();
      return false;
    } finally {
      _sending = false;
    }
  }

  /// A batch that didn't go: back into the queue, merged with anything of
  /// the same kind that came meanwhile.
  void _putBack(List<HealthEvent> batch) {
    for (final e in batch) {
      final had = _q.where((x) => x.fp == e.fp).firstOrNull;
      if (had != null) {
        had.n = (had.n + e.n).clamp(1, 1000);
      } else {
        _q.add(e);
      }
    }
  }
}
