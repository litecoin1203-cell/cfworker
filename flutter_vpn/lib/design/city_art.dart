import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../state/seed.dart';
import 'geometry.dart';
import 'icons.dart';
import 'tokens.dart';
import 'widgets.dart';

/// Generated city "photography": a sky, a seeded skyline in three depths,
/// one landmark, water with reflections. Painted on device, original, and
/// tuned to sit inside the brand blues.
class CityArt extends StatelessWidget {
  const CityArt({super.key, required this.exit});
  final Exit exit;

  @override
  Widget build(BuildContext context) => RepaintBoundary(
    child: CustomPaint(painter: _CityPainter(exit), size: Size.infinite),
  );
}

class _Tone {
  const _Tone(this.sky, this.layers, this.sun, {this.windows});
  final List<Color> sky;
  final List<Color> layers;
  final Color sun;
  final Color? windows;
}

const _tones = {
  SceneTone.dawn: _Tone(
    [Color(0xFFA9D4F5), Color(0xFFE6E4F0), Color(0xFFF4D8C6)],
    [Color(0xFF9DB5D3), Color(0xFF6E86A8), Color(0xFF3E557A)],
    Color(0xFFFFF1E4),
  ),
  SceneTone.day: _Tone(
    [Color(0xFF2F89F5), Color(0xFF7DB8F7), Color(0xFFD7E9FA)],
    [Color(0xFFA2C3E6), Color(0xFF6E95C4), Color(0xFF34507A)],
    Color(0xFFFFFFFF),
  ),
  SceneTone.dusk: _Tone(
    [Color(0xFF14284B), Color(0xFF3F6FB8), Color(0xFFE9A98A)],
    [Color(0xFF3B5583), Color(0xFF243A63), Color(0xFF111F3B)],
    Color(0xFFFFD9B8),
    windows: Color(0xFFFFD58A),
  ),
  SceneTone.night: _Tone(
    [Color(0xFF081429), Color(0xFF14284B), Color(0xFF2B4C80)],
    [Color(0xFF243B63), Color(0xFF172A4C), Color(0xFF0B1630)],
    Color(0xFFE7F1FA),
    windows: Color(0xFFFFD58A),
  ),
};

class _CityPainter extends CustomPainter {
  _CityPainter(this.exit);
  final Exit exit;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    final tone = _tones[exit.tone]!;
    final rnd = math.Random(exit.seed);
    final horizon = h * 0.70;

