/* Exit signals, each with its reasoning stated in full.

   An alert that says "SELL POLYCAB" is worse than no alert: it demands the most
   consequential action in the app while withholding the evidence for it, so the
   user either obeys blindly or ignores it — and both are bad outcomes.

   Every rule here therefore emits a `reasoning` sentence naming the actual
   numbers: what was true at entry, what is true now, and which specific thing
   broke. The word "sell" appears nowhere. The final call is the user's, and the
   payload says so. */

import { HORIZON_SESSIONS } from "./profiles.js";

const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);
const rupee = v => `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export const DEFAULT_RULES = {
  stopLoss: true,
  target: true,
  trailingStop: true,
  trailingStopPct: 8,
  structureBreak: true,
  volumeDryUp: true,
  volumeDryUpSessions: 3,
  thesisBreak: true,
  timeStop: true,
  timeStopSessions: 15,
  timeStopMinGainPct: 2,
};

const SEVERITY = {
  stop_loss: "high", structure_break: "high", target_reached: "high",
  trailing_stop: "medium", thesis_break: "medium",
  volume_dry_up: "low", time_stop: "low",
};
const ACTION = { high: "Consider exiting", medium: "Review", low: "Watch" };

const signal = (holding, rule, headline, reasoning, evidence) => ({
  id: `${holding.id}:${rule}`,
  holdingId: holding.id,
  symbol: holding.symbol,
  rule,
  fired: true,
  armed: true,
  headline,
  reasoning,
  // `fromEntryPct` mirrors `pctFromEntry` so either name reads correctly; the
  // dashboard contract and this module named the same number differently.
  evidence: { ...evidence, fromEntryPct: evidence?.pctFromEntry ?? null },
  severity: SEVERITY[rule] || "low",
  suggestedAction: ACTION[SEVERITY[rule] || "low"],
  action: ACTION[SEVERITY[rule] || "low"].toLowerCase(), // consider exiting | review | watch
  // Stated on every signal, because decision support that reads like an order
  // is not decision support.
  note: "Decision support, not an instruction — the call is yours.",
  at: Date.now(),
});

/**
 * Evaluate every rule for one open holding.
 * @param stock      current snapshot row (price, candles, high20/low20, intraday)
 * @param evaluation current evaluation under the holding's profile, for thesis break
 */
export function evaluateHolding(holding, stock, evaluation, cfg = {}) {
  const rules = { ...DEFAULT_RULES, ...cfg, ...(holding.rulesOverride || {}) };
  const disabled = new Set(holding.rulesDisabled || []);
  const out = [];
  if (!stock || !Number.isFinite(stock.price)) return out;

  const price = stock.price;
  const entry = holding.entryPrice;
  const fromEntry = round2(pct(entry, price));
  const daysHeld = Math.floor((Date.now() - Date.parse(holding.markedAt)) / 86_400_000);
  const base = { entryPrice: entry, currentPrice: price, pctFromEntry: fromEntry, daysHeld };

  // 1. Stop-loss
  if (rules.stopLoss && !disabled.has("stop_loss") && holding.stopLoss > 0 && price <= holding.stopLoss) {
    out.push(signal(holding, "stop_loss", "Stop-loss hit",
      `Price is ${rupee(price)}, at or below the stop you set at ${rupee(holding.stopLoss)}. You are ${fromEntry}% from your entry at ${rupee(entry)} — this is the level you chose in advance as the point the trade was wrong.`,
      { ...base, triggerLevel: holding.stopLoss }));
  }

  // 2. Target
  if (rules.target && !disabled.has("target_reached") && holding.target > 0 && price >= holding.target) {
    out.push(signal(holding, "target_reached", "Target reached",
      `Price is ${rupee(price)}, at or above the target you set at ${rupee(holding.target)} — a gain of ${fromEntry}% from ${rupee(entry)}. The objective you set has been met.`,
      { ...base, triggerLevel: holding.target }));
  }

  // 3. Trailing stop — measured from the peak since entry, not from entry.
  const peak = holding.peakPrice ?? entry;
  const fromPeak = round2(pct(peak, price));
  if (rules.trailingStop && !disabled.has("trailing_stop") && peak > entry && fromPeak <= -rules.trailingStopPct) {
    out.push(signal(holding, "trailing_stop", "Given back gains from the peak",
      `The stock reached ${rupee(peak)} after you marked it, and has since fallen ${Math.abs(fromPeak)}% to ${rupee(price)} — past the ${rules.trailingStopPct}% giveback threshold. You are still ${fromEntry}% from entry, but the move is deteriorating rather than pausing.`,
      { ...base, peakPrice: peak, pctFromPeak: fromPeak, triggerLevel: round2(peak * (1 - rules.trailingStopPct / 100)) }));
  }

  // 4. Structure break — the trend that justified entry has broken.
  const isIntraday = holding.profileId === "intraday";
  const structureLevel = isIntraday
    ? holding.entryContext?.dayLow
    : (stock.low20 ?? holding.entryContext?.low20);
  if (rules.structureBreak && !disabled.has("structure_break") && structureLevel > 0 && price < structureLevel) {
    const what = isIntraday ? "the entry-day low" : "the 20-day low";
    out.push(signal(holding, "structure_break", "Trend structure broke",
      `You marked this at ${rupee(entry)}${holding.entryContext?.high20 ? ` on a breakout above the 20-day high of ${rupee(holding.entryContext.high20)}` : ""}. Price has now fallen to ${rupee(price)}, below ${what} of ${rupee(structureLevel)} — the structure that justified the entry no longer holds.`,
      { ...base, triggerLevel: round2(structureLevel), structure: what }));
  }

  // 5. Volume dry-up — the participation that drove the move is gone.
  if (rules.volumeDryUp && !disabled.has("volume_dry_up") &&
      (holding.lowVolumeSessions || 0) >= rules.volumeDryUpSessions) {
    out.push(signal(holding, "volume_dry_up", "Participation has dried up",
      `Volume has run below half the 20-day average for ${holding.lowVolumeSessions} consecutive sessions. The buying pressure that drove this setup is no longer present, which usually precedes drift rather than continuation.`,
      { ...base, sessionsBelowHalf: holding.lowVolumeSessions, avgVol20: stock.avgVol20, volToday: stock.volToday }));
  }

  // 6. Thesis break — a criterion that was locked at entry no longer holds.
  if (rules.thesisBreak && !disabled.has("thesis_break") && evaluation) {
    const nowById = Object.fromEntries((evaluation.criteria || []).map(c => [c.id, c]));
    for (const wasLocked of holding.entryContext?.criteriaLocked || []) {
      const now = nowById[wasLocked.id];
      if (!now || now.pass) continue;
      const broken = (now.checksOut || []).filter(c => !c.ok);
      if (!broken.length) continue;
      const b = broken[0];
      const was = wasLocked.checks?.find(c => c.metric === b.metric);
      out.push(signal(holding, "thesis_break", `"${wasLocked.name}" no longer holds`,
        `When you marked this, ${wasLocked.name} was locked${was ? ` with ${b.metric} at ${was.value}` : ""}. It has now failed: ${b.metric} is ${b.v ?? "unavailable"} against a threshold of ${b.op === "gte" ? "≥" : "≤"} ${b.value}. The specific condition you bought on is no longer true.`,
        { ...base, criterion: wasLocked.name, criterionAtEntry: was ?? null,
          criterionNow: { metric: b.metric, value: round2(b.v), op: b.op, threshold: b.value } }));
      break; // one thesis-break signal per holding; the first broken leg is enough
    }
  }

  // 7. Time stop — capital doing nothing.
  const horizonSessions = HORIZON_SESSIONS[holding.profileId] ?? rules.timeStopSessions;
  const limit = horizonSessions ? Math.max(horizonSessions * 3, rules.timeStopSessions) : rules.timeStopSessions;
  if (rules.timeStop && !disabled.has("time_stop") && horizonSessions &&
      daysHeld >= limit && (fromEntry ?? 0) < rules.timeStopMinGainPct) {
    out.push(signal(holding, "time_stop", "Going nowhere",
      `Held ${daysHeld} days against a ${holding.profileId || "swing"} horizon of about ${horizonSessions} sessions, and it is ${fromEntry}% from entry — under the ${rules.timeStopMinGainPct}% that would count as progress. The thesis has not been proven wrong, but the capital is not working.`,
      { ...base, horizonSessions, limitDays: limit }));
  }

  return out;
}

/* Rules that have not fired but are close. "Trailing stop 1.2% away" is worth
   knowing before it triggers, and the distance is only computable here — the
   dashboard has no peak-since-entry or 20-day low to measure against. */
export function armedRules(holding, stock, cfg = {}) {
  const rules = { ...DEFAULT_RULES, ...cfg, ...(holding.rulesOverride || {}) };
  const disabled = new Set(holding.rulesDisabled || []);
  if (!stock || !Number.isFinite(stock.price)) return [];
  const price = stock.price;
  const out = [];
  const arm = (rule, level, label) => {
    if (!(level > 0) || disabled.has(rule)) return;
    const away = round2(((price - level) / price) * 100);
    // Only interesting once it is genuinely near; further out is noise.
    if (away > 0 && away <= 5) out.push({ rule, label, triggerLevel: round2(level), distanceToTriggerPct: away, armed: true });
  };
  if (rules.stopLoss) arm("stop_loss", holding.stopLoss, "Stop-loss");
  if (rules.trailingStop && (holding.peakPrice ?? 0) > holding.entryPrice)
    arm("trailing_stop", holding.peakPrice * (1 - rules.trailingStopPct / 100), "Trailing stop");
  if (rules.structureBreak)
    arm("structure_break", holding.profileId === "intraday" ? holding.entryContext?.dayLow : (stock.low20 ?? holding.entryContext?.low20), "Structure break");
  return out;
}

export function evaluateAll(holdingList, bySymbol, evaluationFor, cfg) {
  const out = [];
  for (const h of holdingList) {
    if (h.status !== "open") continue;
    const fired = evaluateHolding(h, bySymbol[h.symbol], evaluationFor?.(h), cfg);
    out.push(...fired);
    // Armed-but-unfired rules, minus any that already fired.
    const firedRules = new Set(fired.map(f => f.rule));
    for (const a of armedRules(h, bySymbol[h.symbol], cfg)) {
      if (firedRules.has(a.rule)) continue;
      out.push({
        id: `${h.id}:${a.rule}:armed`, holdingId: h.id, symbol: h.symbol,
        rule: a.rule, armed: true, fired: false,
        headline: `${a.label} ${a.distanceToTriggerPct}% away`,
        reasoning: `${a.label} sits at ${rupee(a.triggerLevel)}, ${a.distanceToTriggerPct}% below the current ${rupee(bySymbol[h.symbol].price)}. Nothing has broken yet — this is how much room is left before it does.`,
        evidence: { currentPrice: bySymbol[h.symbol].price, triggerLevel: a.triggerLevel, distanceToTriggerPct: a.distanceToTriggerPct },
        severity: "low", suggestedAction: "Watch", action: "watch",
        distanceToTriggerPct: a.distanceToTriggerPct,
        note: "Decision support, not an instruction — the call is yours.",
        at: Date.now(),
      });
    }
  }
  // Highest severity first: these concern money already at risk. Fired before
  // armed at equal severity — something that has happened outranks something
  // that might.
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || (a.fired === false) - (b.fired === false));
}
