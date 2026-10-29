import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'shell.dart';

/// Protect is a control surface. The kill switch is the big favourite
/// card; split tunnel and DNS are spatial cards. Those guards live in the
/// platform tunnel, not the backend, so each says plainly when this build
/// can't run it. Protocol is real: it comes from the server list.
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
            item(_KillSwitchCard(app: app)),
            const SizedBox(height: 16),
            item(const _SplitTunnelCard()),
            const SizedBox(height: 16),
            item(_DnsCard(engine: app.tunnelAvailable == true)),
            const SizedBox(height: 16),
            item(_ProtocolCard(app: app)),
            const SizedBox(height: 16),
            item(_AutoConnectCard(app: app)),
            const SizedBox(height: 16),
            item(
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: const _MiniCard(
                      icon: PIcon.filter,
                      title: 'Threat filter',
                      body: 'No filter on the server. Not in this build.',
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Transform.translate(
                      offset: const Offset(0, 22),
                      child: _MiniCard(
                        icon: PIcon.lan,
                        title: 'Local network',
                        body: app.tunnelAvailable == true
                            ? 'Private addresses stay on your network. Fixed.'
                            : 'Needs the tunnel engine. Not in this build.',
                      ),
                    ),
                  ),
                ],
              ),
            ),
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

class _KillSwitchCard extends StatelessWidget {
  const _KillSwitchCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    // Android's kill switch is always-on VPN with "Block connections
    // without VPN". Only Android can set it, so the card opens that page.
    final engine = app.tunnelAvailable == true;
    return Pressable(
      onTap: engine ? app.tunnel.openSystemSettings : null,
      label: engine
          ? 'Kill switch, opens Android VPN settings'
          : 'Kill switch, unavailable in this build',
      radius: PRadius.card,
      shadow: true,
      color: PColors.navy,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(PRadius.card),
        child: SizedBox(
          height: 214,
          child: Stack(
            children: [
              // The card's own shards flip with the field.
              AnimatedPositioned(
                duration: PMotion.reduced(context)
                    ? Duration.zero
                    : PMotion.scene,
                curve: Curves.easeInOutCubic,
                right: -40,
                top: -66,
                child: const ShardChip(
                  color: PColors.blue,
                  width: 90,
                  height: 190,
                ),
              ),
              AnimatedPositioned(
                duration: PMotion.reduced(context)
                    ? Duration.zero
                    : PMotion.scene,
                curve: Curves.easeInOutCubic,
                right: 96,
                top: -44,
                child: const ShardChip(
                  color: PColors.ice,
                  width: 34,
                  height: 150,
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 22, 16, 18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 44,
                          height: 44,
                          decoration: BoxDecoration(
                            color: Colors.white.withValues(alpha: 0.12),
                            shape: BoxShape.circle,
                          ),
                          alignment: Alignment.center,
                          child: const PIconView(
                            PIcon.lock,
                            size: 22,
                            color: Colors.white,
                          ),
                        ),
                        const Spacer(),
                        const PToggle(
                          value: false,
                          onChanged: null,
                          label: 'Kill switch',
                          onDark: true,
                        ),
                      ],
                    ),
                    const Spacer(),
                    Text('Kill switch', style: PType.h1(color: Colors.white)),
                    const SizedBox(height: 6),
                    UnavailableNote(
                      engine
                          ? 'Android runs it. Tap, then turn on Always-on VPN and Block connections without VPN for Pleat.'
                          : 'Not in this build. It is Android’s always-on VPN with lockdown, and it needs the tunnel engine.',
                      onDark: true,
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

/// Split tunnel: the card keeps its place, but there is no app list to
/// move until a tunnel engine can route apps.
class _SplitTunnelCard extends StatelessWidget {
  const _SplitTunnelCard();

  @override
  Widget build(BuildContext context) {
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const PIconView(PIcon.split, color: PColors.muted),
              const SizedBox(width: 10),
              Expanded(child: Text('Split tunnel', style: PType.h3())),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              for (final (title, color, ink) in const [
                ('Through tunnel', PColors.mist, PColors.navy),
                ('Direct', PColors.field, PColors.muted),
              ])
                Expanded(
                  child: Container(
                    margin: EdgeInsets.only(right: title == 'Direct' ? 0 : 10),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: color,
                      borderRadius: BorderRadius.circular(22),
                    ),
                    child: Text(title, style: PType.meta(color: ink)),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 12),
          const UnavailableNote(
            'Needs the tunnel engine to route apps. Not in this build.',
          ),
        ],
      ),
    );
  }
}

/// DNS: the server sets no resolver to choose. With the engine, every
/// lookup goes through the exit.
class _DnsCard extends StatelessWidget {
  const _DnsCard({required this.engine});
  final bool engine;

  @override
  Widget build(BuildContext context) {
    return SurfaceCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const PIconView(PIcon.dns, color: PColors.muted),
              const SizedBox(width: 10),
              Expanded(child: Text('Private DNS', style: PType.h3())),
            ],
          ),
          const SizedBox(height: 12),
          UnavailableNote(
            engine
                ? 'Every lookup goes through the exit to 1.1.1.1. The server offers no other resolver to pick.'
                : 'The server doesn’t choose a resolver, and this build has no tunnel engine to set one.',
          ),
        ],
      ),
    );
  }
}

