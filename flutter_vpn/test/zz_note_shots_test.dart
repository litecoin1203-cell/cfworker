// LOCAL ONLY (not committed): update-notification concepts, drawn as the
// Android shade would show them. Parts in Roboto are what the system or a
// RemoteViews TextView draws; parts in Plus Jakarta Sans are bitmaps the
// app paints itself (setImageViewBitmap), which is how a notification can
// carry the Pleat type and shards.
// flutter test test/zz_note_shots_test.dart --update-goldens
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/city_art.dart';
import 'package:pleat/design/icons.dart';
import 'package:pleat/design/mark.dart';
import 'package:pleat/design/tokens.dart';

const _fonts =
    '/tmp/claude-0/-home-user/7f56533a-4593-5159-90eb-146161e8c741/scratchpad/fonts';

Future<void> _font(String family, List<String> files) async {
  final f = FontLoader(family);
  for (final n in files) {
    f.addFont(
      Future.value(ByteData.sublistView(File('$_fonts/$n').readAsBytesSync())),
    );
  }
  await f.load();
}

// ── the system's side ─────────────────────────────────────────────
class Sys {
  Sys(this.night);
  final bool night;
  Color get shade => night ? const Color(0xFF0D0F12) : const Color(0xFFDCE2EA);
  Color get card => night ? const Color(0xFF1D2127) : Colors.white;
  Color get ink => night ? const Color(0xFFE8EAED) : const Color(0xFF1B1C1F);
  Color get muted => night ? const Color(0xFFA6ABB3) : const Color(0xFF5B6068);
  Color get chip => night ? const Color(0xFF2A3038) : const Color(0xFFEFF2F6);
  Color get link => night ? const Color(0xFF8AB8FA) : const Color(0xFF1E66D0);
  TextStyle t(double s, FontWeight w, {Color? c, double? h}) => TextStyle(
    fontFamily: 'Roboto',
    fontSize: s,
    fontWeight: w,
    color: c ?? ink,
    height: h,
  );
}

/// A Pleat app-icon dot, as Android draws the small icon in the header.
Widget _appDot([double size = 20]) => Container(
  width: size,
  height: size,
  decoration: const BoxDecoration(
    color: Color(0xFF2F89F5),
    shape: BoxShape.circle,
  ),
  alignment: Alignment.center,
  child: PleatMark(
    size: size * 0.62,
    colors: const MarkColors(Colors.white, Color(0xFFA9D4F5), Color(0xFF2F89F5)),
  ),
);

