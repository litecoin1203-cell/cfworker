import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter/material.dart';

import 'tokens.dart';

/// Faint pale-blue clouds painted on the screen ground, under the shards.
enum CloudStyle { cumulus, stratus, paper, outline, cirrus }

abstract final class PClouds {
  /// The style in use; null paints no clouds.
  static CloudStyle? style;

  static const _blue = Color(0xFFBFDCF5);

  static void paint(Canvas canvas, Size size) {
    final s = style;
    if (s == null) return;
    final dark = PColors.current.isDark;
    final base = dark ? const Color(0xFF8FB4D9) : _blue;
    final k = dark ? 0.10 : 1.0;
    final rnd = math.Random(7);
    final w = size.width, h = size.height;
    switch (s) {
      case CloudStyle.cumulus:
        for (var i = 0; i < 10; i++) {
          final c = Offset(
            (i.isEven ? 0.05 : 0.55) * w + rnd.nextDouble() * w * 0.4,
            (0.04 + i * 0.1) * h,
          );
          _puff(
            canvas,
            c,
            40 + rnd.nextDouble() * 36,
            rnd,
            Paint()
              ..color = base.withValues(alpha: 0.55 * k)
              ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 10),
          );
        }
      case CloudStyle.stratus:
        for (var i = 0; i < 13; i++) {
          final y = (0.03 + i * 0.075) * h;
          final x = rnd.nextDouble() * w * 0.6 - w * 0.2;
          final len = w * (0.5 + rnd.nextDouble() * 0.6);
          canvas.drawRRect(
            RRect.fromRectAndRadius(
              Rect.fromLTWH(x, y, len, 14 + rnd.nextDouble() * 18),
              const Radius.circular(40),
            ),
            Paint()
              ..color = base.withValues(alpha: 0.5 * k)
              ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 9),
          );
        }
      case CloudStyle.paper:
        for (var i = 0; i < 10; i++) {
          final c = Offset(
            (i.isEven ? 0.05 : 0.55) * w + rnd.nextDouble() * w * 0.4,
            (0.05 + i * 0.1) * h,
          );
          final r = 30 + rnd.nextDouble() * 30;
          _puff(
            canvas,
            c + const Offset(6, 7),
            r,
            math.Random(i),
            Paint()..color = base.withValues(alpha: 0.35 * k),
          );
          _puff(
            canvas,
            c,
            r,
            math.Random(i),
            Paint()
              ..color = Color.lerp(
                base,
                Colors.white,
                0.45,
              )!.withValues(alpha: 0.9 * k),
          );
        }
      case CloudStyle.outline:
        for (var i = 0; i < 11; i++) {
          final c = Offset(
            (i.isEven ? 0.05 : 0.55) * w + rnd.nextDouble() * w * 0.4,
            (0.04 + i * 0.09) * h,
          );
          final r = 22 + rnd.nextDouble() * 22;
          final path = _puffPath(c, r, math.Random(i));
          canvas.drawPath(
            path,
            Paint()
              ..style = PaintingStyle.stroke
              ..strokeWidth = 1.6
              ..color = base.withValues(alpha: 0.95 * k),
          );
        }
      case CloudStyle.cirrus:
        // Feathers on the pleat slant.
        for (var i = 0; i < 18; i++) {
          final x = rnd.nextDouble() * w, y = rnd.nextDouble() * h;
          final len = 90 + rnd.nextDouble() * 120;
          final p = Path()
            ..moveTo(x, y)
            ..quadraticBezierTo(x + len * 0.5, y - 26, x + len, y - len * 0.33);
          canvas.drawPath(
            p,
            Paint()
              ..style = PaintingStyle.stroke
              ..strokeCap = StrokeCap.round
              ..strokeWidth = 7 + rnd.nextDouble() * 8
              ..color = base.withValues(alpha: 0.45 * k)
              ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 4),
          );
        }
    }
  }

  static Path _puffPath(Offset c, double r, math.Random rnd) {
    var p = Path()
      ..addRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(c.dx - r * 1.6, c.dy - r * 0.1, r * 3.2, r * 0.9),
          Radius.circular(r * 0.45),
        ),
      );
    for (final (dx, dy, rr) in [
      (-0.85, 0.05, 0.55),
      (-0.2, -0.25, 0.8),
      (0.6, -0.05, 0.62),
    ]) {
      final o = Offset(c.dx + dx * r, c.dy + dy * r);
      p = Path.combine(
        PathOperation.union,
        p,
        Path()..addOval(
          Rect.fromCircle(
            center: o,
            radius: r * rr * (0.9 + rnd.nextDouble() * 0.2),
          ),
        ),
      );
    }
    return p;
  }

  static void _puff(
    Canvas canvas,
    Offset c,
    double r,
    math.Random rnd,
    Paint paint,
  ) => canvas.drawPath(_puffPath(c, r, rnd), paint);
}
