import 'dart:convert';

import 'package:flutter/services.dart';

import '../api/models.dart';

/// One version's What's new: its version, the day it came out and its lines.
class ReleaseEntry {
  const ReleaseEntry(this.version, this.date, this.notes);
  final String version;

  /// The day it came out; null when the file has no date.
  final DateTime? date;
  final List<ReleaseNote> notes;
}

/// Every version's What's new, newest first. The list ships inside the app
/// (assets/whats_new/whats_new.json), so Profile's What's new page works
/// offline. The same file feeds the release notes the Worker reads, so the
/// update sheet of an older Pleat shows the same lines before the update.
class WhatsNewBook {
  const WhatsNewBook(this.entries);
  static const empty = WhatsNewBook([]);
  static const asset = 'assets/whats_new/whats_new.json';

  final List<ReleaseEntry> entries;

  /// The file's entries, leaving out anything malformed.
  factory WhatsNewBook.parse(String json) {
    try {
      final raw = jsonDecode(json);
      if (raw is! List) return empty;
      return WhatsNewBook([
        for (final e in raw.whereType<Map>())
          if (RegExp(r'^\d+\.\d+\.\d+$').hasMatch('${e['version'] ?? ''}'))
            ReleaseEntry(
              '${e['version']}',
              DateTime.tryParse('${e['date'] ?? ''}'),
              ReleaseNote.list(e['notes']),
            ),
      ]);
    } on FormatException {
      return empty;
    }
  }

  static Future<WhatsNewBook> load([AssetBundle? bundle]) async {
    try {
      return WhatsNewBook.parse(await (bundle ?? rootBundle).loadString(asset));
    } catch (_) {
      return empty;
    }
  }

  ReleaseEntry? of(String version) {
    for (final e in entries) {
      if (e.version == version) return e;
    }
    return null;
  }

  /// The book as the page shows it: when the store announced this very
  /// version with lines of its own (the admin may reword them in the bot),
  /// those lines win over the bundled ones.
  WhatsNewBook withAnnounced(AppUpdate? announced) {
    if (announced == null || announced.notes.isEmpty) return this;
    final have = of(announced.version);
    if (have == null) return this;
    return WhatsNewBook([
      for (final e in entries)
        e.version == announced.version
            ? ReleaseEntry(e.version, e.date, announced.notes)
            : e,
    ]);
  }
}

/// When the "You're on the new Pleat" card shows on Home: once per version,
/// after an update, when that version has lines. [seen] is the version the
/// person last saw (or dismissed) the card for; [fresh] marks a new install,
/// which has nothing "new" to be told about.
bool showWhatsNewCard({
  required String version,
  required String? seen,
  required WhatsNewBook book,
}) {
  if (version.isEmpty || seen == null || seen == version) return false;
  if (seen == WhatsNewSeen.fresh) return false;
  final e = book.of(version);
  return e != null && e.notes.isNotEmpty;
}

/// The values the "seen" preference holds besides a version.
abstract final class WhatsNewSeen {
  static const key = 'whatsNewSeen';

  /// A new install: its first version is recorded once it is known.
  static const fresh = '-';
}
