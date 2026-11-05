import 'dart:async';

import 'package:flutter/material.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'checkout.dart';
import 'states.dart';
import 'store_kit.dart';

/// Card to card: the destination card in its bank's colours, the exact
/// amount (its last digits make it unique, so the bank SMS matches it),
/// then a receipt photo. The page checks the order every few seconds, so
/// an SMS-confirmed transfer moves on by itself.
class CardPayScreen extends StatefulWidget {
  const CardPayScreen({super.key, required this.order});
  final Order order;

  @override
  State<CardPayScreen> createState() => _CardPayScreenState();
}

class _CardPayScreenState extends State<CardPayScreen>
    with WidgetsBindingObserver {
  late final Order _o = widget.order;
  final _ref = TextEditingController();
  Timer? _poll;
  bool _sending = false;

  /// Paid or sent for review: nothing left to wait for here.
  bool _settled = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _startPoll();
  }

  void _startPoll() {
    _poll?.cancel();
    if (_settled) return;
    _poll = Timer.periodic(const Duration(seconds: 6), (_) => _check());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) {
      // Back from the bank app: look right away.
      _check();
      _startPoll();
    } else if (!onScreen(s)) {
      // In the bank app or off screen: no polling until back.
      _poll?.cancel();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _ref.dispose();
    super.dispose();
  }

  Future<void> _check() async {
    try {
      final o = await AppScope.read(context).order(_o.id);
      if (!mounted) return;
      if (o.status == 'paid' || o.status == 'review') {
        _settled = true;
        _poll?.cancel();
        if (o.status == 'paid') await AppScope.read(context).afterPaid(o);
        if (mounted) showOrder(context, o, replace: true);
      }
    } on ApiError {
      // Next tick tries again.
    }
  }

  Future<void> _send() async {
    final app = AppScope.read(context);
    final photo = await app.tunnel.pickImage();
    if (photo == null || !mounted) return;
    if (photo.length > 8 * 1024 * 1024) {
      return showNote(context, 'The photo is larger than 8 MB.');
    }
    setState(() => _sending = true);
    try {
      final o = await app.sendReceipt(_o, photo, _ref.text.trim());
      if (!mounted) return;
      if (o == null) {
        // No line: kept on the phone, sent by itself later.
        setState(() => _sending = false);
        return showNote(
          context,
          'Can’t reach the server right now. The receipt is saved on this phone and Pleat sends it by itself when it gets through.',
        );
      }
      _poll?.cancel();
      showOrder(context, o, replace: true);
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() => _sending = false);
      showNote(context, e.message);
    }
  }

  Future<void> _cancel() async {
    final sure = await confirmSheet(
      context,
      title: 'Cancel this order?',
      body: 'If you already transferred, don’t cancel. Wait for the check or send the receipt.',
      yes: 'Cancel order',
    );
    if (!sure || !mounted) return;
    try {
      await AppScope.read(context).cancelOrder(_o);
      if (!mounted) return;
      showNote(context, 'Order cancelled.');
      Navigator.of(context).pop();
    } on ApiError catch (e) {
      if (mounted) showNote(context, e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = _o.card;
    if (c == null) {
      return const StorePage(
        title: 'Card to card',
        children: [Text('This order is not a card payment.')],
      );
    }
    final amount = grouped(_o.amountToman);
    final odd = _o.amountToman % 1000 != 0;
    final digits = c.number;
    final shown = [
      for (var i = 0; i < digits.length; i += 4)
        digits.substring(i, i + 4 > digits.length ? digits.length : i + 4),
    ].join('  ');
    return StorePage(
      title: 'Card to card',
      subtitle: 'Order #${_o.id}. ${_o.title}.',
      children: [
        PaySteps(
          steps: ['Transfer', c.auto ? 'Matched' : 'Receipt', 'Active'],
          at: 0,
        ),
        const SizedBox(height: 20),
        // The destination card, in its bank's own colours.
        Container(
          height: 196,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(PRadius.card),
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                hexColor(c.color1, PColors.navy),
                hexColor(c.color2, PColors.blue),
              ],
            ),
            boxShadow: PShadow.soft(),
          ),
          clipBehavior: Clip.antiAlias,
          child: Stack(
            children: [
              const Positioned(
                right: -30,
                top: -50,
                child: ShardChip(color: Colors.white24, width: 80, height: 170),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 22, 14, 18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      c.bank.isEmpty ? 'Destination card' : c.bank,
                      style: PType.h3(color: Colors.white),
                    ),
                    const Spacer(),
                    Text(
                      shown,
                      style: PType.h2(
                        color: Colors.white,
                      ).copyWith(letterSpacing: 1.5, fontFamily: 'monospace'),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            c.holder,
                            style: PType.small(color: Colors.white),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        Pressable(
                          onTap: () =>
                              copyText(context, digits, 'Card number copied.'),
                          label: 'Copy card number',
                          radius: PRadius.pill,
                          color: Colors.white.withValues(alpha: 0.18),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 14,
                              vertical: 9,
                            ),
                            child: Row(
                              children: [
                                const PIconView(
                                  PIcon.copy,
                                  size: 16,
                                  color: Colors.white,
                                ),
                                const SizedBox(width: 6),
                                Text('COPY', style: PType.button()),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        SurfaceCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Transfer exactly', style: PType.meta()),
              const SizedBox(height: 4),
              Text.rich(
                TextSpan(
                  children: [
                    TextSpan(
                      text: odd
                          ? amount.substring(0, amount.length - 3)
                          : amount,
                    ),
                    if (odd)
                      TextSpan(
                        text: amount.substring(amount.length - 3),
                        style: TextStyle(color: PColors.accentInk),
                      ),
                    TextSpan(
                      text: '  toman',
                      style: PType.small(color: PColors.muted),
                    ),
                  ],
                ),
                style: PType.display(34),
              ),
              const SizedBox(height: 12),
              CopyRow(
                label: 'Amount in rial',
                value: '${c.amountRial}',
                display: grouped(c.amountRial),
              ),
              if (odd) ...[
                const SizedBox(height: 12),
                UnavailableNote(
                  'Send the exact amount, last ${amount.substring(amount.length - 3)} toman included. That is how your transfer is matched.',
                ),
              ],
              if (c.auto) ...[
                const SizedBox(height: 12),
                UnavailableNote(
                  'Automatic check is on. After the transfer you are usually active within a minute; the receipt is optional.',
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 16),
        PField(
          controller: _ref,
          hint: 'Reference number (optional)',
          keyboard: TextInputType.number,
        ),
        if (AppScope.of(context).pendingReceipts.containsKey(_o.id)) ...[
          const SizedBox(height: 12),
          const UnavailableNote(
            'Receipt saved on this phone. Pleat sends it by itself as soon as it can reach the server while open, or when you connect.',
          ),
        ],
        const SizedBox(height: 14),
        PillButton(
          label: _sending
              ? 'Sending…'
              : (c.auto ? 'Send receipt (optional)' : 'Send receipt photo'),
          color: c.auto ? PColors.surface : PColors.blue,
          textColor: c.auto ? PColors.ink : PColors.onAccent,
          onTap: _sending ? null : _send,
        ),
        const SizedBox(height: 10),
        PillButton(
          label: 'Cancel order',
          color: PColors.surface,
          textColor: PColors.ink,
          onTap: _cancel,
        ),
        const SizedBox(height: 14),
        Center(
          child: Text(
            _o.kind == 'plan' || _o.activatePlanId != null
                ? 'Once confirmed, the plan starts by itself.'
                : 'Once confirmed, the amount is added to your wallet.',
            style: PType.small(),
          ),
        ),
      ],
    );
  }
}

/// Yes / back sheet; true when the person confirms.
Future<bool> confirmSheet(
  BuildContext context, {
  required String title,
  required String body,
  required String yes,
}) async {
  final r = await showModalBottomSheet<bool>(
    context: context,
    backgroundColor: Colors.transparent,
    barrierColor: PColors.navy.withValues(alpha: 0.28),
    builder: (context) => Container(
      decoration: BoxDecoration(
        color: PColors.surface,
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(PRadius.sheet),
        ),
      ),
      padding: const EdgeInsets.fromLTRB(24, 22, 24, 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: PType.h2()),
          const SizedBox(height: 8),
          Text(body, style: PType.small(color: PColors.ink)),
          const SizedBox(height: 18),
          PillButton(label: yes, onTap: () => Navigator.of(context).pop(true)),
          const SizedBox(height: 10),
          PillButton(
            label: 'Back',
            color: PColors.field,
            textColor: PColors.ink,
            onTap: () => Navigator.of(context).pop(false),
          ),
        ],
      ),
    ),
  );
  return r ?? false;
}
