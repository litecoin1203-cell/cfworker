import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/api/models.dart';
import 'package:pleat/state/diagnose.dart';
import 'package:pleat/state/exits.dart';

Exit _exit(String name, String link, {int? ms, String? error}) {
  final e = Exit(
    Server.fromJson({
      'index': 0,
      'name': name,
      'country_code': name.substring(0, 2),
      'protocol': link.split('://').first,
      'link': link,
    }),
    null,
  );
  e.measured = ms;
  e.failure = error;
  return e;
}

void main() {
  test('the core\'s words map to a cause and who can fix it', () {
    expect(diagnose(null).cause, Cause.timeout);
    expect(diagnose('… > context deadline exceeded').cause, Cause.timeout);
    expect(diagnose('read tcp …: connection reset by peer').cause, Cause.reset);
    expect(
      diagnose('dial tcp …: connect: connection refused').fixer,
      Fixer.service,
    );
    expect(diagnose('lookup …: no such host').cause, Cause.dns);
    expect(
      diagnose('dial tcp: connect: network is unreachable').cause,
      Cause.offline,
    );
    expect(
      diagnose('tls: failed to verify certificate: x509: …').cause,
      Cause.tls,
    );
    expect(
      diagnose('REALITY: processed invalid connection').cause,
      Cause.reality,
    );
    expect(
      diagnose('proxy/vless/inbound: invalid request user id').cause,
      Cause.account,
    );
    expect(diagnose('unsupported: bad port').cause, Cause.config);
    expect(diagnose('something new').cause, Cause.unknown);
    expect(diagnose('something new').fix, 'something new');
  });

  test('transport names', () {
    expect(
      transportOf('vless://u@h.example.com:443?security=reality&pbk=k#x'),
      'REALITY',
    );
    expect(
      transportOf('vless://u@h.example.com:443?security=tls&type=ws#x'),
      'TLS · WS',
    );
    expect(transportOf('ss://YWVzLTI1Ni1nY206cHc@1.2.3.4:8388#x'), 'plain');
  });

  test('a run sums up what works here and what to do', () {
    final exits = [
      _exit(
        'GB 1',
        'vless://u@a.example.com:443?security=reality&pbk=k#x',
        ms: 130,
      ),
      _exit(
        'CH 1',
        'vless://u@b.example.com:443?security=reality&pbk=k#x',
        ms: 573,
      ),
      _exit(
        'DE 1',
        'vless://u@c.example.com:443?security=tls&type=ws#x',
        ms: -1,
        error: 'connection reset by peer',
      ),
      _exit(
        'FI 1',
        'vless://u@d.example.com:443?security=tls&type=ws#x',
        ms: -1,
        error: 'connection refused',
      ),
    ];
    final f = summarize(exits, smart: false, localDirect: false);
    expect(f.first.title, '2 of 4 exits work here');
    expect(f.first.body, contains('GB 1'));
    expect(f.first.body, contains('Smart connect'));
    expect(
      f.map((x) => x.title),
      contains('What gets through on this network'),
    );
    expect(
      f.firstWhere((x) => x.title.contains('server-side')).body,
      contains('FI 1'),
    );
    expect(f.map((x) => x.title), contains('Faster local sites'));
    final text = report(
      exits,
      app: '1.2.0',
      device: 'Phone, Android 14',
      at: DateTime.utc(2026),
    );
    expect(text, contains('GB 1 · VLESS · REALITY · OK 130 ms'));
    expect(text, contains('FI 1 · VLESS · TLS · WS · FAIL refused'));
    expect(text, isNot(contains('example.com')));
  });

  test('nothing answering points at the network', () {
    final exits = [
      _exit(
        'GB 1',
        'vless://u@a.example.com:443#x',
        ms: -1,
        error: 'i/o timeout',
      ),
      _exit('DE 1', 'vless://u@c.example.com:443#x', ms: -1),
    ];
    final f = summarize(exits, smart: true, localDirect: true);
    expect(f.first.title, 'Nothing answers from this network');
    expect(f.first.body, contains('Wi-Fi'));
  });
}
