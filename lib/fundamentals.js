/* On-demand fundamentals — so universe.json stops needing a hand-maintained
   twin in fundamentals.json. Scrapes public company pages, validates every
   number, and reports honestly when a field could not be established.

   Fundamentals move quarterly, so callers cache. Nothing here scrapes on a
   refresh cycle. Never throws: a dead source returns status "unavailable".

   WHICH metrics exist is fundamentals.config.js. HOW to read them off a page
   is SELECTORS below. Those are the only two places knowledge lives: adding a
   metric is one config entry, and a source changing its HTML is a SELECTORS
   patch. Nothing in this file enumerates metric keys. */

import * as cheerio from "cheerio";
import { METRICS, METRIC_KEYS, REQUIRED_KEYS, RANGES } from "../fundamentals.config.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const TIMEOUT_MS = 10_000;
const RETRIES = 2;

/* ── every piece of markup knowledge, in one block ── */
const SELECTORS = {
  screener: {
    url: sym => `https://www.screener.in/company/${encodeURIComponent(sym)}/`,
    ratioItems: "#top-ratios li",
    ratioName: "span.name",
    ratioValue: "span.value",
    profitLossRows: "#profit-loss table tr",
    balanceSheetRows: "#balance-sheet table tr",
    shareholdingRows: "#quarterly-shp table tr",
    rowLabel: "td.text",
    growthTables: "#profit-loss table.ranges-table",
    analysisBullets: "#analysis li",
    // Screener's P&L ends in a trailing twelve-month column. It is not a
    // financial year, so comparing it against one would silently mix a
    // part-year into a CAGR. Drop it and work in whole years only.
    ttmHeading: /^ttm$/i,
  },
  moneycontrol: {
    searchUrl: sym =>
      `https://www.moneycontrol.com/mccode/common/autosuggestion_solr.php?classic=true&query=${encodeURIComponent(sym)}&type=1&format=json&callback=suggest1`,
    // the overview chart payload: a JSON array parked in a hidden div
    ratioBlob: "div[id$='-graph']",
    scripts: "script",
    trendJson: /trend_jsn\s*=\s*'([\s\S]*?)'/,
  },
};

