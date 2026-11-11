import 'package:flutter/material.dart';

import '../api/countries.dart';

import '../design/city_art.dart';
import '../design/connect_control.dart';
import '../design/geometry.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/update_track.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/updater.dart';
import 'location_detail.dart';
import 'profile.dart';
import 'route_chooser.dart';
import 'route_extras.dart';
import 'shell.dart';
import 'states.dart';
import 'stats_view.dart';

enum _HomeTab { now, route, stats }

/// Home: the greeting, three instrument tabs, one display-size number
/// cropped by a shard, and the connect control standing in the field.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    // in AppState, so a notification can open Route
    return ValueListenableBuilder<int>(
      valueListenable: app.homeTab,
      builder: (context, i, _) => _page(app, _HomeTab.values[i]),
    );
  }

  Widget _page(AppState app, _HomeTab tab) {
    final recommended = app.recommended;

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
            if (app.appUpdate != null && !app.updateLater)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 14, 20, 0),
                child: _UpdateBanner(app: app),
              ),
            const SizedBox(height: 14),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: _Tabs(
                value: tab,
                onChanged: (t) => app.homeTab.value = t.index,
              ),
            ),
            const SizedBox(height: 18),
            _Instrument(app: app, tab: tab),
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
            if (tab == _HomeTab.route)
              Transform.translate(
                offset: const Offset(0, -30),
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      RouteChooser(app: app),
                      RouteExtras(app: app),
                    ],
                  ),
                ),
              ),
            if (tab == _HomeTab.stats)
              Transform.translate(
                offset: const Offset(0, -34),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: SurfaceCard(
                    padding: const EdgeInsets.fromLTRB(20, 18, 20, 14),
                    child: _Usage(app: app),
                  ),
                ),
              ),
            if (tab == _HomeTab.stats)
              Transform.translate(
                offset: const Offset(0, -34),
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 18),
                  child: StatsPanel(app: app),
                ),
              ),
            // Recommended exits stay under Now only: Route and Stats keep
            // to their own job (Ali, 2026-11-11).
            if (tab == _HomeTab.now) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 4),
                child: SectionLabel(
                  'Recommended exits',
                  trailing: 'See all',
                  onTrailing: () => app.setTab(2),
                ),
              ),
              if (recommended.isEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                  child: ServersState(app: app),
                )
              else
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
          child: Avatar(app: app, nudge: true),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // the name opens Profile too, like the picture
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () =>
                    Navigator.of(context)
                        .push(FadeRoute(builder: (_) => const ProfileScreen())),
                child: Text(
                  '$hello, ${app.firstName}',
                  style: PType.h3(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(height: 3),
              Row(
                children: [
                  if (app.exit != null) ...[
                    RegionBadge(app.exit!, size: 18),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text(
                        '${app.exit!.title} exit  ·  ${app.exit!.label}',
                        style: PType.small(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ] else ...[
                    PIconView(PIcon.pin, size: 14, color: PColors.muted),
                    const SizedBox(width: 4),
                    Text(
                      app.servers.loading ? 'Loading exits…' : 'No exit yet',
                      style: PType.small(),
                    ),
                  ],
                ],
              ),
            ],
          ),
        ),
        RoundIcon(
          PIcon.bell,
          onTap: () => showNotices(context),
          label: 'Notices',
          badge: app.hasUnseenNotices,
        ),
      ],
    );
  }
}

