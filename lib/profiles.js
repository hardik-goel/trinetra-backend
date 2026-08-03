/* Criteria profiles — one set per horizon, evaluated independently.

   A single criteria set forces one answer to four different questions. A
   long-term buyer does not need a 2% day move; an intraday trade does not care
   about three-year profit growth. Each profile therefore carries its own
   criteria, and a stock is judged against every enabled one separately.

   Signals record which profile fired them, so the track record can measure each
   horizon on its own. Blending an intraday win rate into a long-term one would
   describe nothing that exists. */

/* The three criteria the instrument exists for. One definition, used whenever
   no valid user config exists and restorable on demand. Order Flow and the AI
   Forecast are deliberately absent: both depend on data this deployment does not
   have, and shipping them enabled is how the eye stops opening. */
export const CANONICAL_CRITERIA = [
  { id: "fund", key: "F", name: "Fundamentals", enabled: true, builtin: true,
    checks: [
      { metric: "roe", op: "gte", value: 15 },
      { metric: "de", op: "lte", value: 0.7 },
      { metric: "profitGrowth", op: "gte", value: 12 },
      { metric: "promoter", op: "gte", value: 40 },
    ] },
  { id: "brk", key: "B", name: "Breakout", enabled: true, builtin: true,
    checks: [
      { metric: "aboveHigh20", op: "gte", value: 1 },
      { metric: "dayChgPct", op: "gte", value: 2 },
      { metric: "pctOf52wHigh", op: "gte", value: 95 },
    ] },
  { id: "vol", key: "V", name: "Volume shocker", enabled: true, builtin: true,
    checks: [{ metric: "volMultiple", op: "gte", value: 3 }] },
];

/** Does this criteria set match the canonical three? Compared on the shape that
    matters — which criteria are enabled and on what thresholds — not on order or
    cosmetic fields. */
export function matchesCanonical(criteria) {
  const norm = list => (list || []).filter(c => c.enabled)
    .map(c => `${c.id}:${(c.checks || []).map(k => `${k.metric}${k.op}${k.value}`).sort().join(",")}`)
    .sort().join("|");
  return norm(criteria) === norm(CANONICAL_CRITERIA);
}

/* Criteria whose data source is not present on this deployment. They may exist,
   they may be edited, but a migration or sync must never turn them on. */
export const DATALESS_CRITERIA = new Set(["flow", "kron"]);

export const HORIZONS = ["intraday", "swing", "positional", "longterm"];

/* Sessions each horizon is measured over — used by potential estimates, time
   stops and outcome tracking. Long term is deliberately absent: a percentage
   target over years is not a number anyone should act on. */
export const HORIZON_SESSIONS = { intraday: 1, swing: 5, positional: 20, longterm: null };

