/* IPO applications — what the user actually applied for, kept next to the other
   trade records rather than in the Pravesh engine, because this is the user's
   behaviour and not the engine's output.

   The interesting number is not the allotment rate. It is how the engine's
   verdicts performed on the IPOs the user skipped: an engine whose "apply"
   calls listed green while the user sat them out is costing them money, and
   that has to be visible. */

import { load, save, newId } from "./store.js";

const FILE = "ipo_applications.json";
const DAY_MS = 86_400_000;
const PRAVESH_URL = process.env.PRAVESH_DATA_URL || "";

let apps = load(FILE, []);
const persist = () => save(FILE, apps);

const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const avg = xs => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export const all = () => apps;

export function add(input) {
  if (!input?.ipoName) return null;
  const a = {
    id: newId("ipo"),
    ipoName: String(input.ipoName).trim(),
    segment: input.segment || null,          // mainboard | sme
    verdictAtApply: input.verdictAtApply || null,
    appliedDate: input.appliedDate || new Date().toISOString(),
    lots: input.lots != null ? +input.lots : null,
    amount: input.amount != null ? +input.amount : null,
    allotted: input.allotted ?? null,
    listingPrice: input.listingPrice != null ? +input.listingPrice : null,
    listingGainPct: input.listingGainPct != null ? +input.listingGainPct : null,
    notes: input.notes || "",
  };
  apps = [a, ...apps];
  persist();
  return a;
}

export function update(id, patch = {}) {
  const a = apps.find(x => x.id === id);
  if (!a) return null;
  for (const k of ["segment", "verdictAtApply", "appliedDate", "notes", "ipoName"])
    if (patch[k] !== undefined) a[k] = patch[k];
  for (const k of ["lots", "amount", "listingPrice", "listingGainPct"])
    if (patch[k] !== undefined) a[k] = patch[k] == null ? null : +patch[k];
  if (patch.allotted !== undefined) a.allotted = patch.allotted;
  persist();
  return a;
}

export function remove(id) {
  const before = apps.length;
  apps = apps.filter(x => x.id !== id);
  if (apps.length !== before) { persist(); return true; }
  return false;
}

/* Pravesh publishes its own verdict history. Reaching it is optional and its
   absence is reported rather than hidden, because "no opportunity cost" and
   "could not check" are very different claims. */
