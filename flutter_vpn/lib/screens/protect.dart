import 'package:flutter/material.dart';

import '../api/countries.dart';
import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/protect.dart';
import 'google_location.dart';
import 'privacy_check.dart';
import 'shell.dart';

/// Protect keeps what guards the person, and only that: Always protected
/// (Android's always-on VPN and lockdown), the Shield, the privacy check,
/// Google location, and the local network. How Pleat connects (goal,
/// country, split route, smart connect) lives in Home > Route.
class ProtectScreen extends StatelessWidget {
  const ProtectScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    var i = 0;
    Widget item(Widget w) => StaggerIn(index: i++, child: w);
    return SafeArea(
      bottom: false,
      child: ParallaxScroll(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 140),
          children: [
            Text('Protect', style: PType.h1()),
            const SizedBox(height: 4),
            Text(_summary(app), style: PType.small()),
            const SizedBox(height: 20),
            item(_AlwaysCard(app: app)),
            const SizedBox(height: 16),
            item(_ShieldCard(app: app)),
            const SizedBox(height: 16),
            item(_PrivacyCard(app: app)),
            const SizedBox(height: 16),
            item(_GoogleCard(app: app)),
            const SizedBox(height: 16),
            item(_LocalCard(app: app)),
          ],
        ),
      ),
    );
  }

  String _summary(AppState app) {
    final p = app.exit?.protocol;
    return [
      app.tunnelAvailable == true
          ? 'All traffic and DNS through the exit'
          : 'Guards need the tunnel engine',
      ?p,
    ].join('  ·  ');
  }
}

// ---- shared pieces ---------------------------------------------------------

/// A round tile with an icon: navy when the feature is on.
class PTile extends StatelessWidget {
  const PTile(this.icon, {super.key, this.on = false, this.size = 40});
  final PIcon icon;
  final bool on;
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: on ? PColors.navy : PColors.mist,
      borderRadius: BorderRadius.circular(size * 0.35),
    ),
    alignment: Alignment.center,
    child: PIconView(
      icon,
      size: size * 0.5,
      color: on ? PColors.onDeep : PColors.accentInk,
    ),
  );
}

/// A card's head: tile, title, one line under it, and something at the end.
class PHead extends StatelessWidget {
  const PHead({
    super.key,
    required this.icon,
    required this.title,
    required this.sub,
    this.on = true,
    this.trailing,
  });
  final PIcon icon;
  final String title, sub;
  final bool on;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      PTile(icon, on: on),
      const SizedBox(width: 12),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: PType.h3().copyWith(fontSize: 16)),
            const SizedBox(height: 2),
            Text(sub, style: PType.meta(color: PColors.muted)),
          ],
        ),
      ),
      if (trailing != null) ...[const SizedBox(width: 8), trailing!],
    ],
  );
}

/// One line inside a card: a lead, two lines of text, and a trailing
/// widget (a chevron when it opens something).
class PLine extends StatelessWidget {
  const PLine({
    super.key,
    required this.lead,
    required this.title,
    required this.sub,
    this.trailing,
    this.onTap,
  });
  final Widget lead;
  final String title, sub;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Pressable(
    onTap: onTap,
    label: '$title. $sub',
    radius: 16,
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 2),
      child: Row(
        children: [
          lead,
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: PType.small(color: PColors.ink)
                      .copyWith(fontWeight: FontWeight.w700, fontSize: 14),
                ),
                const SizedBox(height: 1),
                Text(sub, style: PType.meta(color: PColors.muted)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          trailing ??
              (onTap == null
                  ? const SizedBox.shrink()
                  : PIconView(PIcon.chevron, size: 16, color: PColors.muted)),
        ],
      ),
    ),
  );
}

Widget pRule() => Divider(height: 10, thickness: 1, color: PColors.mist);

/// A small round mark: a check when it passed, "!" when it didn't.
class MarkDot extends StatelessWidget {
  const MarkDot(this.mark, {super.key});
  final Mark mark;

