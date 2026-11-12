import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/models.dart';
import 'package:pleat/state/exits.dart';
import 'package:pleat/state/recommend.dart';

Exit _exit(int i, String cc, String host, {Map<String, dynamic>? rank}) => Exit(
  Server.fromJson({
    'index': i,
    'name': '$cc $i',
    'country_code': cc,
    'protocol': 'vless',
    'link': 'vless://u@$host:443?security=tls#x',
  }),
  rank == null ? null : Rank.fromJson(rank),
);

void main() {
  const net = NetInfo('44244', 'Irancell');

  test('each pick gets a different, true reason', () {
    final current = _exit(1, 'DE', 'de1.example.com');
    final nl = _exit(2, 'NL', 'nl2.example.com')..measured = 86;
    final de4 = _exit(4, 'DE', 'de4.example.com')..measured = 112;
    final fi = _exit(
      5,
      'FI',
      'fi1.example.com',
      rank: {'score': 0.9, 'ms': 160, 'n': 30, 'users': 9, 'kbps': 0},
    );
    final tr = _exit(3, 'TR', 'tr3.example.com')..measured = 140;

    final picks = explainPicks(
      [nl, de4, fi, tr],
      current: current,
      net: net,
      worked: {tr.id},
    );
    expect(picks.map((p) => p.why), [
      PickWhy.fastest,
      PickWhy.sameCountry,
      PickWhy.crowd,
      PickWhy.worked,
    ]);
    expect(picks[0].text, 'Fastest on Irancell');
    expect(picks[1].text, 'Same country, other server');
    expect(picks[2].text, 'Strong for 9 people on Irancell');
  });

  test('same host in the same country is not called another server', () {
    final current = _exit(1, 'DE', 'de.example.com');
    final other = _exit(2, 'DE', 'de.example.com');
    final picks = explainPicks([other], current: current, net: net);
    expect(picks.single.why, isNull);
    expect(picks.single.text, isNull);
  });

  test('nothing measured: no reason line rather than a made-up one', () {
    final picks = explainPicks([_exit(1, 'NL', 'nl.example.com')]);
    expect(picks.single.text, isNull);
  });

  test('a reason kind repeats only when nothing else is true', () {
    final a = _exit(1, 'NL', 'a.example.com')..measured = 90;
    final b = _exit(2, 'NL', 'b.example.com')..measured = 120;
    final c = _exit(3, 'NL', 'c.example.com')..measured = 150;
    final picks = explainPicks([a, b, c]);
    expect(picks.map((p) => p.why), [
      PickWhy.fastest,
      PickWhy.answers,
      PickWhy.answers,
    ]);
    expect(picks[0].text, 'Fastest here');
  });
}
