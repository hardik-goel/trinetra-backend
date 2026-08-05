/* Which NSE stocks can actually be shorted, and for how long.

   This file exists because a short signal that ignores it is unactionable advice.
   In the Indian cash market you cannot carry a short overnight: a short sold
   intraday must be bought back the same session or it goes to auction settlement,
   which is expensive and not optional. Only stocks in the F&O segment can be held
   short past the close, and only through futures or options, in fixed lot sizes.

   So "SHORT, 3–5 days" on a non-F&O stock is not a trade the user can place. The
   engine must know the difference and say it, rather than emitting a horizon that
   quietly cannot be honoured. */

import { load, save } from "./store.js";

const FILE = "fno_symbols.json";
const SRC = "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv";
const REFRESH_MS = 7 * 86_400_000;   // the list changes with each F&O review

const UA = {
  headers: {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    accept: "text/csv,*/*",
  },
};

let state = load(FILE, { at: 0, lots: {} });

const isIndex = s => ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"].includes(s);

/** Symbol → current-month lot size. Indices are dropped: this is about stocks. */
function parse(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",").map(h => h.trim().toUpperCase());
  const symCol = header.indexOf("SYMBOL");
  // The first month column is the near month; columns shift every expiry, so it
  // is found positionally from the symbol column rather than by a fixed index.
  const lotCol = symCol + 1;
  if (symCol < 0) throw new Error("no SYMBOL column in the F&O lots CSV");
  const lots = {};
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const sym = (cells[symCol] || "").trim().toUpperCase();
    const lot = parseInt((cells[lotCol] || "").trim(), 10);
    if (!sym || isIndex(sym)) continue;
    if (Number.isFinite(lot) && lot > 0) lots[sym] = lot;
  }
  return lots;
}

/** Best-effort refresh. Never throws into a scan; staleness is reported instead. */
export async function ensure(force = false) {
  const age = Date.now() - (state.at || 0);
  if (!force && state.at && age < REFRESH_MS && Object.keys(state.lots).length) return state;
  try {
    const r = await fetch(SRC, { ...UA, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const lots = parse(await r.text());
    if (!Object.keys(lots).length) throw new Error("parsed zero symbols");
    state = { at: Date.now(), lots };
    save(FILE, state);
    console.log(`[fno] ${Object.keys(lots).length} F&O stocks loaded`);
  } catch (e) {
    console.warn(`[fno] refresh failed: ${e.message}`);
  }
  return state;
}

export const isFno = sym => !!state.lots[String(sym || "").toUpperCase()];
export const lotSize = sym => state.lots[String(sym || "").toUpperCase()] ?? null;
export const count = () => Object.keys(state.lots).length;
export const loadedAt = () => state.at || null;

/**
 * What the user can actually do with a short on this symbol, stated plainly.
 *
 * `known: false` means the list could not be fetched. That is reported rather
 * than assumed either way — guessing "cash only" would suppress real trades, and
 * guessing "F&O" would present an impossible one as executable.
 */
export function shortability(symbol) {
  if (!state.at || !Object.keys(state.lots).length) {
    return {
      known: false, fno: null, lotSize: null, overnight: null,
      maxHorizon: null,
      note: "Could not check whether this stock is in the F&O segment, so whether a short can be held overnight is unknown. Verify with your broker before acting.",
    };
  }
  const fno = isFno(symbol);
  return {
    known: true, fno,
    lotSize: fno ? lotSize(symbol) : null,
    overnight: fno,
    // The horizon a short can honestly claim. Cash-segment shorts die at the bell.
    maxHorizon: fno ? null : "intraday",
    note: fno
      ? `In the F&O segment (lot size ${lotSize(symbol)}). A short can be carried overnight through futures or options, in whole lots — so the position size is set by the lot, not by your risk budget.`
      : "NOT in the F&O segment. A short here is intraday only and must be bought back before the close — carrying it overnight is not possible in the cash market and results in auction settlement. Any horizon longer than one session is not executable on this stock.",
  };
}
