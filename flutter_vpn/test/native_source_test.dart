// Guard rails on the Kotlin side that the Dart tests can't run (no Android
// SDK here): the source itself is read. Behaviour is proven on a phone.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

String _kt(String name) =>
    File('android/app/src/main/kotlin/app/pleat/pleat/$name')
        .readAsStringSync();

/// The source without `//` comments, so a comment naming a call isn't one.
String _code(String name) =>
    _kt(name)
        .split('\n')
        .map((l) => l.replaceFirst(RegExp(r'//.*'), ''))
        .join('\n');

void main() {
  test('NET-04: the VPN inherits meteredness from the underlying network '
      '(setMetered(false) kept, setUnderlyingNetworks used)', () {
    // Android 10+ makes a VPN metered by default, even on Wi-Fi; false
    // makes it follow the networks handed with setUnderlyingNetworks.
    final svc = _code('PleatVpnService.kt');
    expect(svc, contains('setMetered(false)'));
    expect(svc, isNot(contains('setMetered(true)')));
    expect(svc, contains('setUnderlyingNetworks(arrayOf(network))'));
  });

  test(
    'AND-06: an old service stopping late leaves a newer one running '
    '(running cleared only for its own core, hev stopped only by its owner)',
    () {
      final svc = _code('PleatVpnService.kt');
      final stop = svc.substring(
        svc.indexOf('private fun stopEngine()'),
        svc.indexOf('private fun teardown()'),
      );
      expect(stop, contains('running === core'));
      expect(
        stop,
        isNot(matches(RegExp(r'^\s*running = null', multiLine: true))),
      );
      // hev is one global per process: the stop goes through an owner check
      expect(svc, isNot(contains('TProxyService.TProxyStopService()')));
      final hev = _code('TProxyService.kt');
      expect(hev, contains('fun stop(owner: Any)'));
      expect(hev, contains('fun start(owner: Any'));
    },
  );
}