export const DEFAULT_PROFILES = {
  intraday: {
    name: "Intraday",
    horizon: "intraday",
    enabled: true,
    // Runs on the delayed feed by choice. Order-flow reads NO DATA until Kite.
    requiresLiveData: false,
    alerts: { telegram: true },
    criteria: [
      { id: "orb", key: "O", name: "Opening range", enabled: true,
        checks: [{ metric: "orBreakout", op: "gte", value: 1 }] },
      { id: "vwap", key: "W", name: "Above VWAP", enabled: true,
        checks: [{ metric: "vsVwapPct", op: "gte", value: 0 }] },
      { id: "ivol", key: "V", name: "Volume surge (vs same time)", enabled: true,
        checks: [{ metric: "volVsTOD", op: "gte", value: 1.8 }] },
      { id: "range", key: "R", name: "Upper day range", enabled: true,
        checks: [{ metric: "dayRangePos", op: "gte", value: 70 }] },
      { id: "flow", key: "F", name: "Order flow", enabled: false, depthNote: true,
        checks: [{ metric: "buyerPct", op: "gte", value: 60 }] },
    ],
  },

  swing: {
    name: "Swing",
    horizon: "swing",
    enabled: true,
    requiresLiveData: false,
    alerts: { telegram: true },
    // The canonical three. This profile IS the instrument's original purpose.
    criteria: [
      { id: "fund", key: "F", name: "Fundamentals", enabled: true, builtin: true,
        checks: [
          { metric: "roe", op: "gte", value: 15 },
          { metric: "de", op: "lte", value: 0.7 },
          { metric: "profitGrowth", op: "gte", value: 12 },
          { metric: "promoter", op: "gte", value: 40 },
        ] },
      { id: "brk", key: "B", name: "Breakout", enabled: true, builtin: true,
        checks: [
          { metric: "aboveHigh20", op: "gte", value: 1 },
          { metric: "dayChgPct", op: "gte", value: 2 },
          { metric: "pctOf52wHigh", op: "gte", value: 95 },
        ] },
      { id: "vol", key: "V", name: "Volume shocker", enabled: true, builtin: true,
        checks: [{ metric: "volMultiple", op: "gte", value: 3 }] },
    ],
  },

  positional: {
    name: "Positional",
    horizon: "positional",
    enabled: true,
    requiresLiveData: false,
    alerts: { telegram: true },
    // Longer base, so: a 50-day breakout, participation that has held for days
    // rather than one hot session, and a firmer fundamental floor.
    criteria: [
      { id: "fund", key: "F", name: "Fundamentals", enabled: true,
        checks: [
          { metric: "roe", op: "gte", value: 15 },
          { metric: "roce", op: "gte", value: 15 },
          { metric: "de", op: "lte", value: 0.6 },
          { metric: "profitGrowth", op: "gte", value: 15 },
        ] },
      { id: "brk50", key: "B", name: "50-day breakout", enabled: true,
        checks: [
          { metric: "aboveHigh50", op: "gte", value: 1 },
          { metric: "pctOf52wHigh", op: "gte", value: 90 },
        ] },
      { id: "vol", key: "V", name: "Sustained volume", enabled: true,
        checks: [{ metric: "volSustained", op: "gte", value: 1.5 }] },
    ],
  },

  longterm: {
    name: "Long term",
    horizon: "longterm",
    enabled: true,
    requiresLiveData: false,
    alerts: { telegram: false }, // a compounding thesis is not a 24/7 alert
    // Quality and durability. No day-move criterion: a long-term buyer does not
    // need the stock to be up 2% today to be worth owning.
    criteria: [
      { id: "quality", key: "Q", name: "Business quality", enabled: true,
        checks: [
          { metric: "roe", op: "gte", value: 18 },
          { metric: "roce", op: "gte", value: 18 },
          { metric: "opm", op: "gte", value: 12 },
        ] },
      { id: "balance", key: "D", name: "Balance sheet", enabled: true,
        checks: [
          { metric: "de", op: "lte", value: 0.5 },
          { metric: "pledged", op: "lte", value: 1 },
        ] },
      { id: "growth", key: "G", name: "Durable growth", enabled: true,
        checks: [
          { metric: "profitGrowth", op: "gte", value: 12 },
          { metric: "salesGrowth3y", op: "gte", value: 10 },
        ] },
      { id: "owner", key: "P", name: "Promoter commitment", enabled: true,
        checks: [{ metric: "promoter", op: "gte", value: 45 }] },
    ],
  },
};

/* Trading around a core holding. Both are evaluated ONLY for symbols in
   holdings — `appliesTo` is what stops a SELL ever being emitted for a stock the
   user does not own, which would be a short recommendation and is out of scope. */
