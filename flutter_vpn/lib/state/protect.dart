/// Protect's checks, as plain data: what Google sees of each exit, and the
/// privacy check's rows. Kept free of Flutter so the rules are tested on
/// their own; the screens only draw them.
library;

import 'dart:convert';

/// Places Gemini is closed to; there "doesn't open" says where Google
/// put the address, elsewhere it says nothing.
const geminiClosed = {'IR', 'CN', 'RU', 'KP', 'SY', 'CU', 'BY', 'HK', 'MO'};

/// What Google sees of one exit: the country it gives the exit's address,
/// whether Gemini opens and whether Search walls it off.
class GoogleView {
  const GoogleView({
    required this.cc,
    required this.at,
    this.gemini,
    this.wall = false,
    this.people = 1,
    this.mine = false,
    this.iranVotes = false,
  });

  /// Google's country for the address ("DE"); null when YouTube didn't say.
  final String? cc;

  /// Gemini opened; false when it is closed to [cc]; null when unclear.
  final bool? gemini;

  /// Search answered with its "unusual traffic" wall.
  final bool wall;
  final DateTime at;

  /// Tests behind it (others' and this phone's).
  final int people;

  /// This phone's own test (else other Pleat users').
  final bool mine;

  /// Most of the shared tests said Iran.
  final bool iranVotes;

  /// Google places this exit in Iran.
  bool get iran => mine ? cc == 'IR' : iranVotes;

  /// This phone's own test, from the native Probe's fields; null when it
  /// reached nothing.
  static GoogleView? fromProbe(Map<String, Object?> j, DateTime now) {
    final cc = _cc(j['google_cc']);
    if (cc == null && j['reached'] != true) return null;
    return GoogleView(
      cc: cc,
      at: now,
      gemini: j['gemini'] == true
          ? true
          : (cc != null && geminiClosed.contains(cc) ? false : null),
      wall: j['google_blocked'] == true,
      mine: true,
    );
  }

  /// The Worker's shared view of one exit (`google` in /net/rank).
  static GoogleView? fromShared(Object? raw) {
    if (raw is! Map) return null;
    final at = (raw['at'] as num?)?.toInt();
    final tests = (raw['tests'] as num?)?.toInt() ?? 0;
    if (at == null || tests <= 0) return null;
    final status = '${raw['status'] ?? ''}';
    final share = (raw['gemini'] as num?)?.toDouble();
    return GoogleView(
      cc: _cc(raw['google_cc']),
      at: DateTime.fromMillisecondsSinceEpoch(at * 1000),
      gemini: share == null ? null : share >= 0.5,
      wall: status == 'flagged',
      people: tests,
      iranVotes: status == 'iran',
    );
  }

  Map<String, Object?> toJson() => {
    'c': cc,
    'g': gemini,
    'w': wall,
    'a': at.millisecondsSinceEpoch,
  };

  static GoogleView? fromJson(Object? j) {
    if (j is! Map) return null;
    final a = (j['a'] as num?)?.toInt();
    if (a == null) return null;
    return GoogleView(
      cc: _cc(j['c']),
      at: DateTime.fromMillisecondsSinceEpoch(a),
      gemini: j['g'] as bool?,
      wall: j['w'] == true,
      mine: true,
    );
  }
}

String? _cc(Object? v) {
  final s = '${v ?? ''}'.trim().toUpperCase();
  return RegExp(r'^[A-Z]{2}$').hasMatch(s) ? s : null;
}

/// This phone's own Google tests, by exit key, kept a week.
class GoogleLog {
  GoogleLog([Map<String, GoogleView>? data]) : _data = data ?? {};
  final Map<String, GoogleView> _data;

  /// Own results win over shared ones for this long.
  static const fresh = Duration(hours: 24);
  static const keep = Duration(days: 7);

  GoogleView? operator [](String k) => _data[k];
  void put(String k, GoogleView v) => _data[k] = v;
  Iterable<String> get keys => _data.keys;

  factory GoogleLog.decode(String? raw) {
    if (raw == null || raw.isEmpty) return GoogleLog();
    try {
      final j = jsonDecode(raw);
      if (j is! Map) return GoogleLog();
      final cut = DateTime.now().subtract(keep);
      return GoogleLog({
        for (final e in j.entries)
          if (GoogleView.fromJson(e.value) case final v?)
            if (v.at.isAfter(cut)) '${e.key}': v,
      });
    } on FormatException {
      return GoogleLog();
    }
  }

