/* Holdings — the minimum needed to reason about exits.

   One tap: POST { symbol } and everything else defaults. The user does not
   paper-trade and will not fill in a form, so a holding that demands entry
   price, quantity and a stop would simply never be created, and the exit
   signals that depend on it would never fire.

   What IS captured automatically is the state of the criteria at entry, because
   "the reason you bought no longer holds" cannot be detected later without a
   record of what that reason was. */

import { load, save, newId } from "./store.js";

const FILE = "holdings.json";
let holdings = load(FILE, []);
const persist = () => save(FILE, holdings);

const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);

export const all = () => holdings;
export const open = () => holdings.filter(h => h.status === "open");
export const find = id => holdings.find(h => h.id === id);

/**
 * Mark a holding. `stock` and `evaluation` are optional but strongly preferred:
 * they capture the entry price and the thesis, which is what makes a later
 * "your reason broke" statement evidence rather than assertion.
 */
export function add(input, stock, evaluation) {
  const symbol = String(input?.symbol ?? "").trim().toUpperCase();
  if (!symbol) return null;
  const entryPrice = Number.isFinite(+input.entryPrice) ? +input.entryPrice : stock?.price;
  if (!(entryPrice > 0)) return null;

  const h = {
    id: newId("hld"),
    symbol,
    markedAt: input.markedAt || new Date().toISOString(),
    entryPrice,
    qty: input.qty != null ? +input.qty : null,
    stopLoss: input.stopLoss != null ? +input.stopLoss : null,
    target: input.target != null ? +input.target : null,
    profileId: input.profileId || null,
    /* When the stock was actually bought, as opposed to when it was marked here.
       The STCG flag is the only number in this feature that can change a real
       financial decision, and markedAt is wrong in the expensive direction: a
       stock marked last week but held two years would read "0 months — realises
       STCG" and argue against a sale that is tax-favourable. */
    purchaseDate: input.purchaseDate || null,
    cycle: null,
    paperTradeId: input.paperTradeId || null,
    note: input.note || "",
    status: "open",
    closedAt: null, exitPrice: null, exitReason: null,
    // The thesis, frozen. Without this, rule 6 has nothing to compare against.
    entryContext: {
      high20: stock?.high20 ?? null,
      low20: stock?.low20 ?? null,
      dayLow: stock?.dayLow ?? null,
      avgVol20: stock?.avgVol20 ?? null,
      criteriaLocked: (evaluation?.criteria || [])
        .filter(c => c.pass)
        .map(c => ({
          id: c.id, key: c.key, name: c.name,
          checks: (c.checksOut || []).map(x => ({ metric: x.metric, op: x.op, threshold: x.value, value: round2(x.v) })),
        })),
    },
    // Highest close seen since entry, for the trailing stop.
    peakPrice: entryPrice,
    lowVolumeSessions: 0,
    rulesDisabled: Array.isArray(input.rulesDisabled) ? input.rulesDisabled : [],
  };
  holdings = [h, ...holdings];
  persist();
  return h;
}

export function update(id, patch = {}) {
  const h = find(id);
  if (!h) return null;
  for (const k of ["note", "profileId", "paperTradeId", "cycle", "purchaseDate"])
    if (patch[k] !== undefined) h[k] = patch[k];
  for (const k of ["qty", "stopLoss", "target", "entryPrice"])
    if (patch[k] !== undefined) h[k] = patch[k] == null ? null : +patch[k];
  if (Array.isArray(patch.rulesDisabled)) h.rulesDisabled = patch.rulesDisabled;
  if (patch.status === "closed" || patch.exitPrice != null) {
    const exitPrice = +patch.exitPrice;
    h.status = "closed";
    h.exitPrice = exitPrice > 0 ? exitPrice : h.mtm?.price ?? h.entryPrice;
    h.closedAt = patch.closedAt || new Date().toISOString();
    h.exitReason = patch.exitReason || "manual";
    h.realisedPct = round2(pct(h.entryPrice, h.exitPrice));
    h.realisedPnl = h.qty ? round2((h.exitPrice - h.entryPrice) * h.qty) : null;
  }
  persist();
  return h;
}

export function remove(id) {
  const before = holdings.length;
  holdings = holdings.filter(h => h.id !== id);
  if (holdings.length !== before) { persist(); return true; }
  return false;
}

/** Mark open holdings, and track the two path facts the exit rules need:
    the peak since entry, and how long volume has been absent. */
export function markToMarket(bySymbol) {
  let dirty = false;
  for (const h of holdings) {
    if (h.status !== "open") continue;
    const s = bySymbol[h.symbol];
    if (!s || !Number.isFinite(s.price)) continue;

    h.mtm = {
      price: s.price,
      unrealisedPct: round2(pct(h.entryPrice, s.price)),
      unrealisedPnl: h.qty ? round2((s.price - h.entryPrice) * h.qty) : null,
      daysHeld: Math.floor((Date.now() - Date.parse(h.markedAt)) / 86_400_000),
    };
    if (s.price > (h.peakPrice ?? 0)) { h.peakPrice = s.price; dirty = true; }

    // Sessions where participation was under half the 20-day average. Counted
    // once per session, not once per refresh, or a quiet hour would trip it.
    const today = new Date().toDateString();
    if (s.avgVol20 > 0 && Number.isFinite(s.volToday) && h.lastVolCheckDay !== today) {
      h.lastVolCheckDay = today;
      h.lowVolumeSessions = s.volToday < s.avgVol20 * 0.5 ? (h.lowVolumeSessions || 0) + 1 : 0;
      dirty = true;
    }
  }
  if (dirty) persist();
  return holdings;
}

/** Re-read from disk after a restore, so the process serves the restored
    records rather than the ones it was holding in memory. */
export function reload() {
  holdings = load(FILE, []);
}
