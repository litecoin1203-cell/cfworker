import 'package:flutter/material.dart';

import '../api/countries.dart';
import '../design/city_art.dart';
import '../design/icons.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import '../state/route_mode.dart';
import '../state/route_rules.dart';
import '../state/tunnel.dart';
import 'route_chooser.dart';

/// Under the goal cards and the location bar on Home's Route: Stay in one
/// country, Split route and Your networks. How the three fit together is
/// written once, in `route_rules.dart`.
class RouteExtras extends StatelessWidget {
  const RouteExtras({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          StaggerIn(index: 0, child: _LockCard(app: app)),
          const SizedBox(height: 14),
          StaggerIn(index: 1, child: _SplitCard(app: app)),
          const SizedBox(height: 14),
          StaggerIn(index: 2, child: _NetworksCard(app: app)),
          const SizedBox(height: 14),
          StaggerIn(index: 3, child: _SmartCard(app: app)),
        ],
      ),
    );
  }
}

// ---- shared pieces -------------------------------------------------------

/// A round tile with an icon: navy when the feature is on.
class _Tile extends StatelessWidget {
  const _Tile(this.icon, {this.on = false});
  final PIcon icon;
  final bool on;

  @override
  Widget build(BuildContext context) => Container(
    width: 40,
    height: 40,
    decoration: BoxDecoration(
      color: on ? PColors.navy : PColors.mist,
      borderRadius: BorderRadius.circular(14),
    ),
    alignment: Alignment.center,
    child: PIconView(
      icon,
      size: 20,
      color: on ? PColors.onDeep : PColors.accentInk,
    ),
  );
}

class _Head extends StatelessWidget {
  const _Head({
    required this.icon,
    required this.title,
    required this.sub,
    required this.on,
    this.trailing,
  });
  final PIcon icon;
  final String title, sub;
  final bool on;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      _Tile(icon, on: on),
      const SizedBox(width: 12),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: PType.h3().copyWith(fontSize: 15.5)),
            const SizedBox(height: 2),
            Text(sub, style: PType.meta(color: PColors.muted)),
          ],
        ),
      ),
      ?trailing,
    ],
  );
}

/// One tappable line inside a card: a leading widget, two lines of text
/// and a chevron (or [trailing]).
class _Line extends StatelessWidget {
  const _Line({
    required this.lead,
    required this.title,
    required this.sub,
    this.onTap,
    this.trailing,
    this.label,
  });
  final Widget lead;
  final String title, sub;
  final VoidCallback? onTap;
  final Widget? trailing;
  final String? label;

  @override
  Widget build(BuildContext context) => Pressable(
    onTap: onTap,
    label: label ?? '$title. $sub',
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
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 1),
                Text(
                  sub,
                  style: PType.meta(color: PColors.muted),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
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

Widget _rule() => Divider(height: 10, thickness: 1, color: PColors.mist);

/// A country's flag coin, from its best exit; a globe when none.
Widget _flagOf(AppState app, String country, {double size = 32}) {
  for (final e in app.ranked) {
    if (AppState.countryOf(e) == country) return RegionBadge(e, size: size);
  }
  return Container(
    width: size,
    height: size,
    decoration: BoxDecoration(color: PColors.blue, shape: BoxShape.circle),
    alignment: Alignment.center,
    child: PIconView(PIcon.globe, size: size * 0.56, color: PColors.onAccent),
  );
}

/// The bottom sheet frame Route's sheets share.
Future<T?> _sheet<T>(
  BuildContext context, {
  required String title,
  required String sub,
  required WidgetBuilder body,
}) => showModalBottomSheet<T>(
  context: context,
  backgroundColor: Colors.transparent,
  barrierColor: PColors.scrim,
  isScrollControlled: true,
  builder: (context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
    child: Container(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.85,
      ),
      decoration: BoxDecoration(
        color: PColors.surface,
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(PRadius.sheet),
        ),
      ),
      padding: EdgeInsets.fromLTRB(
        18,
        14,
        18,
        18 + MediaQuery.paddingOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: PColors.mist,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 16),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(title, style: PType.h2()),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 4, 4, 14),
            child: Text(sub, style: PType.small()),
          ),
          Flexible(child: body(context)),
        ],
      ),
    ),
  ),
);