  String encode() =>
      jsonEncode({for (final e in _data.entries) e.key: e.value.toJson()});

  /// What Pleat goes by for exit [k]: this phone's test while [fresh],
  /// else the shared one, else the older own test.
  GoogleView? pick(String k, GoogleView? shared, DateTime now) {
    final own = _data[k];
    if (own != null && now.difference(own.at) < fresh) return own;
    if (shared != null) return shared;
    return own;
  }
}

// ---- the privacy check -----------------------------------------------------

enum Mark { ok, warn, note, none }

/// What a row's lead shows: an icon by name, or a country's flag.
class LeakRow {
  const LeakRow({
    required this.icon,
    required this.title,
    required this.sub,
    required this.value,
    required this.verdict,
    this.flag,
  });
  final String icon, title, sub, value;
  final Mark verdict;

  /// A country code drawn as a flag before [value].
  final String? flag;
}

class LeakGroup {
  const LeakGroup(this.title, this.rows);
  final String title;
  final List<LeakRow> rows;
}

/// What the check knows besides the native results.
typedef LeakContext = ({
  bool lockdown,
  int bypassApps,
  String dns,
  String exitLabel,
  String network,
});

/// One run of the privacy check: the native results turned into rows.
class LeakReport {
  LeakReport(this.raw, this.ctx, this.at, this.took);

  final Map<String, Object?> raw;
  final LeakContext ctx;
  final DateTime at;
  final Duration took;

  late final List<LeakGroup> groups = _groups();

  Iterable<LeakRow> get rows => groups.expand((g) => g.rows);
  int get tests => rows.length;
  int get passed => rows.where((r) => r.verdict == Mark.ok).length;
  int get warnings => rows.where((r) => r.verdict == Mark.warn).length;
  int get notes => rows.where((r) => r.verdict == Mark.note).length;

  /// The country most sites see (Cloudflare), else an IP database's.
  String? get siteCc => _s('cc') ?? _s('ipinfo_cc') ?? _s('ipwho_cc');
  String? get googleCc => _s('google_cc');

  String? _s(String k) {
    final v = raw[k];
    if (v == null) return null;
    final s = '$v'.trim();
    return s.isEmpty ? null : s;
  }

  bool get _homeKnown => _s('home_ip') != null;
  bool _isHome(String? ip) => ip != null && ip == _s('home_ip');

