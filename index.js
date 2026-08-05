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
import crypto from "crypto";
import { fileURLToPath } from "url";
import { yahooDelayed } from "./providers/yahooDelayed.js";
import { stooqEod } from "./providers/stooqEod.js";
import { kite } from "./providers/kite.js";
import { evaluate } from "./lib/engine.js";
import { notify, notifyExit, notifyBrief, notifyCycle } from "./lib/alerts.js";
import { digestLine } from "./lib/alertFormat.js";
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
import { migrate as migrateProfiles, enabledProfiles, needsIntraday, cleanId, HORIZON_SESSIONS,
         CANONICAL_CRITERIA, matchesCanonical, DATALESS_CRITERIA, originalFourStatus } from "./lib/profiles.js";
import { potential, confidence, exitLevels, atrPct } from "./lib/analysis.js";
import { derive as deriveIntraday } from "./lib/intraday.js";
import { suggest as suggestSize, concentration as computeConcentration, DEFAULT_SIZING } from "./lib/sizing.js";
import * as gate from "./lib/alertgate.js";
import * as analysts from "./lib/analysts.js";
import * as pravesh from "./lib/praveshTrigger.js";
import * as cycle from "./lib/cycle.js";
import { resistanceAbove } from "./lib/analysis.js";
import { trendIntact as trendOf } from "./lib/indicators.js";
import { analyse as analyseCandlesFor } from "./lib/candles.js";
import { candidates as levelCandidatesFor } from "./lib/levels.js";
import { build as buildPlaybook } from "./lib/playbook.js";
import { fetchIndices, INDICES } from "./lib/nseIndices.js";
import * as remote from "./lib/remoteStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8"));

const PROVIDER = process.env.PROVIDER || "stooqEod";
const REFRESH_MS = +(process.env.REFRESH_MS || 60_000);
const FUNDAMENTALS = read("fundamentals.json");

// The universe is editable from the dashboard. A runtime copy wins over the
// committed list when present; same ephemeral caveat as config.json — Render
// free wipes it on redeploy and the UI re-pushes.
const UNIVERSE_PATH = path.join(__dirname, "universe.runtime.json");
/* The cap exists to stop a paste-accident, not to limit the universe. Set high
   deliberately: the binding constraint at this scale is not the cap, it is how
   long a serial pass over the free feed takes (~0.5s/symbol) and how much
   candle history fits in Render free's 512 MB. Both are reported by
   /universe/indices and /health rather than enforced as a hidden ceiling. */
const MAX_SYMBOLS = 1000;
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
const saveUniverse = () => {
  try {
    fs.writeFileSync(UNIVERSE_PATH, JSON.stringify({ groups: GROUPS }, null, 2));
    // The edited symbol list is the thing most obviously lost on a redeploy.
    remote.markDirty("universe.runtime.json");
  } catch {}
};

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
const saveFundCache = () => {
  try {
    fs.writeFileSync(FUND_CACHE_PATH, JSON.stringify(fundCache, null, 2));
    remote.markDirty("fundamentals.cache.json");
  } catch {}
};

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
const saveConfig = () => {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    // Criteria, thresholds, sizing and exit rules are hand-tuned and worth
    // keeping. The Telegram token in here is stripped before it is ever encoded.
    remote.markDirty("config.json");
  } catch {}
};

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
config.alertLimits = { ...gate.DEFAULT_ALERT_LIMITS, ...(config.alertLimits || {}) };

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

/* Yahoo's daily bar reports volume ACCUMULATED SO FAR, so mid-session it holds a
   fraction of a day. Comparing that against a 20-day full-day average made the
   volume criterion unreachable until near the close — the single reason the eye
   was not opening. This pro-rates by how much of the session has elapsed, so a
   3x threshold means 3x the pace rather than 3x the whole day by lunchtime. */
function volumePace(q) {
  const IST = 5.5 * 3600e3;
  const now = new Date(Date.now() + IST);
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const OPEN = 9 * 60 + 15, CLOSE = 15 * 60 + 30;
  const lastBar = q.candles?.at(-1);
  const barIsToday = lastBar && new Date(lastBar.t + IST).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  const inSession = mins >= OPEN && mins <= CLOSE && now.getUTCDay() !== 0 && now.getUTCDay() !== 6;

  if (!q.avgVol20) return { sessionFraction: null, volPaceMultiple: null, volumeIsPartial: false };
  const raw = q.volToday / q.avgVol20;
  if (!inSession || !barIsToday) {
    // A completed session compares like with like already.
    return { sessionFraction: 1, volPaceMultiple: +raw.toFixed(3), volumeIsPartial: false };
  }
  const frac = Math.max(0.05, Math.min(1, (mins - OPEN) / (CLOSE - OPEN)));
  return {
    sessionFraction: +frac.toFixed(3),
    volPaceMultiple: +(raw / frac).toFixed(3),
    volumeRawMultiple: +raw.toFixed(3),
    volumeIsPartial: true,
  };
}

/* A full pass is roughly half a second per symbol against the free feed, so a
   300-name universe takes minutes — longer than the refresh interval. Without a
   guard the passes stack, each one competing for the same rate limit and none of
   them finishing. Skipped rather than queued: the next tick is seconds away, and
   a queue of stale passes is worth nothing. */
let refreshing = false;
let skippedRefreshes = 0;

async function refresh() {
  if (refreshing) {
    if (++skippedRefreshes % 10 === 1) {
      console.warn(`[refresh] previous pass still running — skipped (${skippedRefreshes} so far). ${SYMBOLS.length} symbols at ~0.5s each needs REFRESH_MS above ${Math.ceil(SYMBOLS.length * 0.6 / 10) * 10_000}.`);
    }
    return;
  }
  refreshing = true;
  try { return await refreshOnce(); } finally { refreshing = false; }
}

