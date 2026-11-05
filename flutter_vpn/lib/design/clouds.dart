import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter/material.dart';

import 'tokens.dart';

/// Auspicious clouds in the East Asian illustration manner: a cluster of
/// round lobes, spirals rolling inside the big ones, and a long tapered
/// tail that streams off one side. Drawn on device (original geometry),
/// pale blue, on the screen ground under the shards.
///
/// - [ink]: bold blue outline, spirals and a few inner strokes.
/// - [shade]: the outline plus a soft blue shade inside each lobe edge.
/// - [wash]: watercolour-soft blue fill with white line work, no outline.
/// - [gilt]: champagne fill with gold line work, from the theme's gold.
/// - [line]: outline and spirals only, nothing filled.
enum CloudStyle { ink, shade, wash, gilt, line }

abstract final class PClouds {
  /// The style in use; null paints no clouds.
  static CloudStyle? style;

  static const _paper = Color(0xFFF4F9FE);
  static const _sky = Color(0xFFD3E6F7);
  static const _ink = Color(0xFF8DB7DF);

  /// (x, y, size, mirrored), as fractions of the screen; placed so clouds
  /// sit in the open ground between shards and cards.
  static const _spots = [
    (0.76, 0.185, 0.80, false),
    (0.13, 0.355, 0.70, true),
    (0.80, 0.515, 0.75, false),
    (0.16, 0.715, 0.85, true),
    (0.76, 0.945, 0.80, false),
  ];

  /// Lobes: centre x, centre y, radius, in cloud units; big ones first.
  static const _lobes = [
    (0.0, -0.15, 1.05, true),
    (-1.35, 0.30, 0.78, true),
    (1.30, 0.22, 0.82, true),
    (-0.55, -0.85, 0.66, false),
    (0.70, -0.92, 0.70, false),
    (2.20, 0.62, 0.50, false),
    (-2.25, 0.70, 0.46, false),
  ];

  static void paint(Canvas canvas, Size size) {
    final s = style;
    if (s == null) return;
    final fade = PColors.current.isDark ? 0.12 : 0.8;
    final w = size.width, h = size.height;
    for (final (fx, fy, k, flip) in _spots) {
      canvas.save();
      canvas.translate(fx * w, fy * h);
      if (flip) canvas.scale(-1, 1);
      _cloud(canvas, 26.0 * k * (w / 390), s, fade);
      canvas.restore();
    }
  }

  static Path _body(double u) {
    var p = Path()
      ..addRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTRB(-2.65 * u, 0.25 * u, 2.65 * u, 1.18 * u),
          Radius.circular(0.46 * u),
        ),
      );
    for (final (x, y, r, _) in _lobes) {
      p = Path.combine(
        PathOperation.union,
        p,
        Path()
          ..addOval(Rect.fromCircle(center: Offset(x, y) * u, radius: r * u)),
      );
    }
    return p;
  }

  /// A ribbon that leaves the cloud's right base and thins to a point,
  /// with one soft wave on the way.
  static Path _tail(double u) => Path()
    ..moveTo(2.3 * u, 0.55 * u)
    ..cubicTo(3.3 * u, 0.40 * u, 3.9 * u, 1.05 * u, 4.8 * u, 0.55 * u)
    ..cubicTo(5.2 * u, 0.32 * u, 5.6 * u, 0.30 * u, 6.0 * u, 0.36 * u)
    ..cubicTo(5.5 * u, 0.55 * u, 5.1 * u, 0.98 * u, 4.5 * u, 1.05 * u)
    ..cubicTo(3.7 * u, 1.15 * u, 3.1 * u, 0.95 * u, 2.3 * u, 1.18 * u)
    ..close();

  /// Spiral rolling inward from the lobe's lower-left, 1.6 turns.
  static Path _spiral(Offset c, double r) {
    final p = Path();
    const n = 48;
    for (var i = 0; i <= n; i++) {
      final t = i / n;
      final a = math.pi * 0.85 + t * math.pi * 3.2;
      final rr = r * (1 - t * 0.86);
      final pt = c + Offset(math.cos(a), math.sin(a)) * rr;
      i == 0 ? p.moveTo(pt.dx, pt.dy) : p.lineTo(pt.dx, pt.dy);
    }
    return p;
  }

  static void _cloud(Canvas c, double u, CloudStyle s, double fade) {
    final gold = PColors.blue;
    final shape = Path.combine(PathOperation.union, _body(u), _tail(u));
    final (fill, lineCol, inner) = switch (s) {
      CloudStyle.ink => (_paper, _ink, _ink),
      CloudStyle.shade => (_paper, _ink, _ink),
      CloudStyle.wash => (_sky, Colors.transparent, Colors.white),
      CloudStyle.gilt => (Color.lerp(Colors.white, gold, 0.22)!, gold, gold),
      CloudStyle.line => (Colors.transparent, _ink, _ink),
    };
    Color f(Color x, [double a = 1]) => x.withValues(alpha: x.a * a * fade);

    // Fill.
    if (fill.a > 0) {
      final paint = Paint()..color = f(fill, s == CloudStyle.wash ? 0.85 : 1);
      if (s == CloudStyle.wash) {
        paint.maskFilter = MaskFilter.blur(BlurStyle.normal, u * 0.10);
      }
      c.drawPath(shape, paint);
    }

    // Shade: a crescent of blue inside the lower-right edge of each lobe.
    if (s == CloudStyle.shade || s == CloudStyle.gilt) {
      c.save();
      c.clipPath(shape);
      final shadeCol = s == CloudStyle.gilt
          ? Color.lerp(Colors.white, gold, 0.5)!
          : _sky;
      c.drawPath(shape, Paint()..color = f(shadeCol, 0.9));
      c.drawPath(
        shape.shift(Offset(-0.16 * u, -0.20 * u)),
        Paint()..color = f(fill),
      );
      c.restore();
    }

    // Outline.
    if (lineCol.a > 0) {
      c.drawPath(
        shape,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = u * (s == CloudStyle.line ? 0.075 : 0.11)
          ..strokeJoin = StrokeJoin.round
          ..color = f(lineCol),
      );
    }

    // Line work: spirals in the big lobes, a soft arc in the small ones,
    // and one streak along the tail.
    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeWidth = u * (s == CloudStyle.wash ? 0.07 : 0.085)
      ..color = f(inner, s == CloudStyle.wash ? 0.95 : 1);
    for (final (x, y, r, big) in _lobes) {
      final cc = Offset(x, y + 0.12) * u;
      if (big) {
        c.drawPath(_spiral(cc, r * u * 0.58), stroke);
      } else {
        c.drawArc(
          Rect.fromCircle(center: Offset(x, y) * u, radius: r * u * 0.62),
          math.pi * 1.05,
          math.pi * 0.75,
          false,
          stroke,
        );
      }
    }
    c.drawPath(
      Path()
        ..moveTo(2.9 * u, 0.86 * u)
        ..cubicTo(3.6 * u, 0.80 * u, 4.1 * u, 0.95 * u, 4.9 * u, 0.70 * u),
      stroke..strokeWidth = u * 0.06,
    );
  }
}
