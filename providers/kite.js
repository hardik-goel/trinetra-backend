/* Zerodha Kite Connect — LIVE feed with real order-book depth.
   This is the upgrade that turns on your 4th criterion (buyers/sellers %)
   and drops latency from ~15 min to ~1–3 s.

   Enable (after subscribing, ₹2,000/mo):
     1. npm install
     2. developers.kite.trade → create app → API key + secret
     3. Daily login → access_token (Kite tokens expire each morning;
        automate via the request_token redirect or refresh manually)
     4. Env: PROVIDER=kite, KITE_API_KEY, KITE_ACCESS_TOKEN
   For sub-second streaming later, see startKiteTicker() at the bottom. */

import { KiteConnect } from "kiteconnect";

const BATCH = 500;      // getQuote accepts ~500 instruments per call
const HIST_DAYS = 250;  // ~1 trading year, enough for high52
const IST_OFFSET_MS = 5.5 * 60 * 60_000;

let kc = null;
function client() {
  if (kc) return kc;
  const api_key = process.env.KITE_API_KEY;
  const access_token = process.env.KITE_ACCESS_TOKEN;
  if (!api_key || !access_token) throw new Error("KITE_API_KEY / KITE_ACCESS_TOKEN not set");
  kc = new KiteConnect({ api_key });
  kc.setAccessToken(access_token);
  return kc;
}

// Kite tokens die every morning; that failure looks different from a network
// blip and deserves a fix-it message rather than a generic stack trace.
const isAuthError = e =>
  /token|permission|forbidden|unauthor|invalid.*api/i.test(`${e?.error_type || ""} ${e?.message || ""}`);

// Slow-moving fields need daily candles, which are far too expensive to pull
// every refresh cycle. Fetch once per IST trading day and keep them in memory.
const daily = new Map(); // symbol → { day, high20, high52, avgVol20 }
const loggedMiss = new Map(); // symbol → day, so a broken history logs once a day
const istDay = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function dailyStats(symbol, token) {
  const day = istDay();
  const hit = daily.get(symbol);
  if (hit?.day === day) return hit;

  const to = new Date(Date.now() + IST_OFFSET_MS);
  const from = new Date(to.getTime() - HIST_DAYS * 24 * 3600_000);
  const iso = d => d.toISOString().slice(0, 10);
  try {
    const candles = await client().getHistoricalData(token, "day", iso(from), iso(to));
    const closes = (candles || []).map(c => +c.close).filter(v => Number.isFinite(v) && v > 0);
    const vols = (candles || []).map(c => +c.volume).filter(v => Number.isFinite(v));
    if (!closes.length) throw new Error("no candles");
    // Same windows the free providers use: the 20 sessions before the latest.
    const last20 = closes.slice(-21, -1);
    const vol20 = vols.slice(-21, -1);
    const stats = {
      day,
      high20: last20.length ? Math.max(...last20) : null,
      high52: Math.max(...closes.slice(-HIST_DAYS)),
      avgVol20: vol20.length ? Math.round(vol20.reduce((a, b) => a + b, 0) / vol20.length) : null,
    };
    daily.set(symbol, stats);
    return stats;
  } catch (e) {
    // Nulls, not guesses — the Breakout criterion reads NO DATA and never fires
    // on a field we could not actually establish.
    if (loggedMiss.get(symbol) !== day) {
      loggedMiss.set(symbol, day);
      console.warn(`[kite] ${symbol}: daily history unavailable (${e.message}) — high20/high52/avgVol20 null today`);
    }
    return { day: null, high20: null, high52: null, avgVol20: null };
  }
}

export async function kite(symbols) {
  let quotes = {};
  try {
    const kcc = client();
    for (const group of chunk(symbols, BATCH)) {
      Object.assign(quotes, await kcc.getQuote(group.map(s => `NSE:${s}`)));
    }
  } catch (e) {
    if (/not set/.test(e.message)) console.error("[kite] not configured — set KITE_API_KEY and KITE_ACCESS_TOKEN (see README)");
    else if (isAuthError(e)) console.error("[kite] auth failed — refresh KITE_ACCESS_TOKEN (Kite tokens expire daily): " + e.message);
    else console.error("[kite] quote fetch failed:", e.message);
    return []; // degrade to an empty cycle rather than taking the service down
  }

  const out = [];
  for (const s of symbols) {
    const d = quotes[`NSE:${s}`];
    if (!d) { console.warn(`[kite] ${s}: no quote returned`); continue; }
    try {
      // The real order-book depth — the thing no free feed can give you.
      const bidQty = (d.depth?.buy || []).reduce((a, b) => a + (b.quantity || 0), 0);
      const askQty = (d.depth?.sell || []).reduce((a, b) => a + (b.quantity || 0), 0);
      const stats = await dailyStats(s, d.instrument_token);
      out.push({
        symbol: s, name: s, sector: "",
        price: d.last_price, prevClose: d.ohlc?.close ?? d.last_price,
        high20: stats.high20, high52: stats.high52, avgVol20: stats.avgVol20,
        volToday: d.volume ?? 0,
        bidQty: bidQty || null, askQty: askQty || null,
      });
    } catch (e) {
      console.warn(`[kite] ${s}: skipped (${e.message})`);
    }
  }
  return out;
}

/* ---------------------------------------------------------------
   FUTURE: sub-second streaming. getQuote polling above is ~1–3s;
   KiteTicker in mode "full" pushes depth on every tick instead.
   Deliberately not wired — flipping to a push model means the
   refresh loop in index.js stops driving the snapshot, so it is a
   separate change with its own testing.

   import { KiteTicker } from "kiteconnect";
   export function startKiteTicker(symbols, onTick) {
     const t = new KiteTicker({ api_key: process.env.KITE_API_KEY, access_token: process.env.KITE_ACCESS_TOKEN });
     t.connect();
     t.on("connect", () => { t.subscribe(tokens); t.setMode(t.modeFull, tokens); });
     t.on("ticks", onTick);   // feed the snapshot instead of polling
     t.on("noreconnect", () => console.error("[kite] ticker gave up — falling back to polling"));
     return t;
   }
   --------------------------------------------------------------- */
