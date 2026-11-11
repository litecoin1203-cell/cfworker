// TEMPORARY diagnostic (no secrets): exact answer shapes of the replacement price sources.
const get = async (u) => { const r = await fetch(u, { headers: { accept: 'application/json', 'user-agent': 'CloudGold/1.0' }, signal: AbortSignal.timeout(9000) }); return [r.status, await r.text()]; };
const [s1, t1] = await get('https://api1.tabdeal.org/r/plots/market_information/');
try { console.log('tabdeal', s1, t1.length, JSON.stringify(JSON.parse(t1).find((x) => x.symbol === 'USDT_IRT'))); } catch (e) { console.log('tabdeal', s1, e.message); }
const [s2, t2] = await get('https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls');
console.log('nobitex', s2, t2.slice(0, 400));
const [s3, t3] = await get('https://api.exir.io/v2/ticker?symbol=usdt-irt');
console.log('exir', s3, t3);
const [s4, t4] = await get('https://api.kucoin.com/api/v1/prices?base=USD&currencies=TON,TONCOIN');
console.log('kucoin TON', s4, t4);
const [s5, t5] = await get('https://api.coinbase.com/v2/exchange-rates?currency=USD');
console.log('coinbase', s5, t5.length);
const [s6, t6] = await get('https://api.wallex.ir/v1/markets');
console.log('wallex size', s6, t6.length);
