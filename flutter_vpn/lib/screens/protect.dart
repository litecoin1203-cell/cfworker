import 'package:flutter/material.dart';

import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/seed.dart';
import 'shell.dart';

/// Protect is a control surface. The kill switch is the big favourite
/// card and flips the shard mood; split tunnel and DNS are spatial cards.
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
            item(_DnsCard(app: app)),
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
                      icon: PIcon.filter,
                      title: 'Threat filter',
                      body: app.threatFilter
                          ? '1,284 trackers stopped this week'
                          : 'Lookups are not filtered',
                      value: app.threatFilter,
                      onChanged: (v) => app.update((s) => s.threatFilter = v),
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Transform.translate(
                      offset: const Offset(0, 22),
                      child: _MiniCard(
                        icon: PIcon.lan,
                        title: 'Local network',
                        body: app.lan
                            ? 'Printers and TVs can see this phone'
                            : 'Hidden from the local network',
                        value: app.lan,
                        onChanged: (v) => app.update((s) => s.lan = v),
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
    final on = [
      app.killSwitch,
      app.threatFilter,
      app.autoConnect,
    ].where((v) => v).length;
    return '$on of 3 core guards on  ·  ${app.protocol}';
  }
}

class _KillSwitchCard extends StatelessWidget {
  const _KillSwitchCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final armed = app.killSwitch;
    void flip() => app.update((s) => s.killSwitch = !s.killSwitch);
    return Pressable(
      onTap: flip,
      label: 'Kill switch',
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
                right: armed ? -40 : -170,
                top: armed ? -66 : -120,
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
                right: armed ? 96 : -40,
                top: armed ? -44 : -150,
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
                        PToggle(
                          value: armed,
                          onChanged: (_) => flip(),
                          label: 'Kill switch',
                          offIsAlert: true,
                          onDark: true,
                        ),
                      ],
                    ),
                    const Spacer(),
                    Text('Kill switch', style: PType.h1(color: Colors.white)),
                    const SizedBox(height: 6),
                    AnimatedSwitcher(
                      duration: PMotion.quick,
                      child: Text(
                        armed ? 'Armed. If the tunnel drops, traffic stops.' : 'Off. If the tunnel drops, apps fall back to the open network.',
                        key: ValueKey(armed),
                        style: PType.small(
                          color: armed ? PColors.ice : const Color(0xFFFF9C9F),
                        ).copyWith(fontWeight: FontWeight.w600),
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

/// Split tunnel as space: two zones, apps physically move between them.
class _SplitTunnelCard extends StatelessWidget {
  const _SplitTunnelCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final through = demoApps
        .where((a) => !app.directApps.contains(a.id))
        .toList();
    final direct = demoApps
        .where((a) => app.directApps.contains(a.id))
        .toList();
    void move(DemoApp a) => app.update(
      (s) => s.directApps.contains(a.id)
          ? s.directApps.remove(a.id)
          : s.directApps.add(a.id),
    );
    return SurfaceCard(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const PIconView(PIcon.split, color: PColors.blue),
              const SizedBox(width: 10),
              Expanded(child: Text('Split tunnel', style: PType.h3())),
              Text('Tap an app to move it', style: PType.meta()),
            ],
          ),
          const SizedBox(height: 16),
          AnimatedSize(
            duration: PMotion.reduced(context) ? Duration.zero : PMotion.state,
            curve: Curves.easeInOutCubic,
            alignment: Alignment.topCenter,
            child: IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(
                    flex: 3,
                    child: _Zone(
                      title: 'Through tunnel',
                      color: PColors.blue,
                      ink: Colors.white,
                      apps: through,
                      onTap: move,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    flex: 2,
                    child: _Zone(
                      title: 'Direct',
                      color: PColors.mist,
                      ink: PColors.navy,
                      apps: direct,
                      onTap: move,
                    ),
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

class _Zone extends StatelessWidget {
  const _Zone({
    required this.title,
    required this.color,
    required this.ink,
    required this.apps,
    required this.onTap,
  });
  final String title;
  final Color color, ink;
  final List<DemoApp> apps;
  final ValueChanged<DemoApp> onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(22),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: PType.meta(color: ink.withValues(alpha: 0.8))),
          const SizedBox(height: 10),
          if (apps.isEmpty)
            Text(
              'Nothing here',
              style: PType.small(color: ink.withValues(alpha: 0.6)),
            ),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final a in apps)
                Pressable(
                  key: ValueKey(a.id),
                  onTap: () => onTap(a),
                  label: '${a.name}, $title. Tap to move',
                  radius: PRadius.pill,
                  color: Colors.white,
                  child: SizedBox(
                    height: 36,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      child: Center(
                        widthFactor: 1,
                        child: Text(
                          a.name,
                          style: PType.small(color: PColors.ink)
                              .copyWith(fontWeight: FontWeight.w700),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// DNS as three stacked planes; the chosen one steps forward.
class _DnsCard extends StatelessWidget {
  const _DnsCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final d = PMotion.reduced(context) ? Duration.zero : PMotion.state;
    return SurfaceCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const PIconView(PIcon.dns, color: PColors.blue),
              const SizedBox(width: 10),
              Expanded(child: Text('Private DNS', style: PType.h3())),
            ],
          ),
          const SizedBox(height: 14),
          for (var i = 0; i < resolvers.length; i++)
            Builder(
              builder: (context) {
                final r = resolvers[i];
                final on = app.dns == r.id;
                return AnimatedPadding(
                  duration: d,
                  curve: Curves.easeOutBack,
                  padding: EdgeInsets.only(
                    left: on ? 0 : 14.0 + i * 8,
                    bottom: 8,
                  ),
                  child: Pressable(
                    onTap: () => app.update((s) => s.dns = r.id),
                    label: r.name,
                    selected: on,
                    radius: 20,
                    color: on ? PColors.navy : PColors.field,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 14, 12),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  r.name,
                                  style: PType.h3(
                                    color: on ? Colors.white : PColors.ink,
                                  ).copyWith(fontSize: 15),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  r.note,
                                  style: PType.small(
                                    color: on ? PColors.ice : PColors.muted,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          AnimatedOpacity(
                            duration: d,
                            opacity: on ? 1 : 0,
                            child: const PIconView(
                              PIcon.check,
                              color: Colors.white,
                              size: 20,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              },
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
    final i = protocols.indexOf(app.protocol);
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
                  alignment: Alignment(-1 + i * 1.0, 0),
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
                          selected: p == app.protocol,
                          label: p,
                          child: GestureDetector(
                            behavior: HitTestBehavior.opaque,
                            onTap: () => app.update((s) => s.protocol = p),
                            child: Center(
                              child: Text(
                                p,
                                style: PType.small(
                                  color: p == app.protocol
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
          Text(switch (app.protocol) {
            'WireGuard' => 'Fastest handshake, smallest code base.',
            'IKEv2' => 'Holds on when the phone switches networks.',
            _ => 'Most compatible with strict networks.',
          }, style: PType.small()),
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
    return SurfaceCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const PIconView(PIcon.wifi, color: PColors.blue),
              const SizedBox(width: 10),
              Expanded(child: Text('Auto-connect', style: PType.h3())),
              PToggle(
                value: app.autoConnect,
                onChanged: (v) => app.update((s) => s.autoConnect = v),
                label: 'Auto-connect',
              ),
            ],
          ),
          AnimatedSize(
            duration: PMotion.reduced(context) ? Duration.zero : PMotion.state,
            curve: Curves.easeInOutCubic,
            child: !app.autoConnect
                ? const SizedBox(width: double.infinity)
                : Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Row(
                      children: [
                        for (final (only, label) in const [
                          (true, 'Untrusted Wi-Fi'),
                          (false, 'Every network'),
                        ])
                          Expanded(
                            child: Padding(
                              padding: EdgeInsets.only(right: only ? 8 : 0),
                              child: Pressable(
                                onTap: () => app.update(
                                  (s) => s.autoOnlyUntrusted = only,
                                ),
                                label: label,
                                selected: app.autoOnlyUntrusted == only,
                                radius: PRadius.pill,
                                color: app.autoOnlyUntrusted == only
                                    ? PColors.mist
                                    : PColors.field,
                                child: SizedBox(
                                  height: 44,
                                  child: Center(
                                    child: Text(
                                      label,
                                      style: PType.small(
                                        color: app.autoOnlyUntrusted == only
                                            ? PColors.blue
                                            : PColors.muted,
                                      ).copyWith(fontWeight: FontWeight.w700),
                                    ),
                                  ),
                                ),
                              ),
                            ),
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

class _MiniCard extends StatelessWidget {
  const _MiniCard({
    required this.icon,
    required this.title,
    required this.body,
    required this.value,
    required this.onChanged,
  });

  final PIcon icon;
  final String title, body;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return SurfaceCard(
      onTap: () => onChanged(!value),
      label: title,
      padding: const EdgeInsets.fromLTRB(18, 16, 10, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              PIconView(icon, color: value ? PColors.blue : PColors.muted),
              const Spacer(),
              PToggle(value: value, onChanged: onChanged, label: title),
            ],
          ),
          const SizedBox(height: 10),
          Text(title, style: PType.h3()),
          const SizedBox(height: 4),
          SizedBox(height: 54, child: Text(body, style: PType.small())),
        ],
      ),
    );
  }
}
