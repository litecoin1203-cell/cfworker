import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../api/countries.dart';
import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/exits.dart';
import '../state/route_mode.dart';

/// Home's Route tab: how to connect, picked as a goal (Stealth, Speed,
/// Classic or Auto), and where, picked as a country. Smart connect then
/// stays inside that choice (see [AppState.routePool]).
class RouteChooser extends StatelessWidget {
  const RouteChooser({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final modes = app.routeModes;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
          // a pill, like the stage line, so it reads over the shards
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: PColors.surface,
              borderRadius: BorderRadius.circular(PRadius.pill),
              boxShadow: PShadow.soft(),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
              child: Text(
                'How do you want to connect?',
                style: PType.small(color: PColors.ink)
                    .copyWith(fontWeight: FontWeight.w700),
              ),
            ),
          ),
        ),
        SizedBox(
          height: 186,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
            itemCount: modes.length,
            separatorBuilder: (_, _) => const SizedBox(width: 12),
            itemBuilder: (context, i) {
              final m = modes[i];
              return StaggerIn(
                index: i,
                child: ModeCard(
                  mode: m,
                  protocols: app.protocolsOf(m),
                  selected: !app.pinned && app.routeMode == m,
                  onTap: () => app.setRoute(m),
                ),
              );
            },
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
          child: _LocationBar(app: app),
        ),
      ],
    );
  }
}

/// One goal: a white card (navy when picked) with two slanted planes in
/// its corner, the goal's name, what it is for and the protocols behind it.
class ModeCard extends StatelessWidget {
  const ModeCard({
    super.key,
    required this.mode,
    required this.protocols,
    required this.selected,
    required this.onTap,
  });

