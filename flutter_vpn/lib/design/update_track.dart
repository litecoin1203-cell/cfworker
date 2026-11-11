import 'package:flutter/material.dart';

import 'mark.dart';
import 'tokens.dart';

/// The update's three-part line: Download (long), Check, Install, with the
/// Pleat mark riding it. The system notification draws the same line
/// (Updates.kt), so the card and the shade look alike.
class UpdateTrack extends StatelessWidget {
  const UpdateTrack({
    super.key,
    required this.stage,
    required this.frac,
    required this.from,
    required this.to,
  });

  /// 0 download, 1 check, 2 install.
  final int stage;

  /// How far the download is, 0 … 1.
  final double frac;
  final String from, to;

  static const _parts = [70, 15, 15];
  static const _gap = 4.0, _bar = 8.0, _knob = 30.0;

  @override
  Widget build(BuildContext context) {
    final empty = PColors.current.isDark
        ? PColors.ice.withValues(alpha: 0.45)
        : PColors.mist;
    final d = PMotion.reduced(context) ? Duration.zero : PMotion.state;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        LayoutBuilder(
          builder: (context, box) {
            final w = box.maxWidth - 2 * _gap;
            final seg = [for (final p in _parts) w * p / 100];
            final x = switch (stage) {
              0 => seg[0] * frac,
              1 => seg[0] + _gap + seg[1] / 2,
              _ => box.maxWidth,
            };
            final left = (x - _knob / 2).clamp(0.0, box.maxWidth - _knob);
            return SizedBox(
              height: _knob + 2,
              child: Stack(
                alignment: Alignment.centerLeft,
                children: [
                  Row(
                    children: [
                      for (var i = 0; i < 3; i++) ...[
                        if (i > 0) const SizedBox(width: _gap),
                        SizedBox(
                          width: seg[i],
                          height: _bar,
                          child: DecoratedBox(
                            decoration: BoxDecoration(
                              color: i < stage ? PColors.blue : empty,
                              borderRadius: BorderRadius.circular(_bar / 2),
                            ),
                            child: i == 0 && stage == 0
                                ? Align(
                                    alignment: Alignment.centerLeft,
                                    child: AnimatedFractionallySizedBox(
                                      duration: d,
                                      widthFactor: frac,
                                      heightFactor: 1,
                                      child: DecoratedBox(
                                        decoration: BoxDecoration(
                                          color: PColors.blue,
                                          borderRadius: BorderRadius.circular(
                                            _bar / 2,
                                          ),
                                        ),
                                      ),
                                    ),
                                  )
                                : null,
                          ),
                        ),
                      ],
                    ],
                  ),
                  AnimatedPositioned(
                    duration: d,
                    curve: Curves.easeOutCubic,
                    left: left,
                    child: Container(
                      width: _knob,
                      height: _knob,
                      decoration: BoxDecoration(
                        color: PColors.blue,
                        shape: BoxShape.circle,
                        border: Border.all(color: PColors.surface, width: 3),
                        boxShadow: PShadow.lift,
                      ),
                      alignment: Alignment.center,
                      child: PleatMark(
                        size: 14,
                        colors: MarkColors(
                          PColors.onAccent,
                          PColors.ice,
                          PColors.blue,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            );
          },
        ),
        const SizedBox(height: 4),
        Row(
          children: [
            Expanded(
              flex: _parts[0],
              child: Text(from, style: PType.meta()),
            ),
            Expanded(
              flex: _parts[1],
              child: Text(
                'Check',
                textAlign: TextAlign.center,
                style: PType.meta(color: stage >= 1 ? PColors.ink : null),
              ),
            ),
            Expanded(
              flex: _parts[2],
              child: Text(
                to,
                textAlign: TextAlign.end,
                style: PType.meta(color: PColors.accentInk),
              ),
            ),
          ],
        ),
      ],
    );
  }
}
