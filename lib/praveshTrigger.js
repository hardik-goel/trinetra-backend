/* Trigger the Pravesh workflow ourselves, twice a weekday.

   GitHub's scheduled workflows are best-effort on shared infrastructure. The
   cron was present and correct on master and never fired once — every run in the
   history was manual. So the schedule moves to something we control.

   The hard constraint is that a free-tier instance sleeps. At 09:00 IST there may
   be no process alive to fire anything, so each slot is a WINDOW rather than an
   instant: whatever first wakes the instance — an uptime pinger, the keep-alive,
   the user opening the dashboard — causes the dispatch, even at 09:07. Punctual
   delivery therefore depends on something hitting /health from about 08:45; with
   nothing pinging, the run happens whenever the instance next wakes inside the
   window.

   Dispatch state is per slot per IST day and lives on disk, so a restart cannot
   double-fire and the morning run cannot satisfy the afternoon one. */

import { load, save } from "./store.js";

const FILE = "pravesh_dispatch.json";
const CHECK_MS = 5 * 60_000;
const IST_OFFSET_MS = 5.5 * 60 * 60_000;
// Overridable so the dispatch path can be tested against a local stub without
// touching GitHub. Undocumented on purpose — it exists for tests, not operators.
const API_BASE = process.env.GITHUB_API_BASE || "https://api.github.com";

