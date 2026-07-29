/* Oracle client — asks the Trinetra Oracle (Kronos microservice) for
   forward return forecasts and merges them into market snapshots.
   Fully optional: no ORACLE_URL → the metric just reads "no data"
   and the AI Forecast criterion stays inert. Loose coupling, kept. */

const ORACLE_URL = process.env.ORACLE_URL || "";
const HORIZON = +(process.env.ORACLE_HORIZON || 3);

let cache = { day: "", data: {} };

export async function getForecasts(symbols) {
  if (!ORACLE_URL) return {};
  const today = new Date().toDateString();
  if (cache.day === today && Object.keys(cache.data).length) return cache.data;
  try {
    const url = `${ORACLE_URL.replace(/\/$/, "")}/forecasts?symbols=${symbols.join(",")}&horizon=${HORIZON}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    const j = await r.json();
    cache = { day: today, data: j };
    const engines = [...new Set(Object.values(j).map(f => f.engine))];
    console.log(`[oracle] ${Object.keys(j).length} forecasts (${engines.join(",") || "none"})`);
    return j;
  } catch (e) {
    console.warn("[oracle] unavailable:", e.message);
    return cache.data; // stale is better than nothing within the day
  }
}

export function mergeForecasts(snapshots, forecasts) {
  return snapshots.map(s => {
    const f = forecasts[s.symbol];
    return f ? { ...s, fcst: { ret: f.ret, horizon: f.horizon, engine: f.engine, path: f.path } } : s;
  });
}
