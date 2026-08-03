/* Candlestick patterns — with the context that decides whether they mean
   anything.

   An unqualified "hammer detected" is noise. The same hammer, formed at a level
   that has held four times, on 2.4x volume, after a pullback, is evidence. So
   every detection carries its context and only context-valid ones are allowed to
   reach the evidence list.

   Reliability is measured on THIS STOCK'S OWN HISTORY, never from a textbook
   table. "Hammers work 60% of the time" is a claim about a book; what matters is
   whether hammers have worked in this name, and how often, and out of how many.
   Under MIN_OCCURRENCES the answer is "insufficient history" — not a rate. */

const MIN_OCCURRENCES = 8;
const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const pct = (a, b) => (a > 0 ? ((b - a) / a) * 100 : null);

const body = c => Math.abs(c.c - c.o);
const range = c => c.h - c.l;
const upper = c => c.h - Math.max(c.c, c.o);
const lower = c => Math.min(c.c, c.o) - c.l;
const bull = c => c.c > c.o;
const bear = c => c.c < c.o;
const small = c => range(c) > 0 && body(c) / range(c) < 0.3;

/* One entry per pattern: how to spot it, and which way it points. Keeping them
   in a table means adding a pattern is a row, and means the backtest treats
   every pattern identically rather than special-casing favourites. */
const PATTERNS = [
  // ── bullish reversal ──
  { key: "hammer", label: "Hammer", dir: "bullish", n: 1,
    test: ([c]) => range(c) > 0 && lower(c) >= 2 * body(c) && upper(c) <= body(c) * 0.6 },
  { key: "inverted_hammer", n: 1, label: "Inverted hammer", dir: "bullish",
    test: ([c]) => range(c) > 0 && upper(c) >= 2 * body(c) && lower(c) <= body(c) * 0.6 },
  { key: "bullish_engulfing", n: 2, label: "Bullish engulfing", dir: "bullish",
    test: ([p, c]) => p && bear(p) && bull(c) && c.c >= p.o && c.o <= p.c && body(c) > body(p) },
  { key: "piercing_line", n: 2, label: "Piercing line", dir: "bullish",
    test: ([p, c]) => p && bear(p) && bull(c) && c.o < p.l && c.c > (p.o + p.c) / 2 && c.c < p.o },
  { key: "morning_star", n: 3, label: "Morning star", dir: "bullish",
    test: ([a, b, c]) => a && b && bear(a) && small(b) && bull(c) && c.c > (a.o + a.c) / 2 },
  { key: "three_white_soldiers", n: 3, label: "Three white soldiers", dir: "bullish",
    test: ([a, b, c]) => a && b && bull(a) && bull(b) && bull(c) && b.c > a.c && c.c > b.c },
  { key: "bullish_harami", n: 2, label: "Bullish harami", dir: "bullish",
    test: ([p, c]) => p && bear(p) && bull(c) && c.o > p.c && c.c < p.o },
  { key: "tweezer_bottom", n: 2, label: "Tweezer bottom", dir: "bullish",
    test: ([p, c]) => p && bear(p) && bull(c) && Math.abs(p.l - c.l) / Math.max(p.l, 1) < 0.002 },
  { key: "dragonfly_doji", n: 1, label: "Dragonfly doji", dir: "bullish",
    test: ([c]) => range(c) > 0 && body(c) / range(c) < 0.1 && lower(c) > range(c) * 0.6 },

  // ── bearish reversal ──
  { key: "shooting_star", n: 1, label: "Shooting star", dir: "bearish",
    test: ([c]) => range(c) > 0 && upper(c) >= 2 * body(c) && lower(c) <= body(c) * 0.6 && bear(c) },
  { key: "hanging_man", n: 1, label: "Hanging man", dir: "bearish",
    test: ([c]) => range(c) > 0 && lower(c) >= 2 * body(c) && upper(c) <= body(c) * 0.6 && bear(c) },
  { key: "bearish_engulfing", n: 2, label: "Bearish engulfing", dir: "bearish",
    test: ([p, c]) => p && bull(p) && bear(c) && c.o >= p.c && c.c <= p.o && body(c) > body(p) },
  { key: "dark_cloud_cover", n: 2, label: "Dark cloud cover", dir: "bearish",
    test: ([p, c]) => p && bull(p) && bear(c) && c.o > p.h && c.c < (p.o + p.c) / 2 && c.c > p.o },
  { key: "evening_star", n: 3, label: "Evening star", dir: "bearish",
    test: ([a, b, c]) => a && b && bull(a) && small(b) && bear(c) && c.c < (a.o + a.c) / 2 },
  { key: "three_black_crows", n: 3, label: "Three black crows", dir: "bearish",
    test: ([a, b, c]) => a && b && bear(a) && bear(b) && bear(c) && b.c < a.c && c.c < b.c },
  { key: "bearish_harami", n: 2, label: "Bearish harami", dir: "bearish",
    test: ([p, c]) => p && bull(p) && bear(c) && c.o < p.c && c.c > p.o },
  { key: "tweezer_top", n: 2, label: "Tweezer top", dir: "bearish",
    test: ([p, c]) => p && bull(p) && bear(c) && Math.abs(p.h - c.h) / Math.max(p.h, 1) < 0.002 },
  { key: "gravestone_doji", n: 1, label: "Gravestone doji", dir: "bearish",
    test: ([c]) => range(c) > 0 && body(c) / range(c) < 0.1 && upper(c) > range(c) * 0.6 },

  // ── continuation / indecision ──
  { key: "doji", n: 1, label: "Doji", dir: "neutral",
    test: ([c]) => range(c) > 0 && body(c) / range(c) < 0.05 },
  { key: "spinning_top", n: 1, label: "Spinning top", dir: "neutral",
    test: ([c]) => range(c) > 0 && body(c) / range(c) < 0.3 && upper(c) > body(c) && lower(c) > body(c) },
  { key: "marubozu", n: 1, label: "Marubozu", dir: "continuation",
    test: ([c]) => range(c) > 0 && body(c) / range(c) > 0.9 },
];

