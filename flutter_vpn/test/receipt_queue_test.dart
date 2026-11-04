import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/models.dart';
import 'package:pleat/state/app_state.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a receipt that can’t be sent is kept and sent later, '
      'with the same upload id', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final api = FakeApi(MemoryTokens(signedIn: true))..uploadOffline = true;
    final app = AppState(prefs, api, tunnel: FakeTunnel());
    final o = Order.fromJson(api.order('card').cast<String, dynamic>());
    final photo = List.filled(1000, 7);

    expect(await app.sendReceipt(o, photo, '123'), isNull);
    expect(app.pendingReceipts.keys, [o.id]);
    final kept = app.pendingReceipts[o.id]!;
    expect(File(kept.path).readAsBytesSync(), photo);

    // A new launch still knows about it.
    final next = AppState(prefs, api, tunnel: FakeTunnel());
    expect(next.pendingReceipts.keys, [o.id]);

    // Still no line: it stays.
    await next.flushReceipts();
    expect(next.pendingReceipts, isNotEmpty);

    api.uploadOffline = false;
    await next.flushReceipts();
    expect(next.pendingReceipts, isEmpty);
    expect(File(kept.path).existsSync(), isFalse);
    expect(api.uploads.single['upload_id'], kept.id);
    expect(api.uploads.single['ref'], '123');
    expect(api.uploads.single['bytes'], '1000');
    app.dispose();
    next.dispose();
  });

  test('a receipt sent at once leaves nothing behind', () async {
    SharedPreferences.setMockInitialValues({});
    final api = FakeApi(MemoryTokens(signedIn: true));
    final app = AppState(
      await SharedPreferences.getInstance(),
      api,
      tunnel: FakeTunnel(),
    );
    final o = Order.fromJson(api.order('card').cast<String, dynamic>());
    final sent = await app.sendReceipt(o, [1, 2, 3], '');
    expect(sent!.status, 'review');
    expect(app.pendingReceipts, isEmpty);
    expect(api.uploads.single['upload_id'], hasLength(24));
    app.dispose();
  });
}
