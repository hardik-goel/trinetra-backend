/* The playbook: where to get in, where it is now, where to get out, what is left.

   The organising rule is CONVERGENCE. A level found by one method is that
   method's opinion. The same level found by a swing cluster, a Fibonacci
   retracement, a moving average and a broker target is a level, because those
   four do not share a premise. So nothing here picks a method's output — it
   clusters candidates from independent sources and scores by agreement.

   When the methods scatter, that is the finding. "No level here — four methods,
   no agreement" is more useful than a confident number invented by picking one. */

import { candidates as levelCandidates, atr as atrOf } from "./levels.js";
import { analyse as analyseCandles } from "./candles.js";
import { forSymbol as analystsFor } from "./analysts.js";
import { HORIZON_SESSIONS } from "./profiles.js";
import { findAnalogs } from "./analysis.js";

const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const pct = (a, b) => (a > 0 ? ((b - a) / a) * 100 : null);

/* Methods that genuinely differ. Two candidates from the same family are one
   opinion twice, so convergence counts FAMILIES, not candidates — otherwise
   three round numbers near a price would look like agreement. */
const FAMILY = {
  "swing cluster": "structure", "20-day high": "structure", "20-day low": "structure",
  "52-week high": "structure", "52-week low": "structure",
  "20-day MA": "trend", "50-day MA": "trend", "200-day MA": "trend",
  "Fib 38.2%": "fibonacci", "Fib 50.0%": "fibonacci", "Fib 61.8%": "fibonacci",
  "volume point of control": "volume", "volume node": "volume",
  "round number": "psychological",
  "broker target": "broker", "candlestick": "candlestick",
};
const familyOf = method => FAMILY[method] || "other";

/** Group candidates into zones of ATR-scaled width and score each by how many
    independent families agree. */
function convergeZones(cands, atrValue, price) {
  const width = Math.max(atrValue * 0.5, price * 0.004); // half an ATR, floor 0.4%
  const sorted = [...cands].sort((a, b) => a.price - b.price);
  const zones = [];
  for (const c of sorted) {
    const z = zones.at(-1);
    /* Bounded by the zone's LOW, not its high. Chaining off the high lets each
       new candidate extend the zone indefinitely — round numbers every ₹100 with
       a ₹108 join width merged every level from ₹7437 to ₹10500 into one "zone",
       which is no zone at all. A zone is at most `width` wide, full stop. */
    if (z && c.price - z.low <= width) {
      z.members.push(c);
      z.high = Math.max(z.high, c.price);
      z.low = Math.min(z.low, c.price);
    } else {
      zones.push({ low: c.price, high: c.price, members: [c] });
    }
  }
  return zones.map(z => {
    const families = new Set(z.members.map(m => familyOf(m.method)));
    // Psychological levels do not get a vote of their own; they only reinforce.
    families.delete("psychological");
    const strength = z.members.reduce((a, m) => a + (m.strength || 0), 0);
    const mid = (z.low + z.high) / 2;
    return {
      zone: { low: round2(Math.min(z.low, mid - width / 2)), high: round2(Math.max(z.high, mid + width / 2)) },
      mid: round2(mid),
      convergence: families.size,
      families: [...families],
      strength: round2(strength),
      members: z.members,
      type: mid < price ? "support" : "resistance",
    };
  });
}

/** Broker targets become level candidates, weighted by that broker's measured
    record. A target from someone with no record still appears — it just cannot
    carry a level on its own. */
function brokerCandidates(analysts) {
  return (analysts?.live || []).filter(c => c.target).map(c => ({
    price: c.target, type: "resistance",
    // A named expert is not a brokerage desk; the evidence table says which.
    source: c.kind === "expert" ? "Expert" : "Broker",
    method: c.kind === "expert" ? "expert call" : "broker target",
    strength: c.accuracy?.insufficient ? 0.3 : Math.min(0.9, (c.accuracy.rate || 0) / 100),
    note: `${c.broker}${c.call ? ` says ${c.call}` : ""} · target ₹${c.target}${c.accuracy?.insufficient ? " (no measured record yet)" : ` (${c.accuracy.rate}% hit rate, n=${c.accuracy.n})`}`,
    broker: c.broker, url: c.url, accuracy: c.accuracy,
  }));
}

