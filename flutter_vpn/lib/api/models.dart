/// Parsers for the Worker's JSON. One per shape; field names follow the
/// backend contract.
library;

import 'dart:convert';

import 'countries.dart';

int _int(Object? v) => v is num ? v.toInt() : int.tryParse('${v ?? ''}') ?? 0;
int? _intOrNull(Object? v) => v == null ? null : _int(v);
String _str(Object? v) => v == null ? '' : '$v';
DateTime? _date(Object? v) => v == null ? null : DateTime.tryParse('$v');

class Subscription {
  Subscription.fromJson(Map<String, dynamic> j)
    : active = j['active'] == true,
      status = _str(j['status']),
      stopReason = j['stop_reason'] as String?,
      planName = _str(j['plan_name']),
      expiresAt = _date(j['expires_at']),
      daysLeft = _intOrNull(j['days_left']),
      unlimitedTime = j['unlimited_time'] == true,
      unlimitedData = j['unlimited_data'] == true,
      dataLimitBytes = _int(j['data_limit_bytes']),
      usedBytes = _int(j['used_bytes']),
      usedPercent = _intOrNull(j['used_percent']),
      deviceLimit = _int(j['device_limit']),
      periodDays = _intOrNull(j['period_days']);

  final bool active;

  /// active | missing | limited | expired | disabled
  final String status;
  final String? stopReason;
  final String planName;
  final DateTime? expiresAt;
  final int? daysLeft;
  final bool unlimitedTime, unlimitedData;
  final int dataLimitBytes, usedBytes;
  final int? usedPercent;
  final int deviceLimit;

  /// Length of the running package in days, for the time ring.
  final int? periodDays;

  String get statusLine => switch (status) {
    'active' => 'Active',
    'limited' => 'Data used up',
    'expired' => 'Expired',
    'disabled' => 'Paused by support',
    'missing' => 'Not found on the servers',
    _ => status,
  };
}

class Me {
  Me.fromJson(Map<String, dynamic> j)
    : id = _int(j['id']),
      email = _str(j['email']),
      login = _str(j['login']).isNotEmpty ? _str(j['login']) : _str(j['email']),
      telegramName = j['telegram'] is Map
          ? _str((j['telegram'] as Map)['name'])
          : '',
      telegramUsername = j['telegram'] is Map
          ? _str((j['telegram'] as Map)['username'])
          : '',
      telegramId = j['telegram'] is Map
          ? _str((j['telegram'] as Map)['id'])
          : '',
      avatar = _str(j['avatar']),
      wallet = _int(j['wallet_balance']),
      referralCode = _str(j['referral_code']),
      trialAvailable = j['trial_available'] == true,
      subscription = j['subscription'] is Map
          ? Subscription.fromJson(
              (j['subscription'] as Map).cast<String, dynamic>(),
            )
          : null;

  final int id;

  /// Empty for accounts made with Telegram.
  final String email;

  /// What the person signs in with: the email, the Telegram @username, or
  /// the numeric Telegram id when they have no username.
  final String login;

  /// The name on their Telegram account, when they signed up with Telegram.
  final String telegramName;

  /// Without "@"; '' when the Telegram account has no username.
  final String telegramUsername;

  /// Numeric Telegram id; '' until Telegram is verified.
  final String telegramId;
  bool get telegramVerified => telegramId.isNotEmpty;

  /// The Pleat character picked as the profile picture; '' for none.
  final String avatar;

  /// Toman.
  final int wallet;
  final String referralCode;
  final bool trialAvailable;
  final Subscription? subscription;
}

/// One package from `GET /me/packages`: bought, a free trial, given by
/// support, or an account brought over from before.
class Package {
  Package.fromJson(Map<String, dynamic> j)
    : id = _int(j['id']),
      source = _str(j['source']),
      current = j['current'] == true,
      name = _str(j['name']),
      orderId = _intOrNull(j['order_id']),
      purchasedAt = _date(j['purchased_at']),
      activatedAt = _date(j['activated_at']),
      expiresAt = _date(j['expires_at']),
      endedAt = _date(j['ended_at']),
      endReason = j['end_reason'] as String?,
      days = _intOrNull(j['days']),
      dataLimitBytes = _int(j['data_limit_bytes']),
      usedBytes = _intOrNull(j['used_bytes']),
      amountToman = _intOrNull(j['amount_toman']),
      method = _str(j['method']);

  final int id;

  /// order | trial | gift | panel
  final String source;
  final bool current;
  final String name;
  final int? orderId;
  final DateTime? purchasedAt, activatedAt, expiresAt, endedAt;

