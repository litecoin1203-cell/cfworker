import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'geometry.dart';
import 'clouds.dart';
import 'tokens.dart';

/// One shard's resting place, in fractions of the field.
@immutable
class ShardSpec {
  const ShardSpec(this.cx, this.cy, this.w, this.h, {this.depth = 1});
  final double cx, cy, w, h;

  /// Parallax depth: how much of the scroll this shard follows.
  final double depth;

  static ShardSpec lerp(ShardSpec a, ShardSpec b, double t) => ShardSpec(
    lerpD(a.cx, b.cx, t),
    lerpD(a.cy, b.cy, t),
    lerpD(a.w, b.w, t),
    lerpD(a.h, b.h, t),
    depth: lerpD(a.depth, b.depth, t),
  );

  @override
  bool operator ==(Object other) =>
      other is ShardSpec &&
      other.cx == cx &&
      other.cy == cy &&
      other.w == w &&
      other.h == h &&
      other.depth == depth;

  @override
  int get hashCode => Object.hash(cx, cy, w, h, depth);
}

/// Everything the field reacts to. Screens never paint shards directly;
/// they change the scene and the field travels to it.
@immutable
class ShardScene {
  const ShardScene({
    required this.layout,
    List<Color>? mix,
    this.focus = const Offset(0.5, 0.42),
    this.lean = 0,
    this.pull = 0,
    this.rest = 0,
    this.armed = 1,
    this.alert = 0,
  }) : _mix = mix;

  final List<ShardSpec> layout;
  final List<Color>? _mix;
  List<Color> get mix => _mix ?? PColors.planes;

  /// Where handshake pulls the shards to (the connect control).
  final Offset focus;

  /// -1 … 1, toward the selected region's side of the map.
  final double lean;

  /// 0 … 1 handshake contraction.
  final double pull;

  /// 0 … 1, protected: the drift settles.
  final double rest;

  /// 1 when the kill switch is armed: steep, closed formation.
  final double armed;

  /// 0 … 1, red edge for a dropped tunnel or a disarmed kill switch.
  final double alert;

  ShardScene copyWith({
    List<ShardSpec>? layout,
    List<Color>? mix,
    Offset? focus,
    double? lean,
    double? pull,
    double? rest,
    double? armed,
    double? alert,
  }) => ShardScene(
    layout: layout ?? this.layout,
    mix: mix ?? this.mix,
    focus: focus ?? this.focus,
    lean: lean ?? this.lean,
    pull: pull ?? this.pull,
    rest: rest ?? this.rest,
    armed: armed ?? this.armed,
    alert: alert ?? this.alert,
  );

  @override
  bool operator ==(Object other) =>
      other is ShardScene &&
      listEquals(other.layout, layout) &&
      listEquals(other.mix, mix) &&
      other.focus == focus &&
      other.lean == lean &&
      other.pull == pull &&
      other.rest == rest &&
      other.armed == armed &&
      other.alert == alert;

  @override
  int get hashCode => Object.hash(
    Object.hashAll(layout),
    Object.hashAll(mix),
    focus,
    lean,
    pull,
    rest,
    armed,
    alert,
  );

  static ShardScene lerp(ShardScene a, ShardScene b, double t) => ShardScene(
    layout: [
      for (var i = 0; i < b.layout.length; i++)
        ShardSpec.lerp(
          a.layout[math.min(i, a.layout.length - 1)],
          b.layout[i],
          t,
        ),
    ],
    mix: [
      for (var i = 0; i < b.mix.length; i++)
        Color.lerp(a.mix[math.min(i, a.mix.length - 1)], b.mix[i], t)!,
    ],
    focus: Offset.lerp(a.focus, b.focus, t)!,
    lean: lerpD(a.lean, b.lean, t),
    pull: lerpD(a.pull, b.pull, t),
    rest: lerpD(a.rest, b.rest, t),
    armed: lerpD(a.armed, b.armed, t),
    alert: lerpD(a.alert, b.alert, t),
  );
}

/// The shard field: three or four brand planes that are always on stage.
/// A slow drift loop keeps them alive; scene changes travel over 700ms;
/// scroll drives parallax. The drift moves a few pixels a second, so it is
/// drawn about eight times a second instead of every frame, and only while
/// the field can be seen (the app on screen, the route not covered). Reduced motion freezes drift and travel but the
/// scene still changes.
class ShardField extends StatefulWidget {
  const ShardField({super.key, required this.scene, this.scroll});

  final ShardScene scene;
  final ValueListenable<double>? scroll;

  @override
  State<ShardField> createState() => _ShardFieldState();
}

