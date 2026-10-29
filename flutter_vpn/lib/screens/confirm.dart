import 'dart:async';

import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/backdrop.dart';
import '../design/icons.dart';
import '../design/scenes.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/seed.dart';
import 'shell.dart';

/// Confirm: where the link went, a resend cooldown, and the trial slab in
/// the reference's discount-card anatomy.
class ConfirmScreen extends StatefulWidget {
  const ConfirmScreen({
    super.key,
    required this.address,
    required this.byPhone,
  });
  final String address;
  final bool byPhone;

  @override
  State<ConfirmScreen> createState() => _ConfirmScreenState();
}

class _ConfirmScreenState extends State<ConfirmScreen> {
  static const _cooldown = 30;
  int _left = _cooldown;
  int _sent = 1;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _start();
  }

  void _start() {
    _timer?.cancel();
    setState(() => _left = _cooldown);
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (_left <= 1) t.cancel();
      setState(() => _left--);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _confirm() {
    final app = AppScope.read(context);
    app.signIn(widget.byPhone ? 'guest@pleat.demo' : widget.address);
    if (app.planId == null) app.startTrial(plans.first);
    Navigator.of(context).pushAndRemoveUntil(
      FadeRoute(builder: (_) => const Shell()),
      (_) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    final ends = DateTime.now().add(const Duration(days: 7));
    return Scaffold(
      backgroundColor: PColors.ground,
      body: ShardBackdrop(
        layout: Layouts.confirm,
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
            children: [
              Align(
                alignment: Alignment.centerLeft,
                child: RoundIcon(
                  PIcon.back,
                  onTap: () => Navigator.of(context).pop(),
                  label: 'Back',
                ),
              ),
              const SizedBox(height: 18),
              SurfaceCard(
                padding: const EdgeInsets.fromLTRB(24, 26, 24, 22),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 48,
                          height: 48,
                          decoration: const BoxDecoration(
                            color: PColors.mist,
                            shape: BoxShape.circle,
                          ),
                          alignment: Alignment.center,
                          child: PIconView(
                            widget.byPhone ? PIcon.phone : PIcon.mail,
                            color: PColors.blue,
                          ),
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Text(
                            widget.byPhone
                                ? 'Check your messages'
                                : 'Check your inbox',
                            style: PType.h2(),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Text.rich(
                      TextSpan(
                        style: PType.body(color: PColors.muted),
                        children: [
                          TextSpan(
                            text: widget.byPhone
                                ? 'We sent a sign-in code to '
                                : 'We sent a sign-in link to ',
                          ),
                          TextSpan(
                            text: widget.address,
                            style: PType.body().copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const TextSpan(
                            text: '. Open it on this phone to finish.',
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 18),
                    Row(
                      children: [
                        PIconView(
                          PIcon.clock,
                          size: 18,
                          color: _left > 0 ? PColors.muted : PColors.blue,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _left > 0
                                ? 'Resend in 0:${_left.toString().padLeft(2, '0')}'
                                : (_sent > 1
                                      ? 'Sent again. You can resend once more.'
                                      : 'Didn’t arrive?'),
                            style: PType.small(),
                          ),
                        ),
                        Pressable(
                          onTap: _left > 0
                              ? null
                              : () {
                                  setState(() => _sent++);
                                  _start();
                                },
                          label: 'Resend',
                          radius: 20,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 14,
                            ),
                            child: Text(
                              'Resend',
                              style: PType.small(
                                color: _left > 0 ? PColors.ice : PColors.blue,
                              ).copyWith(fontWeight: FontWeight.w700),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              // The trial slab overlaps the card and leaves the column, like the
              // reference's discount card riding over the confirm sheet.
              Transform.translate(
                offset: const Offset(12, -10),
                child: OfferCard(
                  title: 'Your trial',
                  big: '7',
                  unit: 'days of every exit,\nno card needed',
                  footer: 'Solo trial  ·  ends ${_fmt(ends)}',
                ),
              ),
              const SizedBox(height: 18),
              PillButton(
                label: widget.byPhone ? 'Use demo code' : 'I opened the link',
                onTap: _confirm,
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _fmt(DateTime d) {
    const m = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return '${d.day} ${m[d.month - 1]} ${d.year}';
  }
}

/// Three overlapping exit badges: "every exit" made visible.
class RegionBadgeStack extends StatelessWidget {
  const RegionBadgeStack({super.key});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 74,
      height: 44,
      child: Stack(
        children: [
          for (var i = 0; i < 3; i++)
            Positioned(
              left: i * 15.0,
              child: RegionBadge(exits[i * 3], size: 44),
            ),
        ],
      ),
    );
  }
}
