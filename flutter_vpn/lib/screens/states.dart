import 'package:flutter/material.dart';

import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'plans.dart';

/// Loading, error and empty states for the server list, in the surface
/// card the screens already use.
class ServersState extends StatelessWidget {
  const ServersState({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final noPlan = app.me.ready && app.subscription == null;
    final (title, body, action) = app.servers.loading || app.me.loading
        ? ('Loading exits…', 'Asking the server for your list.', null)
        : noPlan
        ? (
            'No exits yet',
            app.me.value!.trialAvailable
                ? 'Start the free trial to open every exit.'
                : 'Buy a plan to open every exit.',
            'See plans',
          )
        : app.servers.error != null
        ? ('Exits didn’t load', app.servers.error!, 'Try again')
        : (
            'No exits on your plan',
            'The server sent an empty list.',
            'Try again',
          );
    return SurfaceCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: PType.h3()),
          const SizedBox(height: 6),
          Text(body, style: PType.small()),
          if (action != null) ...[
            const SizedBox(height: 14),
            PillButton(
              label: action,
              expand: false,
              height: 46,
              onTap: noPlan
                  ? () => Navigator.of(context)
                        .push(FadeRoute(builder: (_) => const PlansScreen()))
                  : () => app.refreshAccount(),
            ),
          ],
        ],
      ),
    );
  }
}

/// The way out of "no plan": Start free trial when the account still has
/// it, See plans otherwise. Both open Plans, where the trial starts with
/// one tap.
class NoPlanAction extends StatelessWidget {
  const NoPlanAction({super.key, required this.app, this.height = 46});
  final AppState app;
  final double height;

  @override
  Widget build(BuildContext context) => PillButton(
    label: (app.me.value?.trialAvailable ?? false)
        ? 'Start free trial'
        : 'See plans',
    expand: false,
    height: height,
    onTap: () =>
        Navigator.of(context)
            .push(FadeRoute(builder: (_) => const PlansScreen())),
  );
}

/// The floating message the screens use for a backend answer.
/// Navy, never red: red is kept for a dropped tunnel.
void showNote(BuildContext context, String text) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        behavior: SnackBarBehavior.floating,
        backgroundColor: PColors.navy,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        content: Text(
          text,
          style: PType.small(color: PColors.onDeep)
              .copyWith(fontWeight: FontWeight.w700),
        ),
      ),
    );
}
