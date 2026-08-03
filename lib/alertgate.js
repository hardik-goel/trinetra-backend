/* Alert delivery gate — when an alert may be sent, and whether this one is new.

   The scan runs 24/7 by design: the track record wants every signal recorded,
   including the ones nobody could act on. Delivery is a different question, and
   conflating the two is what produced evening alerts about a stock that stopped
   moving at 15:30.

   Two rules carry most of the fix:

     1. Alerts are EDGE-triggered. A signal fires when a stock BECOMES locked,
        not while it stays locked. A level-triggered alert repeats forever,
        because "criteria are true" stays true after the tape stops.
     2. The ledger is durable. A free-tier instance sleeps and wakes many times
        a day; an in-memory ledger means every wake re-alerts everything that
        currently qualifies, which is exactly the storm the user saw.

   Everything here is IST-based. The server clock is UTC on Render, so a day
   boundary taken from local time would roll over at 05:30 IST — in the middle
   of nothing, and hours before the market opens. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { load, save } from "./store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = "alert_ledger.json";
const HOLIDAYS_FILE = "market_holidays.json";
const IST_OFFSET_MS = 5.5 * 60 * 60_000;
const DAY_MS = 86_400_000;

const OPEN_MIN = 9 * 60 + 15;   // 09:15 IST
const CLOSE_MIN = 15 * 60 + 30; // 15:30 IST

export const DEFAULT_ALERT_LIMITS = {
  preOpenBufferMinutes: 0,
  postCloseGraceMinutes: 0,
  cooldownMinutes: 240,       // 4h — same symbol stays quiet, across profiles
  maxPerSymbolPerDay: 1,
  maxPerCycle: 5,
  maxPerHour: 15,
  staleAfterMinutes: 10,
};

const istDate = (ms = Date.now()) => new Date(ms + IST_OFFSET_MS);
export const istMinutes = (ms = Date.now()) => {
  const d = istDate(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
/** The trading day an instant belongs to, rolling at 00:00 IST. */
export const tradingDay = (ms = Date.now()) => istDate(ms).toISOString().slice(0, 10);

/* Holidays live in a committed seed that a runtime copy may override. The seed
   carries only fixed-date national holidays, because the lunar ones move every
   year and a guessed date is worse than an absent one: it would silence a real
   trading day, or allow alerts on a closed one. */
let holidays = null;
export function loadHolidays() {
  const fromData = load(HOLIDAYS_FILE, null);
  if (Array.isArray(fromData?.dates)) return (holidays = fromData);
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(ROOT, HOLIDAYS_FILE), "utf8"));
    return (holidays = seed);
  } catch {
    return (holidays = null);
  }
}

export function marketWindow(now = Date.now(), limits = DEFAULT_ALERT_LIMITS) {
  const d = istDate(now);
  const day = d.getUTCDay();
  const mins = istMinutes(now);
  const today = tradingDay(now);
  const open = OPEN_MIN - (limits.preOpenBufferMinutes || 0);
  const close = CLOSE_MIN + (limits.postCloseGraceMinutes || 0);

  if (day === 0 || day === 6) return { open: false, reason: "weekend", today };
  if (holidays?.dates?.includes(today)) return { open: false, reason: "market holiday", today };
  if (mins < open) return { open: false, reason: "before open", today };
  if (mins > close) return { open: false, reason: "after close", today };
  return { open: true, reason: null, today };
}

/** Next 09:15 IST that is not a weekend or a listed holiday. */
export function nextOpen(now = Date.now()) {
  for (let i = 0; i <= 10; i++) {
    const probe = now + i * DAY_MS;
    const d = istDate(probe);
    const day = d.getUTCDay();
    const date = tradingDay(probe);
    if (day === 0 || day === 6 || holidays?.dates?.includes(date)) continue;
    if (i === 0 && istMinutes(now) >= OPEN_MIN) continue; // today's open has passed
    return `${date}T09:15+05:30`;
  }
  return null;
}

/* ── ledger ───────────────────────────────────────────────────────────────
   Durable across restarts, which is the whole point. `locks` remembers what was
   locked last cycle so a wake does not read every standing lock as a new edge;
   `fired` is the delivery record that enforces cooldown, the daily cap and the
   hourly limit. */