  List<LeakGroup> _groups() {
    final cc = _s('cc');
    final gcc = googleCc;
    final gem = raw['gemini'];
    final wall = raw['google_blocked'];
    final reached = raw['reached'] == true;
    final dbs = [_s('ipinfo_cc'), _s('ipwho_cc')].whereType<String>().toList();
    final org = _shortOrg(_s('ipinfo_org') ?? _s('ipwho_org'));
    final seen = [
      _s('ip'),
      _s('ipinfo_ip'),
      _s('stun_ip'),
      _s('dns_seen'),
      _s('v6_ip'),
    ].whereType<String>();
    final dnsSeen = _s('dns_seen');
    final dnsOk = raw['dns_ok'] == true || dnsSeen != null;
    final ecs = _s('dns_ecs');
    final stun = _s('stun_ip');
    final v6 = _s('v6');
    final tz = _s('tz');
    final sim = _s('sim_cc');
    final loc = raw['location_on'];

    Mark iranOr(String? c) =>
        c == null ? Mark.none : (c == 'IR' ? Mark.warn : Mark.ok);

    return [
      LeakGroup('WHAT SITES SEE', [
        LeakRow(
          icon: 'globe',
          title: 'Cloudflare',
          sub: 'Where most sites place you',
          value: cc ?? 'No answer',
          flag: cc,
          verdict: iranOr(cc),
        ),
        LeakRow(
          icon: 'globe',
          title: 'Google · YouTube',
          sub: gcc == 'IR'
              ? 'Google still sees Iran on this exit'
              : 'The country Google gives you',
          value: gcc ?? (reached ? 'Unclear' : 'No answer'),
          flag: gcc,
          verdict: iranOr(gcc),
        ),
        LeakRow(
          icon: 'globe',
          title: 'Google · Gemini',
          sub: 'Closed to Iran, so it shows where Google puts you',
          value: gem == true
              ? 'Opens'
              : (gcc != null && geminiClosed.contains(gcc)
                    ? 'Closed'
                    : (reached ? 'Unclear' : 'No answer')),
          verdict: gem == true
              ? Mark.ok
              : (gcc == 'IR' ? Mark.warn : Mark.none),
        ),
        LeakRow(
          icon: 'search',
          title: 'Google Search',
          sub: wall == true
              ? 'Google asks this address to prove it’s human'
              : 'No “unusual traffic” wall',
          value: wall == null
              ? 'No answer'
              : (wall == true ? 'Wall' : 'Answers'),
          verdict: wall == null
              ? Mark.none
              : (wall == true ? Mark.warn : Mark.ok),
        ),
        LeakRow(
          icon: 'filter',
          title: 'IP databases',
          sub: 'ipinfo and ipwho.is, used by many apps',
          value: dbs.isEmpty ? 'No answer' : dbs.join(' · '),
          flag: dbs.isEmpty ? null : dbs.first,
          verdict: dbs.isEmpty
              ? Mark.none
              : (dbs.contains('IR') ? Mark.warn : Mark.ok),
        ),
        LeakRow(
          icon: 'device',
          title: 'Exit network',
          sub: 'The company the exit’s address belongs to',
          value: org ?? 'Unknown',
          verdict: Mark.none,
        ),
        LeakRow(
          icon: 'user',
          title: 'Your Iran IP',
          sub: 'Asked outside the tunnel, then looked for through it',
          value: !_homeKnown || seen.isEmpty
              ? 'Not checked'
              : (seen.any(_isHome) ? 'Visible' : 'Hidden'),
          verdict: !_homeKnown || seen.isEmpty
              ? Mark.none
              : (seen.any(_isHome) ? Mark.warn : Mark.ok),
        ),
      ]),
      LeakGroup('DNS', [
        LeakRow(
          icon: 'dns',
          title: 'Resolver that answered',
          sub: 'Cloudflare ${ctx.dns}, asked through the exit',
          value: !dnsOk
              ? 'No answer'
              : (_isHome(dnsSeen) ? 'Your line' : 'Cloudflare'),
          verdict: !dnsOk
              ? Mark.none
              : (_isHome(dnsSeen) ? Mark.warn : Mark.ok),
        ),
        LeakRow(
          icon: 'dns',
          title: 'Operator’s DNS',
          sub: _isHome(dnsSeen)
              ? 'Lookups leave on your own line'
              : '${ctx.network.isEmpty ? 'Your operator' : ctx.network} never sees the names you open',
          value: !dnsOk
              ? 'No answer'
              : (_isHome(dnsSeen) ? 'Used' : 'Not used'),
          verdict: !dnsOk
              ? Mark.none
              : (_isHome(dnsSeen) ? Mark.warn : Mark.ok),
        ),
        LeakRow(
          icon: 'dns',
          title: 'Client subnet (ECS)',
          sub: ecs != null && _sameArea(ecs)
              ? 'Sites learn the area you are in'
              : 'Your area isn’t passed on to sites',
          value: !dnsOk && ecs == null
              ? 'No answer'
              : (ecs == null
                    ? 'None'
                    : (_sameArea(ecs) ? 'Your area' : 'Exit’s area')),
          verdict: !dnsOk && ecs == null
              ? Mark.none
              : (ecs != null && _sameArea(ecs) ? Mark.warn : Mark.ok),
        ),
      ]),
      LeakGroup('AROUND THE TUNNEL', [
        LeakRow(
          icon: 'layers',
          title: 'IPv6',
          sub: v6 == 'through'
              ? 'Carried by the exit, never around it'
              : 'A request over IPv6 is refused, not sent around',
          value: v6 == null
              ? 'No answer'
              : (v6 == 'through' ? 'Via exit' : 'Blocked'),
          verdict: v6 == null
              ? Mark.none
              : (_isHome(_s('v6_ip')) ? Mark.warn : Mark.ok),
        ),
        LeakRow(
          icon: 'pulse',
          title: 'WebRTC · STUN (UDP)',
          sub: 'What calls and browsers reveal',
          value: stun == null
              ? 'No answer'
              : (_isHome(stun)
                    ? 'Your IP'
                    : (stun == _s('ip') ? 'Exit IP' : 'Not yours')),
          verdict: stun == null
              ? Mark.none
              : (_isHome(stun) ? Mark.warn : Mark.ok),
        ),
        LeakRow(
          icon: 'lock',
          title: 'Kill switch',
          sub: ctx.lockdown
              ? 'Android blocks traffic without Pleat'
              : 'Off: a drop would send apps out bare',
          value: ctx.lockdown ? 'On' : 'Off',
          verdict: ctx.lockdown ? Mark.ok : Mark.warn,
        ),
        LeakRow(
          icon: 'split',
          title: 'Apps skipping the VPN',
          sub: ctx.bypassApps == 0
              ? 'Every app goes through the tunnel'
              : 'Your choice in Route › Split route: they show your Iran IP',
          value: ctx.bypassApps == 0
              ? 'None'
              : (ctx.bypassApps == 1 ? '1 app' : '${ctx.bypassApps} apps'),
          verdict: ctx.bypassApps == 0 ? Mark.ok : Mark.note,
        ),
      ]),
      LeakGroup('YOUR PHONE TELLS GOOGLE TOO', [
        LeakRow(
          icon: 'pin',
          title: 'Location',
          sub: loc == true
              ? 'Wi-Fi and GPS reports can teach Google this exit is in Iran'
              : 'Your phone isn’t reporting where it is',
          value: loc == null ? 'Unknown' : (loc == true ? 'On' : 'Off'),
          verdict: loc == null
              ? Mark.none
              : (loc == true ? Mark.note : Mark.ok),
        ),
        LeakRow(
          icon: 'clock',
          title: 'Time zone · SIM',
          sub: 'Apps can read these, VPN or not',
          value: [
            if (tz != null) _city(tz),
            ?sim,
          ].join(' · ').ifEmpty('Unknown'),
          verdict: tz == 'Asia/Tehran' || sim == 'IR' ? Mark.note : Mark.none,
        ),
      ]),
    ];
  }

