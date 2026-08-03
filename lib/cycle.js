/* Trading around a core holding: sell a portion near a local top, buy it back
   lower, core untouched. Never a short — a SELL here only ever applies to stock
   the user already owns.

   The load-bearing number in this file is `cycleVsHold`. Trimming a position and
   buying it back frequently underperforms simply holding it, and a feature that
   reports the rupees made from trading without the comparison to doing nothing
   is a device for feeling good about activity. So the comparison is computed
   alongside, always, and is null only when it genuinely cannot be known — never
   omitted because it is unflattering. */

const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);
const MONTH_MS = 30.44 * 86_400_000;

export const emptyCycle = () => ({
  status: "full",
  coreQty: null, soldQty: 0,
  sellPrice: null, soldAt: null,
  boughtBackQty: 0, buyBackPrice: null, boughtBackAt: null,
  roundTrips: 0,
  history: [],
});

/**
 * Record a partial sale. Quantity is optional because the user will not fill a
 * form — without it the cycle still works, in percentage terms only.
 */
export function recordSale(holding, { qty, price } = {}, currentPrice) {
  const c = { ...(holding.cycle || emptyCycle()) };
  const p = Number.isFinite(+price) && +price > 0 ? +price : currentPrice;
  if (!(p > 0)) return null;
  c.status = "partly sold";
  c.sellPrice = round2(p);
  c.soldAt = new Date().toISOString();
  c.soldQty = Number.isFinite(+qty) && +qty > 0 ? +qty : (c.soldQty || null);
  c.coreQty = c.coreQty ?? (Number.isFinite(+holding.qty) ? +holding.qty : null);
  c.boughtBackQty = 0; c.buyBackPrice = null; c.boughtBackAt = null;
  return c;
}

/** Record the buy-back, closing one round trip and scoring it. */
export function recordBuyBack(holding, { qty, price } = {}, currentPrice) {
  const c = { ...(holding.cycle || emptyCycle()) };
  if (!c.sellPrice) return null; // nothing was sold; there is nothing to buy back
  const p = Number.isFinite(+price) && +price > 0 ? +price : currentPrice;
  if (!(p > 0)) return null;

  c.buyBackPrice = round2(p);
  c.boughtBackAt = new Date().toISOString();
  c.boughtBackQty = Number.isFinite(+qty) && +qty > 0 ? +qty : (c.soldQty || null);
  c.status = "restored";
  c.roundTrips = (c.roundTrips || 0) + 1;

  const gainPct = round2(pct(c.buyBackPrice, c.sellPrice)); // sold high, bought lower
  c.history = [...(c.history || []), {
    sellPrice: c.sellPrice, soldAt: c.soldAt,
    buyBackPrice: c.buyBackPrice, boughtBackAt: c.boughtBackAt,
    qty: c.boughtBackQty, gainPct,
  }];
  return c;
}

/**
 * Everything derived: what the trimming realised, and what simply holding would
 * have done instead.
 *
 * The counterfactual is deliberately simple and stated as such — it compares the
 * round trip against holding the same shares through it. It does not model
 * brokerage, STT or the tax the sale actually triggers, all of which make the
 * trading side worse, so the real comparison is less favourable than this one.
 */
export function derive(holding, currentPrice) {
  const c = holding.cycle;
  if (!c) return null;
  const qty = c.soldQty ?? c.coreQty ?? null;
  const qtyKnown = Number.isFinite(qty) && qty > 0;

  let realisedFromCycle = null, cycleVsHold = null, realisedPctFromCycle = null;
  const closed = (c.history || []).filter(h => h.buyBackPrice > 0);
  if (closed.length) {
    // Per round trip: sold at X, bought back at Y. The trade made (X - Y) a share.
    realisedPctFromCycle = round2(closed.reduce((a, h) => a + (h.gainPct || 0), 0));
    if (qtyKnown) {
      realisedFromCycle = round2(closed.reduce((a, h) => a + (h.sellPrice - h.buyBackPrice) * (h.qty || qty), 0));
      /* Against doing nothing: holding those shares from the sale price to now.
         If price ran away after the sale, holding wins and this goes negative —
         which is exactly the case the user needs to see. */
      const hold = closed.reduce((a, h) => a + (currentPrice - h.sellPrice) * (h.qty || qty), 0);
      cycleVsHold = round2(realisedFromCycle - Math.max(0, hold) - Math.min(0, 0) - hold * 0);
      cycleVsHold = round2(realisedFromCycle - hold);
    }
  }

  const belowSalePct = c.sellPrice ? round2(pct(c.sellPrice, currentPrice)) : null;

  return {
    ...c,
    belowSalePct,
    realisedFromCycle, realisedPctFromCycle, cycleVsHold,
    qtyKnown,
    notComparableReason: closed.length === 0
      ? "no completed round trip yet"
      : qtyKnown ? null
      : "quantity not recorded, so only the percentage is known",
    counterfactualNote: "Compares the round trip against holding the same shares through it. Brokerage, STT and the tax the sale triggers are excluded, all of which make the trading side worse than shown.",
  };
}

/**
 * How long this has been held, and whether selling realises short-term gains.
 *
 * `markedAt` is when the user tapped "I'm holding this", which may be well after
 * he actually bought — so the basis is reported and a caveat travels with it. A
 * confident "held 4 months" that is really 4 months since tracking began could
 * push someone into realising STCG on a position that was already long-term.
 */
export function holdingPeriod(holding, now = Date.now()) {
  const explicit = holding.purchaseDate ? Date.parse(holding.purchaseDate) : null;
  const from = Number.isFinite(explicit) ? explicit : Date.parse(holding.markedAt);
  if (!Number.isFinite(from)) return null;
  const months = Math.floor((now - from) / MONTH_MS);
  const measuredFrom = Number.isFinite(explicit) ? "purchaseDate" : "markedAt";
  return {
    months,
    underTwelveMonths: months < 12,
    stcg: months < 12,
    measuredFrom,
    caveat: measuredFrom === "markedAt"
      ? "Measured from when this was marked in Trinetra, which may be later than the actual purchase — set a purchase date to make this exact."
      : null,
    note: "Indian capital-gains treatment changes; confirm current rules before acting on the timing.",
  };
}

export const REENTRY_RISK = "If it keeps running, buying back may be higher than where you sold.";
