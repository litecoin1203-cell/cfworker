import '../api/models.dart';
import 'exits.dart';

/// Why Home's Recommended exits suggests an exit. Every reason is read from
/// something this phone measured or did, or from what people on the same
/// network reported; none is made up.
enum PickWhy { fastest, sameCountry, crowd, hd, worked, saved, answers }

class Pick {
  const Pick(this.exit, this.why, this.text);
  final Exit exit;

  /// null: nothing true to say yet (nothing measured), no line is drawn.
  final PickWhy? why;
  final String? text;
}

/// A session at least this long counts as "worked for you".
const workedMinutes = 10;

/// One reason per pick, each a different kind where the picks allow, so
/// the list reads as four different arguments rather than four "fast"s.
List<Pick> explainPicks(
  List<Exit> picks, {
  Exit? current,
  NetInfo? net,
  Set<String> saved = const {},
  Set<String> worked = const {},
}) {
  // The quickest answer this phone itself measured among the picks.
  Exit? quickest;
  for (final e in picks) {
    final ms = e.measured ?? 0;
    if (ms <= 0) continue;
    if (quickest == null || ms < quickest.measured!) quickest = e;
  }
  final on = net == null ? 'here' : 'on ${net.name}';
  final curHost = current == null
      ? null
      : endpointOf(current.server.link)?.host;

  List<(PickWhy, String)> reasons(Exit e) {
    final r = e.rank;
    final host = endpointOf(e.server.link)?.host;
    return [
      if (identical(e, quickest)) (PickWhy.fastest, 'Fastest $on'),
      if (current != null &&
          e.id != current.id &&
          e.code.isNotEmpty &&
          e.code == current.code &&
          host != null &&
          host != curHost)
        (PickWhy.sameCountry, 'Same country, other server'),
      if (e.verdict == Verdict.strong && r != null)
        (PickWhy.crowd, 'Strong for ${r.people} people $on'),
      if ((e.kbps ?? 0) >= Speed.fastKbps)
        (PickWhy.hd, 'Fast enough for HD video'),
      if (worked.contains(e.id)) (PickWhy.worked, 'Worked for you before'),
      if (saved.contains(e.id)) (PickWhy.saved, 'In your saved exits'),
      if ((e.measured ?? 0) > 0) (PickWhy.answers, 'Answers $on'),
    ];
  }

  final used = <PickWhy>{};
  return [
    for (final e in picks)
      () {
        final all = reasons(e);
        if (all.isEmpty) return Pick(e, null, null);
        final fresh = all.where((x) => !used.contains(x.$1));
        final (why, text) = fresh.isNotEmpty ? fresh.first : all.first;
        used.add(why);
        return Pick(e, why, text);
      }(),
  ];
}
