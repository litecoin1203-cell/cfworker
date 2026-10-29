import 'package:flutter/material.dart';

import '../design/backdrop.dart';
import '../design/icons.dart';
import '../design/scenes.dart';
import '../design/mark.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'login.dart';
import 'plans.dart';

/// Profile, opened from the avatar. Sign out returns to Login.
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final plan = app.plan;
    return Scaffold(
      backgroundColor: PColors.ground,
      body: ShardBackdrop(
        layout: Layouts.profile,
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
            children: [
              Row(
                children: [
                  RoundIcon(
                    PIcon.back,
                    onTap: () => Navigator.of(context).pop(),
                    label: 'Back',
                  ),
                  const Spacer(),
                  const PleatMark(size: 30),
                  const SizedBox(width: 12),
                ],
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Container(
                    width: 72,
                    height: 72,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: PColors.navy,
                      border: Border.all(color: Colors.white, width: 4),
                      boxShadow: PShadow.soft(),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      app.firstName.substring(0, 1),
                      style: PType.h1(color: Colors.white),
                    ),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(app.firstName, style: PType.h2()),
                        const SizedBox(height: 2),
                        Text(
                          app.email,
                          style: PType.small(),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 22),
              SurfaceCard(
                onTap: () =>
                    Navigator.of(context)
                        .push(FadeRoute(builder: (_) => const PlansScreen())),
                label: 'Plans',
                child: Row(
                  children: [
                    Container(
                      width: 48,
                      height: 48,
                      decoration: const BoxDecoration(
                        color: PColors.mist,
                        shape: BoxShape.circle,
                      ),
                      alignment: Alignment.center,
                      child: const PIconView(PIcon.ticket, color: PColors.blue),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            plan == null ? 'No plan yet' : '${plan.name} trial',
                            style: PType.h3(),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            plan == null || app.trialEnds == null
                                ? 'Pick a demo plan'
                                : '${app.trialEnds!.difference(DateTime.now()).inDays + 1} days left  ·  ${plan.devices} device${plan.devices == 1 ? '' : 's'}',
                            style: PType.small(),
                          ),
                        ],
                      ),
                    ),
                    const PIconView(PIcon.chevron, color: PColors.muted),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              SurfaceCard(
                padding: const EdgeInsets.fromLTRB(20, 8, 10, 8),
                child: Column(
                  children: [
                    _Row(
                      icon: PIcon.pulse,
                      title: 'Reduce motion',
                      body:
                          'Shards and orbits hold still. States still change.',
                      trailing: PToggle(
                        value: app.reduceMotion,
                        onChanged: (v) => app.update((s) => s.reduceMotion = v),
                        label: 'Reduce motion',
                      ),
                    ),
                    _Row(
                      icon: PIcon.bolt,
                      title: 'Simulate a dropped tunnel',
                      body: app.phase == Phase.protected
                          ? 'Demo only. Shows the red dropped state.'
                          : 'Connect first, then try this.',
                      trailing: Pressable(
                        onTap: app.phase == Phase.protected
                            ? () {
                                app.simulateDrop();
                                app.setTab(0);
                                Navigator.of(context).pop();
                              }
                            : null,
                        label: 'Simulate drop',
                        radius: PRadius.pill,
                        color: app.phase == Phase.protected
                            ? PColors.mist
                            : PColors.field,
                        child: SizedBox(
                          height: 40,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 14),
                            child: Center(
                              child: Text(
                                'DROP',
                                style: PType.button(
                                  color: app.phase == Phase.protected
                                      ? PColors.blue
                                      : PColors.muted,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 22),
              PillButton(
                label: 'Sign out',
                icon: PIcon.logout,
                color: Colors.white,
                textColor: PColors.ink,
                onTap: () {
                  app.signOut();
                  Navigator.of(context).pushAndRemoveUntil(
                    FadeRoute(builder: (_) => const LoginScreen()),
                    (_) => false,
                  );
                },
              ),
              const SizedBox(height: 16),
              Center(
                child: Text(
                  'Pleat demo 1.0  ·  no real tunnel, no payments',
                  style: PType.meta(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({
    required this.icon,
    required this.title,
    required this.body,
    required this.trailing,
  });
  final PIcon icon;
  final String title, body;
  final Widget trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: [
          PIconView(icon, color: PColors.blue),
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
          const SizedBox(width: 8),
          trailing,
        ],
      ),
    );
  }
}
