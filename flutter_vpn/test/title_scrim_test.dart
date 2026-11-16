// UX-07: section titles sit on a soft pill of the page colour, so a shard
// drawn behind them never takes the text's contrast away.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/design/widgets.dart';

bool _onScrim(WidgetTester tester, String text) {
  final boxes = find.ancestor(
    of: find.text(text),
    matching: find.byType(DecoratedBox),
  );
  return boxes.evaluate().any((e) {
    final d = (e.widget as DecoratedBox).decoration;
    return d is BoxDecoration &&
        d.color != null &&
        d.color!.withValues(alpha: 1) == PColors.ground &&
        d.color!.a >= 0.8;
  });
}

void main() {
  setUp(() => PType.familyOverride = 'PleatTest');

  testWidgets('a section title is on a page-coloured scrim', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: SectionLabel('Recommended exits')),
      ),
    );
    expect(_onScrim(tester, 'Recommended exits'), isTrue);
  });
}
