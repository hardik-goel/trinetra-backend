/* The fundamentals metric catalog — the one place a metric is defined.
   Adding a metric is one entry here plus, if it needs new markup knowledge,
   one selector. Nothing else in the codebase enumerates metric keys: the
   scraper, the plausibility guard, the cache, the API and the criteria engine
   all read this file.

   Each entry:
     key        stable id — used in the cache, the API and criteria checks
     label      human name, shown in the dashboard
     unit       "%" | "x" | "" — display only
     range      [min, max] plausibility band. Outside it the value is markup
                drift, not a fact, and is dropped (which downgrades status).
     required   true  → absence means the scrape did not fully succeed
                false → the source legitimately may not publish it, so absence
                        is not a data-quality failure. Still reported in
                        `missing` so a caller can see exactly what is unknown.
     screener   how to read it off screener.in (see KINDS below)
     moneycontrol  optional fallback for the same metric

   Extraction kinds, so a new metric usually needs no new parsing code:
     { topRatio: /re/ }              a tile in the #top-ratios grid
     { plRow: /re/ }                 last annual column of a P&L row
     { growth: /re/, period: /re/ }  a cell in a compounded-growth table
     { shpRow: /re/ }                latest quarter of a shareholding row
     { bullet: /re with one group/ } a number called out in the analysis notes
     { derive: fn(ctx) }             computed from other parsed values
   `ctx` exposes: topRatios (name → number), plRow(re) → number[],
   bsRow(re) → number[], growth(tableRe, periodRe) → number.            */

export const METRICS = [
  {
    key: "roe", label: "Return on equity", unit: "%", range: [-50, 100], required: true,
    screener: { topRatio: /^roe$/i },
    moneycontrol: { heading: /^roe$/i },
  },
  {
    key: "roce", label: "Return on capital employed", unit: "%", range: [-50, 150], required: true,
    screener: { topRatio: /^roce$/i },
  },
  {
    key: "de", label: "Debt / equity", unit: "", range: [0, 20], required: true,
    // Screener publishes no D/E tile — derive it from the balance sheet.
    screener: {
      derive: ctx => {
        // Banks and NBFCs label this row "Borrowing"; everyone else "Borrowings".
        const borrowings = ctx.bsRow(/^borrowings?\b/i).at(-1);
        const netWorth = (ctx.bsRow(/^equity capital/i).at(-1) || 0) + (ctx.bsRow(/^reserves/i).at(-1) || 0);
        return borrowings != null && netWorth > 0 ? +(borrowings / netWorth).toFixed(3) : null;
      },
    },
    moneycontrol: { heading: /^debt to equity$/i },
  },
  {
    key: "pe", label: "Price / earnings", unit: "", range: [0, 500], required: true,
    screener: { topRatio: /^stock p\/?e$/i },
  },
  {
    key: "pb", label: "Price / book", unit: "", range: [0, 100], required: true,
    // No P/B tile either, but both halves of it are tiles.
    screener: {
      derive: ctx => {
        const price = ctx.topRatios["current price"], book = ctx.topRatios["book value"];
        return price != null && book > 0 ? +(price / book).toFixed(2) : null;
      },
    },
  },
  {
    key: "dividendYield", label: "Dividend yield", unit: "%", range: [0, 50], required: true,
    screener: { topRatio: /^dividend yield$/i },
  },
  {
    key: "opm", label: "Operating margin", unit: "%", range: [-100, 100], required: true,
    screener: { plRow: /^opm\s*%?$/i },
  },
  {
    key: "profitGrowth", label: "Profit growth (3y)", unit: "%", range: [-100, 300], required: true,
    screener: { growth: /compounded profit growth/i, period: /^3\s*years/i },
    moneycontrol: { heading: /^net profit$/i, cagr: 3 },
  },
  {
    key: "salesGrowth3y", label: "Sales growth (3y)", unit: "%", range: [-100, 300], required: true,
    screener: { growth: /compounded sales growth/i, period: /^3\s*years/i },
  },
  {
    key: "promoter", label: "Promoter holding", unit: "%", range: [0, 100], required: true,
    screener: { shpRow: /^promoters/i },
    moneycontrol: { shareholding: "Holding" },
  },

  /* ── optional: the source may legitimately not publish these ── */
  {
    key: "epsGrowth3y", label: "EPS growth (3y)", unit: "%", range: [-100, 300], required: false,
    // Screener publishes no EPS CAGR, so compute it from the EPS row. Needs
    // four comparable annual columns; TTM is excluded upstream so a part-year
    // never gets compared against a full one.
    screener: {
      derive: ctx => {
        const eps = ctx.plRow(/^eps/i);
        if (eps.length < 4) return null;
        const first = eps.at(-4), last = eps.at(-1);
        return first > 0 && last > 0 ? +(((last / first) ** (1 / 3) - 1) * 100).toFixed(1) : null;
      },
    },
  },
  {
    key: "pledged", label: "Pledged shares", unit: "%", range: [0, 100], required: false,
    // Screener only calls pledging out when it exists, and absence is not proof
    // of zero — so this stays missing rather than becoming an invented 0.
    // Moneycontrol states Pledge explicitly, including a real 0.
    screener: { bullet: /pledged\s*([\d.]+)\s*%/i },
    moneycontrol: { shareholding: "Pledge" },
  },
  {
    key: "piotroski", label: "Piotroski F-score", unit: "", range: [0, 9], required: false,
    // Screener does not ship this by default; it appears only when the page
    // owner has added it as a custom ratio. Parsed when present, left missing
    // when not. Deliberately NOT computed — see the README: a faithful F-score
    // needs nine signals across two years, and screener's condensed statements
    // do not expose the current-ratio and gross-margin inputs cleanly. A
    // six-of-nine approximation carrying the name "Piotroski" would read as
    // the real thing, which is exactly the guess this module refuses to make.
    screener: { topRatio: /^piotroski\s*(f[- ]?)?score$/i },
  },
];

export const METRIC_KEYS = METRICS.map(m => m.key);
export const REQUIRED_KEYS = METRICS.filter(m => m.required).map(m => m.key);
export const RANGES = Object.fromEntries(METRICS.map(m => [m.key, m.range]));
export const byKey = Object.fromEntries(METRICS.map(m => [m.key, m]));
