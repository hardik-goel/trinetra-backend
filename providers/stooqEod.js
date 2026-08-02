/* Stooq free end-of-day NSE data — no key, permissive, reliable.
   Returns daily OHLCV as CSV; NSE symbols use the ".in" suffix
   (e.g. polycab.in). This is EOD/delayed, ideal for swing setups.
   No intraday and no order-book depth (Kite-only). */

const MAX_DAY_MOVE = 0.25; // >25% between two EOD closes is a data artifact, not a move

async function fetchCsv(symbol) {
  // d1 = daily interval, i=d
  const url = `https://stooq.com/q/d/l/?s=${symbol.toLowerCase()}.in&i=d`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (trinetra)" } });
  if (!r.ok) throw new Error(`${symbol}: HTTP ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split("\n");
  if (lines.length < 3 || lines[0].startsWith("<")) throw new Error(`${symbol}: no data`);
  // header: Date,Open,High,Low,Close,Volume
  // Drop unparseable/blank closes here so closes and vols stay index-aligned.
  const rows = lines.slice(1).map(l => l.split(","))
    .filter(c => c.length >= 6 && Number.isFinite(+c[4]) && +c[4] > 0);
  if (!rows.length) throw new Error(`${symbol}: no valid closes`);
  const closes = rows.map(c => +c[4]);
  const vols = rows.map(c => +c[5]);
  const price = closes.at(-1);
  let prevClose = closes.at(-2) ?? price;
  if (Math.abs(price - prevClose) / prevClose > MAX_DAY_MOVE) {
    console.warn(`[stooqEod] ${symbol}: implausible day move — price ${price} vs prevClose ${prevClose}; clamping to 0%`);
    prevClose = price;
  }
  const last20 = closes.slice(-21, -1);
  const vol20 = vols.slice(-21, -1);
  return {
    symbol,
    name: symbol,
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

export async function stooqEod(symbols) {
  const out = [];
  for (const s of symbols) {
    try {
      out.push(await fetchCsv(s));
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      console.warn("[stooqEod]", e.message);
    }
  }
  return out;
}
