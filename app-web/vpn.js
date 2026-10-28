/* Connection logic shared by the Phase-2 screens (no markup here): the connection phase, live numbers,
 * smart connect with failover, ISP ranking, the Google check, and the Kill Switch / Always-On state from Android.
 * Screens subscribe to CG.on('conn', fn) and repaint only what changed. Moved out of home.js unchanged in behaviour,
 * except that no server address or exit IP is kept for display and errors carry codes, not raw text. */
(function () {
  'use strict';
  const CG = window.CG;
  const { call, api, on, emit, S, toast, syncVpn, hasActivePlan, t } = CG;

  const recall = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  const keep = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
  const changed = (what) => emit('conn', what || {});

  // ---------------- phase ----------------
  // connected | connecting | disconnecting | disconnected | error | blocked (plan stopped)
  S.vpn.error = null;      // code of the last failure, cleared by the next action
  S.vpn.dropped = false;   // the tunnel closed without the user asking (onRevoke, another VPN app, system)
  S.offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  function phase() {
    if (S.vpn.busy) return S.vpn.busy;
    if (S.vpn.running) return 'connected';
    if (S.me && !hasActivePlan()) return 'blocked';
    if (S.vpn.error) return 'error';
    return 'disconnected';
  }
  // why the plan cannot be used: limited | expired | disabled | missing | on_hold | none ; null = usable or unknown
  function stopReason() {
    if (!S.me) return null;
    const sub = S.me.subscription;
    if (!sub) return 'none';
    if (sub.active) return null;
    return ['limited', 'expired', 'disabled', 'missing', 'on_hold'].includes(sub.status) ? sub.status : 'expired';
  }

  // ---------------- live numbers: ping, session usage, duration ----------------
  const live = { users: 0, timer: 0, pingTimer: 0, rx: 0, tx: 0 };
  // session usage = the app's byte counters now minus at connect time (the core runs in the app's uid)
  S.vpn.base = (() => { try { return JSON.parse(recall('cg_base', 'null')); } catch (e) { return null; } })();
  function sessionBytes() {
    if (!S.vpn.running || !S.vpn.base) return 0;
    return Math.max(0, live.rx - S.vpn.base.rx) + Math.max(0, live.tx - S.vpn.base.tx);
  }
  function durationSec() { return S.vpn.running && S.vpn.since ? Math.max(0, Math.floor((Date.now() - S.vpn.since) / 1000)) : 0; }
  async function readTraffic() {
    try {
      const r = await call('traffic', {});
      live.rx = r.rx; live.tx = r.tx;
      if (S.vpn.running && !S.vpn.base) { S.vpn.base = { rx: r.rx, tx: r.tx }; keep('cg_base', JSON.stringify(S.vpn.base)); }
    } catch (e) {}
  }
  function startLive() {
    if (live.users++ > 0) return;
    live.timer = setInterval(() => { if (S.vpn.running) readTraffic(); }, 2000);
    const ping = () => { if (S.vpn.running) call('vpnPing', {}).catch(() => {}); };
    live.pingTimer = setInterval(ping, 10000);
    readTraffic(); ping();
  }
  function stopLive() {
    if (--live.users > 0) return;
    clearInterval(live.timer); clearInterval(live.pingTimer);
  }

  // native events
  on('vpn', () => {
    if (S.vpn.running) {
      S.vpn.dropped = false; S.vpn.error = null;
      if (S.vpn.edge === 'up') {
        S.vpn.base = null; keep('cg_base', null); readTraffic();
        clearTimeout(connectWatch);
        setTimeout(() => call('vpnPing', {}).catch(() => {}), 1200);
        setTimeout(() => CG.loadMe().then(() => changed({ me: true })).catch(() => {}), 2500);
        setTimeout(refreshPolicy, 1500);
      }
    } else if (S.vpn.edge === 'down') {
      if (S.vpn.dropped && CG.ui) CG.ui.announce(t('conn.dropped'));
      S.ping = null; S.qual = []; S.vpn.base = null; keep('cg_base', null);
      S.policy = { known: false, reason: 'not_connected' };
    }
    changed({ phase: true });
  });
  on('vpnError', (v) => {
    S.vpn.busy = null; S.vpn.label = null;
    S.vpn.error = (v && v.code) || 'start_failed';
    if (fo.tried.length && failover('error')) return;
    changed({ phase: true });
  });
  on('ping', (v) => { S.ping = v && v.ms ? v.ms : null; });
  window.addEventListener('online', () => { S.offline = false; changed({ net: true }); });
  window.addEventListener('offline', () => { S.offline = true; changed({ net: true }); });
  on('resume', () => { refreshPolicy(); CG.loadMe().then(() => changed({ me: true })).catch(() => {}); });

  // ---------------- smart connect: test every server, use the fastest, move on if one stops answering ----------------
  S.auto = recall('cg_auto', '1') === '1';
  function setAuto(v) { S.auto = !!v; keep('cg_auto', v ? '1' : '0'); changed({ auto: true }); }

  let testing = null;
  function testAll(maxWait) {
    if (testing) return testing;
    const pings = S.serverPings = S.serverPings || {};
    testing = new Promise((res) => {
      const got = new Set();
      let over = false, off = null, timer = 0;
      const done = () => { if (over) return; over = true; clearTimeout(timer); if (off) off(); S.pingAt = Date.now(); testing = null; changed({ pings: true }); res(); };
      off = on('serverPing', (v) => { if (v && v.guid) { pings[v.guid] = v.ms; got.add(v.guid); if (got.size >= S.servers.length) done(); } });
      timer = setTimeout(done, maxWait || 7000);
      call('vpnTestAll', {}).catch(done);
    });
    return testing;
  }

  // ISP intelligence: what worked for other users on the same operator (anonymous, per server key)
  let rankAt = 0, rankP = null;
  function ispRank() {
    if (S.rank && Date.now() - rankAt < 10 * 60 * 1000) return Promise.resolve(S.rank);
    if (!rankP) rankP = api('GET', '/net/rank').then((r) => { S.rank = r; rankAt = Date.now(); changed({ rank: true }); return r; }).catch(() => S.rank || null).finally(() => { rankP = null; });
    return rankP;
  }
  const reportQ = [];
  let reportT = 0;
  function reportNet(items) {
    items.forEach((x) => { if (x && x.k) reportQ.push(x); });
    clearTimeout(reportT);
    reportT = setTimeout(() => { const batch = reportQ.splice(0, 60); if (batch.length) api('POST', '/net/report', { results: batch }).catch(() => {}); }, 1500);
  }
  const ispScore = (s) => { const r = S.rank && S.rank.servers && S.rank.servers[s.k]; return r && r.n >= 3 ? r.score : null; };

  // Google / Gemini: how Google sees each server's exit (tested by phones through that config)
  S.googleMode = recall('cg_gmode', '0') === '1';
  function setGoogleMode(v) { S.googleMode = !!v; keep('cg_gmode', v ? '1' : '0'); changed({ auto: true }); }
  const gInfo = (s) => (S.rank && S.rank.google && S.rank.google[s.k]) || null;
  const googleOk = (s) => { const g = gInfo(s); return g ? g.status === 'google' : null; };
  const pool = () => {
    if (!S.googleMode) return S.servers;
    const good = S.servers.filter((s) => googleOk(s) === true);
    return good.length ? good : S.servers;
  };
  async function probeGoogle(force) {
    const s = S.servers.find((x) => x.guid === S.selected);
    if (!s || !S.vpn.running) throw { code: 'not_connected' };
    const key = 'cg_gp_' + s.k;
    if (!force && +recall(key, '0') > Date.now() - 12 * 3600 * 1000) return null;
    keep(key, String(Date.now()));
    const r = await call('probeGoogle', {});
    if (r && !r.error) {
      const saved = await api('POST', '/net/google', Object.assign({ k: s.k, name: s.remarks || s.name }, r)).catch(() => null);
      if (saved && saved.status) { S.rank = S.rank || { servers: {}, google: {} }; S.rank.google = S.rank.google || {}; S.rank.google[s.k] = saved; changed({ rank: true }); }
    }
    return Object.assign({ server: s }, r || {});
  }

  // fastest on this phone, weighted by how well it works on this operator for everyone
  const ranked = (exclude) => {
    const p = S.serverPings || {};
    const score = (s) => {
      const ms = p[s.guid];
      const local = ms > 0 ? 1 - Math.min(ms, 1500) / 1500 : 0;
      const isp = ispScore(s);
      return isp == null ? local : local * 0.45 + isp * 0.55;
    };
    return pool().filter((s) => p[s.guid] > 0 && !(exclude || []).includes(s.guid)).sort((a, b) => score(b) - score(a));
  };
  async function bestServer(exclude) {
    await ispRank();
    if (!(exclude || []).length) {
      const strong = pool().map((s) => ({ s, r: S.rank && S.rank.servers && S.rank.servers[s.k] }))
        .filter((x) => x.r && x.r.n >= 8 && x.r.score >= 0.8).sort((a, b) => b.r.score - a.r.score)[0];
      if (strong) return strong.s;
    }
    const fresh = S.pingAt && Date.now() - S.pingAt < 10 * 60 * 1000 && ranked(exclude).length;
    if (!fresh) {
      await testAll(7000);
      const p = S.serverPings || {};
      reportNet(S.servers.filter((s) => s.guid in p).map((s) => ({ k: s.k, ok: p[s.guid] > 0, ms: p[s.guid] > 0 ? p[s.guid] : 0 })));
    }
    return ranked(exclude)[0] || null;
  }

  // live quality over the last minute: ping, jitter and loss -> 0..100 and a word
  S.qual = [];
  function quality() {
    const q = S.qual.slice(-6);
    if (q.length < 2) return null;
    const ok = q.filter((x) => x > 0);
    const loss = 1 - ok.length / q.length;
    if (!ok.length) return { score: 0, word: 'conn.q.down', kind: 'bad' };
    const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
    let jit = 0;
    for (let i = 1; i < ok.length; i++) jit += Math.abs(ok[i] - ok[i - 1]);
    jit = ok.length > 1 ? jit / (ok.length - 1) : 0;
    const score = Math.round(Math.max(0, Math.min(100, 100 - Math.min(40, avg / 15) - Math.min(30, jit / 4) - loss * 60)));
    const word = score >= 85 ? 'conn.q.great' : score >= 65 ? 'conn.q.good' : score >= 40 ? 'conn.q.fair' : 'conn.q.poor';
    return { score, word, kind: score >= 65 ? 'ok' : score >= 40 ? 'warn' : 'bad' };
  }

  // ---------------- connect / disconnect ----------------
  let connectWatch = 0;
  const fo = { tried: [], misses: 0, resynced: false, reported: false };
  async function connect(guid, opts) {
    opts = opts || {};
    if (!hasActivePlan()) { changed({ phase: true }); return; }  // the screen shows the stop reason and the renew button
    S.vpn.error = null; S.vpn.dropped = false;
    try {
      if (!S.servers.length) await syncVpn();
      if (!S.servers.length) { S.vpn.error = 'no_servers'; changed({ phase: true }); return; }
      if (!opts.failover) { fo.tried = []; fo.misses = 0; fo.resynced = false; }
      fo.reported = false; S.qual = [];
      S.vpn.busy = 'connecting';
      changed({ phase: true });
      if (guid) S.selected = guid;
      else if (S.auto && S.servers.length > 1) {
        S.vpn.label = 'conn.sub.finding';
        changed({ phase: true });
        const best = await bestServer(fo.tried);
        S.vpn.label = null;
        if (S.vpn.busy !== 'connecting') return; // cancelled meanwhile
        if (best) S.selected = best.guid;
      }
      fo.tried.push(S.selected);
      changed({ server: true });
      clearTimeout(connectWatch);
      connectWatch = setTimeout(() => {
        if (S.vpn.busy === 'connecting') { S.vpn.busy = null; if (!failover('timeout')) { S.vpn.error = 'timeout'; changed({ phase: true }); } }
      }, 30000);
      const r = await call(S.vpn.running ? 'vpnSelect' : 'vpnConnect', { guid: S.selected });
      if (r && r.denied) { clearTimeout(connectWatch); S.vpn.busy = null; S.vpn.error = 'denied'; changed({ phase: true }); }
    } catch (e) {
      clearTimeout(connectWatch);
      S.vpn.busy = null; S.vpn.label = null;
      S.vpn.error = (e && e.code) || 'start_failed';
      if (e && e.code === 'device_limit') S.syncError = e;
      changed({ phase: true });
    }
  }
  const cur = () => S.servers.find((s) => s.guid === S.selected);
  // in smart mode a server that fails or stops answering is replaced by the next best one (at most twice);
  // when every tried server failed, the server list is refreshed once and we try again
  function failover(why) {
    const s0 = cur();
    if (s0) reportNet([{ k: s0.k, ok: false }]);
    if (!S.auto) return false;
    const next = fo.tried.length < 3 ? ranked(fo.tried)[0] || S.servers.find((s) => !fo.tried.includes(s.guid)) : null;
    if (next) { toast(t('fo.next')); connect(next.guid, { failover: true }); return true; }
    if (!fo.resynced) {
      fo.resynced = true;
      toast(t('fo.resync'));
      S.pingAt = 0;
      syncVpn().then(() => { fo.tried = []; connect(undefined, { failover: true }); }).catch((e) => { S.vpn.error = (e && e.code) || 'network'; changed({ phase: true }); });
      return true;
    }
    return false;
  }
  on('ping', (v) => {
    if (!S.vpn.running) return;
    S.qual.push(v && v.ms ? v.ms : 0);
    if (S.qual.length > 12) S.qual.shift();
    changed({ ping: true });
    if (v && v.ms) {
      fo.misses = 0;
      const s0 = cur();
      if (!fo.reported && s0) {
        fo.reported = true;
        reportNet([{ k: s0.k, ok: true, ms: v.ms }]);
        setTimeout(() => { if (S.vpn.running) probeGoogle(false).catch(() => {}); }, 6000);
      }
      return;
    }
    if (++fo.misses >= 2 && failover('dead')) fo.misses = 0;
  });

  async function disconnect() {
    clearTimeout(connectWatch);
    S.vpn.busy = 'disconnecting'; S.vpn.label = null; S.vpn.error = null;
    changed({ phase: true });
    try { await call('vpnDisconnect', {}); } catch (e) { S.vpn.busy = null; changed({ phase: true }); }
    setTimeout(() => { if (S.vpn.busy === 'disconnecting') { S.vpn.busy = null; changed({ phase: true }); } }, 5000);
  }

  // ---------------- Kill Switch / Always-On: only what Android reports ----------------
  // {known:true, alwaysOn, lockdown} while the tunnel runs on Android 10+; otherwise {known:false, reason}
  S.policy = { known: false, reason: 'not_connected' };
  let policyP = null;
  function refreshPolicy() {
    if (policyP) return policyP;
    policyP = call('vpnPolicy', {}).then((p) => {
      S.policy = p && typeof p === 'object' ? p : { known: false, reason: 'unsupported' };
    }).catch(() => { S.policy = { known: false, reason: 'unsupported' }; })
      .finally(() => { policyP = null; changed({ policy: true }); });
    return policyP;
  }

  Object.assign(CG, { phase, stopReason, startLive, stopLive, sessionBytes, durationSec, connect, disconnect, setAuto, testAll,
    ispRank, ispScore, setGoogleMode, gInfo, googleOk, probeGoogle, quality, refreshPolicy, reportNet });
})();
