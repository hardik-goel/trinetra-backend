/* Move potential, confidence, and exit levels.

   These are ESTIMATES DERIVED FROM THIS STOCK'S OWN HISTORY, not predictions.
   Three rules hold everywhere in this file:

     1. No point estimate without its range and its sample size.
     2. Below MIN_ANALOGS the numeric range is withheld entirely — a "typical
        move" built on three examples is noise wearing a decimal point.
     3. The word "will" appears nowhere in any generated sentence.

   The confidence score is capped by data freshness rather than adjusted by it.
   A delayed feed cannot produce a high-confidence intraday signal, and pretending
   otherwise would be the single most expensive lie this app could tell. */

import { HORIZON_SESSIONS } from "./profiles.js";

const MIN_ANALOGS = 8;
const ATR_LEN = 14;
const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);

const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const median = xs => percentile([...xs].sort((a, b) => a - b), 0.5);

/** Average true range over the last n candles, as a % of price. */
export function atrPct(candles, n = ATR_LEN) {
  if (!candles || candles.length < n + 1) return null;
  const trs = [];
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    if (!c || !p) continue;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  if (!trs.length) return null;
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  const last = candles.at(-1).c;
  return last > 0 ? (atr / last) * 100 : null;
}

/** The nearest level above price that has previously rejected it. A target
    sitting above a wall is fantasy, so the caller caps against this and names it.
    `from` overrides spot: when the trade is entered at a trigger above spot, the
    walls that matter are the ones above the TRIGGER. Measuring them from spot
    caps the target with a level the entry has already cleared. */
export function resistanceAbove(stock, candles, from, { includeRound = true } = {}) {
  const price = Number.isFinite(from) ? from : stock.price;
  const levels = [];
  if (stock.high20 > price) levels.push({ name: "20d-high", price: stock.high20 });
  if (stock.high50 > price) levels.push({ name: "50d-high", price: stock.high50 });
  if (stock.high52 > price) levels.push({ name: "52w-high", price: stock.high52 });
  // Recent swing high: a pivot the last 60 sessions turned down from twice.
  const recent = (candles || []).slice(-60);
  for (let i = 2; i < recent.length - 2; i++) {
    const h = recent[i].h;
    if (h > price && h >= recent[i - 1].h && h >= recent[i - 2].h && h >= recent[i + 1].h && h >= recent[i + 2].h)
      levels.push({ name: "swing-high", price: h });
  }
  /* Round numbers act as resistance in practice — but weakly, and the magnitude
     is derived from the price, so the nearest one is ALWAYS within about 1%.
     That makes it useless as a ceiling on a multi-session target: a 5-day swing
     passes through several round numbers, and capping there truncated the median
     analog outcome from 3.4% to 1.1% while the stop stayed at 4.6%, which is how
     43 of 45 alerts went out below 1:1. Kept for context, excluded from capping. */
  if (includeRound) {
    const mag = Math.pow(10, Math.max(0, String(Math.floor(price)).length - 2));
    const round = Math.ceil(price / mag) * mag;
    if (round > price * 1.001) levels.push({ name: "round", price: round });
  }

  levels.sort((a, b) => a.price - b.price);
  return levels[0] || null;
}

/**
 * Historical analogs: past bars in this stock where the same shape appeared,
 * and what happened over the horizon that followed.
 *
 * Matching on the full criteria set would need every metric's history, which the
 * feed does not carry. So analogs are matched on the PRICE-AND-VOLUME shape the
 * profile keys on — a breakout of the same lookback on comparable volume — and
 * the payload says so, because an analog set that quietly means something
 * narrower than the signal is a lie by omission.
 */
