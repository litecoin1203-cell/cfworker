import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../state/exits.dart';
import 'geometry.dart';
import 'icons.dart';
import 'tokens.dart';
import 'widgets.dart';

/// Generated city "photography": a sky, a seeded skyline in three depths,
/// one landmark, water with reflections. Painted on device, original, and
/// tuned to sit inside the brand blues.
class CityArt extends StatelessWidget {
  CityArt({super.key, required Exit exit}) : seed = exit.seed, tone = exit.tone;

  /// A scene that belongs to no exit, for onboarding.
  const CityArt.scene({super.key, required this.seed, required this.tone});

  final int seed;
  final SceneTone tone;

  @override
  Widget build(BuildContext context) => RepaintBoundary(
    child: CustomPaint(painter: _CityPainter(seed, tone), size: Size.infinite),
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
  _CityPainter(this.seed, this.toneId);
  final int seed;
  final SceneTone toneId;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    final tone = _tones[toneId]!;
    final rnd = math.Random(seed);
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

    if (toneId == SceneTone.night) {
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
    final landmark = seed % 4;
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
  bool shouldRepaint(_CityPainter old) =>
      old.seed != seed || old.toneId != toneId;
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
    this.note,
  });

  final Exit exit;
  final VoidCallback onOpen;
  final VoidCallback? onTab;
  final String? tabLabel;
  final bool tabActive;
  final double height;
  final bool big;

