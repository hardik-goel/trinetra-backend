/* ================================================================
   TRINETRA · backend
   One service that (1) serves market snapshots to the UI and
   (2) runs the confluence scan server-side so Telegram alerts
   fire 24/7 — no browser tab required.

   Endpoints
     GET  /snapshot      → live array the dashboard reads
     GET  /health        → uptime + provider + last refresh
     GET  /config        → current criteria + alert settings
     POST /config        → update criteria / thresholds / alerts
     GET  /signals       → recent fired signals (audit log)

   Provider is chosen by env PROVIDER=yahooDelayed | kite
   ================================================================ */
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { yahooDelayed } from "./providers/yahooDelayed.js";
import { stooqEod } from "./providers/stooqEod.js";
import { kite } from "./providers/kite.js";
import { evaluate } from "./lib/engine.js";
import { notify } from "./lib/alerts.js";
import { cachedForecasts, ensureForecasts, mergeForecasts } from "./lib/oracle.js";
import { startKeepAlive } from "./lib/keepalive.js";
import { fetchFundamentals } from "./lib/fundamentals.js";
import { METRIC_KEYS } from "./fundamentals.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8"));

const PROVIDER = process.env.PROVIDER || "stooqEod";
const REFRESH_MS = +(process.env.REFRESH_MS || 60_000);
const FUNDAMENTALS = read("fundamentals.json");

// The universe is editable from the dashboard. A runtime copy wins over the
// committed list when present; same ephemeral caveat as config.json — Render
// free wipes it on redeploy and the UI re-pushes.
const UNIVERSE_PATH = path.join(__dirname, "universe.runtime.json");
const MAX_SYMBOLS = 200;
const SYMBOL_RE = /^[A-Z0-9&-]+$/; // NSE symbol charset
let SYMBOLS = fs.existsSync(UNIVERSE_PATH) ? read("universe.runtime.json") : read("universe.json");

// One normalizer behind every /universe endpoint: trim, uppercase, drop
// anything off-charset, dedupe, cap. Order of first appearance is kept.
function cleanSymbols(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw ?? "").trim().toUpperCase();
    if (!s || !SYMBOL_RE.test(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= MAX_SYMBOLS) break;
  }
  return out;
}

SYMBOLS = cleanSymbols(SYMBOLS); // a hand-edited file gets the same treatment
const saveUniverse = () => { try { fs.writeFileSync(UNIVERSE_PATH, JSON.stringify(SYMBOLS, null, 2)); } catch {} };

// Scraped fundamentals, cached because they only move quarterly. The committed
// fundamentals.json stays as the durable seed underneath — same ephemeral
// caveat as the universe on Render free.
const FUND_CACHE_PATH = path.join(__dirname, "fundamentals.cache.json");
const FUND_FIELDS = METRIC_KEYS; // the catalog decides, not this file
let fundCache = fs.existsSync(FUND_CACHE_PATH) ? read("fundamentals.cache.json") : {};
const saveFundCache = () => { try { fs.writeFileSync(FUND_CACHE_PATH, JSON.stringify(fundCache, null, 2)); } catch {} };

// The engine reads this merged view: a scraped value wins, and the hand-entered
// seed fills any field the scrape could not establish. Status always reports
// what the scrape actually managed, so a stock is never silently "complete".
// Seed-only records are tagged so the engine can refuse to lock on them and the
// UI can say where the numbers came from. A scrape has never confirmed these.
const fundFor = sym => {
  const cached = fundCache[sym], seed = FUNDAMENTALS[sym];
  if (!cached) return seed ? { ...seed, status: "seed", source: "committed seed" } : null;
  const merged = { ...(seed || {}) };
  for (const f of FUND_FIELDS) if (cached[f] != null) merged[f] = cached[f];
  return { ...merged, status: cached.status, source: cached.source, fetchedAt: cached.fetchedAt };
};

// Cache only the metric values plus provenance — `missing` is derivable.
const strip = r => ({
  ...Object.fromEntries(METRIC_KEYS.map(k => [k, r[k] ?? null])),
  status: r.status, source: r.source, fetchedAt: r.fetchedAt,
});
const fundInflight = new Set();

// A record written before a metric was added to the catalog simply lacks that
// key — and would otherwise be cached forever, so every criterion on the new
// metric reads "no data" for as long as the cache survives. An ABSENT key means
// never scraped for it; a present null means scraped and genuinely unavailable.
// Only the former is stale, so this re-scrapes once after a catalog change and
// then goes quiet.
const isStale = rec => METRIC_KEYS.some(k => !(k in rec));

