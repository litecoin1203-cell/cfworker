import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pleat/state/xray_config.dart';

Map<String, dynamic> _out(String link) =>
    jsonDecode(jsonEncode(outboundOf(link))) as Map<String, dynamic>;

void main() {
  test('vless reality over tcp', () {
    final o = _out(
      'vless://0b8c-uuid@nl1.example.com:443?encryption=none&security=reality'
      '&sni=www.microsoft.com&fp=chrome&pbk=PUBKEY&sid=ab12&type=tcp'
      '&flow=xtls-rprx-vision#%F0%9F%87%B3%F0%9F%87%B1%20NL%201',
    );
    final v = o['settings']['vnext'][0];
    expect((v['address'], v['port']), ('nl1.example.com', 443));
    expect(v['users'][0]['flow'], 'xtls-rprx-vision');
    final st = o['streamSettings'];
    expect(st['security'], 'reality');
    expect(st['realitySettings']['publicKey'], 'PUBKEY');
    expect(st['realitySettings']['serverName'], 'www.microsoft.com');
  });

  test('vless tls over websocket', () {
    final st = _out(
      'vless://u@de1.example.com:443?security=tls&type=ws&path=%2Fws&host=cdn.example.com#x',
    )['streamSettings'];
    expect(st['network'], 'ws');
    expect(st['wsSettings'], {
      'path': '/ws',
      'headers': {'Host': 'cdn.example.com'},
    });
    expect(st['tlsSettings']['serverName'], 'cdn.example.com');
  });

  test('trojan defaults to tls', () {
    final o = _out('trojan://pa%40ss@us1.example.com:8443#x');
    expect(o['settings']['servers'][0]['password'], 'pa@ss');
    expect(o['streamSettings']['security'], 'tls');
  });

  test('vmess json link', () {
    final body = base64.encode(
      utf8.encode(
        jsonEncode({
          'v': '2',
          'ps': 'DE 2',
          'add': 'a.example.com',
          'port': '2053',
          'id': 'uuid',
          'aid': '0',
          'net': 'grpc',
          'path': 'svc',
          'tls': 'tls',
          'sni': 'a.example.com',
        }),
      ),
    );
    final o = _out('vmess://$body');
    expect(o['settings']['vnext'][0]['port'], 2053);
    expect(o['streamSettings']['grpcSettings']['serviceName'], 'svc');
  });

  test('shadowsocks, both link forms', () {
    final a = _out('ss://YWVzLTI1Ni1nY206cHc@1.2.3.4:8388#x');
    final b = _out(
      'ss://${base64.encode(utf8.encode('aes-256-gcm:pw@1.2.3.4:8388'))}#x',
    );
    for (final o in [a, b]) {
      expect(o['settings']['servers'][0], {
        'address': '1.2.3.4',
        'port': 8388,
        'method': 'aes-256-gcm',
        'password': 'pw',
      });
    }
  });

  test('unsupported protocols are refused, not guessed', () {
    expect(() => outboundOf('hy2://x@h:443'), throwsFormatException);
    expect(() => outboundOf('vless://u@h:0'), throwsFormatException);
  });

  // CI writes every sample's full config and checks it with `xray run -test`.
  test('sample configs for the core', () {
    final out = Platform.environment['XRAY_DUMP'];
    if (out == null) return;
    final vmess = base64.encode(
      utf8.encode(
        jsonEncode({
          'add': 'a.example.com',
          'port': '443',
          'id': '0b8c1e2a-1111-4222-8333-444455556666',
          'net': 'ws',
          'path': '/v',
          'tls': 'tls',
        }),
      ),
    );
    const uuid = '0b8c1e2a-1111-4222-8333-444455556666';
    final samples = {
      'vless_reality':
          'vless://$uuid@nl1.example.com:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sid=ab12&type=tcp&flow=xtls-rprx-vision#x',
      'vless_ws_tls':
          'vless://$uuid@de1.example.com:443?security=tls&type=ws&path=%2Fws&host=cdn.example.com#x',
      'vless_grpc':
          'vless://$uuid@de1.example.com:443?security=tls&type=grpc&serviceName=g#x',
      'vless_xhttp':
          'vless://$uuid@de1.example.com:443?security=tls&type=xhttp&path=%2Fx#x',
      'trojan': 'trojan://pass@us1.example.com:443#x',
      'vmess_ws': 'vmess://$vmess',
      'ss': 'ss://YWVzLTI1Ni1nY206cHc@1.2.3.4:8388#x',
    };
    Directory(out).createSync(recursive: true);
    samples.forEach(
      (k, v) => File('$out/$k.json').writeAsStringSync(xrayConfig(v)),
    );
    // The Iran-direct rules need geoip:ir and geosite:category-ir.
    File('$out/local_direct.json')
        .writeAsStringSync(xrayConfig(samples['trojan']!, localDirect: true));
    File(
      '$out/ping_test.json',
    ).writeAsStringSync(xrayConfig(samples['vless_reality']!, forTest: true));
  });

  test('local direct: QUIC blocked, Iranian sites and IPs direct', () {
    final c = jsonDecode(
      xrayConfig('trojan://p@us1.example.com:443#x', localDirect: true),
    );
    final rules = c['routing']['rules'] as List;
    expect(rules[1], containsPair('network', 'udp'));
    expect(rules[1]['outboundTag'], 'block');
    expect(rules[2]['domain'], contains('geosite:category-ir'));
    expect(rules[3]['ip'], ['geoip:ir']);
    final plain = jsonDecode(xrayConfig('trojan://p@us1.example.com:443#x'));
    expect(plain['routing']['rules'], hasLength(1));
  });

  test('test config has no inbound, so it never takes the tunnel port', () {
    final c = jsonDecode(
      xrayConfig('trojan://p@us1.example.com:443#x', forTest: true),
    );
    expect(c['inbounds'], isEmpty);
  });

  test('full config: local socks in, private ranges direct', () {
    final c = jsonDecode(xrayConfig('trojan://p@us1.example.com:443#x'));
    expect(c['inbounds'][0]['listen'], '127.0.0.1');
    expect(c['inbounds'][0]['port'], socksPort);
    expect(c['outbounds'][0]['tag'], 'proxy');
    expect(c['routing']['rules'][0]['outboundTag'], 'direct');
  });
}
