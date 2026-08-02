/* Intraday derivations from 5-minute bars.

   Everything here needs bars the daily feed does not carry, so each value is
   null when they are missing — and null reaches the engine as NO DATA rather
   than as a zero that would quietly pass or fail a threshold.

   These are computed on a ~15-minute delayed feed. That does not make them
   wrong, but it does mean the session they describe has already moved on; the
   lag disclosure and the confidence cap exist for exactly that reason. */

const IST_OFFSET_MS = 5.5 * 60 * 60_000;
const OPEN_MIN = 9 * 60 + 15;              // NSE opens 09:15 IST
const OPENING_RANGE_MIN = 15;              // first 15 minutes
const istMinutes = ms => {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const istDay = ms => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Group bars by IST session day, newest session last. */
function sessions(bars) {
  const by = new Map();
  for (const b of bars || []) {
    const d = istDay(b.t);
    if (!by.has(d)) by.set(d, []);
    by.get(d).push(b);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, bs]) => ({ day, bars: bs }));
}

export function derive(bars) {
  const days = sessions(bars);
  const today = days.at(-1);
  if (!today || today.bars.length < 2) return null;

  const bs = today.bars;
  const nowMin = istMinutes(bs.at(-1).t);

  // VWAP over the session so far — the level institutions are measured against.
  let pv = 0, vol = 0;
  for (const b of bs) {
    const typical = (b.h + b.l + b.c) / 3;
    if (Number.isFinite(typical) && Number.isFinite(b.v)) { pv += typical * b.v; vol += b.v; }
  }
  const vwap = vol > 0 ? pv / vol : null;

  // Opening range: the first 15 minutes. A break of it is the classic intraday
  // trigger, and it is only meaningful once the range is actually complete.
  const orBars = bs.filter(b => istMinutes(b.t) < OPEN_MIN + OPENING_RANGE_MIN);
  const orComplete = nowMin >= OPEN_MIN + OPENING_RANGE_MIN && orBars.length > 0;
  const orHigh = orComplete ? Math.max(...orBars.map(b => b.h)) : null;
  const orLow = orComplete ? Math.min(...orBars.map(b => b.l)) : null;

  // Volume against the same point in previous sessions. Comparing a 10:00
  // cumulative against a full day's average is how you get a false surge every
  // morning; this compares like with like.
  const cumToNow = bars_ => bars_.filter(b => istMinutes(b.t) <= nowMin).reduce((a, b) => a + (b.v || 0), 0);
  const todayCum = cumToNow(bs);
  const priorCums = days.slice(0, -1).map(d => cumToNow(d.bars)).filter(v => v > 0);
  const todAvg = priorCums.length ? priorCums.reduce((a, b) => a + b, 0) / priorCums.length : null;

  const dayHigh = Math.max(...bs.map(b => b.h));
  const dayLow = Math.min(...bs.map(b => b.l));
  const last = bs.at(-1).c;

  return {
    vwap,
    vsVwapPct: vwap ? ((last - vwap) / vwap) * 100 : null,
    orHigh, orLow,
    orBreakout: orComplete ? (last > orHigh ? 1 : 0) : null,
    dayHigh, dayLow,
    // Where in the day's range price sits: 100 = at the high, 0 = at the low.
    dayRangePos: dayHigh > dayLow ? ((last - dayLow) / (dayHigh - dayLow)) * 100 : null,
    volVsTOD: todAvg ? todayCum / todAvg : null,
    sessionsCompared: priorCums.length,
    barsToday: bs.length,
  };
}