/** Context-valid candles at a level become candidates too — a pattern is not a
    price, but it is a reason to trust the price it formed at. */
function candleCandidates(candles) {
  return (candles?.valid || [])
    .filter(d => d.atLevel && d.sessionsAgo <= 5)
    .map(d => ({
      price: d.atLevel.price, type: d.atLevel.type, source: "Candlestick", method: "candlestick",
      strength: d.history?.insufficient ? 0.3
        : d.history ? Math.min(0.9, Math.max(0.1, (d.history.edgeVsBaseline ?? 0) / 20 + 0.4))
        : 0.3,
      note: d.reading, pattern: d.pattern, direction: d.direction, history: d.history,
    }));
}

const evid = (source, name, stance, detail, weight, reliability = null, url = null) =>
  ({ source, name, stance, detail, weight: round2(weight), reliability, url });

/** Evidence for one zone — including everything that argues against it. */
function evidenceFor(zone, { price, analysts, candles, analogs, direction }) {
  const out = [];
  for (const m of zone.members) {
    // Named humans are named. "Expert/expert call" tells the user nothing they
    // can weigh; "Expert/Sandeep Jain" is the thing they actually want to judge.
    const isBroker = m.source === "Broker" || m.source === "Expert";
    out.push(evid(
      m.source, isBroker ? m.broker : m.method,
      "supports", m.note, m.strength,
      isBroker ? (m.accuracy?.insufficient ? { rate: null, n: m.accuracy.n } : { rate: m.accuracy.rate, n: m.accuracy.n })
        : m.history ? { rate: m.history.followThroughRate ?? null, n: m.history.occurrences }
        : null,
      m.url || null,
    ));
  }

  /* Opposing evidence is not optional. A list that only argues one way is
     marketing, and the user cannot weigh what they are not shown. */
  for (const c of analysts?.live || []) {
    if (c.target && c.target < price && direction === "up") {
      out.push(evid("Broker", c.broker, "opposes",
        `Target ₹${c.target} sits below the current ₹${round2(price)} — this broker sees downside from here.`,
        c.accuracy?.insufficient ? 0.3 : (c.accuracy.rate || 0) / 100,
        c.accuracy?.insufficient ? { rate: null, n: c.accuracy.n } : { rate: c.accuracy.rate, n: c.accuracy.n },
        c.url));
    }
  }
  for (const d of candles?.valid || []) {
    const against = direction === "up" ? d.direction === "bearish" : d.direction === "bullish";
    if (against && d.sessionsAgo <= 5) {
      out.push(evid("Candlestick", d.pattern, "opposes", d.reading,
        d.history?.insufficient ? 0.3 : 0.5,
        d.history && !d.history.insufficient ? { rate: d.history.followThroughRate, n: d.history.occurrences } : null));
    }
  }
  if (analogs?.n >= 8) {
    out.push(evid("Analog", `${analogs.n} similar setups in this stock`, "supports",
      `Median best case +${analogs.medianMFE}%, typical drawdown ${analogs.medianMAE}% over the horizon.`,
      0.6, { rate: analogs.winRate ?? null, n: analogs.n }));
  } else if (analogs) {
    out.push(evid("Analog", "Historical analogs", "neutral",
      `Only ${analogs.n} comparable setups in this stock — too few to draw on.`, 0.1, { rate: null, n: analogs.n }));
  }

  return out.sort((a, b) => (b.stance === "supports") - (a.stance === "supports") || b.weight - a.weight);
}

