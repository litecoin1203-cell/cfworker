import 'dart:async';

import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/connect_control.dart';
import '../design/geometry.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/seed.dart';
import 'location_detail.dart';
import 'profile.dart';
import 'shell.dart';

enum _HomeTab { now, route, stats }

/// Home: the greeting, three instrument tabs, one display-size number
/// cropped by a shard, and the connect control standing in the field.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  _HomeTab _tab = _HomeTab.now;
  Timer? _clock;

  @override
  void initState() {
    super.initState();
    _clock = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && AppScope.read(context).phase == Phase.protected) {
        setState(() {});
      }
    });
  }

  @override
  void dispose() {
    _clock?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final picks = [...exits]..sort((a, b) => a.ping.compareTo(b.ping));
    final recommended = picks.where((e) => e.id != app.exitId).take(4).toList();

    return SafeArea(
      bottom: false,
      child: ParallaxScroll(
        child: ListView(
          padding: const EdgeInsets.only(bottom: 130),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 12, 0),
              child: _Header(app: app),
            ),
            const SizedBox(height: 14),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: _Tabs(
                value: _tab,
                onChanged: (t) => setState(() => _tab = t),
              ),
            ),
            const SizedBox(height: 18),
            _Instrument(app: app, tab: _tab),
            // The control stands in the shard field and overlaps the crop.
            Transform.translate(
              offset: const Offset(0, -40),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Align(
                    alignment: const Alignment(0.62, 0),
                    child: ConnectControl(
                      phase: app.phase,
                      onTap: app.primaryAction,
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 0, 20, 0),
                    child: _StageLine(app: app),
                  ),
                ],
              ),
            ),
            if (_tab != _HomeTab.now)
              Transform.translate(
                offset: const Offset(0, -34),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: SurfaceCard(
                    padding: const EdgeInsets.fromLTRB(20, 18, 20, 14),
                    child: _tab == _HomeTab.route
                        ? _RouteLine(
                            exit: app.exit,
                            live: app.phase == Phase.protected,
                          )
                        : _WeekBars(app: app),
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 4),
              child: SectionLabel(
                'Recommended exits',
                trailing: 'See all',
                onTrailing: () => app.setTab(2),
              ),
            ),
            SizedBox(
              height: 168,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                itemCount: recommended.length,
                separatorBuilder: (_, _) => const SizedBox(width: 14),
                itemBuilder: (context, i) {
                  final e = recommended[i];
                  return StaggerIn(
                    index: i,
                    child: SizedBox(
                      width: 210,
                      child: MediaCard(
                        exit: e,
                        height: 150,
                        onOpen: () => Navigator.of(context).push(
                          TunnelRoute(
                            builder: (_) => LocationDetail(exitId: e.id),
                          ),
                        ),
                        tabLabel: 'Go',
                        onTab: () => app.connect(e.id),
                      ),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final hour = DateTime.now().hour;
    final hello = hour < 12
        ? 'Good morning'
        : (hour < 18 ? 'Good afternoon' : 'Good evening');
    return Row(
      children: [
        Pressable(
          onTap: () =>
              Navigator.of(context)
                  .push(FadeRoute(builder: (_) => const ProfileScreen())),
          label: 'Profile',
          radius: 30,
          child: Container(
            width: 56,
            height: 56,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: PColors.navy,
              border: Border.all(color: Colors.white, width: 3),
              boxShadow: PShadow.soft(),
            ),
            alignment: Alignment.center,
            child: Text(
              app.firstName.substring(0, 1),
              style: PType.h2(color: Colors.white),
            ),
          ),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '$hello, ${app.firstName}',
                style: PType.h3(),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 3),
              Row(
                children: [
                  const PIconView(PIcon.pin, size: 14, color: PColors.muted),
                  const SizedBox(width: 4),
                  Text('${app.exit.city} exit', style: PType.small()),
                ],
              ),
            ],
          ),
        ),
        RoundIcon(
          PIcon.bell,
          onTap: () => showNotices(context),
          label: 'Notices',
          badge: !app.noticesSeen,
        ),
      ],
    );
  }
}

class _Tabs extends StatelessWidget {
  const _Tabs({required this.value, required this.onChanged});
  final _HomeTab value;
  final ValueChanged<_HomeTab> onChanged;