/// A choice row in a sheet: selected ones get the blue ring.
Widget _choice({
  required Widget lead,
  required String title,
  required String sub,
  required bool on,
  required VoidCallback onTap,
}) => Padding(
  padding: const EdgeInsets.only(bottom: 8),
  child: Pressable(
    onTap: onTap,
    label: '$title. $sub',
    selected: on,
    radius: 18,
    color: on ? PColors.mist : PColors.field,
    child: Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 14, 10),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: on ? PColors.blue : Colors.transparent,
          width: 2,
        ),
      ),
      child: Row(
        children: [
          lead,
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: PType.h3().copyWith(fontSize: 15)),
                const SizedBox(height: 2),
                Text(sub, style: PType.meta(color: PColors.ink)),
              ],
            ),
          ),
          if (on) PIconView(PIcon.check, size: 20, color: PColors.accentInk),
        ],
      ),
    ),
  ),
);

// ---- Smart connect ---------------------------------------------------------

/// Moved here from Protect: it decides how Pleat connects, not what guards
/// the person. Off, the exit picked stays in use.
class _SmartCard extends StatelessWidget {
  const _SmartCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) => SurfaceCard(
    radius: 24,
    padding: const EdgeInsets.fromLTRB(16, 16, 12, 16),
    child: _Head(
      icon: PIcon.bolt,
      title: 'Smart connect',
      sub: app.smartConnect
          ? 'Tests every exit, takes the fastest, moves on if it stops'
          : 'Uses the exit you pick, and stays on it',
      on: app.smartConnect,
      trailing: PToggle(
        value: app.smartConnect,
        onChanged: app.tunnelAvailable == true ? app.setSmartConnect : null,
        label: 'Smart connect',
      ),
    ),
  );
}

// ---- Stay in one country -------------------------------------------------

class _LockCard extends StatelessWidget {
  const _LockCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final on = app.stayInCountry && app.routeCountry.isNotEmpty;
    final c = app.routeCountry;
    final place = c.isEmpty ? '' : countryName(c);
    final consent = app.consent;
    final backup = app.backupCountry;
    final until = app.consentUntil;
    return SurfaceCard(
      radius: 24,
      padding: const EdgeInsets.fromLTRB(16, 16, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Head(
            icon: PIcon.pin,
            title: on ? 'Stay in $place' : 'Stay in one country',
            sub: on
                ? 'Same exit and IP while it answers'
                : 'For apps and sites that dislike a changing IP',
            on: on,
            trailing: PToggle(
              value: app.stayInCountry,
              onChanged: app.exits.isEmpty ? null : app.setStayInCountry,
              label: 'Stay in one country',
            ),
          ),
          if (on) ...[
            const SizedBox(height: 8),
            _rule(),
            _Line(
              lead: _flagOf(app, c),
              title: '1st  $place',
              sub: app.pinned
                  ? 'Paused: an exit was picked by hand. Pick a goal or location above to go back.'
                  : 'Always tried first. Change it in Location above.',
              onTap: () => showRouteCountries(context),
            ),
            _Line(
              lead: backup.isEmpty
                  ? _flagOf(app, '', size: 32)
                  : _flagOf(app, backup),
              title: backup.isEmpty
                  ? 'If $place fails: best other country'
                  : 'If $place fails: ${countryName(backup)}',
              sub: 'Only after you say yes in a popup',
              onTap: () => _showBackup(context, app),
            ),
            if (consent != null && until != null) ...[
              const SizedBox(height: 6),
              Container(
                padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
                decoration: BoxDecoration(
                  color: PColors.mist,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Using ${consent.title} until ${_hm(until)}, because $place didn’t answer.',
                        style: PType.meta(color: PColors.ink),
                      ),
                    ),
                    Pressable(
                      onTap: app.endConsent,
                      label: 'Back to $place now',
                      radius: PRadius.pill,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 8,
                        ),
                        child: Text(
                          'BACK TO $place'.toUpperCase(),
                          style: PType.button(color: PColors.accentInk)
                              .copyWith(fontSize: 11.5),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ] else
            Padding(
              padding: const EdgeInsets.fromLTRB(52, 8, 8, 6),
              child: Text(
                'Off: Pleat may move to a faster exit, and your IP with it.',
                style: PType.meta(color: PColors.muted),
              ),
            ),
        ],
      ),
    );
  }