/// The card Android puts around any notification, with its header row.
class Note extends StatelessWidget {
  const Note({
    super.key,
    required this.sys,
    required this.child,
    this.expanded = true,
    this.when = 'now',
    this.header = true,
  });
  final Sys sys;
  final Widget child;
  final bool expanded, header;
  final String when;

  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(
      color: sys.card,
      borderRadius: BorderRadius.circular(26),
    ),
    padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (header) ...[
          Row(
            children: [
              _appDot(),
              const SizedBox(width: 8),
              Text('Pleat', style: sys.t(13, FontWeight.w500)),
              Text('  ·  $when', style: sys.t(13, FontWeight.w400, c: sys.muted)),
              const Spacer(),
              Container(
                width: 28,
                height: 28,
                decoration: BoxDecoration(color: sys.chip, shape: BoxShape.circle),
                alignment: Alignment.center,
                child: Transform.rotate(
                  angle: expanded ? -math.pi / 2 : math.pi / 2,
                  child: PIconView(PIcon.chevron, size: 14, color: sys.ink),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
        ],
        child,
      ],
    ),
  );
}

/// A label above each state in the shade.
Widget _cap(Sys sys, String s) => Padding(
  padding: const EdgeInsets.fromLTRB(8, 18, 8, 10),
  child: Text(
    s.toUpperCase(),
    style: sys.t(12, FontWeight.w700, c: sys.muted).copyWith(letterSpacing: 1.4),
  ),
);

/// A status bar, with an optional Live Update chip.
Widget _statusBar(Sys sys, {Widget? chip}) => Padding(
  padding: const EdgeInsets.fromLTRB(14, 6, 14, 2),
  child: Row(
    children: [
      Text('11:42', style: sys.t(15, FontWeight.w500)),
      const SizedBox(width: 8),
      ?chip,
      const Spacer(),
      PIconView(PIcon.wifi, size: 18, color: sys.ink),
      const SizedBox(width: 6),
      Container(
        width: 22,
        height: 11,
        decoration: BoxDecoration(
          border: Border.all(color: sys.ink, width: 1.5),
          borderRadius: BorderRadius.circular(3),
        ),
        padding: const EdgeInsets.all(1.5),
        alignment: Alignment.centerLeft,
        child: FractionallySizedBox(
          widthFactor: 0.7,
          child: Container(color: sys.ink),
        ),
      ),
    ],
  ),
);

// ── shared Pleat pieces (painted by the app as bitmaps) ──────────────
Widget _pill(
  String label, {
  required Color bg,
  required Color fg,
  PIcon? icon,
  double h = 42,
  bool expand = true,
  Color? border,
}) {
  final body = Container(
    height: h,
    padding: const EdgeInsets.symmetric(horizontal: 18),
    decoration: BoxDecoration(
      color: bg,
      borderRadius: BorderRadius.circular(h),
      border: border == null ? null : Border.all(color: border, width: 1.4),
    ),
    alignment: Alignment.center,
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (icon != null) ...[
          PIconView(icon, size: 16, color: fg),
          const SizedBox(width: 8),
        ],
        Text(label.toUpperCase(), style: PType.button(color: fg)),
      ],
    ),
  );
  return expand ? Expanded(child: body) : body;
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.frac, this.track, this.arc, this.w);
  final double frac, w;
  final Color track, arc;
  @override
  void paint(Canvas c, Size s) {
    final r = Rect.fromCircle(center: s.center(Offset.zero), radius: s.width / 2 - w / 2);
    final p = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = w
      ..strokeCap = StrokeCap.round;
    c.drawArc(r, 0, math.pi * 2, false, p..color = track);
    if (frac > 0) c.drawArc(r, -math.pi / 2, math.pi * 2 * frac, false, p..color = arc);
  }

  @override
  bool shouldRepaint(_) => true;
}