const windowAt = (candles, i, n) => candles.slice(Math.max(0, i - n + 1), i + 1);

/** Every pattern present on the bar at index i.

    Arity is declared per pattern rather than read from test.length: `([p, c])`
    is a single destructured parameter, so length is 1 for two- and three-candle
    patterns alike. Reading it produced single-candle tests being run against the
    previous bar, which flagged a spinning top on more than half of all sessions. */
export function detectAt(candles, i) {
  const out = [];
  const bar = candles[i];
  if (!bar) return out;
  for (const p of PATTERNS) {
    const n = p.n || 1;
    if (i < n - 1) continue;
    const w = candles.slice(i - n + 1, i + 1);
    if (w.length !== n || w.some(c => !c)) continue;
    try { if (p.test(w)) out.push(p); } catch { /* a malformed window is not a pattern */ }
  }
  return [...new Map(out.map(p => [p.key, p])).values()];
}

/* Gaps are classified by where they happen and on what volume, because the same
   gap means opposite things at a base and after a long run. */
function gapAt(candles, i, avgVol) {
  const c = candles[i], p = candles[i - 1];
  if (!p) return null;
  const up = c.l > p.h, down = c.h < p.l;
  if (!up && !down) return null;
  const size = round2(pct(p.c, c.o));
  const vol = avgVol ? (c.v || 0) / avgVol : null;
  const trail = candles.slice(Math.max(0, i - 20), i);
  const run = trail.length ? pct(trail[0].c, p.c) : 0;
  // A gap on heavy volume out of a base breaks away; the same gap after a long
  // run is more often the end of it than the middle.
  const kind = vol != null && vol >= 1.8 && Math.abs(run) < 15 ? "breakaway"
    : Math.abs(run) >= 20 ? "exhaustion" : "common";
  return { direction: up ? "up" : "down", sizePct: size, volumeMultiple: round2(vol), kind };
}

/**
 * Backtest one pattern on this stock's own history: after it appeared, did price
 * move favourably over the horizon? Returns null below MIN_OCCURRENCES, because
 * a rate computed on three examples is a number pretending to be a finding.
 */
