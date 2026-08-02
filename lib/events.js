/* Upcoming corporate events, best-effort.

   A signal fired two days before results is a bet on an announcement, not on a
   setup, and the user should be told which one they are taking.

   Best-effort means exactly that: when a date cannot be established, nothing is
   stored. A guessed earnings date is worse than no date, because it would let
   the app claim "no event risk" about a stock reporting tomorrow. */

import * as cheerio from "cheerio";
import { load, save } from "./store.js";

const FILE = "events.json";
const TTL_MS = 12 * 3_600_000; // dates move rarely; re-checking hourly is waste
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/* All markup knowledge in one block, same as the fundamentals scraper. */
const SELECTORS = {
  screener: {
    url: sym => `https://www.screener.in/company/${encodeURIComponent(sym)}/`,
    // Screener puts upcoming results in the company header area as free text.
    infoBlocks: "#company-info, .company-info, #top, .card",
    resultPattern: /(?:results?|board\s*meeting)\s*(?:date)?\s*[:\-–]?\s*(\d{1,2}\s+\w{3,9}\s+\d{4}|\d{1,2}\s+\w{3,9})/i,
    exDivPattern: /ex[- ]?dividend\s*[:\-–]?\s*(\d{1,2}\s+\w{3,9}\s+\d{4}|\d{1,2}\s+\w{3,9})/i,
  },
};

let cache = load(FILE, {});
const persist = () => save(FILE, cache);
const DAY_MS = 86_400_000;

const clean = s => String(s || "").replace(/\s+/g, " ").trim();

/** Parse "14 Aug 2026" or "14 Aug" (assumed the next occurrence). Returns null
    on anything ambiguous — an unparsed date must not become a wrong one. */
function parseDate(text) {
  if (!text) return null;
  const t = clean(text);
  const withYear = /\d{4}$/.test(t) ? t : `${t} ${new Date().getFullYear()}`;
  const ms = Date.parse(withYear);
  if (!Number.isFinite(ms)) return null;
  // A date that already passed with no year given means next year's occurrence.
  if (!/\d{4}$/.test(t) && ms < Date.now() - 7 * DAY_MS) {
    const next = Date.parse(`${t} ${new Date().getFullYear() + 1}`);
    return Number.isFinite(next) ? next : null;
  }
  return ms;
}

async function scrape(symbol) {
  const S = SELECTORS.screener;
  const r = await fetch(S.url(symbol), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const $ = cheerio.load(await r.text());
  const text = clean($(S.infoBlocks).text()).slice(0, 4000);

  const found = [];
  const res = text.match(S.resultPattern);
  const resDate = res && parseDate(res[1]);
  if (resDate) found.push({ type: "results", date: new Date(resDate).toISOString().slice(0, 10) });

  const div = text.match(S.exDivPattern);
  const divDate = div && parseDate(div[1]);
  if (divDate) found.push({ type: "ex-dividend", date: new Date(divDate).toISOString().slice(0, 10) });

  return found;
}

/** Refresh events for symbols whose cache entry is stale. Paced, and failures
    are recorded as "checked, found nothing" rather than retried in a loop. */
export async function ensureEvents(symbols) {
  for (const s of symbols) {
    const hit = cache[s];
    if (hit && Date.now() - hit.checkedAt < TTL_MS) continue;
    try {
      const events = await scrape(s);
      cache[s] = { checkedAt: Date.now(), source: "screener.in", events };
      if (events.length) console.log(`[events] ${s}: ${events.map(e => `${e.type} ${e.date}`).join(", ")}`);
    } catch (e) {
      cache[s] = { checkedAt: Date.now(), events: [], error: e.message };
    }
    persist();
    await new Promise(r => setTimeout(r, 1_200));
  }
}

/** The soonest future event for a symbol, or null. */
export function nextEvent(symbol) {
  const events = cache[symbol]?.events || [];
  const now = Date.now();
  const upcoming = events
    .map(e => ({ ...e, ms: Date.parse(e.date) }))
    .filter(e => Number.isFinite(e.ms) && e.ms >= now - DAY_MS)
    .sort((a, b) => a.ms - b.ms)[0];
  if (!upcoming) return null;
  const daysAway = Math.max(0, Math.round((upcoming.ms - now) / DAY_MS));
  const rec = cache[symbol] || {};
  return {
    type: upcoming.type,
    date: upcoming.date,
    daysAway,
    // Calendar days and trading sessions differ across a weekend, and "2 days"
    // meaning "next Monday" would understate the room left.
    sessionsAway: sessionsBetween(now, upcoming.ms),
    source: rec.source || null,
    fetchedAt: rec.checkedAt || null,
    // A scraped date whose source has not been re-checked in a day is not
    // wrong, but it is not fresh either — the UI labels it rather than
    // presenting it with the same confidence as a current one.
    stale: rec.checkedAt ? Date.now() - rec.checkedAt > TTL_MS * 2 : true,
  };
}

/** Weekdays between two instants — a weekend is not two trading sessions. */
function sessionsBetween(fromMs, toMs) {
  let n = 0;
  for (let t = fromMs; t < toMs; t += DAY_MS) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n++;
  }
  return n;
}

/** The whole cache, with a top-level staleness flag so the dashboard can label
    the section instead of quietly dropping a warning it could not verify. */
export function allWithHealth() {
  const entries = Object.entries(cache);
  const oldest = entries.length ? Math.min(...entries.map(([, v]) => v.checkedAt || 0)) : null;
  return {
    events: cache,
    source: "screener.in",
    checkedAt: oldest,
    stale: oldest ? Date.now() - oldest > TTL_MS * 2 : true,
    note: "A symbol absent from this cache means no date could be established — never that there is no event.",
  };
}

export const all = () => cache;

/** Symbols with an event inside n days — for the brief. */
export function upcoming(symbols, days = 3) {
  return symbols
    .map(s => ({ symbol: s, event: nextEvent(s) }))
    .filter(x => x.event && x.event.daysAway <= days);
}