async function refreshOnce() {
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
        ...volumePace(q),
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
    // Broker calls are scored against what price actually did, not what was
    // claimed — resolution needs the price series, which only exists here.
    for (const q of snapshot.data) analysts.resolveCalls(q.symbol, q.candles);
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
  const limits = config.alertLimits;
  const now = Date.now();

  /* Delivery is gated; recording is not. Every signal still reaches the track
     record — suppressing an alert is a statement about when the user can act,
     not about what happened. */
  const override = process.env.ALERT_HOURS_OVERRIDE === "true";
  const win = gate.marketWindow(now, limits);
  const windowOpen = win.open || override;
  const snapshotAgeMin = snapshot.at ? (now - snapshot.at) / 60_000 : Infinity;
  const stale = snapshotAgeMin > (limits.staleAfterMinutes ?? 10);
  const tally = { candidates: 0, sent: 0, suppressed: {} };
  const suppress = reason => { tally.suppressed[reason] = (tally.suppressed[reason] || 0) + 1; };
  // Collected per symbol, so one stock locking three profiles is one alert.
  const pending = [];

  for (const s of snapshot.data) {
    const results = {};
    const newlyLocked = [];
    for (const [id, profile] of active) {
      const ev = evaluate(s, profile.criteria);
      /* lockQuality belongs here, not only on a fired signal. A stock that is
         locked-but-partial right now — or whose fundamentals could not be
         evaluated — is in that state whether or not a signal fired today, and a
         watchlist that can only learn it from /signals cannot show the live
         picture at all. */
      results[id] = {
        count: ev.count, total: ev.total, locked: ev.locked, criteria: ev.criteria,
        lockQuality: ev.lockQuality, lockedOn: ev.lockedOn, notEvaluated: ev.notEvaluated,
        warnings: ev.warnings,
      };

      // Edge, not level: fire when it BECOMES locked. A level test stays true
      // all evening once the tape stops, which is what caused the repeats.
      const becameLocked = gate.isNewLock(s.symbol, id, ev.locked);
      const key = `${id}:${s.symbol}`;
      if (!ev.locked || firedToday.has(key)) continue;
      if (!becameLocked) continue;
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
        lockQuality: ev.lockQuality, lockedOn: ev.lockedOn, notEvaluated: ev.notEvaluated,
        criteriaWarnings: ev.warnings,
        // The criteria block in the alert needs the values that made each check
        // pass, not just the criterion names.
        criteriaDetail: ev.criteria,
        /* Every existing criterion detects upward setups — a breakout above the
           20-day high, volume expansion on strength, buyer-side flow. There is
           no bearish screening, so nothing here can produce "sell". The field
           exists because the SELL rendering path is built and waiting; it is not
           inferred by inverting a bullish signal. */
        direction: "buy",
        entryPrice: pot?.triggerPrice ?? null,
        exitPrice: exits?.primary?.price ?? null,
        potentialLeftPct: exits?.primary?.pct ?? null,
        appUrl: process.env.APP_URL || null,
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

      // A profile can be scanned but kept silent — useful while validating
      // Intraday without being paged by it.
      if (profile.alerts?.telegram !== false) newlyLocked.push({ profile, entry });
    }

    if (newlyLocked.length) {
      tally.candidates++;
      // Best evidence first, so a combined alert leads with the strongest leg.
      newlyLocked.sort((a, b) => (b.entry.confidence?.score ?? 0) - (a.entry.confidence?.score ?? 0));
      pending.push({ symbol: s.symbol, legs: newlyLocked, price: s.price, volume: s.volToday });
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

  deliver(pending, { windowOpen, win, stale, snapshotAgeMin, limits, tally, now });
  scanExits(windowOpen);
  scanCycles();
}

/* Everything between "a signal happened" and "the user's phone buzzes".
   Recording already happened above; nothing here can change the track record. */
function deliver(pending, { windowOpen, win, stale, snapshotAgeMin, limits, tally, now }) {
  const tg = config.alerts?.telegram;
  const armed = !!tg?.on;

  const MIN_POTENTIAL_PCT = +(process.env.MIN_POTENTIAL_PCT ?? 5);
  const sendable = [];
  for (const p of pending) {
    /* Actionability gate. A setup with 2% left is not worth a notification, and
       an alert that cannot be acted on teaches the user to ignore the ones that
       can. Delivery only — the signal is already in history above, so the track
       record stays complete either way. When potential cannot be computed the
       alert still goes: the criteria lock is real information, and the message
       says "not established" rather than implying a number. */
    const left = p.legs[0].entry.potentialLeftPct;
    if (left != null && left < MIN_POTENTIAL_PCT) { suppressInto(tally, `potential < ${MIN_POTENTIAL_PCT}%`); continue; }
    if (!windowOpen) { suppressInto(tally, win.reason || "outside market hours"); continue; }
    if (stale) { suppressInto(tally, "stale snapshot"); continue; }
    // A tape that has not moved carries no new information, whatever the
    // criteria say about it.
    if (!gate.inputsChanged(p.symbol, p.price, p.volume)) { suppressInto(tally, "unchanged inputs"); continue; }
    const block = gate.deliveryBlock(p.symbol, now, limits);
    if (block) { suppressInto(tally, block); continue; }
    sendable.push(p);
  }

  // A flood is worse than a summary: past the per-cycle cap the rest become one
  // line rather than fifteen notifications nobody reads.
  const cap = limits.maxPerCycle ?? 5;
  const send = sendable.slice(0, cap);
  const overflow = sendable.slice(cap);

  if (armed) {
    for (const p of send) {
      const lead = p.legs[0].entry;
      const names = p.legs.map(l => l.profile.name);
      const entry = { ...lead, profileName: names.join(" + "), profiles: names };
      notify(tg, entry, snapshot.data.find(q => q.symbol === p.symbol)).catch(e => console.error("[alert]", e.message));
      gate.recordSent(p.symbol, p.legs.map(l => l.entry.profileId), now);
      tally.sent++;
    }
    if (overflow.length) {
      const lines = overflow.map(p => digestLine(p.legs[0].entry)).join("\n");
      notifyBrief(tg, `👁 <b>TRINETRA</b> · ${overflow.length} more locked\n\n${lines}\n\n<i>Open Trinetra for the detail.</i>`)
        .catch(e => console.error("[alert]", e.message));
      for (const p of overflow) gate.recordSent(p.symbol, p.legs.map(l => l.entry.profileId), now);
      suppressInto(tally, `digested(${overflow.length})`);
    }
  } else if (send.length || overflow.length) {
    suppressInto(tally, "telegram not configured");
  }

  // One line per cycle, not per stock: the log has to answer "why did/didn't I
  // get an alert" at a glance.
  const parts = Object.entries(tally.suppressed).map(([r, n]) => `suppressed(${r})=${n}`);
  if (tally.candidates || tally.sent || parts.length) {
    console.log(`[alerts] window=${windowOpen ? "open" : `closed:${win.reason}`} · age=${Math.round(snapshotAgeMin)}m · candidates=${tally.candidates} · sent=${tally.sent}${parts.length ? " · " + parts.join(" · ") : ""}`);
  }
  lastAlertTally = { at: now, windowOpen, reason: win.reason, ...tally };
}

const suppressInto = (tally, reason) => { tally.suppressed[reason] = (tally.suppressed[reason] || 0) + 1; };
let lastAlertTally = null;

/* Holdings-only signals: trimming a core position and buying it back.
   Evaluated ONLY for symbols the user holds — that restriction is what keeps a
   SELL from ever being a short recommendation. */
let cycleSignals = { sell: [], buyBack: [], suppressed: [] };

function cycleContextFor(stock, holding) {
  const price = stock.price;
  const res = resistanceAbove(stock, stock.candles);
  const sup = (() => {
    // Nearest level below price, from the same structure the levels engine uses.
    const cands = [stock.high20, stock.low20, stock.high50, trendOf(stock.candles, price, 20)?.ma,
                   trendOf(stock.candles, price, 50)?.ma].filter(v => Number.isFinite(v) && v < price);
    return cands.length ? Math.max(...cands) : null;
  })();
  const analog = decisionCache && null; // analogs come via potential() below
  const pot = potential(stock, { horizon: "swing", triggerPrice: stock.high20 });
  const medianMFE = pot?.analogs?.medianMFE ?? null;
  const swingLow = stock.low20 ?? null;
  const runPct = swingLow ? ((price - swingLow) / swingLow) * 100 : null;

  /* Context-valid reversal candles formed at a level. `valid` already excludes
     detections with no move to reverse; this additionally requires the candle to
     have formed AT a level, since a reversal in mid-range corroborates nothing. */
  const lv = levelCandidatesFor(stock);
  const det = lv.insufficient ? { valid: [] } : analyseCandlesFor(stock, lv.candidates, { lookback: 3 });
  const atLevel = (dir) => (det.valid || []).find(d => d.direction === dir && d.atLevel);
  const bearC = atLevel("bearish"), bullC = atLevel("bullish");

  return {
    bearishCandleAtResistance: bearC ? 1 : undefined,
    bullishCandleAtSupport: bullC ? 1 : undefined,
    candleReading: bearC?.reading || bullC?.reading || null,
    atResistancePct: res ? Math.abs(((res.price - price) / price) * 100) : undefined,
    resistanceLevel: res ? { name: res.name, price: Math.round(res.price * 100) / 100 } : null,
    supportLevel: sup ? Math.round(sup * 100) / 100 : null,
    pullbackToSupportPct: sup ? Math.abs(((price - sup) / price) * 100) : undefined,
    // "This run is already longer than this stock usually manages" — expressed as
    // a percentage OF the median analog move, so 100 means at the median.
    gainVsAnalogMedian: medianMFE && runPct != null ? (runPct / medianMFE) * 100 : undefined,
    gainVsHoldingEntry: holding?.entryPrice ? ((price - holding.entryPrice) / holding.entryPrice) * 100 : undefined,
    retraceVsSalePct: holding?.cycle?.sellPrice ? ((price - holding.cycle.sellPrice) / holding.cycle.sellPrice) * 100 : undefined,
  };
}

/* `opts` exists so the same code path can be run without side effects, for the
   preview endpoint. Nothing about how a signal is BUILT changes — only whether it
   is committed, alerted and recorded. A preview that took a different path would
   be verifying the preview rather than the thing. */
function scanCycles(opts = {}) {
  const commit = opts.commit !== false;
  const bySymbol = stockBySymbol();
  const out = { sell: [], buyBack: [], suppressed: [] };
  const sellP = config.profiles.sell_holdings, buyP = config.profiles.buyback_holdings;

  for (const h of (opts.holdings || holdings.open())) {
    const stock = bySymbol[h.symbol];
    if (!stock) continue;
    const ctx = cycleContextFor(stock, h);
    const withCtx = { ...stock, cycleCtx: ctx };
    const period = cycle.holdingPeriod(h);
    const derived = cycle.derive(h, stock.price);

    /* Prices for a trim are the mirror of prices for an entry: the action level is
       where you sell, the target sits BELOW it, and the move is a fall. Built by
       the same playbook rather than by inverting numbers here, so one renderer and
       one set of labels serve both. */
    const pricingFor = (kind) => {
      const dir = kind === "sell" ? "sell" : "buy";
      try {
        const pb = buildPlaybook(withCtx, {
          profile: kind === "sell" ? sellP : buyP, dataAge: dataAge(), direction: dir,
        });
        const t = pb.exits?.primary;
        if (!pb.entry?.zone || !t) return null;
        return {
          direction: dir,
          actionLabel: pb.exits.actionLabel, targetLabel: pb.exits.targetLabel,
          actionZone: pb.entry.zone,
          actionPrice: Math.round(((pb.entry.zone.low + pb.entry.zone.high) / 2) * 100) / 100,
          targetPrice: t.mid, targetZone: t.zone,
          // Magnitude plus a direction flag — never a negative "gain".
          movePct: t.movePct, downward: !!t.downward, arrow: t.downward ? "▼" : "▲",
          stop: pb.exits.stop ? { price: pb.exits.stop.mid, above: !!pb.exits.stop.above, rationale: pb.exits.stop.rationale } : null,
          riskReward: pb.exits.riskReward?.toPrimary ?? null,
          confidence: pb.exits.confidence ? { score: pb.exits.confidence.score, band: pb.exits.confidence.band } : null,
          anchor: t.anchor,
        };
      } catch (e) { return null; }
    };

    const render = (ev, kind) => ({
      id: `cyc_${kind}_${h.id}`,
      holdingId: h.id, symbol: h.symbol, kind,
      // A trim is a sell; buying back is a buy. Stated, never inferred from `kind`
      // by whoever is rendering.
      direction: kind === "sell" ? "sell" : "buy",
      pricing: pricingFor(kind),
      subtitle: kind === "sell" ? "sell a portion of your holding" : "buy back what you sold",
      // Failed checks travel too: three of four is not four of four, and the
      // fourth is worth seeing.
      criteria: ev.criteria.map(c => ({
        name: c.name, pass: !!c.pass, skipped: !!c.skipped,
        detail: (c.checksOut || []).map(x => cycleDetail(x, stock, ctx, h)).filter(Boolean).join(" · "),
      })),
      // Shown whether or not the criterion is enabled: it is evidence either way,
      // and its absence is worth seeing too.
      candleReading: ctx.candleReading,
      dataAge: dataAge(), at: Date.now(),
      // Not serialised to the client — carried so the durable record holds the
      // same evidence the signal fired on.
      _ev: ev, _price: stock.price, _name: stock.name, _groups: stock.groups || [],
    });

    if (sellP?.enabled !== false) {
      const ev = evaluate(withCtx, sellP.criteria);
      if (ev.locked || opts.force === "sell") out.sell.push({
        ...render(ev, "sell"),
        holding: {
          entryPrice: h.entryPrice, currentPrice: stock.price,
          gainPct: Math.round(((stock.price - h.entryPrice) / h.entryPrice) * 1000) / 10,
          heldMonths: period?.months ?? null, stcg: !!period?.stcg, holdingPeriod: period,
        },
        reasoning: sellReasoning(stock, ctx, ev, h, period),
        suggestion: "consider selling a portion; core stays",
        reentryRisk: cycle.REENTRY_RISK,
        cycle: derived,
      });
    }

    if (buyP?.enabled !== false) {
      const ev = evaluate(withCtx, buyP.criteria);
      const trend = trendOf(stock.candles, stock.price, 50);
      /* A pullback inside an uptrend is an opportunity; the same fall below the
         trend is a falling knife. Withheld rather than fired — and SAID, because
         silence would read as "no pullback yet". */
      if (trend && !trend.intact) {
        out.suppressed.push({
          symbol: h.symbol, holdingId: h.id, kind: "buyBack",
          reason: "trend broken — no re-entry signal",
          detail: `Price ₹${stock.price} is below the 50-day average of ₹${trend.ma}. This is a falling knife, not a pullback.`,
        });
      } else if (ev.locked || opts.force === "buyBack") {
        out.buyBack.push({
          ...render(ev, "buyBack"),
          belowSalePct: derived?.belowSalePct ?? null,
          sellPrice: h.cycle?.sellPrice ?? null,
          trendIntact: !!trend?.intact,
          suggestion: "consider buying back toward your core size",
          /* A stock the user has actually trimmed is the one this feature exists
             for — the round trip is open and this is the half that closes it. */
          priority: h.cycle?.status === "partly sold" ? "high" : "normal",
          cycle: derived,
        });
      }
    }
  }

  // Strip the carried evidence before anything serialises these.
  for (const sig of [...out.sell, ...out.buyBack]) {
    sig._raw = { ev: sig._ev, price: sig._price, name: sig._name, groups: sig._groups };
    delete sig._ev; delete sig._price; delete sig._name; delete sig._groups;
  }

  const clean = {
    ...out,
    sell: out.sell.map(({ _raw, ...s }) => s),
    buyBack: out.buyBack.map(({ _raw, ...s }) => s),
  };

  // A preview never fires an alert, never enters the track record, and never
  // replaces the live set.
  if (!commit) return clean;
  cycleSignals = clean;

  for (const sig of [...out.sell, ...out.buyBack]) {
    if (!gate.isNewExit(sig.id + ":" + gate.tradingDay())) continue;

    /* Recorded whether or not the alert goes out. The track record measures
       whether the signal was right, not whether Telegram was awake — and without
       this the sell side of byDirection stays permanently empty, which would read
       as "no sell signals" rather than "sells were never scored". */
    try {
      const pr = sig.pricing;
      history.recordSignal({
        symbol: sig.symbol, name: sig._raw.name, price: sig._raw.price,
        groups: sig._raw.groups, evaluation: sig._raw.ev, at: sig.at,
        profileId: sig.kind === "sell" ? "sell_holdings" : "buyback_holdings",
        horizon: "swing",
        potential: pr ? { movePct: pr.movePct, downward: pr.downward, triggerPrice: pr.actionPrice } : null,
        confidence: pr?.confidence ?? null,
        exits: pr ? { primary: { price: pr.targetPrice, pct: pr.movePct } } : null,
        dataAge: sig.dataAge,
        direction: sig.direction,
      });
    } catch (e) { console.error("[history]", e.message); }

    if (!gate.marketWindow(Date.now(), config.alertLimits).open &&
        process.env.ALERT_HOURS_OVERRIDE !== "true") continue;
    if (config.alerts?.telegram?.on) notifyCycle(config.alerts.telegram, sig).catch(e => console.error("[alert]", e.message));
  }
  return cycleSignals;
}

function cycleDetail(chk, stock, ctx, h) {
  if (chk.v == null) return null;
  const v = chk.v;
  switch (chk.metric) {
    case "extensionVs20dma": return `${Math.abs(v).toFixed(1)}% ${v < 0 ? "below" : "above"} the 20-day average`;
    case "extensionVs50dma": return `${Math.abs(v).toFixed(1)}% ${v < 0 ? "below" : "above"} the 50-day average`;
    case "rsi14": return `RSI ${v.toFixed(0)}`;
    case "rsiRecovery": return `RSI turning up at ${v.toFixed(0)}`;
    case "atResistancePct": return ctx.resistanceLevel
      ? `₹${ctx.resistanceLevel.price} — ${ctx.resistanceLevel.name}, ${v.toFixed(1)}% away` : `${v.toFixed(1)}% from resistance`;
    case "pullbackToSupportPct": return ctx.supportLevel
      ? `₹${ctx.supportLevel} — nearest support, ${v.toFixed(1)}% away` : `${v.toFixed(1)}% from support`;
    case "gainVsAnalogMedian": return `run is ${v.toFixed(0)}% of this stock's median historical run`;
    case "gainVsHoldingEntry": return `${v.toFixed(1)}% up from your entry at ₹${h.entryPrice}`;
    case "retraceVsSalePrice": return `${Math.abs(v).toFixed(1)}% below your sale at ₹${h.cycle?.sellPrice}`;
    case "trendIntact": return v ? "above the 50-day average" : "below the 50-day average";
    case "volumeClimax": return `${v.toFixed(1)}× volume with an exhaustion shape`;
    case "volumeDryUpThenExpansion": return "dry-up through the fall, expansion today";
    case "bearishCandleAtResistance": case "bullishCandleAtSupport":
      return ctx.candleReading || "reversal candle at the level";
    default: return `${chk.metric} ${v}`;
  }
}

function sellReasoning(stock, ctx, ev, h, period) {
  const bits = [];
  const passed = ev.criteria.filter(c => c.pass).map(c => c.name.toLowerCase());
  bits.push(`${h.symbol} is ${(((stock.price - h.entryPrice) / h.entryPrice) * 100).toFixed(1)}% up from your entry at ₹${h.entryPrice}`);
  if (ctx.resistanceLevel) bits.push(`and has reached ₹${ctx.resistanceLevel.price}, the ${ctx.resistanceLevel.name}`);
  if (passed.length) bits.push(`— ${passed.join(", ")} all point to a local top`);
  const s = bits.join(" ") + ".";
  return period?.stcg
    ? `${s} Held ${period.months} month${period.months === 1 ? "" : "s"}, so selling realises short-term gains.`
    : s;
}

/* Exit signals are deduped per rule per holding: an alert that repeats every
   minute is one the user learns to ignore, which is the failure mode that
   matters most for the rule that concerns money already at risk. */
const exitAlerted = new Set();
let activeExits = [];

function scanExits(windowOpen = true) {
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

  /* Exit alerts are edge-triggered and durably deduped: once when a rule first
     trips for a holding, never again while the condition persists, and not
     re-announced after a restart. An armed rule is a status, not an event, so
     it is never delivered. */
  for (const e of activeExits) {
    if (e.fired === false) continue;
    if (!gate.isNewExit(e.id)) continue;
    if (!windowOpen) { console.log(`[alerts] exit ${e.symbol}/${e.rule} recorded, delivery suppressed — outside market hours`); continue; }
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
  res.json({ ok: true, provider: PROVIDER, lastRefresh: snapshot.at, symbols: snapshot.data.length,
             delayed: PROVIDER === "yahooDelayed",
             // Whether this instance's data survives a redeploy. Surfaced here
             // because "ephemeral" is a thing to be told, not to discover — but
             // without the repo name or raw API errors, which are not public.
             storage: remote.publicStatus() }));

/* Storage detail and a manual flush, for when the user wants to be certain
   something is safely off this instance before redeploying. */
/* Full detail names the repo and echoes GitHub's errors, and the flush causes
   writes to an external service — hammering it would burn the API rate limit and
   push storage into `degraded`. Same gate as /backup: infrastructure control,
   not app data. /health carries the public subset for the dashboard banner. */
app.get("/storage", (req, res) => {
  if (!guardBackup(req, res)) return;
  res.json({ ...remote.status(), tracked: remote.trackedFiles() });
});
app.post("/storage/flush", async (req, res) => {
  if (!guardBackup(req, res)) return;
  try { res.json({ ok: true, ...(await remote.flush("manual")), status: remote.status() }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

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

/* Load NSE index constituents as watchlist groups.

   Fetched live from the exchange archive rather than shipped as a snapshot: the
   indices rebalance quarterly, and a hardcoded list is wrong within a quarter
   while looking exactly as authoritative as a correct one.

   ADDITIVE BY DEFAULT. Symbols you added yourself are never dropped by this —
   they stay in whatever group they are in, and the only way one leaves is if you
   remove it. Pass `replace: true` to make the named groups exactly match the
   index instead, which still leaves your other groups alone. */
app.post("/universe/indices", async (req, res) => {
  const wanted = Array.isArray(req.body?.indices) && req.body.indices.length
    ? req.body.indices.map(x => String(x).trim())
    : ["nifty50", "niftynext50", "midcap100", "smallcap100"];
  const unknown = wanted.filter(k => !INDICES[k]);
  if (unknown.length) {
    return res.status(400).json({ error: `unknown index: ${unknown.join(", ")}`, known: Object.keys(INDICES) });
  }

  const { groups, errors } = await fetchIndices(wanted);
  if (!Object.keys(groups).length) {
    return res.status(502).json({ error: "could not fetch any index from NSE", errors });
  }

  const before = unionGroups(GROUPS, cleanSymbols).length;
  const replace = req.body?.replace === true;
  const added = [];
  for (const [group, symbols] of Object.entries(groups)) {
    const existing = replace ? [] : (GROUPS[group] || []);
    const merged = cleanSymbols([...existing, ...symbols]);
    added.push(...merged.filter(x => !(GROUPS[group] || []).includes(x)));
    GROUPS[group] = merged;
  }
  commitGroups(false);

  const after = unionGroups(GROUPS, cleanSymbols).length;
  const overCap = after >= MAX_SYMBOLS;
  /* The scan is serial against a free feed, so the universe size sets the floor
     on how often a full pass can complete. Stated in seconds the user can act on
     rather than left to be discovered as silently stale prices. */
  const suggestedRefreshMs = Math.ceil(after * 0.6 / 10) * 10_000;

  res.json({
    ok: true,
    groups: Object.fromEntries(Object.entries(GROUPS).map(([g, v]) => [g, v.length])),
    symbols: after, addedThisCall: [...new Set(added)].length, previousTotal: before,
    errors: errors.length ? errors : null,
    cap: { max: MAX_SYMBOLS, reached: overCap,
           note: overCap ? `Capped at ${MAX_SYMBOLS}; symbols beyond that were dropped.` : null },
    refresh: {
      currentMs: REFRESH_MS,
      suggestedMs: suggestedRefreshMs,
      note: REFRESH_MS < suggestedRefreshMs
        ? `A full pass over ${after} symbols takes about ${Math.round(after * 0.6)}s against the free feed. REFRESH_MS is ${REFRESH_MS / 1000}s, so passes will be skipped as overlapping. Set REFRESH_MS=${suggestedRefreshMs} — on a ~15-minute delayed feed, refreshing faster than that is false precision anyway.`
        : "Refresh interval is comfortable for this universe size.",
    },
    fundamentals: `Fundamentals for new symbols are scraped in the background, paced one per second — about ${Math.ceil(after / 60)} minutes for a full universe, once, then cached. Until a symbol is scraped its fundamentals criteria read NO DATA and cannot veto anything.`,
  });
});

app.get("/universe/indices", (_, res) => res.json({
  available: Object.entries(INDICES).map(([key, v]) => ({ key, group: v.group, label: v.label })),
  note: "POST { indices: [keys], replace?: false } to load them as watchlist groups.",
}));

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

/* Expert views on the IPOs Pravesh covers. Separate from /analysts, which is
   keyed on symbol — an unlisted IPO has no ticker and joins on ipoSlug. */
app.get("/ipo/expert-calls", async (_, res) => {
  try { res.json(await ipo.expertCalls()); }
  catch (e) { res.status(502).json({ ok: false, reason: e.message, calls: [] }); }
});

app.get("/ipo-applications/stats", async (req, res) =>
  res.json(await ipo.stats(Math.max(1, +req.query.days || 365))));

/* ── profiles ────────────────────────────────────────────────────────────── */

app.get("/profiles", (_, res) => res.json({
  profiles: config.profiles,
  canonical: CANONICAL_CRITERIA,
  // The dashboard shows a one-line banner when these differ, rather than
  // silently overriding a user who meant to change them.
  matchesCanonical: matchesCanonical(config.profiles?.swing?.criteria),
  // The founding four, in the user's own words, with their live state — so the
  // panel that pins them reads from the engine rather than a hardcoded list.
  originalFour: originalFourStatus(config.profiles?.swing?.criteria, PROVIDER),
}));

/* One tap back to the instrument's original purpose: fundamentals, breakout,
   volume shocker. Defaults are a floor, not a cage — this is available, never
   automatic. */
app.post("/criteria/restore-defaults", (req, res) => {
  const id = cleanId(req.body?.profile || "swing");
  const p = config.profiles[id];
  if (!p) return res.status(404).json({ error: "no such profile" });
  p.criteria = structuredClone(CANONICAL_CRITERIA);
  saveConfig(); scan();
  res.json({ ok: true, profile: id, criteria: p.criteria, matchesCanonical: true,
             originalFour: originalFourStatus(p.criteria, PROVIDER) });
});

/* "Restore the original four" — the same action, named the way the user names it.
   It restores all four including the dormant order-book criterion, so the fourth
   is visibly present-and-waiting rather than quietly absent. */
app.post("/criteria/restore-original-four", (req, res) => {
  const id = cleanId(req.body?.profile || "swing");
  const p = config.profiles[id];
  if (!p) return res.status(404).json({ error: "no such profile" });
  p.criteria = structuredClone(CANONICAL_CRITERIA);
  saveConfig(); scan();
  res.json({
    ok: true, profile: id, criteria: p.criteria, matchesCanonical: true,
    originalFour: originalFourStatus(p.criteria, PROVIDER),
  });
});

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

app.get("/holdings", (_, res) => {
  const by = stockBySymbol();
  res.json({
    holdings: holdings.all().map(h => ({
      ...h,
      cycle: cycle.derive(h, by[h.symbol]?.price ?? h.entryPrice),
      holdingPeriod: cycle.holdingPeriod(h),
    })),
  });
});

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
app.get("/cycle-signals", (_, res) => res.json({ ...cycleSignals, dataAge: dataAge() }));

/* A real sell payload on demand, for wiring the SELL rendering before a sell has
   ever fired.

   Built by the SAME code path as a live signal, with only the criteria lock
   bypassed — real prices, real levels from the real playbook, real labels. What it
   is NOT is a signal: nothing is alerted, nothing enters the track record, and the
   live set is untouched. `preview: true` and `notASignal` travel with it so it can
   never be mistaken for one on screen. */
app.get("/cycle-signals/preview", (req, res) => {
  const symbol = String(req.query.symbol || "").trim().toUpperCase();
  const kind = req.query.kind === "buyBack" ? "buyBack" : "sell";
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  const stock = stockBySymbol()[symbol];
  if (!stock) return res.status(404).json({ error: `${symbol} is not in the scanned universe` });

  const held = holdings.open().find(h => h.symbol === symbol);
  /* If it is not actually held, stand in a holding rather than refusing — the
     point is to render the shape. The stand-in is declared, not hidden, because
     `holding.gainPct` computed off an invented entry price is not a real number. */
  const h = held || {
    id: "preview", symbol, entryPrice: Math.round(stock.price * 0.8 * 100) / 100,
    markedAt: new Date().toISOString(), cycle: null,
  };

  const out = scanCycles({ commit: false, holdings: [h], force: kind });
  const sig = (kind === "sell" ? out.sell : out.buyBack)[0] || null;

  res.json({
    preview: true,
    notASignal: "Built by the same code path as a live signal with the criteria lock bypassed. Prices, levels and labels are real; the fact that it fired is not. Never render this as a signal.",
    syntheticHolding: !held ? { used: true, entryPrice: h.entryPrice,
      caveat: `${symbol} is not in your holdings, so an entry price 20% below the current price was assumed. holding.gainPct here is fabricated — every other number is real.` } : { used: false },
    kind, symbol,
    signal: sig,
    suppressed: out.suppressed,
    dataAge: dataAge(),
  });
});

/* One tap each. Quantity is optional — the hold itself records none, so the
   cycle works in percentage terms until a quantity is supplied at the moment it
   actually exists. */
app.post("/holdings/:id/sold", (req, res) => {
  const h = holdings.find(req.params.id);
  if (!h) return res.status(404).json({ error: "no such holding" });
  const price = stockBySymbol()[h.symbol]?.price;
  const c = cycle.recordSale(h, req.body || {}, price);
  if (!c) return res.status(400).json({ error: "no current price and no price supplied" });
  const updated = holdings.update(h.id, { cycle: c });
  scanCycles();
  res.json({ ...updated, cycle: cycle.derive(updated, price) });
});

app.post("/holdings/:id/bought-back", (req, res) => {
  const h = holdings.find(req.params.id);
  if (!h) return res.status(404).json({ error: "no such holding" });
  const price = stockBySymbol()[h.symbol]?.price;
  const c = cycle.recordBuyBack(h, req.body || {}, price);
  if (!c) return res.status(400).json({ error: "nothing recorded as sold for this holding" });
  const updated = holdings.update(h.id, { cycle: c });
  scanCycles();
  res.json({ ...updated, cycle: cycle.derive(updated, price) });
});

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

/* ── playbook ─────────────────────────────────────────────────────────────
   The heavy parts — levels, pattern backtests, broker records — are stable
   within a day, so they are cached per symbol per profile per trading day. The
   cheap parts move with price and are recomputed on every request. */
const playbookCache = new Map();

function playbookFor(symbol, profileId) {
  const stock = stockBySymbol()[symbol];
  if (!stock) return null;
  const profile = config.profiles[profileId] || config.profiles.swing;
  if (!profile) return null;
  const key = `${symbol}:${profile.horizon}:${gate.tradingDay()}:${Math.round(stock.price)}`;
  if (playbookCache.has(key)) return playbookCache.get(key);
  if (playbookCache.size > 400) playbookCache.clear();
  const pb = buildPlaybook(stock, {
    profile, dataAge: dataAge(), event: stock.nextEvent,
    triggerPrice: triggerFor(stock, profile),
  });
  playbookCache.set(key, pb);
  return pb;
}

app.get("/playbook", (req, res) => {
  const sym = String(req.query.symbol ?? "").trim().toUpperCase();
  const pb = playbookFor(sym, cleanId(req.query.profile || "swing"));
  if (!pb) return res.status(404).json({ error: "symbol not in the current snapshot, or no such profile" });
  res.json({ ...pb, asOf: snapshot.at, dataAge: dataAge() });
});

app.get("/playbook/all", (req, res) => {
  const profileId = cleanId(req.query.profile || "swing");
  const rows = [];
  for (const s of snapshot.data) {
    const pb = playbookFor(s.symbol, profileId);
    if (!pb) continue;
    if (pb.insufficient) {
      rows.push({ symbol: s.symbol, price: s.price, insufficient: true, reading: pb.reading });
      continue;
    }
    /* Same nesting as /playbook. The compact row previously hoisted primary,
       stop, riskReward and exitConfidence to the top level while the full
       payload nested them under `exits` — the same concepts at two different
       paths in one feature, which is a trap for anything binding both. A caller
       reading the nested shape got an em dash from a row that had the numbers. */
    rows.push({
      symbol: pb.symbol, price: pb.price,
      entry: { kind: pb.entry.kind, zone: pb.entry.zone, triggered: pb.entry.triggered,
               chasing: pb.entry.chasing, warning: pb.entry.warning,
               convergence: pb.entry.convergence, families: pb.entry.families,
               confidence: { score: pb.entry.confidence.score, band: pb.entry.confidence.band } },
      exits: {
        primary: pb.exits.primary
          ? { zone: pb.exits.primary.zone, pct: pb.exits.primary.pct,
              convergence: pb.exits.primary.convergence, families: pb.exits.primary.families }
          : null,
        stop: { zone: pb.exits.stop.zone, pct: pb.exits.stop.pct },
        riskReward: pb.exits.riskReward,
        // Belongs in the compact row too: sub-1:1 is exactly the row a fast
        // scan of a table should not skip past.
        riskRewardWarning: pb.exits.riskRewardWarning,
        confidence: { score: pb.exits.confidence.score, band: pb.exits.confidence.band },
      },
      potential: pb.potential,
      convergence: pb.convergence,
      reading: pb.reading,
    });
  }
  res.json({ profile: profileId, asOf: snapshot.at, dataAge: dataAge(), rows });
});

app.get("/analysts", (req, res) => {
  const sym = String(req.query.symbol ?? "").trim().toUpperCase();
  if (!sym) return res.status(400).json({ error: "symbol required" });
  res.json(analysts.forSymbol(sym));
});

/* Manual entry exists because scraping brokerage pages is unreliable by nature.
   A call typed in by hand is scored identically — it is arguably better data,
   since nothing was inferred from a page layout that may have changed. */
app.post("/analysts", (req, res) => {
  const rec = analysts.addCall(req.body || {}, "manual");
  if (!rec) return res.status(400).json({ error: "symbol and broker are required" });
  playbookCache.clear(); // a new target can move a level
  res.json(rec);
});

/* Named experts on a stock — Sandeep Jain, Anil Singhvi. Scored in the same
   ledger as the brokerages, with the same n threshold. */
app.post("/analysts/experts", async (req, res) => {
  const sym = String(req.body?.symbol ?? "").trim().toUpperCase();
  if (!sym) return res.status(400).json({ error: "symbol required" });
  const out = await analysts.scrapeExperts(sym);
  playbookCache.clear();
  res.json({ ...out, ...analysts.forSymbol(sym) });
});

app.post("/analysts/scrape", async (req, res) => {
  const sym = String(req.body?.symbol ?? "").trim().toUpperCase();
  if (!sym) return res.status(400).json({ error: "symbol required" });
  const out = await analysts.scrape(sym);
  playbookCache.clear();
  res.json({ ...out, ...analysts.forSymbol(sym) });
});

app.get("/pravesh/trigger-status", (_, res) =>
  res.json(pravesh.status(gate.loadHolidays()?.dates || [])));

/* Manual dispatch, for testing and for re-running after a failure. Same CORS
   rule as every other write endpoint. */
app.post("/pravesh/trigger", async (req, res) => {
  const c = pravesh.config();
  const missing = pravesh.missingConfig(c);
  if (missing.length) return res.status(400).json({ error: `not configured — missing ${missing.join(", ")}` });
  const slot = String(req.body?.slot || "manual");
  const out = await pravesh.dispatch(slot, c);
  res.status(out.ok ? 200 : 502).json(out);
});

app.get("/alerts/status", (_, res) => res.json({
  ...gate.status(config.alertLimits),
  override: process.env.ALERT_HOURS_OVERRIDE === "true",
  telegramArmed: !!config.alerts?.telegram?.on,
  lastCycle: lastAlertTally,
}));

app.get("/settings/sizing", (_, res) => res.json(config.sizing));
app.post("/settings/sizing", (req, res) => {
  for (const k of ["capital", "riskPerTradePct", "defaultStopPct", "sectorLimitPct"])
    if (req.body?.[k] !== undefined) config.sizing[k] = +req.body[k];
  saveConfig();
  res.json(config.sizing);
});

/* ── backup & restore ─────────────────────────────────────────────────────
   Render's free tier has no persistent disk, so every deploy wipes data/ —
   which now holds open positions, not just history. These two endpoints are the
   free-tier substitute: pull one file before deploying, push it back after.

   Credentials are deliberately excluded. The backup travels over HTTP and lands
   in a file the user will keep lying around; a Telegram bot token has no
   business in either, and it comes from the environment anyway. */

const BACKUP_FILES = [
  "signal_history.json", "paper_trades.json", "ipo_applications.json",
  "holdings.json", "events.json",
  /* The alert ledger belongs here or a restore does not actually restore: with
     it gone, every currently-locked stock reads as a fresh edge and re-fires the
     storm the gate exists to prevent. Analyst calls belong here because manual
     entry is the ONLY working broker path — scraping is blocked — so those rows
     are hand-typed research that cannot be regenerated. */
  "alert_ledger.json", "analyst_calls.json", "market_holidays.json",
];
const DATA_DIR = path.join(__dirname, "data");

/* These two endpoints read out the entire trading record and can overwrite it,
   on a public URL. CORS is no defence — it is a browser rule, and curl ignores
   it. So they are gated on a shared secret and FAIL CLOSED: with BACKUP_TOKEN
   unset they refuse to serve at all, because there must be no configuration in
   which they are silently public. */
const BACKUP_TOKEN = (process.env.BACKUP_TOKEN || "").trim();

// Constant-time compare: a plain === leaks the token a character at a time to
// anyone willing to measure the response.
function tokenMatches(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(BACKUP_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function guardBackup(req, res) {
  if (!BACKUP_TOKEN) {
    res.status(503).json({
      error: "backup and restore are disabled",
      reason: "BACKUP_TOKEN is not set on this service. These endpoints expose and overwrite the whole trading record, so they refuse to run without one.",
    });
    return false;
  }
  const given = req.get("X-Backup-Token") || (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tokenMatches(given)) {
    console.warn(`[backup] rejected ${req.method} ${req.path} — bad or missing token`);
    res.status(401).json({ error: "invalid or missing X-Backup-Token" });
    return false;
  }
  return true;
}

const readDataFile = f => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")); }
  catch { return null; }
};

app.get("/backup", (req, res) => {
  if (!guardBackup(req, res)) return;
  const files = {};
  for (const f of BACKUP_FILES) {
    const data = readDataFile(f);
    if (data !== null) files[f] = data;
  }
  // Config without the secrets: profiles, thresholds, sizing and the exit rules
  // are all hand-tuned and worth keeping; the token is not.
  const { alerts, ...safeConfig } = config;
  res.json({
    backupVersion: 1,
    generatedAt: Date.now(),
    generatedAtIso: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(files).map(([f, d]) => [f, Array.isArray(d) ? d.length : Object.keys(d || {}).length])),
    files,
    config: { ...safeConfig, alerts: { telegram: { on: !!config.alerts?.telegram?.on } } },
    universe: { groups: GROUPS },
    note: "Telegram credentials are excluded on purpose — they come from the environment and do not belong in a file you keep on disk.",
  });
});

app.post("/restore", (req, res) => {
  if (!guardBackup(req, res)) return;
  const body = req.body || {};
  if (body.backupVersion !== 1) return res.status(400).json({ error: "unrecognised or missing backupVersion" });
  // Restoring overwrites records that cannot be reconstructed, so it takes an
  // explicit acknowledgement rather than happening because a request arrived.
  if (body.confirm !== true) return res.status(400).json({ error: "set confirm: true — this overwrites existing records" });

  // Snapshot what is there first. A restore from the wrong file is recoverable
  // only if the thing it replaced still exists somewhere.
  const rollback = { backupVersion: 1, generatedAt: Date.now(), files: {} };
  for (const f of BACKUP_FILES) {
    const cur = readDataFile(f);
    if (cur !== null) rollback.files[f] = cur;
  }
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  try { fs.writeFileSync(path.join(DATA_DIR, "pre-restore.json"), JSON.stringify(rollback, null, 2)); } catch {}

  const restored = {};
  for (const [f, data] of Object.entries(body.files || {})) {
    if (!BACKUP_FILES.includes(f)) continue; // never write a path the caller named
    try {
      fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(data, null, 2));
      restored[f] = Array.isArray(data) ? data.length : Object.keys(data || {}).length;
    } catch (e) {
      console.warn(`[restore] ${f}: ${e.message}`);
    }
  }

  // Re-read, or the process would keep serving what it was holding in memory.
  history.reload(); paper.reload(); ipo.reload(); holdings.reload();
  analysts.reload(); gate.loadLedger(); gate.loadHolidays();

  if (body.universe?.groups && typeof body.universe.groups === "object") {
    GROUPS = migrateGroups({ groups: body.universe.groups }, cleanSymbols);
    commitGroups(false);
  }
  if (body.config) {
    // Merge, never replace: the live Telegram credentials are not in the backup
    // and must survive it.
    const { alerts: _ignored, ...rest } = body.config;
    config = { ...config, ...rest, alerts: config.alerts };
    if (body.config.profiles) config.profiles = migrateProfiles(body.config);
    saveConfig();
  }

  refresh();
  console.log(`[restore] ${Object.entries(restored).map(([f, n]) => `${f}:${n}`).join(" ")}`);
  res.json({ ok: true, restored, rollbackSavedTo: "data/pre-restore.json" });
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
        // Pravesh publishes close_date (snake) and keeps the call in
        // take.verdict_key with a one-liner worth carrying into the brief.
        ipos = rows.filter(x => {
          const close = Date.parse(x.closeDate || x.close_date || "");
          return Number.isFinite(close) && close >= Date.now() - 86_400_000 && close <= soon;
        }).map(x => ({
          name: x.name || x.ipoName,
          verdict: x.take?.verdict_key || x.verdict || x.call || null,
          verdictLabel: x.take?.verdict_label || null,
          oneLiner: x.take?.one_liner || null,
          segment: x.segment || null,
          closeDate: x.closeDate || x.close_date,
          closingTomorrow: !!x.closing_tomorrow,
        }));
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
  /* A synced criteria array must not be able to switch on a criterion whose
     data source is absent. Enabling Order Flow from the dashboard would
     otherwise block every signal on a delayed feed — the engine now excludes it
     from the lock regardless, but arriving already-disabled is clearer than
     arriving broken and rescued. */
  if (Array.isArray(criteria)) {
    config.criteria = criteria.map(c => (DATALESS_CRITERIA.has(c.id) && c.enabled ? { ...c, enabled: false } : c));
  }
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

  /* Pull anything this disk is missing BEFORE the first scan. On Render's free
     plan a redeploy arrives with an empty data/, so this is the step that turns
     a wipe into a non-event. Only absent files are adopted — a local file always
     wins, because replacing a live trade log with an older snapshot is a worse
     failure than a stale remote. */
  const boot = await remote.bootstrap().catch(e => ({ enabled: false, adopted: [], reason: e.message }));
  if (boot.adopted?.length) {
    // Re-read: the modules loaded their files at import time, before the pull.
    history.reload(); paper.reload(); ipo.reload(); holdings.reload();
    analysts.reload(); events.reload?.();
    if (boot.adopted.includes("universe.runtime.json")) {
      try {
        GROUPS = migrateGroups(read("universe.runtime.json"), cleanSymbols);
        SYMBOLS = unionGroups(GROUPS, cleanSymbols);
        console.log(`[remote] universe adopted — ${SYMBOLS.length} symbols`);
      } catch (e) { console.warn(`[remote] universe adopt failed: ${e.message}`); }
    }
    if (boot.adopted.includes("fundamentals.cache.json")) {
      try {
        fundCache = read("fundamentals.cache.json");
        console.log(`[remote] fundamentals cache adopted — ${Object.keys(fundCache).length} symbols, no re-scrape needed`);
      } catch (e) { console.warn(`[remote] fundamentals adopt failed: ${e.message}`); }
    }
    if (boot.adopted.includes("config.json")) {
      try {
        const restored = read("config.json");
        // Credentials come from the environment every boot and are never in the
        // remote copy, so the live ones must survive adoption.
        const { alerts: _dropped, ...rest } = restored;
        config = { ...config, ...rest, alerts: config.alerts };
        if (restored.profiles) config.profiles = migrateProfiles(restored);
        console.log("[remote] config adopted — criteria and thresholds restored");
      } catch (e) { console.warn(`[remote] config adopt failed: ${e.message}`); }
    }
  }
  const st = remote.status();
  console.log(`[storage] ${st.mode} — ${st.detail}`);
  remote.installShutdownFlush();

  const hol = gate.loadHolidays();
  gate.loadLedger();
  console.log(hol
    ? `[alerts] window Mon-Fri 09:15-15:30 IST · ${hol.dates?.length ?? 0} holidays loaded (${hol.year ?? "?"})`
    : "[alerts] window Mon-Fri 09:15-15:30 IST · no holiday file — weekday logic only, alerts can fire on a market holiday");
  if (process.env.ALERT_HOURS_OVERRIDE === "true") console.warn("[alerts] ALERT_HOURS_OVERRIDE=true — the market-hours gate is OFF");
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
  // Same IST logic as the keep-alive; inert unless explicitly enabled.
  pravesh.startPraveshTrigger(() => gate.loadHolidays()?.dates || []);
});
