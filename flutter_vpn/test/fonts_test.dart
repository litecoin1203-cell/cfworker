import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/licenses.dart';

/// PRV-02: the type face ships inside the APK. Nothing fetches a font at
/// run time (that request would leave the phone outside the tunnel, from
/// the user's real address, to a third party).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('PRV-02: no runtime font fetching package is used', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    expect(pubspec, isNot(contains('google_fonts')));
    for (final f in Directory('lib').listSync(recursive: true)) {
      if (f is! File || !f.path.endsWith('.dart')) continue;
      expect(
        f.readAsStringSync(),
        isNot(contains('package:google_fonts')),
        reason: f.path,
      );
    }
  });

  test('PRV-02: Plus Jakarta Sans is bundled for every weight in use', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    expect(pubspec, contains('- family: PlusJakartaSans'));
    for (final (file, weight) in [
      ('Light', 300),
      ('Regular', 400),
      ('Medium', 500),
      ('SemiBold', 600),
      ('Bold', 700),
      ('ExtraBold', 800),
    ]) {
      final path = 'assets/fonts/PlusJakartaSans-$file.ttf';
      expect(File(path).existsSync(), isTrue, reason: path);
      expect(File(path).lengthSync(), greaterThan(50000), reason: path);
      expect(pubspec, contains('- asset: $path\n          weight: $weight'));
    }
  });

  test('PRV-02: PType uses the bundled family', () {
    final saved = PType.familyOverride;
    PType.familyOverride = null;
    addTearDown(() => PType.familyOverride = saved);
    expect(PType.body().fontFamily, 'PlusJakartaSans');
    expect(PType.h1().fontFamily, 'PlusJakartaSans');
  });

  test('PRV-02: the font licence (OFL) is on the licence page', () async {
    registerThirdPartyLicenses();
    final texts = <String>[];
    await for (final e in LicenseRegistry.licenses) {
      if (e.packages.contains('Plus Jakarta Sans (font)')) {
        texts.add(e.paragraphs.map((p) => p.text).join('\n'));
      }
    }
    expect(texts.join(), contains('SIL OPEN FONT LICENSE Version 1.1'));
    expect(texts.join(), contains('Plus Jakarta Sans Project Authors'));
  });
}
