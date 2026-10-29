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

  String get id => server.key;

  /// Headline: the country the remark names.
  String get title => server.country;

  /// The Worker's own label, e.g. "DE 2".
  String get label => server.name;
  String get code => server.cc;
  String get flag => server.flag;
  String get protocol => server.protocolLabel;

  /// Median ping other people on this network reported, if any.
  int? get ping => (rank?.ms ?? 0) > 0 ? rank!.ms : null;

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
  String get meta =>
      [label, protocol, if (ping != null) '$ping ms'].join('  ·  ');
}
