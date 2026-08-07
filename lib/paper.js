/* Paper trades — the user's own bets, and whether taking them beat taking
   every signal blindly.

   That comparison is the point of the module. A screener that fires 40 signals
   and lets you pick 6 is only worth its subscription if either the signals or
   the picking adds value, and the only way to know which is to measure both.
   Nothing here rounds in the app's favour: an unprofitable record must read as
   unprofitable. */

import { load, save, newId } from "./store.js";

const FILE = "paper_trades.json";
const DAY_MS = 86_400_000;

let trades = load(FILE, []);
const persist = () => save(FILE, trades);

const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const pct = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);

export const all = () => trades;
export const find = id => trades.find(t => t.id === id);

export function open(input) {
  const entryPrice = +input.entryPrice;
  const qty = +input.qty;
  if (!input.symbol || !(entryPrice > 0) || !(qty > 0)) return null;
  /* `side` was hardcoded to "buy", so taking a SELL signal recorded a long: the
     P&L then ran the wrong way and a correct short read as a loss. Direction is
     the trade, not a label on it — it comes from the caller and every downstream
     calculation mirrors on it. */
  const side = input.side === "sell" ? "sell" : "buy";
  const t = {
    id: newId("trd"),
    symbol: String(input.symbol).trim().toUpperCase(),
    signalId: input.signalId || null,
    side,
    entryDate: input.entryDate || new Date().toISOString(),
    entryPrice, qty,
    stopLoss: input.stopLoss != null ? +input.stopLoss : null,
    target: input.target != null ? +input.target : null,
    notes: input.notes || "",
    status: "open",
    exitDate: null, exitPrice: null, exitReason: null,
  };
  trades = [t, ...trades];
  persist();
  return t;
}

/** Update or close. Closing computes the realised P&L once and stores it. */
export function update(id, patch = {}) {
  const t = find(id);
  if (!t) return null;
  for (const k of ["stopLoss", "target", "notes", "qty", "entryPrice", "entryDate", "signalId"]) {
    if (patch[k] !== undefined) t[k] = ["notes", "entryDate", "signalId"].includes(k) ? patch[k] : +patch[k];
  }
  if (patch.status === "closed" || patch.exitPrice != null) {
    const exitPrice = +patch.exitPrice;
    if (!(exitPrice > 0)) return t; // a close without a price is not a close
    t.status = "closed";
    t.exitPrice = exitPrice;
    t.exitDate = patch.exitDate || new Date().toISOString();
    t.exitReason = patch.exitReason || "manual";
    // A short profits when the exit is BELOW the entry. Same arithmetic, mirrored.
    const dir = t.side === "sell" ? -1 : 1;
    t.realisedPnl = round2((exitPrice - t.entryPrice) * t.qty * dir);
    t.realisedPct = round2(pct(t.entryPrice, exitPrice) * dir);
    t.mtm = null;
  }
  persist();
  return t;
}

export function remove(id) {
  const before = trades.length;
  trades = trades.filter(t => t.id !== id);
  if (trades.length !== before) { persist(); return true; }
  return false;
}

/** Mark open trades against the latest prices. Not persisted every tick — this
    is derived from a price that changes by the minute, and rewriting the file
    once a minute would burn the disk for nothing. */
export function markToMarket(priceBySymbol) {
  for (const t of trades) {
    if (t.status !== "open") continue;
    const p = priceBySymbol[t.symbol];
    if (!Number.isFinite(p)) continue;
    /* Mirrored for a short, including the level tests: a short's stop is ABOVE
       the entry and its target BELOW. Left unmirrored, every open short would
       report its stop as hit the moment it started working. */
    const dir = t.side === "sell" ? -1 : 1;
    t.mtm = {
      price: p,
      unrealisedPnl: round2((p - t.entryPrice) * t.qty * dir),
      unrealisedPct: round2(pct(t.entryPrice, p) * dir),
      stopHit: t.stopLoss != null && (dir === 1 ? p <= t.stopLoss : p >= t.stopLoss),
      targetHit: t.target != null && (dir === 1 ? p >= t.target : p <= t.target),
    };
  }
  return trades;
}

/**
 * @param days   window
 * @param signals signal history records, for the "took every signal" baseline
 * @param horizon which signal horizon the baseline exits at
 */
/* Loads one trade into the module so update()/markToMarket() can act on it.
   Used by the multi-user path: a trade owned by a user lives in Postgres, but
   closing it must run through the same P&L code every other trade uses —
   including the short mirror. A second implementation of realised P&L is how two
   users end up scored by different rules. */
