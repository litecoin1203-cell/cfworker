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

export function makeDB(schemaPath) {
  const db = new DatabaseSync(':memory:');
  // apply every migration in order, like `wrangler d1 migrations apply`
  const dir = dirname(schemaPath);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  return {
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    exec: (sql) => db.exec(sql),
  };
}

// ---------------- fake PasarGuard + NOWPayments + Telegram over fetch ----------------
export function installFakes({ panelBase }) {
  const pg = { users: {}, tokens: new Set(), deletedHwids: [], seq: 0, lastSubHeaders: null, groupsSudoOnly: false, failCreate: null };
  const tg = { messages: [], photos: [], lastButtons: null };
  const np = { invoices: [] };

  const resJson = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const resText = (text, status = 200) => new Response(text, { status });

  function subLinks() {
    return [
      'vless://uuid@nl1.example.com:443?security=reality&type=tcp#%F0%9F%87%B3%F0%9F%87%B1%20Netherlands',
      'vless://uuid@de1.example.com:443?security=tls&type=ws#%F0%9F%87%A9%F0%9F%87%AA%20Germany',
      'trojan://pass@us1.example.com:443#%F0%9F%87%BA%F0%9F%87%B8%20United%20States',
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

    if (url.startsWith(panelBase)) {
      const path = url.slice(panelBase.length);
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
        if (method === 'PUT') { Object.assign(u, JSON.parse(body)); return resJson(outUser(u)); }
        if (method === 'DELETE') { delete pg.users[name]; return resText('', 204); }
      }
      if ((mm = path.match(/^\/api\/user\/([^/]+)\/reset$/)) && method === 'POST') {
        const u = pg.users[decodeURIComponent(mm[1])]; u.used_traffic = 0; return resJson(outUser(u));
      }
      if ((mm = path.match(/^\/api\/user\/(\d+)\/hwids\/(.+)$/)) && method === 'DELETE') {
        pg.deletedHwids.push([parseInt(mm[1], 10), decodeURIComponent(mm[2])]); return resText('', 204);
      }
      if (path.match(/^\/sub\/[^/]+\/links$/)) return resText(subLinks());
      if (path.match(/^\/sub\/[^/]+\/?$/)) {
        const hh = new Headers(init.headers || {});
        pg.lastSubHeaders = { ua: hh.get('user-agent'), hwid: hh.get('x-hwid') };
        return new Response(btoa(subLinks()), { status: 200, headers: { 'subscription-userinfo': 'upload=0; download=0; total=0; expire=0' } });
      }
      return resText('panel: unhandled ' + method + ' ' + path, 500);
    }

    if (url.includes('api.nowpayments.io')) {
      const b = JSON.parse(body);
      const inv = { id: 5000 + np.invoices.length, invoice_url: 'https://nowpayments.io/pay/' + b.order_id };
      np.invoices.push({ ...b, ...inv });
      return resJson(inv);
    }

    if (url.includes('api.telegram.org')) {
      const method2 = url.split('/').pop();
      if (method2 === 'sendMessage') { tg.messages.push(JSON.parse(body)); return resJson({ ok: true, result: { message_id: tg.messages.length } }); }
      if (method2 === 'sendPhoto') { tg.photos.push(true); return resJson({ ok: true, result: { message_id: 1, photo: [{ file_id: 'photo_' + tg.photos.length }] } }); }
      return resJson({ ok: true, result: {} });
    }
    throw new Error('unexpected fetch to ' + url);
  };

  return { pg, tg, np };
}
