import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'tokens.dart';

/// Outline icon set drawn on a 24-unit grid at a 1.75 stroke, matching the
/// reference's thin rounded glyphs. Painted, so no icon font is shipped.
enum PIcon {
  home,
  shield,
  pin,
  pulse,
  bell,
  search,
  back,
  bookmark,
  user,
  grid,
  near,
  play,
  game,
  bolt,
  clock,
  lock,
  split,
  dns,
  layers,
  wifi,
  filter,
  lan,
  power,
  check,
  close,
  chevron,
  refresh,
  logout,
  ticket,
  mail,
  phone,
  globe,
  route,
  chart,
}

class PIconView extends StatelessWidget {
  const PIconView(
    this.icon, {
    super.key,
    this.size = 24,
    this.color = PColors.ink,
    this.filled = false,
    this.semanticLabel,
  });

  final PIcon icon;
  final double size;
  final Color color;
  final bool filled;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final glyph = SizedBox.square(
      dimension: size,
      child: CustomPaint(painter: _IconPainter(icon, color, filled)),
    );
    if (semanticLabel == null) return ExcludeSemantics(child: glyph);
    return Semantics(label: semanticLabel, child: glyph);
  }
}

class _IconPainter extends CustomPainter {
  _IconPainter(this.icon, this.color, this.filled);

  final PIcon icon;
  final Color color;
  final bool filled;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 24;
    canvas.scale(s);
    final p = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.75
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final fill = Paint()..color = color;
    final path = Path();

