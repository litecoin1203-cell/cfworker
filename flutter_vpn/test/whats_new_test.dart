import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/models.dart';
import 'package:pleat/screens/whats_new.dart';
import 'package:pleat/state/whats_new.dart';

String _file() => File('assets/whats_new/whats_new.json').readAsStringSync();

String _pubspecVersion() => RegExp(
  r'^version:\s*(\d+\.\d+\.\d+)\+',
  multiLine: true,
).firstMatch(File('pubspec.yaml').readAsStringSync())!.group(1)!;

int _cmp(String a, String b) {
  final x = a.split('.').map(int.parse).toList();
  final y = b.split('.').map(int.parse).toList();
  for (var i = 0; i < 3; i++) {
    if (x[i] != y[i]) return x[i].compareTo(y[i]);
  }
  return 0;
}

AppUpdate _update(String version, List<Map<String, String>> notes) =>
    AppUpdate.fromJson({
      'version': version,
      'build': 99,
      'tag': '99-x',
      'abis': {
        'arm64-v8a': {'size': 10, 'sha256': 'a' * 64},
      },
      'notes': notes,
    });

void main() {
  group('the bundled What\'s new file', () {
    final book = WhatsNewBook.parse(_file());

    test('parses, newest first, every version once', () {
      expect(book.entries, isNotEmpty);
      final versions = book.entries.map((e) => e.version).toList();
      expect(versions.toSet().length, versions.length);
      for (var i = 1; i < versions.length; i++) {
        expect(
          _cmp(versions[i - 1], versions[i]),
          greaterThan(0),
          reason: '${versions[i - 1]} must come before ${versions[i]}',
        );
      }
    });

    test('has lines for the version in pubspec.yaml (every release adds '
        'its entry; the APK workflow copies it into the release notes)', () {
      final e = book.of(_pubspecVersion());
      expect(
        e,
        isNotNull,
        reason:
            'add ${_pubspecVersion()} to '
            'assets/whats_new/whats_new.json',
      );
      expect(e!.notes, isNotEmpty);
    });

    test('every line is short English with a known kind (Pleat is English '
        'only; the Worker drops other scripts)', () {
      final raw = _file();
      expect(RegExp(r'[֐-ࣿיִ-﷿ﹰ-﻿]').hasMatch(raw), isFalse);
      expect(
        RegExp(r'"kind":\s*"(?!new"|better"|fixed")').hasMatch(raw),
        isFalse,
      );
      for (final e in book.entries) {
        expect(e.date, isNotNull, reason: e.version);
        expect(e.notes.length, lessThanOrEqualTo(8), reason: e.version);
        for (final n in e.notes) {
          expect(n.text.length, inInclusiveRange(1, 160));
          expect(n.text.contains('<'), isFalse);
        }
      }
    });
  });

  test('app-config notes: kinds, malformed lines left out, at most 8', () {
    final u = _update('1.2.60', [
      {'kind': 'better', 'text': 'Faster.'},
      {'kind': 'fixed', 'text': ' Widget. '},
      {'kind': 'odd', 'text': 'Plain.'},
      {'kind': 'new', 'text': '  '},
      for (var i = 0; i < 10; i++) {'kind': 'new', 'text': 'n$i'},
    ]);
    expect(u.notes.length, 8);
    expect(u.notes[0].kind, NoteKind.better);
    expect(u.notes[1].text, 'Widget.');
    expect(u.notes[2].kind, NoteKind.added);
    expect(
      AppUpdate.fromJson({'version': '1.2.3', 'build': 1}).notes,
      isEmpty,
      reason: 'a Worker without notes',
    );
  });

  test('the store\'s reworded lines win for the version it announced', () {
    final book = WhatsNewBook.parse(
      '[{"version":"1.2.60","date":"2026-11-20","notes":[{"kind":"new","text":"Bundled."}]},'
      '{"version":"1.2.59","date":"2026-11-19","notes":[]}]',
    );
    final mixed = book.withAnnounced(
      _update('1.2.60', [
        {'kind': 'fixed', 'text': 'From the bot.'},
      ]),
    );
    expect(mixed.of('1.2.60')!.notes.single.text, 'From the bot.');
    expect(mixed.of('1.2.60')!.date, DateTime(2026, 11, 20));
    expect(
      book
          .withAnnounced(
            _update('1.2.61', [
              {'kind': 'new', 'text': 'x'},
            ]),
          )
          .entries
          .length,
      2,
      reason: 'a version not in the file adds nothing',
    );
    expect(
      book.withAnnounced(null).of('1.2.60')!.notes.single.text,
      'Bundled.',
    );
    expect(WhatsNewBook.parse('not json').entries, isEmpty);
  });

  test('the Home card: once per version, after an update, never on a new '
      'install', () {
    final book = WhatsNewBook.parse(
      '[{"version":"1.2.60","date":"2026-11-20","notes":[{"kind":"new","text":"x"}]},'
      '{"version":"1.2.59","date":"2026-11-19","notes":[]}]',
    );
    bool show(String v, String? seen) =>
        showWhatsNewCard(version: v, seen: seen, book: book);
    expect(show('1.2.60', '1.2.59'), isTrue, reason: 'updated');
    expect(
      show('1.2.60', ''),
      isTrue,
      reason:
          'updated from a Pleat '
          'that had no What\'s new',
    );
    expect(show('1.2.60', '1.2.60'), isFalse, reason: 'already seen');
    expect(show('1.2.60', WhatsNewSeen.fresh), isFalse, reason: 'new install');
    expect(
      show('1.2.59', '1.2.58'),
      isFalse,
      reason: 'a version with no lines',
    );
    expect(show('1.2.61', '1.2.60'), isFalse, reason: 'not in the file');
    expect(show('', '1.2.59'), isFalse, reason: 'version not known yet');
  });

  testWidgets('the lines show with their chips', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: NoteLines([
            const ReleaseNote(NoteKind.added, 'Smart connect.'),
            const ReleaseNote(NoteKind.fixed, 'Widget.'),
          ]),
        ),
      ),
    );
    expect(find.text('NEW'), findsOneWidget);
    expect(find.text('FIXED'), findsOneWidget);
    expect(find.text('Smart connect.'), findsOneWidget);
  });
}