// Queued and paced, for the same reason /fundamentals/refresh-all is: a burst
// of parallel scrapes is how you get blocked. One stale symbol is a trickle,
// but a catalog change marks the whole universe stale at once — on a 22-name
// list that would be ~44 requests across two sites in the same second.
const fundQueue = [];
let fundDraining = false;
const FUND_GAP_MS = 1_000;

// Fire-and-forget: adding a symbol must not wait on a scrape.
function ensureFundamentals(symbols) {
  for (const s of symbols) {
    if ((fundCache[s] && !isStale(fundCache[s])) || fundInflight.has(s) || fundQueue.includes(s)) continue;
    fundQueue.push(s);
  }
  drainFundQueue(); // deliberately not awaited
}

async function drainFundQueue() {
  if (fundDraining) return;
  fundDraining = true;
  try {
    while (fundQueue.length) {
      const s = fundQueue.shift();
      fundInflight.add(s);
      try {
        const rec = await fetchFundamentals(s);
        fundCache[s] = strip(rec); saveFundCache();
        applyFund([s]);
        console.log(`[fundamentals] ${s}: ${rec.status}${rec.source ? " via " + rec.source : ""}${rec.missing.length ? " · missing " + rec.missing.join(",") : ""}`);
      } catch (e) {
        console.warn(`[fundamentals] ${s}: ${e.message}`);
      } finally {
        fundInflight.delete(s);
      }
      if (fundQueue.length) await new Promise(r => setTimeout(r, FUND_GAP_MS));
    }
  } finally {
    fundDraining = false;
  }
}

const providers = { stooqEod, yahooDelayed, kite };
const provider = providers[PROVIDER];
if (!provider) throw new Error(`Unknown PROVIDER "${PROVIDER}"`);

// Config is persisted to disk so it survives restarts. On ephemeral
// hosts (Render free) it resets on redeploy — the UI re-pushes it.
const CONFIG_PATH = path.join(__dirname, "config.json");
let config = fs.existsSync(CONFIG_PATH) ? read("config.json") : read("config.default.json");
const saveConfig = () => { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch {} };

/* Telegram credentials from the environment are the durable default. The
   dashboard's "Save to backend" writes only to this instance, so a redeploy on
   an ephemeral host wipes them and alerts stop without saying so. Env values
   are seeded at startup and win over anything on disk; a POST still overrides
   them for the life of the process, and the next restart falls back to env. */
const envTelegram = () => {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  return token && chatId ? { on: true, token, chatId } : null;
};

const seededTelegram = envTelegram();
if (seededTelegram) config = { ...config, alerts: { ...config.alerts, telegram: seededTelegram } };
const tg = config.alerts?.telegram;
console.log(
  `[alerts] telegram: ${seededTelegram ? "from env"
    : tg?.token && tg?.chatId ? "from saved config"
    : "awaiting config"}`
);

/* The bot token is a credential — and since it can now come from the server's
   own environment, it is a secret the operator never handed to the browser.
   /config is what the dashboard reads to render its settings, so it returns
   proof-of-configuration instead of the values themselves. */
const MASK = "••••";
const maskTail = v => (v ? MASK + String(v).slice(-4) : "");
const isMasked = v => typeof v === "string" && v.startsWith(MASK);
const blank = v => v === undefined || v === null || v === "" || isMasked(v);

function publicConfig() {
  const t = config.alerts?.telegram || {};
  const configured = !!(t.token && t.chatId);
  return {
    ...config,
    alerts: {
      ...config.alerts,
      telegram: {
        on: !!t.on,
        configured,
        tokenMasked: maskTail(t.token),
        chatIdMasked: maskTail(t.chatId),
        source: configured ? (seededTelegram && t.token === seededTelegram.token ? "env" : "saved") : "none",
      },
    },
  };
}

/* A POST may echo back the mask it was given, or carry empty inputs from a
   panel that never loaded the credentials in the first place. Neither is an
   instruction to erase what is stored: only a real new value replaces it.
   A request carrying no credential at all is a criteria sync, so its `on` is
   ignored too — otherwise syncing criteria would silently disarm a channel
   configured from the environment. */
function mergeTelegram(cur = {}, next = {}) {
  const token = blank(next.token) ? cur.token || "" : String(next.token).trim();
  const chatId = blank(next.chatId) ? cur.chatId || "" : String(next.chatId).trim();
  const carriesCreds = !blank(next.token) || !blank(next.chatId);
  const on = carriesCreds && next.on !== undefined ? !!next.on : !!cur.on;
  return { on, token, chatId };
}

