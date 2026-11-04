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
    expect(st['wsSettings'], {'path': '/ws', 'host': 'cdn.example.com'});
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

  test('host extras: ECH, ML-DSA, gRPC authority, XHTTP extra', () {
    Map st(String l) => outboundOf(l)['streamSettings'] as Map;
    final tls = st(
      'vless://u@h.example.com:443?security=tls&type=tcp&ech=AEX%2B0ABB&fp=chrome#x',
    );
    expect(tls['tlsSettings']['echConfigList'], 'AEX+0ABB');
    final reality = st(
      'vless://u@h.example.com:443?security=reality&pbk=k&sid=1&pqv=PQ#x',
    );
    expect(reality['realitySettings']['mldsa65Verify'], 'PQ');
    final grpc = st(
      'vless://u@h.example.com:443?security=tls&type=grpc&serviceName=g&authority=a.example.com#x',
    );
    expect(grpc['grpcSettings']['authority'], 'a.example.com');
    final xhttp = st(
      'vless://u@h.example.com:443?security=tls&type=xhttp&path=%2Fx&extra=%7B%22xPaddingBytes%22%3A%22100-1000%22%7D#x',
    );
    expect(xhttp['xhttpSettings']['extra'], {'xPaddingBytes': '100-1000'});
    final bad = st(
      'vless://u@h.example.com:443?security=tls&type=xhttp&extra=nope#x',
    );
    expect((bad['xhttpSettings'] as Map).containsKey('extra'), isFalse);
  });

  test('as v2rayNG reads links: empty values, +, pinned certs, masks', () {
    final st = _out(
      'vless://u@151.101.0.1:443?security=tls&type=xhttp&path=&host=edge.example.net'
      '&sni=&fp=firefox&alpn=h2&pcs=AB12&vcn=&ech=AB%2Bc+d%3D'
      '&extra=%7B%22a%22%3A%22x+y%22%7D&fm=%7B%22tcp%22%3A%5B%5D%7D#x',
    )['streamSettings'];
    final tls = st['tlsSettings'];
    // No sni: the host header's name, never the bare IP address.
    expect(tls['serverName'], 'edge.example.net');
    expect(tls['pinnedPeerCertSha256'], 'AB12');
    expect(tls.containsKey('verifyPeerCertByName'), isFalse);
    expect(tls.containsKey('allowInsecure'), isFalse);
    expect(tls['echConfigList'], 'AB+c+d=');
    expect(st['xhttpSettings']['path'], '/');
    expect(st['xhttpSettings'].containsKey('mode'), isFalse);
    expect(st['xhttpSettings']['extra'], {'a': 'x+y'});
    expect(st['finalmask'], {'tcp': []});

    final named = _out(
      'vless://u@151.101.0.1:443?security=tls&type=xhttp&sni=www.example.com'
      '&host=edge.example.net&mode=auto#x',
    )['streamSettings'];
    expect(named['tlsSettings']['serverName'], 'www.example.com');
    expect(named['xhttpSettings']['mode'], 'auto');

    final insecure = _out(
      'trojan://p@1.2.3.4:443?allow_insecure=1#x',
    )['streamSettings']['tlsSettings'];
    expect(insecure['allowInsecure'], true);
    expect(insecure.containsKey('serverName'), isFalse);
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

  test('hysteria2: auth, TLS, salamander, port hopping, pin', () {
    final o = outboundOf(
      'hysteria2://p%40ss@hy.example.com:443,20000-30000/?sni=cdn.example.com'
      '&obfs=salamander&obfs-password=ob&insecure=1&alpn=h3#x',
    );
    expect(o['protocol'], 'hysteria');
    expect(o['settings'], {
      'version': 2,
      'address': 'hy.example.com',
      'port': 443,
    });
    final st = o['streamSettings'] as Map;
    expect(st['network'], 'hysteria');
    expect(st['security'], 'tls');
    expect((st['hysteriaSettings'] as Map)['auth'], 'p@ss');
    expect((st['hysteriaSettings'] as Map)['version'], 2);
    final tls = st['tlsSettings'] as Map;
    expect(tls['serverName'], 'cdn.example.com');
    expect(tls['allowInsecure'], true);
    expect(tls['alpn'], ['h3']);
    final mask = st['finalmask'] as Map;
    expect(mask['udp'], [
      {
        'type': 'salamander',
        'settings': {'password': 'ob'},
      },
    ]);
    expect(mask['quicParams'], {
      'udpHop': {'ports': '443,20000-30000'},
    });

    final hy = outboundOf('hy2://pw@1.2.3.4:8443?pinSHA256=ab12#x');
    final hst = hy['streamSettings'] as Map;
    expect((hy['settings'] as Map)['port'], 8443);
    expect(hst.containsKey('finalmask'), false);
    expect((hst['tlsSettings'] as Map)['pinnedPeerCertSha256'], 'ab12');
    expect(
      () => outboundOf('hysteria2://pw@h.example.com#x'),
      throwsFormatException,
    );
  });

  test('wireguard as Rebecca shares it', () {
    // the private key is url-escaped in the userinfo, as Go's url.User does
    final o = outboundOf(
      'wireguard://${Uri.encodeComponent('cGl2YXRla2V5cHJpdmF0ZWtleXByaXZhdGVrZXk/AA=')}'
      '@wg.example.com:51820?address=10.8.0.2%2F32&publickey=c2VydmVya2V5c2VydmVya2V5c2VydmVya2V5c2U%2BAA%3D'
      '&reserved=1%2C2%2C3&allowedips=0.0.0.0%2F0&dns=1.1.1.1&mtu=1380&keepalive=25#x',
    );
    expect(o['protocol'], 'wireguard');
    final s = o['settings'] as Map;
    expect(s['secretKey'], 'cGl2YXRla2V5cHJpdmF0ZWtleXByaXZhdGVrZXk/AA=');
    expect(s['address'], ['10.8.0.2/32']);
    expect(s['mtu'], 1380);
    expect(s['reserved'], [1, 2, 3]);
    expect(s['noKernelTun'], true);
    final peer = (s['peers'] as List).single as Map;
    expect(peer['publicKey'], 'c2VydmVya2V5c2VydmVya2V5c2VydmVya2V5c2U+AA=');
    expect(peer['endpoint'], 'wg.example.com:51820');
    expect(peer['keepAlive'], 25);
    expect(peer['allowedIPs'], ['0.0.0.0/0', '::/0']);

    final v6 = outboundOf(
      'wg://k@[2001:db8::1]:51820?publickey=p&reserved=0%2C0%2C0#x',
    );
    final v6s = v6['settings'] as Map;
    expect(
      ((v6s['peers'] as List).single as Map)['endpoint'],
      '[2001:db8::1]:51820',
    );
    expect(v6s.containsKey('address'), false);
    expect(
      () => outboundOf('wireguard://k@h.example.com:51820#x'),
      throwsFormatException,
    );
  });

  test('unsupported protocols are refused, not guessed', () {
    expect(() => outboundOf('tuic://x@h:443'), throwsFormatException);
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
      'vless_xhttp_extra':
          'vless://$uuid@de1.example.com:443?security=tls&type=xhttp&path=%2Fx&mode=packet-up&extra=%7B%22xPaddingBytes%22%3A%22100-1000%22%2C%22noGRPCHeader%22%3Afalse%7D#x',
      'vless_grpc_authority':
          'vless://$uuid@de1.example.com:443?security=tls&type=grpc&serviceName=g&authority=cdn.example.com#x',
      // An exit behind a CDN: IP address, another site's SNI, pinned cert.
      'vless_xhttp_fronted':
          'vless://$uuid@151.101.0.1:443?security=tls&type=xhttp&path=%2F&host=edge.example.net&mode=auto&sni=www.example.com&fp=firefox&alpn=h2&pcs=0000000000000000000000000000000000000000000000000000000000000000&vcn=&extra=%7B%22xPaddingBytes%22%3A%22100-1000%22%7D#x',
      'vless_tls_fm':
          'vless://$uuid@de1.example.com:443?security=tls&type=tcp&sni=de1.example.com&fm=%7B%22tcp%22%3A%5B%7B%22type%22%3A%22fragment%22%2C%22settings%22%3A%7B%22packets%22%3A%22tlshello%22%2C%22length%22%3A%22100-200%22%2C%22delay%22%3A%2210-20%22%7D%7D%5D%7D#x',
      'ss2022':
          'ss://2022-blake3-aes-256-gcm:${Uri.encodeComponent('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=')}@de1.example.com:443#x',
      'trojan': 'trojan://pass@us1.example.com:443#x',
      'vmess_ws': 'vmess://$vmess',
      'ss': 'ss://YWVzLTI1Ni1nY206cHc@1.2.3.4:8388#x',
      'hysteria2': 'hysteria2://pw@hy.example.com:443,20000-30000/?sni=hy.example.com&obfs=salamander&obfs-password=ob#x',
      'hysteria2_plain': 'hy2://pw@1.2.3.4:8443?insecure=1#x',
      'wireguard':
          'wireguard://${Uri.encodeComponent('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=')}@wg.example.com:51820'
          '?address=10.8.0.2%2F32&publickey=AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI%3D&reserved=0%2C0%2C0&mtu=1420&keepalive=25#x',
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
