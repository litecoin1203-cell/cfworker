// NET-02: a short loss of the phone's own network (a lift, a mobile-data
// gap) must not end the session, and a live session whose every exit
// failed keeps the tunnel (blocking) instead of letting apps out bare.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/state/app_state.dart';
import 'package:pleat/state/tunnel.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

Future<(AppState, FakeApi)> _boot(WidgetTester tester, Tunnel tunnel) async {
  PType.familyOverride = 'PleatTest';
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({'onboarded': true});
  final api = FakeApi(MemoryTokens(signedIn: true));
  final state = AppState(
    await SharedPreferences.getInstance(),
    api,
    tunnel: tunnel,
  );
  await state.refreshAccount();
  await tester.pumpWidget(PleatApp(state: state));
  for (var i = 0; i < 30; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  return (state, api);
}

/// Smart connect on, up on the fastest exit (DE 1), live pings answering.
Future<(AppState, FakeTunnel)> _protected(WidgetTester tester) async {
  final tunnel = FakeTunnel()
    ..kind = 'wifi'
    ..pings = {'nl1.example.com': 240, 'de1.example.com': 60};
  final (app, api) = await _boot(tester, tunnel);
  api.rankReports = 4;
  await app.loadServers();
  await app.connect();
  expect(tunnel.started, contains('de1.example.com'));
  tunnel.emit(TunnelState.up);
  await tester.pump(PMotion.seal);
  expect(app.phase, Phase.protected);
  return (app, tunnel);
}

/// One live-ping gap (20 s while pings miss) and its answer.
Future<void> _beat(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 21));
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets('no network: misses are not counted, nothing fails over', (
    tester,
  ) async {
    final (app, tunnel) = await _protected(tester);
    final started = tunnel.started;
    // The phone loses its network (a lift): the exit can't answer either.
    tunnel
      ..kind = ''
      ..live = null;
    final before = tunnel.delays;
    for (var i = 0; i < 8; i++) {
      await _beat(tester);
    }
    // still asked (so the return is seen), but nothing moved
    expect(tunnel.delays - before, greaterThanOrEqualTo(6));
    expect(app.phase, Phase.protected);
    expect(app.noNetwork, isTrue);
    expect(tunnel.stopped, isFalse);
    expect(tunnel.started, started);
    expect(app.exitSilent, isFalse);

    // The network is back and the exit answers: on as before.
    tunnel
      ..kind = 'cell'
      ..live = 80;
    final back = tunnel.delays;
    await _beat(tester);
    expect(tunnel.delays, greaterThan(back));
    expect(app.noNetwork, isFalse);
    expect(app.phase, Phase.protected);
    expect(tunnel.started, started);
    await app.disconnect();
    await tester.pump(const Duration(seconds: 30));
  });

  testWidgets('network back but the exit is dead: failover runs again', (
    tester,
  ) async {
    final (app, tunnel) = await _protected(tester);
    tunnel
      ..kind = ''
      ..live = null;
    for (var i = 0; i < 4; i++) {
      await _beat(tester);
    }
    expect(app.phase, Phase.protected);
    // Network back, the exit still silent: two misses, then the next exit.
    tunnel.kind = 'wifi';
    await _beat(tester);
    await _beat(tester);
    expect(app.phase, Phase.handshaking);
    expect(tunnel.started, contains('nl1.example.com'));
    await app.disconnect();
    await tester.pump(const Duration(seconds: 30));
  });

  testWidgets('every exit failed: the tunnel is held until the person stops', (
    tester,
  ) async {
    final (app, tunnel) = await _protected(tester);
    // The network is there, but no exit answers any more.
    tunnel
      ..live = null
      ..pings = {};
    await _beat(tester);
    await _beat(tester);
    expect(app.phase, Phase.handshaking);
    expect(tunnel.started, contains('nl1.example.com'));
    tunnel.emit(TunnelState.failed);
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    // Whatever was tried next failed too.
    if (app.phase == Phase.handshaking) tunnel.emit(TunnelState.failed);
    for (var i = 0; i < 60; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    expect(app.phase, Phase.dropped);
    expect(app.tunnelMessage, contains('answer'));
    // Not torn down: traffic stays blocked, nothing leaves with the real IP.
    expect(tunnel.stopped, isFalse);
    expect(app.holding, isTrue);
    expect(tunnel.holds, greaterThan(0));
    expect(find.textContaining('held'), findsOneWidget);
    // The person stops it.
    await app.disconnect();
    expect(tunnel.stopped, isTrue);
    expect(app.holding, isFalse);
    expect(app.phase, Phase.idle);
    await tester.pump(const Duration(seconds: 30));
  });

  testWidgets('a held tunnel: Reconnect takes it over, the notification '
      'stop releases it', (tester) async {
    final (app, tunnel) = await _protected(tester);
    tunnel
      ..live = null
      ..pings = {};
    await _beat(tester);
    await _beat(tester);
    tunnel.emit(TunnelState.failed);
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    if (app.phase == Phase.handshaking) tunnel.emit(TunnelState.failed);
    for (var i = 0; i < 60; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    expect(app.holding, isTrue);
    // Reconnect (Home's control): a new start takes the held tun over.
    tunnel.started = null;
    app.primaryAction();
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    expect(app.phase, Phase.handshaking);
    expect(tunnel.started, isNotNull);
    expect(tunnel.stopped, isFalse);
    // It fails too: still held, never let go without the person.
    tunnel.emit(TunnelState.failed);
    for (var i = 0; i < 60; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    if (app.phase == Phase.handshaking) tunnel.emit(TunnelState.failed);
    for (var i = 0; i < 60; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    expect(app.phase, Phase.dropped);
    expect(app.holding, isTrue);
    expect(tunnel.stopped, isFalse);
    // Disconnect (Cancel) on the notification: off, not held any more.
    tunnel.emit(TunnelState.off);
    await tester.pump(const Duration(milliseconds: 50));
    expect(app.phase, Phase.idle);
    expect(app.holding, isFalse);
    await tester.pump(const Duration(seconds: 30));
  });
}
