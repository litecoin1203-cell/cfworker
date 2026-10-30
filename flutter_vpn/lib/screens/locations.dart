import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/exits.dart';
import 'location_detail.dart';
import 'shell.dart';
import 'states.dart';

const _categories = [
  (Category.all, PIcon.grid, 'All'),
  (Category.fastest, PIcon.bolt, 'Fastest'),
  (Category.saved, PIcon.bookmark, 'Saved'),
  (Category.recent, PIcon.clock, 'Recent'),
];

/// Locations break the reference's Partners grid: the first city is an
/// oversized card that ignores the column and slides 16px under the next
/// one; everything after is a dense list.
class LocationsScreen extends StatefulWidget {
  const LocationsScreen({super.key});

  @override
  State<LocationsScreen> createState() => _LocationsScreenState();
}

class _LocationsScreenState extends State<LocationsScreen> {
  String _query = '';

  /// Every list is the backend's: All in the Worker's order, Fastest by
  /// what this network reported, Saved and Recent from this phone.
  List<Exit> _filtered(AppState app) {
    Iterable<Exit> list = app.exits;
    switch (app.category) {
      case Category.all:
        break;
      case Category.fastest:
        list = app.ranked.where((e) => e.score != null);
      case Category.saved:
        list = list.where((e) => app.saved.contains(e.id));
      case Category.recent:
        final seen = <String>{};
        list = [
          for (final s in app.sessions)
            if (seen.add(s.exitId)) ?app.exitById(s.exitId),
        ];
    }
    final q = _query.trim().toLowerCase();
    if (q.isNotEmpty) {
      list = list.where(
        (e) =>
            e.title.toLowerCase().contains(q) ||
            e.label.toLowerCase().contains(q) ||
            e.code.toLowerCase() == q,
      );
    }
    return list.toList();
  }

  String _emptyLine(AppState app) {
    if (_query.trim().isNotEmpty) return 'No exit matches “$_query”';
    return switch (app.category) {
      Category.fastest => 'No speed reports from your network yet',
      Category.saved => 'Nothing saved yet',
      Category.recent => 'No sessions on this phone yet',
      Category.all => 'No exits',
    };
  }

  /// Connect to [e] and show Home, where the connection plays out. The exit
  /// already up (or coming up) just shows Home.
  void _connect(Exit e) {
    final app = AppScope.read(context);
    if (!_on(app, e)) app.connect(e.id);
    app.setTab(0);
  }

  static bool _on(AppState app, Exit e) =>
      app.exit?.id == e.id && (app.busy || app.phase == Phase.protected);

