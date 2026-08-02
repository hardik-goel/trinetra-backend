/* Durable signal history and what happened next.

   A signal log that only says "POLYCAB fired" is unfalsifiable. Each record
   keeps the evidence at fire time — which criteria locked and the values that
   locked them — so a signal can be re-examined later without trusting memory,
   and forward returns so the system can be measured rather than believed.

   Returns are wall-clock, not trading-day, and marked from the fire price using
   the same delayed feed the signal fired on. Both facts are stated in the stats
   payload rather than buried here, because a track record that hides its
   assumptions is worth nothing. */

import { load, save, newId } from "./store.js";

const FILE = "signal_history.json";
const HORIZONS = [1, 3, 7, 30]; // days
const WINDOW_MS = 30 * 86_400_000; // stop marking after the longest horizon
const DAY_MS = 86_400_000;

let history = load(FILE, []);
const persist = () => save(FILE, history);

const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);
const round2 = v => (v == null ? null : Math.round(v * 100) / 100);

/** Record a fired signal with the evidence that produced it. */
export function recordSignal({ symbol, name, price, groups, evaluation, at }) {
  const firedAt = at ?? Date.now();
  const criteria = (evaluation?.criteria || []).filter(c => c.enabled !== false).map(c => ({
    id: c.id, key: c.key, name: c.name, pass: !!c.pass,
    checks: (c.checksOut || []).map(x => ({
      metric: x.metric, op: x.op, threshold: x.value, value: round2(x.v), ok: !!x.ok,
    })),
  }));
  const rec = {
    id: newId("sig"),
    symbol, name: name || symbol, firedAt, price,
    groups: groups || [],
    // The criteria set is the shape of the bet — comparing "F+B+V" against
    // "F+B" is the only way to learn which combination is actually carrying it.
    combo: criteria.filter(c => c.pass).map(c => c.key || c.id).sort().join("+") || "none",
    count: criteria.filter(c => c.pass).length,
    total: criteria.length,
    criteria,
    outcome: { maxGain: 0, maxDrawdown: 0, lastPrice: price, lastAt: firedAt },
  };
  history = [rec, ...history];
  persist();
  return rec;
}

/**
 * Mark every signal still inside the 30-day window against the latest prices.
 * Horizon returns freeze the first time the signal is old enough, so a value
 * once recorded never drifts. maxGain/maxDrawdown track the path, because a
 * signal that ran +8% before closing -2% is a different animal from one that
 * drifted down all week — and only the path distinguishes them.
 */
export function markOutcomes(priceBySymbol, now = Date.now()) {
  let touched = 0;
  for (const rec of history) {
    const age = now - rec.firedAt;
    if (age > WINDOW_MS) continue;
    const price = priceBySymbol[rec.symbol];
    if (!Number.isFinite(price) || !(rec.price > 0)) continue;

    const move = pct(rec.price, price);
    const o = rec.outcome || (rec.outcome = { maxGain: 0, maxDrawdown: 0 });
    o.lastPrice = price;
    o.lastAt = now;
    o.maxGain = round2(Math.max(o.maxGain ?? 0, move));
    o.maxDrawdown = round2(Math.min(o.maxDrawdown ?? 0, move));
    for (const d of HORIZONS) {
      const key = `ret${d}d`;
      if (o[key] == null && age >= d * DAY_MS) o[key] = round2(move);
    }
    touched++;
  }
  if (touched) persist();
  return touched;
}

export function list({ from, to } = {}) {
  const lo = from ? Date.parse(from) : -Infinity;
  const hi = to ? Date.parse(to) + DAY_MS : Infinity; // `to` is inclusive of its day
  return history.filter(r => r.firedAt >= lo && r.firedAt < hi);
}

export const all = () => history;

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return round2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};
const mean = xs => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** Per-horizon summary. `n` is stated everywhere: a 100% win rate over 2
    signals is not a track record, and the caller must be able to see that. */
function summarise(records) {
  const out = {};
  for (const d of HORIZONS) {
    const rets = records.map(r => r.outcome?.[`ret${d}d`]).filter(v => Number.isFinite(v));
    const wins = rets.filter(v => v > 0).length;
    out[`ret${d}d`] = {
      n: rets.length,
      pending: records.length - rets.length,
      winRate: rets.length ? round2((wins / rets.length) * 100) : null,
      avg: mean(rets), median: median(rets),
      best: rets.length ? round2(Math.max(...rets)) : null,
      worst: rets.length ? round2(Math.min(...rets)) : null,
    };
  }
  return out;
}

export function stats(days = 30) {
  const since = Date.now() - days * DAY_MS;
  const records = history.filter(r => r.firedAt >= since);

  const byCombo = {};
  for (const r of records) (byCombo[r.combo] ||= []).push(r);

  return {
    days,
    total: records.length,
    firstAt: records.length ? Math.min(...records.map(r => r.firedAt)) : null,
    horizons: summarise(records),
    byCombo: Object.fromEntries(
      Object.entries(byCombo).map(([combo, rs]) => [combo, { n: rs.length, horizons: summarise(rs) }])
    ),
    pathRisk: {
      // How much heat a signal put you through before it worked, if it did.
      avgMaxGain: mean(records.map(r => r.outcome?.maxGain).filter(Number.isFinite)),
      avgMaxDrawdown: mean(records.map(r => r.outcome?.maxDrawdown).filter(Number.isFinite)),
    },
    assumptions: [
      "Returns are measured from the price at fire time on the same delayed feed the signal used — not a fill you could necessarily have got.",
      "Horizons are wall-clock days, so a 1-day return can span a weekend.",
      "No costs: brokerage, STT, slippage and impact are all excluded.",
      "Signals still inside a horizon are counted as pending, never as zero.",
    ],
  };
}