export const HOLDING_PROFILES = {
  sell_holdings: {
    name: "Sell — holdings",
    horizon: "swing",
    appliesTo: "holdings",
    enabled: true,
    requiresLiveData: false,
    alerts: { telegram: true },
    criteria: [
      { id: "extended", key: "E", name: "Extended", enabled: true,
        checks: [{ metric: "extensionVs20dma", op: "gte", value: 8 }] },
      { id: "overbought", key: "R", name: "Overbought", enabled: true,
        checks: [{ metric: "rsi14", op: "gte", value: 70 }] },
      { id: "resistance", key: "L", name: "At resistance", enabled: true,
        checks: [{ metric: "atResistancePct", op: "lte", value: 1.5 }] },
      { id: "runout", key: "A", name: "Run vs history", enabled: true,
        checks: [{ metric: "gainVsAnalogMedian", op: "gte", value: 100 }] },
      { id: "climax", key: "C", name: "Volume climax", enabled: false,
        checks: [{ metric: "volumeClimax", op: "gte", value: 3 }] },
      { id: "ingain", key: "G", name: "In profit", enabled: true,
        checks: [{ metric: "gainVsHoldingEntry", op: "gte", value: 10 }] },
      // Corroboration, not a trigger — off by default, and its reading is shown
      // on the signal whether or not it is enabled.
      { id: "candle", key: "K", name: "Candles", enabled: false,
        checks: [{ metric: "bearishCandleAtResistance", op: "gte", value: 1 }] },
    ],
  },

  buyback_holdings: {
    name: "Buy back — holdings",
    horizon: "swing",
    appliesTo: "holdings",
    enabled: true,
    requiresLiveData: false,
    alerts: { telegram: true },
    criteria: [
      { id: "support", key: "S", name: "At support", enabled: true,
        checks: [{ metric: "pullbackToSupportPct", op: "lte", value: 1.5 }] },
      { id: "rsirec", key: "R", name: "RSI recovery", enabled: true,
        checks: [{ metric: "rsiRecovery", op: "lte", value: 55 }] },
      // Not a threshold anyone should tune away: below the long trend this is a
      // falling knife, and the buy-back is withheld rather than fired.
      { id: "trend", key: "T", name: "Trend intact", enabled: true,
        checks: [{ metric: "trendIntact", op: "gte", value: 1 }] },
      { id: "vol", key: "V", name: "Volume", enabled: true,
        checks: [{ metric: "volumeDryUpThenExpansion", op: "gte", value: 1 }] },
      { id: "vssale", key: "P", name: "Below your sale", enabled: false,
        checks: [{ metric: "retraceVsSalePrice", op: "lte", value: -2 }] },
      { id: "candle", key: "K", name: "Candles", enabled: false,
        checks: [{ metric: "bullishCandleAtSupport", op: "gte", value: 1 }] },
    ],
  },
};

export const cleanId = raw =>
  String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);

/** Existing config carried one flat `criteria` array. It becomes the Swing
    profile, so a user's tuned thresholds and synced settings survive. */
export function migrate(config) {
  if (config?.profiles && Object.keys(config.profiles).length) {
    // Additive: a config written before these existed still gets them.
    return { ...structuredClone(HOLDING_PROFILES), ...config.profiles };
  }
  const seeded = { ...structuredClone(DEFAULT_PROFILES), ...structuredClone(HOLDING_PROFILES) };
  if (Array.isArray(config?.criteria) && config.criteria.length) {
    /* Never let a migration switch on a criterion whose data source is absent.
       An inherited config with Order Flow or the Oracle enabled would otherwise
       arrive already broken, and the engine would have to rescue it every scan. */
    seeded.swing.criteria = config.criteria.map(c =>
      DATALESS_CRITERIA.has(c.id) ? { ...c, enabled: false } : c);
    seeded.swing.alerts = { telegram: !!config?.alerts?.telegram?.on };
  }
  return seeded;
}

export const enabledProfiles = profiles =>
  Object.entries(profiles).filter(([, p]) => p.enabled !== false);

/** Any enabled intraday profile means the provider must fetch intraday bars. */
export const needsIntraday = profiles =>
  enabledProfiles(profiles).some(([, p]) => p.horizon === "intraday");