    canvas.drawRect(
      Offset.zero & size,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: tone.sky,
        ).createShader(Rect.fromLTWH(0, 0, w, horizon)),
    );

    // Sun or moon with a soft halo.
    final sunC = Offset(
      w * (0.58 + rnd.nextDouble() * 0.3),
      h * (0.22 + rnd.nextDouble() * 0.16),
    );
    canvas.drawCircle(
      sunC,
      h * 0.22,
      Paint()
        ..color = tone.sun.withValues(alpha: 0.18)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 30),
    );
    canvas.drawCircle(
      sunC,
      h * 0.07,
      Paint()..color = tone.sun.withValues(alpha: 0.95),
    );

    if (exit.tone == SceneTone.night) {
      final star = Paint()..color = Colors.white.withValues(alpha: 0.6);
      for (var i = 0; i < 26; i++) {
        canvas.drawCircle(
          Offset(rnd.nextDouble() * w, rnd.nextDouble() * horizon * 0.6),
          rnd.nextDouble() * 1.1 + 0.3,
          star,
        );
      }
    }

    // Landmark sits behind the nearest layer.
    final landmark = exit.seed % 4;
    if (landmark == 2) _mountains(canvas, size, horizon, tone, rnd);

    for (var layer = 0; layer < 3; layer++) {
      final paint = Paint()..color = tone.layers[layer];
      final base = horizon + layer * h * 0.025;
      var x = -10.0;
      final maxH = h * (0.20 + layer * 0.10);
      while (x < w + 10) {
        final bw = w * (0.05 + rnd.nextDouble() * (0.07 + layer * 0.02));
        final bh = maxH * (0.35 + rnd.nextDouble() * 0.65);
        final r = Rect.fromLTWH(x, base - bh, bw, bh + h);
        canvas.drawRRect(
          RRect.fromRectAndCorners(
            r,
            topLeft: const Radius.circular(2),
            topRight: const Radius.circular(2),
          ),
          paint,
        );
        if (tone.windows != null && layer == 2) {
          final wp = Paint()..color = tone.windows!.withValues(alpha: 0.85);
          for (var wy = base - bh + 8; wy < base - 6; wy += 9) {
            for (var wx = x + 5; wx < x + bw - 5; wx += 7) {
              if (rnd.nextDouble() < 0.28) {
                canvas.drawRect(Rect.fromLTWH(wx, wy, 2.6, 3.4), wp);
              }
            }
          }
        }
        x += bw + rnd.nextDouble() * 6;
      }
      if (layer == 1) {
        if (landmark == 0) _spire(canvas, size, horizon, tone);
        if (landmark == 1) _bridge(canvas, size, horizon, tone);
        if (landmark == 3) _wheel(canvas, size, horizon, tone);
      }
    }

    // Water with stretched reflections.
    final waterTop = horizon + h * 0.06;
    canvas.drawRect(
      Rect.fromLTWH(0, waterTop, w, h - waterTop),
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            tone.layers[2],
            Color.lerp(tone.layers[2], Colors.black, 0.35)!,
          ],
        ).createShader(Rect.fromLTWH(0, waterTop, w, h - waterTop)),
    );
    final glint = Paint()..color = tone.sun.withValues(alpha: 0.35);
    for (var i = 0; i < 14; i++) {
      final y = waterTop + 4 + i * (h - waterTop) / 14;
      final len = (14 - i) * 3.0 + rnd.nextDouble() * 18;
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromCenter(center: Offset(sunC.dx, y), width: len, height: 1.6),
          const Radius.circular(1),
        ),
        glint,
      );
    }
  }

  void _mountains(Canvas c, Size s, double horizon, _Tone t, math.Random rnd) {
    final p = Path()..moveTo(0, horizon);
    var x = 0.0;
    while (x < s.width) {
      final peak = horizon - s.height * (0.18 + rnd.nextDouble() * 0.22);
      p.lineTo(x + s.width * 0.12, peak);
      x += s.width * 0.24;
      p.lineTo(x, horizon - s.height * 0.05);
    }
    p
      ..lineTo(s.width, horizon)
      ..close();
    c.drawPath(p, Paint()..color = Color.lerp(t.layers[0], t.sky.last, 0.45)!);
  }

  void _spire(Canvas c, Size s, double horizon, _Tone t) {
    final x = s.width * 0.68;
    final top = horizon - s.height * 0.62;
    final p = Path()
      ..moveTo(x, top)
      ..lineTo(x + 7, horizon - s.height * 0.32)
      ..lineTo(x + 14, horizon)
      ..lineTo(x - 14, horizon)
      ..lineTo(x - 7, horizon - s.height * 0.32)
      ..close();
    c.drawPath(p, Paint()..color = t.layers[1]);
    c.drawCircle(
      Offset(x, horizon - s.height * 0.40),
      9,
      Paint()..color = t.layers[1],
    );
  }

  void _bridge(Canvas c, Size s, double horizon, _Tone t) {
    final paint = Paint()
      ..color = t.layers[1]
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3;
    final y = horizon + s.height * 0.03;
    final towers = [s.width * 0.25, s.width * 0.75];
    for (final x in towers) {
      c.drawLine(
        Offset(x, y),
        Offset(x, horizon - s.height * 0.34),
        paint..strokeWidth = 6,
      );
    }
    paint.strokeWidth = 2;
    final cable = Path()
      ..moveTo(0, horizon - s.height * 0.12)
      ..quadraticBezierTo(
        towers[0] * 0.6,
        horizon - s.height * 0.05,
        towers[0],
        horizon - s.height * 0.34,
      )
      ..quadraticBezierTo(
        s.width / 2,
        horizon - s.height * 0.02,
        towers[1],
        horizon - s.height * 0.34,
      )
      ..quadraticBezierTo(
        s.width - (s.width - towers[1]) * 0.6,
        horizon - s.height * 0.05,
        s.width,
        horizon - s.height * 0.12,
      );
    c.drawPath(cable, paint);
    c.drawLine(Offset(0, y), Offset(s.width, y), paint..strokeWidth = 5);
  }

  void _wheel(Canvas c, Size s, double horizon, _Tone t) {
    final r = s.height * 0.22;
    final center = Offset(s.width * 0.3, horizon - r - 4);
    final paint = Paint()
      ..color = t.layers[1]
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.4;
    c.drawCircle(center, r, paint);
    for (var i = 0; i < 12; i++) {
      final a = i * math.pi / 6;
      c.drawLine(
        center,
        center + Offset(math.cos(a), math.sin(a)) * r,
        paint..strokeWidth = 1.2,
      );
    }
    c.drawLine(
      center,
      Offset(center.dx - r * 0.5, horizon),
      paint..strokeWidth = 3,
    );
    c.drawLine(center, Offset(center.dx + r * 0.5, horizon), paint);
  }

  @override
  bool shouldRepaint(_CityPainter old) => old.exit.id != exit.id;
}

/// Media card with the reference's corner tab. The photo is painted; the
/// tab is its own target (select), the card body opens the city.
class MediaCard extends StatelessWidget {
  const MediaCard({
    super.key,
    required this.exit,
    required this.onOpen,
    this.onTab,
    this.tabLabel,
    this.tabActive = false,
    this.height = 180,
    this.big = false,
  });

