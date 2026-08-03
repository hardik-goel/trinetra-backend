/* Broker calls, and whether each broker has been right.

   A target price is worthless without the record of the person who set it.
   "Motilal Oswal · ₹1,450" is a claim; "Motilal Oswal · ₹1,450 · 64% hit rate
   (n=22)" is evidence. So every call is logged when seen and RESOLVED later
   against what price actually did, and the hit rate is measured rather than
   assumed.

   Two ways in, because scraping brokerage pages is unreliable by nature: an
   automatic scrape that degrades to "unavailable", and manual entry for calls
   the user already sees. The ledger scores both identically — a call typed in by
   hand is worth more than one scraped from a page that may have changed layout,
   not less.

   Below MIN_CALLS a broker has no hit rate, only a count. Five resolved calls is
   already thin; anything less is not a record. */

import * as cheerio from "cheerio";
import { load, save, newId } from "./store.js";

const FILE = "analyst_calls.json";
const MIN_CALLS = 5;
const STALE_DAYS = 90;          // brokerage targets: older than this stops moving levels
/* A named expert's call on a STOCK ages faster than a brokerage target or an IPO
   view — it is a read on the current tape, not a twelve-month thesis. */
const EXPERT_STALE_DAYS = 45;
const RESOLVE_WINDOW_DAYS = 180; // a target has six months to be reached
const DAY_MS = 86_400_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const clean = t => String(t ?? "").replace(/\s+/g, " ").trim();

/* All markup knowledge in one block per source, same discipline as the
   fundamentals scraper: when a site changes, this is the only thing to patch. */
const SOURCES = {
  moneycontrol: {
    name: "moneycontrol",
    url: sym => `https://www.moneycontrol.com/markets/stock-ideas/?search=${encodeURIComponent(sym)}`,
    rows: "table tr, .rapidResBx li, .brokerage-list li",
    broker: ".broker, td:nth-child(1), .brkname",
    call: ".reco, td:nth-child(2), .recotxt",
    target: ".target, td:nth-child(3), .tgt",
    rationale: ".desc, td:nth-child(4)",
  },
  trendlyne: {
    name: "trendlyne",
    url: sym => `https://trendlyne.com/research-reports/stock/${encodeURIComponent(sym)}/`,
    rows: ".research-report-card, table tbody tr",
    broker: ".broker-name, td:nth-child(1)",
    call: ".recommendation, td:nth-child(2)",
    target: ".target-price, td:nth-child(3)",
    rationale: ".report-summary, td:nth-child(4)",
  },
};

/* Brokers appear under many spellings; the ledger is worthless if the same firm
   accumulates a record under four names. */
/* Named experts the user follows. They are sources like any other: their calls
   are logged, resolved against what price did, and scored with n. Being named on
   television earns a row in the evidence table, not a shortcut past it. */
export const EXPERTS = [
  { name: "Sandeep Jain", query: "Sandeep Jain" },
  { name: "Anil Singhvi", query: "Anil Singhvi" },
];

const EXPERT_SOURCES = {
  zeebiz: {
    name: "zeebiz",
    url: (expert, sym) => `https://www.zeebiz.com/search?q=${encodeURIComponent(`${expert} ${sym}`)}`,
    rows: "article, .search-result, .news-list li",
    title: "h2, h3, .title, a",
    snippet: "p, .desc",
    link: "a",
  },
  duckduckgo: {
    name: "duckduckgo",
    url: (expert, sym) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:zeebiz.com "${expert}" ${sym}`)}`,
    rows: ".result, .web-result",
    title: ".result__a",
    snippet: ".result__snippet",
    link: ".result__a",
  },
};

/* Stance in an expert's vocabulary, which is not a brokerage's. "Book profit" is
   a real call and means something different from "sell". */
const EXPERT_STANCE = [
  [/\bbook\s+(partial\s+)?profit/i, "Book profit"],
  [/\b(buy|accumulate|add|bullish)\b/i, "Buy"],
  [/\b(avoid|stay\s+away|exit|sell)\b/i, "Sell"],
  [/\b(hold|neutral|wait)\b/i, "Hold"],
];
const TARGET_RE = /target[^\d₹]{0,20}₹?\s?([\d,]+(?:\.\d+)?)/i;
const STOP_RE = /stop[- ]?loss[^\d₹]{0,20}₹?\s?([\d,]+(?:\.\d+)?)/i;

