/* Confluence engine — the single source of truth for how criteria
   are evaluated. The UI ships an identical copy so what you see and
   what fires the alert can never drift apart. */

import { METRIC_KEYS } from "../fundamentals.config.js";

// Every fundamentals metric is a criteria check for free — the catalog is the
// single source of which ones exist, so a new metric needs no edit here.
const fundGetters = Object.fromEntries(METRIC_KEYS.map(k => [k, s => s.fund?.[k]]));

export const METRICS = {
  ...fundGetters,
  dayChgPct:    s => ((s.price - s.prevClose) / s.prevClose) * 100,
  aboveHigh20:  s => (s.price > s.high20 ? 1 : 0),
  pctOf52wHigh: s => (s.price / s.high52) * 100,
  volMultiple:  s => (s.avgVol20 ? s.volToday / s.avgVol20 : NaN),
  buyerPct:     s => {
    const t = (s.bidQty || 0) + (s.askQty || 0);
    return t ? (s.bidQty / t) * 100 : NaN;
  },
  price:        s => s.price,
  fcstReturn:   s => s.fcst?.ret,
};

// Fundamentals that were never scraped are hand-entered seed values. They are
// worth showing, but they must not lock a gate: an unverified number reads
// exactly like a verified one once it is a green tick.
const FUND_METRICS = new Set(METRIC_KEYS);
const unverified = (s, metric) => FUND_METRICS.has(metric) && s.fund?.status === "seed";

const ok = (s, c) => {
  const fn = METRICS[c.metric];
  const v = fn ? fn(s) : NaN;
  if (v == null || Number.isNaN(v)) return { v, ok: false, na: true };
  if (unverified(s, c.metric)) return { v, ok: false, na: false, unverified: true };
  return { v, ok: c.op === "gte" ? v >= c.value : v <= c.value, na: false };
};

export function evaluate(s, criteria) {
  const active = (criteria || []).filter(c => c.enabled);
  const results = active.map(c => {
    const checks = c.checks.map(ch => ({ ...ch, ...ok(s, ch) }));
    return {
      ...c,
      checksOut: checks,
      pass: checks.length > 0 && checks.every(x => x.ok),
      na: checks.some(x => x.na),
      unverified: checks.some(x => x.unverified),
    };
  });
  return {
    criteria: results,
    count: results.filter(r => r.pass).length,
    total: active.length,
    locked: active.length > 0 && results.every(r => r.pass),
    volX: METRICS.volMultiple(s),
    buyerPct: METRICS.buyerPct(s),
    dayChg: METRICS.dayChgPct(s),
  };
}
