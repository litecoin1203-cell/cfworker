import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/scenes.dart';
import '../design/shard_field.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/exits.dart';
import 'login.dart';

class _Beat {
  const _Beat(this.light, this.bold, this.seed, this.tone);
  final String light, bold;
  final int seed;
  final SceneTone tone;
}

const _beats = [
  _Beat('Your Cloud Gold', 'account, on Pleat', 11, SceneTone.dusk),
  _Beat('Every exit', 'flagged by country', 37, SceneTone.dawn),
  _Beat('Your plan and usage', 'always in view', 83, SceneTone.night),
];

/// Three beats around one circular scene that never leaves. Orbit bubbles
/// swap icons every 900ms, the metric disk trades "28 ms" for "AES-256",
/// and a beat change shifts the shards and wipes the headline.
class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen>
    with SingleTickerProviderStateMixin {
  int _beat = 0;
  int _tick = 0;
  Timer? _timer;
  late final AnimationController _orbit = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 26),
  );

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(PMotion.orbitTick, (_) => setState(() => _tick++));
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (PMotion.reduced(context)) {
      _orbit.stop();
    } else if (!_orbit.isAnimating) {
      _orbit.repeat();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _orbit.dispose();
    super.dispose();
  }

  void _go(int i) {
    if (i < 0 || i >= _beats.length) return;
    setState(() => _beat = i);
  }

  void _next() {
    if (_beat < _beats.length - 1) {
      _go(_beat + 1);
    } else {
      AppScope.read(context).finishOnboarding();
      Navigator.of(context)
          .pushReplacement(FadeRoute(builder: (_) => const LoginScreen()));
    }
  }

  @override
  Widget build(BuildContext context) {
    final beat = _beats[_beat];
    final reduced = PMotion.reduced(context);
    return Scaffold(
      backgroundColor: PColors.ground,
      body: GestureDetector(
        onHorizontalDragEnd: (d) {
          final v = d.primaryVelocity ?? 0;
          if (v < -200) _next();
          if (v > 200) _go(_beat - 1);
        },
        child: Stack(
          fit: StackFit.expand,
          children: [
            ShardField(
              scene: ShardScene(
                layout: Layouts.onboarding[_beat],
                lean: _beat == 2 ? 0.6 : (_beat == 1 ? -0.3 : 0),
              ),
            ),
            SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(28, 24, 28, 24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text('Pleat', style: PType.h3()),
                        const Spacer(),
                        Pressable(
                          onTap: () {
                            AppScope.read(context).finishOnboarding();
                            Navigator.of(context).pushReplacement(
                              FadeRoute(builder: (_) => const LoginScreen()),
                            );
                          },
                          label: 'Skip',
                          radius: 20,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 14,
                            ),
                            child: Text('Skip', style: PType.small()),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 28),
                    _Wipe(
                      key: ValueKey(_beat),
                      reduced: reduced,
                      child: Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(
                              text: '${beat.light}\n',
                              style: PType.light(36),
                            ),
                            TextSpan(
                              text: beat.bold,
                              style: PType.light(36)
                                  .copyWith(fontWeight: FontWeight.w800),
                            ),
                          ],
                        ),
                      ),
                    ),
                    Expanded(
                      child: Center(
                        child: _OrbitScene(
                          art: beat,
                          tick: _tick,
                          orbit: _orbit,
                          beat: _beat,
                        ),
                      ),
                    ),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        for (var i = 0; i < _beats.length; i++)
                          AnimatedContainer(
                            duration: PMotion.quick,
                            margin: const EdgeInsets.symmetric(horizontal: 4),
                            width: i == _beat ? 22 : 7,
                            height: 7,
                            decoration: BoxDecoration(
                              color: i == _beat ? PColors.blue : PColors.ice,
                              borderRadius: BorderRadius.circular(4),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 24),
                    PillButton(
                      label: _beat == _beats.length - 1 ? 'Start' : 'Next',
                      onTap: _next,
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Headline wipe: the new line is revealed left to right.
class _Wipe extends StatelessWidget {
  const _Wipe({super.key, required this.child, required this.reduced});
  final Widget child;
  final bool reduced;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: reduced ? 1 : 0, end: 1),
      duration: const Duration(milliseconds: 520),
      curve: Curves.easeOutCubic,
      builder: (context, t, child) => ClipRect(
        child: Align(
          alignment: Alignment.centerLeft,
          widthFactor: 1,
          child: ShaderMask(
            blendMode: BlendMode.dstIn,
            shaderCallback: (r) => LinearGradient(
              colors: const [Colors.black, Colors.black, Colors.transparent],
              stops: [0, t, (t + 0.08).clamp(0, 1)],
            ).createShader(r),
            child: child,
          ),
        ),
      ),
      child: child,
    );
  }
}

const _bubbleIcons = [
  [PIcon.shield, PIcon.lock, PIcon.check],
  [PIcon.globe, PIcon.pin, PIcon.near],
  [PIcon.wifi, PIcon.bolt, PIcon.route],
];

class _OrbitScene extends StatelessWidget {
  const _OrbitScene({
    required this.art,
    required this.tick,
    required this.orbit,
    required this.beat,
  });
  final _Beat art;
  final int tick;
  final Animation<double> orbit;
  final int beat;

  @override
  Widget build(BuildContext context) {
    const d = 230.0;
    final metricA = tick ~/ 2 % 2 == 0;
    return SizedBox(
      width: d + 80,
      height: d + 80,
      child: AnimatedBuilder(
        animation: orbit,
        builder: (context, _) {
          final a = orbit.value * 2 * math.pi;
          Offset at(double angle, double r) =>
              Offset(math.cos(angle), math.sin(angle)) * r;
          final bubbles = [
            (at(a + 2.4, d / 2 + 6), PColors.navy, Colors.white, 0),
            (at(a + 0.35, d / 2 + 4), Colors.white, PColors.blue, 1),
            (at(a + 1.45, d / 2 + 2), Colors.white, PColors.navy, 2),
          ];
          return Stack(
            alignment: Alignment.center,
            clipBehavior: Clip.none,
            children: [
              Container(
                width: d + 22,
                height: d + 22,
                decoration: BoxDecoration(
                  color: Colors.white,
                  shape: BoxShape.circle,
                  boxShadow: PShadow.soft(),
                ),
              ),
              ClipOval(
                child: SizedBox.square(
                  dimension: d,
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 450),
                    child: CityArt.scene(
                      key: ValueKey(art.seed),
                      seed: art.seed,
                      tone: art.tone,
                    ),
                  ),
                ),
              ),
              for (final (o, bg, fg, i) in bubbles)
                Transform.translate(
                  offset: o,
                  child: Container(
                    width: 56,
                    height: 56,
                    decoration: BoxDecoration(
                      color: bg,
                      shape: BoxShape.circle,
                      boxShadow: PShadow.soft(),
                    ),
                    alignment: Alignment.center,
                    child: AnimatedSwitcher(
                      duration: const Duration(milliseconds: 300),
                      transitionBuilder: (c, an) => FadeTransition(
                        opacity: an,
                        child: ScaleTransition(scale: an, child: c),
                      ),
                      child: PIconView(
                        _bubbleIcons[(i + beat) % 3][(tick + i) % 3],
                        key: ValueKey('$i-${(tick + i) % 3}-$beat'),
                        color: fg,
                      ),
                    ),
                  ),
                ),
              // Disk, swapped like the reference's weather reading. It names
              // what Pleat shows, not a measured figure.
              Transform.translate(
                offset: const Offset(-d / 2 + 24, -d / 2 + 26),
                child: Container(
                  width: 92,
                  height: 92,
                  decoration: BoxDecoration(
                    color: PColors.blue,
                    shape: BoxShape.circle,
                    boxShadow: PShadow.lift,
                  ),
                  clipBehavior: Clip.antiAlias,
                  alignment: Alignment.center,
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 360),
                    // Incoming reading rises in, the old one leaves upward.
                    transitionBuilder: (c, an) {
                      final incoming = c.key == ValueKey(metricA);
                      return FadeTransition(
                        opacity: an,
                        child: SlideTransition(
                          position: Tween(
                            begin: Offset(0, incoming ? 0.6 : -0.6),
                            end: Offset.zero,
                          ).animate(an),
                          child: c,
                        ),
                      );
                    },
                    child: Column(
                      key: ValueKey(metricA),
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          metricA ? 'Exits' : 'Usage',
                          style: PType.meta(
                            color: Colors.white.withValues(alpha: 0.8),
                          ),
                        ),
                        Text(
                          metricA ? 'Flags' : 'Live',
                          style: PType.h3(color: Colors.white)
                              .copyWith(fontSize: 19),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
