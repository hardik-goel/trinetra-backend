/* Position sizing and concentration.

   Sizing answers "how many shares", derived from the risk you are willing to
   lose rather than from the capital you happen to have — the distinction that
   separates a stop from a hope.

   Concentration answers the question nobody asks until it hurts: whether six
   open positions are really one bet wearing six names. */

const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

export const DEFAULT_SIZING = {
  capital: 0,
  riskPerTradePct: 1,
  defaultStopPct: 5,        // used when no stop is supplied — and said so, loudly
  sectorLimitPct: 35,
};

export function suggest({ entry, stop, capital, riskPerTradePct, defaultStopPct }) {
  if (!(capital > 0)) {
    return { error: "capital is not set — POST /sizing/config { capital } first" };
  }
  if (!(entry > 0)) return { error: "entry price required" };

  const assumedStop = !(stop > 0);
  const stopPrice = assumedStop ? round2(entry * (1 - defaultStopPct / 100)) : +stop;
  const perShareRisk = entry - stopPrice;
  if (!(perShareRisk > 0)) return { error: "stop must be below entry for a long position" };

  const rupeeRisk = capital * (riskPerTradePct / 100);
  const qty = Math.floor(rupeeRisk / perShareRisk);
  const positionValue = qty * entry;

  return {
    qty,
    entry: round2(entry),
    stop: stopPrice,
    stopAssumed: assumedStop,
    perShareRisk: round2(perShareRisk),
    rupeeRisk: round2(qty * perShareRisk),
    riskBudget: round2(rupeeRisk),
    positionValue: round2(positionValue),
    positionPctOfCapital: round2((positionValue / capital) * 100),
    notes: [
      assumedStop
        ? `No stop given, so a ${defaultStopPct}% stop at ₹${stopPrice} was assumed. Size it against your real stop — this number is only as good as that level.`
        : null,
      qty === 0 ? "Risk budget is smaller than the risk on a single share — this position cannot be sized at this stop." : null,
      positionValue > capital ? "Position value exceeds total capital: this needs leverage, which changes the risk entirely." : null,
    ].filter(Boolean),
  };
}

export function concentration(openHoldings, bySymbol, { capital, sectorLimitPct }) {
  const positions = openHoldings.map(h => {
    const s = bySymbol[h.symbol];
    const price = s?.price ?? h.entryPrice;
    const value = h.qty ? h.qty * price : null;
    return {
      symbol: h.symbol,
      sector: s?.sector?.trim() || "Unclassified",
      value,
      pctOfCapital: value && capital > 0 ? round2((value / capital) * 100) : null,
    };
  });

  const sized = positions.filter(p => p.value != null);
  const unsized = positions.length - sized.length;

  const bySector = {};
  for (const p of positions) {
    (bySector[p.sector] ||= { symbols: [], value: 0 }).symbols.push(p.symbol);
    bySector[p.sector].value += p.value || 0;
  }
  const sectors = Object.entries(bySector).map(([sector, v]) => ({
    sector,
    symbols: v.symbols,
    count: v.symbols.length,
    value: round2(v.value),
    pctOfCapital: capital > 0 ? round2((v.value / capital) * 100) : null,
  })).sort((a, b) => (b.value || 0) - (a.value || 0));

  const warnings = [];
  for (const s of sectors) {
    if (s.pctOfCapital != null && s.pctOfCapital > sectorLimitPct)
      warnings.push(`${s.sector} is ${s.pctOfCapital}% of capital, above the ${sectorLimitPct}% limit — ${s.symbols.join(", ")}.`);
    // The "six positions, one bet" problem: correlation does not need capital
    // to be concentrated, only names to be.
    else if (s.count >= 3 && s.sector !== "Unclassified")
      warnings.push(`${s.count} open positions are all in ${s.sector} (${s.symbols.join(", ")}) — they will likely move together.`);
  }
  const largest = sized.sort((a, b) => b.value - a.value)[0] || null;
  if (largest?.pctOfCapital > 25)
    warnings.push(`${largest.symbol} alone is ${largest.pctOfCapital}% of capital.`);

  const unclassified = sectors.find(s => s.sector === "Unclassified");
  return {
    capital,
    positions: positions.length,
    sectors,
    largestPosition: largest,
    warnings,
    caveats: [
      unsized ? `${unsized} holding${unsized === 1 ? " has" : "s have"} no quantity recorded, so ${unsized === 1 ? "it is" : "they are"} excluded from the value figures.` : null,
      unclassified ? `${unclassified.count} position${unclassified.count === 1 ? " has" : "s have"} no sector from the feed and ${unclassified.count === 1 ? "is" : "are"} grouped as Unclassified — sector exposure is understated by that much.` : null,
      capital > 0 ? null : "Capital is not set, so percentages cannot be computed.",
    ].filter(Boolean),
  };
}