  final RouteMode mode;
  final String protocols;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final fg = selected ? PColors.onDeep : PColors.ink;
    final sub = selected ? PColors.onDeep : PColors.muted;
    final (a, b) = switch (mode) {
      RouteMode.stealth => (
        PColors.blue,
        selected ? PColors.onDeep : PColors.navy,
      ),
      RouteMode.speed => (PColors.navy, PColors.blue),
      RouteMode.classic => (PColors.ice, PColors.blue),
      RouteMode.auto => (PColors.blue, PColors.ice),
    };
    final d = PMotion.reduced(context) ? Duration.zero : PMotion.quick;
    return Pressable(
      onTap: onTap,
      label: '${mode.title}. ${mode.blurb}. $protocols',
      selected: selected,
      radius: 24,
      child: AnimatedContainer(
        duration: d,
        width: 158,
        height: 176,
        decoration: BoxDecoration(
          color: selected ? PColors.navy : PColors.surface,
          borderRadius: BorderRadius.circular(24),
          border: Border.all(
            color: selected ? PColors.blue : Colors.transparent,
            width: 2,
          ),
          boxShadow: PShadow.soft(),
        ),
        clipBehavior: Clip.antiAlias,
        child: Stack(
          children: [
            Positioned(
              right: -6,
              top: -12,
              child: _Planes(a: a, b: b),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 12, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  Text(
                    mode.title,
                    style: PType.h3(color: fg)
                        .copyWith(fontSize: 19, fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    mode.blurb,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: PType.meta(color: sub).copyWith(height: 1.3),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    protocols.toUpperCase(),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: PType.meta(color: fg).copyWith(
                      fontSize: 9.5,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.6,
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

/// Two slanted planes, Pleat's mark language, in a card's corner.
class _Planes extends StatelessWidget {
  const _Planes({required this.a, required this.b});
  final Color a, b;

  @override
  Widget build(BuildContext context) {
    Widget plane(double w, double h, Color c) => Transform(
      transform: Matrix4.skewX(-math.pi / 7.5),
      alignment: Alignment.bottomCenter,
      child: Container(
        width: w,
        height: h,
        decoration: BoxDecoration(
          color: c,
          borderRadius: BorderRadius.circular(10),
        ),
      ),
    );
    return ExcludeSemantics(
      child: SizedBox(
        width: 92,
        height: 104,
        child: Stack(
          children: [
            Positioned(left: 8, top: 26, child: plane(20, 74, b)),
            Positioned(left: 40, top: 0, child: plane(32, 100, a)),
          ],
        ),
      ),
    );
  }
}

/// Where: the chosen country (or the best anywhere) and the exit it
/// leads to right now, with its real protocol. Opens the country sheet.
class _LocationBar extends StatelessWidget {
  const _LocationBar({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final e = app.exit;
    final pinned = app.pinned && e != null;
    final c = app.routeCountry;
    final title = pinned
        ? e.title
        : (c.isEmpty ? 'Best location' : countryName(c));
    final String detail;
    if (e == null) {
      detail = app.servers.loading ? 'Loading exits…' : 'No exits yet';
    } else if (pinned) {
      detail = 'Picked by hand: ${e.label}. Tap to choose again.';
    } else if (!app.routeAvailable) {
      detail = 'Not on your plan now. Using ${e.label}.';
    } else {
      detail = [
        e.label,
        wrappingOf(e),
        if (e.ping != null) '${e.ping} ms',
      ].join('  ·  ');
    }
    return SurfaceCard(
      onTap: e == null ? null : () => showRouteCountries(context),
      label: 'Location: $title. $detail',
      radius: 22,
      padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
      child: Row(
        children: [
          if (c.isNotEmpty || pinned)
            RegionBadge(e!, size: 32)
          else
            _GlobeDisc(size: 32),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: PType.h3().copyWith(fontSize: 15),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Text(
                  detail,
                  style: PType.meta(color: PColors.ink),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              color: PColors.field,
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: Transform.rotate(
              angle: math.pi / 2,
              child: PIconView(PIcon.chevron, size: 16, color: PColors.ink),
            ),
          ),
        ],
      ),
    );
  }
}

class _GlobeDisc extends StatelessWidget {
  const _GlobeDisc({required this.size});
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(color: PColors.blue, shape: BoxShape.circle),
    alignment: Alignment.center,
    child: PIconView(PIcon.globe, size: size * 0.56, color: PColors.onAccent),
  );
}

/// The countries the chosen goal reaches on this plan, best first, plus
/// "Best location". Picking one keeps the goal.
Future<void> showRouteCountries(BuildContext context) {
  final app = AppScope.read(context);
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    barrierColor: PColors.scrim,
    isScrollControlled: true,
    builder: (context) {
      final list = app.countriesOf(app.routeMode);
      final current = app.pinned ? null : app.routeCountry;
      Widget row({
        required Widget badge,
        required String title,
        required String sub,
        required bool on,
        required VoidCallback onTap,
      }) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Pressable(
          onTap: onTap,
          label: '$title. $sub',
          selected: on,
          radius: 18,
          color: on ? PColors.mist : PColors.field,
          child: Container(
            padding: const EdgeInsets.fromLTRB(12, 10, 14, 10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(18),
              border: Border.all(
                color: on ? PColors.blue : Colors.transparent,
                width: 2,
              ),
            ),
            child: Row(
              children: [
                badge,
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, style: PType.h3().copyWith(fontSize: 15)),
                      const SizedBox(height: 2),
                      Text(sub, style: PType.meta(color: PColors.ink)),
                    ],
                  ),
                ),
                if (on)
                  PIconView(PIcon.check, size: 20, color: PColors.accentInk),
              ],
            ),
          ),
        ),
      );
      String about(Exit best, int n) => [
        n == 1 ? '1 exit' : '$n exits',
        if (best.ping != null) 'best ${best.ping} ms',
        wrappingOf(best),
      ].join('  ·  ');
      return Container(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.8,
        ),
        decoration: BoxDecoration(
          color: PColors.surface,
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(PRadius.sheet),
          ),
        ),
        padding: EdgeInsets.fromLTRB(
          18,
          14,
          18,
          18 + MediaQuery.paddingOf(context).bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: PColors.mist,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Text('Location', style: PType.h2()),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 4, 4, 14),
              child: Text(
                app.routeMode == RouteMode.auto
                    ? 'Every country on your plan.'
                    : 'Countries with a ${app.routeMode.title} exit on your plan.',
                style: PType.small(),
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  row(
                    badge: const _GlobeDisc(size: 36),
                    title: 'Best location',
                    sub: 'Pleat picks the fastest country for you',
                    on: current == '',
                    onTap: () {
                      app.setRoute(app.routeMode, country: '');
                      Navigator.of(context).pop();
                    },
                  ),
                  for (final (key, best, n) in list)
                    row(
                      badge: RegionBadge(best, size: 36),
                      title: best.title,
                      sub: about(best, n),
                      on: current == key,
                      onTap: () {
                        app.setRoute(app.routeMode, country: key);
                        Navigator.of(context).pop();
                      },
                    ),
                ],
              ),
            ),
          ],
        ),
      );
    },
  );
}
