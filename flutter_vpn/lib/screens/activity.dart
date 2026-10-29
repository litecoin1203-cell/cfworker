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

/// Activity reads as a log: editorial city headlines, and a meta line of
/// duration, data and protocol. Reconnect re-runs the handshake.
class ActivityScreen extends StatefulWidget {
  const ActivityScreen({super.key});

  @override
  State<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends State<ActivityScreen> {
  bool _saved = false;

  void _reconnect(AppState app, String id) {
    app.connect(id);
    app.setTab(0);
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    return SafeArea(
      bottom: false,
      child: ParallaxScroll(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 140),
          children: [
            Text('Activity', style: PType.h1()),
            const SizedBox(height: 14),
            _Switch(
              saved: _saved,
              onChanged: (v) => setState(() => _saved = v),
            ),
            const SizedBox(height: 18),
            if (!_saved) ..._sessions(app) else ..._savedList(app),
          ],
        ),
      ),
    );
  }

  List<Widget> _sessions(AppState app) {
    final out = <Widget>[];
    var i = 0;
    if (app.phase == Phase.protected) {
      out.add(
        StaggerIn(
          index: i++,
          child: _LogEntry(
            city: app.exit.city,
            time: 'Live',
            meta:
                '${app.elapsed.inMinutes} min  ·  ${app.liveMegabytes.round()} MB  ·  ${app.protocol}',
            live: true,
            onTap: () => app.setTab(0),
          ),
        ),
      );
    }
    String? lastDay;
    for (final s in app.sessions) {
      final day = _day(s.start);
      if (day != lastDay) {
        out.add(
          Padding(
            padding: const EdgeInsets.only(top: 14, bottom: 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(PRadius.pill),
                ),
                child: Text(day, style: PType.meta(color: PColors.ink)),
              ),
            ),
          ),
        );
        lastDay = day;
      }
      final e = exitById(s.exitId);
      out.add(
        StaggerIn(
          index: i++,
          child: _LogEntry(
            city: e.city,
            time: _time(s.start),
            meta:
                '${s.minutes} min  ·  ${_data(s.megabytes)}  ·  ${s.protocol}',
            onTap: () => Navigator.of(
              context,
            ).push(TunnelRoute(builder: (_) => LocationDetail(exitId: e.id))),
            onReconnect: () => _reconnect(app, e.id),
          ),
        ),
      );
    }
    return out;
  }

  List<Widget> _savedList(AppState app) {
    final saved = exits.where((e) => app.saved.contains(e.id)).toList();
    if (saved.isEmpty) {
      return [
        SurfaceCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Nothing saved yet', style: PType.h3()),
              const SizedBox(height: 6),
              Text(
                'Open a city and tap the bookmark to keep it here.',
                style: PType.small(),
              ),
              const SizedBox(height: 14),
              PillButton(
                label: 'Browse locations',
                onTap: () => app.setTab(2),
                expand: false,
                height: 46,
              ),
            ],
          ),
        ),
      ];
    }
    return [
      for (var i = 0; i < saved.length; i++)
        Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: StaggerIn(
            index: i,
            child: MediaCard(
              exit: saved[i],
              height: 160,
              onOpen: () => Navigator.of(context).push(
                TunnelRoute(
                  builder: (_) => LocationDetail(exitId: saved[i].id),
                ),
              ),
              tabLabel: 'Reconnect',
              onTab: () => _reconnect(app, saved[i].id),
            ),
          ),
        ),
    ];
  }

  static const _months = [
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
  static const _days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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

  String _data(int mb) =>
      mb >= 1024 ? '${(mb / 1024).toStringAsFixed(1)} GB' : '$mb MB';
}

class _Switch extends StatelessWidget {
  const _Switch({required this.saved, required this.onChanged});
  final bool saved;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    Widget tab(bool v, PIcon icon, String label) => Expanded(
      child: Pressable(
        onTap: () => onChanged(v),
        label: label,
        selected: saved == v,
        radius: 16,
        child: SizedBox(
          height: 48,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              PIconView(
                icon,
                size: 20,
                color: saved == v ? PColors.blue : PColors.ink,
              ),
              const SizedBox(width: 8),
              Text(
                label,
                style: PType.small(
                  color: saved == v ? PColors.blue : PColors.ink,
                ).copyWith(fontWeight: FontWeight.w700),
              ),
            ],
          ),
        ),
      ),
    );
    return SurfaceCard(
      padding: const EdgeInsets.symmetric(horizontal: 6),
      radius: 24,
      child: Stack(
        children: [
          Row(
            children: [
              tab(false, PIcon.pulse, 'Sessions'),
              tab(true, PIcon.bookmark, 'Saved'),
            ],
          ),
          AnimatedAlign(
            duration: PMotion.reduced(context) ? Duration.zero : PMotion.quick,
            curve: Curves.easeOutBack,
            alignment: saved ? Alignment.bottomRight : Alignment.bottomLeft,
            child: FractionallySizedBox(
              widthFactor: 0.5,
              child: Container(
                height: 3,
                margin: const EdgeInsets.symmetric(horizontal: 28),
                decoration: BoxDecoration(
                  color: PColors.blue,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _LogEntry extends StatelessWidget {
  const _LogEntry({
    required this.city,
    required this.time,
    required this.meta,
    required this.onTap,
    this.onReconnect,
    this.live = false,
  });

  final String city, time, meta;
  final VoidCallback onTap;
  final VoidCallback? onReconnect;
  final bool live;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: SurfaceCard(
        onTap: onTap,
        label: 'Session in $city',
        padding: const EdgeInsets.fromLTRB(20, 16, 10, 16),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      if (live) ...[
                        Container(
                          width: 8,
                          height: 8,
                          decoration: const BoxDecoration(
                            color: PColors.safe,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 6),
                      ],
                      Text(
                        time,
                        style: PType.meta(
                          color: live ? PColors.safe : PColors.muted,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(city, style: PType.h2().copyWith(fontSize: 24)),
                  const SizedBox(height: 4),
                  Text(meta, style: PType.meta(color: PColors.ink)),
                ],
              ),
            ),
            if (onReconnect != null)
              RoundIcon(
                PIcon.refresh,
                onTap: onReconnect!,
                label: 'Reconnect to $city',
                color: PColors.blue,
                background: PColors.mist,
              ),
          ],
        ),
      ),
    );
  }
}
