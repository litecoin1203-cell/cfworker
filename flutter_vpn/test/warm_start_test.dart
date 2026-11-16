// PERF-A-05: the cached values shown at launch are read from the Keystore
// side by side, not one after another (each read is a decrypt that can take
// tens of ms on a cheap phone, all before the first frame).
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/state/app_state.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

class _SlowTokens extends MemoryTokens {
  _SlowTokens() : super(signedIn: true);
  int now = 0, most = 0, reads = 0;

  Future<String?> _slow(String? v) async {
    reads++;
    now++;
    if (now > most) most = now;
    await Future<void>.delayed(const Duration(milliseconds: 20));
    now--;
    return v;
  }

  @override
  Future<String?> cached(String key) async => _slow(await super.cached(key));

  @override
  Future<String?> cachedServers() async => _slow(await super.cachedServers());
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('warm start reads its caches in parallel', () async {
    SharedPreferences.setMockInitialValues({'onboarded': true});
    final tokens = _SlowTokens();
    final app = AppState(
      await SharedPreferences.getInstance(),
      FakeApi(tokens),
      tunnel: FakeTunnel(),
    );
    await app.warmStart();
    expect(tokens.reads, greaterThanOrEqualTo(5));
    expect(tokens.most, tokens.reads);
  });
}