async function praveshDoc() {
  if (!PRAVESH_URL) return { ok: false, reason: "PRAVESH_DATA_URL not set" };
  try {
    const r = await fetch(PRAVESH_URL, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { ok: true, doc: await r.json() };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function praveshVerdicts() {
  const d = await praveshDoc();
  if (!d.ok) return d;
  const j = d.doc;
  const rows = Array.isArray(j) ? j : j.ipos || j.data || [];
  return { ok: true, rows };
}

/* Expert calls on IPOs, from Pravesh's expert_feed.

   These are NOT stock calls and do not enter the analyst ledger in analysts.js,
   which is keyed on symbol. An unlisted IPO has no ticker — `symbol` is always
   null and the join key is `ipoSlug`. `target` and `stop` are always null too:
   an expert's IPO call is "subscribe" or "avoid", not a level, and Pravesh
   correctly refuses to derive one.

   The distinction this function exists to preserve: **no calls found** and
   **could not look** are different claims. Google News RSS answers intermittently
   and returns headlines only, so a run can legitimately produce zero calls; a run
   where every route 403'd produces zero calls too, and reporting both as "no
   expert view" would launder a broken scraper into an opinion. `sourceStatus`
   carries the per-route evidence and `blocked` says which it was. */
export async function expertCalls() {
  const d = await praveshDoc();
  if (!d.ok) return { ok: false, reason: d.reason, calls: [], coverage: null, sourceStatus: [] };

  const j = d.doc || {};
  const schemaVersion = +(j.schema_version ?? 1);
  // Feature-detected on the number, never asserted equal — the field is additive
  // and pinning it would break on the next bump.
  if (schemaVersion < 2) {
    return { ok: true, schemaVersion, supported: false,
             reason: `Pravesh is publishing schema ${schemaVersion}; expert calls arrive from schema 2 onward`,
             calls: [], coverage: null, sourceStatus: [] };
  }

  const calls = (j.expert_calls || []).map(c => ({
    ipoSlug: c.ipoSlug ?? c.ipo_slug ?? null,
    ipoName: c.ipoName ?? c.ipo_name ?? null,
    symbol: c.symbol ?? null,          // always null for an unlisted IPO
    expert: c.expert ?? null,
    call: c.call ?? null,              // verbatim, never normalised
    stanceNormalised: c.stanceNormalised ?? c.stance_normalised ?? null,
    rationale: c.rationale ?? null,
    url: c.url ?? null,
    seenAt: c.seenAt ?? c.seen_at ?? null,       // publication time, or null
    capturedAt: c.capturedAt ?? c.captured_at ?? null, // when we scraped it
    source: c.source ?? null,
    target: c.target ?? null, stop: c.stop ?? null,    // always null from this side
  })).filter(c => c.url && c.expert);   // an unattributed call is not evidence

  const sourceStatus = (j.source_status || []).map(s => ({
    source: s.source ?? s.name ?? null,
    routes: (s.routes || []).map(r => ({
      route: r.route ?? r.name ?? null,
      attempted: r.attempted ?? null, answered: r.answered ?? null,
      hits: r.hits ?? null, dropped: r.dropped ?? null, reason: r.reason ?? null,
    })),
  }));

  const allRoutes = sourceStatus.flatMap(s => s.routes);
  const answered = allRoutes.filter(r => (r.answered ?? 0) > 0);
  const blocked = allRoutes.length > 0 && answered.length === 0;

  return {
    ok: true, schemaVersion, supported: true,
    calls, sourceStatus,
    coverage: j.expert_coverage ?? null,
    /* The honest headline. Silence has two causes and they mean opposite things
       to someone deciding whether to apply. */
    blocked,
    verdict: blocked
      ? "could not check — every route was blocked or timed out, so the absence of expert calls says nothing"
      : calls.length === 0
        ? "checked, no attributable view — the routes that answered carried no explicit stance from these experts"
        : `${calls.length} attributable call${calls.length === 1 ? "" : "s"}`,
    /* Headline-only capture is a real limit on what any of this can mean. */
    limits: [
      "Google News RSS returns headline and summary only — no article body, so a nuanced view can read as no view.",
      "A headline with no explicit stance is recorded as NO_VIEW rather than guessed at.",
      "Targets and stops are never published for IPO calls; an expert's IPO call is subscribe or avoid, not a level.",
    ],
  };
}

const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export async function stats(days = 365) {
  const since = Date.now() - days * DAY_MS;
  const inWindow = apps.filter(a => Date.parse(a.appliedDate) >= since);
  const decided = inWindow.filter(a => a.allotted != null);
  const allotted = decided.filter(a => a.allotted);
  const gains = allotted.map(a => a.listingGainPct).filter(Number.isFinite);

  const out = {
    days,
    applied: inWindow.length,
    allotmentRate: decided.length ? round2((allotted.length / decided.length) * 100) : null,
    pendingAllotment: inWindow.length - decided.length,
    avgListingGainOnAllotted: avg(gains),
    bestListingGain: gains.length ? round2(Math.max(...gains)) : null,
    worstListingGain: gains.length ? round2(Math.min(...gains)) : null,
    totalApplied: round2(inWindow.reduce((s, a) => s + (a.amount || 0), 0)),
    skipped: null,
    assumptions: [
      "Listing gain is what you recorded, on the lots you were allotted.",
      "Applications awaiting allotment are pending, not counted as failures.",
    ],
  };

  const pravesh = await praveshVerdicts();
  if (!pravesh.ok) {
    out.skipped = { available: false, reason: pravesh.reason };
    return out;
  }

  // Opportunity cost: engine-covered IPOs in the window that were never logged.
  const mine = new Set(inWindow.map(a => norm(a.ipoName)));
  const skipped = pravesh.rows.filter(r => {
    const name = r.name || r.ipoName || r.ipo || "";
    const when = Date.parse(r.listingDate || r.closeDate || r.date || "");
    return name && !mine.has(norm(name)) && (!Number.isFinite(when) || when >= since);
  });
  /* Pravesh's real shape: the call lives in take.verdict_key (APPLY | AVOID |
     RISKY | PRELIMINARY), and it publishes NO realised listing gain — only a
     pre-listing grey-market premium, which is a sentiment indicator and not an
     outcome. So the opportunity cost is reported as a count of missed APPLY
     calls, and the return on them is stated as unavailable rather than
     substituted with GMP. Presenting a grey-market print as a realised gain
     would be exactly the flattering fiction this module exists to avoid. */
  const gainOf = r => {
    const g = r.listingGainPct ?? r.listing_gain_pct ?? r.gainPct;
    return Number.isFinite(+g) ? +g : null;
  };
  const verdictOf = r => String(r.take?.verdict_key ?? r.verdict ?? r.call ?? "").toUpperCase();
  const positive = skipped.filter(r => verdictOf(r) === "APPLY" || /SUBSCRIBE/.test(verdictOf(r)));
  const posGains = positive.map(gainOf).filter(Number.isFinite);

  out.skipped = {
    available: true,
    total: skipped.length,
    engineSaidApply: positive.length,
    names: positive.map(r => r.name || r.ipoName).filter(Boolean).slice(0, 20),
    avgListingGainOnThose: avg(posGains),
    gainDataAvailable: posGains.length > 0,
    note: posGains.length
      ? "Listing gains on IPOs the engine called APPLY that you did not log an application for."
      : "IPOs the engine called APPLY that you did not log. The engine does not publish realised listing gains, so the return you passed up cannot be computed from it — only the count of calls you skipped.",
  };
  return out;
}

/** Re-read from disk after a restore, so the process serves the restored
    records rather than the ones it was holding in memory. */
export function reload() {
  apps = load(FILE, []);
}
