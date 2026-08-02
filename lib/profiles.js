/* Criteria profiles — one set per horizon, evaluated independently.

   A single criteria set forces one answer to four different questions. A
   long-term buyer does not need a 2% day move; an intraday trade does not care
   about three-year profit growth. Each profile therefore carries its own
   criteria, and a stock is judged against every enabled one separately.

   Signals record which profile fired them, so the track record can measure each
   horizon on its own. Blending an intraday win rate into a long-term one would
   describe nothing that exists. */

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
    // The original default set — migrated here so existing behaviour survives.
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

export const cleanId = raw =>
  String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);

/** Existing config carried one flat `criteria` array. It becomes the Swing
    profile, so a user's tuned thresholds and synced settings survive. */
export function migrate(config) {
  if (config?.profiles && Object.keys(config.profiles).length) return config.profiles;
  const seeded = structuredClone(DEFAULT_PROFILES);
  if (Array.isArray(config?.criteria) && config.criteria.length) {
    seeded.swing.criteria = config.criteria;
    seeded.swing.alerts = { telegram: !!config?.alerts?.telegram?.on };
  }
  return seeded;
}

export const enabledProfiles = profiles =>
  Object.entries(profiles).filter(([, p]) => p.enabled !== false);

/** Any enabled intraday profile means the provider must fetch intraday bars. */
export const needsIntraday = profiles =>
  enabledProfiles(profiles).some(([, p]) => p.horizon === "intraday");
