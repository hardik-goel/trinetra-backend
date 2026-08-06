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
export function recordSignal({ symbol, name, price, groups, evaluation, at, profileId, profileName, horizon, potential, confidence, exits, dataAge, direction = "buy" }) {
  const firedAt = at ?? Date.now();
  /* `skipped` is persisted, not just used to compute lockQuality at write time.
     Without it a stored record cannot say WHICH criterion went unanswered, so a
     lockQuality written today could never be audited or recomputed later — and
     records written before it existed cannot be repaired, because the fact was
     simply not kept. Storing the flag means that is a one-time gap rather than a
     permanent one. */
  const criteria = (evaluation?.criteria || []).filter(c => c.enabled !== false).map(c => ({
    id: c.id, key: c.key, name: c.name, pass: !!c.pass, skipped: !!c.skipped,
    skippedReason: c.skipped ? (c.skippedChecks?.[0]?.reason ?? null) : null,
    checks: (c.checksOut || []).map(x => ({
      metric: x.metric, op: x.op, threshold: x.value, value: round2(x.v), ok: !!x.ok, na: !!x.na,
    })),
  }));
  const rec = {
    id: newId("sig"),
    symbol, name: name || symbol, firedAt, price,
    groups: groups || [],
    // Which horizon fired this. Blending an intraday win rate into a long-term
    // one would describe a strategy nobody runs, so outcomes stay separable.
    profileId: profileId || null,
    horizon: horizon || null,
    /* A sell is right when price FALLS. Scoring it on the same axis as a buy
       would make every correct sell look like a loss, and blending the two into
       one win rate would describe a strategy nobody runs. */
    direction: direction || "buy",
    // The estimates as they stood at fire time, so the record can later answer
    // whether the confidence score and the potential range were worth anything.
    estimate: potential ? {
      estRangePct: potential.estRangePct ?? null,
      remainingPct: potential.remainingPct ?? null,
      analogs: potential.analogs ?? null,
      exhausted: !!potential.exhausted,
      insufficientHistory: !!potential.insufficientHistory,
    } : null,
    confidence: confidence ? { score: confidence.score, band: confidence.band, caps: confidence.caps } : null,
    exitLevels: exits ? { safe: exits.safe?.pct, primary: exits.primary?.pct, stretch: exits.stretch?.pct, stop: exits.stop?.pct } : null,
    dataAge: dataAge || null,
    // The criteria set is the shape of the bet — comparing "F+B+V" against
    // "F+B" is the only way to learn which combination is actually carrying it.
    /* `combo` is a compact key for grouping — "O+R+V+W" tells the engine which
       shape of bet this was. It is NOT a label for a human: it reads like the
       original four criteria when it is in fact the Intraday profile's four, and
       two profiles with the same count look identical. The readable names travel
       alongside so a row can say which criteria actually locked. */
    combo: criteria.filter(c => c.pass).map(c => c.key || c.id).sort().join("+") || "none",
    profileName: profileName || profileId || null,
    lockedOn: criteria.filter(c => c.pass).map(c => c.name).filter(Boolean),
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

    /* Measured in the direction the signal claimed. For a sell a fall is the
       favourable move, so the sign is inverted before anything is stored and
       downstream code never has to remember which way this one pointed. */
    const raw = pct(rec.price, price);
    const move = rec.direction === "sell" ? -raw : raw;
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

/* Until 2026-08-03 the holdings-only profiles were run by the SCREENER as well as
   by the cycle scan, because `appliesTo: "holdings"` was declared and never
   enforced. Every history record filed under one of those profiles before that
   date is therefore screener leakage across the whole universe — cycle signals
   were not recorded to history at all until the same commit, so there is no
   legitimate record of that shape to lose.

   Excluded rather than deleted, and counted rather than dropped quietly: a sell
   win rate computed over buy signals fired on stocks the user never held would
   be a confident number about nothing. */
const HOLDINGS_PROFILES = new Set(["sell_holdings", "buyback_holdings"]);
const APPLIES_TO_ENFORCED_AT = Date.parse("2026-08-03T00:00:00Z");
/* Why a record is not real, or null if it is. Reported per reason rather than as
   one bucket, because "the screener ran the wrong profile" and "a developer wrote
   this by hand" are different problems and only one of them is a bug in the app. */
const leakageReason = r => {
  /* Every path that records a signal supplies a profileId — the screener from the
     profile it evaluated, the cycle scan from sell_holdings/buyback_holdings. A
     record without one was written by a library call outside the running app,
     i.e. a verification run. It has a synthetic price and no evidence behind it,
     and it would otherwise sit in the track record as a real signal. */
  if (!r.profileId) {
    return "written directly by a verification run, not by the app — no profile, no evidence, synthetic price";
  }
  if (!HOLDINGS_PROFILES.has(r.profileId)) return null;
  /* The screener hardcodes `direction: "buy"`, so anything filed under the SELL
     profile without direction "sell" came from the screener, whatever its date.
     That is the case worth catching precisely — it is the one that would corrupt
     the sell win rate, which is a number about a different kind of bet entirely.
     The buy-back side has no such tell, so it falls back to the date, and a
     leaked buy-back recorded earlier on the cutover day itself will survive. */
  const screenerLeak = r.profileId === "sell_holdings"
    ? r.direction !== "sell"
    : (r.firedAt ?? 0) < APPLIES_TO_ENFORCED_AT;
  return screenerLeak
    ? "screener signal filed under a holdings-only profile, from before appliesTo was enforced on 2026-08-03 — fired across the whole universe rather than on stock you held"
    : null;
};

const isLeakage = r => leakageReason(r) != null;

export function stats(days = 30) {
  const since = Date.now() - days * DAY_MS;
  const inWindow = history.filter(r => r.firedAt >= since);
  const leaked = inWindow.filter(isLeakage);
  const records = inWindow.filter(r => !isLeakage(r));

  const byCombo = {};
  for (const r of records) (byCombo[r.combo] ||= []).push(r);

  const byProfile = {};
  for (const r of records) (byProfile[r.profileId || "unknown"] ||= []).push(r);

  const byBand = {};
  for (const r of records) (byBand[r.confidence?.band || "unscored"] ||= []).push(r);

  const byDirection = {};
  for (const r of records) (byDirection[r.direction || "buy"] ||= []).push(r);

  /* Did the estimate mean anything? Hit rate of each exit level against what
     actually happened. If the stretch target is hit as often as the safe one,
     the levels are not discriminating and should not be presented as if they
     were. */
  const hitRate = (rs, level) => {
    const scored = rs.filter(r => r.exitLevels?.[level] != null && Number.isFinite(r.outcome?.maxGain));
    if (!scored.length) return null;
    const hits = scored.filter(r => r.outcome.maxGain >= r.exitLevels[level]).length;
    return { n: scored.length, hitRate: round2((hits / scored.length) * 100) };
  };

  return {
    days,
    total: records.length,
    // Stated, not silent. A missing 14 records looks like a quiet backend if the
    // only evidence is a smaller number than yesterday.
    excluded: leaked.length
      ? { n: leaked.length,
          reasons: Object.entries(
            leaked.reduce((a, r) => { const k = leakageReason(r); (a[k] ||= []).push(r.symbol); return a; }, {})
          ).map(([reason, symbols]) => ({ reason, n: symbols.length, symbols: [...new Set(symbols)] })) }
      : null,
    firstAt: records.length ? Math.min(...records.map(r => r.firedAt)) : null,
    horizons: summarise(records),
    byCombo: Object.fromEntries(
      Object.entries(byCombo).map(([combo, rs]) => [combo, { n: rs.length, horizons: summarise(rs) }])
    ),
    /* Reported separately, never merged. A combined win rate across two
       different kinds of bet is not a number about anything. */
    byDirection: Object.fromEntries(
      Object.entries(byDirection).map(([d, rs]) => [d, {
        n: rs.length,
        note: d === "sell"
          ? "A sell counts as correct when price fell to the target within the horizon; returns are measured downward."
          : "Returns measured upward from the fire price.",
        horizons: summarise(rs),
      }])
    ),
    byProfile: Object.fromEntries(
      Object.entries(byProfile).map(([id, rs]) => [id, { n: rs.length, horizons: summarise(rs) }])
    ),
    /* The question that decides whether the confidence score earns its place.
       If high-confidence signals do not outperform low-confidence ones, the
       score is decoration — and this is where that shows, plainly. */
    byConfidenceBand: Object.fromEntries(
      Object.entries(byBand).map(([band, rs]) => [band, {
        n: rs.length,
        avgScore: mean(rs.map(r => r.confidence?.score).filter(Number.isFinite)),
        horizons: summarise(rs),
      }])
    ),
    estimateAccuracy: {
      safe: hitRate(records, "safe"),
      primary: hitRate(records, "primary"),
      stretch: hitRate(records, "stretch"),
      note: "Hit rate = share of signals whose maximum favourable move reached that level. Reaching a level is not the same as exiting there.",
    },
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

/** Re-read from disk after a restore, so the process serves the restored
    records rather than the ones it was holding in memory. */
export function reload() {
  history = load(FILE, []);
}