const ALIASES = [
  [/motilal/i, "Motilal Oswal"], [/icici/i, "ICICI Securities"], [/hdfc/i, "HDFC Securities"],
  [/kotak/i, "Kotak Institutional"], [/axis/i, "Axis Securities"], [/sharekhan/i, "Sharekhan"],
  [/emkay/i, "Emkay Global"], [/anand\s*rathi/i, "Anand Rathi"], [/prabhudas/i, "Prabhudas Lilladher"],
  [/jm\s*financial/i, "JM Financial"], [/nuvama|edelweiss/i, "Nuvama"], [/geojit/i, "Geojit"],
  [/angel/i, "Angel One"], [/iifl/i, "IIFL"], [/nirmal\s*bang/i, "Nirmal Bang"],
  [/ventura/i, "Ventura"], [/dolat/i, "Dolat Capital"], [/centrum/i, "Centrum"],
  [/systematix/i, "Systematix"], [/yes\s*securities/i, "Yes Securities"],
  [/jefferies/i, "Jefferies"], [/morgan\s*stanley/i, "Morgan Stanley"], [/goldman/i, "Goldman Sachs"],
  [/citi/i, "Citi"], [/ubs/i, "UBS"], [/nomura/i, "Nomura"], [/macquarie/i, "Macquarie"],
  [/clsa/i, "CLSA"], [/bernstein/i, "Bernstein"], [/jpmorgan|jp\s*morgan/i, "JPMorgan"],
];
export const normaliseBroker = raw => {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  for (const [re, name] of ALIASES) if (re.test(s)) return name;
  return s.slice(0, 40);
};