/// A slanted band from the left edge to [frac] of the width: the shard
/// that is the progress in concept 1.
class _BandPainter extends CustomPainter {
  _BandPainter(this.frac, this.color);
  final double frac;
  final Color color;
  @override
  void paint(Canvas c, Size s) {
    final x = s.width * frac;
    final run = s.height * 0.32;
    final path = Path()
      ..moveTo(0, 0)
      ..lineTo(x + run, 0)
      ..lineTo(x, s.height)
      ..lineTo(0, s.height)
      ..close();
    c.drawPath(path, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_) => true;
}

// ── state of the offer in the mockups ──
const _from = '1.2.29', _to = '1.2.30', _size = '71.4 MB';
const _frac = 0.38;

// ═════════════ Concept 1 — "Shard card": the notification is a Pleat card
class C1 {
  static Widget art({required double frac, required String tag, required Widget big, required String line, double h = 150, bool done = false}) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(20),
      child: Container(
        height: h,
        color: PColors.navy,
        child: Stack(
          children: [
            if (frac > 0)
              Positioned.fill(
                child: CustomPaint(
                  painter: _BandPainter(frac, PColors.blue.withValues(alpha: 0.9)),
                ),
              ),
            Positioned(
              right: -34,
              top: -24,
              child: ShardChip(color: done ? PColors.safe : PColors.blue, width: 54, height: h + 40),
            ),
            Positioned(
              right: 62,
              top: -h * 0.35,
              child: Opacity(
                opacity: 0.35,
                child: ShardChip(color: PColors.ice, width: 14, height: h * 0.7),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 18, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      PleatMark(size: 18, colors: MarkColors.onDark),
                      const SizedBox(width: 8),
                      Text(tag, style: PType.tab(color: Colors.white.withValues(alpha: 0.8))),
                    ],
                  ),
                  const Spacer(),
                  big,
                  const SizedBox(height: 6),
                  Text(line, style: PType.small(color: Colors.white.withValues(alpha: 0.78))),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  static Widget panel(Sys sys) {
    final white = Colors.white;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _cap(sys, 'Arrives (heads-up)'),
        Note(
          sys: sys,
          expanded: false,
          child: Row(
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  color: PColors.navy,
                  borderRadius: BorderRadius.circular(14),
                ),
                clipBehavior: Clip.antiAlias,
                child: Stack(
                  children: [
                    Positioned(right: -14, top: -6, child: ShardChip(color: PColors.blue, width: 14, height: 60)),
                    Center(child: PleatMark(size: 24, colors: MarkColors.onDark)),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Pleat $_to is here', style: sys.t(15, FontWeight.w700)),
                    const SizedBox(height: 2),
                    Text('One tap · $_size · settings stay', style: sys.t(13, FontWeight.w400, c: sys.muted)),
                  ],
                ),
              ),
              _pill('Update', bg: PColors.blue, fg: white, h: 36, expand: false),
            ],
          ),
        ),
        _cap(sys, 'Pulled down'),
        Note(
          sys: sys,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              art(
                frac: 0,
                tag: 'A NEW PLEAT',
                big: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(_to, style: PType.display(58, color: white)),
                    const SizedBox(width: 10),
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Text('from $_from', style: PType.small(color: white.withValues(alpha: 0.75))),
                    ),
                  ],
                ),
                line: '$_size  ·  made for this phone  ·  checked',
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  _pill('Update now', bg: PColors.blue, fg: white, icon: PIcon.download),
                  const SizedBox(width: 10),
                  _pill('Later', bg: sys.chip, fg: sys.ink, expand: false),
                ],
              ),
            ],
          ),
        ),
        _cap(sys, 'Downloading — the shard is the progress'),
        Note(
          sys: sys,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              art(
                frac: _frac,
                h: 120,
                tag: 'DOWNLOADING  ·  $_to',
                big: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text('38', style: PType.display(52, color: white)),
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4, left: 4),
                      child: Text('%', style: PType.h3(color: white)),
                    ),
                  ],
                ),
                line: '27.1 of $_size  ·  about 40 s left',
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  _pill('Stop', bg: sys.chip, fg: sys.ink, icon: PIcon.close),
                ],
              ),
            ],
          ),
        ),
        _cap(sys, 'Ready to install'),
        Note(
          sys: sys,
          expanded: false,
          child: Row(
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(color: PColors.safe, borderRadius: BorderRadius.circular(14)),
                alignment: Alignment.center,
                child: PIconView(PIcon.check, size: 24, color: white),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Pleat $_to is ready', style: sys.t(15, FontWeight.w700)),
                    const SizedBox(height: 2),
                    Text('Downloaded and checked', style: sys.t(13, FontWeight.w400, c: sys.muted)),
                  ],
                ),
              ),
              _pill('Install', bg: PColors.blue, fg: white, h: 36, expand: false),
            ],
          ),
        ),
      ],
    );
  }
}