  /// renewed | quota | expired | admin
  final String? endReason;
  final int? days;
  final int dataLimitBytes;
  final int? usedBytes, amountToman;
  final String method;

  String get sourceLabel => switch (source) {
    'order' => 'Bought',
    'trial' => 'Free trial',
    'gift' => 'Gift from support',
    _ => 'Existing account',
  };

  String get stateLabel {
    if (current) return 'Running';
    return switch (endReason) {
      'renewed' => 'Renewed',
      'quota' => 'Used up',
      'expired' => 'Expired',
      'admin' => 'Replaced',
      _ => 'Ended',
    };
  }
}

class PlanInfo {
  PlanInfo.fromJson(Map<String, dynamic> j)
    : id = _int(j['id']),
      name = _str(j['name']),
      durationDays = _int(j['duration_days']),
      dataLimitGb = _int(j['data_limit_gb']),
      deviceLimit = _int(j['device_limit']),
      priceToman = _int(j['price_toman']),
      oldPriceToman = _int(j['old_price_toman']),
      savePercent = _int(j['save_percent']),
      badge = _str(j['badge']),
      description = _str(j['description']),
      trialDays = _int(j['trial_days']);

  final int id;
  final String name, badge, description;
  final int durationDays, dataLimitGb, deviceLimit;
  final int priceToman, oldPriceToman, savePercent, trialDays;
}

/// One config from `/vpn/servers`. [link] stays in memory for the tunnel
/// and is never shown, logged or put in an accessibility label.
class Server {
  Server._(this.index, this.name, this.cc, this.protocol, this.link, this.key);

  factory Server.fromJson(Map<String, dynamic> j) {
    final link = _str(j['link']);
    final end = endpointOf(link);
    final name = _str(j['name']);
    var cc = _str(j['country_code']).toUpperCase();
    if (cc.isEmpty) cc = countryFromRemark(name);
    if (cc.isEmpty && end != null) cc = countryFromHost(end.host);
    return Server._(
      _int(j['index']),
      name,
      cc,
      _str(j['protocol']).toLowerCase(),
      link,
      end == null ? 'i${_int(j['index'])}' : serverKey(end),
    );
  }

  final int index;

  /// The Worker's label without its flag, e.g. "DE 2".
  final String name;

  /// ISO country code, '' when the remark names none.
  final String cc;
  final String protocol, link;

  /// Anonymous stable key, the same `k` the Cloud Gold app reports.
  final String key;

  String get country => cc.isEmpty ? 'Unknown country' : countryName(cc);
  String get flag => flagOf(cc);
  String get protocolLabel => switch (protocol) {
    'vless' => 'VLESS',
    'vmess' => 'VMess',
    'trojan' => 'Trojan',
    'ss' => 'Shadowsocks',
    'hy2' || 'hysteria2' => 'Hysteria2',
    'wireguard' => 'WireGuard',
    'tuic' => 'TUIC',
    _ => protocol.toUpperCase(),
  };
}

class Endpoint {
  const Endpoint(this.type, this.host, this.port);
  final String type, host, port;
}

/// Protocol, host and port of a share link, the way v2rayNG stores them.
Endpoint? endpointOf(String link) {
  final i = link.indexOf('://');
  if (i <= 0) return null;
  final scheme = link.substring(0, i).toLowerCase();
  final type = switch (scheme) {
    'ss' => 'shadowsocks',
    'hy2' => 'hysteria2',
    _ => scheme,
  };
  var rest = link.substring(i + 3);
  if (scheme == 'vmess') {
    try {
      var raw = rest.split('#').first;
      raw += '=' * ((4 - raw.length % 4) % 4);
      final j = jsonDecode(
        utf8.decode(
          base64.decode(raw.replaceAll('-', '+').replaceAll('_', '/')),
        ),
      );
      if (j is! Map) return null;
      return Endpoint(type, _str(j['add']), _str(j['port']));
    } on FormatException {
      return null;
    }
  }
  rest = rest.split('#').first.split('?').first.split('/').first;
  final at = rest.lastIndexOf('@');
  var hostPort = at >= 0 ? rest.substring(at + 1) : rest;
  if (at < 0 && scheme == 'ss') {
    // ss://base64(method:pass@host:port)
    try {
      var raw = rest;
      raw += '=' * ((4 - raw.length % 4) % 4);
      final dec = utf8.decode(base64.decode(raw));
      hostPort = dec.substring(dec.lastIndexOf('@') + 1);
    } on FormatException {
      return null;
    }
  }
  String host, port;
  if (hostPort.startsWith('[')) {
    final close = hostPort.indexOf(']');
    host = hostPort.substring(1, close);
    port = hostPort.substring(close + 1).replaceFirst(':', '');
  } else {
    final c = hostPort.lastIndexOf(':');
    host = c >= 0 ? hostPort.substring(0, c) : hostPort;
    port = c >= 0 ? hostPort.substring(c + 1) : '';
  }
  return Endpoint(type, host, port);
}