const num = v => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, "").replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const clean = s => String(s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

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

/* ── source 1: screener.in ──
   The page is parsed once into a context of labelled numbers; every metric is
   then a lookup against that context rather than its own DOM walk. */
function screenerContext($) {
  const S = SELECTORS.screener;

  const topRatios = {};
  $(S.ratioItems).each((_, li) => {
    const name = clean($(li).find(S.ratioName).text()).toLowerCase().replace(/:$/, "");
    if (name) topRatios[name] = num($(li).find(S.ratioValue).text());
  });

  // A statement row reduced to its numeric cells, newest last. The TTM column
  // is identified from the header and dropped so year-on-year maths stays sane.
  const readRows = (sel, ttmIndex) => {
    const rows = [];
    $(sel).each((_, tr) => {
      const label = clean($(tr).find(S.rowLabel).first().text());
      if (!label) return;
      const cells = $(tr).find("td").slice(1).map((__, td) => num($(td).text())).get();
      rows.push({ label, cells: ttmIndex >= 0 ? cells.filter((_, i) => i !== ttmIndex) : cells });
    });
    return rows;
  };

  // header of the P&L table → which column, if any, is TTM
  let ttmIndex = -1;
  $(`${S.profitLossRows}`).first().find("th").slice(1).each((i, th) => {
    if (S.ttmHeading.test(clean($(th).text()))) ttmIndex = i;
  });

  const plRows = readRows(S.profitLossRows, ttmIndex);
  const bsRows = readRows(S.balanceSheetRows, -1);
  const shpRows = readRows(S.shareholdingRows, -1);

  const pick = (rows, re) => (rows.find(r => re.test(r.label))?.cells || []).filter(v => v != null);

  return {
    topRatios,
    plRow: re => pick(plRows, re),
    bsRow: re => pick(bsRows, re),
    shpRow: re => pick(shpRows, re),
    growth: (tableRe, periodRe) => {
      let found = null;
      $(S.growthTables).each((_, tbl) => {
        if (!tableRe.test(clean($(tbl).find("th").first().text()))) return;
        $(tbl).find("tr").each((__, tr) => {
          const cells = $(tr).find("td");
          if (cells.length >= 2 && periodRe.test(clean(cells.eq(0).text()))) found = num(cells.eq(1).text());
        });
      });
      return found;
    },
    bullet: re => {
      let found = null;
      $(S.analysisBullets).each((_, li) => {
        const m = clean($(li).text()).match(re);
        if (m) found = num(m[1]);
      });
      return found;
    },
  };
}

async function fromScreener(symbol) {
  const $ = cheerio.load(await fetchText(SELECTORS.screener.url(symbol)));
  const ctx = screenerContext($);
  const out = {};

  for (const m of METRICS) {
    const spec = m.screener;
    if (!spec) continue;
    let v = null;
    try {
      if (spec.derive) v = spec.derive(ctx);
      else if (spec.topRatio) {
        const hit = Object.keys(ctx.topRatios).find(n => spec.topRatio.test(n));
        v = hit ? ctx.topRatios[hit] : null;
      }
      else if (spec.plRow) v = ctx.plRow(spec.plRow).at(-1) ?? null;
      else if (spec.shpRow) v = ctx.shpRow(spec.shpRow).at(-1) ?? null;
      else if (spec.growth) v = ctx.growth(spec.growth, spec.period);
      else if (spec.bullet) v = ctx.bullet(spec.bullet);
    } catch { v = null; } // one bad selector must not sink the whole page
    if (v != null) out[m.key] = v;
  }

  return out;
}

/* ── source 2: moneycontrol ──
   Covers the metrics screener publishes least reliably. Metrics with no
   moneycontrol spec simply are not available here, and stay missing. */
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
  const specs = METRICS.filter(m => m.moneycontrol);

  $(S.ratioBlob).each((_, div) => {
    const txt = clean($(div).text());
    if (!txt.startsWith("[")) return;
    let series; try { series = JSON.parse(txt); } catch { return; }
    for (const s of series) {
      const head = clean(s.heading);
      const vals = (s.data || []).map(d => num(d.value)).filter(v => v != null);
      if (!vals.length) continue;
      for (const m of specs) {
        const spec = m.moneycontrol;
        if (!spec.heading?.test(head)) continue;
        if (spec.cagr) {
          // No published CAGR here, so compute it from the series.
          const n = spec.cagr;
          if (vals.length < n + 1) continue;
          const first = vals.at(-(n + 1)), last = vals.at(-1);
          if (first > 0 && last > 0) out[m.key] = +(((last / first) ** (1 / n) - 1) * 100).toFixed(1);
        } else {
          out[m.key] = vals.at(-1);
        }
      }
    }
  });

  // Shareholding trend blob — this one states Pledge explicitly, including 0.
  $(S.scripts).each((_, sc) => {
    const m = $(sc).html()?.match(S.trendJson);
    if (!m) return;
    let trend; try { trend = JSON.parse(m[1]); } catch { return; }
    const latest = trend?.Promoter && Object.values(trend.Promoter).at(-1);
    if (!latest) return;
    for (const metric of specs) {
      const field = metric.moneycontrol.shareholding;
      if (field && latest[field] != null) out[metric.key] = num(latest[field]);
    }
  });

  return out;
}

const SOURCES = [
  { name: "screener.in", key: "screener", fn: fromScreener },
  { name: "moneycontrol", key: "moneycontrol", fn: fromMoneycontrol },
];

// Keep only values that are both numbers and physically plausible.
function validate(raw) {
  const kept = {};
  for (const f of METRIC_KEYS) {
    const v = raw[f];
    if (v == null || !Number.isFinite(v)) continue;
    const [lo, hi] = RANGES[f];
    if (v < lo || v > hi) continue; // markup drift, not a fact
    kept[f] = v;
  }
  return kept;
}

/**
 * Scrape one symbol. Sources are tried in order; the first result carrying
 * every REQUIRED metric wins. If none is complete, partials are merged in
 * source order so a field one site omits can still come from the next — the
 * source string then names every site that contributed. Never throws.
 *
 * `missing` lists every metric that could not be established, required or not.
 * `status` is judged on the required ones only, because a metric the source
 * legitimately does not publish (pledging when there is none, a Piotroski
 * score nobody added to the page) is not a failed scrape.
 */
export async function fetchFundamentals(symbol) {
  const merged = {};
  const used = [];

  for (const src of SOURCES) {
    // Only pay for a fetch that can actually contribute. Once every metric this
    // source knows how to read is already established, it has nothing to add —
    // which is what stops a complete screener scrape from also hitting
    // moneycontrol, while still going there for the fields screener omits.
    if (!METRICS.some(m => m[src.key] && merged[m.key] == null)) continue;

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
  }

  const missing = METRIC_KEYS.filter(f => merged[f] == null);
  const missingRequired = REQUIRED_KEYS.filter(f => merged[f] == null);
  const status =
    missingRequired.length === 0 ? "fetched"
    : missingRequired.length === REQUIRED_KEYS.length ? "unavailable"
    : "partial";

  return {
    ...Object.fromEntries(METRIC_KEYS.map(k => [k, merged[k] ?? null])),
    status,
    source: used.join("+") || null,
    fetchedAt: Date.now(),
    missing,
  };
}