// ═════════════ Concept 2 — "Live track": Android 16 Live Update look
class C2 {
  static Widget track(Sys sys, double frac, {int stage = 0}) {
    // three segments: download (70%), check (15%), install (15%)
    const parts = [0.70, 0.15, 0.15];
    return LayoutBuilder(
      builder: (context, box) {
        final w = box.maxWidth - 8;
        final x = (w * parts[0] * frac).clamp(0.0, w);
        return SizedBox(
          height: 34,
          child: Stack(
            clipBehavior: Clip.none,
            alignment: Alignment.centerLeft,
            children: [
              Row(
                children: [
                  for (var i = 0; i < 3; i++) ...[
                    if (i > 0) const SizedBox(width: 4),
                    Expanded(
                      flex: (parts[i] * 100).round(),
                      child: Container(
                        height: 8,
                        decoration: BoxDecoration(
                          color: i < stage ? PColors.blue : (sys.night ? const Color(0xFF2E3A4E) : PColors.mist),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        alignment: Alignment.centerLeft,
                        child: i == stage && i == 0
                            ? FractionallySizedBox(
                                widthFactor: frac,
                                child: Container(
                                  decoration: BoxDecoration(
                                    color: PColors.blue,
                                    borderRadius: BorderRadius.circular(4),
                                  ),
                                ),
                              )
                            : null,
                      ),
                    ),
                  ],
                ],
              ),
              Positioned(
                left: stage == 0 ? x - 14 : null,
                right: stage == 0 ? null : 0,
                child: Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    color: PColors.blue,
                    shape: BoxShape.circle,
                    border: Border.all(color: sys.card, width: 3),
                  ),
                  alignment: Alignment.center,
                  child: stage >= 3
                      ? PIconView(PIcon.check, size: 14, color: Colors.white)
                      : PleatMark(
                          size: 15,
                          colors: const MarkColors(Colors.white, Color(0xFFA9D4F5), Color(0xFF2F89F5)),
                        ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  static Widget chip(String s) => Container(
    height: 22,
    padding: const EdgeInsets.symmetric(horizontal: 9),
    decoration: BoxDecoration(color: const Color(0xFF2F89F5), borderRadius: BorderRadius.circular(11)),
    alignment: Alignment.center,
    child: Row(
      children: [
        PIconView(PIcon.download, size: 12, color: Colors.white),
        const SizedBox(width: 5),
        Text(s, style: const TextStyle(fontFamily: 'Roboto', fontSize: 12, fontWeight: FontWeight.w700, color: Colors.white)),
      ],
    ),
  );

  static Widget ends(Sys sys) => Row(
    children: [
      Text(_from, style: sys.t(12, FontWeight.w500, c: sys.muted)),
      const Spacer(),
      Text('Check', style: sys.t(12, FontWeight.w500, c: sys.muted)),
      const SizedBox(width: 26),
      Text(_to, style: sys.t(12, FontWeight.w700, c: sys.link)),
    ],
  );

  static Widget panel(Sys sys) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      _cap(sys, 'Status bar while it downloads'),
      Container(
        decoration: BoxDecoration(color: sys.card, borderRadius: BorderRadius.circular(18)),
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: _statusBar(sys, chip: chip('38%')),
      ),
      _cap(sys, 'Arrives'),
      Note(
        sys: sys,
        expanded: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Pleat $_to is ready for you', style: sys.t(15, FontWeight.w700)),
            const SizedBox(height: 2),
            Text('$_size · your account and settings stay', style: sys.t(13, FontWeight.w400, c: sys.muted)),
            const SizedBox(height: 12),
            track(sys, 0),
            ends(sys),
            const SizedBox(height: 10),
            Row(
              children: [
                Text('UPDATE NOW', style: sys.t(14, FontWeight.w700, c: sys.link)),
                const SizedBox(width: 28),
                Text('LATER', style: sys.t(14, FontWeight.w700, c: sys.link)),
              ],
            ),
          ],
        ),
      ),
      _cap(sys, 'Downloading — the Pleat mark rides the line'),
      Note(
        sys: sys,
        when: '38%',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text('Updating to $_to', style: sys.t(15, FontWeight.w700)),
                const Spacer(),
                Text('40 s left', style: sys.t(13, FontWeight.w500, c: sys.muted)),
              ],
            ),
            const SizedBox(height: 2),
            Text('27.1 of $_size', style: sys.t(13, FontWeight.w400, c: sys.muted)),
            const SizedBox(height: 12),
            track(sys, _frac),
            ends(sys),
            const SizedBox(height: 10),
            Text('STOP', style: sys.t(14, FontWeight.w700, c: sys.link)),
          ],
        ),
      ),
      _cap(sys, 'Ready to install'),
      Note(
        sys: sys,
        expanded: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Checked. Tap to install $_to', style: sys.t(15, FontWeight.w700)),
            const SizedBox(height: 12),
            track(sys, 1, stage: 2),
            ends(sys),
            const SizedBox(height: 10),
            Text('INSTALL', style: sys.t(14, FontWeight.w700, c: sys.link)),
          ],
        ),
      ),
    ],
  );
}

