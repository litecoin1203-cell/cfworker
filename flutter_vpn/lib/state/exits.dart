import 'dart:math';

import '../api/countries.dart';
import '../api/models.dart';

/// Locations filters. Every one is computed from server data or from what
/// this phone did; none is a made-up tag.
enum Category { all, fastest, saved, recent }

/// Painted scene mood for an exit's generated "photo".
enum SceneTone { dawn, day, dusk, night }

/// One backend config, as the screens see it: country, label, protocol and
/// what people on this network measured. No host, no address.
/// How fast an exit downloads here, at a glance.
enum Speed {
  fast('Fast'),
  fair('Fair'),
  slow('Slow');

  const Speed(this.word);
  final String word;

  /// Enough for HD video.
  static const fastKbps = 6000;

  /// Enough for browsing and voice.
  static const fairKbps = 1500;
}

/// How an exit does for everyone on this phone's operator.
enum Verdict { strong, weak }

class Exit {
  Exit(this.server, this.rank);
  final Server server;
  final Rank? rank;

  /// What this phone measured through the core: ms, or -1 for no answer;
  /// null until tested.
  int? measured;
  DateTime? measuredAt;

  /// Why the last test got no answer, as the core said it; null when it
  /// answered or gave no reason.
  String? failure;

  bool get unreachable => measured == -1;

  /// Download speed through this exit on this phone's network, in kbit/s;
  /// -1 when nothing came through, null until tested.
  int? kbps;
  DateTime? kbpsAt;

  /// A download test through this exit is running now.
  bool speedTesting = false;

  /// A ping through this exit is running now (a tap on its flag).
  bool pingTesting = false;

  /// Ping or download test running: the flag pulses.
  bool get busy => pingTesting || speedTesting;

  /// Labels and others' speed count from this many different people.
  static const minPeople = 3;

  /// Strong or Weak on this operator, from what at least [minPeople]
  /// people on it measured; null while too few did, or in between.
  Verdict? get verdict {
    final r = rank;
    if (r == null || r.people < minPeople) return null;
    if (r.score >= 0.7) return Verdict.strong;
    if (r.score <= 0.4) return Verdict.weak;
    return null;
  }

  /// "Strong on Irancell" / "Weak on Irancell", or null.
  String? verdictOn(NetInfo? net) => switch (verdict) {
    _ when net == null => null,
    Verdict.strong => 'Strong on ${net.name}',
    Verdict.weak => 'Weak on ${net.name}',
    null => null,
  };

  /// What [kbps] means for a person: video, browsing or text only. Until
  /// this phone measured it, what people on this operator measured.
  Speed? get speed {
    final r = rank;
    final k =
        kbps ??
        (r != null && r.people >= minPeople && r.kbps > 0 ? r.kbps : null);
    if (k == null) return null;
    if (k >= Speed.fastKbps) return Speed.fast;
    if (k >= Speed.fairKbps) return Speed.fair;
    return Speed.slow;
  }

  String get id => server.key;

  /// Headline: the country the remark names.
  String get title => server.country;

  /// The Worker's own label, e.g. "DE 2".
  String get label => server.name;
  String get code => server.cc;
  String get flag => server.flag;
  String get protocol => server.protocolLabel;

  /// This phone's own measurement first, then the median other people on
  /// this network reported.
  int? get ping =>
      (measured ?? 0) > 0 ? measured : ((rank?.ms ?? 0) > 0 ? rank!.ms : null);

  /// The network ranking counts once at least three phones reported.
  double? get ispScore =>
      rank != null && rank!.reports >= 3 ? rank!.score : null;

  /// Download speed as 0 … 1 on a log scale: 0.5 Mbit/s is 0, about
  /// 3.5 Mbit/s 0.5, 20 Mbit/s and up 1. This phone's own result first,
  /// then what people on this network measured; unknown counts as the
  /// middle, so the few exits that got a download test are not pushed
  /// down by it.
  double get speedScore {
    final r = rank;
    final k = (kbps ?? 0) > 0
        ? kbps!
        : (r != null && r.people >= minPeople && r.kbps > 0 ? r.kbps : 0);
    if (k <= 0) return 0.5;
    return (log(k / 500) / log(20000 / 500)).clamp(0.0, 1.0);
  }

  /// Order of Best, Recommended and smart connect: what this phone
  /// measured on this network (ping 60 %, download speed 40 %), weighted
  /// by how well it works for people on the same operator and connection
  /// type (the Worker's score, once three phones reported).
  double get smartScore {
    final ms = measured ?? 0;
    final local = ms > 0
        ? (1 - (ms.clamp(0, 1500) / 1500)) * 0.6 + speedScore * 0.4
        : 0.0;
    final isp = ispScore;
    return isp == null ? local : local * 0.45 + isp * 0.55;
  }

  /// 0 … 100, from the network ranking.
  int? get score => rank == null ? null : (rank!.score * 100).round();

  int get seed {
    var h = 7;
    for (final c in id.codeUnits) {
      h = (h * 31 + c) & 0x7fffffff;
    }
    return h;
  }

  SceneTone get tone => SceneTone.values[seed % SceneTone.values.length];

  /// -1 (far west) … 1 (far east), for the shard lean.
  double get bearing =>
      (((countries[code]?.lon ?? 10) - 10) / 120).clamp(-1.0, 1.0);

  /// One-line facts for cards: label, protocol and ping when known.
  String get meta => [
    label,
    protocol,
    if (pingTesting)
      'testing'
    else if (unreachable)
      'no answer'
    else if (ping != null)
      '$ping ms',
    if (speedTesting) 'testing speed' else if (speed != null) speed!.word,
  ].join('  ·  ');
}
