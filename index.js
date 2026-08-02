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
import { notify, notifyExit, notifyBrief } from "./lib/alerts.js";
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
import * as holdings from "./lib/holdings.js";
import * as events from "./lib/events.js";
import * as brief from "./lib/brief.js";
import { evaluateAll as evaluateExits, DEFAULT_RULES as EXIT_RULES } from "./lib/exits.js";
import { migrate as migrateProfiles, enabledProfiles, needsIntraday, cleanId, HORIZON_SESSIONS } from "./lib/profiles.js";
import { potential, confidence, exitLevels, atrPct } from "./lib/analysis.js";
import { derive as deriveIntraday } from "./lib/intraday.js";
import { suggest as suggestSize, concentration as computeConcentration, DEFAULT_SIZING } from "./lib/sizing.js";

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

/* Profiles replace the single criteria set. The old flat array migrates into
   Swing, so tuned thresholds and synced settings survive. */
config.profiles = migrateProfiles(config);
config.sizing = { ...DEFAULT_SIZING, ...(config.sizing || {}) };
config.exitRules = { ...EXIT_RULES, ...(config.exitRules || {}) };
config.briefTime = config.briefTime || "08:45";

const PROVIDER_LAG_S = { yahooDelayed: 900, stooqEod: 86_400, kite: 5 };
const FEED_DELAYED = PROVIDER !== "kite";

/* Data age travels with every snapshot and every signal. Intraday on a delayed
   feed is workable — you are trading what remains of a move — but only if the
   staleness is impossible to overlook. */
function dataAge() {
  const lagSeconds = PROVIDER_LAG_S[PROVIDER] ?? 900;
  return {
    seconds: snapshot.at ? Math.round((Date.now() - snapshot.at) / 1000) : null,
    lagSeconds,
    delayed: FEED_DELAYED,
    provider: PROVIDER,
    asOf: snapshot.at || null,
  };
}

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

/* Seeded from durable history, not empty. A free-tier instance sleeps and wakes
   many times a day; with an in-memory set, every wake would re-fire every
   currently-locked signal — duplicating alerts and inflating the very sample
   size the track record is measured on. */
