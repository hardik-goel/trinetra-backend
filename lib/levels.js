/* Technical levels — candidate prices where the market has actually reacted.

   Nothing here decides anything. Each method contributes CANDIDATES, and the
   playbook decides which are real by looking for agreement between methods that
   do not share a premise. A level found by one method is an opinion; the same
   level found by four is a level.

   Every candidate carries where it came from and how strong it is, because the
   evidence list has to name its sources and the user has to be able to disagree
   with any one of them. */

const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const pct = (a, b) => (a > 0 ? ((b - a) / a) * 100 : null);

export const DEFAULTS = {
  pivotWindow: 3,        // N lower highs either side to call a swing high
  clusterTolPct: 0.75,   // prices within this band are the same level
  fibMinMovePct: 8,      // a leg smaller than this is noise, not a swing
  volumeBins: 40,
  atrLen: 14,
};

/** ATR in rupees and as a percentage — every zone is sized from this, because a
    level quoted to the paisa on a stock that swings 3% a day is false precision. */
export function atr(candles, n = DEFAULTS.atrLen) {
  if (!candles || candles.length < n + 1) return null;
  const trs = [];
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    if (!c || !p) continue;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  if (!trs.length) return null;
  const v = trs.reduce((a, b) => a + b, 0) / trs.length;
  const last = candles.at(-1).c;
  return { value: round2(v), pct: last > 0 ? round2((v / last) * 100) : null };
}

/** Swing pivots: a high with `w` lower highs either side (and the mirror for
    lows). The turning points a human would mark on a chart. */
export function pivots(candles, w = DEFAULTS.pivotWindow) {
  const out = [];
  for (let i = w; i < candles.length - w; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (candles[j].h >= c.h) isHigh = false;
      if (candles[j].l <= c.l) isLow = false;
    }
    if (isHigh) out.push({ price: c.h, type: "high", idx: i, t: c.t });
    if (isLow) out.push({ price: c.l, type: "low", idx: i, t: c.t });
  }
  return out;
}

/** Collapse pivots that sit within a tolerance band into one level. A price
    touched four times is a different object from one touched twice, and the
    count is the whole point. */
export function clusters(points, tolPct = DEFAULTS.clusterTolPct, total = 1) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const groups = [];
  for (const p of sorted) {
    const g = groups.at(-1);
    if (g && Math.abs(p.price - g.mean) / g.mean * 100 <= tolPct) {
      g.members.push(p);
      g.mean = g.members.reduce((a, m) => a + m.price, 0) / g.members.length;
    } else {
      groups.push({ mean: p.price, members: [p] });
    }
  }
  return groups.map(g => {
    const touches = g.members.length;
    const lastIdx = Math.max(...g.members.map(m => m.idx));
    // Recency matters: a level defended last month is live, one from two years
    // ago is archaeology.
    const recency = total > 1 ? lastIdx / (total - 1) : 1;
    const kind = g.members.filter(m => m.type === "high").length >= touches / 2 ? "resistance" : "support";
    return {
      price: round2(g.mean),
      type: kind,
      touches,
      lastTouched: new Date(Math.max(...g.members.map(m => m.t))).toISOString().slice(0, 10),
      lastIdx,
      strength: round2(Math.min(1, (touches / 5) * 0.7 + recency * 0.3)),
    };
  });
}

const sma = (candles, n) => {
  if (!candles || candles.length < n) return null;
  return round2(candles.slice(-n).reduce((a, c) => a + c.c, 0) / n);
};

export function movingAverages(candles) {
  return { ma20: sma(candles, 20), ma50: sma(candles, 50), ma200: sma(candles, 200) };
}

/** Fibonacci retracements of the most recent leg worth calling a leg. */
export function fibonacci(candles, minMovePct = DEFAULTS.fibMinMovePct) {
  const ps = pivots(candles);
  if (ps.length < 2) return null;
  // Walk back for the newest high/low pair that spans a real move.
  for (let i = ps.length - 1; i > 0; i--) {
    for (let j = i - 1; j >= 0; j--) {
      const a = ps[j], b = ps[i];
      if (a.type === b.type) continue;
      const move = Math.abs(pct(Math.min(a.price, b.price), Math.max(a.price, b.price)));
      if (move < minMovePct) continue;
      const hi = Math.max(a.price, b.price), lo = Math.min(a.price, b.price);
      const up = b.price > a.price; // leg direction: retracements pull back against it
      const level = r => round2(up ? hi - (hi - lo) * r : lo + (hi - lo) * r);
      return {
        from: round2(a.price), to: round2(b.price), direction: up ? "up" : "down",
        movePct: round2(move),
        levels: [
          { ratio: 0.382, price: level(0.382) },
          { ratio: 0.5, price: level(0.5) },
          { ratio: 0.618, price: level(0.618) },
        ],
      };
    }
  }
  return null;
}

/** Approximate volume profile: a year of closes bucketed by price and weighted
    by volume. The heavy buckets are where business was actually done, which is
    why they act as support and resistance. */
export function volumeProfile(candles, bins = DEFAULTS.volumeBins) {
  const window = candles.slice(-250);
  if (window.length < 30) return null;
  const lo = Math.min(...window.map(c => c.l));
  const hi = Math.max(...window.map(c => c.h));
  if (!(hi > lo)) return null;
  const size = (hi - lo) / bins;
  const buckets = Array.from({ length: bins }, (_, i) => ({ low: lo + i * size, high: lo + (i + 1) * size, volume: 0 }));
  for (const c of window) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((c.c - lo) / size)));
    buckets[i].volume += c.v || 0;
  }
  const total = buckets.reduce((a, b) => a + b.volume, 0) || 1;
  const ranked = buckets.map(b => ({
    price: round2((b.low + b.high) / 2),
    volume: b.volume,
    share: round2((b.volume / total) * 100),
  })).sort((a, b) => b.volume - a.volume);
  return { poc: ranked[0], nodes: ranked.slice(0, 6) };
}

