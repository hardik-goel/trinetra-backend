/* On-demand fundamentals — so universe.json stops needing a hand-maintained
   twin in fundamentals.json. Scrapes public company pages, validates every
   number, and reports honestly when a field could not be established.

   Fundamentals move quarterly, so callers cache. Nothing here scrapes on a
   refresh cycle. Never throws: a dead source returns status "unavailable".

   When a source changes its HTML, patch SELECTORS below — that block is the
   only place markup knowledge lives. */

import * as cheerio from "cheerio";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const TIMEOUT_MS = 10_000;
const RETRIES = 2;

// A scraped number outside these bounds is markup drift, not a fact. Drop it.
const RANGES = {
  roe: [-50, 100],
  de: [0, 20],
  profitGrowth: [-100, 300],
  promoter: [0, 100],
  pledged: [0, 100],
};
const FIELDS = Object.keys(RANGES);

/* ── every piece of markup knowledge, in one block ── */
const SELECTORS = {
  screener: {
    url: sym => `https://www.screener.in/company/${encodeURIComponent(sym)}/`,
    ratioItems: "#top-ratios li",
    ratioName: "span.name",
    ratioValue: "span.value",
    balanceSheetRows: "#balance-sheet table tr",
    shareholdingRows: "#quarterly-shp table tr",
    rowLabel: "td.text",
    growthTables: "#profit-loss table.ranges-table",
    analysisBullets: "#analysis li",
    // row labels, matched case-insensitively against the first cell
    rowBorrowings: /^borrowings/i,
    rowEquityCapital: /^equity capital/i,
    rowReserves: /^reserves/i,
    rowPromoters: /^promoters/i,
    ratioRoe: /^roe$/i,
    growthHeading: /compounded profit growth/i,
    growthPeriod: /^3\s*years/i,
    pledgeBullet: /pledged\s*([\d.]+)\s*%/i,
  },
  moneycontrol: {
    searchUrl: sym =>
      `https://www.moneycontrol.com/mccode/common/autosuggestion_solr.php?classic=true&query=${encodeURIComponent(sym)}&type=1&format=json&callback=suggest1`,
    // the overview chart payload: a JSON array parked in a hidden div
    ratioBlob: "div[id$='-graph']",
    scripts: "script",
    trendJson: /trend_jsn\s*=\s*'([\s\S]*?)'/,
    headingRoe: /^roe$/i,
    headingDe: /^debt to equity$/i,
    headingProfit: /^net profit$/i,
  },
};

const num = v => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, "").replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const clean = s => String(s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

async function fetchText(url) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 400 * attempt)); // backoff
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, signal: ctl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.text();
      } finally { clearTimeout(timer); }
    } catch (e) { last = e; }
  }
  throw last;
}

/* ── source 1: screener.in ── */
async function fromScreener(symbol) {
  const S = SELECTORS.screener;
  const $ = cheerio.load(await fetchText(S.url(symbol)));
  const out = {};

  $(S.ratioItems).each((_, li) => {
    if (S.ratioRoe.test(clean($(li).find(S.ratioName).text()))) out.roe = num($(li).find(S.ratioValue).text());
  });

  // Screener publishes no D/E ratio directly — derive it from the balance sheet.
  const bs = {};
  $(S.balanceSheetRows).each((_, tr) => {
    const label = clean($(tr).find(S.rowLabel).first().text());
    const lastCell = num($(tr).find("td").last().text());
    if (S.rowBorrowings.test(label)) bs.borrowings = lastCell;
    else if (S.rowEquityCapital.test(label)) bs.equity = lastCell;
    else if (S.rowReserves.test(label)) bs.reserves = lastCell;
  });
  const netWorth = (bs.equity || 0) + (bs.reserves || 0);
  if (bs.borrowings != null && netWorth > 0) out.de = +(bs.borrowings / netWorth).toFixed(3);

  $(S.growthTables).each((_, tbl) => {
    if (!S.growthHeading.test(clean($(tbl).find("th").first().text()))) return;
    $(tbl).find("tr").each((__, tr) => {
      const cells = $(tr).find("td");
      if (cells.length >= 2 && S.growthPeriod.test(clean(cells.eq(0).text()))) out.profitGrowth = num(cells.eq(1).text());
    });
  });

  $(S.shareholdingRows).each((_, tr) => {
    const label = clean($(tr).find(S.rowLabel).first().text());
    if (S.rowPromoters.test(label)) out.promoter = num($(tr).find("td").last().text());
  });

  // Pledging is only called out when it exists. Absence is NOT proof of zero,
  // so we leave the field missing rather than inventing a 0.
  $(S.analysisBullets).each((_, li) => {
    const m = clean($(li).text()).match(S.pledgeBullet);
    if (m) out.pledged = num(m[1]);
  });

  return out;
}

