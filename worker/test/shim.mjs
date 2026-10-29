// A D1-shaped wrapper over Node's built-in SQLite, plus fakes for PasarGuard, Telegram and NOWPayments,
// so the Worker's real code runs unchanged under Node for testing.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

function toNum(v) { return typeof v === 'bigint' ? Number(v) : v; }
function fixRow(row) {
  if (!row) return row;
  const out = {};
  for (const k of Object.keys(row)) out[k] = toNum(row[k]);
  return out;
}

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args.map((a) => (a === undefined ? null : a)); return this; }
  async first(col) {
    const row = fixRow(this.db.prepare(this.sql).get(...this.args));
    if (col) return row ? row[col] : undefined;
    return row ?? null;
  }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map(fixRow), success: true }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: toNum(r.changes), last_row_id: toNum(r.lastInsertRowid) } };
  }
}

export function makeDB(schemaPath, { upto } = {}) {
  const db = new DatabaseSync(':memory:');
  // apply every migration in order, like `wrangler d1 migrations apply`
  const dir = dirname(schemaPath);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) { if (upto && f > upto) break; db.exec(readFileSync(join(dir, f), 'utf8')); }
  return {
    prepare: (sql) => new Stmt(db, sql),
    // like D1: the whole batch is one transaction, run without anything else in between, rolled back on error
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => {
          const r = db.prepare(s.sql).run(...s.args);
          return { success: true, meta: { changes: toNum(r.changes), last_row_id: toNum(r.lastInsertRowid) } };
        });
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    exec: (sql) => db.exec(sql),
  };
}

