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
    final xhttp = diagnose(
      'Get "https://…/generate_204": io: read/write on closed pipe',
    );
    expect(xhttp.cause, Cause.path);
    expect(xhttp.fixer, Fixer.service);
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

  test('link shape: settings to compare, nothing that names or opens a server', () {
    final wg = linkShape(
      'wireguard://cHJpdmF0ZQ%3D%3D@wg.example.com:51820?address=10.8.0.2%2F32'
      '&publickey=c2VydmVy&reserved=0%2C0%2C0&allowedips=0.0.0.0%2F0&mtu=1420'
      '&keepalive=25&dns=1.1.1.1#DE%207',
    );
    expect(
      wg,
      'wireguard name:51820 address=v4/32 publickey=set reserved=0,0,0 '
      'allowedips=0.0.0.0/0 mtu=1420 keepalive=25 dns=set',
    );
    expect(wg, isNot(contains('example')));
    expect(wg, isNot(contains('c2VydmVy')));
    expect(
      linkShape('wireguard://k@5.6.7.8:443?publickey=p#x'),
      'wireguard ipv4:443 publickey=set',
    );
    final vl = linkShape(
      'vless://0b8c1e2a-1111-4222-8333-444455556666@de1.example.com:443'
      '?security=tls&type=ws&path=%2Fws&host=cdn.example.com&sni=cdn.example.com&alpn=h2%2Chttp%2F1.1&fp=chrome#x',
    );
    expect(
      vl,
      'vless name:443 security=tls type=ws path=set host=set sni=set '
      'alpn=h2,http/1.1 fp=chrome',
    );
    expect(vl, isNot(contains('0b8c1e2a')));
  });
}