  /// A short bold line under the facts, e.g. "Strong on Irancell".
  final String? note;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onOpen,
      label: 'Open ${exit.title}, ${exit.label}',
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
                    Row(
                      children: [
                        RegionBadge(exit, size: big ? 40 : 32),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            exit.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: (big ? PType.h1 : PType.h2)(
                              color: Colors.white,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      exit.meta,
                      style: PType.meta(
                        color: Colors.white.withValues(alpha: 0.85),
                      ),
                    ),
                    if (note != null) ...[
                      const SizedBox(height: 4),
                      Text(
                        note!,
                        style: PType.meta(color: Colors.white)
                            .copyWith(fontWeight: FontWeight.w700),
                      ),
                    ],
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

/// The exit's flag as a coin: the remark's country flag fills a circle,
/// a translucent fold crosses it like the mark's planes, and a white ring
/// sets it on photos and cards alike. No country: a mist coin with a globe.
class RegionBadge extends StatelessWidget {
  const RegionBadge(this.exit, {super.key, this.size = 44, this.ring});
  final Exit exit;
  final double size;

  /// The coin's rim; white unless a speed tints it (see [SpeedBadge]).
  final Color? ring;

  @override
  Widget build(BuildContext context) {
    final flag = exit.flag;
    return Semantics(
      label: exit.code.isEmpty ? 'Unknown country' : '${exit.title} flag',
      child: ExcludeSemantics(
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: PColors.mist,
            border: Border.all(
              color: ring ?? Colors.white,
              width: size * (ring == null ? 0.07 : 0.09),
            ),
            boxShadow: [
              BoxShadow(
                color: PColors.navy.withValues(alpha: 0.16),
                blurRadius: size * 0.3,
                offset: Offset(0, size * 0.08),
              ),
            ],
          ),
          child: ClipOval(
            child: flag.isEmpty
                ? Center(
                    child: PIconView(
                      PIcon.globe,
                      size: size * 0.5,
                      color: PColors.blue,
                    ),
                  )
                : Stack(
                    fit: StackFit.expand,
                    children: [
                      // A flag glyph is about 4:3; set it tall enough to
                      // cover the coin, then crop.
                      OverflowBox(
                        maxWidth: size * 2,
                        maxHeight: size * 2,
                        child: Text(
                          flag,
                          textScaler: TextScaler.noScaling,
                          style: TextStyle(
                            fontSize: size * 1.08,
                            height: 1,
                            fontFamilyFallback: PType.emojiFallback,
                          ),
                        ),
                      ),
                      CustomPaint(painter: _FoldPainter()),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}

/// The country coin that also shows the exit's download speed here: its
/// rim turns bright blue (fast), ice (fair) or grey (slow), and a light
/// shard sweeps across it, quicker on a faster exit. While the test runs
/// the rim breathes in ice. Untested exits show the plain coin.
class SpeedBadge extends StatefulWidget {
  const SpeedBadge(this.exit, {super.key, this.size = 44});
  final Exit exit;
  final double size;

  static Color? ringOf(Exit e) {
    if (e.speedTesting) return PColors.ice;
    return switch (e.speed) {
      Speed.fast => PColors.blue,
      Speed.fair => PColors.ice,
      Speed.slow => PColors.muted.withValues(alpha: 0.55),
      null => null,
    };
  }

  static Duration beatOf(Exit e) => e.speedTesting
      ? const Duration(milliseconds: 1100)
      : switch (e.speed) {
          Speed.fast => const Duration(milliseconds: 1300),
          Speed.fair => const Duration(milliseconds: 2400),
          _ => const Duration(milliseconds: 4200),
        };

  @override
  State<SpeedBadge> createState() => _SpeedBadgeState();
}

class _SpeedBadgeState extends State<SpeedBadge>
    with SingleTickerProviderStateMixin {
  late final AnimationController _t = AnimationController(
    vsync: this,
    duration: SpeedBadge.beatOf(widget.exit),
  );

  bool get _live => widget.exit.speedTesting || widget.exit.speed != null;

  @override
  void didUpdateWidget(SpeedBadge old) {
    super.didUpdateWidget(old);
    _t.duration = SpeedBadge.beatOf(widget.exit);
    _sync();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  void _sync() {
    final still = MediaQuery.of(context).disableAnimations;
    if (_live && !still) {
      if (!_t.isAnimating) _t.repeat();
    } else {
      _t.stop();
    }
  }

  @override
  void dispose() {
    _t.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final e = widget.exit;
    final ring = SpeedBadge.ringOf(e);
    final badge = RegionBadge(e, size: widget.size, ring: ring);
    if (!_live) return badge;
    final word = e.speedTesting ? 'testing speed' : '${e.speed!.word} speed';
    return Semantics(
      label: word,
      child: AnimatedBuilder(
        animation: _t,
        builder: (context, child) => Stack(
          children: [
            child!,
            Positioned.fill(
              child: IgnorePointer(
                child: ClipOval(
                  child: CustomPaint(
                    painter: _SweepPainter(
                      _t.value,
                      testing: e.speedTesting,
                      slow: e.speed == Speed.slow,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
        child: badge,
      ),
    );
  }
}

/// A white shard crossing the coin once per beat; a slow exit's is faint,
/// and while testing the whole coin glows on and off instead.
class _SweepPainter extends CustomPainter {
  _SweepPainter(this.t, {required this.testing, required this.slow});
  final double t;
  final bool testing, slow;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    if (testing) {
      final a = 0.08 + 0.22 * (0.5 - 0.5 * math.cos(t * 2 * math.pi));
      canvas.drawCircle(
        Offset(w / 2, w / 2),
        w / 2,
        Paint()..color = PColors.ice.withValues(alpha: a),
      );
      return;
    }
    // Crosses in the first 60% of the beat, then rests.
    final p = (t / 0.6).clamp(0.0, 1.0);
    if (p >= 1) return;
    final x = -w * 0.4 + p * w * 1.8;
    canvas.drawPath(
      shardPath(Offset(x, w * 0.5), w * 0.22, w * 1.4, 0.56),
      Paint()..color = Colors.white.withValues(alpha: slow ? 0.25 : 0.55),
    );
  }

  @override
  bool shouldRepaint(_SweepPainter old) =>
      old.t != t || old.testing != testing || old.slow != slow;
}

class _FoldPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    canvas.drawPath(
      shardPath(Offset(w * 0.78, w * 0.5), w * 0.22, w * 1.3, 0.56),
      Paint()..color = Colors.white.withValues(alpha: 0.22),
    );
  }

  @override
  bool shouldRepaint(_FoldPainter old) => false;
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
