import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'location_detail.dart';
import 'plan_usage.dart';
import 'shell.dart';
import 'states.dart';

/// Activity (Ali's pick C, "Account hub"): the plan with its data and days
/// (moved here from Profile), the last sessions on this phone, and what
/// Pleat keeps about them. The backend keeps no session history.
class ActivityScreen extends StatelessWidget {
  const ActivityScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final live = app.phase == Phase.protected && app.exit != null;
    final recent = app.sessions.take(live ? 2 : 3).toList();
    return SafeArea(
      bottom: false,
      child: ParallaxScroll(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 140),
          children: [
            Text('Activity', style: PType.h1()),
            const SizedBox(height: 14),
            StaggerIn(index: 0, child: PlanHub(app: app)),
            const SizedBox(height: 24),
            _Head(
              'Recent sessions',
              action: app.sessions.length > recent.length ? 'See all' : null,
              onAction: () =>
                  Navigator.of(context)
                      .push(FadeRoute(builder: (_) => const SessionsScreen())),
            ),
            const SizedBox(height: 10),
            StaggerIn(
              index: 1,
              child: SurfaceCard(
                padding: const EdgeInsets.fromLTRB(16, 6, 10, 6),
                child: !live && recent.isEmpty
                    ? Padding(
                        padding: const EdgeInsets.fromLTRB(4, 12, 4, 12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('No sessions yet', style: PType.h3()),
                            const SizedBox(height: 4),
                            Text(
                              app.keepHistory
                                  ? 'Sessions show here, on this phone, once a tunnel really runs.'
                                  : 'Keep history is off, so nothing is logged.',
                              style: PType.small(),
                            ),
                          ],
                        ),
                      )
                    : Column(
                        children: [
                          if (live) _SessionRow.live(app, first: true),
                          for (var i = 0; i < recent.length; i++)
                            _SessionRow(app, recent[i], first: !live && i == 0),
                        ],
                      ),
              ),
            ),
            const SizedBox(height: 24),
            const _Head('Your privacy'),
            const SizedBox(height: 10),
            StaggerIn(index: 2, child: _Privacy(app: app)),
          ],
        ),
      ),
    );
  }
}

class _Head extends StatelessWidget {
  const _Head(this.title, {this.action, this.onAction});
  final String title;
  final String? action;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(child: Text(title, style: PType.h3())),
      if (action != null)
        Pressable(
          onTap: onAction,
          label: action!,
          radius: PRadius.pill,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Text(
              action!,
              style: PType.small(color: PColors.accentInk)
                  .copyWith(fontWeight: FontWeight.w800),
            ),
          ),
        ),
    ],
  );
}

/// One session: flag, "Germany · DE 1", when, how long and the protocol;
/// Reconnect on the right (LIVE for the one running now).
class _SessionRow extends StatelessWidget {
  _SessionRow(this.app, Session s, {required this.first})
    : title = s.title,
      exitId = s.exitId,
      when = '${_day(s.start)} ${_time(s.start)}',
      minutes = s.minutes,
      protocol = s.protocol,
      live = false;

  _SessionRow.live(this.app, {required this.first})
    : title = app.exit!.title,
      exitId = app.exit!.id,
      when = 'Now',
      minutes = app.elapsed.inMinutes,
      protocol = app.exit!.protocol,
      live = true;

  final AppState app;
  final String title, exitId, when, protocol;
  final int minutes;
  final bool first, live;

