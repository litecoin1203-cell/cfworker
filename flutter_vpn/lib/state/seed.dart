/// Seeded, fictional demo data. Nothing here is a real service, brand or
/// price; the app never opens a tunnel or takes a payment.
library;

enum Category { all, nearby, streaming, gaming, fastest, recent }

/// Painted scene mood for a city's generated "photo".
enum SceneTone { dawn, day, dusk, night }

class Exit {
  const Exit({
    required this.id,
    required this.city,
    required this.country,
    required this.code,
    required this.ping,
    required this.load,
    required this.lon,
    required this.tags,
    required this.tone,
    required this.seed,
    required this.blurb,
  });

  final String id, city, country, code, blurb;
  final int ping, load, seed;

  /// Longitude, used to lean the shard field toward the region.
  final double lon;
  final Set<Category> tags;
  final SceneTone tone;

  /// -1 (far west) … 1 (far east), relative to the phone's home exit.
  double get bearing => ((lon - 10) / 120).clamp(-1.0, 1.0);
}

const exits = <Exit>[
  Exit(
    id: 'fra',
    city: 'Frankfurt',
    country: 'Germany',
    code: 'DE',
    ping: 28,
    load: 34,
    lon: 8.7,
    tags: {Category.nearby, Category.gaming, Category.fastest},
    tone: SceneTone.dusk,
    seed: 11,
    blurb: 'Closest exit to you. River-side data hall, low jitter all evening.',
  ),
  Exit(
    id: 'ams',
    city: 'Amsterdam',
    country: 'Netherlands',
    code: 'NL',
    ping: 31,
    load: 52,
    lon: 4.9,
    tags: {Category.nearby, Category.streaming, Category.fastest},
    tone: SceneTone.day,
    seed: 23,
    blurb: 'Canal-side exit with wide peering. Good default for video.',
  ),
  Exit(
    id: 'zrh',
    city: 'Zurich',
    country: 'Switzerland',
    code: 'CH',
    ping: 34,
    load: 21,
    lon: 8.5,
    tags: {Category.nearby},
    tone: SceneTone.dawn,
    seed: 37,
    blurb: 'Quiet mountain-side exit. Lowest load on the network today.',
  ),
  Exit(
    id: 'sto',
    city: 'Stockholm',
    country: 'Sweden',
    code: 'SE',
    ping: 46,
    load: 40,
    lon: 18.1,
    tags: {Category.nearby, Category.gaming},
    tone: SceneTone.night,
    seed: 41,
    blurb: 'Cold-aisle exit on the archipelago. Steady at peak hours.',
  ),
  Exit(
    id: 'lon',
    city: 'London',
    country: 'United Kingdom',
    code: 'GB',
    ping: 38,
    load: 67,
    lon: -0.1,
    tags: {Category.streaming},
    tone: SceneTone.dusk,
    seed: 53,
    blurb: 'Busy exit by the river. Built for streaming throughput.',
  ),
  Exit(
    id: 'nyc',
    city: 'New York',
    country: 'United States',
    code: 'US',
    ping: 92,
    load: 58,
    lon: -74,
    tags: {Category.streaming},
    tone: SceneTone.night,
    seed: 67,
    blurb: 'East-coast exit with a short hop across the Atlantic.',
  ),
  Exit(
    id: 'tor',
    city: 'Toronto',
    country: 'Canada',
    code: 'CA',
    ping: 104,
    load: 29,
    lon: -79.4,
    tags: {Category.streaming},
    tone: SceneTone.day,
    seed: 71,
    blurb: 'Lake-shore exit. Spare capacity most of the day.',
  ),
  Exit(
    id: 'tyo',
    city: 'Tokyo',
    country: 'Japan',
    code: 'JP',
    ping: 212,
    load: 46,
    lon: 139.7,
    tags: {Category.gaming},
    tone: SceneTone.night,
    seed: 83,
    blurb: 'Far-east exit tuned for game traffic and small packets.',
  ),
  Exit(
    id: 'sin',
    city: 'Singapore',
    country: 'Singapore',
    code: 'SG',
    ping: 168,
    load: 38,
    lon: 103.8,
    tags: {Category.gaming},
    tone: SceneTone.dawn,
    seed: 97,
    blurb: 'Harbour exit that bridges Asia and Oceania.',
  ),
  Exit(
    id: 'sel',
    city: 'Seoul',
    country: 'South Korea',
    code: 'KR',
    ping: 224,
    load: 33,
    lon: 127,
    tags: {Category.gaming},
    tone: SceneTone.dusk,
    seed: 101,
    blurb: 'Dense-city exit, very stable for long sessions.',
  ),
];

Exit exitById(String id) =>
    exits.firstWhere((e) => e.id == id, orElse: () => exits.first);

class Plan {
  const Plan({
    required this.id,
    required this.name,
    required this.big,
    required this.unit,
    required this.price,
    required this.line,
    required this.devices,
  });

  final String id, name, big, unit, price, line;
  final int devices;
}

/// Three fictional demo plans. Starting a trial only sets local state.
const plans = <Plan>[
  Plan(
    id: 'solo',
    name: 'Solo',
    big: '7',
    unit: 'days free',
    price: 'then 3.90 / month',
    line: 'One phone, every exit, kill switch included.',
    devices: 1,
  ),
  Plan(
    id: 'pair',
    name: 'Pair',
    big: '14',
    unit: 'days free',
    price: 'then 5.90 / month',
    line: 'Two devices on one tunnel identity.',
    devices: 2,
  ),
  Plan(
    id: 'home',
    name: 'Household',
    big: '30',
    unit: 'days free',
    price: 'then 8.90 / month',
    line: 'Six devices, private DNS for the whole home.',
    devices: 6,
  ),
];

class DemoApp {
  const DemoApp(this.id, this.name);
  final String id, name;
}

const demoApps = <DemoApp>[
  DemoApp('bank', 'Bank'),
  DemoApp('maps', 'Maps'),
  DemoApp('mail', 'Mail'),
  DemoApp('browser', 'Browser'),
  DemoApp('music', 'Music'),
  DemoApp('games', 'Games'),
];

class Resolver {
  const Resolver(this.id, this.name, this.note);
  final String id, name, note;
}

const resolvers = <Resolver>[
  Resolver('pleat', 'Pleat resolver', 'Inside the tunnel, no logs'),
  Resolver('block', 'Pleat + blocklist', 'Drops trackers at lookup'),
  Resolver('custom', 'Custom', '9.9.9.9 demo address'),
];

const protocols = ['WireGuard', 'IKEv2', 'OpenVPN'];

class Notice {
  const Notice(this.title, this.body, this.when);
  final String title, body, when;
}

const notices = <Notice>[
  Notice(
    'Kill switch held 3 requests',
    'Traffic paused while Wi-Fi changed networks.',
    '2h',
  ),
  Notice(
    'Zurich has spare capacity',
    'Load dropped to 21%. Good time to switch.',
    '5h',
  ),
  Notice('Trial reminder', 'Your demo trial keeps every exit open.', '1d'),
];