// ---------------- fake PasarGuard + NOWPayments + Telegram over fetch ----------------
export function installFakes({ panelBase }) {
  const newPanel = (host) => ({ users: {}, tokens: new Set(), deletedHwids: [], seq: 0, lastSubHeaders: null, groupsSudoOnly: false, failCreate: null,
    down: false, puts: 0, putLog: [], host: host || 'example.com' });
  const pg = newPanel();
  const panels = { [panelBase]: pg };
  const tg = { messages: [], photos: [], lastButtons: null, calls: [] };
  const np = { invoices: [] };

  const resJson = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const resText = (text, status = 200) => new Response(text, { status });

  function subLinks(pg) {
    const h = pg.host;
    return [
      `vless://uuid@nl1.${h}:443?security=reality&type=tcp#%F0%9F%87%B3%F0%9F%87%B1%20Netherlands`,
      `vless://uuid@de1.${h}:443?security=tls&type=ws#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20MyPanel`,
      `trojan://pass@us1.${h}:443#%F0%9F%87%BA%F0%9F%87%B8%20United%20States`,
    ].join('\n');
  }
  function outUser(u) {
    return { id: u.id, username: u.username, status: u.status, expire: u.expire, data_limit: u.data_limit,
      used_traffic: u.used_traffic || 0, subscription_url: `/sub/${u.token}/` };
  }

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body;

    const base = Object.keys(panels).find((b) => url.startsWith(b + '/'));
    if (base) {
      const pg = panels[base];
      if (pg.down) throw new TypeError('fetch failed');
      const path = url.slice(base.length);
      if (path.startsWith('/api/users?')) {
        const q = new URL(url).searchParams;
        const all = Object.values(pg.users);
        const off = parseInt(q.get('offset') || '0', 10), lim = parseInt(q.get('limit') || '100', 10);
        return resJson({ users: all.slice(off, off + lim).map(outUser), total: all.length });
      }
      if (path === '/api/system') return resJson({ version: '1.0.0-test' });
      if (path === '/api/admin/token') { const t = 'tok' + ++pg.seq; pg.tokens.add(t); return resJson({ access_token: t, token_type: 'bearer' }); }
      if (path === '/api/groups') return pg.groupsSudoOnly ? resText('{"detail":"You\'re not allowed"}', 403) : resJson({ groups: [{ id: 1, name: 'default' }] });
      if (path.startsWith('/api/groups/simple')) return resJson({ groups: [{ id: 1, name: 'default' }, { id: 2, name: 'reseller' }], total: 2 });
      let mm;
      if (path === '/api/user' && method === 'POST') {
        const b = JSON.parse(body);
        if (pg.failCreate) return resText(JSON.stringify({ detail: pg.failCreate }), 400);
        if (!b.group_ids || !b.group_ids.length) return resText('{"detail":"group_ids required"}', 422);
        const u = { ...b, id: ++pg.seq, token: 'sub' + pg.seq, used_traffic: 0 };
        pg.users[b.username] = u;
        return resJson(outUser(u), 201);
      }
      if ((mm = path.match(/^\/api\/user\/([^/]+)$/))) {
        const name = decodeURIComponent(mm[1]);
        const u = pg.users[name];
        if (method === 'GET') return u ? resJson(outUser(u)) : resText('not found', 404);
        if (method === 'PUT') { if (!u) return resText('not found', 404); pg.puts++; pg.putLog.push(name); Object.assign(u, JSON.parse(body)); return resJson(outUser(u)); }
        if (method === 'DELETE') { delete pg.users[name]; return resText('', 204); }
      }
      if ((mm = path.match(/^\/api\/user\/([^/]+)\/reset$/)) && method === 'POST') {
        const u = pg.users[decodeURIComponent(mm[1])]; u.used_traffic = 0; return resJson(outUser(u));
      }
      if ((mm = path.match(/^\/api\/user\/(\d+)\/hwids\/(.+)$/)) && method === 'DELETE') {
        pg.deletedHwids.push([parseInt(mm[1], 10), decodeURIComponent(mm[2])]); return resText('', 204);
      }
      if (path.match(/^\/sub\/[^/]+\/links$/)) {
        pg.lastLinksHwid = new Headers(init.headers || {}).get('x-hwid');
        return resText(subLinks(pg));
      }
      if (path.match(/^\/sub\/[^/]+\/?$/)) {
        const hh = new Headers(init.headers || {});
        pg.lastSubHeaders = { ua: hh.get('user-agent'), hwid: hh.get('x-hwid') };
        // a panel with "custom JSON for v2rayNG" answers the core's agent with an Xray JSON config
        if (pg.subJson) return resJson([{ remarks: 'x', outbounds: [] }]);
        return new Response(btoa(subLinks(pg)), { status: 200, headers: { 'subscription-userinfo': 'upload=0; download=0; total=0; expire=0' } });
      }
      return resText('panel: unhandled ' + method + ' ' + path, 500);
    }

    if (url.includes('api.coingecko.com')) {
      if (globalThis.__fakePriceDown) return resText('down', 503);
      return resJson({ stellar: { usd: 0.4 }, ripple: { usd: 2.5 }, tron: { usd: 0.25 }, solana: { usd: 200 },
        'the-open-network': { usd: 5 }, litecoin: { usd: 100 }, dogecoin: { usd: 0.2 }, 'bitcoin-cash': { usd: 500 },
        binancecoin: { usd: 700 }, 'polygon-ecosystem-token': { usd: 0.25 }, algorand: { usd: 0.2 } });
    }
    if (url.includes('min-api.cryptocompare.com')) return resText('down', 503);
    // public blockchain APIs; tests push records into globalThis.__chain
    const ch = (globalThis.__chain = globalThis.__chain || { xlm: [], xrp: [], trx: [], ton: [], algo: [] });
    if (url.startsWith('https://horizon.stellar.org/')) return resJson({ _embedded: { records: ch.xlm } });
    if (url.startsWith('https://xrplcluster.com/')) return resJson({ result: { transactions: ch.xrp } });
    if (url.startsWith('https://api.trongrid.io/')) return resJson({ data: ch.trx });
    if (url.startsWith('https://toncenter.com/')) return resJson({ ok: true, result: ch.ton });
    if (url.startsWith('https://mainnet-idx.algonode.cloud/')) return resJson({ transactions: ch.algo });
    // Iranian exchanges (USDT/toman = free-market dollar). tabdeal is a deliberate outlier.
    if (/nobitex|wallex|bitpin|ramzinex|tabdeal/.test(url) && globalThis.__fakeRateDown) return resText('down', 503);
    if (url.includes('api.nobitex.ir/market/stats')) return resJson({ status: 'ok', stats: { 'usdt-rls': { bestBuy: '999000', bestSell: '1001000', latest: '1000000' } } });
    if (url.includes('api.wallex.ir/v1/markets')) return resJson({ result: { symbols: { USDTTMN: { stats: { bidPrice: '99900', askPrice: '100100', lastPrice: '100000' } } } } });
    if (url.includes('api.bitpin.org')) return resJson([{ symbol: 'USDT_IRT', price: '100000' }]);
    if (url.includes('publicapi.ramzinex.com')) return resJson({ data: [{ base_currency_symbol: { en: 'usdt' }, quote_currency_symbol: { en: 'irr' }, buy: 999000, sell: 1001000 }] });
    if (url.includes('api1.tabdeal.org')) return resJson({ symbol: 'USDTIRT', price: '150000' });
    if (url.includes('api.nowpayments.io')) {
      const b = JSON.parse(body);
      const inv = { id: 5000 + np.invoices.length, invoice_url: 'https://nowpayments.io/pay/' + b.order_id };
      np.invoices.push({ ...b, ...inv });
      return resJson(inv);
    }

    if (url.includes('api.telegram.org')) {
      const method2 = url.split('/').pop();
      tg.calls.push({ method: method2, body: body && typeof body === 'string' ? JSON.parse(body) : null });
      if (method2 === 'sendMessage') { tg.messages.push(JSON.parse(body)); return resJson({ ok: true, result: { message_id: tg.messages.length } }); }
      if (method2 === 'sendPhoto') { tg.photos.push(true); return resJson({ ok: true, result: { message_id: 1, photo: [{ file_id: 'photo_' + tg.photos.length }] } }); }
      return resJson({ ok: true, result: {} });
    }
    throw new Error('unexpected fetch to ' + url);
  };

  const addPanel = (b, host) => (panels[b] = newPanel(host));
  return { pg, tg, np, panels, addPanel };
}
