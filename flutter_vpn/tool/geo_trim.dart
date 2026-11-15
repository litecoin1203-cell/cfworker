// Keeps only the lists the app's rules use in geoip.dat / geosite.dat (PERF-A-03).
//
//   dart run tool/geo_trim.dart <in.dat> <out.dat> <code>...
//
// Both files are a protobuf list (GeoIPList / GeoSiteList) whose field 1 repeats
// one entry per list, and each entry's field 1 is its code ("IR",
// "CATEGORY-IR"). The kept entries are copied byte for byte, so a kept list
// matches exactly what it matched in the full file; the core looks a list up
// by its code, case-insensitively, and never reads the others. A code that is
// not in the input stops the tool instead of leaving a rule with nothing to
// match. The CI step that calls this (.github/workflows/flutter-vpn.yml) takes
// its codes from the rules in lib/state/xray_config.dart; a test holds the two
// together.
import 'dart:io';
import 'dart:typed_data';

/// One varint at [pos]: (value, position after it).
(int, int) _varint(Uint8List b, int pos) {
  var value = 0;
  var shift = 0;
  while (true) {
    if (pos >= b.length) throw const FormatException('truncated varint');
    final x = b[pos++];
    value |= (x & 0x7f) << shift;
    if (x < 0x80) return (value, pos);
    shift += 7;
    if (shift > 63) throw const FormatException('varint too long');
  }
}

/// The code (field 1) of one list entry.
String _code(Uint8List entry) {
  var pos = 0;
  while (pos < entry.length) {
    final (key, p1) = _varint(entry, pos);
    final field = key >> 3, wire = key & 7;
    pos = p1;
    switch (wire) {
      case 0:
        pos = _varint(entry, pos).$2;
      case 1:
        pos += 8;
      case 5:
        pos += 4;
      case 2:
        final (len, p2) = _varint(entry, pos);
        if (field == 1) {
          return String.fromCharCodes(entry.sublist(p2, p2 + len));
        }
        pos = p2 + len;
      default:
        throw FormatException('unknown wire type $wire');
    }
  }
  return '';
}

/// The entries of a GeoIPList / GeoSiteList, as (upper-case code, raw bytes
/// of the whole field, key and length included).
List<(String, Uint8List)> geoEntries(Uint8List data) {
  final out = <(String, Uint8List)>[];
  var pos = 0;
  while (pos < data.length) {
    final start = pos;
    final (key, p1) = _varint(data, pos);
    if (key != 0x0a) throw FormatException('unexpected field key $key');
    final (len, p2) = _varint(data, p1);
    if (p2 + len > data.length) throw const FormatException('truncated entry');
    final entry = Uint8List.sublistView(data, p2, p2 + len);
    out.add((
      _code(entry).toUpperCase(),
      Uint8List.sublistView(data, start, p2 + len),
    ));
    pos = p2 + len;
  }
  return out;
}

/// [data] with only the entries whose code is in [codes] (any case).
/// Throws when one of [codes] is missing.
Uint8List trimGeo(Uint8List data, Iterable<String> codes) {
  final want = {for (final c in codes) c.toUpperCase()};
  final kept = BytesBuilder(copy: false);
  final found = <String>{};
  for (final (code, raw) in geoEntries(data)) {
    if (want.contains(code)) {
      kept.add(raw);
      found.add(code);
    }
  }
  final missing = want.difference(found);
  if (missing.isNotEmpty) {
    throw StateError(
      'not in the geo file: ${(missing.toList()..sort()).join(', ')}',
    );
  }
  return kept.takeBytes();
}

void main(List<String> args) {
  if (args.length < 3) {
    stderr.writeln('usage: geo_trim.dart <in.dat> <out.dat> <code>...');
    exit(2);
  }
  final input = File(args[0]).readAsBytesSync();
  final out = trimGeo(input, args.skip(2));
  File(args[1]).writeAsBytesSync(out);
  stdout.writeln(
    '${args[1]}: ${out.length} bytes (from ${input.length}), '
    'kept ${args.skip(2).join(', ')}',
  );
}
