// Local preview: runs the real Worker over Node's SQLite + fake panel, and serves the app-web UI,
// so you can click through the whole store in a browser.  node --experimental-sqlite test/dev_server.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { makeDB, installFakes } from './shim.mjs';

const PANEL = 'http://panel.test';
const fakes = installFakes({ panelBase: PANEL });
// richer server list for the preview
fakes.pg; // keep ref
const worker = (await import('../src/index.js')).default;

const env = {
  DB: makeDB(new URL('../migrations/0001_init.sql', import.meta.url).pathname),
  SECRET_KEY: 'dev-secret-key-not-for-production-0123456789',
  PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
  PASARGUARD_URL: PANEL, PASARGUARD_USERNAME: 'a', PASARGUARD_PASSWORD: 'b', PASARGUARD_USERNAME_PREFIX: 'cg',
  NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: 's',
  TELEGRAM_BOT_TOKEN: 'bot:token', TELEGRAM_CHAT_ID: '12345', TELEGRAM_WEBHOOK_SECRET: 'hook',
};
const ctx = { waitUntil: () => {} };
const WEB = new URL('../../app-web/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain' };

// seed card settings + auto-approve webhook helper
async function seed() {
  await worker.fetch(new Request('http://x/api/v1/plans'), env, ctx); // triggers plan seed
  const bot = (text) => worker.fetch(new Request('http://x/tg/hook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'hook' }, body: JSON.stringify({ message: { chat: { id: 12345, type: 'private' }, from: { id: 12345 }, text } }) }), env, ctx);
  await bot('/set card_number 6037991234567893');
  await bot('/set card_holder Ali Ahmadi');
  await bot('/set card_bank ملی');
  await bot('/set sms_key devkey');
  await bot('/set sms_senders +989100');
  await bot('/set support_url https://t.me/cloudgold');
  await bot('/set usdt_rate_toman 70000');
  await bot('/set usd_rate_toman 100000');
  for (const [k, v] of Object.entries({
    xlm: 'G' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 55), xrp: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
    trx: 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9', sol: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV',
    ton: 'UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG', ltc: 'ltc1qrsfx8hmmxjl8dnm2kfqudaypqnjzqgcvpyvpwq',
    doge: 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', bch: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
    bnb: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', pol: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    algo: 'A'.repeat(58),
  })) await bot(`/set wallet_${k} ${v}`);
  await bot('/set wallet_xlm_memo 84021733');
  await bot('/set wallet_xrp_memo 1048576');
}
await seed();
// preview: pretend everyone is on MCI and that other MCI users found Germany the best server
{
  const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return 'k' + h.toString(16).padStart(8, '0'); };
  const day = Math.floor(Date.now() / 86400000);
  const b = Math.floor(Date.now() / 1000 / 10800);
  const put = (key, ok, fail, ms) => env.DB.exec(`INSERT INTO net_geo (asn, geo, skey, bucket, ok, fail, ms_sum, ms_n) VALUES (197207, 'razavi khorasan', '${fnv(key)}', ${b}, ${ok}, ${fail}, ${ms * ok}, ${ok})`);
  put('vless|de1.example.com|443', 40, 1, 95);
  put('vless|nl1.example.com|443', 12, 9, 260);
  put('trojan|us1.example.com|443', 5, 6, 410);
}

// auto-approve any receipt a moment after it arrives, so the card flow completes in the preview
const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('api.telegram.org') && url.endsWith('/sendPhoto')) {
    const res = await origFetch(input, init);
    // find the latest review order and approve it
    setTimeout(async () => {
      const row = await env.DB.prepare("SELECT id FROM orders WHERE status='review' ORDER BY id DESC LIMIT 1").bind().first();
      if (row) await worker.fetch(new Request('http://x/tg/hook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'hook' }, body: JSON.stringify({ callback_query: { id: 'x', data: 'ap:' + row.id, from: { id: 12345 }, message: { chat: { id: 12345, type: 'private' }, message_id: 1 } } }) }), env, ctx);
    }, 1500);
    return res;
  }
  return origFetch(input, init);
};

function serveStatic(res, pathname) {
  let rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = join(WEB, rel);
  if (!file.startsWith(WEB) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8787');
  const p = url.pathname;
  // preview only: pretend a deposit landed on the blockchain  (POST /dev/chain {coin, record})
  if (p === '/dev/chain' && req.method === 'POST') {
    const chunks = []; for await (const c of req) chunks.push(c);
    const { coin, record } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const ch = (globalThis.__chain = globalThis.__chain || { xlm: [], xrp: [], trx: [], ton: [], algo: [] });
    ch[coin].push(record);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
  }
  if (p.startsWith('/api/') || p.startsWith('/tg/') || p.startsWith('/pay/') || p.startsWith('/sms/') || p === '/health') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const wreq = new Request('http://127.0.0.1:8787' + req.url, { method: req.method, headers: req.headers, body });
    Object.defineProperty(wreq, 'cf', { value: { asn: 197207, asOrganization: 'Mobile Communication Company of Iran PLC', country: 'IR', region: 'Razavi Khorasan', city: 'Mashhad' } });
    const wres = await worker.fetch(wreq, env, ctx);
    const buf = Buffer.from(await wres.arrayBuffer());
    res.writeHead(wres.status, Object.fromEntries(wres.headers));
    res.end(buf);
    return;
  }
  serveStatic(res, p);
}).listen(8787, '127.0.0.1', () => console.log('Cloud Gold preview on http://127.0.0.1:8787/'));
