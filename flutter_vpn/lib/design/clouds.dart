import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter/material.dart';

import 'tokens.dart';

/// Faint pale-blue clouds in the traditional Japanese illustration manner,
/// painted on the screen ground under the shards.
///
/// - [kasumi]: long flat mist bands with stepped edges (suyari-gasumi).
/// - [uzu]: puffed clouds whose ends roll into spirals (uzu-gumo).
/// - [kumo]: a crest of stacked scallops with inner arcs (kumo-mon).
/// - [emaki]: banded clouds with inner lines and one curled tip.
/// - [kinun]: the spiral clouds with a fine gold edge (kin-un).
enum CloudStyle { kasumi, uzu, kumo, emaki, kinun }

abstract final class PClouds {
  /// The style in use; null paints no clouds.
  static CloudStyle? style;

  static const _fill = Color(0xFFDCEBF8);
  static const _line = Color(0xFFA9CBEA);

  /// Hand-placed so clouds sit in the gaps: (x, y, scale) as fractions.
  static const _spots = [
    (-0.08, 0.07, 1.05),
    (0.60, 0.19, 0.80),
    (0.04, 0.39, 0.90),
    (0.66, 0.55, 1.00),
    (-0.04, 0.73, 0.85),
    (0.56, 0.88, 0.95),
  ];

  static void paint(Canvas canvas, Size size) {
    final s = style;
    if (s == null) return;
    final dark = PColors.current.isDark;
    final a = dark ? 0.10 : 1.0;
    final fill = Paint()..color = _fill.withValues(alpha: 0.95 * a);
    final line = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = (s == CloudStyle.kinun ? PColors.blue : _line).withValues(
        alpha: (s == CloudStyle.kinun ? 0.85 : 0.9) * a,
      );
    final w = size.width, h = size.height;
    for (final (i, (fx, fy, k)) in _spots.indexed) {
      final o = Offset(fx * w, fy * h);
      final u = 30.0 * k * (w / 390);
      switch (s) {
        case CloudStyle.kasumi:
          _kasumi(canvas, o, u, w, fill, line, i);
        case CloudStyle.uzu || CloudStyle.kinun:
          _uzu(canvas, o, u, fill, line, i);
        case CloudStyle.kumo:
          _kumo(canvas, o, u, fill, line);
        case CloudStyle.emaki:
          _emaki(canvas, o, u, w, fill, line, i);
      }
    }
  }

  static RRect _bar(double x, double y, double len, double t) =>
      RRect.fromRectAndRadius(
        Rect.fromLTWH(x, y, len, t),
        Radius.circular(t / 2),
      );

  /// Three stacked rounded bars, each stepped in from the one below.
  static Path _bands(Offset o, double u, double len, int seed) {
    final t = u * 0.62;
    final step = seed.isEven ? 1.0 : -1.0;
    var p = Path()..addRRect(_bar(o.dx, o.dy + t * 1.6, len, t));
    p = Path.combine(
      PathOperation.union,
      p,
      Path()..addRRect(
        _bar(o.dx + u * (1.4 + step * 0.6), o.dy + t * 0.8, len * 0.72, t),
      ),
    );
    p = Path.combine(
      PathOperation.union,
      p,
      Path()..addRRect(_bar(o.dx + u * (2.6 + step), o.dy, len * 0.4, t)),
    );
    return p;
  }

  static void _kasumi(
    Canvas c,
    Offset o,
    double u,
    double w,
    Paint f,
    Paint l,
    int i,
  ) {
    final p = _bands(o, u, w * (0.55 + (i % 3) * 0.08), i);
    c.drawPath(p, f);
    c.drawPath(p, l);
  }