export function rangeExtremes(candles) {
  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h), lows = candles.map(c => c.l);
  const at = (arr, n, fn) => (arr.length ? round2(fn(...arr.slice(-n))) : null);
  return {
    high20: at(highs, 20, Math.max), low20: at(lows, 20, Math.min),
    high52: at(highs, 250, Math.max), low52: at(lows, 250, Math.min),
    // "All time" is only as old as the data — two years here, and it says so.
    highestSeen: round2(Math.max(...highs)), lowestSeen: round2(Math.min(...lows)),
    lastClose: round2(closes.at(-1)),
  };
}

/** Psychological levels. Weakest of the methods, useful only as a tie-breaker —
    included so a cluster sitting on a round number gets its due, not so a round
    number can become a target on its own. */
export function roundNumbers(price, near = 2) {
  /* Only the nearest few. Emitting one every ₹100 across a 30% span floods the
     clustering with two dozen weightless candidates that drown the levels that
     were actually earned. */
  const mag = Math.pow(10, Math.max(1, String(Math.floor(price)).length - 2));
  const base = Math.round(price / mag);
  const out = [];
  for (let k = -near; k <= near; k++) {
    const p = (base + k) * mag;
    if (p > 0) out.push(round2(p));
  }
  return out;
}

/**
 * Every candidate level for a stock, from every method, in one flat list.
 * The playbook clusters these — this function deliberately does no judging.
 */
export function candidates(stock, opts = {}) {
  const candles = stock.candles || [];
  const cfg = { ...DEFAULTS, ...opts };
  const price = stock.price;
  const out = [];
  if (candles.length < 40) return { candidates: out, atr: null, insufficient: true, bars: candles.length };

  const a = atr(candles, cfg.atrLen);
  const ps = pivots(candles, cfg.pivotWindow);
  const cls = clusters(ps, cfg.clusterTolPct, candles.length);

  for (const c of cls) {
    if (c.touches < 2) continue; // a single touch is a point, not a level
    /* What a level IS now depends on which side of it price sits, not on how it
       formed: support that price has fallen through is resistance above, and
       calling it support would put a target below the current price. How it
       formed is kept, because "old support, now resistance" is the useful
       reading. */
    out.push({
      price: c.price, type: c.price < price ? "support" : "resistance",
      formedAs: c.type, flipped: (c.price < price) !== (c.type === "support"),
      source: "Technical", method: "swing cluster",
      strength: c.strength, touches: c.touches, lastTouched: c.lastTouched,
      note: `Touched ${c.touches} time${c.touches === 1 ? "" : "s"}, last ${c.lastTouched}` +
        ((c.price < price) !== (c.type === "support") ? ` — former ${c.type}, now ${c.price < price ? "support" : "resistance"}` : ""),
    });
  }

  const ma = movingAverages(candles);
  for (const [name, v] of Object.entries(ma)) {
    if (!v) continue;
    out.push({
      price: v, type: v < price ? "support" : "resistance", source: "Technical",
      method: `${name.replace("ma", "")}-day MA`, strength: name === "ma200" ? 0.7 : name === "ma50" ? 0.6 : 0.5,
      note: `${name.replace("ma", "")}-day moving average, ${v < price ? "below" : "above"} price`,
    });
  }

  const fib = fibonacci(candles, cfg.fibMinMovePct);
  if (fib) for (const l of fib.levels) {
    out.push({
      price: l.price, type: l.price < price ? "support" : "resistance", source: "Technical",
      method: `Fib ${(l.ratio * 100).toFixed(1)}%`, strength: l.ratio === 0.618 ? 0.6 : 0.5,
      note: `${(l.ratio * 100).toFixed(1)}% retracement of the ${fib.movePct}% ${fib.direction} leg`,
    });
  }

  const vp = volumeProfile(candles, cfg.volumeBins);
  if (vp) {
    out.push({
      price: vp.poc.price, type: vp.poc.price < price ? "support" : "resistance", source: "Technical",
      method: "volume point of control", strength: 0.8,
      note: `Heaviest traded price band of the last year (${vp.poc.share}% of volume)`,
    });
    for (const n of vp.nodes.slice(1, 4)) {
      out.push({
        price: n.price, type: n.price < price ? "support" : "resistance", source: "Technical",
        method: "volume node", strength: 0.6,
        note: `High-volume band (${n.share}% of the year's volume)`,
      });
    }
  }

  const ext = rangeExtremes(candles);
  for (const [k, label, strength] of [
    ["high20", "20-day high", 0.6], ["low20", "20-day low", 0.6],
    ["high52", "52-week high", 0.85], ["low52", "52-week low", 0.85],
  ]) {
    if (!ext[k]) continue;
    out.push({
      price: ext[k], type: k.startsWith("high") ? "resistance" : "support",
      source: "Technical", method: label, strength,
      note: `${label} over the available history`,
    });
  }

  for (const p of roundNumbers(price)) {
    out.push({
      price: p, type: p < price ? "support" : "resistance", source: "Technical",
      method: "round number", strength: 0.2,
      note: "Psychological level — a tie-breaker, not a reason on its own",
    });
  }

  return { candidates: out, atr: a, fib, volumeProfile: vp, movingAverages: ma, extremes: ext, bars: candles.length };
}