const CALLS = [
  [/\b(buy|accumulate|add|outperform|overweight)\b/i, "Buy"],
  [/\b(hold|neutral|equal[- ]?weight|market ?perform)\b/i, "Hold"],
  [/\b(sell|reduce|underperform|underweight)\b/i, "Sell"],
];
const normaliseCall = raw => {
  const s = String(raw ?? "");
  for (const [re, v] of CALLS) if (re.test(s)) return v;
  return null;
};
const parsePrice = raw => {
  const n = parseFloat(String(raw ?? "").replace(/[₹,\s]/g, "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

let ledger = load(FILE, { calls: [] });
if (!Array.isArray(ledger.calls)) ledger = { calls: [] };
const persist = () => save(FILE, ledger);
export const reload = () => { ledger = load(FILE, { calls: [] }); if (!Array.isArray(ledger.calls)) ledger = { calls: [] }; };

/** Record a call once. Same broker + symbol + target within a week is the same
    call reported twice, not two views. */
export function addCall(input, source = "manual") {
  const broker = normaliseBroker(input.broker);
  const target = parsePrice(input.target);
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  if (!broker || !symbol) return null;
  const date = input.date || new Date().toISOString().slice(0, 10);

  const dup = ledger.calls.find(c =>
    c.symbol === symbol && c.broker === broker &&
    Math.abs(Date.parse(c.date) - Date.parse(date)) < 7 * DAY_MS &&
    (c.target == null || target == null || Math.abs(c.target - target) < 1));
  if (dup) return dup;

  const rec = {
    id: newId("call"), symbol, broker,
    call: normaliseCall(input.call) || input.call || null,
    target, date,
    priceAtCall: input.priceAtCall != null ? +input.priceAtCall : null,
    rationale: input.rationale ? String(input.rationale).slice(0, 400) : null,
    url: input.url || null,
    source,
    kind: source === "expert" ? "expert" : "broker",
    stopLoss: input.stopLoss != null ? parsePrice(input.stopLoss) : null,
    resolved: null, // { reached, reachedOn, maxPct }
  };
  ledger.calls.push(rec);
  persist();
  return rec;
}

/**
 * Resolve outstanding calls against what price actually did. A call is "hit" if
 * price reached the target within the window; still open if the window has not
 * closed. Nothing is scored until it is decided.
 */
export function resolveCalls(symbol, candles) {
  if (!candles?.length) return 0;
  let changed = 0;
  for (const c of ledger.calls) {
    if (c.symbol !== symbol || c.resolved || !c.target) continue;
    const from = Date.parse(c.date);
    if (!Number.isFinite(from)) continue;
    const deadline = from + RESOLVE_WINDOW_DAYS * DAY_MS;
    const window = candles.filter(x => x.t >= from && x.t <= Math.min(deadline, Date.now()));
    if (!window.length) continue;

    const bullish = c.call !== "Sell";
    const extreme = bullish ? Math.max(...window.map(x => x.h)) : Math.min(...window.map(x => x.l));
    const reached = bullish ? extreme >= c.target : extreme <= c.target;
    const base = c.priceAtCall || window[0].c;

    if (reached) {
      const bar = window.find(x => (bullish ? x.h >= c.target : x.l <= c.target));
      c.resolved = { reached: true, reachedOn: new Date(bar.t).toISOString().slice(0, 10),
                     maxPct: round2(((extreme - base) / base) * 100) };
      changed++;
    } else if (Date.now() > deadline) {
      c.resolved = { reached: false, reachedOn: null, maxPct: round2(((extreme - base) / base) * 100) };
      changed++;
    }
  }
  if (changed) persist();
  return changed;
}

/** Per-broker record. Below MIN_CALLS there is a count and nothing else. */
export function brokerAccuracy(broker) {
  const decided = ledger.calls.filter(c => c.broker === broker && c.resolved);
  if (decided.length < MIN_CALLS) {
    return { broker, n: decided.length, rate: null, insufficient: true, required: MIN_CALLS,
             note: `${decided.length} resolved call${decided.length === 1 ? "" : "s"} — too few to state a hit rate.` };
  }
  const hits = decided.filter(c => c.resolved.reached).length;
  return { broker, n: decided.length, rate: round2((hits / decided.length) * 100), insufficient: false };
}

const ageDays = d => Math.floor((Date.now() - Date.parse(d)) / DAY_MS);

/** Everything known about a symbol, with staleness marked. */
export function forSymbol(symbol) {
  const calls = ledger.calls
    .filter(c => c.symbol === symbol)
    .map(c => {
      const age = ageDays(c.date);
      const limit = c.kind === "expert" ? EXPERT_STALE_DAYS : STALE_DAYS;
      return { ...c, ageDays: age, staleAfterDays: limit, stale: age > limit, accuracy: brokerAccuracy(c.broker) };
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  // Only live calls with targets set consensus, and only live ones move levels.
  const live = calls.filter(c => !c.stale && c.target);
  const targets = live.map(c => c.target).sort((a, b) => a - b);
  const consensusTarget = targets.length
    ? round2(targets.reduce((a, b) => a + b, 0) / targets.length) : null;

  return {
    symbol,
    calls,
    live,
    consensusTarget,
    n: targets.length,
    spread: targets.length > 1 ? { low: targets[0], high: targets.at(-1) } : null,
    unavailable: calls.length === 0,
    note: calls.length === 0
      ? "No broker calls recorded for this symbol. Scraping brokerage pages is unreliable, and nothing has been entered by hand — this is an absence of data, not an absence of coverage."
      : null,
    staleExcluded: calls.filter(c => c.stale).length,
  };
}

/* ── scraping ─────────────────────────────────────────────────────────────
   Best-effort and expected to fail: these sites block automated access and
   change markup. A failure is reported as unavailable, never as "no calls". */
export async function scrape(symbol) {
  const found = [];
  const errors = [];
  for (const src of Object.values(SOURCES)) {
    try {
      const r = await fetch(src.url(symbol), {
        headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      if (/captcha|are you a robot|verify your browser|__verify/i.test(html.slice(0, 4000))) {
        throw new Error("bot check served instead of content");
      }
      const $ = cheerio.load(html);
      let hits = 0;
      $(src.rows).each((_, el) => {
        const broker = normaliseBroker($(el).find(src.broker).first().text());
        const target = parsePrice($(el).find(src.target).first().text());
        const call = normaliseCall($(el).find(src.call).first().text());
        if (!broker || (!target && !call)) return;
        found.push({ broker, target, call, rationale: $(el).find(src.rationale).first().text().trim() || null, url: src.url(symbol) });
        hits++;
      });
      if (!hits) errors.push(`${src.name}: page fetched but no rows matched the selectors`);
    } catch (e) {
      errors.push(`${src.name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1_000)); // paced, like the fundamentals scraper
  }

  for (const f of found) addCall({ ...f, symbol }, "scrape");
  return { added: found.length, errors };
}

/**
 * Named-expert calls on a stock. Best-effort and expected to fail — these are
 * news sites with anti-bot measures — and a failure is reported as such rather
 * than as "no view".
 */
export async function scrapeExperts(symbol) {
  const errors = [];
  let added = 0;
  for (const expert of EXPERTS) {
    let found = false;
    for (const src of Object.values(EXPERT_SOURCES)) {
      if (found) break;
      try {
        const r = await fetch(src.url(expert.query, symbol), {
          headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
          signal: AbortSignal.timeout(12_000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const html = await r.text();
        if (/captcha|are you a robot|__verify/i.test(html.slice(0, 4000))) throw new Error("bot check served instead of content");
        const $ = cheerio.load(html);
        $(src.rows).each((_, el) => {
          if (found) return;
          const title = clean($(el).find(src.title).first().text());
          const snip = clean($(el).find(src.snippet).first().text());
          const text = `${title} ${snip}`;
          // Both the expert AND the symbol must appear, or this is a story about
          // someone else that happened to match a search.
          if (!new RegExp(expert.query, "i").test(text)) return;
          if (!new RegExp(`\\b${symbol}\\b`, "i").test(text)) return;
          const stance = EXPERT_STANCE.find(([re]) => re.test(text))?.[1];
          if (!stance) return;
          addCall({
            symbol, broker: expert.name, call: stance,
            target: (text.match(TARGET_RE) || [])[1]?.replace(/,/g, ""),
            stopLoss: (text.match(STOP_RE) || [])[1]?.replace(/,/g, ""),
            rationale: snip || title,
            url: $(el).find(src.link).first().attr("href") || src.url(expert.query, symbol),
          }, "expert");
          added++; found = true;
        });
        if (!found) errors.push(`${expert.name} via ${src.name}: no matching item`);
      } catch (e) {
        errors.push(`${expert.name} via ${src.name}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 1_000));
    }
  }
  return { added, errors };
}

export const all = () => ledger.calls;
export const MIN_RESOLVED = MIN_CALLS;
