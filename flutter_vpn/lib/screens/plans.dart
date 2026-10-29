import 'package:flutter/material.dart';

import '../api/models.dart';
import '../design/city_art.dart';
import '../design/backdrop.dart';
import '../design/icons.dart';
import '../design/scenes.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'checkout.dart';
import 'states.dart';
import 'store_kit.dart';

/// The store's plans from `/plans`, in the offer-card pattern. Start trial
/// calls `/trial`; Buy opens checkout (wallet, card or crypto).
class PlansScreen extends StatefulWidget {
  const PlansScreen({super.key});

  @override
  State<PlansScreen> createState() => _PlansScreenState();
}

class _PlansScreenState extends State<PlansScreen> {
  int? _busy;

  Future<void> _run(
    PlanInfo p,
    Future<String?> Function() action,
    String ok,
  ) async {
    setState(() => _busy = p.id);
    final err = await action();
    if (!mounted) return;
    setState(() => _busy = null);
    showNote(context, err ?? ok);
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final me = app.me.value;
    final list = app.plans.value ?? const <PlanInfo>[];
    final current = app.subscription?.planName;
    return Scaffold(
      backgroundColor: PColors.ground,
      body: ShardBackdrop(
        layout: Layouts.confirm,
        child: SafeArea(
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
              Text('Plans', style: PType.h1()),
              const SizedBox(height: 4),
              Padding(
                // Clear of the navy shard on the right.
                padding: const EdgeInsets.only(right: 96),
                child: Text(
                  me == null
                      ? 'Prices from the Cloud Gold store.'
                      : 'Wallet ${toman(me.wallet)}. Pay with the wallet, card or crypto.',
                  style: PType.small(),
                ),
              ),
              const SizedBox(height: 20),
              if (list.isEmpty)
                SurfaceCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        app.plans.loading
                            ? 'Loading plans…'
                            : (app.plans.error == null
                                  ? 'No plans on sale'
                                  : 'Plans didn’t load'),
                        style: PType.h3(),
                      ),
                      if (app.plans.error != null) ...[
                        const SizedBox(height: 6),
                        Text(app.plans.error!, style: PType.small()),
                        const SizedBox(height: 14),
                        PillButton(
                          label: 'Try again',
                          expand: false,
                          height: 46,
                          onTap: app.loadPublic,
                        ),
                      ],
                    ],
                  ),
                ),
              for (var i = 0; i < list.length; i++)
                Padding(
                  // Each card steps in from the gutter: a staircase, not a stack.
                  padding: EdgeInsets.only(
                    bottom: 18,
                    left: (i % 3) * 12.0,
                    right: (2 - i % 3) * 12.0,
                  ),
                  child: StaggerIn(
                    index: i,
                    child: _PlanCard(
                      plan: list[i],
                      current: current != null && current == list[i].name,
                      trial:
                          list[i].trialDays > 0 &&
                          (me?.trialAvailable ?? false),
                      busy: _busy == list[i].id,
                      signedIn: me != null,
                      onTrial: () => _run(
                        list[i],
                        () => app.startTrial(list[i]),
                        'Trial started: ${list[i].trialDays} days.',
                      ),
                      onBuy: () => openCheckout(context, plan: list[i]),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  const _PlanCard({
    required this.plan,
    required this.current,
    required this.trial,
    required this.busy,
    required this.signedIn,
    required this.onTrial,
    required this.onBuy,
  });
  final PlanInfo plan;
  final bool current, trial, busy, signedIn;
  final VoidCallback onTrial, onBuy;

  @override
  Widget build(BuildContext context) {
    final data = plan.dataLimitGb > 0
        ? '${plan.dataLimitGb} GB'
        : 'no data cap';
    final line = plan.description.isNotEmpty
        ? plan.description
        : (trial
              ? '${plan.trialDays}-day free trial, then ${toman(plan.priceToman)}.'
              : '$data, ${plan.deviceLimit} device${plan.deviceLimit == 1 ? '' : 's'}.');
    final (label, onTap) = current
        ? ('Current', null)
        : busy
        ? ('Working…', null)
        : !signedIn
        ? ('Sign in', null)
        : trial
        ? ('Start trial', onTrial)
        : ('Buy', onBuy);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        OfferCard(
          title: plan.badge.isEmpty
              ? plan.name
              : '${plan.name}  ·  ${plan.badge}',
          big: '${trial ? plan.trialDays : plan.durationDays}',
          unit: trial ? 'days free\n$data' : 'days\n$data',
          footer: [
            toman(plan.priceToman),
            if (plan.savePercent > 0) 'save ${plan.savePercent}%',
            '${plan.deviceLimit} device${plan.deviceLimit == 1 ? '' : 's'}',
          ].join('  ·  '),
        ),
        Container(
          margin: const EdgeInsets.symmetric(horizontal: 14),
          padding: const EdgeInsets.fromLTRB(18, 12, 12, 12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: const BorderRadius.vertical(
              bottom: Radius.circular(PRadius.card),
            ),
            boxShadow: PShadow.soft(),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(line, style: PType.small(color: PColors.ink)),
              ),
              const SizedBox(width: 10),
              PillButton(
                label: label,
                icon: current ? PIcon.check : null,
                onTap: onTap,
                expand: false,
                height: 46,
              ),
            ],
          ),
        ),
      ],
    );
  }
}
