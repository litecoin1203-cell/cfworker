import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../state/app_state.dart';
import 'mark.dart';
import 'tokens.dart';

/// The connect control. It lives in the shard field and morphs through
/// the tunnel's life: an idle pill, a circular handshake with the mark
/// split and turning, then the mark reassembled as a protected seal.
/// Tapping while it works cancels.
class ConnectControl extends StatefulWidget {
  const ConnectControl({super.key, required this.phase, required this.onTap});
  final Phase phase;
  final VoidCallback onTap;

  static const box = Size(240, 156);

  @override
  State<ConnectControl> createState() => _ConnectControlState();
}

class _ConnectControlState extends State<ConnectControl>
    with TickerProviderStateMixin {
  // 0 idle pill · 1 checking circle · 2 handshake · 3 sealed
  late final AnimationController _morph = AnimationController(
    vsync: this,
    lowerBound: 0,
    upperBound: 3,
    value: _stage(widget.phase),
  );
  late final AnimationController _spin = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );
  late final AnimationController _check = AnimationController(
    vsync: this,
    duration: PMotion.checking,
  );
  bool _down = false;

  static double _stage(Phase p) => switch (p) {
    Phase.idle || Phase.dropped => 0,
    Phase.checking => 1,
    Phase.handshaking => 2,
    Phase.protected => 3,
  };

  @override
  void didUpdateWidget(ConnectControl old) {
    super.didUpdateWidget(old);
    if (old.phase != widget.phase) _go(widget.phase);
  }

  void _go(Phase p) {
    final reduced = PMotion.reduced(context);
    final target = _stage(p);
    if (reduced) {
      _morph.value = target;
      _spin.stop();
      _check.value = p == Phase.checking ? 1 : 0;
      return;
    }
    final d = switch (p) {
      Phase.checking => const Duration(milliseconds: 260),
      Phase.handshaking => const Duration(milliseconds: 300),
      Phase.protected => PMotion.seal,
      _ => PMotion.state,
    };
    _morph.animateTo(target, duration: d, curve: Curves.easeInOutCubic);
    if (p == Phase.checking) _check.forward(from: 0);
    if (p == Phase.handshaking) _spin.repeat();
    if (p == Phase.idle || p == Phase.dropped) _spin.stop();
    if (p == Phase.protected) {
      // Let the turn finish into the seal rather than snapping.
      _spin.animateTo(1, duration: PMotion.seal, curve: Curves.easeOutCubic);
    }
  }

  @override
  void dispose() {
    _morph.dispose();
    _spin.dispose();
    _check.dispose();
    super.dispose();
  }

  String get _label => switch (widget.phase) {
    Phase.idle => 'Connect',
    Phase.checking => 'Checking',
    Phase.handshaking => 'Handshaking',
    Phase.protected => 'Protected',
    Phase.dropped => 'Reconnect',
  };

  @override
  Widget build(BuildContext context) {
    final dropped = widget.phase == Phase.dropped;
    return Semantics(
      button: true,
      label: switch (widget.phase) {
        Phase.idle => 'Connect',
        Phase.checking || Phase.handshaking => '$_label. Tap to cancel',
        Phase.protected => 'Protected. Tap to disconnect',
        Phase.dropped => 'Tunnel dropped. Tap to reconnect',
      },
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => setState(() => _down = true),
        onTapUp: (_) => setState(() => _down = false),
        onTapCancel: () => setState(() => _down = false),
        onTap: widget.onTap,
        child: SizedBox.fromSize(
          size: ConnectControl.box,
          child: AnimatedScale(
            scale: _down ? 0.985 : 1,
            duration: _down ? PMotion.press : const Duration(milliseconds: 280),
            curve: _down ? Curves.easeOut : Curves.easeOutBack,
            child: AnimatedBuilder(
              animation: Listenable.merge([_morph, _spin, _check]),
              builder: (context, _) => CustomPaint(
                painter: _ControlPainter(
                  m: _morph.value,
                  spin: _spin.value,
                  check: _check.value,
                  dropped: dropped,
                  pressed: _down,
                ),
                child: _PillLabel(
                  m: _morph.value,
                  text: dropped ? 'Reconnect' : 'Connect',
                  dropped: dropped,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PillLabel extends StatelessWidget {
  const _PillLabel({
    required this.m,
    required this.text,
    required this.dropped,
  });
  final double m;
  final String text;
  final bool dropped;

  @override
  Widget build(BuildContext context) {
    final o = (1 - m * 2.2).clamp(0.0, 1.0);
    return Center(
      child: Opacity(
        opacity: o,
        child: Text(
          text.toUpperCase(),
          style: PType.button(color: dropped ? PColors.alert : PColors.onAccent)
              .copyWith(fontSize: 14),
        ),
      ),
    );
  }
}

class _ControlPainter extends CustomPainter {
  /// Repaints when Day and Night switch.
  final PPalette palette = PColors.current;

  _ControlPainter({
    required this.m,
    required this.spin,
    required this.check,
    required this.dropped,
    required this.pressed,
  });

  final double m, spin, check;
  final bool dropped, pressed;

  double _seg(double a, double b) => ((m - a) / (b - a)).clamp(0.0, 1.0);

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final a = _seg(0, 1), b = _seg(1, 2), s = _seg(2, 3);

    // Shape: pill 216×68 → circle 96 → 104 → sealed 128.
    final w = lerpDouble(216, 96, a) + 8 * b + 24 * s;
    final h = lerpDouble(68, 96, a) + 8 * b + 24 * s;
    final rect = Rect.fromCenter(center: c, width: w, height: h);
    final rr = RRect.fromRectAndRadius(rect, Radius.circular(h / 2));

    final fill = dropped
        ? PColors.surface
        : Color.lerp(
            Color.lerp(PColors.blue, PColors.navy, b),
            PColors.navy,
            s,
          )!;

    // Lifted shadow, tighter while pressed.
    canvas.drawRRect(
      rr.shift(Offset(0, pressed ? 4 : 12)),
      Paint()
        ..color = (dropped ? PColors.navy : fill).withValues(
          alpha: pressed ? 0.22 : 0.30,
        )
        ..maskFilter = MaskFilter.blur(BlurStyle.normal, pressed ? 8 : 18),
    );

    // The protected halo: green only exists in this state.
    if (s > 0) {
      canvas.drawCircle(
        c,
        h / 2 + 10 + 4 * s,
        Paint()..color = PColors.safe.withValues(alpha: 0.14 * s),
      );
      canvas.drawCircle(
        c,
        h / 2 + 5,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 3
          ..color = PColors.safe.withValues(alpha: s),
      );
    }

    canvas.drawRRect(rr, Paint()..color = fill);
    if (dropped) {
      canvas.drawRRect(
        rr,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..color = PColors.alert,
      );
    }

    // Checking: a white sweep runs once around the inside.
    if (a > 0.6 && b < 1 && check > 0) {
      final arc = Rect.fromCircle(center: c, radius: h / 2 - 7);
      canvas.drawArc(
        arc,
        -math.pi / 2,
        2 * math.pi * check,
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeCap = StrokeCap.round
          ..strokeWidth = 2.5
          ..color = Colors.white.withValues(alpha: (1 - b) * ((a - 0.6) / 0.4)),
      );
    }

    // Handshake: a broken ring turning against the mark.
    if (b > 0 && s < 1) {
      final arc = Rect.fromCircle(center: c, radius: h / 2 - 7);
      final ring = Paint()
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeWidth = 2.5
        ..color = PColors.ice.withValues(alpha: b * (1 - s));
      for (var i = 0; i < 3; i++) {
        canvas.drawArc(
          arc,
          -spin * 2 * math.pi + i * 2 * math.pi / 3,
          1.1,
          false,
          ring,
        );
      }
    }

    // The mark: appears as the pill closes, splits in handshake, rejoins.
    final markOpacity = _seg(0.4, 1);
    if (markOpacity > 0) {
      final split = m <= 1 ? a * 0.6 : (m <= 2 ? 0.6 + 0.4 * b : 1 - s);
      final markSize = h * 0.52;
      canvas.save();
      canvas.translate(c.dx - markSize / 2, c.dy - markSize / 2);
      canvas.saveLayer(
        Rect.fromLTWH(-10, -10, markSize + 20, markSize + 20),
        Paint()..color = Colors.white.withValues(alpha: markOpacity),
      );
      MarkPainter(
        split: split,
        rotation: spin * 2 * math.pi * (m < 3 ? 1 : 0),
        colors: MarkColors.sealed,
      ).paint(canvas, Size.square(markSize));
      canvas.restore();
      canvas.restore();
    }
  }

  static double lerpDouble(double a, double b, double t) => a + (b - a) * t;

  @override
  bool shouldRepaint(_ControlPainter old) =>
      old.palette != palette ||
      old.m != m ||
      old.spin != spin ||
      old.check != check ||
      old.dropped != dropped ||
      old.pressed != pressed;
}