let snapshot = { at: 0, data: [] };
let signalLog = [];
const firedToday = new Set();
let lastDay = new Date().toDateString();

// A scrape lands between refresh ticks. Without this the served snapshot keeps
// the pre-scrape numbers for up to REFRESH_MS while the status already reads
// "complete" — the UI would show fresh provenance over stale values.
function applyFund(symbols) {
  if (!snapshot.data.length) return;
  const touched = new Set(symbols);
  snapshot = { ...snapshot, data: snapshot.data.map(q => touched.has(q.symbol) ? { ...q, fund: fundFor(q.symbol) } : q) };
  scan(); // fresher fundamentals can lock or unlock a gate
}

async function refresh() {
  // reset the per-day dedupe at date rollover
  const today = new Date().toDateString();
  if (today !== lastDay) { firedToday.clear(); lastDay = today; }

  try {
    const quotes = await provider(SYMBOLS);
    // Merge whatever forecasts are known now — a sleeping Oracle must never
    // hold up a market refresh. The fetch runs in the background and re-merges
    // into the published snapshot the moment it lands.
    const enriched = mergeForecasts(quotes, cachedForecasts());
    snapshot = { at: Date.now(), data: enriched.map(q => ({ ...q, fund: fundFor(q.symbol) })) };
    const withFcst = snapshot.data.filter(q => q.fcst).length;
    console.log(`[trinetra] ${snapshot.data.length} symbols via ${PROVIDER} · ${withFcst} with a forecast`);
    scan();
    ensureForecasts(SYMBOLS, applyForecasts);
  } catch (e) {
    console.error("[trinetra] refresh failed:", e.message);
  }
}

// Forecasts arriving between refresh ticks re-merge into the live snapshot, so
// /snapshot reflects them immediately rather than at the next cycle.
function applyForecasts(forecasts) {
  if (!snapshot.data.length) return;
  snapshot = { ...snapshot, data: mergeForecasts(snapshot.data, forecasts) };
  const withFcst = snapshot.data.filter(q => q.fcst).length;
  console.log(`[oracle] merged into snapshot · ${withFcst}/${snapshot.data.length} stocks carry an fcst`);
  scan(); // a forecast can complete a confluence
}

function scan() {
  for (const s of snapshot.data) {
    const ev = evaluate(s, config.criteria);
    if (ev.locked && !firedToday.has(s.symbol)) {
      firedToday.add(s.symbol);
      const entry = {
        symbol: s.symbol, name: s.name, price: s.price,
        volX: +ev.volX.toFixed(1), dayChg: +ev.dayChg.toFixed(1),
        count: ev.count, total: ev.total, at: Date.now(),
      };
      signalLog = [entry, ...signalLog].slice(0, 100);
      if (config.alerts?.telegram?.on) {
        notify(config.alerts.telegram, entry).catch(e => console.error("[alert]", e.message));
      }
    }
  }
}

const app = express();
/* CORS applies to every route below, so the write endpoints (/config,
   /universe, /fundamentals) are restricted by the same rule as the reads.
   A comma-separated list is accepted for a staging origin alongside production. */
const UI_ORIGIN = (process.env.UI_ORIGIN || "*").trim();
const corsOrigin = UI_ORIGIN === "*"
  ? "*"
  : UI_ORIGIN.split(",").map(o => o.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigin }));
console.log(`[cors] ${UI_ORIGIN === "*"
  ? "open to any origin — set UI_ORIGIN to your dashboard origin in production"
  : "restricted to " + [].concat(corsOrigin).join(", ")}`);
app.use(express.json());

app.get("/health", (_, res) =>
  res.json({ ok: true, provider: PROVIDER, lastRefresh: snapshot.at, symbols: snapshot.data.length, delayed: PROVIDER === "yahooDelayed" }));

app.get("/snapshot", (_, res) =>
  res.json({ asOf: snapshot.at, provider: PROVIDER, delayed: PROVIDER === "yahooDelayed", data: snapshot.data }));

app.get("/signals", (_, res) => res.json(signalLog));

app.get("/universe", (_, res) => res.json({ symbols: SYMBOLS }));

// Replace the whole list. An empty array is legal — that is "Clear all".
app.post("/universe", (req, res) => {
  if (!Array.isArray(req.body?.symbols)) return res.status(400).json({ error: "symbols must be an array" });
  const before = new Set(SYMBOLS);
  SYMBOLS = cleanSymbols(req.body.symbols);
  saveUniverse();
  ensureFundamentals(SYMBOLS.filter(s => !before.has(s)));
  refresh(); // not awaited — the caller gets the list now, quotes land next tick
  res.json({ symbols: SYMBOLS });
});