  static String _hm(DateTime t) =>
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
}

Future<void> _showBackup(BuildContext context, AppState app) => _sheet<void>(
  context,
  title: 'Second country',
  sub:
      'Offered only if no ${countryName(app.routeCountry)} exit answers. Pleat always asks first.',
  body: (context) {
    final list = [
      for (final r in app.allCountries)
        if (r.$1 != app.routeCountry) r,
    ];
    return ListView(
      shrinkWrap: true,
      children: [
        _choice(
          lead: _flagOf(app, '', size: 36),
          title: 'Best other country',
          sub: 'Pleat suggests the one that works best then',
          on: app.backupCountry.isEmpty,
          onTap: () {
            app.setBackupCountry('');
            Navigator.of(context).pop();
          },
        ),
        for (final (key, best, n) in list)
          _choice(
            lead: RegionBadge(best, size: 36),
            title: best.title,
            sub: [
              n == 1 ? '1 exit' : '$n exits',
              if (best.ping != null) 'best ${best.ping} ms',
            ].join('  ·  '),
            on: app.backupCountry == key,
            onTap: () {
              app.setBackupCountry(key);
              Navigator.of(context).pop();
            },
          ),
      ],
    );
  },
);

/// The popup: nothing in the chosen country answered. Pleat stopped; the
/// person picks where to go, or stays.
Future<void> showLockAsk(BuildContext context) {
  final app = AppScope.read(context);
  final ask = app.lockAsk;
  if (ask == null) return Future.value();
  final place = countryName(ask.country);
  final what = ask.mode == RouteMode.auto ? '' : ' ${ask.mode.title}';
  return _sheet<void>(
    context,
    title: 'No $place$what exit answered',
    sub: 'Pleat stopped instead of changing your location. Where should it connect?',
    body: (context) => ListView(
      shrinkWrap: true,
      children: [
        for (final o in ask.options)
          _choice(
            lead: _flagOf(app, o.country, size: 36),
            title: o.title,
            sub: o.detail,
            on: false,
            onTap: () {
              Navigator.of(context).pop();
              app.acceptLock(o);
            },
          ),
        const SizedBox(height: 4),
        PillButton(
          label: 'Stay with $place',
          color: PColors.field,
          textColor: PColors.accentInk,
          onTap: () {
            Navigator.of(context).pop();
            app.declineLock();
          },
        ),
      ],
    ),
  ).whenComplete(() {
    // swiped away: the same as staying
    if (app.lockAsk == ask) app.declineLock();
  });
}

// ---- Split route ---------------------------------------------------------

class _SplitCard extends StatelessWidget {
  const _SplitCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final can = app.tunnelAvailable == true && app.geoAvailable;
    final sites = app.directSites;
    final apps = app.bypassApps;
    final any = (app.localDirect && can) || sites.isNotEmpty || apps.isNotEmpty;
    return SurfaceCard(
      radius: 24,
      padding: const EdgeInsets.fromLTRB(16, 16, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Head(
            icon: PIcon.split,
            title: 'Split route',
            sub: 'These never use the VPN: they open with your own IP',
            on: any,
          ),
          const SizedBox(height: 8),
          _rule(),
          _Line(
            lead: const _Tile(PIcon.globe),
            title: 'Iranian sites',
            sub: can
                ? 'Banks, gov and .ir sites. They also save plan data.'
                : 'Needs the place lists. Not in this build.',
            label: 'Iranian sites go direct',
            trailing: PToggle(
              value: app.localDirect && can,
              onChanged: can ? app.setLocalDirect : null,
              label: 'Iranian sites go direct',
            ),
          ),
          _Line(
            lead: const _Tile(PIcon.bookmark),
            title: 'Your sites',
            sub: sites.isEmpty
                ? 'Add a site that should skip the VPN'
                : '${sites.take(2).join(', ')}${sites.length > 2 ? ' +${sites.length - 2}' : ''}',
            onTap: () => _showSites(context, app),
          ),
          _Line(
            lead: const _Tile(PIcon.grid),
            title: apps.isEmpty
                ? 'Apps'
                : (apps.length == 1 ? '1 app' : '${apps.length} apps'),
            sub: apps.isEmpty
                ? 'Pick apps that should skip the VPN'
                : 'Skip the VPN completely',
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (apps.isNotEmpty) _AppFaces(app: app, ids: apps),
                const SizedBox(width: 6),
                PIconView(PIcon.chevron, size: 16, color: PColors.muted),
              ],
            ),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => AppsScreen(app: app)),
            ),
          ),
          if (app.bypassBlocked)
            Padding(
              padding: const EdgeInsets.fromLTRB(2, 6, 4, 6),
              child: UnavailableNote(
                'Android’s “Block connections without VPN” is on, so these apps can’t go online. Turn it off in Protect > Kill switch, or remove them.',
              ),
            ),
        ],
      ),
    );
  }
}