// ═════════════ Concept 3 — "Poster": a picture notification
class C3 {
  static Widget poster({double h = 186}) {
    final white = Colors.white;
    return ClipRRect(
      borderRadius: BorderRadius.circular(18),
      child: Container(
        height: h,
        color: PColors.navy,
        child: Stack(
          children: [
            // the folded planes, unfolding across the picture
            Positioned(left: -40, top: -30, child: Opacity(opacity: 0.35, child: ShardChip(color: PColors.ice, width: 30, height: 140))),
            Positioned(left: 150, top: -60, child: ShardChip(color: PColors.blue, width: 70, height: h + 120)),
            Positioned(left: 238, top: -30, child: Opacity(opacity: 0.8, child: ShardChip(color: PColors.ice, width: 40, height: h + 60))),
            Positioned(right: -30, bottom: -40, child: Opacity(opacity: 0.6, child: ShardChip(color: PColors.blue, width: 50, height: 130))),
            Positioned(
              left: 20,
              top: 18,
              child: Row(
                children: [
                  PleatMark(size: 20, colors: MarkColors.onDark),
                  const SizedBox(width: 8),
                  Text('PLEAT', style: PType.tab(color: white)),
                ],
              ),
            ),
            Positioned(
              left: 18,
              bottom: 16,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('NEW', style: PType.tab(color: white.withValues(alpha: 0.8))),
                  Text(_to, style: PType.display(76, color: white)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  static Widget largeIcon() => ClipRRect(
    borderRadius: BorderRadius.circular(12),
    child: Container(
      width: 44,
      height: 44,
      color: PColors.navy,
      child: Stack(
        children: [
          Positioned(left: 8, top: -8, child: ShardChip(color: PColors.blue, width: 12, height: 60)),
          Center(child: Text('30', style: PType.h3(color: Colors.white))),
        ],
      ),
    ),
  );

  static Widget panel(Sys sys) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      _cap(sys, 'Arrives'),
      Note(
        sys: sys,
        expanded: false,
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('A new Pleat: $_to', style: sys.t(15, FontWeight.w700)),
                  const SizedBox(height: 2),
                  Text('Pull down to see it', style: sys.t(13, FontWeight.w400, c: sys.muted)),
                ],
              ),
            ),
            largeIcon(),
          ],
        ),
      ),
      _cap(sys, 'Pulled down — a poster of the release'),
      Note(
        sys: sys,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('A new Pleat: $_to', style: sys.t(15, FontWeight.w700)),
            const SizedBox(height: 2),
            Text('$_size · checked before it installs', style: sys.t(13, FontWeight.w400, c: sys.muted)),
            const SizedBox(height: 12),
            poster(),
            const SizedBox(height: 12),
            Row(
              children: [
                Text('UPDATE NOW', style: sys.t(14, FontWeight.w700, c: sys.link)),
                const SizedBox(width: 28),
                Text('LATER', style: sys.t(14, FontWeight.w700, c: sys.link)),
              ],
            ),
          ],
        ),
      ),
      _cap(sys, 'Downloading'),
      Note(
        sys: sys,
        when: '38%',
        expanded: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(child: Text('Downloading Pleat $_to', style: sys.t(15, FontWeight.w700))),
                largeIcon(),
              ],
            ),
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: LinearProgressIndicator(
                value: _frac,
                minHeight: 5,
                color: const Color(0xFF2F89F5),
                backgroundColor: sys.chip,
              ),
            ),
          ],
        ),
      ),
    ],
  );
}

// ═════════════ Concept 4 — "Orbit": the ring around the mark
class C4 {
  static Widget ring(Sys sys, double frac, double size, {bool done = false}) => SizedBox.square(
    dimension: size,
    child: Stack(
      alignment: Alignment.center,
      children: [
        CustomPaint(
          size: Size.square(size),
          painter: _RingPainter(frac, sys.night ? const Color(0xFF2E3A4E) : PColors.mist, done ? PColors.safe : PColors.blue, size * 0.08),
        ),
        Container(
          width: size * 0.70,
          height: size * 0.70,
          decoration: BoxDecoration(color: done ? PColors.safe : PColors.blue, shape: BoxShape.circle),
          alignment: Alignment.center,
          child: done
              ? PIconView(PIcon.check, size: size * 0.32, color: Colors.white)
              : PleatMark(
                  size: size * 0.36,
                  colors: const MarkColors(Colors.white, Color(0xFFA9D4F5), Color(0xFF2F89F5)),
                ),
        ),
      ],
    ),
  );

