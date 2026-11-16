// PERF-A-04: coming back to the app reads the plan (/me, which reads every
// panel live) at most once a minute, not on every app switch.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/state/app_state.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a quick switch back does not read /me again', () async {
    SharedPreferences.setMockInitialValues({'onboarded': true});
    final api = FakeApi(MemoryTokens(signedIn: true));
    final app = AppState(
      await SharedPreferences.getInstance(),
      api,
      tunnel: FakeTunnel(),
    );
    await app.refreshAccount();
    int reads() => api.calls.where((c) => c == 'GET /me').length;
    Future<void> back() async {
      app.didChangeAppLifecycleState(AppLifecycleState.paused);
      app.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await Future<void>.delayed(Duration.zero);
    }

    final start = reads();
    // just loaded by refreshAccount: switching to Telegram and back reads
    // nothing
    await back();
    await back();
    expect(reads() - start, 0);
    // a minute later it reads once more
    app.meAt = DateTime.now().subtract(AppState.meOnResumeGap * 2);
    await back();
    expect(reads() - start, 1);
    await back();
    expect(reads() - start, 1);
  });
}