  /// The ECS subnet ("5.120.33.0/24") covers the phone's own address.
  bool _sameArea(String ecs) {
    final home = _s('home_ip');
    if (home == null) return false;
    final net = ecs.split('/').first;
    final a = net.split('.'), b = home.split('.');
    if (a.length != 4 || b.length != 4) return false;
    return a[0] == b[0] && a[1] == b[1] && a[2] == b[2];
  }

  static String _city(String tz) => tz.split('/').last.replaceAll('_', ' ');

  /// "AS24940 Hetzner Online GmbH" -> "Hetzner Online".
  static String? _shortOrg(String? org) {
    if (org == null || org.isEmpty) return null;
    final words = org
        .split(' ')
        .where((w) => w.isNotEmpty && !RegExp(r'^AS\d+$').hasMatch(w))
        .toList();
    if (words.isEmpty) return null;
    return words.take(2).join(' ');
  }

  /// Short, for the Protect card: the first row of each kind it shows.
  Map<String, Object?> toJson() => {
    'raw': raw,
    'at': at.millisecondsSinceEpoch,
    'took': took.inMilliseconds,
    'lock': ctx.lockdown,
    'apps': ctx.bypassApps,
    'dns': ctx.dns,
    'exit': ctx.exitLabel,
    'net': ctx.network,
  };

  static LeakReport? fromJson(String? text) {
    if (text == null || text.isEmpty) return null;
    try {
      final j = jsonDecode(text);
      if (j is! Map || j['raw'] is! Map) return null;
      return LeakReport(
        (j['raw'] as Map).cast<String, Object?>(),
        (
          lockdown: j['lock'] == true,
          bypassApps: (j['apps'] as num?)?.toInt() ?? 0,
          dns: '${j['dns'] ?? '1.1.1.1'}',
          exitLabel: '${j['exit'] ?? ''}',
          network: '${j['net'] ?? ''}',
        ),
        DateTime.fromMillisecondsSinceEpoch((j['at'] as num?)?.toInt() ?? 0),
        Duration(milliseconds: (j['took'] as num?)?.toInt() ?? 0),
      );
    } on FormatException {
      return null;
    }
  }
}

extension on String {
  String ifEmpty(String other) => isEmpty ? other : this;
}
