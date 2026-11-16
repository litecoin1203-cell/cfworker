// UX-10: the product is Pleat. The old "Cloud Gold" name may stay in code
// comments (it explains why the app matches the old app's behaviour) but
// never in text a person reads.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('no screen text names Cloud Gold', () {
    final hits = <String>[];
    for (final f in Directory('lib').listSync(recursive: true)) {
      if (f is! File || !f.path.endsWith('.dart')) continue;
      final lines = f.readAsLinesSync();
      for (final (i, line) in lines.indexed) {
        final code = line.trimLeft();
        if (code.startsWith('//')) continue;
        if (line.contains('Cloud Gold')) hits.add('${f.path}:${i + 1}');
      }
    }
    expect(hits, isEmpty);
  });
  jargon();
}

// UX-09: the support tools stay, in plain words: no "core" on screen.
void jargon() {
  test('the support tools speak without engine jargon', () {
    final hits = <String>[];
    for (final name in ['check.dart', 'google_location.dart']) {
      final lines = File('lib/screens/$name').readAsLinesSync();
      for (final (i, line) in lines.indexed) {
        if (line.trimLeft().startsWith('//')) continue;
        for (final m in RegExp(r"'([^']*)'").allMatches(line)) {
          if (RegExp(r'\bcore\b').hasMatch(m[1]!)) hits.add('$name:${i + 1}');
        }
      }
    }
    expect(hits, isEmpty);
  });
}
