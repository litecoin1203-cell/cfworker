// NET-02: a short loss of the phone's own network (a lift, a mobile-data
// gap) must not end the session, and a live session whose every exit
// failed keeps the tunnel (blocking) instead of letting apps out bare.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/state/app_state.dart';
import 'package:pleat/state/route_mode.dart';
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

Future<void> _secs(WidgetTester tester, int n) async {
  for (var i = 0; i < n; i++) {
    await tester.pump(const Duration(seconds: 1));
  }
}

/// No exit answers any more: live pings miss, failover tries the rest and
/// every start fails, until the session is held.
Future<void> _loseEveryExit(
  WidgetTester tester,
  AppState app,
  FakeTunnel tunnel,
) async {
  tunnel
    ..live = null
    ..pings = {};
  await _beat(tester);
  await _beat(tester);
  for (var i = 0; i < 8 && !app.holding; i++) {
    if (app.phase == Phase.handshaking) tunnel.emit(TunnelState.failed);
    await _secs(tester, 10);
  }
  expect(app.holding, isTrue);
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
    for (var i = 0; i < 5; i++) {
      await _beat(tester);
    }
    // still asked (so the return is seen), but nothing moved
    expect(tunnel.delays - before, greaterThanOrEqualTo(5));
    expect(app.phase, Phase.protected);
    expect(app.noNetwork, isTrue);
    expect(find.textContaining('No network'), findsOneWidget);
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
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('no network for long: the exemption ends, failover runs', (
    tester,
  ) async {
    final (app, tunnel) = await _protected(tester);
    tunnel
      ..kind = ''
      ..live = null;
    for (var i = 0; i < 12 && app.phase == Phase.protected; i++) {
      await _beat(tester);
    }
    // about two minutes of "no network", then the misses count again
    expect(app.phase, Phase.handshaking);
    expect(app.noNetwork, isFalse);
    await app.disconnect();
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('Android could not say: a miss counts as before', (tester) async {
    final (app, tunnel) = await _protected(tester);
    tunnel
      ..kind = ''
      ..netError = true
      ..live = null;
    await _beat(tester);
    await _beat(tester);
    expect(app.phase, Phase.handshaking);
    expect(app.noNetwork, isFalse);
    await app.disconnect();
    await tester.pump(const Duration(minutes: 3));
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
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('a fresh connect that fails everywhere still stops', (
    tester,
  ) async {
    final tunnel = FakeTunnel()
      ..kind = 'wifi'
      ..pings = {'nl1.example.com': 240, 'de1.example.com': 60};
    final (app, api) = await _boot(tester, tunnel);
    api.rankReports = 4;
    await app.loadServers();
    await app.connect();
    tunnel.pings = {};
    for (var i = 0; i < 8 && app.phase != Phase.idle; i++) {
      if (app.phase == Phase.handshaking) tunnel.emit(TunnelState.failed);
      await _secs(tester, 10);
    }
    // never protected: the phone isn't left blocked after a first try
    expect(app.phase, Phase.idle);
    expect(app.holding, isFalse);
    expect(tunnel.stopped, isTrue);
    expect(tunnel.holds, 0);
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('every exit failed: the tunnel is held until the person stops', (
    tester,
  ) async {
    final (app, tunnel) = await _protected(tester);
    await _loseEveryExit(tester, app, tunnel);
    expect(app.phase, Phase.dropped);
    expect(app.tunnelMessage, contains('answer'));
    // Not torn down: traffic stays blocked, nothing leaves with the real IP.
    expect(tunnel.stopped, isFalse);
    expect(tunnel.holds, greaterThan(0));
    expect(find.textContaining('held'), findsOneWidget);
    // The person stops it.
    await app.disconnect();
    expect(tunnel.stopped, isTrue);
    expect(app.holding, isFalse);
    expect(app.phase, Phase.idle);
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('held in the background: the person is told', (tester) async {
    final (app, tunnel) = await _protected(tester);
    app.didChangeAppLifecycleState(AppLifecycleState.paused);
    await _loseEveryExit(tester, app, tunnel);
    expect(tunnel.alerts.last, contains('No exit is answering'));
    app.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await app.disconnect();
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('held: retries with back-off, reconnects once an exit answers', (
    tester,
  ) async {
    final (app, tunnel) = await _protected(tester);
    await _loseEveryExit(tester, app, tunnel);
    final first = app.holdTries;
    // nothing answers: about 15 s, 30 s, 60 s, then every 2 minutes
    await _secs(tester, 16);
    expect(app.holdTries, first + 1);
    await _secs(tester, 31);
    expect(app.holdTries, first + 2);
    await _secs(tester, 30);
    expect(app.holdTries, first + 2);
    await _secs(tester, 31);
    expect(app.holdTries, first + 3);
    await _secs(tester, 100);
    expect(app.holdTries, first + 3);
    await _secs(tester, 21);
    expect(app.holdTries, first + 4);
    expect(app.phase, Phase.dropped);
    expect(tunnel.stopped, isFalse);
    // An exit answers again: the held tun is taken over by it.
    tunnel
      ..pings = {'de1.example.com': 60}
      ..live = 80
      ..started = null;
    await _secs(tester, 121);
    expect(app.phase, Phase.handshaking);
    expect(tunnel.started, contains('de1.example.com'));
    expect(tunnel.stopped, isFalse);
    tunnel.emit(TunnelState.up);
    await tester.pump(PMotion.seal);
    expect(app.phase, Phase.protected);
    expect(app.holding, isFalse);
    await app.disconnect();
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('a held tunnel: Reconnect takes it over, the notification '
      'stop releases it', (tester) async {
    final (app, tunnel) = await _protected(tester);
    await _loseEveryExit(tester, app, tunnel);
    // Reconnect (Home's control): a new start takes the held tun over.
    tunnel
      ..started = null
      ..pings = {'nl1.example.com': 240};
    app.primaryAction();
    await _secs(tester, 5);
    expect(app.phase, Phase.handshaking);
    expect(tunnel.started, isNotNull);
    expect(tunnel.stopped, isFalse);
    // It fails too: still held, never let go without the person.
    for (var i = 0; i < 8 && !app.holding; i++) {
      if (app.phase == Phase.handshaking) tunnel.emit(TunnelState.failed);
      await _secs(tester, 10);
    }
    expect(app.phase, Phase.dropped);
    expect(app.holding, isTrue);
    expect(tunnel.stopped, isFalse);
    // Disconnect (Cancel) on the notification: off, not held any more.
    tunnel.emit(TunnelState.off);
    await tester.pump(const Duration(milliseconds: 50));
    expect(app.phase, Phase.idle);
    expect(app.holding, isFalse);
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('a widget start while held: no longer held, Disconnect works', (
    tester,
  ) async {
    final (app, tunnel) = await _protected(tester);
    await _loseEveryExit(tester, app, tunnel);
    final holds = tunnel.holds;
    // The widget's "Tap to try again" starts the service without the app.
    tunnel.emit(TunnelState.starting);
    await tester.pump();
    expect(app.phase, Phase.handshaking);
    expect(app.holding, isFalse);
    // ... and it comes up: protected, one Disconnect, and it stops.
    tunnel.emit(TunnelState.up);
    await tester.pump(PMotion.seal);
    expect(app.phase, Phase.protected);
    expect(app.holding, isFalse);
    expect(find.text('DISCONNECT'), findsNothing);
    await app.disconnect();
    expect(tunnel.stopped, isTrue);
    expect(tunnel.holds, holds);
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('a widget start while held that fails is not kept by the app', (
    tester,
  ) async {
    final (app, tunnel) = await _protected(tester);
    await _loseEveryExit(tester, app, tunnel);
    final holds = tunnel.holds;
    tunnel.emit(TunnelState.starting);
    await tester.pump();
    tunnel.emit(TunnelState.failed);
    await tester.pump();
    // the service closes its tun after a while, as for any widget start
    expect(app.phase, Phase.idle);
    expect(app.holding, isFalse);
    expect(tunnel.holds, holds);
    expect(find.text('DISCONNECT'), findsNothing);
    await _secs(tester, 200);
    expect(app.holdTries, 0);
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('reopened while the service holds: Home shows it held', (
    tester,
  ) async {
    final tunnel = FakeTunnel()
      ..kind = 'wifi'
      ..now = TunnelState.failed
      ..heldNow = true;
    final (app, _) = await _boot(tester, tunnel);
    // as main() does on launch
    await app.resumeTunnel();
    await tester.pump(const Duration(seconds: 1));
    expect(app.phase, Phase.dropped);
    expect(app.holding, isTrue);
    expect(find.textContaining('held'), findsOneWidget);
    expect(find.text('DISCONNECT'), findsOneWidget);
    await app.disconnect();
    expect(tunnel.stopped, isTrue);
    expect(app.holding, isFalse);
    await tester.pump(const Duration(minutes: 3));
  });

  testWidgets('stay in one country while held: no "stopped" or "Not '
      'connected"', (tester) async {
    final tunnel = FakeTunnel()
      ..kind = 'wifi'
      ..pings = {'nl1.example.com': 240, 'de1.example.com': 60};
    final (app, api) = await _boot(tester, tunnel);
    api.rankReports = 4;
    app.setRoute(RouteMode.auto, country: 'DE');
    app.setStayInCountry(true);
    await app.connect();
    tunnel.emit(TunnelState.up);
    await tester.pump(PMotion.seal);
    expect(app.phase, Phase.protected);
    app.didChangeAppLifecycleState(AppLifecycleState.paused);
    await _loseEveryExit(tester, app, tunnel);
    expect(app.lockAsk, isNotNull);
    expect(tunnel.alerts.last, isNot(contains('stopped')));
    expect(tunnel.alerts.last, contains('held'));
    app.didChangeAppLifecycleState(AppLifecycleState.resumed);
    app.declineLock();
    await tester.pump();
    expect(app.holding, isTrue);
    expect(app.tunnelMessage, isNot(contains('Not connected')));
    expect(app.tunnelMessage, contains('Stayed with Germany'));
    await app.disconnect();
    expect(tunnel.stopped, isTrue);
    await tester.pump(const Duration(minutes: 3));
  });
}