  static const _items = [
    (_HomeTab.now, PIcon.clock, 'Now'),
    (_HomeTab.route, PIcon.route, 'Route'),
    (_HomeTab.stats, PIcon.chart, 'Stats'),
  ];

  @override
  Widget build(BuildContext context) {
    final i = _HomeTab.values.indexOf(value);
    final d = PMotion.reduced(context) ? Duration.zero : PMotion.quick;
    return LayoutBuilder(
      builder: (context, box) {
        final w = box.maxWidth / 3;
        return SizedBox(
          height: 52,
          child: Stack(
            children: [
              Row(
                children: [
                  for (final (t, icon, label) in _items)
                    Expanded(
                      child: Pressable(
                        onTap: () => onChanged(t),
                        label: label,
                        selected: t == value,
                        radius: 16,
                        child: SizedBox(
                          height: 48,
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              PIconView(
                                icon,
                                size: 20,
                                color: t == value ? PColors.blue : PColors.ink,
                              ),
                              const SizedBox(width: 8),
                              AnimatedDefaultTextStyle(
                                duration: d,
                                style: PType.small(
                                  color: t == value
                                      ? PColors.blue
                                      : PColors.ink,
                                ).copyWith(fontWeight: FontWeight.w700),
                                child: Text(label),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              ),
              AnimatedPositioned(
                duration: d,
                curve: Curves.easeOutBack,
                left: w * i + 18,
                width: w - 36,
                bottom: 0,
                height: 3,
                child: Container(
                  decoration: BoxDecoration(
                    color: PColors.blue,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// The oversized number. A navy shard crosses it; inside the shard the
/// same figure is re-set in white, so the shard reads as cutting the type.
class _Instrument extends StatelessWidget {
  const _Instrument({required this.app, required this.tab});
  final AppState app;
  final _HomeTab tab;

  String _clock(Duration d) {
    final h = d.inHours, m = d.inMinutes % 60, s = d.inSeconds % 60;
    String two(int v) => v.toString().padLeft(2, '0');
    return h > 0 ? '$h:${two(m)}' : '${two(m)}:${two(s)}';
  }

  @override
  Widget build(BuildContext context) {
    final protected = app.phase == Phase.protected;
    final (value, unit, caption) = switch (tab) {
      _HomeTab.now =>
        protected
            ? (
                _clock(app.elapsed),
                app.elapsed.inHours > 0 ? 'h:m' : 'min:s',
                'Session through ${app.exit.city}',
              )
            : (
                '${app.exit.ping}',
                'ms',
                'Ping to ${app.exit.city}, ${app.exit.country}',
              ),
      _HomeTab.route => (
        '3',
        'hops',
        'Phone, Pleat edge, ${app.exit.city} exit',
      ),
      _HomeTab.stats => (
        (app.weekMegabytes / 1024).toStringAsFixed(1),
        'GB',
        'Through the tunnel this week',
      ),
    };

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            caption,
            style: PType.small(color: PColors.ink)
                .copyWith(fontWeight: FontWeight.w600),
          ),
          SizedBox(
            height: 156,
            child: AnimatedSwitcher(
              duration: PMotion.reduced(context)
                  ? Duration.zero
                  : PMotion.quick,
              child: _CroppedNumber(
                key: ValueKey('$tab'),
                value: value,
                unit: unit,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CroppedNumber extends StatelessWidget {
  const _CroppedNumber({super.key, required this.value, required this.unit});
  final String value, unit;

  @override
  Widget build(BuildContext context) {
    Widget layer(Color ink, Color unitInk) => Align(
      alignment: Alignment.bottomLeft,
      child: FittedBox(
        fit: BoxFit.scaleDown,
        alignment: Alignment.bottomLeft,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(value, style: PType.display(150, color: ink)),
            const SizedBox(width: 8),
            Padding(
              padding: const EdgeInsets.only(bottom: 18),
              child: Text(unit, style: PType.h2(color: unitInk)),
            ),
          ],
        ),
      ),
    );
    return LayoutBuilder(
      builder: (context, box) {
        // Measure the figure so the shard always cuts its tail.
        final tp = TextPainter(
          text: TextSpan(text: value, style: PType.display(150)),
          textDirection: TextDirection.ltr,
        )..layout();
        final unitTp = TextPainter(
          text: TextSpan(text: unit, style: PType.h2()),
          textDirection: TextDirection.ltr,
        )..layout();
        final scale = (box.maxWidth / (tp.width + 8 + unitTp.width)).clamp(
          0.0,
          1.0,
        );
        final figure = tp.width * scale;
        tp.dispose();
        unitTp.dispose();
        return Semantics(
          label: '$value $unit',
          child: ExcludeSemantics(
            child: Stack(
              fit: StackFit.expand,
              children: [
                layer(PColors.ink, PColors.muted),
                ClipPath(
                  clipper: _CropClip(figure),
                  child: ColoredBox(
                    color: PColors.navy,
                    child: layer(Colors.white, PColors.ice),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _CropClip extends CustomClipper<Path> {
  const _CropClip(this.figure);

  /// Width of the set figure, without its unit.
  final double figure;

  @override
  Path getClip(Size size) => shardPath(
    Offset(figure * 0.86, size.height * 0.62),
    (figure * 0.34).clamp(56.0, 140.0),
    size.height * 1.1,
    0.56,
  );

  @override
  bool shouldReclip(_CropClip old) => old.figure != figure;
}

class _StageLine extends StatelessWidget {
  const _StageLine({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final (text, color) = switch (app.phase) {
      Phase.idle => ('Not protected. Tap to connect.', PColors.muted),
      Phase.checking => ('Checking the network. Tap to cancel.', PColors.blue),
      Phase.handshaking => (
        'Handshaking with ${app.exit.city}. Tap to cancel.',
        PColors.blue,
      ),
      Phase.protected => (
        'Protected. ${app.protocol} to ${app.exit.city}.',
        PColors.safe,
      ),
      Phase.dropped => (
        app.killSwitch
            ? 'Tunnel dropped. Kill switch is holding traffic.'
            : 'Tunnel dropped. Apps are on the open network.',
        PColors.alert,
      ),
    };
    return AnimatedSwitcher(
      duration: PMotion.reduced(context) ? Duration.zero : PMotion.quick,
      child: Container(
        key: ValueKey(text),
        margin: const EdgeInsets.only(top: 2, bottom: 18),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(PRadius.pill),
          boxShadow: PShadow.soft(),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
            const SizedBox(width: 10),
            Flexible(
              child: Text(
                text,
                style: PType.small(color: PColors.ink)
                    .copyWith(fontWeight: FontWeight.w700),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RouteLine extends StatelessWidget {
  const _RouteLine({required this.exit, required this.live});
  final Exit exit;
  final bool live;

  @override
  Widget build(BuildContext context) {
    Widget node(String label, Color c) => Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 12,
          height: 12,
          decoration: BoxDecoration(color: c, shape: BoxShape.circle),
        ),
        const SizedBox(height: 6),
        Text(label, style: PType.meta(color: PColors.ink)),
      ],
    );
    Widget link() => Expanded(
      child: Container(
        height: 2,
        margin: const EdgeInsets.only(bottom: 20, left: 6, right: 6),
        color: live ? PColors.blue : PColors.ice,
      ),
    );
    return Row(
      children: [
        node('Phone', PColors.navy),
        link(),
        node('Edge', PColors.blue),
        link(),
        node(exit.code, live ? PColors.safe : PColors.ice),
      ],
    );
  }
}

class _WeekBars extends StatelessWidget {
  const _WeekBars({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final days = List.generate(7, (i) {
      final day = DateTime(
        now.year,
        now.month,
        now.day,
      ).subtract(Duration(days: 6 - i));
      final mb = app.sessions
          .where(
            (s) =>
                s.start.year == day.year &&
                s.start.month == day.month &&
                s.start.day == day.day,
          )
          .fold<int>(0, (a, s) => a + s.megabytes);
      return (day, i == 6 ? mb + app.liveMegabytes.round() : mb);
    });
    final peak = days.fold<int>(1, (a, d) => d.$2 > a ? d.$2 : a);
    const letters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    return SizedBox(
      height: 64,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          for (final (day, mb) in days)
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  Container(
                    height: 4 + 36 * mb / peak,
                    margin: const EdgeInsets.symmetric(horizontal: 6),
                    decoration: BoxDecoration(
                      color: mb == 0 ? PColors.mist : PColors.blue,
                      borderRadius: BorderRadius.circular(6),
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(letters[day.weekday - 1], style: PType.meta()),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