function scoreConfidence({ zone, analogs, dataAge, horizon, liquidity, event }) {
  const comps = [];
  const caps = [];
  let score = 40;
  const add = (name, contribution, note) => { comps.push({ name, contribution: round2(contribution), note }); score += contribution; };

  // Convergence is the heaviest input, by design.
  const conv = zone?.convergence ?? 0;
  add("Convergence", Math.min(28, conv * 9),
    conv === 0 ? "no independent methods agree here"
      : `${conv} independent method${conv === 1 ? "" : "s"} agree: ${zone.families.join(", ")}`);

  add("Level strength", Math.min(12, (zone?.strength ?? 0) * 3),
    zone?.members?.length ? `${zone.members.length} candidate levels in the zone` : "no level candidates");

  const candle = (zone?.members || []).find(m => m.source === "Candlestick");
  if (candle) add("Candlestick confirmation", candle.history?.insufficient ? 2 : Math.min(10, ((candle.history?.edgeVsBaseline ?? 0) / 2)),
    candle.history?.insufficient ? "a pattern formed here, but this stock has too little history with it"
      : `${candle.pattern}, ${candle.history?.verdict}`);

  /* Expert and analyst opinion is capped, hard. Convergence of independent
     technical methods can contribute 28; every named human view combined can
     contribute at most 10. The system must never become a channel for one
     person's opinion, however good that person's record — and a cap is the only
     thing that holds when a source starts looking reliable. */
  const EXPERT_CAP = 10;
  const broker = (zone?.members || []).find(m => m.source === "Broker" || m.source === "Expert");
  if (broker) add("Analyst support", broker.accuracy?.insufficient ? 2 : Math.min(EXPERT_CAP, (broker.accuracy.rate - 50) / 5),
    broker.accuracy?.insufficient ? `${broker.broker} targets this zone, with no measured record yet`
      : `${broker.broker} targets this zone (${broker.accuracy.rate}% hit rate, n=${broker.accuracy.n})`);

  if (analogs) add("Analog history", analogs.n >= 8 ? Math.min(10, analogs.n / 3) : -10,
    analogs.n >= 8 ? `${analogs.n} comparable setups` : `only ${analogs.n} comparable setups`);

  if (liquidity != null) add("Liquidity", liquidity < 5e6 ? -15 : liquidity < 5e7 ? -5 : 4,
    liquidity < 5e6 ? "thin traded value — exiting may move the price" : "liquid enough to exit");

  if (event?.daysAway != null && event.daysAway <= (HORIZON_SESSIONS[horizon] ?? 5))
    add("Event risk", -12, `${event.type} in ${event.daysAway} day${event.daysAway === 1 ? "" : "s"} — binary risk inside the horizon`);

  if (dataAge?.delayed) {
    add("Data freshness", -8, `prices ~${Math.round((dataAge.lagSeconds || 900) / 60)} min delayed`);
    const cap = horizon === "intraday" ? 55 : 65;
    caps.push(`delayed feed${horizon === "intraday" ? " on an intraday setup" : ""}: capped at ${cap}`);
    score = Math.min(score, cap);
  }

  const humanTotal = comps.filter(c => c.name === "Analyst support").reduce((a, c) => a + Math.max(0, c.contribution), 0);
  if (humanTotal > 10) {
    const excess = humanTotal - 10;
    score -= excess;
    caps.push(`named-expert and analyst views capped at 10 points combined (trimmed ${round2(excess)})`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const band = score >= 75 ? "high" : score >= 55 ? "moderate" : score >= 35 ? "low" : "speculative";
  const top = comps.filter(c => Math.abs(c.contribution) >= 5).slice(0, 3).map(c => c.note);
  return { score, band, components: comps, caps, summary: `${band[0].toUpperCase() + band.slice(1)} (${score}). ${top.join("; ")}.` };
}

/**
 * Build the playbook for one stock under one profile.
 * @param stock snapshot row with candles
 * @param opts  { profile, dataAge, event, triggerPrice }
 */
export function build(stock, { profile, dataAge, event, triggerPrice, direction = "buy", intent } = {}) {
  /* Direction decides which side of price everything sits on. For a sell the
     mirror is exact: the level you act at is ABOVE (resistance), the target is
     BELOW (support), and the potential is the fall between them. Rendering a sell
     with buy-side labels — "target above entry", a + prefix, an up arrow — is a
     direction error, and a direction error in a trading UI costs money. */
  const isSell = direction === "sell";
  const price = stock.price;
  const horizon = profile?.horizon || "swing";
  const sessions = HORIZON_SESSIONS[horizon] ?? 5;
  const lv = levelCandidates(stock);
  if (lv.insufficient) {
    return { symbol: stock.symbol, price, horizon, insufficient: true, bars: lv.bars,
             reading: `Only ${lv.bars} sessions of history — not enough to place levels.` };
  }

  const atrValue = lv.atr?.value ?? price * 0.02;
  const analysts = analystsFor(stock.symbol);
  const candles = analyseCandles(stock, lv.candidates, { lookback: 5, horizon: sessions });
  const analogRaw = findAnalogs(stock.candles || [], { lookback: horizon === "positional" ? 50 : 20, sessions });
  const med = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return round2(s[Math.floor(s.length / 2)]); };
  const analogs = { n: analogRaw.n, medianMFE: med(analogRaw.mfe), medianMAE: med(analogRaw.mae),
                    winRate: analogRaw.n ? round2((analogRaw.mfe.filter(v => v >= (med(analogRaw.mfe) ?? 0)).length / analogRaw.n) * 100) : null };

  const all = [...lv.candidates, ...brokerCandidates(analysts), ...candleCandidates(candles)];
  const zones = convergeZones(all, atrValue, price);
  /* A zone that straddles the current price is where price IS, not somewhere it
     could go — using it as a target produced a "safe exit" 0.35% away. Targets
     must sit entirely above, stops entirely below. */
  const aboveSpot = zones.filter(z => z.zone.low > price).sort((a, b) => a.mid - b.mid);
  const belowSpot = zones.filter(z => z.zone.high < price).sort((a, b) => b.mid - a.mid);

  /* ── entry ── */
  const trigger = Number.isFinite(triggerPrice) ? triggerPrice : (horizon === "positional" ? stock.high50 : stock.high20) ?? price;
  const triggered = price > trigger;
  const movedAlreadyPct = round2(pct(trigger, price));
  const beyondAtr = triggered ? (price - trigger) / atrValue : 0;
  const chasing = triggered && beyondAtr > 1;

  // Not yet triggered: the breakout level. Triggered and extended: the nearest
  // support to pull back to, because buying a stock already 1 ATR past its
  // trigger is the most common way a good signal becomes a bad trade.
  /* The trigger is the trigger. A convergence zone only becomes the entry when
     it actually contains that price — otherwise the payload would announce a
     zone 3% below the level the setup needs, which is a different trade. */
  const entryZone = !triggered
    ? (aboveSpot.find(z => z.zone.low <= trigger && trigger <= z.zone.high)
       || { zone: { low: round2(trigger), high: round2(trigger + atrValue * 0.4) }, convergence: 0, families: [], members: [], strength: 0 })
    : (belowSpot[0] || { zone: { low: round2(price - atrValue), high: round2(price) }, convergence: 0, families: [], members: [], strength: 0 });

  /* Targets and risk are measured from the price you would ACTUALLY PAY, not
     from spot. For an untriggered setup that is the entry zone, not the current
     price — otherwise a zone sitting between spot and the trigger becomes a
     "target" that is below the entry, and the risk-reward describes buying now,
     which the entry rule explicitly forbids. Observed on ZENTEC: entry
     1877.83–1907.67, untriggered, targets 1697/1752/1787, R:R 2.82 against a
     price the setup rejects. */
  const basisPrice = triggered ? price : entryZone.zone.high;
  const basisLabel = triggered ? "current price" : "entry zone — the setup has not triggered yet";
  const above = zones.filter(z => z.zone.low > basisPrice).sort((a, b) => a.mid - b.mid);
  const below = zones.filter(z => z.zone.high < basisPrice).sort((a, b) => b.mid - a.mid);
  // Targets run away from the action level; the stop sits behind it. Swapping the
  // two lists is the whole of the mirror.
  const targetZones = isSell ? below : above;
  const stopZones = isSell ? above : below;

  const entryConfidence = scoreConfidence({
    zone: entryZone, analogs, dataAge, horizon,
    liquidity: (stock.avgVol20 || 0) * price, event,
  });

  /* ── exits ── */
  const pick = (arr, i) => arr[Math.min(i, arr.length - 1)] || null;
  const safeZ = pick(targetZones, 0), primaryZ = pick(targetZones, 1) || safeZ, stretchZ = pick(targetZones, 2) || primaryZ;
  /* The stop must sit beyond the ENTRY, not merely beyond spot. When the entry is
     a pullback zone below price, a support cluster can land between the two — and
     a "stop" above the level you buy at is not a stop, it is an instruction to
     exit before the trade has begun. Candidates are filtered against the entry
     basis; if that leaves none, there is no structural stop here and the ATR
     fallback applies rather than a level that reads coherent and is not. */
  const stopBound = isSell ? Math.max(entryZone.zone.high, basisPrice) : Math.min(entryZone.zone.low, basisPrice);
  const validStops = stopZones.filter(z => (isSell ? z.mid > stopBound : z.mid < stopBound));
  const stopZ = validStops.find(z => z.convergence >= 1) || validStops[0] || null;

  const level = (z, label) => z && {
    zone: z.zone, mid: z.mid,
    // Signed move, and the magnitude the UI shows. A sell's capture is a fall,
    // reported positive with `downward: true` so it can never be rendered as a gain.
    pct: round2(pct(basisPrice, z.mid)),
    movePct: round2(Math.abs(pct(basisPrice, z.mid))),
    downward: isSell,
    anchor: z.members.map(m => m.method).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(" + ") || label,
    convergence: z.convergence, families: z.families,
    evidence: evidenceFor(z, { price, analysts, candles, analogs, direction: isSell ? "down" : "up" }),
  };

  const stopPct = stopZ ? round2(pct(basisPrice, stopZ.mid))
    : round2((isSell ? 1 : -1) * (atrValue * 1.5 / basisPrice) * 100);
  const rr = t => (t?.pct && stopPct ? round2(Math.abs(t.pct / stopPct)) : null);
  const tWord = isSell ? "support" : "resistance";
  const safe = level(safeZ, `nearest ${tWord}`);
  const primary = level(primaryZ, `next ${tWord}`);
  const stretch = level(stretchZ, `far ${tWord}`);

  /* Two different sells exist and they are not the same trade.

     Trimming a holding: you own the stock, you sell part of it high, and you BUY
     BACK to restore the core. Shorting: you own nothing, you sell borrowed stock,
     and you COVER to close. "Buy back" on a short is actively wrong — it implies
     restoring a position you hold, which is the cycle feature. The distinction
     rides on `intent` rather than being guessed from direction, because direction
     alone cannot tell them apart. */
  const sellIntent = intent || (profile?.direction === "sell" ? "short" : "trim");
  const isShort = isSell && sellIntent === "short";

  const exits = {
    direction,
    intent: isSell ? sellIntent : "entry",
    // Labels travel with the payload so no renderer has to infer them.
    actionLabel: isSell ? (isShort ? "Short at" : "Sell at") : "Entry",
    targetLabel: isSell ? (isShort ? "Cover at" : "Buy back") : "Target",
    safe, primary, stretch,
    stop: stopZ
      ? { zone: stopZ.zone, mid: stopZ.mid, pct: stopPct,
          movePct: round2(Math.abs(stopPct)), above: isSell,
          anchor: stopZ.members.map(m => m.method)[0] || (isSell ? "nearest resistance" : "nearest support"),
          /* A sell is invalidated by price running away UPWARD — the mirror of a
             buy breaking support. Saying "below … support" on a trim would point
             the user at the wrong side of the tape. */
          rationale: isSell
            ? `Above ₹${stopZ.mid}, where ${stopZ.convergence} method${stopZ.convergence === 1 ? "" : "s"} place resistance — if it clears that, the trim was early and buying back gets expensive.`
            : `Below ₹${stopZ.mid}, where ${stopZ.convergence} method${stopZ.convergence === 1 ? "" : "s"} place support — the level that would prove the idea wrong, not an arbitrary percentage.` }
      : { zone: isSell
            ? { low: round2(basisPrice), high: round2(basisPrice * (1 + Math.abs(stopPct) / 100)) }
            : { low: round2(basisPrice * (1 + stopPct / 100)), high: round2(basisPrice) },
          pct: stopPct, movePct: round2(Math.abs(stopPct)), above: isSell,
          anchor: "1.5x ATR",
          rationale: isSell
            ? "No resistance cluster above — falling back to a volatility-based stop, which is weaker evidence."
            : "No support cluster below — falling back to a volatility-based stop, which is weaker evidence." },
    riskReward: { toSafe: rr(safe), toPrimary: rr(primary), toStretch: rr(stretch) },
  };
  exits.riskRewardWarning = exits.riskReward.toPrimary != null && exits.riskReward.toPrimary < 1
    ? "Risk-reward to the primary target is below 1:1 — the maths is against this regardless of how the setup looks." : null;
  exits.confidence = scoreConfidence({
    zone: primaryZ, analogs, dataAge, horizon,
    liquidity: (stock.avgVol20 || 0) * price, event,
  });

  const potential = {
    direction,
    // Magnitude, so a sort on "potential" ranks by size regardless of direction.
    magnitudePct: primary ? round2(Math.abs(primary.pct)) : null,
    downward: isSell,
    toSafePct: safe?.pct ?? null, toPrimaryPct: primary?.pct ?? null, toStretchPct: stretch?.pct ?? null,
    movedAlreadyPct, exhausted: (primary?.pct ?? 1) <= 0,
    // What every percentage above is measured from, stated rather than inferred.
    basisPrice: round2(basisPrice), basis: basisLabel,
    fromSpotToPrimaryPct: primary ? round2(pct(price, primary.mid)) : null,
  };

  return {
    symbol: stock.symbol, price: round2(price), horizon, direction,
    profileId: profile?.horizon || horizon,
    basisPrice: round2(basisPrice), basis: basisLabel,
    atr: lv.atr,
    entry: {
      label: isSell ? (sellIntent === "short" ? "Short at" : "Sell at") : "Entry",
      // "trim level" is a holdings word. A short has no holding to trim.
      kind: isSell ? (isShort ? "short entry" : "trim level") : (triggered ? "pullback entry" : "breakout trigger"),
      zone: entryZone.zone, triggered, chasing,
      chaseRiskPct: chasing ? round2(beyondAtr * 100) / 100 : null,
      movedAlreadyPct,
      convergence: entryZone.convergence, families: entryZone.families,
      anchors: entryZone.members.map(m => ({ name: m.method, price: m.price, type: m.type })).slice(0, 4),
      confidence: entryConfidence,
      evidence: evidenceFor(entryZone, { price, analysts, candles, analogs, direction: "up" }),
      warning: chasing
        ? `Price is already ${round2(beyondAtr * 100) / 100} ATR past the ₹${round2(trigger)} trigger. Buying here is chasing — the pullback zone below is the lower-risk entry, and there may not be one.`
        : null,
    },
    exits, potential,
    candles: { detected: candles.detected, valid: candles.valid },
    analysts,
    convergence: Math.max(entryZone.convergence, primaryZ?.convergence ?? 0),
    reading: readingFor({ stock, entryZone, primaryZ, potential, entryConfidence, chasing, triggered, analysts }),
  };
}

function readingFor({ stock, entryZone, primaryZ, potential, entryConfidence, chasing, triggered, analysts }) {
  const bits = [];
  if (!triggered) bits.push(`Not triggered yet — the setup qualifies above ₹${entryZone.zone.high}.`);
  else if (chasing) bits.push(`Already past its trigger by more than an ATR; entering here is chasing.`);
  else bits.push(`Triggered, ${potential.movedAlreadyPct}% past the level.`);

  if (!primaryZ || primaryZ.convergence === 0) {
    bits.push("No resistance zone has more than one method behind it, so there is no target worth naming — that is the finding, not a gap.");
  } else {
    bits.push(`Primary target ₹${primaryZ.zone.low}–${primaryZ.zone.high} where ${primaryZ.convergence} methods agree (${primaryZ.families.join(", ")}), ${potential.toPrimaryPct}% away.`);
  }
  bits.push(`Confidence ${entryConfidence.band} (${entryConfidence.score}).`);
  if (analysts?.unavailable) bits.push("No broker calls on record for this name.");
  return bits.join(" ");
}
