import 'package:flutter/material.dart';

import '../api/countries.dart';
import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/exits.dart';
import '../state/route_mode.dart';
import 'location_detail.dart';
import 'shell.dart';
import 'states.dart';

/// Locations (Ali's pick A, "Country list"): the fastest exit for this
/// network on top, filter chips, then every country once, grouped by
/// region. A country's CONNECT takes its best server; a country with more
/// than one opens into its servers. Countries where nothing answers on
/// this network fold into one row at the end, with each server's reason.
class LocationsScreen extends StatefulWidget {
  const LocationsScreen({super.key});

  @override
  State<LocationsScreen> createState() => _LocationsScreenState();
}

class _LocationsScreenState extends State<LocationsScreen> {
  String _query = '';
  bool _deadOpen = false;

  @override
  void initState() {
    super.initState();
    // The last results show at once. Pings older than an hour on this
    // network, and speeds older than six, are measured again; pull to
    // refresh tests now.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) AppScope.read(context).openLocations();
    });
  }

  @override
  void deactivate() {
    // Leaving Locations: no more download tests nobody sees.
    AppScope.read(context).stopSpeeds();
    super.deactivate();
  }

  /// The chip's slice of the Worker's list, then the search.
  List<Exit> _filtered(AppState app) {
    Iterable<Exit> list = app.exits;
    switch (app.category) {
      case Category.all:
        break;
      case Category.stealth:
        list = list.where((e) => e.family == RouteMode.stealth);
      case Category.tunnel:
        list = list.where((e) => e.server.tunnel);
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
      Category.stealth => 'No Stealth exits on your plan',
      Category.tunnel => 'No IR Tunnel exits on your plan',
      Category.saved => 'Nothing saved yet',
      Category.recent => 'No sessions on this phone yet',
      Category.all => 'No exits',
    };
  }

  /// Connect to [e] (or let smart connect pick when null) and show Home,
  /// where the connection plays out.
  void _connect(Exit? e) {
    final app = AppScope.read(context);
    if (e == null) {
      if (!app.busy && app.phase != Phase.protected) app.connect();
    } else if (!_on(app, e)) {
      app.connect(e.id);
    }
    app.setTab(0);
  }

  static bool _on(AppState app, Exit e) =>
      app.exit?.id == e.id && (app.busy || app.phase == Phase.protected);

  /// "On Irancell · Tested 25 min ago · Pull to re-test".
  static String _statusLine(AppState app) {
    final at = app.testedAt;
    return [
      if (app.network != null) 'On ${app.network!.label}',
      if (app.testing)
        'Testing exits'
      else if (at != null)
        'Tested ${ago(DateTime.now().difference(at))}',
      'Pull to re-test',
    ].join('  ·  ');
  }

  void _open(Exit e) =>
      Navigator.of(context)
          .push(TunnelRoute(builder: (_) => LocationDetail(exitId: e.id)));

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final list = _filtered(app);
    final groups = groupCountries(list);
    final alive = [
      for (final g in groups)
        if (!g.every((e) => e.unreachable)) g,
    ];
    final dead = [
      for (final g in groups)
        if (g.every((e) => e.unreachable)) g,
    ];
    final regions = groupRegions(alive);
    final fastest = fastestExit(app);
    final stealth = app.exits.where((e) => e.family == RouteMode.stealth);
    final tunnels = app.exits.where((e) => e.server.tunnel);
    final chips = [
      (Category.all, PIcon.grid, 'All', null),
      (Category.stealth, PIcon.shield, 'Stealth', stealth.length),
      if (tunnels.isNotEmpty)
        (Category.tunnel, PIcon.tunnel, 'IR Tunnel', tunnels.length),
      (Category.saved, PIcon.bookmark, 'Saved', null),
      (Category.recent, PIcon.clock, 'Recent', null),
    ];
    var stagger = 0;
    return SafeArea(
      bottom: false,
      child: ParallaxScroll(
        child: RefreshIndicator(
          color: PColors.blue,
          onRefresh: app.retestNow,
          child: CustomScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
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
                              style: PType.small(color: PColors.accentInk)
                                  .copyWith(fontWeight: FontWeight.w700),
                            ),
                            const SizedBox(width: 6),
                            RegionBadge(app.exit!, size: 22),
                          ],
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        _statusLine(app),
                        style: PType.small(color: PColors.muted),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 14),
                      PillSearch(
                        hint: 'Search countries or codes',
                        onChanged: (v) => setState(() => _query = v),
                      ),
                      if (app.exits.isNotEmpty) ...[
                        const SizedBox(height: 12),
                        _FastestBar(
                          exit: fastest,
                          on: fastest != null && _on(app, fastest),
                          onConnect: () => _connect(fastest),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              SliverToBoxAdapter(
                child: SizedBox(
                  height: 60,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.fromLTRB(20, 12, 12, 6),
                    children: [
                      for (final (c, icon, label, count) in chips)
                        Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: _FilterChip(
                            icon: icon,
                            label: label,
                            count: count,
                            active: app.category == c,
                            onTap: () => app.setCategory(c),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              if (app.exits.isEmpty)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
                    child: ServersState(app: app),
                  ),
                )
              else if (list.isEmpty)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
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
                ),
              if (list.isNotEmpty)
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 140),
                  sliver: SliverList.list(
                    children: [
                      for (var r = 0; r < regions.length; r++) ...[
                        _RegionHead(
                          region: regions[r].$1,
                          countries: regions[r].$2.length,
                          legend: r == 0,
                        ),
                        StaggerIn(
                          key: ValueKey(
                            'region-${app.category}-${regions[r].$1.name}',
                          ),
                          index: stagger++,
                          child: SurfaceCard(
                            padding: const EdgeInsets.symmetric(vertical: 6),
                            child: Column(
                              children: [
                                for (final g in regions[r].$2)
                                  _CountryRow(
                                    key: ValueKey(
                                      'c-${g.first.code}-${g.first.title}',
                                    ),
                                    exits: g,
                                    best: bestOf(g),
                                    isOn: (e) => _on(app, e),
                                    onOpen: _open,
                                    onConnect: _connect,
                                  ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(height: 4),
                      ],
                      if (dead.isNotEmpty) ...[
                        const SizedBox(height: 12),
                        _NotAnswering(
                          groups: dead,
                          network: app.network?.label,
                          open: _deadOpen,
                          onToggle: () =>
                              setState(() => _deadOpen = !_deadOpen),
                          isOn: (e) => _on(app, e),
                          onOpen: _open,
                          onConnect: _connect,
                        ),
                      ],
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Exits grouped by country, in list order.
List<List<Exit>> groupCountries(List<Exit> list) {
  final by = <String, List<Exit>>{};
  for (final e in list) {
    by.putIfAbsent(e.code.isEmpty ? e.title : e.code, () => []).add(e);
  }
  return by.values.toList();
}

/// A country's best server: the strongest that answers on this network,
/// else the first the Worker lists.
Exit bestOf(List<Exit> g) {
  Exit? top;
  for (final e in g) {
    if (e.unreachable) continue;
    if (top == null || e.smartScore > top.smartScore) top = e;
  }
  return top ?? g.first;
}

/// Countries under their regions. Regions and the countries in them go
/// best first; with nothing measured yet, the region order and the
/// Worker's order (the sort is stable).
List<(Region, List<List<Exit>>)> groupRegions(List<List<Exit>> countries) {
  final by = <Region, List<List<Exit>>>{};
  for (final g in countries) {
    by.putIfAbsent(regionOf(g.first.code), () => []).add(g);
  }
  double score(List<Exit> g) => bestOf(g).smartScore;
  final out = [
    for (final r in Region.values)
      if (by[r] != null) (r, by[r]!),
  ];
  for (final (_, gs) in out) {
    mergeSort(gs, compare: (a, b) => score(b).compareTo(score(a)));
  }
  mergeSort(
    out,
    compare: (a, b) => score(b.$2.first).compareTo(score(a.$2.first)),
  );
  return out;
}

/// Stable insertion sort: equal scores keep the Worker's order.
void mergeSort<T>(List<T> list, {required int Function(T, T) compare}) {
  for (var i = 1; i < list.length; i++) {
    final x = list[i];
    var j = i - 1;
    while (j >= 0 && compare(list[j], x) > 0) {
      list[j + 1] = list[j];
      j--;
    }
    list[j + 1] = x;
  }
}

/// The exit "Fastest for you now" offers: the best this phone or people on
/// this network measured that answers; null until anything is measured
/// (the bar then lets smart connect pick).
Exit? fastestExit(AppState app) {
  for (final e in app.best) {
    if (!e.unreachable) return e;
  }
  return null;
}

/// Green: answered. Red: answered slowly or people here say weak.
/// Grey: not tested yet. Faint: no answer.
enum Health { good, slow, untested, dead }

Health healthOf(Exit e) {
  if (e.unreachable) return Health.dead;
  final p = e.ping;
  if (p == null && e.verdict == null) return Health.untested;
  if ((p != null && p >= 400) ||
      e.verdict == Verdict.weak ||
      e.speed == Speed.slow) {
    return Health.slow;
  }
  return Health.good;
}

class _FastestBar extends StatelessWidget {
  const _FastestBar({
    required this.exit,
    required this.on,
    required this.onConnect,
  });
  final Exit? exit;
  final bool on;
  final VoidCallback onConnect;

  @override
  Widget build(BuildContext context) {
    final e = exit;
    final title = e == null ? 'Smart connect' : '${e.title} · ${e.label}';
    final side = e == null
        ? 'Pleat picks for this network'
        : (e.ping == null ? e.protocol : '${e.protocol} · ${e.ping} ms');
    return Semantics(
      container: true,
      label: 'Fastest for you now: $title',
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 12, 10, 12),
        decoration: BoxDecoration(
          color: PColors.navy,
          borderRadius: BorderRadius.circular(24),
        ),
        child: Row(
          children: [
            PIconView(PIcon.bolt, size: 22, color: PColors.onDeep),
            const SizedBox(width: 12),
            Expanded(
              child: ExcludeSemantics(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'FASTEST FOR YOU NOW',
                      style: PType.tab(
                        color: PColors.onDeep.withValues(alpha: 0.82),
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      title,
                      style: PType.h3(color: PColors.onDeep)
                          .copyWith(fontSize: 16),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    Text(
                      side,
                      style: PType.meta(
                        color: PColors.onDeep.withValues(alpha: 0.82),
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 8),
            Pressable(
              onTap: onConnect,
              label: on ? '$title connected' : 'Connect to $title',
              selected: on,
              radius: PRadius.pill,
              color: on ? PColors.blue : PColors.onDeep,
              child: SizedBox(
                height: 42,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Center(
                    child: on
                        ? PIconView(
                            PIcon.check,
                            size: 18,
                            color: PColors.onAccent,
                          )
                        : Text(
                            'CONNECT',
                            style: PType.button(
                              color: PColors.current.isDark
                                  ? PColors.ground
                                  : PColors.navy,
                            ).copyWith(fontSize: 11),
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

class _FilterChip extends StatelessWidget {
  const _FilterChip({
    required this.icon,
    required this.label,
    required this.count,
    required this.active,
    required this.onTap,
  });
  final PIcon icon;
  final String label;
  final int? count;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final fg = active ? PColors.onAccent : PColors.ink;
    return Pressable(
      onTap: onTap,
      label: count == null ? label : '$label, $count',
      selected: active,
      radius: PRadius.pill,
      color: active
          ? (PColors.current.isDark ? PColors.blue : PColors.navy)
          : PColors.surface,
      child: SizedBox(
        height: 40,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              PIconView(icon, size: 17, color: fg),
              const SizedBox(width: 6),
              Text(
                label,
                style: PType.small(color: fg)
                    .copyWith(fontWeight: FontWeight.w700),
              ),
              if (count != null) ...[
                const SizedBox(width: 6),
                Text(
                  '$count',
                  style: PType.meta(
                    color: active
                        ? PColors.onAccent.withValues(alpha: 0.85)
                        : PColors.muted,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _RegionHead extends StatelessWidget {
  const _RegionHead({
    required this.region,
    required this.countries,
    required this.legend,
  });
  final Region region;
  final int countries;
  final bool legend;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(6, 14, 6, 8),
    child: Row(
      children: [
        Expanded(
          child: Text(
            '${region.title.toUpperCase()}  ·  $countries '
            '${countries == 1 ? 'COUNTRY' : 'COUNTRIES'}',
            style: PType.tab(color: PColors.ink),
          ),
        ),
        if (legend)
          ExcludeSemantics(
            child: Text('WORKS HERE', style: PType.tab(color: PColors.ink)),
          ),
      ],
    ),
  );
}

/// One pip per server, slanted like the shards: does it work here?
class _Pips extends StatelessWidget {
  const _Pips(this.exits);
  final List<Exit> exits;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final e in exits.take(8))
          Padding(
            padding: const EdgeInsets.only(right: 3),
            child: Transform(
              transform: Matrix4.skewX(-0.25),
              alignment: Alignment.center,
              child: Container(
                width: 9,
                height: 9,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(2),
                  color: switch (healthOf(e)) {
                    Health.good => PColors.safe,
                    Health.slow => PColors.alert,
                    Health.untested => PColors.mist,
                    Health.dead => PColors.muted.withValues(alpha: 0.35),
                  },
                ),
              ),
            ),
          ),
      ],
    ),
  );
}

/// A country once: its best server's badge, "4 servers · best 95 ms" with
/// a pip per server, CONNECT to the best, and its servers below when open.
class _CountryRow extends StatefulWidget {
  const _CountryRow({
    super.key,
    required this.exits,
    required this.best,
    required this.isOn,
    required this.onOpen,
    required this.onConnect,
  });
  final List<Exit> exits;
  final Exit best;
  final bool Function(Exit) isOn;
  final void Function(Exit) onOpen, onConnect;

  @override
  State<_CountryRow> createState() => _CountryRowState();
}

class _CountryRowState extends State<_CountryRow> {
  bool? _open;

  @override
  Widget build(BuildContext context) {
    final w = widget;
    final many = w.exits.length > 1;
    final on = w.exits.where(w.isOn).firstOrNull;
    final open = many && (_open ?? on != null);
    final kinds = {for (final e in w.exits) e.protocol}.join(', ');
    final ping = w.best.unreachable ? null : w.best.ping;
    final working = w.exits.where((e) => !e.unreachable).length;
    final meta = [
      many ? '${w.exits.length} servers' : w.best.label,
      // a group's protocols show on its server rows; one line stays short
      if (!many || ping == null) kinds,
      if (w.best.pingTesting)
        'testing'
      else if (ping != null)
        many ? 'best $ping ms' : '$ping ms',
    ].join('  ·  ');
    return Column(
      children: [
        Pressable(
          onTap: many
              ? () => setState(() => _open = !open)
              : () => w.onOpen(w.best),
          label: many
              ? '${w.best.title}, ${w.exits.length} servers, $working answer, '
                    '${open ? 'collapse' : 'expand'}'
              : 'Open ${w.best.title}, ${w.best.label}',
          radius: 20,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
            child: Row(
              children: [
                Pressable(
                  onTap: () => AppScope.read(context).testOne(w.best.id),
                  label: 'Test ${w.best.label} now',
                  radius: PRadius.pill,
                  child: SpeedBadge(w.best, size: 44),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        w.best.title,
                        style: PType.h3().copyWith(fontSize: 16),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        meta,
                        style: PType.meta(
                          color: on != null ? PColors.accentInk : PColors.ink,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 5),
                      _Pips(w.exits),
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                Pressable(
                  onTap: () => w.onConnect(on ?? w.best),
                  label: on != null
                      ? '${w.best.title} connected'
                      : 'Connect to ${w.best.title}, ${w.best.label}',
                  selected: on != null,
                  radius: PRadius.pill,
                  color: on != null ? PColors.blue : PColors.field,
                  child: SizedBox(
                    height: 40,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      child: Center(
                        child: Text(
                          on != null ? 'ON' : 'CONNECT',
                          style: PType.button(
                            color: on != null ? PColors.onAccent : PColors.ink,
                          ).copyWith(fontSize: 11),
                        ),
                      ),
                    ),
                  ),
                ),
                SizedBox(
                  width: 26,
                  child: many
                      ? ExcludeSemantics(
                          child: AnimatedRotation(
                            turns: open ? 0.25 : 0,
                            duration: const Duration(milliseconds: 220),
                            curve: Curves.easeOutCubic,
                            child: PIconView(
                              PIcon.chevron,
                              size: 20,
                              color: PColors.muted,
                            ),
                          ),
                        )
                      : null,
                ),
              ],
            ),
          ),
        ),
        AnimatedSize(
          duration: const Duration(milliseconds: 260),
          curve: Curves.easeOutCubic,
          alignment: Alignment.topCenter,
          child: open
              ? Container(
                  margin: const EdgeInsets.fromLTRB(26, 0, 10, 8),
                  decoration: BoxDecoration(
                    color: PColors.field,
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Column(
                    children: [
                      for (final e in w.exits)
                        Opacity(
                          opacity: e.unreachable ? 0.6 : 1,
                          child: ExitRow(
                            exit: e,
                            sub: true,
                            selected: w.isOn(e),
                            onOpen: () => w.onOpen(e),
                            onSelect: () => w.onConnect(e),
                            reason: e.unreachable && e.failure != null
                                ? 'No answer: ${e.failure}'
                                : null,
                          ),
                        ),
                    ],
                  ),
                )
              : const SizedBox(width: double.infinity),
        ),
      ],
    );
  }
}

/// Countries where no server answered on this network: one row that
/// opens into each server and the core's reason.
class _NotAnswering extends StatelessWidget {
  const _NotAnswering({
    required this.groups,
    required this.network,
    required this.open,
    required this.onToggle,
    required this.isOn,
    required this.onOpen,
    required this.onConnect,
  });
  final List<List<Exit>> groups;
  final String? network;
  final bool open;
  final VoidCallback onToggle;
  final bool Function(Exit) isOn;
  final void Function(Exit) onOpen, onConnect;

  @override
  Widget build(BuildContext context) {
    final n = groups.fold<int>(0, (a, g) => a + g.length);
    final title = network == null
        ? 'Not answering here'
        : 'Not answering on $network';
    final line =
        '$n server${n == 1 ? '' : 's'} in ${groups.length} '
        '${groups.length == 1 ? 'country' : 'countries'}  ·  '
        '${open ? 'tap to hide' : 'tap to see why'}';
    return SurfaceCard(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        children: [
          Pressable(
            onTap: onToggle,
            label: '$title, $n servers, ${open ? 'collapse' : 'expand'}',
            radius: 20,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(18, 12, 14, 12),
              child: Row(
                children: [
                  PIconView(PIcon.info, size: 22, color: PColors.alert),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title, style: PType.h3().copyWith(fontSize: 15)),
                        const SizedBox(height: 2),
                        Text(line, style: PType.meta()),
                      ],
                    ),
                  ),
                  AnimatedRotation(
                    turns: open ? 0.25 : 0,
                    duration: const Duration(milliseconds: 220),
                    child: PIconView(
                      PIcon.chevron,
                      size: 20,
                      color: PColors.muted,
                    ),
                  ),
                ],
              ),
            ),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 260),
            curve: Curves.easeOutCubic,
            alignment: Alignment.topCenter,
            child: open
                ? Column(
                    children: [
                      for (final g in groups)
                        for (final e in g)
                          ExitRow(
                            exit: e,
                            selected: isOn(e),
                            onOpen: () => onOpen(e),
                            onSelect: () => onConnect(e),
                            reason: e.failure == null
                                ? 'No answer on the last test'
                                : 'No answer: ${e.failure}',
                            reasonIcon: PIcon.info,
                          ),
                    ],
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}

/// One exit as Locations lists it; Home's Recommended exits reuses it so
/// both read the same.
class ExitRow extends StatelessWidget {
  const ExitRow({
    super.key,
    required this.exit,
    required this.selected,
    required this.onOpen,
    required this.onSelect,
    this.sub = false,
    this.reason,
    this.reasonIcon,
  });
  final Exit exit;
  final bool selected;

  /// Inside a country group: the row names the exit, not the country.
  final bool sub;
  final VoidCallback onOpen, onSelect;

  /// Why Home suggests this exit; drawn in place of the network verdict.
  final String? reason;
  final PIcon? reasonIcon;

  @override
  Widget build(BuildContext context) {
    final net = AppScope.of(context).network;
    return Pressable(
      onTap: onOpen,
      label:
          'Open ${exit.title}, ${exit.label}'
          '${exit.server.tunnel ? ', Iran tunnel' : ''}'
          '${exit.server.panel > 0 ? ', panel ${exit.server.panel}' : ''}'
          '${reason != null ? ', $reason' : ''}',
      radius: 20,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
        child: Row(
          children: [
            Pressable(
              onTap: () => AppScope.read(context).testOne(exit.id),
              label: 'Test ${exit.label} now',
              radius: PRadius.pill,
              child: SpeedBadge(exit, size: sub ? 34 : 44),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (exit.server.panel <= 0 && !exit.server.tunnel)
                    Text(
                      sub ? exit.label : exit.title,
                      style: PType.h3().copyWith(fontSize: 16),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    )
                  else
                    // the marks follow the name and move to a second line
                    // on a narrow phone rather than cut it
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          sub ? exit.label : exit.title,
                          style: PType.h3().copyWith(fontSize: 16),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        if (exit.server.panel > 0) PanelTag(exit.server.panel),
                        if (exit.server.tunnel) const TunnelBadge(),
                      ],
                    ),
                  const SizedBox(height: 4),
                  Text(
                    sub
                        ? exit.meta.replaceFirst('${exit.label}  ·  ', '')
                        : exit.meta,
                    style: PType.meta(color: PColors.ink),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (reason != null) ...[
                    const SizedBox(height: 3),
                    Row(
                      children: [
                        if (reasonIcon != null) ...[
                          PIconView(
                            reasonIcon!,
                            size: 14,
                            color: PColors.accentInk,
                          ),
                          const SizedBox(width: 5),
                        ],
                        Flexible(
                          child: Text(
                            reason!,
                            style: PType.meta(color: PColors.accentInk)
                                .copyWith(fontWeight: FontWeight.w700),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                  ] else if (exit.verdictOn(net) != null) ...[
                    const SizedBox(height: 3),
                    Text(
                      exit.verdictOn(net)!,
                      style: PType.meta(
                        color: exit.verdict == Verdict.strong
                            ? PColors.accentInk
                            : PColors.muted,
                      ).copyWith(fontWeight: FontWeight.w700),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
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
                        ? PIconView(
                            PIcon.check,
                            size: 18,
                            color: PColors.onAccent,
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

/// Which panel a config came from, "P1".
class PanelTag extends StatelessWidget {
  const PanelTag(this.panel, {super.key});
  final int panel;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: Container(
        padding: const EdgeInsets.fromLTRB(5, 1, 5, 1),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: PColors.muted.withValues(alpha: 0.4)),
        ),
        child: Text(
          'P$panel',
          style: PType.meta(color: PColors.muted).copyWith(
            fontSize: 10,
            height: 1.35,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.4,
          ),
        ),
      ),
    );
  }
}

/// A config that enters through Iran (panel 1's "Tunnel" group): a slanted
/// shard, navy by day and blue by night, so it reads apart from the tag.
class TunnelBadge extends StatelessWidget {
  const TunnelBadge({super.key});

  @override
  Widget build(BuildContext context) {
    final fill = PColors.current.isDark ? PColors.blue : PColors.navy;
    return ExcludeSemantics(
      child: Transform(
        transform: Matrix4.skewX(-0.24),
        alignment: Alignment.center,
        child: Container(
          padding: const EdgeInsets.fromLTRB(6, 2, 7, 2),
          decoration: BoxDecoration(
            color: fill,
            borderRadius: BorderRadius.circular(5),
          ),
          child: Transform(
            transform: Matrix4.skewX(0.24),
            alignment: Alignment.center,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                PIconView(PIcon.tunnel, size: 11, color: PColors.onDeep),
                const SizedBox(width: 4),
                Text(
                  'IR TUNNEL',
                  style: PType.meta(color: PColors.onDeep).copyWith(
                    fontSize: 10,
                    height: 1.35,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.5,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// "just now", "25 min ago", "3 h ago", "2 days ago".
String ago(Duration d) {
  if (d.inMinutes < 1) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes} min ago';
  if (d.inHours < 24) return '${d.inHours} h ago';
  return d.inDays == 1 ? '1 day ago' : '${d.inDays} days ago';
}
