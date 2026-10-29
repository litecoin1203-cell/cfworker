import 'dart:async';

import 'package:flutter/material.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'checkout.dart';
import 'pay_card.dart';
import 'states.dart';
import 'store_kit.dart';
import 'wallet.dart';

/// Where an order stands (gateway waiting, receipt being checked, not
/// accepted, closed), checked every few seconds until it is paid.
class OrderStatusScreen extends StatefulWidget {
  const OrderStatusScreen({super.key, required this.id});
  final int id;

  @override
  State<OrderStatusScreen> createState() => _OrderStatusScreenState();
}

class _OrderStatusScreenState extends State<OrderStatusScreen>
    with WidgetsBindingObserver {
  Order? _o;
  String? _error;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _check();
    _poll = Timer.periodic(const Duration(seconds: 4), (_) => _check());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) _check();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _check() async {
    try {
      final app = AppScope.read(context);
      final o = await app.order(widget.id);
      if (!mounted) return;
      if (o.status == 'paid') {
        _poll?.cancel();
        await app.afterPaid(o);
        if (mounted) showOrder(context, o, replace: true);
        return;
      }
      if (!o.open) _poll?.cancel();
      setState(() {
        _o = o;
        _error = null;
      });
    } on ApiError catch (e) {
      if (mounted && _o == null) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final o = _o;
    if (o == null) {
      return StorePage(
        title: 'Order #${widget.id}',
        children: [
          SurfaceCard(
            child: Text(
              _error ?? 'Loading the order…',
              style: PType.small(color: PColors.ink),
            ),
          ),
        ],
      );
    }
    final (title, body, actions) = switch ((o.status, o.method)) {
      ('pending', 'crypto') => (
        'Waiting for payment',
        'Finish on the gateway page. When the network confirms it, usually within minutes, this page moves on by itself.',
        [
          PillButton(
            label: 'Open payment page',
            onTap: () => app.tunnel.openUrl(o.cryptoPayUrl),
          ),
          _cancel(o),
        ],
      ),
      ('pending', 'card') => (
        'Transfer needed',
        'Transfer the amount, then send the receipt.',
        [
          PillButton(
            label: 'Continue',
            onTap: () => showOrder(context, o, replace: true),
          ),
        ],
      ),
      ('review', _) => (
        'Being checked',
        o.kind == 'topup' && o.activatePlanId == null
            ? 'Once confirmed, the amount is added to your wallet. You can close Pleat; it will be ready when you come back.'
            : 'Once confirmed, your plan starts by itself. You can close Pleat; it will be ready when you come back.',
        <Widget>[],
      ),
      ('rejected', _) => (
        'Not accepted',
        o.adminNote.isNotEmpty && !isPersian(o.adminNote) ? o.adminNote : 'This receipt didn’t match a transfer. Send another one or message support.',
        [
          if (o.method == 'card')
            PillButton(
              label: 'Send another receipt',
              onTap: () async {
                final fresh = await app.order(o.id);
                if (!context.mounted || fresh.card == null) return;
                Navigator.of(context).pushReplacement(
                  FadeRoute(builder: (_) => CardPayScreen(order: fresh)),
                );
              },
            ),
          if (app.config.supportUrl.isNotEmpty)
            PillButton(
              label: 'Message support',
              color: Colors.white,
              textColor: PColors.ink,
              onTap: () => app.tunnel.openUrl(app.config.supportUrl),
            ),
        ],
      ),
      _ => (
        switch (o.status) {
          'cancelled' => 'Order cancelled',
          'expired' => 'Order time ran out',
          _ => 'Order closed',
        },
        'This order is closed. Place a new one any time.',
        <Widget>[],
      ),
    };
    return StorePage(
      title: title,
      subtitle: 'Order #${o.id}  ·  ${o.title}  ·  ${toman(o.amountToman)}',
      children: [
        SurfaceCard(
          child: Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: o.status == 'rejected' ? PColors.alert : PColors.mist,
                  shape: BoxShape.circle,
                ),
                alignment: Alignment.center,
                child: PIconView(
                  o.status == 'rejected'
                      ? PIcon.close
                      : (o.open ? PIcon.clock : PIcon.info),
                  color: o.status == 'rejected' ? Colors.white : PColors.blue,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(body, style: PType.small(color: PColors.ink)),
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        for (final a in actions) ...[a, const SizedBox(height: 10)],
      ],
    );
  }

  Widget _cancel(Order o) => PillButton(
    label: 'Cancel order',
    color: Colors.white,
    textColor: PColors.ink,
    onTap: () async {
      final sure = await confirmSheet(
        context,
        title: 'Cancel this order?',
        body: 'If you already paid, don’t cancel; wait for the confirmation.',
        yes: 'Cancel order',
      );
      if (!sure || !mounted) return;
      try {
        await AppScope.read(context).cancelOrder(o);
        if (mounted) Navigator.of(context).pop();
      } on ApiError catch (e) {
        if (mounted) showNote(context, e.message);
      }
    },
  );
}

/// Paid: what changed, as the server now reports it.
class PaidScreen extends StatelessWidget {
  const PaidScreen({super.key, required this.order});
  final Order order;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final o = order;
    final plan = o.kind == 'plan' || o.planActivated == true;
    final sub = app.subscription;
    final (title, body) = plan
        ? (
            'Your plan is active',
            [
              '${o.kind == 'plan' ? o.planName : o.activatePlanName} is on.',
              if (sub != null && !sub.unlimitedTime && sub.daysLeft != null)
                '${sub.daysLeft} days left.',
              'Tap connect on Home.',
            ].join(' '),
          )
        : o.activatePlanId != null
        ? (
            'Wallet topped up',
            '${toman(o.amountToman)} was added, but the plan didn’t start by itself. Buy it from Plans with your wallet, or message support.',
          )
        : (
            'Wallet topped up',
            '${toman(o.amountToman)} was added to your wallet.',
          );
    return StorePage(
      title: title,
      subtitle: 'Order #${o.id}',
      children: [
        SurfaceCard(
          child: Row(
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: const BoxDecoration(
                  color: PColors.safe,
                  shape: BoxShape.circle,
                ),
                alignment: Alignment.center,
                child: const PIconView(PIcon.check, color: Colors.white),
              ),
              const SizedBox(width: 16),
              Expanded(child: Text(body, style: PType.body())),
            ],
          ),
        ),
        const SizedBox(height: 18),
        PillButton(
          label: plan ? 'Go to Home' : 'Open wallet',
          onTap: () {
            final nav = Navigator.of(context);
            nav.popUntil((r) => r.isFirst);
            if (!plan) {
              nav.push(FadeRoute(builder: (_) => const WalletScreen()));
            } else {
              app.setTab(0);
            }
          },
        ),
      ],
    );
  }
}