export function patternHistory(candles, key, horizon = 5) {
  const p = PATTERNS.find(x => x.key === key);
  if (!p || !candles || candles.length < 60) return null;

  const moveFrom = i => {
    const from = candles[i].c;
    const fwd = candles.slice(i + 1, i + 1 + horizon);
    if (!fwd.length) return null;
    const m = p.dir === "bearish"
      ? -pct(from, Math.min(...fwd.map(x => x.l)))   // a bearish call "works" if price falls
      : pct(from, Math.max(...fwd.map(x => x.h)));
    return Number.isFinite(m) ? m : null;
  };

  /* The baseline is the whole point. "Price rose 1% within five sessions" is
     true of most bars on a stock that swings 2% a day, so a raw follow-through
     rate measures volatility and flatters every pattern equally. What matters is
     whether the pattern does BETTER than picking a bar at random — so the base
     rate over all bars is computed too, and the edge between them is reported.
     A pattern that matches its baseline has told you nothing. */
  const all = [], hits = [];
  for (let i = 3; i < candles.length - horizon; i++) {
    const m = moveFrom(i);
    if (m == null) continue;
    all.push(m);
    if (detectAt(candles, i).some(d => d.key === key)) hits.push(m);
  }

  const threshold = 1; // a move worth noticing, in percent
  const rate = xs => (xs.length ? (xs.filter(m => m > threshold).length / xs.length) * 100 : null);
  const med = xs => {
    if (!xs.length) return null;
    const s2 = [...xs].sort((a, b) => a - b);
    return round2(s2[Math.floor(s2.length / 2)]);
  };

  const baselineRate = round2(rate(all));
  if (hits.length < MIN_OCCURRENCES) {
    return {
      occurrences: hits.length, insufficient: true, required: MIN_OCCURRENCES,
      baselineRate, baselineMedian: med(all),
      note: `Only ${hits.length} occurrence${hits.length === 1 ? "" : "s"} in this stock's history — too few to state a rate.`,
    };
  }

  const followThroughRate = round2(rate(hits));
  const medianMove = med(hits);
  const edge = round2(followThroughRate - baselineRate);
  return {
    occurrences: hits.length,
    followThroughRate, medianMove, horizon,
    baselineRate, baselineMedian: med(all), baselineN: all.length,
    edgeVsBaseline: edge,
    // Stated rather than left for the reader to work out, because the raw rate
    // is the number people quote and it is the misleading one.
    verdict: edge >= 8 ? "better than this stock's base rate"
      : edge <= -8 ? "worse than this stock's base rate"
      : "no better than picking a random day in this stock",
  };
}

/** Prior trend, measured rather than assumed: where price sits against the
    20-day mean and how the last 10 sessions sloped. */
function priorTrend(candles, i) {
  const w = candles.slice(Math.max(0, i - 20), i);
  if (w.length < 10) return null;
  const ma = w.reduce((a, c) => a + c.c, 0) / w.length;
  const slope = pct(w[0].c, w.at(-1).c);
  return { vsMa20Pct: round2(pct(ma, candles[i].c)), slope10Pct: round2(slope),
           direction: slope > 2 ? "up" : slope < -2 ? "down" : "sideways" };
}

/**
 * Patterns on the most recent bars, with everything needed to judge them.
 * @param levels candidate levels from lib/levels.js, for the "at a level" test
 */
