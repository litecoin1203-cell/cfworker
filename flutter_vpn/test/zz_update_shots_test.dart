// LOCAL ONLY (not committed): renders the update / version / night previews.
// flutter test test/zz_update_shots_test.dart --update-goldens
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/screens/profile.dart';
import 'package:pleat/screens/update_variants.dart';
import 'package:pleat/state/app_state.dart';
import 'package:pleat/state/updater.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

const _fonts =
    '/tmp/claude-0/-home-user/7f56533a-4593-5159-90eb-146161e8c741/scratchpad/fonts';

class _Api extends FakeApi {
  _Api(super.tokens);
  static bool force = false;
  static bool offer = true;
  @override
  Future<dynamic> get(String path, {bool bridge = true}) async {
    final r = await super.get(path, bridge: bridge);
    if (path == '/app-config' && r is Map && offer) {
      return {
        ...r.cast<String, Object?>(),
        'update': {
          'version': '1.2.30',
          'build': 33,
          'tag': '33-abc',
          'force': force,
          'abis': {
            'arm64-v8a': {'size': 74868736, 'sha256': 'a' * 64},
          },
        },
      };
    }
    return r;
  }
}

Future<void> _loadFonts() async {
  final f = FontLoader('PleatTest');
  for (final w in [300, 400, 500, 600, 700, 800]) {
    f.addFont(
      Future.value(
        ByteData.sublistView(File('$_fonts/pjs-$w.ttf').readAsBytesSync()),
      ),
    );
  }
  await f.load();
  final e = FontLoader('Emoji')
    ..addFont(
      Future.value(
        ByteData.sublistView(File('$_fonts/emoji.ttf').readAsBytesSync()),
      ),
    );
  await e.load();
  PType.familyOverride = 'PleatTest';
  PType.emojiFallback = ['Emoji'];
}

Future<AppState> _boot(
  WidgetTester tester, {
  bool night = false,
  double tall = 1,
}) async {
  tester.view.physicalSize = Size(1080, 2340 * tall);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(const MethodChannel('pleat/update'), (
        call,
      ) async {
        if (call.method == 'info') {
          return {'version': '1.2.29', 'build': 32, 'abi': 'arm64-v8a'};
        }
        return null;
      });
  SharedPreferences.setMockInitialValues({
    'onboarded': true,
    'theme': night ? 'night' : 'day',
  });
  final api = _Api(MemoryTokens(signedIn: true))
    ..tgVerified = true
    ..avatar = 'kite';
  final state = AppState(await SharedPreferences.getInstance(), api);
  await state.refreshAccount();
  await tester.pumpWidget(PleatApp(state: state));
  for (var i = 0; i < 30; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  return state;
}

Future<void> _settle(WidgetTester t, [int n = 12]) async {
  for (var i = 0; i < n; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
}

Future<void> _shot(WidgetTester t, String name) async {
  await expectLater(find.byType(PleatApp), matchesGoldenFile('shots/$name.png'));
}

Future<void> _close(WidgetTester t) async {
  final nav = t.state<NavigatorState>(find.byType(Navigator).last);
  nav.pop();
  await _settle(t, 6);
}

void _downloading(AppState app, double f) {
  app.updater
    ..step = UpdateStep.downloading
    ..total = 74868736
    ..received = (74868736 * f).round();
  app.update((_) {});
}

void main() {
  setUpAll(_loadFonts);
  tearDown(() {
    Knobs.update = 'now';
    Knobs.version = 'now';
    Knobs.night = 'now';
  });

  // ── current, for comparison
  testWidgets('now', (t) async {
    final app = await _boot(t);
    await _shot(t, 'now-home');
    app.openUpdate();
    await _settle(t);
    await _shot(t, 'now-sheet');
    await _close(t);
  });

  testWidgets('now profile', (t) async {
    await _boot(t, tall: 1.75);
    Navigator.of(t.element(find.byType(Navigator).first))
        .push(PageRouteBuilder(pageBuilder: (_, _, _) => const ProfileScreen()));
    await _settle(t, 15);
    await _shot(t, 'now-profile');
  });

  for (final dir in ['unfold', 'orbit', 'pass']) {
    for (final night in [false, true]) {
      final tag = night ? 'night' : 'day';
      testWidgets('$dir $tag', (t) async {
        Knobs.update = dir;
        final app = await _boot(t, night: night);
        await _shot(t, '$dir-$tag-home');
        app.openUpdate();
        await _settle(t);
        await _shot(t, '$dir-$tag-ready');
        _downloading(app, 0.38);
        await _settle(t, 4);
        await _shot(t, '$dir-$tag-busy');
        await _close(t);
      });
    }
  }

  testWidgets('unfold must', (t) async {
    Knobs.update = 'unfold';
    _Api.force = true;
    addTearDown(() => _Api.force = false);
    final app = await _boot(t);
    app.openUpdate();
    await _settle(t);
    await _shot(t, 'unfold-must');
    await _close(t);
  });

  for (final v in ['footer', 'tag', 'about']) {
    testWidgets('version $v', (t) async {
      Knobs.version = v;
      _Api.offer = false;
      addTearDown(() => _Api.offer = true);
      await _boot(t, tall: 1.85);
      Navigator.of(t.element(find.byType(Navigator).first))
          .push(PageRouteBuilder(pageBuilder: (_, _, _) => const ProfileScreen()));
      await _settle(t, 15);
      await _shot(t, 'version-$v');
    });
  }

  for (final n in ['home', 'hero', 'tiles']) {
    for (final night in [false, true]) {
      final tag = night ? 'night' : 'day';
      testWidgets('night $n $tag', (t) async {
        Knobs.night = n;
        Knobs.update = 'unfold';
        Knobs.version = 'tag';
        _Api.offer = false;
        addTearDown(() => _Api.offer = true);
        await _boot(t, night: night, tall: n == 'home' ? 1 : 1.0);
        if (n != 'home') {
          Navigator.of(t.element(find.byType(Navigator).first)).push(
            PageRouteBuilder(pageBuilder: (_, _, _) => const ProfileScreen()),
          );
          await _settle(t, 15);
        }
        await _shot(t, 'night-$n-$tag');
      });
    }
  }
}
