// PERF-A-02: a measured exit's speed badge must not keep the screen
// drawing frames forever. The sweep crosses the coin, then rests without a
// ticker; only a running test (busy) keeps it going.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/models.dart';
import 'package:pleat/design/city_art.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/state/exits.dart';

Exit _exit({int? kbps}) {
  final e = Exit(
    Server.fromJson({
      'index': 0,
      'name': 'DE 1',
      'country_code': 'DE',
      'protocol': 'vless',
      'link': 'vless://00000000-0000-0000-0000-000000000000@exit.example:443',
    }),
    null,
  );
  e.kbps = kbps;
  return e;
}

/// Pumps [total] in 16 ms steps and counts the steps that asked for a
/// frame, as the phone's display would draw them.
Future<int> _frames(WidgetTester tester, Duration total) async {
  var frames = 0;
  final steps = total.inMilliseconds ~/ 16;
  for (var i = 0; i < steps; i++) {
    if (tester.binding.hasScheduledFrame) frames++;
    await tester.pump(const Duration(milliseconds: 16));
  }
  return frames;
}

Widget _host(Exit e) => MaterialApp(
  home: Scaffold(body: Center(child: SpeedBadge(e))),
);

void main() {
  setUp(() => PType.familyOverride = 'PleatTest');

  testWidgets('a measured badge sweeps, then rests without frames', (
    tester,
  ) async {
    await tester.pumpWidget(_host(_exit(kbps: 9000)));
    final frames = await _frames(tester, const Duration(seconds: 10));
    // 10 s at 60 Hz is 625 frames; a sweep of 0.8 s at most every 8 s is
    // well under 150.
    expect(frames, lessThan(150));
    // It still sweeps.
    expect(frames, greaterThan(10));
  });

  testWidgets('the badge paints on its own layer', (tester) async {
    await tester.pumpWidget(_host(_exit(kbps: 9000)));
    expect(
      find.descendant(
        of: find.byType(SpeedBadge),
        matching: find.byType(RepaintBoundary),
      ),
      findsWidgets,
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a running test keeps pulsing', (tester) async {
    final e = _exit()..speedTesting = true;
    await tester.pumpWidget(_host(e));
    final frames = await _frames(tester, const Duration(seconds: 2));
    expect(frames, greaterThan(100));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an untested exit asks for no frames', (tester) async {
    await tester.pumpWidget(_host(_exit()));
    await tester.pump();
    expect(await _frames(tester, const Duration(seconds: 2)), lessThan(3));
  });
}
