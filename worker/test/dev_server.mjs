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
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.ttf': 'font/ttf', '.json': 'application/json', '.txt': 'text/plain' };

// seed card settings + auto-approve webhook helper
async function seed() {
  await worker.fetch(new Request('http://x/api/v1/plans'), env, ctx); // triggers plan seed
  const bot = (text) => worker.fetch(new Request('http://x/tg/hook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: { chat: { id: 12345 }, text } }) }), env, ctx);
  await bot('/set card_number 6037991234567890');
  await bot('/set card_holder Ali Ahmadi');
  await bot('/set card_bank Melli');
  await bot('/set support_url https://t.me/cloudgold');
  await bot('/set usdt_rate_toman 70000');
}
await seed();

// auto-approve any receipt a moment after it arrives, so the card flow completes in the preview
const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('api.telegram.org') && url.endsWith('/sendPhoto')) {
    const res = await origFetch(input, init);
    // find the latest review order and approve it
    setTimeout(async () => {
      const row = await env.DB.prepare("SELECT id FROM orders WHERE status='review' ORDER BY id DESC LIMIT 1").bind().first();
      if (row) await worker.fetch(new Request('http://x/tg/hook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query: { id: 'x', data: 'ap:' + row.id, message: { chat: { id: 12345 }, message_id: 1 } } }) }), env, ctx);
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
  if (p.startsWith('/api/') || p.startsWith('/tg/') || p.startsWith('/pay/') || p === '/health') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const wreq = new Request('http://127.0.0.1:8787' + req.url, { method: req.method, headers: req.headers, body });
    const wres = await worker.fetch(wreq, env, ctx);
    const buf = Buffer.from(await wres.arrayBuffer());
    res.writeHead(wres.status, Object.fromEntries(wres.headers));
    res.end(buf);
    return;
  }
  serveStatic(res, p);
}).listen(8787, '127.0.0.1', () => console.log('Cloud Gold preview on http://127.0.0.1:8787/'));
