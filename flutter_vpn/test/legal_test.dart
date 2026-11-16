import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/screens/legal.dart';

void main() {
  test('PRV-03: the app says word for word what docs/legal/*.txt says '
      '(the Mini App bundles those files)', () {
    for (final d in LegalDoc.values) {
      final file = File('../docs/legal/${d.file}').readAsStringSync();
      expect(
        d.text,
        file,
        reason: 'lib/legal_text.dart is out of date: copy ${d.file} into it',
      );
    }
  });

  test('PRV-03: the texts parse into a title, sections and items', () {
    for (final d in LegalDoc.values) {
      final b = parseLegal(d.text);
      expect(b.first, (kind: LegalKind.title, text: d.title));
      expect(b.where((x) => x.kind == LegalKind.heading), isNotEmpty);
    }
    expect(parseLegal('# T\n\n## S\n- one\ntext\n'), [
      (kind: LegalKind.title, text: 'T'),
      (kind: LegalKind.heading, text: 'S'),
      (kind: LegalKind.item, text: 'one'),
      (kind: LegalKind.paragraph, text: 'text'),
    ]);
  });

  test('PRV-03: the policy names no country and keeps to the data map', () {
    final all = LegalDoc.values.map((d) => d.text).join('\n');
    expect(all, isNot(contains(RegExp('Iran|Persian', caseSensitive: false))));
    final p = LegalDoc.privacy.text;
    // what the Worker keeps and how long (netstats.js prune, health.js)
    expect(p, contains('Kept for 30 days'));
    expect(p, contains('Kept for 14 days'));
    expect(p, contains('about 4 days'));
    expect(p, contains('Cloudflare'));
    expect(p, contains('Telegram'));
    expect(p, isNot(contains('no session log')));
  });
}