/// Up to three chosen apps' icons, overlapping.
class _AppFaces extends StatelessWidget {
  const _AppFaces({required this.app, required this.ids});
  final AppState app;
  final List<String> ids;

  @override
  Widget build(BuildContext context) => FutureBuilder<List<PhoneApp>>(
    future: app.phoneApps(),
    builder: (context, snap) {
      final by = {for (final a in snap.data ?? const <PhoneApp>[]) a.id: a};
      final shown = [
        for (final id in ids)
          if (by[id]?.icon != null) by[id]!,
      ].take(3).toList();
      if (shown.isEmpty) return const SizedBox.shrink();
      return SizedBox(
        width: 22.0 * shown.length + 8,
        height: 28,
        child: Stack(
          children: [
            for (var i = 0; i < shown.length; i++)
              Positioned(
                left: 22.0 * i,
                child: Container(
                  width: 28,
                  height: 28,
                  decoration: BoxDecoration(
                    color: PColors.surface,
                    borderRadius: BorderRadius.circular(9),
                    border: Border.all(color: PColors.surface, width: 2),
                  ),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(7),
                    child: Image.memory(shown[i].icon!, gaplessPlayback: true),
                  ),
                ),
              ),
          ],
        ),
      );
    },
  );
}

Future<void> _showSites(BuildContext context, AppState app) {
  final field = TextEditingController();
  String? error;
  return _sheet<void>(
    context,
    title: 'Your sites',
    sub:
        'Opened with your own IP, never through the VPN. Subdomains count too.',
    body: (context) => StatefulBuilder(
      builder: (context, setState) {
        void add() {
          if (app.addDirectSite(field.text)) {
            field.clear();
            setState(() => error = null);
          } else {
            setState(() => error = 'Not a site name. Try mybank.com');
          }
        }

        return ListView(
          shrinkWrap: true,
          children: [
            Row(
              children: [
                Expanded(
                  child: Container(
                    height: 52,
                    padding: const EdgeInsets.symmetric(horizontal: 18),
                    decoration: BoxDecoration(
                      color: PColors.field,
                      borderRadius: BorderRadius.circular(PRadius.pill),
                    ),
                    alignment: Alignment.centerLeft,
                    child: TextField(
                      controller: field,
                      autofocus: app.directSites.isEmpty,
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      onSubmitted: (_) => add(),
                      style: PType.body(),
                      cursorColor: PColors.blue,
                      decoration: InputDecoration(
                        isCollapsed: true,
                        border: InputBorder.none,
                        hintText: 'mybank.com',
                        hintStyle: PType.body(color: PColors.muted),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                PillButton(label: 'Add', expand: false, height: 52, onTap: add),
              ],
            ),
            if (error case final e?)
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
                child: Text(e, style: PType.meta(color: PColors.alert)),
              ),
            const SizedBox(height: 12),
            for (final s in app.directSites)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Container(
                  padding: const EdgeInsets.fromLTRB(16, 4, 4, 4),
                  decoration: BoxDecoration(
                    color: PColors.field,
                    borderRadius: BorderRadius.circular(18),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          s,
                          style: PType.body(color: PColors.ink)
                              .copyWith(fontWeight: FontWeight.w600),
                        ),
                      ),
                      RoundIcon(
                        PIcon.close,
                        label: 'Remove $s',
                        onTap: () {
                          app.removeDirectSite(s);
                          setState(() {});
                        },
                      ),
                    ],
                  ),
                ),
              ),
            if (app.directSites.isEmpty)
              Padding(
                padding: const EdgeInsets.all(8),
                child: Text(
                  'Iranian sites already go direct when that switch is on. Add others here, for example a bank hosted abroad.',
                  style: PType.meta(color: PColors.muted),
                ),
              ),
          ],
        );
      },
    ),
  );
}

