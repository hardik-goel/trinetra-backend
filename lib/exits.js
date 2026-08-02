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
  headline,
  reasoning,
  evidence,
  severity: SEVERITY[rule] || "low",
  suggestedAction: ACTION[SEVERITY[rule] || "low"],
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

export function evaluateAll(holdingList, bySymbol, evaluationFor, cfg) {
  const out = [];
  for (const h of holdingList) {
    if (h.status !== "open") continue;
    out.push(...evaluateHolding(h, bySymbol[h.symbol], evaluationFor?.(h), cfg));
  }
  // Highest severity first: these concern money already at risk.
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
