/// Country lookup for server remarks. The country comes from the remark
/// first: a flag emoji, a two-letter code token ("DE 2") or a country name
/// ("Germany"). A host label such as `de1.` is a last, internal hint; the
/// host itself is never shown.
library;

class Country {
  const Country(this.name, this.lon);
  final String name;

  /// Rough longitude of the country, used only to lean the shard field.
  final double lon;
}

const countries = <String, Country>{
  'AE': Country('United Arab Emirates', 54),
  'AM': Country('Armenia', 45),
  'AR': Country('Argentina', -64),
  'AT': Country('Austria', 14),
  'AU': Country('Australia', 134),
  'AZ': Country('Azerbaijan', 48),
  'BE': Country('Belgium', 4.5),
  'BG': Country('Bulgaria', 25),
  'BH': Country('Bahrain', 50.5),
  'BR': Country('Brazil', -52),
  'BY': Country('Belarus', 28),
  'CA': Country('Canada', -96),
  'CH': Country('Switzerland', 8.2),
  'CL': Country('Chile', -71),
  'CN': Country('China', 104),
  'CY': Country('Cyprus', 33),
  'CZ': Country('Czechia', 15.5),
  'DE': Country('Germany', 10.4),
  'DK': Country('Denmark', 10),
  'EE': Country('Estonia', 25),
  'EG': Country('Egypt', 30),
  'ES': Country('Spain', -3.7),
  'FI': Country('Finland', 26),
  'FR': Country('France', 2.2),
  'GB': Country('United Kingdom', -2),
  'GE': Country('Georgia', 43.4),
  'GR': Country('Greece', 22),
  'HK': Country('Hong Kong', 114),
  'HR': Country('Croatia', 15.2),
  'HU': Country('Hungary', 19.5),
  'ID': Country('Indonesia', 118),
  'IE': Country('Ireland', -8),
  'IL': Country('Israel', 35),
  'IN': Country('India', 79),
  'IQ': Country('Iraq', 44),
  'IR': Country('Iran', 53),
  'IS': Country('Iceland', -19),
  'IT': Country('Italy', 12.5),
  'JO': Country('Jordan', 36),
  'JP': Country('Japan', 138),
  'KR': Country('South Korea', 128),
  'KW': Country('Kuwait', 47.5),
  'KZ': Country('Kazakhstan', 67),
  'LT': Country('Lithuania', 24),
  'LU': Country('Luxembourg', 6.1),
  'LV': Country('Latvia', 24.6),
  'MD': Country('Moldova', 28.4),
  'MX': Country('Mexico', -102),
  'MY': Country('Malaysia', 102),
  'NG': Country('Nigeria', 8),
  'NL': Country('Netherlands', 5.3),
  'NO': Country('Norway', 9),
  'NZ': Country('New Zealand', 174),
  'OM': Country('Oman', 57),
  'PH': Country('Philippines', 122),
  'PK': Country('Pakistan', 69),
  'PL': Country('Poland', 19),
  'PT': Country('Portugal', -8),
  'QA': Country('Qatar', 51.2),
  'RO': Country('Romania', 25),
  'RS': Country('Serbia', 21),
  'RU': Country('Russia', 60),
  'SA': Country('Saudi Arabia', 45),
  'SE': Country('Sweden', 16),
  'SG': Country('Singapore', 103.8),
  'SI': Country('Slovenia', 14.8),
  'SK': Country('Slovakia', 19.7),
  'TH': Country('Thailand', 101),
  'TR': Country('Türkiye', 35),
  'TW': Country('Taiwan', 121),
  'UA': Country('Ukraine', 31),
  'US': Country('United States', -98),
  'UZ': Country('Uzbekistan', 64),
  'VN': Country('Vietnam', 106),
  'ZA': Country('South Africa', 24),
};

const _aliases = {
  'usa': 'US',
  'america': 'US',
  'united states of america': 'US',
  'uk': 'GB',
  'england': 'GB',
  'britain': 'GB',
  'great britain': 'GB',
  'holland': 'NL',
  'the netherlands': 'NL',
  'deutschland': 'DE',
  'turkey': 'TR',
  'korea': 'KR',
  'uae': 'AE',
  'emirates': 'AE',
  'dubai': 'AE',
  'czech republic': 'CZ',
};

String countryName(String cc) => countries[cc]?.name ?? cc;

/// Regional-indicator flag for a two-letter code, or '' when it isn't one.
String flagOf(String cc) {
  if (!RegExp(r'^[A-Z]{2}$').hasMatch(cc)) return '';
  return String.fromCharCodes(cc.codeUnits.map((c) => 0x1F1E6 + c - 65));
}

