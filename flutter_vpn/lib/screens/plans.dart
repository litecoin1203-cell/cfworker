import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/backdrop.dart';
import '../design/icons.dart';
import '../design/scenes.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/seed.dart';

/// Three fictional plans in the offer-card pattern. Starting a trial sets
/// the plan locally; nothing is charged.
class PlansScreen extends StatelessWidget {
  const PlansScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
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
              Text(
                'Demo plans. Starting a trial only changes this phone’s state.',
                style: PType.small(),
              ),
              const SizedBox(height: 20),
              for (var i = 0; i < plans.length; i++)
                Padding(
                  // Each card steps in from the gutter: a staircase, not a stack.
                  padding: EdgeInsets.only(
                    bottom: 18,
                    left: i * 12.0,
                    right: (2 - i) * 12.0,
                  ),
                  child: StaggerIn(
                    index: i,
                    child: _PlanCard(
                      plan: plans[i],
                      current: app.planId == plans[i].id,
                      onStart: () {
                        app.startTrial(plans[i]);
                        ScaffoldMessenger.of(context)
                          ..hideCurrentSnackBar()
                          ..showSnackBar(
                            SnackBar(
                              behavior: SnackBarBehavior.floating,
                              backgroundColor: PColors.navy,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(20),
                              ),
                              content: Text(
                                '${plans[i].name} trial started. ${plans[i].big} days, no charge.',
                                style: PType.small(color: Colors.white)
                                    .copyWith(fontWeight: FontWeight.w700),
                              ),
                            ),
                          );
                      },
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
    required this.onStart,
  });
  final Plan plan;
  final bool current;
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        OfferCard(
          title: plan.name,
          big: plan.big,
          unit: plan.unit,
          footer:
              '${plan.price}  ·  ${plan.devices} device${plan.devices == 1 ? '' : 's'}',
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
                child: Text(plan.line, style: PType.small(color: PColors.ink)),
              ),
              const SizedBox(width: 10),
              PillButton(
                label: current ? 'Current' : 'Start trial',
                icon: current ? PIcon.check : null,
                onTap: current ? null : onStart,
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
