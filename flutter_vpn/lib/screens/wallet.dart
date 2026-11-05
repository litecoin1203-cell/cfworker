import 'package:flutter/material.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'checkout.dart';
import 'states.dart';
import 'store_kit.dart';

/// Wallet: balance, top-up and transactions from `/wallet`.
class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key});

  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  final _amount = TextEditingController();
  WalletInfo? _w;
  String? _error;
  int? _preset;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final w = await AppScope.read(context).wallet();
      if (mounted) setState(() => _w = w);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  int get _value =>
      int.tryParse(_amount.text.replaceAll(RegExp(r'\D'), '')) ?? 0;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final min = app.config.minTopup > 0 ? app.config.minTopup : 50000;
    final presets = [100000, 200000, 500000].map((v) => v < min ? min : v);
    final balance = _w?.balance ?? app.me.value?.wallet ?? 0;
    return StorePage(
      title: 'Wallet',
      subtitle: 'Buy plans at once from here. Invite rewards land here too.',
      children: [
        OfferCard(
          title: 'Balance',
          big: grouped(balance),
          unit: 'toman',
          footer: app.config.referralPercent > 0
              ? 'Invite friends to earn ${app.config.referralPercent}% of what they buy'
              : 'Top up with card or crypto',
        ),
        const SizedBox(height: 22),
        SectionLabel('Top up'),
        const SizedBox(height: 12),
        if (!app.config.canPayOnline)
          SurfaceCard(
            child: Text(
              'No way to top up is switched on right now. Contact support.',
              style: PType.small(color: PColors.ink),
            ),
          )
        else ...[
          Row(
            children: [
              for (final v in presets)
                Expanded(
                  child: Padding(
                    padding: EdgeInsets.only(right: v == presets.last ? 0 : 8),
                    child: Pressable(
                      onTap: () => setState(() {
                        _preset = v;
                        _amount.text = grouped(v);
                      }),
                      label: toman(v),
                      radius: 22,
                      color: _preset == v ? PColors.blue : PColors.surface,
                      child: SizedBox(
                        height: 52,
                        child: Center(
                          child: Text(
                            grouped(v),
                            style: PType.h3(
                              color: _preset == v
                                  ? PColors.onAccent
                                  : PColors.ink,
                            ).copyWith(fontSize: 15),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 12),
          PField(
            controller: _amount,
            hint: 'Or an amount in toman',
            keyboard: TextInputType.number,
            onChanged: (s) {
              final d = int.tryParse(s.replaceAll(RegExp(r'\D'), ''));
              final t = d == null ? '' : grouped(d);
              if (t != s) {
                _amount.value = TextEditingValue(
                  text: t,
                  selection: TextSelection.collapsed(offset: t.length),
                );
              }
              setState(() => _preset = null);
            },
          ),
          const SizedBox(height: 12),
          PillButton(
            label: 'Top up',
            onTap: () {
              final v = _value;
              if (v <= 0) return showNote(context, 'Choose or type an amount.');
              if (v < min) {
                return showNote(
                  context,
                  'The smallest top-up is ${toman(min)}.',
                );
              }
              openCheckout(context, topup: v).then((_) => _load());
            },
          ),
        ],
        const SizedBox(height: 24),
        SectionLabel(
          'Transactions',
          trailing: 'PAYMENTS',
          onTrailing: () =>
              Navigator.of(context)
                  .push(FadeRoute(builder: (_) => const OrdersScreen())),
        ),
        const SizedBox(height: 10),
        SurfaceCard(
          padding: const EdgeInsets.fromLTRB(20, 6, 20, 6),
          child: Column(
            children: [
              if (_w == null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: Text(_error ?? 'Loading…', style: PType.small()),
                )
              else if (_w!.transactions.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: Text('No transactions yet.', style: PType.small()),
                ),
              for (final t in _w?.transactions ?? const <WalletTx>[])
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              t.label,
                              style: PType.h3().copyWith(fontSize: 15),
                            ),
                            Text(shortDate(t.createdAt), style: PType.small()),
                          ],
                        ),
                      ),
                      Text(
                        '${t.amount >= 0 ? '+' : '−'}${grouped(t.amount.abs())}',
                        style: PType.h3(
                          color: t.amount >= 0 ? PColors.safe : PColors.ink,
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Every order from `/orders`; an open one reopens its payment page.
class OrdersScreen extends StatefulWidget {
  const OrdersScreen({super.key});

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
  List<Order>? _list;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final l = await AppScope.read(context).orders();
      if (mounted) setState(() => _list = l);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final list = _list;
    return StorePage(
      title: 'Payments',
      subtitle: 'Your last 50 orders.',
      children: [
        if (list == null || list.isEmpty)
          SurfaceCard(
            child: Text(
              list == null
                  ? (_error ?? 'Loading…')
                  : 'No payments yet. Your first plan’s receipt stays here.',
              style: PType.small(color: PColors.ink),
            ),
          ),
        for (final o in list ?? const <Order>[])
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: SurfaceCard(
              onTap: o.open || (o.method == 'coin' && o.status == 'expired')
                  ? () => showOrder(context, o)
                  : null,
              label: '${o.title}, ${o.statusLabel}',
              child: Row(
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      color: o.status == 'paid' ? PColors.safe : PColors.mist,
                      shape: BoxShape.circle,
                    ),
                    alignment: Alignment.center,
                    child: PIconView(
                      o.status == 'paid' ? PIcon.check : PIcon.ticket,
                      size: 20,
                      color: o.status == 'paid'
                          ? PColors.onAccent
                          : PColors.accentInk,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          o.title,
                          style: PType.h3().copyWith(fontSize: 15),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        Text(
                          '#${o.id}  ·  ${o.methodLabel}  ·  ${shortDate(o.createdAt)}',
                          style: PType.small(),
                        ),
                      ],
                    ),
                  ),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(grouped(o.amountToman), style: PType.h3()),
                      Text(
                        o.statusLabel,
                        style: PType.small(
                          color: switch (o.status) {
                            'paid' => PColors.safe,
                            'rejected' => PColors.alert,
                            'review' || 'pending' => PColors.blue,
                            _ => PColors.muted,
                          },
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// Invite friends: the code, what it earns, and a share sheet.
class InviteScreen extends StatefulWidget {
  const InviteScreen({super.key});

  @override
  State<InviteScreen> createState() => _InviteScreenState();
}

class _InviteScreenState extends State<InviteScreen> {
  Referral? _r;
  String? _error;

  @override
  void initState() {
    super.initState();
    AppScope.read(context).referral().then(
      (r) => mounted ? setState(() => _r = r) : null,
      onError: (Object e) => mounted
          ? setState(() => _error = e is ApiError ? e.message : '$e')
          : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final r = _r;
    final code = r?.code ?? app.me.value?.referralCode ?? '';
    return StorePage(
      title: 'Invite friends',
      subtitle: r != null && r.percent > 0
          ? '${r.percent}% of everything your friends buy goes to your wallet.'
          : 'Friends sign up with your code.',
      children: [
        OfferCard(
          title: 'Your code',
          big: code.isEmpty ? '…' : code,
          unit: '',
          footer: r == null
              ? (_error ?? 'Loading…')
              : '${r.invited} friend${r.invited == 1 ? '' : 's'} joined  ·  ${toman(r.earned)} earned',
        ),
        const SizedBox(height: 18),
        PillButton(
          label: 'Send invite',
          icon: PIcon.mail,
          onTap: code.isEmpty
              ? null
              : () => app.tunnel.share(
                  'Join me on Pleat VPN. Sign up with my invite code $code.',
                ),
        ),
        const SizedBox(height: 10),
        PillButton(
          label: 'Copy code',
          icon: PIcon.copy,
          color: PColors.surface,
          textColor: PColors.ink,
          onTap: code.isEmpty
              ? null
              : () => copyText(context, code, 'Invite code copied.'),
        ),
      ],
    );
  }
}
