import 'package:flutter/material.dart';

import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/protect.dart';
import 'protect.dart';

/// Protect > Privacy check, every test: what sites and Google see, DNS,
/// what could slip around the tunnel, and what the phone itself tells
/// Google. Each row says what was found, never an address.
class PrivacyCheckScreen extends StatelessWidget {
  const PrivacyCheckScreen({super.key, required this.app});
  final AppState app;

  static PIcon _icon(String name) => switch (name) {
    'globe' => PIcon.globe,
    'search' => PIcon.search,
    'filter' => PIcon.filter,
    'device' => PIcon.device,
    'user' => PIcon.user,
    'dns' => PIcon.dns,
    'layers' => PIcon.layers,
    'pulse' => PIcon.pulse,
    'lock' => PIcon.lock,
    'split' => PIcon.split,
    'pin' => PIcon.pin,
    'clock' => PIcon.clock,
    _ => PIcon.info,
  };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: PColors.ground,
      body: SafeArea(
        child: ListenableBuilder(
          listenable: app,
          builder: (context, _) {
            final r = app.leakReport;
            final can =
                app.phase == Phase.protected && app.tunnelAvailable == true;
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
                Text(
                  r == null
                      ? 'Privacy check'
                      : 'Privacy check · ${r.ctx.exitLabel}${r.ctx.network.isEmpty ? '' : ' · ${r.ctx.network}'}',
                  style: PType.small(),
                ),
                const SizedBox(height: 4),
                Text(
                  r == null
                      ? 'Not run yet'
                      : r.warnings == 0
                      ? 'No leaks'
                      : '${r.warnings} ${r.warnings == 1 ? 'warning' : 'warnings'}',
                  style: PType.display(52),
                ),
                if (r != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    '${r.tests} tests · ${r.passed} passed'
                    '${r.notes > 0 ? ' · ${r.notes} ${r.notes == 1 ? 'note' : 'notes'}' : ''}'
                    ' · ${(r.took.inMilliseconds / 1000).toStringAsFixed(1)} s · ${agoText(r.at)}',
                    style: PType.small(),
                  ),
                  for (final g in r.groups) ...[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(4, 20, 4, 8),
                      child: Text(
                        g.title,
                        style: PType.meta(color: PColors.muted).copyWith(
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.2,
                        ),
                      ),
                    ),
                    SurfaceCard(
                      padding: const EdgeInsets.fromLTRB(14, 8, 12, 8),
                      child: Column(
                        children: [
                          for (final (i, row) in g.rows.indexed) ...[
                            if (i > 0) pRule(),
                            _Row(row: row, icon: _icon(row.icon), app: app),
                          ],
                        ],
                      ),
                    ),
                  ],
                ],
                const SizedBox(height: 14),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: Text(
                    'Every test goes through the exit, like an app’s traffic. Pleat sends no account, address or link to the test servers (Cloudflare, Google, ipinfo, ipwho.is).',
                    style: PType.meta(color: PColors.muted),
                  ),
                ),
                const SizedBox(height: 14),
                PillButton(
                  label: app.leakRunning ? 'Testing…' : 'Run again',
                  icon: PIcon.refresh,
                  onTap: can && !app.leakRunning ? app.runLeakCheck : null,
                ),
                if (!can)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Center(
                      child: Text(
                        'Connect first: it tests the exit you are on.',
                        style: PType.meta(color: PColors.muted),
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.row, required this.icon, required this.app});
  final LeakRow row;
  final PIcon icon;
  final AppState app;

  @override
  Widget build(BuildContext context) {
    // Rows the person can act on open the place to do it.
    final VoidCallback? fix = switch (row.title) {
      'Kill switch' when row.verdict == Mark.warn =>
        app.tunnel.openSystemSettings,
      'Location' when row.verdict == Mark.note =>
        app.tunnel.openLocationSettings,
      _ => null,
    };
    final valueColor = switch (row.verdict) {
      Mark.warn => PColors.alert,
      Mark.none => PColors.muted,
      _ => PColors.ink,
    };
    return Pressable(
      onTap: fix,
      label: '${row.title}: ${row.value}. ${row.sub}',
      radius: 14,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            PTile(icon, size: 34),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    row.title,
                    style: PType.small(color: PColors.ink)
                        .copyWith(fontWeight: FontWeight.w700, fontSize: 13.5),
                  ),
                  const SizedBox(height: 1),
                  Text(row.sub, style: PType.meta(color: PColors.muted)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            if (row.flag != null) ...[
              flagGlyph(row.flag!, size: 15),
              const SizedBox(width: 4),
            ],
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 96),
              child: Text(
                row.value,
                textAlign: TextAlign.end,
                style: PType.meta(color: valueColor)
                    .copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            if (row.verdict != Mark.none) ...[
              const SizedBox(width: 8),
              MarkDot(row.verdict),
            ],
          ],
        ),
      ),
    );
  }
}