let ledger = { locks: {}, fired: [], exits: [] };
const persist = () => save(LEDGER, ledger);

export function loadLedger() {
  const raw = load(LEDGER, null);
  ledger = {
    locks: raw?.locks && typeof raw.locks === "object" ? raw.locks : {},
    fired: Array.isArray(raw?.fired) ? raw.fired : [],
    exits: Array.isArray(raw?.exits) ? raw.exits : [],
  };
  prune();
  return ledger;
}

function prune() {
  const cutoff = Date.now() - 7 * DAY_MS;
  ledger.fired = ledger.fired.filter(f => f.firedAt >= cutoff);
  ledger.exits = ledger.exits.filter(e => e.firedAt >= cutoff);
}

/**
 * Edge detection. Returns true only on the not-locked → locked transition, and
 * records the new state either way.
 */
export function isNewLock(symbol, profileId, locked) {
  const key = `${profileId}:${symbol}`;
  const was = !!ledger.locks[key];
  if (was !== !!locked) {
    ledger.locks[key] = !!locked;
    persist();
  }
  return !was && !!locked;
}

const firedFor = symbol => ledger.fired.filter(f => f.symbol === symbol);

/** Why this symbol may not be alerted on right now, or null if it may. */
export function deliveryBlock(symbol, now = Date.now(), limits = DEFAULT_ALERT_LIMITS) {
  const today = tradingDay(now);
  const mine = firedFor(symbol);

  const todays = mine.filter(f => f.tradingDay === today);
  if (todays.length >= (limits.maxPerSymbolPerDay ?? 1)) return "daily cap";

  const last = mine.reduce((a, f) => Math.max(a, f.firedAt), 0);
  if (last && now - last < (limits.cooldownMinutes ?? 240) * 60_000) return "cooldown";

  const hourAgo = now - 3_600_000;
  if (ledger.fired.filter(f => f.firedAt >= hourAgo).length >= (limits.maxPerHour ?? 15)) return "hourly limit";

  return null;
}

export function recordSent(symbol, profileIds, now = Date.now()) {
  ledger.fired.push({ symbol, profileIds, tradingDay: tradingDay(now), firedAt: now });
  prune();
  persist();
}

/* Exit alerts are edge-triggered the same way: once when a rule first trips for
   a holding, not on every refresh while the condition persists. Durable, so a
   restart does not re-announce a stop that broke this morning. */
export function isNewExit(id, now = Date.now()) {
  if (ledger.exits.some(e => e.id === id)) return false;
  ledger.exits.push({ id, firedAt: now });
  prune();
  persist();
  return true;
}

/** Snapshot too old, or the tape unchanged, means nothing new has happened. */
const lastInputs = new Map();
export function inputsChanged(symbol, price, volume) {
  const key = symbol;
  const prev = lastInputs.get(key);
  const now = `${price}:${volume}`;
  lastInputs.set(key, now);
  return prev === undefined || prev !== now;
}

export function status(limits = DEFAULT_ALERT_LIMITS, now = Date.now()) {
  const w = marketWindow(now, limits);
  const today = tradingDay(now);
  const todays = ledger.fired.filter(f => f.tradingDay === today);
  const cooldownMs = (limits.cooldownMinutes ?? 240) * 60_000;
  const active = [];
  for (const symbol of new Set(ledger.fired.map(f => f.symbol))) {
    const last = Math.max(...firedFor(symbol).map(f => f.firedAt));
    const remaining = cooldownMs - (now - last);
    if (remaining > 0) active.push({ symbol, minutesRemaining: Math.ceil(remaining / 60_000) });
  }
  return {
    windowOpen: w.open,
    reason: w.reason,
    tradingDay: today,
    nextOpen: w.open ? null : nextOpen(now),
    sentToday: todays.length,
    sentLastHour: ledger.fired.filter(f => f.firedAt >= now - 3_600_000).length,
    activeCooldowns: active.sort((a, b) => b.minutesRemaining - a.minutesRemaining),
    limits,
    holidays: holidays
      ? { configured: true, count: holidays.dates?.length ?? 0, note: holidays.note || null }
      : { configured: false, note: "No holiday file — weekday logic only, so alerts can fire on a market holiday." },
  };
}

export const ledgerState = () => ledger;
