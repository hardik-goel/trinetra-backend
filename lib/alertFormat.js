/* How an alert reads.

   An alert that is not immediately actionable trains the user to ignore all
   alerts, so this file is deliberately spare: what locked, with the numbers that
   locked it; where to get in, where it is now, where to get out; and how long it
   usually takes. Everything else — evidence stacks, convergence counts, component
   breakdowns — lives in the app, one tap away, and is left out here on purpose.

   The criteria block is the most important part. "Fundamentals ✓" says nothing;
   "ROE 22.7% · D/E 0.01 · growth 26%" is the reason, and it is what lets the user
   disagree with the machine. */

import { byKey as FUND_META } from "../fundamentals.config.js";

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rupee = v => `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const pctStr = (v, sign = false) => `${sign && v > 0 ? "+" : ""}${Number(v).toFixed(1)}%`;

/* Short labels for the alert line. The fundamentals catalog already names every
   metric; this only shortens the handful that would otherwise crowd a phone. */
const SHORT = {
  roe: "ROE", roce: "ROCE", de: "D/E", profitGrowth: "growth", salesGrowth3y: "sales",
  epsGrowth3y: "EPS", promoter: "promoter", pledged: "pledged", opm: "margin",
  pe: "P/E", pb: "P/B", dividendYield: "yield", piotroski: "Piotroski",
  dayChgPct: "today", volMultiple: "volume", volSustained: "volume",
  pctOf52wHigh: "of 52w high", aboveHigh20: "20d high", aboveHigh50: "50d high",
  buyerPct: "buyers", fcstReturn: "forecast", orBreakout: "opening range",
  vsVwapPct: "vs VWAP", volVsTOD: "volume", dayRangePos: "day range",
};

/** One check rendered as the fact that made it pass. */
function checkPhrase(chk, stock) {
  const label = SHORT[chk.metric] || chk.metric;
  const v = chk.v;
  if (v == null) return null;
  switch (chk.metric) {
    case "aboveHigh20": return `${rupee(stock.price)} above 20d high ${rupee(stock.high20)}`;
    case "aboveHigh50": return `${rupee(stock.price)} above 50d high ${rupee(stock.high50)}`;
    case "dayChgPct": return `${pctStr(v, true)} today`;
    case "volMultiple": case "volSustained": return `${v.toFixed(1)}× the 20-day average`;
    case "pctOf52wHigh": return `${v.toFixed(0)}% of 52-week high`;
    case "de": return `D/E ${v.toFixed(2)}`;
    default: {
      const unit = FUND_META[chk.metric]?.unit ?? "";
      return `${label} ${v.toFixed(unit === "%" ? 1 : 2)}${unit}`;
    }
  }
}

/** Plain-language holding period. The parenthetical only appears when analog
    history actually supports it — never an invented timing figure. */
export function horizonPhrase(horizon, analogs) {
  const base = { intraday: "rest of the session", swing: "3–5 days",
                 positional: "2–4 weeks", longterm: "3+ months" }[horizon] || "3–5 days";
  const n = analogs?.n ?? 0;
  const sessions = analogs?.medianSessionsToPeak;
  if (n >= 8 && sessions) {
    return `${base}  (typically reached in ${sessions} session${sessions === 1 ? "" : "s"})`;
  }
  return base;
}

const pad = (label, width = 16) => label + " ".repeat(Math.max(1, width - label.length));

/**
 * A setup alert. `direction` is "buy" or "sell"; the sell path is fully wired and
 * simply has nothing to feed it until bearish criteria exist — no bullish signal
 * is ever inverted to manufacture one.
 */
export function formatSignal(sig, stock) {
  const dir = sig.direction === "sell" ? "SELL" : "BUY";
  const profiles = (sig.profiles?.length ? sig.profiles : [sig.profileName]).filter(Boolean);
  const L = [];

  L.push(`👁 <b>TRINETRA</b> · ${dir} · ${esc(profiles.join(" + ").toUpperCase())}`);
  L.push(`<b>${esc(sig.symbol)}</b> · ${esc(sig.name || sig.symbol)}`);
  L.push("");

  // What locked, and the numbers that locked it — the union across profiles,
  // listed once even when several profiles fired.
  const seen = new Set();
  for (const c of sig.criteriaDetail || []) {
    if (!c.pass || seen.has(c.name)) continue;
    seen.add(c.name);
    const facts = (c.checksOut || []).map(chk => checkPhrase(chk, stock)).filter(Boolean);
    L.push(`✓ ${pad(esc(c.name))}${esc(facts.join(" · "))}`);
  }
  // Present but uncountable. Shown so it is not mistaken for a failure, and so
  // the denominator above never includes something unreachable.
  for (const s of sig.notEvaluated || []) {
    const why = (sig.criteriaWarnings || []).find(w => w.startsWith(s));
    L.push(`— ${pad(esc(s))}${esc(why ? why.split(": ").slice(1).join(": ").replace(/\.$/, "") : "no data available")}`);
  }

  L.push("");
  const entry = sig.entryPrice, exit = sig.exitPrice;
  if (entry) L.push(`<b>Entry</b>     ${rupee(entry)}`);
  L.push(`<b>Current</b>   ${rupee(sig.price)}${entry ? `  (${pctStr(((sig.price - entry) / entry) * 100, true)} from entry)` : ""}`);
  if (exit) {
    const below = dir === "SELL";
    L.push(`<b>Exit</b>      ${rupee(exit)}  (target — ${below ? "below" : "above"} entry)`);
  }
  L.push(sig.potentialLeftPct != null
    ? `<b>Potential</b> ${Math.abs(sig.potentialLeftPct).toFixed(1)}% left`
    : `<b>Potential</b> not established`);
  L.push(`<b>Horizon</b>   ${esc(horizonPhrase(sig.horizon, sig.potential?.analogs))}`);
  if (sig.confidence) L.push(`<b>Confidence</b> ${sig.confidence.score}% (${esc(sig.confidence.band)})`);

  L.push("");
  const t = new Date(sig.at).toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" }).slice(0, 5);
  L.push(`<i>${t} IST${sig.dataAge?.delayed ? ` · prices ~${Math.round((sig.dataAge.lagSeconds || 900) / 60)} min delayed` : ""}</i>`);
  if (sig.appUrl) L.push(`<a href="${esc(sig.appUrl)}">Open in Trinetra</a>`);

  return L.join("\n");
}

/** Digest line when the per-cycle cap is exceeded. One stock per line. */
export const digestLine = s =>
  `${esc(s.symbol)} · ${s.count}/${s.total}${s.potentialLeftPct != null ? ` · ${Math.abs(s.potentialLeftPct).toFixed(1)}% left` : ""}${s.confidence ? ` · conf ${s.confidence.score}` : ""}`;
