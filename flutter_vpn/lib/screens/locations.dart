import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/seed.dart';
import 'location_detail.dart';
import 'shell.dart';

const _categories = [
  (Category.all, PIcon.grid, 'All'),
  (Category.nearby, PIcon.near, 'Nearby'),
  (Category.streaming, PIcon.play, 'Streaming'),
  (Category.gaming, PIcon.game, 'Gaming'),
  (Category.fastest, PIcon.bolt, 'Fastest'),
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

  List<Exit> _filtered(AppState app) {
    Iterable<Exit> list = exits;
    switch (app.category) {
      case Category.all:
        break;
      case Category.fastest:
        list = [...exits]..sort((a, b) => a.ping.compareTo(b.ping));
      case Category.recent:
        final seen = <String>{};
        list = [
          for (final s in app.sessions)
            if (seen.add(s.exitId)) exitById(s.exitId),
        ];
      default:
        list = exits.where((e) => e.tags.contains(app.category));
    }
    final q = _query.trim().toLowerCase();
    if (q.isNotEmpty) {
      list = list.where(
        (e) =>
            e.city.toLowerCase().contains(q) ||
            e.country.toLowerCase().contains(q) ||
            e.code.toLowerCase() == q,
      );
    }
    return list.toList();
  }

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
                        Text(
                          app.exit.city,
                          style: PType.small(color: PColors.blue)
                              .copyWith(fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(width: 4),
                        const PIconView(
                          PIcon.pin,
                          size: 18,
                          color: PColors.blue,
                        ),
                      ],
                    ),
                    const SizedBox(height: 18),
                    PillSearch(
                      hint: 'Search cities or countries',
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
            if (list.isEmpty)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 40, 20, 0),
                  child: SurfaceCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('No exit called “$_query”', style: PType.h3()),
                        const SizedBox(height: 6),
                        Text(
                          'Try a country name or a two-letter code like DE.',
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
                        tabLabel: app.exitId == list[0].id
                            ? 'Selected'
                            : 'Select',
                        tabActive: app.exitId == list[0].id,
                        onTab: () => app.select(list[0].id),
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
                          tabLabel: app.exitId == list[1].id
                              ? 'Selected'
                              : 'Select',
                          tabActive: app.exitId == list[1].id,
                          onTab: () => app.select(list[1].id),
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
                                selected: app.exitId == list[i].id,
                                onOpen: () => _open(list[i]),
                                onSelect: () => app.select(list[i].id),
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
      label: 'Open ${exit.city}',
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
                  Text(exit.city, style: PType.h3().copyWith(fontSize: 16)),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Text(
                        '${exit.ping} ms',
                        style: PType.meta(color: PColors.ink),
                      ),
                      const SizedBox(width: 10),
                      _LoadBar(load: exit.load),
                      const SizedBox(width: 6),
                      Text('${exit.load}%', style: PType.meta()),
                    ],
                  ),
                ],
              ),
            ),
            Pressable(
              onTap: onSelect,
              label: selected ? '${exit.city} selected' : 'Select ${exit.city}',
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
                            'SELECT',
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

class _LoadBar extends StatelessWidget {
  const _LoadBar({required this.load});
  final int load;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 44,
      height: 5,
      decoration: BoxDecoration(
        color: PColors.mist,
        borderRadius: BorderRadius.circular(3),
      ),
      alignment: Alignment.centerLeft,
      child: FractionallySizedBox(
        widthFactor: load / 100,
        child: Container(
          decoration: BoxDecoration(
            color: load > 60 ? PColors.navy : PColors.blue,
            borderRadius: BorderRadius.circular(3),
          ),
        ),
      ),
    );
  }
}
