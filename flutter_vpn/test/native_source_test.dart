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
  test('NET-04: the VPN is not declared unmetered', () {
    // Unset (or true), Android takes the metered state of the underlying
    // network handed with setUnderlyingNetworks: mobile data stays metered.
    final svc = _code('PleatVpnService.kt');
    expect(svc, isNot(contains('setMetered(false)')));
    expect(svc, contains('setUnderlyingNetworks(arrayOf(network))'));
  });
}