  final Exit exit;
  final VoidCallback onOpen;
  final VoidCallback? onTab;
  final String? tabLabel;
  final bool tabActive;
  final double height;
  final bool big;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onOpen,
      label: 'Open ${exit.city}',
      radius: PRadius.media,
      shadow: true,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(PRadius.media),
        child: SizedBox(
          height: height,
          child: Stack(
            fit: StackFit.expand,
            children: [
              CityArt(exit: exit),
              const DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [
                      Color(0x8814284B),
                      Color(0x0014284B),
                      Color(0x0014284B),
                      Color(0x9914284B),
                    ],
                    stops: [0, 0.42, 0.55, 1],
                  ),
                ),
              ),
              Positioned(
                left: 20,
                right: 20,
                top: big ? null : 20,
                bottom: big ? 64 : null,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      exit.city,
                      style: (big ? PType.h1 : PType.h2)(color: Colors.white),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${exit.ping} ms  ·  ${exit.load}% load',
                      style: PType.meta(
                        color: Colors.white.withValues(alpha: 0.85),
                      ),
                    ),
                  ],
                ),
              ),
              if (tabLabel != null)
                Positioned(
                  left: 0,
                  bottom: 0,
                  child: CornerTab(
                    label: tabLabel!,
                    active: tabActive,
                    onTap: onTab,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The white tab notched into a media card's bottom-left corner.
class CornerTab extends StatelessWidget {
  const CornerTab({
    super.key,
    required this.label,
    this.onTap,
    this.active = false,
  });
  final String label;
  final VoidCallback? onTap;
  final bool active;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      label: label,
      radius: 0,
      child: Container(
        height: 48,
        padding: const EdgeInsets.only(left: 20, right: 22),
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.only(topRight: Radius.circular(22)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (active) ...[
              const PIconView(PIcon.check, size: 16, color: PColors.blue),
              const SizedBox(width: 6),
            ],
            Text(
              label.toUpperCase(),
              style: PType.button(color: active ? PColors.blue : PColors.ink),
            ),
          ],
        ),
      ),
    );
  }
}

/// Small static shard, for places that need one plane, not the field.
class ShardChip extends StatelessWidget {
  const ShardChip({
    super.key,
    required this.color,
    this.width = 40,
    this.height = 56,
  });
  final Color color;
  final double width, height;

  @override
  Widget build(BuildContext context) => CustomPaint(
    size: Size(width + height * 0.56, height),
    painter: _ShardChipPainter(color, width),
  );
}

class _ShardChipPainter extends CustomPainter {
  _ShardChipPainter(this.color, this.w);
  final Color color;
  final double w;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawPath(
      shardPath(size.center(Offset.zero), w, size.height, 0.56),
      Paint()..color = color,
    );
  }

  @override
  bool shouldRepaint(_ShardChipPainter old) => old.color != color;
}

/// Two-letter region badge drawn as a tiny shard, not a flag.
class RegionBadge extends StatelessWidget {
  const RegionBadge(this.exit, {super.key, this.size = 44});
  final Exit exit;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = PColors.planes[exit.seed % 3];
    final ink = c == PColors.ice ? PColors.navy : Colors.white;
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        alignment: Alignment.center,
        children: [
          CustomPaint(
            size: Size.square(size),
            painter: _ShardChipPainter(c, size * 0.58),
          ),
          Text(
            exit.code,
            style: PType.meta(color: ink).copyWith(fontWeight: FontWeight.w800),
          ),
        ],
      ),
    );
  }
}

/// The trial / offer card from the reference's discount anatomy.
class OfferCard extends StatelessWidget {
  const OfferCard({
    super.key,
    required this.big,
    required this.unit,
    required this.footer,
    this.title,
    this.trailing,
  });

  final String big, unit, footer;
  final String? title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: PColors.navy,
        borderRadius: BorderRadius.circular(PRadius.card),
        boxShadow: PShadow.soft(),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(PRadius.card),
        child: Stack(
          children: [
            Positioned(
              right: -30,
              top: -20,
              child: Opacity(
                opacity: 0.9,
                child: ShardChip(color: PColors.blue, width: 70, height: 130),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 22, 24, 18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (title != null)
                    Text(title!, style: PType.h3(color: Colors.white)),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Text(big, style: PType.display(64, color: Colors.white)),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          unit,
                          style: PType.h3(color: Colors.white)
                              .copyWith(height: 1.05),
                        ),
                      ),
                      ?trailing,
                    ],
                  ),
                  const SizedBox(height: 14),
                  const _Perforation(),
                  const SizedBox(height: 12),
                  Text(
                    footer,
                    style: PType.small(
                      color: Colors.white.withValues(alpha: 0.72),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Perforation extends StatelessWidget {
  const _Perforation();
  @override
  Widget build(BuildContext context) => CustomPaint(
    size: const Size(double.infinity, 2),
    painter: _PerfPainter(),
  );
}

class _PerfPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = Colors.white.withValues(alpha: 0.25)
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round;
    for (var x = 0.0; x < size.width; x += 9) {
      canvas.drawLine(Offset(x, 1), Offset(math.min(x + 4, size.width), 1), p);
    }
  }

  @override
  bool shouldRepaint(_PerfPainter old) => false;
}
