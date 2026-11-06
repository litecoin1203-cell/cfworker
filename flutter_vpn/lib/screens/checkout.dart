// Colour defaults come from the live palette, so they are nullable
// parameters stored in private fields; this lint cannot apply to those.
// ignore_for_file: prefer_initializing_formals

import 'package:flutter/material.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'pay_card.dart';
import 'pay_coin.dart';
import 'order_status.dart';
import 'states.dart';
import 'store_kit.dart';

/// Opens checkout for a plan or a wallet top-up.
Future<void> openCheckout(BuildContext context, {PlanInfo? plan, int? topup}) =>
    Navigator.of(context).push(
      FadeRoute(
        builder: (_) => CheckoutScreen(plan: plan, topup: topup),
      ),
    );

/// After an order is placed: the page that finishes it.
void showOrder(BuildContext context, Order o, {bool replace = false}) {
  final Widget page = switch ((o.status, o.method)) {
    ('paid', _) => PaidScreen(order: o),
    ('pending', 'card') => CardPayScreen(order: o),
    (_, 'coin') => CoinPayScreen(order: o),
    _ => OrderStatusScreen(id: o.id),
  };
  final nav = Navigator.of(context);
  final route = FadeRoute(builder: (_) => page);
  replace ? nav.pushReplacement(route) : nav.push(route);
}

