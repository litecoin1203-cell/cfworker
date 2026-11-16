import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import '../tool/geo_trim.dart';

/// A protobuf length-delimited field ([key] = field << 3 | 2).
List<int> _ld(int key, List<int> body) {
  final len = <int>[];
  var n = body.length;
  while (n >= 0x80) {
    len.add((n & 0x7f) | 0x80);
    n >>= 7;
  }
  len.add(n);
  return [key, ...len, ...body];
}

List<int> _f1(List<int> body) => _ld(0x0a, body);

/// One list entry: code in field 1, then some payload in field 2.
List<int> _entry(String code, List<int> payload) =>
    _f1([..._f1(code.codeUnits), ..._ld(0x12, payload)]);

/// The `env:` value of the APK workflow.
String _env(String key) {
  final yml = File('../.github/workflows/flutter-vpn.yml').readAsStringSync();
  final m = RegExp('^  $key: (.+)\$', multiLine: true).firstMatch(yml);
  return (m?.group(1) ?? '').replaceAll("'", '').trim();
}

/// Every `geosite:` / `geoip:` list the app's own code can put in a rule.
Set<String> _used(String kind) => {
  for (final f in Directory('lib').listSync(recursive: true).whereType<File>())
    if (f.path.endsWith('.dart'))
      for (final m in RegExp(
        "'$kind:([A-Za-z0-9!@._-]+)'",
      ).allMatches(f.readAsStringSync()))
        m.group(1)!.toUpperCase(),
};

void main() {
  final big = List<int>.generate(300, (i) => i % 251); // a 2-byte length
  final data = Uint8List.fromList([
    ..._entry('CN', [1, 2, 3]),
    ..._entry('CATEGORY-IR', big),
    ..._entry('PRIVATE', [9]),
    ..._entry('category-ads-all', [4, 5]),
  ]);

  test('PERF-A-03: only the asked lists are kept, byte for byte', () {
    final out = trimGeo(data, ['category-ir', 'CATEGORY-ADS-ALL']);
    expect(out, [
      ..._entry('CATEGORY-IR', big),
      ..._entry('category-ads-all', [4, 5]),
    ]);
    expect(geoEntries(out).map((e) => e.$1), [
      'CATEGORY-IR',
      'CATEGORY-ADS-ALL',
    ]);
  });

  test('PERF-A-03: a list missing from the file stops the trim', () {
    expect(() => trimGeo(data, ['CATEGORY-IR', 'IR']), throwsStateError);
  });

  test('PERF-A-03: a broken file is refused', () {
    expect(
      () => trimGeo(Uint8List.fromList([0x0a, 0x50, 1]), ['IR']),
      throwsFormatException,
    );
  });

  test('PERF-A-03: the APK keeps exactly the lists the app\'s rules use', () {
    final site = _used('geosite');
    final ip = _used('geoip');
    // the ones the rules use today (Iranian sites direct, Shield)
    expect(
      site,
      containsAll(['CATEGORY-IR', 'CATEGORY-ADS-ALL', 'CATEGORY-PORN']),
    );
    expect(ip, contains('IR'));
    final keepSite = _env('GEOSITE_KEEP').toUpperCase().split(' ').toSet();
    final keepIp = _env('GEOIP_KEEP').toUpperCase().split(' ').toSet();
    expect(keepSite, site, reason: 'GEOSITE_KEEP in flutter-vpn.yml');
    expect(keepIp, ip, reason: 'GEOIP_KEEP in flutter-vpn.yml');
    final yml = File('../.github/workflows/flutter-vpn.yml').readAsStringSync();
    // trimmed before the configs are checked with the real core, so the
    // check runs on the very files the APK ships
    final trim = yml.indexOf('tool/geo_trim.dart');
    expect(trim, greaterThan(0));
    expect(trim, lessThan(yml.indexOf('xray run -test')));
    expect(yml, contains(r'$GEOSITE_KEEP'));
    expect(yml, contains(r'$GEOIP_KEEP'));
  });
}
