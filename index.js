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
import {
  DEFAULT_GROUP, cleanName, migrate as migrateGroups, union as unionGroups,
  groupsFor, counts as groupCounts,
} from "./lib/watchlists.js";
import * as history from "./lib/history.js";
import * as paper from "./lib/paper.js";
import * as ipo from "./lib/ipo.js";

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
const RAW_UNIVERSE = fs.existsSync(UNIVERSE_PATH) ? read("universe.runtime.json") : read("universe.json");

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

/* Watchlists. The engine scans the union of every group — a symbol in any list
   is watched once — while groups are how the dashboard slices the view. A flat
   universe file migrates into "Default", and the /universe endpoints keep
   operating on that group, so the old shape keeps working. */
let GROUPS = migrateGroups(RAW_UNIVERSE, cleanSymbols);
let SYMBOLS = unionGroups(GROUPS, cleanSymbols);
const saveUniverse = () => { try { fs.writeFileSync(UNIVERSE_PATH, JSON.stringify({ groups: GROUPS }, null, 2)); } catch {} };

// Every mutation funnels through here: recompute the scan set, persist, and
// re-tag the live snapshot. Re-tagging matters even when no refresh follows —
// group membership is what the dashboard filters on, and leaving it a minute
// stale would show a symbol in the list it was just moved out of.
function commitGroups(refreshNow = true) {
  SYMBOLS = unionGroups(GROUPS, cleanSymbols);
  saveUniverse();
  if (snapshot.data.length) {
    snapshot = { ...snapshot, data: snapshot.data.map(q => ({ ...q, groups: groupsFor(GROUPS, q.symbol) })) };
  }
  if (refreshNow) refresh();
  return GROUPS;
}

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
    snapshot = {
      at: Date.now(),
      data: enriched.map(q => ({ ...q, fund: fundFor(q.symbol), groups: groupsFor(GROUPS, q.symbol) })),
    };
    const withFcst = snapshot.data.filter(q => q.fcst).length;
    console.log(`[trinetra] ${snapshot.data.length} symbols via ${PROVIDER} · ${withFcst} with a forecast`);
    scan();
    // Track record upkeep: what past signals did next, and where open bets stand.
    const priceBySymbol = Object.fromEntries(snapshot.data.map(q => [q.symbol, q.price]));
    history.markOutcomes(priceBySymbol);
    paper.markToMarket(priceBySymbol);
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
      // Durable record with the evidence at fire time — /signals is a live tail,
      // this is the thing the track record is computed from.
      const rec = history.recordSignal({
        symbol: s.symbol, name: s.name, price: s.price,
        groups: s.groups || [], evaluation: ev, at: entry.at,
      });
      entry.id = rec.id;
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

/* The /universe routes predate watchlists and stay pointed at the Default
   group, so anything that spoke the flat shape keeps working unchanged. They
   report the whole scan set, because that is what "the universe" still means. */
const group = name => (GROUPS[name] ||= []);
const universeResponse = () => ({ symbols: SYMBOLS, groups: groupCounts(GROUPS) });

app.get("/universe", (_, res) => res.json(universeResponse()));

// Replace the whole list. An empty array is legal — that is "Clear all".
app.post("/universe", (req, res) => {
  if (!Array.isArray(req.body?.symbols)) return res.status(400).json({ error: "symbols must be an array" });
  const before = new Set(SYMBOLS);
  GROUPS[DEFAULT_GROUP] = cleanSymbols(req.body.symbols);
  commitGroups(); // not awaited — the caller gets the list now, quotes land next tick
  ensureFundamentals(SYMBOLS.filter(s => !before.has(s)));
  res.json(universeResponse());
});

app.post("/universe/add", (req, res) => {
  const [symbol] = cleanSymbols([req.body?.symbol]);
  if (!symbol) return res.status(400).json({ error: "invalid symbol" });
  if (!SYMBOLS.includes(symbol)) {
    if (SYMBOLS.length >= MAX_SYMBOLS) return res.status(400).json({ error: `universe is full (max ${MAX_SYMBOLS})` });
    group(DEFAULT_GROUP).push(symbol);
    commitGroups();
    ensureFundamentals([symbol]);
  }
  res.json(universeResponse());
});

