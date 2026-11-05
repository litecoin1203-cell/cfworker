// Counts the work behind battery use in fake time: live pings, plan reads,
// frames the shard field asks for, rebuilds while protected, download
// tests and payment polls. Run the same file on the old and the new code
// to compare: `flutter test test/battery_measure_test.dart`; every number
// is printed on a `MEASURE` line, once on an unmetered and once on a
// metered network. It uses only what both versions have.
//
// ignore_for_file: avoid_print
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/shard_field.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/screens/order_status.dart';
import 'package:pleat/state/app_state.dart';
import 'package:pleat/state/tunnel.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

Future<(AppState, FakeApi)> _boot(
  WidgetTester tester,
  FakeTunnel tunnel,
) async {
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

void _to(WidgetTester tester, List<AppLifecycleState> states) {
  for (final s in states) {
    tester.binding.handleAppLifecycleStateChanged(s);
  }
}

const _away = [
  AppLifecycleState.inactive,
  AppLifecycleState.hidden,
  AppLifecycleState.paused,
];
const _back = [
  AppLifecycleState.hidden,
  AppLifecycleState.inactive,
  AppLifecycleState.resumed,
];

Future<void> _protect(WidgetTester tester, AppState app, FakeTunnel t) async {
  await app.connect(app.exits[1].id);
  t.emit(TunnelState.up);
  await tester.pump(const Duration(seconds: 1));
  expect(app.phase, Phase.protected);
}

Future<void> _wait(WidgetTester tester, Duration total) async {
  const step = Duration(seconds: 10);
  for (var d = Duration.zero; d < total; d += step) {
    await tester.pump(step);
  }
}

void _report(String net, String key, Object value) =>
    print('MEASURE $net $key=$value');

/// A test that then lets the network reports it queued go out: since
/// 1.2.15 the app measures when it comes back on screen, and the Worker
/// takes one report per 9 s.
void _t(String name, Future<void> Function(WidgetTester) body) =>
    testWidgets(name, (tester) async {
      await body(tester);
      await _wait(tester, const Duration(seconds: 60));
    });

void main() {
  for (final metered in [false, true]) {
    final net = metered ? 'metered' : 'unmetered';
    group(net, () {
      for (final background in [true, false]) {
        final where = background ? 'screen_off' : 'on_screen';
        _t('one hour connected, $where: live pings and plan reads', (
          tester,
        ) async {
          final tunnel = (FakeTunnel()..onMetered = metered);
          final (app, api) = await _boot(tester, tunnel);
          await _protect(tester, app, tunnel);
          if (background) _to(tester, _away);
          tunnel.delays = 0;
          final me = api.calls.where((c) => c == 'GET /me').length;
          await _wait(tester, const Duration(hours: 1));
          _report(net, 'pings_per_hour_$where', tunnel.delays);
          _report(
            net,
            'plan_reads_per_hour_$where',
            api.calls.where((c) => c == 'GET /me').length - me,
          );
          if (background) _to(tester, _back);
          await app.disconnect();
          await tester.pump(const Duration(seconds: 1));
        });
      }

      _t('Home on screen, 10 s at 60 Hz: shard field paints', (tester) async {
        await _boot(tester, (FakeTunnel()..onMetered = metered));
        final field = tester.renderObject<RenderRepaintBoundary>(
          find
              .descendant(
                of: find.byType(ShardField),
                matching: find.byType(RepaintBoundary),
              )
              .first,
        );
        final before =
            field.debugSymmetricPaintCount + field.debugAsymmetricPaintCount;
        for (var i = 0; i < 625; i++) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        _report(
          net,
          'shard_paints_per_10s_home_idle',
          field.debugSymmetricPaintCount +
              field.debugAsymmetricPaintCount -
              before,
        );
      });

      _t('Protected on Home, 10 s: widgets rebuilt', (tester) async {
        final tunnel = (FakeTunnel()..onMetered = metered);
        final (app, _) = await _boot(tester, tunnel);
        await _protect(tester, app, tunnel);
        await tester.pump(const Duration(seconds: 3));
        var rebuilt = 0;
        debugOnRebuildDirtyWidget = (_, _) => rebuilt++;
        for (var i = 0; i < 100; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        debugOnRebuildDirtyWidget = null;
        _report(net, 'rebuilds_per_10s_protected_home', rebuilt);
        await app.disconnect();
        await tester.pump(const Duration(seconds: 1));
      });

      const hosts = [
        'nl1', 'de1', 'us1', 'fi1', 'fr1', 'se1', 'pl1', 'at1', //
      ];
      setUp(() {
        FakeApi.extraServers = [
          for (var i = 3; i < hosts.length; i++)
            {
              'index': i,
              'name': '${hosts[i].substring(0, 2).toUpperCase()} 1',
              'country_code': hosts[i].substring(0, 2).toUpperCase(),
              'protocol': 'vless',
              'link': 'vless://u@${hosts[i]}.example.com:443?type=tcp#x',
            },
        ];
      });
      tearDown(() => FakeApi.extraServers = []);

      FakeTunnel answering() => (FakeTunnel()..onMetered = metered)
        ..pings = {for (final h in hosts) '$h.example.com': 100}
        ..speeds = {for (final h in hosts) '$h.example.com': 5000};

      _t('Locations opened once, 8 exits answer: download tests', (
        tester,
      ) async {
        final tunnel = answering();
        final (app, _) = await _boot(tester, tunnel);
        expect(app.exits, hasLength(8));
        app.setTab(2);
        await _wait(tester, const Duration(seconds: 60));
        _report(
          net,
          'speed_tests_per_locations_open',
          tunnel.speedTested.length,
        );
        app.setTab(0);
        for (var i = 0; i < 20; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
      });

      _t('Locations left after 4 s, tests take 3 s: download tests', (
        tester,
      ) async {
        final tunnel = answering()..speedTakes = const Duration(seconds: 3);
        final (app, _) = await _boot(tester, tunnel);
        app.setTab(2);
        for (var i = 0; i < 40; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        app.setTab(0);
        // Frames run the tab cross-fade out, as on the phone.
        for (var i = 0; i < 5; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        await _wait(tester, const Duration(seconds: 60));
        _report(
          net,
          'speed_tests_after_leaving_locations',
          tunnel.speedTested.length,
        );
      });

      _t('order status open, app off screen 60 s: polls', (tester) async {
        final (_, api) = await _boot(
          tester,
          (FakeTunnel()..onMetered = metered),
        );
        final nav = tester.state<NavigatorState>(find.byType(Navigator).first);
        nav.push(
          MaterialPageRoute<void>(
            builder: (_) => const OrderStatusScreen(id: 7),
          ),
        );
        await tester.pump(const Duration(seconds: 1));
        _to(tester, _away);
        final before = api.calls.where((c) => c == 'GET /orders/7').length;
        await _wait(tester, const Duration(seconds: 60));
        _report(
          net,
          'order_polls_per_minute_off_screen',
          api.calls.where((c) => c == 'GET /orders/7').length - before,
        );
        _to(tester, _back);
        nav.popUntil((r) => r.isFirst);
        await tester.pump(const Duration(seconds: 1));
      });
    });
  }
}
