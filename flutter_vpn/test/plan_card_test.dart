import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/models.dart';
import 'package:pleat/screens/store_kit.dart';

PlanInfo plan(int gb, int days) =>
    PlanInfo.fromJson({'duration_days': days, 'data_limit_gb': gb});

void main() {
  test('data size is the big number, duration the small line', () {
    final p = plan(50, 30);
    expect(planBig(p), '50');
    expect(planUnit(p, days: p.durationDays), 'GB\n30 days');
  });

  test('no data cap shows infinity', () {
    final p = plan(0, 30);
    expect(planBig(p), '∞');
    expect(planUnit(p, days: 30), 'No data cap\n30 days');
  });

  test('trial keeps the data size big and says free', () {
    final p = plan(5, 30);
    expect(planBig(p), '5');
    expect(planUnit(p, days: 1, free: true), 'GB\n1 day free');
  });
}
