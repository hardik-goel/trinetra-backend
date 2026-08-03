/* Indicators the sell / buy-back cycle needs, all from the OHLCV already fetched.

   Each returns null rather than a number when the history is too short. A
   momentum reading computed from nine bars is not a momentum reading, and a
   criterion is better off skipped — the engine treats null as unanswerable and
   refuses to let it veto anything. */

const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);

/** Wilder's RSI. Needs len+1 bars to seed and is null below that. */
export function rsi(candles, len = 14) {
  if (!candles || candles.length < len + 1) return null;
  let gain = 0, loss = 0;
  for (let i = candles.length - len; i < candles.length; i++) {
    const d = candles[i].c - candles[i - 1].c;
    if (d >= 0) gain += d; else loss -= d;
  }
  const avgGain = gain / len, avgLoss = loss / len;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return round2(100 - 100 / (1 + rs));
}

/** RSI a few bars back, for "dipped then turned up". */
export const rsiAt = (candles, backBars, len = 14) =>
  rsi((candles || []).slice(0, candles.length - backBars), len);

/* Bearish divergence: price prints a higher high while RSI does not. Only
   reported when both legs are clearly identifiable — a divergence eyeballed off
   two adjacent bars is pattern-matching, not evidence. */
export function bearishDivergence(candles, len = 14, lookback = 40) {
  if (!candles || candles.length < lookback + len) return null;
  const recent = candles.slice(-lookback);
  let hi1 = -1, hi2 = -1;
  for (let i = 2; i < recent.length - 2; i++) {
    const h = recent[i].h;
    if (h >= recent[i - 1].h && h >= recent[i - 2].h && h >= recent[i + 1].h && h >= recent[i + 2].h) {
      hi2 = hi1; hi1 = i;
    }
  }
  if (hi1 < 0 || hi2 < 0) return null;
  const base = candles.length - lookback;
  const r1 = rsi(candles.slice(0, base + hi1 + 1), len);
  const r2 = rsi(candles.slice(0, base + hi2 + 1), len);
  if (r1 == null || r2 == null) return null;
  const priceHigher = recent[hi1].h > recent[hi2].h;
  return { present: priceHigher && r1 < r2, priceHigh: round2(recent[hi1].h), rsiNow: r1, rsiPrior: r2 };
}

const sma = (candles, n) =>
  !candles || candles.length < n ? null
    : candles.slice(-n).reduce((a, c) => a + c.c, 0) / n;

/** How stretched price is above its own mean — the mean-reversion argument. */
export const extensionVs = (candles, price, n) => {
  const m = sma(candles, n);
  return m ? round2(pct(m, price)) : null;
};

/** A large up-move on exceptional volume, often with a long upper wick: the
    shape of buyers being exhausted rather than buyers arriving. */
export function volumeClimax(candles, avgVol20) {
  const c = candles?.at(-1);
  if (!c || !avgVol20) return null;
  const mult = (c.v || 0) / avgVol20;
  const range = c.h - c.l;
  const upperWick = range > 0 ? (c.h - Math.max(c.c, c.o)) / range : 0;
  const up = pct(c.o, c.c);
  return {
    volumeMultiple: round2(mult),
    upperWickShare: round2(upperWick * 100),
    dayGainPct: round2(up),
    // Scored so the criterion can threshold one number; the parts are reported
    // so a reader can disagree with the composite.
    score: round2(mult >= 3 && (upperWick > 0.4 || up > 3) ? mult : 0),
  };
}

/** Volume falling through a pullback, then expanding on the turn — sellers
    running out of conviction before buyers return. */
export function dryUpThenExpansion(candles, avgVol20, window = 6) {
  if (!candles || candles.length < window + 2 || !avgVol20) return null;
  const w = candles.slice(-window);
  const before = w.slice(0, -1);
  const today = w.at(-1);
  const avgBefore = before.reduce((a, c) => a + (c.v || 0), 0) / before.length;
  const driedUp = avgBefore < avgVol20 * 0.8;
  const expanded = (today.v || 0) > avgBefore * 1.4;
  return {
    driedUp, expanded,
    pullbackAvgMultiple: round2(avgBefore / avgVol20),
    todayMultiple: round2((today.v || 0) / avgVol20),
    score: driedUp && expanded ? 1 : 0,
  };
}

/** Is the longer-term trend still intact? A pullback inside an uptrend is an
    opportunity; the same fall below the trend is a falling knife, and the
    difference decides whether a buy-back should exist at all. */
export function trendIntact(candles, price, n = 50) {
  const m = sma(candles, n);
  if (!m) return null;
  return { intact: price > m, ma: round2(m), distancePct: round2(pct(m, price)), length: n };
}

export { sma };
