import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/licenses.dart';

/// Every licence entry Flutter's licence page would show, by package.
Future<Map<String, String>> _registered() async {
  final out = <String, String>{};
  await for (final e in LicenseRegistry.licenses) {
    final text = e.paragraphs.map((p) => p.text).join('\n');
    for (final p in e.packages) {
      out[p] = '${out[p] ?? ''}\n$text';
    }
  }
  return out;
}

String _asset(String name) => File('assets/licenses/$name').readAsStringSync();

/// The `env:` value of the APK workflow, which pins the native engines.
String _pin(String key) {
  final yml = File('../.github/workflows/flutter-vpn.yml').readAsStringSync();
  return RegExp(
    '^  $key: (\\S+)\$',
    multiLine: true,
  ).firstMatch(yml)!.group(1)!;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('LEG-01/02/03: every bundled native component has its licence '
      'registered', () async {
    registerThirdPartyLicenses();
    registerThirdPartyLicenses(); // a second call adds nothing
    final l = await _registered();
    // LEG-01: LGPL-3.0 (with the GPL it builds on) and MPL-2.0
    expect(l['AndroidLibXrayLite'], contains('GNU LESSER GENERAL PUBLIC'));
    expect(l['AndroidLibXrayLite'], contains('GNU GENERAL PUBLIC LICENSE'));
    expect(l['Xray-core'], contains('Mozilla Public License Version 2.0'));
    // LEG-03: hev-socks5-tunnel and the submodules it is built with
    for (final p in [
      'hev-socks5-tunnel',
      'hev-socks5-core',
      'hev-task-system',
      'yaml (hev)',
    ]) {
      expect(l[p], contains('Permission is hereby granted'), reason: p);
    }
    expect(l['lwIP'], contains('Swedish Institute of Computer Science'));
    // LEG-02: the geo data, GPL-3.0 and MaxMind's attribution
    final geo = l['Routing data (geoip.dat, geosite.dat)'];
    expect(geo, contains('GNU GENERAL PUBLIC LICENSE'));
    expect(
      geo,
      contains('This product includes GeoLite2 data created by MaxMind'),
    );
    expect(l['domain-list-community'], contains('MIT License'));
    // LEG-03: each Go module in libgojni.so, under its own name
    final mods = RegExp(
      r'^==== module (\S+) ',
      multiLine: true,
    ).allMatches(_asset('go-modules.txt')).map((m) => m.group(1)!).toList();
    expect(mods.length, greaterThan(40));
    expect(mods, containsAll(['std', 'golang.org/x/net', 'gvisor.dev/gvisor']));
    for (final m in mods) {
      final name = m == 'std' ? 'Go standard library' : m;
      expect(l[name], isNotNull, reason: m);
      expect(l[name]!.trim(), isNotEmpty, reason: m);
    }
    // the source offer is in the list too
    expect(l['Pleat: source code'], contains('free of charge'));
  });

  test('LEG-01: the source offer names the engines the APK workflow pins', () {
    final src = _asset('SOURCE.txt');
    final lib = _pin('XRAY_LIB_TAG');
    final hev = _pin('HEV_COMMIT');
    expect(src, contains('AndroidLibXrayLite $lib'));
    expect(src, contains('github.com/2dust/AndroidLibXrayLite/tree/$lib'));
    expect(src, contains('hev-socks5-tunnel commit $hev'));
    expect(src, contains('github.com/heiher/hev-socks5-tunnel/tree/$hev'));
    // the Xray-core version in the offer is the one in the Go module list
    final xray = RegExp(
      r'^==== module github\.com/autorepobot/xray-core (\S+)$',
      multiLine: true,
    ).firstMatch(_asset('go-modules.txt'))!.group(1)!;
    expect(src, contains('github.com/autorepobot/xray-core $xray'));
    expect(src, contains('xray-core/@v/$xray.zip'));
  });

  test('the licence assets are declared, so they reach the APK', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    expect(pubspec, contains('    - assets/licenses/'));
    for (final f in thirdPartyLicenseFiles) {
      expect(File('assets/licenses/$f').existsSync(), isTrue, reason: f);
    }
  });
}