export function findAnalogs(candles, { lookback = 20, volMult = 1.5, sessions = 5 } = {}) {
  if (!candles || candles.length < lookback + sessions + 30) return { n: 0, mfe: [], mae: [], sessionsToPeak: [] };
  const mfe = [], mae = [], ttt = [];
  for (let i = lookback; i < candles.length - sessions; i++) {
    const c = candles[i];
    const window = candles.slice(i - lookback, i);
    const priorHigh = Math.max(...window.map(x => x.h));
    const avgVol = window.reduce((a, x) => a + (x.v || 0), 0) / window.length;
    const brokeOut = c.c > priorHigh;
    const hadVolume = avgVol > 0 && (c.v || 0) >= avgVol * volMult;
    if (!brokeOut || !hadVolume) continue;

    const fwd = candles.slice(i + 1, i + 1 + sessions);
    if (!fwd.length) continue;
    const best = Math.max(...fwd.map(x => x.h));
    mfe.push(pct(c.c, best));
    mae.push(pct(c.c, Math.min(...fwd.map(x => x.l))));
    // How long the best case took. This is what lets an alert say "typically
    // reached in 4 sessions" instead of asserting a horizon with no evidence.
    ttt.push(fwd.findIndex(x => x.h >= best) + 1);
  }
  return { n: mfe.length, mfe: mfe.filter(Number.isFinite), mae: mae.filter(Number.isFinite),
           sessionsToPeak: ttt.filter(Number.isFinite) };
}

/** Potential: how far this setup has typically run, and how much of that the
    delayed feed has already eaten. */