const istDate = (ms = Date.now()) => new Date(ms + IST_OFFSET_MS);
export const istDay = (ms = Date.now()) => istDate(ms).toISOString().slice(0, 10);
export const istMinutes = (ms = Date.now()) => {
  const d = istDate(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
export const istClock = (ms = Date.now()) => istDate(ms).toISOString().slice(11, 16);
const isWeekend = (ms = Date.now()) => [0, 6].includes(istDate(ms).getUTCDay());

/** "morning:09:00-10:30,afternoon:15:00-16:00" → structured slots. */
export function parseSlots(spec) {
  const out = [];
  for (const part of String(spec || "").split(",").map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^([\w-]+)\s*:\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const [, name, h1, m1, h2, m2] = m;
    const from = +h1 * 60 + +m1, to = +h2 * 60 + +m2;
    if (to <= from) continue;
    out.push({ name, from, to, window: `${h1.padStart(2, "0")}:${m1}-${h2.padStart(2, "0")}:${m2} IST` });
  }
  return out;
}

let state = load(FILE, { dispatched: {}, lastError: null });
if (!state.dispatched) state = { dispatched: {}, lastError: null };
const persist = () => save(FILE, state);
const keyFor = (slot, day) => `${day}:${slot}`;

/** Prune anything older than a week so the file stays small. */
function prune() {
  const cutoff = istDay(Date.now() - 7 * 86_400_000);
  for (const k of Object.keys(state.dispatched)) if (k.slice(0, 10) < cutoff) delete state.dispatched[k];
}

/**
 * Which slot, if any, should fire right now. Pure — the caller does the I/O, so
 * every branch is testable without a clock or a network.
 */
export function dueSlot(slots, now = Date.now(), { holidays = [] } = {}) {
  if (isWeekend(now)) return { slot: null, reason: "weekend" };
  const day = istDay(now);
  if (holidays.includes(day)) return { slot: null, reason: "market holiday" };
  const mins = istMinutes(now);
  for (const s of slots) {
    if (mins < s.from || mins > s.to) continue;
    if (state.dispatched[keyFor(s.name, day)]) return { slot: null, reason: `${s.name} already dispatched today`, slotName: s.name };
    return { slot: s, reason: null };
  }
  return { slot: null, reason: "outside every slot window" };
}

/**
 * Fire the workflow. Never throws: a failure here must not disturb the market
 * scan. A failed dispatch is NOT recorded, so the next interval retries while
 * the window is still open.
 */
export async function dispatch(slotName, cfg) {
  const { token, repo, workflow, ref = "master" } = cfg;
  const url = `${API_BASE}/repos/${repo}/actions/workflows/${workflow}/dispatches`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref, inputs: { slot: slotName } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 204) {
      const day = istDay();
      state.dispatched[keyFor(slotName, day)] = { at: Date.now(), istTime: istClock(), slot: slotName };
      state.lastError = null;
      prune(); persist();
      console.log(`[pravesh] dispatched ${slotName} workflow for ${day} IST at ${istClock()}`);
      return { ok: true };
    }
    // The body can echo request details; the token is never in it, and is never
    // logged from here either.
    const body = (await r.text()).slice(0, 300);
    const err = `HTTP ${r.status}: ${body}`;
    state.lastError = { at: Date.now(), slot: slotName, error: err };
    persist();
    console.warn(`[pravesh] dispatch failed (${slotName}) — ${err}`);
    return { ok: false, error: err };
  } catch (e) {
    state.lastError = { at: Date.now(), slot: slotName, error: e.message };
    persist();
    console.warn(`[pravesh] dispatch failed (${slotName}) — ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export function config() {
  const slots = parseSlots(process.env.PRAVESH_TRIGGER_SLOTS || "morning:09:00-10:30,afternoon:15:00-16:00");
  return {
    enabled: process.env.PRAVESH_TRIGGER_ENABLED === "true",
    token: process.env.GITHUB_TOKEN || "",
    repo: process.env.PRAVESH_REPO || "",
    workflow: process.env.PRAVESH_WORKFLOW || "pravesh-daily.yml",
    ref: process.env.PRAVESH_REF || "master",
    slots,
  };
}

export const missingConfig = c =>
  [!c.token && "GITHUB_TOKEN", !c.repo && "PRAVESH_REPO", !c.workflow && "PRAVESH_WORKFLOW",
   !c.slots.length && "PRAVESH_TRIGGER_SLOTS"].filter(Boolean);

/** Status for the endpoint — never includes the token. */
export function status(holidays = []) {
  const c = config();
  const day = istDay();
  return {
    enabled: c.enabled,
    missing: missingConfig(c),
    repo: c.repo || null,
    workflow: c.workflow || null,
    tradingDay: day,
    istNow: istClock(),
    slots: c.slots.map(s => {
      const rec = state.dispatched[keyFor(s.name, day)];
      const mins = istMinutes();
      return {
        name: s.name, window: s.window,
        openNow: !isWeekend() && mins >= s.from && mins <= s.to,
        dispatchedToday: !!rec,
        dispatchedAtIST: rec?.istTime || null,
      };
    }),
    lastError: state.lastError,
  };
}

export function startPraveshTrigger(getHolidays = () => []) {
  const c = config();
  if (!c.enabled) {
    console.log("[pravesh] trigger disabled — set PRAVESH_TRIGGER_ENABLED=true to arm it");
    return;
  }
  const missing = missingConfig(c);
  if (missing.length) {
    console.warn(`[pravesh] trigger NOT armed — missing ${missing.join(", ")}`);
    return;
  }
  console.log(`[pravesh] trigger armed · slots ${c.slots.map(s => `${s.name} ${s.window}`).join(", ")}`);

  const tick = async () => {
    try {
      const { slot, reason } = dueSlot(c.slots, Date.now(), { holidays: getHolidays() });
      if (!slot) return void (reason && reason !== "outside every slot window" &&
        console.log(`[pravesh] no dispatch — ${reason}`));
      await dispatch(slot.name, c);
    } catch (e) {
      console.warn("[pravesh] trigger tick failed:", e.message);
    }
  };
  tick(); // the wake itself is the opportunity — do not wait five minutes for it
  setInterval(tick, CHECK_MS);
}

export const _state = () => state;
export const reload = () => { state = load(FILE, { dispatched: {}, lastError: null }); if (!state.dispatched) state = { dispatched: {}, lastError: null }; };