/// Keys the Worker accepts in `/net/report` (its KEY_RE).
final serverKeyPattern = RegExp(r'^[a-z0-9]{6,16}$');

/// FNV-1a of "type|host|port", identical to `CgVpn.serverKey`.
String serverKey(Endpoint e) {
  var h = 0x811c9dc5;
  for (final c in '${e.type}|${e.host}|${e.port}'.toLowerCase().codeUnits) {
    h ^= c;
    h = (h * 0x01000193) & 0xFFFFFFFF;
  }
  return 'k${h.toRadixString(16).padLeft(8, '0')}';
}

/// What other people on this network measured for one server.
class Rank {
  Rank.fromJson(Map<String, dynamic> j)
    : score = (j['score'] as num?)?.toDouble() ?? 0,
      ms = _int(j['ms']),
      reports = _int(j['n']),
      people = _int(j['users']),
      kbps = _int(j['kbps']);
  final double score;

  /// Median ping and average download speed people measured; 0 = none.
  final int ms, reports, kbps;

  /// Different people behind [reports]; labels need at least three.
  final int people;
}

/// The network the Worker saw this phone on: its id (ASN) and English
/// name, e.g. "Irancell", plus how the phone reaches it ([kind]: 'wifi',
/// 'cell' for mobile data, 'other', '' unknown). The operator comes from
/// the network address the Worker sees anyway and the kind from Android's
/// network type; Pleat reads nothing from the SIM.
class NetInfo {
  const NetInfo(this.id, this.name, {this.mobile = false, this.kind = ''});
  final String id, name, kind;
  final bool mobile;

  /// Results are kept apart per operator AND connection type: Irancell
  /// over a Wi-Fi modem is not Irancell mobile data.
  String get key => kind.isEmpty ? id : '$id-$kind';

  /// "Irancell Wi-Fi", "MCI mobile data", "Shatel".
  String get label => switch (kind) {
    'wifi' => '$name Wi-Fi',
    'cell' => '$name mobile data',
    _ => name,
  };

  static NetInfo? from(dynamic data) {
    if (data is! Map) return null;
    final asn = _int(data['asn']);
    if (asn <= 0) return null;
    final name = _str(data['isp_en']).trim();
    final kind = _str(data['kind']);
    return NetInfo(
      '$asn',
      name.isEmpty ? 'your network' : name,
      mobile: data['mobile'] == true,
      kind: const {'wifi', 'cell', 'other'}.contains(kind) ? kind : '',
    );
  }
}

Map<String, Rank> ranksFrom(dynamic data) {
  final s = data is Map ? data['servers'] : null;
  if (s is! Map) return const {};
  return {
    for (final e in s.entries)
      if (e.value is Map)
        '${e.key}': Rank.fromJson((e.value as Map).cast<String, dynamic>()),
  };
}

class Device {
  Device.fromJson(Map<String, dynamic> j, String thisDevice)
    : id = _int(j['id']),
      model = _str(j['model']),
      lastSeen = _date(j['last_seen']),
      current = _str(j['device_id']) == thisDevice;
  final int id;
  final String model;
  final DateTime? lastSeen;
  final bool current;
}

class AppConfig {
  AppConfig.fromJson(Map<String, dynamic> j)
    : supportUrl = _str(j['support_url']),
      announcement = _str(j['announcement']),
      cardEnabled = j['card_enabled'] == true,
      cardAuto = j['card_auto'] == true,
      cryptoEnabled = j['crypto_enabled'] == true,
      coins = [
        for (final c in (j['coins'] as List?) ?? const [])
          if (c is Map) CoinOption.fromJson(c.cast<String, dynamic>()),
      ],
      minTopup = _int(j['min_topup_toman']),
      referralPercent = _int(j['referral_percent']);
  const AppConfig.empty()
    : supportUrl = '',
      announcement = '',
      cardEnabled = false,
      cardAuto = false,
      cryptoEnabled = false,
      coins = const [],
      minTopup = 0,
      referralPercent = 0;
  final String supportUrl, announcement;
  final bool cardEnabled, cardAuto, cryptoEnabled;
  final List<CoinOption> coins;
  final int minTopup, referralPercent;