export function potential(stock, { horizon, triggerPrice }) {
  const sessions = HORIZON_SESSIONS[horizon];
  if (!sessions) return null; // long term — a % target over years means nothing
  const candles = stock.candles || [];
  const price = stock.price;
  const trigger = Number.isFinite(triggerPrice) ? triggerPrice : stock.high20 || price;
  const movedAlreadyPct = round2(pct(trigger, price)) ?? 0;

  const atr = atrPct(candles);
  /* ONE basis for everything downstream. The percentages the analogs produce are
     applied to this price, so the caps that bound them must be measured from it
     too. They were not: resistance was found above SPOT while the targets were
     built off the TRIGGER, so a stock trading at ₹399 with a trigger at ₹431 had
     its target capped by the round number at ₹400 — a wall ₹31 BELOW the entry.
     The three percentiles then collapsed to +0.23%, which was applied to ₹431.50
     to yield a "target" of ₹432.49 against a 3.4% stop: 0.07:1, and it went out
     in a Telegram alert. Mixed bases, not a market condition. */
  const basisPrice = trigger > price ? trigger : price;
  // Only levels with a record of rejecting price get to cap a target.
  const resistance = resistanceAbove(stock, candles, basisPrice, { includeRound: false });
  const lookback = horizon === "positional" ? 50 : 20;
  const { n, mfe, mae, sessionsToPeak } = findAnalogs(candles, { lookback, sessions });

  // The ceiling volatility allows: ~1.5 ATR for a session, scaled by the square
  // root of time for longer horizons — moves compound with volatility, not linearly.
  const atrCap = atr == null ? null : round2(atr * 1.5 * Math.sqrt(sessions));
  const resistCapPct = resistance ? round2(pct(basisPrice, resistance.price)) : null;

  const base = {
    horizon, sessions, triggerPrice: round2(trigger), movedAlreadyPct,
    // The price every percentage below is measured from. Published so a caller
    // can check a level rather than infer which price it was built off.
    basisPrice: round2(basisPrice),
    atrPct: round2(atr),
    resistance: resistance ? { level: resistance.name, price: round2(resistance.price) } : null,
  };

  if (n < MIN_ANALOGS) {
    return {
      ...base,
      insufficientHistory: true,
      analogs: { n, required: MIN_ANALOGS },
      bounds: { atrCapPct: atrCap, toResistancePct: resistCapPct },
      basis: `Only ${n} comparable setup${n === 1 ? "" : "s"} in this stock's history — too few to estimate a range. Volatility allows roughly ${atrCap == null ? "an unknown amount" : atrCap + "%"} over ${sessions} session${sessions === 1 ? "" : "s"}${resistance ? `, with ${resistance.name} overhead at ₹${round2(resistance.price)}` : ""}.`,
    };
  }

  const sortedMfe = [...mfe].sort((a, b) => a - b);
  let low = round2(percentile(sortedMfe, 0.25));
  let mid = round2(percentile(sortedMfe, 0.5));
  let high = round2(percentile(sortedMfe, 0.75));

  /* Bounded by volatility only.
     Capping these percentiles at the nearest overhead level was double-counting:
     the analogs are a MEASUREMENT of what this stock actually did after this
     setup, and every wall that existed on those days was already in the tape
     that produced the numbers. Truncating a measured distribution with a
     heuristic level can only shrink it, never correct it — and because the cap
     was applied to the 75th percentile and then clamped onto the median and the
     25th, one nearby pivot collapsed all three onto itself. That is how a 3.4%
     median swing outcome became a 1.1% target against a 4.6% stop.
     The wall is still reported and still named in the rationale; it informs the
     reader instead of silently rewriting the estimate. */
  let cappedBy = null;
  if (atrCap != null && high > atrCap) { high = atrCap; cappedBy = "atr"; }
  mid = Math.min(mid, high);
  low = Math.min(low, mid);

  /* A wall close overhead squeezes the three percentiles into the same number.
     Emitting "safe / primary / stretch" at one price would imply a choice that
     does not exist, so the collapse is flagged and the exits are presented as
     the single level they actually are. */
  const converged = high - low < 0.25;

  /* Only a move that has actually happened can be subtracted. When price is
     still below the trigger the setup has not fired, movedAlreadyPct is
     negative, and subtracting it would report MORE upside remaining than the
     whole estimated range — adding the distance to the trigger to the move that
     follows it. Remaining is capped at the range for that reason. */
  const captured = Math.max(0, movedAlreadyPct);
  const remaining = v => round2(Math.max(0, v - captured));
  const medianMAE = round2(median(mae));
  const winRate = sortedMfe.length ? round2((mfe.filter(v => v >= mid).length / mfe.length) * 100) : null;

  return {
    ...base,
    estRangePct: { low, median: mid, high },
    remainingPct: { low: remaining(low), median: remaining(mid), high: remaining(high) },
    exhausted: remaining(mid) <= 0,
    cappedBy, converged,
    analogs: { n, medianMFE: round2(median(mfe)), medianMAE, winRate,
               medianSessionsToPeak: n >= MIN_ANALOGS ? Math.round(median(sessionsToPeak) ?? 0) || null : null },
    basis: `${n} comparable setups in this stock; median best case +${round2(median(mfe))}%, typical drawdown ${medianMAE}% over ${sessions} session${sessions === 1 ? "" : "s"}. Matched on breakout and volume shape, not on the full criteria set.`,
  };
}

/* ── confidence ───────────────────────────────────────────────────────────
   Components are returned alongside the score. A number the user cannot
   interrogate is a number they should not trust. */

const BANDS = [[75, "high"], [55, "moderate"], [35, "low"], [0, "speculative"]];
const bandOf = s => BANDS.find(([min]) => s >= min)[1];