final _flagRe = RegExp(r'[\u{1F1E6}-\u{1F1FF}]{2}', unicode: true);

/// The country a remark names, or ''.
String countryFromRemark(String remark) {
  final m = _flagRe.firstMatch(remark);
  if (m != null) {
    return String.fromCharCodes(m.group(0)!.runes.map((r) => r - 0x1F1E6 + 65));
  }
  final lower = remark.toLowerCase();
  // Longest names first, so "united states of america" wins over "america".
  final names = <String, String>{
    for (final e in countries.entries) e.value.name.toLowerCase(): e.key,
    ..._aliases,
  };
  final keys = names.keys.toList()..sort((a, b) => b.length - a.length);
  for (final n in keys) {
    if (RegExp('(^|[^a-z])${RegExp.escape(n)}([^a-z]|\$)').hasMatch(lower)) {
      return names[n]!;
    }
  }
  // A standalone two-letter code token: "DE 2", "NL-1", "[US]".
  for (final t in RegExp(
    r'(?:^|[^A-Za-z])([A-Z]{2})(?=$|[^A-Za-z])',
  ).allMatches(remark)) {
    final cc = t.group(1)!;
    if (countries.containsKey(cc)) return cc;
  }
  return '';
}

/// Internal last resort: a country code as the first label of the host
/// ("de1.example.com" → DE). The host is never displayed or logged.
String countryFromHost(String host) {
  final m = RegExp(r'^([a-z]{2})(?:\d+)?[.-]').firstMatch(host.toLowerCase());
  if (m == null) return '';
  final cc = m.group(1)!.toUpperCase();
  return countries.containsKey(cc) ? cc : '';
}

/// Locations groups countries under these, in this order when nothing is
/// measured yet. Turkey and the Caucasus sit with Europe, as people in Iran
/// think of them as the near west.
enum Region {
  europe('Europe'),
  middleEast('Middle East'),
  asia('Asia'),
  americas('Americas'),
  africa('Africa'),
  oceania('Oceania'),
  other('Other');

  const Region(this.title);
  final String title;
}

const _regionOf = <String, Region>{
  'AT': Region.europe,
  'BE': Region.europe,
  'BG': Region.europe,
  'BY': Region.europe,
  'CH': Region.europe,
  'CY': Region.europe,
  'CZ': Region.europe,
  'DE': Region.europe,
  'DK': Region.europe,
  'EE': Region.europe,
  'ES': Region.europe,
  'FI': Region.europe,
  'FR': Region.europe,
  'GB': Region.europe,
  'GR': Region.europe,
  'HR': Region.europe,
  'HU': Region.europe,
  'IE': Region.europe,
  'IS': Region.europe,
  'IT': Region.europe,
  'LT': Region.europe,
  'LU': Region.europe,
  'LV': Region.europe,
  'MD': Region.europe,
  'NL': Region.europe,
  'NO': Region.europe,
  'PL': Region.europe,
  'PT': Region.europe,
  'RO': Region.europe,
  'RS': Region.europe,
  'RU': Region.europe,
  'SE': Region.europe,
  'SI': Region.europe,
  'SK': Region.europe,
  'UA': Region.europe,
  'TR': Region.europe,
  'AM': Region.europe,
  'AZ': Region.europe,
  'GE': Region.europe,
  'AE': Region.middleEast,
  'BH': Region.middleEast,
  'IL': Region.middleEast,
  'IQ': Region.middleEast,
  'IR': Region.middleEast,
  'JO': Region.middleEast,
  'KW': Region.middleEast,
  'OM': Region.middleEast,
  'QA': Region.middleEast,
  'SA': Region.middleEast,
  'CN': Region.asia,
  'HK': Region.asia,
  'ID': Region.asia,
  'IN': Region.asia,
  'JP': Region.asia,
  'KR': Region.asia,
  'KZ': Region.asia,
  'MY': Region.asia,
  'PH': Region.asia,
  'PK': Region.asia,
  'SG': Region.asia,
  'TH': Region.asia,
  'TW': Region.asia,
  'UZ': Region.asia,
  'VN': Region.asia,
  'AR': Region.americas,
  'BR': Region.americas,
  'CA': Region.americas,
  'CL': Region.americas,
  'MX': Region.americas,
  'US': Region.americas,
  'EG': Region.africa,
  'NG': Region.africa,
  'ZA': Region.africa,
  'AU': Region.oceania,
  'NZ': Region.oceania,
};

Region regionOf(String cc) => _regionOf[cc] ?? Region.other;
