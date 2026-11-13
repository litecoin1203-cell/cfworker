// Colour defaults come from the live palette, so they are nullable
// parameters stored in private fields; this lint cannot apply to those.
// ignore_for_file: prefer_initializing_formals

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'checkout.dart';
import 'plans.dart';
import '../design/tunnel_route.dart';
import 'store_kit.dart';

/// The plan's data and days (Ali's slanted pleats and day dots) and every
/// package. Activity shows them; Profile only sells plans.

// ---------------------------------------------------------------------------
// Plan helpers

const gib = 1073741824; // the Worker counts plans in GiB: "50 GB" is 50 × 2^30

String gbText(int bytes) {
  final v = bytes / gib;
  return v >= 100 ? v.toStringAsFixed(0) : v.toStringAsFixed(1);
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

String dayText(DateTime d, {bool year = true}) {
  final l = d.toLocal();
  return '${_months[l.month - 1]} ${l.day}${year ? ', ${l.year}' : ''}';
}

/// A small tinted label: ACTIVE, VERIFIED, RUNNING.
class SoftChip extends StatelessWidget {
  const SoftChip(this.text, {super.key, Color? color}) : _color = color;
  final String text;
  final Color? _color;
  Color get color => _color ?? PColors.blue;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
    decoration: BoxDecoration(
      color: color.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(PRadius.pill),
    ),
    child: Text(text, style: PType.tab(color: color)),
  );
}

/// The plan on sale with the running plan's name; null when the store no
/// longer sells it (Renew then opens the full list).
PlanInfo? runningPlanInfo(AppState app) {
  final name = app.subscription?.planName;
  if (name == null || name.isEmpty) return null;
  for (final p in app.plans.value ?? const <PlanInfo>[]) {
    if (p.name == name) return p;
  }
  return null;
}

/// Renew: the same plan at checkout when it is still on sale, else Plans.
void renewPlan(BuildContext context, AppState app) {
  final p = runningPlanInfo(app);
  if (p != null) {
    openCheckout(context, plan: p);
  } else {
    openPlans(context);
  }
}

void openPlans(BuildContext context) =>
    Navigator.of(context).push(FadeRoute(builder: (_) => const PlansScreen()));

/// Data, days and every package, in a sheet from below (Ali's pick). It
/// follows the app, so packages that arrive late still show.
Future<void> showPlanSheet(BuildContext context) {
  final app = AppScope.read(context)..loadPackages();
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    barrierColor: PColors.scrim,
    isScrollControlled: true,
    builder: (context) => ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.88,
      ),
      child: Container(
        decoration: BoxDecoration(
          color: PColors.surface,
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(PRadius.sheet),
          ),
        ),
        child: ListenableBuilder(
          listenable: app,
          builder: (context, _) {
            final sub = app.subscription;
            return SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(24, 14, 24, 28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Center(
                    child: Container(
                      width: 40,
                      height: 4,
                      decoration: BoxDecoration(
                        color: PColors.mist,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    sub == null || sub.planName.isEmpty
                        ? 'Your plan'
                        : sub.planName,
                    style: PType.h2(),
                  ),
                  if (sub != null) ...[
                    const SizedBox(height: 18),
                    _PleatsAndDots.of(app, sub, context),
                  ],
                  const SizedBox(height: 22),
                  Divider(height: 1, thickness: 1.2, color: PColors.field),
                  const SizedBox(height: 16),
                  _Packages(app: app, bare: true),
                ],
              ),
            );
          },
        ),
      ),
    ),
  );
}

