/* Free delayed NSE quotes via Yahoo Finance chart API.
   ~15-min delayed — sized for 1–3 day swing setups, not intraday.
   No order-book depth on this tier (bidQty/askQty = null); the
   Order-flow criterion shows NO DATA until you connect Kite.
   Keep REFRESH_MS >= 60000 and pace requests to stay a good citizen. */

const UA = { headers: { "User-Agent": "Mozilla/5.0 (trinetra-screener)" } };

async function fetchOne(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?interval=1d&range=1y`;
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(`${symbol}: HTTP ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  if (!res) throw new Error(`${symbol}: empty`);

  const q = res.indicators.quote[0];
  const closes = (q.close || []).filter(v => v != null);
  const vols = (q.volume || []).filter(v => v != null);
  const meta = res.meta;

  const price = meta.regularMarketPrice ?? closes.at(-1);
  const prevClose = meta.chartPreviousClose ?? closes.at(-2);
  const last20 = closes.slice(-21, -1);
  const vol20 = vols.slice(-21, -1);

  return {
    symbol,
    name: meta.longName || meta.shortName || symbol,
    sector: "",
    price,
    prevClose,
    high20: last20.length ? Math.max(...last20) : price,
    high52: Math.max(...closes.slice(-250), price),
    avgVol20: vol20.length ? Math.round(vol20.reduce((a, b) => a + b, 0) / vol20.length) : 0,
    volToday: vols.at(-1) ?? 0,
    bidQty: null,
    askQty: null,
  };
}

export async function yahooDelayed(symbols) {
  const out = [];
  for (const s of symbols) {
    try {
      out.push(await fetchOne(s));
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn("[yahooDelayed]", e.message);
    }
  }
  return out;
}