  /// Ways to pay beyond the wallet, as the admin has them switched on.
  bool get canPayOnline => cardEnabled || cryptoEnabled || coins.isNotEmpty;
}

/// A coin the store takes directly. Only the English fields are kept.
class CoinOption {
  CoinOption.fromJson(Map<String, dynamic> j)
    : id = _str(j['id']),
      symbol = _str(j['symbol']),
      name = _str(j['name']),
      network = _str(j['network']),
      color = _str(j['color']),
      auto = j['auto'] == true;
  final String id, symbol, name, network, color;

  /// Confirmed on chain by the Worker, without a hash from the payer.
  final bool auto;
}

/// `/coupons/check`.
class Coupon {
  Coupon.fromJson(Map<String, dynamic> j)
    : code = _str(j['code']),
      percent = _int(j['percent']),
      finalToman = _int(j['final_toman']);
  final String code;
  final int percent, finalToman;
}

/// Where to send a card-to-card transfer.
class CardPay {
  CardPay.fromJson(Map<String, dynamic> j)
    : number = _str(j['number']).replaceAll(RegExp(r'\D'), ''),
      holder = _str(j['holder']),
      color1 = _str(j['color1']),
      color2 = _str(j['color2']),
      amountRial = _int(j['amount_rial']),
      auto = j['auto'] == true;
  final String number;

  /// The account holder exactly as the admin saved it; the payer checks it
  /// against what their bank shows.
  final String holder;
  final String color1, color2;
  final int amountRial;

  /// A trusted bank SMS confirms the transfer, so the receipt is optional.
  final bool auto;

  /// Bank by the card's first six digits, in English.
  String get bank => bankOfCard(number);
}

/// A direct coin payment: exact amount, address, memo and the lock time.
class CoinPay {
  CoinPay.fromJson(Map<String, dynamic> j)
    : symbol = _str(j['symbol']),
      name = _str(j['name']),
      network = _str(j['network']),
      color = _str(j['color']),
      amount = _str(j['amount']),
      address = _str(j['address']),
      memo = j['memo'] == null ? null : _str(j['memo']),
      memoLabel = _str(j['memo_label']),
      secondsLeft = _int(j['seconds_left']),
      auto = j['auto'] == true;
  final String symbol, name, network, color, amount, address, memoLabel;
  final String? memo;
  final int secondsLeft;
  final bool auto;
}

class Order {
  Order.fromJson(Map<String, dynamic> j)
    : id = _int(j['id']),
      kind = _str(j['kind']),
      planName = _str(j['plan_name']),
      activatePlanId = _intOrNull(j['activate_plan_id']),
      activatePlanName = _str(j['activate_plan_name']),
      planActivated = j['plan_activated'] as bool?,
      amountToman = _int(j['amount_toman']),
      method = _str(j['method']),
      status = _str(j['status']),
      createdAt = _date(j['created_at']),
      cryptoPayUrl = _str(j['crypto_pay_url']),
      adminNote = _str(j['admin_note']),
      txid = _str(j['txid']),
      card = j['card'] is Map
          ? CardPay.fromJson((j['card'] as Map).cast<String, dynamic>())
          : null,
      coin = j['coin'] is Map
          ? CoinPay.fromJson((j['coin'] as Map).cast<String, dynamic>())
          : null;

  final int id;

  /// plan | topup
  final String kind;
  final String planName, activatePlanName, method, cryptoPayUrl;

  /// pending | review | paid | rejected | cancelled | expired
  final String status;
  final int? activatePlanId;
  final bool? planActivated;
  final int amountToman;
  final DateTime? createdAt;

  /// The admin's reason for a rejected receipt; often written in Persian,
  /// so screens show it only when it is English.
  final String adminNote;
  final String txid;
  final CardPay? card;
  final CoinPay? coin;

  bool get open =>
      status == 'pending' || status == 'review' || status == 'rejected';

  String get title => kind == 'plan'
      ? (planName.isEmpty ? 'Plan' : planName)
      : (activatePlanId != null
            ? 'Top up and buy ${activatePlanName.isEmpty ? 'a plan' : activatePlanName}'
            : 'Wallet top-up');

