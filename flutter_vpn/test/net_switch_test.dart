// NET-06: a Wi-Fi <-> mobile data switch (or a network back after none)
// is acted on within seconds: the exit is asked at once, and when it
// doesn't answer on the new network the same exit is started again in
// place, which drops the core's connections stuck on the old network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/state/app_state.dart';
import 'package:pleat/state/tunnel.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

Future<(AppState, FakeTunnel)> _protected(WidgetTester tester) async {
  PType.familyOverride = 'PleatTest';
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({'onboarded': true});
  final tunnel = FakeTunnel()
    ..kind = 'wifi'
    ..pings = {'nl1.example.com': 240, 'de1.example.com': 60};
  final api = FakeApi(MemoryTokens(signedIn: true));
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
  api.rankReports = 4;
  await app.loadServers();
  await app.connect();
  expect(tunnel.started, contains('de1.example.com'));
  tunnel.emit(TunnelState.up);
  await tester.pump(PMotion.seal);
  expect(app.phase, Phase.protected);
  return (app, tunnel);
}

Future<void> _secs(WidgetTester tester, int n) async {
  for (var i = 0; i < n; i++) {
    await tester.pump(const Duration(seconds: 1));
  }
}

/// Answered live pings until they are a minute apart.
Future<void> _settle(WidgetTester tester, AppState app) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(app.pulseGap);
    await tester.pump(const Duration(milliseconds: 50));
  }
  expect(app.pulseGap, AppState.pulseSteps[1]);
}

void main() {
  testWidgets('a switch is checked at once; an answering exit stays', (
    tester,
  ) async {
    final (app, tunnel) = await _protected(tester);
    await _settle(tester, app);
    final starts = tunnel.starts;
    final before = tunnel.delays;
    tunnel
      ..kind = 'cell'
      ..netChanged();
    await _secs(tester, 4);
    // asked within seconds, not at the next ping a minute later
    expect(tunnel.delays, greaterThan(before));
    expect(app.phase, Phase.protected);
    expect(tunnel.starts, starts);
    // pings stay close for a while on the new network
    expect(app.pulseGap, AppState.pulseSteps.first);
    await app.disconnect();
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('a switch the exit misses restarts the same exit in place', (
    tester,
  ) async {
    final (app, tunnel) = await _protected(tester);
    await _settle(tester, app);
    final id = app.exitId;
    final starts = tunnel.starts;
    tunnel
      ..kind = 'cell'
      ..live = null
      ..netChanged();
    await _secs(tester, 4);
    // one miss is enough after a switch: the same exit again, not the next
    expect(tunnel.starts, starts + 1);
    expect(tunnel.started, contains('de1.example.com'));
    expect(app.exitId, id);
    expect(tunnel.stopped, isFalse);
    tunnel.live = 70;
    tunnel.emit(TunnelState.up);
    await tester.pump(PMotion.seal);
    expect(app.phase, Phase.protected);
    expect(app.exitId, id);
    await app.disconnect();
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('the restart failing fails over, never stops the tunnel', (
    tester,
  ) async {
    final (app, tunnel) = await _protected(tester);
    final id = app.exitId;
    final starts = tunnel.starts;
    tunnel
      ..kind = 'cell'
      ..live = null
      ..netChanged();
    await _secs(tester, 4);
    expect(tunnel.starts, starts + 1);
    expect(app.exitId, id);
    tunnel.emit(TunnelState.failed);
    await _secs(tester, 2);
    // the next exit takes the tun over; nothing was stopped
    expect(tunnel.starts, starts + 2);
    expect(app.exitId, isNot(id));
    expect(tunnel.stopped, isFalse);
    await app.disconnect();
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('switches in a burst are checked once', (tester) async {
    final (app, tunnel) = await _protected(tester);
    await _settle(tester, app);
    final before = tunnel.delays;
    for (var i = 0; i < 5; i++) {
      tunnel.netChanged();
      await tester.pump(const Duration(milliseconds: 300));
    }
    await _secs(tester, 4);
    expect(tunnel.delays - before, 1);
    await app.disconnect();
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('no session: a switch does nothing', (tester) async {
    final (app, tunnel) = await _protected(tester);
    await app.disconnect();
    await tester.pump(const Duration(seconds: 5));
    final before = tunnel.delays;
    final starts = tunnel.starts;
    tunnel.netChanged();
    await _secs(tester, 4);
    expect(tunnel.delays, before);
    expect(tunnel.starts, starts);
    expect(app.phase, Phase.idle);
    await tester.pump(const Duration(minutes: 3));
  });
}