/// Activity's plan card (Ali's pick C, "Account hub"): a ring of the data
/// left, the plan's end, devices and use, then Packages and Renew. The
/// ring opens the data-and-days sheet.
class PlanHub extends StatelessWidget {
  const PlanHub({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final sub = app.subscription;
    if (sub == null) {
      final trial = app.me.value?.trialAvailable ?? false;
      return SurfaceCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              app.me.loading ? 'Loading your plan…' : 'No plan yet',
              style: PType.h3(),
            ),
            const SizedBox(height: 4),
            Text(
              app.me.error ??
                  (trial
                      ? 'A free trial is waiting for you.'
                      : 'Pick a plan to start.'),
              style: PType.small(),
            ),
            const SizedBox(height: 14),
            PillButton(
              label: trial ? 'Start free trial' : 'See plans',
              onTap: () => openPlans(context),
              expand: false,
              height: 46,
            ),
          ],
        ),
      );
    }
    final left = sub.unlimitedData
        ? 0
        : (sub.dataLimitBytes - sub.usedBytes).clamp(0, sub.dataLimitBytes);
    final frac = sub.unlimitedData
        ? 1.0
        : (sub.dataLimitBytes == 0 ? 0.0 : left / sub.dataLimitBytes);
    final stopped = !sub.active;
    final days = sub.daysLeft ?? 0;
    final ends = sub.unlimitedTime
        ? 'No end date'
        : [
            if (sub.expiresAt != null) dayText(sub.expiresAt!, year: false),
            '$days ${days == 1 ? 'day' : 'days'}',
          ].join('  ·  ');
    final used = sub.unlimitedData
        ? '${gbText(sub.usedBytes)} GB'
        : '${gbText(sub.usedBytes)} of ${gbText(sub.dataLimitBytes)} GB';
    Widget kv(String k, String v) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Text(k, style: PType.small()),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              v,
              textAlign: TextAlign.right,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: PType.small(color: PColors.ink)
                  .copyWith(fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 16),
      child: Column(
        children: [
          Row(
            children: [
              Pressable(
                onTap: () => showPlanSheet(context),
                label: 'Data and days left',
                radius: 60,
                child: _DataRing(
                  frac: frac,
                  big: sub.unlimitedData ? '∞' : gbText(left),
                  small: sub.unlimitedData ? 'no data cap' : 'GB left',
                  muted: stopped,
                  reduce: app.reduceMotion || PMotion.reduced(context),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            sub.planName.isEmpty ? 'Your plan' : sub.planName,
                            style: PType.h3(),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        const SizedBox(width: 6),
                        SoftChip(
                          sub.statusLine.toUpperCase(),
                          color: stopped ? PColors.alert : PColors.safe,
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    kv('Ends', ends),
                    kv('Devices', 'up to ${sub.deviceLimit}'),
                    kv('Used', used),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: _HubButton(
                  'Packages',
                  onTap: () => showPlanSheet(context),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _HubButton(
                  stopped ? 'Renew now' : 'Renew',
                  primary: true,
                  onTap: () => renewPlan(context, app),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// A half-width pill: the plan card is narrow, so the label shrinks to fit
/// instead of overflowing.
class _HubButton extends StatelessWidget {
  const _HubButton(this.label, {required this.onTap, this.primary = false});
  final String label;
  final VoidCallback onTap;
  final bool primary;

  @override
  Widget build(BuildContext context) => Pressable(
    onTap: onTap,
    label: label,
    radius: PRadius.pill,
    color: primary ? PColors.blue : PColors.field,
    child: SizedBox(
      height: 46,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Center(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              label.toUpperCase(),
              style: PType.button(
                color: primary ? PColors.onAccent : PColors.ink,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/// The data left as a ring that fills on first show.
class _DataRing extends StatelessWidget {
  const _DataRing({
    required this.frac,
    required this.big,
    required this.small,
    required this.muted,
    required this.reduce,
  });
  final double frac;
  final String big, small;
  final bool muted, reduce;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: '$big $small',
      excludeSemantics: true,
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: reduce ? frac : 0, end: frac),
        duration: reduce ? Duration.zero : const Duration(milliseconds: 1200),
        curve: Curves.easeOutCubic,
        builder: (context, v, _) => SizedBox(
          width: 108,
          height: 108,
          child: CustomPaint(
            painter: _RingPainter(
              v,
              track: PColors.field,
              fill: muted ? PColors.muted : PColors.blue,
            ),
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(big, style: PType.display(26)),
                  Text(small, style: PType.meta()),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.v, {required this.track, required this.fill});
  final double v;
  final Color track, fill;

  @override
  void paint(Canvas canvas, Size size) {
    const stroke = 10.0;
    final r = Rect.fromLTWH(
      stroke / 2,
      stroke / 2,
      size.width - stroke,
      size.height - stroke,
    );
    final base = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..color = track;
    canvas.drawArc(r, 0, 6.2832, false, base);
    if (v <= 0) return;
    canvas.drawArc(
      r,
      -1.5708,
      6.2832 * v.clamp(0.0, 1.0),
      false,
      base
        ..color = fill
        ..strokeCap = StrokeCap.round,
    );
  }

  @override
  bool shouldRepaint(_RingPainter old) =>
      old.v != v || old.fill != fill || old.track != track;
}

/// Data and days, the way Ali picked (style 4): slanted pleats rise for
/// the data left, and each day of the package is a dot (navy = still
/// ahead). Numbers count up with them; Reduce motion shows the end state.
class _PleatsAndDots extends StatefulWidget {
  static Widget of(AppState app, Subscription sub, BuildContext context) {
    final left = sub.unlimitedData
        ? 0
        : (sub.dataLimitBytes - sub.usedBytes).clamp(0, sub.dataLimitBytes);
    final period = (sub.periodDays ?? 0) > 0 ? sub.periodDays! : 30;
    return _PleatsAndDots(
      dataFrac: sub.unlimitedData
          ? 1.0
          : (sub.dataLimitBytes == 0 ? 0.0 : left / sub.dataLimitBytes),
      leftGb: sub.unlimitedData ? null : left / gib,
      limitGb: sub.dataLimitBytes / gib,
      days: sub.unlimitedTime ? null : (sub.daysLeft ?? 0),
      period: period,
      ends: sub.expiresAt,
      reduce: app.reduceMotion || PMotion.reduced(context),
      muted: !sub.active,
    );
  }

  const _PleatsAndDots({
    required this.dataFrac,
    required this.leftGb,
    required this.limitGb,
    required this.days,
    required this.period,
    required this.ends,
    required this.reduce,
    required this.muted,
  });
  final double dataFrac, limitGb;

  /// null = no data cap / no end date.
  final double? leftGb;
  final int? days;
  final int period;
  final DateTime? ends;
  final bool reduce, muted;

  @override
  State<_PleatsAndDots> createState() => _PleatsAndDotsState();
}

class _PleatsAndDotsState extends State<_PleatsAndDots>
    with SingleTickerProviderStateMixin {
  static const _pleats = 20;
  static const _maxDots = 60;
  late final _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  );

  @override
  void initState() {
    super.initState();
    widget.reduce ? _c.value = 1 : _c.forward();
  }

  @override
  void didUpdateWidget(_PleatsAndDots old) {
    super.didUpdateWidget(old);
    if (old.dataFrac != widget.dataFrac || old.days != widget.days) {
      widget.reduce ? _c.value = 1 : _c.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  /// 0..1 progress of one item that starts at [start] (0..1 of the run)
  /// and takes [span] of it.
  double _at(double start, double span) =>
      ((_c.value - start) / span).clamp(0.0, 1.0);

  @override
  Widget build(BuildContext context) {
    final w = widget;
    // a long package gets one dot per few days, so the grid stays small
    final perDot = (w.period / _maxDots).ceil().clamp(1, 1 << 20);
    final dots = (w.period / perDot).ceil();
    final aheadDots = w.days == null ? dots : (w.days! / perDot).ceil();
    final lit = (w.dataFrac * _pleats).round();
    final blue = w.muted ? PColors.muted : PColors.blue;
    final deep = w.muted ? PColors.muted : PColors.pressed;
    final navy = w.muted ? PColors.ice : PColors.navy;
    return Semantics(
      label: [
        w.leftGb == null
            ? 'No data cap'
            : '${w.leftGb!.toStringAsFixed(1)} GB left of ${w.limitGb.toStringAsFixed(0)}',
        w.days == null ? 'no end date' : '${w.days} of ${w.period} days left',
      ].join(', '),
      excludeSemantics: true,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          final count = Curves.easeOutCubic.transform(_at(0, 0.8));
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _bigRow(
                'DATA LEFT',
                w.leftGb == null ? '∞' : (w.leftGb! * count).toStringAsFixed(1),
                w.leftGb == null ? '' : ' GB',
                w.leftGb == null
                    ? 'No data cap'
                    : 'of ${w.limitGb.toStringAsFixed(0)} GB',
              ),
              const SizedBox(height: 14),
              SizedBox(
                height: 60,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    for (var i = 0; i < _pleats; i++) ...[
                      if (i > 0) const SizedBox(width: 5),
                      Expanded(
                        child: Transform(
                          alignment: Alignment.bottomCenter,
                          transform: Matrix4.skewX(-0.21)
                            ..scaleByDouble(
                              1,
                              i < lit
                                  ? 0.35 +
                                        0.65 *
                                            Curves.easeOutBack.transform(
                                              _at(i * 0.025, 0.3),
                                            )
                                  : 0.35,
                              1,
                              1,
                            ),
                          child: DecoratedBox(
                            decoration: BoxDecoration(
                              color: i < lit && _at(i * 0.025, 0.3) > 0
                                  ? (i.isOdd ? blue : deep)
                                  : PColors.mist,
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: const SizedBox.expand(),
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 18),
              Divider(height: 1, thickness: 1.2, color: PColors.field),
              const SizedBox(height: 16),
              _bigRow(
                'DAYS LEFT',
                w.days == null ? '∞' : '${(w.days! * count).round()}',
                w.days == null ? '' : ' of ${w.period}',
                w.days == null || w.ends == null
                    ? 'No end date'
                    : 'Ends ${dayText(w.ends!, year: false)}',
              ),
              const SizedBox(height: 14),
              LayoutBuilder(
                builder: (context, box) {
                  const cols = 10, gap = 7.0;
                  final size = (box.maxWidth - gap * (cols - 1)) / cols;
                  return Wrap(
                    spacing: gap,
                    runSpacing: gap,
                    children: [
                      for (var i = 0; i < dots; i++)
                        () {
                          final t = _at(0.15 + i * (0.5 / dots), 0.25);
                          final ahead = i >= dots - aheadDots;
                          return Transform.scale(
                            scale: 0.4 + 0.6 * Curves.easeOutBack.transform(t),
                            child: Container(
                              width: size,
                              height: size,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: t == 0
                                    ? PColors.field
                                    : (ahead ? navy : PColors.mist),
                              ),
                            ),
                          );
                        }(),
                    ],
                  );
                },
              ),
              if (perDot > 1) ...[
                const SizedBox(height: 8),
                Text('Each dot is $perDot days.', style: PType.meta()),
              ],
            ],
          );
        },
      ),
    );
  }

  Widget _bigRow(String label, String number, String unit, String side) => Row(
    crossAxisAlignment: CrossAxisAlignment.end,
    children: [
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: PType.tab()),
            const SizedBox(height: 8),
            Text.rich(
              TextSpan(
                children: [
                  TextSpan(text: number, style: PType.display(44)),
                  TextSpan(
                    text: unit,
                    style: PType.body(color: PColors.muted)
                        .copyWith(fontSize: 18, fontWeight: FontWeight.w600),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      Text(side, style: PType.meta()),
    ],
  );
}

/// 4. Every package, newest first: when it was bought and when it started.
class _Packages extends StatelessWidget {
  const _Packages({required this.app, this.bare = false});
  final AppState app;

  /// Inside the Data and days sheet: no card of its own.
  final bool bare;

  @override
  Widget build(BuildContext context) {
    final list = app.packages.value ?? const <Package>[];
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: Text('Packages', style: PType.h3())),
            if (list.isNotEmpty) Text('${list.length}', style: PType.meta()),
          ],
        ),
        if (list.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Text(
              app.packages.loading
                  ? 'Loading your packages…'
                  : (app.packages.error ?? 'No packages yet.'),
              style: PType.small(),
            ),
          ),
        for (var i = 0; i < list.length; i++)
          StaggerIn(
            index: i,
            child: _PackageRow(p: list[i], first: i == 0),
          ),
      ],
    );
    if (bare) return body;
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 10),
      child: body,
    );
  }
}

class _PackageRow extends StatelessWidget {
  const _PackageRow({required this.p, required this.first});
  final Package p;
  final bool first;

  @override
  Widget build(BuildContext context) {
    final dates = [
      if (p.purchasedAt != null)
        'Bought ${dayText(p.purchasedAt!, year: p.activatedAt == null)}',
      if (p.activatedAt != null) 'Activated ${dayText(p.activatedAt!)}',
    ].join('  ·  ');
    final facts = [
      if (p.source != 'order') p.sourceLabel,
      p.dataLimitBytes > 0 ? '${gbText(p.dataLimitBytes)} GB' : 'No data cap',
      if (p.amountToman != null && p.amountToman! > 0) toman(p.amountToman!),
    ].join('  ·  ');
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 11),
      decoration: BoxDecoration(
        border: first
            ? null
            : Border(top: BorderSide(color: PColors.field, width: 1.2)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: p.current ? PColors.blue : PColors.mist,
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: Text(
              p.days == null ? '∞' : '${p.days}d',
              style: PType.meta(
                color: p.current ? PColors.onAccent : PColors.accentInk,
              ).copyWith(fontWeight: FontWeight.w700),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        p.name,
                        style: PType.h3().copyWith(fontSize: 15),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 8),
                    SoftChip(
                      p.stateLabel.toUpperCase(),
                      color: p.current ? PColors.safe : PColors.muted,
                    ),
                  ],
                ),
                const SizedBox(height: 3),
                Text(dates, style: PType.small()),
                const SizedBox(height: 1),
                Text(facts, style: PType.meta()),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
