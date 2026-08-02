/* Free delayed NSE quotes via Yahoo Finance chart API.
   ~15-min delayed — sized for 1–3 day swing setups, not intraday.
   No order-book depth on this tier (bidQty/askQty = null); the
   Order-flow criterion shows NO DATA until you connect Kite.
   Keep REFRESH_MS >= 60000 and pace requests to stay a good citizen. */

const UA = { headers: { "User-Agent": "Mozilla/5.0 (trinetra-screener)" } };

// meta.chartPreviousClose is sometimes stale or misaligned with the daily
// candles, which turns (price-prevClose)/prevClose into nonsense (+123% days).
// Derive both ends from the series instead, and treat meta as a hint we only
// accept when it corroborates the series.
const MAX_DAY_MOVE = 0.25; // >25% on a free delayed feed is an artifact, not a move
const META_TOLERANCE = 0.20; // meta price must agree with the latest close this closely

const validCloses = a => (a || []).filter(v => Number.isFinite(v) && v > 0);

async function fetchOne(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?interval=1d&range=1y`;
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(`${symbol}: HTTP ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  if (!res) throw new Error(`${symbol}: empty`);

  const q = res.indicators.quote[0];
  const closes = validCloses(q.close);
  const vols = (q.volume || []).filter(v => v != null);
  const meta = res.meta;
  if (!closes.length) throw new Error(`${symbol}: no valid closes`);

  const lastClose = closes.at(-1);
  const metaPrice = meta.regularMarketPrice;
  const metaUsable = Number.isFinite(metaPrice) && metaPrice > 0 &&
    Math.abs(metaPrice - lastClose) / lastClose <= META_TOLERANCE;
  const price = metaUsable ? metaPrice : lastClose;

  let prevClose = closes.at(-2) ?? price;
  if (Math.abs(price - prevClose) / prevClose > MAX_DAY_MOVE) {
    console.warn(`[yahooDelayed] ${symbol}: implausible day move — price ${price} vs prevClose ${prevClose}; clamping to 0%`);
    prevClose = price;
  }

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
