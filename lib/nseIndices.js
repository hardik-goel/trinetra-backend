/* NSE index constituents, straight from the exchange.

   NSE publishes each index as a CSV on its archive host. That host serves without
   the bot-check that blocks the main site, so this is a rare case of getting
   authoritative data from the source rather than scraping a third party.

   The lists change — quarterly rebalances add and drop names — so this fetches
   live rather than shipping a snapshot that silently rots. A hardcoded Nifty 100
   from today is wrong within a quarter and gives no sign of it. */

const HOST = "https://nsearchives.nseindia.com/content/indices";

const UA = {
  headers: {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    accept: "text/csv,*/*",
  },
};

export const INDICES = {
  nifty50:     { file: "ind_nifty50list",         group: "Nifty 50",      label: "Nifty 50" },
  niftynext50: { file: "ind_niftynext50list",     group: "Nifty Next 50", label: "Nifty Next 50" },
  nifty100:    { file: "ind_nifty100list",        group: "Nifty 100",     label: "Nifty 100" },
  midcap100:   { file: "ind_niftymidcap100list",  group: "Midcap 100",    label: "Nifty Midcap 100" },
  smallcap100: { file: "ind_niftysmallcap100list", group: "Smallcap 100", label: "Nifty Smallcap 100" },
};

const SYMBOL_RE = /^[A-Z0-9&-]+$/;

/* The CSV is Company Name,Industry,Symbol,Series,ISIN — but column order has
   moved before, so the symbol column is found by header name rather than index.
   A silently wrong column would fill the universe with ISIN codes. */
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const col = header.indexOf("symbol");
  if (col < 0) throw new Error("no Symbol column in the CSV — NSE changed the format");
  const out = [];
  for (const line of lines.slice(1)) {
    const s = (line.split(",")[col] || "").trim().toUpperCase();
    if (s && SYMBOL_RE.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** One index. Throws with a usable message rather than returning an empty list —
    an empty universe silently replacing a full one is the failure to avoid. */
export async function fetchIndex(key) {
  const spec = INDICES[key];
  if (!spec) throw new Error(`unknown index "${key}"`);
  const r = await fetch(`${HOST}/${spec.file}.csv`, { ...UA, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${spec.label}: HTTP ${r.status}`);
  const symbols = parseCsv(await r.text());
  if (!symbols.length) throw new Error(`${spec.label}: parsed zero symbols`);
  return { key, group: spec.group, label: spec.label, symbols };
}

/**
 * Several indices at once. Partial failure is reported, never hidden: getting
 * three of four lists and saying nothing would leave the user believing their
 * universe covers something it does not.
 */
export async function fetchIndices(keys) {
  const groups = {}, errors = [];
  for (const key of keys) {
    try {
      const r = await fetchIndex(key);
      groups[r.group] = r.symbols;
    } catch (e) {
      errors.push({ index: key, reason: e.message });
    }
  }
  return { groups, errors };
}
