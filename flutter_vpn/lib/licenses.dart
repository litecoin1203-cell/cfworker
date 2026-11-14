import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Licences of what the APK carries besides Dart packages (Flutter lists
/// those by itself): the Xray engine (AndroidLibXrayLite, LGPL-3.0, with
/// Xray-core, MPL-2.0, and the Go modules compiled into libgojni.so),
/// hev-socks5-tunnel (MIT) with its submodules, and the geo routing data
/// (GPL-3.0, GeoLite2 by MaxMind). The texts are in assets/licenses/;
/// go-modules.txt is written by tool/go_licenses.py from the AAR's build
/// info. The versions are the ones .github/workflows/flutter-vpn.yml pins.
const thirdPartyLicenses = <(String, List<String>)>[
  (sourceOfferEntry, ['SOURCE.txt']),
  ('AndroidLibXrayLite', ['LGPL-3.0.txt', 'GPL-3.0.txt']),
  ('Xray-core', ['MPL-2.0.txt']),
  ('hev-socks5-tunnel', ['hev-socks5-tunnel.txt']),
  ('hev-socks5-core', ['hev-socks5-core.txt']),
  ('hev-task-system', ['hev-task-system.txt']),
  ('yaml (hev)', ['hev-yaml.txt']),
  ('lwIP', ['lwip.txt']),
  ('Routing data (geoip.dat, geosite.dat)', ['geo-data.txt', 'GPL-3.0.txt']),
  ('domain-list-community', ['domain-list-community.txt']),
];

const _goModules = 'go-modules.txt';

/// Every file under assets/licenses/ that the licence page reads.
List<String> get thirdPartyLicenseFiles => {
  for (final (_, files) in thirdPartyLicenses) ...files,
  _goModules,
}.toList();

/// The licence page entry with the source offer (LGPL / MPL / GPL).
const sourceOfferEntry = 'Pleat: source code';

bool _registered = false;

/// Adds the texts to Flutter's [LicenseRegistry] (read lazily, when the
/// licence page opens). Safe to call more than once.
void registerThirdPartyLicenses() {
  if (_registered) return;
  _registered = true;
  LicenseRegistry.addLicense(() async* {
    for (final (name, files) in thirdPartyLicenses) {
      final texts = [
        for (final f in files)
          await rootBundle.loadString('assets/licenses/$f'),
      ];
      yield LicenseEntryWithLineBreaks([name], texts.join('\n\n'));
    }
    yield* _goEntries(
      await rootBundle.loadString('assets/licenses/$_goModules'),
    );
  });
}

/// go-modules.txt: one block per module, opened by
/// `==== module <path> <version>`; the Go standard library is `std`.
Stream<LicenseEntry> _goEntries(String all) async* {
  const head = '==== module ';
  final blocks = all.split('\n$head').skip(1);
  for (final b in blocks) {
    final nl = b.indexOf('\n');
    final parts = b.substring(0, nl).trim().split(' ');
    final name = parts.first == 'std' ? 'Go standard library' : parts.first;
    final text = b
        .substring(nl + 1)
        .replaceAll(RegExp(r'^-- ', multiLine: true), '')
        .trim();
    yield LicenseEntryWithLineBreaks([
      name,
    ], '${parts.first} ${parts.skip(1).join(' ')}\n\n$text');
  }
}