export function restore(trade) {
  trades = [trade, ...trades.filter(t => t.id !== trade.id)];
  return trade;
}

export function stats(days = 30, signals = [], horizon = 7) {
  return statsOf(trades, days, signals, horizon);
}

/** Same aggregation over an explicit set, so per-user rows reuse it exactly. */
export function statsOf(all, days = 30, signals = [], horizon = 7) {
  const since = Date.now() - days * DAY_MS;
  const inWindow = all.filter(t => Date.parse(t.entryDate) >= since);
  const closed = inWindow.filter(t => t.status === "closed");
  const openTrades = inWindow.filter(t => t.status === "open");

  const wins = closed.filter(t => t.realisedPnl > 0);
  const losses = closed.filter(t => t.realisedPnl <= 0);
  const sum = xs => xs.reduce((a, b) => a + b, 0);
  const avg = xs => (xs.length ? sum(xs) / xs.length : 0);

  const avgWin = round2(avg(wins.map(t => t.realisedPnl)));
  const avgLoss = round2(Math.abs(avg(losses.map(t => t.realisedPnl))));
  const winRate = closed.length ? wins.length / closed.length : null;
  const grossProfit = sum(wins.map(t => t.realisedPnl));
  const grossLoss = Math.abs(sum(losses.map(t => t.realisedPnl)));

  // What the raw system would have returned if every signal were taken at the
  // same average size and exited at a fixed horizon. Percentages are the honest
  // comparison; the rupee figure only exists to make it legible, and says so.
  const sigInWindow = signals.filter(s => s.firedAt >= since);
  const sigRets = sigInWindow.map(s => s.outcome?.[`ret${horizon}d`]).filter(Number.isFinite);
  const avgNotional = closed.length
    ? avg(closed.map(t => t.entryPrice * t.qty))
    : avg(inWindow.map(t => t.entryPrice * t.qty));

  const yourAvgPct = closed.length ? round2(avg(closed.map(t => t.realisedPct))) : null;
  const systemAvgPct = sigRets.length ? round2(avg(sigRets)) : null;

  return {
    days,
    trades: { total: inWindow.length, closed: closed.length, open: openTrades.length },
    winRate: winRate == null ? null : round2(winRate * 100),
    avgWin, avgLoss,
    // Expectancy per trade in rupees: what one more trade is worth on this record.
    expectancy: closed.length ? round2(winRate * avgWin - (1 - winRate) * avgLoss) : null,
    // Infinity does not survive JSON, and a null here would read as "no data"
    // rather than "nothing has lost yet" — which is a very different claim on a
    // record this short. So the reason is stated alongside.
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : null,
    profitFactorNote: grossLoss > 0 ? null
      : closed.length ? "no losing trades yet — undefined, not infinite"
      : "no closed trades yet",
    realisedPnl: round2(sum(closed.map(t => t.realisedPnl))),
    unrealisedPnl: round2(sum(openTrades.map(t => t.mtm?.unrealisedPnl || 0))),
    largestWin: wins.length ? round2(Math.max(...wins.map(t => t.realisedPnl))) : null,
    largestLoss: losses.length ? round2(Math.min(...losses.map(t => t.realisedPnl))) : null,
    selection: {
      horizon,
      yourTrades: { n: closed.length, avgReturnPct: yourAvgPct },
      everySignal: {
        n: sigRets.length,
        pending: sigInWindow.length - sigRets.length,
        avgReturnPct: systemAvgPct,
        pnlAtYourAvgSize: sigRets.length && avgNotional
          ? round2(sum(sigRets.map(r => (r / 100) * avgNotional)))
          : null,
      },
      // Positive: your picking beat the raw system. Negative: the system was
      // better than your selection of it, and the honest read is to take more
      // of its signals, not fewer.
      edgePct: yourAvgPct != null && systemAvgPct != null ? round2(yourAvgPct - systemAvgPct) : null,
    },
    assumptions: [
      "Paper trades only — entry and exit prices are the ones you logged, not fills.",
      "No brokerage, STT, slippage or impact cost anywhere in these figures.",
      `The "every signal" baseline exits at a fixed ${horizon}-day horizon and sizes every signal at your average trade notional.`,
      "Signals still inside that horizon are pending, not zero, so the baseline moves as they mature.",
      "Open trades are marked at the latest delayed price and excluded from realised figures.",
    ],
  };
}

/** Re-read from disk after a restore, so the process serves the restored
    records rather than the ones it was holding in memory. */
export function reload() {
  trades = load(FILE, []);
}
