import 'package:flutter/material.dart';

import '../api/models.dart';
import '../design/icons.dart';
import '../design/nav.dart';
import '../design/scenes.dart';
import '../design/shard_field.dart';
import '../design/tokens.dart';
import '../design/widgets.dart';
import '../state/app_state.dart';
import 'activity.dart';
import 'avatar_gate.dart';
import 'home.dart';
import 'locations.dart';
import 'plan_usage.dart';
import 'protect.dart';
import 'route_extras.dart';
import 'update.dart';

/// Scroll position of the visible tab, for shard parallax.
class ShellScroll extends InheritedWidget {
  const ShellScroll({super.key, required this.offset, required super.child});
  final ValueNotifier<double> offset;

  static ValueNotifier<double>? of(BuildContext context) =>
      context.getInheritedWidgetOfExactType<ShellScroll>()?.offset;

  @override
  bool updateShouldNotify(ShellScroll old) => false;
}

/// Reports vertical scrolling of [child] to the shard field.
class ParallaxScroll extends StatelessWidget {
  const ParallaxScroll({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return NotificationListener<ScrollUpdateNotification>(
      onNotification: (n) {
        if (n.depth == 0 && n.metrics.axis == Axis.vertical) {
          ShellScroll.of(context)?.value = n.metrics.pixels;
        }
        return false;
      },
      child: child,
    );
  }
}

const navItems = [
  NavItem(PIcon.home, 'Home'),
  NavItem(PIcon.shield, 'Protect'),
  NavItem(PIcon.pin, 'Locations'),
  NavItem(PIcon.pulse, 'Activity'),
];

/// The signed-in frame: one shard field behind every tab, the tabs, and
/// the travelling-circle nav.
class Shell extends StatefulWidget {
  const Shell({super.key});

  /// Builds of the Shell so far, counted in debug builds only (tests).
  static int debugBuilds = 0;

  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  final _scroll = ValueNotifier<double>(0);
  AppState? _app;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final app = AppScope.read(context);
    if (app == _app) return;
    _app?.updateSheet.removeListener(_showUpdate);
    _app?.lockAskSheet.removeListener(_showLockAsk);
    _app = app
      ..updateSheet.addListener(_showUpdate)
      ..lockAskSheet.addListener(_showLockAsk);
    // a must-update announced before this screen was built
    if (app.mustUpdate) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _showUpdate());
    }
  }

  void _showUpdate() {
    if (mounted) showUpdateSheet(context);
  }

  /// Stay in one country: nothing in it answered; one popup at a time.
  bool _asking = false;
  void _showLockAsk() {
    if (!mounted || _asking || _app?.lockAsk == null) return;
    _asking = true;
    showLockAsk(context).whenComplete(() => _asking = false);
  }

  @override
  void dispose() {
    _app?.updateSheet.removeListener(_showUpdate);
    _app?.lockAskSheet.removeListener(_showLockAsk);
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Only what the Shell itself shows rebuilds it (PERF-A-01): the pages
    // follow the app on their own, and a test of every exit used to
    // rebuild the shard field and the nav once per exit.
    return AppSelect(
      select: (app) => (
        avatar: app.needsAvatar,
        tab: app.tab,
        scene: (app.phase, app.category, app.exit?.bearing),
      ),
      builder: (context, app, _) => _build(context, app),
    );
  }

  Widget _build(BuildContext context, AppState app) {
    assert(() {
      Shell.debugBuilds++;
      return true;
    }());
    // First sign-in: a character has to be picked before Home.
    if (app.needsAvatar) return const AvatarGate();
    final reduced = PMotion.reduced(context);
    const pages = [
      HomeScreen(),
      ProtectScreen(),
      LocationsScreen(),
      ActivityScreen(),
    ];
    return ShellScroll(
      offset: _scroll,
      child: Scaffold(
        backgroundColor: PColors.ground,
        extendBody: true,
        body: Stack(
          fit: StackFit.expand,
          children: [
            ShardField(scene: sceneFor(app), scroll: _scroll),
            // Tabs cross-fade while the shards travel to the new layout.
            AnimatedSwitcher(
              duration: reduced ? Duration.zero : PMotion.quick,
              switchInCurve: Curves.easeOut,
              switchOutCurve: Curves.easeIn,
              child: KeyedSubtree(
                key: ValueKey(app.tab),
                child: pages[app.tab],
              ),
            ),
          ],
        ),
        bottomNavigationBar: PleatNav(
          items: navItems,
          index: app.tab,
          onSelect: (i) {
            _scroll.value = 0;
            app.setTab(i);
          },
        ),
      ),
    );
  }
}

/// Bell sheet: the store's announcement and what `/me` says about the
/// plan (usage, end date, a stopped plan).
Future<void> showNotices(BuildContext context) {
  final app = AppScope.read(context);
  final notices = app.notices;
  app.markNoticesSeen();
  final outer = context;
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    barrierColor: PColors.scrim,
    isScrollControlled: true,
    builder: (context) => Container(
      decoration: BoxDecoration(
        color: PColors.surface,
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(PRadius.sheet),
        ),
      ),
      padding: EdgeInsets.fromLTRB(
        24,
        14,
        24,
        24 + MediaQuery.paddingOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
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
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(child: Text('Notices', style: PType.h2())),
              RoundIcon(
                PIcon.close,
                onTap: () => Navigator.of(context).pop(),
                label: 'Close',
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (notices.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(
                'Nothing new. Plan and usage notices show up here.',
                style: PType.small(),
              ),
            ),
          for (var i = 0; i < notices.length; i++)
            StaggerIn(
              index: i,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(
                        color: PColors.mist,
                        shape: BoxShape.circle,
                      ),
                      alignment: Alignment.center,
                      child: PIconView(
                        notices[i].alert ? PIcon.bolt : PIcon.info,
                        size: 20,
                        color: notices[i].alert
                            ? PColors.navy
                            : PColors.accentInk,
                      ),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            notices[i].title,
                            style: PType.h3().copyWith(fontSize: 15),
                          ),
                          const SizedBox(height: 3),
                          Text(
                            notices[i].body,
                            style: PType.small(),
                            // UX-03: the admin's announcement may be
                            // Persian; it reads right to left, not
                            // scrambled in an LTR line
                            textDirection: rtlText(notices[i].body)
                                ? TextDirection.rtl
                                : TextDirection.ltr,
                          ),
                          if (notices[i].action == 'plans') ...[
                            const SizedBox(height: 10),
                            PillButton(
                              label: 'See plans',
                              height: 40,
                              expand: false,
                              onTap: () {
                                Navigator.of(context).pop();
                                openPlans(outer);
                              },
                            ),
                          ],
                          if (notices[i].action == 'update') ...[
                            const SizedBox(height: 10),
                            PillButton(
                              label: 'Update',
                              icon: PIcon.refresh,
                              height: 40,
                              expand: false,
                              onTap: () {
                                Navigator.of(context).pop();
                                app.openUpdate();
                              },
                            ),
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    ),
  );
}
