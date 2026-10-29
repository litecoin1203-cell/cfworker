import '../api/countries.dart';
import '../api/models.dart';

/// Locations filters. Every one is computed from server data or from what
/// this phone did; none is a made-up tag.
enum Category { all, fastest, saved, recent }

/// Painted scene mood for an exit's generated "photo".
enum SceneTone { dawn, day, dusk, night }

/// One backend config, as the screens see it: country, label, protocol and
/// what people on this network measured. No host, no address.
class Exit {
  Exit(this.server, this.rank);
  final Server server;
  final Rank? rank;

  /// What this phone measured through the core: ms, or -1 for no answer;
  /// null until tested.
  int? measured;
  DateTime? measuredAt;

  bool get unreachable => measured == -1;

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

  /// Smart-connect order: fast here, weighted by how well it works on this
  /// operator for everyone (the Cloud Gold app's formula).
  double get smartScore {
    final ms = measured ?? 0;
    final local = ms > 0 ? 1 - (ms.clamp(0, 1500) / 1500) : 0.0;
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
    if (unreachable) 'no answer' else if (ping != null) '$ping ms',
  ].join('  ·  ');
}
