// TEMPORARY diagnostic (no secrets, no production access): can the public price / chain APIs the Worker
// relies on be read from a server outside Iran? Prints HTTP status and the shape of the answer only.
const T = 8000;
const SRC = {
  nobitex: ['https://api.nobitex.ir/market/stats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ srcCurrency: 'usdt', dstCurrency: 'rls' }) }],
  wallex: ['https://api.wallex.ir/v1/markets'],
  bitpin_org: ['https://api.bitpin.org/api/v1/mkt/tickers/'],
  bitpin_ir: ['https://api.bitpin.ir/v1/mkt/markets/'],
  ramzinex: ['https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/pairs'],
  tabdeal: ['https://api1.tabdeal.org/r/api/v1/ticker/price?symbol=USDTIRT'],
  coingecko: ['https://api.coingecko.com/api/v3/simple/price?ids=stellar,ripple,tron,solana,the-open-network,litecoin,dogecoin,bitcoin-cash,binancecoin,polygon-ecosystem-token,algorand&vs_currencies=usd'],
  cryptocompare: ['https://min-api.cryptocompare.com/data/pricemulti?fsyms=XLM,XRP,TRX,SOL,TON,LTC,DOGE,BCH,BNB,POL,ALGO&tsyms=USD'],
  stellar: ['https://horizon.stellar.org/'],
  trongrid: ['https://api.trongrid.io/v1/accounts/TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7/transactions?only_to=true&only_confirmed=true&limit=1'],
  toncenter: ['https://toncenter.com/api/v2/getTransactions?address=EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N&limit=1'],
  algonode: ['https://mainnet-idx.algonode.cloud/health'],
  xrplcluster: ['https://xrplcluster.com/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"method":"server_info","params":[{}]}' }],
};
const out = {};
await Promise.all(Object.entries(SRC).map(async ([k, [u, init]]) => {
  const t0 = Date.now();
  try {
    const r = await fetch(u, { ...(init || {}), headers: { accept: 'application/json', 'user-agent': 'CloudGold/1.0', ...((init && init.headers) || {}) }, signal: AbortSignal.timeout(T) });
    const txt = await r.text();
    let shape;
    try { const j = JSON.parse(txt); shape = Array.isArray(j) ? 'array[' + j.length + ']' : JSON.stringify(j).slice(0, 300); } catch (e) { shape = 'not-json: ' + txt.slice(0, 120).replace(/\s+/g, ' '); }
    out[k] = { status: r.status, ms: Date.now() - t0, body: shape };
  } catch (e) { out[k] = { error: String(e.cause?.code || e.message || e).slice(0, 100), ms: Date.now() - t0 }; }
}));
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(14), JSON.stringify(v));
