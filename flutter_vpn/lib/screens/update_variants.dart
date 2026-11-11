// PREVIEW ONLY: the three update directions, the version placements and the
// Night mode placements, switched by [Knobs] for the mockup renders. After
// Ali picks, the chosen pieces move into their screens and this file goes.
// ignore_for_file: public_member_api_docs

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/mark.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/updater.dart';

abstract final class Knobs {
  /// 'now' | 'unfold' | 'orbit' | 'pass'
  static String update = 'now';

  /// 'now' | 'footer' | 'tag' | 'about'
  static String version = 'now';

  /// 'now' | 'home' | 'hero' | 'tiles'
  static String night = 'now';
}

String _mb(int bytes) => (bytes / (1024 * 1024)).toStringAsFixed(1);

/// Everything a design needs about the offer, in one place.
class _Offer {
  _Offer(AppState app)
    : to = app.appUpdate?.version ?? '',
      from = app.updater.version,
      size = app.appUpdate?.files[app.updater.abi]?.size ?? 0,
      step = app.updater.step,
      received = app.updater.received,
      total = app.updater.total,
      must = app.mustUpdate,
      abi = app.updater.abi;
  final String to, from, abi;
  final int size, received, total;
  final UpdateStep step;
  final bool must;
  double get frac => total > 0 ? (received / total).clamp(0.0, 1.0) : 0;
  int get pct => (100 * frac).floor();
  bool get busy =>
      step == UpdateStep.downloading || step == UpdateStep.checking;
  String get phone => abi.startsWith('arm64')
      ? '64-bit phone'
      : (abi.isEmpty ? 'this phone' : abi);
}

// ─────────────────────────── Home entry points ───────────────────────────

/// The Home entry for the chosen update direction (null = keep the banner).
Widget? homeUpdateEntry(AppState app) => switch (Knobs.update) {
  'unfold' => _UnfoldEntry(app: app),
  'pass' => _PassEntry(app: app),
  _ => null,
};

