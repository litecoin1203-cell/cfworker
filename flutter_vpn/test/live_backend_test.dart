// Runs the real client and app state against a running Worker:
//   node --experimental-sqlite worker/test/dev_server.mjs
//   flutter test test/live_backend_test.dart --dart-define=LIVE_API=http://127.0.0.1:8787
import 'dart:io';
import 'dart:math';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/client.dart';
import 'package:pleat/state/app_state.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

const live = String.fromEnvironment('LIVE_API');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // flutter_test blocks real HTTP; this test is the one place that wants it.
  setUpAll(() => HttpOverrides.global = null);

  test('Pleat against the real Worker', () async {
    SharedPreferences.setMockInitialValues({});
    final log = <String>[];
    final api = ApiClient(MemoryTokens(), bases: live)
      ..trace = (m, p, s) => log.add('$s  $m $p');
    final app = AppState(await SharedPreferences.getInstance(), api);
    void step(String what) {
      log.add('-- $what');
    }

    step('public plans');
    await app.loadPublic();
    expect(app.plans.value, isNotEmpty);
    final trialPlan = app.plans.value!.firstWhere((p) => p.trialDays > 0);

    step('create account');
    final email = 'pleat${Random().nextInt(1 << 30)}@example.com';
    expect(await app.signIn(email, 'short1', create: true), isNotNull);
    expect(await app.signIn(email, 'password1', create: true), isNull);
    expect(app.email, email);
    expect(app.subscription, isNull);
    expect(app.servers.error, isNotNull, reason: 'no plan → 402');

    step('connect without a plan is refused');
    await app.connect();
    expect(app.phase, Phase.idle);
    expect(app.tunnelMessage, isNotNull);

    step('start trial');
    expect(await app.startTrial(trialPlan), isNull);
    expect(app.subscription!.active, isTrue);
    expect(await app.startTrial(trialPlan), isNotNull, reason: 'trial_used');

    step('server list = backend list');
    expect(app.exits.map((e) => e.code), containsAll(['NL', 'DE', 'US']));
    for (final e in app.exits) {
      expect('${e.title}${e.label}${e.meta}'.contains('example.com'), isFalse);
    }
    final de = app.exits.firstWhere((e) => e.code == 'DE');
    expect(de.ping, 95, reason: '/net/rank key matched');

    step('connect to the chosen exit');
    await app.connect(de.id);
    expect(app.exit!.id, de.id);
    expect(app.phase, Phase.idle, reason: 'no tunnel engine in this build');
    expect(app.tunnelMessage, contains('tunnel engine'));

    step('devices');
    await app.loadDevices();
    expect(app.devices.value!.single.current, isTrue);

    step('wallet purchase with no balance is refused');
    expect(await app.buyWithWallet(app.plans.value!.first), isNotNull);

    step('store: wallet, invite, coupon');
    final w = await app.wallet();
    expect(w.balance, 0);
    expect((await app.referral()).code, isNotEmpty);
    final plan = app.plans.value!.first;
    await expectLater(
      app.checkCoupon(plan, 'NOPE123'),
      throwsA(
        isA<ApiError>().having((e) => e.code, 'code', startsWith('coupon')),
      ),
    );

    step('store: card order, receipt, status');
    await app.loadPublic();
    expect(app.config.cardEnabled, isTrue);
    final card = await app.placeOrder(plan: plan, method: 'card');
    expect(card.status, 'pending');
    expect(card.card!.number, hasLength(16));
    expect(card.card!.bank, 'Bank Melli');
    expect(card.amountToman, greaterThanOrEqualTo(plan.priceToman));
    final png = [
      0x89,
      0x50,
      0x4E,
      0x47,
      0x0D,
      0x0A,
      0x1A,
      0x0A,
      ...List.filled(64, 0),
    ];
    final sent = await app.sendReceipt(card, png, '123456');
    expect(sent.status, 'review');
    expect((await app.orders()).map((o) => o.id), contains(card.id));

    step('store: top-up order, then cancel');
    final top = await app.placeOrder(topup: 100000, method: 'card');
    expect(top.kind, 'topup');
    expect((await app.cancelOrder(top)).status, 'cancelled');

    step('sign out');
    await app.signOut();
    expect(app.signedIn, isFalse);
    log.add('-- authed call after sign out');
    await expectLater(api.get('/me'), throwsA(isA<ApiError>()));

    debugPrint(log.join('\n'));
  }, skip: live.isEmpty ? 'set --dart-define=LIVE_API' : false);
}
