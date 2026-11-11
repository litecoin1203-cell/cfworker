import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/connect_control.dart';
import '../design/geometry.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/updater.dart';
import '../state/exits.dart';
import 'location_detail.dart';
import 'profile.dart';
import 'shell.dart';
import 'states.dart';

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

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
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
            if (app.appUpdate != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 14, 20, 0),
                child: _UpdateBanner(app: app),
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
                        : _Usage(app: app),
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

/// A new Pleat is out: one line and a button, until it is installed.
class _UpdateBanner extends StatelessWidget {
  const _UpdateBanner({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final u = app.appUpdate!;
    final up = app.updater;
    final busy = up.step == UpdateStep.downloading && up.total > 0;
    return SurfaceCard(
      onTap: app.openUpdate,
      label: 'Update Pleat',
      padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: PColors.blue,
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: PIconView(PIcon.refresh, size: 18, color: PColors.onAccent),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Pleat ${u.version} is ready',
                  style: PType.h3().copyWith(fontSize: 15),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Text(
                  busy
                      ? 'Downloading… ${(100 * up.received / up.total).floor()}%'
                      : (u.force
                            ? 'Needed to keep using Pleat.'
                            : 'Tap to update.'),
                  style: PType.small(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          PIconView(PIcon.chevron, size: 18, color: PColors.muted),
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
      _HomeTab.route when e != null => (
        e.protocol,
        '',
        'Protocol to ${e.title}, ${e.label}',
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

class _RouteLine extends StatelessWidget {
  const _RouteLine({required this.exit, required this.live});
  final Exit? exit;
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
        node(exit?.protocol ?? '—', PColors.blue),
        link(),
        node(
          exit == null || exit!.code.isEmpty ? 'Exit' : exit!.code,
          live ? PColors.safe : PColors.ice,
        ),
      ],
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
