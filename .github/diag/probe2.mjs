// TEMPORARY diagnostic (no secrets): small single-market endpoints.
const get = async (u) => { const r = await fetch(u, { headers: { accept: 'application/json', 'user-agent': 'CloudGold/1.0' }, signal: AbortSignal.timeout(9000) }); return [r.status, await r.text()]; };
for (const u of ['https://api.wallex.ir/v1/depth?symbol=USDTTMN', 'https://api1.tabdeal.org/r/api/v1/depth?symbol=USDTIRT&limit=3', 'https://api.wallex.ir/v1/trades?symbol=USDTTMN']) {
  const [s, t] = await get(u); console.log(u, s, t.length, t.slice(0, 500));
}