/// Direction 1: a deep-plane card like the Plans offer, with the white
/// corner tab the exit cards use.
class _UnfoldEntry extends StatelessWidget {
  const _UnfoldEntry({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final o = _Offer(app);
    return Pressable(
      onTap: app.openUpdate,
      label: 'Update Pleat',
      radius: PRadius.media,
      color: PColors.navy,
      shadow: true,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(PRadius.media),
        child: SizedBox(
          height: 132,
          child: Stack(
            children: [
              Positioned(
                right: -36,
                top: -26,
                child: ShardChip(color: PColors.blue, width: 64, height: 150),
              ),
              Positioned(
                right: 92,
                top: -30,
                child: Opacity(
                  opacity: 0.35,
                  child: ShardChip(color: PColors.ice, width: 18, height: 80),
                ),
              ),
              Positioned(
                left: 22,
                top: 18,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      o.must ? 'NEEDED UPDATE' : 'NEW PLEAT',
                      style: PType.tab(color: Colors.white.withValues(alpha: 0.72)),
                    ),
                    const SizedBox(height: 6),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Text(
                          o.to,
                          style: PType.display(40, color: Colors.white),
                        ),
                        const SizedBox(width: 10),
                        Padding(
                          padding: const EdgeInsets.only(bottom: 2),
                          child: Text(
                            'from ${o.from}',
                            style: PType.small(
                              color: Colors.white.withValues(alpha: 0.72),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              Positioned(
                left: 0,
                bottom: 0,
                child: Container(
                  height: 44,
                  padding: const EdgeInsets.symmetric(horizontal: 22),
                  decoration: BoxDecoration(
                    color: PColors.surface,
                    borderRadius: const BorderRadius.only(
                      topRight: Radius.circular(24),
                    ),
                  ),
                  alignment: Alignment.center,
                  child: Row(
                    children: [
                      PIconView(
                        o.busy ? PIcon.download : PIcon.refresh,
                        size: 16,
                        color: PColors.accentInk,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        o.busy ? '${o.pct}%' : 'UPDATE',
                        style: PType.button(color: PColors.ink),
                      ),
                    ],
                  ),
                ),
              ),
              Positioned(
                right: 18,
                bottom: 14,
                child: Text(
                  '${_mb(o.size)} MB',
                  style: PType.meta(
                    color: Colors.white.withValues(alpha: 0.72),
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

/// Direction 2: a small chip in the Home header, beside the bell.
class OrbitChip extends StatelessWidget {
  const OrbitChip({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final o = _Offer(app);
    return Pressable(
      onTap: app.openUpdate,
      label: 'Update Pleat',
      radius: PRadius.pill,
      color: PColors.blue,
      child: SizedBox(
        height: 36,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(6, 0, 14, 0),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox.square(
                dimension: 26,
                child: CustomPaint(
                  painter: _RingPainter(
                    o.busy ? o.frac : 1,
                    track: Colors.white.withValues(alpha: 0.30),
                    arc: Colors.white,
                    width: 2.4,
                  ),
                  child: Center(
                    child: PIconView(
                      o.busy ? PIcon.download : PIcon.refresh,
                      size: 13,
                      color: Colors.white,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 7),
              Text(
                o.busy ? '${o.pct}%' : o.to,
                style: PType.button(color: PColors.onAccent),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Direction 3: a slim ticket on Home.
class _PassEntry extends StatelessWidget {
  const _PassEntry({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final o = _Offer(app);
    return Pressable(
      onTap: app.openUpdate,
      label: 'Update Pleat',
      radius: 22,
      color: Colors.transparent,
      child: CustomPaint(
        painter: _TicketPainter(
          color: PColors.surface,
          notchAt: 0.70,
          vertical: true,
          dash: PColors.mist,
        ),
        child: SizedBox(
          height: 78,
          child: Row(
            children: [
              const SizedBox(width: 18),
              Expanded(
                flex: 70,
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('UPDATE READY', style: PType.tab(color: PColors.accentInk)),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Text(o.from, style: PType.h3(color: PColors.muted)),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          child: _Planes(width: 30, color: PColors.blue),
                        ),
                        Text(o.to, style: PType.h3()),
                      ],
                    ),
                  ],
                ),
              ),
              Expanded(
                flex: 30,
                child: Center(
                  child: Container(
                    height: 40,
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    decoration: BoxDecoration(
                      color: PColors.blue,
                      borderRadius: BorderRadius.circular(PRadius.pill),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      o.busy ? '${o.pct}%' : 'GET',
                      style: PType.button(),
                    ),
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

// ─────────────────────────────── Sheets ───────────────────────────────

/// The sheet body for the chosen direction (null = keep the current one).
Widget? updateSheetVariant(BuildContext context) => switch (Knobs.update) {
  'unfold' => const _UnfoldSheet(),
  'orbit' => const _OrbitSheet(),
  'pass' => const _PassSheet(),
  _ => null,
};

String _status(_Offer o, Updater up) => switch (o.step) {
  UpdateStep.idle => '',
  UpdateStep.downloading =>
    '${_mb(o.received)} of ${_mb(o.total)} MB',
  UpdateStep.checking => 'Checking the file…',
  UpdateStep.ready => 'Downloaded and checked.',
  UpdateStep.needsPermission =>
    'Android asks once: allow installs from Pleat.',
  UpdateStep.installing => 'Tap Update in Android’s installer.',
  UpdateStep.failed => up.error ?? 'The update didn’t finish.',
};

Widget _handle() => Center(
  child: Container(
    width: 40,
    height: 4,
    decoration: BoxDecoration(
      color: PColors.mist,
      borderRadius: BorderRadius.circular(2),
    ),
  ),
);

/// A pill whose own fill is the download: blue sweeps across as it goes.
class _FillPill extends StatelessWidget {
  const _FillPill({required this.o, required this.app});
  final _Offer o;
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final up = app.updater;
    final u = app.appUpdate;
    final busy = o.busy;
    final label = switch (o.step) {
      UpdateStep.downloading => 'Downloading  ${o.pct}%',
      UpdateStep.checking => 'Checking',
      UpdateStep.ready || UpdateStep.installing => 'Install',
      UpdateStep.needsPermission => 'Allow installs',
      UpdateStep.failed => 'Try again',
      UpdateStep.idle => 'Update now',
    };
    Widget row(Color c) => SizedBox(
      height: 58,
      width: MediaQuery.sizeOf(context).width - 48,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          PIconView(busy ? PIcon.download : PIcon.refresh, size: 18, color: c),
          const SizedBox(width: 10),
          Text(label.toUpperCase(), style: PType.button(color: c)),
        ],
      ),
    );
    return Pressable(
      onTap: busy ? up.stop : (u == null ? null : () => up.start(u)),
      label: label,
      radius: PRadius.pill,
      color: busy ? PColors.mist : PColors.blue,
      child: SizedBox(
        height: 58,
        child: Stack(
          children: [
            row(busy ? PColors.accentInk : PColors.onAccent),
            if (busy)
              ClipRRect(
                borderRadius: BorderRadius.circular(PRadius.pill),
                child: Align(
                  alignment: Alignment.centerLeft,
                  widthFactor: math.max(o.frac, 0.12),
                  child: ColoredBox(
                    color: PColors.blue,
                    child: row(PColors.onAccent),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact(this.icon, this.title, this.body);
  final PIcon icon;
  final String title, body;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Row(
      children: [
        Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(
            color: PColors.field,
            borderRadius: BorderRadius.circular(14),
          ),
          alignment: Alignment.center,
          child: PIconView(icon, size: 20, color: PColors.accentInk),
        ),
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
      ],
    ),
  );
}

/// Direction 1 — "Unfold": a deep plane opens the sheet with the new
/// number at display size; the button itself fills as it downloads.
class _UnfoldSheet extends StatelessWidget {
  const _UnfoldSheet();

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final o = _Offer(app);
    final status = _status(o, app.updater);
    return Container(
      decoration: BoxDecoration(
        color: PColors.surface,
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(PRadius.sheet),
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 236,
            color: PColors.navy,
            child: Stack(
              children: [
                Positioned(
                  right: -86,
                  top: -20,
                  child: ShardChip(color: PColors.blue, width: 92, height: 270),
                ),
                Positioned(
                  right: 18,
                  top: 150,
                  child: Opacity(
                    opacity: 0.5,
                    child: ShardChip(color: PColors.ice, width: 26, height: 110),
                  ),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  top: 12,
                  child: Center(
                    child: Container(
                      width: 40,
                      height: 4,
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.3),
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                ),
                Positioned(
                  left: 24,
                  top: 34,
                  right: 24,
                  child: Row(
                    children: [
                      PleatMark(size: 30, colors: MarkColors.onDark),
                      const Spacer(),
                      if (!o.must)
                        RoundIcon(
                          PIcon.close,
                          onTap: () => Navigator.of(context).maybePop(),
                          label: 'Close',
                          color: Colors.white,
                          background: Colors.white.withValues(alpha: 0.12),
                        ),
                    ],
                  ),
                ),
                Positioned(
                  left: 24,
                  bottom: 26,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        o.must ? 'NEEDED TO KEEP USING PLEAT' : 'A NEW PLEAT IS READY',
                        style: PType.tab(color: Colors.white.withValues(alpha: 0.72)),
                      ),
                      const SizedBox(height: 8),
                      Text(o.to, style: PType.display(76, color: Colors.white)),
                      const SizedBox(height: 10),
                      Text(
                        'You have ${o.from}',
                        style: PType.small(
                          color: Colors.white.withValues(alpha: 0.75),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: EdgeInsets.fromLTRB(
              24,
              14,
              24,
              24 + MediaQuery.paddingOf(context).bottom,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _Fact(
                  PIcon.device,
                  'Made for this phone',
                  '${_mb(o.size)} MB, the ${o.phone} build.',
                ),
                const _Fact(
                  PIcon.shield,
                  'Checked before it installs',
                  'The file is matched to the release, byte for byte.',
                ),
                const _Fact(
                  PIcon.lock,
                  'Nothing to set up again',
                  'Your account, plan and settings stay.',
                ),
                const SizedBox(height: 18),
                _FillPill(o: o, app: app),
                const SizedBox(height: 10),
                Center(
                  child: Text(
                    o.busy
                        ? '$status  ·  tap to stop'
                        : (status.isEmpty
                              ? 'About a minute on a good line.'
                              : status),
                    style: PType.meta(),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.frac, {required this.track, required this.arc, this.width = 10});
  final double frac, width;
  final Color track, arc;

  @override
  void paint(Canvas canvas, Size size) {
    final r = Rect.fromCircle(
      center: size.center(Offset.zero),
      radius: size.width / 2 - width / 2,
    );
    final p = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = width
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(r, 0, math.pi * 2, false, p..color = track);
    if (frac > 0) {
      canvas.drawArc(
        r,
        -math.pi / 2,
        math.pi * 2 * frac,
        false,
        p..color = arc,
      );
    }
  }

  @override
  bool shouldRepaint(_RingPainter old) =>
      old.frac != frac || old.track != track || old.arc != arc;
}

/// Direction 2 — "Orbit": the connect control's ring, around the mark,
/// fills as it downloads; three steps say where it is.
class _OrbitSheet extends StatelessWidget {
  const _OrbitSheet();

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final o = _Offer(app);
    final stage = switch (o.step) {
      UpdateStep.idle || UpdateStep.downloading || UpdateStep.failed => 0,
      UpdateStep.checking => 1,
      _ => 2,
    };
    return Container(
      decoration: BoxDecoration(
        color: PColors.surface,
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(PRadius.sheet),
        ),
      ),
      padding: EdgeInsets.fromLTRB(
        24,
        14,
        24,
        24 + MediaQuery.paddingOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _handle(),
          const SizedBox(height: 26),
          Center(
            child: SizedBox.square(
              dimension: 196,
              child: Stack(
                alignment: Alignment.center,
                children: [
                  Container(
                    width: 196,
                    height: 196,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: PColors.field,
                    ),
                  ),
                  CustomPaint(
                    size: const Size.square(196),
                    painter: _RingPainter(
                      o.busy ? o.frac : (o.step == UpdateStep.ready ? 1 : 0),
                      track: PColors.mist,
                      arc: PColors.blue,
                      width: 12,
                    ),
                  ),
                  Container(
                    width: 132,
                    height: 132,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: o.busy ? PColors.surface : PColors.blue,
                      boxShadow: o.busy ? PShadow.soft() : PShadow.lift,
                    ),
                    alignment: Alignment.center,
                    child: o.busy
                        ? Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text('${o.pct}', style: PType.display(52)),
                              Text('PERCENT', style: PType.tab()),
                            ],
                          )
                        : PleatMark(size: 58, colors: MarkColors.onDark),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 24),
          Center(child: Text('Pleat ${o.to}', style: PType.h2())),
          const SizedBox(height: 6),
          Center(
            child: Text(
              o.busy
                  ? '${_mb(o.received)} of ${_mb(o.total)} MB'
                  : 'From ${o.from}  ·  ${_mb(o.size)} MB  ·  for this phone',
              style: PType.small(),
            ),
          ),
          const SizedBox(height: 22),
          Row(
            children: [
              for (final (i, (icon, label)) in [
                (PIcon.download, 'Download'),
                (PIcon.shield, 'Check'),
                (PIcon.check, 'Install'),
              ].indexed) ...[
                if (i > 0)
                  Expanded(
                    child: Container(
                      height: 2,
                      margin: const EdgeInsets.only(bottom: 22),
                      color: i <= stage ? PColors.blue : PColors.mist,
                    ),
                  ),
                Column(
                  children: [
                    Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: i < stage
                            ? PColors.blue
                            : (i == stage && o.busy
                                  ? PColors.mist
                                  : PColors.field),
                        border: i == stage
                            ? Border.all(color: PColors.blue, width: 2)
                            : null,
                      ),
                      alignment: Alignment.center,
                      child: PIconView(
                        i < stage ? PIcon.check : icon,
                        size: 18,
                        color: i < stage
                            ? PColors.onAccent
                            : (i == stage ? PColors.accentInk : PColors.muted),
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      label.toUpperCase(),
                      style: PType.tab(
                        color: i <= stage ? PColors.accentInk : PColors.muted,
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ),
          const SizedBox(height: 22),
          o.busy
              ? PillButton(
                  label: 'Stop',
                  icon: PIcon.close,
                  color: PColors.mist,
                  textColor: PColors.accentInk,
                  onTap: app.updater.stop,
                )
              : PillButton(
                  label: 'Update now',
                  icon: PIcon.download,
                  onTap: () {},
                ),
          const SizedBox(height: 12),
          Center(
            child: Text(
              'Your account, plan and settings stay.',
              style: PType.meta(),
            ),
          ),
        ],
      ),
    );
  }
}

/// Two little folded planes in a row: the "to" arrow of the ticket.
class _Planes extends StatelessWidget {
  const _Planes({required this.width, required this.color});
  final double width;
  final Color color;
  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      ShardChip(color: color.withValues(alpha: 0.35), width: width * 0.18, height: width * 0.45),
      ShardChip(color: color.withValues(alpha: 0.65), width: width * 0.18, height: width * 0.45),
      ShardChip(color: color, width: width * 0.18, height: width * 0.45),
    ],
  );
}

/// A ticket shape: rounded card with two half-circle notches and a dashed
/// tear line between them (across, or down when [vertical]).
class _TicketPainter extends CustomPainter {
  _TicketPainter({
    required this.color,
    required this.notchAt,
    required this.dash,
    this.vertical = false,
    this.progress,
    this.fillDash,
  });
  final Color color, dash;
  final Color? fillDash;
  final double notchAt;
  final bool vertical;
  final double? progress;
  final PPalette palette = PColors.current;

  @override
  void paint(Canvas canvas, Size size) {
    const r = 22.0, n = 11.0;
    final card = Path()
      ..addRRect(
        RRect.fromRectAndRadius(Offset.zero & size, const Radius.circular(r)),
      );
    final cut = Path();
    if (vertical) {
      final x = size.width * notchAt;
      cut
        ..addOval(Rect.fromCircle(center: Offset(x, 0), radius: n))
        ..addOval(Rect.fromCircle(center: Offset(x, size.height), radius: n));
    } else {
      final y = size.height * notchAt;
      cut
        ..addOval(Rect.fromCircle(center: Offset(0, y), radius: n))
        ..addOval(Rect.fromCircle(center: Offset(size.width, y), radius: n));
    }
    final shape = Path.combine(PathOperation.difference, card, cut);
    canvas.drawShadow(shape, palette.navy.withValues(alpha: 0.4), 8, false);
    canvas.drawPath(shape, Paint()..color = color);
    final p = Paint()
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;
    if (vertical) {
      final x = size.width * notchAt;
      for (var y = n + 8; y < size.height - n - 6; y += 9) {
        canvas.drawLine(Offset(x, y), Offset(x, y + 3), p..color = dash);
      }
    } else {
      final y = size.height * notchAt;
      final from = n + 10, to = size.width - n - 10;
      var i = 0;
      final count = ((to - from) / 12).floor();
      for (var x = from; x < to; x += 12) {
        final on = progress != null && i < (count * progress!).round();
        canvas.drawLine(
          Offset(x, y),
          Offset(x + 5, y),
          p
            ..strokeWidth = on ? 4 : 3
            ..color = on ? (fillDash ?? dash) : dash,
        );
        i++;
      }
    }
  }

  @override
  bool shouldRepaint(_TicketPainter old) =>
      old.progress != progress || old.color != color;
}

/// Direction 3 — "Pass": the update as a boarding pass from this version
/// to the next; the tear line fills dash by dash as it downloads.
class _PassSheet extends StatelessWidget {
  const _PassSheet();

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final o = _Offer(app);
    final white70 = Colors.white.withValues(alpha: 0.7);
    Widget col(String k, String v, {CrossAxisAlignment a = CrossAxisAlignment.start}) =>
        Column(
          crossAxisAlignment: a,
          children: [
            Text(k, style: PType.tab(color: Colors.white.withValues(alpha: 0.72))),
            const SizedBox(height: 4),
            Text(v, style: PType.h3(color: Colors.white).copyWith(fontSize: 15)),
          ],
        );
    return Container(
      decoration: BoxDecoration(
        color: PColors.surface,
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(PRadius.sheet),
        ),
      ),
      padding: EdgeInsets.fromLTRB(
        20,
        14,
        20,
        24 + MediaQuery.paddingOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _handle(),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(child: Text('Your update pass', style: PType.h2())),
              RoundIcon(
                PIcon.close,
                onTap: () => Navigator.of(context).maybePop(),
                label: 'Close',
              ),
            ],
          ),
          const SizedBox(height: 14),
          CustomPaint(
            painter: _TicketPainter(
              color: PColors.navy,
              notchAt: 0.60,
              dash: Colors.white.withValues(alpha: 0.22),
              fillDash: PColors.blue,
              progress: o.busy ? o.frac : null,
            ),
            child: SizedBox(
              height: 236,
              child: Stack(
                children: [
                  Positioned(
                    right: -58,
                    top: -40,
                    child: Opacity(
                      opacity: 0.9,
                      child: ShardChip(color: PColors.blue, width: 52, height: 110),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(22, 20, 22, 18),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            PleatMark(size: 22, colors: MarkColors.onDark),
                            const SizedBox(width: 8),
                            Text(
                              o.must ? 'PLEAT  ·  REQUIRED' : 'PLEAT  ·  UPDATE',
                              style: PType.tab(color: Colors.white),
                            ),
                          ],
                        ),
                        const SizedBox(height: 18),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('NOW', style: PType.tab(color: Colors.white.withValues(alpha: 0.72))),
                                const SizedBox(height: 4),
                                Text(
                                  o.from,
                                  style: PType.display(36, color: white70),
                                ),
                              ],
                            ),
                            Expanded(
                              child: Padding(
                                padding: const EdgeInsets.only(bottom: 10),
                                child: Center(
                                  child: _Planes(width: 40, color: PColors.ice),
                                ),
                              ),
                            ),
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: [
                                Text('NEXT', style: PType.tab(color: Colors.white.withValues(alpha: 0.72))),
                                const SizedBox(height: 4),
                                Text(
                                  o.to,
                                  style: PType.display(36, color: Colors.white),
                                ),
                              ],
                            ),
                          ],
                        ),
                        const Spacer(),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            col('SIZE', '${_mb(o.size)} MB'),
                            col('FOR', o.phone, a: CrossAxisAlignment.center),
                            o.busy
                                ? col('DONE', '${o.pct}%', a: CrossAxisAlignment.end)
                                : col('TIME', '~1 min', a: CrossAxisAlignment.end),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 18),
          o.busy
              ? PillButton(
                  label: 'Stop  ·  ${_mb(o.received)} of ${_mb(o.total)} MB',
                  icon: PIcon.close,
                  color: PColors.mist,
                  textColor: PColors.accentInk,
                  onTap: app.updater.stop,
                )
              : PillButton(label: 'Board the update', icon: PIcon.download, onTap: () {}),
          const SizedBox(height: 12),
          Center(
            child: Text(
              'Checked before it installs. Your account and plan stay.',
              style: PType.meta(),
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────── Version placements ───────────────────────────

/// 'footer': the signature at the end of Profile.
class VersionFooter extends StatelessWidget {
  const VersionFooter({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final v = app.updater.version;
    final has = app.appUpdate != null;
    return Column(
      children: [
        const PleatMark(size: 34),
        const SizedBox(height: 10),
        Text('Pleat $v', style: PType.h3()),
        const SizedBox(height: 6),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                color: has ? PColors.blue : PColors.safe,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 8),
            Text(
              has
                  ? '${app.appUpdate!.version} is ready'
                  : 'Up to date  ·  checked today',
              style: PType.meta(),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Pressable(
          onTap: has ? app.openUpdate : () {},
          label: 'Check for updates',
          radius: PRadius.pill,
          color: PColors.mist,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Text(
              has ? 'UPDATE' : 'CHECK FOR UPDATES',
              style: PType.button(color: PColors.accentInk),
            ),
          ),
        ),
      ],
    );
  }
}

/// 'tag': a version tag in Profile's top bar, where the mark sits.
class VersionTag extends StatelessWidget {
  const VersionTag({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final has = app.appUpdate != null;
    return Pressable(
      onTap: has ? app.openUpdate : () {},
      label: 'Pleat version',
      radius: PRadius.pill,
      color: PColors.surface,
      shadow: true,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 7, 14, 7),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const PleatMark(size: 24),
            const SizedBox(width: 8),
            Text('v${app.updater.version}', style: PType.meta(color: PColors.ink)),
            const SizedBox(width: 8),
            Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(
                color: has ? PColors.blue : PColors.safe,
                shape: BoxShape.circle,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 'about': one "About Pleat" card, last in Profile.
class VersionAbout extends StatelessWidget {
  const VersionAbout({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final has = app.appUpdate != null;
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(16, 16, 12, 16),
      child: Row(
        children: [
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              color: PColors.field,
              borderRadius: BorderRadius.circular(18),
            ),
            alignment: Alignment.center,
            child: const PleatMark(size: 32),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('About Pleat', style: PType.tab()),
                const SizedBox(height: 3),
                Text(
                  'Version ${app.updater.version}',
                  style: PType.h3().copyWith(fontSize: 16),
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        color: has ? PColors.blue : PColors.safe,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      has ? '${app.appUpdate!.version} is ready' : 'Up to date',
                      style: PType.small(),
                    ),
                  ],
                ),
              ],
            ),
          ),
          Pressable(
            onTap: has ? app.openUpdate : () {},
            label: 'Check',
            radius: PRadius.pill,
            color: has ? PColors.blue : PColors.mist,
            child: SizedBox(
              height: 40,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: Center(
                  child: Text(
                    has ? 'UPDATE' : 'CHECK',
                    style: PType.button(
                      color: has ? PColors.onAccent : PColors.accentInk,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────── Night mode placements ───────────────────────────

/// 'home': a small sun/moon switch in the Home header, by the bell.
class NightSwitch extends StatelessWidget {
  const NightSwitch({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final night = PColors.current.isDark;
    return Pressable(
      onTap: () => app.update((s) => s.theme = night ? 'day' : 'night'),
      label: night ? 'Day mode' : 'Night mode',
      radius: PRadius.pill,
      color: PColors.surface,
      shadow: true,
      child: SizedBox(
        width: 76,
        height: 40,
        child: Stack(
          children: [
            AnimatedAlign(
              duration: PMotion.state,
              curve: Curves.easeOutBack,
              alignment: night ? Alignment.centerRight : Alignment.centerLeft,
              child: Padding(
                padding: const EdgeInsets.all(4),
                child: Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    color: night ? PColors.navy : PColors.blue,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            ),
            Row(
              children: [
                Expanded(
                  child: Center(
                    child: PIconView(
                      PIcon.sun,
                      size: 17,
                      color: night ? PColors.muted : PColors.onAccent,
                    ),
                  ),
                ),
                Expanded(
                  child: Center(
                    child: PIconView(
                      PIcon.moon,
                      size: 17,
                      color: night ? PColors.onDeep : PColors.muted,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 'hero': two picture cards at the top of Profile, Day and Night, each a
/// small view of the look itself.
class NightHero extends StatelessWidget {
  const NightHero({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final night = PColors.current.isDark;
    Widget pane(bool forNight) {
      final pal = forNight ? PThemes.night : PThemes.day;
      final on = forNight == night;
      return Expanded(
        child: Pressable(
          onTap: () => app.update((s) => s.theme = forNight ? 'night' : 'day'),
          label: forNight ? 'Night' : 'Day',
          radius: 24,
          color: pal.ground,
          shadow: on,
          child: Container(
            height: 112,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(24),
              border: Border.all(
                color: on ? PColors.blue : Colors.transparent,
                width: 2.5,
              ),
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(22),
              child: Stack(
                children: [
                  Positioned(
                    right: -24,
                    top: -18,
                    child: ShardChip(color: pal.navy, width: 40, height: 96),
                  ),
                  Positioned(
                    right: 30,
                    top: 40,
                    child: ShardChip(color: pal.blue, width: 20, height: 70),
                  ),
                  Positioned(
                    left: 14,
                    top: 14,
                    child: Container(
                      width: 34,
                      height: 34,
                      decoration: BoxDecoration(
                        color: pal.surface,
                        shape: BoxShape.circle,
                      ),
                      alignment: Alignment.center,
                      child: PIconView(
                        forNight ? PIcon.moon : PIcon.sun,
                        size: 18,
                        color: pal.accentInk,
                      ),
                    ),
                  ),
                  Positioned(
                    left: 14,
                    bottom: 12,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          forNight ? 'Night' : 'Day',
                          style: PType.h3(color: pal.ink).copyWith(fontSize: 16),
                        ),
                        Text(
                          on ? 'ON' : 'TAP',
                          style: PType.tab(color: on ? pal.accentInk : pal.muted),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }

    return Row(children: [pane(false), const SizedBox(width: 12), pane(true)]);
  }
}

/// 'tiles': quick tiles at the top of Profile, the way a phone's control
/// centre works: tap flips, the deep fill says it is on.
class NightTiles extends StatelessWidget {
  const NightTiles({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final night = PColors.current.isDark;
    Widget tile(PIcon icon, String title, String state, bool on, VoidCallback tap) =>
        Expanded(
          child: Pressable(
            onTap: tap,
            label: title,
            radius: 24,
            color: on ? PColors.navy : PColors.surface,
            shadow: true,
            child: SizedBox(
              height: 104,
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(
                        color: on ? PColors.blue : PColors.field,
                        shape: BoxShape.circle,
                      ),
                      alignment: Alignment.center,
                      child: PIconView(
                        icon,
                        size: 18,
                        color: on ? PColors.onAccent : PColors.accentInk,
                      ),
                    ),
                    const Spacer(),
                    Text(
                      title,
                      style: PType.h3(
                        color: on ? PColors.onDeep : PColors.ink,
                      ).copyWith(fontSize: 14),
                    ),
                    Text(
                      state,
                      style: PType.tab(
                        color: on ? PColors.ice : PColors.muted,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
    return Row(
      children: [
        tile(PIcon.moon, 'Night', night ? 'ON' : 'OFF', night,
            () => app.update((s) => s.theme = night ? 'day' : 'night')),
        const SizedBox(width: 10),
        tile(PIcon.pulse, 'Calm', app.reduceMotion ? 'ON' : 'OFF', app.reduceMotion,
            () => app.update((s) => s.reduceMotion = !app.reduceMotion)),
        const SizedBox(width: 10),
        tile(PIcon.route, 'Check', 'RUN', false, () {}),
      ],
    );
  }
}
