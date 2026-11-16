import 'package:flutter/material.dart';

import '../api/models.dart';
import '../design/backdrop.dart';
import '../design/geometry.dart';
import '../design/icons.dart';
import '../design/scenes.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/whats_new.dart';
import 'plan_usage.dart' show SoftChip, dayText;

/// What's new (Ali's pick A + the history page of C): the update sheet lists
/// the coming version's lines, Home shows a card once after an update, and
/// Profile opens every version's lines.

/// NEW / BETTER / FIXED, the same width each so the lines start together.
class NoteChip extends StatelessWidget {
  const NoteChip(this.kind, {super.key});
  final NoteKind kind;

  Color get _color => switch (kind) {
    NoteKind.added => PColors.accentInk,
    NoteKind.better => PColors.safe,
    NoteKind.fixed => PColors.muted,
  };

  @override
  Widget build(BuildContext context) => Container(
    width: 68,
    alignment: Alignment.center,
    padding: const EdgeInsets.symmetric(vertical: 4),
    decoration: BoxDecoration(
      color: _color.withValues(alpha: 0.14),
      borderRadius: BorderRadius.circular(PRadius.pill),
    ),
    child: Text(
      kind.label,
      style: PType.tab(color: _color).copyWith(fontSize: 10.5),
    ),
  );
}

/// A version's lines, each with its chip.
class NoteLines extends StatelessWidget {
  const NoteLines(this.notes, {super.key, this.gap = 12});
  final List<ReleaseNote> notes;
  final double gap;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final (i, n) in notes.indexed) ...[
        if (i > 0) SizedBox(height: gap),
        Semantics(
          label: '${n.kind.label}: ${n.text}',
          excludeSemantics: true,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: NoteChip(n.kind),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  n.text,
                  style: PType.body().copyWith(fontSize: 14.5, height: 1.4),
                ),
              ),
            ],
          ),
        ),
      ],
    ],
  );
}

void openWhatsNew(BuildContext context) {
  AppScope.read(context).seenWhatsNew();
  Navigator.of(context).push(FadeRoute(builder: (_) => const WhatsNewScreen()));
}

/// Home, once after an update: "You're on the new Pleat".
class WhatsNewCard extends StatelessWidget {
  const WhatsNewCard({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final e = app.whatsNew.of(app.updater.version);
    final n = e?.notes.length ?? 0;
    return Semantics(
      container: true,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(26),
        child: Container(
          color: PColors.navy,
          child: Stack(
            children: [
              Positioned.fill(
                child: CustomPaint(painter: _CardShard(PColors.blue)),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 14, 8, 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            'UPDATED · ${app.updater.version}',
                            style: PType.tab(
                              color: PColors.onDeep.withValues(alpha: 0.72),
                            ),
                          ),
                        ),
                        RoundIcon(
                          PIcon.close,
                          onTap: app.seenWhatsNew,
                          label: 'Hide',
                          color: PColors.onDeep,
                        ),
                      ],
                    ),
                    Padding(
                      padding: const EdgeInsets.only(right: 96),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'You’re on the new Pleat',
                            style: PType.h3(color: PColors.onDeep),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            n == 1
                                ? '1 change in this version'
                                : '$n changes in this version',
                            style: PType.small(
                              color: PColors.onDeep.withValues(alpha: 0.8),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    Pressable(
                      onTap: () => openWhatsNew(context),
                      label: 'See what’s new',
                      radius: PRadius.pill,
                      color: PColors.onDeep,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 10,
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            PIconView(
                              PIcon.bolt,
                              color: PColors.navy,
                              size: 16,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              'SEE WHAT’S NEW',
                              style: PType.button(color: PColors.navy),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The blue pleat across the card's right edge.
class _CardShard extends CustomPainter {
  _CardShard(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size s) {
    final h = s.height * 1.3;
    canvas.drawPath(
      shardPath(Offset(s.width - 18, s.height * 0.62), 92, h, 0.42),
      Paint()..color = color,
    );
  }

  @override
  bool shouldRepaint(_CardShard old) => old.color != color;
}

/// Profile › What's new: every version's lines, newest first.
class WhatsNewScreen extends StatelessWidget {
  const WhatsNewScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final book = app.whatsNew;
    final mine = app.updater.version;
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
              Text('What’s new', style: PType.h1()),
              const SizedBox(height: 4),
              Padding(
                padding: const EdgeInsets.only(right: 96),
                child: Text(
                  'Every Pleat update, newest first.',
                  style: PType.small(),
                ),
              ),
              const SizedBox(height: 22),
              if (book.entries.isEmpty)
                SurfaceCard(
                  child: Text('Nothing to show yet.', style: PType.body()),
                )
              else
                for (final (i, e) in book.entries.indexed)
                  _VersionRow(
                    entry: e,
                    mine: e.version == mine,
                    last: i == book.entries.length - 1,
                  ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One version on the line: a dot, its number and day, then its lines.
class _VersionRow extends StatelessWidget {
  const _VersionRow({
    required this.entry,
    required this.mine,
    required this.last,
  });
  final ReleaseEntry entry;
  final bool mine, last;

  @override
  Widget build(BuildContext context) {
    final d = entry.date;
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 26,
            child: Stack(
              alignment: Alignment.topCenter,
              children: [
                if (!last)
                  Positioned(
                    top: 12,
                    bottom: 0,
                    child: Container(width: 2, color: PColors.ice),
                  ),
                Container(
                  margin: const EdgeInsets.only(top: 3),
                  width: 16,
                  height: 16,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: mine ? PColors.blue : PColors.surface,
                    border: Border.all(
                      color: mine ? PColors.blue : PColors.ice,
                      width: 3,
                    ),
                    boxShadow: mine
                        ? [
                            BoxShadow(
                              color: PColors.blue.withValues(alpha: 0.22),
                              spreadRadius: 5,
                            ),
                          ]
                        : null,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: 8,
                    runSpacing: 4,
                    children: [
                      Text(entry.version, style: PType.h3()),
                      if (d != null)
                        Text(dayText(d, year: false), style: PType.meta()),
                      if (mine)
                        SoftChip('YOU HAVE THIS', color: PColors.accentInk),
                    ],
                  ),
                  const SizedBox(height: 8),
                  SurfaceCard(
                    padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
                    child: entry.notes.isEmpty
                        ? Text('Smaller fixes.', style: PType.small())
                        : NoteLines(entry.notes, gap: 10),
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