export function analyse(stock, levels = [], { lookback = 5, horizon = 5 } = {}) {
  const candles = stock.candles || [];
  if (candles.length < 60) return { detected: [], insufficient: true, bars: candles.length };

  const avgVol = stock.avgVol20 || (candles.slice(-20).reduce((a, c) => a + (c.v || 0), 0) / 20);
  const atrPct = (() => {
    const w = candles.slice(-15);
    const trs = w.slice(1).map((c, k) => Math.max(c.h - c.l, Math.abs(c.h - w[k].c), Math.abs(c.l - w[k].c)));
    const a = trs.reduce((x, y) => x + y, 0) / (trs.length || 1);
    return candles.at(-1).c > 0 ? (a / candles.at(-1).c) * 100 : 2;
  })();

  const detected = [];
  for (let i = candles.length - lookback; i < candles.length; i++) {
    if (i < 3) continue;
    const c = candles[i];
    const trend = priorTrend(candles, i);
    /* Today's bar is still accumulating volume. Comparing a half-finished
       session against a full-day average reports "0.05x volume, which weakens
       it" about a perfectly normal morning, so the comparison is withheld
       rather than made wrongly. */
    const isLast = i === candles.length - 1;
    const partialSession = isLast && new Date(c.t + 5.5 * 3600e3).toISOString().slice(0, 10) === new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const volumeMultiple = partialSession || !avgVol ? null : round2((c.v || 0) / avgVol);

    for (const p of detectAt(candles, i)) {
      // Nearest level within half an ATR — "at" a level, not merely in the
      // same postcode as one.
      const near = levels
        .map(l => ({ ...l, distPct: Math.abs(pct(c.c, l.price)) }))
        .filter(l => l.distPct <= Math.max(0.75, atrPct / 2))
        .sort((a, b) => a.distPct - b.distPct)[0] || null;

      /* A reversal pattern only means something against a preceding move. A
         bullish hammer inside an uptrend is a pause, not a reversal — marking it
         valid would let the evidence list argue for an entry using a candle that
         says nothing. */
      const contextValid = p.dir === "bullish" ? trend && trend.direction !== "up"
        : p.dir === "bearish" ? trend && trend.direction !== "down"
        : true;

      const hist = patternHistory(candles, p.key, horizon);
      detected.push({
        pattern: p.label, key: p.key, direction: p.dir,
        date: new Date(c.t).toISOString().slice(0, 10),
        sessionsAgo: candles.length - 1 - i,
        contextValid: !!contextValid,
        contextNote: contextValid ? null
          : `Formed inside a ${trend?.direction ?? "flat"} move — a ${p.dir} reversal needs something to reverse.`,
        trend,
        atLevel: near ? { price: near.price, method: near.method, type: near.type, touches: near.touches ?? null, distPct: round2(near.distPct) } : null,
        volumeMultiple, partialSession,
        volumeConfirm: volumeMultiple != null && volumeMultiple >= 1.5,
        history: hist,
        reading: reading(p, { near, volumeMultiple, partialSession, hist, sessionsAgo: candles.length - 1 - i, contextValid }),
      });
    }

    const g = gapAt(candles, i, avgVol);
    if (g) detected.push({
      pattern: `${g.kind[0].toUpperCase() + g.kind.slice(1)} gap ${g.direction}`,
      key: `gap_${g.kind}`, direction: g.direction === "up" ? "bullish" : "bearish",
      date: new Date(c.t).toISOString().slice(0, 10), sessionsAgo: candles.length - 1 - i,
      contextValid: true, trend, atLevel: null,
      volumeMultiple: g.volumeMultiple, volumeConfirm: (g.volumeMultiple ?? 0) >= 1.5,
      history: null,
      reading: `${g.sizePct > 0 ? "+" : ""}${g.sizePct}% gap ${g.direction} on ${g.volumeMultiple ?? "?"}x volume — classified ${g.kind}${g.kind === "exhaustion" ? ", which after a long run more often ends a move than extends it" : ""}.`,
    });
  }

  return {
    detected: detected.sort((a, b) => a.sessionsAgo - b.sessionsAgo),
    // Only these belong in an evidence list; the rest are shown for transparency.
    valid: detected.filter(d => d.contextValid),
    bars: candles.length,
  };
}

function reading(p, { near, volumeMultiple, partialSession, hist, sessionsAgo, contextValid }) {
  const when = sessionsAgo === 0 ? "today" : sessionsAgo === 1 ? "yesterday" : `${sessionsAgo} sessions ago`;
  const vol = partialSession ? " (today's volume is still accumulating, so it is not yet comparable)"
    : volumeMultiple == null ? "" :
    volumeMultiple >= 2 ? ` on heavy ${volumeMultiple}x volume`
    : volumeMultiple >= 1.5 ? ` on ${volumeMultiple}x volume`
    : ` on light ${volumeMultiple}x volume, which weakens it`;
  const where = near
    ? `, right at the ₹${near.price} ${near.type}${near.touches ? ` that has held ${near.touches} times` : ""}`
    : ", in mid-range rather than at any level, which weakens it";
  if (!contextValid) return `${p.label} ${when}${vol}, but formed with no move to reverse — noted, not counted.`;
  const rate = hist?.insufficient
    ? ` This stock has printed it only ${hist.occurrences} time${hist.occurrences === 1 ? "" : "s"} before, too few to say how often it works.`
    : hist ? ` In this stock it has been followed by a favourable move ${hist.followThroughRate}% of the time against a ${hist.baselineRate}% base rate for any day — ${hist.verdict} (n=${hist.occurrences}).`
    : "";
  return `${p.label} ${when}${vol}${where}.${rate}`;
}

export const PATTERN_KEYS = PATTERNS.map(p => p.key);
