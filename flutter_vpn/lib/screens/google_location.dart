import 'package:flutter/material.dart';

import '../api/countries.dart';
import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/exits.dart';
import '../state/protect.dart';
import 'protect.dart';

/// Protect > Google location > every exit: where sites put it, where
/// Google puts it, and who tested it. Exits Google places in Iran come
/// first, since Google-clean exits only skips them.
class GoogleLocationScreen extends StatelessWidget {
  const GoogleLocationScreen({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: PColors.ground,
      body: SafeArea(
        child: ListenableBuilder(
          listenable: app,
          builder: (context, _) {
            final n = app.googleCounts;
            final iran = <Exit>[], abroad = <Exit>[], unknown = <Exit>[];
            for (final e in app.ranked) {
              final g = app.googleOf(e);
              if (g == null || (g.cc == null && !g.iran)) {
                unknown.add(e);
              } else if (g.iran) {
                iran.add(e);
              } else {
                abroad.add(e);
              }
            }
            final engine = app.tunnelAvailable == true;
            return ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 40),
              children: [
                Row(
                  children: [
                    RoundIcon(
                      PIcon.back,
                      label: 'Back',
                      onTap: () => Navigator.of(context).pop(),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                Text('Google location', style: PType.small()),
                const SizedBox(height: 4),
                Text(
                  '${n.abroad} of ${app.exits.length}',
                  style: PType.display(52),
                ),
                const SizedBox(height: 6),
                Text(
                  'exits Google sees abroad${n.unknown > 0 ? ' · ${n.unknown} not tested yet' : ''}',
                  style: PType.small(),
                ),
                const SizedBox(height: 16),
                SurfaceCard(
                  padding: const EdgeInsets.fromLTRB(16, 14, 12, 14),
                  child: PHead(
                    icon: PIcon.shield,
                    on: app.googleClean,
                    title: 'Google-clean exits only',
                    sub: iran.isEmpty
                        ? 'Smart connect and switching skip exits Google places in Iran.'
                        : 'Smart connect and switching skip the ${iran.length == 1 ? 'exit' : '${iran.length} exits'} below. Stay in one country still decides the country.',
                    trailing: PToggle(
                      value: app.googleClean,
                      onChanged: app.setGoogleClean,
                      label: 'Google-clean exits only',
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                PillButton(
                  label: app.googleRunning
                      ? 'Testing ${_name(app)}…'
                      : (n.unknown > 0 ? 'Test untested exits' : 'Test again'),
                  icon: PIcon.refresh,
                  height: 48,
                  color: PColors.field,
                  textColor: PColors.accentInk,
                  onTap: !engine || app.googleRunning
                      ? null
                      : () => app.testGoogleAll(all: n.unknown == 0),
                ),
                const SizedBox(height: 6),
                Center(
                  child: Text(
                    engine
                        ? 'About 1 MB per exit, one at a time.'
                        : 'Needs the tunnel engine. Not in this build.',
                    style: PType.meta(color: PColors.muted),
                  ),
                ),
                if (iran.isNotEmpty)
                  _Group(
                    title: app.googleClean
                        ? 'GOOGLE SEES IRAN · SKIPPED'
                        : 'GOOGLE SEES IRAN',
                    exits: iran,
                    app: app,
                  ),
                if (abroad.isNotEmpty)
                  _Group(title: 'GOOGLE SEES ABROAD', exits: abroad, app: app),
                if (unknown.isNotEmpty)
                  _Group(title: 'NOT TESTED YET', exits: unknown, app: app),
                const SizedBox(height: 16),
                SurfaceCard(
                  padding: const EdgeInsets.fromLTRB(16, 14, 14, 14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const PHead(
                        icon: PIcon.pin,
                        on: false,
                        title: 'Why an exit turns Iranian',
                        sub: 'Google moves an address to the country its phones report. When many phones in Iran share one exit, Google starts calling it Iran. Turning off Google Location Accuracy stops your phone adding to it.',
                      ),
                      const SizedBox(height: 12),
                      PillButton(
                        label: 'Open location settings',
                        height: 46,
                        color: PColors.field,
                        textColor: PColors.accentInk,
                        onTap: engine ? app.tunnel.openLocationSettings : null,
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: Text(
                    'Each exit is tested through a throw-away core with YouTube, Gemini and Search. Results are shared by exit with other Pleat users, never with your account.',
                    style: PType.meta(color: PColors.muted),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  static String _name(AppState app) {
    final id = app.googleTesting;
    if (id == null) return '';
    for (final e in app.exits) {
      if (e.id == id) return e.label;
    }
    return '';
  }
}

class _Group extends StatelessWidget {
  const _Group({required this.title, required this.exits, required this.app});
  final String title;
  final List<Exit> exits;
  final AppState app;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(4, 20, 4, 8),
        child: Text(
          title,
          style: PType.meta(color: PColors.muted)
              .copyWith(fontWeight: FontWeight.w800, letterSpacing: 1.2),
        ),
      ),
      SurfaceCard(
        padding: const EdgeInsets.fromLTRB(14, 6, 12, 6),
        child: Column(
          children: [
            for (final (i, e) in exits.indexed) ...[
              if (i > 0) pRule(),
              _ExitRow(e: e, app: app),
            ],
          ],
        ),
      ),
    ],
  );
}

class _ExitRow extends StatelessWidget {
  const _ExitRow({required this.e, required this.app});
  final Exit e;
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final g = app.googleOf(e);
    final testing = app.googleTesting == e.id;
    final google = g?.cc == null
        ? (g?.iran == true ? 'Iran' : null)
        : countryName(g!.cc!);
    final who = g == null
        ? (testing ? 'Testing now…' : 'Tap to test')
        : g.mine
        ? 'Tested here ${agoText(g.at)}'
        : 'Tested by ${g.people} Pleat ${g.people == 1 ? 'user' : 'users'} · ${agoText(g.at)}';
    final mark = g == null
        ? Mark.none
        : (g.iran ? Mark.warn : (g.cc == null ? Mark.none : Mark.ok));
    return Pressable(
      onTap: app.googleTesting == null && app.tunnelAvailable == true
          ? () => app.testGoogle(e)
          : null,
      label: '${e.label}. Google: ${google ?? 'not known'}. $who',
      radius: 14,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: [
            RegionBadge(e, size: 34),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    e.label,
                    style: PType.small(color: PColors.ink)
                        .copyWith(fontWeight: FontWeight.w700, fontSize: 14),
                  ),
                  const SizedBox(height: 1),
                  Text.rich(
                    TextSpan(
                      style: PType.meta(color: PColors.muted),
                      children: [
                        TextSpan(text: 'Sites: ${e.title} · Google: '),
                        TextSpan(
                          text: google ?? '?',
                          style: TextStyle(
                            fontWeight: FontWeight.w800,
                            color: mark == Mark.warn
                                ? PColors.alert
                                : (mark == Mark.ok
                                      ? PColors.safe
                                      : PColors.muted),
                          ),
                        ),
                        TextSpan(text: '\n$who'),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            if (testing)
              const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            else
              MarkDot(mark),
          ],
        ),
      ),
    );
  }
}