  void _open(Exit e) =>
      Navigator.of(context)
          .push(TunnelRoute(builder: (_) => LocationDetail(exitId: e.id)));

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final list = _filtered(app);
    return SafeArea(
      bottom: false,
      child: ParallaxScroll(
        child: CustomScrollView(
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
              sliver: SliverToBoxAdapter(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(child: Text('Locations', style: PType.h1())),
                        if (app.exit != null) ...[
                          Text(
                            app.exit!.label,
                            style: PType.small(color: PColors.blue)
                                .copyWith(fontWeight: FontWeight.w700),
                          ),
                          const SizedBox(width: 6),
                          RegionBadge(app.exit!, size: 22),
                        ],
                      ],
                    ),
                    const SizedBox(height: 18),
                    PillSearch(
                      hint: 'Search countries or codes',
                      onChanged: (v) => setState(() => _query = v),
                    ),
                  ],
                ),
              ),
            ),
            SliverToBoxAdapter(
              child: Container(
                margin: const EdgeInsets.only(top: 18),
                height: 86,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  children: [
                    for (final (c, icon, label) in _categories)
                      _CategoryChip(
                        icon: icon,
                        label: label,
                        active: app.category == c,
                        onTap: () => app.setCategory(c),
                      ),
                  ],
                ),
              ),
            ),
            if (app.exits.isEmpty)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 30, 20, 0),
                  child: ServersState(app: app),
                ),
              )
            else if (list.isEmpty)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 40, 20, 0),
                  child: SurfaceCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(_emptyLine(app), style: PType.h3()),
                        const SizedBox(height: 6),
                        Text(
                          app.category == Category.saved
                              ? 'Open an exit and tap the bookmark. Saved exits stay on this phone.'
                              : 'Try a country name or a two-letter code like DE.',
                          style: PType.small(),
                        ),
                      ],
                    ),
                  ),
                ),
              )
            else ...[
              // Oversized first city: bleeds past the right gutter.
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 10, 0, 0),
                  child: Transform.translate(
                    offset: const Offset(24, 0),
                    child: StaggerIn(
                      key: ValueKey('big-${list[0].id}'),
                      index: 0,
                      child: MediaCard(
                        exit: list[0],
                        height: 248,
                        big: true,
                        onOpen: () => _open(list[0]),
                        tabLabel: _on(app, list[0]) ? 'Connected' : 'Connect',
                        tabActive: _on(app, list[0]),
                        onTab: () => _connect(list[0]),
                      ),
                    ),
                  ),
                ),
              ),
              if (list.length > 1)
                SliverToBoxAdapter(
                  // Second card is inset off the column and rides 16px over the first.
                  child: Transform.translate(
                    offset: const Offset(0, -16),
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(72, 0, 20, 0),
                      child: StaggerIn(
                        key: ValueKey('second-${list[1].id}'),
                        index: 1,
                        child: MediaCard(
                          exit: list[1],
                          height: 150,
                          onOpen: () => _open(list[1]),
                          tabLabel: _on(app, list[1]) ? 'Connected' : 'Connect',
                          tabActive: _on(app, list[1]),
                          onTab: () => _connect(list[1]),
                        ),
                      ),
                    ),
                  ),
                ),
              if (list.length > 2)
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 140),
                  sliver: SliverToBoxAdapter(
                    child: SurfaceCard(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Column(
                        children: [
                          for (var i = 2; i < list.length; i++)
                            StaggerIn(
                              key: ValueKey(
                                'row-${app.category}-${list[i].id}',
                              ),
                              index: i,
                              child: _ExitRow(
                                exit: list[i],
                                selected: _on(app, list[i]),
                                onOpen: () => _open(list[i]),
                                onSelect: () => _connect(list[i]),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                )
              else
                const SliverToBoxAdapter(child: SizedBox(height: 140)),
            ],
          ],
        ),
      ),
    );
  }
}

class _CategoryChip extends StatelessWidget {
  const _CategoryChip({
    required this.icon,
    required this.label,
    required this.active,
    required this.onTap,
  });
  final PIcon icon;
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = active ? PColors.blue : PColors.muted;
    return Pressable(
      onTap: onTap,
      label: label,
      selected: active,
      radius: 20,
      child: SizedBox(
        width: 76,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            AnimatedContainer(
              duration: PMotion.quick,
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: active ? Colors.white : Colors.transparent,
                shape: BoxShape.circle,
                boxShadow: active ? PShadow.soft() : null,
              ),
              alignment: Alignment.center,
              child: PIconView(
                icon,
                size: 24,
                color: active ? PColors.blue : PColors.ink,
              ),
            ),
            const SizedBox(height: 6),
            Text(label.toUpperCase(), style: PType.tab(color: color)),
          ],
        ),
      ),
    );
  }
}

class _ExitRow extends StatelessWidget {
  const _ExitRow({
    required this.exit,
    required this.selected,
    required this.onOpen,
    required this.onSelect,
  });
  final Exit exit;
  final bool selected;
  final VoidCallback onOpen, onSelect;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onOpen,
      label: 'Open ${exit.title}, ${exit.label}',
      radius: 20,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
        child: Row(
          children: [
            RegionBadge(exit),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    exit.title,
                    style: PType.h3().copyWith(fontSize: 16),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    exit.meta,
                    style: PType.meta(color: PColors.ink),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            Pressable(
              onTap: onSelect,
              label: selected
                  ? '${exit.title} ${exit.label} connected'
                  : 'Connect to ${exit.title} ${exit.label}',
              selected: selected,
              radius: PRadius.pill,
              color: selected ? PColors.blue : PColors.field,
              child: SizedBox(
                height: 40,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  child: Center(
                    child: selected
                        ? const PIconView(
                            PIcon.check,
                            size: 18,
                            color: Colors.white,
                          )
                        : Text(
                            'CONNECT',
                            style: PType.button(color: PColors.ink)
                                .copyWith(fontSize: 11),
                          ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
