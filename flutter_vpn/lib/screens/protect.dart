import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'shell.dart';

/// Protect is a control surface. The kill switch is the big favourite
/// card; split tunnel and DNS are spatial cards. Every switch here does
/// what it shows: kill switch and auto-connect mirror Android's own
/// always-on flags (only Android can set them, so they open its page);
/// split tunnel and smart connect change how Pleat connects.
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
            item(_SplitTunnelCard(app: app)),
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
                    child: _MiniCard(
                      icon: PIcon.bolt,
                      title: 'Smart connect',
                      body: app.smartConnect
                          ? 'Tests every exit, takes the fastest, moves on if it stops.'
                          : 'Uses the exit you pick, and stays on it.',
                      value: app.smartConnect,
                      onChanged: app.tunnelAvailable == true
                          ? app.setSmartConnect
                          : null,
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
                            ? 'Printers and routers stay reachable. Always on.'
                            : 'Needs the tunnel engine. Not in this build.',
                        fixed: app.tunnelAvailable == true,
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
                child: ShardChip(color: PColors.blue, width: 90, height: 190),
              ),
              AnimatedPositioned(
                duration: PMotion.reduced(context)
                    ? Duration.zero
                    : PMotion.scene,
                curve: Curves.easeInOutCubic,
                right: 96,
                top: -44,
                child: ShardChip(color: PColors.ice, width: 34, height: 150),
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
                        const Spacer(),
                        PToggle(
                          value: app.guard?.lockdown ?? false,
                          onChanged: engine
                              ? (_) => app.tunnel.openSystemSettings()
                              : null,
                          label: 'Kill switch',
                          onDark: true,
                        ),
                      ],
                    ),
                    const Spacer(),
                    Text('Kill switch', style: PType.h1(color: PColors.onDeep)),
                    const SizedBox(height: 6),
                    UnavailableNote(
                      !engine
                          ? 'Not in this build. It is Android’s always-on VPN with lockdown, and it needs the tunnel engine.'
                          : switch (app.guard) {
                              (lockdown: true, alwaysOn: _) => 'On. Android blocks every connection that skips the tunnel.',
                              (alwaysOn: true, lockdown: false) => 'Always-on is set, lockdown is off. Tap to block traffic without the tunnel.',
                              _ when app.phase == Phase.protected => 'Off. Tap, then turn on Always-on VPN and Block connections without VPN.',
                              _ => 'Android runs it and shows its state while connected. Tap to open it.',
                            },
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

/// Split tunnel by place: Iranian sites and IPs leave directly, the rest
/// goes through the exit, and QUIC is refused so apps use steadier TCP.
/// The same rules the Cloud Gold app applies by default.
class _SplitTunnelCard extends StatelessWidget {
  const _SplitTunnelCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final can = app.tunnelAvailable == true && app.geoAvailable;
    final on = app.localDirect && can;
    final d = PMotion.reduced(context) ? Duration.zero : PMotion.state;
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(20, 20, 12, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              PIconView(
                PIcon.split,
                color: on ? PColors.accentInk : PColors.muted,
              ),
              const SizedBox(width: 10),
              Expanded(child: Text('Split tunnel', style: PType.h3())),
              PToggle(
                value: app.localDirect,
                onChanged: can ? app.setLocalDirect : null,
                label: 'Local sites direct',
              ),
            ],
          ),
          const SizedBox(height: 14),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Row(
              children: [
                for (final (title, sub, lit) in [
                  (
                    'Through tunnel',
                    on ? 'Everything else' : 'Everything',
                    true,
                  ),
                  ('Direct', on ? 'Iranian sites' : 'Nothing', on),
                ])
                  Expanded(
                    child: AnimatedContainer(
                      duration: d,
                      curve: Curves.easeOutCubic,
                      margin: EdgeInsets.only(
                        right: title == 'Direct' ? 0 : 10,
                      ),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: lit ? PColors.mist : PColors.field,
                        borderRadius: BorderRadius.circular(22),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            title,
                            style: PType.meta(
                              color: lit ? PColors.navy : PColors.muted,
                            ),
                          ),
                          const SizedBox(height: 2),
                          AnimatedSwitcher(
                            duration: d,
                            child: Text(
                              sub,
                              key: ValueKey(sub),
                              style: PType.small(),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: UnavailableNote(
              !can
                  ? 'Needs the tunnel engine and its place lists. Not in this build.'
                  : on
                  ? 'Iranian sites open fast and spend no plan data. QUIC is off, so apps use steadier TCP.'
                  : 'Every site goes through the exit.',
            ),
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
              PIconView(PIcon.dns, color: PColors.muted),
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
              PIconView(PIcon.layers, color: PColors.accentInk),
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
                                        ? PColors.onAccent
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
              PIconView(PIcon.wifi, color: PColors.muted),
              const SizedBox(width: 10),
              Expanded(child: Text('Auto-connect', style: PType.h3())),
              PToggle(
                value: app.guard?.alwaysOn ?? false,
                onChanged: engine
                    ? (_) => app.tunnel.openSystemSettings()
                    : null,
                label: 'Auto-connect',
              ),
            ],
          ),
          const SizedBox(height: 6),
          UnavailableNote(
            !engine
                ? 'Starts the tunnel engine on boot. Not in this build.'
                : app.guard?.alwaysOn == true
                ? 'On. Android starts Pleat on boot and reconnects to your last exit.'
                : 'Android starts Pleat on boot when Always-on VPN is on. Tap to open it.',
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
    this.value = false,
    this.onChanged,
    this.fixed = false,
  });

  final PIcon icon;
  final String title, body;
  final bool value;
  final ValueChanged<bool>? onChanged;

  /// Always on and not a choice: a check instead of a switch.
  final bool fixed;

  @override
  Widget build(BuildContext context) {
    final live = fixed || (value && onChanged != null);
    return SurfaceCard(
      label: fixed ? '$title, always on' : null,
      padding: const EdgeInsets.fromLTRB(18, 16, 10, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              PIconView(icon, color: live ? PColors.accentInk : PColors.muted),
              const Spacer(),
              if (fixed)
                Padding(
                  padding: EdgeInsets.all(12),
                  child: PIconView(PIcon.check, color: PColors.safe),
                )
              else
                PToggle(value: value, onChanged: onChanged, label: title),
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