    switch (icon) {
      case PIcon.home:
        path
          ..moveTo(4, 10.5)
          ..lineTo(12, 4)
          ..lineTo(20, 10.5)
          ..moveTo(6, 9)
          ..lineTo(6, 19.5)
          ..lineTo(18, 19.5)
          ..lineTo(18, 9)
          ..moveTo(10, 19.5)
          ..lineTo(10, 14.5)
          ..lineTo(14, 14.5)
          ..lineTo(14, 19.5);
      case PIcon.shield:
        path
          ..moveTo(12, 3.5)
          ..lineTo(19, 6.2)
          ..lineTo(19, 11.5)
          ..cubicTo(19, 16, 15.8, 19, 12, 20.5)
          ..cubicTo(8.2, 19, 5, 16, 5, 11.5)
          ..lineTo(5, 6.2)
          ..close();
        if (filled) canvas.drawPath(path, fill);
      case PIcon.pin:
        path
          ..moveTo(12, 21)
          ..cubicTo(12, 21, 5.5, 15, 5.5, 10)
          ..arcToPoint(
            const Offset(18.5, 10),
            radius: const Radius.circular(6.5),
          )
          ..cubicTo(18.5, 15, 12, 21, 12, 21)
          ..close();
        canvas.drawCircle(const Offset(12, 10), 2.3, p);
      case PIcon.pulse:
        path
          ..moveTo(3, 12)
          ..lineTo(7, 12)
          ..lineTo(9.5, 6)
          ..lineTo(14, 18)
          ..lineTo(16.5, 12)
          ..lineTo(21, 12);
      case PIcon.bell:
        path
          ..moveTo(6, 16.5)
          ..lineTo(6, 11)
          ..arcToPoint(const Offset(18, 11), radius: const Radius.circular(6))
          ..lineTo(18, 16.5)
          ..lineTo(19.5, 18)
          ..lineTo(4.5, 18)
          ..close()
          ..moveTo(10, 20.5)
          ..lineTo(14, 20.5);
      case PIcon.search:
        canvas.drawCircle(const Offset(10.5, 10.5), 6, p);
        path
          ..moveTo(15, 15)
          ..lineTo(20, 20);
      case PIcon.back:
        path
          ..moveTo(19, 12)
          ..lineTo(5, 12)
          ..moveTo(11, 6)
          ..lineTo(5, 12)
          ..lineTo(11, 18);
      case PIcon.bookmark:
        path
          ..moveTo(6.5, 4)
          ..lineTo(17.5, 4)
          ..lineTo(17.5, 20)
          ..lineTo(12, 16)
          ..lineTo(6.5, 20)
          ..close();
        if (filled) canvas.drawPath(path, fill);
      case PIcon.user:
        canvas.drawCircle(const Offset(12, 8.5), 3.8, p);
        path
          ..moveTo(4.5, 20)
          ..cubicTo(5.5, 15.5, 8.5, 14, 12, 14)
          ..cubicTo(15.5, 14, 18.5, 15.5, 19.5, 20);
      case PIcon.grid:
        // Isometric box, the reference's "ALL" glyph redrawn.
        path
          ..moveTo(12, 3.5)
          ..lineTo(19.5, 7.5)
          ..lineTo(19.5, 16.5)
          ..lineTo(12, 20.5)
          ..lineTo(4.5, 16.5)
          ..lineTo(4.5, 7.5)
          ..close()
          ..moveTo(4.5, 7.5)
          ..lineTo(12, 11.5)
          ..lineTo(19.5, 7.5)
          ..moveTo(12, 11.5)
          ..lineTo(12, 20.5);
      case PIcon.near:
        path
          ..moveTo(20, 4)
          ..lineTo(4, 11)
          ..lineTo(11, 13)
          ..lineTo(13, 20)
          ..close();
      case PIcon.play:
        final r = RRect.fromLTRBR(
          3.5,
          5.5,
          20.5,
          18.5,
          const Radius.circular(3),
        );
        canvas.drawRRect(r, p);
        path
          ..moveTo(10.5, 9.2)
          ..lineTo(14.8, 12)
          ..lineTo(10.5, 14.8)
          ..close();
      case PIcon.game:
        final r = RRect.fromLTRBR(3, 7.5, 21, 17.5, const Radius.circular(5));
        canvas.drawRRect(r, p);
        path
          ..moveTo(7, 12.5)
          ..lineTo(10, 12.5)
          ..moveTo(8.5, 11)
          ..lineTo(8.5, 14);
        canvas.drawCircle(const Offset(15, 11.5), 0.6, p);
        canvas.drawCircle(const Offset(16.8, 13.5), 0.6, p);
      case PIcon.bolt:
        path
          ..moveTo(13, 3)
          ..lineTo(5.5, 13.5)
          ..lineTo(11.5, 13.5)
          ..lineTo(10.5, 21)
          ..lineTo(18.5, 10.5)
          ..lineTo(12.5, 10.5)
          ..close();
      case PIcon.clock:
        canvas.drawCircle(const Offset(12, 12), 8, p);
        path
          ..moveTo(12, 7.5)
          ..lineTo(12, 12)
          ..lineTo(15, 14);
      case PIcon.lock:
        canvas.drawRRect(
          RRect.fromLTRBR(5, 10.5, 19, 20, const Radius.circular(3)),
          p,
        );
        path
          ..moveTo(8, 10.5)
          ..lineTo(8, 8)
          ..arcToPoint(const Offset(16, 8), radius: const Radius.circular(4))
          ..lineTo(16, 10.5)
          ..moveTo(12, 14)
          ..lineTo(12, 16.5);
      case PIcon.split:
        path
          ..moveTo(4, 12)
          ..lineTo(10, 12)
          ..cubicTo(13, 12, 14, 6.5, 17, 6.5)
          ..lineTo(20, 6.5)
          ..moveTo(10, 12)
          ..cubicTo(13, 12, 14, 17.5, 17, 17.5)
          ..lineTo(20, 17.5)
          ..moveTo(17.5, 4)
          ..lineTo(20, 6.5)
          ..lineTo(17.5, 9)
          ..moveTo(17.5, 15)
          ..lineTo(20, 17.5)
          ..lineTo(17.5, 20);
      case PIcon.dns:
        canvas.drawRRect(
          RRect.fromLTRBR(4, 4.5, 20, 10.5, const Radius.circular(2.5)),
          p,
        );
        canvas.drawRRect(
          RRect.fromLTRBR(4, 13.5, 20, 19.5, const Radius.circular(2.5)),
          p,
        );
        path
          ..moveTo(7.5, 7.5)
          ..lineTo(8, 7.5)
          ..moveTo(7.5, 16.5)
          ..lineTo(8, 16.5);
      case PIcon.layers:
        path
          ..moveTo(12, 4)
          ..lineTo(20.5, 8.5)
          ..lineTo(12, 13)
          ..lineTo(3.5, 8.5)
          ..close()
          ..moveTo(3.5, 12.5)
          ..lineTo(12, 17)
          ..lineTo(20.5, 12.5)
          ..moveTo(3.5, 16.5)
          ..lineTo(12, 21)
          ..lineTo(20.5, 16.5);
      case PIcon.wifi:
        for (final r in [3.5, 7.5, 11.5]) {
          canvas.drawArc(
            Rect.fromCircle(center: const Offset(12, 19), radius: r),
            -math.pi * 0.78,
            math.pi * 0.56,
            false,
            p,
          );
        }
        canvas.drawCircle(const Offset(12, 19), 0.9, fill);
      case PIcon.filter:
        path
          ..moveTo(4, 5)
          ..lineTo(20, 5)
          ..lineTo(14, 12.5)
          ..lineTo(14, 19)
          ..lineTo(10, 17)
          ..lineTo(10, 12.5)
          ..close();
      case PIcon.lan:
        canvas.drawRRect(
          RRect.fromLTRBR(9, 3.5, 15, 8.5, const Radius.circular(1.5)),
          p,
        );
        canvas.drawRRect(
          RRect.fromLTRBR(3, 15.5, 9, 20.5, const Radius.circular(1.5)),
          p,
        );
        canvas.drawRRect(
          RRect.fromLTRBR(15, 15.5, 21, 20.5, const Radius.circular(1.5)),
          p,
        );
        path
          ..moveTo(12, 8.5)
          ..lineTo(12, 12)
          ..moveTo(6, 15.5)
          ..lineTo(6, 12)
          ..lineTo(18, 12)
          ..lineTo(18, 15.5);
      case PIcon.power:
        canvas.drawArc(
          Rect.fromCircle(center: const Offset(12, 13), radius: 7),
          -math.pi * 0.3,
          math.pi * 1.6,
          false,
          p,
        );
        path
          ..moveTo(12, 3.5)
          ..lineTo(12, 11);
      case PIcon.check:
        path
          ..moveTo(5, 12.5)
          ..lineTo(10, 17.5)
          ..lineTo(19.5, 7);
      case PIcon.close:
        path
          ..moveTo(6, 6)
          ..lineTo(18, 18)
          ..moveTo(18, 6)
          ..lineTo(6, 18);
      case PIcon.chevron:
        path
          ..moveTo(9.5, 5.5)
          ..lineTo(16, 12)
          ..lineTo(9.5, 18.5);
      case PIcon.refresh:
        canvas.drawArc(
          Rect.fromCircle(center: const Offset(12, 12), radius: 7.5),
          -math.pi * 0.35,
          math.pi * 1.65,
          false,
          p,
        );
        path
          ..moveTo(18.8, 4.2)
          ..lineTo(18.6, 8.3)
          ..lineTo(14.6, 8.1);
      case PIcon.logout:
        path
          ..moveTo(14, 4.5)
          ..lineTo(6.5, 4.5)
          ..lineTo(6.5, 19.5)
          ..lineTo(14, 19.5)
          ..moveTo(11, 12)
          ..lineTo(20, 12)
          ..moveTo(16.5, 8.5)
          ..lineTo(20, 12)
          ..lineTo(16.5, 15.5);
      case PIcon.ticket:
        path
          ..moveTo(4, 7)
          ..lineTo(20, 7)
          ..lineTo(20, 10)
          ..arcToPoint(
            const Offset(20, 14),
            radius: const Radius.circular(2),
            clockwise: false,
          )
          ..lineTo(20, 17)
          ..lineTo(4, 17)
          ..lineTo(4, 14)
          ..arcToPoint(
            const Offset(4, 10),
            radius: const Radius.circular(2),
            clockwise: false,
          )
          ..close()
          ..moveTo(14.5, 9)
          ..lineTo(14.5, 15);
      case PIcon.mail:
        canvas.drawRRect(
          RRect.fromLTRBR(3.5, 5.5, 20.5, 18.5, const Radius.circular(3)),
          p,
        );
        path
          ..moveTo(4.5, 7)
          ..lineTo(12, 12.5)
          ..lineTo(19.5, 7);
      case PIcon.phone:
        canvas.drawRRect(
          RRect.fromLTRBR(7, 3, 17, 21, const Radius.circular(3)),
          p,
        );
        path
          ..moveTo(10.5, 17.5)
          ..lineTo(13.5, 17.5);
      case PIcon.globe:
        canvas.drawCircle(const Offset(12, 12), 8.5, p);
        canvas.drawOval(
          Rect.fromCenter(center: const Offset(12, 12), width: 8, height: 17),
          p,
        );
        path
          ..moveTo(3.5, 12)
          ..lineTo(20.5, 12);
      case PIcon.route:
        canvas.drawCircle(const Offset(6, 18), 2.2, p);
        canvas.drawCircle(const Offset(18, 6), 2.2, p);
        path
          ..moveTo(8.2, 18)
          ..lineTo(14, 18)
          ..arcToPoint(
            const Offset(14, 11),
            radius: const Radius.circular(3.5),
            clockwise: false,
          )
          ..lineTo(10, 11)
          ..arcToPoint(const Offset(10, 6), radius: const Radius.circular(2.5))
          ..lineTo(15.8, 6);
      case PIcon.chart:
        path
          ..moveTo(5, 20)
          ..lineTo(5, 13)
          ..moveTo(10, 20)
          ..lineTo(10, 8)
          ..moveTo(15, 20)
          ..lineTo(15, 11)
          ..moveTo(20, 20)
          ..lineTo(20, 4.5);
    }
    canvas.drawPath(path, p);
  }

  @override
  bool shouldRepaint(_IconPainter old) =>
      old.icon != icon || old.color != color || old.filled != filled;
}