  @override
  Widget build(BuildContext context) {
    final e = app.exitById(exitId);
    final name = e == null ? title : '$title · ${e.label}';
    final meta = [when, _dur(minutes), protocol].join('  ·  ');
    return Container(
      decoration: BoxDecoration(
        border: first
            ? null
            : Border(top: BorderSide(color: PColors.field, width: 1.2)),
      ),
      child: Pressable(
        onTap: live
            ? () => app.setTab(0)
            : e == null
            ? null
            : () => Navigator.of(
                context,
              ).push(TunnelRoute(builder: (_) => LocationDetail(exitId: e.id))),
        label: 'Session in $name',
        radius: 16,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Row(
            children: [
              e == null
                  ? Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        color: PColors.mist,
                        shape: BoxShape.circle,
                      ),
                      alignment: Alignment.center,
                      child: PIconView(
                        PIcon.pin,
                        size: 20,
                        color: PColors.accentInk,
                      ),
                    )
                  : RegionBadge(e, size: 40),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      style: PType.h3().copyWith(fontSize: 15),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      meta,
                      style: PType.meta(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              if (live)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: SoftChip('LIVE', color: PColors.safe),
                )
              else if (e != null)
                RoundIcon(
                  PIcon.refresh,
                  onTap: () {
                    app.connect(e.id);
                    app.setTab(0);
                  },
                  label: 'Reconnect to $name',
                  color: PColors.accentInk,
                  background: PColors.mist,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// What Pleat keeps about sessions, and the two controls over it.
class _Privacy extends StatelessWidget {
  const _Privacy({required this.app});
  final AppState app;

  Future<void> _clear(BuildContext context) async {
    final ok = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Colors.transparent,
      barrierColor: PColors.scrim,
      builder: (context) => Container(
        decoration: BoxDecoration(
          color: PColors.surface,
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(PRadius.sheet),
          ),
        ),
        padding: EdgeInsets.fromLTRB(
          24,
          22,
          24,
          24 + MediaQuery.paddingOf(context).bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Clear history?', style: PType.h2()),
            const SizedBox(height: 8),
            Text(
              'Sessions and connect tries on this phone are deleted. Stats starts again. Your plan and saved exits stay.',
              style: PType.small(),
            ),
            const SizedBox(height: 20),
            Row(
              children: [
                Expanded(
                  child: PillButton(
                    label: 'Keep',
                    onTap: () => Navigator.of(context).pop(false),
                    color: PColors.field,
                    textColor: PColors.ink,
                    height: 48,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: PillButton(
                    label: 'Clear',
                    onTap: () => Navigator.of(context).pop(true),
                    height: 48,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
    if (ok == true) {
      app.clearHistory();
      if (context.mounted) showNote(context, 'History cleared.');
    }
  }

  @override
  Widget build(BuildContext context) {
    Widget row(
      PIcon icon,
      String title,
      String body, {
      Widget? trailing,
      VoidCallback? onTap,
      Color? iconColor,
      bool first = false,
    }) {
      final inner = Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Row(
          children: [
            PIconView(icon, color: iconColor ?? PColors.accentInk),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: PType.h3().copyWith(fontSize: 15)),
                  const SizedBox(height: 2),
                  Text(body, style: PType.small()),
                ],
              ),
            ),
            if (trailing != null) ...[const SizedBox(width: 8), trailing],
          ],
        ),
      );
      return Container(
        decoration: BoxDecoration(
          border: first
              ? null
              : Border(top: BorderSide(color: PColors.field, width: 1.2)),
        ),
        child: onTap == null
            ? inner
            : Pressable(onTap: onTap, label: title, radius: 16, child: inner),
      );
    }

    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(20, 4, 12, 4),
      child: Column(
        children: [
          row(
            PIcon.lock,
            'History stays on this phone',
            'Pleat servers keep no session log.',
            first: true,
          ),
          row(
            PIcon.clock,
            'Keep history',
            app.keepHistory
                ? '${AppState.historyDays} days, then it deletes itself.'
                : 'Off. Nothing is logged.',
            trailing: PToggle(
              value: app.keepHistory,
              onChanged: app.setKeepHistory,
              label: 'Keep history',
            ),
          ),
          row(
            PIcon.close,
            'Clear history now',
            'Sessions and connect tries on this phone.',
            iconColor: PColors.alert,
            onTap: () => _clear(context),
          ),
        ],
      ),
    );
  }
}

/// Every session kept on this phone, by day.
class SessionsScreen extends StatelessWidget {
  const SessionsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final rows = <Widget>[];
    String? lastDay;
    final day = <Widget>[];
    void flush() {
      if (day.isEmpty) return;
      rows.add(
        SurfaceCard(
          padding: const EdgeInsets.fromLTRB(16, 6, 10, 6),
          child: Column(children: List.of(day)),
        ),
      );
      day.clear();
    }

    for (final s in app.sessions) {
      final d = _day(s.start);
      if (d != lastDay) {
        flush();
        rows.add(
          Padding(
            padding: const EdgeInsets.only(top: 16, bottom: 8),
            child: Text(d, style: PType.meta(color: PColors.ink)),
          ),
        );
        lastDay = d;
      }
      day.add(_SessionRow(app, s, first: day.isEmpty));
    }
    flush();
    return Scaffold(
      backgroundColor: PColors.ground,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: RoundIcon(
                PIcon.back,
                onTap: () => Navigator.of(context).pop(),
                label: 'Back',
              ),
            ),
            const SizedBox(height: 12),
            Text('Sessions', style: PType.h1()),
            const SizedBox(height: 4),
            Text(
              'Kept on this phone for ${AppState.historyDays} days.',
              style: PType.small(),
            ),
            ...rows,
          ],
        ),
      ),
    );
  }
}

String _dur(int minutes) {
  if (minutes < 60) return '$minutes min';
  final m = minutes % 60;
  return m == 0 ? '${minutes ~/ 60} h' : '${minutes ~/ 60} h $m';
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
const _days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

String _day(DateTime d) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final that = DateTime(d.year, d.month, d.day);
  final diff = today.difference(that).inDays;
  if (diff == 0) return 'Today';
  if (diff == 1) return 'Yesterday';
  return '${_days[d.weekday - 1]} ${d.day} ${_months[d.month - 1]}';
}

String _time(DateTime d) =>
    '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
