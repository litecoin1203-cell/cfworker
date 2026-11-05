import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'geometry.dart';
import 'tokens.dart';

/// Opening a city flies the camera through the diagonal shards for 500ms
/// and lands on the photo; going back flies out. Reduced motion swaps the
/// flight for an instant cut.
class TunnelRoute<T> extends PageRouteBuilder<T> {
  TunnelRoute({
    required WidgetBuilder builder,
    this.origin = const Offset(0.5, 0.45),
  }) : super(
         transitionDuration: PMotion.tunnel,
         reverseTransitionDuration: PMotion.tunnel,
         opaque: true,
         pageBuilder: (context, _, _) => builder(context),
       );

  /// Where the flight is aimed, in fractions of the screen.
  final Offset origin;

  @override
  Widget buildTransitions(
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    if (PMotion.reduced(context)) return child;
    return AnimatedBuilder(
      animation: animation,
      child: child,
      builder: (context, child) {
        final t = animation.value;
        // The page lands in the last 45% of the flight.
        final land = Curves.easeOutCubic.transform(
          ((t - 0.55) / 0.45).clamp(0.0, 1.0),
        );
        return Stack(
          fit: StackFit.expand,
          children: [
            CustomPaint(painter: _TunnelPainter(t, origin)),
            Opacity(
              opacity: land,
              child: Transform.scale(scale: 1.12 - 0.12 * land, child: child),
            ),
          ],
        );
      },
    );
  }
}

class _TunnelPainter extends CustomPainter {
  /// Repaints when Day and Night switch.
  final PPalette palette = PColors.current;

  _TunnelPainter(this.t, this.origin);
  final double t;
  final Offset origin;

  static List<Color> get _colors => [
    PColors.mist,
    PColors.ice,
    PColors.blue,
    PColors.navy,
  ];

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = PColors.ground);
    final o = Offset(origin.dx * size.width, origin.dy * size.height);
    // Four shard rings rush past the camera, nearest first.
    for (var i = 0; i < 4; i++) {
      final local = (t * 1.5 - i * 0.16).clamp(0.0, 1.0);
      if (local <= 0) continue;
      final z = Curves.easeInCubic.transform(local);
      final scale = 0.25 + z * 6.5;
      final opacity = (1 - z).clamp(0.0, 1.0);
      final paint = Paint()
        ..color = _colors[i].withValues(alpha: math.min(1, opacity * 1.4));
      final w = size.width * 0.32 * scale;
      final h = size.height * 0.30 * scale;
      // Two shards per ring, either side of the flight path.
      for (final side in [-1, 1]) {
        final c = o + Offset(side * w * 0.62, side * -h * 0.08);
        canvas.drawPath(
          shardPath(c, w * 0.7, h, 0.56, radius: 36 * scale),
          paint,
        );
      }
    }
  }

  @override
  bool shouldRepaint(_TunnelPainter old) =>
      old.palette != palette || old.t != t;
}

/// Plain route without Material's default transition: a short fade.
class FadeRoute<T> extends PageRouteBuilder<T> {
  FadeRoute({required WidgetBuilder builder})
    : super(
        transitionDuration: PMotion.state,
        reverseTransitionDuration: PMotion.quick,
        pageBuilder: (context, _, _) => builder(context),
        transitionsBuilder: (context, a, _, child) => FadeTransition(
          opacity: CurvedAnimation(parent: a, curve: Curves.easeOut),
          child: child,
        ),
      );
}