/// Picks the apps that skip the VPN. Changes apply when leaving, in one
/// go, so a running session restarts once, not once per tap.
class AppsScreen extends StatefulWidget {
  const AppsScreen({super.key, required this.app});
  final AppState app;

  @override
  State<AppsScreen> createState() => _AppsScreenState();
}

class _AppsScreenState extends State<AppsScreen> {
  late final Set<String> _picked = widget.app.bypassApps.toSet();
  late final Future<List<PhoneApp>> _apps = widget.app.phoneApps(fresh: true);
  String _q = '';

  @override
  void dispose() {
    widget.app.setBypassApps(_picked);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: PColors.ground,
      body: SafeArea(
        child: FutureBuilder<List<PhoneApp>>(
          future: _apps,
          builder: (context, snap) {
            final all = snap.data ?? const <PhoneApp>[];
            final q = _q.trim().toLowerCase();
            bool hit(PhoneApp a) =>
                q.isEmpty ||
                a.name.toLowerCase().contains(q) ||
                a.id.toLowerCase().contains(q);
            final ir = [
              for (final a in all)
                if (looksIranian(a.id) && hit(a)) a,
            ];
            final rest = [
              for (final a in all)
                if (!looksIranian(a.id) && hit(a)) a,
            ];
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
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text('Apps that skip the VPN', style: PType.h2()),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  'Picked apps use your own internet and IP, never the tunnel. Everything else stays protected.',
                  style: PType.small(),
                ),
                const SizedBox(height: 14),
                PillSearch(
                  hint: 'Search apps',
                  onChanged: (v) => setState(() => _q = v),
                ),
                const SizedBox(height: 14),
                if (snap.connectionState != ConnectionState.done)
                  const Padding(
                    padding: EdgeInsets.all(24),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (all.isEmpty)
                  UnavailableNote(
                    'No apps to show. This needs Pleat on an Android phone.',
                  ),
                if (ir.isNotEmpty) ...[
                  _group('IRANIAN APPS ON THIS PHONE'),
                  for (final a in ir) _row(a),
                  const SizedBox(height: 10),
                ],
                if (rest.isNotEmpty) ...[
                  _group('ALL APPS'),
                  for (final a in rest) _row(a),
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _group(String t) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 4, 4, 8),
    child: Text(
      t,
      style: PType.meta(color: PColors.muted).copyWith(
        fontWeight: FontWeight.w800,
        letterSpacing: 1.1,
        fontSize: 10.5,
      ),
    ),
  );

  Widget _row(PhoneApp a) {
    final on = _picked.contains(a.id);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Pressable(
        onTap: () =>
            setState(() => on ? _picked.remove(a.id) : _picked.add(a.id)),
        label: '${a.name}, ${on ? 'skips the VPN' : 'uses the VPN'}',
        selected: on,
        radius: 18,
        color: on ? PColors.mist : PColors.surface,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 14, 8),
          child: Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: SizedBox(
                  width: 38,
                  height: 38,
                  child: a.icon == null
                      ? ColoredBox(
                          color: PColors.ice,
                          child: Center(
                            child: Text(
                              a.name.isEmpty
                                  ? '?'
                                  : a.name.characters.first.toUpperCase(),
                              style: PType.h3(color: PColors.navy),
                            ),
                          ),
                        )
                      : Image.memory(a.icon!, gaplessPlayback: true),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      a.name,
                      style: PType.small(color: PColors.ink)
                          .copyWith(fontWeight: FontWeight.w700, fontSize: 14),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    Text(
                      a.id,
                      style: PType.meta(color: PColors.muted),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              AnimatedContainer(
                duration: PMotion.quick,
                width: 24,
                height: 24,
                decoration: BoxDecoration(
                  color: on ? PColors.blue : Colors.transparent,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: on ? PColors.blue : PColors.muted,
                    width: 2,
                  ),
                ),
                alignment: Alignment.center,
                child: on
                    ? PIconView(PIcon.check, size: 14, color: PColors.onAccent)
                    : null,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---- Your networks -------------------------------------------------------

class _NetworksCard extends StatelessWidget {
  const _NetworksCard({required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) {
    final list = app.netRoutes.list.take(4).toList();
    final on = app.routeByNetwork;
    return SurfaceCard(
      radius: 24,
      padding: const EdgeInsets.fromLTRB(16, 16, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Head(
            icon: PIcon.wifi,
            title: 'Your networks',
            sub: 'Switch the goal when your network changes',
            on: on,
            trailing: PToggle(
              value: on,
              onChanged: app.setRouteByNetwork,
              label: 'Switch the goal when the network changes',
            ),
          ),
          if (on && app.netRouteNote != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(52, 8, 8, 0),
              child: Text(
                app.netRouteNote!,
                style: PType.meta(color: PColors.accentInk)
                    .copyWith(fontWeight: FontWeight.w700),
              ),
            ),
          const SizedBox(height: 8),
          _rule(),
          if (list.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 8, 8, 8),
              child: Text(
                'Connect once on each network (home Wi-Fi, mobile data). Pleat remembers the goal you used there.',
                style: PType.meta(color: PColors.muted),
              ),
            ),
          for (final (key, r) in list)
            _Line(
              lead: _Tile(
                key.endsWith('-wifi') ? PIcon.wifi : PIcon.phone,
                on: key == app.netKey,
              ),
              title: r.name,
              sub: [
                if (key == app.netKey) 'You’re on it',
                r.tries == 0
                    ? 'Not connected here yet'
                    : 'Worked ${r.ok} of ${r.tries} times',
              ].join('  ·  '),
              label: '${r.name}: ${r.mode.title}. Tap to change.',
              trailing: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: key == app.netKey ? PColors.navy : PColors.field,
                  borderRadius: BorderRadius.circular(PRadius.pill),
                ),
                child: Text(
                  r.mode.title,
                  style: PType.meta(
                    color: key == app.netKey ? PColors.onDeep : PColors.ink,
                  ).copyWith(fontWeight: FontWeight.w800),
                ),
              ),
              onTap: () => _showNetGoal(context, app, key, r),
            ),
          if (on && app.stayInCountry && list.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 4, 8, 6),
              child: Text(
                'Changes the goal only. Your country stays ${countryName(app.routeCountry)}.',
                style: PType.meta(color: PColors.muted),
              ),
            ),
        ],
      ),
    );
  }
}

Future<void> _showNetGoal(
  BuildContext context,
  AppState app,
  String key,
  NetRoute r,
) => _sheet<void>(
  context,
  title: r.name,
  sub: 'The goal Pleat uses on this network.',
  body: (context) => ListView(
    shrinkWrap: true,
    children: [
      for (final m in app.routeModes)
        _choice(
          lead: _Tile(_iconOf(m), on: r.mode == m),
          title: m.title,
          sub: m.blurb,
          on: r.mode == m,
          onTap: () {
            app.setNetGoal(key, m);
            Navigator.of(context).pop();
          },
        ),
      const SizedBox(height: 4),
      PillButton(
        label: 'Forget this network',
        color: PColors.field,
        textColor: PColors.accentInk,
        onTap: () {
          app.forgetNet(key);
          Navigator.of(context).pop();
        },
      ),
    ],
  ),
);

PIcon _iconOf(RouteMode m) => switch (m) {
  RouteMode.auto => PIcon.bolt,
  RouteMode.stealth => PIcon.lock,
  RouteMode.speed => PIcon.download,
  RouteMode.classic => PIcon.layers,
};
