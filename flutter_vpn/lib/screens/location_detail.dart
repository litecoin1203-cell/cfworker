import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/seed.dart';

/// Where the tunnel flight lands: the city photo, a frosted slab of ping,
/// load and protocol, a bookmark, and Connect here.
class LocationDetail extends StatelessWidget {
  const LocationDetail({super.key, required this.exitId});
  final String exitId;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final exit = exitById(exitId);
    final here = app.exitId == exit.id;
    final live = here && app.phase == Phase.protected;
    final saved = app.saved.contains(exit.id);
    final top = MediaQuery.paddingOf(context).top;
    final photoH = MediaQuery.sizeOf(context).height * 0.56;

    return Scaffold(
      backgroundColor: PColors.ground,
      body: Stack(
        fit: StackFit.expand,
        children: [
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: photoH + 40,
            child: CityArt(exit: exit),
          ),
          Positioned(
            top: top + 8,
            left: 16,
            right: 16,
            child: Row(
              children: [
                RoundIcon(
                  PIcon.back,
                  onTap: () => Navigator.of(context).pop(),
                  label: 'Back',
                  color: PColors.ink,
                  background: Colors.white,
                ),
                const Spacer(),
                RoundIcon(
                  PIcon.bookmark,
                  onTap: () => app.toggleSaved(exit.id),
                  label: saved ? 'Remove from saved' : 'Save ${exit.city}',
                  filled: saved,
                  color: saved ? PColors.blue : PColors.ink,
                  background: Colors.white,
                ),
              ],
            ),
          ),
          Positioned(
            left: 20,
            right: 20,
            top: top + 76,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    RegionBadge(exit, size: 40),
                    const SizedBox(width: 10),
                    Text(
                      exit.country,
                      style: PType.small(color: Colors.white)
                          .copyWith(fontWeight: FontWeight.w700),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  exit.city,
                  style: PType.h1(color: Colors.white).copyWith(fontSize: 40),
                ),
              ],
            ),
          ),
          Positioned(
            left: 20,
            right: 20,
            top: photoH - 96,
            child: FrostedSlab(
              child: Row(
                children: [
                  _Metric(label: 'Ping', value: '${exit.ping}', unit: 'ms'),
                  const _Divider(),
                  _Metric(label: 'Load', value: '${exit.load}', unit: '%'),
                  const _Divider(),
                  _Metric(label: 'Protocol', value: app.protocol, unit: ''),
                ],
              ),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            top: photoH + 8,
            child: Container(
              decoration: const BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.vertical(
                  top: Radius.circular(PRadius.sheet),
                ),
              ),
              padding: EdgeInsets.fromLTRB(
                24,
                24,
                24,
                20 + MediaQuery.paddingOf(context).bottom,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(exit.blurb, style: PType.body()),
                  const SizedBox(height: 10),
                  Text(
                    live
                        ? 'You are protected through this exit.'
                        : (here
                              ? 'This is your selected exit.'
                              : 'Connecting here makes it your exit.'),
                    style: PType.small(
                      color: live ? PColors.safe : PColors.muted,
                    ).copyWith(fontWeight: FontWeight.w700),
                  ),
                  const Spacer(),
                  PillButton(
                    label: live ? 'Disconnect' : 'Connect here',
                    icon: live ? PIcon.power : PIcon.shield,
                    color: live ? PColors.navy : PColors.blue,
                    onTap: () {
                      if (live) {
                        app.disconnect();
                      } else {
                        app.connect(exit.id);
                        app.setTab(0);
                        Navigator.of(context).pop();
                      }
                    },
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric({required this.label, required this.value, required this.unit});
  final String label, value, unit;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Column(
        children: [
          Text(label, style: PType.meta()),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text.rich(
              TextSpan(
                children: [
                  TextSpan(text: value, style: PType.h2()),
                  if (unit.isNotEmpty)
                    TextSpan(text: ' $unit', style: PType.small()),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Divider extends StatelessWidget {
  const _Divider();
  @override
  Widget build(BuildContext context) => Container(
    width: 1,
    height: 34,
    color: PColors.navy.withValues(alpha: 0.10),
  );
}