  String get methodLabel => switch (method) {
    'card' => 'Card to card',
    'wallet' => 'Wallet',
    'crypto' => 'Crypto gateway',
    'coin' => coin?.symbol.isNotEmpty == true ? coin!.symbol : 'Crypto',
    _ => method,
  };

  String get statusLabel => switch (status) {
    'pending' => 'Waiting for payment',
    'review' => 'Being checked',
    'paid' => 'Paid',
    'rejected' => 'Not accepted',
    'cancelled' => 'Cancelled',
    'expired' => 'Expired',
    _ => status,
  };
}

class WalletTx {
  WalletTx.fromJson(Map<String, dynamic> j)
    : amount = _int(j['amount']),
      reason = _str(j['reason']),
      createdAt = _date(j['created_at']);
  final int amount;
  final String reason;
  final DateTime? createdAt;

  String get label => switch (reason) {
    'topup' => 'Top-up',
    'purchase' => 'Plan purchase',
    'referral' => 'Invite reward',
    'refund' => 'Refund',
    'admin' => 'Correction by support',
    _ => 'Wallet change',
  };
}

class WalletInfo {
  WalletInfo.fromJson(Map<String, dynamic> j)
    : balance = _int(j['balance']),
      transactions = [
        for (final t in (j['transactions'] as List?) ?? const [])
          if (t is Map) WalletTx.fromJson(t.cast<String, dynamic>()),
      ];
  final int balance;
  final List<WalletTx> transactions;
}

class Referral {
  Referral.fromJson(Map<String, dynamic> j)
    : code = _str(j['code']),
      percent = _int(j['percent']),
      invited = _int(j['invited']),
      earned = _int(j['earned_toman']);
  final String code;
  final int percent, invited, earned;
}

/// True when [s] has Persian or Arabic letters; such server text is not
/// shown in the English-only app.
bool isPersian(String s) => RegExp(r'[\u0600-\u06FF]').hasMatch(s);

/// Iranian banks by card BIN, in English (the Worker's banks.js list).
String bankOfCard(String digits) {
  for (final e in _banks.entries) {
    for (final bin in e.value) {
      if (digits.startsWith(bin)) return e.key;
    }
  }
  return '';
}

const _banks = {
  'Bank Melli': ['603799'],
  'Bank Sepah': ['589210', '639370', '627381', '639599', '636949'],
  'Bank Mellat': ['610433', '991975'],
  'Bank Saderat': ['603769'],
  'Tejarat Bank': ['627353', '585983'],
  'Keshavarzi Bank': ['603770', '639217'],
  'Bank Maskan': ['628023'],
  'Post Bank': ['627760'],
  'Export Development Bank': ['627648', '207177'],
  'Bank of Industry and Mine': ['627961'],
  'Tose\'e Ta\'avon Bank': ['502908'],
  'EN Bank': ['627412'],
  'Parsian Bank': ['622106', '639194', '627884'],
  'Pasargad Bank': ['502229', '639347'],
  'Karafarin Bank': ['627488', '502910'],
  'Saman Bank': ['621986'],
  'Sina Bank': ['639346'],
  'Sarmayeh Bank': ['639607'],
  'Ayandeh Bank': ['636214'],
  'Shahr Bank': ['502806', '504706'],
  'Day Bank': ['502938'],
  'Refah Bank': ['589463'],
  'Iran Zamin Bank': ['505785'],
  'Middle East Bank': ['585947'],
  'Gardeshgari Bank': ['505416'],
  'Mehr Iran Bank': ['606373'],
  'Central Bank': ['636795'],
  'Kosar Credit': ['505801'],
  'Noor Credit': ['507677'],
  'Melal Credit': ['606256'],
  'Resalat Bank': ['504172'],
  'Tose\'e Credit': ['628157'],
};

/// The address the internet sees while connected: the exit's public IP
/// and where it is, as the Worker sees the request coming through the
/// tunnel.
class ExitAddress {
  const ExitAddress(this.ip, {this.cc = '', this.country = '', this.city = ''});
  final String ip, cc, country, city;

  static ExitAddress? from(dynamic data) {
    if (data is! Map) return null;
    final ip = _str(data['ip']).trim();
    if (ip.isEmpty) return null;
    final cc = _str(data['cc']).toUpperCase();
    return ExitAddress(
      ip,
      cc: cc,
      country: cc.isEmpty ? '' : countryName(cc),
      city: _str(data['city']).trim(),
    );
  }

  /// "Frankfurt, Germany", or just the country.
  String get place =>
      [if (city.isNotEmpty) city, if (country.isNotEmpty) country].join(', ');
}
