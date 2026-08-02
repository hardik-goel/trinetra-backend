/* Oracle client — asks the Trinetra Oracle (Kronos microservice) for
   forward return forecasts and merges them into market snapshots.
   Fully optional: no ORACLE_URL → the metric just reads "no data"
   and the AI Forecast criterion stays inert. Loose coupling, kept.

   The Oracle is a free-tier service that sleeps, cold-starts slowly, and
   depends on an upstream data source that can fail. So: never cache an empty
   answer, retry through a cold start, and never block a market refresh waiting
   for it. Forecasts land asynchronously and are merged into the live snapshot
   when they arrive. */

const ORACLE_URL = process.env.ORACLE_URL || "";
const HORIZON = +(process.env.ORACLE_HORIZON || 3);
const TIMEOUT_MS = +(process.env.ORACLE_TIMEOUT_MS || 120_000);
const ATTEMPTS = 3;
const BACKOFF_MS = [3_000, 15_000]; // between attempts — time for a cold start

let cache = { day: "", data: {} };
let inflight = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s ?? "").trim().toUpperCase();
const today = () => new Date().toDateString();

// A forecast without a usable return is not a forecast. Dropping it here keeps
// the "N forecasts received" log honest and stops an empty record from
// producing an fcst field that reads as data.
const usable = f => f && Number.isFinite(+f.ret);

/* The Oracle answers with a bare { SYMBOL: {...} } map. A wrapper shape is
   tolerated so an upstream change degrades to "no data" loudly rather than
   merging nothing silently. */
function unwrap(j) {
  if (!j || typeof j !== "object") return {};
  if (!Array.isArray(j) && j.forecasts && typeof j.forecasts === "object") return j.forecasts;
  return j;
}

// Symbols are uppercased on both sides so a merge can never miss on casing.
function normalise(raw) {
  const out = {};
  for (const [sym, f] of Object.entries(unwrap(raw))) if (usable(f)) out[norm(sym)] = f;
  return out;
}

/** The forecasts known right now. Synchronous — a refresh never waits. */
export function cachedForecasts() {
  return cache.day === today() ? cache.data : {};
}

/**
 * Fetch forecasts in the background, retrying through a cold start. Calls
 * onLoaded(data) only when a non-empty set arrives, so the caller can re-merge
 * into the snapshot it has already published. Never throws.
 *
 * An empty or failed response is deliberately NOT cached: a request that woke
 * a sleeping Oracle, or hit an upstream data outage, must be retried on the
 * next cycle rather than pinned as today's answer until the date rolls over.
 */
export async function ensureForecasts(symbols, onLoaded) {
  if (!ORACLE_URL || inflight) return;
  if (cache.day === today() && Object.keys(cache.data).length) return; // have today's
  if (!symbols?.length) return;

  inflight = true;
  const url = `${ORACLE_URL.replace(/\/$/, "")}/forecasts?symbols=${symbols.map(norm).join(",")}&horizon=${HORIZON}`;
  try {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = normalise(await r.json());
        const n = Object.keys(data).length;
        const engines = [...new Set(Object.values(data).map(f => f.engine))].filter(Boolean);
        console.log(`[oracle] GET ${url} → ${n} forecast(s)${engines.length ? " (" + engines.join(",") + ")" : ""}`);
        if (n) {
          cache = { day: today(), data };
          onLoaded?.(data);
          return;
        }
        console.warn(`[oracle] empty forecast set (attempt ${attempt}/${ATTEMPTS}) — not cached, will retry`);
      } catch (e) {
        console.warn(`[oracle] attempt ${attempt}/${ATTEMPTS} failed: ${e.message}`);
      }
      if (attempt < ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1));
    }
    console.warn(`[oracle] no forecasts after ${ATTEMPTS} attempts — stocks will carry no fcst`);
  } finally {
    inflight = false;
  }
}

/** Merge on an exact, normalised symbol match. Stocks without a forecast are
    returned untouched, so the criterion reads "no data" rather than failing. */
export function mergeForecasts(snapshots, forecasts) {
  const by = forecasts || {};
  return snapshots.map(s => {
    const f = by[norm(s.symbol)];
    return usable(f)
      ? { ...s, fcst: { ret: +f.ret, horizon: f.horizon ?? HORIZON, engine: f.engine, path: f.path } }
      : s;
  });
}
