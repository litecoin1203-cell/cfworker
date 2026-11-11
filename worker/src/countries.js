// The country a server is in, read from what the panel calls it. Panels name configs in many ways: a flag
// emoji ("🇩🇪 Fast"), a country or city name in English or Persian ("Germany", "آلمان", "Frankfurt"), or a
// two-letter code ("DE-2", "[NL]"). A host label like "de1." is the last, internal hint (never shown).
// Mirrors flutter_vpn/lib/api/countries.dart so the app and the Worker agree.

export const COUNTRIES = {
  AE: 'United Arab Emirates', AM: 'Armenia', AR: 'Argentina', AT: 'Austria', AU: 'Australia', AZ: 'Azerbaijan',
  BE: 'Belgium', BG: 'Bulgaria', BH: 'Bahrain', BR: 'Brazil', BY: 'Belarus', CA: 'Canada', CH: 'Switzerland',
  CL: 'Chile', CN: 'China', CY: 'Cyprus', CZ: 'Czechia', DE: 'Germany', DK: 'Denmark', EE: 'Estonia', EG: 'Egypt',
  ES: 'Spain', FI: 'Finland', FR: 'France', GB: 'United Kingdom', GE: 'Georgia', GR: 'Greece', HK: 'Hong Kong',
  HR: 'Croatia', HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland', IL: 'Israel', IN: 'India', IQ: 'Iraq', IR: 'Iran',
  IS: 'Iceland', IT: 'Italy', JO: 'Jordan', JP: 'Japan', KR: 'South Korea', KW: 'Kuwait', KZ: 'Kazakhstan',
  LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia', MD: 'Moldova', MX: 'Mexico', MY: 'Malaysia', NG: 'Nigeria',
  NL: 'Netherlands', NO: 'Norway', NZ: 'New Zealand', OM: 'Oman', PH: 'Philippines', PK: 'Pakistan', PL: 'Poland',
  PT: 'Portugal', QA: 'Qatar', RO: 'Romania', RS: 'Serbia', RU: 'Russia', SA: 'Saudi Arabia', SE: 'Sweden',
  SG: 'Singapore', SI: 'Slovenia', SK: 'Slovakia', TH: 'Thailand', TR: 'Türkiye', TW: 'Taiwan', UA: 'Ukraine',
  US: 'United States', UZ: 'Uzbekistan', VN: 'Vietnam', ZA: 'South Africa',
};

// other English names, and cities providers put in remarks
const ALIASES = {
  usa: 'US', america: 'US', 'united states of america': 'US', uk: 'GB', england: 'GB', britain: 'GB', 'great britain': 'GB',
  holland: 'NL', 'the netherlands': 'NL', deutschland: 'DE', turkey: 'TR', turkiye: 'TR', korea: 'KR', uae: 'AE',
  emirates: 'AE', dubai: 'AE', 'czech republic': 'CZ',
  frankfurt: 'DE', falkenstein: 'DE', nuremberg: 'DE', berlin: 'DE', amsterdam: 'NL', istanbul: 'TR', izmir: 'TR',
  london: 'GB', paris: 'FR', helsinki: 'FI', stockholm: 'SE', moscow: 'RU', yerevan: 'AM', zurich: 'CH',
  vienna: 'AT', warsaw: 'PL', milan: 'IT', madrid: 'ES', tokyo: 'JP', toronto: 'CA', 'new york': 'US', ashburn: 'US',
  'los angeles': 'US', tbilisi: 'GE', baku: 'AZ', tehran: 'IR', oslo: 'NO', bucharest: 'RO', sofia: 'BG',
};