class _ShardFieldState extends State<ShardField>
    with TickerProviderStateMixin, WidgetsBindingObserver {
  /// One drift loop, and how often the drift is drawn.
  static const _loop = Duration(seconds: 18);
  static const driftStep = Duration(milliseconds: 125);

  /// 0 … 1 through the loop; moves only on [driftStep] ticks.
  final _drift = ValueNotifier<double>(0);
  Timer? _driftTick;
  bool _visible = true, _shown = true;
  late final AnimationController _travel = AnimationController(
    vsync: this,
    duration: PMotion.scene,
    value: 1,
  );
  late ShardScene _from = widget.scene;
  late ShardScene _to = widget.scene;
  static final _zero = ValueNotifier<double>(0);

  ShardScene get _current => ShardScene.lerp(
    _from,
    _to,
    Curves.easeInOutCubic.transform(_travel.value),
  );

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final now = WidgetsBinding.instance.lifecycleState;
    _shown = now == null || onScreen(now);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // False under a covering route; also a dependency, so this runs again
    // when it changes.
    _visible = TickerMode.valuesOf(context).enabled;
    _syncDrift();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    _shown = onScreen(s);
    _syncDrift();
  }

  void _syncDrift() {
    final run = _visible && _shown && !PMotion.reduced(context);
    if (run && _driftTick == null) {
      _driftTick = Timer.periodic(driftStep, (_) {
        _drift.value =
            (_drift.value + driftStep.inMicroseconds / _loop.inMicroseconds) %
            1;
      });
    } else if (!run) {
      _driftTick?.cancel();
      _driftTick = null;
    }
  }

  @override
  void didUpdateWidget(ShardField old) {
    super.didUpdateWidget(old);
    if (old.scene != widget.scene) {
      _from = _current;
      _to = widget.scene;
      if (PMotion.reduced(context)) {
        _travel.value = 1;
      } else {
        _travel.forward(from: 0);
      }
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _driftTick?.cancel();
    _drift.dispose();
    _travel.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scroll = widget.scroll ?? _zero;
    return RepaintBoundary(
      child: CustomPaint(
        size: Size.infinite,
        painter: _ShardPainter(
          drift: _drift,
          travel: _travel,
          scroll: scroll,
          scene: () => _current,
        ),
      ),
    );
  }
}

class _ShardPainter extends CustomPainter {
  _ShardPainter({
    required this.drift,
    required this.travel,
    required this.scroll,
    required this.scene,
  }) : super(repaint: Listenable.merge([drift, travel, scroll]));

  final ValueListenable<double> drift;
  final Animation<double> travel;
  final ValueListenable<double> scroll;
  final ShardScene Function() scene;

  @override
  void paint(Canvas canvas, Size size) {
    PClouds.paint(canvas, size);
    paintShards(canvas, size, scene(), drift.value, scroll.value);
  }

  @override
  bool shouldRepaint(_ShardPainter old) => true;
}

/// Shared by the field, the tunnel transition and the instrument crop so a
/// shard is the same shape everywhere it appears.
List<Path> shardPaths(Size size, ShardScene s, double t, double scrollPx) {
  final paths = <Path>[];
  final amp = 1 - s.rest * 0.8;
  for (var i = 0; i < s.layout.length; i++) {
    final spec = s.layout[i];
    final phase = t * 2 * math.pi + i * 1.7;
    var cx =
        spec.cx + s.lean * 0.07 * spec.depth + math.sin(phase) * 0.014 * amp;
    var cy = spec.cy + math.cos(phase * 0.8) * 0.010 * amp;
    // Disarmed: the formation opens away from the focus.
    final open = (1 - s.armed) * 0.05 * (cx < s.focus.dx ? -1 : 1);
    cx += open;
    // Handshake: everything is drawn toward the connect control.
    cx = lerpD(cx, s.focus.dx, s.pull * 0.42);
    cy = lerpD(cy, s.focus.dy, s.pull * 0.42);
    final w = spec.w * size.width * (1 - 0.22 * s.pull);
    final h = spec.h * size.height * (1 - 0.18 * s.pull);
    final slant = 0.56 + s.lean * 0.14 + s.armed * 0.1;
    final c = Offset(
      cx * size.width,
      cy * size.height - scrollPx * 0.3 * spec.depth,
    );
    paths.add(shardPath(c, w, h, slant));
  }
  return paths;
}

void paintShards(
  Canvas canvas,
  Size size,
  ShardScene s,
  double t,
  double scrollPx,
) {
  final paths = shardPaths(size, s, t, scrollPx);
  for (var i = 0; i < paths.length; i++) {
    canvas.drawPath(paths[i], Paint()..color = s.mix[i % s.mix.length]);
  }
  if (s.alert > 0.01 && paths.length > 1) {
    canvas.drawPath(
      paths[1],
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3
        ..color = PColors.alert.withValues(alpha: s.alert),
    );
  }
}