const firedToday = new Set(
  history.all()
    .filter(r => new Date(r.firedAt).toDateString() === new Date().toDateString())
    .map(r => `${r.profileId || "swing"}:${r.symbol}`)
);
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
    const quotes = await provider(SYMBOLS, { intraday: needsIntraday(config.profiles) });
    // Merge whatever forecasts are known now — a sleeping Oracle must never
    // hold up a market refresh. The fetch runs in the background and re-merges
    // into the published snapshot the moment it lands.
    const enriched = mergeForecasts(quotes, cachedForecasts());
    snapshot = {
      at: Date.now(),
      data: enriched.map(q => ({
        ...q,
        fund: fundFor(q.symbol),
        groups: groupsFor(GROUPS, q.symbol),
        intraday: q.intradayBars ? deriveIntraday(q.intradayBars) : null,
        nextEvent: events.nextEvent(q.symbol),
      })),
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

/* The trigger level a setup qualified at — what "already moved" is measured
   against. Without it, movedAlready would be measured from an arbitrary point. */
function triggerFor(stock, profile) {
  switch (profile.horizon) {
    case "intraday": return stock.intraday?.orHigh ?? stock.dayOpen ?? stock.prevClose;
    case "positional": return stock.high50 ?? stock.high20;
    default: return stock.high20;
  }
}

/* Sortable summary: the four numbers a watchlist column needs, and nothing
   else. Cached per refresh — the analog scan is cheap but not free, and it
   would otherwise run once per profile per symbol per request. */
const decisionCache = new Map();
function decisionSummary(stock, profile, result) {
  const key = `${stock.symbol}:${profile.horizon}:${snapshot.at}`;
  if (decisionCache.has(key)) return decisionCache.get(key);
  if (decisionCache.size > 2000) decisionCache.clear();

  const ev = { criteria: result?.criteria || [] };
  const { potential: pot, confidence: conf, exits } = analyse(stock, profile, ev);
  const summary = {
    profileId: profile.horizon,
    confidence: conf ? { score: conf.score, band: conf.band, capped: (conf.caps || []).length > 0 } : null,
    // null rather than 0 when there is no estimate: "no view" and "no upside
    // left" are different claims and must sort differently.
    remainingMedianPct: pot?.remainingPct?.median ?? null,
    rrToPrimary: exits?.riskReward?.toPrimary ?? null,
    exhausted: !!pot?.exhausted,
    insufficientHistory: !!pot?.insufficientHistory,
    noEstimate: pot === null,
    analogsN: pot?.analogs?.n ?? null,
  };
  decisionCache.set(key, summary);
  return summary;
}

/** Everything A8 produces for one stock under one profile. */
function analyse(stock, profile, ev) {
  const pot = potential(stock, { horizon: profile.horizon, triggerPrice: triggerFor(stock, profile) });
  const conf = confidence(stock, { profile, evaluation: ev, pot, dataAge: dataAge(), event: stock.nextEvent });
  const exits = pot ? exitLevels(stock, { pot, conf, atr: atrPct(stock.candles) }) : null;
  return { potential: pot, confidence: conf, exits };
}

function scan() {
  const active = enabledProfiles(config.profiles);
  for (const s of snapshot.data) {
    const results = {};
    for (const [id, profile] of active) {
      const ev = evaluate(s, profile.criteria);
      results[id] = { count: ev.count, total: ev.total, locked: ev.locked, criteria: ev.criteria };

      const key = `${id}:${s.symbol}`;
      if (!ev.locked || firedToday.has(key)) continue;
      firedToday.add(key);

      const { potential: pot, confidence: conf, exits } = analyse(s, profile, ev);
      const age = dataAge();
      const event = s.nextEvent;
      const horizonDays = HORIZON_SESSIONS[profile.horizon] ?? 5;

      const entry = {
        symbol: s.symbol, name: s.name, price: s.price,
        profileId: id, profileName: profile.name, horizon: profile.horizon,
        volX: +(ev.volX || 0).toFixed(1), dayChg: +(ev.dayChg || 0).toFixed(1),
        count: ev.count, total: ev.total, at: Date.now(),
        dataAge: age,
        potential: pot, confidence: conf, exits,
        // Intraday on a delayed feed is the user's explicit choice. It is
        // supported — and it always says what it is.
        lagDisclosure: profile.horizon === "intraday" && age.delayed
          ? `Prices are ~${Math.round(age.lagSeconds / 60)} minutes delayed. This stock has already moved ${pot?.movedAlreadyPct >= 0 ? "+" : ""}${pot?.movedAlreadyPct ?? 0}% since the trigger level; the estimate below is what may remain, not the full move.`
          : null,
        eventWarning: event && event.daysAway <= 3
          ? `${event.type === "results" ? "Results" : event.type} due in ${event.daysAway} day${event.daysAway === 1 ? "" : "s"} — this signal carries binary event risk.`
          : null,
      };
      signalLog = [entry, ...signalLog].slice(0, 100);

      // Durable record with the evidence at fire time — /signals is a live tail,
      // this is the thing the track record is computed from.
      const rec = history.recordSignal({
        symbol: s.symbol, name: s.name, price: s.price,
        groups: s.groups || [], evaluation: ev, at: entry.at,
        profileId: id, horizon: profile.horizon,
        potential: pot, confidence: conf, exits, dataAge: age,
      });
      entry.id = rec.id;

      if (config.alerts?.telegram?.on && profile.alerts?.telegram !== false) {
        notify(config.alerts.telegram, entry).catch(e => console.error("[alert]", e.message));
      }
    }
    s.profileResults = results;
    // Flat list of the profiles this symbol currently satisfies — an "All
    // profiles" view needs this and nothing else.
    s.profilesLocked = Object.entries(results).filter(([, r]) => r.locked).map(([id]) => id);

    /* Compact decision summary per profile, so the watchlist can sort by
       confidence, remaining potential or risk-reward without a call per row.
       Deliberately NOT the full payload: the components, rationale and analog
       detail are heavy and only wanted when a row is opened, which is what
       /decision serves. */
    s.decisions = {};
    for (const [id, profile] of active) {
      const d = decisionSummary(s, profile, results[id]);
      if (d) s.decisions[id] = d;
    }
  }
  scanExits();
}

/* Exit signals are deduped per rule per holding: an alert that repeats every
   minute is one the user learns to ignore, which is the failure mode that
   matters most for the rule that concerns money already at risk. */
const exitAlerted = new Set();
let activeExits = [];

function scanExits() {
  const bySymbol = Object.fromEntries(snapshot.data.map(q => [q.symbol, q]));
  activeExits = evaluateExits(
    holdings.open(), bySymbol,
    h => {
      const p = config.profiles[h.profileId] || config.profiles.swing;
      const s = bySymbol[h.symbol];
      return s && p ? evaluate(s, p.criteria) : null;
    },
    config.exitRules
  );

  for (const e of activeExits) {
    if (exitAlerted.has(e.id)) continue;
    exitAlerted.add(e.id);
    if (config.alerts?.telegram?.on) {
      notifyExit(config.alerts.telegram, e).catch(err => console.error("[alert]", err.message));
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
  res.json({
    asOf: snapshot.at, provider: PROVIDER, delayed: FEED_DELAYED,
    dataAge: dataAge(),
    // The candle series is for server-side analysis only; shipping 250 bars per
    // symbol to the browser every few seconds would be pure weight.
    data: snapshot.data.map(({ candles, intradayBars, ...rest }) => rest),
  }));

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

/* ── profiles ────────────────────────────────────────────────────────────── */

app.get("/profiles", (_, res) => res.json({ profiles: config.profiles }));

app.post("/profiles", (req, res) => {
  const id = cleanId(req.body?.id || req.body?.name);
  if (!id) return res.status(400).json({ error: "invalid id" });
  if (config.profiles[id]) return res.status(409).json({ error: "profile already exists" });
  config.profiles[id] = {
    name: req.body?.name || id,
    horizon: req.body?.horizon || "swing",
    enabled: req.body?.enabled !== false,
    requiresLiveData: !!req.body?.requiresLiveData,
    alerts: req.body?.alerts || { telegram: true },
    criteria: Array.isArray(req.body?.criteria) ? req.body.criteria : [],
  };
  saveConfig(); scan();
  res.json({ profiles: config.profiles });
});

app.patch("/profiles/:id", (req, res) => {
  const p = config.profiles[cleanId(req.params.id)];
  if (!p) return res.status(404).json({ error: "no such profile" });
  for (const k of ["name", "horizon", "requiresLiveData"]) if (req.body?.[k] !== undefined) p[k] = req.body[k];
  if (req.body?.enabled !== undefined) p.enabled = !!req.body.enabled;
  if (req.body?.alerts) p.alerts = { ...p.alerts, ...req.body.alerts };
  if (Array.isArray(req.body?.criteria)) p.criteria = req.body.criteria;
  saveConfig(); scan();
  res.json({ profiles: config.profiles });
});

app.delete("/profiles/:id", (req, res) => {
  const id = cleanId(req.params.id);
  if (!config.profiles[id]) return res.status(404).json({ error: "no such profile" });
  if (Object.keys(config.profiles).length === 1) return res.status(400).json({ error: "cannot delete the last profile" });
  delete config.profiles[id];
  saveConfig(); scan();
  res.json({ profiles: config.profiles });
});

/* ── holdings & exits ────────────────────────────────────────────────────── */

const stockBySymbol = () => Object.fromEntries(snapshot.data.map(q => [q.symbol, q]));

app.get("/holdings", (_, res) => res.json({ holdings: holdings.all() }));

app.post("/holdings", (req, res) => {
  // One tap: { symbol } is enough. Entry price, the thesis and the levels the
  // exit rules need are all captured from the current snapshot.
  const sym = String(req.body?.symbol ?? "").trim().toUpperCase();
  const stock = stockBySymbol()[sym];
  const profileId = req.body?.profileId || "swing";
  const p = config.profiles[profileId];
  const ev = stock && p ? evaluate(stock, p.criteria) : null;
  const h = holdings.add({ ...req.body, profileId }, stock, ev);
  if (!h) return res.status(400).json({ error: "symbol required, and it must be in the watchlist or carry an entryPrice" });
  holdings.markToMarket(stockBySymbol());
  scanExits();
  res.json(h);
});

app.patch("/holdings/:id", (req, res) => {
  const h = holdings.update(req.params.id, req.body || {});
  if (!h) return res.status(404).json({ error: "no such holding" });
  scanExits();
  res.json(h);
});

app.delete("/holdings/:id", (req, res) =>
  holdings.remove(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: "no such holding" }));

/* `signals` is fired-only. Armed-but-unfired rules are a separate array, so a
   "trailing stop 1.2% away" can never be rendered with the same affordances as
   a rule that actually broke — the client should not have to remember to split
   on a flag to avoid offering "Mark closed" on a watch. */
app.get("/exit-signals", (_, res) =>
  res.json({
    signals: activeExits.filter(e => e.fired !== false),
    armed: activeExits.filter(e => e.fired === false),
    rules: config.exitRules,
    dataAge: dataAge(),
  }));

/* ── sizing & concentration ──────────────────────────────────────────────── */

app.get("/sizing/config", (_, res) => res.json(config.sizing));
app.post("/sizing/config", (req, res) => {
  for (const k of ["capital", "riskPerTradePct", "defaultStopPct", "sectorLimitPct"])
    if (req.body?.[k] !== undefined) config.sizing[k] = +req.body[k];
  saveConfig();
  res.json(config.sizing);
});

app.get("/sizing", (req, res) => {
  const sym = String(req.query.symbol ?? "").trim().toUpperCase();
  const entry = +req.query.entry || stockBySymbol()[sym]?.price;
  res.json(suggestSize({ entry, stop: +req.query.stop, ...config.sizing }));
});

app.get("/concentration", (_, res) =>
  res.json(computeConcentration(holdings.open(), stockBySymbol(), config.sizing)));

app.get("/events", (_, res) => res.json(events.allWithHealth()));

/* Aliases matching the dashboard's contract, so neither side has to rename a
   route it has already built against. Same handlers, different doors. */
app.post("/profiles/:id/criteria", (req, res) => {
  const p = config.profiles[cleanId(req.params.id)];
  if (!p) return res.status(404).json({ error: "no such profile" });
  if (!Array.isArray(req.body?.criteria)) return res.status(400).json({ error: "criteria must be an array" });
  p.criteria = req.body.criteria;
  saveConfig(); scan();
  res.json({ profiles: config.profiles });
});

app.post("/holdings/:id/dismiss", (req, res) => {
  const h = holdings.find(req.params.id);
  if (!h) return res.status(404).json({ error: "no such holding" });
  const rule = String(req.body?.rule ?? "").trim();
  if (!rule) return res.status(400).json({ error: "rule required" });
  const next = [...new Set([...(h.rulesDisabled || []), rule])];
  holdings.update(h.id, { rulesDisabled: next });
  scanExits();
  res.json({ ok: true, rulesDisabled: next });
});

/* The full decision surface for one symbol under one profile — what the detail
   drawer needs. Computed on demand rather than shipped for every row, since the
   components, rationale and analog detail are only wanted once something is
   opened. Works whether or not the profile is currently locked: the user asking
   "what would this be worth" deserves an answer before it fires. */
app.get("/decision", (req, res) => {
  const sym = String(req.query.symbol ?? "").trim().toUpperCase();
  const stock = stockBySymbol()[sym];
  if (!stock) return res.status(404).json({ error: "symbol not in the current snapshot" });
  const id = cleanId(req.query.profile || "swing");
  const profile = config.profiles[id];
  if (!profile) return res.status(404).json({ error: "no such profile" });

  const ev = evaluate(stock, profile.criteria);
  const { potential: pot, confidence: conf, exits } = analyse(stock, profile, ev);
  res.json({
    symbol: sym, profileId: id, profileName: profile.name, horizon: profile.horizon,
    price: stock.price,
    locked: ev.locked, count: ev.count, total: ev.total, criteria: ev.criteria,
    potential: pot, confidence: conf, exits,
    nextEvent: stock.nextEvent,
    dataAge: dataAge(),
    lagDisclosure: profile.horizon === "intraday" && FEED_DELAYED
      ? `Prices are ~${Math.round((PROVIDER_LAG_S[PROVIDER] ?? 900) / 60)} minutes delayed. This stock has already moved ${pot?.movedAlreadyPct >= 0 ? "+" : ""}${pot?.movedAlreadyPct ?? 0}% since the trigger level; the estimate below is what may remain, not the full move.`
      : null,
  });
});

app.get("/settings/sizing", (_, res) => res.json(config.sizing));
app.post("/settings/sizing", (req, res) => {
  for (const k of ["capital", "riskPerTradePct", "defaultStopPct", "sectorLimitPct"])
    if (req.body?.[k] !== undefined) config.sizing[k] = +req.body[k];
  saveConfig();
  res.json(config.sizing);
});

/* ── morning brief ───────────────────────────────────────────────────────── */

async function buildBrief() {
  const age = dataAge();
  let ipos = [];
  try {
    const url = process.env.PRAVESH_DATA_URL;
    if (url) {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const j = await r.json();
        const rows = Array.isArray(j) ? j : j.ipos || j.data || [];
        const soon = Date.now() + 2 * 86_400_000;
        ipos = rows.filter(x => {
          const close = Date.parse(x.closeDate || x.close_date || "");
          return Number.isFinite(close) && close >= Date.now() - 86_400_000 && close <= soon;
        }).map(x => ({ name: x.name || x.ipoName, verdict: x.verdict || x.call, closeDate: x.closeDate || x.close_date }));
      }
    }
  } catch { /* degrade silently — the brief is still worth sending */ }

  return brief.build({
    signals: history.all(),
    holdings: holdings.open(),
    exitSignals: activeExits,
    events: events.upcoming(SYMBOLS, 3),
    concentration: computeConcentration(holdings.open(), stockBySymbol(), config.sizing),
    ipos,
    profiles: config.profiles,
    dataHealth: {
      provider: PROVIDER, delayed: age.delayed, lagSeconds: age.lagSeconds,
      ageSeconds: age.seconds, lastRefresh: snapshot.at,
      symbols: snapshot.data.length, expected: SYMBOLS.length,
      failures: Math.max(0, SYMBOLS.length - snapshot.data.length),
    },
  });
}

app.get("/brief", async (_, res) => res.json(await buildBrief()));

app.post("/brief/send", async (_, res) => {
  const b = await buildBrief();
  const ok = await notifyBrief(config.alerts?.telegram, brief.renderTelegram(b));
  res.json({ ok });
});

/* Scheduled brief. Timezone-correct IST, same approach as the keep-alive: the
   server clock is UTC on Render, so local time is never trusted. Fires once per
   weekday within the minute the user configured. */
let lastBriefDay = "";
function briefTick() {
  if (!isFinite(Date.now())) return;
  if (!brief.isWeekday()) return;
  const [hh, mm] = String(config.briefTime || "08:45").split(":").map(Number);
  const target = (hh || 8) * 60 + (mm || 45);
  const now = brief.istMinutes();
  const day = brief.istNow().toISOString().slice(0, 10);
  if (day === lastBriefDay || now < target || now > target + 5) return;
  lastBriefDay = day;
  buildBrief()
    .then(b => notifyBrief(config.alerts?.telegram, brief.renderTelegram(b)))
    .then(ok => console.log(`[brief] ${config.briefTime} IST brief ${ok ? "sent" : "not sent (no telegram configured)"}`))
    .catch(e => console.warn("[brief]", e.message));
}

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
  events.ensureEvents(SYMBOLS); // best-effort, paced, never blocks
  setInterval(refresh, REFRESH_MS);
  setInterval(briefTick, 60_000);
  setInterval(() => events.ensureEvents(SYMBOLS), 6 * 3_600_000);

  const active = enabledProfiles(config.profiles).map(([id, p]) => `${p.name}${p.horizon === "intraday" ? "*" : ""}`);
  console.log(`[profiles] ${active.join(", ")} (${active.length} enabled)`);
  const intraday = enabledProfiles(config.profiles).find(([, p]) => p.horizon === "intraday");
  if (intraday) {
    console.log(`[profiles] intraday: active · feed ${FEED_DELAYED ? `lag ~${Math.round((PROVIDER_LAG_S[PROVIDER] ?? 900) / 60)}m (delayed) — confidence capped at 55` : "live"}`);
  }
  console.log(`[brief] scheduled ${config.briefTime} IST on weekdays`);

  // Only on hosts that sleep on idle — unset SELF_URL leaves everything as-is.
  if (process.env.SELF_URL) startKeepAlive(process.env.SELF_URL);
});
