// PERF-A-01: a test of every exit used to rebuild the whole Shell (the
// shard field, the nav, the page) once per exit tested. The Shell now
// rebuilds only when what it shows changes, and the per-exit results of a
// run reach the screens at most every [AppState.testNotifyGap].
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/screens/shell.dart';
import 'package:pleat/state/app_state.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

Future<(AppState, FakeTunnel, FakeApi)> _boot(WidgetTester tester) async {
  PType.familyOverride = 'PleatTest';
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({'onboarded': true});
  addTearDown(() => FakeApi.extraServers = []);
  FakeApi.extraServers = [
    for (var i = 0; i < 24; i++)
      {
        'index': 10 + i,
        'name': 'FI ${i + 1}',
        'country_code': 'FI',
        'protocol': 'vless',
        'link': 'vless://u@fi$i.example.com:443?type=tcp#x',
      },
  ];
  final api = FakeApi(MemoryTokens(signedIn: true))..avatar = 'vesper';
  final tunnel = FakeTunnel()
    ..probeTakes = const Duration(milliseconds: 90)
    ..pings = {for (var i = 0; i < 24; i += 2) 'fi$i.example.com': 100 + i};
  final app = AppState(
    await SharedPreferences.getInstance(),
    api,
    tunnel: tunnel,
  );
  await app.refreshAccount();
  await tester.pumpWidget(PleatApp(state: app));
  for (var i = 0; i < 30; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  await app.loadServers();
  await tester.pump(const Duration(seconds: 1));
  return (app, tunnel, api);
}

void main() {
  testWidgets('testing every exit does not rebuild the Shell per exit', (
    tester,
  ) async {
    final (app, tunnel, _) = await _boot(tester);
    expect(app.exits.length, greaterThanOrEqualTo(27));
    var notes = 0;
    app.addListener(() => notes++);
    final builds = Shell.debugBuilds;
    final run = app.testAll();
    // frames while the exits answer, one by one in six lanes
    for (var i = 0; i < 60; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
    await run;
    await tester.pump(const Duration(milliseconds: 300));
    // nothing the Shell shows changed: not rebuilt at all
    expect(Shell.debugBuilds - builds, 0);
    // the results reached the screens in a few batches, not one per exit
    expect(notes, lessThan(app.exits.length ~/ 2));
    // and every result is there in the end
    expect(app.exits.where((e) => e.measured != null).length, app.exits.length);
    expect(app.testing, isFalse);
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('the Shell still follows a tab change', (tester) async {
    final (app, _, _) = await _boot(tester);
    final builds = Shell.debugBuilds;
    app.setTab(1);
    await tester.pump(const Duration(milliseconds: 800));
    expect(Shell.debugBuilds - builds, greaterThanOrEqualTo(1));
    expect(find.text('Always protected'), findsOneWidget);
    await tester.pump(const Duration(minutes: 3));
  });
}