class _ProtocolCard extends StatelessWidget {
  const _ProtocolCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final protocols = app.protocols;
    final current = app.exit?.protocol;
    final i = current == null ? 0 : protocols.indexOf(current);
    final d = PMotion.reduced(context) ? Duration.zero : PMotion.state;
    return SurfaceCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const PIconView(PIcon.layers, color: PColors.blue),
              const SizedBox(width: 10),
              Expanded(child: Text('Protocol', style: PType.h3())),
            ],
          ),
          const SizedBox(height: 14),
          if (protocols.isEmpty)
            Text(
              app.servers.loading
                  ? 'Loading your exits…'
                  : 'Protocols come from your exits. None yet.',
              style: PType.small(),
            )
          else
            Container(
              height: 52,
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                color: PColors.field,
                borderRadius: BorderRadius.circular(PRadius.pill),
              ),
              child: Stack(
                children: [
                  AnimatedAlign(
                    duration: d,
                    curve: Curves.easeOutBack,
                    alignment: Alignment(
                      protocols.length == 1
                          ? 0
                          : -1 + i * 2 / (protocols.length - 1),
                      0,
                    ),
                    child: FractionallySizedBox(
                      widthFactor: 1 / protocols.length,
                      child: Container(
                        decoration: BoxDecoration(
                          color: PColors.blue,
                          borderRadius: BorderRadius.circular(PRadius.pill),
                          boxShadow: PShadow.lift,
                        ),
                      ),
                    ),
                  ),
                  Row(
                    children: [
                      for (final p in protocols)
                        Expanded(
                          child: Semantics(
                            button: true,
                            selected: p == current,
                            label: p,
                            child: GestureDetector(
                              behavior: HitTestBehavior.opaque,
                              onTap: () => app.chooseProtocol(p),
                              child: Center(
                                child: Text(
                                  p,
                                  style: PType.small(
                                    color: p == current
                                        ? Colors.white
                                        : PColors.ink,
                                  ).copyWith(fontWeight: FontWeight.w700),
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          const SizedBox(height: 10),
          Text(
            'Each exit speaks one protocol. Picking one selects the best-rated exit that uses it.',
            style: PType.small(),
          ),
        ],
      ),
    );
  }
}

class _AutoConnectCard extends StatelessWidget {
  const _AutoConnectCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final engine = app.tunnelAvailable == true;
    return SurfaceCard(
      onTap: engine ? app.tunnel.openSystemSettings : null,
      label: engine ? 'Auto-connect, opens Android VPN settings' : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const PIconView(PIcon.wifi, color: PColors.muted),
              const SizedBox(width: 10),
              Expanded(child: Text('Auto-connect', style: PType.h3())),
              const PToggle(
                value: false,
                onChanged: null,
                label: 'Auto-connect',
              ),
            ],
          ),
          const SizedBox(height: 6),
          UnavailableNote(
            engine
                ? 'Android starts Pleat on boot and reconnects when Always-on VPN is on. Tap to open it.'
                : 'Starts the tunnel engine on boot. Not in this build.',
          ),
        ],
      ),
    );
  }
}

class _MiniCard extends StatelessWidget {
  const _MiniCard({
    required this.icon,
    required this.title,
    required this.body,
  });

  final PIcon icon;
  final String title, body;

  @override
  Widget build(BuildContext context) {
    return SurfaceCard(
      label: '$title, unavailable',
      padding: const EdgeInsets.fromLTRB(18, 16, 10, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              PIconView(icon, color: PColors.muted),
              const Spacer(),
              PToggle(value: false, onChanged: null, label: title),
            ],
          ),
          const SizedBox(height: 10),
          Text(title, style: PType.h3()),
          const SizedBox(height: 4),
          SizedBox(height: 54, child: UnavailableNote(body)),
        ],
      ),
    );
  }
}