// Persian names (normalised: ي→ی, ك→ک, no zero-width joiner)
const FA = {
  'آلمان': 'DE', 'هلند': 'NL', 'ترکیه': 'TR', 'فرانسه': 'FR', 'انگلیس': 'GB', 'انگلستان': 'GB', 'بریتانیا': 'GB',
  'آمریکا': 'US', 'امریکا': 'US', 'کانادا': 'CA', 'فنلاند': 'FI', 'سوئد': 'SE', 'نروژ': 'NO', 'روسیه': 'RU',
  'ارمنستان': 'AM', 'سوئیس': 'CH', 'اتریش': 'AT', 'ایتالیا': 'IT', 'اسپانیا': 'ES', 'لهستان': 'PL', 'امارات': 'AE',
  'دبی': 'AE', 'ژاپن': 'JP', 'سنگاپور': 'SG', 'هنگ کنگ': 'HK', 'هنگکنگ': 'HK', 'هند': 'IN', 'هندوستان': 'IN',
  'ایران': 'IR', 'عراق': 'IQ', 'قطر': 'QA', 'عربستان': 'SA', 'بحرین': 'BH', 'کویت': 'KW', 'عمان': 'OM',
  'گرجستان': 'GE', 'آذربایجان': 'AZ', 'قزاقستان': 'KZ', 'اوکراین': 'UA', 'رومانی': 'RO', 'بلغارستان': 'BG',
  'مجارستان': 'HU', 'لیتوانی': 'LT', 'لتونی': 'LV', 'استونی': 'EE', 'دانمارک': 'DK', 'بلژیک': 'BE',
  'لوکزامبورگ': 'LU', 'ایرلند': 'IE', 'پرتغال': 'PT', 'یونان': 'GR', 'قبرس': 'CY', 'مولداوی': 'MD', 'صربستان': 'RS',
  'کرواسی': 'HR', 'اسلوونی': 'SI', 'اسلواکی': 'SK', 'بلاروس': 'BY', 'ازبکستان': 'UZ', 'چین': 'CN', 'کره': 'KR',
  'تایوان': 'TW', 'تایلند': 'TH', 'ویتنام': 'VN', 'مالزی': 'MY', 'اندونزی': 'ID', 'استرالیا': 'AU', 'برزیل': 'BR',
  'مکزیک': 'MX', 'آرژانتین': 'AR', 'شیلی': 'CL', 'مصر': 'EG', 'آفریقای جنوبی': 'ZA', 'اردن': 'JO', 'پاکستان': 'PK',
  'فرانکفورت': 'DE', 'آمستردام': 'NL', 'استانبول': 'TR', 'لندن': 'GB', 'پاریس': 'FR', 'هلسینکی': 'FI', 'مسکو': 'RU', 'ایروان': 'AM',
};

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// longest first, so "united states of america" wins over "america" and "هندوستان" over "هند"
const EN = Object.entries({ ...Object.fromEntries(Object.entries(COUNTRIES).map(([cc, n]) => [n.toLowerCase(), cc])), ...ALIASES })
  .sort((a, b) => b[0].length - a[0].length)
  .map(([n, cc]) => [new RegExp(`(^|[^a-z])${esc(n)}([^a-z]|$)`), cc]);
const FA_LETTER = '\\u0600-\\u06FF';
const FA_RE = Object.entries(FA).sort((a, b) => b[0].length - a[0].length)
  // a whole word, or the adjective with ی ("آلمانی"), so "هند" does not match inside "هندزفری"
  .map(([n, cc]) => [new RegExp(`(^|[^${FA_LETTER}])${esc(n)}ی?(?=$|[^${FA_LETTER}])`), cc]);

const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

export function flagToCc(text) {
  const m = String(text || '').match(FLAG_RE);
  if (!m) return '';
  return Array.from(m[0]).map((ch) => String.fromCharCode(ch.codePointAt(0) - 0x1f1e6 + 65)).join('');
}

// The ISO code a remark names, or ''.
export function countryFromRemark(remark) {
  const text = String(remark || '');
  const flag = flagToCc(text);
  if (flag) return flag;
  const lower = text.toLowerCase();
  for (const [re, cc] of EN) if (re.test(lower)) return cc;
  const fa = text.replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/‌/g, ' ');
  for (const [re, cc] of FA_RE) if (re.test(fa)) return cc;
  // a standalone two-letter code: "DE 2", "NL-1", "[US]"
  for (const m of text.matchAll(/(?:^|[^A-Za-z])([A-Z]{2})(?=$|[^A-Za-z])/g)) if (COUNTRIES[m[1]]) return m[1];
  return '';
}

// "de1.example.com" -> DE. Internal hint only: the host is never shown or logged.
export function countryFromHost(host) {
  const m = String(host || '').toLowerCase().match(/^([a-z]{2})\d*[.-]/);
  return m && COUNTRIES[m[1].toUpperCase()] ? m[1].toUpperCase() : '';
}
