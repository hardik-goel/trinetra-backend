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

/* Intraday bars are a second request, so they are only fetched when an intraday
   profile is actually enabled. Cached for a minute: the feed is ~15 min delayed,
   so asking more often than the refresh cycle buys nothing but rate limits. */
const intradayCache = new Map(); // symbol -> { at, bars }
const INTRADAY_TTL_MS = 60_000;

async function fetchIntraday(symbol) {
  const hit = intradayCache.get(symbol);
  if (hit && Date.now() - hit.at < INTRADAY_TTL_MS) return hit.bars;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?interval=5m&range=5d`;
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(`${symbol}: intraday HTTP ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  const q = res?.indicators?.quote?.[0];
  if (!res || !q) throw new Error(`${symbol}: intraday empty`);
  const bars = (res.timestamp || []).map((t, i) => ({
    t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i],
  })).filter(b => Number.isFinite(b.c) && Number.isFinite(b.v));
  intradayCache.set(symbol, { at: Date.now(), bars });
  return bars;
}

async function fetchOne(symbol, wantIntraday) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?interval=1d&range=2y`;
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(`${symbol}: HTTP ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  if (!res) throw new Error(`${symbol}: empty`);

  const q = res.indicators.quote[0];
  const closes = validCloses(q.close);
  const vols = (q.volume || []).filter(v => v != null);
  const meta = res.meta;
  if (!closes.length) throw new Error(`${symbol}: no valid closes`);

  // The full daily series, kept so the analysis layer can measure ATR, find
  // resistance and scan for historical analogs. Nothing downstream re-fetches.
  const candles = (res.timestamp || []).map((t, i) => ({
    t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i],
  })).filter(c => Number.isFinite(c.c) && Number.isFinite(c.h) && Number.isFinite(c.l));

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

  const lastBar = candles.at(-1) || {};
  const out = {
    symbol,
    name: meta.longName || meta.shortName || symbol,
    sector: meta.sector || "",
    price,
    prevClose,
    high20: last20.length ? Math.max(...last20) : price,
    // 50-day high drives the positional profile's breakout, the same way
    // high20 drives swing.
    high50: closes.length > 1 ? Math.max(...closes.slice(-51, -1)) : price,
    low20: closes.length > 1 ? Math.min(...closes.slice(-21, -1)) : price,
    high52: Math.max(...closes.slice(-250), price),
    dayHigh: Number.isFinite(lastBar.h) ? lastBar.h : price,
    dayLow: Number.isFinite(lastBar.l) ? lastBar.l : price,
    dayOpen: Number.isFinite(lastBar.o) ? lastBar.o : price,
    avgVol20: vol20.length ? Math.round(vol20.reduce((a, b) => a + b, 0) / vol20.length) : 0,
    volToday: vols.at(-1) ?? 0,
    // Three-session participation, for "is the volume that justified this
    // still here" rather than a single hot bar.
    avgVol3: vols.length >= 3 ? Math.round(vols.slice(-3).reduce((a, b) => a + b, 0) / 3) : (vols.at(-1) ?? 0),
    bidQty: null,
    askQty: null,
    candles,
  };

  if (wantIntraday) {
    try {
      out.intradayBars = await fetchIntraday(symbol);
    } catch (e) {
      // Intraday is a bonus request; losing it must not lose the quote. The
      // intraday criteria then read NO DATA, which is the honest outcome.
      console.warn("[yahooDelayed]", e.message);
    }
  }
  return out;
}

export async function yahooDelayed(symbols, opts = {}) {
  const out = [];
  for (const s of symbols) {
    try {
      out.push(await fetchOne(s, !!opts.intraday));
      await new Promise(r => setTimeout(r, opts.intraday ? 450 : 300));
    } catch (e) {
      console.warn("[yahooDelayed]", e.message);
    }
  }
  return out;
}
