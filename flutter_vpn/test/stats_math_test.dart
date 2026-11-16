// ARC-03 (first slice): the Stats numbers AppState used to work out inline,
// now plain functions in stats_log.dart. Expected values are worked by hand.
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/models.dart';
import 'package:pleat/state/exits.dart';
import 'package:pleat/state/route_mode.dart';
import 'package:pleat/state/stats_log.dart';

const _gb = 1024 * 1024 * 1024;

Subscription _sub({
  int limit = 10 * _gb,
  int used = 4 * _gb,
  int? days = 12,
  bool unlimited = false,
}) => Subscription.fromJson({
  'active': true,
  'status': 'active',
  'data_limit_bytes': limit,
  'used_bytes': used,
  'days_left': days,
  'unlimited_data': unlimited,
});

Exit _exit(int i, String link, {double? score, int ms = 0, int n = 0}) => Exit(
  Server.fromJson({
    'index': i,
    'name': 'X $i',
    'country_code': 'DE',
    'protocol': link.split('://').first,
    'link': link,
  }),
  score == null
      ? null
      : Rank.fromJson({'score': score, 'ms': ms, 'n': n, 'users': n}),
);

void main() {
  test('data pace: when it runs out and what lasts to the plan end', () {
    final now = DateTime(2026, 11, 15, 12);
    final p = dataPaceOf(_sub(), _gb, now)!;
    expect(p.pace, _gb);
    // 6 GB left at 1 GB a day: six days (144 h) from now
    expect(p.runsOut, now.add(const Duration(hours: 144)));
    expect(p.perDayToLast, 6 * _gb ~/ 12);
    // no pace, no cap, no plan: nothing to show
    expect(dataPaceOf(_sub(), null, now), isNull);
    expect(dataPaceOf(_sub(unlimited: true), _gb, now), isNull);
    expect(dataPaceOf(_sub(limit: 0), _gb, now), isNull);
    expect(dataPaceOf(null, _gb, now), isNull);
    // nothing used lately: never runs out; the plan's last day: no daily share
    final idle = dataPaceOf(_sub(days: 0), 0, now)!;
    expect(idle.runsOut, isNull);
    expect(idle.perDayToLast, isNull);
    // over the cap counts as nothing left
    expect(dataPaceOf(_sub(used: 12 * _gb), _gb, now)!.runsOut, now);
  });

  test('what works for everyone: per goal, weighted by reports', () {
    const a = 'vless://u@a.example.com:443?security=reality&type=tcp#a';
    const b = 'vless://u@b.example.com:443?security=reality&type=tcp#b';
    const c = 'trojan://p@c.example.com:443?security=tls#c';
    final shares = familyShares([
      _exit(1, a, score: 0.9, ms: 100, n: 30),
      _exit(
        2,
        b,
        score: 0.5,
        ms: 0,
        n: 10,
      ), // no ping: weighs in the share only
      _exit(3, c, score: 0.2, ms: 300, n: 5),
      _exit(4, c), // no ranking
      _exit(5, c, score: 1.0, ms: 50, n: 0), // no reports
    ]);
    final fa = familyOf('vless', a), fc = familyOf('trojan', c);
    expect(shares[fa]!.$1, closeTo((0.9 * 30 + 0.5 * 10) / 40, 1e-9));
    expect(shares[fa]!.$2, 100);
    expect(shares[fa]!.$3, 40);
    expect(shares[fc], (0.2, 300, 5));
    expect(familyShares(const []), isEmpty);
  });
}
