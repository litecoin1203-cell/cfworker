import 'dart:async';

import 'package:flutter/material.dart';
import 'package:qr/qr.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'checkout.dart';
import 'pay_card.dart';
import 'states.dart';
import 'store_kit.dart';

/// A direct coin payment: exact amount, the address as text and QR, the
/// memo when the chain needs one, and the time the price is locked for.
/// Coins the Worker watches confirm by themselves; for the rest the payer
/// taps "I have paid", optionally with the transaction hash.
class CoinPayScreen extends StatefulWidget {
  const CoinPayScreen({super.key, required this.order});
  final Order order;

  @override
  State<CoinPayScreen> createState() => _CoinPayScreenState();
}

class _CoinPayScreenState extends State<CoinPayScreen>
    with WidgetsBindingObserver {
  late Order _o = widget.order;
  final _tx = TextEditingController();
  Timer? _poll, _tick;
  late DateTime _until;
  bool _sending = false;

  /// Paid: nothing left to wait for.
  bool _settled = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _tx.text = _o.txid;
    _until = DateTime.now().add(Duration(seconds: _o.coin?.secondsLeft ?? 0));
    _startTimers();
  }

  void _startTimers() {
    _poll?.cancel();
    _tick?.cancel();
    if (!_settled) {
      _poll = Timer.periodic(const Duration(seconds: 5), (_) => _check());
    }
    // The countdown is counted from [_until], so pausing it loses nothing.
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) {
      // Back from the wallet app: look right away.
      _check();
      _startTimers();
    } else if (!onScreen(s)) {
      _poll?.cancel();
      _tick?.cancel();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _tick?.cancel();
    _tx.dispose();
    super.dispose();
  }

  Future<void> _check() async {
    try {
      final app = AppScope.read(context);
      final o = await app.order(_o.id);
      if (!mounted) return;
      if (o.status == 'paid') {
        _settled = true;
        _poll?.cancel();
        await app.afterPaid(o);
        if (mounted) showOrder(context, o, replace: true);
        return;
      }
      setState(() => _o = o);
    } on ApiError {
      // Next tick tries again.
    }
  }

  Future<void> _paid() async {
    setState(() => _sending = true);
    try {
      final o = await AppScope.read(context).coinPaid(_o, _tx.text.trim());
      if (!mounted) return;
      setState(() {
        _o = o;
        _sending = false;
      });
      showNote(context, 'Thanks. The payment is being checked.');
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
      body: 'If you already sent the coins, don’t cancel. Tap “I have paid”.',
      yes: 'Cancel order',
    );
    if (!sure || !mounted) return;
    try {
      await AppScope.read(context).cancelOrder(_o);
      if (mounted) Navigator.of(context).pop();
    } on ApiError catch (e) {
      if (mounted) showNote(context, e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = _o.coin;
    if (c == null) {
      return const StorePage(
        title: 'Crypto',
        children: [Text('This order is not a crypto payment.')],
      );
    }
    final left = _until.difference(DateTime.now());
    final expired = _o.status == 'expired' || left.isNegative;
    final review = _o.status == 'review';
    final rejected = _o.status == 'rejected';
    final accent = hexColor(c.color, PColors.blue);
    String two(int v) => v.toString().padLeft(2, '0');

    return StorePage(
      title: 'Pay with ${c.symbol}',
      subtitle: 'Order #${_o.id}. ${_o.title}, ${toman(_o.amountToman)}.',
      children: [
        PaySteps(
          steps: const ['Send', 'Network check', 'Active'],
          at: review ? 1 : 0,
        ),
        const SizedBox(height: 20),
        if (review)
          SurfaceCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Being checked', style: PType.h2()),
                const SizedBox(height: 6),
                Text(
                  'Your payment is on its way. The plan starts as soon as the network confirms it; you can close Pleat meanwhile.',
                  style: PType.small(color: PColors.ink),
                ),
              ],
            ),
          )
        else ...[
          SurfaceCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (rejected) ...[
                  UnavailableNote(
                    _o.adminNote.isNotEmpty && !isPersian(_o.adminNote)
                        ? _o.adminNote
                        : 'This payment wasn’t found. Check the hash and try again.',
                  ),
                  const SizedBox(height: 12),
                ],
                Text('Send exactly', style: PType.meta()),
                const SizedBox(height: 4),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Flexible(
                      child: Text(
                        c.amount,
                        style: PType.display(32),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Text(c.symbol, style: PType.h3(color: accent)),
                    ),
                    const Spacer(),
                    RoundIcon(
                      PIcon.copy,
                      onTap: () =>
                          copyText(context, c.amount, 'Amount copied.'),
                      label: 'Copy amount',
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                UnavailableNote(
                  'Only on the ${c.network} network. Another network or amount can’t be matched.',
                ),
                if (c.auto) ...[
                  const SizedBox(height: 10),
                  const UnavailableNote(
                    'Automatic check is on: you are usually active about a minute after sending.',
                  ),
                ],
                const SizedBox(height: 18),
                Center(
                  child: _Qr(text: c.address, color: PColors.navy),
                ),
                const SizedBox(height: 18),
                CopyRow(label: '${c.name} address', value: c.address),
                if (c.memo != null && c.memo!.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  CopyRow(
                    label:
                        '${c.memoLabel.isEmpty ? 'Memo' : c.memoLabel}, required',
                    value: c.memo!,
                    alert: true,
                  ),
                ],
                const SizedBox(height: 16),
                Text(
                  expired
                      ? 'The locked price ran out. Cancel and place a new order.'
                      : 'Price locked for ${two(left.inMinutes)}:${two(left.inSeconds % 60)}',
                  style: PType.small(
                    color: expired ? PColors.alert : PColors.ink,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          if (!c.auto) ...[
            PField(
              controller: _tx,
              hint: 'Transaction hash (optional, faster)',
              mono: true,
            ),
            const SizedBox(height: 14),
          ],
          PillButton(
            label: _sending
                ? 'Sending…'
                : (c.auto ? 'I have paid (optional)' : 'I have paid'),
            onTap: _sending ? null : _paid,
          ),
          const SizedBox(height: 10),
          PillButton(
            label: 'Cancel order',
            color: PColors.surface,
            textColor: PColors.ink,
            onTap: _cancel,
          ),
        ],
      ],
    );
  }
}

/// QR of [text], drawn as rounded dots in Pleat's navy on white.
class _Qr extends StatelessWidget {
  const _Qr({required this.text, required this.color});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final QrImage img;
    try {
      img = QrImage(QrCode(payload: QrPayload.fromString(text)));
    } catch (_) {
      return const SizedBox.shrink();
    }
    return Semantics(
      label: 'Wallet address QR code',
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: PColors.surface,
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: PColors.mist),
        ),
        child: CustomPaint(
          size: const Size.square(200),
          painter: _QrPainter(img, color),
        ),
      ),
    );
  }
}

class _QrPainter extends CustomPainter {
  _QrPainter(this.img, this.color);
  final QrImage img;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final n = img.moduleCount;
    final cell = size.width / n;
    final p = Paint()..color = color;
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (!img.isDark(r, c)) continue;
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromLTWH(c * cell, r * cell, cell * 0.92, cell * 0.92),
            Radius.circular(cell * 0.3),
          ),
          p,
        );
      }
    }
  }

  @override
  bool shouldRepaint(_QrPainter old) => old.img != img || old.color != color;
}
