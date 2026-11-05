import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'geometry.dart';
import 'tokens.dart';

/// The Pleat mark: two offset folded planes. The back plane is a long
/// shard; the front plane is shorter, set up and to the right, and where
/// they overlap the paper folds to ice.
class MarkColors {
  const MarkColors(this.back, this.front, this.fold);
  final Color back, front, fold;

  static MarkColors get onLight =>
      MarkColors(PColors.navy, PColors.blue, PColors.ice);
  static MarkColors get onDark =>
      MarkColors(PColors.onDeep, PColors.ice, PColors.blue);
  static MarkColors get sealed =>
      MarkColors(PColors.onDeep, PColors.ice, PColors.mist);
}

class MarkPainter extends CustomPainter {
  MarkPainter({
    this.drawBack = 1,
    this.drawFront = 1,
    this.fill = 1,
    this.split = 0,
    this.rotation = 0,
    MarkColors? colors,
    Color? strokeColor,
  }) : colors = colors ?? MarkColors.onLight,
       strokeColor = strokeColor ?? PColors.blue;

  /// 0 … 1 outline draw-on progress per plane.
  final double drawBack, drawFront;

  /// 0 … 1 fill opacity once drawn.
  final double fill;

  /// 0 … 1 planes slide apart along their own axis.
  final double split;

  /// Radians, around the mark's centre.
  final double rotation;
  final MarkColors colors;
  final Color strokeColor;

  static const _slant = 0.325;

  static List<Offset> _plane(double top, double bottom, double left, double w) {
    final run = (bottom - top) * _slant;
    return [
      Offset(left + run, top),
      Offset(left + run + w, top),
      Offset(left + w, bottom),
      Offset(left, bottom),
    ];
  }

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide;
    canvas.save();
    canvas.translate(size.width / 2, size.height / 2);
    canvas.rotate(rotation);
    canvas.translate(-s / 2, -s / 2);
    canvas.scale(s);

    // Axis of the planes ("/"): moving apart means back goes down-left,
    // front goes up-right.
    final axis = const Offset(_slant, -1) / math.sqrt(_slant * _slant + 1);
    final d = axis * (split * 0.16);

    final back = roundedPolygon(_plane(0.10, 0.90, 0.10, 0.25), 0.05).shift(-d);
    final front = roundedPolygon(
      _plane(0.24, 0.80, 0.30, 0.27),
      0.05,
    ).shift(d + Offset(split * 0.04, 0));

    if (fill > 0) {
      canvas.drawPath(
        back,
        Paint()..color = colors.back.withValues(alpha: colors.back.a * fill),
      );
      canvas.drawPath(
        front,
        Paint()..color = colors.front.withValues(alpha: colors.front.a * fill),
      );
      final fold = Path.combine(PathOperation.intersect, back, front);
      canvas.drawPath(
        fold,
        Paint()..color = colors.fold.withValues(alpha: colors.fold.a * fill),
      );
    }

    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 0.035
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = strokeColor.withValues(alpha: (1 - fill).clamp(0, 1));
    if (fill < 1) {
      _drawPartial(canvas, back, drawBack, stroke);
      _drawPartial(canvas, front, drawFront, stroke);
    }
    canvas.restore();
  }

  void _drawPartial(Canvas canvas, Path path, double t, Paint paint) {
    if (t <= 0) return;
    for (final m in path.computeMetrics()) {
      canvas.drawPath(m.extractPath(0, m.length * t.clamp(0, 1)), paint);
    }
  }

  @override
  bool shouldRepaint(MarkPainter old) =>
      old.drawBack != drawBack ||
      old.drawFront != drawFront ||
      old.fill != fill ||
      old.split != split ||
      old.rotation != rotation ||
      old.colors != colors ||
      old.strokeColor != strokeColor;
}

/// Static mark, for headers and the avatar-free places.
class PleatMark extends StatelessWidget {
  const PleatMark({super.key, this.size = 40, MarkColors? colors})
    : _colors = colors;
  final double size;
  final MarkColors? _colors;
  MarkColors get colors => _colors ?? MarkColors.onLight;

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Pleat',
    child: CustomPaint(
      size: Size.square(size),
      painter: MarkPainter(colors: colors),
    ),
  );
}
