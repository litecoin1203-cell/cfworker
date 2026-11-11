import 'package:flutter/material.dart';

import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/route_mode.dart';

/// Home's Stats under the plan card: Data pace, Hardest hours and What
/// works here. All of it is counted on this phone, except "All Pleat
/// users", which reads the operator ranking the app already loads.
class StatsPanel extends StatelessWidget {
  const StatsPanel({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 14, 20, 0),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        StaggerIn(index: 0, child: _PaceCard(app: app)),
        const SizedBox(height: 14),
        StaggerIn(index: 1, child: _HoursCard(app: app)),
        const SizedBox(height: 14),
        StaggerIn(index: 2, child: _WorksCard(app: app)),
      ],
    ),
  );
}

const _gb = 1073741824;

String _size(int bytes) {
  if (bytes >= _gb) return '${(bytes / _gb).toStringAsFixed(1)} GB';
  return '${(bytes / 1048576).round()} MB';
}

const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

String _date(DateTime d) => '${_months[d.month - 1]} ${d.day}';

class _CardHead extends StatelessWidget {
  const _CardHead(this.title, {this.side});
  final String title;
  final String? side;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.end,
    children: [
      Expanded(
        child: Text(
          title.toUpperCase(),
          style: PType.meta(color: PColors.muted).copyWith(
            fontWeight: FontWeight.w800,
            letterSpacing: 1.1,
            fontSize: 10.5,
          ),
        ),
      ),
      if (side != null)
        Text(
          side!,
          style: PType.meta(color: PColors.accentInk)
              .copyWith(fontWeight: FontWeight.w700),
        ),
    ],
  );
}

class _Headline extends StatelessWidget {
  const _Headline(this.title, this.sub);
  final String title, sub;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const SizedBox(height: 8),
      Text(title, style: PType.h2().copyWith(fontSize: 21)),
      const SizedBox(height: 3),
      Text(sub, style: PType.small()),
    ],
  );
}

class _Kpi extends StatelessWidget {
  const _Kpi(this.value, this.unit, this.label);
  final String value, unit, label;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
    decoration: BoxDecoration(
      color: PColors.field,
      borderRadius: BorderRadius.circular(16),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text.rich(
          TextSpan(
            text: value,
            style: PType.h2().copyWith(fontSize: 20),
            children: [
              TextSpan(
                text: ' $unit',
                style: PType.meta(color: PColors.muted)
                    .copyWith(fontWeight: FontWeight.w700),
              ),
            ],
          ),
        ),
        const SizedBox(height: 2),
        Text(label, style: PType.meta(color: PColors.muted)),
      ],
    ),
  );
}

// ---- Data pace -------------------------------------------------------------