  static void _emaki(
    Canvas c,
    Offset o,
    double u,
    double w,
    Paint f,
    Paint l,
    int i,
  ) {
    final len = w * (0.5 + (i % 3) * 0.08);
    final p = _bands(o, u, len, i);
    c.drawPath(p, f);
    c.drawPath(p, l);
    // Inner drawn lines along each band.
    final t = u * 0.62;
    final thin = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..strokeCap = StrokeCap.round
      ..color = l.color.withValues(alpha: l.color.a * 0.7);
    for (final (dx, dy, lw) in [(t * 0.9, t * 1.6 + t * 0.5, len - t * 2.2)]) {
      c.drawLine(o + Offset(dx, dy), o + Offset(dx + lw * 0.7, dy), thin);
    }
    // One curled tip at the long band's right end.
    final end = o + Offset(len - t * 0.5, t * 1.6 + t * 0.5);
    c.drawPath(_spiral(end, t * 0.36, 0), l);
  }

  /// A spiral rolling inward from radius [r] around [c].
  static Path _spiral(Offset c, double r, double start, {bool cw = true}) {
    final p = Path();
    const n = 40;
    for (var k = 0; k <= n; k++) {
      final t = k / n;
      final ang = start + (cw ? 1 : -1) * t * math.pi * 2.4;
      final rr = r * (1 - t * 0.82);
      final pt = c + Offset(math.cos(ang), math.sin(ang)) * rr;
      k == 0 ? p.moveTo(pt.dx, pt.dy) : p.lineTo(pt.dx, pt.dy);
    }
    return p;
  }

  static void _uzu(Canvas c, Offset o, double u, Paint f, Paint l, int i) {
    final len = u * (5.2 + (i % 2) * 1.4);
    final r = u * 0.55;
    final base = o.dy + u * 1.2;
    var body = Path()..addRRect(_bar(o.dx, base - r, len, r * 2));
    final lobes = [(0.24, 0.62), (0.48, 0.85), (0.72, 0.6)];
    for (final (fx, fr) in lobes) {
      body = Path.combine(
        PathOperation.union,
        body,
        Path()..addOval(
          Rect.fromCircle(
            center: Offset(o.dx + len * fx, base - r * 0.6),
            radius: u * fr,
          ),
        ),
      );
    }
    c.drawPath(body, f);
    c.drawPath(body, l);
    // Both ends roll into spirals; each lobe gets one inner arc.
    c.drawPath(_spiral(Offset(o.dx + r, base), r * 0.78, math.pi, cw: true), l);
    c.drawPath(
      _spiral(Offset(o.dx + len - r, base), r * 0.78, 0, cw: false),
      l,
    );
    for (final (fx, fr) in lobes) {
      final cc = Offset(o.dx + len * fx, base - r * 0.6);
      c.drawArc(
        Rect.fromCircle(center: cc, radius: u * fr * 0.58),
        math.pi * 1.1,
        math.pi * 0.8,
        false,
        l,
      );
    }
  }

  static void _kumo(Canvas c, Offset o, double u, Paint f, Paint l) {
    final r = u * 0.62;
    final x0 = o.dx + u * 1.5, y0 = o.dy + u * 2.2;
    // Back row first so the front scallops cover its lines.
    final rows = [
      for (var k = 0; k < 2; k++) (x0 + r * (1 + k * 2), y0 - r * 1.6),
      for (var k = 0; k < 3; k++) (x0 + r * k * 2, y0 - r * 0.7),
      for (var k = 0; k < 4; k++) (x0 - r + r * k * 2, y0),
    ];
    final clip = Rect.fromLTRB(
      o.dx - u * 4,
      o.dy - u * 4,
      o.dx + u * 12,
      y0 + r * 0.25,
    );
    c.save();
    c.clipRect(clip);
    for (final (x, y) in rows) {
      final cc = Offset(x, y);
      c.drawCircle(cc, r, f);
      c.drawCircle(cc, r, l);
      c.drawArc(
        Rect.fromCircle(center: cc, radius: r * 0.6),
        math.pi * 1.05,
        math.pi * 0.9,
        false,
        l,
      );
    }
    c.restore();
    c.drawLine(
      Offset(x0 - r * 2, y0 + r * 0.25),
      Offset(x0 + r * 6, y0 + r * 0.25),
      l,
    );
  }
}
