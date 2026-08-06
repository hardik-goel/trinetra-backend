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
  /* Buy vocabulary on a short is how someone reads "Exit ₹2,696" as a level to
     sell at when it is the level to BUY BACK at. The two sides get their own
     words, and the move is reported as a magnitude in the direction claimed. */
  const isSell = dir === "SELL";
  const actionWord = isSell ? "Short at" : "Entry";
  const targetWord = isSell ? "Cover at" : "Exit";
  if (entry) L.push(`<b>${actionWord}</b>${" ".repeat(Math.max(1, 10 - actionWord.length))}${rupee(entry)}`);
  L.push(`<b>Current</b>   ${rupee(sig.price)}${entry ? `  (${pctStr(Math.abs(((sig.price - entry) / entry) * 100) * (isSell ? -1 : 1), true)} ${isSell ? "against you" : "from entry"})` : ""}`);
  if (exit) {
    L.push(`<b>${targetWord}</b>${" ".repeat(Math.max(1, 10 - targetWord.length))}${rupee(exit)}  (target — ${isSell ? "below" : "above"} ${isSell ? "the short" : "entry"})`);
  } else if (sig.noRoom) {
    /* A target WAS computed and came out closer than the stop. Saying nothing
       here reads as "we could not work it out"; the truth is the opposite, and
       it is the more useful of the two messages. */
    L.push(`<b>${targetWord}</b>${" ".repeat(Math.max(1, 10 - targetWord.length))}none offered`);
  }
  /* The stop belongs in the alert, not one tap away. A target without the level
     that invalidates it is half a trade, and it is the half that loses money. */
  if (sig.stopPrice) {
    L.push(`<b>Stop</b>      ${rupee(sig.stopPrice)}  (${isSell ? "above" : "below"} — invalidates the setup)`);
  }
  L.push(sig.potentialLeftPct != null
    ? `<b>Potential</b> ${Math.abs(sig.potentialLeftPct).toFixed(1)}% left`
    : sig.noRoom
      ? `<b>Potential</b> less than the risk — see below`
      : `<b>Potential</b> not established`);
  if (sig.riskReward?.toPrimary != null) {
    const rr = sig.riskReward.toPrimary;
    L.push(`<b>R:R</b>       ${rr}:1${rr < 1 ? "  ⚠ below 1:1 — the maths is against this" : ""}`);
  }
  if (sig.noRoom && sig.riskRewardWarning) L.push(`<i>${esc(sig.riskRewardWarning)}</i>`);
  L.push(`<b>Horizon</b>   ${esc(horizonPhrase(sig.horizon, sig.potential?.analogs))}`);
  /* A short is not a buy with the sign flipped, and the two facts that make it
     different belong in the alert itself — not one tap away in the app. Someone
     acting on a phone notification must not have to remember that a cash-market
     short dies at the bell, or that the downside has no floor. */
  if (dir === "SELL" && sig.shortability) {
    const sh = sig.shortability;
    if (sig.horizonClamped) {
      L.push(`<b>⚠ Intraday only</b> — ${esc(sig.horizonClamped.why)}`);
    } else if (sh.fno) {
      L.push(`<b>F&amp;O</b>       lot ${sh.lotSize} — can be carried overnight, in whole lots`);
    } else if (sh.known === false) {
      L.push(`<b>⚠ Unknown</b>   could not check F&amp;O eligibility — confirm with your broker before carrying this`);
    }
    L.push(`<i>Loss on a short is unbounded. The stop is the risk control, not a formality.</i>`);
  }
  if (sig.confidence) L.push(`<b>Confidence</b> ${sig.confidence.score}% (${esc(sig.confidence.band)})`);

  /* Where the numbers came from. A target derived from this stock's own history
     after comparable setups is a different claim from one read off the chart, and
     conflating them would overstate the weaker of the two. */
  if (sig.levelSource === "structure") {
    L.push(`<i>Levels from chart structure — no comparable past setups in this stock to measure against.</i>`);
  }

  L.push("");
  const t = new Date(sig.at).toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" }).slice(0, 5);
  L.push(`<i>${t} IST${sig.dataAge?.delayed ? ` · prices ~${Math.round((sig.dataAge.lagSeconds || 900) / 60)} min delayed` : ""}</i>`);
  if (sig.appUrl) L.push(`<a href="${esc(sig.appUrl)}">Open in Trinetra</a>`);

  return L.join("\n");
}

/** Digest line when the per-cycle cap is exceeded. One stock per line. */
export const digestLine = s =>
  `${esc(s.symbol)} · ${s.count}/${s.total}${s.potentialLeftPct != null ? ` · ${Math.abs(s.potentialLeftPct).toFixed(1)}% left` : ""}${s.confidence ? ` · conf ${s.confidence.score}` : ""}`;
