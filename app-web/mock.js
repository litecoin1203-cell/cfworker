/* Browser stand-in for the Android bridge (window.CGHost). Only loaded when the page runs outside the app:
   HTTP goes to a real Cloud Gold API (default http://127.0.0.1:8000), the VPN core is simulated. */
(function () {
  'use strict';
  if (window.CGHost) return;
  const API = (new URLSearchParams(location.search).get('api') || location.origin).replace(/\/$/, '');
  const LS = {
    get(k) { try { return JSON.parse(localStorage.getItem('mock_' + k)); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem('mock_' + k) : localStorage.setItem('mock_' + k, JSON.stringify(v)); } catch (e) {} },
  };
  const emit = (name, v) => setTimeout(() => window.__cgEvent(name, JSON.stringify(v)), 0);
  let deviceId = LS.get('device');
  if (!deviceId) { deviceId = 'web-' + Math.random().toString(36).slice(2, 10); LS.set('device', deviceId); }
  const vpn = { running: false, servers: LS.get('servers') || [], selected: LS.get('selected'), rx: 0, tx: 0 };

  async function http(method, path, body, isForm) {
    const send = async () => {
      const s = LS.get('session') || {};
      const headers = { 'X-Device-Id': deviceId, 'X-Device-Model': 'Web preview' };
      if (s.access_token) headers.Authorization = 'Bearer ' + s.access_token;
      if (body != null && !isForm) headers['Content-Type'] = 'application/json';
      const r = await fetch(API + '/api/v1' + path, { method, headers, body: body == null ? undefined : isForm ? body : JSON.stringify(body) });
      let data = null;
      try { data = await r.json(); } catch (e) {}
      return { status: r.status, data };
    };
    let r = await send();
    const s = LS.get('session');
    if (r.status === 401 && s && s.refresh_token && !path.startsWith('/auth/')) {
      const rr = await fetch(API + '/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }) });
      if (rr.ok) { LS.set('session', Object.assign(s, await rr.json())); r = await send(); } else LS.set('session', null);
    }
    return r;
  }
  function serverFromLink(link, i) {
    let name = decodeURIComponent((link.split('#')[1] || 'Server ' + (i + 1)));
    if (link.startsWith('vmess://')) { try { name = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(link.slice(8)), (c) => c.charCodeAt(0)))).ps || name; } catch (e) {} }
    let host = '';
    try { host = link.split('@')[1].split(/[:?#]/)[0]; } catch (e) {}
    // like the app: a stable key instead of the address (FNV-1a of type|host|port, see CgVpn.serverKey)
    const str = `${link.split('://')[0]}|${host}|443`.toLowerCase();
    let h = 0x811c9dc5;
    for (let j = 0; j < str.length; j++) { h ^= str.charCodeAt(j); h = Math.imul(h, 0x01000193) >>> 0; }
    return { guid: 'g' + i, remarks: name, k: 'k' + h.toString(16).padStart(8, '0'), type: link.split('://')[0] };
  }
  const H = {
    async api(a) { return http(a.method, a.path, a.body); },
    async session() { const s = LS.get('session'); return { loggedIn: !!(s && s.refresh_token), email: s && s.email, version: '1.0.0-web', core: '2.2.6', fontScale: +(new URLSearchParams(location.search).get('fs') || 1) }; },
    async setSession(a) { LS.set('session', a); return {}; },
    async logout() { LS.set('session', null); LS.set('servers', null); vpn.servers = []; vpn.running = false; emit('vpn', { running: false }); return {}; },
    async device() { return { id: deviceId, model: 'Web preview' }; },
    async vpnSync() {
      const r = await http('GET', '/vpn');
      if (r.status >= 400) throw r.data && r.data.detail ? r.data.detail : { message: 'Could not load your plan' };
      const l = await http('GET', '/vpn/servers');
      if (l.status >= 400) throw (l.data && l.data.detail) || { message: 'Could not load servers' };
      vpn.servers = l.data.map((s, i) => serverFromLink(s.link, i));
      if (!vpn.servers.find((s) => s.guid === vpn.selected)) vpn.selected = vpn.servers[0] && vpn.servers[0].guid;
      LS.set('servers', vpn.servers); LS.set('selected', vpn.selected);
      return { servers: vpn.servers, selected: vpn.selected };
    },
    async vpnServers() { return { servers: vpn.servers, selected: vpn.selected }; },
    async vpnConnect(a) {
      if (a.guid) { vpn.selected = a.guid; LS.set('selected', a.guid); }
      setTimeout(() => { vpn.running = true; emit('vpn', { running: true }); }, 1600);
      return {};
    },
    async vpnSelect(a) { vpn.selected = a.guid; LS.set('selected', a.guid); vpn.running = false; setTimeout(() => { vpn.running = true; emit('vpn', { running: true }); }, 1200); return {}; },
    async vpnDisconnect() { setTimeout(() => { vpn.running = false; emit('vpn', { running: false }); }, 700); return {}; },
    async vpnState() { return { running: vpn.running }; },
    async vpnPing() { if (vpn.running) setTimeout(() => emit('ping', { ms: 120 + Math.round(Math.random() * 60), ip: '45.128.199.56', cc: 'NL' }), 600); return {}; },
    async vpnTestAll() { vpn.servers.forEach((s, i) => setTimeout(() => emit('serverPing', { guid: s.guid, ms: 80 + Math.round(Math.random() * 300) }), 300 + i * 120)); return {}; },
    async traffic() {
      if (vpn.running) { vpn.rx += 200000 + Math.random() * 3e6; vpn.tx += 60000 + Math.random() * 1e6; }
      return { rx: vpn.rx, tx: vpn.tx };
    },
    async uploadReceipt(a) {
      // a 1x1 PNG stands in for the photo picker
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      const f = new FormData();
      f.append('file', new Blob([png], { type: 'image/png' }), 'receipt.png');
      f.append('ref', a.ref || '');
      return http('POST', a.path, f, true);
    },
    async openUrl(a) { console.log('[mock] open', a.url); return {}; },
    async copy(a) { try { await navigator.clipboard.writeText(a.text); } catch (e) {} return {}; },
    async share(a) { console.log('[mock] share', a.text); return {}; },
    async getTune() { return { iranDirect: LS.get('iran') !== false, ipv6Tunnel: false }; },
    async probeGoogle() {
      if (!vpn.running) throw { message: 'اول به یک سرور وصل شو.' };
      await new Promise((r) => setTimeout(r, 1200));
      const s = vpn.servers.find((x) => x.guid === vpn.selected) || {};
      const iran = /amsterdam/i.test(s.remarks || '');   // preview: pretend Google sees the Netherlands node as Iran
      return { ip: iran ? '185.12.1.9' : '45.128.199.56', cc: iran ? 'NL' : 'DE', google_cc: iran ? 'IR' : 'DE', gemini: !iran, gemini_region: iran ? null : 'DEU', google_blocked: false };
    },
    async setTune(a) { LS.set('iran', !!a.iranDirect); return { iranDirect: !!a.iranDirect }; },
    // preview: ?policy=on|off decides what "Android" reports while connected
    async vpnPolicy() {
      if (!vpn.running) return { known: false, reason: 'not_connected' };
      const p = new URLSearchParams(location.search).get('policy');
      if (!p) return { known: false, reason: 'no_answer' };
      return { known: true, alwaysOn: p === 'on', lockdown: p === 'on' };
    },
    async systemBars() { return {}; },
    // preview: ?autodeny=1 makes the VPN permission dialog say no; ?notif=off starts with notifications off
    async getAutoStart() { return { on: !!LS.get('boot'), hasServer: true }; },
    async setAutoStart(a) {
      if (!a.on) { LS.set('boot', false); return { on: false }; }
      if (new URLSearchParams(location.search).get('autodeny')) return { on: false, denied: true };
      LS.set('boot', true); return { on: true };
    },
    async notifState() { const v = LS.get('notif'); return { on: v == null ? new URLSearchParams(location.search).get('notif') !== 'off' : !!v, canAsk: true }; },
    async notifEnable() { if (new URLSearchParams(location.search).get('notif') === 'off') return { on: false, canAsk: true }; LS.set('notif', true); return { on: true, canAsk: true }; },
    async openNotifSettings() { console.log('[mock] open notification settings'); return { opened: true }; },
    async vpnSystemSettings() { console.log('[mock] open Android VPN settings'); return { opened: true }; },
  };
  window.CGMockHost = {
    call(id, method, argsJson) {
      const fn = H[method];
      const args = JSON.parse(argsJson || '{}');
      Promise.resolve()
        .then(() => { if (!fn) throw { message: 'Unknown bridge method ' + method }; return fn(args); })
        .then((v) => window.__cgResolve(id, true, JSON.stringify(v == null ? {} : v)))
        .catch((e) => window.__cgResolve(id, false, JSON.stringify({ message: (e && e.message) || String(e), code: e && e.code })));
    },
  };
})();
