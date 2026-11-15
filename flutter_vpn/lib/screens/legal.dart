import 'package:flutter/material.dart';

import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/tunnel_route.dart';
import '../design/widgets.dart';
import '../legal_text.dart';

/// The Privacy policy and Terms of use. Their text is docs/legal/*.txt,
/// which the Telegram Mini App bundles too (miniapp/src/legal.js), copied
/// into [privacyText] / [termsText] (a test keeps them equal). Format: `# `
/// the title, `## ` a section, `- ` a list item, anything else a paragraph;
/// one block per line.
enum LegalDoc {
  privacy('Privacy policy', 'privacy.txt', privacyText),
  terms('Terms of use', 'terms.txt', termsText);

  const LegalDoc(this.title, this.file, this.text);
  final String title, file, text;
}

enum LegalKind { title, heading, item, paragraph }

typedef LegalBlock = ({LegalKind kind, String text});

/// The text file as blocks.
List<LegalBlock> parseLegal(String text) => [
  for (final raw in text.split('\n'))
    if (raw.trim().isNotEmpty)
      if (raw.startsWith('## '))
        (kind: LegalKind.heading, text: raw.substring(3).trim())
      else if (raw.startsWith('# '))
        (kind: LegalKind.title, text: raw.substring(2).trim())
      else if (raw.startsWith('- '))
        (kind: LegalKind.item, text: raw.substring(2).trim())
      else
        (kind: LegalKind.paragraph, text: raw.trim()),
];

void openLegal(BuildContext context, LegalDoc doc) =>
    Navigator.of(context)
        .push(FadeRoute(builder: (_) => LegalScreen(doc: doc)));

class LegalScreen extends StatelessWidget {
  const LegalScreen({super.key, required this.doc});
  final LegalDoc doc;

  @override
  Widget build(BuildContext context) {
    final blocks = parseLegal(doc.text);
    return Scaffold(
      backgroundColor: PColors.ground,
      body: SafeArea(
        child: ListView(
          primary: false,
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
            SurfaceCard(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [for (final b in blocks) _block(b)],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _block(LegalBlock b) => switch (b.kind) {
    LegalKind.title => Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Text(b.text, style: PType.h1()),
    ),
    LegalKind.heading => Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 6),
      child: Text(b.text, style: PType.h3()),
    ),
    LegalKind.item => Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 8, right: 10),
            child: Container(
              width: 5,
              height: 5,
              decoration: BoxDecoration(
                color: PColors.accentInk,
                shape: BoxShape.circle,
              ),
            ),
          ),
          Expanded(
            child: Text(b.text, style: PType.small(color: PColors.ink)),
          ),
        ],
      ),
    ),
    LegalKind.paragraph => Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(b.text, style: PType.small(color: PColors.ink)),
    ),
  };
}

/// "By creating an account you agree to the Terms of use and the Privacy
/// policy", both opening in the app. Under every Create account button.
class AgreeLine extends StatelessWidget {
  const AgreeLine({super.key});

  @override
  Widget build(BuildContext context) {
    Widget link(LegalDoc d) => Pressable(
      onTap: () => openLegal(context, d),
      label: d.title,
      radius: 12,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 6),
        child: Text(
          d.title,
          style: PType.meta(color: PColors.accentInk)
              .copyWith(fontWeight: FontWeight.w700),
        ),
      ),
    );
    final style = PType.meta();
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Wrap(
        alignment: WrapAlignment.center,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text('By creating an account you agree to the ', style: style),
          link(LegalDoc.terms),
          Text(' and the ', style: style),
          link(LegalDoc.privacy),
          Text('.', style: style),
        ],
      ),
    );
  }
}