  static Widget steps(Sys sys, int stage) => Row(
    children: [
      for (final (i, s) in ['Download', 'Check', 'Install'].indexed) ...[
        if (i > 0) Container(width: 14, height: 1.5, margin: const EdgeInsets.symmetric(horizontal: 6), color: sys.muted.withValues(alpha: 0.5)),
        Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(
            color: i <= stage ? PColors.blue : sys.muted.withValues(alpha: 0.4),
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 5),
        Text(s, style: sys.t(12, i == stage ? FontWeight.w700 : FontWeight.w500, c: i == stage ? sys.ink : sys.muted)),
      ],
    ],
  );

  static Widget panel(Sys sys) {
    final white = Colors.white;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _cap(sys, 'Arrives'),
        Note(
          sys: sys,
          expanded: false,
          child: Row(
            children: [
              ring(sys, 0, 48),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Pleat $_to', style: sys.t(15, FontWeight.w700)),
                    const SizedBox(height: 2),
                    Text('Ready when you are · $_size', style: sys.t(13, FontWeight.w400, c: sys.muted)),
                  ],
                ),
              ),
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: PColors.blue, shape: BoxShape.circle),
                alignment: Alignment.center,
                child: PIconView(PIcon.download, size: 18, color: white),
              ),
            ],
          ),
        ),
        _cap(sys, 'Downloading — pulled down'),
        Note(
          sys: sys,
          when: '38%',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Stack(
                    alignment: Alignment.center,
                    children: [
                      ring(sys, _frac, 96),
                    ],
                  ),
                  const SizedBox(width: 18),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text('38', style: PType.display(50, color: sys.ink)),
                            Padding(
                              padding: const EdgeInsets.only(bottom: 4, left: 3),
                              child: Text('%', style: PType.h3(color: sys.ink)),
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Text('Pleat $_to · 27.1 of $_size', style: sys.t(13, FontWeight.w400, c: sys.muted)),
                        const SizedBox(height: 8),
                        steps(sys, 0),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  _pill('Stop', bg: sys.chip, fg: sys.ink, icon: PIcon.close),
                ],
              ),
            ],
          ),
        ),
        _cap(sys, 'Ready to install'),
        Note(
          sys: sys,
          expanded: false,
          child: Row(
            children: [
              ring(sys, 1, 48, done: true),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Pleat $_to is ready', style: sys.t(15, FontWeight.w700)),
                    const SizedBox(height: 4),
                    steps(sys, 2),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Today's notification, for comparison.
Widget today(Sys sys) => Column(
  crossAxisAlignment: CrossAxisAlignment.stretch,
  children: [
    _cap(sys, 'Today'),
    Note(
      sys: sys,
      expanded: false,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Pleat $_to is ready', style: sys.t(15, FontWeight.w700)),
          const SizedBox(height: 2),
          Text('Tap to update. Your account and settings stay as they are.', style: sys.t(13, FontWeight.w400, c: sys.muted)),
        ],
      ),
    ),
  ],
);

void main() {
  setUpAll(() async {
    await _font('PleatTest', [for (final w in [300, 400, 500, 600, 700, 800]) 'pjs-$w.ttf']);
    await _font('Roboto', ['roboto-400.ttf', 'roboto-500.ttf', 'roboto-700.ttf']);
    PType.familyOverride = 'PleatTest';
  });

  final concepts = <String, Widget Function(Sys)>{
    'today': today,
    'c1': C1.panel,
    'c2': C2.panel,
    'c3': C3.panel,
    'c4': C4.panel,
  };
  for (final e in concepts.entries) {
    for (final night in [false, true]) {
      testWidgets('${e.key} ${night ? 'night' : 'day'}', (t) async {
        PColors.current = night ? PThemes.night : PThemes.day;
        addTearDown(() => PColors.current = PThemes.day);
        t.view.physicalSize = Size(412 * 2.5, e.key == 'today' ? 200 * 2.5 : 1000 * 2.5);
        t.view.devicePixelRatio = 2.5;
        addTearDown(t.view.reset);
        final sys = Sys(night);
        await t.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            home: Material(
              color: sys.shade,
              child: Align(
                alignment: Alignment.topCenter,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 4, 12, 16),
                  child: e.value(sys),
                ),
              ),
            ),
          ),
        );
        await t.pump();
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile('notes/${e.key}-${night ? 'night' : 'day'}.png'),
        );
      });
    }
  }
}
