// TEMPORARY diagnostic (no secrets): the FIXED price code against the real APIs.
import { fetchUsdRate } from '../../worker/src/usdrate.js';
import { fetchPrices } from '../../worker/src/coins.js';
console.log('fetchUsdRate ->', JSON.stringify(await fetchUsdRate()));
console.log('fetchPrices ->', JSON.stringify(await fetchPrices()));
const { PRICE_SOURCES, COINS } = await import('../../worker/src/coins.js');
for (const s of PRICE_SOURCES) { try { const p = await s.read(); console.log(s.id, Object.keys(p).length, COINS.filter((c) => !p[c.id]).map((c) => c.id).join(',') || 'all'); } catch (e) { console.log(s.id, 'ERR', e.message); } }
