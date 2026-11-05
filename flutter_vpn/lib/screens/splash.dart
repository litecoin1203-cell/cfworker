import 'package:flutter/material.dart';

import '../design/mark.dart';
import '../design/scenes.dart';
import '../design/shard_field.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../state/app_state.dart';
import 'login.dart';
import 'onboarding.dart';
import 'shell.dart';

/// Splash: the mark draws on in a blue stroke, its second plane follows a
/// beat later, the name arrives, and the shards are already moving.
class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1500),
  );
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (PMotion.reduced(context)) {
      _c.value = 1;
      Future.delayed(const Duration(milliseconds: 600), _next);
    } else {
      _c.forward().whenComplete(
        () => Future.delayed(const Duration(milliseconds: 450), _next),
      );
    }
  }

  void _next() {
    if (!mounted) return;
    final app = AppScope.read(context);
    final Widget next = !app.onboarded
        ? const OnboardingScreen()
        : (app.signedIn ? const Shell() : const LoginScreen());
    Navigator.of(context).pushReplacement(FadeRoute(builder: (_) => next));
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  double _iv(double a, double b) => Curves.easeInOutCubic.transform(
    ((_c.value - a) / (b - a)).clamp(0.0, 1.0),
  );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: PColors.ground,
      body: Stack(
        fit: StackFit.expand,
        children: [
          const ShardField(
            scene: ShardScene(layout: Layouts.splash, focus: Offset(0.5, 0.48)),
          ),
          Center(
            child: Container(
              width: 220,
              height: 260,
              decoration: BoxDecoration(
                color: PColors.surface,
                borderRadius: BorderRadius.circular(PRadius.sheet),
                boxShadow: PShadow.soft(),
              ),
              child: AnimatedBuilder(
                animation: _c,
                builder: (context, _) => Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    CustomPaint(
                      size: const Size.square(96),
                      painter: MarkPainter(
                        drawBack: _iv(0.0, 0.42),
                        drawFront: _iv(0.18, 0.60),
                        fill: _iv(0.55, 0.75),
                      ),
                    ),
                    const SizedBox(height: 18),
                    Opacity(
                      opacity: _iv(0.62, 0.9),
                      child: Transform.translate(
                        offset: Offset(0, 10 * (1 - _iv(0.62, 0.9))),
                        child: Text('Pleat', style: PType.h1()),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