app.post("/universe/remove", (req, res) => {
  const [symbol] = cleanSymbols([req.body?.symbol]);
  if (!symbol) return res.status(400).json({ error: "invalid symbol" });
  // Removing from "the universe" means removing it everywhere — a symbol left
  // in another group would keep being scanned and look like it never left.
  for (const name of Object.keys(GROUPS)) GROUPS[name] = GROUPS[name].filter(s => s !== symbol);
  commitGroups(false);
  res.json(universeResponse());
});

app.post("/universe/bulk-add", (req, res) => {
  if (!Array.isArray(req.body?.symbols)) return res.status(400).json({ error: "symbols must be an array" });
  const had = new Set(SYMBOLS);
  const before = SYMBOLS.length;
  // Existing symbols go first, so an over-cap paste is what gets dropped.
  GROUPS[DEFAULT_GROUP] = cleanSymbols([...group(DEFAULT_GROUP), ...cleanSymbols(req.body.symbols)]);
  commitGroups(false);
  const added = SYMBOLS.length - before;
  if (added) { ensureFundamentals(SYMBOLS.filter(s => !had.has(s))); refresh(); }
  res.json({ ...universeResponse(), added, skipped: req.body.symbols.length - added });
});

app.post("/universe/bulk-remove", (req, res) => {
  if (!Array.isArray(req.body?.symbols)) return res.status(400).json({ error: "symbols must be an array" });
  const drop = new Set(cleanSymbols(req.body.symbols));
  const before = SYMBOLS.length;
  for (const name of Object.keys(GROUPS)) GROUPS[name] = GROUPS[name].filter(s => !drop.has(s));
  commitGroups(false);
  res.json({ ...universeResponse(), removed: before - SYMBOLS.length });
});

/* ── watchlists ──────────────────────────────────────────────────────────
   Groups slice the same scan set; they never widen or narrow what the engine
   watches beyond their union. */

app.get("/watchlists", (_, res) =>
  res.json({ groups: GROUPS, counts: groupCounts(GROUPS), total: SYMBOLS.length }));

app.post("/watchlists", (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: "invalid name" });
  if (GROUPS[name]) return res.status(409).json({ error: "watchlist already exists" });
  GROUPS[name] = [];
  commitGroups(false);
  res.json({ groups: GROUPS, counts: groupCounts(GROUPS) });
});

app.patch("/watchlists/:name", (req, res) => {
  const from = cleanName(req.params.name);
  const to = cleanName(req.body?.name);
  if (!GROUPS[from]) return res.status(404).json({ error: "no such watchlist" });
  if (!to) return res.status(400).json({ error: "invalid name" });
  if (to !== from && GROUPS[to]) return res.status(409).json({ error: "watchlist already exists" });
  if (to !== from) {
    // Rebuilt in order so a rename does not shuffle the dashboard's tabs.
    GROUPS = Object.fromEntries(Object.entries(GROUPS).map(([k, v]) => [k === from ? to : k, v]));
    commitGroups(false);
  }
  res.json({ groups: GROUPS, counts: groupCounts(GROUPS) });
});

app.delete("/watchlists/:name", (req, res) => {
  const name = cleanName(req.params.name);
  if (!GROUPS[name]) return res.status(404).json({ error: "no such watchlist" });
  // Refusing the last one keeps "where do symbols go" answerable at all times.
  if (Object.keys(GROUPS).length === 1) return res.status(400).json({ error: "cannot delete the last watchlist" });
  delete GROUPS[name];
  commitGroups(false); // symbols only in that list drop out of the scan set
  res.json({ groups: GROUPS, counts: groupCounts(GROUPS) });
});