class _PaceCard extends StatelessWidget {
  const _PaceCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final s = app.subscription;
    final days = app.usageDays(14);
    final known = days.where((d) => d.$2 != null).length;
    final p = app.dataPace;
    String title, sub;
    if (s == null) {
      title = 'No plan yet';
      sub = 'Your daily use shows here once you have a plan.';
    } else if (known < 2) {
      title = 'Learning your pace';
      sub = 'Pleat notes your plan’s data once a day. The forecast shows after two days.';
    } else if (s.unlimitedData) {
      final avg = app.usageLog.pace();
      title = avg == null ? 'No data cap' : '${_size(avg)} a day';
      sub = 'Your plan has no data cap, so it never runs out.';
    } else if (p == null) {
      title = 'Learning your pace';
      sub = 'The forecast shows after two days of use.';
    } else {
      final left = (s.dataLimitBytes - s.usedBytes).clamp(0, s.dataLimitBytes);
      final end = s.expiresAt;
      final out = p.runsOut;
      if (out != null && end != null && out.isBefore(end)) {
        final early = end.difference(out).inDays;
        title = 'Lasts until ${_date(out)}';
        sub =
            'At this pace your ${_size(left)} left runs out ${early <= 1 ? 'a day' : '$early days'} before your plan ends.';
      } else if (out != null && end == null) {
        title = 'Lasts until ${_date(out)}';
        sub = 'At this pace your ${_size(left)} left lasts until then.';
      } else {
        title = 'Lasts the whole plan';
        final spare = end == null
            ? null
            : left - p.pace * end.difference(DateTime.now()).inDays;
        sub = spare != null && spare > 0
            ? 'At this pace about ${_size(spare)} is still left when the plan ends.'
            : 'At this pace your data lasts until the plan ends.';
      }
    }
    final max = days.fold<int>(
      1,
      (m, d) => d.$2 != null && d.$2! > m ? d.$2! : m,
    );
    final avg = app.usageLog.pace(n: 14);
    final today = days.isEmpty ? null : days.last.$2;
    return SurfaceCard(
      radius: 24,
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const _CardHead('Data pace', side: 'Last 14 days'),
          _Headline(title, sub),
          const SizedBox(height: 14),
          SizedBox(
            height: 96,
            child: Semantics(
              label:
                  'Data used per day, last 14 days${avg == null ? '' : ', about ${_size(avg)} a day'}',
              child: ExcludeSemantics(
                child: Stack(
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        for (var i = 0; i < days.length; i++)
                          Expanded(
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 2,
                              ),
                              child: days[i].$2 == null
                                  ? Align(
                                      alignment: Alignment.bottomCenter,
                                      child: Container(
                                        height: 4,
                                        decoration: BoxDecoration(
                                          color: PColors.mist,
                                          borderRadius: BorderRadius.circular(
                                            2,
                                          ),
                                        ),
                                      ),
                                    )
                                  : FractionallySizedBox(
                                      heightFactor: (days[i].$2! / max).clamp(
                                        0.04,
                                        1.0,
                                      ),
                                      alignment: Alignment.bottomCenter,
                                      child: Container(
                                        decoration: BoxDecoration(
                                          color: i == days.length - 1
                                              ? PColors.blue
                                              : PColors.ice,
                                          borderRadius:
                                              const BorderRadius.vertical(
                                                top: Radius.circular(4),
                                                bottom: Radius.circular(1),
                                              ),
                                        ),
                                      ),
                                    ),
                            ),
                          ),
                      ],
                    ),
                    if (avg != null && known >= 2)
                      Positioned(
                        left: 0,
                        right: 0,
                        bottom: 96 * (avg / max).clamp(0.0, 1.0),
                        child: Row(
                          children: [
                            Expanded(
                              child: CustomPaint(
                                size: const Size(double.infinity, 1.5),
                                painter: _Dash(PColors.muted),
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                _date(days.first.$1),
                style: PType.meta(color: PColors.muted),
              ),
              if (avg != null && known >= 2)
                Text(
                  '- - avg ${_size(avg)}/day',
                  style: PType.meta(color: PColors.muted),
                ),
              Text('Today', style: PType.meta(color: PColors.muted)),
            ],
          ),
          if (s != null && known >= 2) ...[
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _Kpi(
                    today == null ? '—' : _size(today).split(' ').first,
                    today == null ? '' : _size(today).split(' ').last,
                    'Used today',
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: p?.perDayToLast == null
                      ? _Kpi(
                          s.daysLeft == null ? '∞' : '${s.daysLeft}',
                          'days',
                          'Left on your plan',
                        )
                      : _Kpi(
                          _size(p!.perDayToLast!).split(' ').first,
                          '${_size(p.perDayToLast!).split(' ').last}/day',
                          'To last the whole plan',
                        ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _Dash extends CustomPainter {
  const _Dash(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color.withValues(alpha: 0.8)
      ..strokeWidth = 1.5;
    for (var x = 0.0; x < size.width; x += 9) {
      canvas.drawLine(Offset(x, 0), Offset(x + 5, 0), paint);
    }
  }

  @override
  bool shouldRepaint(_Dash old) => old.color != color;
}

// ---- Hardest hours -----------------------------------------------------------

class _HoursCard extends StatelessWidget {
  const _HoursCard({required this.app});
  final AppState app;

  static const _rows = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

  @override
  Widget build(BuildContext context) {
    final grid = app.hardness;
    final h = app.hardest;
    final net = app.network?.label;
    String two(int x) => '${x.toString().padLeft(2, '0')}:00';
    final String title, sub;
    if (h == null) {
      title = 'Still counting';
      sub =
          'Fills in as you connect on ${net ?? 'this network'}: which hours filtering makes it hardest.';
    } else {
      title = '${two(h.from)}–${two(h.to)}';
      final pct = (h.share * 100).round();
      final best = h.best;
      sub = best == null
          ? '$pct% of tries failed in these hours.'
          : '$pct% of tries failed then. ${best.title} got through ${h.ok} of ${h.n} times.';
    }
    final steps = [
      PColors.field,
      Color.lerp(PColors.mist, PColors.ice, 0.4)!,
      PColors.ice,
      PColors.blue,
      PColors.navy,
    ];
    final empty = PColors.current.isDark
        ? PColors.field
        : PColors.ground.withValues(alpha: 0.6);
    Color cell(double? v) {
      if (v == null) return empty;
      return steps[(v * 4).round().clamp(0, 4)];
    }

    return SurfaceCard(
      radius: 24,
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _CardHead(
            'Hardest hours',
            side: net == null ? null : '$net · 30 days',
          ),
          _Headline(title, sub),
          const SizedBox(height: 12),
          Semantics(
            label: 'Failed connects by day and hour, last 30 days',
            child: ExcludeSemantics(
              child: Column(
                children: [
                  for (var r = 0; r < 7; r++)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Row(
                        children: [
                          SizedBox(
                            width: 28,
                            child: Text(
                              _rows[r],
                              style: PType.meta(color: PColors.muted)
                                  .copyWith(fontSize: 9.5),
                            ),
                          ),
                          for (var c = 0; c < 24; c++)
                            Expanded(
                              child: Container(
                                height: 13,
                                margin: const EdgeInsets.symmetric(
                                  horizontal: 1,
                                ),
                                decoration: BoxDecoration(
                                  color: cell(grid[r][c]),
                                  borderRadius: BorderRadius.circular(3),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      const SizedBox(width: 28),
                      for (final t in const ['00', '06', '12', '18'])
                        Expanded(
                          child: Text(
                            t,
                            style: PType.meta(color: PColors.muted)
                                .copyWith(fontSize: 9.5),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Text('Easy', style: PType.meta(color: PColors.muted)),
              const SizedBox(width: 6),
              for (final c in steps.skip(1))
                Container(
                  width: 16,
                  height: 9,
                  margin: const EdgeInsets.only(right: 3),
                  decoration: BoxDecoration(
                    color: c,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              const SizedBox(width: 3),
              Text('Hard', style: PType.meta(color: PColors.muted)),
              const Spacer(),
              Text('Blank: no tries', style: PType.meta(color: PColors.muted)),
            ],
          ),
        ],
      ),
    );
  }
}

// ---- What works here -------------------------------------------------------

class _WorksCard extends StatefulWidget {
  const _WorksCard({required this.app});
  final AppState app;

  @override
  State<_WorksCard> createState() => _WorksCardState();
}

class _WorksCardState extends State<_WorksCard> {
  bool _all = false;

  @override
  Widget build(BuildContext context) {
    final app = widget.app;
    final net = app.network;
    final mine = app.familyMine;
    final all = app.familyAll;
    final goals = [
      for (final m in const [
        RouteMode.stealth,
        RouteMode.speed,
        RouteMode.classic,
      ])
        if (app.routeModes.contains(m)) m,
    ];
    final rows = <(RouteMode, double?, String, String)>[];
    for (final m in goals) {
      if (_all) {
        final v = all[m];
        rows.add((
          m,
          v?.$1,
          v == null ? '—' : '${(v.$1 * 100).round()}%',
          v == null
              ? 'no reports'
              : (v.$2 > 0 ? '${v.$2} ms' : '${v.$3} reports'),
        ));
      } else {
        final v = mine[m];
        rows.add((
          m,
          v == null ? null : v.$1 / v.$2,
          v == null ? '—' : '${(v.$1 / v.$2 * 100).round()}%',
          v == null ? 'not tried' : '${v.$1} of ${v.$2}',
        ));
      }
    }
    double best = 0;
    for (final r in rows) {
      if ((r.$2 ?? 0) > best) best = r.$2!;
    }
    final seg = PMotion.reduced(context) ? Duration.zero : PMotion.quick;
    return SurfaceCard(
      radius: 24,
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _CardHead(
            'What works on ${net?.name ?? 'your network'}',
            side: _all ? null : 'Last 7 days',
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(4),
            decoration: BoxDecoration(
              color: PColors.field,
              borderRadius: BorderRadius.circular(PRadius.pill),
            ),
            child: Row(
              children: [
                for (final (v, t) in const [
                  (false, 'My phone'),
                  (true, 'All Pleat users'),
                ])
                  Expanded(
                    child: Pressable(
                      onTap: () => setState(() => _all = v),
                      label: t,
                      selected: _all == v,
                      radius: PRadius.pill,
                      child: AnimatedContainer(
                        duration: seg,
                        padding: const EdgeInsets.symmetric(vertical: 9),
                        decoration: BoxDecoration(
                          color: _all == v
                              ? PColors.surface
                              : Colors.transparent,
                          borderRadius: BorderRadius.circular(PRadius.pill),
                          boxShadow: _all == v ? PShadow.soft() : null,
                        ),
                        alignment: Alignment.center,
                        child: Text(
                          t,
                          style: PType.small(
                            color: _all == v ? PColors.ink : PColors.muted,
                          ).copyWith(fontWeight: FontWeight.w800),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          for (final (m, share, value, sub) in rows)
            Pressable(
              onTap: () => app.setRoute(m),
              label: '${m.title}: $value, $sub. Tap to use ${m.title}.',
              radius: 14,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 2),
                child: Row(
                  children: [
                    SizedBox(
                      width: 70,
                      child: Text(
                        m.title,
                        style: PType.small(color: PColors.ink)
                            .copyWith(fontWeight: FontWeight.w700),
                      ),
                    ),
                    Expanded(
                      child: Container(
                        height: 10,
                        decoration: BoxDecoration(
                          color: PColors.field,
                          borderRadius: BorderRadius.circular(PRadius.pill),
                        ),
                        alignment: Alignment.centerLeft,
                        child: FractionallySizedBox(
                          widthFactor: (share ?? 0).clamp(0.0, 1.0),
                          child: Container(
                            decoration: BoxDecoration(
                              color: share != null && share >= best && best > 0
                                  ? PColors.blue
                                  : PColors.ice,
                              borderRadius: BorderRadius.circular(PRadius.pill),
                            ),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    SizedBox(
                      width: 70,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(
                            value,
                            style: PType.small(color: PColors.ink)
                                .copyWith(fontWeight: FontWeight.w800),
                          ),
                          Text(
                            sub,
                            style: PType.meta(color: PColors.muted)
                                .copyWith(fontSize: 10.5),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 4),
          UnavailableNote(
            _all
                ? 'Share of tests that worked for Pleat users on ${net?.name ?? 'this operator'}, from the reports the app already sends. Tap a goal to use it.'
                : 'Share of connects that worked on this phone and network. Tap a goal to use it.',
          ),
        ],
      ),
    );
  }
}
