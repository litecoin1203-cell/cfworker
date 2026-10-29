import 'package:flutter/material.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/xray_config.dart';
import 'store_kit.dart';

/// Connection check: runs each step Pleat needs, in order, and shows how
/// each one went and how long it took. Meant for a screenshot when
/// something doesn't connect. It shows paths, codes, counts and times;
/// never an address, a config or a token.
class CheckScreen extends StatefulWidget {
  const CheckScreen({super.key});

  @override
  State<CheckScreen> createState() => _CheckScreenState();
}

class _Step {
  _Step(this.label);
  final String label;
  bool? ok;
  String detail = '';
  Duration? took;
}

class _CheckScreenState extends State<CheckScreen> {
  final _steps = <_Step>[];
  bool _running = false;

  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<void> _step(String label, Future<String> Function() body) async {
    final s = _Step(label);
    setState(() => _steps.add(s));
    final w = Stopwatch()..start();
    try {
      s.detail = await body();
      s.ok = true;
    } on ApiError catch (e) {
      s.ok = false;
      s.detail = e.status == 0
          ? '${e.code}: ${e.message}'
          : 'HTTP ${e.status} ${e.code}';
    } catch (e) {
      s.ok = false;
      s.detail = e.runtimeType.toString();
    }
    s.took = w.elapsed;
    if (mounted) setState(() {});
  }

  Future<void> _run() async {
    final app = AppScope.read(context);
    final api = app.api;
    setState(() {
      _running = true;
      _steps.clear();
    });
    await _step('Server address in this build', () async {
      if (!api.configured) throw ApiError(0, 'no_server', 'none');
      return 'set';
    });
    await _step('Public plans  GET /plans', () async {
      final l = await api.get('/plans') as List;
      return '${l.length} plans';
    });
    if (app.signedIn) {
      await _step('Account  GET /me', () async {
        final m = Me.fromJson((await api.get('/me') as Map).cast());
        final s = m.subscription;
        return s == null ? 'no plan' : '${s.status}, ${s.daysLeft ?? '∞'} days';
      });
      await _step('Plan check  GET /vpn', () async {
        final v = await api.get('/vpn') as Map;
        final s = v['subscription'] as Map?;
        return s == null ? 'no plan' : '${s['status']}';
      });
      List<Server> list = const [];
      await _step('Exits  GET /vpn/servers', () async {
        final l = await api.get('/vpn/servers') as List;
        list = [
          for (final x in l)
            Server.fromJson((x as Map).cast<String, dynamic>()),
        ];
        final kinds = {for (final s in list) s.protocolLabel}.join(', ');
        return '${list.length} exits${kinds.isEmpty ? '' : ' ($kinds)'}';
      });
      await _step('Network ranking  GET /net/rank', () async {
        final r = ranksFrom(await api.get('/net/rank'));
        return '${r.length} ranked';
      });
      await _step('Tunnel engine', () async {
        if (!await app.tunnel.available()) {
          throw ApiError(0, 'no_engine', 'not in this build');
        }
        return await app.tunnel.hasGeo()
            ? 'core + place lists'
            : 'core, no place lists';
      });
      for (final s in list.take(4)) {
        await _step('Exit ${s.name}  ${s.protocolLabel}', () async {
          final String config;
          try {
            config = xrayConfig(s.link, forTest: true);
          } on FormatException {
            throw ApiError(0, 'unsupported', 'protocol not supported');
          }
          final ms = await app.tunnel.ping(config);
          if (ms == null) {
            throw ApiError(0, 'no_answer', 'no answer through the core');
          }
          return '$ms ms through the core';
        });
      }
    }
    if (mounted) setState(() => _running = false);
  }

  @override
  Widget build(BuildContext context) {
    return StorePage(
      title: 'Connection check',
      subtitle: 'Each step Pleat needs, in order. Send a screenshot to support if one fails.',
      children: [
        SurfaceCard(
          padding: const EdgeInsets.fromLTRB(18, 8, 18, 8),
          child: Column(
            children: [
              for (final s in _steps)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        width: 26,
                        height: 26,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: s.ok == null
                              ? PColors.mist
                              : (s.ok! ? PColors.safe : PColors.alert),
                        ),
                        alignment: Alignment.center,
                        child: s.ok == null
                            ? const SizedBox(
                                width: 12,
                                height: 12,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: PColors.blue,
                                ),
                              )
                            : PIconView(
                                s.ok! ? PIcon.check : PIcon.close,
                                size: 14,
                                color: Colors.white,
                              ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              s.label,
                              style: PType.h3().copyWith(fontSize: 14),
                            ),
                            if (s.detail.isNotEmpty || s.took != null)
                              Text(
                                [
                                  if (s.detail.isNotEmpty) s.detail,
                                  if (s.took != null)
                                    '${(s.took!.inMilliseconds / 1000).toStringAsFixed(1)} s',
                                ].join('  ·  '),
                                style: PType.small(
                                  color: s.ok == false
                                      ? PColors.alert
                                      : PColors.muted,
                                ),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        PillButton(
          label: _running ? 'Checking…' : 'Run again',
          icon: PIcon.refresh,
          onTap: _running ? null : _run,
        ),
      ],
    );
  }
}
