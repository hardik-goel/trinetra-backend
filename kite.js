/* Zerodha Kite Connect — LIVE feed with real order-book depth.
   This is the upgrade that turns on your 4th criterion (buyers/sellers %)
   and drops latency from ~15 min to ~1–3 s.

   Enable (after subscribing, ₹2,000/mo):
     1. npm install kiteconnect
     2. developers.kite.trade → create app → API key + secret
     3. Daily login → access_token (Kite tokens expire each morning;
        automate via the request_token redirect or refresh manually)
     4. Env: PROVIDER=kite, KITE_API_KEY, KITE_ACCESS_TOKEN
     5. Uncomment the import + registration in index.js
   For sub-second streaming later, replace getQuote polling with the
   KiteTicker websocket in mode "full" (pushes depth on every tick). */

// import { KiteConnect } from "kiteconnect";

export async function kite(symbols) {
  throw new Error("Kite provider not configured — see providers/kite.js");

  /* ---- reference ----
  const kc = new KiteConnect({ api_key: process.env.KITE_API_KEY });
  kc.setAccessToken(process.env.KITE_ACCESS_TOKEN);
  const keys = symbols.map(s => `NSE:${s}`);
  const quote = await kc.getQuote(keys);
  return symbols.map(s => {
    const d = quote[`NSE:${s}`];
    if (!d) return null;
    const bidQty = d.depth.buy.reduce((a, b) => a + b.quantity, 0);
    const askQty = d.depth.sell.reduce((a, b) => a + b.quantity, 0);
    return {
      symbol: s, name: s, sector: "",
      price: d.last_price, prevClose: d.ohlc.close,
      high20: null, high52: null, avgVol20: null, // pull daily via getHistoricalData
      volToday: d.volume, bidQty, askQty,
    };
  }).filter(Boolean);
  ---- */
}