/* ── source 2: moneycontrol ── */
async function fromMoneycontrol(symbol) {
  const S = SELECTORS.moneycontrol;
  const body = await fetchText(S.searchUrl(symbol));
  const json = body.slice(body.indexOf("["), body.lastIndexOf("]") + 1);
  const hits = JSON.parse(json);
  // pdt_dis_nm carries "ISIN, NSESYMBOL, code" — match our symbol exactly.
  const hit = hits.find(h => new RegExp(`(^|[,>\\s])${symbol}([,<\\s]|$)`, "i").test(h.pdt_dis_nm || "")) || hits[0];
  if (!hit?.link_src) throw new Error("symbol not found on moneycontrol");

  const $ = cheerio.load(await fetchText(hit.link_src));
  const out = {};

  $(S.ratioBlob).each((_, div) => {
    const txt = clean($(div).text());
    if (!txt.startsWith("[")) return;
    let series; try { series = JSON.parse(txt); } catch { return; }
    for (const s of series) {
      const head = clean(s.heading);
      const vals = (s.data || []).map(d => num(d.value)).filter(v => v != null);
      if (!vals.length) continue;
      if (S.headingRoe.test(head)) out.roe = vals.at(-1);
      else if (S.headingDe.test(head)) out.de = vals.at(-1);
      else if (S.headingProfit.test(head) && vals.length >= 4) {
        // No published 3y profit CAGR here, so compute it from the series.
        const first = vals.at(-4), last = vals.at(-1);
        if (first > 0 && last > 0) out.profitGrowth = +(((last / first) ** (1 / 3) - 1) * 100).toFixed(1);
      }
    }
  });

  // Shareholding trend blob — this one states Pledge explicitly, including 0.
  $(S.scripts).each((_, sc) => {
    const m = $(sc).html()?.match(S.trendJson);
    if (!m) return;
    let trend; try { trend = JSON.parse(m[1]); } catch { return; }
    const quarters = trend?.Promoter && Object.values(trend.Promoter);
    const latest = quarters?.at(-1);
    if (latest) {
      if (latest.Holding != null) out.promoter = num(latest.Holding);
      if (latest.Pledge != null) out.pledged = num(latest.Pledge);
    }
  });

  return out;
}

const SOURCES = [
  { name: "screener.in", fn: fromScreener },
  { name: "moneycontrol", fn: fromMoneycontrol },
];

// Keep only values that are both numbers and physically plausible.
function validate(raw) {
  const kept = {};
  for (const f of FIELDS) {
    const v = raw[f];
    if (v == null || !Number.isFinite(v)) continue;
    const [lo, hi] = RANGES[f];
    if (v < lo || v > hi) continue; // markup drift, not a fact
    kept[f] = v;
  }
  return kept;
}

/**
 * Scrape one symbol. Sources are tried in order; the first COMPLETE result
 * wins. If none is complete, partials are merged in source order so a field
 * one site omits can still come from the next — the source string then names
 * every site that contributed. Never throws.
 */
export async function fetchFundamentals(symbol) {
  const merged = {};
  const used = [];

  for (const src of SOURCES) {
    let kept;
    try {
      kept = validate(await src.fn(symbol));
    } catch (e) {
      console.warn(`[fundamentals] ${symbol} via ${src.name}: ${e.message}`);
      continue;
    }
    const added = Object.keys(kept).filter(f => merged[f] == null);
    if (!added.length) continue;
    added.forEach(f => { merged[f] = kept[f]; });
    used.push(src.name);
    if (FIELDS.every(f => merged[f] != null)) break; // complete — stop early
  }

  const missing = FIELDS.filter(f => merged[f] == null);
  const status = missing.length === 0 ? "fetched" : missing.length === FIELDS.length ? "unavailable" : "partial";
  return {
    roe: merged.roe ?? null,
    de: merged.de ?? null,
    profitGrowth: merged.profitGrowth ?? null,
    promoter: merged.promoter ?? null,
    pledged: merged.pledged ?? null,
    status,
    source: used.join("+") || null,
    fetchedAt: Date.now(),
    missing,
  };
}