app.post("/watchlists/:name/add", (req, res) => {
  const name = cleanName(req.params.name);
  if (!GROUPS[name]) return res.status(404).json({ error: "no such watchlist" });
  const add = cleanSymbols(req.body?.symbols ?? [req.body?.symbol]);
  if (!add.length) return res.status(400).json({ error: "symbols must be a non-empty array" });
  const had = new Set(SYMBOLS);
  GROUPS[name] = cleanSymbols([...GROUPS[name], ...add]);
  if (unionGroups(GROUPS, cleanSymbols).length > MAX_SYMBOLS)
    return res.status(400).json({ error: `universe is full (max ${MAX_SYMBOLS})` });
  commitGroups(false);
  const fresh = SYMBOLS.filter(s => !had.has(s));
  if (fresh.length) { ensureFundamentals(fresh); refresh(); }
  res.json({ groups: GROUPS, counts: groupCounts(GROUPS), added: add.length });
});

app.post("/watchlists/:name/remove", (req, res) => {
  const name = cleanName(req.params.name);
  if (!GROUPS[name]) return res.status(404).json({ error: "no such watchlist" });
  const drop = new Set(cleanSymbols(req.body?.symbols ?? [req.body?.symbol]));
  GROUPS[name] = GROUPS[name].filter(s => !drop.has(s));
  commitGroups(false);
  res.json({ groups: GROUPS, counts: groupCounts(GROUPS) });
});

app.post("/watchlists/:name/move", (req, res) => {
  const from = cleanName(req.params.name);
  const to = cleanName(req.body?.to);
  if (!GROUPS[from]) return res.status(404).json({ error: "no such watchlist" });
  if (!GROUPS[to]) return res.status(404).json({ error: "no such destination watchlist" });
  const move = cleanSymbols(req.body?.symbols ?? [req.body?.symbol]).filter(s => GROUPS[from].includes(s));
  if (!move.length) return res.status(400).json({ error: "no matching symbols in the source watchlist" });
  GROUPS[from] = GROUPS[from].filter(s => !move.includes(s));
  GROUPS[to] = cleanSymbols([...GROUPS[to], ...move]);
  commitGroups(false); // union is unchanged, so no rescan is needed
  res.json({ groups: GROUPS, counts: groupCounts(GROUPS), moved: move.length });
});

/* ── track record ────────────────────────────────────────────────────────
   Signals, what happened next, and whether the user's picking beat the raw
   system. The numbers are reported as they are; nothing here is smoothed. */

app.get("/signals/history", (req, res) =>
  res.json({ signals: history.list({ from: req.query.from, to: req.query.to }) }));

app.get("/signals/stats", (req, res) =>
  res.json(history.stats(Math.max(1, +req.query.days || 30))));

app.get("/paper-trades", (_, res) => res.json({ trades: paper.all() }));

app.post("/paper-trades", (req, res) => {
  const t = paper.open(req.body || {});
  if (!t) return res.status(400).json({ error: "symbol, entryPrice and qty are required" });
  paper.markToMarket(Object.fromEntries(snapshot.data.map(q => [q.symbol, q.price])));
  res.json(t);
});

app.patch("/paper-trades/:id", (req, res) => {
  const t = paper.update(req.params.id, req.body || {});
  if (!t) return res.status(404).json({ error: "no such trade" });
  res.json(t);
});

app.delete("/paper-trades/:id", (req, res) =>
  paper.remove(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: "no such trade" }));

app.get("/paper-trades/stats", (req, res) =>
  res.json(paper.stats(Math.max(1, +req.query.days || 30), history.all(), Math.max(1, +req.query.horizon || 7))));

app.get("/ipo-applications", (_, res) => res.json({ applications: ipo.all() }));

app.post("/ipo-applications", (req, res) => {
  const a = ipo.add(req.body || {});
  if (!a) return res.status(400).json({ error: "ipoName is required" });
  res.json(a);
});

app.patch("/ipo-applications/:id", (req, res) => {
  const a = ipo.update(req.params.id, req.body || {});
  if (!a) return res.status(404).json({ error: "no such application" });
  res.json(a);
});

app.delete("/ipo-applications/:id", (req, res) =>
  ipo.remove(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: "no such application" }));

app.get("/ipo-applications/stats", async (req, res) =>
  res.json(await ipo.stats(Math.max(1, +req.query.days || 365))));

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
