import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/state/net_cache.dart';

void main() {
  test('results are kept per network and survive a save', () {
    final now = DateTime(2026, 10, 31, 12);
    final c = NetCache({})
      ..putPing('44244', 'k1', 80, now)
      ..putSpeed('44244', 'k1', 9000, now)
      ..putPing('197207', 'k1', -1, now)
      ..markTested('44244', now);
    final back = NetCache.decode(c.encode(now: now));
    expect(back.get('44244', 'k1')!.ms, 80);
    expect(back.get('44244', 'k1')!.kbps, 9000);
    expect(back.get('197207', 'k1')!.ms, -1);
    expect(back.get('197207', 'k1')!.kbps, isNull);
    expect(back.testedAt('44244'), now);
    expect(back.testedAt('197207'), isNull);
    expect(back.has('58224'), isFalse);
  });

  test('old results and extra networks are dropped', () {
    final now = DateTime(2026, 10, 31);
    final c = NetCache({})
      ..putPing('1', 'k', 50, now.subtract(const Duration(days: 4)));
    for (var i = 0; i < NetCache.keepNetworks + 2; i++) {
      c.putPing('n$i', 'k', 50, now.subtract(Duration(minutes: i)));
    }
    final back = NetCache.decode(c.encode(now: now));
    expect(back.has('1'), isFalse);
    expect(back.has('n0'), isTrue);
    expect(back.has('n${NetCache.keepNetworks + 1}'), isFalse);
  });

  test('a cache that no longer parses starts empty', () {
    expect(NetCache.decode('{"n": 3}').has('1'), isFalse);
    expect(NetCache.decode('not json').has('1'), isFalse);
  });
}
