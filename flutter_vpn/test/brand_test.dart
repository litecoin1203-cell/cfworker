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
}