app.post("/universe/add", (req, res) => {
  const [symbol] = cleanSymbols([req.body?.symbol]);
  if (!symbol) return res.status(400).json({ error: "invalid symbol" });
  if (!SYMBOLS.includes(symbol)) {
    if (SYMBOLS.length >= MAX_SYMBOLS) return res.status(400).json({ error: `universe is full (max ${MAX_SYMBOLS})` });
    SYMBOLS = [...SYMBOLS, symbol];
    saveUniverse();
    ensureFundamentals([symbol]);
    refresh();
  }
  res.json({ symbols: SYMBOLS });
});

app.post("/universe/remove", (req, res) => {
  const [symbol] = cleanSymbols([req.body?.symbol]);
  if (!symbol) return res.status(400).json({ error: "invalid symbol" });
  if (SYMBOLS.includes(symbol)) {
    SYMBOLS = SYMBOLS.filter(s => s !== symbol);
    saveUniverse();
  }
  res.json({ symbols: SYMBOLS });
});

app.post("/universe/bulk-add", (req, res) => {
  if (!Array.isArray(req.body?.symbols)) return res.status(400).json({ error: "symbols must be an array" });
  const had = new Set(SYMBOLS);
  const before = SYMBOLS.length;
  // Existing symbols go first, so an over-cap paste is what gets dropped.
  SYMBOLS = cleanSymbols([...SYMBOLS, ...cleanSymbols(req.body.symbols)]);
  const added = SYMBOLS.length - before;
  if (added) { saveUniverse(); ensureFundamentals(SYMBOLS.filter(s => !had.has(s))); refresh(); }
  res.json({ symbols: SYMBOLS, added, skipped: req.body.symbols.length - added });
});

app.post("/universe/bulk-remove", (req, res) => {
  if (!Array.isArray(req.body?.symbols)) return res.status(400).json({ error: "symbols must be an array" });
  const drop = new Set(cleanSymbols(req.body.symbols));
  const before = SYMBOLS.length;
  SYMBOLS = SYMBOLS.filter(s => !drop.has(s));
  const removed = before - SYMBOLS.length;
  if (removed) saveUniverse();
  res.json({ symbols: SYMBOLS, removed });
});

app.get("/fundamentals", (_, res) => res.json(fundCache));

app.post("/fundamentals/refresh", async (req, res) => {
  const [symbol] = cleanSymbols([req.body?.symbol]);
  if (!symbol) return res.status(400).json({ error: "invalid symbol" });
  const rec = await fetchFundamentals(symbol);
  fundCache[symbol] = strip(rec);
  saveFundCache();
  applyFund([symbol]);
  res.json(fundCache[symbol]);
});

// Sequential and paced — a burst of parallel scrapes is how you get blocked.
// Note this responds only when the whole universe is done (~1s per symbol).
app.post("/fundamentals/refresh-all", async (_, res) => {
  const summary = { refreshed: 0, partial: 0, unavailable: 0 };
  for (const s of SYMBOLS) {
    const rec = await fetchFundamentals(s);
    fundCache[s] = strip(rec);
    if (rec.status === "fetched") summary.refreshed++;
    else if (rec.status === "partial") summary.partial++;
    else summary.unavailable++;
    saveFundCache();
    applyFund([s]);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`[fundamentals] refresh-all: ${JSON.stringify(summary)}`);
  res.json(summary);
});

app.get("/config", (_, res) => res.json(publicConfig()));
app.post("/config", (req, res) => {
  const { criteria, alerts } = req.body || {};
  if (Array.isArray(criteria)) config.criteria = criteria;
  if (alerts) {
    config.alerts = {
      ...config.alerts, ...alerts,
      telegram: mergeTelegram(config.alerts?.telegram, alerts.telegram),
    };
  }
  saveConfig();
  scan(); // re-evaluate immediately against the new rules
  res.json({ ok: true, config: publicConfig() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[trinetra] listening :${PORT} · provider=${PROVIDER}`);
  await refresh();
  // Anything still on seed values gets scraped now, so an unverified gate is a
  // state the instrument passes through rather than one it sits in.
  ensureFundamentals(SYMBOLS);
  setInterval(refresh, REFRESH_MS);
  // Only on hosts that sleep on idle — unset SELF_URL leaves everything as-is.
  if (process.env.SELF_URL) startKeepAlive(process.env.SELF_URL);
});