  @override
  Widget build(BuildContext context) {
    final c = switch (mark) {
      Mark.ok => PColors.safe,
      Mark.warn => PColors.alert,
      Mark.note => PColors.accentInk,
      Mark.none => PColors.muted,
    };
    return Container(
      width: 26,
      height: 26,
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.14),
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: PIconView(
        mark == Mark.ok ? PIcon.check : PIcon.info,
        size: 14,
        color: c,
      ),
    );
  }
}

/// A country's flag, as a small glyph.
Widget flagGlyph(String cc, {double size = 18}) => Text(
  flagOf(cc),
  textScaler: TextScaler.noScaling,
  style: TextStyle(
    fontSize: size,
    height: 1,
    fontFamilyFallback: PType.emojiFallback,
  ),
);

String agoText(DateTime at) {
  final d = DateTime.now().difference(at);
  if (d.inMinutes < 1) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes} min ago';
  if (d.inHours < 24) return '${d.inHours} h ago';
  return '${d.inDays} d ago';
}

// ---- Always protected ------------------------------------------------------

/// Android's always-on VPN (start with the phone) and its lockdown (the
/// kill switch). Only Android can set them, so both open its VPN page.
/// "Stay running" asks Android not to close Pleat to save battery; on a
/// Xiaomi, Autostart and a lock in Recents keep its cleaner off Pleat too.
class _AlwaysCard extends StatelessWidget {
  const _AlwaysCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final engine = app.tunnelAvailable == true;
    final g = app.guard;
    final open = engine ? app.tunnel.openSystemSettings : null;
    final keep = app.keep;
    // on: a switch's state; null: a page to open (no state Android tells)
    Widget row(
      PIcon icon,
      String title,
      String sub,
      bool? on, {
      VoidCallback? tap,
      String where = 'Android VPN settings',
    }) => Pressable(
      onTap: tap ?? open,
      label: '$title, opens $where',
      radius: 16,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: [
            PIconView(icon, size: 20, color: PColors.onDeep),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: PType.small(color: PColors.onDeep)
                        .copyWith(fontWeight: FontWeight.w700, fontSize: 14),
                  ),
                  Text(
                    sub,
                    style: PType.meta(
                      color: PColors.onDeep.withValues(alpha: 0.72),
                    ),
                  ),
                ],
              ),
            ),
            if (on != null)
              PToggle(
                value: on,
                onChanged: engine ? (_) => (tap ?? open)!() : null,
                label: title,
                onDark: true,
              )
            else
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: PIconView(
                  PIcon.chevron,
                  size: 18,
                  color: PColors.onDeep.withValues(alpha: 0.72),
                ),
              ),
          ],
        ),
      ),
    );
    final d = PMotion.reduced(context) ? Duration.zero : PMotion.scene;
    return ClipRRect(
      borderRadius: BorderRadius.circular(PRadius.card),
      child: ColoredBox(
        color: PColors.navy,
        child: Stack(
          children: [
            AnimatedPositioned(
              duration: d,
              right: -40,
              top: -66,
              child: ShardChip(color: PColors.blue, width: 90, height: 150),
            ),
            AnimatedPositioned(
              duration: d,
              right: 90,
              top: -50,
              child: ShardChip(color: PColors.ice, width: 30, height: 110),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 22, 14, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      color: PColors.onDeep.withValues(alpha: 0.12),
                      shape: BoxShape.circle,
                    ),
                    alignment: Alignment.center,
                    child: PIconView(
                      PIcon.lock,
                      size: 22,
                      color: PColors.onDeep,
                    ),
                  ),
                  const SizedBox(height: 28),
                  Text(
                    'Always protected',
                    style: PType.h1(color: PColors.onDeep),
                  ),
                  const SizedBox(height: 6),
                  UnavailableNote(
                    !engine
                        ? 'Not in this build. It needs the tunnel engine.'
                        : g == null
                        ? 'Android shows these while Pleat is connected. Tap to open its VPN page.'
                        : 'Android keeps Pleat on. Nothing leaves your phone outside the tunnel.',
                    onDark: true,
                  ),
                  const SizedBox(height: 8),
                  Divider(
                    height: 1,
                    color: PColors.onDeep.withValues(alpha: 0.12),
                  ),
                  row(
                    PIcon.shield,
                    'Kill switch',
                    g?.lockdown == true
                        ? 'If the tunnel drops, traffic stops'
                        : 'Off: turn on “Block connections without VPN”',
                    g?.lockdown ?? false,
                  ),
                  Divider(
                    height: 1,
                    color: PColors.onDeep.withValues(alpha: 0.12),
                  ),
                  row(
                    PIcon.power,
                    'Start with the phone',
                    g?.alwaysOn == true
                        ? 'Connects after a restart, before any app'
                        : 'Off: turn on “Always-on VPN”',
                    g?.alwaysOn ?? false,
                  ),
                  if (keep != null) ...[
                    Divider(
                      height: 1,
                      color: PColors.onDeep.withValues(alpha: 0.12),
                    ),
                    row(
                      PIcon.bolt,
                      'Stay running',
                      keep.exempt
                          ? 'No battery limits: Android leaves Pleat on'
                          : 'Off: Android may close Pleat to save battery',
                      keep.exempt,
                      tap: app.tunnel.askBatteryExempt,
                      where: 'Android battery settings',
                    ),
                  ],
                  if (keep?.xiaomi == true) ...[
                    Divider(
                      height: 1,
                      color: PColors.onDeep.withValues(alpha: 0.12),
                    ),
                    row(
                      PIcon.lock,
                      'Autostart and Recents lock',
                      'Turn on Autostart, then lock Pleat in Recents so “Clear all” leaves it',
                      null,
                      tap: app.tunnel.openAutostart,
                      where: 'Xiaomi Autostart settings',
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---- Shield ---------------------------------------------------------------

class _ShieldCard extends StatelessWidget {
  const _ShieldCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final engine = app.tunnelAvailable == true;
    final level = app.shieldLevel;
    final d = PMotion.reduced(context) ? Duration.zero : PMotion.state;
    const levels = [
      ('Off', 'Nothing blocked'),
      ('Safe', 'Malware, phishing'),
      ('Clean', 'Safe + ads, trackers'),
    ];
    final chips = [
      (PIcon.close, 'Malware', 1),
      (PIcon.lock, 'Phishing', 1),
      (PIcon.filter, 'Ads', 2),
      (PIcon.user, 'Trackers', 2),
    ];
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(16, 16, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const PHead(
            icon: PIcon.shield,
            title: 'Shield',
            sub: 'Blocks bad sites before they load. Ads never download, so they cost no plan data.',
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              for (final (n, (title, sub)) in levels.indexed) ...[
                if (n > 0) const SizedBox(width: 8),
                Expanded(
                  child: Pressable(
                    onTap: engine ? () => app.setShield(n) : null,
                    label: 'Shield $title: $sub',
                    selected: n == level,
                    radius: 18,
                    color: n == level ? PColors.navy : PColors.field,
                    child: AnimatedContainer(
                      duration: d,
                      padding: const EdgeInsets.fromLTRB(10, 10, 8, 11),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            title,
                            style: PType.small(
                              color: n == level ? PColors.onDeep : PColors.ink,
                            ).copyWith(fontWeight: FontWeight.w700),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            sub,
                            style: PType.meta(
                              color: n == level
                                  ? PColors.onDeep.withValues(alpha: 0.72)
                                  : PColors.muted,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final (icon, name, need) in chips)
                _Chip(icon: icon, text: name, on: level >= need),
            ],
          ),
          const SizedBox(height: 6),
          pRule(),
          PLine(
            lead: PTile(PIcon.user, size: 36),
            title: 'Adult sites',
            sub: 'Block them too, for a child’s phone',
            trailing: PToggle(
              value: app.blockAdult,
              onChanged: engine ? app.setBlockAdult : null,
              label: 'Block adult sites',
            ),
          ),
          if (!engine)
            Padding(
              padding: const EdgeInsets.fromLTRB(2, 4, 4, 6),
              child: UnavailableNote(
                'Needs the tunnel engine. Not in this build.',
              ),
            )
          else if (!app.geoAvailable && (level >= 2 || app.blockAdult))
            Padding(
              padding: const EdgeInsets.fromLTRB(2, 4, 4, 6),
              child: UnavailableNote(
                'Ad and adult lists need the place lists, missing in this build. Malware is still blocked.',
              ),
            ),
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.icon, required this.text, required this.on});
  final PIcon icon;
  final String text;
  final bool on;

  @override
  Widget build(BuildContext context) => Container(
    height: 28,
    padding: const EdgeInsets.symmetric(horizontal: 9),
    decoration: BoxDecoration(
      color: on ? PColors.mist : PColors.field,
      borderRadius: BorderRadius.circular(PRadius.pill),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        PIconView(
          icon,
          size: 13,
          color: on ? PColors.accentInk : PColors.muted,
        ),
        const SizedBox(width: 5),
        Text(
          text,
          style: PType.meta(color: on ? PColors.accentInk : PColors.muted)
              .copyWith(fontWeight: FontWeight.w700),
        ),
      ],
    ),
  );
}

// ---- Privacy check ----------------------------------------------------------

class _PrivacyCard extends StatelessWidget {
  const _PrivacyCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final r = app.leakReport;
    final can = app.phase == Phase.protected && app.tunnelAvailable == true;
    void open() => Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => PrivacyCheckScreen(app: app)),
    );
    final site = r?.siteCc;
    final g = r?.googleCc;
    Mark of(Iterable<String> titles) {
      final rows = r!.rows.where((x) => titles.contains(x.title));
      if (rows.any((x) => x.verdict == Mark.warn)) return Mark.warn;
      if (rows.any((x) => x.verdict == Mark.ok)) return Mark.ok;
      return Mark.none;
    }

    return SurfaceCard(
      onTap: r == null ? null : open,
      label: 'Privacy check',
      padding: const EdgeInsets.fromLTRB(16, 16, 12, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          PHead(
            icon: PIcon.search,
            title: 'Privacy check',
            sub: r == null
                ? 'Leak tests, the way sites and Google see you'
                : '${r.tests} leak tests, the way sites and Google see you',
            trailing: r == null
                ? null
                : _Pill(
                    r.warnings == 0
                        ? 'ALL CLEAR'
                        : '${r.warnings} ${r.warnings == 1 ? 'WARNING' : 'WARNINGS'}',
                    good: r.warnings == 0,
                  ),
          ),
          if (r != null) ...[
            const SizedBox(height: 6),
            pRule(),
            PLine(
              lead: site == null
                  ? PTile(PIcon.globe, size: 36)
                  : SizedBox(
                      width: 36,
                      child: Center(child: flagGlyph(site, size: 26)),
                    ),
              title: site == null
                  ? 'Sites didn’t answer'
                  : 'Sites see ${countryName(site)}',
              sub:
                  'Your Iran IP is ${of(['Your Iran IP']) == Mark.warn ? 'visible' : 'not visible'}',
              trailing: MarkDot(of(['Cloudflare', 'Your Iran IP'])),
            ),
            PLine(
              lead: PTile(PIcon.dns, size: 36),
              title: 'DNS goes through the tunnel',
              sub: 'Your operator can’t see the sites you open',
              trailing: MarkDot(
                of(['Resolver that answered', 'Operator’s DNS']),
              ),
            ),
            PLine(
              lead: PTile(PIcon.layers, size: 36),
              title: 'IPv6 and WebRTC sealed',
              sub: 'Nothing slips out around the tunnel',
              trailing: MarkDot(of(['IPv6', 'WebRTC · STUN (UDP)'])),
            ),
            PLine(
              lead: PTile(PIcon.globe, size: 36),
              title: g == null
                  ? 'Google didn’t say'
                  : 'Google sees ${countryName(g)}',
              sub: 'YouTube, Gemini and Search',
              trailing: MarkDot(
                of(['Google · YouTube', 'Google · Gemini', 'Google Search']),
              ),
            ),
          ],
          const SizedBox(height: 10),
          PillButton(
            label: app.leakRunning
                ? 'Testing…'
                : (r == null ? 'Run check' : 'Run again'),
            icon: PIcon.refresh,
            height: 48,
            color: r == null ? PColors.blue : PColors.field,
            textColor: r == null ? PColors.onAccent : PColors.accentInk,
            onTap: can && !app.leakRunning
                ? () async {
                    final done = await app.runLeakCheck();
                    if (done != null && context.mounted) open();
                  }
                : null,
          ),
          const SizedBox(height: 8),
          Center(
            child: Text(
              !can
                  ? 'Connect first: it tests the exit you are on.'
                  : r == null
                  ? 'About 20 seconds and 3 MB, through the exit.'
                  : 'Checked ${agoText(r.at)}${r.ctx.network.isEmpty ? '' : ' on ${r.ctx.network}'}',
              style: PType.meta(color: PColors.muted),
              textAlign: TextAlign.center,
            ),
          ),
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill(this.text, {required this.good});
  final String text;
  final bool good;

  @override
  Widget build(BuildContext context) {
    final c = good ? PColors.safe : PColors.alert;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: c.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(PRadius.pill),
      ),
      child: Text(
        text,
        style: PType.meta(color: c)
            .copyWith(fontWeight: FontWeight.w800, letterSpacing: 0.6),
      ),
    );
  }
}

// ---- Google location ------------------------------------------------------

class _GoogleCard extends StatelessWidget {
  const _GoogleCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final n = app.googleCounts;
    final e = app.exit;
    final g = e == null ? null : app.googleOf(e);
    void open() => Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => GoogleLocationScreen(app: app)),
    );
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(16, 16, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const PHead(
            icon: PIcon.globe,
            title: 'Google location',
            sub: 'Some exits look abroad to every site, but Google still sees Iran. Pleat tests each exit the way Google does.',
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              GoogleStat(n.abroad, 'Google sees abroad', tone: PColors.safe),
              const SizedBox(width: 8),
              GoogleStat(n.iran, 'Google sees Iran', tone: PColors.alert),
              const SizedBox(width: 8),
              GoogleStat(n.unknown, 'Not tested yet', tone: PColors.muted),
            ],
          ),
          const SizedBox(height: 6),
          if (e != null) ...[
            pRule(),
            PLine(
              lead: RegionBadge(e, size: 36),
              title: 'You’re on ${e.label}',
              sub: g == null
                  ? (app.googleTesting == e.id
                        ? 'Testing what Google sees…'
                        : 'Not tested yet')
                  : 'Sites see ${e.title} · Google sees ${g.cc == null ? 'unclear' : countryName(g.cc!)}',
              trailing: g == null
                  ? null
                  : MarkDot(
                      g.iran ? Mark.warn : (g.cc == null ? Mark.none : Mark.ok),
                    ),
            ),
          ],
          pRule(),
          PLine(
            lead: PTile(PIcon.shield, size: 36, on: app.googleClean),
            title: 'Google-clean exits only',
            sub: 'Connect and switch only to exits Google sees abroad',
            trailing: PToggle(
              value: app.googleClean,
              onChanged: app.setGoogleClean,
              label: 'Google-clean exits only',
            ),
          ),
          PLine(
            lead: PTile(PIcon.route, size: 36),
            title: 'See every exit',
            sub: 'Results shared by Pleat users',
            onTap: open,
          ),
        ],
      ),
    );
  }
}

/// A count tile: green for abroad, red for Iran, grey for untested.
class GoogleStat extends StatelessWidget {
  const GoogleStat(this.n, this.text, {super.key, required this.tone});
  final int n;
  final String text;
  final Color tone;

  @override
  Widget build(BuildContext context) => Expanded(
    child: Container(
      padding: const EdgeInsets.fromLTRB(10, 10, 8, 11),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('$n', style: PType.h2(color: tone)),
          const SizedBox(height: 2),
          Text(
            text,
            style: PType.meta(color: tone)
                .copyWith(fontWeight: FontWeight.w700),
          ),
        ],
      ),
    ),
  );
}

// ---- Local network ---------------------------------------------------------

class _LocalCard extends StatelessWidget {
  const _LocalCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final engine = app.tunnelAvailable == true;
    return SurfaceCard(
      label: 'Local network, always on',
      padding: const EdgeInsets.fromLTRB(16, 14, 14, 14),
      child: PHead(
        icon: PIcon.lan,
        on: false,
        title: 'Local network',
        sub: engine
            ? 'Printers and routers stay reachable'
            : 'Needs the tunnel engine. Not in this build.',
        trailing: engine ? const MarkDot(Mark.ok) : null,
      ),
    );
  }
}
