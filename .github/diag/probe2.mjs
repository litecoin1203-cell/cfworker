// TEMPORARY diagnostic (no secrets): run the Worker's OWN price code from a server outside Iran,
// and try candidate replacement sources.
import { fetchUsdRate } from '../../worker/src/usdrate.js';
import { prices } from '../../worker/src/coins.js';
const env = { DB: { prepare() { throw new Error('no db in probe'); } } };
console.log('fetchUsdRate ->', JSON.stringify(await fetchUsdRate()));
try { console.log('prices ->', JSON.stringify(await prices(env))); } catch (e) { console.log('prices threw', e.message); }
const C = {
  nobitex_v2: ['https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls'],
  nobitex_get: ['https://api.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls'],
  tabdeal_api: ['https://api.tabdeal.org/r/api/v1/ticker/price?symbol=USDTIRT'],
  tabdeal_api1_depth: ['https://api1.tabdeal.org/r/api/v1/depth?symbol=USDTIRT&limit=5'],
  tabdeal_market: ['https://api1.tabdeal.org/r/plots/market_information/'],
  ompfinex: ['https://api.ompfinex.com/v1/market'],
  excoino: ['https://api.excoino.com/market/symbol-thumb'],
  okex_ir: ['https://azapi.ok-ex.io/oapi/v1/market/ticker?symbol=USDT-IRT'],
  exir: ['https://api.exir.io/v2/ticker?symbol=usdt-irt'],
  aban: ['https://abantether.com/management/all-coins/?format=json'],
  wallex_usdt_tmn: ['https://api.wallex.ir/v1/markets'],
  wallex_all: ['https://api.wallex.ir/hector/web/v1/markets'],
  coinbase: ['https://api.coinbase.com/v2/exchange-rates?currency=USD'],
  coinpaprika: ['https://api.coinpaprika.com/v1/tickers?quotes=USD&limit=300'],
  kucoin: ['https://api.kucoin.com/api/v1/prices?base=USD&currencies=XLM,XRP,TRX,SOL,TON,LTC,DOGE,BCH,BNB,POL,ALGO'],
  binance: ['https://api.binance.com/api/v3/ticker/price?symbols=%5B%22XLMUSDT%22,%22TONUSDT%22%5D'],
  okx: ['https://www.okx.com/api/v5/market/tickers?instType=SPOT'],
};
await Promise.all(Object.entries(C).map(async ([k, [u]]) => {
  try {
    const r = await fetch(u, { headers: { accept: 'application/json', 'user-agent': 'CloudGold/1.0' }, signal: AbortSignal.timeout(9000) });
    const t = await r.text();
    let s = t.slice(0, 160).replace(/\s+/g, ' ');
    if (k === 'wallex_usdt_tmn') { try { s = JSON.stringify(JSON.parse(t).result.symbols.USDTTMN.stats); } catch (e) { s = 'no USDTTMN: ' + e.message; } }
    if (k === 'coinbase') { try { const d = JSON.parse(t).data.rates; s = ['XLM','XRP','TRX','SOL','TON','LTC','DOGE','BCH','BNB','POL','ALGO'].map((x) => x + '=' + d[x]).join(' '); } catch (e) {} }
    if (k === 'kucoin') s = t.slice(0, 400);
    console.log(k.padEnd(20), r.status, s);
  } catch (e) { console.log(k.padEnd(20), 'ERR', String(e.cause?.code || e.message).slice(0, 80)); }
}));