/// Checkout: the price (with a discount code for plans), the ways to pay
/// the admin has switched on, and Pay. Same choices as the Cloud Gold app:
/// wallet, wallet plus the rest, card to card, a coin, or the gateway.
class CheckoutScreen extends StatefulWidget {
  const CheckoutScreen({super.key, this.plan, this.topup})
    : assert(plan != null || topup != null);
  final PlanInfo? plan;
  final int? topup;

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends State<CheckoutScreen> {
  final _code = TextEditingController();
  Coupon? _coupon;
  String? _codeNote;
  bool _checking = false, _paying = false;
  String? _pick;

  /// With "wallet + rest": how the rest is paid.
  String? _restVia;
  String? _coin;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  int get _price => widget.plan == null
      ? widget.topup!
      : (_coupon?.finalToman ?? widget.plan!.priceToman);

  List<(String, PIcon, String, String, bool)> _methods(AppState app) {
    final cfg = app.config;
    final bal = app.me.value?.wallet ?? 0;
    final price = _price;
    final out = <(String, PIcon, String, String, bool)>[];
    if (widget.plan != null) {
      if (bal >= price) {
        out.add((
          'wallet',
          PIcon.ticket,
          'Wallet',
          'Balance ${toman(bal)}',
          true,
        ));
      } else if (bal > 0 && cfg.canPayOnline) {
        out.add((
          'mix',
          PIcon.ticket,
          'Wallet and pay the rest',
          '${toman(bal)} from the wallet, ${toman(price - bal)} to pay',
          true,
        ));
      } else {
        out.add((
          'wallet',
          PIcon.ticket,
          'Wallet',
          'Balance ${toman(bal)}, not enough',
          false,
        ));
      }
    }
    if (cfg.cardEnabled) {
      out.add((
        'card',
        PIcon.copy,
        'Card to card',
        cfg.cardAuto
            ? 'Transfer; confirmed by the bank in about a minute'
            : 'Transfer, then send a photo of the receipt',
        true,
      ));
    }
    if (cfg.coins.isNotEmpty) {
      final names = cfg.coins.take(3).map((c) => c.symbol).join(', ');
      out.add((
        'coin',
        PIcon.globe,
        'Cryptocurrency',
        '$names${cfg.coins.length > 3 ? ' and more' : ''}',
        true,
      ));
    }
    if (cfg.cryptoEnabled) {
      out.add((
        'crypto',
        PIcon.globe,
        'Crypto gateway',
        'Pay on the gateway page; activates by itself',
        true,
      ));
    }
    return out;
  }

  Future<void> _apply(AppState app) async {
    final code = _code.text.trim();
    if (code.isEmpty) {
      setState(() {
        _coupon = null;
        _codeNote = null;
      });
      return;
    }
    setState(() => _checking = true);
    try {
      final c = await app.checkCoupon(widget.plan!, code);
      setState(() {
        _coupon = c;
        _codeNote = '${c.percent}% off applied.';
      });
    } on ApiError catch (e) {
      setState(() {
        _coupon = null;
        _codeNote = e.message;
      });
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _pay(AppState app) async {
    final pick = _pick;
    if (pick == null) return;
    final method = pick == 'mix' ? _restVia! : pick;
    setState(() => _paying = true);
    try {
      final o = await app.placeOrder(
        plan: widget.plan,
        topup: widget.topup,
        method: method,
        useWallet: pick == 'mix' || pick == 'wallet',
        coupon: _coupon?.code,
        coin: method == 'coin' ? _coin : null,
      );
      if (!mounted) return;
      if (o.method == 'crypto' &&
          o.status == 'pending' &&
          o.cryptoPayUrl.isNotEmpty) {
        await app.tunnel.openUrl(o.cryptoPayUrl);
        if (!mounted) return;
      }
      showOrder(context, o, replace: true);
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() => _paying = false);
      showNote(context, e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final plan = widget.plan;
    final methods = _methods(app);
    final usable = methods.where((m) => m.$5).toList();
    if (_pick == null || !usable.any((m) => m.$1 == _pick)) {
      _pick = usable.isEmpty ? null : usable.first.$1;
    }
    final online = methods
        .where((m) => const ['card', 'coin', 'crypto'].contains(m.$1))
        .toList();
    _restVia ??= online.isEmpty ? null : online.first.$1;
    final coins = app.config.coins;
    _coin ??= coins.isEmpty ? null : coins.first.id;
    final showCoins = _pick == 'coin' || (_pick == 'mix' && _restVia == 'coin');
    final bal = app.me.value?.wallet ?? 0;
    final due = _pick == 'mix'
        ? _price - bal
        : (_pick == 'wallet' || _price == 0 ? 0 : _price);

    return StorePage(
      title: plan == null ? 'Top up wallet' : 'Checkout',
      subtitle: plan == null
          ? 'The amount is added to your wallet once it is paid.'
          : 'Your plan starts as soon as the payment is confirmed.',
      children: [
        OfferCard(
          title: plan?.name ?? 'Wallet',
          big: plan == null ? grouped(_price) : planBig(plan),
          unit: plan == null
              ? 'toman'
              : planUnit(plan, days: plan.durationDays),
          footer: [
            if (_coupon != null && plan != null)
              'was ${toman(plan.priceToman)}',
            toman(_price),
            if (plan != null)
              '${plan.deviceLimit} device${plan.deviceLimit == 1 ? '' : 's'}',
          ].join('  ·  '),
        ),
        const SizedBox(height: 18),
        if (plan != null) ...[
          PField(
            controller: _code,
            hint: 'Discount code (optional)',
            trailing: PillButton(
              label: _checking ? '…' : 'Apply',
              expand: false,
              height: 44,
              onTap: _checking ? null : () => _apply(app),
            ),
          ),
          if (_codeNote != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 8, 18, 0),
              child: Text(
                _codeNote!,
                style: PType.small(
                  color: _coupon != null ? PColors.safe : PColors.ink,
                ),
              ),
            ),
          const SizedBox(height: 18),
        ],
        SectionLabel('Pay with'),
        const SizedBox(height: 10),
        if (methods.isEmpty || usable.isEmpty)
          SurfaceCard(
            child: Text(
              'No way to pay is switched on right now. Contact support.',
              style: PType.small(color: PColors.ink),
            ),
          ),
        for (final m in methods)
          MethodTile(
            icon: m.$2,
            title: m.$3,
            body: m.$4,
            selected: _pick == m.$1,
            onTap: m.$5 ? () => setState(() => _pick = m.$1) : null,
          ),
        if (_pick == 'mix' && online.length > 1) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 4, 6, 10),
            child: Text('Pay the rest with', style: PType.meta()),
          ),
          Wrap(
            spacing: 8,
            children: [
              for (final o in online)
                _Chip(
                  label: o.$3,
                  on: _restVia == o.$1,
                  onTap: () => setState(() => _restVia = o.$1),
                ),
            ],
          ),
          const SizedBox(height: 10),
        ],
        if (showCoins) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 4, 6, 10),
            child: Text('Coin', style: PType.meta()),
          ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final c in coins)
                _Chip(
                  label: c.auto ? '${c.symbol}  ·  auto' : c.symbol,
                  on: _coin == c.id,
                  color: hexColor(c.color, PColors.blue),
                  onTap: () => setState(() => _coin = c.id),
                ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(6, 10, 6, 0),
            child: Text(
              coins.any((c) => c.auto)
                  ? 'All have low network fees. "auto" coins activate about a minute after you pay.'
                  : 'All have low network fees.',
              style: PType.small(),
            ),
          ),
          const SizedBox(height: 10),
        ],
        const SizedBox(height: 12),
        PillButton(
          label: _paying
              ? 'Working…'
              : _pick == null
              ? 'Choose a way to pay'
              : due == 0
              ? (_price == 0
                    ? 'Activate for free'
                    : 'Pay ${toman(_price)} from wallet')
              : 'Pay ${toman(due)}',
          onTap: _paying || _pick == null ? null : () => _pay(app),
        ),
      ],
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({
    required this.label,
    required this.on,
    required this.onTap,
    Color? color,
  }) : _color = color;
  final String label;
  final bool on;
  final VoidCallback onTap;
  final Color? _color;
  Color get color => _color ?? PColors.blue;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      label: label,
      radius: PRadius.pill,
      color: on ? color : PColors.surface,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
        child: Text(
          label,
          style: PType.small(color: on ? PColors.onAccent : PColors.ink)
              .copyWith(fontWeight: FontWeight.w700),
        ),
      ),
    );
  }
}