export function confidence(stock, { profile, evaluation, pot, dataAge, event }) {
  const comps = [];
  const caps = [];
  let score = 50;
  const add = (name, contribution, note) => {
    comps.push({ name, contribution: round2(contribution), note });
    score += contribution;
  };

  /* Long term deliberately has no potential estimate — a percentage target over
     years is not actionable, so none is computed. That is a design choice, not
     missing evidence, and penalising it as though history were thin would mark
     every long-term signal down for a reason that does not apply. Such a signal
     rests on the fundamental criteria themselves. */
  const noEstimateByDesign = pot === null;

  if (!noEstimateByDesign) {
    // Evidence depth — how much history stands behind the estimate.
    const n = pot?.analogs?.n ?? 0;
    if (n >= MIN_ANALOGS) add("Evidence depth", Math.min(15, (n - MIN_ANALOGS) * 0.8 + 6), `${n} historical analogs`);
    else add("Evidence depth", -20, `only ${n} analogs — below the ${MIN_ANALOGS} needed to estimate a range`);
  } else {
    comps.push({ name: "Evidence depth", contribution: 0, note: "no move estimate at this horizon by design — judged on the fundamental criteria" });
  }

  // Analog consistency — a tight band of outcomes is worth more than a wild one.
  if (pot?.estRangePct) {
    const spread = pot.estRangePct.high - pot.estRangePct.low;
    const rel = pot.estRangePct.median > 0 ? spread / pot.estRangePct.median : 99;
    add("Analog consistency", rel < 1 ? 10 : rel < 2 ? 4 : -6,
      rel < 1 ? "past outcomes clustered tightly" : rel < 2 ? "moderate dispersion" : "past outcomes varied widely");
  }

  // Criteria margin — clearing a threshold by a mile is not the same as scraping past it.
  const margins = [];
  for (const c of evaluation?.criteria || []) {
    for (const chk of c.checksOut || []) {
      if (!chk.ok || !Number.isFinite(chk.v) || !Number.isFinite(chk.value) || chk.value === 0) continue;
      margins.push(chk.op === "gte" ? (chk.v - chk.value) / Math.abs(chk.value) : (chk.value - chk.v) / Math.abs(chk.value));
    }
  }
  if (margins.length) {
    const m = margins.reduce((a, b) => a + b, 0) / margins.length;
    add("Criteria margin", Math.max(-5, Math.min(12, m * 20)),
      `criteria cleared thresholds by ${round2(m * 100)}% on average`);
  }

  // Liquidity — a signal you cannot get out of is not a signal.
  const turnover = (stock.avgVol20 || 0) * (stock.price || 0);
  if (turnover < 5e6) add("Liquidity", -15, "thin traded value — exiting may move the price");
  else if (turnover < 5e7) add("Liquidity", -5, "moderate traded value");
  else add("Liquidity", 5, "liquid enough to exit");

  // Structure headroom — a target crowded against a wall deserves less confidence.
  if (pot?.cappedBy?.startsWith("resistance")) add("Structure headroom", -8, `capped by ${pot.cappedBy}`);

  // Event risk — a result inside the horizon makes this a coin toss on news.
  if (event?.daysAway != null && event.daysAway <= (pot?.sessions ?? 5))
    add("Event risk", -12, `${event.type} in ${event.daysAway} day${event.daysAway === 1 ? "" : "s"} — binary risk inside the horizon`);

  // Data freshness. A penalty AND a hard ceiling: on a delayed feed the top band
  // is unreachable by design, because part of the move is already gone.
  if (dataAge?.delayed) {
    add("Data freshness", -10, `prices ~${Math.round((dataAge.lagSeconds || 900) / 60)} min delayed`);
    const cap = profile?.horizon === "intraday" ? 55 : 65;
    caps.push(`delayed feed${profile?.horizon === "intraday" ? " on an intraday setup" : ""}: capped at ${cap}`);
    score = Math.min(score, cap);
  } else {
    add("Data freshness", 8, "live feed");
  }

  if (pot?.exhausted) {
    add("Move already captured", -15, "the move this setup typically delivers has already happened");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const band = bandOf(score);
  const reasons = comps.filter(c => Math.abs(c.contribution) >= 5).slice(0, 3).map(c => c.note);
  return {
    score, band, components: comps, caps,
    summary: `${band[0].toUpperCase() + band.slice(1)} (${score}). ${reasons.join("; ")}.`,
  };
}

/* ── exits ────────────────────────────────────────────────────────────────
   Three levels with reasoning, plus the stop that invalidates the setup. The
   question this answers is "bank 8% or hold for 10%", so it must show the
   trade-off rather than pick for the user. */

export function exitLevels(stock, { pot, conf, atr }) {
  if (!pot || pot.insufficientHistory || !pot.estRangePct) return null;
  /* Measured from the level the trade is ENTERED at, not from spot.
     The analog percentages describe the move that follows the trigger, so
     applying them to a price still below the trigger produces a "target" beneath
     the entry — a buy told to sell lower than it bought. Same defect as the
     playbook's, and it reached the alert the moment exits started being sent.
     Untriggered setups measure from the trigger; triggered ones from spot,
     because that is where the position actually starts.
     `basisPrice` is that decision, made once in potential() so the caps and the
     levels cannot drift onto different prices — which is exactly what happened
     when this file chose the basis and potential() chose the caps. */
  const price = pot.basisPrice ?? stock.price;
  const a = atr ?? pot.atrPct;
  const mfeHitRate = p => {
    const n = pot.analogs?.n || 0;
    return n ? round2(p * 100) : null;
  };

  const lvl = (p, rationale) => ({ pct: round2(p), price: round2(price * (1 + p / 100)), rationale });
  const stopPct = a ? -round2(Math.max(a * 1.5, Math.abs(pot.analogs?.medianMAE ?? a))) : -3;

  // Resistance sitting just overhead squeezes all three tiers onto one price.
  // Say that, rather than dressing one level up as three.
  if (pot.converged) {
    const at = lvl(pot.estRangePct.median,
      `${pot.resistance ? `${pot.resistance.level} at ₹${pot.resistance.price} sits just above` : "The volatility ceiling sits just above"}, so the safe, primary and stretch targets collapse onto the same level — there is no meaningful choice between them here.`);
    const stop0 = lvl(stopPct,
      `1.5× ATR below price — the level that invalidates the setup rather than an arbitrary percentage.`);
    const rr0 = stopPct ? round2(Math.abs(at.pct / stopPct)) : null;
    const noRoom0 = rr0 != null && rr0 < 1;
    return {
      converged: true, ...(noRoom0 ? { noRoom: true, withheld: { primary: at.price, why: "below 1:1 against the stop" } } : {}),
      safe: noRoom0 ? null : at, primary: noRoom0 ? null : at, stretch: noRoom0 ? null : at, stop: stop0,
      riskReward: { toSafe: rr0, toPrimary: rr0, toStretch: rr0 },
      riskRewardWarning: noRoom0
        ? `Risk-reward to the only available target is ${rr0}:1. No target is offered — ${pot.resistance ? `${pot.resistance.level} at ₹${pot.resistance.price}` : "the volatility ceiling"} is ${at.pct}% away against a ${Math.abs(stopPct)}% stop.`
        : null,
      suggestion: pot.exhausted
        ? `The move these setups typically deliver has already happened (+${pot.movedAlreadyPct}% since the trigger), and ${pot.resistance ? `${pot.resistance.level} at ₹${pot.resistance.price}` : "the volatility ceiling"} is directly overhead. The evidence does not favour a fresh entry here.`
        : `Only about ${at.pct}% stands between price and ${pot.resistance ? pot.resistance.level : "the ceiling"}, against a stop ${Math.abs(stop0.pct)}% away — a ${rr0}:1 payoff. The room does not justify the risk unless the level breaks first.`,
    };
  }

  const safe = lvl(pot.estRangePct.low,
    `The 25th-percentile outcome across ${pot.analogs.n} past setups — the level most of them reached. Banking here trades upside for hit rate.`);
  const primary = lvl(pot.estRangePct.median,
    /* This used to say "kept below {level} at ₹X, which has rejected price
       before", which was true while the percentiles were truncated at that
       level. They no longer are, and the sentence outlived the behaviour: on
       BEL/positional it annotated a ₹426.35 target with "kept below ₹408.45" —
       prose asserting a cap that did not happen, naming a price BELOW the number
       it was attached to. The level is still worth stating; what changed is that
       it is context the reader weighs, not a bound the estimate obeys. */
    `The median outcome of those setups.${pot.resistance ? ` ${pot.resistance.level} at ₹${pot.resistance.price} is the nearest level overhead that has rejected price before; this estimate is measured from what this stock actually did and assumes neither that the level holds nor that it breaks.` : ""}`);
  const stretch = lvl(pot.estRangePct.high,
    `The 75th-percentile outcome — reached by roughly ${mfeHitRate(0.25)}% of past setups. Only sensible behind a trailing stop.`);
  const stop = lvl(stopPct,
    `1.5× ATR below price${pot.analogs?.medianMAE != null ? `, about the ${pot.analogs.medianMAE}% drawdown these setups typically put you through` : ""} — the level that invalidates the setup rather than an arbitrary percentage.`);

  const rr = target => (stopPct ? round2(Math.abs(target / stopPct)) : null);
  const riskReward = { toSafe: rr(safe.pct), toPrimary: rr(primary.pct), toStretch: rr(stretch.pct) };

  // The suggestion reasons from the numbers and never instructs. Framing is
  // deliberate: "the evidence favours", never "you should".
  const remaining = pot.remainingPct?.median ?? primary.pct;
  let suggestion;
  if (pot.exhausted) {
    suggestion = `The move these setups typically deliver has already happened (+${pot.movedAlreadyPct}% since the trigger). What remains is below the median outcome, so the evidence does not favour a fresh entry here.`;
  } else if (riskReward.toPrimary != null && riskReward.toPrimary < 1) {
    suggestion = `Risk-reward to the primary target is ${riskReward.toPrimary}:1 — below 1:1, the math is against this regardless of how the setup looks.`;
  } else if (conf?.band === "high" || conf?.band === "moderate") {
    suggestion = `With confidence ${conf.band} (${conf.score}) and about ${remaining}% of the typical move still ahead, holding for ${primary.pct}% carries a ${riskReward.toPrimary}:1 payoff against the stop; the safe exit at ${safe.pct}% trades that for a higher hit rate.`;
  } else {
    suggestion = `Confidence is ${conf?.band ?? "low"} (${conf?.score ?? "n/a"}), so the evidence favours the safe exit at ${safe.pct}% over holding for ${primary.pct}%.`;
  }

  /* A target closer than the stop is not a trade, and printing it as one is the
     same failure as printing a manufactured convergence: the number looks like a
     level to act on and is not. The stop stays — it is the honest half — and the
     reason is stated instead of a price. `noRoom` is the finding, not an error. */
  /* Tested against the STRETCH, not the median. The stop is deliberately wide —
     max(1.5×ATR, the drawdown these setups typically inflict) — so that noise
     does not take you out. Judging that tail-sized risk against a median-sized
     reward compares two different things and condemns almost every setup: it put
     68 of 100 here. The honest question is whether ANY exit plan clears 1:1, and
     that is the 75th percentile. Below-1:1 to the median is still reported. */
  if (riskReward.toStretch != null && riskReward.toStretch < 1) {
    return {
      noRoom: true,
      safe: null, primary: null, stretch: null, stop, riskReward,
      riskRewardWarning: `Even the best-case target is ${riskReward.toStretch}:1 against the stop. No target is offered — the 75th-percentile outcome of these setups is ${stretch.pct}% while the stop sits ${Math.abs(stopPct)}% away, so there is less to gain than to lose on any exit plan.`,
      suggestion,
      withheld: { safe: safe.price, primary: primary.price, stretch: stretch.price,
                  why: "below 1:1 against the stop" },
    };
  }

  return {
    safe, primary, stretch, stop, riskReward,
    // Not a withholding — the stretch clears 1:1, so a plan exists. Says plainly
    // that banking at the median does not pay for the risk taken to get there.
    riskRewardWarning: riskReward.toPrimary != null && riskReward.toPrimary < 1
      ? `Risk-reward to the primary target is ${riskReward.toPrimary}:1 — only the stretch target at ${stretch.pct}% (${riskReward.toStretch}:1) pays for this stop.`
      : null,
    suggestion,
  };
}