/// A new Pleat is out: the same card as the system notification. The
/// three-part line (Download, Check, Install) carries the Pleat mark along
/// as it goes; the button does whatever is next.
class _UpdateBanner extends StatelessWidget {
  const _UpdateBanner({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final u = app.appUpdate!;
    final up = app.updater;
    final c = UpdateCopy.of(up, u);
    final t = updateTrack(up);
    final busy = up.busy;
    final later = !busy && !u.force && up.step == UpdateStep.idle;
    return SurfaceCard(
      onTap: app.openUpdate,
      label: 'Update Pleat',
      padding: const EdgeInsets.fromLTRB(18, 14, 14, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      c.short,
                      style: PType.h3().copyWith(fontSize: 15),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      c.side.isEmpty || !busy
                          ? c.shortText
                          : '${c.shortText}  ·  ${c.side}',
                      style: PType.small(
                        color: up.step == UpdateStep.failed
                            ? PColors.ink
                            : null,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              if (c.button.isNotEmpty) ...[
                const SizedBox(width: 10),
                PillButton(
                  label: c.button,
                  icon: busy ? PIcon.close : PIcon.download,
                  color: busy ? PColors.mist : null,
                  textColor: busy ? PColors.accentInk : null,
                  height: 38,
                  expand: false,
                  onTap: app.goUpdate,
                ),
              ],
            ],
          ),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: UpdateTrack(
              stage: t.stage,
              frac: t.frac,
              from: up.version,
              to: u.version,
            ),
          ),
          if (later)
            Align(
              alignment: Alignment.centerLeft,
              child: Pressable(
                onTap: app.putOffUpdate,
                label: 'Later',
                radius: PRadius.pill,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(0, 8, 12, 4),
                  child: Text(
                    'LATER',
                    style: PType.button(color: PColors.accentInk),
                  ),
                ),
              ),
            ),
        ],
      ),
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
                                color: t == value
                                    ? PColors.accentInk
                                    : PColors.ink,
                              ),
                              const SizedBox(width: 8),
                              AnimatedDefaultTextStyle(
                                duration: d,
                                style: PType.small(
                                  color: t == value
                                      ? PColors.accentInk
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

  @override
  Widget build(BuildContext context) {
    final protected = app.phase == Phase.protected;
    final e = app.exit;
    final sub = app.subscription;
    // Connected: the exit's country code, big, with the city and the
    // public IP the internet sees above it.
    final a = app.exitAddress;
    final detail = tab == _HomeTab.now && protected
        ? (a == null ? 'Finding your IP address' : 'IP ${a.ip}')
        : null;
    final cc = a != null && a.cc.isNotEmpty ? a.cc : (e?.code ?? '');
    final (value, unit, caption) = switch (tab) {
      _HomeTab.now when protected => (
        cc.isEmpty ? '—' : cc,
        '',
        'Through ${a != null && a.place.isNotEmpty ? a.place : (e?.title ?? 'your exit')}',
      ),
      _HomeTab.now when e?.ping != null => (
        '${e!.ping}',
        'ms',
        (e.measured ?? 0) > 0
            ? 'Ping to ${e.title} from this phone'
            : 'Ping to ${e.title} reported on your network',
      ),
      _HomeTab.now when sub != null && !sub.unlimitedTime => (
        '${sub.daysLeft ?? 0}',
        'days',
        sub.active ? 'Left on your plan' : sub.statusLine,
      ),
      _HomeTab.now when sub != null => (
        '${app.exits.length}',
        'exits',
        'On your plan, no end date',
      ),
      _HomeTab.now => (
        app.me.loading ? '…' : '0',
        'exits',
        app.me.loading ? 'Loading your plan' : 'No plan yet. Open Plans.',
      ),
      _HomeTab.route when e != null && app.pinned => (
        e.code.isEmpty ? e.protocol : e.code,
        '',
        'Picked by hand: ${e.label}, ${e.protocol}',
      ),
      _HomeTab.route when e != null => (
        app.routeMode.title,
        '',
        '${app.routeMode.title} mode, ${app.routeCountry.isEmpty ? 'best location' : countryName(app.routeCountry)}',
      ),
      _HomeTab.route => ('0', 'exits', 'No exit to route through yet'),
      _HomeTab.stats => (
        ((sub?.usedBytes ?? 0) / 1073741824).toStringAsFixed(1),
        'GB',
        sub == null
            ? 'No plan yet'
            : (sub.unlimitedData
                  ? 'Used on your plan, no data cap'
                  : 'Used of ${(sub.dataLimitBytes / 1073741824).toStringAsFixed(0)} GB on your plan'),
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
          if (detail != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                detail,
                style: PType.body(color: PColors.ink)
                    .copyWith(fontWeight: FontWeight.w700),
              ),
            ),
          SizedBox(
            height: detail == null ? 156 : 132,
            child: AnimatedSwitcher(
              duration: PMotion.reduced(context)
                  ? Duration.zero
                  : PMotion.quick,
              child: _CroppedNumber(
                key: ValueKey('$tab$value'),
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
                    child: layer(
                      PColors.onDeep,
                      PColors.onDeep.withValues(alpha: 0.7),
                    ),
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
      Phase.idle => (
        app.tunnelMessage ?? 'Not protected. Tap to connect.',
        PColors.muted,
      ),
      Phase.checking => (
        '${app.progressNote ?? 'Checking your plan and exit.'} Tap to cancel.',
        PColors.blue,
      ),
      Phase.handshaking => (
        'Handshaking with ${app.exit?.title}. Tap to cancel.',
        PColors.blue,
      ),
      Phase.protected when app.exitSilent => (
        '${app.exit?.title} isn’t answering. Pick another exit.',
        PColors.alert,
      ),
      Phase.protected => (
        'Protected. ${app.exit?.protocol} to ${app.exit?.title}.',
        PColors.safe,
      ),
      Phase.dropped => (
        '${app.tunnelMessage ?? 'Tunnel dropped.'} Not protected.',
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
          color: PColors.surface,
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

/// Plan usage from `/me`: a bar of used data and the days left.
class _Usage extends StatelessWidget {
  const _Usage({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final s = app.subscription;
    if (s == null) {
      return Text(
        app.me.error ??
            (app.me.loading ? 'Loading your plan…' : 'No plan yet.'),
        style: PType.small(color: PColors.ink),
      );
    }
    final pct = s.usedPercent;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                s.planName,
                style: PType.h3().copyWith(fontSize: 15),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            Text(
              s.active ? (pct == null ? 'No cap' : '$pct%') : s.statusLine,
              style: PType.meta(color: PColors.ink),
            ),
          ],
        ),
        const SizedBox(height: 10),
        UsageBar(percent: pct ?? 0, height: 8),
        const SizedBox(height: 8),
        Text(
          s.unlimitedTime
              ? 'No end date  ·  ${s.deviceLimit} devices'
              : '${s.daysLeft ?? 0} days left  ·  ${s.deviceLimit} devices',
          style: PType.meta(),
        ),
      ],
    );
  }
}
