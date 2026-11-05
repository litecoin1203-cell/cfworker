import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/design/tokens.dart';
import 'package:pleat/main.dart';
import 'package:pleat/screens/profile.dart';
import 'package:pleat/state/app_state.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'fakes.dart';

const fontDir = String.fromEnvironment('FONTS');

Future<void> shot(WidgetTester tester, String name, {bool open = false, double h = 844, int scroll = 0}) async {
  final loader = FontLoader('PleatShot');
  for (final x in [300, 500, 600, 700]) {
    final b = File('$fontDir/pjs$x.ttf').readAsBytesSync();
    loader.addFont(Future.value(ByteData.view(b.buffer)));
  }
  await loader.load();
  PType.familyOverride = 'PleatShot';
  tester.view.physicalSize = Size(390 * 2, h * 2);
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({'onboarded': true});
  final api = FakeApi(MemoryTokens(signedIn: true))
    ..tgVerified = true
    ..email = 'mohammadreza.hosseini.tehran1990@gmail.com';
  final state = AppState(await SharedPreferences.getInstance(), api, tunnel: FakeTunnel());
  await state.refreshAccount();
  await tester.pumpWidget(PleatApp(state: state));
  for (var i = 0; i < 30; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.tap(find.byType(Avatar).first);
  for (var i = 0; i < 20; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  if (open) {
    await tester.tap(find.text('Data and days'));
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    if (scroll > 0) {
      await tester.drag(find.byType(SingleChildScrollView).last, Offset(0, -scroll.toDouble()));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }
  }
  await expectLater(find.byType(MaterialApp), matchesGoldenFile('shots/$name.png'));
}

void main() {
  testWidgets('profile', (t) => shot(t, 'a_profile'));
  testWidgets('sheet', (t) => shot(t, 'b_sheet', open: true));
  testWidgets('sheet2', (t) => shot(t, 'c_sheet_packages', open: true, scroll: 500));
}
