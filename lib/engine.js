/* Confluence engine — the single source of truth for how criteria
   are evaluated. The UI ships an identical copy so what you see and
   what fires the alert can never drift apart.

   Two rules matter more than any threshold in here:

   1. A CRITERION WITH NO DATA CAN NEVER VETO A SIGNAL. A check whose metric is
      unavailable is skipped, not failed. Order Flow needs Kite; the Oracle is
      parked. If either could fail a check, enabling it would silently block
      every signal forever — the eye would simply never open, and nothing would
      say why.
   2. A missing metric is not a failed metric. "Pledged shares: unknown" is not
      "pledged shares: too high". The criterion is judged on what is known, and
      says which parts it skipped.

   The cost of rule 1 is real and stated rather than hidden: a criterion whose
   data is entirely missing drops OUT of the lock, so a stock can lock on the
   remaining criteria. That is the intended behaviour — a gate that cannot be
   evaluated should not be able to hold the door shut — but it means "locked"
   sometimes means "locked on what we could measure". `evaluation.skipped` names
   those, and callers are expected to show it. */

import { METRIC_KEYS } from "../fundamentals.config.js";

// Every fundamentals metric is a criteria check for free — the catalog is the
// single source of which ones exist, so a new metric needs no edit here.
const fundGetters = Object.fromEntries(METRIC_KEYS.map(k => [k, s => s.fund?.[k]]));

export const METRICS = {
  ...fundGetters,
  dayChgPct:    s => ((s.price - s.prevClose) / s.prevClose) * 100,
  aboveHigh20:  s => (s.price > s.high20 ? 1 : 0),
  aboveHigh50:  s => (s.high50 ? (s.price > s.high50 ? 1 : 0) : NaN),
  /* Volume against the same point in the session, not against a whole day.
     Yahoo's daily bar reports volume ACCUMULATED SO FAR, so at 11:30 it holds
     about a third of a session. Comparing that to a 20-day full-day average made
     a 3x volume criterion unreachable until near the close — POLYCAB read 0.13x
     at 38% elapsed, which is 0.35x at full-day pace. index.js supplies the
     pro-rated figure; the raw ratio is the fallback for a completed session. */
  volMultiple:  s => (s.volPaceMultiple ?? (s.avgVol20 ? s.volToday / s.avgVol20 : NaN)),
  // Participation that has held for days, not one hot session.
  volSustained: s => (s.avgVol20 ? (s.avgVol3 ?? NaN) / s.avgVol20 : NaN),
  pctOf52wHigh: s => (s.price / s.high52) * 100,
  buyerPct:     s => {
    const t = (s.bidQty || 0) + (s.askQty || 0);
    return t ? (s.bidQty / t) * 100 : NaN;
  },
  price:        s => s.price,
  fcstReturn:   s => s.fcst?.ret,
  /* Intraday metrics come from 5-minute bars. Undefined when those bars are
     missing, which reaches the engine as NO DATA — never as a passing zero. */
  orBreakout:   s => s.intraday?.orBreakout,
  vsVwapPct:    s => s.intraday?.vsVwapPct,
  volVsTOD:     s => s.intraday?.volVsTOD,
  dayRangePos:  s => s.intraday?.dayRangePos,
};

/* Metrics whose data source is simply not present on this deployment. A check on
   one of these is not "failing", it is unanswerable, and it must never hold a
   signal shut. */
export const SOURCE_UNAVAILABLE = {
  buyerPct: "order-book depth needs Kite — not available on a delayed feed",
  fcstReturn: "the forecast service is parked",
  orBreakout: "intraday bars unavailable",
  vsVwapPct: "intraday bars unavailable",
  volVsTOD: "intraday bars unavailable",
  dayRangePos: "intraday bars unavailable",
};

// Fundamentals that were never scraped are hand-entered seed values. They are
// worth showing, but they must not settle a gate: an unverified number reads
// exactly like a verified one once it is a green tick.
const FUND_METRICS = new Set(METRIC_KEYS);
const unverified = (s, metric) => FUND_METRICS.has(metric) && s.fund?.status === "seed";

const ok = (s, c) => {
  const fn = METRICS[c.metric];
  const v = fn ? fn(s) : NaN;
  if (v == null || Number.isNaN(v)) {
    return { v: null, ok: false, na: true, unverified: false,
             reason: SOURCE_UNAVAILABLE[c.metric] || "no value available for this metric" };
  }
  if (unverified(s, c.metric)) {
    return { v, ok: false, na: false, unverified: true,
             reason: "hand-entered seed value — never confirmed by a scrape" };
  }
  return { v, ok: c.op === "gte" ? v >= c.value : v <= c.value, na: false, unverified: false };
};

export function evaluate(s, criteria) {
  const active = (criteria || []).filter(c => c.enabled);
  const results = active.map(c => {
    const checks = c.checks.map(ch => ({ ...ch, ...ok(s, ch) }));
    // A check that could not be evaluated is neither passed nor failed.
    const answerable = checks.filter(x => !x.na && !x.unverified);
    const skippedChecks = checks.filter(x => x.na || x.unverified);
    const skipped = answerable.length === 0 && checks.length > 0;
    return {
      ...c,
      checksOut: checks,
      // Judged on what is known. Missing parts are reported, not counted against.
      pass: answerable.length > 0 && answerable.every(x => x.ok),
      skipped,
      skippedChecks: skippedChecks.map(x => ({ metric: x.metric, reason: x.reason })),
      partial: !skipped && skippedChecks.length > 0,
      na: skipped, // kept for callers that predate `skipped`
      unverified: checks.some(x => x.unverified),
    };
  });

  const counted = results.filter(r => !r.skipped);
  const skipped = results.filter(r => r.skipped);

  return {
    criteria: results,
    count: counted.filter(r => r.pass).length,
    total: counted.length,
    // Locked on everything that could be evaluated. A criterion with no data is
    // excluded rather than allowed to veto — but it is named, so "locked" is
    // never quietly weaker than it looks.
    locked: counted.length > 0 && counted.every(r => r.pass),
    /* A lock reached with a criterion excluded is not the same event as a lock
       on all three, and must never be presented as one. The rule that a
       data-less criterion cannot veto is right — it is what stopped the eye
       opening at all — but its cost is that "locked" can quietly mean "locked on
       what we could measure". This names that, and the alert repeats it. */
    lockQuality: skipped.length ? "partial" : "full",
    lockedOn: counted.map(r => r.name),
    notEvaluated: skipped.map(r => r.name),
    skipped: skipped.map(r => ({ id: r.id, name: r.name, reasons: r.skippedChecks })),
    partial: results.filter(r => r.partial).map(r => ({ id: r.id, name: r.name, reasons: r.skippedChecks })),
    warnings: [
      ...skipped.map(r => `${r.name} was excluded from the lock: ${r.skippedChecks.map(x => x.reason)[0]}.`),
      ...results.filter(r => r.partial).map(r =>
        `${r.name} was judged on ${r.checksOut.length - r.skippedChecks.length} of ${r.checksOut.length} checks — ${r.skippedChecks.map(x => x.metric).join(", ")} had no data.`),
    ],
    volX: METRICS.volMultiple(s),
    buyerPct: METRICS.buyerPct(s),
    dayChg: METRICS.dayChgPct(s),
  };
}
