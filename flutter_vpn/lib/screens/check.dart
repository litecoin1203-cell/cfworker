import 'package:flutter/material.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/diagnose.dart';
import '../state/exits.dart';
import 'states.dart';
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
  DateTime? _testedAt;

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
          final why = await app.tunnel.engineError();
          throw ApiError(0, 'no_engine', why ?? 'not in this build');
        }
        return await app.tunnel.hasGeo()
            ? 'core + place lists'
            : 'core, no place lists';
      });
      // Every exit through the core at once (a few at a time natively),
      // the same run smart connect uses; the findings below read it.
      await _step('Exits through the core', () async {
        if (app.exits.isEmpty) await app.loadServers();
        if (app.exits.isEmpty) throw ApiError(0, 'no_exits', 'none to test');
        await app.testAll();
        final all = app.exits.where((e) => e.measured != null).toList();
        final ok = all.where((e) => (e.measured ?? 0) > 0).length;
        if (ok == 0) throw ApiError(0, 'none_answer', '0 of ${all.length}');
        return '$ok of ${all.length} answer';
      });
      _testedAt = DateTime.now();
    }
    if (mounted) setState(() => _running = false);
  }

  /// What the run found, with advice, then every exit with its result and,
  /// for a failure, the reason and what to do.
  List<Widget> _results(BuildContext context) {
    final app = AppScope.of(context);
    final exits = [...app.exits]
      ..sort((a, b) {
        final x = a.measured ?? 0, y = b.measured ?? 0;
        if ((x > 0) != (y > 0)) return x > 0 ? -1 : 1;
        return x > 0 ? x.compareTo(y) : a.label.compareTo(b.label);
      });
    final findings = summarize(
      exits,
      smart: app.smartConnect,
      localDirect: app.localDirect,
    );
    return [
      const SizedBox(height: 24),
      SectionLabel('What we found'),
      const SizedBox(height: 10),
      for (final f in findings)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: SurfaceCard(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                PIconView(
                  f.good ? PIcon.check : PIcon.shield,
                  size: 20,
                  color: f.good ? PColors.safe : PColors.blue,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(f.title, style: PType.h3().copyWith(fontSize: 15)),
                      const SizedBox(height: 4),
                      Text(f.body, style: PType.small(color: PColors.ink)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      const SizedBox(height: 14),
      SectionLabel('Every exit'),
      const SizedBox(height: 10),
      SurfaceCard(
        padding: const EdgeInsets.fromLTRB(18, 6, 18, 6),
        child: Column(children: [for (final e in exits) _ExitResult(e)]),
      ),
      const SizedBox(height: 18),
      PillButton(
        label: 'Copy report for support',
        icon: PIcon.copy,
        color: Colors.white,
        textColor: PColors.ink,
        onTap: () => copyText(
          context,
          report(
            exits,
            app: ApiClient.appVersion,
            device: '${app.api.deviceModel}, Android ${app.api.osVersion}',
            at: _testedAt!,
          ),
          'Report copied. It has no addresses or account details.',
        ),
      ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    return StorePage(
      title: 'Connection check',
      subtitle: 'Each step Pleat needs, in order, then what works on this network and how to connect better.',
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
        if (_testedAt != null && !_running) ..._results(context),
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

/// One exit's result: its time, or what went wrong and what to do.
class _ExitResult extends StatelessWidget {
  const _ExitResult(this.exit);
  final Exit exit;

  @override
  Widget build(BuildContext context) {
    final m = exit.measured;
    final ok = (m ?? 0) > 0;
    final d = ok || m == null ? null : diagnose(exit.failure);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '${exit.label}  ·  ${exit.protocol}  ·  ${transportOf(exit.server.link)}',
                  style: PType.h3().copyWith(fontSize: 14),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Text(
                m == null ? 'not tested' : (ok ? '$m ms' : 'failed'),
                style: PType.small(
                  color: ok
                      ? PColors.safe
                      : (m == null ? PColors.muted : PColors.alert),
                ).copyWith(fontWeight: FontWeight.w700),
              ),
            ],
          ),
          if (d != null) ...[
            const SizedBox(height: 3),
            Text(
              '${d.title}${d.fixer == Fixer.service ? ' (server side)' : ''}',
              style: PType.small(color: PColors.alert),
            ),
            Text(d.fix, style: PType.small(color: PColors.ink)),
            if (exit.failure != null && d.cause != Cause.unknown)
              Text(
                exit.failure!,
                style: PType.small(color: PColors.muted).copyWith(fontSize: 11),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            _TraceLink(exit.id),
          ],
        ],
      ),
    );
  }
}

/// Tests this one exit alone with the core's full log and copies the
/// result (no addresses, keys or ids) for support.
class _TraceLink extends StatefulWidget {
  const _TraceLink(this.id);
  final String id;

  @override
  State<_TraceLink> createState() => _TraceLinkState();
}

class _TraceLinkState extends State<_TraceLink> {
  bool _running = false;

  Future<void> _trace() async {
    final app = AppScope.read(context);
    setState(() => _running = true);
    final text = await app.traceExit(widget.id);
    if (!mounted) return;
    setState(() => _running = false);
    if (text == null) {
      showNote(context, 'Wait for the check to finish, then try again.');
      return;
    }
    copyText(
      context,
      text,
      'Core log copied. It has no addresses, keys or account details.',
    );
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 4),
    child: GestureDetector(
      onTap: _running ? null : _trace,
      child: Text(
        _running
            ? 'Testing alone with the core log…'
            : 'Test alone + copy core log',
        style: PType.small(color: PColors.blue).copyWith(
          fontWeight: FontWeight.w700,
          decoration: _running ? null : TextDecoration.underline,
        ),
      ),
    ),
  );
}
